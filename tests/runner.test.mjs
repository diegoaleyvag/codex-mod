// Tests for scripts/codex-runner.mjs against tests/fixtures/fake-app-server.mjs.
// The fake is passed as `--codex <file>.mjs` (the runner launches a .mjs with
// process.execPath); FAKE_SCENARIO selects its behaviour and FAKE_LOG records
// every message the runner sent it. Run: node --test tests/runner.test.mjs
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { TreeUsage } from '../hooks/tree-usage.mjs'
import { PARENT, CHILD, PARENT_TURN, CHILD_TURN, nestedUsage } from './fixtures/nested-items.mjs'
import batch5Items from './fixtures/batch5-items.mjs'
import batch6Items, { questionParams, ANSWER } from './fixtures/batch6-items.mjs'

const here = fileURLToPath(new URL('.', import.meta.url))
const RUNNER = join(here, '..', 'scripts', 'codex-runner.mjs')
const FAKE = join(here, 'fixtures', 'fake-app-server.mjs')
const sleep = ms => new Promise(r => setTimeout(r, ms))

// `control`: the control dir's path under the temp dir (default `control`);
// `setup(control)` runs before the runner starts (files present at startup).
function start(scenario, { extra = [], prompt = 'do it', env = {}, control: controlName = 'control', setup } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'runner-test-'))
  const control = join(dir, controlName)
  const logFile = join(dir, 'fake.log')
  setup?.(control)
  const child = spawn(process.execPath, [RUNNER, 'run', '--codex', FAKE, '--cwd', dir, '--model', 'm', '--effort', 'low', '--sandbox', 'workspace-write', '--control', control, ...extra], {
    env: { ...process.env, FAKE_SCENARIO: scenario, FAKE_LOG: logFile, ...env },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', d => (stdout += d))
  child.stderr.on('data', d => (stderr += d))
  child.stdin.end(prompt)
  const exit = new Promise(r => child.on('exit', (code, signal) => r({ code, signal })))
  const lines = () => stdout.split('\n').filter(Boolean).map(l => JSON.parse(l))
  const sent = () => (existsSync(logFile) ? readFileSync(logFile, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)) : [])
  const waitFor = async (pred, ms = 5000) => {
    const t = Date.now()
    while (Date.now() - t < ms) {
      if (pred()) return
      await sleep(25)
    }
    throw new Error(`timeout; output so far:\n${stdout}\nstderr: ${stderr}`)
  }
  const cleanup = () => rmSync(dir, { recursive: true, force: true })
  return { child, control, exit, lines, sent, waitFor, cleanup, stderr: () => stderr }
}
const types = r => r.lines().map(l => l.type)

for (const scenario of ['nested-one-child', 'nested-early', 'nested-both', 'nested-collab-only', 'nested-failure', 'nested-response-only']) test(`${scenario}: one child, independent public stream, attachment replay and direct/tree usage`, async () => {
  const r = start(scenario)
  try {
    assert.equal((await r.exit).code, 0, r.stderr())
    const rpc = r.sent().filter(m => m.method)
    assert.equal(rpc.filter(m => m.method === 'thread/start').length, 1)
    assert.equal(rpc.filter(m => m.method === 'turn/start').length, 1)
    const adopts = rpc.filter(m => m.method === 'thread/resume')
    assert.equal(adopts.length, 1)
    assert.deepEqual(adopts[0].params, { threadId: CHILD, excludeTurns: true })
    assert.equal(r.lines().filter(l => l.type === 'codexmod.child' && l.status === 'attached').length, 1)
    const events = r.lines().filter(l => l.type === 'codexmod.childEvent').map(l => l.event)
    assert.ok(events.every(e => e.thread_id === CHILD && e.turn_id === CHILD_TURN))
    const actions = events.filter(e => e.type === 'item.completed')
    assert.equal(actions.filter(e => e.source.item.id === 'child-command').length, 1)
    assert.equal(actions.filter(e => e.source.item.id === 'child-file').length, 1)
    assert.ok(actions.some(e => e.item.text === 'child checked the fixture'))
    assert.deepEqual(events.filter(e => e.type === 'codexmod.directUsage').at(-1).usage, { input: 2000, cached: 1500, output: 100 })
    assert.equal(events.filter(e => ['turn.completed', 'turn.failed'].includes(e.type)).length, 1)
    assert.ok(!r.lines().some(e => e.type === 'item.completed' && e.source?.threadId === CHILD))
    const rootEnd = r.lines().findIndex(e => e.type === 'turn.completed')
    const childEnd = r.lines().findIndex(e => e.type === 'codexmod.childEvent' && ['turn.completed', 'turn.failed'].includes(e.event.type))
    assert.ok(rootEnd >= 0 && childEnd > rootEnd)
    const snapshots = r.lines().filter(e => e.type === 'codexmod.treeUsage')
    assert.deepEqual(snapshots.at(-1).direct, { input: 1000, cached: 600, output: 50 })
    assert.deepEqual(snapshots.at(-1).tree, { input: 3000, cached: 2100, output: 150 })
    assert.equal(snapshots.at(-1).active, 0)
    assert.equal(rpc.filter(m => m.method === 'thread/items/list').length, 2)
    const journal = readFileSync(join(r.control, `events-${CHILD}.jsonl`), 'utf8').trim().split('\n').map(JSON.parse)
    assert.deepEqual(journal, events)
    assert.ok(!JSON.stringify(events).includes('PRIVATE_'))
  } finally { r.cleanup() }
})

for (const scenario of ['nested-rejoin-failure', 'nested-ancestry', 'nested-history-mode']) test(`${scenario}: honest attachment fallback without replacement execution`, async () => {
  const r = start(scenario)
  try {
    assert.equal((await r.exit).code, 0)
    assert.ok(r.lines().some(e => e.type === 'codexmod.child' && e.status === 'unavailable' && e.reason))
    assert.ok(!r.lines().some(e => e.type === 'codexmod.childEvent'))
    assert.equal(r.sent().filter(m => m.method === 'turn/start').length, 1)
    assert.ok(r.lines().filter(e => e.type === 'codexmod.treeUsage').at(-1).missing > 0)
  } finally { r.cleanup() }
})

test('nestedAgents:false retains Batch 5 without child rejoin or mirror events', async () => {
  const r = start('nested-one-child', { extra: ['--nested', 'false'] })
  try {
    assert.equal((await r.exit).code, 0)
    assert.ok(!r.sent().some(m => m.method === 'thread/resume'))
    assert.ok(!r.lines().some(l => l.type === 'codexmod.child'))
    assert.ok(r.lines().some(l => l.source?.item?.type === 'subAgentActivity'))
  } finally { r.cleanup() }
})

test('nested controls: root completion keeps owner alive; child steer/stop target only that thread once', async () => {
  const r = start('nested-controls')
  try {
    await r.waitFor(() => r.lines().some(l => l.type === 'turn.completed') && r.lines().some(l => l.type === 'codexmod.childEvent'))
    writeFileSync(join(r.control, 'steer-child-1.json'), JSON.stringify({ threadId: CHILD, turnId: CHILD_TURN, text: 'continue checking' }))
    await r.waitFor(() => r.lines().some(l => l.event?.type === 'codexmod.steer' && l.event.status === 'accepted'))
    writeFileSync(join(r.control, 'steer-stale.json'), JSON.stringify({ threadId: CHILD, turnId: 'stale', text: 'do not deliver' }))
    await r.waitFor(() => r.lines().some(l => l.event?.type === 'codexmod.steer' && l.event.status === 'rejected'))
    const stop = { threadId: CHILD, turnId: CHILD_TURN, operationId: 'stop-1' }
    writeFileSync(join(r.control, 'interrupt-child-1.json'), JSON.stringify(stop))
    writeFileSync(join(r.control, 'interrupt-child-2.json'), JSON.stringify(stop))
    assert.equal((await r.exit).code, 0)
    const steers = r.sent().filter(m => m.method === 'turn/steer')
    assert.equal(steers.length, 1)
    assert.equal(steers[0].params.threadId, CHILD)
    const stops = r.sent().filter(m => m.method === 'turn/interrupt')
    assert.deepEqual(stops.map(s => s.params), [{ threadId: CHILD, turnId: CHILD_TURN }])
    assert.ok(r.lines().some(l => l.event?.type === 'turn.failed' && l.event.status === 'interrupted'))
    assert.equal(r.sent().filter(m => m.method === 'turn/start').length, 1)
  } finally { r.cleanup() }
})

test('batch 8 replayed message UUIDs never steer twice, while distinct UUIDs with identical text still deliver', async () => {
  const r = start('nested-controls')
  try {
    await r.waitFor(() => r.lines().some(l => l.type === 'codexmod.child' && l.status === 'attached'))
    const body = { threadId: CHILD, turnId: CHILD_TURN, text: 'same text', messageId: 'source-one' }
    writeFileSync(join(r.control, 'steer-receipt-1.json'), JSON.stringify(body))
    await r.waitFor(() => r.lines().some(l => l.event?.type === 'codexmod.steer' && l.event.status === 'accepted'))
    writeFileSync(join(r.control, 'steer-receipt-1.json'), JSON.stringify(body))
    writeFileSync(join(r.control, 'steer-receipt-replayed.json'), JSON.stringify(body))
    writeFileSync(join(r.control, 'steer-receipt-2.json'), JSON.stringify({ ...body, messageId: 'source-two' }))
    await r.waitFor(() => r.lines().filter(l => l.event?.type === 'codexmod.steer' && l.event.status === 'accepted').length === 2)
    writeFileSync(join(r.control, 'interrupt'), '')
    await r.exit
    const steers = r.sent().filter(m => m.method === 'turn/steer')
    assert.equal(steers.length, 2)
    assert.deepEqual(steers.map(s => s.params.clientUserMessageId).sort(), ['source-one', 'source-two'])
    assert.ok(steers.every(s => s.params.threadId === CHILD && s.params.expectedTurnId === CHILD_TURN))
  } finally { r.cleanup() }
})

test('batch 8 a steer acknowledgement for another turn is unknown and never retried', async () => {
  const r = start('nested-steer-wrong-ack', { env: { FAKE_CHILD_DELAY_MS: '1500' } })
  try {
    await r.waitFor(() => r.lines().some(l => l.event?.type === 'codexmod.turn'))
    writeFileSync(join(r.control, 'steer-wrong-ack.json'), JSON.stringify({ threadId: CHILD, turnId: CHILD_TURN, text: 'one submission', messageId: 'source-wrong-ack' }))
    await r.waitFor(() => r.lines().some(l => l.event?.type === 'codexmod.steer' && l.event.status === 'unknown'))
    await r.exit
    assert.equal(r.sent().filter(m => m.method === 'turn/steer').length, 1)
    assert.ok(!r.lines().some(l => l.event?.type === 'codexmod.steer' && l.event.status === 'accepted'))
  } finally { r.cleanup() }
})

test('parent stop interrupts active descendants even after its own turn completed', async () => {
  const r = start('nested-controls')
  try {
    await r.waitFor(() => r.lines().some(l => l.type === 'turn.completed'))
    writeFileSync(join(r.control, 'interrupt'), '')
    await r.exit
    assert.equal(r.sent().filter(m => m.method === 'turn/interrupt' && m.params.threadId === CHILD).length, 1)
  } finally { r.cleanup() }
})

test('batch 8 stopping one mirror cascades its source subtree and leaves a sibling running until parent stop', async () => {
  const r = start('nested-tree-controls')
  const grandchild = '55555555-5555-4555-8555-555555555555'
  const sibling = '66666666-6666-4666-8666-666666666666'
  try {
    await r.waitFor(() => r.sent().filter(m => m.method === 'thread/resume').length === 3 && r.lines().some(l => l.type === 'turn.completed'))
    writeFileSync(join(r.control, 'interrupt-mirror.json'), JSON.stringify({ threadId: CHILD, turnId: CHILD_TURN, operationId: 'native-mirror-stop' }))
    await r.waitFor(() => r.lines().some(l => l.event?.thread_id === grandchild && l.event.type === 'turn.failed'))
    let targets = r.sent().filter(m => m.method === 'turn/interrupt').map(m => m.params.threadId).sort()
    assert.deepEqual(targets, [CHILD, grandchild].sort())
    assert.equal(JSON.parse(readFileSync(join(r.control, 'owner.json'), 'utf8')).ended, false)
    writeFileSync(join(r.control, 'interrupt'), '')
    await r.exit
    targets = r.sent().filter(m => m.method === 'turn/interrupt').map(m => m.params.threadId).sort()
    assert.deepEqual(targets, [CHILD, grandchild, sibling].sort())
    assert.equal(r.sent().filter(m => m.method === 'turn/start').length, 1)
  } finally { r.cleanup() }
})

test('tree usage deduplicates responses, turns and edges; historical child turns cannot leak into a follow-up', () => {
  const ledger = new TreeUsage()
  assert.ok(ledger.edge(PARENT, CHILD))
  assert.ok(ledger.edge(PARENT, CHILD))
  assert.equal(ledger.edge(CHILD, PARENT), false)
  assert.equal(ledger.edge('foreign', CHILD), false)
  for (let i = 0; i < 3; i++) {
    ledger.cumulative(PARENT, PARENT_TURN, PARENT_TURN, nestedUsage(1000, 600, 50))
    ledger.response(CHILD, CHILD_TURN, PARENT_TURN, 'child-response', nestedUsage(2000, 1500, 100).total)
    ledger.cumulative(CHILD, CHILD_TURN, PARENT_TURN, nestedUsage(2000, 1500, 100))
  }
  ledger.response(CHILD, 'old-turn', 'old-root', 'old-response', { inputTokens: 900000, cachedInputTokens: 800000, outputTokens: 500 })
  assert.deepEqual(ledger.snapshot(PARENT, PARENT_TURN).tree, { input: 3000, cached: 2100, output: 150 })
  assert.deepEqual(ledger.snapshot(PARENT, 'new-root').tree, { input: 0, cached: 0, output: 0 })
  const grandchild = 'grandchild'
  assert.ok(ledger.edge(CHILD, grandchild))
  ledger.response(grandchild, 'grand-turn', PARENT_TURN, 'grand-response', { inputTokens: 30, cachedInputTokens: 10, outputTokens: 5, reasoningOutputTokens: 3, cacheWriteInputTokens: 2 })
  assert.deepEqual(ledger.snapshot(PARENT, PARENT_TURN).tree, { input: 3030, cached: 2110, output: 155 })
  assert.deepEqual(ledger.snapshot(CHILD, PARENT_TURN).tree, { input: 2030, cached: 1510, output: 105 })
  const unknown = new TreeUsage()
  unknown.edge(PARENT, CHILD)
  unknown.cumulative(CHILD, CHILD_TURN, PARENT_TURN, { total: { inputTokens: 99999, outputTokens: 40 } })
  assert.ok(unknown.snapshot(PARENT, PARENT_TURN).missing > 0)
})

test('batch 6 full images, generation, review, warnings and summaries cross the wire without private reasoning', async () => {
  const r = start('batch6-images-modes')
  try {
    assert.equal((await r.exit).code, 0)
    const lines = r.lines(), completed = lines.filter(l => l.type === 'item.completed')
    assert.equal(completed.length, batch6Items.length)
    for (const item of batch6Items) {
      const publicItem = { ...item }
      if (item.type === 'reasoning') delete publicItem.content
      assert.deepEqual(completed.find(l => l.source.item.id === item.id).source.item, publicItem)
    }
    assert.ok(!JSON.stringify(lines).includes('PRIVATE_'))
    assert.equal(lines.filter(l => l.type === 'codexmod.warning').length, 2)
    assert.ok(!lines.some(l => ['turn.failed', 'error'].includes(l.type)))
    assert.equal(r.sent().find(m => m.id === 202 && !m.method).error.code, -32601)
    assert.deepEqual(r.sent().filter(m => m.method).map(m => m.method), ['initialize', 'initialized', 'thread/start', 'turn/start'])
  } finally { r.cleanup() }
})

const responseTo = (q, extra = {}) => ({ token: q.token, requestId: q.requestId, threadId: q.params.threadId, turnId: q.params.turnId, itemId: q.params.itemId, ...extra })
for (const cancel of [false, true]) test(`batch 6 explicit question ${cancel ? 'cancel' : 'answer'} is bound once; receipt and stale IDs supply no consent`, async () => {
  const r = start('batch6-question', { extra: ['--questions', 'choices'] })
  try {
    await r.waitFor(() => r.lines().some(l => l.type === 'codexmod.request' && l.status === 'pending'))
    const q = r.lines().find(l => l.type === 'codexmod.request')
    assert.equal(r.lines().filter(l => l.type === 'codexmod.request').length, 1)
    assert.ok(!r.sent().some(m => m.id === 201 && !m.method))
    writeFileSync(join(r.control, `response-${q.token}.json`), JSON.stringify(responseTo(q, { requestId: 'stale', result: ANSWER })))
    await r.waitFor(() => r.lines().some(l => l.type === 'codexmod.responseRejected'))
    assert.ok(!r.sent().some(m => m.id === 201 && !m.method))
    writeFileSync(join(r.control, `response-${q.token}.json`), JSON.stringify(responseTo(q, { result: { answers: { mode: { answers: ['Invented'] } } } })))
    await r.waitFor(() => r.lines().filter(l => l.type === 'codexmod.responseRejected').length === 2)
    assert.ok(!r.sent().some(m => m.id === 201 && !m.method))
    writeFileSync(join(r.control, `response-${q.token}.json`), JSON.stringify(responseTo(q, cancel ? { cancel: true } : { result: ANSWER })))
    assert.equal((await r.exit).code, 0)
    const replies = r.sent().filter(m => m.id === 201 && !m.method)
    assert.equal(replies.length, 1)
    assert.deepEqual(cancel ? replies[0].error.code : replies[0].result, cancel ? -32800 : ANSWER)
    assert.equal(r.lines().filter(l => l.status === (cancel ? 'cancelled' : 'answered')).length, 1)
    assert.equal(r.sent().find(m => m.method === 'thread/start').params.approvalPolicy, 'never')
  } finally { r.cleanup() }
})

test('batch 6 resolved and ended questions reject late responses and never reply twice', async () => {
  for (const scenario of ['batch6-question-resolved', 'batch6-question-finish']) {
    const r = start(scenario, { extra: ['--questions', 'choices'] })
    try {
      await r.waitFor(() => r.lines().some(l => l.type === 'codexmod.request' && l.status === 'pending'))
      const q = r.lines().find(l => l.status === 'pending')
      await r.waitFor(() => r.lines().some(l => l.type === 'codexmod.request' && l.status === 'cancelled'))
      if (scenario.endsWith('resolved')) {
        writeFileSync(join(r.control, `response-${q.token}.json`), JSON.stringify(responseTo(q, { result: ANSWER })))
        await r.waitFor(() => r.lines().some(l => l.type === 'codexmod.responseRejected'))
        assert.ok(!r.sent().some(m => m.id === 201 && !m.method))
        writeFileSync(join(r.control, 'interrupt'), '')
      }
      await r.exit
      assert.ok(r.sent().filter(m => m.id === 201 && !m.method).length <= 1)
      assert.ok(!r.lines().some(l => l.status === 'answered'))
    } finally { r.cleanup() }
  }
})

for (const scenario of ['batch6-question', 'batch6-question-unsupported', 'batch6-question-foreign']) test(`batch 6 ${scenario}: disabled, secret and stale-turn requests explicitly error`, async () => {
  const r = start(scenario, { extra: scenario === 'batch6-question' ? [] : ['--questions', 'choices'] })
  try {
    assert.equal((await r.exit).code, 0)
    const replies = r.sent().filter(m => m.id === 201 && !m.method)
    assert.equal(replies.length, 1)
    assert.equal(replies[0].error.code, -32601)
    assert.ok(!r.lines().some(l => l.status === 'answered' || l.status === 'pending'))
  } finally { r.cleanup() }
})

test('batch 5 transports full plans, child identities, states, messages and failures without child RPCs', async () => {
  const r = start('batch5-plans-children', { extra: ['--nested', 'false'] })
  try {
    assert.equal((await r.exit).code, 0)
    const lines = r.lines()
    const completed = lines.filter(l => l.type === 'item.completed')
    assert.equal(completed.length, batch5Items.filter(e => e.item).length)
    for (const { item } of batch5Items.filter(e => e.item)) {
      const wire = completed.find(l => l.source.item.id === item.id)
      assert.deepEqual(wire.source.item, item)
      assert.equal(wire.source.threadId, 'thr-1')
      assert.equal(wire.source.turnId, 'turn-1')
      if (item.type === 'collabAgentToolCall') {
        for (const key of ['id', 'senderThreadId', 'model', 'reasoningEffort', 'prompt', 'status']) assert.deepEqual(wire.item[key], item[key])
        assert.deepEqual(wire.item.agents_states, item.agentsStates)
      }
    }
    assert.deepEqual(lines.filter(l => l.item?.type === 'plan_update').map(l => ({ explanation: l.item.explanation, plan: l.item.steps })), batch5Items.filter(e => e.plan).map(e => e.plan))
    assert.deepEqual(r.sent().map(m => m.method), ['initialize', 'initialized', 'thread/start', 'turn/start'])
    assert.equal(lines.filter(l => l.type === 'turn.completed').length, 1)
  } finally { r.cleanup() }
})

test('--version prints the protocol version', async () => {
  const r = await new Promise(res => {
    const c = spawn(process.execPath, [RUNNER, '--version'])
    let o = ''
    c.stdout.on('data', d => (o += d))
    c.on('exit', code => res({ code, o }))
  })
  assert.equal(r.code, 0)
  assert.equal(r.o.trim(), '1')
})

test('normal turn: exec-compatible lines, turn-scoped usage, exit 0', async () => {
  const r = start('normal')
  const { code } = await r.exit
  const l = r.lines()
  assert.equal(code, 0)
  assert.deepEqual(l[0], { type: 'thread.started', thread_id: 'thr-1' })
  assert.deepEqual(l[1], { type: 'codexmod.turn', turn_id: 'turn-1' })
  const cmd = l.find(x => x.item?.type === 'command_execution')
  assert.equal(cmd.item.id, 'c1')
  assert.equal(cmd.item.aggregated_output, 'a\n')
  assert.equal(cmd.item.exit_code, 0)
  assert.equal(cmd.source.threadId, 'thr-1')
  assert.equal(cmd.source.turnId, 'turn-1')
  const started = l.find(x => x.type === 'item.started')
  assert.deepEqual(started.item.changes, [{ path: '/x/a.txt', kind: { type: 'add' }, diff: '' }])
  const done = l.find(x => x.type === 'item.completed' && x.item.type === 'file_change')
  assert.deepEqual(done.item.changes, [{ path: '/x/a.txt', kind: { type: 'add' }, diff: '' }, { path: '/x/b.txt', kind: { type: 'update', move_path: null }, diff: '' }])
  assert.deepEqual(l.filter(x => x.item?.type === 'agent_message').map(x => x.item.text), ['all done'])
  // baseline = first total - first last (992,98,48); final total 1500/300/80
  assert.deepEqual(l.findLast(e => e.type === 'turn.completed'), { type: 'turn.completed', usage: { input_tokens: 508, cached_input_tokens: 202, output_tokens: 32 } })
  const s = r.sent()
  assert.deepEqual(s.map(m => m.method), ['initialize', 'initialized', 'thread/start', 'turn/start'])
  assert.equal(s[0].params.clientInfo.name, 'codex-mod')
  assert.ok(!s[0].params.capabilities.optOutNotificationMethods.includes('item/commandExecution/outputDelta'))
  assert.equal(s[2].params.approvalPolicy, 'never')
  assert.equal(s[2].params.sandbox, 'workspace-write')
  assert.equal(s[2].params.config.model_reasoning_effort, 'low')
  assert.equal(s[3].params.input[0].text, 'do it')
  assert.equal(s[3].params.effort, 'low')
  r.cleanup()
})

test('--config values are parsed like TOML scalars and arrays', async () => {
  const r = start('normal', { extra: ['--config', 'features.plugins=false', '--config', 'web_search="disabled"', '--config', 'n=3', '--config', "a=['x','y']", '--config', 'raw=hello'] })
  await r.exit
  const cfg = r.sent().find(m => m.method === 'thread/start').params.config
  assert.deepEqual(cfg, { model_reasoning_effort: 'low', 'features.plugins': false, web_search: 'disabled', n: 3, a: ['x', 'y'], raw: 'hello' })
  r.cleanup()
})

test('resume path uses thread/resume with the given thread id', async () => {
  const r = start('normal', { extra: ['--thread', 'old-thread'] })
  const { code } = await r.exit
  assert.equal(code, 0)
  const resume = r.sent().find(m => m.method === 'thread/resume')
  assert.equal(resume.params.threadId, 'old-thread')
  assert.ok(!r.sent().some(m => m.method === 'thread/start'))
  assert.equal(r.lines()[0].thread_id, 'old-thread')
  r.cleanup()
})

test('steer mid-turn is forwarded and acked accepted', async t => {
  const r = start('steer')
  await r.waitFor(() => types(r).includes('codexmod.turn'))
  writeFileSync(join(r.control, 'steer-1.json'), JSON.stringify({ text: 'change plan' }))
  const { code } = await r.exit
  assert.equal(code, 0)
  assert.equal(r.lines().find(l => l.type === 'codexmod.steer').acceptedTurnId, 'turn-1')
  assert.equal(r.lines().find(l => l.type === 'codexmod.steer').status, 'accepted')
  const st = r.sent().find(m => m.method === 'turn/steer')
  assert.equal(st.params.threadId, 'thr-1')
  assert.equal(st.params.expectedTurnId, 'turn-1')
  assert.equal(st.params.input[0].text, 'change plan')
  assert.ok(!existsSync(join(r.control, 'steer-1.json')))
  r.cleanup()
})

test('a steer rejected by app-server is acked rejected with the reason', async t => {
  const r = start('steer-reject')
  t.after(() => { r.child.kill(); r.cleanup() })
  await r.waitFor(() => types(r).includes('codexmod.turn'))
  writeFileSync(join(r.control, 'steer-7.json'), JSON.stringify({ text: 'x' }))
  await r.waitFor(() => types(r).includes('codexmod.steer'))
  assert.equal(r.lines().find(l => l.type === 'codexmod.steer').status, 'rejected')
  assert.deepEqual(r.lines().find(l => l.type === 'codexmod.steer').error, { code: -32600, message: 'expected turn mismatch' })
  writeFileSync(join(r.control, 'interrupt'), '')
  await r.exit
  r.cleanup()
})

test('steer file still held when the turn finishes is rejected "turn finished"', async () => {
  // the file is there before the turn id is known (held); `instant` then delivers the
  // turn/start reply and the whole turn in one chunk, so the hold ends with the turn over
  const r = start('instant', {
    setup: control => {
      mkdirSync(control, { recursive: true, mode: 0o700 })
      writeFileSync(join(control, 'steer-9.json'), JSON.stringify({ text: 'late' }))
    },
  })
  const { code } = await r.exit
  assert.equal(code, 0)
  assert.equal(r.lines().find(l => l.type === 'codexmod.steer').status, 'rejected')
  assert.match(r.lines().find(l => l.type === 'codexmod.steer').reason, /stale or idle/)
  assert.ok(!r.sent().some(m => m.method === 'turn/steer'))
  assert.ok(!existsSync(join(r.control, 'steer-9.json')))
  r.cleanup()
})

test('a steer present before the turn id is known is held, then delivered after turn/start', async () => {
  const r = start('slow-start', {
    setup: control => {
      mkdirSync(control, { recursive: true, mode: 0o700 })
      writeFileSync(join(control, 'steer-3.json'), JSON.stringify({ text: 'early' }))
    },
  })
  const { code } = await r.exit
  assert.equal(code, 0)
  assert.equal(r.lines().find(l => l.type === 'codexmod.steer').acceptedTurnId, 'turn-1')
  const methods = r.sent().map(m => m.method)
  assert.ok(methods.indexOf('turn/start') >= 0)
  assert.ok(methods.indexOf('turn/start') < methods.indexOf('turn/steer'), `turn/start before turn/steer: ${methods}`)
  assert.equal(r.sent().find(m => m.method === 'turn/steer').params.expectedTurnId, 'turn-1')
  r.cleanup()
})

test('the control dir and the chain it creates are mode 0700', async () => {
  const r = start('normal', { control: join('runs', 'sess-agent-1') })
  const { code } = await r.exit
  assert.equal(code, 0)
  const mode = p => statSync(p).mode & 0o777
  assert.equal(mode(r.control), 0o700)
  assert.equal(mode(join(r.control, '..')), 0o700)
  r.cleanup()
})

test('unparseable steer file is retried then rejected', async () => {
  const r = start('hang')
  await r.waitFor(() => types(r).includes('codexmod.turn'))
  writeFileSync(join(r.control, 'steer-2.json'), '{not json')
  await r.waitFor(() => types(r).includes('codexmod.steer'), 6000)
  assert.deepEqual(r.lines().find(l => l.type === 'codexmod.steer'), { type: 'codexmod.steer', id: 2, status: 'rejected', reason: 'unparseable steer file' })
  writeFileSync(join(r.control, 'interrupt'), '')
  await r.exit
  r.cleanup()
})

test('interrupt file -> turn/interrupt, turn.failed interrupted, exit 1', async () => {
  const r = start('hang')
  await r.waitFor(() => types(r).includes('codexmod.turn'))
  writeFileSync(join(r.control, 'interrupt'), '')
  const { code } = await r.exit
  assert.equal(code, 1)
  assert.deepEqual(r.lines().findLast(e => e.type === 'turn.failed'), { type: 'turn.failed', status: 'interrupted', error: { message: 'interrupted' } })
  const it = r.sent().find(m => m.method === 'turn/interrupt')
  assert.deepEqual(it.params, { threadId: 'thr-1', turnId: 'turn-1' })
  r.cleanup()
})

test('interrupt with an unresponsive server still ends within the 5 s window', async () => {
  const r = start('deaf')
  // "deaf" never completes after turn/interrupt
  await r.waitFor(() => types(r).includes('codexmod.turn'))
  writeFileSync(join(r.control, 'interrupt'), '')
  const t = Date.now()
  const { code } = await r.exit
  assert.equal(code, 1)
  assert.ok(Date.now() - t < 12000)
  assert.deepEqual(r.lines().findLast(e => e.type === 'turn.failed'), { type: 'turn.failed', error: { message: 'interrupted' } })
  r.cleanup()
})

test('interrupt written before the turn id is known is sent once the turn starts', async () => {
  const r = start('slow-start')
  await r.waitFor(() => types(r).includes('thread.started'))
  writeFileSync(join(r.control, 'interrupt'), '')
  const { code } = await r.exit
  assert.equal(code, 1)
  assert.deepEqual(r.lines().findLast(e => e.type === 'turn.failed'), { type: 'turn.failed', status: 'interrupted', error: { message: 'interrupted' } })
  const methods = r.sent().map(m => m.method)
  assert.ok(methods.indexOf('turn/start') < methods.indexOf('turn/interrupt'))
  assert.deepEqual(r.sent().find(m => m.method === 'turn/interrupt').params, { threadId: 'thr-1', turnId: 'turn-1' })
  r.cleanup()
})

test('interrupt before the turn id with an unresponsive server still ends the run', async () => {
  const r = start('slow-start-deaf')
  await r.waitFor(() => types(r).includes('thread.started'))
  writeFileSync(join(r.control, 'interrupt'), '')
  const t = Date.now()
  const { code } = await r.exit
  assert.equal(code, 1)
  assert.ok(Date.now() - t < 12000)
  assert.ok(r.sent().some(m => m.method === 'turn/interrupt'))
  assert.deepEqual(r.lines().findLast(e => e.type === 'turn.failed'), { type: 'turn.failed', error: { message: 'interrupted' } })
  r.cleanup()
})

test('server approval request is answered -32601', async () => {
  const r = start('approval')
  const { code } = await r.exit
  assert.equal(code, 0)
  const reply = r.sent().find(m => m.id === 101 && m.method === undefined)
  assert.equal(reply.error.code, -32601)
  assert.match(reply.error.message, /unsupported by codex-mod/)
  r.cleanup()
})

test('a malformed line is reported once and skipped', async () => {
  const r = start('malformed')
  const { code } = await r.exit
  assert.equal(code, 0)
  assert.equal(r.lines().filter(l => l.type === 'error').length, 1)
  assert.ok(r.lines().some(e => e.type === 'turn.completed'))
  r.cleanup()
})

test('app-server dying early -> codexmod.fatal with its stderr, exit 1', async () => {
  const r = start('die')
  const { code } = await r.exit
  assert.equal(code, 1)
  const f = r.lines().find(l => l.type === 'codexmod.fatal')
  assert.match(f.message, /exited early/)
  assert.match(f.message, /fake fatal: no auth/)
  r.cleanup()
})

test('-32601 on initialize -> codexmod.fatal "protocol changed" with the version', async () => {
  const r = start('legacy')
  const { code } = await r.exit
  assert.equal(code, 1)
  assert.match(r.lines().find(l => l.type === 'codexmod.fatal').message, /app-server protocol changed/)
  r.cleanup()
})

test('unknown notification methods / item types are reported at the end', async () => {
  const r = start('unknown')
  await r.exit
  assert.deepEqual(r.lines().find(l => l.type === 'codexmod.protocol'), { type: 'codexmod.protocol', unknown_methods: ['brand/new/notification'], unknown_items: ['holoDeck'] })
  r.cleanup()
})

test('SIGTERM interrupts the active turn, then exits non-zero', async () => {
  const r = start('hang')
  await r.waitFor(() => types(r).includes('codexmod.turn'))
  r.child.kill('SIGTERM')
  const { code } = await r.exit
  assert.equal(code, 1)
  assert.ok(r.sent().some(m => m.method === 'turn/interrupt'))
  r.cleanup()
})

test('parent death triggers the same interrupt path', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'runner-parent-'))
  const logFile = join(dir, 'fake.log')
  const pidFile = join(dir, 'runner.pid')
  // a middle process spawns the runner (detached from our wait), then dies
  const script = `
    const { spawn } = require('node:child_process'); const fs = require('node:fs')
    const c = spawn(process.execPath, [${JSON.stringify(RUNNER)}, 'run', '--codex', ${JSON.stringify(FAKE)}, '--cwd', ${JSON.stringify(dir)}, '--model', 'm', '--effort', 'low', '--sandbox', 'workspace-write', '--control', ${JSON.stringify(join(dir, 'c'))}], { stdio: ['pipe', 'ignore', 'ignore'], env: { ...process.env, FAKE_SCENARIO: 'hang', FAKE_LOG: ${JSON.stringify(logFile)} } })
    c.stdin.end('go'); fs.writeFileSync(${JSON.stringify(pidFile)}, String(c.pid)); setTimeout(() => process.exit(0), 1500)`
  const mid = spawn(process.execPath, ['-e', script], { stdio: 'ignore' })
  await new Promise(r => mid.on('exit', r))
  const pid = Number(readFileSync(pidFile, 'utf8'))
  const alive = () => {
    try {
      process.kill(pid, 0)
      return true
    } catch {
      return false
    }
  }
  const t = Date.now()
  while (alive() && Date.now() - t < 8000) await sleep(100)
  assert.ok(!alive(), 'runner exited after its parent died')
  const methods = readFileSync(logFile, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l).method)
  assert.ok(methods.includes('turn/interrupt'))
  rmSync(dir, { recursive: true, force: true })
})


test('phase 3 translates each completed app-server item and plan notification, without raw reasoning', async t => {
  const r = start('phase3')
  try {
    assert.equal((await r.exit).code, 0)
    const lines = r.lines()
    const items = lines.filter(l => l.type === 'item.completed').map(l => l.item)
    await t.test('reasoning contains summary text only, including an empty summary', () => {
      assert.deepEqual(items.filter(i => i.type === 'reasoning'), [
        { type: 'reasoning', text: 'Check the available evidence.\n\nThen verify the change.' }, { type: 'reasoning', text: '' },
      ])
      assert.ok(!JSON.stringify(lines).includes('PRIVATE_RAW_REASONING'))
    })
    await t.test('commentary preserves its phase', () => {
      assert.deepEqual(items.find(i => i.phase === 'commentary'), { type: 'agent_message', text: 'Checking the sources.', phase: 'commentary' })
    })
    await t.test('search, openPage and findInPage preserve results and actions, once each', () => {
      const web = items.filter(i => i.type === 'web_search')
      assert.equal(web.length, 3)
      assert.equal(web[0].results[0].url, 'https://example.test/docs')
      assert.deepEqual(web.map(i => i.action.type), ['search', 'openPage', 'findInPage'])
      assert.equal(lines.filter(l => l.type === 'item.started').length, 22) // all public source starts, including deferred variants
    })
    await t.test('MCP results and errors stay exec-compatible', () => {
      const mcp = items.filter(i => i.type === 'mcp_tool_call')
      assert.equal(mcp.length, 2)
      assert.deepEqual(mcp[0], { type: 'mcp_tool_call', server: 'docs', tool: 'lookup', arguments: { topic: 'options' }, status: 'completed', result: { content: [{ type: 'text', text: 'Found options.' }], structuredContent: null }, error: null })
      assert.deepEqual(mcp[1].error, { message: 'No such topic' })
    })
    await t.test('dynamic calls use a new exec-like shape, preserving text and failure', () => {
      const dyn = items.filter(i => i.type === 'dynamic_tool_call')
      assert.equal(dyn.length, 2)
      assert.equal(dyn[0].namespace, 'local')
      assert.equal(dyn[0].content_items[0].text, 'Inspected a.')
      assert.equal(dyn[1].success, false)
    })
    await t.test('plan updates and proposed plans are distinct', () => {
      assert.deepEqual(items.find(i => i.type === 'proposed_plan'), { type: 'proposed_plan', text: '1. Inspect\n2. Verify' })
      assert.deepEqual(lines.find(l => l.item?.type === 'plan_update'), { type: 'item.updated', item: { type: 'plan_update', explanation: 'Verify the work', steps: [{ step: 'Inspect', status: 'completed' }, { step: 'Test', status: 'inProgress' }, { step: 'Report', status: 'pending' }] } })
    })
    await t.test('collaboration calls use exec fields and activity becomes a note', () => {
      const collab = items.filter(i => i.type === 'collab_tool_call')
      assert.deepEqual(collab.map(i => i.tool), ['spawn_agent', 'send_input', 'wait'])
      assert.deepEqual(collab[0].receiver_thread_ids, ['child-1'])
      assert.equal(collab[0].prompt, 'Inspect the tests.\nReport findings.')
      assert.ok(items.some(i => i.type === 'note' && i.text === 'Codex agent /root/reviewer finished'))
    })
    await t.test('miscellaneous items preserve their complete Batch 6 contracts', () => {
      assert.deepEqual(items.filter(i => i.type === 'note' && i.dim).map(i => i.text), [
        'Codex compacted context',
      ])
      for (const type of ['image_view', 'image_generation', 'entered_review_mode', 'exited_review_mode', 'sleep']) assert.ok(items.some(i => i.type === type))
      assert.ok(!lines.some(l => l.type === 'codexmod.protocol'))
    })
  } finally { r.cleanup() }
})

test('phase 3 handled items do not conceal unknown-item drift', async () => {
  const r = start('phase3-drift')
  try {
    assert.equal((await r.exit).code, 0)
    assert.deepEqual(r.lines().find(l => l.type === 'codexmod.protocol'), { type: 'codexmod.protocol', unknown_methods: [], unknown_items: ['futureWidget'] })
  } finally { r.cleanup() }
})

test('batch 1 wire: all 19 public source variants, lifecycle replay and notifications remain lossless', async t => {
  const r = start('batch1-wire')
  try {
    assert.equal((await r.exit).code, 0)
    const lines = r.lines()
    const fixtures = JSON.parse(readFileSync(join(here, 'fixtures', 'batch1-wire-items.json'), 'utf8'))
    for (const item of fixtures) await t.test(item.type, () => {
      const events = lines.filter(l => l.source?.item?.id === item.id)
      assert.equal(events.length, 2)
      const done = events.find(l => l.type === 'item.completed')
      const publicItem = { ...item }
      if (item.type === 'reasoning') delete publicItem.content
      assert.deepEqual(done.source.item, publicItem)
      assert.equal(done.source.threadId, 'thr-1')
      assert.equal(done.source.turnId, 'turn-1')
      assert.equal(done.source.completedAtMs, 120)
      assert.equal(events.find(l => l.type === 'item.started').source.startedAtMs, 100)
    })
    await t.test('patch/aggregate/terminal/goal/warning/unsupported/request records remain separate', () => {
      const sources = lines.filter(l => l.type === 'codexmod.source').map(l => l.source)
      const byMethod = method => sources.find(s => s.event === method)
      assert.deepEqual(byMethod('item/fileChange/patchUpdated').data.changes, fixtures.find(i => i.type === 'fileChange').changes)
      assert.equal(byMethod('turn/diff/updated').data.diff, 'aggregate only')
      assert.equal(byMethod('item/commandExecution/outputDelta').data.delta, 'a\r\n\n')
      assert.equal(byMethod('item/commandExecution/terminalInteraction').data.stdin, 'q')
      for (const method of ['thread/goal/updated', 'thread/goal/cleared', 'configWarning', 'error', 'future/notification']) assert.ok(byMethod(method))
      assert.equal(byMethod('error').data.willRetry, true)
      assert.equal(byMethod('item/tool/requestUserInput').data.requestId, 101)
      assert.equal(byMethod('item/tool/requestUserInput').data.response.code, -32601)
      assert.deepEqual(lines.find(l => l.source?.item?.id === 'future').source.item, { type: 'futureItem', id: 'future', payload: { exact: true } })
      assert.ok(!JSON.stringify(lines).includes('PRIVATE_RAW_REASONING'))
      assert.ok(!lines.some(l => l.type === 'turn.failed'))
      assert.equal(r.sent().find(m => m.id === 101 && !m.method).error.code, -32601)
    })
  } finally { r.cleanup() }
})

test('batch 2 exploration: action evidence and exact output survive start/delta/poll/completion, once per command', async () => {
  const r = start('batch2-exploration')
  try {
    assert.equal((await r.exit).code, 0)
    const fixtures = JSON.parse(readFileSync(join(here, 'fixtures', 'batch2-app-items.json'), 'utf8'))
    const lines = r.lines()
    const commands = lines.filter(l => l.type === 'item.completed' && l.item?.type === 'command_execution')
    assert.equal(commands.length, fixtures.length)
    for (const [index, item] of fixtures.entries()) {
      const done = commands[index]
      assert.deepEqual(done.source.item, item)
      assert.equal(done.item.aggregated_output, item.aggregatedOutput)
      assert.equal(done.item.exit_code, item.exitCode)
      assert.deepEqual(done.item.commandActions, item.commandActions)
      assert.equal(lines.filter(l => l.type === 'item.started' && l.source?.item?.id === item.id).length, 1)
    }
    const interactions = lines.filter(l => l.source?.event === 'item/commandExecution/terminalInteraction')
    assert.equal(interactions.length, 1)
    assert.equal(interactions[0].source.data.processId, fixtures[0].processId)
    assert.equal(interactions[0].source.data.stdin, '')
    assert.deepEqual(lines.filter(l => l.source?.event === 'item/commandExecution/outputDelta').map(l => l.source.data.delta), ['one\n', 'two\n'])
    assert.equal(lines.filter(l => l.item?.type === 'agent_message').length, 1)
    assert.deepEqual(r.sent().map(m => m.method), ['initialize', 'initialized', 'thread/start', 'turn/start'])
    assert.ok(!lines.some(l => l.type === 'codexmod.protocol'))
  } finally { r.cleanup() }
})

test('batch 4 web/tools: all search/open/find/MCP/dynamic evidence survives once without callbacks', async () => {
  const r = start('batch4-web-tools')
  try {
    assert.equal((await r.exit).code, 0)
    const { default: fixtures } = await import('./fixtures/batch4-items.mjs')
    const completed = r.lines().filter(l => l.type === 'item.completed' && l.source?.item?.type !== 'agentMessage')
    assert.equal(completed.length, fixtures.length)
    for (const item of fixtures) {
      const done = completed.find(l => l.source.item.id === item.id)
      assert.deepEqual(done.source.item, item)
      assert.equal(r.lines().filter(l => l.type === 'item.started' && l.source?.item?.id === item.id).length, 1)
    }
    assert.deepEqual(r.sent().map(m => m.method), ['initialize', 'initialized', 'thread/start', 'turn/start'])
    assert.ok(!r.lines().some(l => l.type === 'codexmod.protocol'))
  } finally { r.cleanup() }
})

test('batch 4 offline MCP fixture exposes real schemas and logs only explicit executor calls', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'batch4-mcp-'))
  const logFile = join(dir, 'calls.jsonl')
  try {
    const child = spawn(process.execPath, [join(here, 'fixtures/batch4-mcp-server.mjs')], {
      env: { ...process.env, FAKE_MCP_LOG: logFile }, stdio: ['pipe', 'pipe', 'pipe'],
    })
    let output = ''
    let stderr = ''
    child.stdout.on('data', d => { output += d })
    child.stderr.on('data', d => { stderr += d })
    const closed = new Promise(r => child.on('close', r))
    const requests = [
      { id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1' } } },
      { method: 'notifications/initialized' },
      { id: 2, method: 'tools/list' },
      ...['lookup', 'structured', 'media', 'fail'].map((name, i) => ({ id: 3 + i, method: 'tools/call', params: { name, arguments: { topic: 'fixture' } } })),
    ].map(m => ({ jsonrpc: '2.0', ...m }))
    child.stdin.end(requests.map(m => JSON.stringify(m)).join('\n') + '\n')
    assert.equal(await closed, 0, stderr)
    const replies = output.trim().split('\n').map(l => JSON.parse(l))
    const tools = replies.find(m => m.id === 2).result.tools
    assert.deepEqual(tools.map(t => t.name), ['lookup', 'structured', 'media', 'fail'])
    assert.equal(tools[0].inputSchema.additionalProperties, false)
    assert.deepEqual(tools[0].inputSchema.required, ['topic'])
    assert.deepEqual(tools[1].outputSchema.required, ['answer'])
    assert.deepEqual(replies.find(m => m.id === 4).result, { content: [], structuredContent: { answer: 42 } })
    assert.deepEqual(replies.find(m => m.id === 5).result.content.map(b => b.type), ['image', 'audio'])
    assert.equal(replies.find(m => m.id === 6).result.isError, true)
    assert.deepEqual(readFileSync(logFile, 'utf8').trim().split('\n').map(l => JSON.parse(l)), requests)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('batch 3 patches: exact per-file kinds/diffs, patchUpdated, failures and aggregate evidence survive once', async () => {
  const r = start('batch3-patches')
  try {
    const { code } = await r.exit
    assert.equal(code, 0, r.stderr())
    const fixtures = JSON.parse(readFileSync(join(here, 'fixtures/batch3-app-items.json'), 'utf8'))
    const completed = r.lines().filter(l => l.source?.event === 'item/completed' && l.source.item.type === 'fileChange')
    assert.equal(completed.length, fixtures.length)
    for (const item of fixtures) {
      const line = completed.find(l => l.source.item.id === item.id)
      assert.deepEqual(line.source.item, item.id === 'patch-updated' ? { ...item, changes: [] } : item)
      assert.equal(line.item.status, item.status)
      const patch = r.lines().find(l => l.source?.event === 'item/fileChange/patchUpdated' && l.source.data.itemId === item.id)
      assert.deepEqual(patch.source.data.changes, item.changes)
    }
    assert.equal(r.lines().filter(l => l.source?.event === 'turn/diff/updated').length, fixtures.length)
    assert.ok(!r.lines().some(l => l.type === 'codexmod.protocol'))
    assert.ok(completed.find(l => l.source.item.id === 'crlf').item.changes[0].diff.includes('\r\n'))
    assert.ok(completed.find(l => l.source.item.id === 'no-final-newline').item.changes[0].diff.includes('\\ No newline at end of file'))
  } finally { r.cleanup() }
})

test('batch 3 optional fake-Codex images stay in the supplied disposable root', async () => {
  const env = { FAKE_PATCH_DELAY_MS: '5' }
  const r = start('batch3-patches', { env, setup: control => { env.FAKE_PATCH_ROOT = join(control, '..', 'images') } })
  try {
    const { code } = await r.exit
    assert.equal(code, 0, r.stderr())
    const root = env.FAKE_PATCH_ROOT
    assert.equal(readFileSync(join(root, 'batch3/empty.txt'), 'utf8'), '')
    assert.equal(readFileSync(join(root, 'batch3/no-final-newline.txt'), 'utf8'), 'new')
    assert.equal(readFileSync(join(root, 'batch3/crlf.txt'), 'utf8'), 'one\r\ntwo\r\n')
    assert.equal(readFileSync(join(root, 'batch3/edit.txt'), 'utf8'), 'new\n')
    assert.equal(readFileSync(join(root, 'batch3/moved.txt'), 'utf8'), 'new\n')
    assert.equal(existsSync(join(root, 'batch3/move-edit.txt')), false)
    assert.equal(existsSync(join(root, 'batch3/delete-diff.txt')), false)
    assert.equal(readFileSync(join(root, 'batch3/partial-unknown.txt'), 'utf8'), 'new\n')
    const move = r.lines().find(l => l.source?.item?.id === 'move-edit' && l.type === 'item.completed')
    assert.equal(move.item.changes[0].kind.move_path, join(root, 'batch3/moved.txt'))
  } finally { r.cleanup() }
})

test('batch 3 exec harness fixture retains string kinds, move paths, exact text and outcomes', () => {
  const lines = readFileSync(join(here, 'fixtures/batch3-exec.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l))
  const completed = lines.filter(l => l.item?.type === 'file_change')
  assert.equal(completed.length, 22)
  assert.ok(completed.every(l => l.item.changes.every(c => typeof c.kind === 'string')))
  assert.equal(completed.find(l => l.item.id === 'move-edit').item.changes[0].move_path, 'batch3/moved.txt')
  assert.equal(completed.find(l => l.item.id === 'crlf').item.changes[0].diff, '+one\r\n+two\r\n')
  assert.equal(completed.find(l => l.item.id === 'partial-unknown').item.status, 'failed')
  assert.equal(completed.find(l => l.item.id === 'exec-no-diff').item.changes[0].diff, undefined)
})

// R5 first slice: the same operation engine serves HTTP and file controls.
const { createSteerControl } = await import('../hooks/steer-control.mjs')
const { messageStatus } = await import('../hooks/steer-control-text.mjs')
const { request: httpRequest } = await import('node:http')
function controlFixture(t, dispatch) {
  const control = mkdtempSync('/tmp/cm-v2-')
  const events = []
  const options = { control, generation: 'g1', destination: () => ({ id: 'thread', turnId: 'turn' }),
    dispatch, emit: e => events.push(e), interrupt: async () => {} }
  const bridge = createSteerControl(options)
  t.after(() => { bridge.close(); rmSync(control, { recursive: true, force: true }) })
  return { control, events, bridge, options }
}
const operation = (messageId, extra = {}) => ({ messageId, text: 'same literal body', expectedTurnId: 'turn', ...extra })
const socketCall = (descriptor, method, path, body) => new Promise((resolve, reject) => {
  const req = httpRequest({ socketPath: descriptor.socketPath, path, method,
    headers: { 'content-type': 'application/json', 'x-codex-generation': descriptor.generation } }, res => {
    let text = ''
    res.on('data', d => { text += d })
    res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(text) }))
  })
  req.on('error', reject)
  req.end(body ? JSON.stringify(body) : undefined)
})

test('R5 journal: distinct identical texts, duplicate IDs, conflicts, exact precondition and RPC IDs', async t => {
  const calls = []
  const f = controlFixture(t, async (params, beforeWrite) => { beforeWrite(101 + calls.length); calls.push(params); return { turnId: 'turn' } })
  for (const id of ['a', 'b', 'a']) { const e = await f.bridge.submit(operation(id)); await e.done }
  await assert.rejects(f.bridge.submit(operation('a', { text: 'conflicting' })), /conflicting/)
  assert.deepEqual(calls.map(c => c.clientUserMessageId), ['a', 'b'])
  assert.ok(calls.every(c => c.expectedTurnId === 'turn' && c.threadId === 'thread'))
  assert.equal(f.bridge.get('a').acceptedTurnId, 'turn')
  assert.equal(f.bridge.get('b').rpcRequestId, 102)
  assert.equal(f.events.length, 2)
  const recovered = createSteerControl({ ...f.options, generation: 'g2', dispatch: () => assert.fail('replayed accepted request') })
  const e = await recovered.submit(operation('a')); await e.done
  assert.equal(e.outcome.status, 'accepted')
})

for (const reply of [{}, { turnId: 'wrong' }]) test(`R5 malformed or foreign acknowledgment ${JSON.stringify(reply)} stays unknown`, async t => {
  const f = controlFixture(t, async () => reply)
  await (await f.bridge.submit(operation('bad'))).done
  assert.equal(f.bridge.get('bad').status, 'unknown')
  assert.equal(f.bridge.get('bad').acceptedTurnId, undefined)
})

test('R5 rejected steer retains the entire RPC error; stale turn dispatches nothing', async t => {
  const error = { code: -32600, message: 'review cannot be steered', data: { kind: 'review' } }
  let calls = 0
  const f = controlFixture(t, async () => { calls++; throw error })
  await (await f.bridge.submit(operation('review'))).done
  assert.deepEqual(f.bridge.get('review').error, error)
  assert.equal(f.bridge.get('review').status, 'rejected')
  await (await f.bridge.submit(operation('stale', { expectedTurnId: 'previous' }))).done
  assert.equal(calls, 1)
  assert.equal(f.bridge.get('stale').status, 'rejected')
})

test('R5 echo before/after ack, duplicates, null client IDs and foreign thread/turn are isolated', async t => {
  let finish
  const f = controlFixture(t, () => new Promise(resolve => { finish = resolve }))
  const e = await f.bridge.submit(operation('echo'))
  f.bridge.observe('other', 'turn', { type: 'userMessage', id: 'wrong', clientId: 'echo' })
  f.bridge.observe('thread', 'other', { type: 'userMessage', id: 'wrong', clientId: 'echo' })
  f.bridge.observe('thread', 'turn', { type: 'userMessage', id: 'wrong', clientId: null })
  assert.equal(e.outcome.echoedItemId, undefined)
  f.bridge.observe('thread', 'turn', { type: 'userMessage', id: 'item-1', clientId: 'echo' })
  assert.equal(e.outcome.status, 'pending')
  finish({ turnId: 'turn' }); await e.done
  f.bridge.observe('thread', 'turn', { type: 'userMessage', id: 'item-1', clientId: 'echo' })
  assert.equal(e.outcome.echoedItemId, 'item-1')
  assert.equal(e.outcome.acceptedTurnId, 'turn')
})

test('R5 crash after dispatch or acceptance before durable ack recovers uncertain without retry', async t => {
  let calls = 0
  const f = controlFixture(t, () => { calls++; return new Promise(() => {}) })
  await f.bridge.submit(operation('crashed'))
  const recovered = createSteerControl({ ...f.options, generation: 'new', dispatch: () => assert.fail('unsafe retry') })
  const e = await recovered.submit(operation('crashed'))
  assert.equal(e.outcome.status, 'unknown')
  assert.equal(calls, 1)
})

test('R5 private Unix HTTP: health negotiation, finite pending response, late ack/query and conflicts', async t => {
  let finish
  const f = controlFixture(t, () => new Promise(resolve => { finish = resolve }))
  const d = await f.bridge.listen()
  if (d.channel !== 'unix') { t.skip(d.reason); return }
  assert.equal(statSync(d.socketPath).mode & 0o777, 0o600)
  assert.equal((await socketCall(d, 'GET', '/health')).body.version, 2)
  const body = { ...operation('late'), runId: f.control }
  const initial = await socketCall(d, 'POST', '/messages', body)
  assert.equal(initial.body.status, 'pending')
  finish({ turnId: 'turn' })
  await sleep(10)
  const final = await socketCall(d, 'GET', '/messages/late')
  assert.equal(final.body.acceptedTurnId, 'turn')
  assert.equal((await socketCall(d, 'POST', '/messages', { ...body, text: 'conflict' })).status, 409)
  assert.equal((await socketCall({ ...d, generation: 'old' }, 'POST', '/messages', body)).status, 409)
})

test('R5 socket unavailable advertises file fallback and still journals one file operation', async t => {
  const f = controlFixture(t, async () => ({ turnId: 'turn' }))
  const longControl = join(f.control, 'x'.repeat(100))
  mkdirSync(longControl)
  const bridge = createSteerControl({ ...f.options, control: longControl })
  t.after(() => bridge.close())
  const d = await bridge.listen()
  assert.equal(d.channel, 'file')
  assert.equal(JSON.parse(readFileSync(join(longControl, 'control.json'), 'utf8')).version, 2)
  await (await bridge.submit(operation('file'))).done
  assert.equal(bridge.get('file').status, 'accepted')
})

test('R5 literal status covers coordinator card, exec FIFO, rejection and unknown without claiming consumption', () => {
  assert.match(messageStatus(), /Received/)
  assert.equal(messageStatus({ status: 'accepted', acceptedTurnId: 'X' }), 'Accepted into turn X')
  assert.equal(messageStatus({ status: 'queued', queuedAfterTurnId: 'X', reason: 'review' }), 'Queued after turn X · review')
  assert.equal(messageStatus({ status: 'rejected', reason: '<literal>' }), 'Rejected: <literal>')
  assert.match(messageStatus({ status: 'unknown', messageId: 'm' }), /query m/)
})

test('R5 raw server -32000 is rejected, while a local connection loss is uncertain', async t => {
  const f = controlFixture(t, async params => { throw params.clientUserMessageId === 'rpc' ? { code: -32000, message: 'server refusal', data: { raw: true } } : { code: -2, message: 'connection lost', transport: true } })
  await (await f.bridge.submit(operation('rpc'))).done
  await (await f.bridge.submit(operation('lost'))).done
  assert.equal(f.bridge.get('rpc').status, 'rejected')
  assert.deepEqual(f.bridge.get('rpc').error.data, { raw: true })
  assert.equal(f.bridge.get('lost').status, 'unknown')
})

for (const scenario of ['steer-v2-accepted', 'steer-v2-rejected', 'steer-v2-late-ack', 'steer-v2-wrong-ack', 'steer-v2-lost-ack']) test(`live harness ${scenario}: waits without unrelated actions and records one exact message`, async t => {
  const r = start(scenario)
  t.after(() => { r.child.kill(); r.cleanup() })
  await r.waitFor(() => types(r).includes('codexmod.turn'))
  assert.ok(!r.lines().some(l => l.item || l.source?.item), 'steer harness must not emit generic ls/patch fixture work')
  writeFileSync(join(r.control, 'steer-harness.json'), JSON.stringify({ text: 'Keep waiting; include MARKER.', messageId: 'harness-source', expectedTurnId: 'turn-1' }))
  await r.waitFor(() => r.lines().some(l => l.type === 'codexmod.steer' && ['accepted', 'observed', 'rejected', 'unknown'].includes(l.status)))
  const outcome = r.lines().filter(l => l.type === 'codexmod.steer').at(-1)
  assert.equal(outcome.messageId, 'harness-source')
  if (scenario === 'steer-v2-rejected') assert.deepEqual(outcome.error, { code: -32600, message: 'cannot steer a review turn', data: { turnKind: 'review' } })
  else if (['steer-v2-wrong-ack', 'steer-v2-lost-ack'].includes(scenario)) assert.equal(outcome.status, 'unknown')
  else assert.equal(outcome.acceptedTurnId, 'turn-1')
  if (scenario !== 'steer-v2-lost-ack') writeFileSync(join(r.control, 'interrupt'), '')
  await r.exit
  assert.equal(r.sent().filter(m => m.method === 'turn/steer').length, 1)
  assert.ok(!r.lines().some(l => l.item?.type === 'command_execution' || l.item?.type === 'file_change'))
})

test('R6 exec cumulative fixture: delta, unknown baseline, reset and malformed counts', async () => {
  const { execDelta, zeroUsage } = await import('../hooks/exec-usage.mjs')
  const fixture = JSON.parse(readFileSync(join(here, 'fixtures/cache-exec-cumulative.json'), 'utf8'))
  assert.deepEqual(execDelta(fixture.first, zeroUsage()), { usage: fixture.first, partial: false })
  for (let i = 0; i < 3; i++) assert.deepEqual(execDelta(fixture.followUpTotal, fixture.first), { usage: fixture.followUpDelta, partial: false })
  assert.deepEqual(execDelta(fixture.followUpTotal, undefined), { partial: true })
  assert.deepEqual(execDelta(fixture.first, fixture.followUpTotal), { partial: true })
  assert.deepEqual(execDelta({ input: NaN, cached: 0, output: 0 }, zeroUsage()), { partial: true })
})

for (const scenario of ['cache-accounting', 'cache-missing-last', 'cache-interrupt']) test(`R6 ${scenario}: resumed zero baseline, stale turns, duplicate responses and final direct totals`, async () => {
  const r = start(scenario, { extra: ['--thread', 'same-thread'] })
  try {
    assert.equal((await r.exit).code, scenario === 'cache-interrupt' ? 1 : 0)
    const direct = r.lines().filter(e => e.type === 'codexmod.directUsage').at(-1)
    assert.deepEqual(direct.usage, { input: 1000, cached: 600, output: 50 })
    assert.equal(direct.partial, scenario === 'cache-missing-last')
    const total = r.lines().filter(e => e.type === 'codexmod.threadUsage').at(-1)
    assert.deepEqual(total, { type: 'codexmod.threadUsage', thread_id: 'same-thread', total: { input: 6000, cached: 4600, output: 550 } })
    const stored = JSON.parse(readFileSync(join(r.control, 'usage.json'), 'utf8'))
    assert.equal(stored.responses.length, 1)
    assert.equal(stored.turns.length, 1)
  } finally { r.cleanup() }
})

test('R6 app-server capacity text is retained for the hook retry; sidecar itself never retries', async () => {
  const r = start('cache-capacity', { extra: ['--model', 'gpt-6.1-sol', '--thread', 'same-thread'] })
  try {
    assert.equal((await r.exit).code, 1)
    assert.ok(r.lines().some(e => e.type === 'turn.failed' && e.error.message === 'Selected model is at capacity. Please try a different model.'))
    assert.equal(r.sent().filter(m => m.method === 'turn/start').length, 1)
    assert.equal(r.sent().find(m => m.method === 'thread/resume').params.threadId, 'same-thread')
  } finally { r.cleanup() }
})
