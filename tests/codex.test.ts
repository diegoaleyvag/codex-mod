import { test, expect } from 'claude-code/testing'
import type { On } from 'claude-code'
import { compact, diffEdit, footer, mcpServerNames, unwrapShell, describeCommand, parseConfig, parseModelsCache, checkProfile, stripCoordinator, launchArgv, SHADOW_LINKS, cleanText, readConversation, itemsFromApi, parseCodexLine, runnerArgv, parseCodexVersion, codexTooOld, modelProvider, steerNote } from '../hooks/codex.ts'

// The test environment has timers; the hooks' type environment declares none.
declare const setTimeout: (fn: () => void, ms: number) => unknown

const MODELS_CACHE = JSON.stringify({
  fetched_at: '2026-10-18T00:00:00Z', etag: 'x', client_version: '0.163.0',
  models: [
    { slug: 'gpt-hidden', visibility: 'hide', priority: 0, supported_reasoning_levels: [{ effort: 'low' }] },
    { slug: 'gpt-6-luna', display_name: 'Luna', visibility: 'list', priority: 4, default_reasoning_level: 'medium', supported_reasoning_levels: ['low', 'medium', 'high', 'xhigh', 'max'].map(effort => ({ effort, description: effort })) },
    { slug: 'gpt-6.1-sol', display_name: 'Sol', visibility: 'list', priority: 1, default_reasoning_level: 'low', supported_reasoning_levels: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'].map(effort => ({ effort, description: effort })) },
  ],
})

const CODEX_JSONL = [
  '{"type":"thread.started","thread_id":"t-1"}',
  '{"type":"turn.started"}',
  '{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"PONG"}}',
  '{"type":"turn.completed","usage":{"input_tokens":1,"output_tokens":1}}',
  '',
].join('\n')

type Status = 'running' | 'completed' | 'killed'
const AGENT_TYPES: Record<string, string> = {
  'agent-codex': 'codex-mod:codex',
  'agent-sol': 'codex-mod:sol',
  'agent-solh': 'codex-mod:sol-high',
  'agent-astra': 'codex-mod:astra-audit',
  'agent-resume': 'codex-mod:sol',
  'agent-deny': 'codex-mod:sol',
  'agent-gp': 'general-purpose',
  'agent-keep': 'codex-mod:sol',
  'agent-new-effort': 'codex-mod:sol',
  'agent-persist': 'codex-mod:sol',
  'agent-restarted': 'codex-mod:sol-high',
  'agent-moved': 'codex-mod:sol',
  'agent-compact': 'codex-mod:sol',
  'agent-progress': 'codex-mod:codex',
  'agent-throttle': 'codex-mod:codex',
  'agent-files': 'codex-mod:codex',
  'agent-abort': 'codex-mod:codex',
  'agent-stopped': 'codex-mod:codex',
  'agent-turnend': 'codex-mod:codex',
  'agent-lost': 'codex-mod:codex',
  'agent-folded': 'codex-mod:codex',
  'agent-never-stepped': 'codex-mod:codex',
  'agent-text': 'codex-mod:codex',
  'agent-text-actions': 'codex-mod:codex',
  'agent-force-text': 'codex-mod:codex',
  'agent-force-tool': 'codex-mod:codex',
  'agent-throws': 'codex-mod:codex',
  'agent-unknown-role': 'codex-mod:retired',
  'agent-restart-guard': 'codex-mod:sol',
  'agent-gp2': 'general-purpose',
  'agent-wrapped': 'codex-mod:codex',
  'agent-wrapped-mid': 'codex-mod:codex',
  'agent-text-follow': 'codex-mod:codex',
  'agent-timeout': 'codex-mod:codex',
  'agent-plain': 'codex-mod:codex',
  'agent-plain-tool': 'codex-mod:codex',
  'agent-footer-short': 'codex-mod:sol',
  'agent-footer-off': 'codex-mod:sol',
  'agent-extra': 'codex-mod:codex',
  'agent-shadow': 'codex-mod:codex',
  'agent-cat-model': 'codex-mod:codex',
  'agent-cat-effort': 'codex-mod:codex',
  'agent-cat-ultra': 'codex-mod:codex',
  'agent-live': 'codex-mod:codex',
  'agent-live-rows': 'codex-mod:codex',
  'agent-fallback': 'codex-mod:codex',
  'agent-window': 'codex-mod:codex',
  'agent-guard-restart': 'codex-mod:sol',
  'agent-drift': 'codex-mod:codex',
  'agent-drift-ok': 'codex-mod:codex',
  'agent-drift-version': 'codex-mod:codex',
  'agent-exec-notimer': 'codex-mod:codex',
  'agent-provider': 'codex-mod:codex',
  'agent-app': 'codex-mod:sol',
  'agent-app-fallback': 'codex-mod:codex',
  'agent-app-lazy': 'codex-mod:codex',
  'agent-app-steer': 'codex-mod:codex',
  'agent-app-reject': 'codex-mod:codex',
  'agent-app-unacked': 'codex-mod:codex',
  'agent-app-mid': 'codex-mod:codex',
  'agent-app-kill': 'codex-mod:codex',
  'agent-app-kill-hard': 'codex-mod:codex',
  'agent-app-fatal': 'codex-mod:codex',
  'agent-app-drift': 'codex-mod:codex',
  'agent-exec-note': 'codex-mod:codex',
  'agent-app-plain-steer': 'codex-mod:codex',
}

type Spawned = { argv: readonly string[]; input?: string; cwd?: string; env?: Record<string, string> }
type Piece = { stream: 'stdout' | 'stderr'; text: string }
type WorldOpts = {
  /** `$.agent.list` rejects. */
  listThrows?: boolean
  stdout?: string
  stderr?: string
  code?: number
  task?: string
  reject?: boolean
  messages?: () => any
  /**
   * Exact pieces, in order; `'block'` waits until the child is killed (or 4 s);
   * a function is polled every 10 ms until it is true (or 4 s), then the next piece comes.
   */
  pieces?: readonly (Piece | 'block' | (() => boolean))[]
  store?: Map<string, unknown>
  /** What `$.fs.read` finds, by absolute path (mutable between steps). */
  files?: Map<string, string>
  /** False: the agent's conversation lacks the host's SubagentHandback reminder (no auto mode). */
  handback?: boolean
  /** `$.session.messages({ as: "api" })` is denied (rows only). */
  noApi?: boolean
}

/** The meta row the host puts in an agent's conversation when its report goes through SubagentHandback. */
const HANDBACK_ROW = {
  role: 'user',
  isMeta: true,
  text: '<system-reminder>\nYour final report is delivered through SubagentHandback: when your work is complete, call SubagentHandback({message: <your full report>}). The call ends your run, so make it your last step.\n</system-reminder>',
  toolUses: [],
}

/** The world beneath the plugin: agents, the agent's conversation, cwd, a fake codex, a clock, a store, files, the tools' core. */
function world(on: On, opts: WorldOpts = {}) {
  const spawned: Spawned[] = []
  const modelCalls: string[] = []
  const logs: string[] = []
  const sleeps: number[] = []
  const kills = { count: 0, bySignal: 0 }
  const status = new Map<string, Status>()
  const store = opts.store ?? new Map<string, unknown>()
  const files = opts.files ?? new Map<string, string>()
  const clock = { now: 1_000_000 }
  // every call that reached the engine's own tool path (permission + run)
  const core: { tool: string; id?: string; agentId?: string }[] = []
  const checks: { tool: string; agentId?: string }[] = []
  // every `$.fs.write`, in order (steer and interrupt files of app-server runs)
  const writes: { path: string; text: string }[] = []
  on('fs.write', (_$, e: any) => {
    writes.push({ path: e.path, text: e.text })
    return { value: undefined }
  })
  on('ui.log', (_$, e: any) => {
    logs.push(String(e.text ?? ''))
    return { value: undefined }
  })
  on('session.start', () => ({ cwd: '/tmp/project' }))
  on('agent.list', () => {
    if (opts.listThrows) throw new Error('agent list unavailable')
    return { value: Object.entries(AGENT_TYPES).map(([id, type]) => ({ id, type, description: id, status: status.get(id) ?? ('running' as const) })) }
  })
  on('session.cwd', () => ({ value: '/tmp/project' }))
  on('session.id', () => ({ value: 'sess-1' }))
  on('clock.now', () => ({ value: clock.now }))
  on('clock.sleep', (_$, e: any) => {
    sleeps.push(e.ms)
    clock.now += e.ms
    return { value: undefined }
  })
  on('env.get', (_$, e: any) => ({ value: e.name === 'HOME' ? '/home/t' : undefined }))
  on('fs.read', (_$, e: any) => {
    const text = files.get(e.path)
    if (text === undefined) throw new Error(`ENOENT ${e.path}`)
    return { value: text }
  })
  on('store.get', (_$, e) => ({ value: store.get(e.key) }))
  on('store.set', (_$, e) => {
    store.set(e.key, JSON.parse(JSON.stringify(e.value)))
    return { value: undefined }
  })
  on('store.delete', (_$, e) => {
    store.delete(e.key)
    return { value: undefined }
  })
  on('store.keys', () => ({ value: [...store.keys()] }))
  on('tool.call', (_$, e: any) => {
    core.push({ tool: e.tool, id: e.tool_use_id, agentId: e.agentId })
    return { result: { stdout: 'REALLY RAN', stderr: '', interrupted: false } } as any
  })
  on('tool.check', (_$, e: any) => {
    checks.push({ tool: e.tool, agentId: e.agentId })
    return { decision: 'allow' as const }
  })
  // As the engine answers: the rows form leaves meta rows out (isMeta), the API form carries them.
  on('session.messages', (_$, e: any) => {
    const raw = opts.messages ? opts.messages() : [{ role: 'user', text: opts.task ?? '<system-reminder>ignore me</system-reminder>\nReply with the single word PONG', toolUses: [] }]
    const rows = Array.isArray(raw) && opts.handback !== false ? [raw[0], HANDBACK_ROW, ...raw.slice(1)].filter(Boolean) : raw
    if (!Array.isArray(rows)) return { value: rows }
    if (e.as === 'api') return { value: opts.noApi ? { deny: 'no api form' } : rows.map(apiOf) }
    return { value: rows.filter((r: any) => r.isMeta !== true).map(({ isMeta: _m, ...r }: any) => r) }
  })
  on('process.spawn', async function* (_$, e, next) {
    if (opts.reject) throw new Error('spawn ENOENT')
    spawned.push({ argv: e.argv, input: e.input, cwd: e.cwd, env: e.env })
    try {
      if (opts.pieces) {
        for (const p of opts.pieces) {
          if (typeof p === 'function') {
            for (let i = 0; i < 400 && !p() && !next.signal.aborted; i++) await new Promise<void>(r => setTimeout(r, 10))
            continue
          }
          if (p === 'block') {
            await new Promise<void>(resolve => {
              next.signal.addEventListener('abort', () => resolve())
              setTimeout(resolve, 4000)
            })
            if (next.signal.aborted) kills.bySignal++
            continue
          }
          yield p
        }
      } else {
        const out = opts.stdout ?? CODEX_JSONL
        // split mid-line to prove the hook reassembles lines
        const cut = Math.floor(out.length / 2)
        if (out.slice(0, cut)) yield { stream: 'stdout' as const, text: out.slice(0, cut) }
        if (out.slice(cut)) yield { stream: 'stdout' as const, text: out.slice(cut) }
        if (opts.stderr) yield { stream: 'stderr' as const, text: opts.stderr }
      }
      return { value: { code: opts.code ?? 0, signal: null } }
    } finally {
      if (next.signal.aborted) kills.count++
    }
  })
  on('turn.step', async function* (_$, e) {
    modelCalls.push(e.agentId ?? 'main')
    yield { kind: 'text' as const, index: 0, text: 'from the model' }
    return { turnId: e.turnId, index: e.index, answer: 'from the model', toolUses: [], stopReason: 'end_turn' as const, usage: null }
  })
  return { spawned, modelCalls, logs, sleeps, kills, status, store, clock, files, core, checks, writes }
}

/** A SessionMessage-shaped test row in the Messages API form. */
function apiOf(r: any): any {
  if (r.role === 'assistant') {
    const content = [...(r.text ? [{ type: 'text', text: r.text }] : []), ...(r.toolUses ?? []).map((u: any) => ({ type: 'tool_use', id: u.tool_use_id, name: u.tool, input: u.input ?? {} }))]
    return { role: 'assistant', content }
  }
  const results = (r.toolResults ?? []).map((t: any) => ({ type: 'tool_result', tool_use_id: t.tool_use_id, content: t.text, ...(t.isError ? { is_error: true } : {}) }))
  return { role: 'user', content: [...results, ...(r.text ? [{ type: 'text', text: r.text }] : [])] }
}

async function step($: any, agentId?: string, index = 0, turnId = 'turn-1') {
  const stream = $.turn.step({ turnId, index, model: 'claude-haiku-4-5', messageCount: 1, ...(agentId ? { agentId } : {}) })
  const chunks: any[] = []
  for (;;) {
    const r = await stream.next()
    if (r.done) return { chunks, result: r.value }
    chunks.push(r.value)
  }
}

/** The tool calls a step emitted: `{ id, name, input }` each. */
const callsOf = (chunks: any[]) =>
  chunks.filter(c => c.kind === 'tool').map(c => ({ id: c.id as string, name: c.name as string, input: JSON.parse(chunks.find(i => i.kind === 'input' && i.index === c.index).json) }))
/** What the engine does next with a step's calls: raises tool.call for each, in the agent's loop. */
const runCalls = ($: any, chunks: any[], agentId: string) =>
  Promise.all(callsOf(chunks).map(c => $.tool.call({ tool: c.name, ...c.input, tool_use_id: c.id, agentId } as any)))
const handback = (result: any): string => result.toolUses.find((u: any) => u.name === 'SubagentHandback')!.input.message
const firstLine = (a: string) => a.split('\n')[0]!
const lastLine = (a: string) => a.split('\n').at(-1)!

const out = (line: string): Piece => ({ stream: 'stdout', text: `${line}\n` })
const cmdDone = (command: string, output = '', exit: number | null = 0) =>
  out(JSON.stringify({ type: 'item.completed', item: { type: 'command_execution', command, aggregated_output: output, exit_code: exit, status: exit === 0 ? 'completed' : 'failed' } }))
const cmdStart = (command: string) => out(JSON.stringify({ type: 'item.started', item: { type: 'command_execution', command, aggregated_output: '', exit_code: null } }))
const fileEv = (type: 'item.started' | 'item.completed', path: string, kind: string) =>
  out(JSON.stringify({ type, item: { type: 'file_change', changes: [{ path, kind }] } }))
const THREAD = (id: string) => out(JSON.stringify({ type: 'thread.started', thread_id: id }))
const MESSAGE = (text: string) => out(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text } }))
const USAGE = out('{"type":"turn.completed","usage":{"input_tokens":21269,"cached_input_tokens":20992,"output_tokens":46}}')

const user = (text: string) => ({ role: 'user', text, toolUses: [] })
const toolResult = (tool: string, id = 'x') => [
  { role: 'assistant', text: '', toolUses: [{ tool_use_id: id, tool, input: {} }] },
  { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: id, text: 'ok', isError: false }] },
]
const argOf = (argv: readonly string[], flag: string) => argv[argv.indexOf(flag) + 1]

test('a main-loop step passes through to the model', async ($, on) => {
  const w = world(on)
  const { chunks, result } = await step($)
  expect(w.modelCalls).toEqual(['main'])
  expect(w.spawned.length).toBe(0)
  expect(result.answer).toBe('from the model')
  expect(chunks.map(c => c.text)).toEqual(['from the model'])
})

test('another agent type passes through to the model', async ($, on) => {
  const w = world(on)
  const { result } = await step($, 'agent-gp')
  expect(w.modelCalls).toEqual(['agent-gp'])
  expect(w.spawned.length).toBe(0)
  expect(result.answer).toBe('from the model')
})

test('a codex agent step is answered by codex, with no model request and no header', { options: { lean: false } }, async ($, on) => {
  const w = world(on)
  const { chunks, result } = await step($, 'agent-codex')
  expect(w.modelCalls).toEqual([])
  expect(w.spawned.length).toBe(1)
  const run = w.spawned[0]!
  expect(run.argv.slice(1)).toEqual([
    'exec', '--json', '--skip-git-repo-check', '--sandbox', 'workspace-write', '-C', '/tmp/project',
    '-m', 'gpt-6.1-sol', '-c', 'model_reasoning_effort="medium"', '-',
  ])
  // no session start ran: `codex` from PATH
  expect(run.argv[0]).toBe('codex')
  expect(run.input).toBe('Reply with the single word PONG')
  const message = 'PONG\n\ncodex · gpt-6.1-sol · medium · workspace-write · 0 actions · 1 new tokens (0 cached, 1 out) · thread t-1'
  expect(result.toolUses).toEqual([{ name: 'SubagentHandback', input: { message } }])
  // the answer is handed back once: no text block beside the handback call
  expect(result.answer).toBe('')
  expect(chunks.some(c => c.kind === 'text')).toBe(false)
  // Codex tokens are not reported as the step's (Anthropic) usage
  expect(result.usage).toBe(null)
  expect(result.stopReason).toBe('tool_use')
  expect(chunks.at(-1)).toEqual({ kind: 'stop', stopReason: 'tool_use', usage: null })
  expect(chunks.at(-3)).toMatchObject({ kind: 'tool', index: 0, name: 'SubagentHandback' })
  expect(chunks.at(-3).id.startsWith('toolu_codexmod_')).toBe(true)
  expect(chunks.at(-2)).toEqual({ kind: 'input', index: 0, json: JSON.stringify({ message }) })
})

test('a failed codex run still answers without the model: "codex failed:" first, footer last', async ($, on) => {
  const w = world(on, { stdout: '{"type":"thread.started","thread_id":"t-1"}\n{"type":"turn.failed","error":{"message":"not logged in"}}\n', code: 1, stderr: 'stderr tail line' })
  const { result } = await step($, 'agent-codex')
  expect(w.modelCalls).toEqual([])
  const m = handback(result)
  expect(firstLine(m)).toBe('codex failed: exit 1: not logged in')
  expect(m).toContain('stderr tail line')
  expect(lastLine(m)).toBe('codex · gpt-6.1-sol · medium · workspace-write · 0 actions · thread t-1')
  expect(result.stopReason).toBe('tool_use')
})

test('userConfig defaultModel is used', { options: { defaultModel: 'gpt-x-test' } }, async ($, on) => {
  const w = world(on)
  await step($, 'agent-codex')
  expect(w.spawned[0]!.argv).toContain('gpt-x-test')
})

test('a leading codex-model line picks the model and is stripped', async ($, on) => {
  const w = world(on, { task: 'codex-model: gpt-mini-test\nSay hi' })
  await step($, 'agent-codex')
  expect(w.spawned[0]!.argv).toContain('gpt-mini-test')
  expect(w.spawned[0]!.input).toBe('Say hi')
})

test('each agent type maps to its model, effort and sandbox', async ($, on) => {
  const w = world(on)
  for (const [id, name, model, effort, sandbox] of [
    ['agent-sol', 'sol', 'gpt-6.1-sol', 'medium', 'workspace-write'],
    ['agent-solh', 'sol-high', 'gpt-6.1-sol', 'xhigh', 'workspace-write'],
    ['agent-astra', 'astra-audit', 'gpt-6-astra', 'xhigh', 'read-only'],
  ] as const) {
    const { result } = await step($, id)
    const argv = w.spawned.at(-1)!.argv
    expect(argOf(argv, '--sandbox')).toBe(sandbox)
    expect(argOf(argv, '-m')).toBe(model)
    expect(argv).toContain(`model_reasoning_effort="${effort}"`)
    expect(lastLine(handback(result)).startsWith(`${name} · ${model} · ${effort} · ${sandbox} · 0 actions`)).toBe(true)
  }
})

test('codex-effort and codex-model lines override the table', async ($, on) => {
  const w = world(on, { task: 'codex-effort: low\ncodex-model: gpt-mini-test\nHi' })
  const { result } = await step($, 'agent-sol')
  expect(w.spawned[0]!.argv).toContain('model_reasoning_effort="low"')
  expect(w.spawned[0]!.argv).toContain('gpt-mini-test')
  expect(w.spawned[0]!.input).toBe('Hi')
  expect(lastLine(handback(result))).toContain('sol · gpt-mini-test · low')
})

test('failure: spawn rejected', async ($, on) => {
  world(on, { reject: true })
  const { result } = await step($, 'agent-codex')
  expect(firstLine(handback(result))).toContain('codex failed: could not start Codex')
  expect(result.toolUses[0]!.name).toBe('SubagentHandback')
})

test('failure: non-zero exit with stderr tail', async ($, on) => {
  world(on, { stdout: '', stderr: 'boom line', code: 3 })
  const { result } = await step($, 'agent-codex')
  expect(firstLine(handback(result))).toBe('codex failed: exit 3')
  expect(handback(result)).toContain('boom line')
})

test('failure: exit 0 but no agent message', async ($, on) => {
  world(on, { stdout: '{"type":"turn.completed","usage":{"input_tokens":1,"output_tokens":0}}\n' })
  const { result } = await step($, 'agent-codex')
  expect(firstLine(handback(result))).toBe('codex failed: no agent message')
})

test('failure: turn.failed with exit 0', async ($, on) => {
  world(on, { stdout: '{"type":"turn.failed","error":{"message":"quota"}}\n' })
  const { result } = await step($, 'agent-codex')
  expect(firstLine(handback(result))).toBe('codex failed: quota')
})

test('failure: denied session read (auto: SubagentHandback by default)', async ($, on) => {
  const w = world(on, { messages: () => ({ deny: 'no access' }) })
  const { result } = await step($, 'agent-deny')
  expect(w.spawned.length).toBe(0)
  expect(result.stopReason).toBe('tool_use')
  expect(firstLine(handback(result))).toBe('codex failed: session read denied: no access')
  expect(lastLine(handback(result))).toBe('sol · gpt-6.1-sol · medium · workspace-write · 0 actions')
})

test('follow-up message resumes the thread; the tool-result step ends the turn', async ($, on) => {
  let conv: any[] = [user('first task')]
  const w = world(on, { messages: () => conv })
  await step($, 'agent-resume')
  expect(w.spawned[0]!.argv).not.toContain('resume')
  conv = [...conv, ...toolResult('SubagentHandback')]
  const ended = await step($, 'agent-resume', 1)
  expect(w.spawned.length).toBe(1)
  expect(ended.result.stopReason).toBe('end_turn')
  conv = [...conv, user('second task')]
  const { result } = await step($, 'agent-resume', 0, 'turn-2')
  expect(w.spawned.length).toBe(2)
  const argv = w.spawned[1]!.argv
  expect(argv.slice(1, 3)).toEqual(['exec', 'resume'])
  expect(argv).toContain('t-1')
  expect(argv).toContain('sandbox_mode="workspace-write"')
  expect(argv.at(-1)).toBe('-')
  expect(argv.at(-2)).toBe('t-1')
  expect(w.spawned[1]!.input).toBe('second task')
  expect(lastLine(handback(result))).toContain('thread t-1')
})

// ---- overrides survive follow-ups, restarts and compaction ----------------

test('(a) a follow-up without override lines resumes with the first run\'s model and effort', async ($, on) => {
  let conv: any[] = [user('codex-effort: high\ncodex-model: gpt-pinned\nfirst')]
  const w = world(on, { messages: () => conv })
  await step($, 'agent-keep')
  conv = [...conv, ...toolResult('SubagentHandback')]
  await step($, 'agent-keep', 1)
  conv = [...conv, user('second, no override lines')]
  const { result } = await step($, 'agent-keep', 0, 'turn-2')
  const argv = w.spawned[1]!.argv
  expect(argv.slice(1, 3)).toEqual(['exec', 'resume'])
  expect(argOf(argv, '-m')).toBe('gpt-pinned')
  expect(argv).toContain('model_reasoning_effort="high"')
  expect(lastLine(handback(result))).toContain('sol · gpt-pinned · high · workspace-write')
})

test('(b) a follow-up with a new codex-effort line uses it and persists it', async ($, on) => {
  let conv: any[] = [user('codex-model: gpt-pinned\nfirst')]
  const w = world(on, { messages: () => conv })
  await step($, 'agent-new-effort')
  conv = [...conv, ...toolResult('SubagentHandback'), user('codex-effort: low\nsecond')]
  const second = await step($, 'agent-new-effort', 0, 'turn-2')
  expect(w.spawned[1]!.argv).toContain('model_reasoning_effort="low"')
  expect(argOf(w.spawned[1]!.argv, '-m')).toBe('gpt-pinned')
  expect(w.spawned[1]!.input).toBe('second')
  expect(lastLine(handback(second.result))).toContain('gpt-pinned · low')
  expect(w.store.get('agent:sess-1:agent-new-effort')).toMatchObject({ model: 'gpt-pinned', effort: 'low', thread: 't-1' })
  conv = [...conv, ...toolResult('SubagentHandback'), user('third')]
  await step($, 'agent-new-effort', 0, 'turn-3')
  expect(w.spawned[2]!.argv).toContain('model_reasoning_effort="low"')
  expect(argOf(w.spawned[2]!.argv, '-m')).toBe('gpt-pinned')
})

// What a first run of agent-persist writes; the restart test below starts from it.
const PERSISTED = {
  agentName: 'sol',
  model: 'gpt-pinned',
  effort: 'xhigh',
  sandbox: 'workspace-write',
  thread: 't-1',
  lastTask: 'codex-model: gpt-pinned\ncodex-effort: xhigh\nfirst',
  handedBack: true,
}

test('(c1) the first run persists the agent record under agent:<session>:<agent>', async ($, on) => {
  const conv: any[] = [user('codex-model: gpt-pinned\ncodex-effort: xhigh\nfirst')]
  const w = world(on, { messages: () => conv })
  await step($, 'agent-persist')
  expect([...w.store.keys()]).toEqual(['agent:sess-1:agent-persist'])
  expect(w.store.get('agent:sess-1:agent-persist')).toMatchObject(PERSISTED)
})

test('(c2) after a worker restart (empty memory) a follow-up resumes from the stored record', async ($, on) => {
  const store = new Map<string, unknown>([['agent:sess-1:agent-restarted', { ...PERSISTED, agentName: 'sol-high', updatedAt: 1_000_000 }]])
  const conv: any[] = [user(PERSISTED.lastTask), ...toolResult('SubagentHandback')]
  const w = world(on, { messages: () => conv, store })
  const ended = await step($, 'agent-restarted', 1)
  expect(ended.result.stopReason).toBe('end_turn')
  expect(w.spawned.length).toBe(0)
  conv.push(user('follow-up after restart'))
  const { result } = await step($, 'agent-restarted', 0, 'turn-2')
  const argv = w.spawned[0]!.argv
  expect(argv.slice(1, 3)).toEqual(['exec', 'resume'])
  expect(argv).toContain('t-1')
  expect(argOf(argv, '-m')).toBe('gpt-pinned')
  expect(argv).toContain('model_reasoning_effort="xhigh"')
  expect(lastLine(handback(result))).toContain('sol-high · gpt-pinned · xhigh')
  expect(w.logs.some(l => l.includes('record reloaded from the store'))).toBe(true)
})

test('(c3) a record stored under another session id (resume) is found by agent id and moved', async ($, on) => {
  const store = new Map<string, unknown>([['agent:old-session:agent-moved', { ...PERSISTED, updatedAt: 1_000_000 }]])
  const conv: any[] = [user(PERSISTED.lastTask), ...toolResult('SubagentHandback'), user('next')]
  const w = world(on, { messages: () => conv, store })
  await step($, 'agent-moved', 0, 'turn-2')
  expect(argOf(w.spawned[0]!.argv, '-m')).toBe('gpt-pinned')
  expect(w.spawned[0]!.argv).toContain('t-1')
  expect(w.store.has('agent:old-session:agent-moved')).toBe(false)
  expect(w.store.has('agent:sess-1:agent-moved')).toBe(true)
})

test('(d) a compaction summary as newest user row triggers no Codex run', async ($, on) => {
  let conv: any[] = [user('codex-effort: high\nfirst')]
  const w = world(on, { messages: () => conv })
  await step($, 'agent-compact')
  conv = [
    user('This session is being continued from a previous conversation that ran out of context. The conversation is summarized below:\n...'),
  ]
  const { chunks, result } = await step($, 'agent-compact', 0, 'turn-2')
  expect(w.spawned.length).toBe(1)
  expect(w.modelCalls).toEqual([])
  expect(result.stopReason).toBe('end_turn')
  expect(result.toolUses).toEqual([])
  expect(chunks).toEqual([{ kind: 'stop', stopReason: 'end_turn', usage: null }])
  expect(w.logs.some(l => l.includes('compaction summary'))).toBe(true)
})

test('session.start prunes records older than two days', async ($, on) => {
  const store = new Map<string, unknown>([
    ['agent:s:old', { ...PERSISTED, updatedAt: 1_000_000 - 3 * 86_400_000 }],
    ['agent:s:new', { ...PERSISTED, updatedAt: 1_000_000 - 3_600_000 }],
    ['agent:s:junk', 'x'],
    ['other', 1],
  ])
  const w = world(on, { store })
  on('process.run', () => ({ value: { exitCode: 0, stdout: 'ok', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('agent.register', (_$, e: any) => ({ value: { agent: `codex-mod:${e.name}` } }))
  await $.session.start?.({ cwd: '/tmp/project', surface: null, isInteractive: false })
  expect([...w.store.keys()].sort()).toEqual(['agent:s:new', 'other'])
})

// ---- Codex's actions as native tool calls ---------------------------------

test('a command is a Bash call, interim message as text before it, answered with Codex\'s output; the engine never runs it', async ($, on) => {
  const w = world(on, {
    pieces: [THREAD('01a14f50-c51c-7370'), MESSAGE('I will list the files.'), cmdStart("/bin/zsh -lc 'ls -la'"), cmdDone("/bin/zsh -lc 'ls -la'", 'a.txt\nb.txt\n', 0), MESSAGE('Two files.'), USAGE],
  })
  const s1 = await step($, 'agent-progress', 0)
  expect(s1.result.stopReason).toBe('tool_use')
  expect(s1.chunks[0]).toEqual({ kind: 'text', index: 0, text: 'I will list the files.' })
  const calls = callsOf(s1.chunks)
  expect(calls.map(c => [c.name, c.input])).toEqual([['Bash', { command: 'ls -la', description: 'List files' }]])
  expect(calls[0]!.id.startsWith('toolu_codexmod_')).toBe(true)
  expect(s1.result.toolUses).toEqual([{ name: 'Bash', input: { command: 'ls -la', description: 'List files' } }])
  expect(s1.chunks.at(-1)).toEqual({ kind: 'stop', stopReason: 'tool_use', usage: null })
  // the engine raises tool.call for it: the guard answers, core never sees it
  const [r] = await runCalls($, s1.chunks, 'agent-progress')
  expect(r.result).toEqual({ stdout: 'a.txt\nb.txt', stderr: '', interrupted: false })
  expect(w.core).toEqual([])
  expect(w.checks).toEqual([])
  const s2 = await step($, 'agent-progress', 1)
  expect(handback(s2.result)).toBe('Two files.\n\ncodex · gpt-6.1-sol · medium · workspace-write · 1 action · 277 new tokens (21K cached, 46 out) · thread 01a14f50')
  expect(s2.result.usage).toBe(null)
  expect(w.spawned.length).toBe(1)
  expect(w.modelCalls).toEqual([])
  const s3 = await step($, 'agent-progress', 2)
  expect(s3.result.stopReason).toBe('end_turn')
})

test('a failed command keeps its output and says its exit code', async ($, on) => {
  world(on, { pieces: [THREAD('t-2'), cmdDone("/bin/zsh -lc 'ls nope'", 'ls: nope: No such file or directory\n', 1), MESSAGE('done')] })
  const s1 = await step($, 'agent-progress', 0)
  expect(callsOf(s1.chunks)[0]!.input).toEqual({ command: 'ls nope', description: 'List files' })
  const [r] = await runCalls($, s1.chunks, 'agent-progress')
  expect(r.result).toEqual({ stdout: 'ls: nope: No such file or directory', stderr: 'Exit code 1', interrupted: false })
})

test('file changes: add is Write (content from disk), update is Edit (old/new), delete is a comment-only Bash row', async ($, on) => {
  const P = '/tmp/project/notes.txt'
  const files = new Map<string, string>()
  const w = world(on, {
    files,
    pieces: [
      THREAD('t-3'),
      fileEv('item.started', P, 'add'),
      fileEv('item.completed', P, 'add'),
      fileEv('item.started', P, 'update'),
      fileEv('item.completed', P, 'update'),
      fileEv('item.completed', P, 'delete'),
      MESSAGE('edited'),
    ],
  })
  files.set(P, 'alpha\nbeta\n')
  // the add is read at once; the update and the delete come in the next steps
  const s1 = await step($, 'agent-files', 0)
  expect(callsOf(s1.chunks).map(c => [c.name, c.input])).toEqual([['Write', { file_path: P, content: 'alpha\nbeta\n' }]])
  const [w1] = await runCalls($, s1.chunks, 'agent-files')
  expect(w1.result).toEqual({ type: 'create', filePath: P, content: 'alpha\nbeta\n', structuredPatch: [], originalFile: null })
  files.set(P, 'alpha\ngamma\n')
  const s2 = await step($, 'agent-files', 1)
  expect(callsOf(s2.chunks).map(c => [c.name, c.input])).toEqual([['Edit', { file_path: P, old_string: 'beta', new_string: 'gamma' }]])
  const [e2] = await runCalls($, s2.chunks, 'agent-files')
  expect(e2.result).toEqual({
    filePath: P, oldString: 'beta', newString: 'gamma', originalFile: 'alpha\nbeta\n', userModified: false, replaceAll: false,
    structuredPatch: [{ oldStart: 1, oldLines: 3, newStart: 1, newLines: 3, lines: [' alpha', '-beta', '+gamma', ' '] }],
  })
  files.delete(P)
  w.clock.now += 5000
  const s3 = await step($, 'agent-files', 2)
  expect(callsOf(s3.chunks).map(c => [c.name, c.input])).toEqual([['Bash', { command: '# codex apply_patch: delete notes.txt', description: 'Delete file' }]])
  await runCalls($, s3.chunks, 'agent-files')
  expect(w.core).toEqual([])
  const s4 = await step($, 'agent-files', 3)
  expect(lastLine(handback(s4.result))).toContain(' · 3 actions · thread t-3')
})

test('throttling: actions done within a second go out in one step, one call each; at most 10 per step', async ($, on) => {
  const burst = (from: number, to: number) => ({ stream: 'stdout' as const, text: Array.from({ length: to - from + 1 }, (_, i) => cmdDone(`/bin/zsh -lc 'echo ${from + i}'`, `${from + i}\n`).text).join('') })
  const w = world(on, { pieces: [THREAD('t-8'), burst(1, 12), cmdDone('/bin/zsh -lc pwd', '/tmp/project\n'), MESSAGE('ok')] })
  const s1 = await step($, 'agent-throttle', 0)
  expect(callsOf(s1.chunks).map(c => c.input.command)).toEqual(Array.from({ length: 10 }, (_, i) => `echo ${i + 1}`))
  expect(new Set(callsOf(s1.chunks).map(c => c.id)).size).toBe(10)
  expect(w.sleeps).toEqual([])
  await runCalls($, s1.chunks, 'agent-throttle')
  // the two left over go 1 s after the first step
  const s2 = await step($, 'agent-throttle', 1)
  expect(callsOf(s2.chunks).map(c => c.input.command)).toEqual(['echo 11', 'echo 12'])
  expect(w.sleeps).toEqual([1000])
  await runCalls($, s2.chunks, 'agent-throttle')
  // an action 3 s later goes out at once
  w.clock.now += 3000
  const s3 = await step($, 'agent-throttle', 2)
  expect(callsOf(s3.chunks).map(c => c.input)).toEqual([{ command: 'pwd', description: 'Show current directory' }])
  expect(w.sleeps).toEqual([1000])
  await runCalls($, s3.chunks, 'agent-throttle')
  const s4 = await step($, 'agent-throttle', 3)
  expect(lastLine(handback(s4.result))).toContain(' · 13 actions · thread t-8')
  expect(w.core).toEqual([])
})

test('a follow-up folded into the turn mid-run runs (resumed) after the handback', async ($, on) => {
  let conv: any[] = [user('first')]
  const w = world(on, { messages: () => conv, pieces: [THREAD('t-12'), cmdDone('/bin/zsh -lc make'), MESSAGE('built')] })
  await step($, 'agent-folded', 0)
  conv = [...conv, ...toolResult('Bash', 'toolu_codexmod_a'), user('also run the linter')]
  const s2 = await step($, 'agent-folded', 1)
  expect(s2.result.toolUses[0]!.name).toBe('SubagentHandback')
  expect(w.logs.some(l => l.includes('follow-up received mid-run'))).toBe(true)
  conv = [...conv, ...toolResult('SubagentHandback')]
  const s3 = await step($, 'agent-folded', 2)
  expect(w.spawned.length).toBe(2)
  expect(w.spawned[1]!.argv.slice(1, 3)).toEqual(['exec', 'resume'])
  expect(w.spawned[1]!.argv).toContain('t-12')
  expect(w.spawned[1]!.input).toBe('also run the linter')
  expect(s3.result.toolUses[0]!.name).toBe('Bash')
})

test('exec: a message queued mid-run is announced once, as text before the next step\'s calls, never as the answer', async ($, on) => {
  let conv: any[] = [user('first')]
  const w = world(on, { messages: () => conv, pieces: [THREAD('t-13'), cmdDone('/bin/zsh -lc make'), cmdDone('/bin/zsh -lc lint'), MESSAGE('built')] })
  await step($, 'agent-exec-note', 0)
  conv = [...conv, ...toolResult('Bash', 'toolu_codexmod_n1'), user('also run the linter')]
  const s2 = await step($, 'agent-exec-note', 1)
  // the note is this step's text block, before its Bash call
  expect(s2.chunks.filter(c => c.kind === 'text').map(c => c.text)).toEqual([steerNote('queued')])
  expect(s2.result.toolUses.map((u: any) => u.name)).toEqual(['Bash'])
  conv = [...conv, ...toolResult('Bash', 'toolu_codexmod_n2'), user('and the docs')]
  const s3 = await step($, 'agent-exec-note', 2)
  // a second queued message gets no second note; the answer is Codex's own
  expect(handback(s3.result).startsWith('built\n\n')).toBe(true)
  expect(handback(s3.result)).not.toContain('↪')
  expect(w.store.get('agent:sess-1:agent-exec-note')).toMatchObject({ followUps: [{ text: 'also run the linter', count: 2 }, { text: 'and the docs', count: 3 }] })
  expect(w.spawned.length).toBe(1)
})

// ---- safety: the engine never executes a Codex agent's Bash/Edit/Write ----

test('safety: an action answer is used once; a replay of the same id is refused, never run', async ($, on) => {
  const w = world(on, { pieces: [THREAD('t-20'), cmdDone("/bin/zsh -lc 'rm -rf build'", ''), MESSAGE('ok')] })
  const s1 = await step($, 'agent-progress', 0)
  const [call] = callsOf(s1.chunks)
  const first: any = await $.tool.call({ tool: 'Bash', ...call!.input, tool_use_id: call!.id, agentId: 'agent-progress' } as any)
  expect(first.result.stdout).toBe('')
  const again: any = await $.tool.call({ tool: 'Bash', ...call!.input, tool_use_id: call!.id, agentId: 'agent-progress' } as any)
  expect(again.deny).toContain('codex-mod: not executed')
  expect(w.core).toEqual([])
})

test('safety: Bash/Edit/Write of a Codex agent without our id prefix is refused, never run', async ($, on) => {
  const w = world(on)
  await step($, 'agent-codex')
  for (const call of [
    { tool: 'Bash', command: 'touch /tmp/x' },
    { tool: 'Edit', file_path: '/tmp/x', old_string: 'a', new_string: 'b' },
    { tool: 'Write', file_path: '/tmp/x', content: 'pwned' },
  ]) {
    const r: any = await $.tool.call({ ...call, tool_use_id: 'toolu_01realmodelid', agentId: 'agent-codex' } as any)
    expect(r.deny).toContain('codex-mod: not executed')
  }
  expect(w.core).toEqual([])
})

test('safety: an id with our prefix is refused when its answer is unknown, from another agent, or claimed for another tool', async ($, on) => {
  const w = world(on, { pieces: [THREAD('t-21'), cmdDone('/bin/zsh -lc ls', 'x\n'), MESSAGE('ok')] })
  const s1 = await step($, 'agent-progress', 0)
  const [call] = callsOf(s1.chunks)
  // after a worker restart nothing is stored: refused
  const unknown: any = await $.tool.call({ tool: 'Bash', command: 'ls', tool_use_id: 'toolu_codexmod_forged_1', agentId: 'agent-never-stepped' } as any)
  expect(unknown.deny).toContain('not executed')
  // the right id from another loop (main, a Claude agent): refused
  const main: any = await $.tool.call({ tool: 'Bash', command: 'ls', tool_use_id: call!.id } as any)
  expect(main.deny).toContain('not executed')
  const gp: any = await $.tool.call({ tool: 'Bash', command: 'ls', tool_use_id: call!.id, agentId: 'agent-gp' } as any)
  expect(gp.deny).toContain('not executed')
  // the right id and agent, another tool: refused
  const write: any = await $.tool.call({ tool: 'Write', file_path: '/tmp/x', content: 'y', tool_use_id: call!.id, agentId: 'agent-progress' } as any)
  expect(write.deny).toContain('not executed')
  expect(w.core).toEqual([])
})

test('safety: other loops\' Bash calls are untouched (reach the engine as usual)', async ($, on) => {
  const w = world(on)
  await step($, 'agent-codex')
  const main: any = await $.tool.call({ tool: 'Bash', command: 'ls', tool_use_id: 'toolu_01a' } as any)
  const gp: any = await $.tool.call({ tool: 'Bash', command: 'ls', tool_use_id: 'toolu_01b', agentId: 'agent-gp' } as any)
  const read: any = await $.tool.call({ tool: 'Read', file_path: '/tmp/x', tool_use_id: 'toolu_01c', agentId: 'agent-codex' } as any)
  expect([main.result.stdout, gp.result.stdout]).toEqual(['REALLY RAN', 'REALLY RAN'])
  expect(read.result).toBeDefined()
  expect(w.core.map(c => c.id)).toEqual(['toolu_01a', 'toolu_01b', 'toolu_01c'])
})

test('safety: tool.check denies a Codex agent\'s Bash/Edit/Write (with or without the prefix), passes others', async ($, on) => {
  const w = world(on)
  await step($, 'agent-codex')
  const a: any = await $.tool.check({ tool: 'Bash', input: { command: 'ls' }, agentId: 'agent-codex', tool_use_id: 'toolu_codexmod_x_1' } as any)
  const b: any = await $.tool.check({ tool: 'Write', input: { file_path: '/x', content: '' }, agentId: 'agent-codex', tool_use_id: 'toolu_01z' } as any)
  const c: any = await $.tool.check({ tool: 'Bash', input: { command: 'ls' }, agentId: 'agent-gp', tool_use_id: 'toolu_01y' } as any)
  expect([a.decision, b.decision, c.decision]).toEqual(['deny', 'deny', 'allow'])
  expect(w.checks).toEqual([{ tool: 'Bash', agentId: 'agent-gp' }])
})

// ---- kill ------------------------------------------------------------------

// A plugin above codex-mod that abandons the second step of agent-abort after
// 300 ms, as an interrupt does: the dispatch beneath is abandoned and its
// `next.signal` aborts.
const interrupter = {
  name: 'interrupter',
  tier: 'prepend' as const,
  register: ((on: On) => {
    on('turn.step', async function* (_$, e, next) {
      if (e.agentId !== 'agent-abort' || e.index !== 1) return yield* next(e)
      const beneath = next(e)
      void beneath.next().catch(() => undefined)
      await new Promise<void>(r => setTimeout(() => r(), 300))
      yield { kind: 'stop' as const, stopReason: 'end_turn' as const, usage: null }
      return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn' as const, usage: null }
    })
  }) as any,
}

test('kill: an aborted step kills Codex', { timeoutMs: 15000, plugins: [interrupter] }, async ($, on) => {
  const w = world(on, { pieces: [THREAD('t-9'), cmdDone('/bin/zsh -lc date', 'today\n'), 'block', MESSAGE('never')] })
  const s1 = await step($, 'agent-abort', 0)
  expect(s1.result.toolUses[0]!.name).toBe('Bash')
  const s2 = await step($, 'agent-abort', 1)
  expect(s2.result.stopReason).toBe('end_turn')
  await new Promise<void>(r => setTimeout(() => r(), 300))
  expect(w.kills.count).toBe(1)
  expect(w.kills.bySignal).toBe(1)
  expect(w.modelCalls).toEqual([])
})

test('kill: a step that finds the agent stopped kills Codex and ends the turn', { timeoutMs: 15000 }, async ($, on) => {
  const w = world(on, { pieces: [THREAD('t-10'), cmdDone('/bin/zsh -lc date'), 'block', MESSAGE('never')] })
  await step($, 'agent-stopped', 0)
  w.status.set('agent-stopped', 'killed')
  const s2 = await step($, 'agent-stopped', 1)
  expect(s2.result.stopReason).toBe('end_turn')
  await new Promise<void>(r => setTimeout(() => r(), 300))
  expect(w.kills.count).toBe(1)
})

test('kill: the agent\'s turn ending mid-run kills Codex', { timeoutMs: 15000 }, async ($, on) => {
  const w = world(on, { pieces: [THREAD('t-11'), cmdDone('/bin/zsh -lc date'), 'block', MESSAGE('never')] })
  on('turn.complete', () => ({ text: '' }))
  await step($, 'agent-turnend', 0)
  await $.turn.complete({ answer: '', durationMs: 1, isAborted: true, turnId: 'turn-1', agentId: 'agent-turnend', reason: 'aborted' } as any)
  await new Promise<void>(r => setTimeout(() => r(), 300))
  expect(w.kills.count).toBe(1)
})

test('an action result with no live run (worker restarted mid-run) hands back "codex failed: run lost"', async ($, on) => {
  const store = new Map<string, unknown>([['agent:sess-1:agent-lost', { ...PERSISTED, agentName: 'codex', handedBack: false, updatedAt: 1_000_000 }]])
  const conv: any[] = [user('task'), ...toolResult('Bash', 'toolu_codexmod_turn1_3_9')]
  const w = world(on, { messages: () => conv, store })
  const { result } = await step($, 'agent-lost', 4)
  expect(w.spawned.length).toBe(0)
  expect(firstLine(handback(result))).toContain('codex failed: run lost')
  expect(lastLine(handback(result))).toContain('thread t-1')
})

// ---- lean launches ---------------------------------------------------------

const CONFIG_TOML = [
  'model = "gpt-6.1-sol"',
  '[plugins."vercel@openai-curated"]',
  'enabled = true',
  '[mcp_servers.node_repl]',
  'command = "x"',
  '[mcp_servers.node_repl.env]',
  'A = "1"',
  '[mcp_servers.computer-use]',
  'enabled = false',
  '[mcp_servers."has.dot"]',
  'command = "y"',
  '[mcp_servers."quoted_ok"]',
  'command = "z"',
].join('\n')

test('lean (default): -c overrides for features, web search, skills and each MCP server of config.toml', async ($, on) => {
  const w = world(on, { files: new Map([['/home/t/.codex/config.toml', CONFIG_TOML]]) })
  await step($, 'agent-codex')
  const argv = w.spawned[0]!.argv
  const overrides = argv.filter((_, i) => argv[i - 1] === '-c')
  for (const f of ['plugins', 'remote_plugin', 'apps', 'multi_agent', 'image_generation', 'computer_use', 'browser_use', 'goals', 'tool_suggest']) {
    expect(overrides).toContain(`features.${f}=false`)
  }
  expect(overrides).toContain('web_search="disabled"')
  expect(overrides).toContain('skills.include_instructions=false')
  expect(overrides.filter(o => o.startsWith('mcp_servers.'))).toEqual([
    'mcp_servers.node_repl.enabled=false', 'mcp_servers.computer-use.enabled=false', 'mcp_servers.quoted_ok.enabled=false',
  ])
  expect(argv.at(-1)).toBe('-')
})

test('lean: no config.toml still launches, with the feature overrides only', async ($, on) => {
  const w = world(on)
  const { result } = await step($, 'agent-codex')
  expect(w.spawned[0]!.argv).toContain('features.plugins=false')
  expect(w.spawned[0]!.argv.some(a => a.startsWith('mcp_servers.'))).toBe(false)
  expect(handback(result).startsWith('PONG')).toBe(true)
})

test('lean off: no overrides', { options: { lean: false } }, async ($, on) => {
  const w = world(on, { files: new Map([['/home/t/.codex/config.toml', CONFIG_TOML]]) })
  await step($, 'agent-codex')
  expect(w.spawned[0]!.argv.some(a => a.startsWith('features.') || a.startsWith('mcp_servers.'))).toBe(false)
})

// ---- pure helpers ----------------------------------------------------------

test('helpers: shell unwrapping, descriptions, footer numbers, MCP names, diffs', async () => {
  expect(unwrapShell("/bin/zsh -lc 'mkdir luna-demo'")).toBe('mkdir luna-demo')
  expect(unwrapShell('/bin/zsh -lc pwd')).toBe('pwd')
  expect(unwrapShell(`/bin/bash -lc 'echo '"'"'hi'"'"''`)).toBe("echo 'hi'")
  expect(unwrapShell(`/bin/zsh -lc "echo \\"a\\""`)).toBe('echo "a"')
  expect(unwrapShell('/bin/zsh -lc ls extra')).toBe('/bin/zsh -lc ls extra')
  expect(unwrapShell('git status')).toBe('git status')
  expect(describeCommand('git status --short')).toBe('Run git status')
  expect(describeCommand('cd sub && npm test')).toBe('Run npm test')
  expect(describeCommand('sed -n 1,20p a.ts')).toBe('Read part of a file')
  expect(describeCommand('frobnicate')).toBe('Run frobnicate')
  expect([compact(950), compact(37412), compact(154000), compact(1250000), compact(2000)]).toEqual(['950', '37.4K', '154K', '1.3M', '2K'])
  expect(footer({ agent: 'codex', model: 'gpt-6-luna', effort: 'low', sandbox: 'workspace-write', actions: 3, usage: { input: 192000, cached: 154000, output: 631 }, thread: '01a14f50-c51c' }))
    .toBe('codex · gpt-6-luna · low · workspace-write · 3 actions · 38K new tokens (154K cached, 631 out) · thread 01a14f50')
  expect(mcpServerNames(CONFIG_TOML)).toEqual(['node_repl', 'computer-use', 'quoted_ok'])
  expect(diffEdit('a\nb\nc\n', 'a\nb\nX\nc\n')).toMatchObject({ oldString: 'b', newString: 'b\nX' })
  expect(diffEdit('same', 'same')).toBe(undefined)
})

// ---- session.start ---------------------------------------------------------

const runOk = (stdout = 'ok') => ({ value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })

test('session.start: finds codex on PATH, checks it, registers the agents with the models Codex lists', async ($, on) => {
  const w = world(on, { files: new Map([['/home/t/.codex/models_cache.json', MODELS_CACHE]]) })
  const runs: string[][] = []
  const registered: any[] = []
  on('agent.register', (_$, e: any) => {
    registered.push(e)
    return { value: { agent: `codex-mod:${e.name}` } }
  })
  on('process.run', (_$, e: any) => {
    runs.push([...e.argv])
    return runOk(e.argv[0] === 'which' ? '/usr/local/bin/codex\n' : 'ok')
  })
  on('ui.notify', () => ({ value: { isSent: true, channel: 'terminal_bell' as const } }))
  on('ui.toast', () => ({ value: undefined }))
  await $.session.start?.({ cwd: '/tmp/project', surface: null, isInteractive: false })
  expect(runs.map(r => r.join(' '))).toEqual(['which codex', '/usr/local/bin/codex --version', '/usr/local/bin/codex login status'])
  expect(registered.map(r => r.name)).toEqual(['codex', 'sol', 'sol-high'])
  expect(registered[1]).toMatchObject({ tools: ['Read', 'Bash', 'Edit', 'Write'], model: 'haiku', maxTurns: 400, background: true, omitClaudeMd: true })
  expect(registered[0].description).toContain('gpt-6.1-sol (low|medium|high|xhigh|max|ultra), gpt-6-luna (low|medium|high|xhigh|max)')
  expect(registered[0].description).not.toContain('gpt-hidden')
  // astra-audit's model is not listed: skipped, with a debug line
  expect(w.logs.some(l => l.includes('role astra-audit not registered: model gpt-6-astra not available'))).toBe(true)
  expect(w.logs.some(l => l.includes('Codex ready (/usr/local/bin/codex)'))).toBe(true)
  // the launch uses what was found
  await step($, 'agent-extra')
  expect(w.spawned[0]!.argv[0]).toBe('/usr/local/bin/codex')
})

test('session.start: without codex on PATH, the first common install location that exists is used', async ($, on) => {
  const w = world(on)
  on('agent.register', (_$, e: any) => ({ value: { agent: `codex-mod:${e.name}` } }))
  on('process.run', (_$, e: any) => (e.argv[0] === 'which' ? { value: { exitCode: 1, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } } : runOk()))
  on('fs.exists', (_$, e: any) => ({ value: e.path === '/home/t/.local/bin/codex' }))
  await $.session.start?.({ cwd: '/tmp/project', surface: null, isInteractive: false })
  expect(w.logs.some(l => l.includes('Codex ready (/home/t/.local/bin/codex)'))).toBe(true)
})

test('session.start: the codexPath option wins and roles can be turned off', { options: { codexPath: '/opt/codex', roles: ['sol'] } }, async ($, on) => {
  world(on)
  const runs: string[][] = []
  const registered: string[] = []
  on('agent.register', (_$, e: any) => {
    registered.push(e.name)
    return { value: { agent: `codex-mod:${e.name}` } }
  })
  on('process.run', (_$, e: any) => {
    runs.push([...e.argv])
    return runOk()
  })
  await $.session.start?.({ cwd: '/tmp/project', surface: null, isInteractive: false })
  expect(runs.map(r => r[0])).toEqual(['/opt/codex', '/opt/codex'])
  expect(registered).toEqual(['codex', 'sol'])
})

test('session.start: warns when logged out; first use carries the launch check', async ($, on) => {
  const notified: string[] = []
  const w = world(on, { stdout: '', code: 1, stderr: 'x' })
  on('agent.register', (_$, e: any) => ({ value: { agent: `codex-mod:${e.name}` } }))
  on('process.run', (_$, e: any) => ({ value: e.argv.includes('login') ? { exitCode: 1, stdout: '', stderr: 'Not logged in', isStdoutTruncated: false, isStderrTruncated: false } : { exitCode: 0, stdout: e.argv[0] === 'which' ? '/bin/codex' : 'v', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('ui.notify', (_$, e: any) => {
    notified.push(e.text)
    return { value: { isSent: false, reason: 'no-surface' } }
  })
  const toasts: string[] = []
  on('ui.toast', (_$, e: any) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  await $.session.start?.({ cwd: '/tmp/project', surface: null, isInteractive: false })
  expect(notified[0]).toContain('not logged in')
  expect(toasts[0]).toContain('not logged in')
  const { result } = await step($, 'agent-codex')
  expect(w.spawned.length).toBe(1)
  expect(handback(result)).toContain('launch check: Codex is not logged in')
})

test('session.start: warns when codex is missing', async ($, on) => {
  const toasts: string[] = []
  world(on)
  on('agent.register', (_$, e: any) => ({ value: { agent: `codex-mod:${e.name}` } }))
  on('process.run', () => {
    throw new Error('ENOENT')
  })
  on('ui.notify', () => ({ value: { isSent: false, reason: 'disabled' } }))
  on('ui.toast', (_$, e: any) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  await $.session.start?.({ cwd: '/tmp/project', surface: null, isInteractive: false })
  expect(toasts[0]).toContain('not found or not runnable')
})

// ---- one handback: SubagentHandback or final text ---------------------------

test('auto without the reminder still hands back through SubagentHandback', async ($, on) => {
  world(on, { handback: false })
  const { result } = await step($, 'agent-text')
  expect(result.toolUses.map((u: any) => u.name)).toEqual(['SubagentHandback'])
  expect(handback(result).startsWith('PONG')).toBe(true)
})

test('handbackMode text: the answer is the final text alone (end_turn, no handback call)', { options: { handbackMode: 'text' } }, async ($, on) => {
  const w = world(on, { handback: false })
  const { chunks, result } = await step($, 'agent-text')
  expect(w.modelCalls).toEqual([])
  expect(result.toolUses).toEqual([])
  expect(result.stopReason).toBe('end_turn')
  expect(result.usage).toBe(null)
  expect(result.answer).toBe('PONG\n\ncodex · gpt-6.1-sol · medium · workspace-write · 0 actions · 1 new tokens (0 cached, 1 out) · thread t-1')
  expect(chunks.filter(c => c.kind === 'text').length).toBe(1)
  expect(chunks.at(-1)).toEqual({ kind: 'stop', stopReason: 'end_turn', usage: null })
})

test('text route: interim remarks stay text before the action calls; the final answer is one text block', { options: { handbackMode: 'text' } }, async ($, on) => {
  const w = world(on, { handback: false, pieces: [THREAD('t-30'), MESSAGE('Looking.'), cmdDone('/bin/zsh -lc ls', 'a\n'), MESSAGE('Done: one file.')] })
  const s1 = await step($, 'agent-text-actions', 0)
  expect(s1.chunks[0]).toEqual({ kind: 'text', index: 0, text: 'Looking.' })
  expect(s1.result.stopReason).toBe('tool_use')
  await runCalls($, s1.chunks, 'agent-text-actions')
  const s2 = await step($, 'agent-text-actions', 1)
  expect(s2.result.toolUses).toEqual([])
  expect(s2.result.stopReason).toBe('end_turn')
  expect(firstLine(s2.result.answer)).toBe('Done: one file.')
  expect(lastLine(s2.result.answer)).toContain(' · 1 action · thread t-30')
  expect(w.core).toEqual([])
})

test('handbackMode text forces the final text even when the host asks for SubagentHandback', { options: { handbackMode: 'text' } }, async ($, on) => {
  world(on)
  const { result } = await step($, 'agent-force-text')
  expect(result.toolUses).toEqual([])
  expect(result.answer.startsWith('PONG')).toBe(true)
})

test('handbackMode tool forces the SubagentHandback call', { options: { handbackMode: 'tool' } }, async ($, on) => {
  world(on, { handback: false })
  const { result } = await step($, 'agent-force-tool')
  expect(result.toolUses.map((u: any) => u.name)).toEqual(['SubagentHandback'])
  expect(result.answer).toBe('')
})

test('text route: a follow-up folded in mid-run runs in the same step after the first answer', { options: { handbackMode: 'text' } }, async ($, on) => {
  let conv: any[] = [user('first')]
  const w = world(on, { handback: false, messages: () => conv, pieces: [THREAD('t-31'), cmdDone('/bin/zsh -lc make'), MESSAGE('built')] })
  await step($, 'agent-text-follow', 0)
  conv = [...conv, ...toolResult('Bash', 'toolu_codexmod_b'), user('The coordinator sent a message while you were working:\nalso lint\n\nAddress this before completing your current task.')]
  const s2 = await step($, 'agent-text-follow', 1)
  // the second run starts at once; its first action carries the first answer before it
  expect(w.spawned.length).toBe(2)
  expect(w.spawned[1]!.input).toBe('also lint')
  expect(w.spawned[1]!.argv).toContain('t-31')
  expect(s2.chunks[0].kind).toBe('text')
  // the note about the queued message precedes the first answer, never replaces it
  expect(s2.chunks[0].text.split('\n\n').slice(0, 2)).toEqual([steerNote('queued'), 'built'])
  expect(s2.result.toolUses[0]!.name).toBe('Bash')
})

// ---- safety: failures never fall through to the model -----------------------

test('a turn.step hook failure ends the step with "codex failed", never the model', async ($, on) => {
  const w = world(on, {
    messages: () => {
      throw new Error('transcript unavailable')
    },
  })
  const { result } = await step($, 'agent-throws')
  expect(w.modelCalls).toEqual([])
  expect(w.spawned.length).toBe(0)
  const text = result.toolUses[0]?.input.message ?? result.answer
  expect(firstLine(text)).toContain('codex failed: hook error')
})

test('a type of this plugin it does not define fails closed: no model, no Codex', async ($, on) => {
  const w = world(on)
  const { result } = await step($, 'agent-unknown-role')
  expect(w.modelCalls).toEqual([])
  expect(w.spawned.length).toBe(0)
  expect(firstLine(handback(result))).toBe('codex failed: agent type codex-mod:retired is not defined by this version of the plugin')
})

test('when the agent list fails, an agent with a stored record is still answered by Codex', async ($, on) => {
  const store = new Map<string, unknown>([['agent:sess-1:agent-persist', { ...PERSISTED, handedBack: false, updatedAt: 1_000_000 }]])
  const w = world(on, { listThrows: true, store, messages: () => [user('again')] })
  await step($, 'agent-persist', 0, 'turn-9')
  expect(w.modelCalls).toEqual([])
  expect(w.spawned.length).toBe(1)
})

test('safety: after a worker restart (nothing known) a Codex agent\'s Bash without our prefix is refused, never run', async ($, on) => {
  const w = world(on)
  const r: any = await $.tool.call({ tool: 'Bash', command: 'touch /tmp/pwned', tool_use_id: 'toolu_01model', agentId: 'agent-restart-guard' } as any)
  expect(r.deny).toContain('codex-mod: not executed')
  // a Claude subagent seen for the first time still runs its tools
  const gp: any = await $.tool.call({ tool: 'Bash', command: 'ls', tool_use_id: 'toolu_01gp', agentId: 'agent-gp2' } as any)
  expect(gp.result.stdout).toBe('REALLY RAN')
  expect(w.core.map(c => c.agentId)).toEqual(['agent-gp2'])
})

test('safety: when the agent type cannot be resolved, a subagent\'s Bash is refused', async ($, on) => {
  const w = world(on, { listThrows: true })
  const r: any = await $.tool.call({ tool: 'Bash', command: 'ls', tool_use_id: 'toolu_01x', agentId: 'agent-who-knows' } as any)
  expect(r.deny).toContain('codex-mod: not executed')
  expect(w.core).toEqual([])
})

// ---- coordinator framing ----------------------------------------------------

const WRAPPED = 'The coordinator sent a message while you were working:\nNext range: 10 to 15, print each number and its square, run it, and show me the output and the final file.\n\nAddress this before completing your current task.'

test('the coordinator framing is stripped: Codex gets the message body only', async ($, on) => {
  const w = world(on, { messages: () => [user(WRAPPED)] })
  await step($, 'agent-wrapped')
  expect(w.spawned[0]!.input).toBe('Next range: 10 to 15, print each number and its square, run it, and show me the output and the final file.')
  expect(stripCoordinator('plain task')).toBe('plain task')
  expect(stripCoordinator('The coordinator sent a message while you were working:\nbody only')).toBe('body only')
})

// ---- options ----------------------------------------------------------------

test('timeoutMinutes: a run past its time is stopped and reported as "codex failed: timeout"', { timeoutMs: 15000, options: { timeoutMinutes: 1 } }, async ($, on) => {
  const w = world(on, { pieces: [THREAD('t-40'), 'block', MESSAGE('never')] })
  const timers: number[] = []
  on('clock.after', async (_$, e: any) => {
    timers.push(e.ms)
    await new Promise<void>(r => setTimeout(() => r(), 50))
    return { value: undefined }
  })
  const { result } = await step($, 'agent-timeout')
  expect(timers).toEqual([60000])
  expect(firstLine(handback(result))).toBe('codex failed: timeout after 1 min (timeoutMinutes); Codex was stopped')
  expect(w.kills.count).toBe(1)
  expect(w.modelCalls).toEqual([])
})

test('nativeActions off: actions are text lines streamed in one step, nothing to answer', { options: { nativeActions: false, handbackMode: 'text' } }, async ($, on) => {
  const w = world(on, { pieces: [THREAD('t-41'), MESSAGE('Listing.'), cmdDone("/bin/zsh -lc 'ls -la'", 'a\n'), cmdDone('/bin/zsh -lc false', '', 1), MESSAGE('All done.')] })
  const { chunks, result } = await step($, 'agent-plain')
  expect(callsOf(chunks)).toEqual([])
  expect(result.stopReason).toBe('end_turn')
  expect(chunks.filter(c => c.kind === 'text').map(c => c.text)).toEqual([
    'Listing.', '\n\n$ ls -la', '\n\n$ false (exit code 1)',
    'All done.\n\ncodex · gpt-6.1-sol · medium · workspace-write · 2 actions · thread t-41',
  ])
  expect(chunks.filter(c => c.kind === 'text').map(c => c.index)).toEqual([0, 0, 0, 1])
  expect(w.spawned.length).toBe(1)
})

test('nativeActions off with SubagentHandback: the stream, then one handback call', { options: { nativeActions: false } }, async ($, on) => {
  world(on, { pieces: [THREAD('t-42'), cmdDone('/bin/zsh -lc pwd', '/x\n'), MESSAGE('ok')] })
  const { chunks, result } = await step($, 'agent-plain-tool')
  expect(chunks.filter(c => c.kind === 'text').map(c => c.text)).toEqual(['$ pwd'])
  expect(result.toolUses.map((u: any) => u.name)).toEqual(['SubagentHandback'])
  expect(callsOf(chunks)[0]!.input.message.startsWith('ok\n\ncodex · ')).toBe(true)
})

test('footer short and off', async ($, on) => {
  const p = { agent: 'sol', model: 'm', effort: 'low', sandbox: 'read-only', actions: 2, thread: 'abcdefghij' }
  expect(footer(p, 'short')).toBe('sol · m · low')
  expect(footer(p, 'off')).toBe('')
})

test('footer off: the handback carries the answer alone', { options: { footer: 'off' } }, async ($, on) => {
  world(on)
  const { result } = await step($, 'agent-footer-off')
  expect(handback(result)).toBe('PONG')
})

test('footer short in a run', { options: { footer: 'short' } }, async ($, on) => {
  world(on)
  const { result } = await step($, 'agent-footer-short')
  expect(handback(result)).toBe('PONG\n\nsol · gpt-6.1-sol · medium')
})

test('extraConfig entries are passed as -c to every launch', { options: { extraConfig: ['tools.view_image=false'], lean: false } }, async ($, on) => {
  const w = world(on)
  await step($, 'agent-extra')
  const argv = w.spawned[0]!.argv
  expect(argv.slice(-3)).toEqual(['-c', 'tools.view_image=false', '-'])
})

test('option validation: every knob, defaults on refused values', async () => {
  const d = parseConfig({})
  expect(d).toMatchObject({
    lean: true, globalRules: true, generic: { model: '', effort: 'medium', sandbox: 'workspace-write' }, roles: ['sol', 'sol-high', 'astra-audit'],
    extraConfig: [], intervalMs: 1000, maxActionsPerStep: 10, handbackMode: 'auto', footer: 'full', timeoutMs: 0, nativeActions: true, ttlMs: 2 * 86_400_000, maxRunsPerWindow: 3, warnings: [],
  })
  expect(d.codexPath).toBe(undefined)
  const good = parseConfig({
    codexPath: '/x/codex', defaultModel: 'gpt-6-luna', defaultEffort: 'ULTRA', defaultSandbox: 'read-only', roles: ['sol'], lean: false, globalRules: false,
    extraConfig: ['a.b=1'], progressIntervalMs: 0, maxActionsPerStep: 3, handbackMode: 'tool', footer: 'short', timeoutMinutes: 30, nativeActions: false, pruneDays: 7,
    maxRunsPerWindow: 5,
  })
  expect(good).toMatchObject({
    codexPath: '/x/codex', generic: { model: 'gpt-6-luna', effort: 'ultra', sandbox: 'read-only' }, roles: ['sol'], lean: false, globalRules: false,
    extraConfig: ['a.b=1'], intervalMs: 0, maxActionsPerStep: 3, handbackMode: 'tool', footer: 'short', timeoutMs: 1_800_000, nativeActions: false, ttlMs: 7 * 86_400_000, maxRunsPerWindow: 5, warnings: [],
  })
  const bad = parseConfig({
    defaultModel: 'bad model!', defaultEffort: 'not-an-effort', defaultSandbox: 'yolo', roles: ['sol', 'ghost'], lean: 'yes', globalRules: 1,
    extraConfig: ['novalue', 'model=gpt-x', 'sandbox_mode="danger-full-access"', 'ok=1'], progressIntervalMs: -5, maxActionsPerStep: 99, handbackMode: 'never',
    footer: 'huge', timeoutMinutes: 99999, nativeActions: 'no', pruneDays: 0, maxRunsPerWindow: 0,
  })
  expect(bad).toMatchObject({
    generic: { model: '', effort: 'medium', sandbox: 'workspace-write' }, roles: ['sol'], lean: true, globalRules: true, extraConfig: ['ok=1'],
    intervalMs: 1000, maxActionsPerStep: 10, handbackMode: 'auto', footer: 'full', timeoutMs: 0, nativeActions: true, ttlMs: 2 * 86_400_000, maxRunsPerWindow: 3,
  })
  for (const k of ['defaultModel', 'defaultEffort', 'defaultSandbox', 'ghost', 'lean', 'globalRules', 'novalue', '"model"', '"sandbox_mode"', 'progressIntervalMs', 'maxActionsPerStep', 'handbackMode', 'footer', 'timeoutMinutes', 'nativeActions', 'pruneDays', 'maxRunsPerWindow']) {
    expect(bad.warnings.some(w => w.includes(k))).toBe(true)
  }
})

test('model catalog: listed models by priority with their efforts; profile checks', async () => {
  const cat = parseModelsCache(MODELS_CACHE)!
  expect(cat.map(m => m.slug)).toEqual(['gpt-6.1-sol', 'gpt-6-luna'])
  expect(cat[0]).toEqual({ slug: 'gpt-6.1-sol', efforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'], defaultEffort: 'low' })
  expect(parseModelsCache('nope')).toBe(undefined)
  expect(checkProfile(cat, 'gpt-6.1-sol', 'ultra')).toBe(undefined)
  expect(checkProfile(cat, 'gpt-hidden', 'low')).toBe('model gpt-hidden not available (available: gpt-6.1-sol, gpt-6-luna)')
  expect(checkProfile(cat, 'gpt-6-luna', 'ultra')).toBe('effort ultra not supported by gpt-6-luna (supported: low, medium, high, xhigh, max)')
  expect(checkProfile(undefined, 'anything', 'any')).toBe(undefined)
})

const startWithCatalog = async ($: any, on: any, opts: WorldOpts = {}) => {
  const w = world(on, { ...opts, files: new Map([['/home/t/.codex/models_cache.json', MODELS_CACHE]]) })
  on('agent.register', (_$: any, e: any) => ({ value: { agent: `codex-mod:${e.name}` } }))
  on('process.run', (_$: any, e: any) => runOk(e.argv[0] === 'which' ? '/bin/codex' : 'ok'))
  await $.session.start?.({ cwd: '/tmp/project', surface: null, isInteractive: false })
  return w
}

test('an unknown model override fails clearly, no silent fallback, no launch', async ($, on) => {
  const w = await startWithCatalog($, on, { task: 'codex-model: gpt-nope\nhi' })
  const { result } = await step($, 'agent-cat-model')
  expect(w.spawned.length).toBe(0)
  expect(firstLine(handback(result))).toBe('codex failed: model gpt-nope not available (available: gpt-6.1-sol, gpt-6-luna)')
})

test('an effort the model does not support fails clearly; max/ultra pass where supported', async ($, on) => {
  let conv: any[] = [user('codex-model: gpt-6-luna\ncodex-effort: ultra\nhi')]
  const w = world(on, { messages: () => conv, files: new Map([['/home/t/.codex/models_cache.json', MODELS_CACHE]]) })
  on('agent.register', (_$: any, e: any) => ({ value: { agent: `codex-mod:${e.name}` } }))
  on('process.run', (_$: any, e: any) => runOk(e.argv[0] === 'which' ? '/bin/codex' : 'ok'))
  await $.session.start?.({ cwd: '/tmp/project', surface: null, isInteractive: false })
  const r1 = await step($, 'agent-cat-effort')
  expect(w.spawned.length).toBe(0)
  expect(firstLine(handback(r1.result))).toBe('codex failed: effort ultra not supported by gpt-6-luna (supported: low, medium, high, xhigh, max)')
  conv = [...conv, ...toolResult('SubagentHandback')]
  await step($, 'agent-cat-effort', 1)
  conv = [...conv, user('codex-model: gpt-6.1-sol\ncodex-effort: ultra\nhi again')]
  await step($, 'agent-cat-effort', 0, 'turn-2')
  expect(w.spawned.length).toBe(1)
  expect(w.spawned[0]!.argv).toContain('model_reasoning_effort="ultra"')
})

// ---- global rules off (experimental shadow CODEX_HOME) ----------------------

test('globalRules off: Codex runs with a plugin-owned CODEX_HOME linking only auth, config and the model list', { options: { globalRules: false, lean: false } }, async ($, on) => {
  const runs: string[][] = []
  const w = world(on)
  on('process.run', (_$, e: any) => {
    runs.push([...e.argv])
    return runOk()
  })
  on('fs.exists', (_$, e: any) => ({ value: ['auth.json', 'config.toml', 'models_cache.json', 'AGENTS.md', 'sessions'].some(n => e.path === `/home/t/.codex/${n}`) }))
  on('fs.stat', () => {
    throw new Error('ENOENT')
  })
  await step($, 'agent-shadow')
  const shadow = '/home/t/.cache/codex-mod/home'
  expect(w.spawned[0]!.env).toEqual({ CODEX_HOME: shadow })
  expect(runs).toEqual([
    ['mkdir', '-p', shadow],
    ['rm', '-f', `${shadow}/AGENTS.md`, `${shadow}/AGENTS.override.md`],
    ...SHADOW_LINKS.map(n => ['ln', '-sfn', `/home/t/.codex/${n}`, `${shadow}/${n}`]),
  ])
  // nothing ever names AGENTS.md as a link source, and nothing touches the real home but as a link target
  expect(runs.some(r => r.includes('/home/t/.codex/AGENTS.md'))).toBe(false)
  expect(runs.filter(r => r[0] !== 'ln').some(r => r.some(a => a.startsWith('/home/t/.codex')))).toBe(false)
  expect(w.spawned.length).toBe(1)
})

test('globalRules on (default): no CODEX_HOME, nothing prepared', async ($, on) => {
  const w = world(on)
  await step($, 'agent-wrapped-mid')
  expect(w.spawned[0]!.env).toBe(undefined)
})

test('launch argv (pure): new and resumed runs, extra -c last before the prompt', async () => {
  const prof = { model: 'm', effort: 'max', sandbox: 'read-only' }
  expect(launchArgv({ codex: 'codex', prof, cwd: '/w', lean: [], extra: ['k=v'] })).toEqual([
    'codex', 'exec', '--json', '--skip-git-repo-check', '--sandbox', 'read-only', '-C', '/w', '-m', 'm', '-c', 'model_reasoning_effort="max"', '-c', 'k=v', '-',
  ])
  expect(launchArgv({ codex: 'codex', prof, cwd: '/w', resume: 'th', lean: [], extra: [] })).toEqual([
    'codex', 'exec', 'resume', '--json', '--skip-git-repo-check', '-c', 'sandbox_mode="read-only"', '-m', 'm', '-c', 'model_reasoning_effort="max"', 'th', '-',
  ])
})

test('agent registration refused at session start is retried once on the next main-loop step', async ($, on) => {
  const w = world(on)
  let calls = 0
  on('agent.register', (_$, e: any) => {
    calls++
    if (calls <= 4) throw new Error('session not bound')
    return { value: { agent: `codex-mod:${e.name}` } }
  })
  on('process.run', (_$, e: any) => runOk(e.argv[0] === 'which' ? '/bin/codex' : 'ok'))
  await $.session.start?.({ cwd: '/tmp/project', surface: null, isInteractive: false })
  expect(calls).toBe(4)
  await step($)
  expect(calls).toBe(8)
  await step($)
  expect(calls).toBe(8)
  expect(w.modelCalls).toEqual(['main', 'main'])
})

// ---- live failure (Desktop, auto mode): engine nudges never launch Codex ------

const LIVE_TASK = 'codex-model: gpt-6-luna\ncodex-effort: low\nIn the current directory, running each command separately: 1) create a folder luna-v2; 2) write luna-v2/count.py printing 1 to 5; 3) run python3 luna-v2/count.py. Reply with the output of step 3 and ask me which range I want next.'
const LIVE_ENFORCE = '[handback-send-enforce] Your report has not been delivered. Call SubagentHandback({message: <your full report>}) now; the call ends your run.'
const LIVE_NO_OUTPUT = '[Your previous response had no visible output. Please continue and produce a user-visible response.]'
const LIVE_COORDINATOR = 'The coordinator sent a message while you were working:\nRange 20 to 23 with squares; run it and show the output.\n\nAddress this before completing your current task.'
const meta = (text: string) => ({ role: 'user', text, toolUses: [], isMeta: true })
const said = (text: string) => ({ role: 'assistant', text, toolUses: [] })
const NOT_ACTIVE_TEXT = 'Nothing was sent: SubagentHandback is not active for this agent. Write your report as plain text instead.'

test('live sequence: 1 Codex launch for the task, 1 for the coordinator follow-up; nudges re-deliver through SubagentHandback', async ($, on) => {
  const first = '1\n2\n3\n4\n5\n\nWhich range would you like next?'
  const second = '```text\n400\n441\n484\n529\n```'
  let conv: any[] = [user(LIVE_TASK)]
  const opts: any = { messages: () => conv, pieces: [THREAD('01a14f89'), MESSAGE(first)] }
  const w = world(on, opts)
  const s1 = await step($, 'agent-live', 0)
  expect(w.spawned.length).toBe(1)
  expect(w.spawned[0]!.input).toBe(LIVE_TASK.split('\n').slice(2).join('\n'))
  const answer1 = handback(s1.result)
  expect(answer1.startsWith(first)).toBe(true)
  // the transcript as the live run had it: the answer as text, then the engine's two nudges, four times
  for (let i = 0; i < 4; i++) {
    conv = [...conv, said(answer1), meta(LIVE_ENFORCE), meta(LIVE_NO_OUTPUT)]
    const s = await step($, 'agent-live', i + 1)
    expect(w.spawned.length).toBe(1)
    expect(s.result.toolUses.map((u: any) => u.name)).toEqual(['SubagentHandback'])
    expect(handback(s.result)).toBe(answer1)
  }
  // the coordinator's message (a meta row too) is the one new task
  opts.pieces = [THREAD('01a14f89'), MESSAGE(second)]
  conv = [...conv, said(answer1), meta(LIVE_COORDINATOR)]
  const s2 = await step($, 'agent-live', 0, 'turn-2')
  expect(w.spawned.length).toBe(2)
  expect(w.spawned[1]!.input).toBe('Range 20 to 23 with squares; run it and show the output.')
  expect(w.spawned[1]!.argv).toContain('01a14f89')
  const answer2 = handback(s2.result)
  expect(answer2.startsWith(second)).toBe(true)
  for (let i = 0; i < 4; i++) {
    conv = [...conv, said(answer2), meta(LIVE_ENFORCE), meta(LIVE_NO_OUTPUT)]
    const s = await step($, 'agent-live', i + 1, 'turn-2')
    expect(w.spawned.length).toBe(2)
    expect(s.result.toolUses.map((u: any) => u.name)).toEqual(['SubagentHandback'])
    expect(handback(s.result)).toBe(answer2)
  }
  expect(w.modelCalls).toEqual([])
  expect(w.store.get('agent:sess-1:agent-live')).toMatchObject({ handbackLock: 'tool', launchesSinceNew: 1, userCount: 2 })
})

test('live sequence on the rows form alone (API form denied): nudges are invisible, still no relaunch', async ($, on) => {
  let conv: any[] = [user(LIVE_TASK)]
  const w = world(on, { messages: () => conv, noApi: true })
  await step($, 'agent-live-rows', 0)
  for (let i = 0; i < 4; i++) {
    conv = [...conv, said('PONG'), meta(LIVE_ENFORCE), meta(LIVE_NO_OUTPUT)]
    await step($, 'agent-live-rows', i + 1)
  }
  expect(w.spawned.length).toBe(1)
})

test('auto: a "not active" SubagentHandback result re-delivers the same answer as text; an enforce nudge switches back to the tool', async ($, on) => {
  let conv: any[] = [user('Reply with the single word PONG')]
  const w = world(on, { messages: () => conv, handback: false })
  const s1 = await step($, 'agent-fallback', 0)
  const answer = handback(s1.result)
  conv = [...conv,
    { role: 'assistant', text: '', toolUses: [{ tool_use_id: 'toolu_codexmod_hb', tool: 'SubagentHandback', input: { message: answer } }] },
    { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: 'toolu_codexmod_hb', text: NOT_ACTIVE_TEXT, isError: false }] },
  ]
  const s2 = await step($, 'agent-fallback', 1)
  expect(w.spawned.length).toBe(1)
  expect(s2.result.toolUses).toEqual([])
  expect(s2.result.stopReason).toBe('end_turn')
  expect(s2.result.answer).toBe(answer)
  expect(w.store.get('agent:sess-1:agent-fallback')).toMatchObject({ handbackLock: 'text' })
  conv = [...conv, said(answer), meta(LIVE_ENFORCE), meta(LIVE_NO_OUTPUT)]
  const s3 = await step($, 'agent-fallback', 2)
  expect(w.spawned.length).toBe(1)
  expect(handback(s3.result)).toBe(answer)
  expect(w.store.get('agent:sess-1:agent-fallback')).toMatchObject({ handbackLock: 'tool' })
})

test('launch guard: at most maxRunsPerWindow (3) launches per agent in 10 min; beyond, "launch guard tripped" and no relaunch', async ($, on) => {
  let conv: any[] = [user('task 0')]
  const w = world(on, { messages: () => conv })
  await step($, 'agent-window', 0)
  for (let i = 1; i <= 3; i++) {
    conv = [...conv, ...toolResult('SubagentHandback', `hb${i}`), meta(`The coordinator sent a message while you were working:\ntask ${i}\n\nAddress this before completing your current task.`)]
    const s = await step($, 'agent-window', 0, `turn-${i + 1}`)
    if (i < 3) expect(handback(s.result).startsWith('PONG')).toBe(true)
    else expect(firstLine(handback(s.result))).toBe('codex failed: launch guard tripped (3 launches in the last 10 min (maxRunsPerWindow 3))')
  }
  expect(w.spawned.length).toBe(3)
  expect((w.store.get('agent:sess-1:agent-window') as any).launches.length).toBe(3)
  // a nudge re-delivers the trip, never a run
  conv = [...conv, said('x'), meta(LIVE_NO_OUTPUT)]
  const again = await step($, 'agent-window', 1, 'turn-4')
  expect(firstLine(handback(again.result))).toContain('launch guard tripped')
  expect(w.spawned.length).toBe(3)
  // past the window a new message runs again
  w.clock.now += 11 * 60 * 1000
  conv = [...conv, ...toolResult('SubagentHandback', 'hb9'), user('task 9')]
  await step($, 'agent-window', 0, 'turn-9')
  expect(w.spawned.length).toBe(4)
})

test('launch guard: one launch per message, kept in the stored record across a worker restart', async ($, on) => {
  const store = new Map<string, unknown>([['agent:sess-1:agent-guard-restart', {
    ...PERSISTED, lastTask: undefined, handedBack: false, launchKey: '1:first', launchesSinceNew: 1, launches: [999_000], updatedAt: 1_000_000,
  }]])
  const w = world(on, { messages: () => [user('first')], store })
  const { result } = await step($, 'agent-guard-restart', 0)
  expect(w.spawned.length).toBe(0)
  expect(firstLine(handback(result))).toBe('codex failed: launch guard tripped (this message already had its Codex run)')
  expect(w.store.get('agent:sess-1:agent-guard-restart')).toMatchObject({ guardTrip: { key: '1:first' } })
})

test('helpers: engine notices and reminder-only rows are never tasks', async () => {
  expect(cleanText(LIVE_ENFORCE)).toBe('')
  expect(cleanText(LIVE_NO_OUTPUT)).toBe('')
  expect(cleanText(HANDBACK_ROW.text)).toBe('')
  expect(cleanText(LIVE_COORDINATOR)).toBe('Range 20 to 23 with squares; run it and show the output.')
  expect(cleanText('[x] keep this checklist line\n[WIP] and this')).toBe('[x] keep this checklist line\n[WIP] and this')
  const rd = readConversation(itemsFromApi([{ role: 'user', content: LIVE_TASK }, { role: 'user', content: [{ type: 'text', text: HANDBACK_ROW.text }] }]))
  expect(rd.signal).toBe('tool')
  expect(rd.latest?.count).toBe(1)
})

// ---- protocol drift, version, provider (both transports) --------------------

test('drift: a run with no agent message and unknown lines fails as "protocol changed", naming up to 3 types', async ($, on) => {
  world(on, { stdout: '{"type":"thread.started","thread_id":"t-50"}\n{"type":"item.weird"}\nnot json at all\n{"type":"thing.a"}\n{"type":"thing.b"}\n{"type":"turn.completed","usage":{"input_tokens":1,"output_tokens":0}}\n' })
  const { result } = await step($, 'agent-drift')
  expect(firstLine(handback(result))).toBe('codex failed: codex exec --json protocol changed (codex-cli unknown): 4 unknown events (item.weird, non-JSON, thing.a)')
})

test('drift: unknown lines beside an agent message change nothing', async ($, on) => {
  world(on, { stdout: '{"type":"thread.started","thread_id":"t-51"}\n{"type":"item.weird"}\n{"type":"item.completed","item":{"type":"agent_message","text":"PONG"}}\n' })
  const { result } = await step($, 'agent-drift-ok')
  expect(handback(result)).toBe('PONG\n\ncodex · gpt-6.1-sol · medium · workspace-write · 0 actions · thread t-51')
})

test('version: session start reads codex --version; the drift reason names it; no warning at 0.163.0-alpha', async ($, on) => {
  const notified: string[] = []
  world(on, { stdout: '{"type":"brand.new"}\n' })
  on('agent.register', (_$, e: any) => ({ value: { agent: `codex-mod:${e.name}` } }))
  on('process.run', (_$, e: any) => runOk(e.argv[0] === 'which' ? '/bin/codex' : e.argv.includes('--version') ? 'codex-cli 0.163.0-alpha.10.2\n' : 'ok'))
  on('ui.notify', (_$, e: any) => {
    notified.push(e.text)
    return { value: { isSent: true, channel: 'terminal_bell' as const } }
  })
  await $.session.start?.({ cwd: '/tmp/project', surface: null, isInteractive: false })
  expect(notified).toEqual([])
  const { result } = await step($, 'agent-drift-version')
  expect(firstLine(handback(result))).toBe('codex failed: codex exec --json protocol changed (codex-cli 0.163.0-alpha.10.2): 1 unknown event (brand.new)')
})

test('version: below 0.163.0 is warned about once (debug + notify), and Codex still runs', async ($, on) => {
  const notified: string[] = []
  const w = world(on)
  on('agent.register', (_$, e: any) => ({ value: { agent: `codex-mod:${e.name}` } }))
  on('process.run', (_$, e: any) => runOk(e.argv[0] === 'which' ? '/bin/codex' : e.argv.includes('--version') ? 'codex-cli 0.150.2' : 'ok'))
  on('ui.notify', (_$, e: any) => {
    notified.push(e.text)
    return { value: { isSent: true, channel: 'terminal_bell' as const } }
  })
  await $.session.start?.({ cwd: '/tmp/project', surface: null, isInteractive: false })
  await $.session.start?.({ cwd: '/tmp/project', surface: null, isInteractive: false })
  expect(notified).toEqual(['codex-mod: codex-cli 0.150.2 is older than 0.163.0, the version this plugin was verified on; runs may fail'])
  expect(w.logs.some(l => l.includes('older than 0.163.0'))).toBe(true)
  expect(w.logs.some(l => l.includes('Codex ready (/bin/codex)'))).toBe(true)
})

test('provider: a non-openai model_provider makes a failing login status a debug note, not the logged-out blocker', async ($, on) => {
  const notified: string[] = []
  const w = world(on, { files: new Map([['/home/t/.codex/config.toml', '# local\nmodel_provider = "ollama"\nmodel = "x"\n[model_providers.ollama]\nname = "Ollama"\n']]) })
  on('agent.register', (_$, e: any) => ({ value: { agent: `codex-mod:${e.name}` } }))
  on('process.run', (_$, e: any) => ({ value: e.argv.includes('login') ? { exitCode: 1, stdout: '', stderr: 'Not logged in', isStdoutTruncated: false, isStderrTruncated: false } : runOk(e.argv[0] === 'which' ? '/bin/codex' : 'v').value }))
  on('ui.notify', (_$, e: any) => {
    notified.push(e.text)
    return { value: { isSent: true, channel: 'terminal_bell' as const } }
  })
  await $.session.start?.({ cwd: '/tmp/project', surface: null, isInteractive: false })
  expect(notified).toEqual([])
  expect(w.logs.some(l => l.includes('model_provider is ollama, so it is not treated as logged out'))).toBe(true)
  const { result } = await step($, 'agent-provider')
  expect(handback(result)).not.toContain('launch check')
})

test('provider: with openai (or none) the logged-out message suggests codex login and --device-auth', async ($, on) => {
  const notified: string[] = []
  world(on, { files: new Map([['/home/t/.codex/config.toml', 'model_provider = "openai"\n']]) })
  on('agent.register', (_$, e: any) => ({ value: { agent: `codex-mod:${e.name}` } }))
  on('process.run', (_$, e: any) => ({ value: e.argv.includes('login') ? { exitCode: 1, stdout: '', stderr: 'Not logged in', isStdoutTruncated: false, isStderrTruncated: false } : runOk(e.argv[0] === 'which' ? '/bin/codex' : 'v').value }))
  on('ui.notify', (_$, e: any) => {
    notified.push(e.text)
    return { value: { isSent: true, channel: 'terminal_bell' as const } }
  })
  await $.session.start?.({ cwd: '/tmp/project', surface: null, isInteractive: false })
  expect(notified).toEqual(['codex-mod: Codex is not logged in (Not logged in); run "codex login" or "codex login --device-auth"'])
})

test('helpers: runner lines, versions, model_provider, runner argv, footer with transport and steers', async () => {
  expect(parseCodexLine('{"type":"codexmod.turn","turn_id":"tu-1"}')).toEqual({ kind: 'turn', id: 'tu-1' })
  expect(parseCodexLine('{"type":"codexmod.steer","id":12,"status":"accepted"}')).toEqual({ kind: 'steer', id: '12', accepted: true })
  expect(parseCodexLine('{"type":"codexmod.steer","id":"x","status":"rejected","reason":"turn finished"}')).toEqual({ kind: 'steer', id: 'x', accepted: false, reason: 'turn finished' })
  expect(parseCodexLine('{"type":"codexmod.protocol","unknown_methods":["a/b"],"unknown_items":["c"]}')).toEqual({ kind: 'protocol', types: ['method a/b', 'item c'] })
  expect(parseCodexLine('{"type":"codexmod.fatal","message":"boom"}')).toEqual({ kind: 'fatal', text: 'boom' })
  expect(parseCodexLine('{"type":"codexmod.future"}')).toEqual({ kind: 'other' })
  expect(parseCodexLine('{"type":"item.updated","item":{}}')).toEqual({ kind: 'other' })
  expect(parseCodexLine('{"type":"turn.started"}')).toEqual({ kind: 'other' })
  expect(parseCodexLine('{"type":"x.y"}')).toEqual({ kind: 'unknown', type: 'x.y' })
  expect(parseCodexLine('{"no":"type"}')).toEqual({ kind: 'unknown', type: 'untyped' })
  expect(parseCodexLine('garbage')).toEqual({ kind: 'unknown', type: 'non-JSON' })
  expect(parseCodexVersion('codex-cli 0.163.0-alpha.10.2\n')).toBe('0.163.0-alpha.10.2')
  expect(parseCodexVersion('codex-cli 0.170.1')).toBe('0.170.1')
  expect(parseCodexVersion('ok')).toBe(undefined)
  expect([codexTooOld('0.162.9'), codexTooOld('0.163.0-alpha.1'), codexTooOld('0.163.0'), codexTooOld('0.200.0'), codexTooOld('1.0.0')]).toEqual([true, false, false, false, false])
  expect(modelProvider('model_provider = "ollama"')).toBe('ollama')
  expect(modelProvider("model_provider='azure' # c")).toBe('azure')
  expect(modelProvider('model = "x"\n[profiles.a]\nmodel_provider = "ollama"')).toBe(undefined)
  expect(runnerArgv({ node: '/n', runner: '/r.mjs', codex: '/c', prof: { model: 'm', effort: 'low', sandbox: 'read-only' }, cwd: '/w', resume: 'th', lean: ['-c', 'features.apps=false', '-c', 'web_search="disabled"'], extra: ['k=v'], control: '/ctl' })).toEqual([
    '/n', '/r.mjs', 'run', '--codex', '/c', '--cwd', '/w', '--model', 'm', '--effort', 'low', '--sandbox', 'read-only', '--thread', 'th',
    '--config', 'features.apps=false', '--config', 'web_search="disabled"', '--config', 'k=v', '--control', '/ctl',
  ])
  expect(runnerArgv({ node: 'n', runner: 'r', codex: 'c', prof: { model: 'm', effort: 'e', sandbox: 's' }, cwd: '/w', lean: [], extra: [], control: '/ctl' })).not.toContain('--thread')
  const p = { agent: 'codex', model: 'm', effort: 'low', sandbox: 'workspace-write', actions: 2 }
  expect(footer({ ...p, transport: 'app-server', steers: 2 })).toBe('codex · m · low · workspace-write · app-server · 2 steers · 2 actions')
  expect(footer({ ...p, transport: 'app-server', steers: 0 })).toBe('codex · m · low · workspace-write · app-server · 2 actions')
  expect(footer({ ...p, transport: 'app-server', steers: 1 }, 'short')).toBe('codex · m · low')
  expect(steerNote('accepted', 'codex-effort: high\n  fix the  tests\nplease')).toBe('↪ steer delivered to Codex mid-turn: "fix the tests please"')
  const long = steerNote('accepted', 'x'.repeat(200))
  expect(long).toBe(`↪ steer delivered to Codex mid-turn: "${'x'.repeat(77)}..."`)
  expect(steerNote('finished')).toBe('↪ Codex had already finished; this message runs next, on the same thread')
  expect(steerNote('queued')).toBe('↪ queued: runs after this turn (exec transport has no mid-turn steer)')
  expect(parseConfig({})).toMatchObject({ transport: 'exec', nodeOverride: undefined })
  expect(parseConfig({ transport: 'app-server', nodePath: '/opt/node' })).toMatchObject({ transport: 'app-server', nodeOverride: '/opt/node', warnings: [] })
  const bad = parseConfig({ transport: 'websocket', nodePath: 3 })
  expect(bad).toMatchObject({ transport: 'exec', nodeOverride: undefined })
  expect(bad.warnings.some(w => w.startsWith('transport:'))).toBe(true)
  expect(bad.warnings.some(w => w.startsWith('nodePath:'))).toBe(true)
})

test('exec runs never set the mid-step timer', async ($, on) => {
  const w = world(on, { pieces: [THREAD('t-52'), out('{"type":"turn.started"}'), MESSAGE('PONG')] })
  let timers = 0
  on('clock.after', () => {
    timers++
    return { value: undefined }
  })
  await step($, 'agent-exec-notimer')
  expect(timers).toBe(0)
  expect(w.writes).toEqual([])
})

// ---- app-server transport ---------------------------------------------------

const RUNNER_PATH = /\/scripts\/codex-runner\.mjs$/
const TURN = (id: string) => out(JSON.stringify({ type: 'codexmod.turn', turn_id: id }))
const ACK = (id: number, status: 'accepted' | 'rejected', reason?: string) => out(JSON.stringify({ type: 'codexmod.steer', id, status, ...(reason ? { reason } : {}) }))

/**
 * A world with transport app-server ready: node on PATH, the runner present
 * and speaking protocol 1, `codex app-server --help` passing (or `help` exit);
 * `$.clock.after` fires after a few real ms, whatever it asks.
 */
function appWorld(on: On, opts: WorldOpts = {}, ready: { help?: number; protocol?: string; node?: boolean } = {}) {
  const w = world(on, opts)
  const runs: string[][] = []
  const timers: number[] = []
  on('agent.register', (_$, e: any) => ({ value: { agent: `codex-mod:${e.name}` } }))
  on('process.run', (_$, e: any) => {
    runs.push([...e.argv])
    const a = e.argv as string[]
    if (a[0] === 'which') return a[1] === 'node' && ready.node === false ? { value: { exitCode: 1, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } } : runOk(`/usr/local/bin/${a[1]}\n`)
    if (a.includes('app-server')) return { value: { exitCode: ready.help ?? 0, stdout: 'usage', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    if (RUNNER_PATH.test(a[1] ?? '') && a[2] === '--version') return runOk(`${ready.protocol ?? '1'}\n`)
    return runOk(a.includes('--version') ? 'codex-cli 0.163.0' : 'ok')
  })
  on('fs.exists', (_$, e: any) => ({ value: RUNNER_PATH.test(e.path) }))
  on('clock.after', async (_$, e: any) => {
    timers.push(e.ms)
    await new Promise<void>(r => setTimeout(r, 15))
    return { value: undefined }
  })
  return { ...w, runs, timers }
}

const startSession = ($: any) => $.session.start?.({ cwd: '/tmp/project', surface: null, isInteractive: false })
const CONTROL = /^\/home\/t\/\.cache\/codex-mod\/runs\/sess-1-(agent-[\w-]+)-(\d+)$/

test('app-server: session start checks node, the runner and codex app-server; a launch runs the runner with the same profile', { options: { transport: 'app-server', extraConfig: ['tools.view_image=false'] } }, async ($, on) => {
  const w = appWorld(on, { files: new Map([['/home/t/.codex/config.toml', CONFIG_TOML]]), pieces: [THREAD('t-60'), TURN('tu-1'), MESSAGE('PONG'), USAGE] })
  await startSession($)
  expect(w.runs.map(r => (RUNNER_PATH.test(r[1] ?? '') ? ['node', 'RUNNER', ...r.slice(2)] : r).join(' '))).toEqual([
    'which codex', '/usr/local/bin/codex --version', '/usr/local/bin/codex login status',
    'which node', '/usr/local/bin/codex app-server --help', 'node RUNNER --version',
  ])
  expect(w.logs.some(l => l.includes('app-server transport ready'))).toBe(true)
  const { result } = await step($, 'agent-app')
  const argv = w.spawned[0]!.argv
  expect(argv[0]).toBe('/usr/local/bin/node')
  expect(argv[1]).toMatch(RUNNER_PATH)
  expect(argv.slice(2, 13)).toEqual(['run', '--codex', '/usr/local/bin/codex', '--cwd', '/tmp/project', '--model', 'gpt-6.1-sol', '--effort', 'medium', '--sandbox', 'workspace-write'])
  expect(argv).not.toContain('--thread')
  const configs = argv.filter((_, i) => argv[i - 1] === '--config')
  expect(configs).toContain('features.plugins=false')
  expect(configs).toContain('mcp_servers.node_repl.enabled=false')
  expect(configs.at(-1)).toBe('tools.view_image=false')
  expect(configs.some(c => c.startsWith('model_reasoning_effort'))).toBe(false)
  expect(argv.at(-2)).toBe('--control')
  expect(argv.at(-1)).toMatch(CONTROL)
  expect(w.spawned[0]!.input).toBe('Reply with the single word PONG')
  // the stale-dir guard removed the control dir before the launch
  expect(w.runs.some(r => r[0] === 'rm' && r[1] === '-rf' && r[2] === argv.at(-1))).toBe(true)
  expect(handback(result)).toBe('PONG\n\nsol · gpt-6.1-sol · medium · workspace-write · app-server · 0 actions · 277 new tokens (21K cached, 46 out) · thread t-60')
  expect(w.store.get('agent:sess-1:agent-app')).toMatchObject({ runSeq: 1, thread: 't-60' })
})

test('app-server: a failing check falls back to exec for the session, and the footer says why', { options: { transport: 'app-server', lean: false } }, async ($, on) => {
  const w = appWorld(on, {}, { help: 2 })
  await startSession($)
  expect(w.logs.some(l => l.includes('app-server transport unavailable (codex app-server --help failed (exit 2)); runs use codex exec'))).toBe(true)
  const { result } = await step($, 'agent-app-fallback')
  expect(w.spawned[0]!.argv.slice(0, 3)).toEqual(['/usr/local/bin/codex', 'exec', '--json'])
  expect(lastLine(handback(result))).toBe('codex · gpt-6.1-sol · medium · workspace-write · exec (app-server unavailable: codex app-server --help failed (exit 2)) · 0 actions · 1 new tokens (0 cached, 1 out) · thread t-1')
})

test('app-server: a runner speaking another protocol falls back to exec', { options: { transport: 'app-server' } }, async ($, on) => {
  const w = appWorld(on, {}, { protocol: '2' })
  await startSession($)
  expect(w.logs.some(l => l.includes('runner protocol 2, expected 1'))).toBe(true)
  await step($, 'agent-app-fallback')
  expect(w.spawned[0]!.argv[1]).toBe('exec')
})

test('app-server: without a session start the first launch runs the checks (nodePath wins)', { options: { transport: 'app-server', nodePath: '/opt/node22/bin/node' } }, async ($, on) => {
  const w = appWorld(on, { pieces: [THREAD('t-61'), TURN('tu-1'), MESSAGE('ok')] })
  await step($, 'agent-app-lazy')
  expect(w.runs.some(r => r[0] === 'which')).toBe(false)
  expect(w.runs.some(r => r[0] === '/opt/node22/bin/node' && r[2] === '--version')).toBe(true)
  expect(w.spawned[0]!.argv[0]).toBe('/opt/node22/bin/node')
  expect(w.spawned[0]!.argv[1]).toMatch(RUNNER_PATH)
})

test('app-server steer: a message arriving mid-run is written as a steer file; accepted, it is that message\'s launch', { options: { transport: 'app-server' } }, async ($, on) => {
  let conv: any[] = [user('build it')]
  const w = appWorld(on, { messages: () => conv, pieces: [THREAD('t-62'), TURN('tu-1'), cmdDone('/bin/zsh -lc make'), ACK(2, 'accepted'), MESSAGE('built, with tests'), USAGE] })
  const s1 = await step($, 'agent-app-steer', 0)
  expect(s1.result.toolUses[0]!.name).toBe('Bash')
  await runCalls($, s1.chunks, 'agent-app-steer')
  conv = [...conv, ...toolResult('Bash', 'toolu_codexmod_s'), user('codex-effort: high\nalso add tests')]
  const s2 = await step($, 'agent-app-steer', 1)
  const control = w.spawned[0]!.argv.at(-1)!
  expect(w.writes).toEqual([{ path: `${control}/steer-000002.json`, text: JSON.stringify({ text: 'also add tests' }) }])
  // the control dir was created private before any steer file went into it
  expect(w.runs.some(r => r[0] === 'mkdir' && r.slice(1, 4).join(' ') === '-p -m 700' && r.includes('/home/t/.cache/codex-mod/runs') && r.at(-1) === control)).toBe(true)
  // the note says what was steered (without the override line), before Codex's answer
  expect(handback(s2.result).split('\n\n').slice(0, 2)).toEqual(['↪ steer delivered to Codex mid-turn: "also add tests"', 'built, with tests'])
  expect(lastLine(handback(s2.result))).toBe('codex · gpt-6.1-sol · medium · workspace-write · app-server · 1 steer · 1 action · 277 new tokens (21K cached, 46 out) · thread t-62')
  expect(w.store.get('agent:sess-1:agent-app-steer')).toMatchObject({ userCount: 2, lastTask: 'codex-effort: high\nalso add tests', launchKey: '2:codex-effort: high\nalso add tests' })
  // the handback's result ends the turn; the steered message never launches again
  conv = [...conv, ...toolResult('SubagentHandback', 'hb')]
  const s3 = await step($, 'agent-app-steer', 2)
  expect(s3.result.stopReason).toBe('end_turn')
  conv = [...conv, said('x'), meta(LIVE_NO_OUTPUT)]
  await step($, 'agent-app-steer', 3)
  expect(w.spawned.length).toBe(1)
  expect(w.modelCalls).toEqual([])
})

test('app-server steer: a rejected steer runs after the handback, resuming the thread', { options: { transport: 'app-server' } }, async ($, on) => {
  let conv: any[] = [user('first')]
  const opts: WorldOpts = { messages: () => conv, pieces: [THREAD('t-63'), TURN('tu-1'), cmdDone('/bin/zsh -lc make'), ACK(2, 'rejected', 'turn finished'), MESSAGE('built')] }
  const w = appWorld(on, opts)
  const s1 = await step($, 'agent-app-reject', 0)
  await runCalls($, s1.chunks, 'agent-app-reject')
  conv = [...conv, ...toolResult('Bash', 'toolu_codexmod_r'), user('also lint')]
  const s2 = await step($, 'agent-app-reject', 1)
  expect(lastLine(handback(s2.result))).not.toContain('steer')
  expect(handback(s2.result).split('\n\n').slice(0, 2)).toEqual([steerNote('finished'), 'built'])
  expect(w.logs.some(l => l.includes('steer 2 rejected (turn finished)'))).toBe(true)
  opts.pieces = [THREAD('t-63'), TURN('tu-2'), MESSAGE('linted')]
  conv = [...conv, ...toolResult('SubagentHandback', 'hb')]
  const s3 = await step($, 'agent-app-reject', 2)
  expect(w.spawned.length).toBe(2)
  const argv = w.spawned[1]!.argv
  expect(argOf(argv, '--thread')).toBe('t-63')
  expect(w.spawned[1]!.input).toBe('also lint')
  // each run gets its own control dir
  expect(argv.at(-1)).not.toBe(w.spawned[0]!.argv.at(-1))
  expect(argv.at(-1)!.endsWith('-2')).toBe(true)
  expect(handback(s3.result).startsWith('linted')).toBe(true)
})

test('app-server steer: a steer the runner never acked runs after the handback', { options: { transport: 'app-server' } }, async ($, on) => {
  let conv: any[] = [user('first')]
  const opts: WorldOpts = { messages: () => conv, pieces: [THREAD('t-64'), TURN('tu-1'), cmdDone('/bin/zsh -lc make'), MESSAGE('built')] }
  const w = appWorld(on, opts)
  const s1 = await step($, 'agent-app-unacked', 0)
  await runCalls($, s1.chunks, 'agent-app-unacked')
  conv = [...conv, ...toolResult('Bash', 'toolu_codexmod_u'), user('and docs')]
  const s2 = await step($, 'agent-app-unacked', 1)
  expect(w.writes.length).toBe(1)
  // never acked when the run ended: announced as running next, before the answer
  expect(handback(s2.result).split('\n\n').slice(0, 2)).toEqual([steerNote('finished'), 'built'])
  expect(lastLine(handback(s2.result))).not.toContain('steer')
  opts.pieces = [THREAD('t-64'), TURN('tu-2'), MESSAGE('documented')]
  conv = [...conv, ...toolResult('SubagentHandback', 'hb')]
  await step($, 'agent-app-unacked', 2)
  expect(w.spawned.length).toBe(2)
  expect(w.spawned[1]!.input).toBe('and docs')
})

test('app-server mid-step: while a step waits on the runner, a new message is steered within that same step', { timeoutMs: 15000, options: { transport: 'app-server' } }, async ($, on) => {
  let conv: any[] = [user('long task')]
  let w: ReturnType<typeof appWorld>
  const steered = () => w.writes.some(x => x.path.endsWith('/steer-000002.json'))
  w = appWorld(on, { messages: () => conv, pieces: [THREAD('t-65'), TURN('tu-1'), steered, ACK(2, 'accepted'), MESSAGE('done, steered'), USAGE] })
  const pending = step($, 'agent-app-mid', 0)
  await new Promise<void>(r => setTimeout(r, 60))
  conv = [...conv, user('change of plan')]
  const { result } = await pending
  expect(w.timers.filter(ms => ms === 2000).length >= 1).toBe(true)
  expect(w.writes.map(x => JSON.parse(x.text))).toEqual([{ text: 'change of plan' }])
  // the pull that was pending when the checks ran was read on, nothing lost; the
  // accepted steer is announced before Codex's answer
  expect(handback(result).startsWith(`${steerNote('accepted', 'change of plan')}\n\ndone, steered`)).toBe(true)
  expect(lastLine(handback(result))).toContain('app-server · 1 steer · 0 actions')
  expect(w.spawned.length).toBe(1)
})

test('app-server, nativeActions off: the accepted steer\'s note streams as text; the handback keeps Codex\'s answer', { timeoutMs: 15000, options: { transport: 'app-server', nativeActions: false } }, async ($, on) => {
  let conv: any[] = [user('long task')]
  let w: ReturnType<typeof appWorld>
  const steered = () => w.writes.some(x => x.path.endsWith('/steer-000002.json'))
  w = appWorld(on, { messages: () => conv, pieces: [THREAD('t-69'), TURN('tu-1'), cmdDone('/bin/zsh -lc make'), steered, ACK(2, 'accepted'), MESSAGE('done'), USAGE] })
  const pending = step($, 'agent-app-plain-steer', 0)
  await new Promise<void>(r => setTimeout(r, 60))
  conv = [...conv, user('codex-model: gpt-6-astra\nchange of plan, use the other parser')]
  const { chunks, result } = await pending
  expect(chunks.filter(c => c.kind === 'text').map(c => c.text)).toEqual(['$ make', `\n\n${steerNote('accepted', 'change of plan, use the other parser')}`])
  expect(result.toolUses.map((u: any) => u.name)).toEqual(['SubagentHandback'])
  expect(handback(result).startsWith('done\n\n')).toBe(true)
  expect(lastLine(handback(result))).toContain('app-server · 1 steer · 1 action')
})

test('app-server kill: a stopped agent\'s run is asked to stop (interrupt file) and read to its end', { timeoutMs: 15000, options: { transport: 'app-server' } }, async ($, on) => {
  let w: ReturnType<typeof appWorld>
  const interrupted = () => w.writes.some(x => x.path.endsWith('/interrupt'))
  w = appWorld(on, { pieces: [THREAD('t-66'), TURN('tu-1'), cmdDone('/bin/zsh -lc date'), interrupted, out('{"type":"turn.failed","error":{"message":"interrupted"}}')], code: 1 })
  await step($, 'agent-app-kill', 0)
  w.status.set('agent-app-kill', 'killed')
  const s2 = await step($, 'agent-app-kill', 1)
  expect(s2.result.stopReason).toBe('end_turn')
  expect(w.writes.map(x => x.path)).toEqual([`${w.spawned[0]!.argv.at(-1)}/interrupt`])
  expect(w.timers).toContain(1500)
  // it ended on its own within the grace: nothing had to be killed
  expect(w.kills.count).toBe(0)
})

test('app-server kill: a run that does not end within 1.5 s of the interrupt is killed', { timeoutMs: 15000, options: { transport: 'app-server' } }, async ($, on) => {
  const w = appWorld(on, { pieces: [THREAD('t-67'), TURN('tu-1'), cmdDone('/bin/zsh -lc date'), 'block', MESSAGE('never')] })
  on('turn.complete', () => ({ text: '' }))
  await step($, 'agent-app-kill-hard', 0)
  await $.turn.complete({ answer: '', durationMs: 1, isAborted: true, turnId: 'turn-1', agentId: 'agent-app-kill-hard', reason: 'aborted' } as any)
  await new Promise<void>(r => setTimeout(() => r(), 300))
  expect(w.writes.some(x => x.path.endsWith('/interrupt'))).toBe(true)
  expect(w.kills.count).toBe(1)
})

test('app-server: a runner fatal line is the failure reason', { options: { transport: 'app-server' } }, async ($, on) => {
  appWorld(on, { pieces: [out('{"type":"codexmod.fatal","message":"app-server protocol changed (codex-cli 0.170.0)"}'), { stream: 'stderr', text: 'Method not found\n' }], code: 1 })
  const { result } = await step($, 'agent-app-fatal')
  expect(firstLine(handback(result))).toBe('codex failed: app-server protocol changed (codex-cli 0.170.0)')
  expect(handback(result)).toContain('Method not found')
})

test('app-server: runner drift evidence with no agent message fails as "protocol changed"', { options: { transport: 'app-server' } }, async ($, on) => {
  appWorld(on, { pieces: [THREAD('t-68'), TURN('tu-1'), out('{"type":"codexmod.protocol","unknown_methods":["item/newThing"],"unknown_items":["hologram"]}')] })
  const { result } = await step($, 'agent-app-drift')
  expect(firstLine(handback(result))).toBe('codex failed: codex app-server protocol changed (codex-cli unknown): 2 unknown events (method item/newThing, item hologram)')
})

test('session start prunes app-server control dirs older than pruneDays', async ($, on) => {
  const removed: string[] = []
  world(on)
  on('agent.register', (_$, e: any) => ({ value: { agent: `codex-mod:${e.name}` } }))
  on('process.run', (_$, e: any) => {
    if (e.argv[0] === 'rm') removed.push(e.argv[2])
    return runOk(e.argv[0] === 'which' ? '/bin/codex' : 'ok')
  })
  const runs = '/home/t/.cache/codex-mod/runs'
  on('fs.exists', (_$, e: any) => ({ value: e.path === runs }))
  on('fs.list', () => ({ value: [
    { name: 'old', kind: 'dir' as const, size: 0, mtimeMs: 0, isLink: false },
    { name: 'new', kind: 'dir' as const, size: 0, mtimeMs: 0, isLink: false },
    { name: 'stray.txt', kind: 'file' as const, size: 1, mtimeMs: 0, isLink: false },
  ] }))
  on('fs.stat', (_$, e: any) => ({ value: { kind: 'dir' as const, size: 0, isLink: false, mtimeMs: e.path.endsWith('/old') ? 1_000_000 - 3 * 86_400_000 : 1_000_000 - 1000 } }))
  await startSession($)
  expect(removed).toEqual([`${runs}/old`])
})
