import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { exists, readText, withLock, writeAtomic } from '../fsutil.mjs';
import { mainWorktreeRoot } from '../git.mjs';
import { formatEntry, normalizeTitle, parseEntries, renderEntry } from '../markdown.mjs';
import { FILES, MemoryError, requireMemory, today } from '../memory.mjs';
import { findSecrets } from '../secrets.mjs';
import { DECISIONS_TEMPLATE, LEARNINGS_TEMPLATE } from '../templates.mjs';

// One-way import of Claude Code auto memory (~/.claude/projects/<project>/memory/) into the
// shared memory. Claude's files are only read, never changed.

export const CLAUDE_TYPES = ['feedback', 'project', 'reference', 'user'];

// Where each Claude memory type lands. `user` memories describe the person, not the project,
// and the shared memory is committed to git, so they are never imported.
const TARGETS = {
  feedback: { key: 'decisions', tags: ['convention'] },
  project: { key: 'learnings', tags: ['project'] },
  reference: { key: 'learnings', tags: ['reference'] },
  other: { key: 'learnings', tags: [] },
};

const SOURCE_PREFIX = 'claude-memory/';
const TITLE_MAX = 90;

// --- Locating Claude's memory directory -------------------------------------------------

// Claude Code names a project's directory after its path with every non-alphanumeric
// character replaced by "-" (/Users/me/app → -Users-me-app).
export const encodeProjectPath = (p) => p.replace(/[^a-zA-Z0-9]/g, '-');

const expandHome = (p) => (p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p);

function settingsValue(file, key) {
  try {
    return JSON.parse(readText(file, '{}'))[key];
  } catch {
    return undefined;
  }
}

// Candidate directories in the order Claude Code would use them: an explicit
// `autoMemoryDirectory` setting (local > project > user), then the per-project default.
export function claudeMemoryCandidates(root, env = process.env) {
  const configDir = expandHome(env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'));
  const candidates = [];
  for (const [file, label] of [
    [path.join(root, '.claude', 'settings.local.json'), '.claude/settings.local.json'],
    [path.join(root, '.claude', 'settings.json'), '.claude/settings.json'],
    [path.join(configDir, 'settings.json'), 'user settings'],
  ]) {
    const dir = settingsValue(file, 'autoMemoryDirectory');
    if (typeof dir === 'string' && dir) {
      candidates.push({ dir: path.resolve(root, expandHome(dir)), why: `autoMemoryDirectory in ${label}` });
    }
  }
  if (env.CLAUDE_CODE_PROJECT_DIR_NAME) {
    candidates.push({ dir: path.join(configDir, 'projects', env.CLAUDE_CODE_PROJECT_DIR_NAME, 'memory'), why: 'CLAUDE_CODE_PROJECT_DIR_NAME' });
  }
  const roots = new Set([root, mainWorktreeRoot(root)].filter(Boolean));
  for (const r of [...roots]) {
    try {
      roots.add(fs.realpathSync(r));
    } catch {
      // keep the unresolved path
    }
  }
  for (const r of roots) {
    candidates.push({ dir: path.join(configDir, 'projects', encodeProjectPath(r), 'memory'), why: `project ${r}` });
  }
  return candidates;
}

export function findClaudeMemoryDir(root, from) {
  if (from) {
    const dir = path.resolve(expandHome(from));
    if (!exists(dir)) throw new MemoryError(`not found: ${from}`);
    return { dir, why: '--from' };
  }
  const candidates = claudeMemoryCandidates(root);
  const found = candidates.find((c) => exists(c.dir));
  if (!found) {
    const tried = candidates.map((c) => `  - ${c.dir}`).join('\n');
    throw new MemoryError(`no Claude Code auto memory found for this project. Looked in:\n${tried}\nPass --from <dir> to point at it.`);
  }
  return found;
}

// --- Reading Claude's memory files ------------------------------------------------------

const unquote = (v) => {
  const t = v.trim();
  if (/^".*"$/.test(t)) {
    try {
      return JSON.parse(t);
    } catch {
      return t.slice(1, -1);
    }
  }
  return /^'.*'$/.test(t) ? t.slice(1, -1).replace(/''/g, "'") : t;
};

// The small YAML subset Claude writes: scalars, one level of nesting, and block scalars.
export function parseFrontmatter(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text);
  if (!m) return { data: {}, body: text };
  const data = {};
  let parent = null;
  let block = null;
  for (const line of m[1].split(/\r?\n/)) {
    if (block) {
      if (/^\s+\S/.test(line) || line.trim() === '') {
        block.target[block.key] += `${block.target[block.key] ? block.sep : ''}${line.trim()}`;
        continue;
      }
      block = null;
    }
    const kv = /^(\s*)([\w-]+):\s*(.*)$/.exec(line);
    if (!kv) continue;
    const [, indent, key, raw] = kv;
    const target = indent && parent ? (data[parent] ??= {}) : data;
    if (!indent) parent = null;
    if (raw === '') {
      if (!indent) {
        parent = key;
        data[key] = {};
      }
      continue;
    }
    if (/^[|>][+-]?$/.test(raw)) {
      target[key] = '';
      block = { target, key, sep: raw.startsWith('|') ? '\n' : ' ' };
      continue;
    }
    target[key] = unquote(raw);
  }
  return { data, body: text.slice(m[0].length) };
}

export function readClaudeMemories(dir) {
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.md') && f !== 'MEMORY.md')
    .sort()
    .map((file) => {
      const full = path.join(dir, file);
      const { data, body } = parseFrontmatter(readText(full));
      const meta = typeof data.metadata === 'object' ? data.metadata : {};
      return {
        file,
        slug: file.replace(/\.md$/, ''),
        name: data.name || file.replace(/\.md$/, ''),
        description: typeof data.description === 'string' ? data.description : '',
        type: (meta.type || data.type || '').toString().toLowerCase() || null,
        modified: meta.modified || data.modified || fs.statSync(full).mtime.toISOString(),
        body: body.trim(),
      };
    });
}

// --- Converting to shared-memory entries ------------------------------------------------

function shorten(text, max) {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (clean.length <= max) return clean;
  const cut = clean.slice(0, max - 1);
  return `${cut.slice(0, cut.lastIndexOf(' ') > max * 0.6 ? cut.lastIndexOf(' ') : cut.length).replace(/[,;:.\s]+$/, '')}…`;
}

// Headings in a memory body would start new entries in our files; demote them to level 3+.
function demoteHeadings(body) {
  let inFence = false;
  return body
    .split('\n')
    .map((line) => {
      if (/^\s*(```|~~~)/.test(line)) inFence = !inFence;
      return !inFence && /^#{1,2}\s/.test(line) ? line.replace(/^#{1,2}/, '###') : line;
    })
    .join('\n');
}

function localDate(iso) {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? today() : today(d);
}

// Descriptions are often a long sentence ("X — because Y"); a title keeps the first clause.
function firstClause(text) {
  const clean = text.replace(/\[\[([^\]\n]+)\]\]/g, '$1').replace(/\s+/g, ' ').trim();
  const balanced = (s) => (s.match(/[([]/g) ?? []).length === (s.match(/[)\]]/g) ?? []).length;
  for (const m of clean.matchAll(/\s[—–]\s|;\s|\.\s|:\s/g)) {
    const head = clean.slice(0, m.index);
    if (head.length > TITLE_MAX) break;
    if (head.length >= 20 && balanced(head)) return head.replace(/[,.]$/, '');
  }
  return clean;
}

// The description is Claude's own one-line summary, so it makes the best title; a body
// heading is often a sub-section ("1. Results") and is only used when there is none.
function titleFor(memory) {
  if (memory.description) return { title: shorten(firstClause(memory.description), TITLE_MAX), fromHeading: null };
  const heading = /^#{1,6}\s+(.+)$/m.exec(memory.body);
  if (heading) return { title: shorten(firstClause(heading[1]), TITLE_MAX), fromHeading: heading[0] };
  return { title: memory.name.replace(/[-_]+/g, ' '), fromHeading: null };
}

// Each imported entry records a short hash of its own text. A mismatch later means someone
// edited the entry by hand, independent of how this importer renders entries.
const HASH_META = /\s·\shash: [0-9a-f]+/;
const normalize = (text) => text.trim().replace(/[ \t]+$/gm, '').replace(HASH_META, '');
export const entryHash = (text) => crypto.createHash('sha1').update(normalize(text)).digest('hex').slice(0, 10);

export function toEntry(memory, titlesBySlug) {
  const target = TARGETS[memory.type] ?? TARGETS.other;
  const { title, fromHeading } = titleFor(memory);
  let body = fromHeading ? memory.body.replace(fromHeading, '').trim() : memory.body;
  // Keep the description when it was not used verbatim as the title.
  if (memory.description && normalizeTitle(memory.description) !== normalizeTitle(title)) {
    body = `_${memory.description.trim()}_\n\n${body}`.trim();
  }
  body = demoteHeadings(body).replace(/\[\[([^\]\n]+)\]\]/g, (_, slug) => {
    const linked = titlesBySlug.get(slug.trim());
    return linked ? `“${linked}”` : `\`${slug.trim()}\``;
  });
  const fields = {
    date: localDate(memory.modified),
    title,
    meta: { agent: 'claude', tags: ['imported', ...target.tags].join(', '), source: `${SOURCE_PREFIX}${memory.file}` },
    body,
  };
  const hash = entryHash(formatEntry(fields));
  return { key: target.key, title, hash, text: formatEntry({ ...fields, meta: { ...fields.meta, hash } }) };
}

// --- Planning and applying --------------------------------------------------------------

const templateFor = (key) => (key === 'decisions' ? DECISIONS_TEMPLATE : LEARNINGS_TEMPLATE);

// How an earlier import compares to its current state and to a fresh import. Entries imported
// before hashes were recorded are treated as unedited.
function compareToPrevious(previous, entry) {
  const recorded = previous.entry.meta.hash;
  const current = entryHash(renderEntry(previous.entry));
  return { edited: recorded ? current !== recorded : false, stale: (recorded ?? current) !== entry.hash };
}

// --- Branch scoping ---------------------------------------------------------------------

// Names like "main" are ordinary words, so they only count in a branch context.
const GENERIC_BRANCHES = new Set(['main', 'master', 'dev', 'develop', 'trunk', 'staging', 'production', 'release']);
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function branchMatchers(name, aliases = []) {
  const matchers = [];
  const lower = name.toLowerCase();
  if (GENERIC_BRANCHES.has(lower) || lower.length < 4) {
    const n = escapeRe(lower);
    matchers.push(new RegExp(`\`${n}\`|\\bbranch(?:es)?\\s+[\`'"]?${n}\\b|\\b${n}\\s+branch\\b`, 'iu'));
  } else {
    const names = new Set([lower]);
    const last = lower.split('/').pop();
    if (last !== lower && last.length >= 6 && !GENERIC_BRANCHES.has(last)) names.add(last);
    for (const n of names) matchers.push(new RegExp(`(?<![\\p{L}\\p{N}_-])${escapeRe(n)}(?![\\p{L}\\p{N}_-])`, 'iu'));
  }
  for (const alias of aliases) {
    if (alias.trim()) matchers.push(new RegExp(`(?<![\\p{L}\\p{N}])${escapeRe(alias.trim().toLowerCase())}(?![\\p{L}\\p{N}])`, 'iu'));
  }
  return matchers;
}

// `name` is the branch whose docs/memory is being filled; every other known branch (local,
// remote, or named in the `branches` config) counts as "another branch".
export function branchFilter(name, knownBranches, aliases = {}) {
  const all = [...new Set([name, ...knownBranches, ...Object.keys(aliases)])];
  const make = (b) => ({ name: b, matchers: branchMatchers(b, aliases[b]) });
  return { name, self: make(name), others: all.filter((b) => b !== name).map(make) };
}

function firstMatch(branch, text) {
  for (const re of branch.matchers) {
    const m = re.exec(text);
    if (m) return m[0].replace(/\s+/g, ' ');
  }
  return null;
}

// "KHUSUS branch X …" / "Only on X: …" in the description or first line marks a memory as
// belonging to X alone, even when it mentions other branches too.
const ONLY_MARKER = String.raw`(?:khusus|hanya|only|exclusively)\b[^.\n]{0,40}?`;

function markedFor(branch, lead) {
  return branch.matchers.some((re) => new RegExp(`${ONLY_MARKER}(?:${re.source})`, 'iu').test(lead));
}

// Keep memories about this branch or about no particular branch; skip ones that only
// mention other branches. Mentioning several branches (a rule listing them all) is kept,
// unless an explicit "only for <branch>" marker says otherwise.
export function classifyBranch(memory, filter) {
  const lead = [memory.description, memory.body.split('\n').find((l) => l.trim()) ?? ''].join('\n');
  if (markedFor(filter.self, lead)) return { keep: true, scope: 'marked for this branch' };
  const markedOther = filter.others.filter((b) => markedFor(b, lead));
  if (markedOther.length) return { keep: false, reason: `marked only for ${markedOther.map((b) => b.name).join(', ')}` };

  const text = [memory.file, memory.name, memory.description, memory.body].join('\n');
  const self = firstMatch(filter.self, text);
  const others = filter.others.map((b) => ({ name: b.name, match: firstMatch(b, text) })).filter((o) => o.match);
  if (self && others.length) return { keep: true, scope: `this branch + ${others.map((o) => o.name).join(', ')}` };
  if (self) return { keep: true, scope: `this branch ("${self}")` };
  if (others.length) {
    const label = (o) => (o.match.toLowerCase() === o.name.toLowerCase() ? o.name : `${o.name} ("${o.match}")`);
    return { keep: false, reason: `only about ${others.map(label).join(', ')}` };
  }
  return { keep: true, scope: 'no branch mentioned' };
}

// Decide, per memory file, whether it would be added, updated, removed or skipped (and why).
// `branch` is a branchFilter; `prune` removes earlier imports that the filters now exclude.
export function planImport(
  project,
  memories,
  { types = ['feedback', 'project', 'reference'], update = false, branch = null, prune = false } = {},
) {
  requireMemory(project);
  const existing = {};
  for (const key of ['decisions', 'learnings']) existing[key] = parseEntries(readText(project.file(key)));
  const bySource = new Map();
  for (const [key, entries] of Object.entries(existing)) {
    for (const e of entries) if (e.meta.source?.startsWith(SOURCE_PREFIX)) bySource.set(e.meta.source, { key, entry: e });
  }
  const titlesBySlug = new Map();
  for (const m of memories) {
    const { title } = titleFor(m);
    titlesBySlug.set(m.slug, title);
    titlesBySlug.set(m.name, title);
  }

  return memories.map((memory) => {
    const base = { file: memory.file, type: memory.type ?? 'untyped' };
    if (memory.type === 'user') return { ...base, action: 'skip', reason: "personal 'user' memory (not shared)" };
    if (!memory.body && !memory.description) return { ...base, action: 'skip', reason: 'empty' };

    const entry = toEntry(memory, titlesBySlug);
    const item = { ...base, key: entry.key, title: entry.title, text: entry.text };
    const previous = bySource.get(`${SOURCE_PREFIX}${memory.file}`);
    const state = previous ? compareToPrevious(previous, entry) : null;

    // Filtered out: skip it, or with --prune remove what an earlier import added.
    const scoped = branch ? classifyBranch(memory, branch) : { keep: true };
    let excluded = null;
    if (memory.type && !types.includes(memory.type)) excluded = 'type not selected (--types)';
    else if (!scoped.keep) excluded = scoped.reason;
    if (excluded) {
      if (!previous) return { ...item, action: 'skip', reason: excluded };
      if (!prune) return { ...item, key: previous.key, action: 'skip', reason: `${excluded}; imported earlier (use --prune to remove)` };
      if (state.edited) {
        return { ...item, key: previous.key, action: 'skip', reason: `${excluded}; edited since import, remove it by hand` };
      }
      return { ...item, key: previous.key, action: 'remove', reason: excluded };
    }
    if (scoped.scope) item.scope = scoped.scope;

    const secrets = findSecrets(entry.text, project.config.sensitive);
    if (secrets.length) return { ...item, action: 'skip', reason: `looks like a secret (${secrets.map((s) => s.label).join(', ')})` };

    if (previous) {
      if (!state.stale) return { ...item, action: 'skip', reason: 'already imported' };
      if (state.edited) return { ...item, action: 'skip', reason: 'edited here and changed in Claude memory; reconcile by hand' };
      if (!update) return { ...item, action: 'skip', reason: 'changed since import (use --update)' };
      return { ...item, action: 'update', key: previous.key };
    }
    const wanted = normalizeTitle(entry.title);
    const clash = existing[entry.key].find((e) => normalizeTitle(e.title) === wanted);
    if (clash) return { ...item, action: 'skip', reason: `same title already in ${FILES[entry.key]}:${clash.line}` };
    return { ...item, action: 'add' };
  });
}

// Replace the entry matching `predicate` with `entryText`, or remove it when that is empty.
function replaceEntry(text, predicate, entryText) {
  const entries = parseEntries(text);
  const i = entries.findIndex(predicate);
  if (i === -1) return null;
  const lines = text.split(/\r?\n/);
  const end = entries[i + 1] ? entries[i + 1].line - 1 : lines.length;
  const after = lines.slice(end).join('\n').replace(/^\s+/, '');
  const before = lines.slice(0, entries[i].line - 1).join('\n').replace(/\s+$/, '');
  const middle = entryText.trim() ? `\n\n${entryText.trim()}\n` : '\n';
  return `${before}${middle}${after ? `\n${after}` : ''}`.replace(/\n*$/, '\n');
}

export function applyImport(project, plan) {
  return withLock(project.memDir, () => {
    const counts = { add: 0, update: 0, remove: 0 };
    for (const key of ['decisions', 'learnings']) {
      const items = plan.filter((p) => p.key === key && p.action in counts);
      if (!items.length) continue;
      const file = project.file(key);
      let text = readText(file, templateFor(key));
      for (const item of items) {
        if (item.action === 'update' || item.action === 'remove') {
          const source = `${SOURCE_PREFIX}${item.file}`;
          const replaced = replaceEntry(text, (e) => e.meta.source === source, item.action === 'remove' ? '' : item.text);
          if (replaced !== null) {
            text = replaced;
            counts[item.action] += 1;
            continue;
          }
          if (item.action === 'remove') continue;
        }
        text = `${text.replace(/\s+$/, '')}\n\n${item.text}`;
        counts[item.action] += 1;
      }
      writeAtomic(file, text);
    }
    return counts;
  });
}
