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

## D-005 - One cross-model review per change, not per phase (superseded by D-007)
- Date: 2026-10-18 (1.2.0).
- Decision: Codex work is implemented with gpt-6.1-sol (medium; xhigh for hard work or a retry).
  The orchestrator verifies each phase itself (diff, tests, live check). One read-only review
  covers the whole change at the end, from the other model family: Fable for Sol's work,
  gpt-6-astra (low or medium) for Claude's work. Never both.
- Why: Sol xhigh is the Codex counterpart of Opus, whose steps are not reviewed one by one;
  Fable and Astra play the same role, and Astra costs about 5x Sol.
- Consequences: findings surface later, so each phase must leave tests that make the final review cheap to act on.

## D-006 - Roles are declared per project, with a user-level full-access opt-in
- Date: 2026-10-18 (1.2.0).
- Decision: roles are declared in `.claude/codex-mod.json` in the session working directory;
  the generic `codex-mod:codex` agent is always present. A repository file cannot request
  `danger-full-access` without the user-level `allowProjectFullAccess` opt-in.
- Why: role names, profiles and instructions belong to each project's workflow rather than
  a hardcoded plugin roster. Repository content may be untrusted and cannot grant itself full access.
- Consequences: roles load at session start (or registration retry); edits need a new session,
  and cwd changes do not reload them. Existing records retain their profiles; instructions
  come from the loaded snapshot, and invalid project files never block the generic agent.

## D-007 - Codex first, Astra as the one final reviewer
- Date: 2026-10-18 (1.2.0). Supersedes D-005.
- Decision: implementation, research (REA through the `rea` CLI) and review go to Codex through
  codex-mod agents; Sol medium by default, xhigh for hard work or a retry. One read-only
  gpt-6-astra review (low or medium) covers a whole change at the end. Claude subagents only
  for Claude-only tools. No Fable review; at most the orchestrator double-checks Astra's findings.
- Why: the owner prefers to spend Codex capacity over Claude usage; Astra is a different,
  stronger model than the Sol implementer, which keeps the review independent.
- Consequences: the final review is no longer cross-family; the orchestrator's own checks
  (diff, tests, live runs) carry more weight.

## D-008 - Retry only an explicit no-start host denial
- Date: 2026-10-19 (1.2.0).
- Decision: an observer launch may repeat the identical request once only for the complete
  auto-mode no-verdict denial that explicitly asks for one retry. The live capability must
  remain unconsumed, no host may exist, and retiring the first core tool ID must checkpoint
  before submitting the replacement. All call/check/spawn identity guards still apply.
- Why: a denied launch starts no agent; unknown creation outcomes can already own a task.
  Treating either case as a generic retry would risk duplicate observers or source execution.
- Consequences: second denials retain the explicit lifecycle/report fallback. Worker recovery,
  safety refusals and uncertain outcomes never gain permission to launch again. No consent
  or permission mode is synthesized.

## D-009 - Reconcile history with buffered source lifecycle
- Date: 2026-10-19 (1.2.0).
- Decision: a matching buffered source start supersedes a child's replayed terminal claim.
  Suppress that stale terminal before journaling it, and retire only the replay claim when
  draining the start. A live terminal remains closed against duplicate starts and completions.
- Why: the app-server can expose an interrupted history snapshot while buffering the same
  turn's actual start. Treating that projection as a permanent completion discards the later
  real completion and leaves the parent waiting forever.
- Consequences: attachment preserves source actions and usage once without starting or
  rerunning child work. A terminal history entry without a superseding start remains terminal.

## D-010 - Restore presentation through persisted ownership
- Date: 2026-10-19 (1.2.0).
- Decision: a fresh UI worker may recover a nonlegacy Coordinator tool name before
  registration only when its current-session row cache identifies the exact tool ID,
  tool name and owning agent, whose durable record contains that row and received UUID.
  Legacy receipts retain their exact-name compatibility path within the current session.
- Why: registration is worker-local and may not precede historical rendering. A suffix
  match alone cannot establish ownership, while verified persisted data can restore it.
- Consequences: recovery supplies presentation only. It never restores a held answer,
  executes an action or changes the guards. This fixes a reproducible recovery gap;
  it does not establish the cause of Desktop's generic Coordinator rows.

## D-011 - Hide new plugin sessions through an opt-in source classification (superseded by D-012)
- Date: 2026-10-19 (unreleased).
- Decision: `hideSessions` defaults to false. When enabled, new root threads use
  `chatgpt_hidden` through exec's `--thread-source` or app-server's `threadSource`.
  Resumes never retag an existing thread; real children retain source parent/subagent metadata.
- Why: the inspected Codex/Work app filters this private marker from its chat catalogs
  and notifications, while Codex accepts and persists it without ephemeral sessions.
  Archiving after completion would still expose running sessions and miss interrupted runs.
- Consequences: history stays persistent in the same Codex home, without auth or database
  changes. Existing sidebar entries need separate archiving. Other host versions and
  live UI visibility require verification; accepting an arbitrary source is not proof
  of hiding. No safety guards or transport fallback semantics change.

## D-012 - Archive owned source sessions after process completion
- Date: 2026-10-19 (unreleased). Supersedes D-011.
- Decision: `archiveSessions` defaults to false. When enabled, the hook uses
  `codex archive -- <UUID>` only for its exact owned source thread after the
  process iterator ends and its result resolves. Both transports and exec fallback
  share this cleanup. Mirrors are excluded; conflicting source identities persist
  a quarantine that disables all future history operations, including after reload.
  A follow-up best-effort unarchives the same thread in its recorded Codex home
  before one ordinary resume; a persisted archive flag supports this after opt-out.
- Why: the D-011 candidate failed live protocol verification: `thread/read` retains
  `chatgpt_hidden`, but `thread/list` drops it before the Desktop catalog sees the
  thread. Acceptance and persistence of a source marker do not establish hiding.
  The supported archive/unarchive lifecycle preserves history and exact-ID resume
  without changing authentication or editing Codex's database or history files.
- Consequences: running sessions can appear, and aborts, timeouts, worker loss or
  process crashes can miss cleanup. Older sessions and real child sessions need
  separate manual archiving after they stop. CLI unarchive errors do not distinguish
  already active threads from failures, so the same-thread resume validates state;
  no new-thread fallback or history-command retry is allowed. Archive failure adds
  a short notice without losing the result. No safety guard or source policy changes.

## D-013 - Owner grants bound execution and one-shot approvals
- Date: 2026-10-19 (unreleased). Refines D-002 and D-006.
- Decision: user options and supported user extraConfig keys grant execution authority;
  named launch headers may request only bounded modes, paths, roots and network.
  Explicit cwd requests require an existing registered worktree of the parent Git
  repository or a canonical owner-allowed directory. Both transports force the
  resolved policy; snapshots and a required recovery fingerprint pin each thread.
  Unknown legacy execution state becomes a disclosed conservative baseline, never
  a reason to inherit newly expanded config. No policy header is applied by steering.
- Why: prompt prose cannot grant filesystem/network rights, session cwd cannot write
  a sibling worktree automatically, and inherited exec approval config disagreed
  with app-server's hardcoded never policy. Full access remains a conscious owner
  opt-in and must be described as unrestricted, including network and protected Git.
- Consequences: options override ambient execution config.toml; supported owner
  extraConfig execution keys override option defaults before launch narrowing.
  Existing users relying on ambient policy must migrate explicitly. Interactive
  modes require app-server and never fall back to exec. Manual native controls are
  host-dependent and not Desktop-accepted; unanswered requests expire without
  consent. Native auto uses installed Codex auto_review. Orchestrator mode exposes
  only the exact source agent's authoritative immediate Claude parent to a real
  inspect/decide tool; background launch and parent polling are required. Command
  and file approvals are one-shot; permission grants use requested literal subsets
  and turn scope. Method/RPC/token/thread/turn/item/callback/kind identity, lifecycle
  cancellation and existing replay/ownership/handback guards all remain enforced.
  No experimental RPC capability or persistent approval cache is enabled.

## D-014 - Revalidate the original cwd grant and approve only visible source proposals
- Date: 2026-10-19 (unreleased). Refines D-013.
- Decision: execution snapshot v2 records whether cwd came from the original
  session, a registered worktree with an original parent/common-directory anchor,
  or an owner root. Every resume rechecks the original basis against current
  grants and registration without retargeting the thread. Unanchored v1 snapshots
  fail explicitly instead of guessing their original authority. An unsuccessful
  Git metadata probe cannot silently establish nonrepository session authority.
- Why: a saved external cwd must not survive revocation merely because the host
  moved onto it, and file-approval RPC parameters do not contain the proposed patch.
- Consequences: file acceptance requires the exact matching owned in-progress item,
  presented paths/kinds/diff and an unchanged complete proposal snapshot. Proposals
  above 32768 characters, missing/empty/stale proposals and opaque command or stdin
  requests can be declined/cancelled but never blindly accepted. The runner checks
  its own source evidence again at response delivery. Network destinations remain
  distinct from command or stdin payloads. Parent authority requires complete host
  identity and known active lifecycle state; an absent parentId is accepted only
  through the installed AgentInfo contract that documents a main-loop launch.

## D-015 - Writable-root requests select exact canonical owner grants
- Date: 2026-10-19 (unreleased). Refines D-013 and D-014.
- Decision: every requested or resumed additional writable root must equal an
  explicitly owner-granted root after canonical resolution. A launch may omit
  granted roots, but cannot select a descendant without a separate explicit grant.
- Why: Codex can retain protected metadata exclusions under a parent workspace
  root while explicitly naming a child such as `.git` enables writes there.
  Lexical or canonical containment therefore does not establish narrower access.
- Consequences: equality applies to protected and ordinary descendants alike,
  including `.codex`, `.agents` and normal subdirectories. Symlink aliases of an
  exact grant work; retargeted aliases and revoked exact grants fail on resume.
  A broader parent grant cannot replace a removed exact metadata grant.

## D-016 - Ship verified delegation with an explicit manual-UI compatibility limit
- Date: 2026-10-19. Applies to 1.2.1.
- Decision: keep conservative defaults and ship optional native auto review and
  immediate-parent delegation. Mark manual `ask` experimental and unavailable in
  the tested Desktop child view; retain its no-consent timeout. Never substitute
  a synthetic human response or replay the requested operation to pass acceptance.
- Why: a fresh Sonnet-led Desktop session verified five real delegated cases,
  exact positive/negative marker files, source completion/interruption and archive
  cleanup. The same host displayed generic manual request details without buttons;
  the request expired without applying its patch. Native auto review had already
  passed a separate fresh-session capability check.
- Consequences: stable does not mean every experimental host control is accepted.
  Permissions/stdin variants, computer window control and custom Coordinator paint
  retain their documented gates. Approval-policy and execution-policy helpers run
  in hosted CI; proprietary hook tests and strict validation remain local evidence.
  Version 1.2.1 gets a new stable tag; the 1.2.0 prerelease tag stays unchanged.
