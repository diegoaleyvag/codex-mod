# Batch 3 headless harness

Use `FAKE_SCENARIO=batch3-patches` with `fake-app-server.mjs` via the existing
wrapper that answers `--version` and `app-server --help`. Keep that environment
variable on the wrapper/child; no new capability probe is needed. Load actual
user settings (or `claude --settings`) with `transport:app-server`,
`nativeActions:true`, `richRows:false`. Repeat with richRows on and nativeActions off.

`batch3-app-items.json` contains 21 source patches / 22 file rows, including
empty, CRLF, no-final-newline, repeated text, insertion, unknown gaps, binary,
oversized, missing/racing snapshots, move+edit, metadata-only move, both deletion
forms, patchUpdated-only completion data, failed/declined/partial-unknown and
multi-file cases. The fake replays completions and emits aggregate turn diffs;
neither should add a row. Source error objects are fixture extensions retained
as evidence; partial-unknown uses the protocol's `failed` status.

By default the fake does no file work. Exact additions use their source diff;
updates/moves lack verified images and use Bash. For positive Edit/move-image
checks, set `FAKE_PATCH_ROOT` to a **fresh disposable directory**, e.g.
`mktemp -d /tmp/codex-mod-batch3.XXXXXX`. Only this opt-in lets the fake simulate
Codex writes/deletions beneath that root, using `batch3-images.json`. Set
`FAKE_PATCH_DELAY_MS=1000` if the host needs more time to capture starts (default
250 ms). Insufficient capture time must safely produce Bash, never a guessed Edit.
With images expect: 7 Write, 3 Edit, 12 Bash rows; 21 source patches. Four
small additions plus patch-updated and the two multi-file adds account for Write.
Three failures must deny, even though partial-unknown's fake file changes.
Moves show both paths; deletes never become empty writes. The unit fixtures
add ordered bounded hunk rows with shifted intermediate coordinates, unknown
status, missing completed image, invalid UTF-8 and changing completion reads.

For exec, have the fake executable emit `batch3-exec.jsonl` verbatim for
`exec --json` (and resume). Its string kinds and optional `move_path` are
intentional; no start snapshots exist. Expect 22 patches / 23 file rows:
7 Write and 16 Bash, with three error denials. Diff-less updates stay Bash.
The fixture path strings resolve against the harness cwd; no files are needed.

Instrument native Bash/Edit/Write executors and guard filesystem writes: all
must remain zero. The optional source simulator's writes are separate from
these guard checks. Assert exact input/result schemas and typed
`Bash.bashEditDiff` mapper acceptance, including `created:true`/`deleted:true`,
EOF markers, CRLF, no clipping markers, immutable inputs, foreign/replayed IDs
and one real final handback. A patch count is independent of file/hunk row count.

After install/reload, use a NEW Desktop session to inspect created/edited/deleted
paint, both move paths, +/- counts, multi-file/hunk grouping and failure labels;
check working-tree refresh and absence of spurious Git/PR binding. Record a
concrete paint failure before considering a custom patch card. Unit/runner
checks do not establish host mapper admission or Desktop appearance.

## Implementation checkpoint

- Branch confirmed from `.git/HEAD`: `feat/1.2`. Changes remain uncommitted;
  no Git status/diff inspection was performed. Only the explicitly requested
  `git diff --check` Git command ran. The social-preview PNG was not touched.
- Changed: `hooks/codex.ts`, new `hooks/patches.ts`, both test suites,
  `fake-app-server.mjs`, `batch3-*` fixtures, README, Unreleased changelog and UI map.
  Existing runner wire retention and `hooks/hooks.json` loading were sufficient.
- Verification: plugin 424/424; runner 56/56; strict plugin validation passed.
  Logs: `/tmp/codex-mod-batch3-parent-plugin.log` and
  `/tmp/codex-mod-batch3-parent-runner.log`.
- Parent-path tests assert the exported pure helper shared by read acquisition
  and rendering, plus literal parent segments in both Write and Edit inputs.
  The host normalizes `fs.read` before test hooks, so hook-observed read paths
  cannot measure the plugin's original argument. No runtime path logic changed.
- Headless output mapper admission and NEW Desktop session checks remain unrun;
  the fake simulator/exec fixtures above are ready for the owner's harness.
