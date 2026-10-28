import path from 'node:path';
import { AGENTS } from './config.mjs';
import { exists, pruneEmptyDirs, readText, removeFile, writeIfChanged } from './fsutil.mjs';
import { BLOCK_START, hasBlock, removeBlock, stripComments, upsertBlock } from './markdown.mjs';
import {
  MANAGED_MARKER,
  antigravityHandoffWorkflow,
  antigravitySaveWorkflow,
  claudeHandoffCommand,
  claudeSaveCommand,
  hookCommand,
  protocolBlock,
} from './templates.mjs';

const HOOK_KEY = 'shared-agent-memory';
const HOOK_SIGNATURE = 'agent-memory hook';

// Hook events installed per agent. Claude Code: project-level hooks in .claude/settings.json.
// Antigravity (IDE and CLI): workspace hooks in .agents/hooks.json.
export const CLAUDE_HOOKS = [
  { event: 'SessionStart', matcher: 'startup|resume|clear|compact', arg: 'session-start', timeout: 15 },
  { event: 'Stop', arg: 'stop', timeout: 15 },
  // SessionEnd hooks share a short default budget; an explicit timeout raises it.
  { event: 'SessionEnd', arg: 'session-end', timeout: 10 },
];
export const ANTIGRAVITY_HOOKS = [
  { event: 'SessionStart', arg: 'session-start', timeout: 15 },
  { event: 'Stop', arg: 'stop', timeout: 15 },
];

export function resolveAgents(list) {
  if (!list) return null;
  const agents = list.split(',').map((t) => t.trim().toLowerCase()).filter(Boolean);
  for (const a of agents) {
    if (!AGENTS.includes(a)) throw new Error(`unknown agent "${a}" (use: ${AGENTS.join(', ')})`);
  }
  return agents;
}

// Antigravity reads `.agents/` (current) and `.agent/` (legacy). Follow whatever the repo uses.
function antigravityDir(root) {
  return exists(path.join(root, '.agent')) && !exists(path.join(root, '.agents')) ? '.agent' : '.agents';
}

function paths(root) {
  return {
    agentsMd: path.join(root, 'AGENTS.md'),
    claudeMd: path.join(root, 'CLAUDE.md'),
    claudeSettings: path.join(root, '.claude', 'settings.json'),
    claudeCommandsDir: path.join(root, '.claude', 'commands'),
    claudeCommands: {
      'memory-handoff.md': claudeHandoffCommand,
      'memory-save.md': claudeSaveCommand,
    },
    antigravityHooks: path.join(root, '.agents', 'hooks.json'),
    antigravityWorkflowsDir: path.join(root, antigravityDir(root), 'workflows'),
    antigravityWorkflows: {
      'memory-handoff.md': antigravityHandoffWorkflow,
      'memory-save.md': antigravitySaveWorkflow,
    },
  };
}

function readJson(file) {
  const text = readText(file, null);
  if (text === null || !text.trim()) return {};
  let value;
  try {
    value = JSON.parse(text);
  } catch (err) {
    throw new Error(`cannot parse ${file}: ${err.message} — fix it by hand, then re-run`);
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${file} must contain a JSON object — fix it by hand, then re-run`);
  }
  return value;
}

const writeJson = (file, obj) => writeIfChanged(file, `${JSON.stringify(obj, null, 2)}\n`);

// CLAUDE.md that already imports AGENTS.md gets the protocol through the import.
function importsAgentsMd(text) {
  return /^\s*@(\.\/)?AGENTS\.md\s*$/m.test(stripComments(removeBlock(text)));
}

function writeManaged(file, text) {
  const current = readText(file, null);
  if (current !== null && !current.includes(MANAGED_MARKER)) {
    return { file, action: 'skipped', note: 'exists and is not managed by agent-memory' };
  }
  return { file, action: writeIfChanged(file, text) };
}

function removeManaged(file) {
  const text = readText(file, null);
  if (text === null || !text.includes(MANAGED_MARKER)) return [];
  removeFile(file);
  return [{ file, action: 'removed' }];
}

function upsertInstructions(file, block) {
  return { file, action: writeIfChanged(file, upsertBlock(readText(file), block)) };
}

function stripInstructions(file, text) {
  const cleaned = removeBlock(text);
  if (!cleaned.trim()) {
    removeFile(file);
    return { file, action: 'removed' };
  }
  return { file, action: writeIfChanged(file, cleaned) };
}

const isOurHook = (h) => typeof h?.command === 'string' && h.command.includes(HOOK_SIGNATURE);

// --- Claude Code ------------------------------------------------------------------------

// Remove our handlers from every event, leaving the user's hooks (and their order) intact.
function withoutClaudeHooks(hooks = {}) {
  const out = {};
  for (const [event, groups] of Object.entries(hooks)) {
    if (!Array.isArray(groups)) {
      out[event] = groups;
      continue;
    }
    const kept = groups
      .map((g) => (Array.isArray(g?.hooks) ? { ...g, hooks: g.hooks.filter((h) => !isOurHook(h)) } : g))
      .filter((g) => !Array.isArray(g?.hooks) || g.hooks.length);
    if (kept.length) out[event] = kept;
  }
  return out;
}

function installClaude(project, p) {
  const results = [];
  const claudeMd = readText(p.claudeMd);
  if (importsAgentsMd(claudeMd)) {
    const cleaned = removeBlock(claudeMd);
    results.push({
      file: p.claudeMd,
      action: cleaned === claudeMd ? 'unchanged' : writeIfChanged(p.claudeMd, cleaned),
      note: 'imports @AGENTS.md, protocol comes from there',
    });
  } else {
    results.push(upsertInstructions(p.claudeMd, protocolBlock(project.relDir)));
  }

  const settings = readJson(p.claudeSettings);
  const hooks = withoutClaudeHooks(settings.hooks);
  for (const h of CLAUDE_HOOKS) {
    const group = { hooks: [{ type: 'command', command: hookCommand('claude', h.arg), timeout: h.timeout }] };
    (hooks[h.event] ??= []).push(h.matcher ? { matcher: h.matcher, ...group } : group);
  }
  settings.hooks = hooks;
  results.push({
    file: p.claudeSettings,
    action: writeJson(p.claudeSettings, settings),
    note: `hooks: ${CLAUDE_HOOKS.map((h) => h.event).join(', ')}`,
  });

  for (const [name, render] of Object.entries(p.claudeCommands)) {
    results.push(writeManaged(path.join(p.claudeCommandsDir, name), render(project.relDir)));
  }
  return results;
}

function uninstallClaude(project, p) {
  const results = [];
  const claudeMd = readText(p.claudeMd, null);
  if (claudeMd !== null && hasBlock(claudeMd)) results.push(stripInstructions(p.claudeMd, claudeMd));

  if (exists(p.claudeSettings)) {
    const settings = readJson(p.claudeSettings);
    if (settings.hooks) {
      const hooks = withoutClaudeHooks(settings.hooks);
      if (Object.keys(hooks).length) settings.hooks = hooks;
      else delete settings.hooks;
      if (!Object.keys(settings).length) {
        removeFile(p.claudeSettings);
        results.push({ file: p.claudeSettings, action: 'removed' });
      } else {
        results.push({ file: p.claudeSettings, action: writeJson(p.claudeSettings, settings) });
      }
    }
  }
  for (const name of Object.keys(p.claudeCommands)) {
    results.push(...removeManaged(path.join(p.claudeCommandsDir, name)));
  }
  pruneEmptyDirs(p.claudeCommandsDir, project.root);
  return results;
}

// --- Gemini Antigravity -----------------------------------------------------------------

function installAntigravity(project, p) {
  const results = [upsertInstructions(p.agentsMd, protocolBlock(project.relDir))];

  // Top-level keys are hook names; non-tool events take a handler list directly.
  const hooks = readJson(p.antigravityHooks);
  hooks[HOOK_KEY] = Object.fromEntries(
    ANTIGRAVITY_HOOKS.map((h) => [h.event, [{ type: 'command', command: hookCommand('antigravity', h.arg), timeout: h.timeout }]]),
  );
  results.push({
    file: p.antigravityHooks,
    action: writeJson(p.antigravityHooks, hooks),
    note: `hooks: ${ANTIGRAVITY_HOOKS.map((h) => h.event).join(', ')}`,
  });

  for (const [name, render] of Object.entries(p.antigravityWorkflows)) {
    results.push(writeManaged(path.join(p.antigravityWorkflowsDir, name), render(project.relDir)));
  }
  return results;
}

function uninstallAntigravity(project, p) {
  const results = [];
  const agentsMd = readText(p.agentsMd, null);
  if (agentsMd !== null && hasBlock(agentsMd)) results.push(stripInstructions(p.agentsMd, agentsMd));

  if (exists(p.antigravityHooks)) {
    const hooks = readJson(p.antigravityHooks);
    if (HOOK_KEY in hooks) {
      delete hooks[HOOK_KEY];
      if (Object.keys(hooks).length) {
        results.push({ file: p.antigravityHooks, action: writeJson(p.antigravityHooks, hooks) });
      } else {
        removeFile(p.antigravityHooks);
        results.push({ file: p.antigravityHooks, action: 'removed' });
      }
    }
  }
  for (const name of Object.keys(p.antigravityWorkflows)) {
    results.push(...removeManaged(path.join(p.antigravityWorkflowsDir, name)));
  }
  pruneEmptyDirs(p.antigravityWorkflowsDir, project.root);
  pruneEmptyDirs(path.dirname(p.antigravityHooks), project.root);
  return results;
}

// --- Entry points -----------------------------------------------------------------------

export function install(project, agents) {
  const p = paths(project.root);
  const results = [];
  if (agents.includes('claude')) results.push(...installClaude(project, p));
  if (agents.includes('antigravity')) results.push(...installAntigravity(project, p));
  return results;
}

export function uninstall(project, agents) {
  const p = paths(project.root);
  const results = [];
  if (agents.includes('claude')) results.push(...uninstallClaude(project, p));
  if (agents.includes('antigravity')) results.push(...uninstallAntigravity(project, p));
  return results;
}

function safeJson(file) {
  try {
    return readJson(file);
  } catch {
    return null;
  }
}

export function inspect(project, agents) {
  const p = paths(project.root);
  const checks = [];
  const check = (group, label, ok, hint) => checks.push({ group, label, ok, hint });

  if (agents.includes('claude')) {
    const hint = 'run `agent-memory install --agents claude`';
    const claudeMd = readText(p.claudeMd);
    const settings = safeJson(p.claudeSettings);
    check(
      'Claude Code',
      'CLAUDE.md has the memory protocol',
      claudeMd.includes(BLOCK_START) || (importsAgentsMd(claudeMd) && readText(p.agentsMd).includes(BLOCK_START)),
      hint,
    );
    if (settings === null) check('Claude Code', '.claude/settings.json is valid JSON', false, 'fix the file by hand');
    for (const h of CLAUDE_HOOKS) {
      const groups = settings?.hooks?.[h.event];
      const ok = Array.isArray(groups) && groups.some((g) => (g.hooks ?? []).some((x) => x.command === hookCommand('claude', h.arg)));
      check('Claude Code', `.claude/settings.json ${h.event} hook`, ok, hint);
    }
    if (settings?.disableAllHooks === true) {
      check('Claude Code', 'hooks enabled (disableAllHooks is true in .claude/settings.json)', false, 'remove disableAllHooks');
    }
    check(
      'Claude Code',
      '/memory-handoff and /memory-save commands',
      Object.keys(p.claudeCommands).every((n) => exists(path.join(p.claudeCommandsDir, n))),
      hint,
    );
  }

  if (agents.includes('antigravity')) {
    const hint = 'run `agent-memory install --agents antigravity`';
    const hooks = safeJson(p.antigravityHooks);
    check('Antigravity', 'AGENTS.md has the memory protocol', readText(p.agentsMd).includes(BLOCK_START), hint);
    if (hooks === null) check('Antigravity', '.agents/hooks.json is valid JSON', false, 'fix the file by hand');
    for (const h of ANTIGRAVITY_HOOKS) {
      const handlers = hooks?.[HOOK_KEY]?.[h.event];
      const ok = Array.isArray(handlers) && handlers.some((x) => x.command === hookCommand('antigravity', h.arg));
      check('Antigravity', `.agents/hooks.json ${h.event} hook`, ok, hint);
    }
    check(
      'Antigravity',
      '/memory-handoff and /memory-save workflows',
      Object.keys(p.antigravityWorkflows).every((n) => exists(path.join(p.antigravityWorkflowsDir, n))),
      hint,
    );
  }
  return checks;
}
