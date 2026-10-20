// Fake `codex app-server` for tests/runner.test.mjs. Launched by the runner
// through `--codex <this file>` (a .mjs --codex is run with process.execPath).
// FAKE_SCENARIO picks the behaviour, FAKE_LOG is a JSONL file where every
// client message is recorded so tests can assert what the runner sent.
import { appendFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, resolve, sep } from 'node:path'
import { createInterface } from 'node:readline'
import batch4Items from './batch4-items.mjs'
import batch5Items from './batch5-items.mjs'
import batch6Items, { PNG, questionParams } from './batch6-items.mjs'
import { PARENT, CHILD, PARENT_TURN, CHILD_TURN, nestedCommand, nestedFile, nestedActivity, nestedUsage } from './nested-items.mjs'

// Scenarios: normal, slow (completes after 1.5 s), instant (turn/start reply
// and the whole turn in ONE stdout write), steer / steer-reject / hang / deaf
// (wait for a steer or interrupt; deaf never completes after turn/interrupt),
// slow-start[-deaf] (turn/start answered after 500 ms, then as hang / deaf),
// approval, malformed, unknown, die, legacy.
const scenario = process.env.FAKE_SCENARIO ?? 'normal'
if (process.argv.includes('--version')) { process.stdout.write('codex-cli 0.163.0 (fake)\n'); process.exit(0) }
if (process.argv.includes('--help')) { process.stdout.write('fake codex app-server\n'); process.exit(0) }
if (process.argv.includes('login')) { process.stdout.write('fixture: no authentication required\n'); process.exit(0) }
const log = m => process.env.FAKE_LOG && appendFileSync(process.env.FAKE_LOG, JSON.stringify(m) + '\n')
let batch // when set, `out` collects lines for one write
const out = o => {
  const line = JSON.stringify(o) + '\n'
  if (batch !== undefined) batch.push(line)
  else process.stdout.write(line)
}
const note = (method, params) => out({ method, params })
let THREAD = scenario.startsWith('nested-') ? PARENT : 'thr-1'
const TURN = scenario.startsWith('nested-') ? PARENT_TURN : 'turn-1'
let turnActive = false
let childActive = false
let childAttached = false
const childNote = (method, params) => note(method, { threadId: CHILD, turnId: CHILD_TURN, ...params })
const extraChildren = new Map([
  ['55555555-5555-4555-8555-555555555555', { parent: CHILD, turn: '77777777-7777-4777-8777-777777777777', active: true }],
  ['66666666-6666-4666-8666-666666666666', { parent: PARENT, turn: '88888888-8888-4888-8888-888888888888', active: true }],
])
const childComplete = (status = 'completed') => {
  if (!childActive) return
  childActive = false
  childNote('item/completed', { item: { type: 'agentMessage', id: 'child-final', text: 'child checked the fixture' } })
  for (let i = 0; i < 2; i++) {
    childNote('turn/completed', { turn: { id: CHILD_TURN, rootTurnId: PARENT_TURN, status, error: status === 'failed' ? { message: 'child failed' } : null } })
    if (scenario === 'nested-replayed-terminal' && i === 0) {
      // A duplicate start after a real terminal must not reactivate dedup.
      childNote('turn/started', { turn: { id: CHILD_TURN, rootTurnId: PARENT_TURN, status: 'inProgress' } })
    }
  }
  if (scenario !== 'nested-response-only') setTimeout(() => childNote('thread/tokenUsage/updated', { tokenUsage: nestedUsage(2000, 1500, 100) }), 20)
}
const childWork = () => {
  if (scenario === 'nested-early') note('thread/started', { thread: { id: CHILD, parentThreadId: PARENT, model: 'gpt-6.1-sol' } })
  childNote('turn/started', { turn: { id: CHILD_TURN, rootTurnId: PARENT_TURN, status: 'inProgress' } })
  if (scenario === 'nested-tree-controls') for (const [id, child] of extraChildren) note('item/completed', {
    threadId: child.parent, turnId: child.parent === CHILD ? CHILD_TURN : PARENT_TURN,
    item: { ...nestedActivity, id: `spawn-${id}`, agentThreadId: id },
  })
  childNote('item/completed', { item: nestedCommand })
  childNote('item/completed', { item: nestedCommand })
  childNote('item/commandExecution/outputDelta', { itemId: nestedCommand.id, delta: 'child' })
  childNote('item/started', { item: { ...nestedFile, status: 'inProgress' } })
  childNote('item/completed', { item: nestedFile })
  if (scenario === 'nested-large-journal') {
    for (let i = 0; i < 6; i++) childNote('item/completed', { item: { type: 'agentMessage', id: `large-${i}`, text: 'á😀'.repeat(180000) } })
  }
  const numeric = { threadId: CHILD, turnId: CHILD_TURN, responseId: 'child-response-1', rootTurnId: PARENT_TURN, usage: nestedUsage(2000, 1500, 100).total }
  note('rawResponse/completed', numeric)
  note('rawResponse/completed', numeric)
  if (scenario !== 'nested-response-only') {
    childNote('thread/tokenUsage/updated', { tokenUsage: nestedUsage(2000, 1500, 100) })
    childNote('thread/tokenUsage/updated', { tokenUsage: nestedUsage(2000, 1500, 100) })
  }
  if (!['nested-controls', 'nested-tree-controls'].includes(scenario)) setTimeout(() => childComplete(scenario === 'nested-failure' ? 'failed' : 'completed'), Number(process.env.FAKE_CHILD_DELAY_MS ?? 350))
}
let reqId = 100
const usage = (i, c, o) => ({ total: { totalTokens: i + o, inputTokens: i, cachedInputTokens: c, cacheWriteInputTokens: 0, outputTokens: o, reasoningOutputTokens: 0 }, last: { totalTokens: 10, inputTokens: 8, cachedInputTokens: 2, cacheWriteInputTokens: 0, outputTokens: 2, reasoningOutputTokens: 0 }, modelContextWindow: null })

const complete = status => {
  if (!turnActive) return
  turnActive = false
  note('turn/completed', { threadId: THREAD, turn: { id: TURN, status, error: status === 'failed' ? { message: 'boom' } : null,
    items: scenario === 'batch1-wire' ? [{ type: 'reasoning', id: 'snapshot-reasoning', summary: ['Public snapshot summary'], content: ['PRIVATE_RAW_REASONING'] }] : [] } })
}
const work = () => {
  note('turn/started', { threadId: THREAD, turn: { id: TURN, status: 'inProgress' } })
  note('thread/tokenUsage/updated', { threadId: THREAD, turnId: TURN, tokenUsage: usage(1000, 100, 50) })
  note('item/completed', { threadId: THREAD, turnId: TURN, item: { type: 'commandExecution', id: 'c1', command: 'ls', aggregatedOutput: 'a\n', exitCode: 0, status: 'completed' } })
  note('item/started', { threadId: THREAD, turnId: TURN, item: { type: 'fileChange', id: 'f1', changes: [{ path: '/x/a.txt', kind: { type: 'add' }, diff: '' }], status: 'inProgress' } })
  note('item/completed', { threadId: THREAD, turnId: TURN, item: { type: 'fileChange', id: 'f1', changes: [{ path: '/x/a.txt', kind: { type: 'add' }, diff: '' }, { path: '/x/b.txt', kind: { type: 'update', move_path: null }, diff: '' }], status: 'completed' } })
  // another turn's noise must be dropped
  note('item/completed', { threadId: THREAD, turnId: 'other', item: { type: 'agentMessage', id: 'z', text: 'WRONG' } })
  note('thread/tokenUsage/updated', { threadId: THREAD, turnId: TURN, tokenUsage: usage(1500, 300, 80) })
}
const finishNormally = () => {
  note('item/completed', { threadId: THREAD, turnId: TURN, item: { type: 'agentMessage', id: 'm1', text: 'all done' } })
  complete('completed')
}

const batch3Patches = async () => {
  const items = JSON.parse(readFileSync(new URL('./batch3-app-items.json', import.meta.url), 'utf8'))
  const images = JSON.parse(readFileSync(new URL('./batch3-images.json', import.meta.url), 'utf8'))
  // Optional fake-Codex mutations are confined to the explicitly supplied fixture root.
  // Guards never write these files; without this opt-in the fake only emits evidence.
  const root = process.env.FAKE_PATCH_ROOT && resolve(process.env.FAKE_PATCH_ROOT)
  const pathInRoot = path => {
    const target = resolve(root, path)
    if (!target.startsWith(root + sep)) throw new Error('fixture path escapes FAKE_PATCH_ROOT')
    return target
  }
  const writeImage = (path, content) => {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, content)
  }
  for (const template of items) {
    if (!turnActive) return
    const item = { ...template, changes: template.changes.map(c => root ? { ...c, path: pathInRoot(c.path),
      kind: { ...c.kind, ...(c.kind.move_path ? { move_path: pathInRoot(c.kind.move_path) } : {}) } } : c) }
    const image = images[item.id] ?? {}
    if (root && image.before !== undefined) writeImage(item.changes[0].path, image.before)
    note('item/started', { threadId: THREAD, turnId: TURN, item: { ...item, status: 'inProgress' } })
    if (root) await new Promise(r => setTimeout(r, Number(process.env.FAKE_PATCH_DELAY_MS ?? 250)))
    if (!turnActive) return
    note('item/fileChange/patchUpdated', { threadId: THREAD, turnId: TURN, itemId: item.id, changes: item.changes })
    if (root) {
      const c = item.changes[0]
      if (image.after !== undefined) writeImage(c.kind.move_path ?? c.path, image.after)
      if (c.kind.type === 'delete' || (c.kind.move_path && image.after !== undefined)) rmSync(c.path, { force: true })
    }
    const completed = item.id === 'patch-updated' ? { ...item, changes: [] } : item
    note('item/completed', { threadId: THREAD, turnId: TURN, item: completed })
    note('item/completed', { threadId: THREAD, turnId: TURN, item: completed })
    note('turn/diff/updated', { threadId: THREAD, turnId: TURN, diff: 'aggregate evidence only' })
  }
  finishNormally()
}

createInterface({ input: process.stdin }).on('line', line => {
  const m = JSON.parse(line)
  log(m)
  const reply = result => out({ id: m.id, result })
  if (m.id !== undefined && m.method === undefined) {
    if (scenario.startsWith('capability-approval') && m.id === 701) {
      if (scenario.endsWith('-cancel') && m.result?.decision === 'cancel') return complete('interrupted')
      return finishNormally()
    }
    if (scenario.startsWith('batch6-question') && m.id === 201) finishNormally()
    return
  }
  const extraChild = scenario === 'nested-tree-controls' && extraChildren.get(m.params?.threadId)
  if (extraChild) {
    const id = m.params.threadId
    if (m.method === 'thread/resume') {
      reply({ thread: { id, parentThreadId: extraChild.parent, historyMode: 'paginated' } })
      setTimeout(() => note('turn/started', { threadId: id, turn: { id: extraChild.turn, rootTurnId: PARENT_TURN, status: 'inProgress' } }), 10)
      return
    }
    if (m.method === 'thread/turns/list') return reply({ data: [{ id: extraChild.turn, rootTurnId: PARENT_TURN, status: 'inProgress' }], nextCursor: null })
    if (m.method === 'thread/items/list') return reply({ data: [], nextCursor: null })
    if (m.method === 'thread/unsubscribe') return reply({})
    if (m.method === 'turn/start') throw new Error('duplicate descendant execution')
    if (m.method === 'turn/interrupt') {
      reply({})
      if (extraChild.active) {
        extraChild.active = false
        setTimeout(() => note('turn/completed', { threadId: id, turn: { id: extraChild.turn, status: 'interrupted' } }), 10)
      }
      return
    }
  }
  switch (m.method) {
    case 'initialize':
      if (scenario === 'legacy') return out({ id: m.id, error: { code: -32601, message: 'Method not found' } })
      return reply({ userAgent: 'codex-cli/9.9.9 (fake)' })
    case 'thread/start':
    case 'thread/resume':
      if (scenario.startsWith('nested-') && m.params.threadId === CHILD) {
        if (m.method !== 'thread/resume' || Object.keys(m.params).some(k => !['threadId', 'excludeTurns'].includes(k))) throw new Error('duplicate child execution or override')
        if (scenario === 'nested-rejoin-failure') return out({ id: m.id, error: { code: -32601, message: 'child rejoin unavailable' } })
        if (childAttached) throw new Error('child attached twice')
        childAttached = true
        reply({ thread: { id: CHILD, parentThreadId: scenario === 'nested-ancestry' ? CHILD : PARENT, historyMode: scenario === 'nested-history-mode' ? 'unknown' : 'paginated', model: 'gpt-6.1-sol' } })
        if (!['nested-early', 'nested-replayed-terminal', 'nested-history-terminal'].includes(scenario)) setTimeout(childWork, 30)
        return
      }
      THREAD = m.params.threadId ?? THREAD
      return reply({ thread: { id: THREAD } })
    case 'thread/turns/list':
      return reply({ data: [{ id: CHILD_TURN, rootTurnId: PARENT_TURN,
        status: ['nested-replayed-terminal', 'nested-history-terminal'].includes(scenario) ? 'interrupted' : 'inProgress',
        ...(scenario === 'nested-replayed-terminal' ? { completedAt: null } : {}), items: [] }], nextCursor: null })
    case 'thread/items/list':
      // Publish live evidence before the history response, deterministically
      // buffering the same-ID start while the interrupted snapshot is merged.
      if (scenario === 'nested-replayed-terminal' && !m.params.cursor) childWork()
      return reply({ data: m.params.cursor ? [] : [{ turnId: CHILD_TURN, item: nestedCommand, startedAtMs: 1, completedAtMs: 2 }], nextCursor: m.params.cursor ? null : 'page-2' })
    case 'thread/unsubscribe':
      return reply({ status: 'unsubscribed' })
    case 'turn/start':
      if (scenario.startsWith('cache-')) {
        reply({ turn: { id: TURN, status: 'inProgress' } })
        turnActive = true
        note('turn/started', { threadId: THREAD, turn: { id: TURN, status: 'inProgress' } })
        if (scenario === 'cache-capacity' && m.params.model === 'gpt-6.1-sol') {
          turnActive = false
          note('turn/completed', { threadId: THREAD, turn: { id: TURN, status: 'failed', error: { message: 'Selected model is at capacity. Please try a different model.' } } })
          return
        }
        const token = (total, last) => note('thread/tokenUsage/updated', { threadId: THREAD, turnId: TURN, tokenUsage: { total, last } })
        const before = { inputTokens: 5000, cachedInputTokens: 4000, outputTokens: 500 }
        const first = { inputTokens: 6000, cachedInputTokens: 4600, outputTokens: 550 }
        const last = { inputTokens: 1000, cachedInputTokens: 600, outputTokens: 50 }
        token(before, { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 })
        // A stale notification bound to another turn must never enter this ledger.
        note('thread/tokenUsage/updated', { threadId: THREAD, turnId: 'stale', tokenUsage: nestedUsage(999999, 900000, 9000) })
        if (scenario === 'cache-missing-last') token(first, undefined)
        else token(first, last)
        for (let i = 0; i < 2; i++) note('rawResponse/completed', { threadId: THREAD, turnId: TURN, responseId: 'cache-response', usage: last })
        token(first, last)
        note('item/completed', { threadId: THREAD, turnId: TURN, item: { type: 'agentMessage', id: 'cache-final', text: 'cache fixture done' } })
        return complete(scenario === 'cache-interrupt' ? 'interrupted' : 'completed')
      }
      if (scenario.startsWith('nested-')) {
        if (m.params.threadId !== PARENT) throw new Error('duplicate source child turn/start')
        reply({ turn: { id: TURN, status: 'inProgress' } })
        turnActive = true
        childActive = true
        note('turn/started', { threadId: PARENT, turn: { id: TURN, status: 'inProgress' } })
        note('thread/tokenUsage/updated', { threadId: PARENT, turnId: TURN, tokenUsage: nestedUsage(1000, 600, 50) })
        if (scenario === 'nested-early') childWork()
        if (scenario !== 'nested-collab-only') note('item/completed', { threadId: PARENT, turnId: TURN, item: nestedActivity })
        if (['nested-both', 'nested-collab-only'].includes(scenario)) note('item/completed', { threadId: PARENT, turnId: TURN,
          item: { type: 'collabAgentToolCall', id: 'collab-spawn', tool: 'spawnAgent', status: 'completed', senderThreadId: PARENT, receiverThreadIds: [CHILD], prompt: 'check fixture', agentsStates: { [CHILD]: { status: 'running' } } } })
        setTimeout(() => {
          note('item/completed', { threadId: PARENT, turnId: TURN, item: { type: 'agentMessage', id: 'parent-final', text: 'parent done' } })
          complete('completed')
        }, 80)
        return
      }
      if (scenario === 'die') {
        process.stderr.write('fake fatal: no auth\n')
        process.exit(3)
      }
      if (scenario === 'instant') {
        // reply, the turn and its completion reach the runner in one chunk
        batch = []
        reply({ turn: { id: TURN, status: 'inProgress' } })
        turnActive = true
        work()
        finishNormally()
        process.stdout.write(batch.join(''))
        batch = undefined
        return
      }
      if (scenario.startsWith('slow-start')) {
        setTimeout(() => {
          reply({ turn: { id: TURN, status: 'inProgress' } })
          turnActive = true
          work()
        }, 500)
        return
      }
      reply({ turn: { id: TURN, status: 'inProgress' } })
      turnActive = true
      if (scenario.startsWith('steer-v2-')) {
        note('turn/started', { threadId: THREAD, turn: { id: TURN, status: 'inProgress' } })
        return
      }
      if (scenario === 'batch6-images-modes') {
        const root = process.env.FAKE_IMAGE_ROOT && resolve(process.env.FAKE_IMAGE_ROOT)
        if (root) {
          mkdirSync(resolve(root, 'batch6'), { recursive: true })
          for (const name of ['view.png', 'generated.png']) writeFileSync(resolve(root, 'batch6', name), Buffer.from(PNG, 'base64'))
          writeFileSync(resolve(root, 'batch6/vector.svg'), '<svg/>')
        }
        note('configWarning', { threadId: THREAD, summary: 'Configuration warning: ignored optional setting' })
        note('error', { threadId: THREAD, turnId: TURN, willRetry: true, error: { message: 'Retryable warning' } })
        note('thread/compacted', { threadId: THREAD, turnId: TURN })
        for (const template of batch6Items) {
          const item = { ...template, ...(root && template.path ? { path: resolve(root, template.path) } : {}), ...(root && template.savedPath ? { savedPath: resolve(root, template.savedPath) } : {}) }
          note('item/completed', { threadId: THREAD, turnId: TURN, item })
          note('item/completed', { threadId: THREAD, turnId: TURN, item })
        }
        note('thread/compacted', { threadId: THREAD, turnId: TURN })
        out({ id: 202, method: 'item/permissions/requestApproval', params: { threadId: THREAD, turnId: TURN, itemId: 'approval', reason: 'Explicit request; never consent' } })
        return complete('completed')
      }
      if (scenario.startsWith('batch6-question')) {
        const params = { ...questionParams, threadId: THREAD,
          ...(scenario === 'batch6-question-unsupported' ? { questions: [{ ...questionParams.questions[0], isSecret: true }] } : {}),
          ...(scenario === 'batch6-question-foreign' ? { turnId: 'stale-turn' } : {}) }
        out({ id: 201, method: 'item/tool/requestUserInput', params })
        out({ id: 201, method: 'item/tool/requestUserInput', params })
        if (scenario === 'batch6-question-resolved') setTimeout(() => note('serverRequest/resolved', { threadId: THREAD, requestId: 201 }), 400)
        if (scenario === 'batch6-question-finish') setTimeout(finishNormally, 500)
        return
      }
      if (scenario === 'batch5-plans-children') {
        for (const entry of batch5Items) {
          if (entry.plan) note('turn/plan/updated', { threadId: THREAD, turnId: TURN, ...entry.plan })
          else {
            const item = entry.item
            note('item/started', { threadId: THREAD, turnId: TURN, item: { ...item, status: 'inProgress' } })
            note('item/completed', { threadId: THREAD, turnId: TURN, item })
            note('item/completed', { threadId: THREAD, turnId: TURN, item })
          }
        }
        complete('completed')
        break
      }
      if (scenario === 'batch4-web-tools') {
        for (const item of batch4Items) {
          note('item/started', { threadId: THREAD, turnId: TURN, item: { ...item, ...('status' in item ? { status: 'inProgress' } : {}), results: null, result: null, contentItems: null } })
          note('item/completed', { threadId: THREAD, turnId: TURN, item })
          note('item/completed', { threadId: THREAD, turnId: TURN, item })
        }
        return setTimeout(finishNormally, 50)
      }
      if (scenario === 'batch3-patches') {
        batch3Patches().catch(err => { process.stderr.write(String(err)); process.exit(1) })
        return
      }
      if (scenario === 'batch2-exploration') {
        const items = JSON.parse(readFileSync(new URL('./batch2-app-items.json', import.meta.url), 'utf8'))
        for (const item of items) {
          note('item/started', { threadId: THREAD, turnId: TURN, item: { ...item, status: 'inProgress', aggregatedOutput: null, exitCode: null } })
          if (item.id === 'whole') {
            note('item/commandExecution/outputDelta', { threadId: THREAD, turnId: TURN, itemId: item.id, delta: 'one\n' })
            note('item/commandExecution/terminalInteraction', { threadId: THREAD, turnId: TURN, itemId: item.id, processId: item.processId, stdin: '' })
            note('item/commandExecution/outputDelta', { threadId: THREAD, turnId: TURN, itemId: item.id, delta: 'two\n' })
          }
          note('item/completed', { threadId: THREAD, turnId: TURN, item })
          note('item/completed', { threadId: THREAD, turnId: TURN, item })
        }
        return setTimeout(finishNormally, 50)
      }
      if (scenario === 'batch1-wire') {
        const items = JSON.parse(readFileSync(new URL('./batch1-wire-items.json', import.meta.url), 'utf8'))
        for (const item of items) {
          const start = { ...item, ...('status' in item ? { status: 'inProgress' } : {}) }
          note('item/started', { threadId: THREAD, turnId: TURN, item: start, startedAtMs: 100 })
          if (item.type === 'commandExecution') {
            note('item/commandExecution/outputDelta', { threadId: THREAD, turnId: TURN, itemId: item.id, delta: 'a\r\n\n' })
            note('item/commandExecution/terminalInteraction', { threadId: THREAD, turnId: TURN, itemId: item.id, processId: 'pty-1', stdin: 'q' })
          }
          if (item.type === 'fileChange') note('item/fileChange/patchUpdated', { threadId: THREAD, turnId: TURN, itemId: item.id, changes: item.changes })
          note('item/completed', { threadId: THREAD, turnId: TURN, item, completedAtMs: 120 })
          note('item/completed', { threadId: THREAD, turnId: TURN, item, completedAtMs: 120 })
        }
        for (const method of ['turn/diff/updated', 'turn/plan/updated', 'thread/goal/updated', 'thread/goal/cleared', 'configWarning', 'error', 'future/notification']) {
          note(method, { threadId: THREAD, turnId: TURN, diff: 'aggregate only', explanation: 'Plan', plan: [], goal: { objective: 'Goal', status: 'active' }, error: { message: 'retrying' }, willRetry: true })
        }
        note('item/completed', { threadId: THREAD, turnId: TURN, item: { type: 'futureItem', id: 'future', payload: { exact: true } } })
        out({ id: ++reqId, method: 'item/tool/requestUserInput', params: { threadId: THREAD, turnId: TURN, itemId: 'question', questions: [], isBlocking: true } })
        return setTimeout(finishNormally, 50)
      }
      if (scenario === 'malformed') process.stdout.write('this is not json\n')
      if (scenario === 'unknown') {
        note('brand/new/notification', { threadId: THREAD, turnId: TURN })
        note('item/completed', { threadId: THREAD, turnId: TURN, item: { type: 'holoDeck', id: 'h' } })
      }
      if (scenario.startsWith('capability-approval')) {
        const method = scenario.includes('permissions') ? 'item/permissions/requestApproval' : scenario.includes('file') ? 'item/fileChange/requestApproval' : 'item/commandExecution/requestApproval'
        const params = { threadId: THREAD, turnId: TURN, itemId: 'approval-item', startedAtMs: 42,
          ...(method.includes('commandExecution') ? { command: /-(?:opaque|item|stdin|network)$/.test(scenario) ? null : 'printf exact', cwd: '/repo', approvalId: 'callback-1',
            kind: /-(?:opaque|item|network)$/.test(scenario) ? 'command' : 'writeStdin', ...(scenario.endsWith('-network') ? { networkApprovalContext: { host: 'api.example.test', protocol: 'https' } } : {}) } : {}),
          ...(method.includes('permissions') ? { cwd: '/repo', permissions: { network: { enabled: true }, fileSystem: { write: ['/extra'] } } } : {}) }
        if (method === 'item/commandExecution/requestApproval' && /-(?:item|stdin)$/.test(scenario)) note('item/started', { threadId: THREAD, turnId: TURN, item: { id: params.itemId, type: 'commandExecution', status: 'inProgress', command: 'ORIGINAL_COMMAND_IS_NOT_STDIN' } })
        if (method === 'item/fileChange/requestApproval' && !scenario.includes('missing')) {
          note('item/started', { threadId: THREAD, turnId: TURN, item: { type: 'fileChange', id: 'competing-item', status: 'inProgress', changes: [{ path: '/repo/foreign.txt', kind: { type: 'delete' }, diff: '-foreign' }] } })
          note('item/started', { threadId: THREAD, turnId: TURN, item: { type: 'fileChange', id: params.itemId, status: 'inProgress', changes: [{ path: '/repo/exact.txt', kind: { type: 'update' }, diff: '@@ -1 +1 @@\n-old\n+exact-proposal\n' }] } })
          if (scenario.includes('stale')) setTimeout(() => note('item/completed', { threadId: THREAD, turnId: TURN, item: { type: 'fileChange', id: params.itemId, status: 'completed', changes: [] } }), 300)
        }
        out({ id: 701, method, params })
        if (scenario.endsWith('-resolved')) setTimeout(() => { note('serverRequest/resolved', { threadId: THREAD, turnId: TURN, requestId: 701 }); finishNormally() }, 150)
        if (scenario.endsWith('-finish')) setTimeout(finishNormally, 150)
        return
      }
      if (scenario === 'approval') {
        out({ id: ++reqId, method: 'item/commandExecution/requestApproval', params: { threadId: THREAD, turnId: TURN } })
        setTimeout(finishNormally, 300)
        return
      }
      work()
      if (scenario.startsWith('phase3')) {
        const items = JSON.parse(readFileSync(new URL('./phase3-app-items.json', import.meta.url), 'utf8'))
        for (const item of items) {
          note('item/started', { threadId: THREAD, turnId: TURN, item })
          note('item/completed', { threadId: THREAD, turnId: TURN, item })
        }
        note('turn/plan/updated', { threadId: THREAD, turnId: TURN, explanation: 'Verify the work', plan: [{ step: 'Inspect', status: 'completed' }, { step: 'Test', status: 'inProgress' }, { step: 'Report', status: 'pending' }] })
        if (scenario === 'phase3-drift') note('item/completed', { threadId: THREAD, turnId: TURN, item: { type: 'futureWidget', id: 'new' } })
      }
      if (['steer', 'steer-reject', 'hang', 'deaf'].includes(scenario)) return // wait for steer / interrupt
      if (scenario === 'slow') return setTimeout(finishNormally, 1500)
      return setTimeout(finishNormally, 50)
    case 'turn/steer':
      if (scenario.startsWith('steer-v2-')) {
        if (scenario === 'steer-v2-rejected') return out({ id: m.id, error: { code: -32600, message: 'cannot steer a review turn', data: { turnKind: 'review' } } })
        if (scenario === 'steer-v2-wrong-ack') return reply({ turnId: 'foreign-turn' })
        if (scenario === 'steer-v2-lost-ack') return setTimeout(() => process.exit(1), 10)
        const item = { type: 'userMessage', id: `echo-${m.id}`, clientId: m.params.clientUserMessageId, content: m.params.input }
        note('item/started', { threadId: THREAD, turnId: TURN, item })
        const accepted = () => {
          reply({ turnId: TURN })
          note('item/completed', { threadId: THREAD, turnId: TURN, item })
        }
        if (scenario === 'steer-v2-late-ack') return setTimeout(accepted, 400)
        return accepted()
      }
      if (scenario.startsWith('nested-') && m.params.threadId === CHILD) {
        if (!childActive || m.params.expectedTurnId !== CHILD_TURN) return out({ id: m.id, error: { code: -32000, message: 'stale child turn' } })
        if (scenario === 'nested-steer-wrong-ack') return reply({ turnId: 'foreign-turn' })
        return reply({ turnId: CHILD_TURN })
      }
      if (!turnActive) return out({ id: m.id, error: { code: -32600, message: 'no active turn' } })
      if (scenario === 'steer-reject') return out({ id: m.id, error: { code: -32600, message: 'expected turn mismatch' } })
      reply({ turnId: TURN })
      return setTimeout(finishNormally, 50)
    case 'turn/interrupt':
      if (scenario.startsWith('nested-') && m.params.threadId === CHILD) {
        reply({})
        return setTimeout(() => childComplete('interrupted'), 10)
      }
      reply({})
      if (!scenario.endsWith('deaf')) setTimeout(() => complete('interrupted'), 50)
      return
  }
})
process.stdin.on('end', () => process.exit(0))
