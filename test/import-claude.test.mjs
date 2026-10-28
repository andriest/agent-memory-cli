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
  assert.match(r.out, /add\s+learnings\s+project\s+stack-notes\.md\s+→ "Render pipeline uses ffmpeg with hardware encoding"/);
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
  assert.match(r.out, /Import applied to docs\/memory\/: 3 added, 0 updated\./);

  const decisions = t.read('docs/memory/decisions.md');
  assert.match(
    decisions,
    /## 2026-09-01 · Always commit and push after finishing a change\n> agent: claude · tags: imported, convention · source: claude-memory\/feedback-commit-push\.md · hash: [0-9a-f]{10}\n\nCommit and push without asking\./,
  );
  assert.match(decisions, /See “Render pipeline uses ffmpeg with hardware encoding”\./, '[[links]] point at the imported title');

  const learnings = t.read('docs/memory/learnings.md');
  assert.match(learnings, /## 2026-09-01 · Render pipeline uses ffmpeg with hardware encoding\n> agent: claude · tags: imported, project · source: claude-memory\/stack-notes\.md · hash: [0-9a-f]{10}\n\n### Render pipeline\n/, 'description is the title; body heading is demoted');
  assert.match(learnings, /^### Details$/m, 'body headings cannot start a new entry');
  assert.doesNotMatch(learnings, /senior backend|ghp_/);

  const search = t.run(['search', 'ffmpeg']);
  assert.match(search.out, /learnings\.md:\d+\s+## 2026-09-01 · Render pipeline uses ffmpeg/);
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
  assert.match(learnings, /## 2026-10-01 · Render pipeline uses ffmpeg with hardware encoding[\s\S]*VAAPI/);
  assert.doesNotMatch(learnings, /videotoolbox/);
  assert.equal((learnings.match(/source: claude-memory\/stack-notes\.md/g) ?? []).length, 1, 'replaced in place');
  assert.match(learnings, /dashboard\.md/, 'other entries kept');
});

test('--types filters, title clashes are skipped, --json lists the plan', () => {
  const t = setup(SAMPLE);
  t.run(['save', 'learning', 'Render pipeline uses ffmpeg with hardware encoding', '--body', 'hand-written']);
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

// --- Branch scoping ---------------------------------------------------------------------

const BRANCHED = {
  'aurora-format.md': memory({ name: 'aurora-format', description: 'Aurora Shop product pages use a single hero image', type: 'feedback', body: 'Keep one image per page.' }),
  'borealis-cadence.md': memory({ name: 'borealis-cadence', description: 'KHUSUS branch brand/borealis: commit and push automatically', type: 'feedback', body: 'Only there.' }),
  'borealis-banners.md': memory({ name: 'borealis-banners', description: 'Borealis Store banners use pastel colors', type: 'project', body: 'Tested in October.' }),
  'branch-rules.md': memory({ name: 'branch-rules', description: 'Every branch has its own rules', type: 'feedback', body: '`main` = shared core, `brand/aurora` = Aurora Shop.' }),
  'borealis-only.md': memory({ name: 'borealis-only', description: 'KHUSUS branch brand/borealis: no image compression', type: 'feedback', body: 'Unlike brand/aurora, keep the original images.' }),
  'aurora-only.md': memory({ name: 'aurora-only', description: 'Only on brand/aurora: launch banner at 100 orders', type: 'project', body: 'Branch main did this at 50.' }),
  'render-disk.md': memory({ name: 'render-disk', description: 'Rendering fails when the disk is full', type: 'project', body: 'The main cause is temp files.' }),
  'core-titles.md': memory({ name: 'core-titles', description: 'Launch titles for the core site', type: 'project', body: 'Used on branch main only.' }),
};

function branchedSetup() {
  const t = setup(BRANCHED);
  const git = (...args) => spawnSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd: t.repo });
  git('add', '-A');
  git('commit', '-qm', 'init');
  git('branch', '-M', 'main');
  git('branch', 'brand/borealis');
  git('switch', '-qc', 'brand/aurora');
  const config = JSON.parse(t.read('.agent-memory.json'));
  config.branches = { 'brand/aurora': ['Aurora Shop'], 'brand/borealis': ['Borealis Store'] };
  write(t.repo, { '.agent-memory.json': JSON.stringify(config, null, 2) });
  return t;
}

test('--branch keeps this branch and unscoped memories, skips other branches with reasons', () => {
  const t = branchedSetup();
  const r = t.run(['import', 'claude', '--branch', 'current']);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /Branch filter: brand\/aurora \(aliases: Aurora Shop\); other branches: (?=.*\bmain\b)(?=.*brand\/borealis)/);
  assert.match(r.out, /add .* aurora-format\.md .*\[this branch \("Aurora( Shop)?"\)\]/);
  assert.match(r.out, /skip .* borealis-cadence\.md .*\(marked only for brand\/borealis\)$/m);
  assert.match(r.out, /skip .* borealis-banners\.md .*only about brand\/borealis \("Borealis( Store)?"\)/);
  assert.match(r.out, /add .* branch-rules\.md .*\[this branch \+ main\]/);
  assert.match(r.out, /add .* render-disk\.md .*\[no branch mentioned\]/, 'the word "main" alone is not a branch');
  assert.match(r.out, /skip .* core-titles\.md .*only about main \("branch main"\)/);
  assert.match(r.out, /skip .* borealis-only\.md .*\(marked only for brand\/borealis\)/, 'marker beats a mention of this branch');
  assert.match(r.out, /add .* aurora-only\.md .*\[marked for this branch\]/, 'marker beats a mention of another branch');
  assert.match(r.out, /Plan: 4 to add, 0 to update, 4 skipped\./);
});

test('--prune removes earlier imports that belong to other branches, but not edited ones', () => {
  const t = branchedSetup();
  t.run(['import', 'claude', '--apply']);
  const learnings = t.read('docs/memory/learnings.md');
  write(t.repo, { 'docs/memory/learnings.md': learnings.replace('Tested in October.', 'Tested in October. Edited by hand.') });

  const dry = t.run(['import', 'claude', '--branch', 'current']);
  assert.match(dry.out, /imported earlier \(use --prune to remove\)/);

  const r = t.run(['import', 'claude', '--branch', 'current', '--prune', '--apply']);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /remove .* borealis-cadence\.md/);
  assert.match(r.out, /remove .* core-titles\.md/);
  assert.match(r.out, /skip .* borealis-banners\.md .*edited since import, remove it by hand/);
  assert.match(r.out, /remove .* borealis-only\.md/);
  assert.match(r.out, /0 added, 0 updated, 3 removed/);

  const decisions = t.read('docs/memory/decisions.md');
  assert.doesNotMatch(decisions, /borealis-cadence/);
  assert.match(decisions, /branch-rules\.md/);
  assert.match(decisions, /aurora-format\.md/);
  assert.match(t.read('docs/memory/learnings.md'), /Edited by hand/);
  assert.doesNotMatch(t.read('docs/memory/learnings.md'), /core-titles/);
  assert.match(t.read('docs/memory/decisions.md'), /^# Decisions/, 'file header kept');

  assert.match(t.run(['import', 'claude', '--branch', 'current', '--prune']).out, /Plan: 0 to add, 0 to update, \d+ skipped\./);
});

test('--prune needs a filter, and branches config is validated', () => {
  const t = branchedSetup();
  assert.equal(t.run(['import', 'claude', '--prune']).code, 2);
  const config = JSON.parse(t.read('.agent-memory.json'));
  config.branches = { main: 'Core Site' };
  write(t.repo, { '.agent-memory.json': JSON.stringify(config) });
  const r = t.run(['import', 'claude', '--branch', 'main']);
  assert.equal(r.code, 1);
  assert.match(r.err, /"branches" must be an object mapping branch names to arrays of aliases/);
});

test('hand edits are detected by hash, independent of importer changes', () => {
  const t = setup(SAMPLE);
  t.run(['import', 'claude', '--apply']);
  const file = path.join(t.repo, 'docs/memory/learnings.md');
  // An entry imported by an older version (no hash, different title) is treated as unedited.
  const legacy = fs.readFileSync(file, 'utf8').replace(/ · hash: [0-9a-f]{10}/g, '').replace('· Grafana dashboard for the workers', '· Old style title');
  fs.writeFileSync(file, legacy);
  const r = t.run(['import', 'claude', '--update', '--apply']);
  assert.match(r.out, /update .* dashboard\.md/);
  assert.match(fs.readFileSync(file, 'utf8'), /· Grafana dashboard for the workers\n> .*hash: [0-9a-f]{10}/);

  // A hand edit plus a change in Claude memory is never overwritten.
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('https://grafana.example.com/d/workers', 'https://grafana.example.com/d/workers (moved?)'));
  write(t.memDir, { 'dashboard.md': memory({ name: 'dashboard', description: 'Grafana dashboard for the workers', type: 'reference', body: 'https://grafana.example.com/d/new' }) });
  const conflict = t.run(['import', 'claude', '--update', '--apply']);
  assert.match(conflict.out, /skip .* dashboard\.md .*edited here and changed in Claude memory; reconcile by hand/);
  assert.match(fs.readFileSync(file, 'utf8'), /\(moved\?\)/);
});
