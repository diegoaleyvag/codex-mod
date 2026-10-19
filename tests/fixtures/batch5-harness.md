# Batch 5 harness and checkpoint

Branch read from `.git/HEAD`: `feat/1.2`. Single writer; no commit, branch,
push or subagent launch. Social-preview PNG, hooks.json, manifest/version and
release files are unchanged. Changes: `hooks/codex.ts`, new
`hooks/plans-children.ts`, runner collab retention, both suites, fake server,
Batch 5 fixtures/probe, README, Unreleased changelog and UI map. The decision
log is outside this task's allowed paths; this implements the supplied P/A
choices without a new transport or mirror decision. Optional X5 is deferred.

## Fake Codex

Use the owner's wrapper answering `--version` and `app-server --help`, then
launching `tests/fixtures/fake-app-server.mjs` for `app-server`. Set
`FAKE_SCENARIO=batch5-plans-children`. This scenario emits plans, completed
spawn operations with running/unknown children, failed/declined spawns, full
messages, wait transitions, resume/list, close/interrupt/failures and all four
subAgentActivity kinds. Starts and completions are replayed; the sidecar
emits each completion once. No actual child is spawned and no RPC for child
execution, message or interrupt is sent by the plugin.

For exec have the wrapper print `batch5-exec.jsonl` after reading stdin. It
contains the same corpus using snake-case items; plan_update compatibility
fixtures are protocol-derived, not a claim that normal exec emits that item.
Exec todo_list bool statuses have separate unit coverage. The fixture keeps
full UUIDs for future identity work; no source child stream is attached.

Use saved subscription authentication and real user-level/`claude --settings`
options. Load/reload the plugin; use a NEW Desktop session for hook revisions.
Run with `nativeActions:true`, `lean:false`, both richRows values and both
transports; repeat nativeActions off. Do not change global feature flags or
execute native task tools just to enable a renderer. Task* must both appear
in `$.tool.list()` and in the Codex agent's own registered tool list.

Expected with richRows enabled and Agent/SendMessage/TaskStop admitted:
4 Agent rows (running-child spawn, failed spawn, declined spawn, unknown-child
spawn), 3 SendMessage rows (one failed), 3 TaskStop rows (one failed), and
4 codex_tool rows (resume, list, missing message, multi-target close). Plans
prefer TodoWrite; otherwise TaskCreate/TaskUpdate together. Six plan snapshots
cover duplicate occurrences, status changes, crossing reorder, rename,
completion and clear. Display-only IDs are disclosed beside native task rows.
Without native plan admission or richRows, expect six full codex_plan cards.
With richRows off every non-wait child operation becomes full codex_tool.
Waits produce only changed state/report text; lifecycle notifications produce
no second Agent row. NativeActions off and registration failure retain full
text. One source final answer is handed back once.

## Reproduce the isolated headless mapper probe

This probe emits guarded rows in a disposable MAIN session to exercise actual
schemas/mappers without spawning a Codex subagent or calling a provider. It
does not establish child placement or Desktop paint. The fixture's tool.check
always denies probe IDs if they somehow pass its tool.call answer. Every
probe call is logged before returning without next. Ordinary IDs pass.

```sh
mkdir -p /tmp/codex-mod-batch5-probe/.claude-plugin /tmp/codex-mod-batch5-probe/hooks
printf '%s\n' '{"name":"batch5-probe","version":"0.0.1","description":"Offline guarded mapper probe"}' > /tmp/codex-mod-batch5-probe/.claude-plugin/plugin.json
printf '%s\n' '{"modules":["./probe.ts"]}' > /tmp/codex-mod-batch5-probe/hooks/hooks.json
printf '%s\n' '{}' > /tmp/codex-mod-batch5-probe/settings.json
cp tests/fixtures/batch5-probe.ts /tmp/codex-mod-batch5-probe/hooks/probe.ts
claude -p --plugin-dir /tmp/codex-mod-batch5-probe --settings /tmp/codex-mod-batch5-probe/settings.json --setting-sources '' --output-format stream-json --verbose 'Offline mapper probe' > /tmp/codex-mod-batch5-probe/output.jsonl
claude -p --model claude-sonnet-4-6 --plugin-dir /tmp/codex-mod-batch5-probe --settings /tmp/codex-mod-batch5-probe/settings.json --setting-sources '' --output-format stream-json --verbose 'Offline supported-model mapper probe' > /tmp/codex-mod-batch5-probe/admitted-output.jsonl
```

Observed Claude Code **2.1.302**, 2026-10-19 UTC (2026-10-18 local):

- Default `claude-opus-5-5` admission: TodoWrite and TaskCreate/TaskUpdate
  absent; TaskStop and SendMessage present. Setting ENABLE_TASKS for a single
  investigative subprocess did not change admission; no setting was persisted.
- `--model claude-sonnet-4-6`, with no feature overrides: TaskCreate/TaskUpdate
  admitted and accepted. Create maps to `Task #<synthetic-id> created
  successfully`; update maps to `Updated task #<synthetic-id> status`.
- TaskStop `{message,task_id,task_type:'codex'}` accepted unchanged.
- SendMessage `{to:{agentId:<synthetic>},message,summary}` with the actual
  status/state acknowledgement projection `{status:'completed',agentsStates}`
  accepted and preserved as JSON, with no delivery-success flag. The null
  candidate failed **in the result mapper**, precisely `SendMessage output is
  not an object`. Null is therefore never emitted by this adapter.
- Every run returned `duration_api_ms:0`, empty `modelUsage`, zero token usage
  and `subagent_stats.spawned:0`. The null error is intentional; overall probe
  completion alone is insufficient: inspect each tool_result and guard log.
  These runs do not instrument all Desktop/frontend side effects.

Schema source: supplied `r1/CLAUDE-TOOLS.md`, declarations at
`hooks-api/types/claude-code.d.ts`: TaskCreate input 17185 / result 21843;
TaskUpdate input 17206 / result 21878; TaskStop input 17200 / result 21868;
SendMessage input 17121 / result 21726 (`unknown`, bounded by the real mapper);
Agent input 16472 / completed result 17292; TodoWrite R1 1754–1772.
Guard success is `{result:R}`, denial is `{deny:actualReport}`. Display R is
an array of text blocks. TaskCreate R is `{task:{id,subject}}`; TaskUpdate R is
`{success:true,taskId,updatedFields,statusChange?}` with exact changed keys.
TodoWrite is `{oldTodos,newTodos}` from previous/current display snapshots.
Agent is the completed union with prompt/content, canContinueAgent:false,
zero host metrics/nullable usage buckets and optional actual resolvedModel;
its report explicitly disclaims measured child metrics and host task creation.
Failed/declined spawns return denial and no completed result.

REA artifact evidence `/tmp/codex-mod-batch5-rea.json`:
`ev_87902c6ef526bd23719d9a4a9e40540a97bfe5061168c15c03dfc9685d3b1d30`,
CLI SHA-256 `5262ce9de86243fed0d21edc39b271555d56780d0112e2b194439fe1c6662d37`.
Artifact identity is not semantic proof. Bounded in-memory source reads found
Task* admission `dI() && SV()` with model-sensitive SV; persistence, created/
completed hooks, assignments and panel expansion remain inside executors.
SendMessage's mapper rejects non-object/array/null and serializes this bounded
status/state object; its special display/revival/inlineHandback fields are
never supplied. No third-party source or assets were copied.

## Exact Desktop check: main task list untouched

1. In a NEW local Desktop session after plugin reload, create actual main
   tasks `MAIN-B5-PENDING` and `MAIN-B5-DONE`; complete only the latter. Record
   TaskList IDs, descriptions, owners/dependencies, statuses, backing task
   files/hash and task panel. If TodoWrite is admitted separately, also set
   main todo `MAIN-B5-TODO`; never flip a global feature to admit it.
2. Launch the owner's fake Codex agent once using the above settings, richRows
   on. While its six plans stream, inspect the child's native rows and the
   main panel simultaneously. Native executor/task-hook/assignment counters
   must remain zero for synthetic IDs, with no real task files for
   `codex-plan-*`. A normal main TaskList must still return exactly the two
   real sentinels, with every field unchanged.
3. Capture every child SDK assistant/tool_result row's **non-null actual
   parent_tool_use_id**, bound to the genuine launching Agent tool-use ID.
   Inspect saved transcript/sidecar scope too; the plugin never supplies or
   fabricates that host envelope field. Q1's traced main todo reducer and CLI
   restore exclude non-null parents; a top-level TodoWrite can replace a
   derived main list despite a skipped executor. Unit tests characterize this
   boundary with a positive top-level control; they cannot prove host forwarding.
   Q1 does not prove a separate Task* frontend hydration reducer is safe.
4. Close/reopen the child pane, then reopen history and resume in a new
   session. Recheck all parent IDs, real TaskList fields/files and main panel.
   Make another source plan update: shadow IDs/status/history must survive
   without reusing a real task ID or another agent's IDs. Exercise another
   Codex agent's distinct plan to establish cross-agent isolation.
5. Expand Task* rows. If they are hidden/useless or offer broken “open real
   task” actions, record the actual trigger/result and select `richRows:false`
   (codex_plan). Any main-panel change likewise fails native plan acceptance;
   do not execute a task tool to fix its display. Inspect Agent prompt/report,
   resolved spinner and absent continuation/extra task; SendMessage full body
   and acknowledgement; TaskStop actual close vs interrupt. Check local and
   remote/replayed inference separately before claiming remote support.

## Verification / remaining work

Actual results: `node --test tests/runner.test.mjs` passed **59/59**;
`claude plugin validate --strict .` passed; the explicitly requested
`git diff --check` passed. Third `claude plugin test .` attempt: **537 passed,
6 failed**, all six new app-server cases failed at fixture loading because
appWorld and the case each registered agent.register. Corrected by keeping
world's single case-level registration and adding only app-server process/
existence mocks. **No fourth hook-suite attempt**, per AGENTS.md's three-failed-
attempt cap. Final identity field labels (Claude session vs Codex thread/spawn
IDs) and explicit plan fallback notes were also corrected after that run and
remain unverified by the hook suite. Earlier runs exposed stale Batch 3
assertions and fixture translation/dedup assumptions, corrected using the
observed outputs. Logs:
`/tmp/codex-mod-batch5-plugin.log`, `/tmp/codex-mod-batch5-runner.log`,
`/tmp/codex-mod-batch5-validate.log`. Headless mapper results above were run;
NEW Desktop checks and the owner's integrated fake-subagent harness remain
pending. No independent per-batch review/subagent was launched under the task's
explicit restriction. Next: owner's live scope/paint/affordance acceptance,
then whole-change review. No mirror, native model badge, child controls or
child usage accounting is claimed by this batch.
