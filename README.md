# codex-mod

[![CI](https://github.com/diegoaleyvag/codex-mod/actions/workflows/ci.yml/badge.svg)](https://github.com/diegoaleyvag/codex-mod/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Version 1.1.0](https://img.shields.io/badge/version-1.1.0-informational.svg)](CHANGELOG.md)

codex-mod is a Claude Code plugin (a "mod", built on the early-access plugin hooks-module API) that adds subagent types answered by the OpenAI Codex CLI running on your machine instead of an Anthropic model. Claude stays the orchestrator and delegates self-contained tasks to `codex exec --json`, using your own ChatGPT/Codex login. Codex's commands and file changes show up in the transcript as ordinary Bash, Edit and Write rows, and its final answer comes back like any other subagent report.

<!-- demo: docs/demo.gif -->

## How it works

```
Claude (orchestrator)
   |  Agent(subagent_type = "codex-mod:sol", prompt)
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
Use codex-mod:sol to add input validation to src/api.ts. Allowed paths: src/. Verify with `npm test`. Report the diff summary.

Use codex-mod:astra-audit to review the diff of branch feature/x against main. Report findings only.
```

Codex sees only the prompt and the repository's `AGENTS.md`, so the prompt must carry the whole task: branch, allowed paths, how to verify, what to report.

Override the model or effort for one agent by starting the prompt with these lines (the choice sticks for its follow-ups):

```
codex-model: gpt-6-luna
codex-effort: low
Summarise what src/index.ts exports.
```

An unknown model or unsupported effort fails with a clear error; nothing falls back silently.

Follow-ups go through `SendMessage` to the same agent and resume its Codex thread. A message sent while the agent is still running is delivered too, according to the transport (see [Transports](#transports)).

Each answer ends with a footer, for example:

```
codex · gpt-6-luna · low · workspace-write · 3 actions · 37.4K new tokens (154K cached, 631 out) · thread 01a14f50
```

It shows the agent, model, effort, sandbox, number of actions, Codex's token counts (new, cached, output) and the Codex thread id. With the `app-server` transport it also shows `app-server` and, when any were delivered, `N steer(s)`. Failures are never silent: the answer starts with `codex failed: <reason>` followed by the last lines of Codex's stderr.

## Agents

| Agent | Default model | Effort | Sandbox | Use it for |
| --- | --- | --- | --- | --- |
| `codex-mod:codex` | option `defaultModel` (empty: first model Codex lists) | option `defaultEffort` | option `defaultSandbox` | A self-contained coding or research task |
| `codex-mod:sol` | `gpt-6.1-sol` | `medium` | `workspace-write` | A normal, bounded implementation task |
| `codex-mod:sol-high` | `gpt-6.1-sol` | `xhigh` | `workspace-write` | High-risk work, or a retry |
| `codex-mod:astra-audit` | `gpt-6-astra` | `xhigh` | `read-only` | Independent read-only review; never edits |

A role agent whose model is not in your Codex model list is not registered. Agent descriptions list the models available on your machine.

## Options

Set them in the plugin's config screen or under `pluginConfigs` in settings. An out-of-range value falls back to its default.

| Option | Default | Meaning |
| --- | --- | --- |
| `codexPath` | empty | Absolute path of `codex`. Empty: `PATH`, then common locations. |
| `defaultModel` | empty | Model of `codex-mod:codex`. Empty: first model Codex lists. |
| `defaultEffort` | `medium` | Effort of `codex-mod:codex`; must be supported by the model. |
| `defaultSandbox` | `workspace-write` | `read-only`, `workspace-write` or `danger-full-access`. |
| `roles` | `sol`, `sol-high`, `astra-audit` | Role agents to register besides `codex`. |
| `lean` | `true` | Turn off Codex plugins, apps, skills instructions, web search, multi-agent and configured MCP servers per launch. |
| `globalRules` | `true` | Off (experimental): run Codex with a plugin-owned `CODEX_HOME` so your user-level `AGENTS.md` is not loaded. |
| `extraConfig` | none | Raw `key=value` entries passed as `-c` to every launch. `model`, `model_reasoning_effort` and `sandbox_mode` are refused. |
| `handbackMode` | `auto` | `auto`: `SubagentHandback`, plain text only if the tool is not active for the agent. `tool` or `text` force one. |
| `footer` | `full` | `full`, `short` (agent, model, effort) or `off`. |
| `nativeActions` | `true` | Off: actions are plain text lines in one step instead of Bash/Edit/Write rows. |
| `progressIntervalMs` | `1000` | At most one action step per interval (0 to 60000). |
| `maxActionsPerStep` | `10` | Most actions shown in one step (1 to 50). |
| `timeoutMinutes` | `0` | Stop a run after this many minutes and report `codex failed: timeout`. `0`: no limit. |
| `maxRunsPerWindow` | `3` | Launch guard: most launches per agent in 10 minutes (1 to 100). |
| `transport` | `exec` | `exec` (`codex exec --json`, most stable) or `app-server` (experimental, see [Transports](#transports)). |
| `nodePath` | empty | Absolute path of Node (18 or later) for the `app-server` sidecar. Empty: `PATH`, then common locations. |
| `pruneDays` | `2` | Delete stored agent records (thread, model, effort) unused for this many days. |

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

If Node, the runner or `codex app-server` is unavailable, the session falls back to `exec` automatically and the footer says why.

The agent's output shows what happened to a message:

```
↪ steer delivered to Codex mid-turn: "..."
↪ Codex had already finished; this message runs next, on the same thread
↪ queued: runs after this turn (exec transport has no mid-turn steer)
```

The notes exist because Claude Code Desktop does not render the coordinator's message itself in the subagent view. A steer lands at Codex's next step boundary (about 3 s in a live check).

Control files for a live run (steer text, interrupt) live in `~/.cache/codex-mod/runs` (mode 0700) and are pruned after `pruneDays`.

### Global rules off

With `globalRules` off, Codex runs with `CODEX_HOME` set to `$XDG_CACHE_HOME/codex-mod/home` (default `~/.cache/codex-mod/home`), which contains symbolic links to your real `auth.json`, `config.toml` and `models_cache.json` only. The plugin never writes to your real Codex home. Trade-offs: sessions for these runs live in the shadow folder (threads do not carry across the switch), skills and plugins from your Codex home are not visible, and if Codex replaces `auth.json` instead of writing through the link, your main install may ask you to log in again.

## How is this different from openai/codex-plugin-cc?

[openai/codex-plugin-cc](https://github.com/openai/codex-plugin-cc) exposes Codex through slash commands and a Claude wrapper subagent, with a shared broker process. codex-mod instead registers native subagent types whose rows are answered by a `turn.step` hook without any Claude model request, runs one sidecar per run (no shared broker), and can steer a running turn. The two take different routes to the same Codex CLI; pick the one that fits your workflow.

## Costs

- Codex usage counts against your ChatGPT/Codex plan, not your Claude usage. The footer shows Codex's own token counts: new input, cached input and output.
- No Anthropic request is made for the agent's own work. Claude still spends tokens writing the prompt and reading the answer.
- `lean` (on by default) roughly halves the input tokens of each Codex call.

## Limitations and known behaviours

- The row label in Claude Code Desktop shows the placeholder Anthropic model the agent is registered with. That model is never called; the footer shows the real Codex model.
- In auto mode, every handback carries the note "Auto mode classifier was unavailable". No Anthropic request was made for the classifier to review, so the note is accurate: Claude did not review Codex's work. Verify it yourself.
- The plugin relies on early-access APIs (`turn.step`, `tool.call`, `$.agent.register`, `SubagentHandback`) that may change.
- Installing or editing the plugin takes effect in a new session.
- In `workspace-write`, Codex usually cannot commit inside a git worktree or use the network; let the caller commit and push.
- Only finished actions and Codex's messages are shown, not its reasoning. Codex reports file changes without a diff, so Edit rows are reconstructed from file text seen before and after.
- With `app-server`, a steer is applied at Codex's next step boundary, not instantly.
- A run does not survive a restart of the plugin worker: the agent reports `codex failed: run lost`, and a follow-up resumes its thread.

## Safety model

- Codex's actions are never executed by Claude. The native rows are answered from what Codex already did, without reaching the permission system or the tool.
- Any other Bash, Edit or Write call from a codex-mod agent, or from a subagent whose type cannot be resolved, is refused. A failing guard refuses too, and a `tool.check` hook denies such a call as a backstop. No option turns this off.
- Launch guard: at most one launch per new message and `maxRunsPerWindow` launches per agent in 10 minutes. Beyond that the agent hands back `codex failed: launch guard tripped`. Counters live in the stored record, so a restart does not reset them.
- Engine notices (reminders, nudges) are never treated as tasks; they re-deliver the last answer without a Codex run.
- Codex itself runs under the sandbox of the chosen agent. Prefer `read-only` or `workspace-write`; `danger-full-access` is opt-in via `defaultSandbox`.

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
- More native action types: only command executions and file changes are drawn as rows; other Codex items appear as text.
- A demo GIF for the top of this README (`docs/demo.gif`).

## Disclaimer

Not affiliated with or endorsed by Anthropic or OpenAI. Claude and Claude Code are trademarks of Anthropic; Codex and ChatGPT are trademarks of OpenAI.

## License

MIT, see [LICENSE](LICENSE).
