# Steer v2 checkpoint: delayed native inbox drain fixed

Checkout: feat/1.2 (read .git/HEAD); single writer, no agents/commits/pushes.
Existing steer-v2 dirty implementation carried forward. User added manifest
`types: ./hooks/steer-contract.d.ts` and reported the earlier clean suites.
That approval is resolved; no further approval is pending. No manifest/version
or social-preview image was written in this follow-up. The only Git command
used was the requested `git diff --check`.

Evidence read as data:
- live-rich/sv2-debug.txt:107 registers receive; :613–626 dispatches both
  native sends; :796 probes the Unix channel during cancellation, not send.
- Parent transcript 25ac51a9-5af7-4713-a4bc-026216772659.jsonl:47–51 has
  successful native queue results and recipient pins. :49/:52 contain the
  old plugin's model-only pending feedback. Child transcript ends after the
  generic fixture actions, with no delivered coordinator row.
- CLI 2.1.302 native send queues pendingMessages; attachment collection drains
  them and raises receive before creating queued_command. Thus a long held
  turn.step prevented the very receive/append callbacks it awaited. REA was
  attempted but Hopper could not launch; bounded direct binary inspection
  corroborated the recorded queue order. No vendor implementation was copied.

Changes this follow-up:
- hooks/codex.ts: capture persisted parent SendMessage row UUID/tool ID; route
  only after native success confirms the owned recipient pin; reconcile the
  later native copy without replay. Parallel blocks sharing a parent UUID use
  distinct message IDs. Preserve unscoped append-only 1.1 steering. At a
  settled ack boundary emit pending owned cards without another Codex action
  or leaving a child pull pending. Ambiguous source-row queries require IDs.
- hooks/steer-contract.d.ts: optional child deliveryUuid in addition to the
  authoritative parent sourceUuid.
- tests/codex.test.ts: real deferred receive/append order, held pull, names,
  identical parallel bodies/shared UUID, context/card/status and legacy fallback.
- tests/fixtures/fake-app-server.mjs: steer-v2 scenarios branch before generic
  ls/patch work. tests/runner.test.mjs covers all five steer-v2 scenarios.
- README, CHANGELOG, UI map and steer-v2 harness describe the actual order.

Final verification in this sandbox:
- claude plugin test .: 661 passed, 0 failed.
  /tmp/codex-mod-sv2-live-hooks-final.log
- node --test tests/runner.test.mjs: 96 passed, 0 failed, 1 skipped (Unix
  listener denied by this sandbox); all five new fake scenarios passed.
  /tmp/codex-mod-sv2-live-runner-1.log
- claude plugin validate --strict .: passed.
  /tmp/codex-mod-sv2-live-validate-final.log
- git diff --check: passed.

Next live gate: reload in a NEW headless/Desktop session outside this sandbox,
repeat the named two-message harness, and confirm sender receipt/received/ack
logs precede card tool rounds, then native-copy reconciliation with no second
steer or launch. Actual post-fix host dispatch/UI was not rerun here. Queries
should use message/tool IDs; multiple tool blocks can share a parent row UUID.
