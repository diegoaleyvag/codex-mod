import test from 'node:test'
import assert from 'node:assert/strict'
import { resolveExecution } from '../hooks/execution-policy.ts'
import { configHash } from '../hooks/run-policy.ts'
import { compactStoreState } from '../hooks/store-state.ts'

const owner = overrides => ({ approvalMode: 'never', allowedApprovalModes: [], networkAccess: false, additionalWritableRoots: [], allowedCwdRoots: [],
  allowProjectFullAccess: false, generic: { sandbox: 'workspace-write' }, extraConfig: [], ...overrides })
function host() {
  const paths = new Map()
  const git = new Map()
  for (const [path, root] of [['/repo', '/repo'], ['/repo/sub', '/repo'], ['/wt', '/wt']]) {
    git.set(`${path} rev-parse --path-format=absolute --git-common-dir`, '/repo/.git')
    git.set(`${path} rev-parse --show-toplevel`, root)
    git.set(`${path} worktree list --porcelain`, 'worktree /repo\n\nworktree /wt\n')
  }
  const $ = { process: { run: async argv => {
    if (argv[0] === '/bin/sh') return { exitCode: paths.get(argv[4]) === null ? 1 : 0, stdout: paths.get(argv[4]) ?? argv[4] }
    const text = git.get(argv.slice(2).join(' '))
    return { exitCode: text === undefined ? 128 : 0, stdout: text ?? '', stderr: text === undefined ? 'fatal: not a git repository' : '' }
  } } }
  return { $, paths, git }
}
test('owner cwd grants are rechecked on every resume, even after host cwd moves onto the target', async () => {
  const h = host(), grant = owner({ allowedCwdRoots: ['/external'] })
  const saved = await resolveExecution(h.$, grant, { cwd: '/external/job' }, '/repo', 'workspace-write')
  assert.deepEqual(saved.cwdAuthority, { kind: 'owner', root: '/external' })
  for (const currentCwd of ['/repo', '/external/job', '/repo/sub']) {
    assert.deepEqual(await resolveExecution(h.$, grant, {}, currentCwd, 'workspace-write', JSON.parse(JSON.stringify(saved))), saved)
    await assert.rejects(resolveExecution(h.$, owner(), {}, currentCwd, 'workspace-write', saved), /no longer granted/)
    await assert.rejects(resolveExecution(h.$, owner(), { cwd: '/external/job' }, currentCwd, 'workspace-write', saved), /no longer granted/)
  }
  h.paths.set('/external/job', '/foreign')
  await assert.rejects(resolveExecution(h.$, grant, {}, '/repo', 'workspace-write', saved), /cannot change/)
})
test('registered worktree authority retains the original anchor and detects removed registration or changed common dir', async () => {
  const h = host(), grants = owner()
  const saved = await resolveExecution(h.$, grants, { cwd: '/wt' }, '/repo', 'workspace-write')
  assert.deepEqual(saved.cwdAuthority, { kind: 'worktree', anchor: '/repo', commonDir: '/repo/.git', worktreeRoot: '/wt' })
  assert.deepEqual(await resolveExecution(h.$, grants, {}, '/repo/sub', 'workspace-write', saved), saved)
  h.git.set('/repo worktree list --porcelain', 'worktree /repo\n')
  await assert.rejects(resolveExecution(h.$, grants, {}, '/wt', 'workspace-write', saved), /no longer registered/)
  h.git.set('/repo worktree list --porcelain', 'worktree /repo\n\nworktree /wt\n')
  h.git.set('/wt worktree list --porcelain', 'worktree /repo\n')
  await assert.rejects(resolveExecution(h.$, grants, {}, '/repo', 'workspace-write', saved), /registration.*changed/)
  h.git.set('/wt worktree list --porcelain', 'worktree /repo\n\nworktree /wt\n')
  h.git.set('/wt rev-parse --path-format=absolute --git-common-dir', '/foreign/.git')
  await assert.rejects(resolveExecution(h.$, grants, {}, '/repo', 'workspace-write', saved), /common directory changed/)
})
test('ordinary session cwd remains pinned while the host moves within the original repository', async () => {
  const h = host(), grants = owner()
  const saved = await resolveExecution(h.$, grants, {}, '/repo', 'workspace-write')
  assert.deepEqual(saved.cwdAuthority, { kind: 'session', anchor: '/repo', commonDir: '/repo/.git', worktreeRoot: '/repo' })
  assert.equal((await resolveExecution(h.$, grants, {}, '/wt', 'workspace-write', saved)).cwd, '/repo')
  h.git.set('/repo rev-parse --path-format=absolute --git-common-dir', '/new/.git')
  await assert.rejects(resolveExecution(h.$, grants, {}, '/repo', 'workspace-write', saved), /common directory changed/)
})
test('v2 authority survives JSON/cache snapshots; unanchored v1 snapshots never become newly authorized session targets', async () => {
  const h = host(), grants = owner({ allowedCwdRoots: ['/external'] })
  const saved = await resolveExecution(h.$, grants, { cwd: '/external/job' }, '/repo', 'workspace-write')
  const compact = compactStoreState({ effectiveExecution: saved, executionFingerprint: saved.fingerprint })
  assert.deepEqual(await resolveExecution(h.$, grants, {}, '/repo', 'workspace-write', JSON.parse(JSON.stringify(compact.effectiveExecution))), saved)
  const { cwdAuthority, fingerprint, ...rest } = saved
  const old = { ...rest, version: 1 }
  old.fingerprint = configHash(old)
  await assert.rejects(resolveExecution(h.$, grants, {}, '/external/job', 'workspace-write', old), /cwd authority unavailable/)
  const legacy = await resolveExecution(h.$, grants, {}, '/repo', 'workspace-write', undefined, true)
  assert.equal(legacy.version, 2)
  assert.equal(legacy.cwdAuthority.kind, 'session')
  assert.equal(legacy.source, 'legacy')
})

test('a failed Git authority probe never silently classifies a repository as a plain session directory', async () => {
  const failed = { process: { run: async argv => argv[0] === '/bin/sh' ? { exitCode: 0, stdout: argv[4] } : { exitCode: 1, stdout: '', stderr: 'EPERM protected Git metadata' } } }
  await assert.rejects(resolveExecution(failed, owner(), {}, '/repo', 'workspace-write'), /cannot validate session cwd Git authority/)
})

test('writable-root requests select only exact owner roots, including protected and ordinary descendants', async () => {
  const h = host(), grants = owner({ additionalWritableRoots: ['/repo'] })
  for (const path of ['/repo/.git', '/repo/.codex', '/repo/.agents', '/repo/src']) {
    await assert.rejects(resolveExecution(h.$, grants, { writableRoots: [path] }, '/repo', 'workspace-write'), /exactly match an explicit canonical owner root/)
  }
  assert.deepEqual((await resolveExecution(h.$, grants, { writableRoots: ['/repo'] }, '/repo', 'workspace-write')).writableRoots, ['/repo'])
  assert.deepEqual((await resolveExecution(h.$, grants, { writableRoots: [] }, '/repo', 'workspace-write')).writableRoots, [])
})
test('writable-root equality resolves both owner and requested symlinks without authorizing a child', async () => {
  const h = host()
  h.paths.set('/repo-alias', '/repo')
  h.paths.set('/git-alias', '/repo/.git')
  const parentOnly = owner({ additionalWritableRoots: ['/repo-alias'] })
  await assert.rejects(resolveExecution(h.$, parentOnly, { writableRoots: ['/git-alias'] }, '/repo', 'workspace-write'), /descendant selections are not granted/)
  const exact = owner({ additionalWritableRoots: ['/git-alias'] })
  assert.deepEqual((await resolveExecution(h.$, exact, { writableRoots: ['/repo/.git'] }, '/repo', 'workspace-write')).writableRoots, ['/repo/.git'])
  assert.deepEqual((await resolveExecution(h.$, exact, { writableRoots: ['/git-alias'] }, '/repo', 'workspace-write')).writableRoots, ['/repo/.git'])
})
test('resume revalidates an exact writable-root grant and cannot substitute a broader parent after revocation', async () => {
  const h = host(), exact = owner({ additionalWritableRoots: ['/repo/.git'] })
  const saved = await resolveExecution(h.$, exact, { writableRoots: ['/repo/.git'] }, '/repo', 'workspace-write')
  assert.deepEqual(await resolveExecution(h.$, exact, {}, '/repo/sub', 'workspace-write', JSON.parse(JSON.stringify(saved))), saved)
  for (const additionalWritableRoots of [[], ['/repo']]) {
    await assert.rejects(resolveExecution(h.$, owner({ additionalWritableRoots }), {}, '/repo', 'workspace-write', saved), /exactly match an explicit canonical owner root/)
  }
  h.paths.set('/git-alias', '/repo/.git')
  const aliasOwner = owner({ additionalWritableRoots: ['/git-alias'] })
  assert.deepEqual(await resolveExecution(h.$, aliasOwner, {}, '/repo', 'workspace-write', saved), saved)
  h.paths.set('/git-alias', '/repo/.codex')
  await assert.rejects(resolveExecution(h.$, aliasOwner, {}, '/repo', 'workspace-write', saved), /exactly match an explicit canonical owner root/)
})
