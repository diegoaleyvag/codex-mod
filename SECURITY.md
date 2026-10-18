# Security

## What the plugin can do

codex-mod runs the Codex CLI on your machine, with your own Codex login, and shows its actions as Bash, Edit and Write rows. It sends nothing anywhere itself.

- Codex runs under the sandbox of the chosen agent: `read-only`, `workspace-write` (default) or `danger-full-access`, which is opt-in through `defaultSandbox`. In `workspace-write`, Codex can change files in the working directory.
- Codex's actions are never executed by Claude; the rows are answered from what Codex already did. Any other Bash, Edit or Write call from a codex-mod agent is refused.
- The plugin never writes your real Codex home. With `globalRules` off it uses a shadow `CODEX_HOME` that only links `auth.json`, `config.toml` and `models_cache.json`.
- Control files for a live run (steer text, interrupt) live in `~/.cache/codex-mod/runs` with mode 0700 and are pruned after `pruneDays`.
- `extraConfig` passes raw `-c` entries to Codex; treat it like any other configuration that can loosen Codex's behaviour.

## Reporting a vulnerability

Please report privately, not in a public issue: open the repository's Security tab and choose "Report a vulnerability" (GitHub private vulnerability reporting). Include the affected version, what you did, and what you expected. Remove tokens and private paths first.

Only the latest release is supported.
