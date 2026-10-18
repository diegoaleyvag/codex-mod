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
- **deferred**: possible, but it would touch shared state or run something real; not drawn.
- **out of reach**: Claude Code has no fitting surface, or drawing it would be misleading.

## Map

| Codex item (exec / app-server) | Codex CLI shows | Codex app shows | Closest Claude Code row | Status | Fields used |
|---|---|---|---|---|---|
| `agent_message` / `agentMessage` | Assistant text | Assistant message; commentary between tools | Text block; the last one is the handback; app-server commentary is text between rows | mapped (commentary: 1.2) | `text`; app-server also has `phase` (commentary, final_answer) |
| `command_execution` / `commandExecution` | "Running" / "Ran" cell; read/list/search commands grouped under "Exploring" | "Running {command}" / "Ran {command}"; shell block with cwd, output and copy buttons; groups read as "Ran commands", "Read files" | `Bash` row | mapped | `command`, `aggregated_output`, `exit_code`; app-server adds `commandActions`, `cwd`, `durationMs` |
| `file_change` / `fileChange` | "Added" / "Edited" / "Deleted" with a diff | "Editing/Edited", "Creating/Created", "Deleting/Deleted" per file, a diff toggle, +/- counts | `Edit` / `Write` rows (deletes as a `Bash` note) | mapped | `changes[].path`, `kind`; app-server adds a per-file `diff` |
| `reasoning` / `reasoning` | Status header from the summary; summary in dim text | "Thinking" while it streams, then "Thought for {time}", collapsed by default | `thinking` stream chunk (summary only) | 1.2 | `summary[]` (app-server deltas: `summaryTextDelta`, `summaryPartAdded`); the exec item `text` |
| `todo_list` (exec) / `turn/plan/updated` notification | "Updated Plan" with a checklist | Progress ring plus current step, "Step n / m" | Display-only `codex_plan` row (`TodoWrite` deferred) | 1.2 | `items[{text, completed}]` (exec); `plan[{step, status}]`, `explanation` |
| — / `plan` (plan mode) | "Proposed Plan" block | "Plan" card ("Writing plan" while it streams), expandable | Text block headed "Proposed plan:" | 1.2 | `text` |
| `web_search` / `webSearch` | "Searching the web" / "Searched the web"; opening and finding in pages | "Searching the web" -> "Searched the web for {query}" | `WebSearch` row answered by the guard | 1.2 | `query`, `action` (search, openPage, findInPage), `results` |
| `mcp_tool_call` / `mcpToolCall` | "Calling" / "Called" plus tool and result | Connector-specific verb or generic tool row; result blocks; raw `server.tool` output | Display-only `codex_tool` row | 1.2 | `server`, `tool`, `arguments`, `result.content`, `error.message`, `status` |
| — / `dynamicToolCall` | Tool call cell | "{toolName}" row | Display-only `codex_tool` row | 1.2 | `namespace`, `tool`, `arguments`, `contentItems`, `success` |
| `collab_tool_call` / `collabAgentToolCall` | "Spawned", "Sent input to", "Waiting for agents", agent states | "Created {agent} with the instructions…", "Messaged", "Closed"; wait calls hidden; Subagents panel | Note line (never an `Agent` row); wait calls skipped | 1.2 | `tool`, `prompt`, `receiver_thread_ids`, `agents_states`, `status`, `model` |
| — / `subAgentActivity` | (agent status lines) | "{name} finished", "Sent message to {agent}" | Note line | 1.2 | `kind`, `agentPath`, `model` |
| — / `imageView` | "Viewed image" | "Viewed an image" with preview | Nothing (a `Read` row would really run) | deferred | `path` |
| — / `imageGeneration` | "Generated an image" | Generated image in a gallery | Dim note line with `savedPath` | 1.2 (note only) | `status`, `revisedPrompt`, `savedPath` |
| — / `contextCompaction` | "Compacted context" | "Compacting context" -> "Context automatically compacted" | Dim note line | 1.2 |  — |
| — / `enteredReviewMode`, `exitedReviewMode` | "Entered/Exited review mode" | "Review mode" | Dim note line | 1.2 | `review` |
| — / `sleep` | (wait cell) | Wait row | Dim note line | 1.2 | `durationMs` |
| `error` item (exec) | Warning | — | Debug log only | mapped | `message` |
| — / `userMessage`, `hookPrompt`, `functionCallOutput` | Input echo / internal | Input echo / internal | Nothing (Claude Code already shows the prompt) | out of reach (not needed) | — |

Exec only emits eight item types (`agent_message`, `reasoning`, `command_execution`,
`file_change`, `mcp_tool_call`, `web_search`, `todo_list`, `collab_tool_call`) plus `error`.
Every other row in the table needs the `app-server` transport.

## How 1.2 draws them

- **Reasoning summary -> `thinking` chunks.** Only the summary text, never raw reasoning, and only
  within the existing step pacing. Claude Code shows hook-made thinking live but does not record it,
  so it is missing from the saved transcript. Many runs send no summary at all.
- **Web search -> `WebSearch` row.** Input `{ query }` (for `openPage` the URL, for `findInPage`
  `<pattern> in <url>`), from the completed item only (the started exec item has an empty query).
  The guard answers with Codex's results when they parse, else "Searched by Codex". `WebSearch` is
  in every Codex agent's tools and is covered by both guards like Bash/Edit/Write: a codex-mod
  agent's search row never reaches a real search, and a guard failure denies.
- **MCP and dynamic tool calls -> display-only `codex_tool`.** Registered by the plugin (full name
  `mcp__codex-mod__codex_tool`), input `{ server, name, arguments }`, answered only by the guard
  with Codex's result text (an error result is marked as one). Real `mcp__<server>__<tool>` names are
  never emitted. Any call without the plugin's id, including one from the main model, is refused and
  does nothing. Input keys avoid the hook envelope's reserved keys (`tool`, `tool_use_id`).
- **Plan updates -> display-only `codex_plan`.** Input `{ explanation?, steps: [{ step, status }] }`.
  `TodoWrite`, `TaskCreate` and `TaskUpdate` are never used: they feed or change Claude's own task list.
- **Proposed plan** (`plan` item) -> a text block headed "Proposed plan:".
- **Sub-agents** -> one-line notes ("Codex spawned an agent: ...", "Codex messaged ...",
  "Codex agent ... finished"); wait calls are skipped, as the Codex app does. Never `Agent` rows.
- **Commentary** (app-server `agentMessage` with phase `commentary`) -> text between rows; the final
  answer is still the handback.
- **Compaction, review mode, sleep, image generation** -> one dim note line each.
- **Image view** -> not drawn (deferred): a `Read` row would really read the file.
- With `nativeActions: false`, every new item becomes a plain text line, like commands and edits.
- If the display tools cannot be registered, their rows fall back to text lines.

## Not possible (or not worth it)

- Native rows for tools that are not in the agent's own `tools` list: the engine refuses them
  before any hook answers.
- Real `Agent`, `TaskCreate`/`TaskUpdate`, or real MCP rows without real side effects.
- Recorded thinking: only the engine's signed thinking blocks are kept in the transcript.
- Exec-only sessions cannot show plans, dynamic tools, sub-agent activity, image views,
  compaction or review mode. Codex does not emit them there.
- Exact Codex wording and layout: Claude Code draws its own rows. A `ui.render` hook can
  relabel a row, but how faithfully Desktop draws custom trees is not verified.
- Glob/Grep rows (for Codex's read/search commands) are not proposed: this build has no typed
  result for them, and splitting one shell command into several rows would misreport what ran.
