# Changelog

## Unreleased

### Breaking

- Removed built-in `sol`, `sol-high`, `astra-audit` agents and the `roles` option. To restore equivalent roles, copy the example in README's "Roles per project" section into `.claude/codex-mod.json`; the new names are `implementer`, `implementer-high` and `auditor`. The generic `codex-mod:codex` agent remains available. Leftover `roles` settings are ignored with a warning.

### Added

- Batch 1 native-parity foundation: retain public source items and notifications with source IDs, cwd, command actions/process/status/timing, patch kinds/moves/diffs, web/tool results, child model/effort/states, image/review/failure fields and row provenance. Preserve unsupported variants; deduplicate item lifecycles without rendering terminal interactions or aggregate turn diffs as new actions. Private reasoning content stays excluded.
- Full coordinator messages in the Codex subagent view through guarded, display-only `coordinator_message` rows and a Coordinator card, with source UUID deduplication across worker restarts, numbered parts above 90,000 characters, and plain text fallback. Steering/queuing status notes remain, without message excerpts; receipt display never substitutes for Codex's answer or confirms steering.
- Experimental `richRows` (default `false`): draw Codex sub-agent spawns as guarded, completed Agent rows and plan updates as guarded TodoWrite rows when the session offers that tool (otherwise `codex_plan`). Both are answered with native result shapes by the plugin, never executed, counted in the footer and shown as text with `nativeActions: false`.
- Codex reasoning summaries as best-effort live thinking, completed web searches as guarded WebSearch rows, and MCP/dynamic tool results and plan updates as display-only `codex_tool`/`codex_plan` rows. All new rows are counted in the footer and degrade to text with `nativeActions: false`.
- App-server commentary between rows, proposed plan text, and notes for Codex agent activity, context compaction, review mode, sleep and image generation. Raw reasoning is never shown; the final answer still uses the handback.

- Project roles in `.claude/codex-mod.json`, loaded at session start, with validated profiles, descriptions and optional role instructions prepended to every Codex task and live steer.
- `projectRoles` (default `true`) to enable project role loading and `allowProjectFullAccess` (default `false`) as the user-level opt-in for repository-declared `danger-full-access` roles.

### Fixed

- Bind display answers to the session, agent, exact tool, immutable emitted input and source record; intercept every reserved display ID, including unknown tool names, in both guards and catches. Give real handback calls a separate namespace. Cache verified ordinary ownership and restore Codex ownership from durable records during lookup outages.
- Filter each Codex agent's native tool list by availability, with admitted display/text fallbacks. Validate baseline native answers and registered content-block arrays before emission and consumption; include required WebSearch mode and completed Agent fields. Report failed/declined operations through `deny`, preserve full shell output and trailing newlines, and keep partial assistant answers out of final handback.
- In `handbackMode: auto`, use text directly when the complete API conversation has no handback signal, and remember failed handbacks per session so new agents avoid repeating an unavailable `SubagentHandback` call. Explicit tool signals still take precedence.

## 1.1.0 - 2026-10-18

- New opt-in `transport` option: `exec` (default) or `app-server`. With `app-server`, a per-run Node sidecar (`scripts/codex-runner.mjs`) drives `codex app-server`, so a message sent to a running agent is delivered mid-turn (`turn/steer`) and stopping the agent sends `turn/interrupt`. Falls back to `exec` when Node, the runner or `codex app-server` is unavailable; the footer says why. New `nodePath` option.
- Visible `↪` notes in the agent's output for delivered, late and queued messages; the footer shows `app-server` and `N steer(s)`.
- Fix: messages sent to a running agent (they arrive as a `queued_command` attachment) were silently dropped; they are now delivered on both transports.
- Diagnostics: `codex exec --json` protocol drift detection, a warning for Codex older than 0.163.0, a provider-aware login check, and a `--device-auth` hint.
- Control files live in `~/.cache/codex-mod/runs` (mode 0700) and are pruned after `pruneDays`.

## 1.0.0

First public release.

- Subagent types `codex-mod:codex`, `codex-mod:sol`, `codex-mod:sol-high` and `codex-mod:astra-audit` answered by the local Codex CLI (`codex exec --json`) under the user's own login, with no Anthropic request for the agent's work.
- Streaming `turn.step` hook; Codex commands and file changes rendered as native Bash, Edit and Write rows answered by a guarded `tool.call` hook and never executed by Claude.
- Final answer delivered through `SubagentHandback`, with a text fallback and a footer (agent, model, effort, sandbox, actions, Codex tokens, thread).
- Agents registered at session start from Codex's `models_cache.json`; model and effort overrides validated against it.
- Lean launches (about half the input tokens), optional plugin-owned Codex home to skip global rules.
- Launch guard and anti-loop handling of engine notices; per-agent thread resume for follow-ups.
- Configurable through `userConfig`: Codex path, defaults, roles, lean, extra config, handback mode, footer, native rows, progress throttling, timeout, launch guard and record retention.
