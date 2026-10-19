# Batch 6 harness and checkpoint

Branch: `feat/1.2` (read from `.git/HEAD`). Single writer; no delegation,
commit, push or branch operation. Allowed implementation: hooks, runner,
tests/fixtures, README, Unreleased changelog and UI map. hooks.json still
loads codex.ts and imports its helper modules. Manifest/version and
`docs/codex-mod-social-preview.png` remain untouched. Decisions I1/I2,
X1–X8, QN1/QN2 and M1 follow the supplied matrix; docs/decisions.md is
outside the allowed paths, so no decision-log entry was appended.

## Deterministic fake Codex

Make a disposable executable wrapper (replace REPO with this checkout's
absolute path). It answers preflight without invoking a real Codex model:

```sh
#!/bin/sh
REPO=/Users/atomicz/Projects/personal/codex-mod
case "$*" in
  --version) printf '%s\n' 'codex-cli 0.163.0-alpha.10.2'; exit 0 ;;
  'login status') printf '%s\n' 'Saved subscription fixture'; exit 0 ;;
  'app-server --help') printf '%s\n' 'Fake app-server'; exit 0 ;;
esac
if [ "$1" = app-server ]; then
  exec node "$REPO/tests/fixtures/fake-app-server.mjs" "$@"
fi
cat >/dev/null
cat "$REPO/tests/fixtures/batch6-exec.jsonl"
```

Set `FAKE_SCENARIO=batch6-images-modes` and a disposable `FAKE_IMAGE_ROOT`.
The fake alone writes the original one-pixel PNGs and unsupported SVG in that
root; the hook only reads bounded image bytes. The scenario emits full
imageView/generation success/failure/remote-only records, revised prompts,
public/empty summaries with private-content sentinels, commentary, partial
answer, long review request/full review result, duplicate compaction item and
deprecated notification, sleep, config/retryable warnings, explicit approval
request (error only), lifecycle replays and exactly one final answer.
The exec JSONL fixture includes only applicable serializer families; it does
not pretend exec supports dedicated images/modes/question RPCs.

Use disposable user settings or `claude --settings`; project plugin options
are ineffective. Example settings for a local plugin-dir load (ensure the
plugin is enabled in the host):

```json
{"plugins":{"codex-mod@inline":{"enabled":true,"options":{"codexPath":"/tmp/codex-mod-batch6/fake-codex","transport":"app-server","nativeActions":true,"richRows":true,"lean":false,"progressIntervalMs":0}}}}
```

As in the earlier harness, run `claude -p --plugin-dir "$REPO" --settings
/tmp/codex-mod-batch6/settings.json --setting-sources '' --output-format
stream-json --verbose '<owner-provided fake-agent harness prompt>'` with the
scenario/root environment set. The owner may launch the fake Codex agent in
that harness; no Codex subagent was launched during this implementation task.
Repeat both transports, richRows values, nativeActions off and registration
failure. Native Read needs admission in that specific registered agent.
Count one source generation even when it has a second Read preview row.

## Pending question scenarios

`FAKE_SCENARIO=batch6-question` sends a bounded explicit choice RPC twice
with the same ID. `batch6-question-unsupported` uses a secret question;
`batch6-question-foreign` uses a stale turn; `batch6-question-resolved`
resolves the request before a late answer; `batch6-question-finish` ends the
turn without an answer. Node tests drive their real control-file protocol,
including wrong request IDs, invalid choices, cancellation, late response,
replay, explicit unsupported errors and exactly-once response delivery.

Enable pending choice controls only with app-server, nativeActions on,
lean off and registered/admitted codex_question. In an interactive NEW
Desktop session, select then explicitly submit choices, or cancel. Selection
alone and receipt acknowledgement must write no response. The reply binds
request token, RPC ID, item, thread and turn; old controls cannot answer a
restarted run. All approvals remain -32601 errors; approvalPolicy stays never.
A supported question can remain pending until answered or interrupted;
headless `-p` has no human surface, so do not expect it to answer by itself.
An already delivered real answer can produce AskUserQuestion only if admitted
and richRows is on. No AskUserQuestion executor runs to draw either site.

## Offline host schema/mapper probe (no subagent or provider)

```sh
mkdir -p /tmp/codex-mod-batch6-probe/.claude-plugin /tmp/codex-mod-batch6-probe/hooks
printf '%s\n' '{"name":"batch6-probe","version":"0.0.1","description":"Offline guarded mapper probe"}' > /tmp/codex-mod-batch6-probe/.claude-plugin/plugin.json
printf '%s\n' '{"modules":["./probe.ts"]}' > /tmp/codex-mod-batch6-probe/hooks/hooks.json
printf '%s\n' '{}' > /tmp/codex-mod-batch6-probe/settings.json
cp tests/fixtures/batch6-probe.ts /tmp/codex-mod-batch6-probe/hooks/probe.ts
claude -p --plugin-dir /tmp/codex-mod-batch6-probe --settings /tmp/codex-mod-batch6-probe/settings.json --setting-sources '' --output-format stream-json --verbose 'Offline Batch 6 mapper probe' > /tmp/codex-mod-batch6-probe/output.jsonl
```

Observed CLI 2.1.302, 2026-10-19 UTC / 2026-10-18 local: guarded PNG Read
accepted as native image content, 70 actual bytes, with file.type image/png
and no filePath in the image result. ReportFindings accepted and mapped to
`1 finding reported.` AskUserQuestion was absent from noninteractive tool
admission, so its native answer path stays conditional. Every emitted probe
row passed through a logging no-next guard, with tool.check denial backstop.
Result: duration_api_ms 0, empty modelUsage, zero tokens/cost, spawned 0.
This probe establishes schemas/mappers, not child placement or Desktop paint.

Schemas: supplied r1/CLAUDE-TOOLS.md Read 1100–1122, AskUserQuestion 222–244,
ReportFindings 1224–1242 and runtime question bounds at 2008; hooks API fs.read
returns {base64} for {as:'bytes'}, rejects over 4 MiB. Codex shapes come from
phase3/app-server-ts/v2/ThreadItem.ts, ToolRequestUserInput{Params,Question,
Option,Answer,Response}.ts and ServerRequestResolvedNotification.ts plus
ImageGenerationItem.ts. Findings are conditional actual supplied structure;
the current ThreadItem union promises review prose only. The format fixture
contains original PNG bytes and local sips/cwebp conversions of that image,
not copied vendor assets.

REA inspect-artifact corroborated CLI SHA-256
5262ce9de86243fed0d21edc39b271555d56780d0112e2b194439fe1c6662d37,
evidence ev_87902c6ef526bd23719d9a4a9e40540a97bfe5061168c15c03dfc9685d3b1d30
(`/tmp/codex-mod-batch6-rea.json`). Artifact identity is not renderer proof;
semantic evidence comes from the supplied research and offline host probe.

## NEW Desktop acceptance

1. Reload/install then start a NEW Desktop session; record transport,
   nativeActions, richRows and lean. Instrument actual native executors,
   process/task spawn, filesystem writes and network calls. Synthetic rows
   must have zero executor calls; only original fake mutations are allowed.
2. Inspect/reopen PNG previews and all four supported formats. Check exact
   byte count/MIME and the later-file-preview label. Change/remove an image
   during capture; test >4 MiB and unsupported bytes. Each must report its
   actual fallback reason. A preview never rereads through Claude's tool or
   fetches a result URL. Full generation results/prompts/failures stay visible.
3. Observe public summary thinking live; reopen history and record its
   absence as native signed thinking. No private-content sentinel, invented
   duration or fabricated thinking history may appear. Partial/commentary
   alone must end with a missing-final error; successful final handback is
   once, independent of warnings/full review/compaction/wait text.
4. Deliver coordinator Unicode, multiline tags/Markdown/fences/override
   lines before a tool input, on an idle step and just before handback.
   Repeat a UUID, send >90k parts across an emoji boundary, fail tool
   registration and restart/resume. Cards and literal text must preserve the
   full body, source and order. Receipt/queued/accepted/rejected are separate;
   no extra launch or final-answer substitution. Reopened rows can restore
   persisted owned render lookup; otherwise complete original input remains.
5. Exercise pending question choice/submit/cancel and late/stale responses.
   Inspect that only actual delivered answers appear in any native question
   answer row. Unsupported/secret/free-text/approval requests return explicit
   errors, never answers. A reopened/restarted pending row has no live
   callback and its receipt does not claim consent.

## Verification and next steps

Final verification results and the unverified fixture correction are recorded below.
The integrated fake-agent/headless owner harness and NEW Desktop checks
remain unrun here, honoring the task's no-subagent instruction. Summary
streaming stays opted out; completed summaries already supply live thinking.
No transport/billing/approval-policy option or version change was added.

Final results: `node --test tests/runner.test.mjs` **66/66 passed**;
`claude plugin validate --strict .` passed; explicitly requested read-only
`git diff --check` passed. The intermediate hook run passed **559/559**.
The final expanded hook run passed **566/567**; its one findings-fallback
case omitted session.start, leaving codex_tool unregistered, so the correct
full-text fallback appeared instead of the expected card. Added session.start
to exercise the intended registered-card branch; this fixture-only correction
is **not rerun**, under AGENTS.md's three-failed-attempt cap. Earlier failures
were corrected using observed evidence: direct helper tests needed a supplied
filesystem API, pending-question tests needed session registration, stale
warning/error assertions needed the new behavior, and the hook loader refuses
JSON imports (format fixture converted to a code module). There was no fourth
failed-hook retry, independent review or subagent. Logs:
`/tmp/codex-mod-batch6-plugin-{1,2,final}.log`,
`/tmp/codex-mod-batch6-runner-{1,2,final}.log`,
`/tmp/codex-mod-batch6-validate.log`, mapper probe output above.

Next: reconcile this checkpoint with the checkout; the only post-run edit is
the findings-fallback fixture setup and documentation. The owner must authorize
any further hook-suite retry under the verification cap, then run that suite
and the integrated/NEW Desktop checks above. Known changed files:
`hooks/codex.ts`, new `hooks/images-modes.ts` and `hooks/questions.mjs`,
`scripts/codex-runner.mjs`, both test suites, fake-app-server.mjs, new
`tests/fixtures/batch6-*`, README, Unreleased changelog and UI map. Changes
remain in the working tree; branch feat/1.2 is unchanged. No Git mutation was
run; the requested diff --check is the sole Git-command exception. Social
preview SHA-256 stayed
b230ac6a88b1b181cc538fd94e897f9c00008a0557244bf0871cf12455bbfa0f.
