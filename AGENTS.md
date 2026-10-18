# codex-mod agent instructions

codex-mod is a Claude Code hooks-module plugin. It registers subagent types
(the generic `codex-mod:codex` plus roles a project declares) answered by the local
OpenAI Codex CLI, with Codex actions drawn as native rows and never executed by Claude.

## Layout

- `hooks/codex.ts` + `hooks/hooks.json`: all plugin behaviour (turn.step, tool.call guard, handback).
- `scripts/codex-runner.mjs`: per-run Node sidecar for the opt-in `app-server` transport.
- `tests/`: `codex.test.ts` (hooks, needs `claude-code/testing`), `runner.test.mjs` (Node only), `fixtures/`.
- `.claude-plugin/plugin.json`: manifest and every user option. `README.md`, `CHANGELOG.md`, `CONTRIBUTING.md`.
- `.claude/codex-mod.json`: this repo's own Codex roles (`implementer`, `implementer-high`, `auditor`).
- `docs/decisions.md`: decision log. Read it before changing transport, safety or handback behaviour.

## Roles

- **Orchestrator (Opus):** plans, writes the task spec, delegates, validates findings,
  and is the only role that integrates, commits and pushes. Push, publish and release
  need the owner's go-ahead.
- **Implementer:** gpt-6.1-sol through any codex-mod agent (a role this project
  declares, or `codex-mod:codex` with `codex-model:` / `codex-effort:` lines), or Claude.
  Normal: Sol medium (or Sonnet medium). High risk or a retry: Sol xhigh (or Opus high).
  Change Sol's effort, not the model, and raise it only when the task needs it.
- **Orchestrator verification:** the orchestrator checks every phase itself (diff,
  tests, live check); there is no separate per-phase review.
- **Final reviewer (one per change, from the other model family):** Sol-implemented
  work gets Fable 5.1 (Opus if unavailable); Claude-implemented work gets `gpt-6-astra`
  at low or medium effort, read-only. Never both, never per phase or per task.
- Two writers never share a checkout; concurrent writers use separate worktrees.

## Rules for Codex workers

- You see only the task prompt and this file. The prompt must give branch, allowed paths,
  verification command and report format; if any is missing, say so instead of guessing.
- Never run `git commit`, `git push`, `git reset`, branch or tag commands. Leave changes in the working tree.
- Edit only the allowed paths. Do not touch `.claude-plugin/plugin.json` version, CHANGELOG or release files unless listed.
- Assume no network. Do not install packages or add dependencies.
- Do not copy third-party code or assets; write original code.
- Keep the style of `hooks/codex.ts`: TypeScript, no semicolons, single quotes, 2-space indent,
  English comments that explain why. No dead code or debug leftovers.
- Keep the safety model: Codex actions are never executed by Claude and the guards have no off switch.
- Add or update a test for every behaviour change.
- Report in the requested format: files changed, commands run with real results,
  what you did not verify, open doubts. No transcripts.

## Verification

Run from the repo root, as available:

```
claude plugin test .
node --test tests/runner.test.mjs
claude plugin validate --strict .
```

`claude plugin test .` and `validate` need Claude Code and may be unavailable inside
a Codex sandbox; say which commands could not run. Hook changes have no hot reload:
verify them for real in a NEW Desktop session after installing or reloading the plugin.
Passing tests are evidence, not proof of the requirement.

## Review

- **Per phase:** the orchestrator verifies (diff, tests, live check) and validates
  its own findings before fixing; no Astra or Fable review per phase.
- **End of a whole change:** one read-only review by the final reviewer of the other
  model family (see Roles). The orchestrator validates each finding before fixing; at
  most 2 fix/review rounds, then escalate to the owner.
- **Low risk** (docs, typos, README, comments): no separate review; orchestrator checks the diff.
- A failed verification is a failed attempt: retry only with new information, at most
  3 attempts, then stop and report.

## Git and releases

- Imperative commit messages, one focused change per commit, no AI coauthor or attribution trailers.
- Update README.md and CHANGELOG.md when behaviour or options change; options live in `plugin.json`.
- Record a new durable decision in `docs/decisions.md` (append, never rewrite).
