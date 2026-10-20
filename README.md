# codex-mod

[![CI](https://github.com/diegoaleyvag/codex-mod/actions/workflows/ci.yml/badge.svg)](https://github.com/diegoaleyvag/codex-mod/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Version 1.2.1](https://img.shields.io/badge/version-1.2.1-informational.svg)](CHANGELOG.md)

codex-mod is a Claude Code plugin (a "mod", built on the early-access plugin hooks-module API) that adds subagent types answered by the OpenAI Codex CLI running on your machine instead of an Anthropic model. Claude stays the orchestrator and delegates self-contained tasks to `codex exec --json`, using your own ChatGPT/Codex login. Codex's commands and file changes show up in the transcript as ordinary Bash, Edit and Write rows, and its final answer comes back like any other subagent report.

![Codex agent steered mid-turn in Claude Code Desktop: the agent panel shows its commands, the "↪ steer delivered to Codex mid-turn" note and the footer with app-server · 1 steer](docs/demo.gif)

*Claude delegates to a Codex agent (gpt-6-luna, low), then sends it a change of plan while it works; Codex picks it up mid-turn.*

## What's new in 1.2.1

- Explicit working directories, registered-worktree validation and owner grants
  for network, writable roots, sandbox and approval modes, pinned across resumes.
- Opt-in Codex automatic review, manual controls and delegation to the immediate
  Claude parent. Experimental controls and their host limits are listed under
  [Execution policy](#execution-policy-and-working-directories).
- More useful deterministic command titles and optional completion archiving
  that preserves history and same-thread follow-ups.
- CI coverage for runner, approval, execution-policy and recovery helpers.

### Included from 1.2

- **More faithful action rows:** reads, searches, file changes, web results and
  plans use native rows when source evidence and host admission permit them,
  with full-text fallbacks and conservative compound-command labels.
- **Model and effort selection:** choose a registered model type or declare
  project roles; titles identify the executing Codex model and effort.
- **Steering and child lifecycle:** correlated delivery outcomes, existing-child
  observation without rerunning its work, bounded retries and honest fallbacks.
- **Recovery and accounting:** bounded presentation caches, segmented child
  journals, exact launch identities, direct/tree usage and one same-thread
  capacity fallback when configured.

Desktop acceptance is partial. Native Read/Write/Edit, model/effort titles,
delivered steering and a real parent/helper completion were observed. The
Coordinator receipt preserves full text and accepted-turn status, but its
custom card and live redraw remain unaccepted. The host may still label a
Codex child as Haiku. Interactive questions, native task placement and some
expanded/reopened rows also need live checks. `richRows` stays off by default;
`app-server` remains opt-in. See the [verification record](docs/codex-ui-map.md#desktop-followup-verification-2026-10-19).

### Upgrading from 1.1

The built-in `sol`, `sol-high` and `astra-audit` types were removed. Replace
them with [project roles](#roles-per-project), or use `codex-mod:codex` with
`codex-model:` and `codex-effort:` prompt lines. The former `roles` option is
ignored with a warning. Existing Codex login and plugin options are retained.
Finish active work and start a fresh session after updating; Desktop hooks
may require quitting and reopening the application.

## How it works

```
Claude (orchestrator)
   |  Agent(subagent_type = "codex-mod:codex", prompt)
   v
turn.step hook  --- never calls the model: no Anthropic request ---
   |  starts: codex exec --json   (task on stdin, thread resumed on follow-ups)
   v
Codex events --> native Bash / Edit / Write rows (answered by a tool.call hook,
                 never executed by Claude) --> final answer via SubagentHandback
```

- **Agent types.** Registered at session start from Codex's own model list (`models_cache.json`), so they exist only while the plugin is loaded.
- **`turn.step`.** Each model request of a codex-mod agent passes through a streaming hook that answers it from Codex's output. No Anthropic request is made for the agent's work.
- **Native rows.** Each finished Codex command or file change is drawn as a `Bash`, `Edit` or `Write` call, with Codex's interim remarks as text.
- **`tool.call` guard.** Those calls carry a reserved id prefix and are answered from the result Codex already reported. They are never executed by Claude.
- **Handback.** The final answer is delivered once through `SubagentHandback`, followed by a footer line.
- **Resume.** Each agent keeps its Codex thread, so follow-ups continue the same conversation.
- **Transport.** By default Codex runs through `codex exec --json`. The opt-in `app-server` transport adds mid-turn messages and stop (see [Transports](#transports)).

### What Codex work looks like

Exploration adapters accept agent commands marked `agent` or `unifiedExecStartup`.
User-shell commands and later unified-exec interactions retain Bash rows. Compound
and conditional Bash descriptions summarize the whole command conservatively;
the original command and output stay intact.

Commands normally appear as Bash rows. With `app-server`, a single faithful read, file listing or search can appear as Read, Glob or Grep when Codex reports a matching `commandActions` entry. A literal command parser admits whole `cat` reads, `head`/`tail` slices whose output establishes the file total, file-only NUL-delimited `find`/`rg --files` listings, and framed ripgrep content/files/match-count searches. Fixed strings are escaped into equivalent regexes. The original command and cwd appear beside each translated row; results come from Codex's output without another read, search or shell run.

Pipelines, multiple actions, redirects, substitutions, unknown slice totals, directory listings, ambiguous filenames/output and unsupported options keep one Bash row. Normal `exec` output has no command actions and stays Bash. A streamed command and its polls produce one final row. Read/Glob/Grep are admitted in each Codex agent's own tools and protected by both guards and their refusing catches, including the placeholder agent's Read; ordinary main-thread and verified Claude subagent calls pass unchanged. An unavailable exploration tool falls back to Bash when admitted. Results retain the delivered output, including CRLF and trailing newlines; already truncated output stays Bash. An unreported Glob duration is disclosed as a 0 ms display sentinel.

File additions use Write only with complete exact content. Updates use Edit only when the source diff applies to a captured base and matches stable completion reads; several bounded exact hunks can produce ordered Edit rows. Other patches use Bash’s typed patch diff with a display-comment input, including deletion flags and both move paths when images are verified. Missing facts retain the literal reported diff. Failed/declined or unconfirmed patches use error rows; they never imply successful writes. Each source patch counts once, separately from its file/hunk rows. Plan updates use `codex_plan`. These rows show work Codex already did and never execute a Claude action tool. Main-list UI isolation additionally depends on the host retaining child scope; see the Batch 5 live checks below. Grep content decodes ripgrep's JSON into matching/context lines with reported paths and requested line numbers; raw JSON remains in the source record. Count mode requires actual regex-match counts (`--count-matches`), rather than treating matching-line counts as match totals. Empty no-match searches succeed; actual failures keep Bash error rows. Desktop grouping and expanded-row appearance still need a new-session live check.

Messages received from the coordinator appear in the Codex subagent view as display-only `coordinator_message` rows with the full original text, including override lines. Where the host dispatches the custom renderer, a **Coordinator** card shows the message first, its delivery status below, and full message/turn identifiers in dimmed details. Status distinguishes received, accepted into a specific turn, observed in Codex input, queued after a turn, rejected with the reason, and uncertain. Source UUIDs prevent repeat display after a worker restart; messages over 90,000 characters split into numbered parts. With `nativeActions: false`, or if tool registration fails, they appear as text headed "Coordinator message:". Acceptance confirms the RPC response, not that the model read or followed the instruction. Literal receipt/status text and `↪` notes remain as fallbacks. Reopened rows can restore their literal full-body rendering before tool registration; nonlegacy names require a matching session, cached row owner, exact tool name/ID and received receipt. Text fallback fences markup so tags and Markdown stay visible. New-session Desktop tests with bundled CLI 2.1.299 confirmed literal receipt, accepted-turn status and delivered steering, but showed generic tool details; custom-card paint and live redraw are not accepted on that host.

Experimental `richRows: true` prefers TodoWrite for plans when admitted, then the paired TaskCreate/TaskUpdate tools, then `codex_plan`. TodoWrite is disabled in the tested host; Task* admission depends on the host/model. The plugin keeps per-agent/thread snapshots and synthetic `codex-plan-…` IDs across restarts/resume, matching exact text occurrences and explicitly removing/creating ambiguous reordered or renamed steps. Native task rows acknowledge this display registry only: no host tasks, assignments, dependencies or hooks execute. The fallback includes the full checklist and explanation in input, result and an owned checkbox card.

With `richRows`, completed Codex spawn operations use completed Agent results; the child can still be running or unknown. Failed/declined spawns produce errors without a completed-child result. A synthetic `codex-display-…` ID offers no continuation, host task or child transcript. Full child messages can use guarded SendMessage with Codex's status/state acknowledgement; close/interrupt can use TaskStop with `task_type:codex`. Missing tools, ambiguous targets or missing facts use `codex_tool`, then full text if registration fails. Resume/list use `codex_tool`; wait polls produce no rows, only meaningful state/report transitions. Child identity/model/effort and plan state persist as groundwork for later mirrors; no mirror is launched.

Claude Code 2.1.302 accepted guarded TaskCreate/TaskUpdate (with supported model admission), TaskStop and SendMessage acknowledgement objects in an offline headless probe. SendMessage's declared `unknown` result still rejects `null` in its mapper; only the probed status/state object is enabled. Desktop paint, synthetic task-link usefulness, and preservation of child scope on live/reload/resume remain unverified. Follow the exact main-task sentinel check in the [Batch 5 harness](tests/fixtures/batch5-harness.md) in a NEW Desktop session after plugin reload. If a native candidate changes the main derived list or offers broken host-task controls, use `richRows:false` for the display fallback and record that result.

Completed web searches use WebSearch with the actual query (all queries in order for multi-query actions), source URLs/snippets and textual or opaque results. Empty results stay empty. Durations come from source timing; an unreported duration uses an explicitly disclosed zero sentinel. Opening a page or finding a pattern uses WebFetch only when Codex reports the URL, bytes, HTTP code/text, extracted text and duration. HTTP failures retain their real code; transport failures use error rows. Missing metadata and other web actions use `codex_tool` with the exact action name and original results.

MCP and dynamic calls use `codex_tool` with nested arguments, full text, structured results and readable media metadata; encoded media stays in the owned source record. Errors remain errors. Canonical external tool substitution is blocked on Claude Code 2.1.302: `$.tool.list()` returns only name, description and MCP status, without input schemas or original server identity, and MCP replacement results have no declared universal contract. Matching names alone cannot establish the matrix's identity/schema binding. The plugin neither guesses that binding nor replays a tool to discover it. See the [Batch 4 harness](tests/fixtures/batch4-harness.md) for the offline MCP server, source evidence and remaining host acceptance checks.

Native rows are admitted only when the tool is available and included in that Codex agent's own tools. An unavailable tool falls back to `codex_tool`, or attributed text when registration also fails. Results are checked against the supported native shapes before emission and again before answering; failed or declined operations return a native denial with Codex's actual report. Bash results retain the full combined output, including trailing newlines; an unreported exit stays unknown.

The latest run's public source records and row provenance are retained in its agent record under the existing `pruneDays` policy. These include source IDs, command actions/cwd/process/status/timing, exact patch kinds/moves/diffs, tool and web results, child models/states, image/review/failure data and notifications, including unsupported variants. Repeated item completions produce one row; aggregate turn diffs and terminal interactions are retained without extra action rows. Private reasoning content is excluded. This foundation preserves evidence for later native mappings; it does not add new visual mappings.

Image views use guarded Read image results with actual PNG/JPEG/GIF/WebP bytes obtained through the plugin filesystem API, bounded to 4 MiB and checked for file changes during capture. The accompanying text identifies a later file preview: it cannot establish the exact bytes Codex saw earlier. Missing, changing, oversized, unsupported images or absent Read admission get an explicit preview-unavailable report. Image generation keeps its status, revised prompt, reported result and failure in `codex_tool`; a real saved output can add a Read preview, without counting generation twice. Result URLs are never fetched for display.

Reasoning summaries appear as best-effort live thinking, absent from reopened native thinking history; raw reasoning content never crosses the wire. Summary streaming remains opted out; completed public summaries use existing step pacing. Commentary, partial answers, proposed plans and full review-mode text appear separately and cannot become the final handback. Actual complete structured findings can use guarded ReportFindings with `richRows`; review prose is never parsed into invented findings. Warnings do not fail the turn, compaction notices deduplicate against their source item, and sleep reports elapsed time without scheduling anything.

With `app-server`, `nativeActions:true` and `lean:false`, explicit non-secret choice questions (1–4 questions, 2–4 options each, short headers, no Other/free-text option) use an owned `codex_question` card. Select answers and press **Send selected answers**, or **Cancel question**. Only that explicit action sends a bound, one-time RPC response; card receipt is neither answer nor approval. An acknowledged answer can add an admitted AskUserQuestion reported-answer row with `richRows`. Unavailable question UI, unsupported shapes and exec questions get explicit unsupported errors. Permission approvals remain disabled by default; the owner-granted approval modes are described under [Execution policy](#execution-policy-and-working-directories). Ended, resolved, restarted and stale requests cannot be answered by old controls. Headless `-p` has no human controls, so use the interactive/Desktop harness for pending questions.

`nativeActions:false` shows attributed text and disables interactive question requests. The offline host probe accepted Read image and ReportFindings results without executor calls or inference; AskUserQuestion was unavailable in that noninteractive host. See the [Batch 6 harness](tests/fixtures/batch6-harness.md) and [Codex UI map](docs/codex-ui-map.md) for contracts, coverage and remaining Desktop checks.

## Requirements

- Claude Code with plugin hooks-module (mod) support. Verified on Claude Code Desktop, CLI 2.1.299 to 2.1.302.
- Auto mode, so the host offers `SubagentHandback`. Outside it, the answer is delivered as plain text after one extra step.
- The Codex CLI, installed and logged in (`codex login`). The plugin looks for it on `PATH`, then in common install locations (Homebrew, `~/.local/bin`, bun and volta global bins, the ChatGPT and Codex desktop apps), or uses the `codexPath` option.

## Install

From GitHub:

```bash
claude plugin marketplace add diegoaleyvag/codex-mod
claude plugin install codex-mod@codex-mod --scope user
```

From a local clone:

```bash
claude plugin marketplace add /path/to/codex-mod
claude plugin install codex-mod@codex-mod --scope user
```

Start a new session afterwards: agent types are registered at session start.

For local development, a directory marketplace can execute the clone directly;
the versioned `installed_plugins.json` cache path alone does not identify the
loaded source. After hooks-module edits, finish active work, quit and reopen
Desktop, then test in a new session. A new chat or `/reload-plugins` alone did
not load the changed diagnostic module in the tested Desktop setup.

Update:

```bash
claude plugin marketplace update codex-mod
claude plugin update codex-mod@codex-mod --scope user
```

Uninstall:

```bash
claude plugin uninstall codex-mod@codex-mod --scope user
claude plugin marketplace remove codex-mod
```

## Usage

Ask Claude to delegate, or name the agent directly:

```
Use codex-mod:codex to add input validation to src/api.ts. Allowed paths: src/. Verify with `npm test`. Report the diff summary.

Use codex-mod:auditor (declared below) to review the diff of branch feature/x against main. Report findings only.
```

Codex sees only the prompt and the repository's `AGENTS.md`, so the prompt must carry the whole task: branch, allowed paths, how to verify, what to report.

### Choosing model and effort

Choose a catalog model directly with an Agent type such as
`codex-mod:gpt-6-1-sol` on the current host, or use `codex-mod:codex` with your configured defaults.
With `modelAgents:true` (the default), session start registers one type per
model with `visibility:list` in Codex's `models_cache.json`; its description
lists supported reasoning efforts. The plugin first tries the exact slug;
Claude Code 2.1.302 rejects dots in type names, so it logs a fallback with
punctuation replaced by hyphens (`gpt-6.1-sol` → `gpt-6-1-sol`). The Codex
model ID stays exact. Project roles also win collisions with these aliases.
These types use the model's catalog effort
default and `defaultSandbox`. If the catalog is unreadable, only the generic
agent and project roles are offered. Project roles win name collisions.

The coordinator can pass the native Agent `effort` parameter:

```json
{"subagent_type":"codex-mod:gpt-6-1-sol","effort":"high","description":"Check validation","prompt":"Review src/api.ts. Allowed paths: none. Report findings."}
```

Effort precedence is **prompt `codex-effort:` > Agent `effort` > role/model-type/generic
default**. Native effort is validated against the resolved Codex model. An
unsupported native value uses the agent's default (or that model's supported
catalog default if necessary), with a visible note. The current host exposes
Agent input `effort` to `tool.call` but omits it from `agent.spawn`; codex-mod
binds the input by the real tool-use ID and also detects a future spawn
`effort` field. If neither surface supplies it, defaults apply. The debug log
records `spawn.effort` and `Agent.effort`; see the [Batch 7 harness](tests/fixtures/batch7-harness.md).

[Project roles](#roles-per-project) provide named model, effort, sandbox and
instruction defaults. Leading prompt lines remain the portable fallback,
including efforts the host's Agent schema cannot spell (such as `ultra`):

```
codex-model: gpt-6-luna
codex-effort: low
Summarise what src/index.ts exports.
```

Prompt overrides stick for follow-ups. An unknown model or unsupported
**prompt-line** effort fails with a clear error before any Codex launch.

Launch titles read `Codex <model> · <effort> · <description>` for owned
codex-mod spawns. The parent Agent row adds current model/effort text alongside
the original native row, preserving its controls, status and navigation. The
row and answer footer follow later model changes; the title records the
launch choice. Resume/workflow titles are fixed by the host. Missing ownership
or render failures retain the native row.

The native model badge cannot display arbitrary GPT IDs: it may still show
**Haiku**, the unused Claude execution placeholder. codex-mod keeps registered
agents on `haiku`; putting a GPT ID there can change provider model selection.
Titles, added row text and footers are the supported model visibility sites.

Follow-ups go through `SendMessage` to the same agent and resume its Codex thread. A message sent while the agent is still running is delivered too, according to the transport (see [Transports](#transports)).

Each answer ends with a footer, for example:

```
codex · gpt-6-luna · low · workspace-write · 3 actions · 37.4K new tokens (154K cached, 631 out) · thread 01a14f50
```

It shows the agent, model, effort, sandbox, number of actions, Codex's token counts (new, cached, output) and the Codex thread id. With the `app-server` transport it also shows `app-server` and, when any were delivered, `N steer(s)`. Failures are never silent: the answer starts with `codex failed: <reason>` followed by the last lines of Codex's stderr.

## Roles per project

`codex-mod:codex` is always available. Its defaults come from `defaultModel` (empty: first model Codex lists), `defaultEffort` and `defaultSandbox`. Projects can declare additional roles in `.claude/codex-mod.json`, relative to the session's working directory:

```json
{"roles": {
  "implementer": {"model": "gpt-6.1-sol", "effort": "medium", "sandbox": "workspace-write", "description": "Normal bounded coding task; the prompt carries the full spec (branch, allowed paths, verification command, report format)."},
  "implementer-high": {"model": "gpt-6.1-sol", "effort": "xhigh", "sandbox": "workspace-write", "description": "High-risk work or a retry after a failed attempt."},
  "auditor": {"model": "gpt-6-astra", "effort": "low", "sandbox": "read-only", "description": "One read-only cross-model review of a whole change.", "instructions": "You are a read-only auditor. Never edit files. Report findings with file:line and a failure scenario."}
}}
```

This registers `codex-mod:implementer`, `codex-mod:implementer-high` and `codex-mod:auditor` when their profiles are available. There are no built-in role agents in 1.2; this example replaces the former `sol`, `sol-high` and `astra-audit` roles.

- The file must be an object with a `roles` object. Each role requires string `model`, `effort` and `description` fields; model and effort must be nonempty. `sandbox` defaults to `workspace-write`; `instructions` is an optional string.
- Names must match `^[a-z][a-z0-9-]{0,31}$` and cannot be `codex`. Only the first 16 entries are considered. Descriptions are limited to 600 characters and instructions to 2000. Invalid roles are skipped with debug warnings; unknown keys are ignored with debug warnings.
- Sandboxes are `read-only`, `workspace-write` or `danger-full-access`. Repository files may be untrusted: `danger-full-access` roles are refused unless you enable the user-level `allowProjectFullAccess` option (default `false`). A file cannot opt itself in.
- A role whose model or effort is absent from Codex's `models_cache.json` is skipped with a debug message. If the catalog cannot be read, profiles are not validated, as before. Agent descriptions list the available models when known.
- A missing file silently leaves only the generic agent. Malformed JSON or a wrong file shape produces a debug message and one user-visible notice per session; the generic agent remains available. Set `projectRoles: false` to skip reading the file entirely.

Roles load at session start (and again if agent registration must be retried). Start a new session after editing the file; a cwd change mid-session does not reload it. Running agents retain the model, effort and sandbox in their records even if their role disappears. The first launch saves the role instructions, resolved override map, real/shadow Codex home identity, and an effective-config fingerprint in the agent record. Follow-ups and live steers keep that snapshot, including after a role is removed or the hooks worker restarts. Legacy threads without a snapshot adopt the current bounded policy with an unknown-baseline note. Model/effort overrides still work; their footer warns that a follow-up may start cold. Host-store metadata remains bounded to 32 Ki characters per record; larger snapshots recover from the private run cache.

Role instructions are prepended to the task with a blank line on first runs, resumed runs, follow-ups and live steers, after prompt override lines are removed. They are never added to rendered action rows, delivery notes or footers.

### Role capabilities and cache continuity

Roles accept optional `lean` (boolean), `capabilities` and `fallbackModels`.
Omitted `lean` inherits the global preset. Capability keys are:

| Key | Values | Lean default |
| --- | --- | --- |
| `webSearch` | `"disabled"`, `"cached"`, `"live"` | disabled |
| `mcpServers` | Up to 32 unique configured bare server names | none |
| `multiAgent` | boolean | false |
| `skillsInstructions`, `apps`, `plugins` | booleans | false |
| `images` | boolean, image generation | false |

Rich roles preserve the user's baseline when a capability is omitted. An empty
`mcpServers` list disables discovered servers; an empty `fallbackModels` list
disables capacity retries for that role. Lists are bounded to 32 unique entries;
invalid capability types, unknown capability keys and invalid names skip the role.

With global `lean=true`, repository `lean=false` requires the user option
`allowProjectNonLean=true`. Selective expansions instead require user
`projectCapabilityAllowlist` grants, for example `["webSearch:live", "mcp:rea",
"multiAgent"]`. A repository cannot grant itself authority. With global
`lean=false`, roles inherit the user's rich baseline and may restrict it. Explicit
positive capability overrides still need a user grant, so repository settings
cannot turn on a tool independently disabled in the user's Codex config.
Explicit user `extraConfig` overrides win on both transports; a conflicting
lean request is logged as partial. Capabilities are launch presets, not a
security boundary: MCP discovery reads supported bare names from the user's
config.toml and cannot enumerate every layered/project/plugin server. MCP and
app actions can have external effects even with a read-only filesystem sandbox.

For example, a role may request `"lean": true, "capabilities": {"webSearch":
"live", "mcpServers": ["rea"], "multiAgent": false}`. Only the corresponding
user-approved grants expand lean; other optional families remain disabled.

`multiAgent=false` sends `features.multi_agent=false` and prepends **Do not
spawn sub-agents.** to tasks and steers. R6 found no supported universal tool-removal
key: gpt-6.x native v2 can still expose `collaboration.spawn_agent` with feature
flags off. Observed spawns produce a debug log, visible warning and footer note;
real child rows and nested mirrors remain available. This is a behavioral
restriction with detection, not an enforced removal of the spawning tool.
`nestedAgents` controls observation independently; it does not authorize spawning.

Both transports use the same canonical override snapshot. Changes to on-disk
Codex configuration, AGENTS files or the CLI itself can still affect the prompt;
a fingerprint describes plugin-controlled settings, not the full wire context.
No supported history tool-output limit was verified by R6, so codex-mod adds no
speculative limit or display truncation. Bound large searches and command output
at their source. Model compaction defaults and cache routing are unchanged.

### Model capacity fallback

A failed run containing `Selected model is at capacity` may resume its existing
thread once with the first different, visible model in `capacityFallback`
(default `["gpt-6-sol", "gpt-5.6-sol"]`). A role's `fallbackModels` replaces that
list. Unknown/hidden models are skipped; an unreadable catalog or missing thread
prevents retry. The effort is retained when supported, otherwise the model's
supported default (or first supported effort) is used. A visible note says
`gpt-6.1-sol at capacity; continued on gpt-6-sol`. The retry counts as another
launch within `maxRunsPerWindow`, retains the policy and sandbox, and never
tries a second fallback. Other failures do not trigger this recovery.

## Options

Set them in the plugin's config screen or under `pluginConfigs` in settings. An out-of-range value falls back to its default.

| Option | Default | Meaning |
| --- | --- | --- |
| `codexPath` | empty | Absolute path of `codex`. Empty: `PATH`, then common locations. |
| `defaultModel` | empty | Model of `codex-mod:codex`. Empty: first model Codex lists. |
| `defaultEffort` | `medium` | Effort of `codex-mod:codex`; must be supported by the model. |
| `defaultSandbox` | `workspace-write` | `read-only`, `workspace-write` or `danger-full-access`. |
| `modelAgents` | `true` | Register an agent type for each listed Codex model; project roles win name collisions. |
| `projectRoles` | `true` | Load roles from `.claude/codex-mod.json` at session start. Off: do not read the file. |
| `allowProjectFullAccess` | `false` | Allow project roles to request `danger-full-access`. User-level opt-in. |
| `lean` | `true` | Remove optional context/tool families; multi-agent off uses an instruction plus detection, with native v2 limits. |
| `allowProjectNonLean` | `false` | Permit project roles to expand the lean preset. |
| `projectCapabilityAllowlist` | `[]` | Selective user grants such as `webSearch:live`, `mcp:rea`, `multiAgent`. |
| `capacityFallback` | `["gpt-6-sol", "gpt-5.6-sol"]` | Ordered catalog-validated candidates for one same-thread capacity retry. |
| `globalRules` | `true` | Off (experimental): run Codex with a plugin-owned `CODEX_HOME` so your user-level `AGENTS.md` is not loaded. |
| `archiveSessions` | `false` | Archive owned source threads after the Codex process ends; preserve history and same-thread follow-ups. Active or interrupted runs can remain visible. |
| `extraConfig` | none | Raw `key=value` entries passed as `-c` to every launch. `model`, `model_reasoning_effort` and `sandbox_mode` are refused. |
| `handbackMode` | `auto` | `auto`: `SubagentHandback`, plain text only if the tool is not active for the agent. `tool` or `text` force one. |
| `footer` | `full` | `full`, `short` (agent, model, effort) or `off`. |
| `nativeActions` | `true` | Off: actions are plain text lines in one step instead of Bash/Edit/Write rows. |
| `richRows` | `false` | Experimental: guarded Agent spawn, SendMessage and TaskStop rows; plans prefer TodoWrite, then paired TaskCreate/TaskUpdate, then `codex_plan`. All use reported results without execution; `nativeActions: false` shows full text. Desktop scope/paint checks remain pending. |
| `nestedAgents` | `true` | With app-server, create hidden observation agents for existing Codex children, with their own guarded transcript and direct/tree usage. Off: Batch 5 behavior. Attachment and host depth/concurrency refusals retain lifecycle/report rows. |
| `progressIntervalMs` | `1000` | At most one action step per interval (0 to 60000). |
| `maxActionsPerStep` | `10` | Most actions shown in one step (1 to 50). |
| `timeoutMinutes` | `0` | Stop a run after this many minutes and report `codex failed: timeout`. `0`: no limit. |
| `maxRunsPerWindow` | `3` | Launch guard: most launches per agent in 10 minutes (1 to 100). |
| `transport` | `exec` | `exec` (`codex exec --json`, most stable) or `app-server` (experimental, see [Transports](#transports)). |
| `nodePath` | empty | Absolute path of Node (18 or later) for the `app-server` sidecar. Empty: `PATH`, then common locations. |
| `pruneDays` | `2` | Delete stored agent records (thread, model, effort) unused for this many days. |

`archiveSessions: true` runs `codex archive -- <thread UUID>` after an owned
source process has ended, on both transports and app-server's exec fallback.
This removes completed plugin sessions from the normal Codex/Work history
without deleting them. The command uses the same Codex executable and recorded
`CODEX_HOME` as the source run. Authentication, permissions and source metadata
stay unchanged. Mirror observers, unowned threads and records with conflicting source IDs are
never archived; conflicting IDs also disable future unarchive commands for that
record, including after reload.

Follow-ups first try `codex unarchive -- <thread UUID>`, then resume that exact
thread once. The saved archive flag keeps this recovery available after the
option is disabled. Unarchive is best effort: the CLI reports a generic failure
for an already active thread as well as other errors, so the ordinary same-ID
resume checks its state. A history-command failure never starts a replacement
thread or replays work, and an archive failure preserves the answer with a
short notice. Details go to the debug log.

Running sessions can appear in chat lists. Abort, timeout, worker interruption
or process crashes can miss cleanup; archive those sessions manually when they
are no longer running. Older sessions are not scanned or changed by this option.
Real Codex children keep their provenance and are not separately archived by
the source-run cleanup. This is completion cleanup, not guaranteed invisibility.

`handbackMode: "tool"` can lose answers in a session where the host does not offer `SubagentHandback`; keep `auto`.

Nested agents use the parent's app-server connection to rejoin an existing child
with `thread/resume`, without starting a child turn or changing its settings.
The hidden `codex-mod:codex-child` host loop only reads that child's public
journal. The parent Agent link references the actual host agent ID; commands
and changes still use the display guards. CLI 2.1.302 places plugin API spawns
at depth 1 without a parent. There is no supported parent selector, so the
child title says `Codex child of <parent title>` and the parent's observation
link names both host IDs. This provides separate real tasks, not native nesting.
The observer implementation supports two source child generations.
Launch ownership uses the spawning step's recorded parent and a one-time
token/tool ID, including hosts that omit parent/cwd fields from spawn events.
Debug logs retain phase/reason codes and non-secret field summaries for refused
launches, and call/check admissions with their tool ID. Nested re-entry logs
flush when the parent's spawn call settles; prompt tokens are never logged.
Exec, failed rejoin, unavailable history and host admission failures keep the
Batch 5 view and log the reason. A lost mirror or owner is never relaunched
automatically. The host's exact auto-mode no-verdict denial can request one
unchanged observer-launch retry. That retry requires an unconsumed live launch
capability, no created host, and a durable checkpoint retiring the first core
tool ID. A second denial, other refusal or uncertain outcome keeps the fallback;
the plugin never fabricates consent. Native stop targets the exact child and its source descendants;
parent stop also cascades after a hooks-worker restart. A stop request remains
`stopping` until source termination confirms interruption; a killed observer
may retain that pending state until its journal is read again. Running child
messages steer once per source UUID, with acknowledged/rejected/unknown
outcomes. Missing acknowledgements are never retried. Idle or stale messages
are rejected explicitly rather than starting new work.

All Codex agent types register as background subagents, so core can supply
background task status, stop/send controls, description, prompt/report and
progress derived from emitted transcript/tool rows. They do not become separate
Desktop sessions. The public API has no task status/progress-summary setter:
source failure/interruption is explicit in the mirror transcript and saved
state, but a normally ended observer can still have a host Completed badge.
Host-generated one-line progress summaries require `agentProgressSummaries`
and may make an auxiliary `agent_summary` provider request; the plugin does
not enable it or substitute paid API billing. See the
[task/card contract and limits](docs/codex-ui-map.md#agents-and-task-cards-batch-8).

Full footers retain the full thread ID and show direct usage plus `tree` usage when descendants exist. Exec follow-ups subtract the last known cumulative full-thread baseline; duplicate completion totals replace each other. Unknown or interrupted baselines are labeled partial/unknown instead of charging historical totals to the next run. App-server uses response IDs or guarded turn deltas, including final usage arriving after completion. Transport switches share the persisted thread total when available.
Tree counts already include direct usage: never add the two. Exec reports known direct usage as a lower bound with missing descendant usage; app-server adds observed descendants once by source identity. Failed capacity-attempt usage, when known, is shown separately before the resumed launch. Responses and cumulative turn snapshots are deduplicated; cache and reasoning
subtotals are not added twice. Missing observations are labeled partial.
Codex counts stay out of host provider counters. The parent currently waits
for observed children to drain before handing back its final tree snapshot.
Owner-supplied headless results confirm real observer creation, depth 1 with
no parent, and no observed `agent_summary` (only MCP fetch/telemetry Anthropic
traffic). They do not establish Desktop's summary settings. Native Desktop
navigation, controls, progress paint/history and auxiliary summary requests
still need a new-session check using the [Batch 8 harness](tests/fixtures/batch8-harness.md).

To set `transport` from a settings file:

```json
{
  "pluginConfigs": {
    "codex-mod@codex-mod": { "options": { "transport": "app-server" } }
  }
}
```

### Transports

- **`exec`** (default, most stable). Each launch is `codex exec --json`. A message sent to an agent while it runs cannot reach the running turn: it is queued and runs after the turn, resuming the same thread.
- **`app-server`** (opt-in, needs Node 18 or later on `PATH` or `nodePath`). A per-run sidecar, `scripts/codex-runner.mjs`, owns the stdin of `codex app-server` for that run, because the hook cannot keep a child's stdin open. A message you send to a running Codex agent is delivered mid-turn (`turn/steer`), and stopping the agent sends `turn/interrupt`. Codex marks `app-server` as experimental, so its protocol may change.

If Node, the runner or `codex app-server` is unavailable, `approvalMode: "never"` falls back to `exec` and the footer says why. Other approval modes fail before launch; they never lose approval handling through fallback.

The agent's output shows what happened to a message:

```
↪ steer delivered to Codex mid-turn
↪ Codex had already finished; this message runs next, on the same thread
↪ queued: runs after this turn (exec transport has no mid-turn steer)
```

Each app-server run exposes HTTP over a private Unix socket (`0600` inside its `0700` control directory). The host API supports `socketPath`; the hook probes protocol/version and runner generation before sending. Socket creation, path-length or host-policy failures negotiate the file bridge before submission. A submitted operation never switches channels on a timeout. Run data and operation journals stay under `~/.cache/codex-mod/runs`, with the existing `pruneDays` cleanup.

Native coordinator SendMessage calls are serialized per target. The persisted parent assistant row supplies the authoritative source UUID and tool ID; a successful native result must confirm the same recipient ID before the hook routes to Codex. This avoids waiting for CLI 2.1.302, which raises `session.receive` only when the child drains its inbox between tool rounds. The later native copy is consumed without another steer; hosts that append without receive reconcile its child UUID to the same operation. Uncorrelated `queued_command` attachments still route directly from append, preserving the 1.1 fallback. Message identity uses source/tool IDs and target order; body text only checks integrity. Parallel tool blocks sharing a source row remain separate operations. Role instructions and override stripping affect Codex input while the card retains the original body.

A journal records intent before RPC dispatch and the outcome before replying. Accepted messages include the exact turn ID; rejected messages retain the raw RPC error and can enter the durable plugin FIFO after the turn. `exec` uses that FIFO directly. A lost response or crash between acceptance and recording remains **unknown** and is never automatically replayed. Reload restores bounded host-store metadata and full private-cache records; no transcript rows are rewritten.

When available within the bridge's short response window, an additive model-only `context` on the coordinator's SendMessage result reports the outcome and message ID. For later acknowledgments, call the registered `codex_message_status` tool with `targetAgentId` and `messageId` (also accepts a source UUID or SendMessage tool-use ID). It only reads owned outcomes and never sends or launches work. Child/display callers are refused. UI redraws do not update the coordinator model's earlier result.

The bridge remains per run with stdout event translation. Exec remains the default; no session broker, native daemon, or experimental queue is enabled. Real hook/socket policy, coordinator ordering/context mapping, and card reload/replay need the [steer v2 harness](tests/fixtures/steer-v2-harness.md) in a NEW session. RPC acceptance does not promise interruption of a tool already running or instruction compliance.

### Global rules off

With `globalRules` off, Codex runs with `CODEX_HOME` set to `$XDG_CACHE_HOME/codex-mod/home` (default `~/.cache/codex-mod/home`), which contains symbolic links to your real `auth.json`, `config.toml` and `models_cache.json` only. The plugin leaves those auth and configuration files alone; optional archive commands update session history in each source run's recorded home. Trade-offs: sessions for these runs live in the shadow folder (threads do not carry across the switch), skills and plugins from your Codex home are not visible, and if Codex replaces `auth.json` instead of writing through the link, your main install may ask you to log in again.

## How is this different from openai/codex-plugin-cc?

[openai/codex-plugin-cc](https://github.com/openai/codex-plugin-cc) exposes Codex through slash commands and a Claude wrapper subagent, with a shared broker process. codex-mod instead registers native subagent types whose rows are answered by a `turn.step` hook without any Claude model request, runs one sidecar per run (no shared broker), and can steer a running turn. The two take different routes to the same Codex CLI; pick the one that fits your workflow.

## Costs

- Codex usage counts against your ChatGPT/Codex plan, not your Claude usage. The footer shows Codex's own token counts: new input, cached input and output.
- No Anthropic request is made for the agent's own work. Claude still spends tokens writing the prompt and reading the answer.
- `lean` (on by default) removes optional context/tool families. R6 did not establish a universal percentage saving; high cache reuse can still accompany excessive total input.

## Limitations and known behaviours

- The native Claude model badge can still show the unused Haiku placeholder. Codex launch titles, added Agent-row text and footers show the real model and effort; separate header/task badges cannot display arbitrary GPT IDs.
- In auto mode, every handback carries the note "Auto mode classifier was unavailable". No Anthropic request was made for the classifier to review, so the note is accurate: Claude did not review Codex's work. Verify it yourself.
- The plugin relies on early-access APIs (`turn.step`, `tool.call`, `$.agent.register`, `SubagentHandback`) that may change.
- Installing or editing the plugin takes effect in a new session.
- `workspace-write` defaults restrict network and protected Git metadata. Owner network and exact Git-directory grants can expand those capabilities; see [Execution policy](#execution-policy-and-working-directories). Commit and push authority still comes from the task.
- Only finished actions, messages and available reasoning summaries are shown; raw reasoning is never shown. Exact patch adapters preserve empty content, CRLF and missing final newlines; they never clip Write/Edit inputs. Binary, oversized, ambiguous and missing/racing-snapshot patches retain a Bash diff/report. Normal exec payloads without per-file diffs cannot establish exact Write/Edit inputs. Typed Bash patch mapper acceptance and Desktop paint still require the headless/new-session checks in `tests/fixtures/batch3-harness.md`.
- With `app-server`, a steer is applied at Codex's next step boundary, not instantly.
- A root driver run does not survive a restart of the plugin worker: it reports `codex failed: run lost`, and a follow-up resumes its thread. A mirror can re-adopt its existing live broker/journal; missing ownership degrades without relaunch.

## Safety model

- Codex's actions are never executed by Claude. The native rows are answered from what Codex already did, without reaching the permission system or the tool.
- Every reserved display ID is intercepted, regardless of tool name, caller or options. An answer must match its held session, agent, exact tool, emitted input and source record, and can be consumed once. Handback uses a separate ID namespace so its real delivery still executes.
- Other Bash, Read, Glob, Grep, Edit, Write, WebSearch, WebFetch, Agent, TodoWrite, TaskCreate, TaskUpdate, SendMessage, TaskStop, ReportFindings and AskUserQuestion calls from Codex agents are refused. Both guards and their catches remain active with all option values. Registered `codex_tool`, `codex_plan`, `coordinator_message` and `codex_question` names refuse every caller without a matching held answer. Verified ordinary Claude/main calls with ordinary IDs pass unchanged. If both agent lookup and durable ownership lookup fail for an unseen protected subagent call, it is refused; verified ordinary ownership is cached through later lookup outages.
- Launch guard: at most one launch per new message and `maxRunsPerWindow` launches per agent in 10 minutes. Beyond that the agent hands back `codex failed: launch guard tripped`. Counters live in the stored record, so a restart does not reset them.
- Engine notices (reminders, nudges) are never treated as tasks; they re-deliver the last answer without a Codex run.
- Codex itself runs under the sandbox of the chosen agent. Prefer `read-only` or `workspace-write`; `danger-full-access` requires `defaultSandbox` for the generic agent or the user-level `allowProjectFullAccess` opt-in for project roles.

## Troubleshooting

- Agents not listed: start a new session, then check that Codex is installed and logged in (`codex login status`). Role agents are skipped when their model is not in `models_cache.json`.
- Footer or note says the transport fell back to `exec`: check `node --version` (18 or later), set `nodePath`, and confirm `codex app-server --help` works.
- Diagnostics: a change in the `codex exec --json` event format is reported as `protocol changed (codex-cli X)`; a Codex older than 0.163.0 produces a warning; the login check is provider-aware (skipped for a non-OpenAI `model_provider`), and a failed login suggests `codex login --device-auth`.
- `codex failed: ...` at the start of an answer: read the stderr lines that follow. Common causes are a missing binary (set `codexPath`), a logged-out Codex, or an unknown model or effort.
- `launch guard tripped`: too many launches in 10 minutes; wait or raise `maxRunsPerWindow`.
- Rows misbehave in your host: set `nativeActions` to false.
- Debug messages are written to Claude Code's debug log (`claude --debug`), prefixed `codex-mod:`.

## Contributing and ideas

See [CONTRIBUTING.md](CONTRIBUTING.md). Changes are listed in [CHANGELOG.md](CHANGELOG.md). Ideas and questions go to [Discussions](https://github.com/diegoaleyvag/codex-mod/discussions); bugs go to [issues](https://github.com/diegoaleyvag/codex-mod/issues). Security reports: see [SECURITY.md](SECURITY.md).

Good first contributions:

- Windows: the `app-server` runner relies on POSIX signals and file modes and has not been tried on Windows; test it and report or fix what breaks.
- Linux: CI runs the runner tests on Ubuntu, but the plugin itself has only been verified on macOS (Claude Code Desktop); try it on Linux and report.
- Desktop acceptance for image previews, question controls and reopened history; see the [Codex UI map](docs/codex-ui-map.md).

## Disclaimer

Not affiliated with or endorsed by Anthropic or OpenAI. Claude and Claude Code are trademarks of Anthropic; Codex and ChatGPT are trademarks of OpenAI.

## License

MIT, see [LICENSE](LICENSE).

## Execution policy and working directories

The user-level plugin options own execution authority. Repository files and task
text can request capabilities but cannot grant them. Defaults remain
`workspace-write`, `approvalMode: "never"`, network off and no additional writable
roots. Both transports now force this policy explicitly. This closes exec's former
inheritance of `approval_policy` and workspace network/roots from `config.toml`;
users relying on that inheritance must copy those grants into the plugin options
or the supported user `extraConfig` keys before activating this version.

| User option | Meaning |
| --- | --- |
| `approvalMode` | `never` (default), `ask`, `auto`, or `orchestrator` |
| `allowedApprovalModes` | Additional modes named launch headers may request; defaults to none |
| `networkAccess` | Workspace sandbox network grant, default false |
| `additionalWritableRoots` | Up to 32 existing absolute writable directory grants |
| `allowedCwdRoots` | Additional existing directory roots allowed for explicit launch cwd requests |

`defaultSandbox: "danger-full-access"` is a ready opt-in for the generic agent's
unrestricted filesystem and network access. Repository roles still require
`allowProjectFullAccess: true` to request that sandbox. It has no network or
writable-root boundary; use `workspace-write` to retain those controls. Ordinary
extra roots do not automatically remove Codex's protected `.git` rules.
Installed-CLI probes confirmed that extra roots plus network allow a sibling
directory write and network connection while `.git/FETCH_HEAD` remains protected.
A separate real CLI probe verified that explicitly granting the exact `.git`
directory allows `FETCH_HEAD` writes; full access also permits them. For linked
worktrees, inspect `git rev-parse --absolute-git-dir` and
`git rev-parse --path-format=absolute --git-common-dir`, and grant only the exact
real directories the owner intends. The plugin never adds these grants itself.
These are CLI policy probes, not live Desktop plugin acceptance.

Start a new task with an optional block of named headers, for example:

```text
codex-cwd: /absolute/path/to/registered-worktree
codex-approval: never
codex-sandbox: workspace-write
codex-network: false
codex-writable-roots: ["/absolute/explicit-owner-root"]
codex-model: gpt-6.1-sol
Implement the bounded task here.
```

The requested cwd must exist and resolve either to a registered worktree with the
same Git common directory as the host repository, or under an explicit
`allowedCwdRoots` grant. Symlinks resolve before grant comparisons. Missing,
unrelated and unregistered targets fail before model launch. Paths mentioned in
prose do not change cwd or write roots. The worktree becomes Codex's cwd and
workspace sandbox root; additional roots are separate owner grants.

An omitted header uses the owner default. Approval mode `never` is always
available; any other requested mode must be the owner default or appear in
`allowedApprovalModes`. Sandbox requests are bounded by the owner's
`defaultSandbox` and `allowProjectFullAccess` grant. Network can be requested only
when the owner enables it. A writable-root list can select only exact canonical
members of the owner-granted root list, including on resume. Descendants require their own explicit owner
grant: granting `/repo` does not authorize requesting `/repo/.git`, `/repo/.codex`,
`/repo/.agents` or even `/repo/src` as a separate root. Naming a protected child
explicitly can expand its permissions. Symlink aliases are accepted only when
they resolve to the same explicitly granted canonical directory. Read-only has
no writable-root grant and this version does not implement read-only network
expansion. A launch cannot request
network off while retaining `danger-full-access`.

The supported execution `extraConfig` keys are `approval_policy` (`"never"` or
`"on-request"`), `approvals_reviewer` (`"user"` or `"auto_review"`),
`sandbox_workspace_write.network_access` and
`sandbox_workspace_write.writable_roots`. These **user-owned** entries override
plugin option defaults first; named launch requests then select a permitted
narrower policy. `on-request` with reviewer `user` selects `ask`, while
`auto_review` selects `auto`. Whole sandbox tables and unsupported execution
values fail explicitly. No launch header accepts arbitrary TOML.

Each thread saves its exact effective cwd, sandbox, approval mode, network,
roots, policy source and fingerprint, alongside source evidence. Snapshot v2 also
records the cwd's original session, registered-worktree or owner-root authority.
Every resume revalidates that original authority against current owner grants and
Git registration/common-directory metadata. Moving the host onto an externally
granted target cannot turn a revoked grant into session authority. Existing v1
execution snapshots lack this anchor and fail explicitly; start a new agent.
Follow-ups keep that snapshot; privilege or target changes require a new agent. Revoked owner
grants fail closed. New-policy records with a missing recovery payload fail
instead of becoming legacy records. Old records without an execution snapshot
use a disclosed conservative baseline: their recorded sandbox, current host cwd,
never approvals, network off and no additional roots. Full access is inherently
unrestricted. Host cwd changes do not retarget a snapshotted thread.

### Approval modes

`never` supports either transport, including app-server's ordinary exec fallback.
Every other mode requires `app-server`; an unavailable runner or unsupported
reviewer fails explicitly and cannot silently fall back to exec or full access.
A ready opt-in for native Codex review is `transport: "app-server"` with
`approvalMode: "auto"`. This sends `on-request` and the installed Codex
`approvalsReviewer: "auto_review"` at thread and turn start. It uses Codex's
reviewer, not a Claude safety classifier. A fresh Desktop session with a Sonnet
parent and a Codex worker verified a native auto-review approval for computer-tool
inventory, alongside Git writes and network access under explicit full access.
This does not establish every approval type or interactive control.

`ask` displays owned native approval controls: **Approve once**, **Decline**, and
**Cancel turn**. It requires native action tools and a host that actually invokes
the custom renderer and supports buttons. Successful tool registration alone
does not establish this; some Desktop child views skip custom ToolUse renderers.
The new Desktop approval controls are **NOT RUN**. Missing controls fail
explicitly, and an unanswered/invisible pending approval expires after 120 seconds
without consent. Opening a row, receiving a request or rendering a receipt never
approves it.

`orchestrator` is an explicit owner delegation to the source agent's authoritative
immediate Claude parent. The parent must launch the Codex worker **in the
background**, then poll `codex_approval` with `action: "inspect"` and the exact
`targetAgentId` **before** blocking on completion. Inspect returns the complete
request and bound `identity`. Decide with `action: "decide"`, that unchanged
identity, and `decision: "accept"`, `"decline"` or `"cancel"`. For file acceptance,
copy the full `fileChanges` returned by inspect. When inspect supplies a command
item fallback, also copy its `commandContext`. These snapshots are checked again
against the exact current owned source item before submission and in the runner. A permission request
may additionally select a `permissions` subset. Submission is acknowledged before
runner delivery; inspect again or read the source outcome rather than replaying
the decision. Parent auto mode does not receive these requests automatically.
There is no internal parent notification; polling is required. An unanswered
request expires after 120 seconds.

The approval tool rejects source Codex agents, mirrors, unrelated Claude agents,
wrong sessions, orphaned children and missing/failed authoritative parent lookup.
If the host does not expose enough parent identity, orchestrator mode fails before
launch. Decisions bind method, JSON-RPC ID, token, thread, turn, item, optional
`approvalId` and command/`writeStdin` kind. Cancellation, interruption, turn end,
resolved RPCs and stale identities supply no consent. Command and file responses
are one-shot; permission grants contain only requested literal paths/network and
use turn scope. Session approvals, policy amendments, unstable file `grantRoot`,
special/glob permission roots and unknown RPCs remain unsupported. File approval
controls and parent inspection show the exact matching in-progress source item's
paths, kinds and diff, never a patch inferred from a reason or another item.
Missing, stale, empty, incomplete or oversized proposals disable acceptance. The
complete proposal limit is 32 files and 32,768 characters; proposals are rejected in full
instead of silently truncated. Decline and cancel remain available. Command
approvals require actionable command, explicit stdin callback payload or network
destination context. Original command text never supplies missing stdin bytes;
network host/protocol context is shown separately. No reusable
approval secret is persisted, and Claude never executes or replays the operation.

Permission diagnostics retain the original command output and add policy facts
for clear permission denials such as `EPERM`, `FETCH_HEAD` and ref-lock failures.
A message such as `error connecting to api.github.com` is reported as a network
failure with policy facts; it does not establish sandbox causality. No diagnostic
retries a command.

### Computer tools

Rich launches preserve configured MCP capabilities. The owner may selectively
grant a configured server with `projectCapabilityAllowlist: ["mcp:cua_repl"]`
and a role capability `mcpServers: ["cua_repl"]`; a rich owner preset can also use
already enabled servers. Lean disables these servers unless explicitly granted.
Read-only discovery on the installed `cua_repl` server returned its tools and a
native app inventory. A subsequent real Codex turn using saved ChatGPT auth and
only that existing MCP server completed two `js` inventory calls: 37 apps and no
open browser surfaces, without errors. Codex's per-turn MCP metadata resolved the
standalone probe's missing-context error. Selecting or controlling an app or
browser remains **NOT RUN**. Prefer an explicit owner `lean:false` rich baseline
for inherited tool access. Native computer/browser flags alone do not establish
a working host service; app permissions, context and server health still apply.
