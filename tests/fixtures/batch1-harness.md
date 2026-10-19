# Batch 1 headless harness inputs

`batch1-exec.jsonl` is a deterministic exec-shaped stream for the fake Codex
executable. The less common exec variants/extra fields are protocol-derived
compatibility fixtures, not claims that this Codex serializer emits them today.
It includes all 19 source kinds, command replay, null/nonzero/declined exits,
a move diff, structured-only MCP, failed dynamic audio, child model/effort,
image failure, review bodies, a warning, an unknown variant and one final answer.
The absolute source cwd/path values are evidence only; the fake performs no work.

Run your existing host harness with `nativeActions:true`, `richRows:false`,
`lean:true`, `transport:exec`, then with `richRows:true` and with native rows off.
Use actual user settings or `claude --settings`. Instrument native executors,
file/network calls and Agent spawn: all display calls must execute zero times;
SubagentHandback remains the single real delivery. Verify ordinary main and
ordinary Claude subagent tool calls separately. Host schema/mapper acceptance
and a NEW Desktop session remain orchestrator checks.

The stream exercises Bash, WebSearch, codex_tool, codex_plan and admitted rich
Agent/TodoWrite shapes. This host lacks TodoWrite, so expect codex_plan there.
Use the harness's existing before/after file setup for native Write/Edit results;
the move fixture retains source evidence but uses the existing patch preview.
Images, native exploration, exact patches, Task*, WebFetch, faithful external
tools, question interaction and child mirror loops remain later batches.

For app-server use `FAKE_SCENARIO=batch1-wire` with `fake-app-server.mjs` through
the runner. It additionally sends patchUpdated, outputDelta, terminalInteraction,
aggregate turn diff, plan/goal/warning/retry/unsupported notifications, a nested
reasoning snapshot and a user-input request. The request must still receive
-32601; recording it does not approve or answer it. No aggregate-diff or terminal
interaction record should create another action row.
