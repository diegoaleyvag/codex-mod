# Nested Codex harness

Use a disposable folder and the saved subscription login. The fake simulates
one existing child; it never delegates to Codex or a provider. This fixture
is for the owner's headless/Desktop harness, not an authorization to launch
real Codex subagents during implementation.

Create `/tmp/codex-nested/fake-codex` (make it executable):

```sh
#!/bin/sh
REPO=/Users/atomicz/Projects/personal/codex-mod
case "$*" in
  --version) printf '%s\n' 'codex-cli 0.163.0 (fake)'; exit 0 ;;
  'login status') printf '%s\n' 'Subscription fixture'; exit 0 ;;
  'app-server --help') printf '%s\n' 'Fake app-server'; exit 0 ;;
esac
if [ "$1" = app-server ]; then
  exec node "$REPO/tests/fixtures/fake-app-server.mjs" "$@"
fi
printf '%s\n' 'This fixture supports app-server only' >&2
exit 2
```

Use `/tmp/codex-nested/settings.json` with a local plugin-dir load:

```json
{"plugins":{"codex-mod@inline":{"enabled":true,"options":{"codexPath":"/tmp/codex-nested/fake-codex","transport":"app-server","nestedAgents":true,"lean":false,"nativeActions":true,"progressIntervalMs":0}}}}
```

```sh
FAKE_SCENARIO=nested-one-child \
FAKE_LOG=/tmp/codex-nested/rpc.jsonl \
FAKE_CHILD_DELAY_MS=5000 \
claude -p --plugin-dir /Users/atomicz/Projects/personal/codex-mod \
  --settings /tmp/codex-nested/settings.json --setting-sources '' \
  --output-format stream-json --verbose \
  'Launch one codex-mod:codex agent with prompt "observe fixture" and report its answer.'
```

The main orchestration turn may use the normal subscription model. Count
mirror worker and auxiliary requests independently at the provider boundary;
do not infer zero requests from mock turn.step tests. Use the harness's
provider-denial instrumentation for mirrors and progress-summary timers.
Never configure paid API fallback. This repository's unit tests simulate the
spawn chain; they do not establish core task creation or Desktop forwarding.

Check actual core task records and `$.agent.list`: exactly one child host
agent has parentId equal to the parent Codex host ID. Its first step may run
before spawn resolves. Parent Agent link result must use that real ID;
compare the separately recorded core launch tool ID, task tool ID and actual
forwarded parent_tool_use_id. Navigate to the child's command, file-change
receipt and final text, then reopen history. No native Bash/Edit/Write
executor may run. The fixture reports a patch but writes no repository file;
an unavailable file image may render a guarded patch receipt.

RPC log: one root `thread/start`, one root `turn/start`, one child
`thread/resume` with only threadId/excludeTurns; **zero** child turn/start.
Child UUID is `22222222-2222-4222-8222-222222222222`; usage is root direct
1,050 and child direct 2,100, tree 3,150 (input 3,000, cached 2,100, new 900,
output 150). Duplicates and a late usage notification must not change totals.
Codex numbers stay out of host provider token counters.

Variants: `nested-early`, `nested-both`, `nested-collab-only`,
`nested-rejoin-failure`, `nested-ancestry`, `nested-history-mode`,
`nested-failure`, `nested-response-only`, `nested-controls`. Controls waits for a child interrupt;
send the real mirror a message, then stop it. Verify one child-specific steer
and interrupt, no parent kill and no echo after source interruption. Repeat
with the parent stopped after its root turn completes. Test nestedAgents off,
exec, host depth/concurrency refusals, and a hooks-worker restart. Lost owner,
truncated journal or evicted host ID must report the gap without relaunch.

NEW Desktop session after plugin install/reload: verify actual native task,
nested navigation, streaming text/tools, failure/stop settling, retained
history and effective nested forwarding flags. Audit auxiliary provider
traffic long enough to trigger progress summaries. A separate owner-approved
real-server experiment is still needed to establish native v2 rejoin/runtime
reuse; this fake alone cannot establish that capability.

## Local checkpoint

Branch `feat/1.2` was read from `.git/HEAD`; changes remain uncommitted. Only
the authorized hook, runner, tests, manifest userConfig and documentation
paths were edited. hooks.json still loads codex.ts; plugin version remains
1.1.0. The social-preview PNG retains SHA-256
`b230ac6a88b1b181cc538fd94e897f9c00008a0557244bf0871cf12455bbfa0f`.
No subagents, real Codex inference, package installs, commits or pushes were
launched. The sole Git command is the requested `git diff --check`.

Local verification: `claude plugin test .` (589 tests),
`node --test tests/runner.test.mjs` (79 tests), strict plugin validation and
diff whitespace checks. The tests exercise the fake wire, lifecycle,
recovery, refusal and guarded replay paths. Native task creation/linkage and
auxiliary provider traffic need the owner's harness; Desktop needs a NEW
session after reload. Parent handback waits for observed children to drain;
idle child continuation, file-only observation and native external-token
projection are outside this slice. Recovery after owner/task loss reports
the gap instead of relaunching. The short terminal drain is a bounded
snapshot, not proof that every server version has flushed all late usage.
