# R6 cache, accounting and capacity headless checks

Use a disposable project and a NEW host session after installing/reloading the
plugin. Never change providers or authentication. The fake below uses no model
requests, authentication or network. This harness does not establish actual
cache savings, native v2 tool removal or Desktop rendering acceptance.

## Offline setup

Run these as separate commands, using this checkout's absolute path:

```sh
export R6_REPO=/Users/atomicz/Projects/personal/codex-mod
```

```sh
export FAKE_CACHE_ROOT=$(mktemp -d /tmp/codex-mod-r6.XXXXXX)
```

```sh
mkdir -p "$FAKE_CACHE_ROOT/project/.claude"
```

```sh
cat > "$FAKE_CACHE_ROOT/codex" <<'SH'
#!/bin/sh
exec node "$R6_REPO/tests/fixtures/cache-codex.mjs" "$@"
SH
```

```sh
chmod +x "$FAKE_CACHE_ROOT/codex"
```

```sh
cat > "$FAKE_CACHE_ROOT/project/.claude/codex-mod.json" <<'JSON'
{"roles":{"implementer":{"model":"gpt-6.1-sol","effort":"medium","description":"R6 offline check","lean":true,"capabilities":{"multiAgent":false},"fallbackModels":["missing-model","gpt-6-sol"]}}}
JSON
```

Set the plugin's user options in the disposable project/session: `codexPath`
points to `$FAKE_CACHE_ROOT/codex`, `transport` is `exec`, `footer` is `full`,
`maxRunsPerWindow` is at least 2. User options belong in host settings, never in
`.claude/codex-mod.json`. Launch the host from `$FAKE_CACHE_ROOT/project`.
The existing read-only model catalog must list the chosen models; otherwise
catalog validation correctly refuses the role/fallback. Do not edit real catalog
or authentication files to bypass this check.

For example, after setting those options, start the installed plugin headlessly:

```sh
claude --plugin-dir "$R6_REPO" -p 'Use codex-mod:implementer for task ONE. After its answer, send task TWO to that SAME agent. Return both complete footers.'
```

Expect CACHE_OK 1 followed by CACHE_OK 2 on the same full thread ID. First usage
is 53,880 input / 42,112 cached / 284 output. Second is **45,054 input / 43,904
cached / 367 output**, not 98,934 / 86,016 / 651. Duplicate final events add
nothing. Reuse a fresh temporary root or remove only its `exec-count.json` before
repeating. Observe the effective fingerprint and override snapshot through the
host's test/debug state; do not print raw task/config bodies from private cache.

## Capacity and policy

Start a fresh host session with `FAKE_SCENARIO=cache-capacity` in its environment,
using a fresh temporary root. Launch one task with the role above. Expect exactly
two Codex launches: gpt-6.1-sol fails, missing-model is skipped, and gpt-6-sol
resumes the same thread at medium effort. The handback contains
`gpt-6.1-sol at capacity; continued on gpt-6-sol`. With maxRunsPerWindow=1,
expect a launch-guard failure and only one launch. An empty role fallbackModels
list disables retry. Automated hook tests also cover a second capacity failure:
no third launch, including after a host nudge.

Repeat with transport=app-server. Unset FAKE_SCENARIO for the accounting case;
its resumed thread total is 6,000/4,600/550 and direct usage is 1,000/600/50.
Duplicate raw responses, duplicate cumulative notifications, a pre-turn zero
snapshot and a stale foreign-turn notification must not add tokens. The sidecar
retains late numeric source records after the terminal event. Capacity behavior
is the same and the sidecar itself performs no retries.

For role precedence, restart with lean=false in the project role while global
lean=true: expect a refusal warning and effective lean=true. Enable user
allowProjectNonLean to allow the rich preset. Alternatively keep role lean=true
and grant only `["webSearch:live","mcp:rea","multiAgent"]` in user
projectCapabilityAllowlist before requesting those capabilities. Only configured,
discovered MCP names can be selected; this is not a full layered-config audit.
An explicit user `extraConfig` disable wins. Invalid capability types skip the
role. Change config.toml/role text after the first launch: follow-ups keep the
saved override/instruction/home snapshot. A deliberate model/effort change adds
a cold-start warning and changes the effective fingerprint.

## Spawn detection and live checks

Use the existing nested harness with FAKE_SCENARIO=nested-one-child and effective
multiAgent=false. Expect the no-subagents task instruction, a visible/logged
spawn warning and real nested observation rows; no replacement execution.
With a user-approved role multiAgent=true, the warning/instruction disappear and
nested mirrors still work. Exec retains source rows and marks child usage
missing; app-server sums observed direct/descendant source usage once.

For real CLI checks, use saved subscription login and an explicitly bounded
read-only task. Verify the actual available tool catalog in fresh/resumed lean,
rich and selective runs. R6 proves features.multi_agent=false is insufficient
for gpt-6.x v2; the instruction/detector does not remove that tool or guarantee
no children. Do not call a sandbox-blocked check accepted. No supported config
for bounding tool results in retained Codex history was verified; bound output
at the command/search source. Do not infer universal token savings from a fake.

## Automated verification

```sh
claude plugin test .
node --test tests/runner.test.mjs
claude plugin validate --strict .
git diff --check
```

Inspect the actual results before recording acceptance. Native Desktop controls
and live cache/capability checks remain separate, fresh-session checks.

## Implementation checkpoint (2026-10-19)

- Branch supplied by owner: feat/1.2; existing checkout, one writer, no subagents.
  Changes are left uncommitted. No Git operation beyond the requested
  `git diff --check` was run; branch/status were not queried.
- Changed: hooks/codex.ts, hooks/run-policy.ts, hooks/exec-usage.mjs,
  hooks/tree-usage.mjs, scripts/codex-runner.mjs; the hook/runner/store tests;
  fake-app-server.mjs and cache-* fixtures; manifest userConfig only,
  README, Unreleased CHANGELOG and docs/codex-ui-map.md. The social preview
  image and manifest version were left untouched.
- Verification: `claude plugin test .` 685 passed, 0 failed;
  `node --test tests/runner.test.mjs` 101 passed, 0 failed, 1 skipped
  (private Unix socket unavailable); `node --test tests/store-state.test.mjs`
  10 passed; strict plugin validation and whitespace check passed.
  Node syntax checks and an offline CLI capacity/resume/cumulative smoke passed.
- Logs: /tmp/codex-mod-r6-plugin-final.log,
  /tmp/codex-mod-r6-runner-final.log, /tmp/codex-mod-r6-validate-final.log.
- Next checks: new Desktop session after reload, actual tool catalog on both
  transports, real same-thread first/follow-up counts and cache measurements.
  No live model/capacity experiment or Desktop acceptance was performed here.
