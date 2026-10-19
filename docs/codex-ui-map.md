# Codex UI map

How OpenAI Codex shows each kind of work item, and how codex-mod draws it in Claude Code.
Checked against codex-cli 0.163.0-alpha.10.2 and the Codex desktop app 26.1013. Labels come
from two independent static readings of the shipped binaries and app bundle plus a few
`codex exec --json` runs, not from captures of either UI. Treat them as close approximations,
not exact copies.

codex-mod draws a Codex action as a Claude Code tool row. Codex has already run the action,
so the mod's own `tool.call` guard answers the row with the result Codex reported, and Claude
never runs it again (D-001). A row can only use a tool that is in the agent's own `tools` list,
because the engine refuses any other tool before the guard sees it.

## Status legend

- **mapped**: drawn since 1.0.
- **1.2**: drawn since 1.2, as described in the column "Closest Claude Code row".
- **deferred**: not implemented or not yet admitted/verified; not drawn.
- **out of reach**: Claude Code has no fitting surface, or drawing it would be misleading.

## Map

| Codex item (exec / app-server) | Codex CLI shows | Codex app shows | Closest Claude Code row | Status | Fields used |
|---|---|---|---|---|---|
| Coordinator receipt (`session.append`, both transports) | Input message / steer | Input message | Display-only `mcp__codex-mod__coordinator_message` with a Coordinator card on owned emitted IDs; full original text, numbered parts above 90,000 characters; "Coordinator message:" text when native rows are off or registration fails. UUID deduplication persists; receipt does not confirm steering or enter the handback. Live Desktop paint/replay remains unverified. | 1.2 | `{ sourceUuid, text }`; original override lines retained; `↪` delivery status stays separate without an excerpt |
| `agent_message` / `agentMessage` | Assistant text | Assistant message; commentary between tools | Text block; the last final answer is the handback; commentary and partial answers are text between rows | mapped (commentary: 1.2) | `text`; app-server also has `phase` (commentary, final_answer) |
| `command_execution` / `commandExecution`, single faithful read | Read under "Exploring" | "Read files" | Guarded `Read` text result; whole `cat`, proved-total `head`/`tail` slices | 1.2 | Single `read` action, literal args, matching path/cwd, exact output/line total; original command/cwd beside row |
| Same, single file-only enumeration | List under "Exploring" | File listing | Guarded `Glob`; NUL-delimited `find -type f -print0` or `rg --files -0` with supported filter | 1.2 | Single `listFiles` action, exact translated pattern/root, reported filenames/order, duration (disclosed sentinel when absent) |
| Same, single faithful content/files/count search | Search under "Exploring" | Search results | Guarded `Grep`; ripgrep JSON content or NUL-delimited filenames/match counts; documented no-match exit succeeds | 1.2 | Single `search` action, query/path/options, fixed-string escaping, exact delivered output and decoded filenames/counts |
| Same, every incompatible/ambiguous command; normal exec without actions | "Running" / "Ran" | "Running {command}" / "Ran {command}" | One `Bash` row, including pipelines, multiple actions, redirects/substitutions, unknown slice totals, directory listings and real failures | mapped | Original command, combined output, status/exit; no inferred successful exit |
| Command output deltas / terminal interactions / completion replay | Running shell activity | Running shell activity | One final C1–C5 row per item, no extra poll/keypress row | 1.2 | Thread/turn/item/process identity, retained deltas/stdin, authoritative completed output |
| `file_change` / `fileChange` | "Added" / "Edited" / "Deleted" with a diff | "Editing/Edited", "Creating/Created", "Deleting/Deleted" per file, a diff toggle, +/- counts | Exact additions → `Write`; verified unique replacement spans → `Edit`; bounded exact hunks → ordered `Edit` rows. Other patches → typed `Bash.bashEditDiff` with a display comment; deletions use `deleted:true`, verified moves use old deleted/new created images. Failed/declined/unconfirmed attempts deny. | 1.2 | Original structured/string `kind`, `move_path`, verbatim per-file `diff`, completed status, source cwd and item-scoped before/stable-after evidence; patchUpdated merges, aggregate turn diffs never add rows |
| `reasoning` / `reasoning` | Status header from the summary; summary in dim text | "Thinking" while it streams, then "Thought for {time}", collapsed by default | `thinking` stream chunk (summary only) | 1.2 | Completed `summary[]`; public exec `text`. Summary deltas remain opted out; raw content/deltas never cross the wire |
| `todo_list` (exec) / `turn/plan/updated` notification | "Updated Plan" with a checklist | Progress ring plus current step, "Step n / m" | With `richRows`: admitted `TodoWrite`, then paired `TaskCreate`/`TaskUpdate`; full `codex_plan` otherwise | 1.2 | `items[{text, completed}]` (exec); `plan[{step, status}]`, `explanation` |
| — / `plan` (plan mode) | "Proposed Plan" block | "Plan" card ("Writing plan" while it streams), expandable | Text block headed "Proposed plan:" | 1.2 | `text` |
| `web_search` / `webSearch` | "Searching the web" / "Searched the web"; opening and finding in pages | "Searching the web" -> "Searched the web for {query}" | Guarded `WebSearch` for search, `WebFetch` for open/find with complete HTTP metadata; action-labelled `codex_tool` otherwise | 1.2 | `query`, ordered queries, exact `action`, `results`, source timing |
| `mcp_tool_call` / `mcpToolCall` | "Calling" / "Called" plus tool and result | Connector-specific verb or generic tool row; result blocks; raw `server.tool` output | Display-only `codex_tool` row | 1.2 | `server`, `tool`, nested `arguments`, full `result.content`/`structuredContent`/`_meta`, errors/status/timing |
| — / `dynamicToolCall` | Tool call cell | "{toolName}" row | Display-only `codex_tool` row | 1.2 | Original `namespace`, `tool`, nested `arguments`, text/image/audio `contentItems`, success/status/timing |
| `collab_tool_call` / `collabAgentToolCall` | "Spawned", "Sent input to", "Waiting for agents", agent states | "Created {agent} with the instructions…", "Messaged", "Closed"; wait calls hidden; Subagents panel | With `richRows`: guarded completed/error `Agent`, `SendMessage` for full sends, `TaskStop` for close/interrupt; `codex_tool` fallback and resume/list; waits show state transitions only | 1.2 | `tool`, `prompt`, `receiver_thread_ids`, `agents_states`, `status`, `model` |
| — / `subAgentActivity` | (agent status lines) | "{name} finished", "Sent message to {agent}" | Deduplicated lifecycle text; app-server can attach one observer, without a duplicate spawn/mirror | 1.2 | `kind`, full `agentThreadId`, `agentPath`, `model`, `reasoningEffort` |
| — / `imageView` | "Viewed image" | "Viewed an image" with preview | Guarded Read image from bounded, stable filesystem bytes; explicit later-preview/unavailable report | 1.2 | `path` |
| — / `imageGeneration` | "Generated an image" | Generated image in a gallery | Full `codex_tool` generation result/error, plus guarded Read of a real saved output | 1.2 | `status`, `revisedPrompt`, `result`, `savedPath`, `transparentBackground`, `failure` |
| — / `contextCompaction` | "Compacted context" | "Compacting context" -> "Context automatically compacted" | Deduplicated status text | 1.2 |  — |
| — / `enteredReviewMode`, `exitedReviewMode` | "Entered/Exited review mode" | "Review mode" | Full attributed review text; complete actual structured findings can use guarded ReportFindings with richRows | 1.2 | `review`, actual `findings` when supplied separately |
| — / `sleep` | (wait cell) | Wait row | Elapsed-wait text; never ScheduleWakeup or a timer | 1.2 | `durationMs` |
| `item/tool/requestUserInput` (app-server RPC) | Explicit question | Question card | Owned choice question/answer/cancel card; admitted AskUserQuestion only after actual answer; unsupported/approval requests error explicitly | 1.2 | Full RPC params and request/item/thread/turn IDs, one-time response token; no implied consent |
| `error` item (exec) | Warning | — | Visible warning text plus source record; does not fail the turn | mapped | `message` |
| — / `userMessage`, `hookPrompt`, `functionCallOutput` | Input echo / internal | Input echo / internal | Nothing (Claude Code already shows the prompt) | out of reach (not needed) | — |

Exec only emits eight item types (`agent_message`, `reasoning`, `command_execution`,
`file_change`, `mcp_tool_call`, `web_search`, `todo_list`, `collab_tool_call`) plus `error`.
Every other row in the table needs the `app-server` transport.

## How 1.2 draws them

- **Reasoning summary -> `thinking` chunks.** Only the summary text, never raw reasoning, and only
  within the existing step pacing. Claude Code shows hook-made thinking live but does not record it,
  so it is missing from the saved transcript. Many runs send no summary at all.
- **Web search -> `WebSearch` row.** Completed actual searches use `{ query, mode }`, including every ordered query in one multi-query row. Results retain source title/URL/snippet envelopes bound to the emitted host tool-use ID, text and opaque JSON; an actual empty array stays empty. A missing duration is disclosed beside the row as a zero sentinel.
- **Open/find -> `WebFetch` when response facts exist.** Input `{url,prompt}` names the actual action; find describes the actual pattern and returns its matching excerpt. The result is exactly `{bytes,code,codeText,result,durationMs,url}` from reported response metadata. Actual HTTP failures keep their code. Missing metadata/URL/pattern, mismatched URL and other/opaque actions use `codex_tool`, with an owned `Codex web.<action>` label and full reported results. No invented `200 OK`, bytes or elapsed time.
- **MCP and dynamic calls -> display-only `codex_tool`.** Input `{server,name,arguments}` keeps arbitrary keys nested outside the dispatch envelope. Results are text content-block arrays, with structured-only results, `_meta`, resources and media descriptions; encoded payloads remain in the source record. Dynamic inputText/inputImage/inputAudio are interpreted separately from MCP blocks. Failures use `deny` with the actual report. Only owned IDs are decorated, preserving the host row underneath. Normal Claude MCP calls pass unchanged.
- **Faithful external identities are blocked on the current host.** Claude Code 2.1.302's `ToolInfo` and runtime `$.tool.list` return only `{name,description,mcp}`. `tool.describe` supplies description/deferral/provider, without schemas. There is no supported input-schema plus original-server-identity discovery path here. MCP results are typed `unknown`; the registered display content-array contract does not prove every external tool's contract. T1/T3 therefore use T2/T4 for a concrete missing-schema/binding reason; no canonical-name registry or guessed identity is enabled. Recognized account-memory success replacement remains excluded along with all other unverified contracts. This is an API limitation, not a Desktop paint finding.
- **Plan updates -> display-only `codex_plan`.** Input `{ explanation?, steps: [{ step, status }] }`.
  `richRows` selects guarded `TodoWrite` when admitted, otherwise paired `TaskCreate`/`TaskUpdate`. Previous snapshots, occurrence-matched IDs and statuses persist per agent/thread. Ambiguous reorders/renames are removed/created; clears delete only shadow IDs. The full checklist/empty state and explanation remain in the registered fallback input/result and owned ToolUse checkbox card. No host task persistence, hooks, assignments or dependencies execute. Actual main-panel isolation requires child parent scope to survive stream/reload/resume (Q1 evidence); Task* paint and synthetic-link affordances still need Desktop acceptance.
- **Proposed plan** (`plan` item) -> a text block headed "Proposed plan:".
- **Codex child operations** -> guarded completed Agent for successful completed spawn calls, denial for failed/declined spawns. Reports distinguish spawn completion from child status, disclose unreported metrics, use synthetic IDs and disable continuation. Full message bodies map to admitted SendMessage with the probed `{status,agentsStates}` acknowledgement object; null fails the real mapper despite its unknown declaration. Close/interrupt map to admitted TaskStop `{message,task_id,task_type:"codex"}`. Resume/list, missing facts/tools and ambiguous targets use full codex_tool; registration failure retains text. Waits show only changed child state/report (reported duration when present); subAgentActivity is deduplicated against known operation state. With app-server and `nestedAgents`, the separate observer path below creates real host tasks; exec, disabled nesting and attachment/admission failures retain this report-only view.
- **Commentary** (app-server `agentMessage` with phase `commentary`) -> text between rows; the final
  answer is still the handback.
- **Compaction** -> source-keyed status text, deduplicated with deprecated thread/compacted notifications. **Review** -> full text, never Claude plan mode. **Sleep** -> elapsed status without creating a timer.
- **Images** -> guarded Read image (real filesystem bytes) and full generation cards; details and fallbacks below.
- **Questions** -> owned explicit response card for bounded choices; already acknowledged answers alone can use AskUserQuestion when admitted. No question executor runs to draw it.
- With `nativeActions: false`, every new item becomes a plain text line, like commands and edits.
- If the display tools cannot be registered, their rows fall back to text lines.

## Not possible (or not worth it)

- Native rows for tools that are not in the agent's own `tools` list: the engine refuses them
  before any hook answers.
- A guarded completed `Agent` row describes a spawn result; it does not create a real host task. Native task and faithful MCP adapters need admission/result checks before use.
- Recorded thinking: only the engine's signed thinking blocks are kept in the transcript.
- Exec-only sessions cannot show plans, dynamic tools, sub-agent activity, image views,
  compaction or review mode. Codex does not emit them there.
- Exact Codex wording and layout: Claude Code draws its own rows. A `ui.render` hook can
  relabel a row, but how faithfully Desktop draws custom trees is not verified.
- Exploration adapters use a bounded literal parser; unsupported forms keep Bash. Native result schemas come from Read's declaration and Glob/Grep's runtime contracts in the research matrix. Grep content decodes matching/context lines and counts delivered lines, retaining raw JSON in the source record. Native grouping/paint, clipping behavior and reopened command visibility still require a NEW Desktop session; unit/schema checks do not establish them.

## Exact patches (Batch 3)

`hooks/patches.ts` parses unified per-file hunks and raw prefixed add/delete
lines, preserving CRLF and explicit no-newline markers. A complete addition can
supply Write even when no image is readable; a disagreeing/unstable image refuses
that translation. Empty ambiguous diffs require an empty completed image.
Updates require a captured base, strict coordinates/content and matching stable
completion reads. Exact gaps may join hunks; otherwise each bounded replacement
must be unique at its intermediate revision or the whole file falls back to Bash.
A sampled update with no source diff never becomes Write.

Bash uses a comment headed `# Codex apply_patch:` and a typed `bashEditDiff`
result (`files`, `moreFiles:0`, `changedFiles`), with only known hunks and literal
true creation/deletion flags. Undecodable diffs remain literal stdout. Moves
retain both paths and modification diff; old/new image hunks require verification.
Source failure/decline/unknown status returns `deny` with the actual report and
attempted diff. Explicit per-file completed evidence can admit that file after
an overall failure; unproved partial application remains an error. Guards never
call executors or write patch files. One source patch can produce several native
rows; adjacent notes, row provenance and footer counts preserve that distinction.

Contracts: research R1 Bash (246–266), Edit (394–414), Write (1902–1922), and
R2 apply_patch plus generated `FileUpdateChange`, `PatchChangeKind` and
`FileChangePatchUpdatedNotification` types. See `tests/fixtures/batch3-harness.md`
for headless mapper checks and NEW Desktop session acceptance. Typed Bash patch
admission, native paint/counts/grouping and working-tree/Git effects are still
unverified live; no custom-card fallback is selected without observed paint evidence.

## Web and arbitrary tools (Batch 4)

The web constructors and safe result text live in `hooks/web-tools.ts`; the
existing source ledger retains complete unmodified public item results and
provenance. Only the display text omits encoded media bytes. WebFetch joins
both guards, refusing catches and each capability-filtered Codex tool list.
Its normal main/verified Claude calls keep the real executor. External names
are never blanket-matched as plugin display tools; reserved-prefix calls
remain refused regardless of name. Plain text mode retains arbitrary tool
results and reported web metadata.

Schema sources: R1 WebSearch (1852-1872), WebFetch (1826-1846), the actual
`BuiltinToolInputs`/`BuiltinToolResults` declarations, and the confirmed
registered-display text-array contract. Raw app-server results are arbitrary
JSON: only a complete explicit RFetch-shaped response is admitted, without
assuming undocumented aliases. Metadata extension fixtures are capability
examples, not evidence that normal Codex web output provides these facts.

See `tests/fixtures/batch4-harness.md` for settings, the shared 45-item scenario,
the offline MCP server and API evidence. No success claim for T1/T3 or native
MCP output mappers follows from fallback/runner tests. Headless real WebFetch
mapper acceptance and a NEW Desktop session still need to be observed.

## Images, modes, questions and receipts (Batch 6)

Read image input is `{file_path:absolutePath}`. Its exact inner result is
`{type:'image',file:{base64,type,originalSize}}`; `file` has no filePath.
MIME is sniffed from PNG/JPEG/GIF/WebP bytes; originalSize is the actual byte
count. `$.fs.stat` before/after a bounded `$.fs.read(path,{as:'bytes'})`
rejects size/mtime/resolution changes. This captures a later file image, not
proof of the original viewed bytes. No Claude Read executor or network fetch
runs. Malformed/unsupported, missing, oversized or changing files retain a
concrete preview-unavailable explanation. Generated previews do not add a
second source-operation count; generation's full reported fields remain in
its display card. Embedded result strings are not treated as image paths.

Completed public summaries use live thinking only, with no invented duration
or signed history. Commentary/partial answers, full review text, warnings,
compaction and waits remain separate from final handback. Structured findings
are conditional extensions: the current ThreadItem union guarantees review
prose, not a dedicated findings item. Required fields are never inferred.

Question controls are enabled only on app-server with nativeActions on,
lean off and an admitted owned `codex_question` ToolUse site. They support
1–4 distinct non-secret questions, 2–4 choices each, headers at most 12
characters, no free-text/Other. Every choice, submit and cancel is explicit.
Responses bind the per-run token and RPC/item/thread/turn IDs; malformed,
stale, duplicated, resolved or ended responses cannot deliver an answer.
Cancellation returns an RPC error, not an empty answer. All permission and
approval methods remain unsupported errors; `approvalPolicy:never` stays set.
With richRows and actual AskUserQuestion admission, only an acknowledged
answer maps to `{questions,answers}` in both native input and result.

Coordinator rows persist exact registered name, owned ID, source UUID and
full literal text for renderer lookup after restart. Guards are never restored
from those presentation records. Host default input retains the full body if
a custom renderer is missing; attributed text fallback uses a fence longer
than any payload fence when markup could hide text. Numbered parts preserve
Unicode surrogate pairs and source UUIDs; receipt never changes the answer.

Offline Claude 2.1.302 accepted Read PNG and ReportFindings replacements with
zero provider work and zero subagent launches. AskUserQuestion was absent in
noninteractive admission, so that native path remains conditional. Actual
Desktop preview/history, live thinking versus reopen, owned question controls
and coordinator rendering need a NEW Desktop session. See
[Batch 6 harness](../tests/fixtures/batch6-harness.md).

## Agents and task cards (Batch 8)

### Host contract and placement verdict

CLI **2.1.302** supports real background subagents, but its plugin spawn API
cannot choose a parent. The owner's headless run created the child with
`spawnDepth:1`, no parent field, `pluginSteered:true` and
`requestShape:background`; the spawn event omitted `parentAgentId` and `effort`.
This is a real sibling task, not successful native nesting.

Evidence, verified locally against the installed host:

- Research `hooks-api/types/claude-code.d.ts:251` restricts `AgentSpawnArgs`
  to prompt, description, subagentType, model, name and cwd. At line 319,
  `parentAgentId` on the observed spawn event is pinned. `AgentInfo.parentId`
  is read-only (line 168). There is no reparent/adopt argument or method.
- `strings -n 8 "$(readlink -f "$(which claude)")"`: the session engine's
  `toolContext` builds from main-session messages and `mainLoopModel`; the
  headless `toolContext` likewise uses its session builder. The `rdn` adapter
  adds plugin origin/caller, without an arbitrary agent identity. Agent
  launch computes depth from that context and core creates a `local_agent`
  through `Pse`. In this strings output these appear near offsets 44,976,342,
  50,631,585, 24,996,340, 30,843,625 and 27,235,342 respectively.
- REA `inspect-artifact` authenticated the installed Mach-O (SHA-256
  `5262ce9de86243fed0d21edc39b271555d56780d0112e2b194439fe1c6662d37`,
  evidence `ev_1ae0f8689a2202cf198132bbca25df345c22a5b071f314060f4d685eefc6e58d`).
  REA establishes artifact identity; the contract and bounded strings reads
  establish the API conclusions, not live Desktop rendering.

Consequently the title includes `Codex child of <parent title>` and the
parent's completed observation-link Agent row names the source parent and
both real host IDs. No pinned fields, task snapshots or transcript files are
rewritten to simulate hierarchy. The Batch 8 unsupported-parent stop condition
is reached; another spawn route/provider is not attempted.

### Supported cards and remaining limits

All registered Codex types already have `background:true`. A real Agent/API
spawn creates the host `local_agent` task, which supplies status and native
stop/send controls through core task events and `background_tasks_changed`.
The title comes from supported `agent.spawn.description`; prompt/report come
from the real loop. Core progress accounting (`cLn`/`slt`/`rco` in CLI `DQ`,
near strings offset 30,768,666) consumes emitted transcript/tool rows. The
plugin does not set task fields. Unit tests check background registration,
model/title text, guarded rows and reports; Desktop paint remains unverified.

| Capability | Verdict |
|---|---|
| Top-level Codex task/card | Supported as an actual background subagent; no extra session creation is necessary. |
| Mirror task/card | Supported as a real `codex-mod:codex-child` observation task, separate from its source parent in this host. |
| Native running/completed/stopped | Core controls its own worker/task state. Native TaskStop/abort maps to the source adapter below. |
| Source failed/interrupted | Journal and saved mirror state retain `failed`/`aborted`, and the report says `codex failed`. A normally ended observer may still have a host Completed badge. `TurnStepResult` has no error/task-status field (`d.ts:13963`), and `turn.complete` only returns text/usage (`13804`). No supported Failed/Killed badge setter for an external source was found. |
| One-line summary/progress text | No public task summary setter. SDK `agentProgressSummaries` enables host-generated summaries (an auxiliary `agent_summary` inference); `task_progress.summary` describes that host output, not a plugin input. Use title, transcript actions and final report without enabling inference for decoration. |
| Separate Desktop session card | Unsupported adoption here. Conditional `mcp__ccd_session__start_session` starts a new session and has no Codex agent selector/adopt-thread field. This plugin intercepts subagent steps; its main steps pass through. Calling that tool would start ordinary provider work. |

The supplied headless network audit saw MCP fetch and telemetry requests to
Anthropic, with no `agent_summary` observed. It does not prove Desktop's
initialization flags or a long-running summary timer. There is no public
per-agent summary opt-out in this contract. Keep saved subscription auth;
never switch billing/provider to work around this boundary. A NEW Desktop
session must confirm background-list/sidebar presence, stop/send controls,
progress rendering, navigation/history and auxiliary-request behavior.

### Observer implementation

`nestedAgents:true` on app-server discovers verified source UUID edges from
SubAgentActivity and legacy spawn items. The owning connection rejoins with
`thread/resume {threadId,excludeTurns:true}` without execution overrides or
`turn/start`, pages current-root-turn history, merges buffered live events,
and journals each child's public compatibility envelopes separately. Root
completion cannot terminate a live child observer. Attachment gaps and
unverified ancestry are lifecycle/report fallbacks; no file-only tailing or
new source execution repairs a missing stream.

The actual parent's step reserves and persists a launch capability before
calling `$.agent.spawn`. A separate spawn observer records the core tool ID;
turn.start can bind the host ID before the API resolves. Distinct source-depth
2/3 mirror step registrations avoid the calling handler's inherited exclusion;
these are dispatch/source-generation guards, not native host placement.
CLI 2.1.302 can omit parentAgentId and report cwd as undefined in agent.spawn.
Admission therefore uses the active spawning step's recorded parent/session,
exact one-time prompt token, expected type/name/description and one core tool
ID shared across call/check/spawn. Cwd is excluded from that input digest;
the source cwd remains in the mirror record for replay. An explicit conflicting
parent or host identity is refused. Missing list metadata is reconciled only
against the admitted launch, without creating another task.
Their catches answer without engine APIs or provider fallthrough. A mirror
consumes the existing journal through the normal guarded action renderer and
never enters startRun/answerWithCodex. Infrastructure Agent admission checks
exact held input and plugin origin; all source/display actions remain
nonexecuting. The hidden type is not offered to model dispatch.

The extra parent Agent row is a completed **observation-link operation**,
with the returned real host agentId and a separately recorded host launch ID.
It is not the core virtual launch row, and makes no native token/task-state
projection. Native Desktop linkage between these rows is an acceptance gate.
The host task owns its own transcript and completion. Child source terminal
events end the mirror without interrupt echo. Host child stop writes a
child-addressed interrupt, and the broker cancels that source subtree while
leaving unrelated siblings running. Explicit parent abort snapshots owned
descendants even after hooks-worker restart or root-turn completion. Both
paths deduplicate per thread/turn. A request checkpoints `stopping`; only
source terminal evidence confirms `aborted`, and an RPC acknowledgement alone
does not. A killed observer's saved state can remain `stopping` until its
journal is read again; it does not claim successful source cancellation.

Steering claims each coordinator receipt separately from its pending display,
preserves UUID and submission intent before writing a control, and records
accepted/rejected/unknown outcomes. The full receipt remains available until
the transcript renderer emits it.
The broker retains UUID dedup for its lifetime even after a hooks receipt
window is evicted. Acceptance requires a matching turn ID. Missing/ambiguous
acks or checkpoint failures are never retried or converted to new inference.
Idle child continuation is rejected in this slice.

Private mirror records (`mirror:<session>:<child UUID>`) retain parent/source
IDs, launch token/digest, broker generation, actual host ID, core launch ID,
display-link ID and launch outcome. Agent records retain replay cursor,
prefix check, public ledger, pending rows, final text and direct usage.
Recovery consumes these records and the current owner journal, or reports a
partial/lost observer. Reserved, uncertain and evicted identities are never
automatically spawned again. Journal truncation/replacement is a gap. Cursor
and host transcript writes are not atomic; ambiguous text delivery is not
claimed exactly once.

Run [Batch 8 harness](../tests/fixtures/batch8-harness.md) for real headless
SendMessage/TaskStop checks and the remaining Desktop acceptance cases.

The source usage ledger counts each reachable thread once, scoped by root
turn, and deduplicates response IDs and cumulative turn snapshots. Full
footers label direct and tree counts; missing sources remain partial. Host
stop usage stays null, preventing parent-tree/child-direct double counting.
No native GPT badge or zero auxiliary host inference claim follows from this
accounting. See the [nested harness](../tests/fixtures/nested-harness.md) for
core task, provider-boundary and NEW Desktop checks.


## Model and effort visibility (Batch 7, M2/M3)

The shared `resolveProfile` selects the actual model/effort for agent.spawn
presentation and startRun execution on both transports. Leading prompt lines
win over the native Agent effort, then role/model-type/generic defaults.
Native effort is read from `tool.call`'s flat Agent input by tool-use ID;
`agent.spawn.effort` is also detected if supplied by a later host. The supplied
API snapshot and installed 2.1.302 spawn-event builder omit effort but include
model, parentModel, permissionMode and provider. Debug diagnostics distinguish
both effort surfaces and absence. Unsupported native efforts visibly fall back;
invalid prompt profiles still fail without launching Codex.

M2 prefixes only pinned codex-mod types/providers with
`Codex <model> · <effort> · <description>`. Normal Claude agents and fixed
resume/workflow descriptions pass through. Nested observers construct the
same prefix before the mirror capability digest, preserving admission.
The title records launch selection; there is no supported title setter for
later profile changes.

M3 binds the real spawn tool-use ID to the actual host agent's compact record,
with pending-launch identity checks before an early first step. The ToolUse
renderer matches only these owned Agent IDs or owned synthetic child rows.
It adds literal current model/effort text around the original native tree;
status, errors, navigation and accessibility remain the host's. Rendering
errors or missing state fall back to the native tree. Compact row IDs survive
reopened history; prompt bodies/catalogs stay out of $.store. Follow-up runs
invalidate the row and the footer uses the same selected execution profile.

The native header/activity/task model badge recognizes Claude families and
cannot be made to display arbitrary GPT IDs through this plugin API. All
registered types retain `model:haiku`; GPT registration risks provider request
selection. No model request, usage projection or tool execution is induced by
presentation. `modelAgents:true` offers one type per listed catalog slug,
independent of the placeholder. The host registration API permits only
letters, digits, underscores and hyphens (64 characters), so unsupported
literal slugs fall back to a logged sanitized alias, e.g.
`codex-mod:gpt-6-1-sol` still launches `gpt-6.1-sol`. Project roles win both
literal and alias collisions.

The native-actions default remains enabled. The existing richRows default
remains false pending the matrix's NEW Desktop acceptance for task placement
and native controls; this batch does not promote unverified candidates.
See the [Batch 7 harness](../tests/fixtures/batch7-harness.md) for host-field,
provider-boundary and live rendering checks.

## Steer v2 coordinator outcomes (R5 first slice)

CLI 2.1.302 queues native sends until the next child tool round; its inbox
drain raises `session.receive` before materializing a `queued_command`. A long
Codex step can block both events. The SendMessage wrapper instead binds the
persisted parent assistant UUID/tool ID to the successful native result pin,
then routes immediately for an active owned run. A settled steer-ack pull can
emit the guarded receipt card without waiting for another Codex action. The
later native copy is consumed, or its appended child UUID is reconciled to
the existing operation. Unscoped append-only deliveries retain the 1.1 path.
Per-target send order and source/tool IDs identify operations; text only
checks integrity. Parallel tool blocks may share a row UUID. No payload
marker, transcript rewrite or second native send is used.

The exact owned `coordinator_message` ToolUse ID retains its literal body and
subscribes to the declared `codex-mod.messageStatus` state family. A later
outcome publishes state and invalidates `ui.render`. Private cache checkpoints
restore bodies, UUIDs and outcomes after reload, with bounded metadata in the
host store; hydration restores presentation, never executable guard answers.
Plain receipt results, literal text/status and `↪` notes remain export/replay
fallbacks until NEW Desktop validation passes.

Status distinguishes received/pending, accepted into the matching RPC turn,
observed correlated input (when emitted), queued after a turn, rejected with
the actual error, and uncertain. Accepted/observed do not claim obedience or
that a pending tool stopped. Failed-steer details remain on a queued outcome.
Unknown submissions never become automatic follow-up launches.

The coordinator learns known outcomes through additive model-only SendMessage
`context`, preserving the native result. Later outcomes use the registered
`codex_message_status` read-only contract (`targetAgentId`, `messageId`), which
also accepts source UUID or sender tool-use ID. A card redraw cannot update
an earlier model result. Query calls refuse child/synthetic callers and never
send, append, wake or execute a Codex action. HTTP responses are finite and
bounded; stdout keeps the existing per-step ownership. See the [steer v2
harness](../tests/fixtures/steer-v2-harness.md) for host ordering and live gates.
