# Changelog

All notable changes to this project are documented here.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this
project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.5.2] - 2026-10-29

### Changed

- `context.maxChars` is now a hard limit. Truncation counts its own "truncated" note, and a section
  that no longer fits is left out with a pointer to `agent-memory read`. Previously the context
  could exceed the limit by about 15%.
- A resumed Claude Code session only gets the memory context again when the memory changed since
  it was last injected (for example, another agent wrote a handoff). After `clear` or `compact` it
  is always injected again. Changes to the local `status.md` do not count.
- A session is no longer told that it itself ended without a handoff.
- The `Stop` reminder is about half as long, with one required command (the handoff). Saving
  decisions or learnings is optional, and running tests is only suggested when `tests.command` is
  set.

### Documentation

- A "Token cost" section in the README.

## [0.5.1] - 2026-10-29

### Changed

- The Claude Code `Stop` reminder is returned as `hookSpecificOutput.additionalContext` instead
  of `decision: "block"`. Claude still continues the turn with the same loop protections, but the
  transcript labels it "Stop hook feedback" instead of "Stop hook error", and no error
  notification is shown.

### Documentation

- When the `Stop` reminder appears, and how to make it less frequent
  (`session.remindIntervalMinutes`) or turn it off (`session.onStop: "off"`).

## [0.5.0] - 2026-10-28

### Added

- `install` imports Claude Code auto memory on the first run, once. The time is recorded as
  `claude.importedAt`, so later installs never re-add entries you deleted.
- `install --per-branch` imports only the current branch's memories, and `install --skip-import`
  skips the import. The `claude.importOnInstall` setting (`auto`, `all`, `branch`, `off`) controls
  the default.
- `install` sets `"autoMemoryEnabled": false` in `.claude/settings.json`
  (`claude.disableAutoMemory`). A value the user already set is kept, and `uninstall` removes the
  setting again.
- Session-start context includes the instruction file each agent does not load by itself:
  `CLAUDE.md` for Antigravity and `GEMINI.md` for Claude Code (`context.agentInstructions`).
- Protocol rule: project instructions in `CLAUDE.md`, `AGENTS.md` and `GEMINI.md` apply to every
  agent.

### Changed

- When Antigravity is installed, `CLAUDE.md` gets an `@AGENTS.md` import instead of a second copy of
  the protocol. Claude Code skips `AGENTS.md` whenever a `CLAUDE.md` exists, unless `CLAUDE.md`
  imports it. With Claude Code alone, `CLAUDE.md` keeps its own copy of the protocol.
- `project.md` is optional. The context no longer asks for it to be filled in when the instruction
  files already describe the project, and it is not created when `project` is left out of
  `context.sections`.
- `install` ends by saying the project is ready and lists the files to commit.

## [0.4.0] - 2026-10-28

### Added

- `import claude --branch <name>|current` keeps memories about that branch or about no branch,
  skips memories that only mention other branches, and shows the reason for each one.
- Explicit markers (`only on`, `exclusively for`, or Indonesian `KHUSUS`/`hanya`, followed by a
  branch name) assign a memory to one branch even when it mentions others.
- `import claude --prune` removes earlier imports that the filters now exclude. Entries edited by
  hand are never removed.
- `branches` setting: aliases that notes use for each branch.
- Each imported entry records a content `hash`, so hand edits are detected regardless of the
  importer version. `--update` and `--prune` never touch an entry that was edited by hand.
- MIT `LICENSE` and the package `author`.

### Changed

- Imported entries take their title from the memory's description (its first clause) instead of
  the first heading in the body.

## [0.3.0] - 2026-10-28

### Added

- `import claude`: a one-way, read-only import of Claude Code auto memory
  (`~/.claude/projects/<project>/memory/`) into the shared memory.
  - Finds the directory the way Claude Code does: `autoMemoryDirectory`, `CLAUDE_CONFIG_DIR`,
    `CLAUDE_CODE_PROJECT_DIR_NAME`, then the git root (shared by all worktrees). `--from <dir>`
    sets it explicitly.
  - Maps `feedback` to `decisions.md` and `project`/`reference` to `learnings.md`. Personal `user`
    memories, anything that looks like a secret, and titles that already exist are skipped.
  - Shows the plan only, unless `--apply` is given. `--types` filters memory types, and `--json`
    prints the plan.
  - Safe to re-run: every entry carries `source: claude-memory/<file>`, and `--update` refreshes
    entries whose source memory changed.
  - `[[links]]` between memories become the linked entry's title, and headings inside a memory are
    demoted so they cannot break the file.
- Protocol rule: keep project knowledge in the shared memory, not in an agent's private memory.

## [0.2.0] - 2026-10-28

First release.

### Added

- Shared, git-tracked memory in `docs/memory/`: `project.md`, `decisions.md`, `learnings.md`,
  `handoff.md` (newest first, rotated into `archive/`), and a local `status.md`.
- CLI (`shared-memory`, `agent-memory`, `amem`): `install`, `uninstall`, `doctor`, `config`,
  `read`, `search`, `save`, `handoff`, `test`, `status`, and `hook`.
- Claude Code integration: memory protocol in `CLAUDE.md`; `SessionStart`, `Stop` and `SessionEnd`
  hooks in `.claude/settings.json`; `/memory-handoff` and `/memory-save` commands.
- Antigravity integration: memory protocol in `AGENTS.md`; `SessionStart` and `Stop` hooks in
  `.agents/hooks.json`; `/memory-handoff` and `/memory-save` workflows.
- Session automation: context injected at session start; a reminder to write a handoff when the
  session changed files (once per code state, rate limited, loop-safe); a status snapshot when the
  session ends; `handoff --session` replaces that session's entry.
- `.agent-memory.json` project configuration with validation: context sections and extra files,
  handoff rotation, session modes, test command, sensitive patterns and excluded paths.
- Secret detection on writes and redaction of captured test output.
- Safe concurrent writes (lock file and atomic writes). Merges with existing hooks and restores
  files on uninstall.
- Verified with Claude Code 2.1.312 and Antigravity CLI 1.4.9.

[Unreleased]: https://github.com/andriest/agent-memory-cli/compare/v0.5.2...HEAD
[0.5.2]: https://github.com/andriest/agent-memory-cli/compare/v0.5.1...v0.5.2
[0.5.1]: https://github.com/andriest/agent-memory-cli/compare/v0.5.0...v0.5.1
[0.5.0]: https://github.com/andriest/agent-memory-cli/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/andriest/agent-memory-cli/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/andriest/agent-memory-cli/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/andriest/agent-memory-cli/releases/tag/v0.2.0
