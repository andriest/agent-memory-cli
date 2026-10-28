import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { AGENTS, CONFIG_FILE, writeConfig } from './config.mjs';
import { readText } from './fsutil.mjs';
import { fingerprint } from './git.mjs';
import { inspect, install, resolveAgents, uninstall } from './integrations.mjs';
import { renderEntry } from './markdown.mjs';
import {
  ENTRY_TYPES,
  FILES,
  MemoryError,
  buildContext,
  openProject,
  parseTags,
  readEntries,
  requireMemory,
  saveEntry,
  scaffold,
  search,
  writeHandoff,
} from './memory.mjs';
import { onSessionEnd, onSessionStart, onStop, runTests } from './session.mjs';
import { CLAUDE_TYPES, applyImport, branchFilter, findClaudeMemoryDir, planImport, readClaudeMemories } from './importers/claude.mjs';
import { currentBranch, listBranches } from './git.mjs';

const VERSION = JSON.parse(readText(new URL('../package.json', import.meta.url))).version;

const HELP = `agent-memory ${VERSION} — shared, git-tracked memory for coding agents
(also available as \`shared-memory\` and \`amem\`)

Usage: agent-memory <command> [options]

Setup (once per repository)
  install [path] [--agents claude,antigravity] [--dir <path>] [--memory-only]
                          Create docs/memory/ and .agent-memory.json if missing, and wire
                          Claude Code + Antigravity to it (instructions, hooks, commands).
                          Safe to re-run; never overwrites memory content. Alias: init
  uninstall [path] [--agents …]
                          Remove integrations (memory files and config are kept)
  doctor [path]           Check config, memory files, hooks and the CLI on PATH
  config [--json]         Show the effective project configuration

Daily use (by agents or humans)
  read [handoff|status|project|decisions|learnings] [--max-chars N] [--recent N] [--all]
                          No argument: the context summary hooks inject at session start
  search <term…> [--in <file>] [--limit N] [--full] [--json]
                          Each argument is a term; quote a phrase to match it exactly
  save <decision|learning> "<title>" [--body "<text>" | --body -] [--tags a,b]
       [--agent <name>] [--force] [--allow-secrets]
  handoff --summary "<one line>" [--done <item>]… [--next <item>]… [--blockers <item>]…
          [--notes "<text>" | --notes -] [--session <id>] [--agent <name>] [--skip-git]
  test ["<command>"]      Run tests (default: tests.command) and record the result
  status                  Last session snapshot and last test run

Migration
  import claude [--from <dir>] [--types feedback,project,reference] [--branch <name>|current]
                [--prune] [--update] [--apply] [--json]
                          Import this project's Claude Code auto memory into the shared
                          memory (one-way). Shows the plan only, unless --apply is given.
                          --branch keeps memories about that branch or no branch; --prune
                          removes earlier imports the filters now exclude

Internal
  hook <claude|antigravity> <session-start|stop|session-end>
                          Hook entry point (reads the agent's hook JSON on stdin)

Global options
  --dir <path>    Memory folder relative to the project root (default: docs/memory)
  -h, --help      Show help        -v, --version   Show version

"-" as a value for --body/--notes reads it from stdin.
Agent name defaults to $AGENT_MEMORY_AGENT, or "claude" inside Claude Code.
`;

const OPTIONS = {
  dir: { type: 'string' },
  agents: { type: 'string' },
  only: { type: 'string' },
  'memory-only': { type: 'boolean' },
  'skip-install': { type: 'boolean' },
  body: { type: 'string' },
  tags: { type: 'string' },
  agent: { type: 'string' },
  force: { type: 'boolean' },
  'allow-secrets': { type: 'boolean' },
  in: { type: 'string' },
  limit: { type: 'string' },
  full: { type: 'boolean' },
  json: { type: 'boolean' },
  summary: { type: 'string' },
  done: { type: 'string', multiple: true },
  next: { type: 'string', multiple: true },
  blockers: { type: 'string', multiple: true },
  notes: { type: 'string' },
  session: { type: 'string' },
  'skip-git': { type: 'boolean' },
  from: { type: 'string' },
  types: { type: 'string' },
  apply: { type: 'boolean' },
  update: { type: 'boolean' },
  branch: { type: 'string' },
  prune: { type: 'boolean' },
  'max-chars': { type: 'string' },
  recent: { type: 'string' },
  all: { type: 'boolean' },
  help: { type: 'boolean', short: 'h' },
  version: { type: 'boolean', short: 'v' },
};

class UsageError extends Error {}

const out = (s = '') => process.stdout.write(s.endsWith('\n') ? s : `${s}\n`);
const err = (s) => process.stderr.write(s.endsWith('\n') ? s : `${s}\n`);

function int(value, name) {
  if (value === undefined) return undefined;
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n) || n < 1) throw new UsageError(`--${name} must be a positive integer`);
  return n;
}

const stdinOr = (value) => (value === '-' ? fs.readFileSync(0, 'utf8') : value ?? '');

function detectAgent(explicit) {
  return explicit || process.env.AGENT_MEMORY_AGENT || (process.env.CLAUDECODE ? 'claude' : 'unknown');
}

function rel(project, file) {
  return path.relative(project.root, file).split(path.sep).join('/') || '.';
}

function printResults(project, results) {
  const width = Math.max(...results.map((r) => r.action.length));
  for (const r of results) {
    out(`  ${r.action.padEnd(width)}  ${rel(project, r.file)}${r.note ? `  (${r.note})` : ''}`);
  }
}

function onPath() {
  return spawnSync('sh', ['-c', 'command -v agent-memory'], { stdio: 'ignore' }).status === 0;
}

// Setup commands take an optional target path; everything else works from the cwd.
function targetDir(args) {
  if (!args[0]) return process.cwd();
  const dir = path.resolve(args[0]);
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) throw new UsageError(`not a directory: ${args[0]}`);
  return dir;
}

// --- Commands ---------------------------------------------------------------------------

function installCommand(_, values, args) {
  const cwd = targetDir(args);
  const agents = resolveAgents(values.agents ?? values.only);
  let project = openProject({ cwd, dir: values.dir });

  const configAction = writeConfig(project.configInfo, { dir: values.dir && project.relDir, agents: agents ?? undefined });
  project = openProject({ cwd, dir: values.dir });

  out(`Shared memory in ${project.relDir}/ (project root: ${project.root})`);
  printResults(project, [{ file: project.configInfo.file, action: configAction }, ...scaffold(project)]);
  if (!values['memory-only'] && !values['skip-install']) {
    out(`\nAgent integrations (${project.config.agents.join(', ')})`);
    printResults(project, install(project, project.config.agents));
  }
  out(`\nNext: fill in ${project.relDir}/project.md (or ask an agent to), review ${CONFIG_FILE},`);
  out(`then commit ${project.relDir}/, ${CONFIG_FILE} and the integration files.`);
  if (!onPath()) out('Note: `agent-memory` is not on your PATH, so hooks will stay silent. See README → Installation.');
}

const commands = {
  install: installCommand,
  init: installCommand,

  uninstall(_, values, args) {
    const project = openProject({ cwd: targetDir(args), dir: values.dir });
    const results = uninstall(project, resolveAgents(values.agents ?? values.only) ?? AGENTS);
    if (results.length) printResults(project, results);
    else out('Nothing to remove.');
    out(`Memory files in ${project.relDir}/ and ${CONFIG_FILE} were left untouched.`);
  },

  doctor(_, values, args) {
    const project = openProject({ cwd: targetDir(args), dir: values.dir });
    let failures = 0;
    const line = (ok, label, hint) => {
      if (!ok) failures += 1;
      out(`  ${ok ? '✓' : '✗'} ${label}${ok || !hint ? '' : `  → ${hint}`}`);
    };
    const { configInfo, config } = project;
    out(`Project root: ${project.root}\n\nConfig (${CONFIG_FILE})`);
    line(configInfo.exists, configInfo.exists ? 'present and valid' : 'not found (defaults in use)', 'run `agent-memory install`');
    for (const w of configInfo.warnings) out(`  ! ${w}`);
    out(`    agents: ${config.agents.join(', ') || '(none)'} · stop hook: ${config.session.onStop} · session end: ${config.session.onEnd}`);
    out(`    tests.command: ${config.tests.command || '(not set)'}`);

    out(`\nMemory (${project.relDir}/)`);
    for (const name of ['project', 'decisions', 'learnings', 'handoff']) {
      line(fs.existsSync(project.file(name)), FILES[name], 'run `agent-memory install`');
    }
    const ignore = readText(path.join(project.memDir, '.gitignore'));
    line(['.state.json', 'status.md'].every((l) => ignore.split(/\r?\n/).includes(l)), '.gitignore keeps local files out of git', 'run `agent-memory install`');

    let group = null;
    for (const c of inspect(project, config.agents)) {
      if (c.group !== group) out(`\n${(group = c.group)}`);
      line(c.ok, c.label, c.hint);
    }
    out('\nCLI');
    line(onPath(), '`agent-memory` on PATH (needed by hooks)', 'see README → Installation');
    out(failures ? `\n${failures} problem(s) found.` : '\nAll good.');
    return failures ? 1 : 0;
  },

  config(project, values) {
    const { configInfo, config } = project;
    if (values.json) {
      out(JSON.stringify(config, null, 2));
      return;
    }
    out(`# ${configInfo.exists ? configInfo.file : `${CONFIG_FILE} not found — defaults`}`);
    for (const w of configInfo.warnings) out(`# warning: ${w}`);
    out(JSON.stringify(config, null, 2));
  },

  read(project, values, [section]) {
    requireMemory(project);
    if (!section || section === 'context') {
      out(buildContext(project, { maxChars: int(values['max-chars'], 'max-chars'), recent: int(values.recent, 'recent') }));
      return;
    }
    const key = { ...ENTRY_TYPES, handoff: 'handoff', handoffs: 'handoff', project: 'project', status: 'status' }[section];
    if (!key) throw new UsageError(`unknown section "${section}" (use: handoff, status, project, decisions, learnings)`);
    if (key === 'handoff' && !values.all) {
      const [latest] = readEntries(project, 'handoff');
      out(latest ? renderEntry(latest) : 'No handoff yet.');
      return;
    }
    out(readText(project.file(key)) || `${FILES[key]} is empty.`);
  },

  status(project) {
    requireMemory(project);
    out(readText(project.file('status')) || 'No status recorded yet (written at session end and by `agent-memory test`).');
  },

  search(project, values, terms) {
    const { total, needles, results } = search(project, terms, {
      in: values.in,
      limit: int(values.limit, 'limit') ?? 10,
    });
    if (values.json) {
      out(JSON.stringify({ total, results }, null, 2));
      return;
    }
    if (!results.length) {
      out('No matches.');
      return;
    }
    for (const r of results) {
      const partial = r.matched < needles ? `  [${r.matched}/${needles} terms]` : '';
      out(`${project.relDir}/${r.file}:${r.line}  ## ${r.heading}${partial}`);
      if (values.full) out(`${r.text}\n`);
      else for (const s of r.snippet) out(`    ${s}`);
    }
    if (total > results.length) out(`… ${total - results.length} more (use --limit)`);
  },

  save(project, values, [type, ...titleParts]) {
    if (!type || !titleParts.length) throw new UsageError('usage: agent-memory save <decision|learning> "<title>" [--body …]');
    const { file, entry } = saveEntry(project, {
      type,
      title: titleParts.join(' '),
      body: stdinOr(values.body),
      tags: parseTags(values.tags),
      agent: detectAgent(values.agent),
      force: values.force,
      allowSecrets: values['allow-secrets'],
    });
    out(`Saved to ${rel(project, file)}:${entry.line}  ## ${entry.heading}`);
  },

  handoff(project, values) {
    const { file, entry, archived, replaced } = writeHandoff(project, {
      summary: values.summary,
      agent: detectAgent(values.agent),
      session: values.session,
      done: values.done ?? [],
      next: values.next ?? [],
      blockers: values.blockers ?? [],
      notes: stdinOr(values.notes),
      useGit: !values['skip-git'],
      allowSecrets: values['allow-secrets'],
      fingerprint: fingerprint(project.root, project.relDir),
    });
    out(`Handoff ${replaced ? 'updated' : 'written'} in ${rel(project, file)}  ## ${entry.heading}`);
    if (archived) out(`Older handoffs moved to ${project.relDir}/archive/handoffs.md`);
    if (!values.next?.length) err('Tip: add --next items so the next agent knows where to start.');
  },

  async test(project, values, args) {
    const { code, passed, seconds } = await runTests(project, { command: args.join(' '), agent: detectAgent(values.agent) });
    err(`\nagent-memory: tests ${passed ? 'passed' : `failed (exit ${code})`} in ${seconds}s — recorded in ${project.relDir}/status.md`);
    return code;
  },

  import(project, values, [source]) {
    if (source !== 'claude') throw new UsageError('usage: agent-memory import claude [--from <dir>] [--apply]');
    const types = values.types?.split(',').map((t) => t.trim().toLowerCase()).filter(Boolean);
    const unknown = types?.filter((t) => !CLAUDE_TYPES.includes(t)) ?? [];
    if (unknown.length) throw new UsageError(`unknown memory type(s): ${unknown.join(', ')} (use: feedback, project, reference)`);

    if (values.prune && !values.branch && !values.types) throw new UsageError('--prune needs --branch or --types to know what to remove');

    let branch = null;
    if (values.branch !== undefined) {
      const name = ['current', 'HEAD', '.'].includes(values.branch) ? currentBranch(project.root) : values.branch.trim();
      if (!name) throw new UsageError('--branch current: not on a branch (detached HEAD or not a git repository)');
      const known = listBranches(project.root);
      if (!known.includes(name)) err(`agent-memory: warning: branch "${name}" not found in this repository`);
      branch = branchFilter(name, known, project.config.branches);
    }

    const { dir, why } = findClaudeMemoryDir(project.root, values.from);
    const plan = planImport(project, readClaudeMemories(dir), { types, update: values.update, branch, prune: values.prune });
    const count = (action) => plan.filter((p) => p.action === action).length;
    if (values.json) {
      out(JSON.stringify({ source: dir, branch: branch?.name ?? null, plan: plan.map(({ text, ...p }) => p) }, null, 2));
      if (!values.apply) return;
    } else {
      out(`Claude Code memory: ${dir}  (${why}, ${plan.length} file(s))`);
      if (branch) {
        const aliases = project.config.branches[branch.name] ?? [];
        out(`Branch filter: ${branch.name}${aliases.length ? ` (aliases: ${aliases.join(', ')})` : ''}; other branches: ${branch.others.map((o) => o.name).join(', ') || '(none)'}`);
      }
      out('');
      for (const p of plan) {
        const where = p.key ? FILES[p.key].replace('.md', '') : '-';
        const what = p.title ? `  → "${p.title}"` : '';
        const note = p.reason ? `  (${p.reason})` : p.scope ? `  [${p.scope}]` : '';
        out(`  ${p.action.padEnd(6)}  ${where.padEnd(9)}  ${p.type.padEnd(9)}  ${p.file}${what}${note}`);
      }
      const removing = count('remove') ? `, ${count('remove')} to remove` : '';
      out(`\nPlan: ${count('add')} to add, ${count('update')} to update${removing}, ${count('skip')} skipped.`);
      if (branch) out('Branch scope is matched from the text of each memory; check the reasons above before applying.');
    }
    if (!values.apply) {
      out('Nothing written. Re-run with --apply to import.');
      return;
    }
    const done = applyImport(project, plan);
    const parts = [`${done.add} added`, `${done.update} updated`, ...(done.remove ? [`${done.remove} removed`] : [])];
    out(`Import applied to ${project.relDir}/: ${parts.join(', ')}. Review with \`git diff ${project.relDir}\` before committing.`);
    out('Claude Code keeps writing its private memory; to make the shared memory the only one for this project,');
    out('add "autoMemoryEnabled": false to .claude/settings.json.');
  },
};

// --- Hooks ------------------------------------------------------------------------------

// What each agent expects on stdout when the hook has nothing to do.
const NOOP = {
  claude: () => '',
  antigravity: (event) => (event === 'stop' ? JSON.stringify({ decision: 'stop' }) : '{}'),
};

function readHookInput() {
  try {
    return process.stdin.isTTY ? {} : JSON.parse(fs.readFileSync(0, 'utf8') || '{}');
  } catch {
    return {};
  }
}

// Hooks must never break an agent session: any failure produces the no-op output and exit 0.
function runHook(agent, event = 'session-start') {
  if (!AGENTS.includes(agent)) {
    err(`agent-memory: unknown hook agent "${agent}"`);
    return 0;
  }
  const input = readHookInput();
  const cwd = input.cwd || input.workspacePaths?.[0] || process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const sessionId = input.session_id || input.conversationId || null;
  let output = NOOP[agent](event);
  try {
    const project = openProject({ cwd });
    if (event === 'session-start') {
      const context = onSessionStart(project, { agent, sessionId });
      if (context) {
        // Antigravity: injectSteps[].systemMessage is an object holding the message text.
        output = agent === 'claude' ? context : JSON.stringify({ injectSteps: [{ systemMessage: { systemMessage: context } }] });
      }
    } else if (event === 'stop') {
      // Antigravity reports cancelled/errored stops; only remind after a normal, idle finish.
      const normalFinish = agent === 'claude' || (input.fullyIdle !== false && !input.error);
      const reason = normalFinish
        ? onStop(project, { agent, sessionId, alreadyContinued: input.stop_hook_active === true })
        : null;
      if (reason) {
        output = JSON.stringify(agent === 'claude' ? { decision: 'block', reason } : { decision: 'continue', reason });
      } else if (agent === 'antigravity') {
        // Antigravity has no session-end event: refresh the status snapshot whenever it stops.
        onSessionEnd(project, { agent, sessionId, reason: input.terminationReason, final: false });
      }
    } else if (event === 'session-end') {
      onSessionEnd(project, { agent, sessionId, reason: input.reason, final: true });
    }
  } catch (e) {
    if (process.env.AGENT_MEMORY_DEBUG) err(`agent-memory hook: ${e.stack}`);
  }
  if (output) out(output);
  return 0;
}

// --- Entry point ------------------------------------------------------------------------

export async function main(argv) {
  let parsed;
  try {
    parsed = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true, strict: true });
  } catch (e) {
    err(`agent-memory: ${e.message}\nRun \`agent-memory --help\` for usage.`);
    return 2;
  }
  const { values, positionals } = parsed;
  const [command, ...args] = positionals;

  if (values.version) {
    out(VERSION);
    return 0;
  }
  if (values.help || !command || command === 'help') {
    out(HELP);
    return command || values.help ? 0 : 2;
  }
  if (command === 'hook') return runHook(args[0] ?? 'claude', args[1]);

  const run = commands[command];
  if (!run) {
    err(`agent-memory: unknown command "${command}"\nRun \`agent-memory --help\` for usage.`);
    return 2;
  }
  try {
    // Setup commands open the project themselves (they accept a target path).
    const project = ['install', 'init', 'uninstall', 'doctor'].includes(command) ? null : openProject({ dir: values.dir });
    return (await run(project, values, args)) ?? 0;
  } catch (e) {
    err(`agent-memory: ${e.message}`);
    if (process.env.AGENT_MEMORY_DEBUG && !(e instanceof MemoryError)) err(e.stack);
    return e instanceof UsageError ? 2 : 1;
  }
}
