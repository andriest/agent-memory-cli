import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { exists, withLock } from './fsutil.mjs';
import { fingerprint, gitState } from './git.mjs';
import {
  MemoryError,
  buildContext,
  formatChanges,
  loadState,
  nowStamp,
  requireMemory,
  saveState,
  shortId,
  writeStatusSection,
} from './memory.mjs';
import { redactSecrets } from './secrets.mjs';
import { stopReminder } from './templates.mjs';

// Session automation shared by every agent. Agent-specific hook plumbing (stdin/stdout
// formats) lives in cli.mjs; this module only decides *what* should happen.

function touchSession(state, id, agent) {
  const s = (state.sessions[id] ??= { agent, startedAt: Date.now() });
  s.updatedAt = Date.now();
  return s;
}

// Status is a local snapshot that changes whenever a session ends, so it does not count as the
// memory having changed.
const contextHash = (text) =>
  crypto
    .createHash('sha1')
    .update(text.replace(/\n\n## Status\n[\s\S]*?(?=\n\n## |\n*$)/, ''))
    .digest('hex')
    .slice(0, 12);

// Session start: return the context to inject and remember the working-tree baseline so the
// stop hook can tell "this session changed something" from "the repo was already dirty".
// A resumed session still has the context it was given earlier, so it only gets it again when
// the memory changed in the meantime (for example another agent wrote a handoff).
export function onSessionStart(project, { agent, sessionId, source }) {
  if (!exists(project.memDir)) return '';
  const context = buildContext(project, { agent, sessionId });
  if (!sessionId) return context;
  const fp = fingerprint(project.root, project.relDir);
  const hash = contextHash(context);
  return withLock(project.memDir, () => {
    const state = loadState(project);
    const s = touchSession(state, sessionId, agent);
    s.startFingerprint ??= fp;
    const unchanged = source === 'resume' && s.contextHash === hash;
    s.contextHash = hash;
    saveState(project, state);
    return unchanged ? '' : context;
  });
}

// Stop: ask the agent (once per working-tree state, rate limited) to update memory when the
// session changed files since it started or since the last handoff. Returns null to allow.
export function onStop(project, { agent, sessionId, alreadyContinued = false }) {
  const { onStop: mode, remindIntervalMinutes } = project.config.session;
  if (mode === 'off' || alreadyContinued || !sessionId || !exists(project.memDir)) return null;
  const fp = fingerprint(project.root, project.relDir);
  if (!fp) return null;

  return withLock(project.memDir, () => {
    const state = loadState(project);
    const isNew = !state.sessions[sessionId]?.startFingerprint;
    const s = touchSession(state, sessionId, agent);
    if (isNew) {
      // No baseline yet (hooks installed mid-session, or a resumed session whose start hook did
      // not run): take the current state as the baseline.
      s.startFingerprint = fp;
      saveState(project, state);
      return null;
    }
    const unchanged = [s.startFingerprint, s.handoffFingerprint, s.remindedFingerprint, state.lastHandoff?.fingerprint].includes(fp);
    const recentlyReminded = s.remindedAt && Date.now() - s.remindedAt < remindIntervalMinutes * 60_000;
    if (unchanged || recentlyReminded) {
      saveState(project, state);
      return null;
    }
    s.remindedFingerprint = fp;
    s.remindedAt = Date.now();
    saveState(project, state);
    return stopReminder({ dir: project.relDir, agent, session: sessionId, testCommand: project.config.tests.command });
  });
}

// Session end: record a deterministic snapshot in status.md (no model involved), so the next
// agent learns about unfinished work even when nobody wrote a handoff. `final` is false for
// agents without a session-end event, which refresh the snapshot on every stop instead.
export function onSessionEnd(project, { agent, sessionId, reason, final = true }) {
  if (project.config.session.onEnd === 'off' || !exists(project.memDir)) return;
  const fp = fingerprint(project.root, project.relDir);
  const git = gitState(project.root, project.relDir, project.config.sensitive.excludePaths);
  withLock(project.memDir, () => {
    const state = loadState(project);
    const s = sessionId ? state.sessions[sessionId] : null;
    const handedOff =
      Boolean(s?.handedOff && s.handoffFingerprint === fp) ||
      (fp !== null && state.lastHandoff?.fingerprint === fp) ||
      (fp !== null && s?.startFingerprint === fp);
    const meta = [
      `agent: ${agent}`,
      `ended: ${nowStamp()}`,
      git?.branch ? `branch: ${git.branch}` : null,
      `handoff: ${handedOff ? 'yes' : 'no'}`,
      sessionId ? `session: ${shortId(sessionId)}` : null,
      reason ? `reason: ${reason}` : null,
    ].filter(Boolean);
    const changes = formatChanges(git, 'Uncommitted changes');
    writeStatusSection(project, 'Last session', `> ${meta.join(' · ')}${changes ? `\n\n${changes}` : ''}`);
    // Keep only what a later `resume` of this session needs.
    if (sessionId && final) {
      const { contextHash: kept } = state.sessions[sessionId] ?? {};
      if (kept) state.sessions[sessionId] = { contextHash: kept, updatedAt: Date.now() };
      else delete state.sessions[sessionId];
    }
    saveState(project, state);
  });
}

// --- Test runs --------------------------------------------------------------------------

const stripAnsi = (s) => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');

// Run the project's test command, stream its output, and record the result in status.md.
export async function runTests(project, { command, agent }) {
  requireMemory(project);
  const cmd = command?.trim() || project.config.tests.command;
  if (!cmd) {
    throw new MemoryError('no test command: pass one (agent-memory test "npm test") or set "tests.command" in .agent-memory.json');
  }
  const started = Date.now();
  let tail = '';
  const keep = (chunk) => {
    tail = (tail + chunk.toString()).slice(-50_000);
  };
  const code = await new Promise((resolve) => {
    const child = spawn(cmd, { cwd: project.root, shell: true, stdio: ['inherit', 'pipe', 'pipe'] });
    child.stdout.on('data', (d) => {
      process.stdout.write(d);
      keep(d);
    });
    child.stderr.on('data', (d) => {
      process.stderr.write(d);
      keep(d);
    });
    child.on('error', (err) => {
      keep(`${err.message}\n`);
      resolve(127);
    });
    child.on('close', (c, signal) => resolve(c ?? (signal ? 128 : 1)));
  });

  const passed = code === 0;
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  const lines = redactSecrets(stripAnsi(tail), project.config.sensitive)
    .replace(/```/g, "'''")
    .split(/\r?\n/)
    .map((l) => l.trimEnd())
    .filter(Boolean)
    .slice(passed ? -3 : -20);
  const meta = `> ${nowStamp()} · ${passed ? '✅ passed' : `❌ failed (exit ${code})`} · ${seconds}s · agent: ${agent}`;
  const shownCmd = redactSecrets(cmd, project.config.sensitive).replace(/`/g, "'");
  const body = `${meta}\n\n\`${shownCmd}\`${lines.length ? `\n\n\`\`\`text\n${lines.join('\n')}\n\`\`\`` : ''}`;
  withLock(project.memDir, () => writeStatusSection(project, 'Last test run', body));
  return { code, passed, seconds };
}
