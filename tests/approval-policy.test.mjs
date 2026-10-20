import assert from 'node:assert/strict'
import { test } from 'node:test'
import { approvalRequest, approvalIdentity, approvalResponse, matchesApproval, permissionSubset, approvalParent, parentMayDecide, fileApprovalEvidence, FILE_APPROVAL_MAX, commandApprovalContext } from '../hooks/approval-policy.mjs'
const params = { threadId: 'thread', turnId: 'turn', itemId: 'item', startedAtMs: 1, command: 'exact command', approvalId: 'callback', kind: 'writeStdin' }
const command = { method: 'item/commandExecution/requestApproval', id: 41, token: 'token', params }
const response = (q, extra = {}) => ({ ...approvalIdentity(q), decision: 'accept', ...extra })

test('one-shot command approval binds method, RPC, callback, stdin kind and lifecycle identity', () => {
  assert.ok(approvalRequest(command.method, params))
  assert.deepEqual(approvalResponse(command, response(command)), { result: { decision: 'accept' } })
  for (const key of Object.keys(approvalIdentity(command))) {
    assert.equal(matchesApproval(command, { ...response(command), [key]: 'foreign' }), false, key)
    assert.equal(approvalResponse(command, { ...response(command), [key]: 'foreign' }), undefined, key)
  }
  for (const decision of ['acceptForSession', { acceptWithExecpolicyAmendment: { execpolicy_amendment: ['git'] } }, 'allow']) assert.equal(approvalResponse(command, response(command, { decision })), undefined)
  assert.equal(approvalResponse({ ...command, params: { ...params, availableDecisions: ['decline', 'cancel'] } }, response(command)), undefined)
  for (const decision of ['decline', 'cancel']) assert.deepEqual(approvalResponse(command, response(command, { decision })), { result: { decision } })
  assert.equal(approvalRequest(command.method, { ...params, kind: 'unknown' }), false)
  assert.equal(approvalRequest('unknown/requestApproval', params), false)
})

test('file approval is one-shot and rejects unstable session-root requests', () => {
  const q = { ...command, method: 'item/fileChange/requestApproval', params: { threadId: 'thread', turnId: 'turn', itemId: 'file', startedAtMs: 2 } }
  assert.ok(approvalRequest(q.method, q.params))
  assert.equal(approvalResponse(q, response(q)), undefined)
  const evidence = fileApprovalEvidence(q, fileSource(q))
  assert.deepEqual(approvalResponse(q, response(q, { fileChanges: evidence }), evidence), { result: { decision: 'accept' } })
  assert.equal(approvalRequest(q.method, { ...q.params, grantRoot: '/repo' }), false)
})

test('permission approvals grant only requested literal subsets for this turn', () => {
  const permissions = { network: { enabled: true }, fileSystem: { read: ['/one'], write: ['/two'], entries: [{ access: 'read', path: { type: 'path', path: '/three' } }] } }
  const q = { ...command, method: 'item/permissions/requestApproval', params: { threadId: 'thread', turnId: 'turn', itemId: 'perms', startedAtMs: 1, cwd: '/repo', permissions } }
  assert.ok(approvalRequest(q.method, q.params))
  assert.deepEqual(approvalResponse(q, response(q)), { result: { permissions, scope: 'turn' } })
  assert.deepEqual(approvalResponse(q, response(q, { permissions: { fileSystem: { write: ['/two'] } } })), { result: { permissions: { fileSystem: { write: ['/two'] } }, scope: 'turn' } })
  for (const grant of [{ fileSystem: { write: ['/'] } }, { fileSystem: { write: ['/two/../other'] } }, { network: { enabled: true }, extra: true }]) assert.equal(permissionSubset({}, grant), false)
  assert.equal(approvalResponse(q, response(q, { scope: 'session' })), undefined)
  assert.equal(approvalResponse(q, response(q, { permissions: { fileSystem: { entries: [{ access: 'write', path: { type: 'special', value: { kind: 'root' } } }] } } })), undefined)
  for (const decision of ['decline', 'cancel']) assert.deepEqual(approvalResponse(q, response(q, { decision })), { result: { permissions: {}, scope: 'turn' } })
  assert.equal(approvalRequest(q.method, { ...q.params, permissions: { fileSystem: { entries: [{ access: 'write', path: { type: 'glob_pattern', pattern: '*' } }] } } }), false)
})

const isCodex = a => a.type.startsWith('codex-mod:')
test('delegated authority uses a complete authoritative source entry and exact immediate Claude parent', () => {
  const source = { id: 'source', type: 'codex-mod:codex', description: 'Source task', status: 'running' }
  assert.deepEqual(approvalParent([source], 'source', isCodex), { main: true, sourceId: 'source' })
  assert.ok(parentMayDecide({ main: true, sourceId: 'source' }, undefined, [source], isCodex))
  assert.equal(approvalParent([{ id: 'source', type: source.type }], 'source', isCodex), undefined)
  assert.equal(approvalParent([], 'source', isCodex), undefined)
  assert.equal(approvalParent(undefined, 'source', isCodex), undefined)
  assert.equal(parentMayDecide({ main: true, sourceId: 'source' }, 'source', [source], isCodex), false)
  const claude = { id: 'parent', type: 'general-purpose', description: 'Claude parent', status: 'running' }
  const sibling = { id: 'sibling', type: 'general-purpose', description: 'Claude sibling', status: 'running' }
  const list = [{ ...source, parentId: 'parent' }, claude, sibling]
  const bound = approvalParent(list, 'source', isCodex)
  assert.deepEqual(bound, { agentId: 'parent', sourceId: 'source' })
  assert.ok(parentMayDecide(bound, 'parent', list, isCodex))
  for (const caller of [undefined, 'source', 'sibling', 'mirror']) assert.equal(parentMayDecide(bound, caller, list, isCodex), false)
  for (const type of ['codex-mod:codex', 'codex-mod:codex-child', 'codex-mod:implementer']) {
    const changed = list.map(a => a.id === 'parent' ? { ...a, type } : a)
    assert.equal(approvalParent(changed, 'source', isCodex), undefined)
    assert.equal(parentMayDecide(bound, 'parent', changed, isCodex), false)
  }
  assert.equal(parentMayDecide(bound, 'parent', list.map(a => a.id === 'parent' ? { ...a, status: 'completed' } : a), isCodex), false)
  assert.equal(parentMayDecide(bound, 'parent', undefined, isCodex), false)
})

function fileSource(q, changes = [{ path: '/repo/exact.txt', kind: { type: 'update' }, diff: '@@ -1 +1 @@\n-old\n+exact\n' }]) {
  return { threadId: q.params.threadId, turnId: q.params.turnId, itemId: q.params.itemId, event: 'item.started', cwd: '/repo',
    item: { id: q.params.itemId, type: 'fileChange', status: 'inProgress', changes } }
}
test('file acceptance requires the exact bounded current proposal and request identity', () => {
  const q = { ...command, method: 'item/fileChange/requestApproval', params: { threadId: 'thread', turnId: 'turn', itemId: 'file', startedAtMs: 2 } }
  const source = fileSource(q), shown = fileApprovalEvidence(q, source)
  assert.equal(shown.item.changes[0].diff, source.item.changes[0].diff)
  assert.deepEqual(shown.identity, approvalIdentity(q))
  for (const mutation of [{ threadId: 'other' }, { turnId: 'old-turn' }, { itemId: 'competing' },
    { item: { ...source.item, id: 'competing' } }, { item: { ...source.item, status: 'completed' } }, { event: 'item.completed' }]) {
    assert.equal(fileApprovalEvidence(q, { ...source, ...mutation }), undefined)
  }
  for (const changes of [[], [{ path: '/repo/noop', kind: { type: 'update' }, diff: '' }], [{ path: '/repo/opaque', kind: { type: 'update' } }],
    [{ path: '/repo/large', kind: { type: 'add' }, diff: 'x'.repeat(FILE_APPROVAL_MAX) }]]) assert.equal(fileApprovalEvidence(q, fileSource(q, changes)), undefined)
  const current = fileApprovalEvidence(q, fileSource(q, [{ path: '/repo/exact.txt', kind: { type: 'delete' }, diff: '-changed' }]))
  assert.equal(approvalResponse(q, response(q, { fileChanges: shown }), current), undefined)
  assert.equal(approvalResponse(q, response(q, { fileChanges: { ...shown, identity: { ...shown.identity, token: 'other' } } }), shown), undefined)
  for (const decision of ['decline', 'cancel']) assert.deepEqual(approvalResponse(q, response(q, { decision })), { result: { decision } })
})
test('command context may use only an exact pending command item; stdin bytes are never inferred', () => {
  const q = { ...command, params: { ...params, command: null, kind: 'command' } }
  const source = { threadId: 'thread', turnId: 'turn', itemId: 'item', event: 'item.started', cwd: '/repo',
    item: { id: 'item', type: 'commandExecution', status: 'inProgress', command: 'exact pending command' } }
  assert.equal(approvalResponse(q, response(q)), undefined)
  const context = commandApprovalContext(q, source)
  assert.equal(context.command, 'exact pending command')
  assert.equal(approvalResponse(q, response(q), undefined, context), undefined)
  assert.deepEqual(approvalResponse(q, response(q, { commandContext: context }), undefined, context), { result: { decision: 'accept' } })
  assert.equal(commandApprovalContext({ ...q, params: { ...q.params, kind: 'writeStdin' } }, source), undefined)
  assert.equal(commandApprovalContext(q, { ...source, itemId: 'competing' }), undefined)
  assert.equal(commandApprovalContext(q, { ...source, item: { ...source.item, status: 'completed' } }), undefined)
  const network = { ...q, params: { ...q.params, networkApprovalContext: { host: 'api.example.test', protocol: 'https' } } }
  assert.deepEqual(commandApprovalContext(network).network, { host: 'api.example.test', protocol: 'https' })
  assert.equal(commandApprovalContext(network).kind, 'network')
  for (const decision of ['decline', 'cancel']) assert.deepEqual(approvalResponse(q, response(q, { decision })), { result: { decision } })
})
test('parent authority rejects malformed or inactive source and parent records, including main callers', () => {
  const source = { id: 'source', type: 'codex-mod:codex', description: 'Source task', status: 'running' }
  const main = approvalParent([source], 'source', isCodex)
  assert.deepEqual(main, { main: true, sourceId: 'source' })
  for (const status of ['pending', 'running', 'waiting', 'idle']) assert.ok(approvalParent([{ ...source, status }], 'source', isCodex))
  for (const bad of [{ status: undefined }, { status: 'future' }, { status: 'completed' }, { description: undefined }, { description: 2 }, { description: '' }, { type: '' }]) {
    assert.equal(approvalParent([{ ...source, ...bad }], 'source', isCodex), undefined)
    assert.equal(parentMayDecide(main, undefined, [{ ...source, ...bad }], isCodex), false)
  }
  const parent = { id: 'parent', type: 'general-purpose', description: 'Claude task', status: 'waiting' }
  const list = [{ ...source, parentId: 'parent' }, parent]
  const bound = approvalParent(list, 'source', isCodex)
  assert.ok(parentMayDecide(bound, 'parent', list, isCodex))
  for (const bad of [{ status: undefined }, { status: 'unknown' }, { status: 'completed' }, { description: undefined }, { description: 2 }, { description: '' }]) {
    const changed = [list[0], { ...parent, ...bad }]
    assert.equal(approvalParent(changed, 'source', isCodex), undefined)
    assert.equal(parentMayDecide(bound, 'parent', changed, isCodex), false)
  }
  assert.equal(parentMayDecide(bound, 'parent', [list[0]], isCodex), false)
})
