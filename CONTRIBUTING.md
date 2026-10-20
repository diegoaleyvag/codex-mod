# Contributing

## Setup

You need Claude Code with plugin hooks-module support and, to exercise the plugin for real, the Codex CLI logged in. The tests use a fake Codex and do not need a login.

## Checks

Run these checks before opening a pull request:

```bash
claude plugin test .
claude plugin validate --strict .
node --test tests/runner.test.mjs tests/approval-policy.test.mjs
```

The runner and approval-policy tests need only Node 18 or later and a fake app-server. The hook tests (`tests/codex.test.ts`) import `claude-code/testing`, which ships with Claude Code, so they cannot run in a generic CI environment. CI (`.github/workflows/ci.yml`) runs the runner and approval-policy tests, a syntax check and a JSON validity check on Ubuntu and macOS with Node 20 and 22; the hook tests and `claude plugin validate` run locally.

The cache, checkpoint and execution-policy tests import TypeScript helpers. Run them with Node 22
or later; CI exercises them on Node 22 on both operating systems:

```bash
node --experimental-strip-types --test tests/store-state.test.mjs tests/row-cache.test.mjs tests/execution-policy.test.mjs
```

## Release checklist

1. Match the version in `.claude-plugin/plugin.json`, README and CHANGELOG;
   update the marketplace description when agent names change.
2. Run the checks above and verify the GitHub CI matrix. Hook suites remain
   local evidence, separate from hosted CI.
3. Record live Desktop checks and remaining limits in `docs/codex-ui-map.md`.
   Do not describe an unaccepted custom renderer or control as verified.
4. Document removed options/types and the migration path. Keep manual harnesses
   and their fixtures; store temporary probes, logs and session checkpoints
   outside the repository.
5. Prepare a PR and release notes from the final commit. The owner's release
   decision must account for remaining acceptance gates. Create the version
   tag from that commit when publishing; never move an existing release tag.
6. After installing/updating, inspect `claude plugin list` for scope, version
   and loaded path, then use a fresh session. A directory marketplace may load
   the checkout directly rather than the metadata cache.

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
