# Batch 8: real mirror stop, SendMessage and cards

Run in a disposable project with saved subscription authentication. The fake
simulates existing Codex children; it never delegates to Codex or calls a
provider. The main Claude orchestration prompt uses the owner's subscription.
Do not configure an API-key fallback. Hook changes need a NEW session.

## Setup

Create `/tmp/codex-batch8/fake-codex`, executable, using this wrapper (set
`REPO` to the checkout under test):

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

Create `/tmp/codex-batch8/settings.json`:

```json
{
  "pluginConfigs": {
    "codex-mod@codex-mod": {
      "options": {
        "codexPath": "/tmp/codex-batch8/fake-codex",
        "transport": "app-server",
        "nestedAgents": true,
        "lean": false,
        "nativeActions": true,
        "progressIntervalMs": 0
      }
    }
  }
}
```

Use `pluginConfigs` with the host's actual `codex-mod@codex-mod` identity.
Project options do not override user settings. Use distinct debug/RPC/output
files per run, so another session's mirror ID cannot be selected.

## Native SendMessage, then stop the real mirror

From a disposable cwd, run:

```sh
FAKE_SCENARIO=nested-controls \
FAKE_LOG=/tmp/codex-batch8/controls.rpc.jsonl \
claude -p --plugin-dir /Users/atomicz/Projects/personal/codex-mod \
  --settings /tmp/codex-batch8/settings.json --setting-sources '' \
  --debug-file /tmp/codex-batch8/controls.debug \
  --output-format stream-json --verbose \
  'Launch exactly one codex-mod:codex named batch8-parent with prompt "observe fixture". Keep it in the background. Use Bash to poll /tmp/codex-batch8/controls.debug, at most 10 seconds, until the codex-mod: mirror bound line appears for thread 22222222-2222-4222-8222-222222222222. Read the real mirror host ID from host= in that line. SendMessage to that ID with message "Batch 8 message: keep checking the fixture". Wait one second, then TaskStop that same real mirror task ID. Wait for the parent report. Return the parent and mirror IDs and actual tool outcomes. Do not launch another agent or stop the parent.' \
  > /tmp/codex-batch8/controls.stream.jsonl
```

Allow the main prompt's Agent/Bash/SendMessage/TaskStop calls through the
normal saved permissions. If polling times out, stop and report the actual
admission/bind failure; do not invent an ID or retry launches.

Inspect the debug log:

```sh
rg 'codex-mod: mirror (launch|bound|steer|stop|source terminal)|agent_summary|background_tasks_changed|task_started|task_updated|task_notification' /tmp/codex-batch8/controls.debug /tmp/codex-batch8/controls.stream.jsonl
```

Expected adapter markers: `mirror bound`, `mirror steer submitted`,
`mirror steer acknowledgement` with `status=accepted`, and exactly one
`mirror stop submitted` for the target. Native stop kills the host observer,
so `mirror source terminal` may not be read by that observer afterward;
the runner journal is authoritative for source interruption. No prompt token
or message body should appear in these adapter diagnostics.

Check the source RPC log (also inspect `~/.cache/codex-mod/runs/*/events-*.jsonl`
or the configured `XDG_CACHE_HOME` for the matching fresh run):

```sh
node --input-type=module - <<'JS'
import { readFileSync } from 'node:fs'
import assert from 'node:assert/strict'
const rpc = readFileSync('/tmp/codex-batch8/controls.rpc.jsonl', 'utf8').trim().split('\n').map(JSON.parse)
const child = '22222222-2222-4222-8222-222222222222'
const calls = method => rpc.filter(m => m.method === method)
assert.equal(calls('thread/start').length, 1)
assert.equal(calls('turn/start').length, 1)
assert.equal(calls('thread/resume').length, 1)
assert.deepEqual(calls('turn/steer').map(m => m.params.threadId), [child])
assert.deepEqual(calls('turn/interrupt').map(m => m.params.threadId), [child])
assert.ok(calls('turn/steer')[0].params.clientUserMessageId)
console.log('one existing child; one steer; one child interrupt; no duplicate execution')
JS
```

The child-specific journal must contain `turn.failed` with
`status:interrupted`. An interrupt RPC `{}` acknowledgement alone is not
termination proof. The root finishes normally and unrelated work stays live.

## Parent stop, completion/failure and restart variants

- Repeat with fresh `parent-stop.*` output paths and `nested-tree-controls`.
  Prompt: "Launch one codex-mod:codex named batch8-parent in the background
  with prompt observe fixture. Poll the parent-stop debug log until three
  mirror bound lines appear, at most 10 seconds. TaskStop only the parent
  host task returned by Agent. Report IDs and outcome; launch nothing else."
  Expect one interrupt each for threads beginning `2222`, `5555`, `6666`,
  including after the root source turn finished. To test a subtree, stop
  the `2222` mirror first: `5555` stops with it, `6666` stays active until
  explicit parent stop. No duplicate child interrupt from host cascading.
- Use `nested-one-child` with `FAKE_CHILD_DELAY_MS=5000` and a prompt to
  launch one agent and wait for its result. Then use `nested-failure`.
  Verify source reports and saved states are completed vs failed; a source
  failure can still have a host Completed badge because no public task status
  setter exists. Do not count that as native Failed badge parity.
- `nested-steer-wrong-ack` with a long delay must show unknown steer outcome,
  never accepted, without a second `turn/steer`. Idle/completed messages are
  explicitly rejected; they never create a child turn.
- Restart only the hooks worker while a live broker/journal remains: the
  same host/thread/cursor resumes, with no extra source start or host spawn.
  Lost owner, evicted host, truncated journal, or uncertain launch must report
  a gap and no relaunch. Unit recovery tests cover these boundaries; session
  restart itself cannot promise adoption because the public spawn API has no
  resume/adopt-ID parameter. Repeating a receipt UUID must not resubmit it.

## Host placement, card and request audit

CLI 2.1.302's supplied headless result is a real task at depth 1, no native
parent, `pluginSteered:true`, `requestShape:background`; plugin identity is
`codex-mod@codex-mod`. Compare actual `task_started`/background snapshots and
the native agent metadata. A plugin cannot set `parentAgentId`/`spawnDepth`.
The parent Agent row is a completed observation link with a real host ID,
not the core virtual launching tool row. The child title names its parent.
Record a contrary observed parent instead of changing pinned host fields.

NEW Desktop session: confirm top-level Codex and mirror background-list/sidebar
cards, prompt/report, activity/status, stop/send controls, visible parent title,
Agent-link navigation, streaming tools/text and reopened history. Exact native
GPT badges, hierarchy and source Failed badges remain host limits. There is
no separate session adoption or public task-summary setter.

Run long enough with enough action rows for summary timers (e.g. a 90-second
child delay), capturing the actual provider request boundary and host
initialization flags. Check worker inference and `agent_summary` independently;
debug-marker absence alone cannot prove zero network requests. The supplied
headless audit saw only Anthropic MCP fetch/telemetry, no `agent_summary`.
Desktop can enable different summary behavior. If auxiliary inference is
unavoidable, report that concrete host blocker; do not switch providers or
silently claim zero-Anthropic operation.

## Implementation checkpoint (2026-10-18)

Branch `feat/1.2` per task; one writer, no agents delegated. Local changes are
uncommitted in `hooks/codex.ts`, `scripts/codex-runner.mjs`,
`tests/codex.test.ts`, `tests/runner.test.mjs`, `tests/store-state.test.mjs`,
`tests/fixtures/fake-app-server.mjs`, this harness, README, CHANGELOG and
`docs/codex-ui-map.md`. No Git inspection/mutation beyond the explicitly
requested `git diff --check`; pre-existing dirty files were not inventoried.
The manifest/version and `docs/codex-mod-social-preview.png` were not edited.

Verification: `claude plugin test .` (650 passed),
`node --test tests/runner.test.mjs` (82 passed),
`node --test tests/store-state.test.mjs` (9 passed),
`claude plugin validate --strict .` and `git diff --check` (both passed).
Logs are `/tmp/codex-mod-batch8-{plugin-test,runner-test,store-test,validate}.log`.
Tests use a fake server and intercepted host API calls. This implementation
did not execute the new headless control prompts, a new Desktop session or
a real Codex child; supplied headless findings are attributed above.

Next: run the fresh-session headless control prompts, then Desktop's card,
navigation/history and request audit. Preserve the current one-time
launch/control guards and store budgets. Do not retry unsupported nesting,
session adoption or source failure badge setters through another provider.
