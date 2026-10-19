# Batch 2 headless harness

Use `FAKE_SCENARIO=batch2-exploration` with `fake-app-server.mjs` through
`scripts/codex-runner.mjs`. `batch2-app-items.json` supplies app-server-shaped
commands; normal exec does not emit commandActions and cannot exercise the
positive mappings. The missing-actions case deliberately simulates that gap.
All paths/output are evidence; the fake does no filesystem work or inference.
`batch2-cases.ts` holds the corresponding expectations for plugin tests.

Example capture (a disposable control directory is required):

```sh
FAKE_SCENARIO=batch2-exploration node scripts/codex-runner.mjs run \
  --codex tests/fixtures/fake-app-server.mjs --cwd "$PWD" \
  --model gpt-6.1-sol --effort medium --sandbox workspace-write \
  --control /tmp/codex-mod-batch2-control < /dev/null > /tmp/batch2.jsonl
```

Use your headless host harness to consume that JSONL via fake Codex, or route
its fake app-server executable through this scenario. Load a disposable plugin
with actual user settings / `claude --settings`: `nativeActions:true`,
`richRows:false`, `lean:true`, `transport:app-server`. Repeat with richRows on
and nativeActions off. Native exploration is independent of richRows.

Expect one row for each fixture command (including starts/deltas/poll/replays),
plus one final handback: positive Read/Glob/Grep and one Bash per negative.
Check exact text Read and runtime Glob/Grep output-schema/mapper acceptance;
instrument native read/search/shell executors and assert zero executions.
Only the final SubagentHandback is real. Check ordinary main and Claude
subagent Read/Glob/Grep separately, and foreign/replayed IDs refusing safely.
The `duration-sentinel` row must disclose its unreported duration.

After install/reload, use a NEW Desktop session for grouping/counts, original
command/cwd visibility, expansion (decoded match lines and NUL-framed counts), long-output
clipping disclosure, error styling and reopened history. A pipeline must stay
one Bash row. These live observations are not established by plugin tests.
