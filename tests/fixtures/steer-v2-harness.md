# Steer bridge v2 headless/live gate

Load/reload the plugin in a NEW Claude Code/Desktop session. Use saved
subscription authentication. Select `transport: app-server`, `nativeActions:
true`, `lean: false`, and a disposable working directory. Keep exec as the
general default. A headless fake run can set `codexPath` to an executable
launcher that runs `node /absolute/path/tests/fixtures/fake-app-server.mjs "$@"`.
Set `FAKE_SCENARIO=steer-v2-accepted` in the host environment (not the prompt).
Other scenarios: `steer-v2-rejected`, `steer-v2-late-ack`,
`steer-v2-wrong-ack`, `steer-v2-lost-ack`. The fake has no model or network
activity; it emits no generic `ls` or patch work and stays active until
interrupted so messages can be inspected. The task prompt is not executed
by this fake.

Prompt:

> Start one `codex-mod:codex` agent in the background with name `steer-check`.
> Ask it to run a harmless 20-second wait in this disposable directory, then
> return `DONE`. While it is running, use SendMessage twice to tell that SAME
> agent `Keep waiting; include MARKER in your answer.` Use identical bodies
> deliberately, with two distinct SendMessage tool calls. Report the additive
> context from each result. Query `codex_message_status` with targetAgentId
> and messageId (or the SendMessage tool use ID) until each outcome is known.
> Do not send another delivery as a status check. Stop the agent after checking.

Debug lines to grep (never include message bodies or credentials):

```text
codex-mod: steer v2 channel=unix protocol=2
codex-mod: steer v2 channel=file (Unix health unavailable)
codex-mod: steer v2 sender receipt target=... message=... source=...
codex-mod: steer v2 native copy reconciled target=... message=...
codex-mod: steer v2 message=... status=received
codex-mod: steer v2 message=... status=accepted turn=...
codex-mod: steer v2 message=... status=observed turn=...
codex-mod: steer v2 message=... status=queued
codex-mod: steer v2 message=... status=unknown
```

Verify one receipt card per SendMessage tool ID, literal full bodies, distinct message
IDs for identical texts, the same card changing status, and no second launch
for accepted/unknown outcomes. A rejection may be queued after the current
turn; preserve its raw error in the status query. Repeat with `transport: exec`
(queue only), `nativeActions: false` (literal receipt/status), reopen/reload,
then socket-policy refusal (file negotiation before any POST). Check a message
sent just before completion and a stopped mirror without starting replacement
work. On CLI 2.1.302 the native queue does not raise receive/append until a
child tool round: verify sender source -> native pin -> RPC/ack -> card ->
native-copy reconciliation, plus receive/append-only fallback ordering. Verify
coordinator `context` reaches the model; unit tests cannot establish host/UI
behavior. A late ack can be read by query even before another child-view pull.
No session-wide broker, native daemon, or experimental Codex queue is involved.

The source UUID for an early receipt is the persisted parent assistant row;
parallel SendMessage blocks in that row have distinct tool/message IDs. An
append-only host may additionally record `deliveryUuid` for the child row. A
consumed native copy creates no child attachment, because it must not replay
the message into Codex. Query by the message ID or sender tool ID.
