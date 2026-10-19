# Batch 7 harness and checkpoint

Branch: feat/1.2 (read from .git/HEAD). Single writer, no subagents or Git
operations except the requested diff whitespace check. Allowed paths only;
plugin version, hooks.json loader, docs/decisions.md and social preview remain
untouched. Model/row recovery metadata uses the existing per-record store
budget; catalogs and pending prompt bodies never enter $.store.

## Headless host-field check, without creating a subagent

The original probe is `batch7-probe.ts`. It intercepts the main turn, emits a
real Agent call with effort high, observes the tool and spawn events, then
**denies the spawn**. It does not invoke Codex or create a Codex subagent.
Prepare a disposable plugin named codex-mod; leave existing saved subscription
authentication alone (no API key or paid API fallback):

```sh
mkdir -p /tmp/codex-mod-batch7-probe/.claude-plugin /tmp/codex-mod-batch7-probe/hooks
printf '%s\n' '{"name":"codex-mod","version":"0.0.1","description":"Offline Batch 7 field probe","author":{"name":"Local probe"}}' > /tmp/codex-mod-batch7-probe/.claude-plugin/plugin.json
printf '%s\n' '{"modules":["./probe.ts"]}' > /tmp/codex-mod-batch7-probe/hooks/hooks.json
printf '%s\n' '{}' > /tmp/codex-mod-batch7-probe/settings.json
cp tests/fixtures/batch7-probe.ts /tmp/codex-mod-batch7-probe/hooks/probe.ts
claude plugin validate --strict /tmp/codex-mod-batch7-probe
claude -p --plugin-dir /tmp/codex-mod-batch7-probe --settings /tmp/codex-mod-batch7-probe/settings.json --setting-sources '' --debug-file /tmp/codex-mod-batch7-probe/debug.log --output-format stream-json --verbose 'Offline Batch 7 effort field probe' > /tmp/codex-mod-batch7-probe/output.jsonl
rg 'batch7-probe: (tool-call|agent-spawn)' /tmp/codex-mod-batch7-probe/debug.log
```

Observed installed CLI 2.1.302 (2026-10-18 local):

- tool.call keys: description, effort, prompt, subagent_type, tool, tool_use_id;
  the effort field is **effort**, value **high**.
- agent.spawn keys: background, cwd, description, fork, model, name,
  parentModel, permissionMode, prompt, provider, subagentType, tool_use_id.
  **effort is absent**. model is undefined; parentModel is claude-opus-5-5;
  provider is {plugin:codex-mod@inline,tier:user}.
- Successful denied-spawn probe: result BATCH7 FIELD PROBE DONE, exit 0,
  duration_api_ms 0, empty modelUsage, zero reported usage/cost and spawned 0.
  The host nevertheless attempted an auxiliary classifier after the denied
  tool; authentication was unavailable, so that attempt failed. This is not
  evidence of zero auxiliary host inference in an authenticated session.
- The first disposable probe failed its module static check because its
  logging helper was nested; it was moved to module scope and validated.
  That failed run reported authentication required, zero usage/cost/spawns.
- REA artifact inventory: /tmp/codex-mod-batch7-rea.json. Static installed
  spawn-event builder at byte 229071147 confirms the same field set. Artifact
  inspection authenticates the binary, not Desktop renderer behavior.

The implementation captures flat Agent effort in its existing guarded
`tool.call` hook only after ordinary ownership/guard checks, scopes it to the
real tool_use_id while next is pending, then reads optional spawn.effort first
and that scoped input second. Its production diagnostic can be inspected with:

```sh
rg 'codex-mod: model selection:|model type .*refused|project role wins name collision' /tmp/codex-mod-batch7/debug.log
```

Expected example: `spawn.effort=absent; Agent.effort=high;
resolved=gpt-6.1-sol/high`. Neither field supplied prints absent twice. The
spawn event's model/parentModel/permissionMode/provider are preserved. Debug
keys are diagnostic; no prompt body is logged.

## Owner's fake-Codex integration check

Use the fake-Codex wrapper from the Batch 6 harness (exec or app-server) and
user settings / `claude -p --settings`, never project-only options:

```json
{"plugins":{"codex-mod@inline":{"enabled":true,"options":{"codexPath":"/tmp/codex-mod-batch7/fake-codex","transport":"exec","modelAgents":true,"progressIntervalMs":0}}}}
```

Run a NEW session with `--plugin-dir` pointing at this checkout and
`--debug-file /tmp/codex-mod-batch7/debug.log`. Have the owner/coordinator call
Agent using the registered catalog type and effort high, then compare with a
role, generic defaults and prompt overrides. Repeat invalid native effort via
an instrumented tool input (the Agent schema may reject arbitrary values
before plugins), a valid host effort unsupported by a restricted model, and
invalid prompt model/effort. Only the native invalid effort gets a visible
default note; prompt profile errors launch nothing. Use prompt lines for
ultra, which the native Agent schema cannot spell.

The visible catalog fixture offers codex, gpt-6-1-sol and gpt-6-luna, plus
project roles and hidden/unoffered codex-child. Exact dotted type names are
refused at the host API boundary; the logged alias executes the exact dotted
Codex model. Missing/unreadable catalog: codex + project roles only (besides
hidden mirror infrastructure). modelAgents:false removes model types. Test
literal and alias role collisions; the project role must win.

Use simultaneous identical prompts/titles and different profiles/parents.
Before a first step, the pending title/type/parent match must checkpoint its
selection; ambiguous identical profiles may checkpoint only their agreed
profile and wait for the actual spawn ack to bind row IDs. Real spawn IDs
must survive history reopening. Follow-ups change row/footer model without
claiming that the launch title changed. Resumed/workflow titles are fixed by
core. Observe native model and effort inputs unchanged (haiku remains only
the unused registered model). No UI hook may call a model, tool executor or
spawn API.

## NEW Desktop acceptance and remaining policy

After plugin reload/install, start a NEW Desktop session. Check launch title,
parent Agent row while running/completed/errored/interrupted, separate child
header, activity/task list and reopened history. Literal current model/effort
text must coexist with the original native tree: status, errors, expansion,
links, keyboard navigation and accessibility. Force ui.resolve/Box failure
and missing stored identity: the native row must remain. Ordinary Claude
Agent titles and rows must remain untouched, even with lookalike inputs.
Repeat declared roles, prompt model overrides, both transports, nested child
observer titles/links, concurrent children, follow-ups, reload and resume.
The native badge may still display Haiku or omit unknown GPT IDs; this plugin
cannot replace that separate badge. No GPT model ID is registered with Claude.

The matrix makes promotion of experimental native candidates conditional on
Desktop acceptance. That acceptance is not available in this task, so
nativeActions stays true and richRows stays false; conditional rich mappings
remain available as before. No default is promoted on headless evidence alone.
The owner must perform the above Desktop checks; they were not claimed as run.

## Current implementation checkpoint

Branch: feat/1.2. Single writer; no subagents, commits, pushes, resets or
branch/tag operations. The only Git command was the requested diff --check.
Working changes from Batch 7 remain in hooks/codex.ts, tests/codex.test.ts,
.claude-plugin/plugin.json (userConfig only), README.md, CHANGELOG.md and
docs/codex-ui-map.md, with new batch7-models.mjs, batch7-probe.ts and this
harness. Plugin version, social preview and decisions.md remain untouched.

The owner's fresh attempt resolved the previous eight integration-test
failures by replacing b7Engine's incomplete public test-driver forwarding
with explicit hook API fixtures. Those fixtures share the normal world's
files, store, clock, logs and agent identities, and provide ui.log,
invalidate, toast and notify. Normal plugin steps and row rendering still
run through the existing test engine and reload the captured selections.
No production code or defensive logging fallback changed in this attempt.

Verification on the fresh attempt:

- claude plugin test .: **639 pass / 0 fail**, including all eight formerly
  failing first-step/concurrency/scoping integration cases. Log:
  /tmp/codex-mod-batch7-tests-fresh-1.log.
- node --test tests/runner.test.mjs: **79 pass / 0 fail**. Log:
  /tmp/codex-mod-batch7-runner-fresh.log.
- claude plugin validate --strict .: **passed**.
- git diff --check: **passed**.
- Previous store-size check: node --test tests/store-state.test.mjs,
  **9 pass / 0 fail**; not rerun for this test-only adapter correction.

The denied-spawn host probe above confirmed tool.call.effort is supplied
and agent.spawn omits effort. Fixture registration confirms codex,
gpt-6-1-sol and gpt-6-luna, project roles, and hidden codex-child; the
hyphenated alias still executes exact model ID gpt-6.1-sol.

No actual Codex subagent, authenticated worker launch or NEW Desktop
acceptance ran. Native badge replacement remains unsupported; promotion
of the richRows default remains conditional on Desktop acceptance. Next
step is the owner's Desktop acceptance described above, after reloading
the plugin in a NEW session. Reconcile the current checkout before resuming.
