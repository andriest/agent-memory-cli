import crypto from 'node:crypto';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

function git(root, args, input) {
  const r = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8', input, maxBuffer: 256 * 1024 * 1024 });
  return r.status === 0 ? r.stdout : null;
}

export function isRepo(root) {
  return git(root, ['rev-parse', '--is-inside-work-tree'])?.trim() === 'true';
}

// Everything except the memory folder, which changes on every save.
const scope = (memRel) => ['--', '.', `:(exclude)${memRel}`];

// Minimal glob: `**` spans directories, `*` and `?` stay within one path segment.
// A pattern without "/" is matched against the file name, so ".env" also hides "api/.env".
export function globToRegExp(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*' && glob[i + 1] === '*') {
      const atEnd = i + 2 === glob.length;
      const slashAfter = glob[i + 2] === '/';
      if (re.endsWith('/') && atEnd) re = `${re.slice(0, -1)}(?:/.*)?`;
      else if (slashAfter) re += '(?:.*/)?';
      else re += '.*';
      i += slashAfter ? 2 : 1;
    } else if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

export function pathFilter(patterns = []) {
  const rules = patterns.map((p) => ({ re: globToRegExp(p.replace(/^\.\//, '')), byName: !p.includes('/') }));
  return (file) => {
    const clean = file.replace(/\/+$/, '');
    return !rules.some(({ re, byName }) => re.test(byName ? path.posix.basename(clean) : clean));
  };
}

function porcelainPath(line) {
  const p = line.slice(3);
  const arrow = p.indexOf(' -> ');
  return (arrow === -1 ? p : p.slice(arrow + 4)).replace(/^"(.*)"$/, '$1');
}

// Branch and uncommitted changes, with sensitive paths hidden.
export function gitState(root, memRel, excludePaths = []) {
  if (!isRepo(root)) return null;
  const branch = git(root, ['branch', '--show-current'])?.trim() || git(root, ['rev-parse', '--short', 'HEAD'])?.trim() || '';
  const lines = (git(root, ['status', '--porcelain', ...scope(memRel)]) ?? '').split('\n').filter(Boolean);
  const keep = pathFilter(excludePaths);
  const changes = lines.filter((l) => keep(porcelainPath(l)));
  return { branch, changes, hidden: lines.length - changes.length };
}

// A short hash of the working tree state (HEAD, staged, unstaged and untracked content,
// excluding the memory folder). Equal fingerprints mean "nothing changed since then".
export function fingerprint(root, memRel) {
  if (!isRepo(root)) return null;
  const hash = crypto.createHash('sha1');
  hash.update(git(root, ['rev-parse', 'HEAD']) ?? 'no-head');
  hash.update(git(root, ['status', '--porcelain', ...scope(memRel)]) ?? '');
  hash.update(
    git(root, ['diff', 'HEAD', ...scope(memRel)]) ??
      `${git(root, ['diff', ...scope(memRel)]) ?? ''}${git(root, ['diff', '--cached', ...scope(memRel)]) ?? ''}`,
  );
  const untracked = (git(root, ['ls-files', '--others', '--exclude-standard', ...scope(memRel)]) ?? '')
    .split('\n')
    .filter(Boolean)
    .slice(0, 500);
  if (untracked.length) hash.update(git(root, ['hash-object', '--stdin-paths'], untracked.join('\n')) ?? '');
  return hash.digest('hex').slice(0, 16);
}
