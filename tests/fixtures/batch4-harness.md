# Batch 4 headless harness

Run the fake app-server through the existing wrapper (answer `--version` and
`app-server --help`, then launch `fake-app-server.mjs` for `app-server`). Set
`FAKE_SCENARIO=batch4-web-tools` in its environment. The fake imports the shared
`batch4-items.mjs` corpus; it emits started/completed/replayed items and performs
no web, MCP or dynamic actions. The sidecar already retains the complete source
items, so this batch needs no runner wire change.

Use actual user settings or `claude --settings /absolute/path/settings.json`
with the codex-mod plugin's options `transport:app-server`,
`nativeActions:true`, `richRows:false`, `lean:false` and `codexPath` pointing to
the wrapper. Repeat with richRows on, nativeActions off, and lean on. These
flags never bypass either guard. Load/install/reload the plugin and use a NEW
Desktop session for every hook revision; project plugin options are ineffective.
Keep saved subscription authentication; the fake needs no provider inference.

## Expected rows and response contracts

There are 45 source actions: 23 web, 15 MCP and 7 dynamic. With WebSearch and
WebFetch admitted in the Codex agent's own tools, expect 9 WebSearch,
3 WebFetch and 33 codex_tool rows, once each, plus one final handback. Three
searches have durations; other unreported search durations use a disclosed
zero sentinel beside the row. Source/item counts do not include the handback.
With WebFetch absent, its three candidates become action-labelled codex_tool.
No open/find action should acquire a WebSearch label.

- Search: `{query,results,durationSeconds}`; each structured source group has
  the real emitted `tool_use_id` and `{title,url,snippet?}` content. Empty
  results stay `[]`; text/unparsed/opaque entries survive. Query arrays form
  one row, in order. `mode` is required; extended mode needs source evidence.
- Fetch: `{bytes,code,codeText,result,durationMs,url}`. Positive metadata cases
  use an explicit fixture extension containing these complete reported facts;
  ordinary Codex arbitrary-JSON results do not promise this shape. Find returns
  the matching excerpt and names the actual pattern. Duration may also come
  from reported item timing or matched source start/completion timestamps. The failed HTTP case
  retains `404 Not Found`; transport failure uses denial. Missing facts,
  null URL/pattern, mismatched URL, code 0, other and future actions use the
  registered fallback. The fixtures never supply fake `200 OK` for missing data.
- Display: an array of text blocks, never `{content:[...]}`. MCP output retains
  content, structuredContent and _meta; dynamic inputText/inputImage/inputAudio
  stay distinct. Media descriptions include type/size/MIME, without base64 in
  the text. Complete original bytes and null namespace remain in the owned
  source record. Failed/success:false/isError calls deny with actual output.
  Reserved arguments remain nested and never become dispatch envelope fields.

## Configure this offline MCP server

Write a disposable `mcp.json` (replace the Node executable if necessary):

```json
{
  "mcpServers": {
    "parity_fixture": {
      "command": "/opt/homebrew/bin/node",
      "args": ["/Users/atomicz/Projects/personal/codex-mod/tests/fixtures/batch4-mcp-server.mjs"],
      "env": {"FAKE_MCP_LOG": "/tmp/codex-mod-batch4-mcp.jsonl"}
    }
  }
}
```

Pass `--mcp-config /absolute/path/mcp.json` to the headless Claude harness.
The server is newline-delimited JSON-RPC on stdin/stdout; run it directly with
`node tests/fixtures/batch4-mcp-server.mjs`. It supports initialize, ping,
tools/list and tools/call. Config key `parity_fixture` is deliberate: its
lookup identity is `mcp__parity_fixture__lookup`. Every tool requires exactly
`{topic:string}`. `structured` declares output `{answer:integer}` and returns
structuredContent only; `media` returns a tiny image/audio pair; `fail` reports
isError. The log records every request, including tools/call. Startup/listing
is expected; Codex display must produce **zero tools/call requests**. An
ordinary Claude call made separately should reach the server exactly once
and return `Actual fixture executor: <topic>`.

## Confirmed host API blocker for T1/T3

On Claude Code 2.1.302, even the matching fixture tool must remain codex_tool.
The supplied declarations at `hooks-api/types/claude-code.d.ts:13460` define
ToolInfo as only `{name,description,mcp}`. `tool.describe` at 13361 supplies
provider/description/deferral but no schema. The installed runtime's tool.list
implementation independently confirms these three fields (byte 223746028).
There is no supported current API that supplies both the actual input schema
and original server/tool identity. A description or normalized name cannot
prove the matrix's same-server/schema binding. An external MCP replacement
result is also typed unknown: the confirmed plugin display-array contract
cannot be generalized to every connector's output mapper.

REA inspect-artifact evidence:
`ev_1ae0f8689a2202cf198132bbca25df345c22a5b071f314060f4d685eefc6e58d`,
CLI SHA-256 `5262ce9de86243fed0d21edc39b271555d56780d0112e2b194439fe1c6662d37`.
Artifact inspection establishes identity/inventory; declaration and bounded
runtime source inspection establish this API limitation. Evidence JSON was
written to `/tmp/codex-mod-batch4-rea.json`. No third-party source was copied.

Consequently native MCP/dynamic adapters and their exact-name registry are
**not enabled**. Host-present, absent, unknown-contract, mismatched-identity,
reserved-key, account-memory, structured/media and failed calls all exercise
T2/T4. These tests do not claim a successful T1/T3 mapper probe. A supported
schema/identity API plus a no-next mapper/admission probe is still needed
before canonical substitution can be implemented. Do not configure tools as
a way to replay an operation or infer success. Account-memory hook success
substitution remains excluded (R1's non-forgeability rule).

## Safety and remaining live checks

Instrument actual WebSearch/WebFetch network/model executors and MCP/dynamic
executors: all must remain zero for emitted Codex rows. Assert schema/mapper
acceptance, own-agent tool admission, input/source/session binding, cross-agent
and replay refusal, and exactly-once final handback. Both tool.call and
independent tool.check deny protected Codex calls. Normal main/verified Claude
WebFetch and MCP calls with ordinary IDs keep their original execution and
permission path; there is no blanket MCP-name matcher. Test lookup outage and
all flag values. Unit tests mock these boundaries; they do not prove the real
headless mapper or permission path.

In a NEW Desktop session inspect citation URLs, open versus find labels,
HTTP/error styling, structured-only output and readable media descriptions,
expansion controls, saved/reopened rows and absence of duplicate connector
permission dialogs. Owned codex_tool ToolUse labels wrap the normal host row;
if that render state is absent after restart, the literal input/result still
names the actual action. Record any widget side effects precisely. Native
connector UI is not claimed while T1/T3 remain blocked.

## Implementation checkpoint

- Branch read from `.git/HEAD`: `feat/1.2`; only writer. No commit/push/branch
  commands. Changes remain in the working tree; social-preview PNG untouched.
- Changed: `hooks/codex.ts`, new `hooks/web-tools.ts`, both test suites,
  `fake-app-server.mjs`, new `batch4-items.mjs`, `batch4-mcp-server.mjs`, this
  harness, README, Unreleased changelog and UI map. Existing hooks.json and
  sidecar retention suffice. No dependency, manifest or release-file changes.
- Completed: W1-W3 and T2/T4 result fidelity and fixtures. T1/T3 native binding
  is blocked as explained above; no guessed adapter or widened MCP guard.
- Next: resolve supported schema/identity discovery with the host; run the
  owner's real no-next mapper/executor harness, then NEW Desktop acceptance.
  Final whole-release review remains with the orchestrator.
- Verification: `claude plugin test .` passed 526/526; `node --test
  tests/runner.test.mjs` passed 58/58; `claude plugin validate --strict .`
  passed. The final `git diff --check` passed. Logs are
  `/tmp/codex-mod-batch4-plugin.log`, `/tmp/codex-mod-batch4-runner.log` and
  `/tmp/codex-mod-batch4-validate.log`. Real headless output mapper/permission
  admission and NEW Desktop checks were not run.
