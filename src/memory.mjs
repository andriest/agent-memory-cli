import fs from 'node:fs';
import path from 'node:path';
import { CONFIG_FILE, DEFAULT_DIR, loadConfig } from './config.mjs';
import { exists, readText, withLock, writeAtomic, writeIfChanged } from './fsutil.mjs';
import { gitState, pathFilter } from './git.mjs';
import {
  formatEntry,
  normalizeTitle,
  parseEntries,
  renderEntry,
  stripComments,
  truncate,
} from './markdown.mjs';
import { findSecrets } from './secrets.mjs';
import {
  ARCHIVE_TEMPLATE,
  DECISIONS_TEMPLATE,
  HANDOFF_TEMPLATE,
  LEARNINGS_TEMPLATE,
  MEMORY_GITIGNORE,
  PROJECT_TEMPLATE,
  STATUS_TEMPLATE,
  contextHeader,
  memoryReadme,
} from './templates.mjs';

export const FILES = {
  project: 'project.md',
  decisions: 'decisions.md',
  learnings: 'learnings.md',
  handoff: 'handoff.md',
  status: 'status.md',
};

export const ENTRY_TYPES = {
  decision: 'decisions',
  decisions: 'decisions',
  d: 'decisions',
  learning: 'learnings',
  learnings: 'learnings',
  gotcha: 'learnings',
  l: 'learnings',
};

const STATE_FILE = '.state.json';

export class MemoryError extends Error {}

// --- Locating the project --------------------------------------------------------------

export function findRoot(start) {
  const origin = path.resolve(start);
  let dir = origin;
  for (;;) {
    for (const marker of [CONFIG_FILE, DEFAULT_DIR, '.git']) {
      if (exists(path.join(dir, marker))) return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) return origin;
    dir = parent;
  }
}

export function openProject({ cwd = process.cwd(), dir } = {}) {
  const root = findRoot(cwd);
  const configInfo = loadConfig(root);
  if (configInfo.errors.length) {
    throw new MemoryError(`invalid ${CONFIG_FILE}:\n${configInfo.errors.map((e) => `  - ${e}`).join('\n')}`);
  }
  const config = configInfo.config;
  const relDir = toPosix(dir ?? process.env.AGENT_MEMORY_DIR ?? config.dir);
  const memDir = path.resolve(root, relDir);
  return {
    root,
    config,
    configInfo,
    relDir,
    memDir,
    file: (name) => path.join(memDir, FILES[name] ?? name),
  };
}

function toPosix(p) {
  return p.split(path.sep).join('/').replace(/\/+$/, '');
}

export function requireMemory(project) {
  if (!exists(project.memDir)) {
    throw new MemoryError(
      `no shared memory at ${project.relDir}/ (project root: ${project.root}). Run \`agent-memory install\` first.`,
    );
  }
}

// --- Scaffolding ------------------------------------------------------------------------

// Creates missing memory files; never overwrites existing memory content.
export function scaffold(project) {
  const results = [];
  const add = (rel, text, { overwrite = false } = {}) => {
    const file = path.join(project.memDir, rel);
    if (!overwrite && exists(file)) {
      results.push({ file, action: 'kept' });
      return;
    }
    results.push({ file, action: writeIfChanged(file, text) });
  };
  add('README.md', memoryReadme(project.relDir), { overwrite: true });
  add(FILES.project, PROJECT_TEMPLATE);
  add(FILES.decisions, DECISIONS_TEMPLATE);
  add(FILES.learnings, LEARNINGS_TEMPLATE);
  add(FILES.handoff, HANDOFF_TEMPLATE);

  // Keep user lines in .gitignore, but make sure local-only files stay out of git.
  const ignoreFile = path.join(project.memDir, '.gitignore');
  const current = readText(ignoreFile);
  const missing = MEMORY_GITIGNORE.split('\n').filter((l) => l && !current.split(/\r?\n/).includes(l));
  const ignore = missing.length ? `${current.replace(/\s*$/, current ? '\n' : '')}${missing.join('\n')}\n` : current;
  results.push({ file: ignoreFile, action: writeIfChanged(ignoreFile, ignore) });
  return results;
}

// --- Shared helpers ---------------------------------------------------------------------

const pad = (n) => String(n).padStart(2, '0');
export const today = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
export const nowStamp = (d = new Date()) => `${today(d)} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
export const shortId = (id) => (id ? String(id).replace(/[^\w-]/g, '').slice(0, 8) : '');

export function parseTags(raw) {
  if (!raw) return [];
  return [...new Set(raw.split(',').map((t) => t.trim().toLowerCase().replace(/^#/, '')).filter(Boolean))];
}

export function assertNoSecrets(project, text, allowSecrets) {
  if (allowSecrets) return;
  const hits = findSecrets(text, project.config.sensitive);
  if (hits.length) {
    const list = hits.map((h) => `  - ${h.label} (${h.sample})`).join('\n');
    throw new MemoryError(
      `refusing to save: content looks like it contains secrets (memory is committed to git):\n${list}\n` +
        `Remove them, add a known false positive to "sensitive.allow" in ${CONFIG_FILE}, or pass --allow-secrets.`,
    );
  }
}

// Local, gitignored bookkeeping for the session hooks. Callers must hold the memory lock.
export function loadState(project) {
  try {
    const state = JSON.parse(readText(path.join(project.memDir, STATE_FILE), '{}'));
    state.sessions ??= {};
    return state;
  } catch {
    return { sessions: {} };
  }
}

export function saveState(project, state) {
  const cutoff = Date.now() - 14 * 24 * 3600 * 1000;
  for (const [id, s] of Object.entries(state.sessions)) {
    if ((s.updatedAt ?? 0) < cutoff) delete state.sessions[id];
  }
  writeAtomic(path.join(project.memDir, STATE_FILE), `${JSON.stringify(state, null, 2)}\n`);
}

// --- Decisions and learnings ------------------------------------------------------------

export function saveEntry(project, { type, title, body = '', tags = [], agent, force = false, allowSecrets = false }) {
  requireMemory(project);
  const key = ENTRY_TYPES[type];
  if (!key) throw new MemoryError(`unknown entry type "${type}" (use: decision, learning)`);
  if (!title?.trim()) throw new MemoryError('a title is required');
  const text = formatEntry({
    date: today(),
    title,
    meta: { agent, tags: tags.join(', ') },
    body,
  });
  assertNoSecrets(project, text, allowSecrets);

  const file = project.file(key);
  return withLock(project.memDir, () => {
    const current = readText(file, key === 'decisions' ? DECISIONS_TEMPLATE : LEARNINGS_TEMPLATE);
    if (!force) {
      const wanted = normalizeTitle(title);
      const dup = parseEntries(current).find((e) => normalizeTitle(e.title) === wanted);
      if (dup) {
        throw new MemoryError(
          `an entry with this title already exists at ${FILES[key]}:${dup.line} ("${dup.heading}"). ` +
            'Edit that entry instead, or pass --force to add another.',
        );
      }
    }
    const base = current.replace(/\s+$/, '');
    writeAtomic(file, `${base}\n\n${text}`);
    const entries = parseEntries(readText(file));
    return { file, entry: entries[entries.length - 1] };
  });
}

// --- Status (local, overwritten) --------------------------------------------------------

export const STATUS_SECTIONS = ['Last session', 'Last test run'];

export function readStatus(project) {
  return Object.fromEntries(parseEntries(readText(project.file('status'))).map((e) => [e.heading, e]));
}

// Replace one section of status.md. Callers must hold the memory lock.
export function writeStatusSection(project, title, body) {
  const sections = readStatus(project);
  sections[title] = { heading: title, body: body.trim() };
  const ordered = STATUS_SECTIONS.filter((t) => sections[t]).map((t) => renderEntry(sections[t]));
  writeAtomic(project.file('status'), `${STATUS_TEMPLATE}\n${ordered.join('\n\n')}\n`);
}

export function formatChanges(git, label) {
  if (!git || (!git.changes.length && !git.hidden)) return '';
  const shown = git.changes.slice(0, 25).map((c) => `- \`${c}\``);
  if (git.changes.length > 25) shown.push(`- … and ${git.changes.length - 25} more`);
  if (git.hidden) shown.push(`- (${git.hidden} sensitive path(s) hidden by sensitive.excludePaths)`);
  return `**${label}**\n${shown.join('\n')}`;
}

// --- Handoffs ---------------------------------------------------------------------------

const bullets = (items) => items.map((i) => `- ${i.trim()}`).join('\n');

export function buildHandoff({ summary, agent, session, done = [], next = [], blockers = [], notes = '', git = null, tests = null }) {
  const parts = [];
  if (done.length) parts.push(`**Done**\n${bullets(done)}`);
  if (next.length) parts.push(`**Next**\n${bullets(next)}`);
  if (blockers.length) parts.push(`**Blockers / open questions**\n${bullets(blockers)}`);
  if (notes.trim()) parts.push(`**Notes**\n${notes.trim()}`);
  if (tests) parts.push(`**Last test run**\n- ${tests}`);
  const changes = formatChanges(git, 'Uncommitted changes at handoff');
  if (changes) parts.push(changes);
  return formatEntry({
    date: nowStamp(),
    title: summary,
    meta: { agent, branch: git?.branch, session: shortId(session) },
    body: parts.join('\n\n'),
  });
}

// Insert entries at the top of a newest-first file; returns the new text and any entries
// pushed past `max` (as raw text) so they can be archived.
export function insertNewestFirst(text, entryText, max = Infinity) {
  const lines = text.split(/\r?\n/);
  const first = parseEntries(text)[0];
  const at = first ? first.line - 1 : lines.length;
  const head = lines.slice(0, at).join('\n').replace(/\s+$/, '');
  const rest = lines.slice(at).join('\n').replace(/\s+$/, '');
  const result = `${head ? `${head}\n\n` : ''}${entryText.trim()}\n${rest ? `\n${rest}\n` : ''}`;

  const entries = parseEntries(result);
  if (entries.length <= max) return { text: result, overflow: '' };
  const resultLines = result.split('\n');
  const cut = entries[max].line - 1;
  return {
    text: `${resultLines.slice(0, cut).join('\n').replace(/\s+$/, '')}\n`,
    overflow: resultLines.slice(cut).join('\n').trim(),
  };
}

function removeEntry(text, predicate) {
  const entries = parseEntries(text);
  const i = entries.findIndex(predicate);
  if (i === -1) return text;
  const lines = text.split(/\r?\n/);
  const end = entries[i + 1] ? entries[i + 1].line - 1 : lines.length;
  return [...lines.slice(0, entries[i].line - 1), ...lines.slice(end)].join('\n');
}

function lastTestSummary(project) {
  const run = readStatus(project)['Last test run'];
  const meta = run?.body.split('\n').find((l) => /^>\s?/.test(l));
  const cmd = /`([^`]+)`/.exec(run?.body ?? '')?.[1];
  return meta ? `${meta.replace(/^>\s?/, '')}${cmd ? ` · \`${cmd}\`` : ''}` : null;
}

// `session` (the agent's session/conversation id) makes repeated handoffs from one session
// replace that session's entry instead of piling up.
export function writeHandoff(project, { useGit = true, allowSecrets = false, fingerprint = null, ...fields }) {
  requireMemory(project);
  if (!fields.summary?.trim()) throw new MemoryError('--summary is required');
  const { handoff: opts, sensitive } = project.config;
  const git = useGit && opts.gitChanges ? gitState(project.root, project.relDir, sensitive.excludePaths) : null;

  const file = project.file('handoff');
  const archiveFile = path.join(project.memDir, 'archive', 'handoffs.md');
  return withLock(project.memDir, () => {
    const text = buildHandoff({ ...fields, git, tests: lastTestSummary(project) });
    assertNoSecrets(project, text, allowSecrets);

    let current = readText(file, HANDOFF_TEMPLATE);
    const sid = shortId(fields.session);
    const replaced = Boolean(sid) && parseEntries(current).some((e) => e.meta.session === sid);
    if (replaced) current = removeEntry(current, (e) => e.meta.session === sid);

    const { text: updated, overflow } = insertNewestFirst(current, text, opts.keep);
    writeAtomic(file, updated);
    if (overflow) {
      writeAtomic(archiveFile, insertNewestFirst(readText(archiveFile, ARCHIVE_TEMPLATE), overflow).text);
    }

    const state = loadState(project);
    state.lastHandoff = { at: Date.now(), fingerprint, agent: fields.agent, session: fields.session ?? null };
    if (fields.session) {
      const s = (state.sessions[fields.session] ??= {});
      Object.assign(s, { agent: fields.agent, handoffFingerprint: fingerprint, handedOff: true, updatedAt: Date.now() });
    }
    saveState(project, state);
    return { file, entry: parseEntries(updated)[0], archived: Boolean(overflow), replaced };
  });
}

// --- Reading ----------------------------------------------------------------------------

export function readEntries(project, key) {
  return parseEntries(readText(project.file(key)));
}

// project.md without template comments and without empty sections.
export function projectSummary(project) {
  const text = stripComments(readText(project.file('project')));
  const sections = parseEntries(text).filter((e) => e.body.trim());
  return sections.map((s) => `### ${s.heading}\n${s.body}`).join('\n\n');
}

const ENTRY_CAP = 1500;
const demote = (entry) => renderEntry(entry).replace(/^## /, '### ');

function entriesSection(entries, budget, fileHint) {
  const out = [];
  let used = 0;
  for (const e of entries) {
    const text = truncate(demote(e), ENTRY_CAP, fileHint);
    if (used + text.length > budget && out.length) break;
    out.push(text);
    used += text.length + 2;
  }
  const rest = entries.length - out.length;
  if (rest > 0) out.push(`_+${rest} older in ${fileHint}_`);
  return out.join('\n\n');
}

// Extra repository files listed in `context.files`, never outside the root or sensitive.
function contextFiles(project) {
  const allowed = pathFilter(project.config.sensitive.excludePaths);
  return project.config.context.files
    .map((rel) => ({ rel: rel.replace(/^\.\//, ''), abs: path.resolve(project.root, rel) }))
    .filter(({ rel, abs }) => abs.startsWith(project.root + path.sep) && allowed(rel) && exists(abs))
    .map(({ rel, abs }) => ({ rel, text: stripComments(readText(abs)).trim() }));
}

function statusSection(project, budget) {
  const status = readStatus(project);
  const parts = [];
  const last = status['Last session'];
  if (last) {
    const handedOff = /handoff: yes/.test(last.body);
    parts.push(
      handedOff
        ? demote(last)
        : `⚠ The previous session ended **without a handoff**. Check its uncommitted changes before continuing.\n\n${demote(last)}`,
    );
  }
  if (status['Last test run']) parts.push(demote(status['Last test run']));
  return parts.length ? truncate(parts.join('\n\n'), budget, `${project.relDir}/status.md`) : '';
}

// The context summary injected at session start, built from `context.sections` in order
// and kept within `context.maxChars`.
export function buildContext(project, { maxChars, recent } = {}) {
  requireMemory(project);
  const d = project.relDir;
  const cfg = project.config.context;
  maxChars ??= cfg.maxChars;
  recent ??= cfg.recent;

  const recentOf = (key) => {
    const all = readEntries(project, key);
    return { all: all.length, shown: all.slice(-recent).reverse() };
  };

  const renderers = {
    handoff: () => {
      const [latest] = readEntries(project, 'handoff');
      return {
        title: 'Latest handoff',
        render: (b) => (latest ? truncate(demote(latest), b, `${d}/handoff.md`) : '_No handoff yet._'),
      };
    },
    status: () => ({ title: 'Status', render: (b) => statusSection(project, b), optional: true }),
    project: () => ({
      title: 'Project',
      render: (b) =>
        truncate(projectSummary(project), b, `${d}/project.md`) ||
        `_${d}/project.md is not filled in yet — add the overview, stack, commands, architecture and conventions as you learn them._`,
    }),
    decisions: () => {
      const { all, shown } = recentOf('decisions');
      return {
        title: `Recent decisions (${shown.length} of ${all})`,
        render: (b) => (shown.length ? entriesSection(shown, b, `${d}/decisions.md`) : '_None recorded yet._'),
      };
    },
    learnings: () => {
      const { all, shown } = recentOf('learnings');
      return {
        title: `Recent learnings (${shown.length} of ${all})`,
        render: (b) => (shown.length ? entriesSection(shown, b, `${d}/learnings.md`) : '_None recorded yet._'),
      };
    },
    files: () => {
      const files = contextFiles(project);
      return {
        title: 'Project files',
        optional: true,
        render: (b) => {
          const each = Math.max(200, Math.floor(b / Math.max(1, files.length)) - 20);
          return files.map((f) => `### ${f.rel}\n${truncate(f.text, each, f.rel)}`).join('\n\n');
        },
      };
    },
  };

  const sections = cfg.sections.map((name) => renderers[name]());
  const header = contextHeader(d);
  let remaining = maxChars - header.length;
  const parts = [header];
  sections.forEach((s, i) => {
    const reserve = (sections.length - i - 1) * 300;
    const budget = Math.max(200, remaining - reserve - s.title.length - 10);
    const body = s.render(budget);
    if (!body && s.optional) return;
    parts.push(`## ${s.title}\n${body}`);
    remaining -= body.length + s.title.length + 10;
  });
  return `${parts.join('\n\n')}\n`;
}

// --- Searching --------------------------------------------------------------------------

function memoryFiles(dir) {
  const out = [];
  const walk = (d) => {
    for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, ent.name);
      if (ent.isDirectory()) walk(p);
      else if (ent.name.endsWith('.md') && !(d === dir && ent.name === 'README.md')) out.push(p);
    }
  };
  walk(dir);
  return out.sort();
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Terms match at the start of a word, so "test" finds "tests" but "ci" does not find "decision".
function termMatcher(term) {
  return new RegExp(`(?<![\\p{L}\\p{N}])${escapeRe(term)}`, 'giu');
}

const countMatches = (re, text) => (text.match(re) ?? []).length;

export function search(project, terms, { in: only, limit = 10 } = {}) {
  requireMemory(project);
  const needles = terms.map((t) => t.trim()).filter(Boolean).map(termMatcher);
  if (!needles.length) throw new MemoryError('give at least one search term');
  const results = [];
  for (const file of memoryFiles(project.memDir)) {
    const rel = path.relative(project.memDir, file).split(path.sep).join('/');
    if (only && !rel.startsWith(only.replace(/\.md$/, ''))) continue;
    for (const entry of parseEntries(readText(file))) {
      const hay = `${entry.heading}\n${entry.body}`;
      const matched = needles.filter((re) => countMatches(re, hay) > 0);
      if (!matched.length) continue;
      const occurrences = needles.reduce((sum, re) => sum + countMatches(re, hay), 0);
      const inHeading = needles.filter((re) => countMatches(re, entry.heading) > 0).length;
      const snippet = entry.body
        .split('\n')
        .filter((l) => needles.some((re) => countMatches(re, l) > 0) && !/^>\s?/.test(l))
        .slice(0, 2)
        .map((l) => (l.trim().length > 160 ? `${l.trim().slice(0, 157)}…` : l.trim()));
      results.push({
        file: rel,
        line: entry.line,
        heading: entry.heading,
        date: entry.date,
        meta: entry.meta,
        matched: matched.length,
        score: matched.length * 100 + inHeading * 10 + Math.min(occurrences, 9),
        snippet,
        text: renderEntry(entry),
      });
    }
  }
  results.sort((a, b) => b.score - a.score || (b.date ?? '').localeCompare(a.date ?? ''));
  return { total: results.length, needles: needles.length, results: results.slice(0, limit) };
}
