import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { encodeProjectPath, parseFrontmatter } from '../src/importers/claude.mjs';

const BIN = fileURLToPath(new URL('../bin/agent-memory.mjs', import.meta.url));

function write(dir, files) {
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), text);
  }
}

// A repo plus a fake Claude config dir whose auto memory belongs to that repo.
function setup(memories) {
  const repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agent-memory-import-')));
  spawnSync('git', ['init', '-q'], { cwd: repo });
  const config = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-config-'));
  const memDir = path.join(config, 'projects', encodeProjectPath(repo), 'memory');
  write(memDir, { 'MEMORY.md': '# Memory Index\n\n- [x](x.md) — hook\n', ...memories });
  const run = (args, cwd = repo) => {
    const env = { ...process.env, CLAUDE_CONFIG_DIR: config };
    for (const k of ['CLAUDECODE', 'AGENT_MEMORY_AGENT', 'AGENT_MEMORY_DIR', 'CLAUDE_CODE_PROJECT_DIR_NAME']) delete env[k];
    const r = spawnSync(process.execPath, [BIN, ...args], { cwd, encoding: 'utf8', env });
    return { code: r.status, out: r.stdout, err: r.stderr };
  };
  run(['install', '--memory-only']);
  return { repo, config, memDir, run, read: (rel) => fs.readFileSync(path.join(repo, rel), 'utf8') };
}

const memory = ({ name, description, type, modified = '2026-09-01T10:00:00.000Z', body }) =>
  `---\nname: ${name}\ndescription: ${description}\nmetadata:\n  node_type: memory\n  type: ${type}\n  originSessionId: 0000\n  modified: ${modified}\n---\n\n${body}\n`;

const SAMPLE = {
  'feedback-commit-push.md': memory({
    name: 'feedback-commit-push',
    description: 'Always commit and push after finishing a change',
    type: 'feedback',
    body: 'Commit and push without asking.\n\n**Why:** the user deploys from main.\n**How to apply:** after tests pass. See [[stack-notes]].',
  }),
  'stack-notes.md': memory({
    name: 'stack-notes',
    description: 'Render pipeline uses ffmpeg with hardware encoding',
    type: 'project',
    body: '# Render pipeline\n\nffmpeg with `-hwaccel videotoolbox`.\n\n## Details\nThrottles when the disk is full.',
  }),
  'dashboard.md': memory({ name: 'dashboard', description: 'Grafana dashboard for the workers', type: 'reference', body: 'https://grafana.example.com/d/workers' }),
  'user-role.md': memory({ name: 'user-role', description: 'User is a senior backend engineer', type: 'user', body: 'Prefers terse answers.' }),
  'leaky.md': memory({ name: 'leaky', description: 'Deploy token', type: 'project', body: 'token ghp_abcdefghijklmnopqrstuvwxyz0123456789' }),
};

test('frontmatter parser handles nesting, quotes and block scalars', () => {
  const { data, body } = parseFrontmatter(
    '---\nname: "a: b"\ndescription: >\n  folded\n  text\nmetadata:\n  type: project\n  modified: 2026-01-01\ntags: \'it\'\'s\'\n---\nBody\n',
  );
  assert.deepEqual(data, { name: 'a: b', description: 'folded text', metadata: { type: 'project', modified: '2026-01-01' }, tags: "it's" });
  assert.equal(body, 'Body\n');
  assert.deepEqual(parseFrontmatter('no frontmatter'), { data: {}, body: 'no frontmatter' });
});

test('finds the memory directory from the project path and plans without writing', () => {
  const t = setup(SAMPLE);
  const before = t.read('docs/memory/decisions.md') + t.read('docs/memory/learnings.md');
  const r = t.run(['import', 'claude']);
  assert.equal(r.code, 0, r.err);
  assert.ok(r.out.includes(t.memDir), 'reports the source directory');
  assert.match(r.out, /add\s+decisions\s+feedback\s+feedback-commit-push\.md/);
  assert.match(r.out, /add\s+learnings\s+project\s+stack-notes\.md\s+→ "Render pipeline"/);
  assert.match(r.out, /add\s+learnings\s+reference\s+dashboard\.md/);
  assert.match(r.out, /skip\s+-\s+user\s+user-role\.md.*personal 'user' memory/);
  assert.match(r.out, /skip\s+learnings\s+project\s+leaky\.md.*looks like a secret \(GitHub token\)/);
  assert.match(r.out, /Plan: 3 to add, 0 to update, 2 skipped\./);
  assert.equal(t.read('docs/memory/decisions.md') + t.read('docs/memory/learnings.md'), before, 'dry run writes nothing');
});

test('--apply imports entries with source markers, demoted headings and resolved links', () => {
  const t = setup(SAMPLE);
  const r = t.run(['import', 'claude', '--apply']);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /Imported 3 entries/);

  const decisions = t.read('docs/memory/decisions.md');
  assert.match(
    decisions,
    /## 2026-09-01 · Always commit and push after finishing a change\n> agent: claude · tags: imported, convention · source: claude-memory\/feedback-commit-push\.md\n\nCommit and push without asking\./,
  );
  assert.match(decisions, /See “Render pipeline”\./, '[[links]] point at the imported title');

  const learnings = t.read('docs/memory/learnings.md');
  assert.match(learnings, /## 2026-09-01 · Render pipeline\n> agent: claude · tags: imported, project · source: claude-memory\/stack-notes\.md\n\n_Render pipeline uses ffmpeg with hardware encoding_/);
  assert.match(learnings, /^### Details$/m, 'body headings cannot start a new entry');
  assert.doesNotMatch(learnings, /senior backend|ghp_/);

  const search = t.run(['search', 'ffmpeg']);
  assert.match(search.out, /learnings\.md:\d+\s+## 2026-09-01 · Render pipeline/);
  assert.equal((learnings.match(/^## /gm) ?? []).length, 2, 'exactly the two learnings');
});

test('re-running is idempotent; --update refreshes entries whose source changed', () => {
  const t = setup(SAMPLE);
  t.run(['import', 'claude', '--apply']);
  const again = t.run(['import', 'claude', '--apply']);
  assert.match(again.out, /Plan: 0 to add, 0 to update, 5 skipped\./);
  assert.match(again.out, /already imported/);

  write(t.memDir, {
    'stack-notes.md': memory({
      name: 'stack-notes',
      description: 'Render pipeline uses ffmpeg with hardware encoding',
      type: 'project',
      modified: '2026-10-01T10:00:00.000Z',
      body: '# Render pipeline\n\nNow uses VAAPI on Linux too.',
    }),
  });
  assert.match(t.run(['import', 'claude']).out, /changed since import \(use --update\)/);
  const upd = t.run(['import', 'claude', '--update', '--apply']);
  assert.match(upd.out, /Plan: 0 to add, 1 to update/);
  const learnings = t.read('docs/memory/learnings.md');
  assert.match(learnings, /## 2026-10-01 · Render pipeline[\s\S]*VAAPI/);
  assert.doesNotMatch(learnings, /videotoolbox/);
  assert.equal((learnings.match(/source: claude-memory\/stack-notes\.md/g) ?? []).length, 1, 'replaced in place');
  assert.match(learnings, /dashboard\.md/, 'other entries kept');
});

test('--types filters, title clashes are skipped, --json lists the plan', () => {
  const t = setup(SAMPLE);
  t.run(['save', 'learning', 'Render pipeline', '--body', 'hand-written']);
  const r = t.run(['import', 'claude', '--types', 'project', '--json']);
  const { plan } = JSON.parse(r.out);
  const byFile = Object.fromEntries(plan.map((p) => [p.file, p]));
  assert.equal(byFile['stack-notes.md'].action, 'skip');
  assert.match(byFile['stack-notes.md'].reason, /same title already in learnings\.md/);
  assert.match(byFile['feedback-commit-push.md'].reason, /type not selected/);
  assert.equal(t.run(['import', 'claude', '--types', 'bogus']).code, 2);
});

test('autoMemoryDirectory and --from override the default location', () => {
  const t = setup({});
  const custom = fs.mkdtempSync(path.join(os.tmpdir(), 'custom-mem-'));
  write(custom, { 'note.md': memory({ name: 'note', description: 'Custom location note', type: 'project', body: 'x' }) });
  write(t.repo, { '.claude/settings.json': JSON.stringify({ autoMemoryDirectory: custom }) });
  const viaSetting = t.run(['import', 'claude']);
  assert.match(viaSetting.out, /autoMemoryDirectory in \.claude\/settings\.json/);
  assert.match(viaSetting.out, /Custom location note/);

  fs.rmSync(path.join(t.repo, '.claude'), { recursive: true });
  assert.match(t.run(['import', 'claude', '--from', custom]).out, /\(--from, 1 file\(s\)\)/);

  const missing = t.run(['import', 'claude', '--from', path.join(custom, 'nope')]);
  assert.equal(missing.code, 1);
  assert.equal(t.run(['import', 'gemini']).code, 2);
});

test('a missing memory directory lists where it looked', () => {
  const t = setup({});
  fs.rmSync(t.memDir, { recursive: true });
  const r = t.run(['import', 'claude']);
  assert.equal(r.code, 1);
  assert.match(r.err, /no Claude Code auto memory found[\s\S]*projects\/.*\/memory/);
});
