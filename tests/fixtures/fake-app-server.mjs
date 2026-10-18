// Fake `codex app-server` for tests/runner.test.mjs. Launched by the runner
// through `--codex <this file>` (a .mjs --codex is run with process.execPath).
// FAKE_SCENARIO picks the behaviour, FAKE_LOG is a JSONL file where every
// client message is recorded so tests can assert what the runner sent.
import { appendFileSync, readFileSync } from 'node:fs'
import { createInterface } from 'node:readline'

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
  note('turn/completed', { threadId: THREAD, turn: { id: TURN, status, error: status === 'failed' ? { message: 'boom' } : null, items: [] } })
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
