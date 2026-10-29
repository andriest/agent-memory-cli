import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const BIN = fileURLToPath(new URL('../bin/agent-memory.mjs', import.meta.url));
const EMPTY_CLAUDE_CONFIG = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-config-empty-'));

function write(dir, files) {
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), typeof text === 'string' ? text : JSON.stringify(text, null, 2));
  }
}

function tempRepo(files = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-memory-'));
  spawnSync('git', ['init', '-q'], { cwd: dir });
  write(dir, files);
  return dir;
}

function commitAll(dir) {
  spawnSync('git', ['add', '-A'], { cwd: dir });
  spawnSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'x'], { cwd: dir });
}

function run(cwd, args, input) {
  const env = { ...process.env };
  for (const k of ['CLAUDECODE', 'AGENT_MEMORY_AGENT', 'AGENT_MEMORY_DIR', 'CLAUDE_PROJECT_DIR']) delete env[k];
  // Never read the developer's real Claude Code memory.
  env.CLAUDE_CONFIG_DIR = EMPTY_CLAUDE_CONFIG;
  const r = spawnSync(process.execPath, [BIN, ...args], { cwd, input, encoding: 'utf8', env });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

const hook = (agent, event, payload) => run(os.tmpdir(), ['hook', agent, event], JSON.stringify(payload));
const read = (dir, rel) => fs.readFileSync(path.join(dir, rel), 'utf8');
const readJson = (dir, rel) => JSON.parse(read(dir, rel));

// --- Setup ------------------------------------------------------------------------------

test('install is one command, idempotent, and never overwrites memory', () => {
  const dir = tempRepo();
  const first = run(os.tmpdir(), ['install', dir]);
  assert.equal(first.code, 0, first.err);
  for (const f of ['README.md', 'project.md', 'decisions.md', 'learnings.md', 'handoff.md', '.gitignore']) {
    assert.ok(fs.existsSync(path.join(dir, 'docs/memory', f)), f);
  }
  const config = readJson(dir, '.agent-memory.json');
  assert.equal(config.dir, 'docs/memory');
  assert.deepEqual(config.agents, ['claude', 'antigravity']);
  assert.match(read(dir, 'docs/memory/.gitignore'), /^\.state\.json$/m);

  write(dir, { 'docs/memory/project.md': '# Project\n\n## Overview\nMy app.\n' });
  const second = run(dir, ['init']);
  assert.equal(second.code, 0);
  assert.doesNotMatch(second.out, /\b(created|updated)\s/);
  assert.equal(read(dir, 'docs/memory/project.md'), '# Project\n\n## Overview\nMy app.\n');
});

test('install --agents limits integrations and is remembered in the config', () => {
  const dir = tempRepo();
  run(dir, ['install', '--agents', 'antigravity']);
  assert.ok(fs.existsSync(path.join(dir, 'AGENTS.md')));
  assert.ok(!fs.existsSync(path.join(dir, 'CLAUDE.md')));
  assert.deepEqual(readJson(dir, '.agent-memory.json').agents, ['antigravity']);
  assert.equal(run(dir, ['install', '--agents', 'gpt']).code, 1);
});

test('hooks merge with existing hooks on the same events and uninstall restores them', () => {
  const settings = {
    permissions: { allow: ['Bash(ls)'] },
    hooks: {
      SessionStart: [{ matcher: 'startup', hooks: [{ type: 'command', command: 'echo mine' }] }],
      Stop: [{ hooks: [{ type: 'command', command: './lint.sh' }] }],
      PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: './guard.sh' }] }],
    },
  };
  const agHooks = {
    'my-linter': { PostToolUse: [{ matcher: 'run_command', hooks: [{ type: 'command', command: './lint.sh' }] }] },
    'my-start': { SessionStart: [{ type: 'command', command: './hello.sh' }] },
  };
  const dir = tempRepo({
    'AGENTS.md': '# Agents\n\nUse tabs.\n',
    '.claude/settings.json': settings,
    '.agents/hooks.json': agHooks,
  });
  assert.equal(run(dir, ['install']).code, 0);
  run(dir, ['install']);

  const claude = readJson(dir, '.claude/settings.json');
  assert.deepEqual(claude.permissions, settings.permissions);
  assert.deepEqual(claude.hooks.PreToolUse, settings.hooks.PreToolUse);
  assert.deepEqual(claude.hooks.SessionStart[0], settings.hooks.SessionStart[0], 'user hook kept first');
  assert.deepEqual(claude.hooks.Stop[0], settings.hooks.Stop[0]);
  for (const event of ['SessionStart', 'Stop', 'SessionEnd']) {
    const ours = claude.hooks[event].flatMap((g) => g.hooks).filter((h) => h.command.includes('agent-memory hook claude'));
    assert.equal(ours.length, 1, `${event} installed once`);
  }

  const ag = readJson(dir, '.agents/hooks.json');
  assert.deepEqual(ag['my-linter'], agHooks['my-linter']);
  assert.deepEqual(ag['my-start'], agHooks['my-start']);
  assert.deepEqual(Object.keys(ag['shared-agent-memory']), ['SessionStart', 'Stop']);
  assert.match(ag['shared-agent-memory'].Stop[0].command, /\|\| echo '\{"decision":"stop"\}'$/);

  const agents = read(dir, 'AGENTS.md');
  assert.match(agents, /^# Agents\n\nUse tabs\.\n\n<!-- shared-agent-memory:start -->/);
  assert.equal(agents.split('shared-agent-memory:start').length, 2, 'block appears once');

  assert.equal(run(dir, ['uninstall']).code, 0);
  assert.equal(read(dir, 'AGENTS.md'), '# Agents\n\nUse tabs.\n');
  assert.deepEqual(readJson(dir, '.claude/settings.json'), settings);
  assert.deepEqual(readJson(dir, '.agents/hooks.json'), agHooks);
  assert.ok(!fs.existsSync(path.join(dir, 'CLAUDE.md')), 'CLAUDE.md we created is removed');
  assert.ok(!fs.existsSync(path.join(dir, '.claude/commands')));
  assert.ok(fs.existsSync(path.join(dir, 'docs/memory/handoff.md')), 'memory is kept');
});

test('install upgrades hooks written by an older version', () => {
  const dir = tempRepo({
    '.claude/settings.json': {
      hooks: { SessionStart: [{ matcher: 'startup', hooks: [{ type: 'command', command: 'command -v agent-memory >/dev/null 2>&1 && agent-memory hook claude || true' }] }] },
    },
  });
  run(dir, ['install']);
  const groups = readJson(dir, '.claude/settings.json').hooks.SessionStart;
  assert.equal(groups.length, 1);
  assert.match(groups[0].hooks[0].command, /hook claude session-start/);
});

test('invalid hook files are reported, not overwritten', () => {
  const dir = tempRepo({ '.claude/settings.json': '{ not json' });
  const r = run(dir, ['install']);
  assert.equal(r.code, 1);
  assert.match(r.err, /cannot parse .*settings\.json/);
  assert.equal(read(dir, '.claude/settings.json'), '{ not json');
});

test('CLAUDE.md importing @AGENTS.md does not get a duplicate block', () => {
  const dir = tempRepo({ 'CLAUDE.md': '@AGENTS.md\n' });
  run(dir, ['install']);
  assert.equal(read(dir, 'CLAUDE.md'), '@AGENTS.md\n');
  assert.match(run(dir, ['doctor']).out, /✓ CLAUDE\.md has the memory protocol/);
});

test('user-owned command files are not overwritten', () => {
  const dir = tempRepo({ '.claude/commands/memory-save.md': 'mine\n' });
  const r = run(dir, ['install']);
  assert.match(r.out, /skipped\s+\.claude\/commands\/memory-save\.md/);
  assert.equal(read(dir, '.claude/commands/memory-save.md'), 'mine\n');
});

// --- Config -----------------------------------------------------------------------------

test('config is validated with clear errors and unknown keys are warnings', () => {
  const dir = tempRepo({ '.agent-memory.json': { context: { maxChars: -1 }, session: { onStop: 'nag' }, extra: 1 } });
  const r = run(dir, ['read']);
  assert.equal(r.code, 1);
  assert.match(r.err, /"context\.maxChars" must be a positive integer/);
  assert.match(r.err, /"session\.onStop" must be one of: remind, off/);

  write(dir, { '.agent-memory.json': { extra: 1, tests: { command: 'true' } } });
  const ok = run(dir, ['config']);
  assert.equal(ok.code, 0);
  assert.match(ok.out, /warning: unknown key "extra"/);
  assert.equal(JSON.parse(run(dir, ['config', '--json']).out).context.maxChars, 8000, 'defaults fill gaps');
});

test('custom --dir is remembered and found from subdirectories', () => {
  const dir = tempRepo();
  run(dir, ['install', '--dir', '.memory', '--memory-only']);
  assert.equal(readJson(dir, '.agent-memory.json').dir, '.memory');
  fs.mkdirSync(path.join(dir, 'pkg/sub'), { recursive: true });
  const r = run(path.join(dir, 'pkg/sub'), ['save', 'decision', 'Nested', '--body', 'ok']);
  assert.equal(r.code, 0, r.err);
  assert.match(read(dir, '.memory/decisions.md'), /Nested/);
});

test('context.sections and context.files control what is read', () => {
  const dir = tempRepo({ 'docs/arch.md': '# Architecture\nHexagonal.\n', '.env': 'SECRET=1\n' });
  run(dir, ['install', '--memory-only']);
  const config = readJson(dir, '.agent-memory.json');
  config.context.sections = ['files', 'handoff'];
  config.context.files = ['docs/arch.md', '.env', '../outside.md'];
  write(dir, { '.agent-memory.json': config });
  const r = run(dir, ['read']);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /## Project files\n### docs\/arch\.md\n# Architecture\nHexagonal\./);
  assert.doesNotMatch(r.out, /SECRET|\.env|outside|## Project\n|Recent decisions/);
  assert.ok(r.out.indexOf('Project files') < r.out.indexOf('Latest handoff'), 'sections keep configured order');
});

// --- Saving -----------------------------------------------------------------------------

test('save appends entries, rejects duplicates and secrets', () => {
  const dir = tempRepo();
  run(dir, ['install', '--memory-only']);
  const ok = run(dir, ['save', 'decision', 'Use pnpm', '--body', 'Faster installs.', '--tags', 'Tooling, deps', '--agent', 'claude']);
  assert.equal(ok.code, 0, ok.err);
  assert.match(read(dir, 'docs/memory/decisions.md'), /## \d{4}-\d{2}-\d{2} · Use pnpm\n> agent: claude · tags: tooling, deps\n\nFaster installs\.\n$/);

  const dup = run(dir, ['save', 'decision', 'use PNPM!', '--body', 'again']);
  assert.equal(dup.code, 1);
  assert.match(dup.err, /already exists/);
  assert.equal(run(dir, ['save', 'decision', 'use PNPM!', '--force']).code, 0);

  const leak = run(dir, ['save', 'learning', 'Token', '--body', 'token: ghp_abcdefghijklmnopqrstuvwxyz0123456789']);
  assert.equal(leak.code, 1);
  assert.match(leak.err, /GitHub token/);
  assert.doesNotMatch(read(dir, 'docs/memory/learnings.md'), /ghp_/);

  assert.equal(run(dir, ['save', 'learning', 'Env', '--body', 'API_KEY=process.env.API_KEY at boot']).code, 0);

  const stdin = run(dir, ['save', 'learning', 'From stdin', '--body', '-'], 'multi\nline\n');
  assert.equal(stdin.code, 0, stdin.err);
  assert.match(read(dir, 'docs/memory/learnings.md'), /From stdin\n> agent: unknown\n\nmulti\nline\n$/);
});

test('custom sensitive patterns are refused and allow-listed literals pass', () => {
  const dir = tempRepo();
  run(dir, ['install', '--memory-only']);
  const config = readJson(dir, '.agent-memory.json');
  config.sensitive.patterns = ['\\bCUST-\\d{6}\\b'];
  config.sensitive.allow = ['sk-test-0000000000000000000000'];
  write(dir, { '.agent-memory.json': config });

  const refused = run(dir, ['save', 'learning', 'Customer bug', '--body', 'Reported by CUST-123456']);
  assert.equal(refused.code, 1);
  assert.match(refused.err, /custom pattern #1/);
  const allowed = run(dir, ['save', 'learning', 'Fixture key', '--body', 'Tests use sk-test-0000000000000000000000']);
  assert.equal(allowed.code, 0, allowed.err);
});

test('commands outside an initialized repo fail clearly', () => {
  const dir = tempRepo();
  const r = run(dir, ['save', 'decision', 'X']);
  assert.equal(r.code, 1);
  assert.match(r.err, /agent-memory install/);
});

// --- Handoffs ---------------------------------------------------------------------------

test('handoff is newest first, includes git state, and rotates to the archive', () => {
  const dir = tempRepo({ 'src/app.js': '1\n' });
  run(dir, ['install', '--memory-only']);
  for (let i = 1; i <= 12; i++) {
    const r = run(dir, ['handoff', '--agent', 'antigravity', '--summary', `Session ${i}`, '--done', 'a', '--next', `step ${i}`]);
    assert.equal(r.code, 0, r.err);
  }
  const handoff = read(dir, 'docs/memory/handoff.md');
  const headings = [...handoff.matchAll(/^## .* · (Session \d+)$/gm)].map((m) => m[1]);
  assert.deepEqual(headings, ['Session 12', 'Session 11', 'Session 10', 'Session 9', 'Session 8', 'Session 7', 'Session 6', 'Session 5', 'Session 4', 'Session 3']);
  assert.match(handoff, /> agent: antigravity · branch: \S+/);
  assert.match(handoff, /^- `\?\? src\/`$/m);
  assert.doesNotMatch(handoff, /docs\/memory|`\?\? docs\/`/);

  const archive = read(dir, 'docs/memory/archive/handoffs.md');
  assert.deepEqual([...archive.matchAll(/(Session \d+)$/gm)].map((m) => m[1]), ['Session 2', 'Session 1']);

  const latest = run(dir, ['read', 'handoff']);
  assert.match(latest.out, /Session 12/);
  assert.doesNotMatch(latest.out, /Session 11/);
});

test('handoff --session replaces that session entry; sensitive paths are hidden', () => {
  const dir = tempRepo({ 'src/a.js': '1\n', '.env.local': 'X=1\n', 'secrets/prod.json': '{}' });
  run(dir, ['install', '--memory-only']);
  run(dir, ['handoff', '--summary', 'Other session', '--session', 'other-1']);
  run(dir, ['handoff', '--summary', 'First draft', '--session', 'abc12345-xyz']);
  const r = run(dir, ['handoff', '--summary', 'Final', '--session', 'abc12345-xyz']);
  assert.match(r.out, /Handoff updated/);
  const handoff = read(dir, 'docs/memory/handoff.md');
  assert.deepEqual([...handoff.matchAll(/^## .* · (.+)$/gm)].map((m) => m[1]), ['Final', 'Other session']);
  assert.match(handoff, /session: abc12345/);
  assert.match(handoff, /`\?\? src\/`/);
  assert.doesNotMatch(handoff, /\.env\.local|secrets\//);
  assert.match(handoff, /2 sensitive path\(s\) hidden/);
});

// --- Reading and searching --------------------------------------------------------------

test('read builds a budgeted context and hides empty project sections', () => {
  const dir = tempRepo();
  run(dir, ['install', '--memory-only']);
  write(dir, { 'docs/memory/project.md': '# Project\n\n## Overview\n<!-- hint -->\nA CLI.\n\n## Stack\n<!-- empty -->\n' });
  for (let i = 1; i <= 8; i++) run(dir, ['save', 'learning', `Gotcha ${i}`, '--body', 'x'.repeat(400)]);
  const r = run(dir, ['read', '--max-chars', '3000']);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /### Overview\nA CLI\./);
  assert.doesNotMatch(r.out, /### Stack|hint/);
  assert.match(r.out, /Recent learnings \(5 of 8\)/);
  assert.match(r.out, /Gotcha 8/);
  assert.ok(r.out.length < 3600, `context is ${r.out.length} chars`);
});

test('search ranks by matched terms and matches word prefixes', () => {
  const dir = tempRepo();
  run(dir, ['install', '--memory-only']);
  run(dir, ['save', 'decision', 'Use pnpm workspaces', '--body', 'For the monorepo.']);
  run(dir, ['save', 'learning', 'CI cache for pnpm', '--body', 'Cache the pnpm store on CI.']);
  run(dir, ['save', 'learning', 'Decision log tooling', '--body', 'nothing relevant']);

  const { results } = JSON.parse(run(dir, ['search', 'pnpm', 'ci', '--json']).out);
  assert.deepEqual(results.map((x) => x.heading.split(' · ')[1]), ['CI cache for pnpm', 'Use pnpm workspaces']);
  assert.match(run(dir, ['search', 'workspace']).out, /Use pnpm workspaces/);
  assert.match(run(dir, ['search', 'nomatch']).out, /No matches/);
});

// --- Tests ------------------------------------------------------------------------------

test('test records pass/fail with redacted output in status.md and the next handoff', () => {
  const dir = tempRepo();
  run(dir, ['install', '--memory-only']);
  const fail = run(dir, ['test', `${JSON.stringify(process.execPath)} -e "console.log('token ghp_abcdefghijklmnopqrstuvwxyz0123456789'); process.exit(3)"`]);
  assert.equal(fail.code, 3);
  let status = read(dir, 'docs/memory/status.md');
  assert.match(status, /## Last test run\n> .* · ❌ failed \(exit 3\) · [\d.]+s · agent: unknown/);
  assert.match(status, /token \[REDACTED\]/);
  assert.doesNotMatch(status, /ghp_/);

  const config = readJson(dir, '.agent-memory.json');
  config.tests.command = 'echo all good';
  write(dir, { '.agent-memory.json': config });
  assert.equal(run(dir, ['test']).code, 0);
  status = read(dir, 'docs/memory/status.md');
  assert.match(status, /✅ passed/);
  assert.equal(status.split('## Last test run').length, 2, 'section replaced, not appended');

  run(dir, ['handoff', '--summary', 'With tests', '--skip-git']);
  assert.match(read(dir, 'docs/memory/handoff.md'), /\*\*Last test run\*\*\n- .*✅ passed.*`echo all good`/);
  assert.match(run(dir, ['read']).out, /## Status\n### Last test run/);
});

// --- Session hooks ----------------------------------------------------------------------

test('session-start injects context in each agent format and never fails', () => {
  const dir = tempRepo();
  run(dir, ['install', '--memory-only']);
  run(dir, ['handoff', '--summary', 'Hook test', '--skip-git']);

  const claude = hook('claude', 'session-start', { cwd: dir, session_id: 's1', source: 'startup' });
  assert.equal(claude.code, 0);
  assert.match(claude.out, /^# Shared agent memory/);
  assert.match(claude.out, /Hook test/);
  assert.ok(claude.out.length < 10_000, 'under the Claude Code 10k hook output cap');

  const ag = hook('antigravity', 'session-start', { workspacePaths: [dir], conversationId: 'c1' });
  assert.equal(ag.code, 0);
  assert.match(JSON.parse(ag.out).injectSteps[0].systemMessage.systemMessage, /Hook test/);

  // v0.1 hook commands had no event argument.
  assert.match(run(os.tmpdir(), ['hook', 'claude'], JSON.stringify({ cwd: dir })).out, /Hook test/);

  const none = tempRepo();
  assert.deepEqual(hook('claude', 'session-start', { cwd: none }), { code: 0, out: '', err: '' });
  assert.equal(run(os.tmpdir(), ['hook', 'antigravity', 'session-start'], 'not json').out.trim(), '{}');
  assert.deepEqual(JSON.parse(run(os.tmpdir(), ['hook', 'antigravity', 'stop'], 'not json').out), { decision: 'stop' });
});

test('claude stop hook reminds once per change and stays quiet otherwise', () => {
  const dir = tempRepo({ 'src/a.js': '1\n' });
  run(dir, ['install', '--memory-only']);
  commitAll(dir);
  const config = readJson(dir, '.agent-memory.json');
  config.session.remindIntervalMinutes = 0;
  write(dir, { '.agent-memory.json': config });
  commitAll(dir);
  const p = { cwd: dir, session_id: 'sess-1' };

  hook('claude', 'session-start', p);
  assert.equal(hook('claude', 'stop', p).out, '', 'no changes yet: allow stop');

  write(dir, { 'src/a.js': '2\n' });
  const reminder = JSON.parse(hook('claude', 'stop', p).out);
  assert.equal(reminder.decision, undefined, 'feedback, not a blocking error');
  assert.equal(reminder.hookSpecificOutput.hookEventName, 'Stop');
  assert.match(reminder.hookSpecificOutput.additionalContext, /agent-memory handoff --session sess-1 --agent claude/);

  assert.equal(hook('claude', 'stop', p).out, '', 'same state: not asked twice');
  assert.equal(hook('claude', 'stop', { ...p, stop_hook_active: true }).out, '');

  write(dir, { 'src/a.js': '3\n' });
  assert.equal(run(dir, ['handoff', '--summary', 'Did it', '--session', 'sess-1']).code, 0);
  assert.equal(hook('claude', 'stop', p).out, '', 'handoff covers the current state');

  write(dir, { 'src/a.js': '4\n' });
  assert.match(JSON.parse(hook('claude', 'stop', p).out).hookSpecificOutput.additionalContext, /Before you finish/, 'new changes after the handoff');

  config.session.onStop = 'off';
  write(dir, { '.agent-memory.json': config });
  write(dir, { 'src/a.js': '5\n' });
  assert.equal(hook('claude', 'stop', p).out, '', 'onStop: off');
});

test('stop reminders are rate limited', () => {
  const dir = tempRepo({ 'src/a.js': '1\n' });
  run(dir, ['install', '--memory-only']);
  commitAll(dir);
  const p = { cwd: dir, session_id: 'sess-2' };
  hook('claude', 'session-start', p);
  write(dir, { 'src/a.js': '2\n' });
  assert.match(JSON.parse(hook('claude', 'stop', p).out).hookSpecificOutput.additionalContext, /Before you finish/);
  write(dir, { 'src/a.js': '3\n' });
  assert.equal(hook('claude', 'stop', p).out, '', 'within remindIntervalMinutes');
});

test('antigravity stop hook uses decision continue/stop and refreshes status', () => {
  const dir = tempRepo({ 'src/a.js': '1\n' });
  run(dir, ['install', '--memory-only']);
  commitAll(dir);
  const p = { workspacePaths: [dir], conversationId: 'conv-1' };
  hook('antigravity', 'session-start', p);
  write(dir, { 'src/a.js': '2\n' });

  assert.deepEqual(JSON.parse(hook('antigravity', 'stop', { ...p, fullyIdle: false }).out), { decision: 'stop' }, 'not idle');
  const cont = JSON.parse(hook('antigravity', 'stop', { ...p, fullyIdle: true }).out);
  assert.equal(cont.decision, 'continue');
  assert.match(cont.reason, /--session conv-1 --agent antigravity/);

  assert.deepEqual(JSON.parse(hook('antigravity', 'stop', { ...p, fullyIdle: true }).out), { decision: 'stop' });
  assert.match(read(dir, 'docs/memory/status.md'), /## Last session\n> agent: antigravity · ended: .* · handoff: no · session: conv-1/);
});

test('claude session-end records status and warns the next session about a missing handoff', () => {
  const dir = tempRepo({ 'src/a.js': '1\n' });
  run(dir, ['install', '--memory-only']);
  commitAll(dir);
  const p = { cwd: dir, session_id: 'sess-3' };
  hook('claude', 'session-start', p);
  write(dir, { 'src/a.js': '2\n' });
  assert.equal(hook('claude', 'session-end', { ...p, reason: 'prompt_input_exit' }).code, 0);

  const status = read(dir, 'docs/memory/status.md');
  assert.match(status, /> agent: claude · ended: .* · handoff: no · session: sess-3 · reason: prompt_input_exit/);
  assert.match(status, /^- ` M src\/a\.js`$/m);
  const next = hook('claude', 'session-start', { cwd: dir, session_id: 'sess-4' });
  assert.match(next.out, /## Status\n⚠ The previous session ended \*\*without a handoff\*\*/);

  run(dir, ['handoff', '--summary', 'Wrapped up', '--session', 'sess-4']);
  hook('claude', 'session-end', { cwd: dir, session_id: 'sess-4', reason: 'other' });
  assert.match(read(dir, 'docs/memory/status.md'), /handoff: yes/);
  assert.doesNotMatch(hook('claude', 'session-start', { cwd: dir, session_id: 'sess-5' }).out, /without a handoff/);
});

test('doctor reports every hook event', () => {
  const dir = tempRepo();
  run(dir, ['install']);
  const r = run(dir, ['doctor']);
  for (const label of ['SessionStart', 'Stop', 'SessionEnd']) assert.match(r.out, new RegExp(`✓ \\.claude/settings\\.json ${label} hook`));
  for (const label of ['SessionStart', 'Stop']) assert.match(r.out, new RegExp(`✓ \\.agents/hooks\\.json ${label} hook`));

  const settings = readJson(dir, '.claude/settings.json');
  delete settings.hooks.Stop;
  write(dir, { '.claude/settings.json': settings });
  assert.match(run(dir, ['doctor']).out, /✗ \.claude\/settings\.json Stop hook/);
});
