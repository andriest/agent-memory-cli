import fs from 'node:fs';
import path from 'node:path';

export function readText(file, fallback = '') {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return fallback;
    throw err;
  }
}

export function exists(file) {
  return fs.existsSync(file);
}

// Write via temp file + rename so a crash or a concurrent reader never sees a half-written file.
export function writeAtomic(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}

// Returns 'created' | 'updated' | 'unchanged'.
export function writeIfChanged(file, text) {
  const before = readText(file, null);
  if (before === text) return 'unchanged';
  writeAtomic(file, text);
  return before === null ? 'created' : 'updated';
}

export function removeFile(file) {
  if (!exists(file)) return false;
  fs.rmSync(file, { force: true });
  return true;
}

// Remove `dir` and its parents up to (not including) `stop` while they are empty.
export function pruneEmptyDirs(dir, stop) {
  let current = path.resolve(dir);
  const root = path.resolve(stop);
  while (current.startsWith(root + path.sep)) {
    try {
      if (fs.readdirSync(current).length > 0) return;
      fs.rmdirSync(current);
    } catch {
      return;
    }
    current = path.dirname(current);
  }
}

const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

// Cross-process lock using an exclusive-create lock file. Two agents saving at the same
// moment are serialized instead of overwriting each other's entries.
export function withLock(dir, fn, { timeoutMs = 5000, staleMs = 30000 } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const lock = path.join(dir, '.lock');
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      fs.closeSync(fs.openSync(lock, 'wx'));
      break;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      try {
        if (Date.now() - fs.statSync(lock).mtimeMs > staleMs) {
          fs.rmSync(lock, { force: true });
          continue;
        }
      } catch {
        continue; // lock vanished between open and stat; retry
      }
      if (Date.now() > deadline) {
        throw new Error(`memory is locked by another writer (${lock}); delete it if it is stale`);
      }
      sleep(50);
    }
  }
  try {
    return fn();
  } finally {
    fs.rmSync(lock, { force: true });
  }
}
