import type { EngineInterface } from 'claude-code'
import { canonicalOverrides, configHash } from './run-policy.ts'

export const APPROVAL_MODES = ['never', 'ask', 'auto', 'orchestrator'] as const
export type ApprovalMode = typeof APPROVAL_MODES[number]
export type ExecutionRequest = { cwd?: string; approvalMode?: ApprovalMode; sandbox?: string; networkAccess?: boolean; writableRoots?: string[] }
export type ExecutionOwner = {
  approvalMode: ApprovalMode; allowedApprovalModes: string[]; networkAccess: boolean; additionalWritableRoots: string[]
  allowedCwdRoots: string[]; allowProjectFullAccess: boolean; generic: { sandbox: string }; extraConfig: string[]
}
export type CwdAuthority = { kind: 'session'; anchor: string; commonDir?: string; worktreeRoot?: string }
  | { kind: 'worktree'; anchor: string; commonDir: string; worktreeRoot: string }
  | { kind: 'owner'; root: string }
export type ExecutionPolicy = {
  version: 2; cwdAuthority: CwdAuthority; cwd: string; sandbox: string; approvalMode: ApprovalMode; networkAccess: boolean; writableRoots: string[]
  source: 'owner' | 'launch' | 'legacy'; fingerprint: string
}
const sandboxes = ['read-only', 'workspace-write', 'danger-full-access']
const executionKeys = ['approval_policy', 'approvals_reviewer', 'sandbox_workspace_write.network_access', 'sandbox_workspace_write.writable_roots']
export const executionOverride = (entry: string): boolean => {
  const key = entry.slice(0, entry.indexOf('=')).trim().replace(/"([\w-]+)"/g, '$1')
  return executionKeys.includes(key) || key === 'sandbox_workspace_write'
}
const pathList = (value: unknown): value is string[] => Array.isArray(value) && value.length <= 32 && value.every(v => typeof v === 'string' && v.startsWith('/') && !/[\0\r\n]/.test(v))
const literal = (value: string): unknown => {
  if (value === 'true' || value === 'false') return value === 'true'
  try { return JSON.parse(value) } catch {}
  if (/^'[^']*'$/.test(value)) return value.slice(1, -1)
  // Accept the common TOML literal-string array without evaluating TOML supplied by a model.
  if (/^\[\s*(?:'[^']*'\s*(?:,\s*'[^']*'\s*)*)?\]$/.test(value)) return [...value.matchAll(/'([^']*)'/g)].map(m => m[1])
  throw new Error('unsupported execution extraConfig value; use quoted strings, booleans or a path array')
}

/** Only the leading named launch headers request permissions; prose grants nothing. */
export function executionRequest(task: string): { request: ExecutionRequest; rest: string } {
  const request: ExecutionRequest = {}
  let rest = task
  const modelHeaders: string[] = []
  const seen = new Set<string>()
  for (;;) {
    const m = /^\s*codex-(model|effort|cwd|approval|sandbox|network|writable-roots):[ \t]*([^\n]*)(?:\n|$)/i.exec(rest)
    if (!m) break
    if (['model', 'effort'].includes(m[1]!.toLowerCase())) {
      // Model/effort are parsed separately, but may appear in the same header block.
      modelHeaders.push(m[0])
      rest = rest.slice(m[0].length)
      continue
    }
    const name = m[1]!.toLowerCase(), value = m[2]!.trim()
    if (seen.has(name)) throw new Error(`duplicate codex-${name} header`)
    seen.add(name)
    if (name === 'cwd') {
      if (!value.startsWith('/') || /[\0\r\n]/.test(value)) throw new Error('codex-cwd must be an absolute existing directory')
      request.cwd = value
    } else if (name === 'approval') {
      if (!(APPROVAL_MODES as readonly string[]).includes(value)) throw new Error('invalid codex-approval mode')
      request.approvalMode = value as ApprovalMode
    } else if (name === 'sandbox') {
      if (!sandboxes.includes(value)) throw new Error('invalid codex-sandbox')
      request.sandbox = value
    } else if (name === 'network') {
      if (!['true', 'false'].includes(value)) throw new Error('codex-network must be true or false')
      request.networkAccess = value === 'true'
    } else {
      let roots: unknown
      try { roots = JSON.parse(value) } catch { throw new Error('codex-writable-roots must be a JSON array of absolute paths') }
      if (!pathList(roots)) throw new Error('codex-writable-roots must be a bounded array of absolute paths')
      request.writableRoots = roots
    }
    rest = rest.slice(m[0].length)
  }
  return { request, rest: modelHeaders.join('') + rest }
}

export function ownerExecution(owner: ExecutionOwner) {
  let approvalMode = owner.approvalMode, networkAccess = owner.networkAccess, writableRoots = owner.additionalWritableRoots
  let reviewer = 'user'
  let rawPolicy: unknown
  for (const entry of canonicalOverrides(owner.extraConfig)) {
    const at = entry.indexOf('='), key = entry.slice(0, at), raw = entry.slice(at + 1)
    if (key === 'sandbox_workspace_write') throw new Error('execution extraConfig must use named network_access/writable_roots keys, not a sandbox table')
    if (!executionKeys.includes(key)) continue
    const value = literal(raw)
    if (key === 'approval_policy') rawPolicy = value
    else if (key === 'approvals_reviewer') {
      if (!['user', 'auto_review'].includes(String(value))) throw new Error('unsupported approvals_reviewer; expected user or auto_review')
      reviewer = String(value)
    } else if (key.endsWith('network_access')) {
      if (typeof value !== 'boolean') throw new Error('network_access must be boolean')
      networkAccess = value
    } else {
      if (!pathList(value)) throw new Error('writable_roots must be a bounded array of absolute paths')
      writableRoots = value
    }
  }
  if (rawPolicy !== undefined) {
    if (!['never', 'on-request'].includes(String(rawPolicy))) throw new Error('unsupported approval_policy; expected never or on-request')
    approvalMode = rawPolicy === 'never' ? 'never' : reviewer === 'auto_review' ? 'auto' : 'ask'
  } else if (reviewer === 'auto_review') {
    if (approvalMode === 'orchestrator') throw new Error('approvals_reviewer=auto_review conflicts with orchestrator mode')
    approvalMode = 'auto'
  }
  return { approvalMode, networkAccess, writableRoots }
}
const within = (path: string, root: string) => path === root || path.startsWith(root.replace(/\/$/, '') + '/')

/** Resolve symlinks before comparing grants. No shell evaluates a requested path. */
async function canonical($: EngineInterface, path: string): Promise<string> {
  if (!path.startsWith('/') || /[\0\r\n]/.test(path)) throw new Error('execution paths must be absolute directories')
  const r = await $.process.run(['/bin/sh', '-c', 'cd -P -- "$1" && pwd -P', 'codex-mod-path', path], { timeoutMs: 5000 })
  if (r.exitCode !== 0 || !r.stdout.trim().startsWith('/')) throw new Error(`execution directory unavailable: ${path}`)
  return r.stdout.trim()
}
async function git($: EngineInterface, cwd: string, args: string[]): Promise<string> {
  const r = await $.process.run(['git', '-C', cwd, ...args], { timeoutMs: 5000 })
  if (r.exitCode !== 0) throw new Error(`cannot validate registered worktree: ${cwd}`)
  return r.stdout.trim()
}
const commonArgs = ['rev-parse', '--path-format=absolute', '--git-common-dir']
async function repository($: EngineInterface, cwd: string): Promise<{ commonDir: string; worktreeRoot: string }> {
  const [commonDir, worktreeRoot] = await Promise.all([git($, cwd, commonArgs), git($, cwd, ['rev-parse', '--show-toplevel'])])
  if (!commonDir.startsWith('/') || !worktreeRoot.startsWith('/')) throw new Error(`cannot validate registered worktree: ${cwd}`)
  return { commonDir, worktreeRoot }
}
async function sessionRepository($: EngineInterface, cwd: string): Promise<{ commonDir: string; worktreeRoot: string } | undefined> {
  const probe = await $.process.run(['git', '-C', cwd, ...commonArgs], { timeoutMs: 5000 })
  if (probe.exitCode !== 0) {
    if (probe.exitCode === 128 && /not a git repository/i.test(probe.stderr ?? '')) return undefined
    throw new Error(`cannot validate session cwd Git authority: ${cwd}`)
  }
  const commonDir = probe.stdout.trim(), worktreeRoot = await git($, cwd, ['rev-parse', '--show-toplevel'])
  if (!commonDir.startsWith('/') || !worktreeRoot.startsWith('/')) throw new Error(`invalid session cwd Git authority: ${cwd}`)
  return { commonDir, worktreeRoot }
}
async function registered($: EngineInterface, cwd: string, commonDir: string, worktreeRoot: string): Promise<void> {
  const current = await repository($, cwd)
  const list = await git($, cwd, ['worktree', 'list', '--porcelain'])
  if (current.commonDir !== commonDir || current.worktreeRoot !== worktreeRoot || !list.split('\n').includes(`worktree ${worktreeRoot}`)) throw new Error('saved cwd worktree registration or Git common directory changed')
}
async function cwdGrant($: EngineInterface, owner: ExecutionOwner, cwd: string): Promise<string | undefined> {
  for (const path of owner.allowedCwdRoots) {
    const root = await canonical($, path)
    if (within(cwd, root)) return root
  }
}
async function resolveCwd($: EngineInterface, owner: ExecutionOwner, requested: string | undefined, sessionCwd: string,
  saved?: ExecutionPolicy): Promise<{ cwd: string; cwdAuthority: CwdAuthority }> {
  if (saved) {
    const cwd = await canonical($, saved.cwd)
    if (cwd !== saved.cwd || requested !== undefined && await canonical($, requested) !== cwd) throw new Error('same-thread resume cannot change execution policy or cwd; start a new agent')
    const authority = saved.cwdAuthority
    if (authority.kind === 'owner') {
      if (!await cwdGrant($, owner, cwd)) throw new Error('saved cwd is no longer granted by owner allowedCwdRoots')
    } else {
      if (await canonical($, authority.anchor) !== authority.anchor) throw new Error('saved cwd authorization anchor changed')
      if (authority.kind === 'session' && cwd !== authority.anchor) throw new Error('saved session cwd differs from its authorization anchor')
      if (authority.commonDir && authority.worktreeRoot) {
        await registered($, cwd, authority.commonDir, authority.worktreeRoot)
        if (authority.kind === 'worktree') {
          const parent = await repository($, authority.anchor)
          const list = await git($, authority.anchor, ['worktree', 'list', '--porcelain'])
          if (parent.commonDir !== authority.commonDir || !list.split('\n').includes(`worktree ${cwd}`) || cwd !== authority.worktreeRoot) throw new Error('saved cwd worktree is no longer registered to its original parent repository')
        }
      }
    }
    return { cwd, cwdAuthority: authority }
  }
  const parent = await canonical($, sessionCwd)
  const cwd = requested === undefined ? parent : await canonical($, requested)
  if (cwd === parent) {
    const repo = await sessionRepository($, cwd)
    if (repo) await registered($, cwd, repo.commonDir, repo.worktreeRoot)
    return { cwd, cwdAuthority: { kind: 'session', anchor: parent, ...repo } }
  }
  const root = await cwdGrant($, owner, cwd)
  if (root) return { cwd, cwdAuthority: { kind: 'owner', root } }
  const [a, b] = await Promise.all([repository($, parent), repository($, cwd)])
  const list = await git($, parent, ['worktree', 'list', '--porcelain'])
  if (a.commonDir !== b.commonDir || b.worktreeRoot !== cwd || !list.split('\n').includes(`worktree ${cwd}`)) throw new Error('codex-cwd is not a registered worktree of the parent repository or an owner-allowed directory')
  return { cwd, cwdAuthority: { kind: 'worktree', anchor: parent, ...b } }
}
const validAuthority = (value: unknown): value is CwdAuthority => {
  if (!value || typeof value !== 'object') return false
  const a = value as Record<string, unknown>
  if (a.kind === 'owner') return pathList([a.root])
  if (a.kind !== 'session' && a.kind !== 'worktree' || !pathList([a.anchor])) return false
  if (a.kind === 'worktree') return pathList([a.commonDir, a.worktreeRoot])
  return a.commonDir === undefined && a.worktreeRoot === undefined || pathList([a.commonDir, a.worktreeRoot])
}

export async function resolveExecution($: EngineInterface, owner: ExecutionOwner, request: ExecutionRequest, sessionCwd: string,
  sandbox: string, saved?: ExecutionPolicy, legacy = false): Promise<ExecutionPolicy> {
  if (saved) {
    const { fingerprint, ...value } = saved
    if (saved.version !== 2 || !validAuthority(saved.cwdAuthority)) throw new Error('saved execution cwd authority unavailable; start a new agent rather than guessing its original grant')
    if ( !saved.cwd?.startsWith('/') || !pathList(saved.writableRoots) || typeof saved.networkAccess !== 'boolean' || !['owner', 'launch', 'legacy'].includes(saved.source) || fingerprint !== configHash(value)) throw new Error('saved execution policy is invalid; no resume launched')
  }
  const grants = ownerExecution(owner)
  const allowedModes = new Set(['never', grants.approvalMode, ...owner.allowedApprovalModes])
  const maxSandbox = owner.allowProjectFullAccess ? 2 : sandboxes.indexOf(owner.generic.sandbox)
  const baseline = saved ?? { cwd: sessionCwd, sandbox, approvalMode: legacy ? 'never' as const : grants.approvalMode,
    networkAccess: legacy ? false : grants.networkAccess, writableRoots: legacy ? [] : grants.writableRoots }
  const mode = request.approvalMode ?? baseline.approvalMode
  const effectiveSandbox = request.sandbox ?? baseline.sandbox
  const fullAccess = effectiveSandbox === 'danger-full-access'
  if (!sandboxes.includes(effectiveSandbox)) throw new Error('invalid saved sandbox')
  if (fullAccess && request.networkAccess === false) throw new Error('danger-full-access cannot disable network; request workspace-write or read-only to narrow it')
  if (effectiveSandbox === 'read-only' && request.networkAccess === true) throw new Error('read-only network expansion is unsupported; request an owner-granted workspace-write sandbox')
  const network = fullAccess || effectiveSandbox === 'workspace-write' && (request.networkAccess ?? baseline.networkAccess)
  if (!allowedModes.has(mode)) throw new Error(`approval mode ${mode} is not granted by the owner`)
  if (sandboxes.indexOf(effectiveSandbox) > maxSandbox) throw new Error('requested or saved sandbox exceeds current owner authority')
  if (network && !fullAccess && !grants.networkAccess) throw new Error('network access is not granted by the owner')
  const { cwd, cwdAuthority } = await resolveCwd($, owner, request.cwd, sessionCwd, saved)
  if (effectiveSandbox === 'read-only' && request.writableRoots?.length) throw new Error('read-only sandbox cannot grant writable roots')
  const requestedRoots = effectiveSandbox === 'workspace-write' ? request.writableRoots ?? baseline.writableRoots : []
  let writableRoots: string[] = []
  if (requestedRoots.length) {
    const granted = await Promise.all(grants.writableRoots.map(path => canonical($, path)))
    writableRoots = [...new Set(await Promise.all(requestedRoots.map(path => canonical($, path))))].sort()
    // Naming a protected descendant explicitly can grant more than its parent root.
    if (writableRoots.some(path => !granted.includes(path))) throw new Error('writable root is outside the owner grants: each root must exactly match an explicit canonical owner root; descendant selections are not granted')
  }
  const value = { version: 2 as const, cwdAuthority, cwd, sandbox: effectiveSandbox, approvalMode: mode, networkAccess: network, writableRoots,
    source: saved?.source ?? (legacy ? 'legacy' as const : Object.keys(request).length ? 'launch' as const : 'owner' as const) }
  if (saved && configHash({ ...value, source: saved.source }) !== configHash({ ...saved, fingerprint: undefined })) throw new Error('same-thread resume cannot change execution policy or cwd; start a new agent')
  return { ...value, fingerprint: configHash(value) }
}

export const executionOverrides = (policy: ExecutionPolicy): string[] => [
  `approval_policy="${policy.approvalMode === 'never' ? 'never' : 'on-request'}"`,
  `approvals_reviewer="${policy.approvalMode === 'auto' ? 'auto_review' : 'user'}"`,
  `sandbox_workspace_write.network_access=${policy.networkAccess}`,
  `sandbox_workspace_write.writable_roots=${JSON.stringify(policy.writableRoots)}`,
]

/** Label evidence, not an inferred cause for every failed connection. */
export function permissionEvidence(text: string, policy?: ExecutionPolicy): string | undefined {
  if (!policy) return undefined
  const denied = /(?:EPERM|operation not permitted|permission denied|read-only file system)/i.test(text)
  const network = /(?:could not resolve host|failed to connect|could not connect|error connecting to|connection (?:failed|failure)|network is unreachable|api\.github\.com.*(?:connection|connect))/i.test(text)
  if (!denied && !network) return undefined
  return `${denied ? 'Permission denial evidence' : 'Network failure; sandbox causality unproven'}; policy: sandbox=${policy.sandbox}, approval=${policy.approvalMode}, network=${policy.networkAccess}, cwd=${policy.cwd}, extra roots=${policy.sandbox === 'danger-full-access' ? 'unrestricted filesystem' : policy.writableRoots.length}`
}
