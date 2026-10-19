// Fake `codex app-server` for tests/runner.test.mjs. Launched by the runner
// through `--codex <this file>` (a .mjs --codex is run with process.execPath).
// FAKE_SCENARIO picks the behaviour, FAKE_LOG is a JSONL file where every
// client message is recorded so tests can assert what the runner sent.
import { appendFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, resolve, sep } from 'node:path'
import { createInterface } from 'node:readline'
import batch4Items from './batch4-items.mjs'
import batch5Items from './batch5-items.mjs'

// Scenarios: normal, slow (completes after 1.5 s), instant (turn/start reply
// and the whole turn in ONE stdout write), steer / steer-reject / hang / deaf
// (wait for a steer or interrupt; deaf never completes after turn/interrupt),
// slow-start[-deaf] (turn/start answered after 500 ms, then as hang / deaf),
// approval, malformed, unknown, die, legacy.
const scenario = process.env.FAKE_SCENARIO ?? 'normal'
const log = m => process.env.FAKE_LOG && appendFileSync(process.env.FAKE_LOG, JSON.stringify(m) + '\n')
let batch // when set, `out` collects lines for one write
const out = o => {
  const line = JSON.stringify(o) + '\n'
  if (batch !== undefined) batch.push(line)
  else process.stdout.write(line)
}
const note = (method, params) => out({ method, params })
let THREAD = 'thr-1'
const TURN = 'turn-1'
let turnActive = false
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
  if (m.id !== undefined && m.method === undefined) return // reply to our server request
  switch (m.method) {
    case 'initialize':
      if (scenario === 'legacy') return out({ id: m.id, error: { code: -32601, message: 'Method not found' } })
      return reply({ userAgent: 'codex-cli/9.9.9 (fake)' })
    case 'thread/start':
    case 'thread/resume':
      THREAD = m.params.threadId ?? THREAD
      return reply({ thread: { id: THREAD } })
    case 'turn/start':
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
      if (!turnActive) return out({ id: m.id, error: { code: -32600, message: 'no active turn' } })
      if (scenario === 'steer-reject') return out({ id: m.id, error: { code: -32600, message: 'expected turn mismatch' } })
      reply({ turnId: TURN })
      return setTimeout(finishNormally, 50)
    case 'turn/interrupt':
      reply({})
      if (!scenario.endsWith('deaf')) setTimeout(() => complete('interrupted'), 50)
      return
  }
})
process.stdin.on('end', () => process.exit(0))
