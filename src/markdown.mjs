// Memory files are plain Markdown. Each entry is a level-2 section:
//
//   ## 2026-10-28 · Use pnpm workspaces
//   > agent: claude · tags: tooling, deps
//
//   What was decided and why.
//
// The parser is lenient so entries written by hand (or by any agent) are still understood.

export const BLOCK_START = '<!-- shared-agent-memory:start -->';
export const BLOCK_END = '<!-- shared-agent-memory:end -->';

// Blank out HTML comments but keep their newlines, so line numbers stay correct.
export function stripComments(text) {
  return text.replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/[^\n]/g, ''));
}

export function parseEntries(text) {
  const lines = stripComments(text).split(/\r?\n/);
  const entries = [];
  let current = null;
  let inFence = false;
  lines.forEach((line, i) => {
    if (/^\s*(```|~~~)/.test(line)) inFence = !inFence;
    const m = inFence ? null : /^##\s+(.+?)\s*$/.exec(line);
    if (m) {
      if (current) entries.push(finishEntry(current));
      current = { heading: m[1], line: i + 1, lines: [] };
    } else if (current) {
      current.lines.push(line);
    }
  });
  if (current) entries.push(finishEntry(current));
  return entries;
}

function finishEntry({ heading, line, lines }) {
  const hm = /^(\d{4}-\d{2}-\d{2}(?:[ T]\d{2}:\d{2})?)\s+[·—|-]\s+(.*)$/.exec(heading);
  const meta = {};
  const first = lines.find((l) => l.trim() !== '');
  if (first && /^>\s?/.test(first)) {
    for (const part of first.replace(/^>\s?/, '').split('·')) {
      const kv = /^([\w-]+):\s*(.*)$/.exec(part.trim());
      if (kv) meta[kv[1].toLowerCase()] = kv[2].trim();
    }
  }
  return {
    heading,
    date: hm ? hm[1] : null,
    title: hm ? hm[2] : heading,
    meta,
    line,
    body: lines.join('\n').replace(/^\s*\n/, '').replace(/\s+$/, ''),
  };
}

export function renderEntry(entry) {
  return entry.body ? `## ${entry.heading}\n${entry.body}` : `## ${entry.heading}`;
}

export function formatEntry({ date, title, meta = {}, body = '' }) {
  const metaLine = Object.entries(meta)
    .filter(([, v]) => v !== undefined && v !== '')
    .map(([k, v]) => `${k}: ${v}`)
    .join(' · ');
  let out = `## ${date} · ${title.trim()}\n`;
  if (metaLine) out += `> ${metaLine}\n`;
  if (body.trim()) out += `\n${body.trim()}\n`;
  return out;
}

export function normalizeTitle(title) {
  return title.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

// Insert or replace the managed block in an instructions file (AGENTS.md, CLAUDE.md).
export function upsertBlock(text, inner) {
  const block = `${BLOCK_START}\n${inner.trim()}\n${BLOCK_END}`;
  const s = text.indexOf(BLOCK_START);
  const e = text.indexOf(BLOCK_END);
  if (s !== -1 && e > s) return text.slice(0, s) + block + text.slice(e + BLOCK_END.length);
  const base = text.replace(/\s+$/, '');
  return (base ? `${base}\n\n` : '') + `${block}\n`;
}

export function removeBlock(text) {
  const s = text.indexOf(BLOCK_START);
  const e = text.indexOf(BLOCK_END);
  if (s === -1 || e < s) return text;
  const before = text.slice(0, s).replace(/\s+$/, '');
  const after = text.slice(e + BLOCK_END.length).replace(/^\s+/, '');
  if (!before) return after;
  return after ? `${before}\n\n${after}` : `${before}\n`;
}

export function hasBlock(text) {
  return text.includes(BLOCK_START) && text.includes(BLOCK_END);
}

// Shorten text to at most `max` characters, including the "truncated" note, preferring a line
// boundary.
export function truncate(text, max, hint) {
  if (text.length <= max) return text;
  const note = `\n… (truncated${hint ? ` — see ${hint}` : ''})`;
  const room = max - note.length;
  if (room <= 0) return '';
  const cut = text.slice(0, room);
  const nl = cut.lastIndexOf('\n');
  return `${nl > room * 0.5 ? cut.slice(0, nl) : cut}${note}`;
}
