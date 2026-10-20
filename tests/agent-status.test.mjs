import test from 'node:test'
import assert from 'node:assert/strict'
import { agentStatus } from '../hooks/agent-status.ts'

const record = (event, item, data) => ({ event, transport: 'exec', threadId: 'thread', turnId: 'turn', itemId: item?.id, item, data })
const run = records => ({ ledger: { records }, startedAtMs: 100, lastSourceObservedAtMs: 120,
  thread: 'thread', turnId: 'turn', cwd: '/repo', prof: { model: 'gpt-6.1-sol', effort: 'medium' }, transport: 'exec',
  execution: { sandbox: 'read-only', networkAccess: false, approvalMode: 'never' } })
const pending = { approvals: 0, questions: 0 }

test('source lifecycle, explicit status and deduplicated completion count remain distinct', () => {
  const source = run([record('turn.started'), record('item.started', { id: 'cmd', type: 'commandExecution', command: 'node --test', status: 'inProgress' })])
  const active = agentStatus(source, 150, pending)
  assert.equal(active.sourceState, 'inProgress')
  assert.equal(active.currentAction.status, 'inProgress')
  assert.equal(active.currentAction.lifecycle, 'started')
  assert.equal(active.currentAction.command.text, 'node --test')
  assert.equal(active.completedActions, 0)
  assert.equal(active.elapsedMs, 50)
  const done = record('item/completed', { id: 'cmd', type: 'commandExecution', command: 'node --test', status: 'failed', result: 'PRIVATE_RESULT' })
  source.ledger.records.push(done, done)
  const result = agentStatus(source, 160, pending)
  assert.equal(result.completedActions, 1)
  assert.equal(result.currentAction, null)
  assert.equal(result.lastAction.status, 'failed')
  assert.equal(result.lastAction.lifecycle, 'completed')
  assert.equal(result.sourceState, 'inProgress')
  source.ledger.records.push(record('turn/completed', undefined, { turn: { status: 'interrupted' } }))
  assert.equal(agentStatus(source, 160, pending).sourceState, 'interrupted')
})

test('missing source fields remain unknown rather than guessing activity or completion', () => {
  const source = run([record('item.started', { type: 'commandExecution', command: 'pwd' })])
  delete source.startedAtMs
  delete source.lastSourceObservedAtMs
  delete source.execution
  const result = agentStatus(source, null, pending)
  assert.equal(result.sourceState, 'unknown')
  assert.equal(result.lastAction.status, null)
  assert.equal(result.launchedAt, null)
  assert.equal(result.elapsedMs, null)
  assert.equal(result.lastSourceObservedAt, null)
  assert.equal(result.execution.networkAccess, null)
  source.ledger.records.push(record('item.completed', { type: 'commandExecution' }))
  assert.equal(agentStatus(source, null, pending).completedActions, null)
})

test('parallel completion preserves still-active source commands', () => {
  const source = run([record('turn.started'),
    record('item.started', { id: 'a', type: 'commandExecution', command: 'sleep 60', status: 'inProgress' }),
    record('item.started', { id: 'b', type: 'commandExecution', command: 'echo done', status: 'inProgress' })])
  assert.equal(agentStatus(source, 200, pending).activeActions, 2)
  source.ledger.records.push(record('item.updated', { id: 'a', type: 'commandExecution', command: 'sleep 60', status: 'inProgress' }))
  assert.equal(agentStatus(source, 200, pending).currentAction.command.text, 'sleep 60')
  source.ledger.records.push(record('item.completed', { id: 'b', type: 'commandExecution', command: 'echo done', status: 'completed' }))
  const result = agentStatus(source, 200, pending)
  assert.equal(result.activeActions, 1)
  assert.equal(result.currentAction.command.text, 'sleep 60')
  assert.equal(result.currentAction.status, 'inProgress')
  assert.equal(result.lastAction.command.text, 'echo done')
  assert.equal(result.lastAction.status, 'completed')
})

test('only bounded public activity crosses the projection, with no mutation on polling', () => {
  const source = run([
    record('item.completed', { id: 'r', type: 'reasoning', summary: ['PRIVATE_SUMMARY'], text: 'PRIVATE_REASONING', content: ['PRIVATE_CONTENT'] }),
    record('item/started', { id: 'cmd', type: 'commandExecution', command: '😀\n'.repeat(10000), status: 'inProgress',
      arguments: { secret: 'PRIVATE_ARGS' }, aggregatedOutput: 'PRIVATE_RESULT' }),
    record('item.completed', { id: 'c', type: 'agentMessage', phase: 'commentary', text: 'Working publicly. '.repeat(10000) }),
    record('codexmod.request', undefined, { token: 'PRIVATE_TOKEN', params: { prompt: 'PRIVATE_PROMPT' } }),
  ])
  source.cwd = '/repo/' + '\u0000😀'.repeat(10000)
  source.env = { API_KEY: 'PRIVATE_ENV' }
  source.config = { home: 'PRIVATE_HOME' }
  const before = JSON.stringify(source)
  const first = agentStatus(source, 200, { approvals: 1, questions: 2 }, () => 'Run command')
  const text = JSON.stringify(first)
  assert.equal(first.currentAction.command.clipped, true)
  assert.equal(first.publicUpdate.clipped, true)
  assert.equal(first.execution.cwd.clipped, true)
  assert.ok(Buffer.byteLength(text) < 4096)
  assert.ok(!text.includes('PRIVATE_'))
  assert.deepEqual(first.pending, { approvals: 1, questions: 2 })
  assert.equal(JSON.stringify(source), before)
  const later = agentStatus(source, 300, pending)
  assert.equal(later.lastSourceObservedAt, first.lastSourceObservedAt)
  assert.equal(later.launchedAt, first.launchedAt)
  assert.equal(JSON.stringify(source), before)
})

test('plans and commentary are source-public excerpts with clipping disclosed', () => {
  for (const type of ['todo_list', 'plan_update']) {
    const steps = Array.from({ length: 20 }, (_, i) => ({ text: `task ${i} ` + 'x'.repeat(500), step: `task ${i} ` + 'x'.repeat(500), status: 'pending' }))
    const source = run([record('item.updated', { type, items: steps, steps, explanation: 'PRIVATE_EXPLANATION' })])
    const result = agentStatus(source, 200, pending)
    assert.equal(result.publicUpdate.kind, 'plan')
    assert.equal(result.publicUpdate.clipped, true)
    assert.ok(result.publicUpdate.text.startsWith('task 0'))
    assert.ok(!JSON.stringify(result).includes('PRIVATE_EXPLANATION'))
  }
  const source = run([record('item.completed', { type: 'plan', text: 'Public proposed plan' }),
    { ...record('item.completed', { type: 'agentMessage', phase: 'commentary', text: 'FOREIGN_TURN' }), turnId: 'other' },
    record('item.completed', { type: 'agentMessage', phase: 'final_answer', text: 'FINAL_REPORT' })])
  assert.equal(agentStatus(source, 200, pending).publicUpdate.text, 'Public proposed plan')
})

test('lone surrogates and escaped controls respect each serialized preview byte budget', () => {
  for (const text of ['\ud800'.repeat(1000), '\udfff'.repeat(1000), '\u0000'.repeat(1000), '😀'.repeat(1000)]) {
    const source = run([record('item.started', { id: 'cmd', type: 'commandExecution', command: text, status: 'inProgress' })])
    const result = agentStatus(source, 200, pending)
    assert.equal(result.currentAction.command.clipped, true)
    assert.ok(Buffer.byteLength(JSON.stringify(result.currentAction.command.text).slice(1, -1)) <= 700)
    assert.ok(Buffer.byteLength(JSON.stringify(result)) < 4096)
  }
})

test('maximum public previews and parallel activity stay below the complete response byte bound', () => {
  const text = 'x'.repeat(10000)
  const source = run([record('item.started', { id: 'a', type: 'commandExecution', command: text, status: 'inProgress' }),
    record('item.completed', { id: 'b', type: 'commandExecution', command: text, status: 'completed' }),
    record('item.completed', { type: 'agentMessage', phase: 'commentary', text })])
  source.cwd = source.prof.model = source.prof.effort = text
  source.execution = { sandbox: 'danger-full-access', networkAccess: true, approvalMode: 'orchestrator' }
  const result = agentStatus(source, Number.MAX_SAFE_INTEGER, { approvals: 1000000, questions: 1000000 }, () => text)
  assert.equal(result.currentAction.status, 'inProgress')
  assert.equal(result.lastAction.status, 'completed')
  assert.ok(Buffer.byteLength(JSON.stringify(result)) < 4096)
})
