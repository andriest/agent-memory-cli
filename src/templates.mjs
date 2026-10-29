// Text written into target repositories. Everything an agent reads is in English so the
// instructions work the same for every model.

export const MANAGED_MARKER = '<!-- managed by shared-agent-memory: edits are overwritten by `agent-memory install` -->';

// The compact protocol placed in AGENTS.md and CLAUDE.md. Kept short: it is in every prompt.
export function protocolBlock(d) {
  return `## Shared agent memory

This repository keeps durable memory shared by every coding agent (Claude Code, Gemini Antigravity, …) in \`${d}/\` — plain Markdown committed to git. It is the source of truth for project context, past decisions, learnings and work in progress. Use the \`agent-memory\` CLI when it is installed; otherwise read and edit the files directly, following the format in \`${d}/README.md\`.

**Start of session**
- Unless the memory was already injected into your context by a hook, run \`agent-memory read\` (fallback: read the top entry of \`${d}/handoff.md\`, then \`${d}/project.md\`, and skim \`${d}/decisions.md\` and \`${d}/learnings.md\`).
- Continue from the latest handoff's "Next" items unless the user asks for something else.
- Project instructions in \`CLAUDE.md\`, \`AGENTS.md\` and \`GEMINI.md\` apply to every agent, whichever tool they were written for. Read any of them that is not already in your context.

**While working**
- Before re-deciding or re-investigating something, search: \`agent-memory search <keyword> [keyword…]\`.
- Record durable decisions (what + why): \`agent-memory save decision "<title>" --body "<what and why>" --tags <a,b> --agent <your-name>\`.
- Record non-obvious learnings (gotchas, root causes, environment quirks): \`agent-memory save learning "<title>" --body "…" --agent <your-name>\`.
- Keep \`${d}/project.md\` true: edit it directly when the stack, commands, architecture or conventions change.
- If an entry is wrong or outdated, edit or delete it in place instead of adding a contradicting one.
- Run tests through \`agent-memory test ["<command>"]\` so the result is recorded for the next agent.

**End of session / before handing off** — always leave a handoff:
\`agent-memory handoff --agent <your-name> --summary "<one line>" --done "<item>" --next "<item>" [--blockers "<item>"]\` (repeat \`--done\`, \`--next\`, \`--blockers\` once per item). A stop hook may remind you with the exact command; pass its \`--session\` value so repeated handoffs update one entry.

**Rules**
- Keep project knowledge here, not in your agent's private or built-in memory, so every agent can see it.
- Never write secrets, tokens, credentials or personal data to memory; it is committed to git.
- Save only durable knowledge that is not obvious from the code or git history. No transcripts or step-by-step logs.
- Memory can be stale: verify file, function and command names against the code before relying on them.
- Use your agent name consistently: \`claude\` for Claude Code, \`antigravity\` for Gemini Antigravity.`;
}

// What CLAUDE.md gets when AGENTS.md carries the protocol: Claude Code skips AGENTS.md
// whenever a CLAUDE.md exists, unless CLAUDE.md imports it.
export const CLAUDE_IMPORT_BLOCK = '@AGENTS.md';

export function contextHeader(d) {
  return `# Shared agent memory (${d}/)
Durable project memory shared by all coding agents. Follow the "Shared agent memory" protocol in AGENTS.md / CLAUDE.md: search before re-deciding, save decisions and learnings, write a handoff before you stop. Memory can be stale — verify against the code.`;
}

export function memoryReadme(d) {
  return `# Shared agent memory

${MANAGED_MARKER}

This folder is long-term memory shared by every coding agent working on this repository
(Claude Code, Gemini Antigravity, or a human). It is plain Markdown, versioned with the code,
so it is auditable, reviewable in pull requests, and moves with the repository to any machine.

Managed by the \`agent-memory\` CLI (\`shared-agent-memory\`), but every file can be read and
edited by hand.

| File | Purpose | Written by |
| --- | --- | --- |
| \`project.md\` | Curated, stable context: overview, stack, commands, architecture, conventions | Edited directly |
| \`decisions.md\` | Durable decisions and *why* (newest at the bottom) | \`agent-memory save decision\` |
| \`learnings.md\` | Gotchas, root causes, environment quirks (newest at the bottom) | \`agent-memory save learning\` |
| \`handoff.md\` | Session handoffs, **newest first**; the top entry is the current state | \`agent-memory handoff\` |
| \`archive/\` | Older handoffs rotated out of \`handoff.md\` | automatic |
| \`status.md\` | Local snapshot: last session end, last test run (gitignored) | session hooks, \`agent-memory test\` |
| \`.state.json\` | Local bookkeeping for the session hooks (gitignored) | session hooks |

Project settings (sections to read, extra files, handoff rotation, session automation,
sensitive patterns and excluded paths) live in \`.agent-memory.json\` at the repository root.

## Entry format

Every entry is a level-2 section. The metadata line is optional.

\`\`\`markdown
## 2026-10-28 · Use pnpm workspaces
> agent: claude · tags: tooling, deps

What was decided and why. Alternatives that were rejected.
\`\`\`

Handoffs use the same shape with a time and fixed sub-sections:

\`\`\`markdown
## 2026-10-28 17:40 · Login form wired to API
> agent: antigravity · branch: feat/login

**Done**
- …

**Next**
- …

**Blockers / open questions**
- …
\`\`\`

## Rules

- No secrets, tokens, credentials or personal data — this folder is committed to git.
- Only durable knowledge that is not obvious from the code or git history.
- Fix or delete outdated entries instead of adding contradicting ones.
- Memory can be stale: verify names against the code before relying on them.

## Commands

\`\`\`sh
agent-memory read                       # context summary (what hooks inject at session start)
agent-memory search <keyword…>          # find entries
agent-memory save decision "<title>" --body "<why>" --tags a,b --agent <name>
agent-memory save learning "<title>" --body "…" --agent <name>
agent-memory handoff --agent <name> --summary "…" --done "…" --next "…"
agent-memory test ["<command>"]         # run tests and record the result in status.md
agent-memory status                     # last session and last test run
agent-memory doctor                     # check the setup
\`\`\`
`;
}

export const PROJECT_TEMPLATE = `# Project

<!-- Curated, stable context every agent needs. Edit this file directly; keep it short and true.
     Empty sections are hidden from \`agent-memory read\`. -->

## Overview
<!-- What this project is, who it is for, current status. -->

## Stack
<!-- Languages, frameworks, key libraries and versions. -->

## Commands
<!-- How to install, run, test, lint, build and deploy. -->

## Architecture
<!-- Main modules or directories and how they fit together. -->

## Conventions
<!-- Code style, naming, branching and commit rules; things to always or never do. -->
`;

export const DECISIONS_TEMPLATE = `# Decisions

Durable technical and product decisions, and *why* they were made. Newest at the bottom.
Add with \`agent-memory save decision "<title>" --body "…"\`, or by hand in the same format.
Edit or delete entries that are no longer true.
`;

export const LEARNINGS_TEMPLATE = `# Learnings

Non-obvious things discovered while working: gotchas, root causes, environment quirks,
"this looks wrong but is intentional". Newest at the bottom.
Add with \`agent-memory save learning "<title>" --body "…"\`, or by hand in the same format.
`;

export const HANDOFF_TEMPLATE = `# Handoff

Session handoffs between agents, **newest first**. The top entry is the current state of work.
Write with \`agent-memory handoff …\`. Older entries are moved to \`archive/handoffs.md\`.
`;

export const ARCHIVE_TEMPLATE = `# Handoff archive

Older handoffs rotated out of \`../handoff.md\`, newest first.
`;

export const STATUS_TEMPLATE = `# Status

<!-- Local snapshot written by agent-memory (session hooks and \`agent-memory test\`).
     Overwritten automatically and gitignored: it describes this machine's working tree. -->
`;

// status.md and .state.json describe this machine's working tree, so they stay out of git.
export const MEMORY_GITIGNORE = `.lock
*.tmp
.state.json
status.md
`;

// Sent back to the agent by the stop hook when the session changed files without a handoff.
// Kept short, with one required command: every reminder costs the agent an extra turn.
export function stopReminder({ dir, agent, session, testCommand }) {
  const extras = [`\`agent-memory save decision|learning "<title>" --body "…" --agent ${agent}\` for a durable decision or gotcha`];
  if (testCommand) extras.push(`\`agent-memory test --agent ${agent}\` if you changed code and have not run \`${testCommand}\``);
  return `Files changed since the last shared-memory handoff (${dir}/). Before you stop, record this session for the next agent:
\`agent-memory handoff --session ${session} --agent ${agent} --summary "<one line>" --done "<item>" --next "<item>"\`
Only if relevant: ${extras.join('; ')}. If nothing worth recording changed, reply in one line and stop.`;
}

// --- Claude Code slash commands -------------------------------------------------------

export function claudeHandoffCommand(d) {
  return `---
description: Write a shared-memory handoff (${d}) so another agent can continue
argument-hint: [optional notes or focus]
---
${MANAGED_MARKER}

Write a handoff to the shared project memory so the next agent (Claude Code or Antigravity) can continue.

1. Review what happened this session (the conversation, \`git status\`, \`git diff --stat\`).
2. Save durable decisions or learnings that are not recorded yet (\`agent-memory search\` first, then \`agent-memory save decision|learning … --agent claude\`). Update \`${d}/project.md\` directly if the stack, commands, architecture or conventions changed.
3. Run \`agent-memory handoff --agent claude --summary "<one line>" --done "<item>" --next "<item>" [--blockers "<item>"]\`, one flag per item. Make "Next" concrete enough that another agent can start without asking.
4. Show the result with \`agent-memory read handoff\`.

Extra notes from the user: $ARGUMENTS
`;
}

export function claudeSaveCommand(d) {
  return `---
description: Save a decision or learning to the shared project memory (${d})
argument-hint: <what to remember>
---
${MANAGED_MARKER}

Save this to the shared project memory: $ARGUMENTS

1. Decide the type: \`decision\` (a choice and why) or \`learning\` (a gotcha, root cause or quirk). If it is stable project context (stack, commands, architecture, conventions), edit \`${d}/project.md\` directly instead.
2. Run \`agent-memory search <keywords>\`. If a matching entry exists, edit it in place rather than adding a duplicate.
3. Otherwise run \`agent-memory save <decision|learning> "<short title>" --body "<what and why>" --tags <a,b> --agent claude\`.
4. Never include secrets or credentials. Confirm what was saved.
`;
}

// --- Antigravity workflows (/memory-handoff, /memory-save) ------------------------------

export function antigravityHandoffWorkflow(d) {
  return `---
description: Write a shared-memory handoff (${d}) so another agent can continue
---
${MANAGED_MARKER}

Write a handoff to the shared project memory so the next agent (Claude Code or Antigravity) can continue. Include any notes the user gave with this command.

1. Review what happened this session (the conversation, \`git status\`, \`git diff --stat\`).
2. Save durable decisions or learnings that are not recorded yet (\`agent-memory search\` first, then \`agent-memory save decision|learning … --agent antigravity\`). Update \`${d}/project.md\` directly if the stack, commands, architecture or conventions changed.
3. Run \`agent-memory handoff --agent antigravity --summary "<one line>" --done "<item>" --next "<item>" [--blockers "<item>"]\`, one flag per item. Make "Next" concrete enough that another agent can start without asking.
4. Show the result with \`agent-memory read handoff\`.
`;
}

export function antigravitySaveWorkflow(d) {
  return `---
description: Save a decision or learning to the shared project memory (${d})
---
${MANAGED_MARKER}

Save what the user asked to remember to the shared project memory.

1. Decide the type: \`decision\` (a choice and why) or \`learning\` (a gotcha, root cause or quirk). If it is stable project context (stack, commands, architecture, conventions), edit \`${d}/project.md\` directly instead.
2. Run \`agent-memory search <keywords>\`. If a matching entry exists, edit it in place rather than adding a duplicate.
3. Otherwise run \`agent-memory save <decision|learning> "<short title>" --body "<what and why>" --tags <a,b> --agent antigravity\`.
4. Never include secrets or credentials. Confirm what was saved.
`;
}

// Hooks stay harmless on machines where the CLI is not installed: they print the agent's
// "do nothing" output instead of failing. Antigravity's Stop requires a `decision`; any value
// other than "continue" lets the agent stop.
const NOOP_OUTPUT = {
  claude: 'true',
  antigravity: { 'session-start': "echo '{}'", stop: `echo '{"decision":"stop"}'` },
};

export function hookCommand(agent, event) {
  const fallback = agent === 'claude' ? NOOP_OUTPUT.claude : NOOP_OUTPUT.antigravity[event];
  return `command -v agent-memory >/dev/null 2>&1 && agent-memory hook ${agent} ${event} || ${fallback}`;
}
