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

**2. A repository, one command per project.**

```sh
shared-memory install .          # or: shared-memory install ~/projects/my-app
shared-memory doctor .
git add docs/memory .agent-memory.json AGENTS.md CLAUDE.md .claude .agents
git commit -m "Add shared agent memory"
```

`install` is **idempotent**. It is safe to re-run, for example after upgrading the tool, and it
**never overwrites memory content** or your own hooks. It creates:

| File | For | Contents |
| --- | --- | --- |
| `.agent-memory.json` | all | Project configuration (see [Configuration](#configuration)) |
| `docs/memory/project.md` | all | Stable context: overview, stack, commands, architecture, conventions |
| `docs/memory/decisions.md` | all | Decisions and why they were made (newest at the bottom) |
| `docs/memory/learnings.md` | all | Gotchas, root causes, environment quirks |
| `docs/memory/handoff.md` | all | Handoffs between sessions, **newest first** |
| `docs/memory/status.md` | all | Local snapshot: last session and last test run (*gitignored*) |
| `CLAUDE.md` | Claude Code | Memory protocol block (between markers; the rest of the file is untouched) |
| `.claude/settings.json` | Claude Code | Project hooks: `SessionStart`, `Stop`, `SessionEnd` |
| `.claude/commands/memory-{handoff,save}.md` | Claude Code | `/memory-handoff`, `/memory-save` |
| `AGENTS.md` | Antigravity (+ other agents) | The same memory protocol block |
| `.agents/hooks.json` | Antigravity IDE & CLI | Workspace hooks: `SessionStart`, `Stop` |
| `.agents/workflows/memory-{handoff,save}.md` | Antigravity | `/memory-handoff`, `/memory-save` |

Options:

- `--agents claude` or `--agents antigravity` installs a single agent. The choice is saved in the config.
- `--dir .memory` uses a different memory location.
- `--memory-only` creates the memory without any agent integration.

`uninstall` removes the integrations and restores your files exactly as they were.
Memory files and the config are kept.

## Session automation

| When | Claude Code | Antigravity | What happens |
| --- | --- | --- | --- |
| **Session start** | `SessionStart` | `SessionStart` | Memory context is injected: latest handoff, status, `project.md`, recent decisions and learnings, and extra files from the config. The working-tree state at that moment is recorded as the baseline. |
| **Agent finishes a reply** | `Stop` | `Stop` | If this session changed files since it started or since the last handoff, the agent is asked to save decisions/learnings, run tests via `agent-memory test`, and write a handoff with `--session <id>`. |
| **Session closes** | `SessionEnd` | *(every `Stop`)* | A deterministic snapshot (no model involved) is written to `status.md`: agent, time, branch, uncommitted changes, and whether a handoff was written. |

The `Stop` reminder is designed to stay out of the way:

- **Once per code state.** If nothing new changed, the agent is not asked again.
- **Rate limited.** The default is `session.remindIntervalMinutes: 20`.
- **Loop-safe.** Claude uses `stop_hook_active`. Antigravity is only reminded when `fullyIdle` is true and there is no error.
- **One entry per session.** A handoff with the same `--session` **replaces** that session's entry, so `handoff.md` does not pile up.
- **Skippable.** For trivial changes the agent can reply with one line and stop.

If a session ends without a handoff, the next session receives the warning
"⚠ The previous session ended without a handoff" together with the list of uncommitted changes.

Set `"session": { "onStop": "off" }` to disable the reminder, or `"onEnd": "off"` to disable
the snapshot.

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
    "files": []                          // extra repository files, e.g. ["docs/architecture.md"]
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
  }
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
npm test       # node:test, no dependencies (24 tests)
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
