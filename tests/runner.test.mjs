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
  assert.deepEqual(l.at(-1), { type: 'turn.completed', usage: { input_tokens: 508, cached_input_tokens: 202, output_tokens: 32 } })
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

test('steer mid-turn is forwarded and acked accepted', async () => {
  const r = start('steer')
  await r.waitFor(() => types(r).includes('codexmod.turn'))
  writeFileSync(join(r.control, 'steer-1.json'), JSON.stringify({ text: 'change plan' }))
  const { code } = await r.exit
  assert.equal(code, 0)
  assert.deepEqual(r.lines().find(l => l.type === 'codexmod.steer'), { type: 'codexmod.steer', id: 1, status: 'accepted' })
  const st = r.sent().find(m => m.method === 'turn/steer')
  assert.equal(st.params.threadId, 'thr-1')
  assert.equal(st.params.expectedTurnId, 'turn-1')
  assert.equal(st.params.input[0].text, 'change plan')
  assert.ok(!existsSync(join(r.control, 'steer-1.json')))
  r.cleanup()
})

test('a steer rejected by app-server is acked rejected with the reason', async () => {
  const r = start('steer-reject')
  await r.waitFor(() => types(r).includes('codexmod.turn'))
  writeFileSync(join(r.control, 'steer-7.json'), JSON.stringify({ text: 'x' }))
  await r.waitFor(() => types(r).includes('codexmod.steer'))
  assert.deepEqual(r.lines().find(l => l.type === 'codexmod.steer'), { type: 'codexmod.steer', id: 7, status: 'rejected', reason: 'expected turn mismatch' })
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
  assert.deepEqual(r.lines().find(l => l.type === 'codexmod.steer'), { type: 'codexmod.steer', id: 9, status: 'rejected', reason: 'turn finished' })
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
  assert.deepEqual(r.lines().find(l => l.type === 'codexmod.steer'), { type: 'codexmod.steer', id: 3, status: 'accepted' })
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
  assert.deepEqual(r.lines().at(-1), { type: 'turn.failed', error: { message: 'interrupted' } })
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
  assert.deepEqual(r.lines().at(-1), { type: 'turn.failed', error: { message: 'interrupted' } })
  r.cleanup()
})

test('interrupt written before the turn id is known is sent once the turn starts', async () => {
  const r = start('slow-start')
  await r.waitFor(() => types(r).includes('thread.started'))
  writeFileSync(join(r.control, 'interrupt'), '')
  const { code } = await r.exit
  assert.equal(code, 1)
  assert.deepEqual(r.lines().at(-1), { type: 'turn.failed', error: { message: 'interrupted' } })
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
  assert.deepEqual(r.lines().at(-1), { type: 'turn.failed', error: { message: 'interrupted' } })
  r.cleanup()
})

test('server approval request is answered -32601', async () => {
  const r = start('approval')
  const { code } = await r.exit
  assert.equal(code, 0)
  const reply = r.sent().find(m => m.id === 101 && m.method === undefined)
  assert.equal(reply.error.code, -32601)
  assert.equal(reply.error.message, 'unsupported by codex-mod')
  r.cleanup()
})

test('a malformed line is reported once and skipped', async () => {
  const r = start('malformed')
  const { code } = await r.exit
  assert.equal(code, 0)
  assert.equal(r.lines().filter(l => l.type === 'error').length, 1)
  assert.equal(r.lines().at(-1).type, 'turn.completed')
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
    await t.test('miscellaneous items produce one dim note each; imageView is deferred', () => {
      assert.deepEqual(items.filter(i => i.type === 'note' && i.dim).map(i => i.text), [
        'Codex compacted context', 'Codex entered review mode', 'Codex exited review mode', 'Codex slept for 125 ms', 'Codex image generation: completed (/tmp/generated.png)',
      ])
      assert.ok(!items.some(i => /image.?view/i.test(i.type)))
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
      assert.deepEqual(r.sent().find(m => m.id === 101 && !m.method).error, { code: -32601, message: 'unsupported by codex-mod' })
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
