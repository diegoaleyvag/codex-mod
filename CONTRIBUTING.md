# Contributing

## Setup

You need Claude Code with plugin hooks-module support and, to exercise the plugin for real, the Codex CLI logged in. The tests use a fake Codex and do not need a login.

## Checks

Run both before opening a pull request:

```bash
claude plugin test .
claude plugin validate --strict .
node --test tests/runner.test.mjs
```

The runner tests (`tests/runner.test.mjs`) need only Node 18 or later and a fake app-server. The hook tests (`tests/codex.test.ts`) import `claude-code/testing`, which ships with Claude Code, so they cannot run in a generic CI environment; the runner tests can.

## Style

- TypeScript in `hooks/codex.ts`; follow the existing style (no semicolons, single quotes, 2-space indent).
- Comments in English, explaining why rather than what.
- No dead code or debug leftovers.
- Keep the safety model intact: Codex actions are never executed by Claude, and the guards have no off switch.
- Add or update a test for every behaviour change.

## Pull requests

- One focused change per PR, with a short description of the problem and the fix.
- Imperative commit messages ("Fix handback re-delivery").
- Update README.md and CHANGELOG.md when behaviour or options change; options live in `.claude-plugin/plugin.json`.
- All checks must pass.

## Reporting bugs

Open an issue with the bug report template. Include the footer line of the affected answer, your Claude Code version (`claude --version`), your Codex version (`codex --version`), the plugin options you changed, and the relevant lines of the debug log (`claude --debug`, lines starting with `codex-mod:`). Remove anything private first.
