# Changelog

## 1.2.0 - 2026-10-19

- Follow the host's exact auto-mode no-verdict instruction with at most one unchanged observer-launch retry, after retiring the denied core tool ID and checkpointing the live capability. Other denials, admitted spawns and uncertain outcomes never retry.
- Recover Coordinator presentation data from verified persisted receipts before tool registration, contain missing presentation records and live-status read failures, and clarify that question controls require an explicit human answer or cancellation. Custom-card Desktop paint remains unaccepted.
- Restore unregistered host-returned Coordinator names only through session-scoped cached ownership and a matching received receipt. Keep the message primary, delivery state separate and full identifiers dimmed; preserve exported status text. Shorten unavailable-observer notices while retaining complete private diagnostics.
- Admit exact exploration results from Codex's observed `unifiedExecStartup` source while retaining conservative user-shell/interaction fallbacks. Describe compound and conditional Bash commands without reducing the label to their first token.

- Preserve bounded SHA-256 task/launch identities independently of recovery payloads, split large checkpoints below the host filesystem limit, and refuse relaunches with an explicit recovery error when state is unavailable.
- Rotate child journals into indexed 1 MiB segments with resumable cursors, preserve Unicode across stream/segment boundaries, and report persistent read failures separately from truncation.
- Replace retained row source copies with bounded presentation metadata, release consumed/run/session entries, and recover historical labels/plans lazily from a bounded private disk cache. Show one final footer on capacity fallback with a short note for the failed attempt's usage.

- R6: add per-role lean, selective capabilities and fallbackModels with user-level allowProjectNonLean/projectCapabilityAllowlist limits. Snapshot canonical overrides, role instructions and Codex home with an effective-config fingerprint for both transports; warn on model/effort continuity changes.
- Add an explicit no-subagents instruction and spawn detection when multiAgent is off. Preserve real child rows/mirrors and document native v2 feature-gate limits, MCP discovery limits and unverified history-output caps.
- Correct exec resumed accounting with persisted full-thread deltas, duplicate-total replacement, partial/unknown interruption baselines and full footer thread IDs. Keep final app-server direct/tree accounting consistent without counting response and cumulative copies twice.
- Retry capacity failures once on the same thread with a catalog-validated capacityFallback candidate (default gpt-6-sol, then gpt-5.6-sol), preserving supported effort and counting the attempt within the launch guard. Add visible switch notes and an R6 headless harness.

- Fix steering on CLI 2.1.302 when a long Codex step delays native inbox drain: route successful SendMessage calls from their persisted parent source UUID/tool ID and confirmed recipient pin, reconcile delayed receive/append copies without replay, and emit the receipt card at a settled acknowledgment boundary. Preserve append-only 1.1 steering and keep steer-v2 fake scenarios free of unrelated command/patch output.

- Steer bridge v2: per-run private HTTP/Unix control with health/generation negotiation and file fallback, durable stable message IDs, exact-turn acceptance, raw RPC rejections and explicit uncertain outcomes without replay. Exec retains a durable after-turn FIFO with the same outcome records.
- Route scoped coordinator receipts at `session.receive`, bind authoritative UUIDs at append, redraw the same literal coordinator card through declared state, and expose additive SendMessage model context plus the guarded read-only `codex_message_status` query. Retain literal/status notes and bounded host-store/private-cache persistence.

- Batch 8 mirror lifecycle: explicit parent relation in child titles and parent observation links for CLI 2.1.302's parentless depth-1 API spawns. Deduplicate message UUIDs in the owning runner, validate steer turn acknowledgements, persist delivery outcomes, distinguish stop requests from confirmed source interruption, and cascade stops through source descendants across hooks-worker recovery. Document native background-task support and unsupported reparenting, status/summary setters and separate-session adoption; add a stop/SendMessage headless harness. Desktop controls/progress and auxiliary summary traffic remain live checks.

- Add `modelAgents` (default true): register each listed Codex model as `codex-mod:<slug>`, with catalog effort defaults and supported efforts in its description. The current host rejects dots in type names, so `gpt-6.1-sol` falls back to `gpt-6-1-sol` with a log note and exact executing model ID. Project roles win collisions; unreadable catalogs retain generic/role types only.
- Resolve native Agent `effort` from the scoped tool input and detect spawn-field support; prompt lines take precedence, then native effort, then defaults. Unsupported native efforts fall back with a visible note; invalid prompt overrides still fail before launch.
- Show actual model and effort in owned launch titles (including nested observers) and alongside the parent's native Agent row, retaining native controls and failure fallback. Row/footer profiles follow later changes through the same resolver used by Codex launch. Keep the unused `haiku` execution placeholder; native GPT badges remain unsupported.

### Breaking

- Removed built-in `sol`, `sol-high`, `astra-audit` agents and the `roles` option. To restore equivalent roles, copy the example in README's "Roles per project" section into `.claude/codex-mod.json`; the new names are `implementer`, `implementer-high` and `auditor`. The generic `codex-mod:codex` agent remains available. Leftover `roles` settings are ignored with a warning.

### Added

- Nested Codex observation agents (`nestedAgents`, default true): on app-server, discover v2/legacy child identities, rejoin without a new turn, replay each child's public events through an independent fail-closed host consumer, and persist real host/Codex identity and delivery cursors. Child steering/stops target the exact thread; parent stop interrupts descendants. Add deduplicated direct/tree source accounting, honest admission/attachment/restart fallbacks, and a deterministic `nested-one-child` fixture and headless harness. Native Desktop placement, auxiliary host requests and real-server attachment remain live acceptance gates; idle child continuation is explicitly unsupported in this slice.

- Batch 6 images, modes and questions: guarded Read image previews from bounded, stable plugin filesystem reads; full generation status/result/revised prompt/failure cards; full review prose and conditional structured ReportFindings. Keep summary-only live thinking and final/partial/commentary separation, surface warnings without failing successful turns, deduplicate compaction and report sleep without timers. Add owned choice-question controls with explicit one-time, source-bound answer/cancel RPCs and conditional already-answered AskUserQuestion rows; approvals remain unsupported under `approvalPolicy:never`. Persist coordinator render records and fence literal Markdown fallbacks. Add fake app-server/exec fixtures, lifecycle/guard tests and a Batch 6 harness. Read image and ReportFindings passed an offline host mapper probe; AskUserQuestion is unavailable in noninteractive headless mode. Desktop acceptance remains outstanding.

- Batch 5 native plans and child operation rows: persist per-agent/thread display snapshots and synthetic task/child IDs; prefer admitted TodoWrite, then paired TaskCreate/TaskUpdate, with full checklist `codex_plan` fallback. Guard completed Agent spawn operations, deny failed/declined spawns, and add admitted SendMessage status/state acknowledgements and TaskStop Codex lifecycle reports. Preserve full message bodies, wait state/report transitions, source model/effort and resume/list fallbacks without launching mirrors or touching host task executors. Add exec/app-server fixtures and reducer-boundary tests. Headless Task*, TaskStop and SendMessage object mappers passed; SendMessage null is rejected despite its unknown declaration. Desktop main-list scope and synthetic-link acceptance remain live checks.

- Batch 4 web fidelity: preserve empty/structured/text/opaque search results, multi-query actions and real timing; draw open/find as guarded WebFetch only with complete reported response metadata. Missing metadata uses an action-labelled `codex_tool`; real HTTP codes and transport errors stay faithful. Preserve MCP/dynamic structured results, metadata and media descriptions without text-dumping encoded bytes. Add a shared fake app-server scenario and offline MCP harness server. Canonical MCP/dynamic substitution remains blocked on Claude 2.1.302's missing schema/original-identity discovery API; no guessed bindings or external replays. Host mapper and Desktop checks remain outstanding.

- Batch 3 exact native patches: reconstruct full additions and verified replacements from per-file source diffs, preserving empty files, CRLF and EOF markers without clipping Write/Edit inputs. Use ordered exact hunks when a combined edit exceeds the display bound; retain typed Bash patch diffs for other updates/adds, deletion flags and verified move images. Keep failed/declined/unconfirmed attempts as error rows, preserve raw diffs and patchUpdated evidence, and count source patches separately from file/hunk rows. Add deterministic app-server/exec harness fixtures and guard coverage. Host mapper acceptance and Desktop paint remain live checks.
- Batch 2 native exploration: one faithful structured command action can become guarded Read/Glob/Grep, with exact delivered text/counts and adjacent original command/cwd. Literal parsing and output framing keep pipelines, multiple actions, redirects, substitutions, directory/ambiguous listings, unknown slice totals, unsupported options and real failures as one Bash row. Normal exec commands without actions stay Bash. Extend both ownership-scoped guards and refusing catches to Read/Glob/Grep, including the placeholder Read; normal Claude calls retain their execution path. Add deterministic app-server exploration fixtures and stream/poll deduplication coverage.
- Batch 1 native-parity foundation: retain public source items and notifications with source IDs, cwd, command actions/process/status/timing, patch kinds/moves/diffs, web/tool results, child model/effort/states, image/review/failure fields and row provenance. Preserve unsupported variants; deduplicate item lifecycles without rendering terminal interactions or aggregate turn diffs as new actions. Private reasoning content stays excluded.
- Full coordinator messages in the Codex subagent view through guarded, display-only `coordinator_message` rows and a Coordinator card, with source UUID deduplication across worker restarts, numbered parts above 90,000 characters, and plain text fallback. Steering/queuing status notes remain, without message excerpts; receipt display never substitutes for Codex's answer or confirms steering.
- Experimental `richRows` (default `false`): draw Codex sub-agent spawns as guarded, completed Agent rows and plan updates as guarded TodoWrite rows when the session offers that tool (otherwise `codex_plan`). Both are answered with native result shapes by the plugin, never executed, counted in the footer and shown as text with `nativeActions: false`.
- Codex reasoning summaries as best-effort live thinking, completed web searches as guarded WebSearch rows, and MCP/dynamic tool results and plan updates as display-only `codex_tool`/`codex_plan` rows. All new rows are counted in the footer and degrade to text with `nativeActions: false`.
- App-server commentary between rows, proposed plan text, and notes for Codex agent activity, context compaction, review mode, sleep and image generation. Raw reasoning is never shown; the final answer still uses the handback.

- Project roles in `.claude/codex-mod.json`, loaded at session start, with validated profiles, descriptions and optional role instructions prepended to every Codex task and live steer.
- `projectRoles` (default `true`) to enable project role loading and `allowProjectFullAccess` (default `false`) as the user-level opt-in for repository-declared `danger-full-access` roles.

### Fixed

- Reconcile a child's replayed terminal snapshot with a buffered same-turn start before emitting a false interruption. Live completion then closes the parent normally; duplicate live terminal events remain deduplicated and usage is counted once.

- Match nested mirror admission to CLI 2.1.302's host events: bind one-time tokens and stable launch fields to the spawning step's recorded parent and one core tool ID; tolerate omitted parent/cwd metadata while refusing conflicting identities and repeated launches. Preserve source cwd for replay, remove temporary spawn diagnostics and retain bounded store/private-cache persistence.
- Keep permanent mirror launch diagnostics: explicit admission/binding reason codes and non-secret host field summaries, plus call/check admissions with the core tool ID. Re-entry diagnostics flush from the active parent after spawn settles without engine calls inside catches.

- Keep wire evidence, nested replay payloads and coordinator bodies in private run-cache files, with bounded metadata (32 Ki characters per record) in the host store. Compact legacy records on load/session pruning and contain store write failures so Codex steps and handbacks continue.
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
