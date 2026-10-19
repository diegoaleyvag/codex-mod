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
| `reasoning` / `reasoning` | Status header from the summary; summary in dim text | "Thinking" while it streams, then "Thought for {time}", collapsed by default | `thinking` stream chunk (summary only) | 1.2 | `summary[]` (app-server deltas: `summaryTextDelta`, `summaryPartAdded`); the exec item `text` |
| `todo_list` (exec) / `turn/plan/updated` notification | "Updated Plan" with a checklist | Progress ring plus current step, "Step n / m" | Display-only `codex_plan` row; guarded `TodoWrite` with `richRows` when admitted | 1.2 | `items[{text, completed}]` (exec); `plan[{step, status}]`, `explanation` |
| — / `plan` (plan mode) | "Proposed Plan" block | "Plan" card ("Writing plan" while it streams), expandable | Text block headed "Proposed plan:" | 1.2 | `text` |
| `web_search` / `webSearch` | "Searching the web" / "Searched the web"; opening and finding in pages | "Searching the web" -> "Searched the web for {query}" | `WebSearch` row answered by the guard | 1.2 | `query`, `action` (search, openPage, findInPage), `results` |
| `mcp_tool_call` / `mcpToolCall` | "Calling" / "Called" plus tool and result | Connector-specific verb or generic tool row; result blocks; raw `server.tool` output | Display-only `codex_tool` row | 1.2 | `server`, `tool`, `arguments`, `result.content`, `error.message`, `status` |
| — / `dynamicToolCall` | Tool call cell | "{toolName}" row | Display-only `codex_tool` row | 1.2 | `namespace`, `tool`, `arguments`, `contentItems`, `success` |
| `collab_tool_call` / `collabAgentToolCall` | "Spawned", "Sent input to", "Waiting for agents", agent states | "Created {agent} with the instructions…", "Messaged", "Closed"; wait calls hidden; Subagents panel | Note line; guarded completed `Agent` for spawns with `richRows` when admitted; wait calls skipped | 1.2 | `tool`, `prompt`, `receiver_thread_ids`, `agents_states`, `status`, `model` |
| — / `subAgentActivity` | (agent status lines) | "{name} finished", "Sent message to {agent}" | Note line | 1.2 | `kind`, `agentPath`, `model` |
| — / `imageView` | "Viewed image" | "Viewed an image" with preview | Nothing; source retained, guarded image adapter deferred | deferred | `path` |
| — / `imageGeneration` | "Generated an image" | Generated image in a gallery | Dim note line with `savedPath` | 1.2 (note only) | `status`, `revisedPrompt`, `savedPath` |
| — / `contextCompaction` | "Compacted context" | "Compacting context" -> "Context automatically compacted" | Dim note line | 1.2 |  — |
| — / `enteredReviewMode`, `exitedReviewMode` | "Entered/Exited review mode" | "Review mode" | Dim note line | 1.2 | `review` |
| — / `sleep` | (wait cell) | Wait row | Dim note line | 1.2 | `durationMs` |
| `error` item (exec) | Warning | — | Retained source warning; does not fail the turn | mapped | `message` |
| — / `userMessage`, `hookPrompt`, `functionCallOutput` | Input echo / internal | Input echo / internal | Nothing (Claude Code already shows the prompt) | out of reach (not needed) | — |

Exec only emits eight item types (`agent_message`, `reasoning`, `command_execution`,
`file_change`, `mcp_tool_call`, `web_search`, `todo_list`, `collab_tool_call`) plus `error`.
Every other row in the table needs the `app-server` transport.

## How 1.2 draws them

- **Reasoning summary -> `thinking` chunks.** Only the summary text, never raw reasoning, and only
  within the existing step pacing. Claude Code shows hook-made thinking live but does not record it,
  so it is missing from the saved transcript. Many runs send no summary at all.
- **Web search -> `WebSearch` row.** Input `{ query, mode: 'standard' }` (for `openPage` the URL, for `findInPage`
  `<pattern> in <url>`), from the completed item only (the started exec item has an empty query).
  The guard answers with Codex's results when they parse, else "Searched by Codex". `WebSearch` is
  included only when available in the Codex agent's tools and is covered by both guards like Bash/Edit/Write: a codex-mod
  agent's search row never reaches a real search, and a guard failure denies.
- **MCP and dynamic tool calls -> display-only `codex_tool`.** Registered by the plugin (full name
  `mcp__codex-mod__codex_tool`), input `{ server, name, arguments }`, answered only by the guard
  with a content-block array of Codex's result text (failures use `deny`). Real `mcp__<server>__<tool>` names are
  never emitted. Any call without the plugin's id, including one from the main model, is refused and
  does nothing. Input keys avoid the hook envelope's reserved keys (`tool`, `tool_use_id`).
- **Plan updates -> display-only `codex_plan`.** Input `{ explanation?, steps: [{ step, status }] }`.
  `richRows` selects guarded `TodoWrite` when admitted, without executing its mutation. `TaskCreate`/`TaskUpdate` adapters remain deferred.
- **Proposed plan** (`plan` item) -> a text block headed "Proposed plan:".
- **Sub-agents** -> one-line notes ("Codex spawned an agent: ...", "Codex messaged ...",
  "Codex agent ... finished"); wait calls are skipped, as the Codex app does. With `richRows`, admitted completed spawn rows use guarded `Agent`.
- **Commentary** (app-server `agentMessage` with phase `commentary`) -> text between rows; the final
  answer is still the handback.
- **Compaction, review mode, sleep, image generation** -> one dim note line each.
- **Image view** -> not drawn (deferred): the source path is retained; the guarded image-result adapter is not implemented.
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
