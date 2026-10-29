# Shared Agent Memory

Shared project memory for coding agents such as **Claude Code** and **Gemini Antigravity**.
Memory is plain Markdown in `docs/memory/`, committed to the repository.
No server, database, API keys or OpenClaw required.

The core principle: **the Markdown files are the source of truth; the CLI is only a helper.**
Every file can be read and edited by hand, any agent that reads `AGENTS.md` follows the same
protocol, and per-agent automation (hooks) is an addition, not a requirement.

```
            ┌────────────────────────────────────────────┐
            │      agent-memory / shared-memory (CLI)    │
            │ install · read · save · search · handoff · │
            │            test · status · doctor          │
            └────────────────────────────────────────────┘
  ┌───────────────────────────────┐  ┌───────────────────────────────┐
  │          Claude Code          │  │      Gemini Antigravity       │
  │ CLAUDE.md + .claude/settings  │  │ AGENTS.md + .agents/hooks.json│
  │ SessionStart · Stop · SessEnd │  │ SessionStart · Stop           │
  │ /memory-handoff, /memory-save │  │ /memory-handoff, /memory-save │
  └───────────────┬───────────────┘  └───────────────┬───────────────┘
                  └────────────────┐  ┌──────────────┘
                                   ▼  ▼
            ┌────────────────────────────────────────────┐
            │      docs/memory/  (Markdown, in git)      │
            │  project · decisions · learnings · handoff │
            └────────────────────────────────────────────┘
```

The tool **never touches** Claude's (`~/.claude/…`) or Gemini's (`~/.gemini/…`) internal memory
directories. Memory therefore stays auditable, can be reviewed in pull requests, and moves to
another machine with a `git clone`.

## Installation

**1. The CLI, once per machine.** Requires Node.js 18.17 or later. No other dependencies.

```sh
npm install -g github:andriest/agent-memory-cli   # once this repo is pushed to GitHub
# or from a local copy:
git clone https://github.com/andriest/agent-memory-cli.git ~/tools/agent-memory-cli && npm install -g ~/tools/agent-memory-cli
```

Three equivalent command names are installed: `shared-memory`, `agent-memory` and `amem`.

**2. A repository: one command, once.**

```sh
shared-memory install .          # or: shared-memory install ~/projects/my-app
```

That is the whole setup. Then start `claude` or `agy` in the project: the shared memory, the
project instructions and the previous handoff load automatically. Review the changes and
commit them so the setup travels with the repository:

```sh
git add docs/memory .agent-memory.json AGENTS.md CLAUDE.md .claude .agents
git commit -m "Add shared agent memory"
```

On the first run `install` does everything:

1. **Creates the shared memory** in `docs/memory/` and the config `.agent-memory.json`.
2. **Wires both agents to it**: the memory protocol in `AGENTS.md`, session hooks, and the
   `/memory-handoff` and `/memory-save` commands for each agent.
3. **Connects their instruction files** without moving your content. Claude Code skips
   `AGENTS.md` whenever a `CLAUDE.md` exists, so `CLAUDE.md` gets an `@AGENTS.md` import.
   Antigravity does not read `CLAUDE.md`, so its session-start hook includes `CLAUDE.md`'s own
   instructions; Claude's hook does the same for `GEMINI.md`.
4. **Imports Claude Code's private auto memory** for this project (personal `user` memories and
   anything that looks like a secret are skipped). This happens once: the time is recorded as
   `claude.importedAt`, so later installs never re-add entries you deleted.
5. **Turns off Claude Code's private auto memory** for the project (`"autoMemoryEnabled": false`),
   so new knowledge goes to the shared memory. An explicit value you already set is kept.

For a repository where **each branch has its own rules**, run `shared-memory install . --per-branch`
on each branch, after listing branch aliases (see
[Repositories where each branch has its own rules](#repositories-where-each-branch-has-its-own-rules)).
Only that branch's memories are imported, and the choice is saved in that branch's config.

`install` is **idempotent**. It is safe to re-run, for example after upgrading the tool, and it
**never overwrites memory content** or your own hooks and settings. `shared-memory doctor .`
checks the result. Files it touches:

| File | For | Contents |
| --- | --- | --- |
| `.agent-memory.json` | all | Project configuration (see [Configuration](#configuration)) |
| `docs/memory/project.md` | all | Optional curated context: overview, stack, commands, architecture, conventions. Not needed when `CLAUDE.md`/`AGENTS.md` already describe the project |
| `docs/memory/decisions.md` | all | Decisions and why they were made (newest at the bottom) |
| `docs/memory/learnings.md` | all | Gotchas, root causes, environment quirks |
| `docs/memory/handoff.md` | all | Handoffs between sessions, **newest first** |
| `docs/memory/status.md` | all | Local snapshot: last session and last test run (*gitignored*) |
| `CLAUDE.md` | Claude Code | An `@AGENTS.md` import between markers (the rest of the file is untouched) |
| `.claude/settings.json` | Claude Code | Project hooks `SessionStart`, `Stop`, `SessionEnd`; `"autoMemoryEnabled": false` |
| `.claude/commands/memory-{handoff,save}.md` | Claude Code | `/memory-handoff`, `/memory-save` |
| `AGENTS.md` | Antigravity (+ other agents) | The memory protocol block |
| `.agents/hooks.json` | Antigravity IDE & CLI | Workspace hooks: `SessionStart`, `Stop` |
| `.agents/workflows/memory-{handoff,save}.md` | Antigravity | `/memory-handoff`, `/memory-save` |

Options:

- `--agents claude` or `--agents antigravity` installs a single agent. The choice is saved in the
  config. With Claude Code alone, `CLAUDE.md` gets the protocol itself instead of an import.
- `--per-branch` imports only the current branch's Claude memories (see above).
- `--skip-import` skips the Claude memory import. `--memory-only` creates the memory without any
  agent integration.
- `--dir .memory` uses a different memory location.

`uninstall` removes the integrations, including the `autoMemoryEnabled` setting it added, and
restores your files exactly as they were. Memory files and the config are kept.

## Session automation

| When | Claude Code | Antigravity | What happens |
| --- | --- | --- | --- |
| **Session start** | `SessionStart` | `SessionStart` | Memory context is injected: latest handoff, status, `project.md`, recent decisions and learnings, and extra files from the config. The working-tree state at that moment is recorded as the baseline. |
| **Agent finishes a reply** | `Stop` | `Stop` | If this session changed files since it started or since the last handoff, the agent is asked to save decisions/learnings, run tests via `agent-memory test`, and write a handoff with `--session <id>`. |
| **Session closes** | `SessionEnd` | *(every `Stop`)* | A deterministic snapshot (no model involved) is written to `status.md`: agent, time, branch, uncommitted changes, and whether a handoff was written. |

The `Stop` reminder is designed to stay out of the way:

- **Only when code changed.** Questions and answers without file changes never trigger it, and
  neither do changes inside `docs/memory/`.
- **Once per code state.** If nothing new changed, the agent is not asked again.
- **Rate limited.** The default is `session.remindIntervalMinutes: 20`.
- **Feedback, not an error.** In Claude Code the reminder is returned as
  `hookSpecificOutput.additionalContext`, which the transcript labels "Stop hook feedback".
  A `decision: "block"` would be labelled "Stop hook error" even though nothing failed.
  In Antigravity it is a `{"decision": "continue", "reason": …}` system message.
- **Loop-safe.** Claude uses `stop_hook_active` (and Claude Code's own cap on consecutive
  continuations). Antigravity is only reminded when `fullyIdle` is true and there is no error.
- **One entry per session.** A handoff with the same `--session` **replaces** that session's entry, so `handoff.md` does not pile up.
- **Skippable.** For trivial changes the agent can reply with one line and stop.

If a session ends without a handoff, the next session receives the warning
"⚠ The previous session ended without a handoff" together with the list of uncommitted changes.

Set `"session": { "remindIntervalMinutes": 60 }` to be reminded less often,
`"session": { "onStop": "off" }` to disable the reminder, or `"onEnd": "off"` to disable the
snapshot. With the reminder off, a session that ends without a handoff is still recorded in
`status.md` and flagged to the next session.

## Daily use

```sh
shared-memory read                        # context summary (the same one hooks inject)
shared-memory read handoff                # latest handoff (--all for every entry)
shared-memory status                      # last session + last test run

shared-memory search pnpm ci              # each argument is a term; "quote a phrase" to match it
shared-memory search auth --in decisions --full

shared-memory save decision "Use pnpm workspaces" \
  --body "Faster installs; the monorepo needs workspaces." --tags tooling,deps --agent claude
shared-memory save learning "Vitest needs --pool=forks on CI" --body - --agent antigravity < notes.md

shared-memory test                        # run tests.command and record the result
shared-memory test "npm run test:unit"    # or any other command

shared-memory handoff --agent claude --summary "Login form wired to the API" \
  --done "POST /login endpoint" --next "Add refresh tokens" --blockers "API error format?"
```

`handoff` automatically includes the git branch, the last test run, and the list of uncommitted
changes. The memory folder and sensitive paths are left out.

## Migrating existing Claude Code memory

If Claude Code has already built up auto memory for a project
(`~/.claude/projects/<project>/memory/`), import it once so every agent can use it:

```sh
shared-memory import claude            # show the plan; nothing is written
shared-memory import claude --apply    # write it
git diff docs/memory                   # review, edit or delete entries, then commit
```

| Claude memory type | Imported into | Notes |
| --- | --- | --- |
| `feedback` | `decisions.md` (tags `imported, convention`) | How to work on this project |
| `project` | `learnings.md` (tags `imported, project`) | Facts, findings, project state |
| `reference` | `learnings.md` (tags `imported, reference`) | Pointers to external resources |
| `user` | **skipped** | Personal preferences stay private; shared memory is committed to git |

- **Read-only on Claude's side.** Claude's memory files are only read, never changed or deleted.
- **Finds the directory like Claude Code does.** It uses `autoMemoryDirectory` (local, project
  or user settings), `CLAUDE_CONFIG_DIR`, `CLAUDE_CODE_PROJECT_DIR_NAME`, then
  `~/.claude/projects/<encoded git root>/memory` (shared by all worktrees). Use
  `--from <dir>` to point at it explicitly.
- **Safe to re-run.** Every entry carries `source: claude-memory/<file>`, so imported files are
  skipped. `--update` refreshes entries whose source memory changed since the import.
- **Converted to the shared format.** Titles come from the memory's heading or the first clause of
  its description (the full description is kept in the body). `[[links]]` between memories
  become the linked entry's title, and headings inside a memory are demoted so they cannot
  break the file. Dates come from the memory's `modified` timestamp.
- **Filtered.** Entries that look like secrets are skipped, and so are titles that already
  exist. `--types feedback,project` limits what is imported, and `--json` prints the plan
  for scripts.
- **`project.md` is not touched.** It stays curated by hand. Promote stable facts into it
  yourself, or ask an agent to.
- **Hand edits are protected.** Each imported entry records a `hash:` of its own text. An entry
  you edited after importing is never overwritten by `--update` or removed by `--prune`.

### Repositories where each branch has its own rules

`docs/memory/` lives in the repository, so every branch already has its own memory. Claude
Code's auto memory, however, is one directory for the whole repository, so it mixes the
rules of every branch. Use `--branch` to import only what belongs to the current branch:

```sh
shared-memory import claude --branch current                  # plan, with a reason per memory
shared-memory import claude --branch current --prune --apply  # also remove earlier imports
                                                              # that belong to other branches
```

A memory is **kept** when it mentions this branch, mentions no branch at all (a general rule),
or mentions several branches including this one (a rule that lists them all). It is
**skipped** when it only mentions other branches. An explicit marker in the description or
first line (`only on X`, `exclusively for X`, or Indonesian `KHUSUS`/`hanya` + X) overrides that and assigns the
memory to X alone.

Branches are recognised by name from `git branch` (local and remote), and by their last path
segment (`borealis` for `brand/borealis`). Common names such as `main` only count in a branch
context (`` `main` ``, "branch main"). Notes often refer to a branch by another name, so
list aliases in `.agent-memory.json`:

```json
"branches": {
  "main": ["Core Site"],
  "brand/aurora": ["Aurora Shop"],
  "brand/borealis": ["Borealis Store"]
}
```

Matching is done on the text of each memory, so review the reasons in the plan before
`--apply`. A general memory that happens to name another branch's channel will be skipped;
add it back by hand, or re-run without `--branch` and delete what you do not want.
`--prune` only removes entries that carry a `source: claude-memory/…` marker and were not
edited by hand.

After importing, Claude Code still keeps writing its private memory. To make the shared memory
the only one for the project, add `"autoMemoryEnabled": false` to `.claude/settings.json`.
The memory protocol in `AGENTS.md`/`CLAUDE.md` also tells every agent to keep project
knowledge in the shared memory.

Antigravity CLI has no plain-text memory store to import from: in version 1.4.9 its
per-conversation data is internal binary protobuf. Notes it writes into `GEMINI.md`,
`AGENTS.md` or `.agents/rules/` are already project files, which both agents can read.

## Configuration

`.agent-memory.json` at the repository root. Every key is optional; missing keys fall back to
the defaults. `shared-memory config` prints the effective configuration. Invalid values are
rejected with a clear message; unknown keys only produce a warning.

```jsonc
{
  "dir": "docs/memory",                  // memory location
  "agents": ["claude", "antigravity"],   // integrations installed by `install`
  "context": {
    "maxChars": 8000,                    // injected context budget (Claude truncates hook output over 10,000)
    "recent": 5,                         // number of recent decisions/learnings
    "sections": ["handoff", "status", "project", "decisions", "learnings", "files"],  // selection & order
    "files": [],                         // extra repository files, e.g. ["docs/architecture.md"]
    "agentInstructions": true            // give each agent the instruction file it does not read itself
  },
  "handoff": {
    "keep": 10,                          // handoffs kept in handoff.md; the rest go to archive/handoffs.md
    "gitChanges": true                   // include branch & uncommitted changes
  },
  "session": {
    "onStop": "remind",                  // "remind" | "off"
    "remindIntervalMinutes": 20,
    "onEnd": "status"                    // "status" | "off"
  },
  "tests": { "command": "" },            // e.g. "npm test"; used by `shared-memory test`
  "sensitive": {
    "patterns": [],                      // extra regexes to refuse, e.g. ["\\bCUST-\\d{6}\\b"]
    "allow": [],                         // literals known to be safe (false positives)
    "excludePaths": [".env", ".env.*", "*.pem", "*.key", "*.p12", "secrets/**", "credentials*"]
  },
  "claude": {
    "disableAutoMemory": true,           // install sets "autoMemoryEnabled": false
    "importOnInstall": "auto"            // first install imports Claude memory: "auto" (per branch
                                         // when `branches` is set), "all", "branch" or "off";
                                         // `importedAt` is recorded afterwards
  },
  "branches": {}                         // branch aliases for `import claude --branch`, e.g.
                                         // { "brand/aurora": ["Aurora Shop"] }
}
```

`sensitive.excludePaths` hides these paths from handoffs and status, and matching files are never
read through `context.files`. A pattern without `/` matches the file name in any folder.

## Safety

- **Secret detection.** `save` and `handoff` refuse content that looks like a private key,
  a GitHub, Slack or AWS token, an `sk-…` key, a JWT, `password=…`, a URL with an embedded
  password, or a pattern from `sensitive.patterns`. Test output and test commands are
  **redacted** (`[REDACTED]`) before they are recorded. References such as
  `process.env.API_KEY` or `${TOKEN}` are allowed.
- **No duplicates.** An existing title is refused so the old entry gets edited instead. Use `--force` to add it anyway.
- **Safe concurrent writes.** Writes use a lock file and are atomic.
- **Hooks never break a session.** If the CLI is not installed, the memory does not exist, or an
  error occurs, the hook emits each agent's valid "do nothing" output and exits 0.
- **Merge, never overwrite.** Your hooks in `.claude/settings.json` and `.agents/hooks.json`,
  including ones on the same events, are kept in their original order. Malformed JSON files are
  reported, not overwritten.

## Verified compatibility

Tested on 2026-10-28 with real headless sessions (`claude -p` and `agy -p`), not just unit tests:

| Agent | Version | SessionStart (context injected) | Stop (reminder → handoff) | Session end (status) |
| --- | --- | --- | --- | --- |
| Claude Code | 2.1.312 | ✅ | ✅ agent received the reminder | ✅ `SessionEnd` |
| Antigravity CLI (`agy`) | 1.4.9 | ✅ | ✅ agent ran the tests and wrote a handoff | ✅ via `Stop` |
| Antigravity IDE | — | not tested | not tested | not tested |

The Claude Code `Stop` reminder was re-verified on 2026-10-29 after switching to
`additionalContext`: the agent received it, continued, and wrote the session's handoff with
`--session`. The "Stop hook feedback" label appears only in interactive sessions, so that part
comes from the Claude Code hooks documentation rather than from a headless test.

Instruction files were verified the same way: Claude Code read a codeword that existed only in
`AGENTS.md` (through the `@AGENTS.md` import inside the managed block), and Antigravity CLI read
a codeword that existed only in `CLAUDE.md` (through its session-start hook).

Notes:

- **Antigravity IDE** uses the same `.agents/hooks.json` file and format according to the
  documentation, but has not been tested directly. If hooks do not run in the IDE, `AGENTS.md`
  (supported since IDE 1.20.5) still tells the agent to run `agent-memory read`.
- **Antigravity `injectSteps` format.** The documentation is inconsistent. The form that works in
  `agy` 1.4.9 is `{"injectSteps":[{"systemMessage":{"systemMessage":"…"}}]}`.
- **Gemini CLI** (not Antigravity) reads `GEMINI.md` by default. Add
  `"context": { "fileName": ["AGENTS.md", "GEMINI.md"] }` to `.gemini/settings.json`.
- **Windows.** Hook commands use `sh` syntax (`command -v …`). Claude Code runs them through
  Git Bash. These hooks have not been tested with Antigravity on Windows.

## Memory format

Every entry is a level-2 section. The metadata line is optional, so entries written by hand are
still understood by the tool:

```markdown
## 2026-10-28 · Use pnpm workspaces
> agent: claude · tags: tooling, deps

What was decided and why. Alternatives that were rejected.
```

`status.md` and `.state.json` are local only (gitignored), because they describe this machine's
working tree. Anything that should be shared across machines belongs in a handoff.

## Development

```sh
npm test       # node:test, no dependencies (37 tests)
```

Code layout:

- `src/cli.mjs` — commands, argument parsing, and per-agent hook adapters (stdin/stdout formats)
- `src/session.mjs` — session logic (start/stop/end) and the test runner
- `src/memory.mjs` — memory operations, context, search, handoffs
- `src/config.mjs` — defaults and validation for `.agent-memory.json`
- `src/integrations.mjs` — install/uninstall/inspect for Claude Code and Antigravity
- `src/git.mjs` — git status, working-tree fingerprint, sensitive path filter
- `src/templates.mjs` — all text written into target repositories
- `src/markdown.mjs` — entry parser and managed blocks
- `src/secrets.mjs` — secret detection and redaction
- `src/importers/claude.mjs` — one-way import of Claude Code auto memory
