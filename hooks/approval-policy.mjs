// Only one-shot installed-protocol decisions are supported. Session caches,
// policy amendments, special/glob roots and secret grant material stay disabled.
export const APPROVAL_METHODS = new Set(['item/commandExecution/requestApproval', 'item/fileChange/requestApproval', 'item/permissions/requestApproval'])
const object = v => !!v && typeof v === 'object' && !Array.isArray(v)
const string = v => typeof v === 'string' && v.length > 0 && v.length <= 32768
const paths = v => Array.isArray(v) && v.length <= 32 && v.every(p => string(p) && p.startsWith('/') && !/[\0\r\n]/.test(p))
const only = (v, names) => object(v) && Object.keys(v).every(k => names.includes(k))
const fsPermissions = v => v == null || only(v, ['read', 'write', 'entries']) && ['read', 'write'].every(k => v[k] == null || paths(v[k])) &&
  (v.entries == null || Array.isArray(v.entries) && v.entries.length <= 32 && v.entries.every(e => only(e, ['access', 'path']) &&
    ['read', 'write'].includes(e.access) && only(e.path, ['type', 'path']) && e.path.type === 'path' && paths([e.path.path])))
export const permissionProfile = v => only(v, ['network', 'fileSystem']) &&
  (v.network == null || only(v.network, ['enabled']) && (v.network.enabled == null || typeof v.network.enabled === 'boolean')) && fsPermissions(v.fileSystem)
export function approvalRequest(method, params) {
  if (!APPROVAL_METHODS.has(method) || !object(params) || !['threadId', 'turnId', 'itemId'].every(k => string(params[k])) || !Number.isFinite(params.startedAtMs)) return false
  if (method === 'item/commandExecution/requestApproval') return (params.command == null || typeof params.command === 'string') &&
    (params.approvalId == null || string(params.approvalId)) && (params.kind === undefined || ['command', 'writeStdin'].includes(params.kind)) &&
    (params.availableDecisions == null || Array.isArray(params.availableDecisions))
  // A grantRoot requests session authority whose one-shot meaning is unstable.
  if (method === 'item/fileChange/requestApproval') return params.grantRoot == null
  return string(params.cwd) && permissionProfile(params.permissions)
}
export function approvalIdentity(q) {
  return { method: q.method, token: q.token, requestId: q.requestId ?? q.id, threadId: q.params.threadId, turnId: q.params.turnId,
    itemId: q.params.itemId, approvalId: q.params.approvalId ?? null, kind: q.params.kind ?? null }
}
export const matchesApproval = (q, body) => Object.entries(approvalIdentity(q)).every(([k, v]) => body[k] === v)
const subset = (granted, requested) => granted == null || Array.isArray(granted) && granted.every(p => (requested ?? []).includes(p))
export function permissionSubset(requested, granted) {
  if (!permissionProfile(requested) || !permissionProfile(granted)) return false
  if (granted.network?.enabled === true && requested.network?.enabled !== true) return false
  const fs = granted.fileSystem, source = requested.fileSystem
  if (!fs) return true
  if (!subset(fs.read, source?.read) || !subset(fs.write, source?.write)) return false
  return fs.entries == null || fs.entries.every(e => (source?.entries ?? []).some(r => JSON.stringify(e) === JSON.stringify(r)))
}
export function approvalResponse(q, body, fileChanges, commandContext) {
  if (!matchesApproval(q, body) || !['accept', 'decline', 'cancel'].includes(body.decision)) return undefined
  if (q.method === 'item/commandExecution/requestApproval' && body.decision === 'accept') {
    const context = commandContext ?? commandApprovalContext(q)
    if (!context || context.source === 'item' && JSON.stringify(body.commandContext) !== JSON.stringify(context) ||
        body.commandContext !== undefined && JSON.stringify(body.commandContext) !== JSON.stringify(context)) return undefined
  }
  if (q.method === 'item/fileChange/requestApproval' && body.decision === 'accept' &&
      (!fileChanges || !matchesApproval(q, fileChanges.identity ?? {}) || JSON.stringify(body.fileChanges) !== JSON.stringify(fileChanges))) return undefined
  if (q.method !== 'item/permissions/requestApproval') {
    if (body.permissions !== undefined || body.scope !== undefined) return undefined
    const available = q.params.availableDecisions
    if (Array.isArray(available) && !available.includes(body.decision)) return undefined
    return { result: { decision: body.decision } }
  }
  if (body.scope !== undefined && body.scope !== 'turn') return undefined
  if (body.decision === 'accept') {
    const permissions = body.permissions ?? q.params.permissions
    if (!permissionSubset(q.params.permissions, permissions)) return undefined
    return { result: { permissions, scope: 'turn' } }
  }
  if (body.permissions !== undefined) return undefined
  return { result: { permissions: {}, scope: 'turn' } }
}

export const FILE_APPROVAL_MAX = 32768
export const FILE_APPROVAL_UNAVAILABLE = 'Exact proposed file changes are missing, stale, empty, incomplete or exceed the 32-file or 32768-character display limit; acceptance disabled. Decline or cancel remains available.'
/** Read only the exact owned in-progress source item. Never reconstruct a patch from a reason. */
export function fileApprovalEvidence(q, source) {
  const item = source?.item
  if (q.method !== 'item/fileChange/requestApproval' || !source || source.threadId !== q.params.threadId || source.turnId !== q.params.turnId ||
      source.itemId !== q.params.itemId || item?.id !== q.params.itemId || item.type !== 'fileChange' || item.status !== 'inProgress' ||
      !['item.started', 'item/started', 'item/fileChange/patchUpdated'].includes(source.event) || !Array.isArray(item.changes) || !item.changes.length || item.changes.length > 32) return undefined
  const changes = []
  for (const change of item.changes) {
    const kind = typeof change?.kind === 'string' ? { type: change.kind } : change?.kind
    if (!string(change?.path) || !object(kind) || !['add', 'update', 'delete'].includes(kind.type) || typeof change.diff !== 'string' ||
        kind.move_path != null && !string(kind.move_path) || kind.type === 'update' && !change.diff && !kind.move_path) return undefined
    changes.push({ path: change.path, kind: { ...kind }, diff: change.diff })
  }
  const evidence = { identity: approvalIdentity(q), cwd: source.cwd, item: { id: item.id, type: 'fileChange', status: 'inProgress', changes } }
  const text = JSON.stringify(evidence)
  // Reject oversized proposals in full; never show a truncated patch beside an accept button.
  return text.length <= FILE_APPROVAL_MAX ? JSON.parse(text) : undefined
}
export const COMMAND_APPROVAL_UNAVAILABLE = 'Actionable command, stdin payload or network destination context is unavailable; acceptance disabled. Original command text cannot establish pending stdin bytes.'
export function commandApprovalContext(q, source) {
  if (q.method !== 'item/commandExecution/requestApproval') return undefined
  const identity = approvalIdentity(q), kind = q.params.kind ?? 'command'
  const network = q.params.networkApprovalContext
  const destination = object(network) && string(network.host) && ['http', 'https', 'socks5Tcp', 'socks5Udp'].includes(network.protocol)
    ? { host: network.host, protocol: network.protocol } : undefined
  let context
  if (string(q.params.command) && q.params.command.trim()) context = { identity, source: 'request', kind, command: q.params.command, ...(destination ? { network: destination } : {}) }
  else if (kind === 'writeStdin') return undefined
  else if (destination) context = { identity, source: 'request', kind: 'network', network: destination }
  else {
    const item = source?.item
    if (!source || source.threadId !== q.params.threadId || source.turnId !== q.params.turnId || source.itemId !== q.params.itemId ||
        item?.id !== q.params.itemId || item.type !== 'commandExecution' || item.status !== 'inProgress' || !string(item.command) || !item.command.trim() ||
        !['item.started', 'item/started'].includes(source.event)) return undefined
    context = { identity, source: 'item', kind: 'command', command: item.command, cwd: source.cwd }
  }
  const text = JSON.stringify(context)
  return text.length <= FILE_APPROVAL_MAX ? JSON.parse(text) : undefined
}
const activeStatus = new Set(['pending', 'running', 'waiting', 'idle'])
const activeAgent = value => object(value) && string(value.id) && string(value.type) && string(value.description) && value.id.trim() && value.type.trim() && value.description.trim() && activeStatus.has(value.status)

/** Host identity, never source text, binds who may inspect and decide a request. */
export function approvalParent(list, agentId, isCodex) {
  if (!Array.isArray(list)) return undefined
  const info = list.find(a => a?.id === agentId)
  if (!activeAgent(info)) return undefined
  // Installed AgentInfo documents an absent parentId for a main-loop launch.
  if (info.parentId == null) return { main: true, sourceId: info.id }
  if (!string(info.parentId)) return undefined
  const parent = list.find(a => a?.id === info.parentId)
  if (!activeAgent(parent) || isCodex(parent)) return undefined
  return { agentId: parent.id, sourceId: info.id }
}
export function parentMayDecide(parent, caller, list, isCodex) {
  if (!parent || !Array.isArray(list) || !string(parent.sourceId)) return false
  const current = approvalParent(list, parent.sourceId, isCodex)
  if (!current || JSON.stringify(current) !== JSON.stringify(parent)) return false
  if (parent.main) return caller === undefined
  if (caller !== parent.agentId) return false
  const info = list.find(a => a?.id === caller)
  return activeAgent(info) && !isCodex(info)
}
