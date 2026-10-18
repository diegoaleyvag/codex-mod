# Decision log

Append-only. Each entry: ID, date, decision, why, consequences. If a decision changes,
add a new entry that supersedes it and mark the old one `superseded by D-NNN`.

## D-001 - Codex actions are drawn as native rows and never executed by Claude
- Date: 2026-10-18 (1.0.0).
- Decision: Codex commands and file changes are shown as Bash/Edit/Write rows answered by a
  guarded `tool.call` hook from the result Codex already reported. Any other Bash/Edit/Write from
  a codex-mod agent is refused; a `tool.check` hook denies as a backstop. No option disables this.
- Why: Codex already ran the action under its own sandbox; executing it again would duplicate it and bypass the permission model.
- Consequences: rows are faithful only to what Codex reported (Edit rows are reconstructed from before/after text);
  guard failures refuse rather than allow; every behaviour change near the guard is high risk.

## D-002 - `exec` is the default transport; `app-server` is opt-in
- Date: 2026-10-18 (1.1.0).
- Decision: default `codex exec --json`; `transport: app-server` runs a per-run Node sidecar
  (`scripts/codex-runner.mjs`) and falls back to `exec` when Node, the runner or `codex app-server` is missing, saying why in the footer.
- Why: `exec` is the most stable; Codex marks `app-server` experimental. The hook cannot keep a child's stdin open, hence the sidecar (needed for `turn/steer` and `turn/interrupt`).
- Consequences: mid-turn steering only on opt-in; two code paths to test; protocol drift in either is a release risk.

## D-003 - Final answer is delivered once through `SubagentHandback`
- Date: 2026-10-18 (1.0.0).
- Decision: `handbackMode: auto` uses `SubagentHandback`, falling back to plain text (one extra step) only when the tool answers that it is not active; a footer follows the answer. Failures are explicit (`codex failed: <reason>`), never silent.
- Why: it is the native way for a subagent to return its result; the fallback keeps non-auto sessions usable.
- Consequences: auto mode adds an "Auto mode classifier was unavailable" note (accurate: Claude did not review Codex's work); engine notices re-deliver the last answer without a Codex run (anti-loop).

## D-004 - Messages to a running agent are delivered on both transports
- Date: 2026-10-18 (1.1.0).
- Decision: messages arriving as a `queued_command` attachment are delivered (steered under `app-server`, queued and run on the same thread under `exec`) and announced with visible `↪` notes.
- Why: they were silently dropped before 1.1.0; Desktop does not render the coordinator message in the subagent view.
- Consequences: output contains non-Codex note lines; launch guard still limits launches (one per new message, `maxRunsPerWindow` per 10 minutes).

## D-005 - One cross-model review per change, not per phase
- Date: 2026-10-18 (1.2.0).
- Decision: Codex work is implemented with gpt-6.1-sol (medium; xhigh for hard work or a retry).
  The orchestrator verifies each phase itself (diff, tests, live check). One read-only review
  covers the whole change at the end, from the other model family: Fable for Sol's work,
  gpt-6-astra (low or medium) for Claude's work. Never both.
- Why: Sol xhigh is the Codex counterpart of Opus, whose steps are not reviewed one by one;
  Fable and Astra play the same role, and Astra costs about 5x Sol.
- Consequences: findings surface later, so each phase must leave tests that make the final review cheap to act on.
