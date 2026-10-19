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
| — / `subAgentActivity` | (agent status lines) | "{name} finished", "Sent message to {agent}" | Deduplicated lifecycle text; no extra spawn or mirror | 1.2 | `kind`, full `agentThreadId`, `agentPath`, `model`, `reasoningEffort` |
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
- **Codex child operations** -> guarded completed Agent for successful completed spawn calls, denial for failed/declined spawns. Reports distinguish spawn completion from child status, disclose unreported metrics, use synthetic IDs and disable continuation. Full message bodies map to admitted SendMessage with the probed `{status,agentsStates}` acknowledgement object; null fails the real mapper despite its unknown declaration. Close/interrupt map to admitted TaskStop `{message,task_id,task_type:"codex"}`. Resume/list, missing facts/tools and ambiguous targets use full codex_tool; registration failure retains text. Waits show only changed child state/report (reported duration when present); subAgentActivity is deduplicated against known operation state. Durable child identities retain full source IDs/path/model/effort; no real host mirror or child task exists.
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
