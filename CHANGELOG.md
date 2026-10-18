# Changelog

## 1.0.0

First public release.

- Subagent types `codex-mod:codex`, `codex-mod:sol`, `codex-mod:sol-high` and `codex-mod:astra-audit` answered by the local Codex CLI (`codex exec --json`) under the user's own login, with no Anthropic request for the agent's work.
- Streaming `turn.step` hook; Codex commands and file changes rendered as native Bash, Edit and Write rows answered by a guarded `tool.call` hook and never executed by Claude.
- Final answer delivered through `SubagentHandback`, with a text fallback and a footer (agent, model, effort, sandbox, actions, Codex tokens, thread).
- Agents registered at session start from Codex's `models_cache.json`; model and effort overrides validated against it.
- Lean launches (about half the input tokens), optional plugin-owned Codex home to skip global rules.
- Launch guard and anti-loop handling of engine notices; per-agent thread resume for follow-ups.
- Configurable through `userConfig`: Codex path, defaults, roles, lean, extra config, handback mode, footer, native rows, progress throttling, timeout, launch guard and record retention.
