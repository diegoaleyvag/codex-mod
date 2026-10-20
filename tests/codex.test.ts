import { test as hostTest, expect } from 'claude-code/testing'
import type { BuiltinToolResults, On } from 'claude-code'
import { explorationAction, literalWords } from '../hooks/exploration.ts'
import { batch2Cases } from './fixtures/batch2-cases.ts'
import { batch3Cases } from './fixtures/batch3-cases.ts'
import { patchActions, parsePatch } from '../hooks/patches.ts'
import batch4Items from './fixtures/batch4-items.mjs'
import { webAction, toolFallback, publicToolText } from '../hooks/web-tools.ts'
import { absolute } from '../hooks/codex.ts'
import { childRows, planRows, emptyDisplayState, planText, displayChildId } from '../hooks/plans-children.ts'
import batch5Items, { CHILD as B5_CHILD, THREAD as B5_THREAD } from './fixtures/batch5-items.mjs'
import batch6Items, { PNG, questionParams, ANSWER } from './fixtures/batch6-items.mjs'
import batch6Images from './fixtures/batch6-images.mjs'
import { imageFile, captureImage, generationAction, findingsAction, literalReceipt, IMAGE_MAX } from '../hooks/images-modes.ts'
import batch7Models from './fixtures/batch7-models.mjs'
import { resolvePolicy, canonicalOverrides, configHash, policyTask, capacityFallback } from '../hooks/run-policy.ts'
import { RECORD_BUDGET, compactStoreState, writeStoreState } from '../hooks/store-state.ts'
import { executionRequest, ownerExecution, resolveExecution, executionOverrides, permissionEvidence } from '../hooks/execution-policy.ts'
import { fingerprint } from '../hooks/fingerprint.ts'
import { ROW_SLOTS } from '../hooks/row-cache.ts'
import { choiceQuestions, choiceResponse, answeredQuestion } from '../hooks/questions.mjs'
import { PARENT as N_PARENT, CHILD as N_CHILD, PARENT_TURN as N_PT, CHILD_TURN as N_CT, nestedCommand, nestedFile, nestedActivity } from './fixtures/nested-items.mjs'
import { compact, footer, mcpServerNames, unwrapShell, describeCommand, parseConfig, parseModelsCache, checkProfile, stripCoordinator, launchArgv, SHADOW_LINKS, cleanText, readConversation, itemsFromApi, parseCodexLine, runnerArgv, parseCodexVersion, codexTooOld, modelProvider, steerNote, coordinatorPayload, chooseHandback, parseProjectRoles, normalizeSource, SourceLedger, validAction, commandAction, resolveProfile, modelTitle, NATIVE_TOOLS, ID_PREFIX, HANDBACK_ID_PREFIX, register as codexRegister } from '../hooks/codex.ts'

// Cache-directory setup is infrastructure, independent of each test's process fixture.
const cacheDirectories = {
  name: 'cache-directories',
  tier: 'prepend' as const,
  register: ((on: On) => {
    on('process.run', ($, e, next) => {
      if (e.argv[0] === 'git' && e.argv[1] === '-C') return { value: { exitCode: 128, stdout: '', stderr: 'fatal: not a git repository', isStdoutTruncated: false, isStderrTruncated: false } }
      if (e.argv[0] === '/bin/sh' && e.argv[3] === 'codex-mod-path') return { value: { exitCode: 0, stdout: e.argv[4], stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
      if (e.argv[0] === 'mkdir' && String(e.argv.at(-1)).includes('/codex-mod/runs/state-')) return { value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
      return next(e)
    })
    // Keep the optional journal-index probe separate from each world's own
    // filesystem fixture: the host permits one handler per event per module.
    on('fs.exists', async ($, e: any, next) => {
      if (!e.path.endsWith('.index.json')) return next(e)
      try {
        await $.fs.read(e.path)
        return { value: true }
      } catch {
        return { value: false }
      }
    })
  }) as any,
}
const test: typeof hostTest = ((name: string, options: any, fn?: any) => {
  if (typeof options === 'function') return hostTest(name, { plugins: [cacheDirectories] }, options)
  return hostTest(name, { ...options, plugins: [cacheDirectories, ...(options.plugins ?? [])] }, fn)
}) as typeof hostTest

// The test environment has timers; the hooks' type environment declares none.
declare const setTimeout: (fn: () => void, ms: number) => unknown

const MODELS_CACHE = JSON.stringify(batch7Models)

// A project file supplied through the session-relative fs.read mock, never the real repo.
const PROJECT_ROLES = JSON.stringify({ roles: {
  implementer: { model: 'gpt-6.1-sol', effort: 'medium', description: 'Bounded implementation.', instructions: 'Keep the change bounded.' },
  'implementer-high': { model: 'gpt-6.1-sol', effort: 'xhigh', sandbox: 'workspace-write', description: 'High-risk implementation.' },
  auditor: { model: 'gpt-6-astra', effort: 'xhigh', sandbox: 'read-only', description: 'Read-only review.', instructions: 'Never edit files.' },
} })

const CODEX_JSONL = [
  '{"type":"thread.started","thread_id":"t-1"}',
  '{"type":"turn.started"}',
  '{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"PONG"}}',
  '{"type":"turn.completed","usage":{"input_tokens":1,"output_tokens":1}}',
  '',
].join('\n')

type Status = 'running' | 'completed' | 'killed'
const AGENT_TYPES: Record<string, string> = {
  'agent-project': 'codex-mod:implementer',
  'agent-project-high': 'codex-mod:implementer-high',
  'agent-project-auditor': 'codex-mod:auditor',
  'agent-codex': 'codex-mod:codex',
  'agent-normal': 'codex-mod:codex',
  'agent-resume': 'codex-mod:codex',
  'agent-deny': 'codex-mod:codex',
  'agent-gp': 'general-purpose',
  'agent-keep': 'codex-mod:codex',
  'agent-new-effort': 'codex-mod:codex',
  'agent-persist': 'codex-mod:codex',
  'agent-restarted': 'codex-mod:codex',
  'agent-moved': 'codex-mod:codex',
  'agent-compact': 'codex-mod:codex',
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
  'agent-restart-guard': 'codex-mod:codex',
  'agent-gp2': 'general-purpose',
  'agent-wrapped': 'codex-mod:codex',
  'agent-wrapped-mid': 'codex-mod:codex',
  'agent-text-follow': 'codex-mod:codex',
  'agent-timeout': 'codex-mod:codex',
  'agent-plain': 'codex-mod:codex',
  'agent-plain-tool': 'codex-mod:codex',
  'agent-footer-short': 'codex-mod:codex',
  'agent-footer-off': 'codex-mod:codex',
  'agent-extra': 'codex-mod:codex',
  'agent-shadow': 'codex-mod:codex',
  'agent-cat-model': 'codex-mod:codex',
  'agent-cat-effort': 'codex-mod:codex',
  'agent-cat-ultra': 'codex-mod:codex',
  'agent-live': 'codex-mod:codex',
  'agent-live-rows': 'codex-mod:codex',
  'agent-fallback': 'codex-mod:codex',
  'agent-window': 'codex-mod:codex',
  'agent-guard-restart': 'codex-mod:codex',
  'agent-drift': 'codex-mod:codex',
  'agent-drift-ok': 'codex-mod:codex',
  'agent-drift-version': 'codex-mod:codex',
  'agent-exec-notimer': 'codex-mod:codex',
  'agent-provider': 'codex-mod:codex',
  'agent-app-fallback': 'codex-mod:codex',
  'agent-app-lazy': 'codex-mod:codex',
  'agent-app-steer': 'codex-mod:codex',
  'agent-app-reject': 'codex-mod:codex',
  'agent-app-unacked': 'codex-mod:codex',
  'agent-app-kill': 'codex-mod:codex',
  'agent-app-kill-hard': 'codex-mod:codex',
  'agent-app-fatal': 'codex-mod:codex',
  'agent-app-drift': 'codex-mod:codex',
  'agent-exec-note': 'codex-mod:codex',
  'agent-app-plain-steer': 'codex-mod:codex',
  'agent-app-deliver': 'codex-mod:codex',
  'agent-exec-deliver': 'codex-mod:codex',
  'agent-api-deliver': 'codex-mod:codex',
  'agent-peer-ignored': 'codex-mod:codex',
  'agent-coordinator': 'codex-mod:codex',
  'agent-coordinator-reload': 'codex-mod:codex',
  'agent-coordinator-stream': 'codex-mod:codex',
}

type Spawned = { argv: readonly string[]; input?: string; cwd?: string; env?: Record<string, string> }
type Piece = { stream: 'stdout' | 'stderr'; text: string }
type WorldOpts = {
  /** `$.agent.list` rejects. */
  sendDelivery?: ($: any, e: any) => Promise<any>
  listThrows?: boolean
  agentList?: () => any[]
  registeredAgents?: any[]
  /** Full registered tool names are chosen by the host. */
  toolNamespace?: string
  toolRegisterThrows?: string
  /** Tools the session exposes to its model, before agent tool filtering. */
  availableTools?: string[]
  toolListThrows?: boolean
  stdout?: string
  runs?: { stdout: string; code?: number }[]
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
  storeKeysThrows?: boolean
  storeSnapshots?: boolean
  storeReject?: (key: string, value: unknown) => boolean
  /** What `$.fs.read` finds, by the requested path (mutable between steps). */
  files?: Map<string, string>
  binary?: Map<string, string>
  writeFile?: (path: string, text: string) => void
  readFile?: (path: string, text: string | undefined) => string | undefined
  /** False: the agent's conversation lacks the host's SubagentHandback reminder. */
  handback?: boolean
  /** `$.session.messages({ as: "api" })` is denied (rows only). */
  noApi?: boolean
  sessionId?: string | (() => string)
  clockNow?: (now: number) => number | Promise<number>
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
  const source = { ended: 0 }
  const status = new Map<string, Status>()
  const store = opts.store ?? new Map<string, unknown>()
  const files = opts.files ?? new Map<string, string>()
  const reads: string[] = []
  const location = { cwd: '/tmp/project' }
  const clock = { now: 1_000_000 }
  // every call that reached the engine's own tool path (permission + run)
  const core: { tool: string; id?: string; agentId?: string }[] = []
  const checks: { tool: string; agentId?: string }[] = []
  // every `$.fs.write`, in order (steer and interrupt files of app-server runs)
  const writes: { path: string; text: string }[] = []
  const stateWrites: { path: string; text: string }[] = []
  const toolSpecs: any[] = []
  const toolLists: string[][] = []
  on('tool.list', () => {
    const names = opts.availableTools ?? ['Bash', 'Edit', 'Write', 'WebSearch', 'Agent', 'TodoWrite']
    toolLists.push([...names])
    if (opts.toolListThrows) throw new Error('tool list unavailable')
    return { value: names.map(name => ({ name, description: name, mcp: false })) }
  })
  on('tool.register', (_$, e: any) => {
    toolSpecs.push(e)
    if (opts.toolRegisterThrows === e.name) throw new Error('registration unavailable')
    return { value: { tool: `mcp__${opts.toolNamespace ?? 'codex-mod'}__${e.name}` } }
  })
  on('fs.write', (_$, e: any) => {
    opts.writeFile?.(e.path, e.text)
    if (/\/runs\/state-[^/]+\/(?:record\.json(?:\.\d+)?|row-\d+\.json)$/.test(e.path)) {
      stateWrites.push({ path: e.path, text: e.text })
      files.set(e.path, e.text)
    } else writes.push({ path: e.path, text: e.text })
    return { value: undefined }
  })
  on('ui.log', (_$, e: any) => {
    logs.push(String(e.text ?? ''))
    return { value: undefined }
  })
  on('session.receive', (_$, e) => ({ text: e.text }))
  on('session.start', () => ({ cwd: '/tmp/project' }))
  on('agent.list', () => {
    if (opts.listThrows) throw new Error('agent list unavailable')
    if (opts.agentList) return { value: opts.agentList() }
    return { value: Object.entries(AGENT_TYPES).map(([id, type]) => ({ id, type, description: id, status: status.get(id) ?? ('running' as const) })) }
  })
  on('session.cwd', () => ({ value: location.cwd }))
  on('session.id', () => ({ value: typeof opts.sessionId === 'function' ? opts.sessionId() : opts.sessionId ?? 'sess-1' }))
  on('clock.now', async () => ({ value: opts.clockNow ? await opts.clockNow(clock.now) : clock.now }))
  on('clock.sleep', (_$, e: any) => {
    sleeps.push(e.ms)
    clock.now += e.ms
    return { value: undefined }
  })
  on('env.get', (_$, e: any) => ({ value: e.name === 'HOME' ? '/home/t' : undefined }))
  on('fs.read', (_$, e: any) => {
    // The host resolves relative reads before dispatching this mock hook.
    const path = e.path.endsWith('/.claude/codex-mod.json') ? '.claude/codex-mod.json' : e.path
    reads.push(path)
    if (e.as === 'bytes' && opts.binary?.has(path)) return { value: { base64: opts.binary.get(path)! } }
    const text = opts.readFile ? opts.readFile(path, files.get(path)) : files.get(path)
    if (text === undefined) throw new Error(`ENOENT ${e.path}`)
    return { value: text }
  })
  on('store.get', (_$, e) => {
    const value = store.get(e.key)
    return { value: opts.storeSnapshots && value !== undefined ? JSON.parse(JSON.stringify(value)) : value }
  })
  on('store.set', (_$, e) => {
    if (opts.storeReject?.(e.key, e.value)) throw new Error('store limit exceeded')
    store.set(e.key, JSON.parse(JSON.stringify(e.value)))
    return { value: undefined }
  })
  on('store.delete', (_$, e) => {
    store.delete(e.key)
    return { value: undefined }
  })
  on('store.keys', () => {
    if (opts.storeKeysThrows) throw new Error('store recovery unavailable')
    return { value: [...store.keys()] }
  })
  on('tool.call', async ($, e: any) => {
    if (e.tool === 'SendMessage' && opts.sendDelivery) return opts.sendDelivery($, e)
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
    const fixture = opts.runs?.[spawned.length - 1]
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
        const out = fixture?.stdout ?? opts.stdout ?? CODEX_JSONL
        // split mid-line to prove the hook reassembles lines
        const cut = Math.floor(out.length / 2)
        if (out.slice(0, cut)) yield { stream: 'stdout' as const, text: out.slice(0, cut) }
        if (out.slice(cut)) yield { stream: 'stdout' as const, text: out.slice(cut) }
        if (opts.stderr) yield { stream: 'stderr' as const, text: opts.stderr }
      }
      return { value: { code: fixture?.code ?? opts.code ?? 0, signal: null } }
    } finally {
      source.ended++
      if (next.signal.aborted) kills.count++
    }
  })
  on('turn.step', async function* (_$, e) {
    modelCalls.push(e.agentId ?? 'main')
    yield { kind: 'text' as const, index: 0, text: 'from the model' }
    return { turnId: e.turnId, index: e.index, answer: 'from the model', toolUses: [], stopReason: 'end_turn' as const, usage: null }
  })
  return { spawned, modelCalls, logs, sleeps, kills, source, status, store, clock, files, core, checks, writes, stateWrites, reads, location, toolSpecs, toolLists }
}

// Source evidence and display payloads now recover from private cache files.
function savedState(w: ReturnType<typeof world>, key: string): any {
  const metadata: any = w.store.get(key)
  if (!metadata?.cachedState) return metadata
  const path = `/home/t/.cache/codex-mod/runs/state-${encodeURIComponent(key)}/record.json`
  const saved = JSON.parse(w.files.get(path)!)
  return saved.chunked === 1 ? JSON.parse(Array.from({ length: saved.chunks }, (_, i) => JSON.parse(w.files.get(`${path}.${i}`)!)).join('')) : saved
}

test('store load migrates a 900 KB wire and unknown oversized fields without losing resume identity', async ($, on) => {
  const key = 'agent:sess-1:agent-coordinator-reload'
  const record = { ...quietCoordinatorRecord('pending literal body'), thread: 'resume-thread',
    wire: { records: [{ event: 'public', data: 'x'.repeat(900_000) }], rows: {} }, legacyPayload: 'y'.repeat(900_000) }
  const w = world(on, { store: new Map([[key, record]]) })
  // Exercise loadRecord without relying on session.start pruning.
  await $.session.append(deliveryRow('agent-coordinator-reload', 'saved-row', 'pending literal body'))
  const compact: any = w.store.get(key)
  expect(compact.wire).toBe(undefined)
  expect(compact.legacyPayload).toBe(undefined)
  expect(compact.thread).toBe('resume-thread')
  expect(JSON.stringify(compact).length <= RECORD_BUDGET).toBe(true)
  expect(savedState(w, key).wire.records[0].data.length).toBe(900_000)
})

test('store prune recovers when an already oversized store rejects shrinking replacements', async ($, on) => {
  const store = new Map<string, unknown>(['a', 'b', 'c'].map(id => [`agent:sess-1:${id}`, {
    ...quietCoordinatorRecord('body'), wire: { records: ['x'.repeat(900_000)], rows: {} },
  }]))
  const w = world(on, { store, storeReject: (key, value) => JSON.stringify(Object.fromEntries(new Map([...store, [key, value]]))).length > 1_000_000 })
  await startSession($)
  expect(store.size).toBe(3)
  for (const value of store.values()) {
    expect((value as any).wire).toBe(undefined)
    expect(JSON.stringify(value).length <= RECORD_BUDGET).toBe(true)
  }
  expect(w.stateWrites.filter(w => w.path.endsWith('/record.json')).length).toBe(3)
})

test('store rejection cannot fail an action step, its guard, or the handback', async ($, on) => {
  const w = world(on, { storeReject: () => true, pieces: [THREAD('resilient'), cmdDone('printf ok'), MESSAGE('Completed despite full store')] })
  const first = await step($, 'agent-progress')
  expect(callsOf(first.chunks).map(c => c.name)).toEqual(['Bash'])
  const results: any[] = await runCalls($, first.chunks, 'agent-progress')
  expect(results[0].result).toBeDefined()
  const last = await step($, 'agent-progress', 1)
  expect(handback(last.result)).toContain('Completed despite full store')
  expect(w.logs.some(l => l.includes('store write failed'))).toBe(true)
  expect(w.core).toEqual([])
})

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
// Display answers use the confirmed content-block array contract, never an MCP envelope.
const validDisplayResult = (result: unknown): boolean =>
  (Array.isArray(result) && result.every(block =>
    block !== null && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string'))
const assertDisplayAnswer = (tool: string, answer: any) => {
  if (/^mcp__.*__(codex_(tool|plan)|coordinator_message)$/.test(tool) && !('deny' in answer)) {
    expect(validDisplayResult(answer.result)).toBe(true)
  }
}
/** What the engine does next with a step's calls: raises tool.call for each, in the agent's loop. */
const runCalls = ($: any, chunks: any[], agentId: string) =>
  Promise.all(callsOf(chunks).map(async c => {
    const answer = await $.tool.call({ tool: c.name, ...c.input, tool_use_id: c.id, agentId } as any)
    assertDisplayAnswer(c.name, answer)
    return answer
  }))
const handback = (result: any): string => result.toolUses.find((u: any) => u.name === 'SubagentHandback')!.input.message
const firstLine = (a: string) => a.split('\n')[0]!
const lastLine = (a: string) => a.split('\n').at(-1)!

const out = (line: string): Piece => ({ stream: 'stdout', text: `${line}\n` })
const cmdDone = (command: string, output = '', exit: number | null = 0) =>
  out(JSON.stringify({ type: 'item.completed', item: { type: 'command_execution', command, aggregated_output: output, exit_code: exit, status: exit === 0 ? 'completed' : 'failed' } }))
const cmdStart = (command: string) => out(JSON.stringify({ type: 'item.started', item: { type: 'command_execution', command, aggregated_output: '', exit_code: null } }))
const fileEv = (type: 'item.started' | 'item.completed', path: string, kind: string, diff?: string, id?: string) =>
  out(JSON.stringify({ type, item: { type: 'file_change', id, status: type === 'item.completed' ? 'completed' : 'in_progress', changes: [{ path, kind, diff }] } }))
const THREAD = (id: string) => out(JSON.stringify({ type: 'thread.started', thread_id: id }))
const MESSAGE = (text: string) => out(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text } }))
const USAGE = out('{"type":"turn.completed","usage":{"input_tokens":21269,"cached_input_tokens":20992,"output_tokens":46}}')

const nestedReady = { type: 'codexmod.child', thread_id: N_CHILD, parent_thread_id: N_PARENT,
  source_turn_id: N_PT, source_item_id: 'spawn-1', root_turn_id: N_PT, turn_id: N_CT,
  path: '/root/check', model: 'gpt-6.1-sol', effort: 'medium', status: 'attached', generation: 'fake-generation' }
const nestedSource = (item: any, parent = false) => ({ type: 'item.completed', item: item.type === 'agentMessage' ? { type: 'agent_message', text: item.text } : item.type === 'commandExecution'
  ? { type: 'command_execution', command: item.command, aggregated_output: item.aggregatedOutput, exit_code: item.exitCode } : item.type === 'fileChange' ? { type: 'file_change', changes: item.changes } : { type: 'source_only' },
  thread_id: parent ? N_PARENT : N_CHILD, turn_id: parent ? N_PT : N_CT,
  source: { transport: 'app-server', event: 'item/completed', threadId: parent ? N_PARENT : N_CHILD, turnId: parent ? N_PT : N_CT, item } })
const nestedJournal = [
  { type: 'codexmod.turn', thread_id: N_CHILD, turn_id: N_CT }, nestedSource(nestedCommand), nestedSource(nestedCommand), nestedSource(nestedFile),
  nestedSource({ type: 'agentMessage', id: 'child-final', text: 'child checked the fixture' }),
  { type: 'turn.completed', thread_id: N_CHILD, turn_id: N_CT, usage: { input_tokens: 2000, cached_input_tokens: 1500, output_tokens: 100 } },
].map(e => JSON.stringify(e) + '\n').join('')
const nestedRootPieces = [THREAD(N_PARENT), out(JSON.stringify({ type: 'codexmod.turn', turn_id: N_PT })),
  out(JSON.stringify(nestedSource(nestedActivity, true))), out(JSON.stringify(nestedReady)), MESSAGE('parent done')]
// Literal captured host denial, independent of the implementation constant.
const HOST_MIRROR_NO_VERDICT = 'The server-side auto mode classifier gave no verdict for Agent: the request that produced this action did not ask for one. Issue the action again once, as-is; if it is denied again, continue with other tasks that don\'t require it and tell the user that auto mode could not evaluate it. Note: reading files, searching code, and other read-only operations do not require the classifier and can still be used.'
const HOST_MIRROR_NO_VERDICT_CURLY = 'The server-side auto mode classifier gave no verdict for Agent: the request that produced this action did not ask for one. Issue the action again once, as-is; if it is denied again, continue with other tasks that don’t require it and tell the user that auto mode could not evaluate it. Note: reading files, searching code, and other read-only operations do not require the classifier and can still be used.'
let nestedHarnessCount = 0

/** The kit's plugin worker and imported helpers have separate live maps.
 * Keep the entire source step and native guard chain in this one module. */
async function nestedLaunchHarness(on: On, opts: WorldOpts) {
  const w = world(on, opts)
  const hooks = b7Hooks({ transport: 'app-server', richRows: true, progressIntervalMs: 0, timeoutMs: 0 })
  const unique = `nested-harness-${++nestedHarnessCount}`
  const parent = `agent-${unique}`
  const session = `${unique}:sess-1`
  const agents = () => opts.agentList!().map(a => ({ ...a, id: a.id === 'agent-progress' ? parent : a.id,
    ...(a.parentId === 'agent-progress' ? { parentId: parent } : {}) }))
  const engine: any = b7Engine(w, agents)
  engine.session.id = async () => `${unique}:${typeof opts.sessionId === 'function' ? opts.sessionId() : 'sess-1'}`
  engine.session.messages = async ({ as }: any) => as === 'api' ? [apiOf(user('root task')), apiOf(HANDBACK_ROW)] : [user('root task')]
  engine.tool = {
    list: async () => ['Bash', 'Edit', 'Write', 'Agent', 'TodoWrite'].map(name => ({ name })),
    register: async (spec: any) => { w.toolSpecs.push(spec); return { tool: `mcp__codex-mod__${spec.name}` } },
  }
  engine.agent.register = async ({ name }: any) => ({ agent: `codex-mod:${name}` })
  engine.fs.exists = async (path: string) => path.endsWith('/scripts/codex-runner.mjs')
  engine.fs.list = async () => []
  engine.clock.sleep = async (ms: number) => { w.clock.now += ms }
  engine.process.run = async (argv: string[]) => {
    if (argv[0] === '/bin/sh' && argv[3] === 'codex-mod-path') {
      if (argv[4] !== '/tmp/project') throw new Error('unexpected harness canonical cwd')
      return runOk('/tmp/project').value
    }
    if (argv[0] === 'git' && argv[1] === '-C') {
      if (argv[2] !== '/tmp/project') throw new Error('unexpected harness Git cwd')
      const probe = argv.slice(3).join(' ')
      if (probe === 'rev-parse --path-format=absolute --git-common-dir') return runOk('/tmp/project/.git').value
      if (probe === 'rev-parse --show-toplevel') return runOk('/tmp/project').value
      if (probe === 'worktree list --porcelain') return runOk('worktree /tmp/project\n').value
      throw new Error('unexpected harness Git authority probe')
    }
    return runOk(argv[0] === 'which' ? `/bin/${argv[1]}`
      : argv[1]?.endsWith('/scripts/codex-runner.mjs') && argv[2] === '--version' ? '1'
      : argv.includes('--version') ? 'codex-cli 0.163.0' : 'ok').value
  }
  engine.process.spawn = async function* (input: Spawned) {
    w.spawned.push(input)
    for (const piece of opts.pieces ?? []) {
      if (typeof piece === 'string' || typeof piece === 'function') throw new Error('unexpected harness wait')
      yield piece
    }
    return { code: 0, signal: null }
  }
  const set = engine.store.set
  engine.store.set = async (key: string, value: any) => {
    if (opts.storeReject?.(key, value)) throw new Error('store limit exceeded')
    return set(key, value)
  }
  await hooks.get('session.start')!.handler(engine, {}, b7Next(async () => ({})))
  return { w, hooks, engine, parent, session,
    step: async (index: number) => {
      const chunks: any[] = []
      const e = { turnId: 'turn-1', index, agentId: parent, model: 'claude-haiku-4-5', messageCount: 1 }
      const stream = hooks.get('turn.step')!.handler(engine, e, b7Next(async function* () { w.modelCalls.push(parent); throw new Error('model must not run') }))
      for (;;) { const r = await stream.next(); if (r.done) return { chunks, result: r.value }; chunks.push(r.value) }
    },
    calls: async (chunks: any[]) => {
      for (const c of callsOf(chunks).filter(c => c.name !== 'SubagentHandback')) {
        const result = await hooks.get('tool.call')!.handler(engine, { tool: c.name, ...c.input, tool_use_id: c.id, agentId: parent },
          b7Next(async () => { w.core.push({ tool: c.name }); throw new Error('native executor must not run') }))
        expect(result.deny).toBe(undefined)
      }
    },
  }
}

test('nested mirrors: hidden type; early core-event identity reconciles with list; child rows execute zero native tools', { options: { transport: 'app-server', progressIntervalMs: 0 } }, async ($, on) => {
  let prompt = 'root task'
  const host = 'host-child-1'
  const actual: any[] = []
  const registered: any[] = []
  const w = appWorld(on, { pieces: nestedRootPieces, messages: () => [{ role: 'user', text: prompt, toolUses: [] }],
    readFile: (path, text) => path.endsWith(`/events-${N_CHILD}.jsonl`) ? nestedJournal : path.endsWith('/owner.json') ? JSON.stringify({ generation: 'fake-generation', updatedAt: Date.now(), ended: true }) : text,
    registeredAgents: registered, agentList: () => [
    { id: 'agent-progress', type: 'codex-mod:codex', description: 'parent', status: 'running' as const },
    { id: host, type: 'codex-mod:codex-child', description: 'observer', parentId: 'agent-progress', status: 'running' as const, spawnedBy: 'codex-mod@codex-mod' },
  ] })
  let childFinal = ''
  on('turn.start', (_$, e: any) => ({ turnId: e.turnId }))
  on('ui.render', () => ({ type: 'Text', children: ['NESTED HOST CONTROLS'] }))
  on('agent.spawn', async (_$, e: any) => {
    actual.push(e)
    expect(e.description).toContain('Codex gpt-6.1-sol · medium · ')
    expect(e.description).toContain('Codex child of parent')
    // Re-enter before the API resolves, as core can do. This is an API-chain
    // test, not evidence that the testing kit created a native task record.
    prompt = e.prompt
    await $.turn.start({ text: e.prompt, turnId: 'mirror-host-turn', agentId: host })
    for (let i = 0; i < 8; i++) {
      const s = await step($, host, i, 'mirror-host-turn')
      if (s.result.toolUses.some(u => u.name === 'SubagentHandback')) { childFinal = handback(s.result); break }
      if (s.result.stopReason === 'end_turn') { childFinal = s.result.answer; break }
      await runCalls($, s.chunks, host)
    }
    prompt = 'root task'
    return { model: 'claude-haiku-4-5', agentId: host }
  })
  await startSession($)
  const hidden = registered.find(a => a.name === 'codex-child')
  expect(hidden.prompt).toContain('hook not active')
  expect(hidden.background).toBe(true)
  expect(registered.every(a => a.background === true)).toBe(true)
  expect(await $.agent.offer({ agent: 'codex-mod:codex-child', description: '', source: 'plugin', provider: { plugin: 'codex-mod', tier: 'project' } } as any)).toEqual({ isOffered: false })
  const parent = await step($, 'agent-progress')
  const link = callsOf(parent.chunks).find(c => c.name === 'Agent')!
  expect(link).toBeDefined()
  const answer: any = await $.tool.call({ tool: 'Agent', ...link.input, tool_use_id: link.id, agentId: 'agent-progress' } as any)
  expect(answer.result.agentId).toBe(host)
  const label = JSON.stringify(await b7Render($, link.id))
  expect(label).toContain('Codex gpt-6.1-sol · medium')
  expect(label).toContain('NESTED HOST CONTROLS')
  expect(answer.result.content[0].text).toContain('Observation link')
  expect(answer.result.content[0].text).toContain('child of parent (host agent-progress)')
  expect(childFinal).toContain('child checked the fixture')
  expect(childFinal).toContain('500 new tokens (1.5K cached, 100 out)')
  expect(actual.length).toBe(1)
  // The testing kit supplies API args rather than core-filled spawn events.
  // Actual parent/tool linkage requires the native harness below.
  expect(actual[0].subagentType ?? actual[0].subagent_type).toBe('codex-mod:codex-child')
  expect(w.spawned.length).toBe(1)
  expect(w.modelCalls).toEqual([])
  expect(w.core).toEqual([])
  expect(w.spawned[0].input).toContain('Do not spawn sub-agents.')
  expect(w.logs.some(l => l.includes('multiAgent=false: Codex child spawn observed'))).toBe(true)
  const identity: any = w.store.get(`mirror:sess-1:${N_CHILD}`)
  expect(identity.host).toBe(host)
  expect(identity.parentHost).toBe('agent-progress')
  expect(identity.parentThread).toBe(N_PARENT)
  expect(identity.displayToolId).toBe(link.id)
  expect(identity.launch).toBe('bound')
})

for (const refusal of ['deny', 'depth', 'attachment', 'uncertain']) test(`nested ${refusal}: Batch 5 fallback; no second execution or automatic host retry`, { options: { transport: 'app-server', richRows: true, progressIntervalMs: 0 } }, async ($, on) => {
  const ready = refusal === 'attachment' ? { ...nestedReady, status: 'unavailable', reason: 'rejoin unsupported' } : nestedReady
  const calls: any[] = []
  const w = appWorld(on, { pieces: [THREAD(N_PARENT), out(JSON.stringify(nestedSource(nestedActivity, true))), out(JSON.stringify(ready)), out(JSON.stringify(ready)), MESSAGE('parent done')], agentList: () => [
    { id: 'agent-progress', type: 'codex-mod:codex', status: 'running' as const, description: '', ...(refusal === 'depth' ? { parentId: 'host-up-2' } : {}) },
    { id: 'host-up-2', type: 'general-purpose', status: 'running' as const, description: '', parentId: 'host-up-1' },
    { id: 'host-up-1', type: 'general-purpose', status: 'running' as const, description: '' },
  ] })
  on('agent.spawn', (_$, e: any) => { calls.push(e); if (refusal === 'uncertain') throw new Error('lost host result'); return { deny: 'concurrency limit' } })
  const s = await step($, 'agent-progress')
  const text = s.chunks.filter(c => c.kind === 'text').map(c => c.text).join('\n') + (s.result.toolUses.some(u => u.name === 'SubagentHandback') ? handback(s.result) : s.result.answer)
  const notice = text.split('\n').find(line => line.includes('observer transcript unavailable'))!
  expect(notice).toContain(`Codex child ${N_CHILD.slice(-8)}`)
  expect(notice).toContain('Showing reported child activity')
  expect(notice).not.toContain(N_CHILD)
  expect(notice).not.toContain('Batch 5')
  expect(notice.length < 220).toBe(true)
  if (refusal === 'depth') {
    expect(notice).toContain('Observer nesting limit reached')
    expect(w.logs.some(line => line.includes('observer dispatch depth limit 3'))).toBe(true)
  }
  if (refusal === 'deny') {
    expect(notice).toContain('Observer launch declined')
    expect(w.logs.some(line => line.includes(N_CHILD) && line.includes('concurrency limit'))).toBe(true)
  }
  if (refusal === 'attachment') expect(notice).toContain('Observer attachment incomplete')
  expect(w.spawned.length).toBe(1)
  expect(calls.length).toBe(refusal === 'deny' || refusal === 'uncertain' ? 1 : 0)
  expect(w.modelCalls).toEqual([])
  expect(w.core).toEqual([])
})

for (const [apostrophe, denial] of [['ASCII', HOST_MIRROR_NO_VERDICT], ['curly', HOST_MIRROR_NO_VERDICT_CURLY]] as const) {
for (const outcome of ['success', 'second-denial'] as const) test(`nested exact ${apostrophe} auto-mode denial then ${outcome}: one unchanged retry with a fresh core ID`,
  { options: { transport: 'app-server', richRows: true, progressIntervalMs: 0 } }, async ($, on) => {
    const host = 'host-retried-child'
    const inputs: any[] = []
    let observers = 0
    const agents = () => [{ id: 'agent-progress', type: 'codex-mod:codex', description: 'parent', status: 'running' },
      { id: host, type: 'codex-mod:codex-child', parentId: 'agent-progress', spawnedBy: 'codex-mod', status: 'running' }]
    const harness = await nestedLaunchHarness(on, { agentList: agents, pieces: [...nestedRootPieces.slice(0, -1), out(JSON.stringify(nestedReady)), MESSAGE('parent done')] })
    const { w, hooks, engine, parent, session } = harness
    const pluginNext = (fn: any) => Object.assign(b7Next(fn), { origin: { plugin: 'codex-mod', tier: 'project' } })
    engine.agent.spawn = async (input: any) => {
      inputs.push({ ...input })
      const id = `toolu_plugin_retry_${inputs.length}`
      const { subagentType, ...rest } = input
      const call = { tool: 'Agent', ...rest, subagent_type: subagentType, run_in_background: true, tool_use_id: id, agentId: parent }
      if (inputs.length === 2) {
        const old = { ...call, tool_use_id: 'toolu_plugin_retry_1' }
        let reached = 0
        expect((await hooks.get('tool.call')!.handler(engine, old, pluginNext(async () => { reached++; return {} }))).deny).toContain('not executed')
        expect((await hooks.get('tool.check')!.handler(engine, old, pluginNext(async () => { reached++; return {} }))).decision).toBe('deny')
        expect((await hooks.get('agent.spawn')!.handler(engine, { ...input, tool_use_id: old.tool_use_id, background: true, fork: false }, pluginNext(async () => { reached++; return {} }))).deny).toContain('unowned')
        expect(reached).toBe(0)
        const checkpoint: any = w.store.get(`mirror:${session}:${N_CHILD}`)
        expect(checkpoint.launch).toBe('launching')
        expect(checkpoint.hostToolId).toBe(undefined)
      }
      return hooks.get('tool.call')!.handler(engine, call, pluginNext(async () => {
        const { tool, tool_use_id, agentId, ...checkInput } = call
        const check = await hooks.get('tool.check')!.handler(engine, { tool, tool_use_id, agentId, input: checkInput, ceiling: 'allow' }, pluginNext(async () => ({ decision: 'allow' })))
        expect(check.decision).toBe('allow')
        if (inputs.length === 1 || outcome === 'second-denial') return { deny: denial }
        return hooks.get('agent.spawn')!.handler(engine, { ...input, tool_use_id: id, background: true, fork: false,
          provider: { plugin: 'codex-mod', tier: 'project' } }, pluginNext(async () => { observers++; return { agentId: host } }))
      }))
    }
    let text = ''
    for (let i = 0; i < 5; i++) {
      const s = await harness.step(i)
      text += s.chunks.filter(c => c.kind === 'text').map(c => c.text).join('\n')
      await harness.calls(s.chunks)
      if (s.result.toolUses.some(u => u.name === 'SubagentHandback')) { text += handback(s.result); break }
    }
    expect(inputs.length).toBe(2)
    expect(inputs[1]).toEqual(inputs[0])
    expect(Object.keys(inputs[0]).sort()).toEqual(['cwd', 'description', 'name', 'prompt', 'subagentType'])
    expect(observers).toBe(outcome === 'success' ? 1 : 0)
    const mirror: any = w.store.get(`mirror:${session}:${N_CHILD}`)
    expect(mirror.launch).toBe(outcome === 'success' ? 'bound' : 'refused')
    if (outcome === 'success') {
      expect(mirror.host).toBe(host)
      expect(mirror.hostToolId).toBe('toolu_plugin_retry_2')
      expect(text).not.toContain('observer transcript unavailable')
    } else {
      const notice = text.split('\n').find(line => line.includes('observer transcript unavailable'))!
      expect(notice).toContain('Auto mode could not evaluate the observer after one retry')
      expect(notice).not.toContain(denial)
      expect(notice).not.toContain('server-side')
      expect(notice).not.toContain('Batch 5')
      expect(notice).not.toContain(N_CHILD)
      expect(mirror.reason).toBe(`auto mode could not evaluate observer launch after one unchanged retry: ${denial}`)
      expect(w.logs.some(line => line.includes(N_CHILD) && line.includes(mirror.reason))).toBe(true)
    }
    expect(w.spawned.length).toBe(1)
    expect(w.modelCalls).toEqual([])
    expect(w.core).toEqual([])
  })
}

for (const refusal of ['ordinary', 'nonexact', 'exception', 'no-id', 'ack-host', 'spawn-admitted', 'early-host', 'changed-session', 'checkpoint', 'session-during-checkpoint'] as const) {
  test(`nested retry excludes ${refusal}; repeated ready events never relaunch`,
    { options: { transport: 'app-server', richRows: true, progressIntervalMs: 0 } }, async ($, on) => {
      let sid = 'sess-1', failCheckpoint = false, changeSession = false
      const host = 'host-no-retry'
      const inputs: any[] = []
      const agents = () => [{ id: 'agent-progress', type: 'codex-mod:codex', description: 'parent', status: 'running' },
        { id: host, type: 'codex-mod:codex-child', parentId: 'agent-progress', spawnedBy: 'codex-mod', status: 'running' }]
      const harness = await nestedLaunchHarness(on, { sessionId: () => sid, agentList: agents,
        storeReject: key => {
          if (!key.startsWith('mirror:')) return false
          if (changeSession) sid = 'changed-session'
          return failCheckpoint
        }, pieces: [...nestedRootPieces.slice(0, -1), out(JSON.stringify(nestedReady)), MESSAGE('parent done')] })
      const { w, hooks, engine, parent, session } = harness
      const pluginNext = (fn: any) => Object.assign(b7Next(fn), { origin: { plugin: 'codex-mod', tier: 'project' } })
      engine.agent.spawn = async (input: any) => {
        inputs.push(input)
        if (refusal === 'exception') throw new Error('lost host result')
        const { subagentType, ...rest } = input
        const id = 'toolu_plugin_no_retry'
        const call = { tool: 'Agent', ...rest, subagent_type: subagentType, tool_use_id: id, agentId: parent }
        return hooks.get('tool.call')!.handler(engine, call, pluginNext(async () => {
          if (refusal === 'spawn-admitted') await hooks.get('agent.spawn')!.handler(engine,
            { ...input, tool_use_id: id, background: true, fork: false }, pluginNext(async () => ({ deny: HOST_MIRROR_NO_VERDICT })))
          if (refusal === 'early-host') await hooks.get('turn.start')!.handler(engine,
            { agentId: host, text: input.prompt }, pluginNext(async () => ({ turnId: 'early' })))
          if (refusal === 'changed-session') sid = 'changed-session'
          if (refusal === 'checkpoint') failCheckpoint = true
          if (refusal === 'session-during-checkpoint') changeSession = true
          return refusal === 'ordinary' ? { deny: 'concurrency limit' }
            : refusal === 'nonexact' ? { deny: `${HOST_MIRROR_NO_VERDICT}\n` }
            : refusal === 'no-id' ? {}
            : { deny: HOST_MIRROR_NO_VERDICT, ...(refusal === 'ack-host' ? { agentId: host } : {}) }
        }))
      }
      let text = ''
      for (let i = 0; i < 5; i++) {
        const s = await harness.step(i)
        text += s.chunks.filter(c => c.kind === 'text').map(c => c.text).join('\n')
        await harness.calls(s.chunks)
        if (s.result.toolUses.some(u => u.name === 'SubagentHandback')) { text += handback(s.result); break }
      }
      expect(inputs.length).toBe(1)
      const notice = text.split('\n').find(line => line.includes('observer transcript unavailable'))!
      expect(notice).not.toContain('after one retry')
      expect(notice).not.toContain(HOST_MIRROR_NO_VERDICT)
      expect(notice).not.toContain('Batch 5')
      if (refusal === 'checkpoint') {
        expect(notice).toContain('Observer launch unavailable; no retry')
        expect(w.logs.some(line => line.includes('mirror retry checkpoint unavailable; no retry'))).toBe(true)
      }
      if (refusal === 'exception') {
        expect(notice).toContain('Observer launch outcome unknown; no retry')
        expect(w.logs.some(line => line.includes(N_CHILD) && line.includes('host creation outcome unknown: lost host result'))).toBe(true)
      }
      expect(w.spawned.length).toBe(1)
      expect(w.modelCalls).toEqual([])
      expect(w.core).toEqual([])
    })
}

test('observer fallback notices distinguish short child identities while private diagnostics retain full reasons', { options: { transport: 'app-server' } }, async ($, on) => {
  const other = '33333333-3333-4333-8333-333333333333'
  const reason = 'rejoin unsupported by this broker'
  const w = appWorld(on, { pieces: [THREAD(N_PARENT), ...[N_CHILD, other].map(thread_id =>
    out(JSON.stringify({ ...nestedReady, thread_id, status: 'unavailable', reason }))), MESSAGE('parent done')] })
  let launches = 0
  on('agent.spawn', () => { launches++; return { deny: 'must not launch' } })
  const s = await step($, 'agent-progress')
  const text = s.chunks.filter(c => c.kind === 'text').map(c => c.text).join('\n') + (s.result.toolUses.some(u => u.name === 'SubagentHandback') ? handback(s.result) : s.result.answer)
  const notices = text.split('\n').filter(line => line.includes('observer transcript unavailable'))
  expect(notices.length).toBe(2)
  for (const [index, id] of [N_CHILD, other].entries()) {
    expect(notices[index]).toContain(`Codex child ${id.slice(-8)}`)
    expect(notices[index]).toContain('Observer attachment incomplete')
    expect(notices[index]).not.toContain(id)
    expect(notices[index]).not.toContain(reason)
    expect(w.logs.some(line => line.includes(id) && line.includes(reason))).toBe(true)
  }
  expect(launches).toBe(0)
  expect(w.spawned.length).toBe(1)
  expect(w.modelCalls).toEqual([])
  expect(w.core).toEqual([])
})

test('nested off: app-server launch disables rejoin and keeps the Batch 5 rows', { options: { transport: 'app-server', nestedAgents: false, richRows: true } }, async ($, on) => {
  const w = appWorld(on, { pieces: nestedRootPieces })
  let spawns = 0
  on('agent.spawn', () => { spawns++; return { deny: 'must not be called' } })
  await step($, 'agent-progress')
  expect(w.spawned[0].argv).toContain('--nested')
  expect(argOf(w.spawned[0].argv, '--nested')).toBe('false')
  expect(spawns).toBe(0)
  expect(parseConfig({}).nestedAgents).toBe(true)
  expect(parseConfig({ nestedAgents: 'true' }).warnings).toContain('nestedAgents: not a boolean; default used')
})

const savedMirror = (host = 'host-recovered-child', extra: any = {}) => ({ version: 1, session: 'sess-1', thread: N_CHILD,
  parentThread: N_PARENT, parentHost: 'agent-progress', host, hostToolId: 'real-host-tool-id', sourceTurn: N_PT, sourceItem: 'spawn-1', rootTurn: N_PT,
  control: '/tmp/private-nested-run', node: 'node', reader: '/plugin/scripts/codex-runner.mjs', generation: 'fake-generation', token: 'opaque-launch-token',
  inputDigest: 'saved', depth: 2, model: 'gpt-6.1-sol', effort: 'medium', sandbox: 'workspace-write', launch: 'bound', state: 'running', activeTurn: N_CT, updatedAt: 1000000, ...extra })
const mirrorStore = (m: any, extra: any = {}) => new Map<string, unknown>([
  [`mirror:sess-1:${N_CHILD}`, m],
  [`agent:sess-1:${m.host}`, { agentName: 'codex-child', model: m.model, effort: m.effort, sandbox: m.sandbox,
    thread: N_CHILD, lastTask: m.token, userCount: 1, updatedAt: m.updatedAt, mirror: m, ...extra }],
])

test('nested recovery: persisted mirror cursor resumes public events with no startRun or source replay', { options: { progressIntervalMs: 0 } }, async ($, on) => {
  const m = savedMirror()
  const consumed = nestedJournal.indexOf('\n') + 1
  const w = world(on, { task: m.token, store: mirrorStore(m, { playback: { cursor: consumed, prefix: nestedJournal.slice(0, consumed), texts: [], queue: [], actions: 0, turnId: N_CT } }),
    readFile: (path, text) => path.endsWith(`/events-${N_CHILD}.jsonl`) ? nestedJournal : path.endsWith('/owner.json') ? JSON.stringify({ generation: m.generation, ended: true }) : text })
  let final = ''
  for (let i = 0; i < 6; i++) {
    const s = await step($, m.host, i)
    if (s.result.toolUses.some(u => u.name === 'SubagentHandback')) { final = handback(s.result); break }
    await runCalls($, s.chunks, m.host)
  }
  expect(final).toContain('child checked the fixture')
  expect(w.spawned).toEqual([])
  expect(w.modelCalls).toEqual([])
  expect(w.core).toEqual([])
  const rec: any = w.store.get(`agent:sess-1:${m.host}`)
  expect(rec.playback.cursor).toBe(nestedJournal.length)
  expect(rec.mirror.host).toBe(m.host)
})

test('nested rotated journal reloads a later segment through the host fs limit without losing its child', async ($, on) => {
  const m = savedMirror()
  const files = new Map<string, string>()
  const padding = Array.from({ length: 5 }, () => JSON.stringify({ type: 'unknown-child-event', thread_id: N_CHILD, data: 'x'.repeat(900000) }) + '\n').join('')
  const text = padding + nestedJournal
  const chunk = 256 * 1024
  const segments = Math.ceil(text.length / chunk)
  for (let i = 0; i < segments; i++) files.set(`${m.control}/events-${N_CHILD}${i ? `-${i}` : ''}.jsonl`, text.slice(i * chunk, (i + 1) * chunk))
  files.set(`${m.control}/events-${N_CHILD}.index.json`, JSON.stringify({ segment: segments - 1 }))
  files.set(`${m.control}/owner.json`, JSON.stringify({ generation: m.generation, ended: true }))
  // Simulate a worker reload after the large earlier portion was consumed.
  const segment = Math.floor(padding.length / chunk)
  const cursor = padding.length % chunk
  const part = text.slice(segment * chunk, (segment + 1) * chunk)
  const w = world(on, { task: m.token, files, store: mirrorStore(m, { playback: { segment, cursor, prefix: part.slice(Math.max(0, cursor - 160), cursor), texts: [], queue: [], actions: 0 } }),
    readFile: (_path, value) => { if (value !== undefined && value.length > 4 * 1024 * 1024) throw new Error('host fs limit'); return value } })
  let final = ''
  for (let i = 0; i < 6; i++) {
    const s = await step($, m.host, i)
    if (s.result.toolUses.some(u => u.name === 'SubagentHandback')) { final = handback(s.result); break }
    await runCalls($, s.chunks, m.host)
  }
  expect(final).toContain('child checked the fixture')
  expect(w.spawned.length).toBe(0)
  expect(savedState(w, `agent:sess-1:${m.host}`).playback.segment).toBe(segments - 1)
})

for (const persistent of [false, true]) test(`nested journal read error ${persistent ? 'persistent' : 'transient'}: retry without inventing truncation`, async ($, on) => {
  const m = savedMirror()
  let failures = 0
  const w = world(on, { task: m.token, store: mirrorStore(m), readFile: (path, text) => {
    if (path.endsWith(`/events-${N_CHILD}.jsonl`)) {
      if (persistent || failures++ < 2) throw new Error('journal I/O unavailable')
      return nestedJournal
    }
    if (path.endsWith('/owner.json')) return JSON.stringify({ generation: m.generation, ended: true })
    return text
  } })
  let final = ''
  for (let i = 0; i < 6; i++) {
    const s = await step($, m.host, i)
    if (s.result.toolUses.some(u => u.name === 'SubagentHandback')) { final = handback(s.result); break }
    await runCalls($, s.chunks, m.host)
  }
  expect(w.spawned.length).toBe(0)
  expect(w.sleeps.slice(0, 2)).toEqual([50, 100])
  expect(final).not.toContain('truncated or replaced')
  expect(final).toContain(persistent ? 'child journal read failed after 3 attempts' : 'child checked the fixture')
})

for (const gap of ['owner-lost', 'truncated', 'invalid-depth', 'malformed', 'foreign-child']) test(`nested recovery ${gap}: fail closed with no execution, inference or relaunch`, async ($, on) => {
  const m = savedMirror('host-broken-child', gap === 'invalid-depth' ? { depth: 9 } : {})
  const store = mirrorStore(m, gap === 'truncated' ? { playback: { cursor: 99, prefix: 'old-file', texts: [], queue: [], actions: 0 } } : {})
  const w = world(on, { task: m.token, store, readFile: (path, text) => path.endsWith(`/events-${N_CHILD}.jsonl`) ? gap === 'malformed' ? 'bad json\n' : gap === 'foreign-child' ? JSON.stringify({ type: 'codexmod.child', parent_thread_id: N_PARENT }) + '\n' : '' : path.endsWith('/owner.json') ? '{}' : text })
  const s = await step($, m.host)
  const body = s.result.toolUses.some(u => u.name === 'SubagentHandback') ? handback(s.result) : s.result.answer
  expect(body).toContain('codex failed:')
  expect(w.spawned).toEqual([])
  expect(w.modelCalls).toEqual([])
  expect(w.core).toEqual([])
})

test('nested host stop writes one child interrupt and never returns/kills a parent process', { options: { progressIntervalMs: 0 } }, async ($, on) => {
  const m = savedMirror('host-stopped-child')
  const journal = nestedJournal.split('\n').slice(0, 2).join('\n') + '\n'
  const w = world(on, { task: m.token, store: mirrorStore(m), readFile: (path, text) => path.endsWith(`/events-${N_CHILD}.jsonl`) ? journal : text })
  on('turn.complete', () => ({ text: '' }))
  const s = await step($, m.host)
  await runCalls($, s.chunks, m.host)
  for (let i = 0; i < 2; i++) await $.turn.complete({ answer: '', durationMs: 1, isAborted: true, turnId: 'turn-1', agentId: m.host, reason: 'aborted' } as any)
  const interrupts = w.writes.filter(w => w.path.includes('/interrupt-'))
  expect(interrupts.length).toBe(1)
  expect(JSON.parse(interrupts[0].text)).toMatchObject({ threadId: N_CHILD, turnId: N_CT })
  expect(w.spawned).toEqual([])
  expect(w.kills.count).toBe(0)
  expect(w.writes.some(w => w.path.endsWith('/interrupt'))).toBe(false)
  expect(w.modelCalls).toEqual([])
  const stopped: any = w.store.get(`mirror:sess-1:${N_CHILD}`)
  expect(stopped.state).toBe('stopping')
  expect(stopped.stopSent).toBe(true)
})

test('nested SendMessage receipts steer the exact child once per UUID; identical bodies with distinct UUIDs remain distinct', async ($, on) => {
  const m = savedMirror('host-message-child')
  const w = world(on, { task: m.token, store: mirrorStore(m), readFile: (path, text) => path.endsWith(`/events-${N_CHILD}.jsonl`) ? nestedJournal : text })
  for (const uuid of ['delivery-one', 'delivery-one', 'delivery-two']) await $.session.append(deliveryRow(m.host, uuid, 'Same body'))
  const steers = w.writes.filter(w => w.path.includes('/steer-'))
  expect(steers.length).toBe(2)
  expect(steers.every(w => JSON.parse(w.text).threadId === N_CHILD)).toBe(true)
  expect(steers.every(w => JSON.parse(w.text).text.includes('Same body'))).toBe(true)
  expect(new Set(steers.map(w => w.path)).size).toBe(2)
  expect(w.spawned).toEqual([])
  expect(w.modelCalls).toEqual([])
  // Pending text is deliberately absent from compact store metadata.
  const checkpoint = `/home/t/.cache/codex-mod/runs/state-${encodeURIComponent(`agent:sess-1:${m.host}`)}/record.json`
  let rec: any = JSON.parse(w.files.get(checkpoint)!)
  expect(rec.coordinator.pending.length).toBe(2)
  expect(rec.coordinator.pending.every((p: any) => p.mirrorClaimed === true)).toBe(true)
  expect(rec.mirror.messages.map((message: any) => message.status)).toEqual(['submitted', 'submitted'])
  const s = await step($, m.host)
  const receipts = callsOf(s.chunks).filter(call => call.name.endsWith('__coordinator_message'))
  expect(receipts.map(call => call.input.sourceUuid)).toEqual(['delivery-one', 'delivery-two'])
  expect(receipts.every(call => String(call.input.text).includes('Same body'))).toBe(true)
  await runCalls($, s.chunks, m.host)
  expect(w.writes.filter(w => w.path.includes('/steer-')).length).toBe(2)
  rec = JSON.parse(w.files.get(checkpoint)!)
  expect(rec.coordinator.pending).toEqual([])
  expect(w.core).toEqual([])
})

test('batch 8 parent abort after restart cascades source descendants once without native nesting or a live parent run', async ($, on) => {
  const child = savedMirror()
  const grandchild = savedMirror('host-grandchild', { thread: '55555555-5555-4555-8555-555555555555', parentHost: child.host, parentThread: N_CHILD, depth: 3 })
  const unrelated = savedMirror('host-unrelated', { thread: '66666666-6666-4666-8666-666666666666', parentHost: 'unrelated-parent' })
  const store = mirrorStore(child)
  for (const m of [grandchild, unrelated]) store.set(`mirror:sess-1:${m.thread}`, m)
  const w = world(on, { store, storeSnapshots: true })
  on('turn.complete', () => ({ text: '' }))
  const ended: any = { answer: '', durationMs: 1, isAborted: true, turnId: 'aborted-parent', agentId: child.parentHost, reason: 'aborted' }
  await Promise.all([$.turn.complete(ended), $.turn.complete(ended)])
  const stops = w.writes.filter(w => w.path.includes('/interrupt-')).map(w => JSON.parse(w.text).threadId).sort()
  expect(stops).toEqual([child.thread, grandchild.thread].sort())
  expect(w.writes.some(w => w.path.endsWith('/interrupt'))).toBe(false)
  expect(w.spawned).toEqual([])
  expect(w.core).toEqual([])
})

test('batch 8 store recovery failure still stops a known mirror on parent abort', async ($, on) => {
  const m = savedMirror()
  const journal = nestedJournal.split('\n').slice(0, 2).join('\n') + '\n'
  const w = world(on, { task: m.token, store: mirrorStore(m), storeKeysThrows: true,
    readFile: (path, text) => path.endsWith(`/events-${N_CHILD}.jsonl`) ? journal : text })
  on('turn.complete', () => ({ text: '' }))
  await step($, m.host)
  await $.turn.complete({ answer: '', durationMs: 1, isAborted: true, turnId: 'turn-1', agentId: m.parentHost, reason: 'aborted' } as any)
  expect(w.writes.filter(w => w.path.includes('/interrupt-')).length).toBe(1)
  expect(w.logs.some(line => line.includes('mirror cascade recovery unavailable'))).toBe(true)
  expect(w.spawned).toEqual([])
})

for (const state of ['completed', 'failed', 'interrupted']) test(`batch 8 source ${state} settles once without an interrupt echo`, { options: { progressIntervalMs: 0 } }, async ($, on) => {
  const m = savedMirror()
  const terminal = state === 'completed' ? { type: 'turn.completed' } : { type: 'turn.failed', status: state, error: { message: state } }
  const journal = [nestedSource({ type: 'agentMessage', id: 'final', text: 'actual child report' }),
    { ...terminal, thread_id: N_CHILD, turn_id: N_CT }].map(e => JSON.stringify(e) + '\n').join('')
  const w = world(on, { task: m.token, store: mirrorStore(m), readFile: (path, text) => path.endsWith(`/events-${N_CHILD}.jsonl`) ? journal : path.endsWith('/owner.json') ? JSON.stringify({ generation: m.generation, ended: true }) : text })
  on('turn.complete', () => ({ text: '' }))
  const s = await step($, m.host)
  expect(handback(s.result)).toContain('actual child report')
  if (state !== 'completed') expect(handback(s.result)).toContain(`codex failed: exit 1: ${state}`)
  await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 'turn-1', agentId: m.host, reason: 'answer' } as any)
  const stored: any = w.store.get(`mirror:sess-1:${N_CHILD}`)
  expect(stored.state).toBe(state === 'interrupted' ? 'aborted' : state)
  expect(w.writes.filter(w => w.path.includes('/interrupt-'))).toEqual([])
  expect(w.spawned).toEqual([])
  expect(w.modelCalls).toEqual([])
})

for (const status of ['accepted', 'rejected', 'unknown', 'missing']) test(`batch 8 steer ${status} persists its outcome across journal recovery without resubmission`, async ($, on) => {
  const id = `${N_CHILD}-1-source-uuid`
  const m = savedMirror('host-recovered-message', { messages: [{ id, status: 'submitted' }] })
  const ack = status === 'missing' ? '' : JSON.stringify({ type: 'codexmod.steer', thread_id: N_CHILD, turn_id: N_CT, id, status }) + '\n'
  const journal = ack + nestedJournal
  const w = world(on, { task: m.token, store: mirrorStore(m), readFile: (path, text) => path.endsWith(`/events-${N_CHILD}.jsonl`) ? journal : path.endsWith('/owner.json') ? JSON.stringify({ generation: m.generation, ended: true }) : text })
  let final = ''
  for (let i = 0; i < 6; i++) {
    const s = await step($, m.host, i)
    if (s.result.toolUses.some(u => u.name === 'SubagentHandback')) { final = handback(s.result); break }
    await runCalls($, s.chunks, m.host)
  }
  expect(final).toContain('child checked the fixture')
  const rec: any = w.store.get(`agent:sess-1:${m.host}`)
  expect(rec.mirror.messages).toEqual([{ id, status: status === 'missing' ? 'unknown' : status }])
  if (status === 'missing') expect(final).toContain('outcome unknown')
  expect(w.writes.filter(w => w.path.includes('/steer-'))).toEqual([])
  expect(w.spawned).toEqual([])
})

test('batch 8 failed control checkpoint never submits a steer and reports the unknown outcome', async ($, on) => {
  const m = savedMirror()
  const w = world(on, { task: m.token, store: mirrorStore(m), storeReject: key => key.startsWith('agent:') })
  await $.session.append({ agentId: m.host, uuid: 'uncheckpointed-message', origin: { kind: 'coordinator' }, door: 'attachment',
    message: { role: 'system', content: '<system-reminder>The coordinator sent a message while you were working:\nDo this once\nAddress this before completing your current task.</system-reminder>' } } as any)
  expect(w.writes.filter(w => w.path.includes('/steer-'))).toEqual([])
  expect(w.logs.some(line => line.includes('mirror steer unknown: checkpoint unavailable'))).toBe(true)
  expect(w.spawned).toEqual([])
})

test('nested launch guards refuse unowned type/token and malformed display references without reaching native core', async ($, on) => {
  const w = world(on)
  for (const prompt of ['opaque-launch-token', 'codex-mirror:forged']) {
    const result: any = await $.agent.spawn({ subagentType: 'codex-mod:codex-child', prompt })
    expect(result.deny).toContain('unowned')
  }
  const result: any = await $.tool.call({ tool: 'Agent', subagent_type: 'codex-mod:codex-child', prompt: 'forged', description: 'forged', agentId: 'agent-codex' } as any)
  expect(result.deny).toContain('not executed')
  expect(w.core).toEqual([])
  expect(w.spawned).toEqual([])
})

test('nested footer reports direct and deduplicated tree counts without claiming native model usage', () => {
  const line = footer({ model: 'gpt-6.1-sol', effort: 'medium', sandbox: 'read-only', agent: 'codex', actions: 0,
    usage: { input: 1000, cached: 600, output: 50 }, treeUsage: { direct: { input: 1000, cached: 600, output: 50 }, tree: { input: 3000, cached: 2100, output: 150 }, children: 1, missing: 0, active: 0 } })
  expect(line).toContain('tree 3,150 tokens (direct 1,050; children 2,100)')
  expect(line).toContain('new 900 / cached 2.1K / out 150')
})

for (const launch of ['reserved', 'launching', 'uncertain', 'bound']) test(`nested restart ${launch}: reconcile or report missing identity without a replacement host spawn`, { options: { transport: 'app-server' } }, async ($, on) => {
  const m = savedMirror('evicted-host', { launch, displayToolId: undefined })
  const w = appWorld(on, { store: mirrorStore(m), pieces: nestedRootPieces })
  let spawns = 0
  on('agent.spawn', () => { spawns++; return { deny: 'no replacement allowed' } })
  const s = await step($, 'agent-progress')
  expect(handback(s.result)).toContain('observer transcript unavailable')
  expect(spawns).toBe(0)
  expect(w.spawned.length).toBe(1)
  expect(w.modelCalls).toEqual([])
})

test('nested terminal usage replay has one direct count after source-ledger hydration', () => {
  const event = normalizeSource(JSON.stringify({ type: 'turn.completed', thread_id: N_CHILD, turn_id: N_CT, usage: { input_tokens: 2000, output_tokens: 100 } }))!
  const ledger = new SourceLedger()
  expect(ledger.capture(event).render).toBe(true)
  expect(ledger.capture(event).render).toBe(false)
  const hydrated = new SourceLedger()
  for (const record of ledger.records) hydrated.capture(record)
  expect(hydrated.capture(event).render).toBe(false)
})

test('nested idle message is explicitly rejected without creating a turn or a stranded control file', async ($, on) => {
  const m = savedMirror('host-idle-child', { state: 'completed' })
  const w = world(on, { messages: () => [user(m.token), user('new idle message')], store: mirrorStore(m, { handedBack: true, lastAnswer: 'previous child report' }) })
  const s = await step($, m.host)
  expect(handback(s.result)).toContain('child message rejected')
  expect(w.writes).toEqual([])
  expect(w.spawned).toEqual([])
  expect(w.modelCalls).toEqual([])
})

test('nested canonical direct counters replace response/terminal copies instead of adding them', { options: { progressIntervalMs: 0 } }, async ($, on) => {
  const m = savedMirror('host-numeric-child')
  const direct = JSON.stringify({ type: 'codexmod.directUsage', thread_id: N_CHILD, turn_id: N_CT, usage: { input: 2000, cached: 1500, output: 100 } }) + '\n'
  const journal = direct + direct + nestedJournal
  const w = world(on, { task: m.token, store: mirrorStore(m), readFile: (path, text) => path.endsWith(`/events-${N_CHILD}.jsonl`) ? journal : path.endsWith('/owner.json') ? JSON.stringify({ generation: m.generation, ended: true }) : text })
  let final = ''
  for (let i = 0; i < 6; i++) {
    const s = await step($, m.host, i)
    if (s.result.toolUses.some(u => u.name === 'SubagentHandback')) { final = handback(s.result); break }
    await runCalls($, s.chunks, m.host)
  }
  expect(final).toContain('500 new tokens (1.5K cached, 100 out)')
  expect(w.spawned).toEqual([])
  expect(w.modelCalls).toEqual([])
})

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
    '-m', 'gpt-6.1-sol', '-c', 'model_reasoning_effort="medium"',
    '-c', 'approval_policy="never"', '-c', 'approvals_reviewer="user"', '-c', 'sandbox_workspace_write.network_access=false', '-c', 'sandbox_workspace_write.writable_roots=[]', '-',
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
  expect(chunks.at(-3).id.startsWith('toolu_codexhandback_')).toBe(true)
  expect(chunks.at(-2)).toEqual({ kind: 'input', index: 0, json: JSON.stringify({ message }) })
})

test('a failed codex run still answers without the model: "codex failed:" first, footer last', async ($, on) => {
  const w = world(on, { stdout: '{"type":"thread.started","thread_id":"t-1"}\n{"type":"turn.failed","error":{"message":"not logged in"}}\n', code: 1, stderr: 'stderr tail line' })
  const { result } = await step($, 'agent-codex')
  expect(w.modelCalls).toEqual([])
  const m = handback(result)
  expect(firstLine(m)).toBe('codex failed: exit 1: not logged in')
  expect(m).toContain('stderr tail line')
  expect(lastLine(m)).toBe('codex · gpt-6.1-sol · medium · workspace-write · 0 actions · direct usage partial/unknown · thread t-1')
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
  expect(w.spawned[0]!.input).toBe('Do not spawn sub-agents.\n\n' + 'Say hi')
})

test('project roles: each agent maps to its declared profile and instructions', async ($, on) => {
  const w = await startProject($, on)
  for (const [id, name, model, effort, sandbox] of [
    ['agent-project', 'implementer', 'gpt-6.1-sol', 'medium', 'workspace-write'],
    ['agent-project-high', 'implementer-high', 'gpt-6.1-sol', 'xhigh', 'workspace-write'],
    ['agent-project-auditor', 'auditor', 'gpt-6-astra', 'xhigh', 'read-only'],
  ] as const) {
    const { result } = await step($, id)
    const argv = w.spawned.at(-1)!.argv
    expect(argOf(argv, '--sandbox')).toBe(sandbox)
    expect(argOf(argv, '-m')).toBe(model)
    expect(argv).toContain(`model_reasoning_effort="${effort}"`)
    const instructions = name === 'implementer' ? 'Keep the change bounded.\n\n' : name === 'auditor' ? 'Never edit files.\n\n' : ''
    expect(w.spawned.at(-1)!.input).toBe(`${instructions}Do not spawn sub-agents.\n\nReply with the single word PONG`)
    expect(handback(result)).not.toContain('Keep the change bounded.')
    expect(handback(result)).not.toContain('Never edit files.')
    expect(lastLine(handback(result)).startsWith(`${name} · ${model} · ${effort} · ${sandbox} · 0 actions`)).toBe(true)
  }
})

test('codex-effort and codex-model lines override the defaults', async ($, on) => {
  const w = world(on, { task: 'codex-effort: low\ncodex-model: gpt-mini-test\nHi' })
  const { result } = await step($, 'agent-normal')
  expect(w.spawned[0]!.argv).toContain('model_reasoning_effort="low"')
  expect(w.spawned[0]!.argv).toContain('gpt-mini-test')
  expect(w.spawned[0]!.input).toBe('Do not spawn sub-agents.\n\n' + 'Hi')
  expect(lastLine(handback(result))).toContain('codex · gpt-mini-test · low')
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

test('failure: denied session read (auto: SubagentHandback by default)', { options: { defaultModel: 'gpt-6.1-sol' } }, async ($, on) => {
  const w = world(on, { messages: () => ({ deny: 'no access' }) })
  const { result } = await step($, 'agent-deny')
  expect(w.spawned.length).toBe(0)
  expect(result.stopReason).toBe('tool_use')
  expect(firstLine(handback(result))).toBe('codex failed: session read denied: no access')
  expect(lastLine(handback(result))).toBe('codex · gpt-6.1-sol · medium · workspace-write · 0 actions')
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
  expect(w.spawned[1]!.input).toBe('Do not spawn sub-agents.\n\n' + 'second task')
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
  expect(lastLine(handback(result))).toContain('codex · gpt-pinned · high · workspace-write')
})

test('(b) a follow-up with a new codex-effort line uses it and persists it', async ($, on) => {
  let conv: any[] = [user('codex-model: gpt-pinned\nfirst')]
  const w = world(on, { messages: () => conv })
  await step($, 'agent-new-effort')
  conv = [...conv, ...toolResult('SubagentHandback'), user('codex-effort: low\nsecond')]
  const second = await step($, 'agent-new-effort', 0, 'turn-2')
  expect(w.spawned[1]!.argv).toContain('model_reasoning_effort="low"')
  expect(argOf(w.spawned[1]!.argv, '-m')).toBe('gpt-pinned')
  expect(w.spawned[1]!.input).toBe('Do not spawn sub-agents.\n\n' + 'second')
  expect(lastLine(handback(second.result))).toContain('gpt-pinned · low')
  expect(w.store.get('agent:sess-1:agent-new-effort')).toMatchObject({ model: 'gpt-pinned', effort: 'low', thread: 't-1' })
  conv = [...conv, ...toolResult('SubagentHandback'), user('third')]
  await step($, 'agent-new-effort', 0, 'turn-3')
  expect(w.spawned[2]!.argv).toContain('model_reasoning_effort="low"')
  expect(argOf(w.spawned[2]!.argv, '-m')).toBe('gpt-pinned')
})

// What a first run of agent-persist writes; the restart test below starts from it.
const PERSISTED = {
  agentName: 'codex',
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
  const store = new Map<string, unknown>([['agent:sess-1:agent-restarted', { ...PERSISTED, agentName: 'codex', updatedAt: 1_000_000 }]])
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
  expect(lastLine(handback(result))).toContain('codex · gpt-pinned · xhigh')
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
    ['session:old:handback', { handbackLock: 'text', updatedAt: 1_000_000 - 3 * 86_400_000 }],
    ['session:new:handback', { handbackLock: 'text', updatedAt: 1_000_000 - 3_600_000 }],
    ['session:junk:handback', { handbackLock: 'tool', updatedAt: 1_000_000 }],
    ['session:s:other', 1],
    ['other', 1],
  ])
  const w = world(on, { store })
  on('process.run', () => ({ value: { exitCode: 0, stdout: 'ok', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('agent.register', (_$, e: any) => ({ value: { agent: `codex-mod:${e.name}` } }))
  await $.session.start?.({ cwd: '/tmp/project', surface: null, isInteractive: false })
  expect([...w.store.keys()].sort()).toEqual(['agent:s:new', 'other', 'session:new:handback', 'session:s:other'])
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
  expect(r.result).toEqual({ stdout: 'a.txt\nb.txt\n', stderr: '', interrupted: false })
  expect(w.core).toEqual([])
  expect(w.checks).toEqual([])
  const s2 = await step($, 'agent-progress', 1)
  expect(handback(s2.result)).toBe('Two files.\n\ncodex · gpt-6.1-sol · medium · workspace-write · 1 action · 277 new tokens (21K cached, 46 out) · thread 01a14f50-c51c-7370')
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
  expect(r.deny).toBe('Codex command failed (exit code 1):\nls: nope: No such file or directory\n')
})

test('file changes: exact add/update use Write/Edit; deletion uses a display comment', async ($, on) => {
  const P = '/tmp/project/notes.txt'
  const files = new Map<string, string>()
  const w = world(on, {
    files,
    pieces: [
      THREAD('t-3'),
      fileEv('item.started', P, 'add'),
      fileEv('item.completed', P, 'add', '+alpha\n+beta\n'),
      fileEv('item.started', P, 'update'),
      () => { files.set(P, 'alpha\ngamma\n'); return true },
      fileEv('item.completed', P, 'update', '@@ -2 +2 @@\n-beta\n+gamma\n'),
      fileEv('item.completed', P, 'delete'),
      MESSAGE('edited'),
    ],
  })
  files.set(P, 'alpha\nbeta\n')
  // the add is read at once; the update and the delete come in the next steps
  const s1 = await step($, 'agent-files', 0)
  expect(callsOf(s1.chunks).map(c => [c.name, c.input])).toEqual([['Write', { file_path: P, content: 'alpha\nbeta\n' }]])
  const [w1] = await runCalls($, s1.chunks, 'agent-files')
  expect(w1.result).toEqual({ type: 'create', filePath: P, content: 'alpha\nbeta\n', structuredPatch: [{ oldStart: 0, oldLines: 0, newStart: 1, newLines: 2, lines: ['+alpha', '+beta'] }], originalFile: null })
  const s2 = await step($, 'agent-files', 1)
  expect(callsOf(s2.chunks).map(c => [c.name, c.input])).toEqual([['Edit', { file_path: P, old_string: 'beta\n', new_string: 'gamma\n', replace_all: false }]])
  const [e2] = await runCalls($, s2.chunks, 'agent-files')
  expect(e2.result).toEqual({
    filePath: P, oldString: 'beta\n', newString: 'gamma\n', originalFile: 'alpha\nbeta\n', userModified: false, replaceAll: false,
    structuredPatch: [{ oldStart: 2, oldLines: 1, newStart: 2, newLines: 1, lines: ['-beta', '+gamma'] }],
  })
  files.delete(P)
  w.clock.now += 5000
  const s3 = await step($, 'agent-files', 2)
  expect(callsOf(s3.chunks).map(c => [c.name, c.input])).toEqual([['Bash', { command: "# Codex apply_patch: delete '/tmp/project/notes.txt'", description: "Codex patch: delete '/tmp/project/notes.txt'" }]])
  await runCalls($, s3.chunks, 'agent-files')
  expect(w.core).toEqual([])
  const s4 = await step($, 'agent-files', 3)
  expect(lastLine(handback(s4.result))).toContain(' · 3 actions · 3 patches / 3 file rows · thread t-3')
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
  expect(w.spawned[1]!.input).toBe('Do not spawn sub-agents.\n\n' + 'also run the linter')
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
  expect(savedState(w, 'agent:sess-1:agent-exec-note')).toMatchObject({ followUps: [{ text: 'also run the linter', count: 2 }, { text: 'and the docs', count: 3 }] })
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
  expect(read.deny).toContain('not executed')
  expect(w.core.map(c => c.id)).toEqual(['toolu_01a', 'toolu_01b'])
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
    'mcp_servers.computer-use.enabled=false', 'mcp_servers.node_repl.enabled=false', 'mcp_servers.quoted_ok.enabled=false',
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
  expect(describeCommand('cd sub && npm test')).toBe('Run shell commands: cd, npm test')
  expect(describeCommand('sed -n 1,20p a.ts')).toBe('Read part of a.ts')
  expect(describeCommand('frobnicate')).toBe('Run frobnicate')
  expect([compact(950), compact(37412), compact(154000), compact(1250000), compact(2000)]).toEqual(['950', '37.4K', '154K', '1.3M', '2K'])
  expect(footer({ agent: 'codex', model: 'gpt-6-luna', effort: 'low', sandbox: 'workspace-write', actions: 3, usage: { input: 192000, cached: 154000, output: 631 }, thread: '01a14f50-c51c' }))
    .toBe('codex · gpt-6-luna · low · workspace-write · 3 actions · 38K new tokens (154K cached, 631 out) · thread 01a14f50-c51c')
  expect(mcpServerNames(CONFIG_TOML)).toEqual(['node_repl', 'computer-use', 'quoted_ok'])
})

test('shell descriptions cover compound and conditional commands while quoted delimiters stay literal', () => {
  for (const command of ['pwd; wc -l a.ts', 'pwd && wc -l a.ts', 'pwd | wc -l', 'pwd\nwc -l a.ts']) {
    expect(describeCommand(command)).toBe('Run shell commands: pwd, wc')
  }
  expect(describeCommand('git status --short; npm test')).toBe('Run shell commands: git status, npm test')
  for (const command of ['if test -f a; then cat a; fi', 'case "$x" in a) pwd;; esac', 'pwd; if true; then wc -l a; fi']) {
    expect(describeCommand(command)).toBe('Run conditional shell command')
  }
  expect(describeCommand('for f in a b; do cat "$f"; done')).toBe('Run compound shell command')
  for (const command of ["printf '%s; | &' 'if then fi'", 'printf "%s; | &" "literal"', 'printf escaped\\;delimiter']) {
    expect(describeCommand(command)).toBe('Print text')
  }
  expect(describeCommand('pwd;')).toBe('Show current directory')
  for (const command of ['echo "$(pwd; wc -l a)"', 'cat <<EOF\npwd; wc\nEOF', 'printf "unterminated; wc', 'pwd; '.repeat(7), 'x'.repeat(8193)]) {
    expect(describeCommand(command)).toBe('Run shell command')
  }
})

test('compound command labels preserve the original Bash source and output without native reclassification', () => {
  const command = 'pwd; wc -l "file;name"'
  const output = '/tmp/project\n7 file;name\n'
  const action = commandAction(command, output, 0)
  expect(action.tool).toBe('Bash')
  expect(action.input.command).toBe(command)
  expect(action.input.description).toBe('Run shell commands: pwd, wc')
  expect(action.result).toEqual({ stdout: output, stderr: '', interrupted: false })
  const source = normalizeSource(JSON.stringify({ type: 'item.completed', item: { type: 'command_execution', command,
    aggregated_output: output, exit_code: 0, status: 'completed' } }), { transport: 'exec', cwd: '/tmp/project' })!
  source.item!.commandActions = [{ type: 'read', command, path: '/tmp/project/file;name' }]
  expect(explorationAction(source)).toBe(undefined)
  expect(validAction(action)).toBe(true)
})

test('activity titles select literal read and pytest targets without exposing option values', () => {
  for (const [command, title] of [
    ['cat preregistration.json', 'Read preregistration.json'],
    ["cat 'pilot doc;$(literal).md'", 'Read pilot doc;$(literal).md'],
    ['head -n 20 "pilot doc.md"', 'Read start of pilot doc.md'],
    ['tail -n +3 notes.txt', 'Read end of notes.txt'],
    ['nl -ba notes.txt', 'Read with line numbers notes.txt'],
    ['sed -n 2,8p notes.txt', 'Read part of notes.txt'],
    ['pytest -q tests/test_pilot.py::test_read', 'Run pytest tests/test_pilot.py::test_read'],
    ['python3 -m pytest tests', 'Run pytest tests'],
    ['uv run pytest -q tests/a.py tests/b.py', 'Run pytest tests/a.py, tests/b.py'],
    ['pytest -k secret_filter tests', 'Run pytest'],
    ['python3 -c "print(42)"', 'Run Python'],
    ['cat a b', 'Show file contents'],
    ['sed -i s/a/b/ a.txt', 'Edit file in place'],
    ['TOKEN=private pytest tests', 'Run shell command'],
    ["cat 'token=private'", 'Show file contents'],
    ["cat 'sk-abcdefghijk'", 'Show file contents'],
    ['git --token ghp_abcdefghijk', 'Run git'],
    ['cat "$TOKEN"', 'Run shell command'],
    ['cat <<EOF\nprivate\nEOF', 'Run shell command'],
  ]) expect(describeCommand(command!)).toBe(title)
  expect(commandAction('/bin/zsh -lc "cat \'$TOKEN\'"', '', 0).input.description).toBe('Run shell command')
})

test('activity search titles require exact source, command, query and path linkage', () => {
  const command = "rg -n 'pilot | draft' docs"
  const item = { type: 'commandExecution', command, commandActions: [{ type: 'search', command, query: 'pilot | draft', path: '/workspace/docs' }] }
  const source = { transport: 'app-server' as const, event: 'item/completed', cwd: '/workspace', item }
  expect(describeCommand(command, source)).toBe('Search pilot | draft in docs')
  const wrapped = `/bin/zsh -lc ${JSON.stringify(command)}`
  expect(commandAction(wrapped, '', 0, 'completed', { ...source, item: { ...item, command: wrapped } }).input.description).toBe('Search pilot | draft in docs')
  for (const changed of [
    { ...item, command: 'rg other docs' },
    { ...item, type: 'agentMessage', description: 'Unrelated successful task' },
    { ...item, commandActions: [{ ...item.commandActions[0], command: 'rg other docs' }] },
    { ...item, commandActions: [{ ...item.commandActions[0], query: 'other' }] },
    { ...item, commandActions: [{ ...item.commandActions[0], path: '/foreign/docs' }] },
    { ...item, commandActions: [{ ...item.commandActions[0], type: 'unknown' }] },
    { ...item, commandActions: [...item.commandActions, ...item.commandActions] },
  ]) expect(describeCommand(command, { ...source, item: changed })).toBe('Search files')
  for (const query of ['password=private', 'sk-abcdefghijkl', 'bad\u001btitle']) {
    const cmd = `rg '${query}' docs`
    expect(describeCommand(cmd, { ...source, item: { ...item, command: cmd, commandActions: [{ type: 'search', command: cmd, query, path: 'docs' }] } })).toBe('Search files')
  }
  const unsupported = 'rg --pre private-script pilot docs'
  expect(describeCommand(unsupported, { ...source, item: { ...item, command: unsupported, commandActions: [{ type: 'search', command: unsupported, query: 'pilot', path: 'docs' }] } })).toBe('Search files')
})

test('activity titles bound long operands and compounds while preserving failed and unknown exits', () => {
  const path = `${'nested/'.repeat(100)}preregistration.json`
  const title = describeCommand(`cat '${path}'`)
  expect(title.startsWith('Read nested/')).toBe(true)
  expect(title.endsWith('preregistration.json')).toBe(true)
  expect(title.length <= 80).toBe(true)
  const command = `cat '${path}'; pytest '${path}'; cat '${path}'`
  expect(describeCommand(command).length <= 240).toBe(true)
  expect(describeCommand('cat a; pytest tests')).toBe('Run shell commands: Read a, Run pytest tests')
  const compound = 'cat a; rg -n pilot docs'
  const source = { transport: 'app-server' as const, event: 'item/completed', cwd: '/workspace', item: { type: 'commandExecution', command: compound,
    commandActions: [{ type: 'read', command: 'cat a', path: '/workspace/a' }, { type: 'search', command: 'rg -n pilot docs', query: 'pilot', path: '/workspace/docs' }] } }
  expect(describeCommand(compound, source)).toBe('Run shell commands: Read a, Search pilot in docs')
  // A whole compound annotated as one search does not establish its subcommand.
  expect(describeCommand(compound, { ...source, item: { ...source.item, commandActions: [{ type: 'search', command: compound, query: 'pilot', path: 'docs' }] } })).toBe('Run shell commands: Read a, rg')
  for (const [exitCode, status] of [[2, 'failed'], [null, 'failed'], [null, 'completed']] as const) {
    const action = commandAction('pytest tests/a.py', 'original error\n[output truncated]', exitCode, status)
    expect(action.input.description).toBe(`Run pytest tests/a.py${exitCode === null ? ' (exit unreported)' : ''}`)
    expect(action.input.command).toBe('pytest tests/a.py')
    expect(action.result).toEqual({ stdout: 'original error\n[output truncated]', stderr: '', interrupted: false })
    expect(Boolean(action.error)).toBe(status === 'failed')
    if (action.error) expect(action.error).toContain('original error\n[output truncated]')
  }
})

// ---- session.start ---------------------------------------------------------

const runOk = (stdout = 'ok') => ({ value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })

const startProject = async ($: any, on: On, opts: WorldOpts = {}) => {
  const w = world(on, { ...opts, files: new Map([['.claude/codex-mod.json', PROJECT_ROLES], ...(opts.files ?? [])]) })
  on('agent.register', (_$, e: any) => ({ value: { agent: `codex-mod:${e.name}` } }))
  on('process.run', (_$, e: any) => runOk(e.argv[0] === 'which' ? '/bin/codex' : e.argv[0] === '/bin/sh' ? e.argv[4] : 'ok'))
  await $.session.start?.({ cwd: '/tmp/project', surface: null, isInteractive: false })
  return w
}

test('session.start: finds codex on PATH, checks it, registers the agents with the models Codex lists', async ($, on) => {
  const w = world(on, { files: new Map([['/home/t/.codex/models_cache.json', MODELS_CACHE], ['.claude/codex-mod.json', PROJECT_ROLES]]) })
  const runs: string[][] = []
  const registered: any[] = []
  on('agent.register', (_$, e: any) => {
    if (e.name !== 'codex-child') registered.push(e)
    return { value: { agent: `codex-mod:${e.name}` } }
  })
  on('process.run', (_$, e: any) => {
    if (e.argv[0] === 'mkdir' && String(e.argv.at(-1)).includes('/codex-mod/runs/state-')) return runOk()
    runs.push([...e.argv])
    return runOk(e.argv[0] === 'which' ? '/usr/local/bin/codex\n' : 'ok')
  })
  on('ui.notify', () => ({ value: { isSent: true, channel: 'terminal_bell' as const } }))
  on('ui.toast', () => ({ value: undefined }))
  await $.session.start?.({ cwd: '/tmp/project', surface: null, isInteractive: false })
  expect(runs.map(r => r.join(' '))).toEqual(['which codex', '/usr/local/bin/codex --version', '/usr/local/bin/codex login status'])
  expect(registered.map(r => r.name)).toEqual(['codex', 'implementer', 'implementer-high', 'gpt-6-1-sol', 'gpt-6-luna'])
  expect(registered[1]).toMatchObject({ tools: ['Bash', 'Edit', 'Write', 'WebSearch', 'Agent', 'mcp__codex-mod__codex_tool', 'mcp__codex-mod__codex_plan', 'mcp__codex-mod__coordinator_message', 'mcp__codex-mod__codex_question'], model: 'haiku', maxTurns: 400, background: true, omitClaudeMd: true })
  expect(w.toolSpecs.map(t => t.name)).toEqual(['codex_tool', 'codex_plan', 'coordinator_message', 'codex_question', 'codex_message_status'])
  expect(w.toolSpecs.filter(t => t.name !== 'codex_message_status').every(t => t.description.includes('Display-only') && t.description.includes('refused'))).toBe(true)
  expect(w.toolSpecs[3].description).toContain('question or owner-enabled approval')
  expect(w.toolSpecs[3].description).toContain('one-shot approval')
  expect(w.toolSpecs[3].description).toContain('Only an explicit human answer, one-shot approval, decline or cancel submits a response')
  expect(w.toolSpecs[3].description).not.toBe(w.toolSpecs[0].description)
  expect(w.toolSpecs[3].isDeferred).toBe(false)
  expect(w.toolSpecs[3].inputSchema).toEqual(w.toolSpecs[0].inputSchema)
  expect(w.toolSpecs[0].inputSchema.required).toEqual(['server', 'name', 'arguments'])
  expect(w.toolSpecs[1].inputSchema.properties.steps.items.properties.status.enum).toEqual(['pending', 'in_progress', 'completed'])
  // The host spreads arguments beside its envelope fields, so display schemas
  // must keep these keys out of their top-level inputs.
  const envelopeKeys = ['tool', 'tool_use_id', 'agentId', 'requestMeta', 'consent', 'input', 'ceiling']
  expect(w.toolSpecs.map(t => Object.keys(t.inputSchema.properties))).toEqual([['server', 'name', 'arguments'], ['explanation', 'steps'], ['sourceUuid', 'text'], ['server', 'name', 'arguments'], ['targetAgentId', 'messageId']])
  for (const spec of w.toolSpecs) {
    expect(spec.inputSchema.additionalProperties).toBe(false)
    expect(Object.keys(spec.inputSchema.properties).some(key => envelopeKeys.includes(key))).toBe(false)
  }
  expect(registered[0].description).toContain('gpt-6.1-sol (low|medium|high|xhigh|max|ultra), gpt-6-luna (low|medium|high|xhigh|max)')
  expect(registered[0].description).not.toContain('gpt-hidden')
  expect(registered[1].description).toContain('Bounded implementation. Runs OpenAI Codex gpt-6.1-sol at medium reasoning in a workspace-write sandbox (declared by this project). Start the prompt')
  expect(registered[1].description).toContain('Codex models available here:')
  expect(registered[1].description).not.toContain('Keep the change bounded.')
  // The auditor's model is not listed: skipped, with a debug line.
  expect(w.logs.some(l => l.includes('role auditor not registered: model gpt-6-astra not available'))).toBe(true)
  const missing = await step($, 'agent-project-auditor')
  expect(firstLine(handback(missing.result))).toContain('is not declared by this project')
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

test('session.start: projectRoles false never reads the file; codexPath wins', { options: { codexPath: '/opt/codex', projectRoles: false } }, async ($, on) => {
  const w = world(on, { files: new Map([['.claude/codex-mod.json', PROJECT_ROLES]]) })
  const runs: string[][] = []
  const registered: string[] = []
  on('agent.register', (_$, e: any) => {
    if (e.name !== 'codex-child') registered.push(e.name)
    return { value: { agent: `codex-mod:${e.name}` } }
  })
  on('process.run', (_$, e: any) => {
    runs.push([...e.argv])
    return runOk()
  })
  await $.session.start?.({ cwd: '/tmp/project', surface: null, isInteractive: false })
  expect(runs.map(r => r[0])).toEqual(['/opt/codex', '/opt/codex'])
  expect(registered).toEqual(['codex'])
  expect(w.reads).not.toContain('.claude/codex-mod.json')
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

test('auto + API form without the reminder answers as text with a footer', async ($, on) => {
  const w = world(on, { handback: false })
  const { chunks, result } = await step($, 'agent-text')
  expect(result.toolUses).toEqual([])
  expect(result.stopReason).toBe('end_turn')
  expect(result.answer).toBe('PONG\n\ncodex · gpt-6.1-sol · medium · workspace-write · 0 actions · 1 new tokens (0 cached, 1 out) · thread t-1')
  expect(chunks.filter(c => c.kind === 'text').map(c => c.text)).toEqual([result.answer])
  expect(chunks.some(c => c.kind === 'tool' && c.name === 'SubagentHandback')).toBe(false)
  expect(w.logs.some(l => l.includes('handback route text') && l.includes('api read, signal none'))).toBe(true)
})

test('auto + rows fallback without the reminder still uses SubagentHandback', async ($, on) => {
  const w = world(on, { handback: false, noApi: true })
  const { result } = await step($, 'agent-text')
  expect(result.toolUses.map((u: any) => u.name)).toEqual(['SubagentHandback'])
  expect(handback(result).startsWith('PONG')).toBe(true)
  expect(w.logs.some(l => l.includes('handback route tool') && l.includes('rows read, signal none'))).toBe(true)
})

test('auto + API form without a signal preserves a stored tool lock', async ($, on) => {
  const store = new Map<string, unknown>([['agent:sess-1:agent-text', {
    ...PERSISTED, agentName: 'codex', handbackLock: 'tool', updatedAt: 1_000_000,
  }]])
  world(on, { store, handback: false })
  const { result } = await step($, 'agent-text')
  expect(result.toolUses.map((u: any) => u.name)).toEqual(['SubagentHandback'])
})

test('chooseHandback: auto respects signals, locks and read completeness', () => {
  for (const source of ['api', 'rows', 'denied'] as const) {
    expect(chooseHandback('auto', source)).toBe(source !== 'api')
    expect(chooseHandback('auto', source, 'tool', 'text', true)).toBe(true)
    expect(chooseHandback('auto', source, 'text', 'tool')).toBe(false)
    expect(chooseHandback('auto', source, undefined, 'tool', true)).toBe(true)
    expect(chooseHandback('auto', source, undefined, 'text')).toBe(false)
    expect(chooseHandback('auto', source, undefined, undefined, true)).toBe(false)
  }
})

test('chooseHandback: explicit modes ignore all automatic evidence', () => {
  for (const mode of ['tool', 'text'] as const) {
    for (const source of ['api', 'rows', 'denied'] as const) {
      for (const signal of [undefined, 'tool', 'text'] as const) {
        for (const lock of [undefined, 'tool', 'text'] as const) {
          for (const inactive of [false, true]) expect(chooseHandback(mode, source, signal, lock, inactive)).toBe(mode === 'tool')
        }
      }
    }
  }
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
  expect(w.spawned[1]!.input).toBe('Do not spawn sub-agents.\n\n' + 'also lint')
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
  expect(firstLine(handback(result))).toBe('codex failed: agent type codex-mod:retired is not declared by this project (.claude/codex-mod.json) or this version of the plugin')
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
  expect(w.spawned[0]!.input).toBe('Do not spawn sub-agents.\n\n' + 'Next range: 10 to 15, print each number and its square, run it, and show me the output and the final file.')
  expect(stripCoordinator('plain task')).toBe('plain task')
  expect(stripCoordinator('The coordinator sent a message while you were working:\nbody only')).toBe('body only')
})

// A coordinator's mid-run SendMessage as the engine renders it (codex-cli 2.1.299 transcript, row
// `attachment` of type `queued_command`): a reminder block with an id on both tags.
const DELIVERED = (text: string, id = 'ce76432e300b552c', address = true) =>
  `<system-reminder id="${id}">\nThe coordinator sent a message while you were working:\n${text}\n${address ? '\nAddress this before completing your current task.\n' : ''}</system-reminder id="${id}">`
const PEER = '<system-reminder id="p1">\nAnother Claude session sent a message while you were working:\nhello from a peer\n</system-reminder id="p1">'
const PLUGIN = '<system-reminder id="p2">\nThe loop plugin sent a message while you were working:\ntick\n</system-reminder id="p2">'

test('coordinator delivery rendered as a reminder block is a message in the API form, in either placement; peers and plugins are not', async () => {
  expect(coordinatorPayload(DELIVERED('do X'))).toBe('do X')
  expect(coordinatorPayload(DELIVERED('do X', 'z', false))).toBe('do X')
  expect(coordinatorPayload(`<system-reminder>\nunrelated\n</system-reminder>\n${DELIVERED('two\nlines')}`)).toBe('two\nlines')
  expect(coordinatorPayload(PEER)).toBe(undefined)
  expect(coordinatorPayload(PLUGIN)).toBe(undefined)
  expect(coordinatorPayload('The coordinator sent a message while you were working:\nbare')).toBe(undefined)
  expect(cleanText(PEER)).toBe('')
  // placement 1: the block beside the tool_result blocks of the same user message
  const same = itemsFromApi([
    { role: 'user', content: [{ type: 'text', text: 'first' }] },
    { role: 'assistant', content: [{ type: 'tool_use', id: 'a', name: 'Bash', input: {} }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'a', content: 'ok' }, { type: 'text', text: DELIVERED('also lint') }] },
  ])
  const r1 = readConversation(same)
  expect(r1.latest).toEqual({ text: 'also lint', count: 2, coordinator: true })
  expect(r1.textAfterResults).toBe(true)
  // placement 2: its own meta user message; seen again on a later step it keeps its count
  const own = [
    ...same.slice(0, 3),
    { role: 'user' as const, kind: 'text' as const, text: DELIVERED('also lint', 'q', false) },
    { role: 'assistant' as const, kind: 'use' as const, id: 'b', tool: 'Bash' },
    { role: 'user' as const, kind: 'result' as const, id: 'b', text: 'ok', isError: false },
  ]
  expect(readConversation(own.slice(0, 4)).latest).toEqual({ text: 'also lint', count: 2, coordinator: true })
  expect(readConversation(own).latest).toEqual({ text: 'also lint', count: 2, coordinator: true })
  expect(readConversation(own).textAfterResults).toBe(false)
  // a peer's or a plugin's delivery is engine prose: a nudge, never a task
  const peer = readConversation([...same.slice(0, 3), { role: 'user', kind: 'text', text: PEER }, { role: 'user', kind: 'text', text: PLUGIN }])
  expect(peer.latest).toEqual({ text: 'first', count: 1 })
  expect(peer.nudged).toBe(true)
})

test('exec: a delivery in the API form (beside the tool results) is a follow-up; a peer\'s message is not', async ($, on) => {
  let conv: any[] = [user('first')]
  const w = world(on, { messages: () => conv, pieces: [THREAD('t-14'), cmdDone('/bin/zsh -lc make'), cmdDone('/bin/zsh -lc lint'), MESSAGE('built')] })
  await step($, 'agent-api-deliver', 0)
  conv = [...conv, { role: 'user', text: PEER, toolUses: [], toolResults: [{ tool_use_id: 'toolu_codexmod_d1', text: 'ok', isError: false }] }]
  await step($, 'agent-api-deliver', 1)
  expect(w.logs.some(l => l.includes('follow-up received mid-run'))).toBe(false)
  conv = [...conv, { role: 'user', text: DELIVERED('also lint'), toolUses: [], toolResults: [{ tool_use_id: 'toolu_codexmod_d2', text: 'ok', isError: false }] }]
  const s3 = await step($, 'agent-api-deliver', 2)
  expect(w.logs.some(l => l.includes('follow-up received mid-run'))).toBe(true)
  expect(handback(s3.result).split('\n\n').slice(0, 2)).toEqual([steerNote('queued'), 'built'])
  conv = [...conv, ...toolResult('SubagentHandback', 'hb')]
  await step($, 'agent-api-deliver', 3)
  expect(w.spawned.length).toBe(2)
  expect(w.spawned[1]!.argv.slice(1, 3)).toEqual(['exec', 'resume'])
  expect(w.spawned[1]!.input).toBe('Do not spawn sub-agents.\n\n' + 'also lint')
})

// The row the engine appends for that delivery, as `session.append` carries it (the kit puts the pinned fields back).
const deliveryRow = (agentId: string, uuid: string, text: string) => ({
  message: { type: 'attachment' as const, name: 'queued_command', role: 'user' as const, isMeta: true as const, content: [{ type: 'text', text: DELIVERED(text) }] },
  door: 'attachment' as const,
  origin: { kind: 'coordinator' as const },
  uuid,
  agentId,
})

test('exec: a coordinator delivery appended as an attachment (not in the API form) is taken at the next step, queued, and runs after the handback once', async ($, on) => {
  let conv: any[] = [user('first')]
  const w = world(on, { messages: () => conv, pieces: [THREAD('t-15'), cmdDone('/bin/zsh -lc make'), cmdDone('/bin/zsh -lc lint'), MESSAGE('built')] })
  await step($, 'agent-exec-deliver', 0)
  conv = [...conv, ...toolResult('Bash', 'toolu_codexmod_e1')]
  await $.session.append(deliveryRow('agent-exec-deliver', 'row-1', 'also lint'))
  await $.session.append(deliveryRow('agent-other', 'row-2', 'not for us'))
  expect(w.logs.some(l => l.includes('coordinator message delivered mid-run (attachment queued_command, row row-1)'))).toBe(true)
  const s2 = await step($, 'agent-exec-deliver', 1)
  expect(s2.chunks.filter(c => c.kind === 'text').map(c => c.text)).toEqual([steerNote('queued')])
  conv = [...conv, ...toolResult('Bash', 'toolu_codexmod_e2')]
  const s3 = await step($, 'agent-exec-deliver', 2)
  expect(handback(s3.result).startsWith('built\n\n')).toBe(true)
  expect(savedState(w, 'agent:sess-1:agent-exec-deliver')).toMatchObject({ lastTask: 'first', userCount: 1, followUps: [{ text: 'also lint', count: 1, uuid: 'row-1' }] })
  conv = [...conv, ...toolResult('SubagentHandback', 'hb')]
  const s4 = await step($, 'agent-exec-deliver', 3)
  expect(w.spawned.length).toBe(2)
  expect(w.spawned[1]!.argv.slice(1, 3)).toEqual(['exec', 'resume'])
  expect(w.spawned[1]!.input).toBe('Do not spawn sub-agents.\n\n' + 'also lint')
  expect(s4.result.toolUses[0]!.name).toBe('Bash')
  // the transcript's task stays the record's: after this run the first message is not new again
  expect(savedState(w, 'agent:sess-1:agent-exec-deliver')).toMatchObject({ lastTask: 'first', userCount: 1, launchKey: '1:row-1:also lint' })
  conv = [...conv, ...toolResult('Bash', 'toolu_codexmod_e3')]
  const s5 = await step($, 'agent-exec-deliver', 4)
  expect(s5.result.toolUses[0]!.name).toBe('Bash')
  conv = [...conv, ...toolResult('Bash', 'toolu_codexmod_e4')]
  const s6 = await step($, 'agent-exec-deliver', 5)
  expect(s6.result.toolUses[0]!.name).toBe('SubagentHandback')
  expect(handback(s6.result)).not.toContain('↪')
  conv = [...conv, ...toolResult('SubagentHandback', 'hb2')]
  const s7 = await step($, 'agent-exec-deliver', 6)
  expect(s7.result.stopReason).toBe('end_turn')
  expect(w.spawned.length).toBe(2)
  expect(w.modelCalls).toEqual([])
})

test('a delivery to an agent that is not ours is forgotten when its turn ends', async ($, on) => {
  const w = world(on)
  on('turn.complete', () => ({ text: '' }))
  await step($, 'agent-gp')
  await $.session.append(deliveryRow('agent-gp', 'row-9', 'for the model'))
  await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 'turn-1', agentId: 'agent-gp', reason: 'end_turn' } as any)
  expect(w.modelCalls).toEqual(['agent-gp'])
  expect(w.spawned.length).toBe(0)
})

// ---- Coordinator receipt display --------------------------------------------

const COORDINATOR_TOOL = 'mcp__codex-mod__coordinator_message'
const coordinatorCalls = (chunks: any[]) => callsOf(chunks).filter(c => c.name.endsWith('__coordinator_message'))
const quietCoordinatorRecord = (text: string, uuid = 'saved-row') => ({
  model: 'gpt-6.1-sol', effort: 'medium', sandbox: 'workspace-write', agentName: 'codex',
  lastTask: 'first', userCount: 1, handedBack: false, lastAnswer: 'Previous Codex answer', updatedAt: 1_000_000,
  coordinator: { received: [uuid], pending: [{ uuid, text }] },
})

test('coordinator receipt: full original message, returned name, UUID dedup across steps, no extra action count or handback text', async ($, on) => {
  let conv: any[] = [user('first')]
  const w = world(on, { toolNamespace: 'runtime', messages: () => conv, pieces: [THREAD('echo'), cmdDone('/bin/zsh -lc make'), cmdDone('/bin/zsh -lc lint'), MESSAGE('built')] })
  const first = await step($, 'agent-coordinator')
  await runCalls($, first.chunks, 'agent-coordinator')
  conv.push(...toolResult('Bash'))
  const text = `codex-model: gpt-6.1-sol\ncodex-effort: high\n  Keep every line.\n\n${'Full message, no excerpt. '.repeat(12)}\n\n`
  await $.session.append(deliveryRow('agent-coordinator', 'full-row', text))
  await $.session.append(deliveryRow('agent-coordinator', 'full-row', text))
  const second = await step($, 'agent-coordinator', 1)
  expect(coordinatorCalls(second.chunks).map(c => [c.name, c.input])).toEqual([
    ['mcp__runtime__coordinator_message', { sourceUuid: 'full-row', text }],
  ])
  expect(callsOf(second.chunks).map(c => c.name)).toEqual(['mcp__runtime__coordinator_message', 'Bash'])
  expect(second.result.toolUses.map((c: any) => c.name)).toEqual(['mcp__runtime__coordinator_message', 'Bash'])
  expect(second.chunks.find(c => c.kind === 'text').text).toBe(steerNote('queued'))
  const spec = w.toolSpecs.find(s => s.name === 'coordinator_message')
  expect(spec).toMatchObject({ isDeferred: false, inputSchema: { required: ['sourceUuid', 'text'], additionalProperties: false } })
  expect(spec.description).toContain('Display-only coordinator message')
  expect(spec.description).toContain('Never call')
  const answers = await runCalls($, second.chunks, 'agent-coordinator')
  expect(answers[0]).toEqual({ result: [{ type: 'text', text: 'Queued after turn current' }] })
  conv.push(...toolResult('Bash'))
  await $.session.append(deliveryRow('agent-coordinator', 'full-row', text))
  const final = await step($, 'agent-coordinator', 2)
  expect(coordinatorCalls(final.chunks)).toEqual([])
  expect(handback(final.result)).toContain('built')
  expect(handback(final.result)).toContain('2 actions')
  expect(handback(final.result)).not.toContain('Full message')
  expect(w.spawned.length).toBe(1)
  expect(w.modelCalls).toEqual([])
  expect(w.core).toEqual([])
  expect(w.checks).toEqual([])
  expect((w.store.get('agent:sess-1:agent-coordinator') as any).coordinator).toMatchObject({ received: ['full-row'], pending: [] })
})

for (const nativeActions of [true, false]) {
  test(`coordinator record reload: pending display only, persisted UUID prevents re-show and never launches or replaces the answer (nativeActions ${nativeActions})`, { options: { nativeActions } }, async ($, on) => {
    const text = 'codex-effort: high\nReloaded coordinator text'
    const key = 'agent:sess-1:agent-coordinator-reload'
    let conv: any[] = [user('first')]
    const w = world(on, { store: new Map([[key, quietCoordinatorRecord(text)]]), messages: () => conv })
    // A repeated receipt after restart must not requeue it for Codex either.
    await $.session.append(deliveryRow('agent-coordinator-reload', 'saved-row', text))
    const displayed = await step($, 'agent-coordinator-reload', 1)
    if (nativeActions) {
      expect(coordinatorCalls(displayed.chunks).map(c => c.input)).toEqual([{ sourceUuid: 'saved-row', text }])
      expect(displayed.result.stopReason).toBe('tool_use')
      await runCalls($, displayed.chunks, 'agent-coordinator-reload')
      conv.push(...toolResult(COORDINATOR_TOOL, coordinatorCalls(displayed.chunks)[0].id))
    } else {
      expect(displayed.chunks.filter(c => c.kind === 'text')).toEqual([{ kind: 'text', index: 0, text: `Coordinator message:\n\n${text}` }])
      expect(displayed.result.answer).toBe(`Coordinator message:\n\n${text}`)
      expect(displayed.result.toolUses).toEqual([])
    }
    const stored = w.store.get(key) as any
    expect(stored.coordinator).toMatchObject({ received: ['saved-row'], pending: [] })
    expect(stored.lastAnswer).toBe('Previous Codex answer')
    expect(stored.followUps).toBe(undefined)
    await $.session.append(deliveryRow('agent-coordinator-reload', 'saved-row', text))
    const later = await step($, 'agent-coordinator-reload', 2)
    expect(later.chunks.filter(c => c.kind === 'text' || c.kind === 'tool')).toEqual([])
    expect(later.result.stopReason).toBe('end_turn')
    expect(w.logs.some(l => l.includes('record reloaded from the store'))).toBe(true)
    expect(w.spawned).toEqual([])
    expect(w.modelCalls).toEqual([])
    expect(w.core).toEqual([])
  })
}

test('coordinator displayed UUID loaded from the store is not shown or queued again', async ($, on) => {
  const record = quietCoordinatorRecord('Already shown')
  record.coordinator.pending = []
  const w = world(on, { task: 'first', store: new Map([['agent:sess-1:agent-coordinator-reload', record]]) })
  await $.session.append(deliveryRow('agent-coordinator-reload', 'saved-row', 'Already shown'))
  const s = await step($, 'agent-coordinator-reload')
  expect(s.result.toolUses).toEqual([])
  expect(s.chunks.filter(c => c.kind === 'text')).toEqual([])
  expect(w.spawned).toEqual([])
  expect(w.logs.some(l => l.includes('record reloaded from the store'))).toBe(true)
})

test('coordinator first receipt survives a copied launch record waiting for its save timestamp', async ($, on) => {
  const key = 'agent:sess-1:agent-coordinator'
  const { coordinator: _coordinator, ...record } = quietCoordinatorRecord('unused')
  let clocks = 0
  let reached!: () => void
  let release!: () => void
  const waiting = new Promise<void>(resolve => { reached = resolve })
  const released = new Promise<void>(resolve => { release = resolve })
  const w = world(on, { task: 'second', store: new Map([[key, record]]), pieces: [cmdDone('/bin/zsh -lc make'), MESSAGE('done')], clockNow: async now => {
    // startRun reads launch-guard time first, then saveRecord's timestamp.
    if (++clocks === 2) {
      reached()
      await released
    }
    return now
  } })
  const pending = step($, 'agent-coordinator')
  await waiting
  await $.session.append(deliveryRow('agent-coordinator', 'during-save', 'Keep this receipt'))
  release()
  const s = await pending
  expect(coordinatorCalls(s.chunks).map(c => c.input)).toEqual([{ sourceUuid: 'during-save', text: 'Keep this receipt' }])
  expect((w.store.get(key) as any).coordinator).toMatchObject({ received: ['during-save'], pending: [] })
  expect(w.spawned.length).toBe(1)
})

test('coordinator delayed receipt save preserves newer launch metadata and drained display state', async ($, on) => {
  const key = 'agent:sess-1:agent-coordinator'
  const { coordinator: _coordinator, ...record } = quietCoordinatorRecord('unused')
  let clocks = 0
  let reached!: () => void
  let release!: () => void
  const waiting = new Promise<void>(resolve => { reached = resolve })
  const released = new Promise<void>(resolve => { release = resolve })
  const w = world(on, { task: 'second', store: new Map([[key, record]]), pieces: [cmdDone('/bin/zsh -lc make'), MESSAGE('done')], clockNow: async now => {
    if (++clocks === 1) {
      reached()
      await released
    }
    return now
  } })
  const receipt = $.session.append(deliveryRow('agent-coordinator', 'slow-receipt', 'Preserve the newer launch'))
  await waiting
  const s = await step($, 'agent-coordinator')
  expect(coordinatorCalls(s.chunks).length).toBe(1)
  release()
  await receipt
  expect(w.store.get(key)).toMatchObject({
    lastTask: 'second', launchKey: '1:second', launchesSinceNew: 1,
    coordinator: { received: ['slow-receipt'], pending: [] },
  })
  expect(w.spawned.length).toBe(1)
})

test('coordinator concurrent first receipts share their UUIDs and bodies before persistence awaits', async ($, on) => {
  let clocks = 0
  let reached!: () => void
  let release!: () => void
  const waiting = new Promise<void>(resolve => { reached = resolve })
  const released = new Promise<void>(resolve => { release = resolve })
  const w = world(on, { task: 'first', clockNow: async now => {
    if (++clocks === 1) {
      reached()
      await released
    }
    return now
  } })
  const first = $.session.append(deliveryRow('agent-coordinator', 'concurrent-1', 'First receipt'))
  await waiting
  await $.session.append(deliveryRow('agent-coordinator', 'concurrent-2', 'Second receipt'))
  release()
  await first
  const s = await step($, 'agent-coordinator')
  expect(coordinatorCalls(s.chunks).map(c => c.input)).toEqual([
    { sourceUuid: 'concurrent-1', text: 'First receipt' }, { sourceUuid: 'concurrent-2', text: 'Second receipt' },
  ])
  expect((w.store.get('agent:sess-1:agent-coordinator') as any).coordinator).toMatchObject({ received: ['concurrent-1', 'concurrent-2'], pending: [] })
})

test('coordinator display guards: own answer only once, foreign IDs, wrong owner, dispatch and main-model calls denied', async ($, on) => {
  const w = world(on, { task: 'first', store: new Map([['agent:sess-1:agent-coordinator', quietCoordinatorRecord('Guarded text')]]) })
  const s = await step($, 'agent-coordinator')
  const [call] = coordinatorCalls(s.chunks)
  for (const [tool, id, agentId] of [
    [call.name, 'foreign', 'agent-coordinator'],
    [call.name, 'toolu_codexmod_forged', 'agent-coordinator'],
    [call.name, call.id, undefined],
    [call.name, call.id, 'agent-gp'],
    ['mcp__codex-mod__codex_tool', call.id, 'agent-coordinator'],
  ]) {
    const answer: any = await $.tool.call({ tool, ...call.input, tool_use_id: id, ...(agentId ? { agentId } : {}) } as any)
    expect(answer.deny).toContain('not executed')
  }
  const check: any = await $.tool.check({ tool: call.name, input: call.input, tool_use_id: call.id, agentId: 'agent-coordinator' } as any)
  expect(check.decision).toBe('deny')
  const [answer] = await runCalls($, s.chunks, 'agent-coordinator')
  expect(answer.result).toEqual([{ type: 'text', text: 'Received · pending Codex acknowledgment' }])
  const replay: any = await $.tool.call({ tool: call.name, ...call.input, tool_use_id: call.id, agentId: 'agent-coordinator' } as any)
  expect(replay.deny).toContain('not executed')
  expect(w.core).toEqual([])
  expect(w.checks).toEqual([])
})

test('coordinator receipt ignores other agents, main, peer and plugin origins', async ($, on) => {
  const w = world(on)
  await $.session.append(deliveryRow('agent-gp', 'foreign-row', 'Other agent'))
  for (const kind of ['peer', 'plugin']) {
    await $.session.append({ ...deliveryRow('agent-coordinator', `origin-${kind}`, 'Not the coordinator'), origin: { kind, name: 'other', sessionId: 'other' } } as any)
  }
  const main = deliveryRow('agent-coordinator', 'main-row', 'Main session')
  await $.session.append({ ...main, agentId: undefined } as any)
  expect(w.store.size).toBe(0)
})

test('coordinator registration failure falls back to full text and still registers agents', async ($, on) => {
  const text = 'Complete fallback message'
  const w = world(on, { task: 'first', toolRegisterThrows: 'coordinator_message', store: new Map([['agent:sess-1:agent-coordinator', quietCoordinatorRecord(text)]]) })
  const agents: any[] = []
  on('agent.register', (_$, e: any) => {
    if (e.name !== 'codex-child') agents.push(e)
    return { value: { agent: `codex-mod:${e.name}` } }
  })
  await $.session.start?.({ cwd: '/tmp/project', surface: null, isInteractive: false })
  expect(agents.length).toBe(1)
  expect(agents[0].tools.includes(COORDINATOR_TOOL)).toBe(false)
  const s = await step($, 'agent-coordinator')
  expect(s.chunks.filter(c => c.kind === 'text').map(c => c.text)).toEqual([`Coordinator message:\n\n${text}`])
  expect(coordinatorCalls(s.chunks)).toEqual([])
  expect(w.spawned).toEqual([])
})

for (const nativeActions of [true, false]) {
  test(`coordinator long messages split into consecutive source-linked parts above 90,000 characters (nativeActions ${nativeActions})`, { options: { nativeActions } }, async ($, on) => {
    const text = `${'a'.repeat(90000)}${'b'.repeat(90000)}end`
    const w = world(on, { task: 'first', store: new Map([['agent:sess-1:agent-coordinator', quietCoordinatorRecord(text)]]) })
    const s = await step($, 'agent-coordinator')
    const parts = nativeActions ? coordinatorCalls(s.chunks).map(c => c.input.text) : s.chunks.filter(c => c.kind === 'text').map(c => c.text.replace('Coordinator message:\n\n', ''))
    expect(parts).toEqual([`(part 1/3)\n${'a'.repeat(90000)}`, `(part 2/3)\n${'b'.repeat(90000)}`, '(part 3/3)\nend'])
    expect(parts.map(t => t.replace(/^\(part \d+\/\d+\)\n/, '')).join('')).toBe(text)
    if (nativeActions) {
      expect(coordinatorCalls(s.chunks).map(c => c.input.sourceUuid)).toEqual(['saved-row', 'saved-row', 'saved-row'])
      await runCalls($, s.chunks, 'agent-coordinator')
    }
    expect(w.spawned).toEqual([])
  })
}

test('coordinator card uses only the exact returned tool and emitted IDs, with literal full text after guard consumption', async ($, on) => {
  const text = '<tag>**literal coordinator text**</tag>'
  world(on, { task: 'first', toolNamespace: 'runtime', store: new Map([['agent:sess-1:agent-coordinator', quietCoordinatorRecord(text)]]) })
  on('ui.render', () => ({ type: 'Text', children: ['HOST'] }))
  const s = await step($, 'agent-coordinator')
  const [call] = coordinatorCalls(s.chunks)
  await runCalls($, s.chunks, 'agent-coordinator')
  const render = (tool: string, id: string) => $.ui.render({ component: 'ToolUse', surface: 'desktop', requestId: id, props: {
    tool, tool_use_id: id, input: { sourceUuid: 'forged', text: 'forged body' }, isRunning: false, isErrored: false, isInterrupted: false,
  } } as any)
  const card: any = await render(call.name, call.id)
  expect(card.type).toBe('Box')
  expect(card.children[0]).toMatchObject({ type: 'Text', props: { weight: 'semibold' }, children: ['Coordinator'] })
  expect(card.children[1]).toMatchObject({ type: 'Text', children: [text] })
  for (const [tool, id] of [[COORDINATOR_TOOL, call.id], [call.name, 'toolu_codexmod_unemitted'], [call.name, 'foreign'], ['Bash', call.id]]) {
    const fallback: any = await render(tool, id)
    expect(fallback.type).toBe('Text')
    expect(fallback.children).toEqual(['HOST'])
  }
})

test('fresh UI worker restores only an owned canonical coordinator receipt without tool registration or execution', async ($, on) => {
  const id = `${ID_PREFIX}saved_coordinator_ui`
  const text = 'Keep this exact coordinator body.\nSecond line.'
  const receipt = { tool: COORDINATOR_TOOL, sourceUuid: 'saved-row', text, messageId: 'message-ui' }
  const record: any = quietCoordinatorRecord('unused')
  record.coordinator = { received: ['saved-row'], pending: [], rows: {
    [id]: receipt,
    [`${id}_wrong_tool`]: { ...receipt, tool: 'Bash' },
    [`${id}_foreign_tool`]: { ...receipt, tool: 'mcp__foreign__coordinator_message' },
    [`${id}_unreceived`]: { ...receipt, sourceUuid: 'unreceived' },
  }, outcomes: { 'message-ui': { status: 'accepted', acceptedTurnId: 'saved-turn', messageId: 'message-ui' } } }
  const w = world(on, { store: new Map([['agent:sess-1:agent-coordinator', record]]) })
  const processes: any[] = []
  on('process.run', (_$, e: any) => { processes.push(e); return runOk() })
  on('ui.render', () => ({ type: 'Text', children: ['HOST'] }))
  const render = (tool: string, toolId: string) => b7Render($, toolId, tool, { text: 'forged input', sourceUuid: 'forged' })
  const card: any = await render(COORDINATOR_TOOL, id)
  expect(card.type).toBe('Box')
  expect(card.children[0].children).toEqual(['Coordinator'])
  expect(card.children[1].children).toEqual([text])
  expect(card.children[2].children).toEqual(['Accepted into turn'])
  expect(card.children[3].props.dimColor).toBe(true)
  expect(card.children[3].children[0]).toContain('Message: message-ui')
  expect(card.children[3].children[0]).toContain('Accepted turn: saved-turn')
  for (const [tool, toolId] of [[COORDINATOR_TOOL, `${id}_wrong_tool`], ['mcp__foreign__coordinator_message', `${id}_foreign_tool`],
    [COORDINATOR_TOOL, `${id}_unreceived`], ['Bash', id], ['mcp__codex-mod__codex_tool', id], [COORDINATOR_TOOL, `${id}_impostor`]]) {
    const fallback: any = await render(tool, toolId)
    expect(fallback.children).toEqual(['HOST'])
  }
  expect((await $.tool.call({ tool: COORDINATOR_TOOL, tool_use_id: id, sourceUuid: receipt.sourceUuid, text, agentId: 'agent-coordinator' } as any) as any).deny).toContain('not executed')
  expect(w.toolSpecs).toEqual([])
  expect(processes).toEqual([])
  expect(w.spawned).toEqual([])
  expect(w.modelCalls).toEqual([])
  expect(w.core).toEqual([])
})

for (const mismatch of ['none', 'foreign-tool', 'wrong-receipt-tool', 'wrong-cache-tool', 'wrong-session', 'wrong-record-session', 'wrong-agent', 'wrong-id', 'missing-cache', 'unreceived'] as const) {
  test(`fresh coordinator UI with an unregistered runtime name: ${mismatch}`, async ($, on) => {
    const id = `${ID_PREFIX}runtime_coordinator_${mismatch}`
    const tool = 'mcp__host_runtime__coordinator_message'
    const foreign = 'mcp__foreign__coordinator_message'
    const agent = 'agent-coordinator-reload'
    const text = '<literal>Complete coordinator message\n  keep every line.</literal>'
    const receipt = { tool: mismatch === 'wrong-receipt-tool' ? foreign : tool, sourceUuid: 'received-source', text }
    const record: any = quietCoordinatorRecord('unused')
    record.coordinator = { received: mismatch === 'unreceived' ? [] : ['received-source'], pending: [], rows: { [id]: receipt } }
    const cached = { id: mismatch === 'wrong-id' ? `${id}_other` : id, row: {
      sessionId: mismatch === 'wrong-session' ? 'other-session' : 'sess-1',
      agentId: mismatch === 'wrong-agent' ? 'another-agent' : agent,
      tool: mismatch === 'wrong-cache-tool' ? foreign : tool, sourceDigest: fingerprint('null').sha256,
    } }
    const slot = parseInt(fingerprint(id).sha256.slice(0, 8), 16) % ROW_SLOTS
    const path = `/home/t/.cache/codex-mod/runs/state-row-cache/row-${slot}.json`
    const w = world(on, {
      store: new Map([[`agent:${mismatch === 'wrong-record-session' ? 'other-session' : 'sess-1'}:${agent}`, record]]),
      files: mismatch === 'missing-cache' ? new Map() : new Map([[path, JSON.stringify(cached)]]),
    })
    const processes: any[] = []
    on('process.run', (_$, e: any) => { processes.push(e); return runOk() })
    on('ui.render', () => ({ type: 'Text', children: ['HOST'] }))
    const renderedTool = mismatch === 'foreign-tool' || mismatch === 'wrong-receipt-tool' ? foreign : tool
    const card: any = await b7Render($, id, renderedTool, { text: 'forged body', sourceUuid: 'forged' })
    if (mismatch === 'none') {
      expect(card.type).toBe('Box')
      expect(card.children[0].children).toEqual(['Coordinator'])
      expect(card.children[1].children).toEqual([text])
    } else expect(card.children).toEqual(['HOST'])
    // Presentation restoration must never restore a held execution answer.
    expect((await $.tool.call({ tool: renderedTool, tool_use_id: id, sourceUuid: receipt.sourceUuid, text, agentId: agent } as any) as any).deny).toContain('not executed')
    expect((await $.tool.check({ tool: renderedTool, tool_use_id: id, agentId: agent, input: { sourceUuid: receipt.sourceUuid, text } } as any)).decision).toBe('deny')
    expect(w.toolSpecs).toEqual([])
    expect(processes).toEqual([])
    expect(w.spawned).toEqual([])
    expect(w.modelCalls).toEqual([])
    expect(w.core).toEqual([])
  })
}

test('restored runtime coordinator presentation cannot cross a session change', async ($, on) => {
  const id = `${ID_PREFIX}runtime_coordinator_session_change`
  const tool = 'mcp__host_runtime__coordinator_message'
  const agent = 'agent-coordinator-reload'
  let sid = 'sess-1'
  const record: any = quietCoordinatorRecord('unused')
  record.coordinator = { received: ['source'], pending: [], rows: { [id]: { tool, sourceUuid: 'source', text: 'Owned body' } } }
  const slot = parseInt(fingerprint(id).sha256.slice(0, 8), 16) % ROW_SLOTS
  const w = world(on, { sessionId: () => sid, store: new Map([[`agent:sess-1:${agent}`, record]]), files: new Map([
    [`/home/t/.cache/codex-mod/runs/state-row-cache/row-${slot}.json`, JSON.stringify({ id, row: { sessionId: sid, agentId: agent, tool, sourceDigest: fingerprint('null').sha256 } })],
  ]) })
  on('ui.render', () => ({ type: 'Text', children: ['HOST'] }))
  expect((await b7Render($, id, tool) as any).type).toBe('Box')
  sid = 'other-session'
  expect((await b7Render($, id, tool) as any).children).toEqual(['HOST'])
  expect(w.spawned).toEqual([])
  expect(w.modelCalls).toEqual([])
  expect(w.core).toEqual([])
})

for (const [name, outcome, label] of [
  ['received', { status: 'received' }, 'Received · pending Codex acknowledgment'],
  ['pending', { status: 'pending', expectedTurnId: 'expected-turn-full-id' }, 'Pending Codex acknowledgment'],
  ['accepted', { status: 'accepted', acceptedTurnId: 'accepted-turn-full-id', turnId: 'source-turn-full-id' }, 'Accepted into turn'],
  ['observed', { status: 'observed', acceptedTurnId: 'observed-turn-full-id', echoedItemId: 'observed-item' }, 'Observed in Codex input'],
  ['accepted-observed', { status: 'accepted', acceptedTurnId: 'accepted-observed-turn-full-id', echoedItemId: 'observed-item' }, 'Accepted into turn · observed in input'],
  ['queued', { status: 'queued', queuedAfterTurnId: 'queued-turn-full-id', reason: 'source turn already finished' }, 'Queued after turn · source turn already finished'],
  ['unknown', { status: 'unknown', expectedTurnId: 'uncertain-turn-full-id', reason: 'acknowledgment was lost' }, 'Delivery uncertain · acknowledgment was lost'],
  ['rejected', { status: 'rejected', reason: 'stale turn identity' }, 'Rejected · stale turn identity'],
  ['rejected-error', { status: 'rejected', error: { message: 'broker refused the request' } }, 'Rejected · broker refused the request'],
] as const) test(`coordinator presentation separates literal body, ${name} state and full evidence IDs`, async ($, on) => {
  const id = `${ID_PREFIX}coordinator_state_${name}`
  const messageId = `message-full-id-${name}`
  const text = '<tag>**Keep this literal body**</tag>\n  café 😀\nFinal line.'
  const record: any = quietCoordinatorRecord('unused')
  record.coordinator = { received: ['source'], pending: [], rows: { [id]: { tool: COORDINATOR_TOOL, sourceUuid: 'source', text, messageId } },
    outcomes: { [messageId]: { ...outcome, messageId, receivedAt: 1 } } }
  const w = world(on, { store: new Map([['agent:sess-1:agent-coordinator', record]]) })
  on('ui.render', () => ({ type: 'Text', children: ['HOST'] }))
  const card: any = await b7Render($, id, COORDINATOR_TOOL)
  expect(card.children[1].children).toEqual([text])
  expect(card.children[2].children).toEqual([label])
  expect(card.children[2].children[0]).not.toContain(messageId)
  expect(card.children[3].props.dimColor).toBe(true)
  expect(card.children[3].children[0]).toContain(`Message: ${messageId}`)
  for (const [key, value] of Object.entries(outcome)) {
    if (key.endsWith('TurnId') || key === 'turnId') expect(card.children[3].children[0]).toContain(value)
  }
  expect((await $.tool.call({ tool: COORDINATOR_TOOL, tool_use_id: id, agentId: 'agent-coordinator', text, sourceUuid: 'source' } as any) as any).deny).toContain('not executed')
  expect(w.spawned).toEqual([])
  expect(w.modelCalls).toEqual([])
  expect(w.core).toEqual([])
})

test('coordinator history keeps its saved outcome when the live state query fails', async ($, on) => {
  const id = `${ID_PREFIX}saved_coordinator_state_error`
  const record: any = quietCoordinatorRecord('unused')
  record.coordinator = { received: ['saved-row'], pending: [], rows: {
    [id]: { tool: COORDINATOR_TOOL, sourceUuid: 'saved-row', text: 'Saved body', messageId: 'saved-message' },
  }, outcomes: { 'saved-message': { status: 'queued', queuedAfterTurnId: 'saved-turn', messageId: 'saved-message' } } }
  const w = world(on, { store: new Map([['agent:sess-1:agent-coordinator', record]]) })
  const engine: any = b7Engine(w)
  engine.ui.resolve = () => ({ Box: (props: any) => ({ type: 'Box', ...props }), Text: (props: any) => ({ type: 'Text', ...props }) })
  engine.state = { get: async () => { throw new Error('state unavailable') } }
  const render = b7Hooks().get('ui.renderToolUse')!.handler
  const card = await render(engine, { props: { tool_use_id: id, tool: COORDINATOR_TOOL } }, b7Next(async () => ({ type: 'HOST' })))
  expect(card.type).toBe('Box')
  expect(card.children[1].children).toBe('Saved body')
  expect(card.children[2].children).toBe('Queued after turn')
  expect(card.children[3].dimColor).toBe(true)
  expect(card.children[3].children).toContain('Queued after turn: saved-turn')
  expect(w.spawned).toEqual([])
  expect(w.modelCalls).toEqual([])
  expect(w.core).toEqual([])
})

test('coordinator render errors fall back through next(e)', async () => {
  let render: any
  let catcher: any
  codexRegister(((event: string, ...args: any[]) => {
    const selected = event === 'ui.render' && args[0]?.component === 'ToolUse'
    if (selected) render = args.at(-1)
    return { catch: (handler: any) => { if (selected) catcher = handler } }
  }) as any, {})
  const e = { props: { get tool_use_id() { throw new Error('Render failure') } } }
  let passed: any
  const next = (value: any) => { passed = value; return { type: 'Text', children: ['HOST'] } }
  let threw = false
  try { await render({}, e, next) } catch { threw = true }
  expect(threw).toBe(true)
  expect(catcher({}, e, next)).toEqual({ type: 'Text', children: ['HOST'] })
  expect(passed === e).toBe(true)
})

test('coordinator receipt between a tool header and input waits for the next block boundary', async ($, on) => {
  const w = world(on, { task: 'first', pieces: [cmdDone('/bin/zsh -lc make'), MESSAGE('built')] })
  const stream = $.turn.step({ turnId: 'turn-1', index: 0, agentId: 'agent-coordinator', model: 'claude-haiku-4-5', messageCount: 1 })
  const header = await stream.next()
  expect(header.value).toMatchObject({ kind: 'tool', index: 0, name: 'Bash' })
  await $.session.append(deliveryRow('agent-coordinator', 'between-blocks', 'Do not break the tool input'))
  const input = await stream.next()
  expect(input.value).toMatchObject({ kind: 'input', index: 0 })
  const chunks: any[] = [header.value, input.value]
  let result: any
  for (;;) {
    const r = await stream.next()
    if (r.done) { result = r.value; break }
    chunks.push(r.value)
  }
  expect(callsOf(chunks).map(c => c.name)).toEqual(['Bash', COORDINATOR_TOOL])
  expect(result.toolUses.map((c: any) => c.name)).toEqual(['Bash', COORDINATOR_TOOL])
  await runCalls($, chunks, 'agent-coordinator')
  expect(w.spawned.length).toBe(1)
  expect(w.core).toEqual([])
})

test('coordinator plain text received mid-stream uses a separate block and never enters the handback or saved answer', { options: { nativeActions: false } }, async ($, on) => {
  const text = 'codex-effort: high\n  Full message after the first action.\n\n'
  const w = world(on, { task: 'first', pieces: [cmdDone('/bin/zsh -lc make'), cmdDone('/bin/zsh -lc lint'), MESSAGE('built')] })
  const stream = $.turn.step({ turnId: 'turn-1', index: 0, agentId: 'agent-coordinator-stream', model: 'claude-haiku-4-5', messageCount: 1 })
  const first = await stream.next()
  expect(first.value).toMatchObject({ kind: 'text', index: 0, text: '$ make' })
  await $.session.append(deliveryRow('agent-coordinator-stream', 'midstream', text))
  const chunks: any[] = [first.value]
  let result: any
  for (;;) {
    const r = await stream.next()
    if (r.done) { result = r.value; break }
    chunks.push(r.value)
  }
  expect(chunks.filter(c => c.kind === 'text').map(c => [c.index, c.text])).toEqual([
    [0, '$ make'], [1, `${literalReceipt(text)}\nQueued after turn current\n`], [2, `\n\n${steerNote('queued')}`], [2, '\n\n$ lint'],
  ])
  expect(result.answer).toContain(literalReceipt(text))
  expect(handback(result)).toContain('built')
  expect(handback(result)).not.toContain('Full message')
  expect((w.store.get('agent:sess-1:agent-coordinator-stream') as any).lastAnswer).not.toContain('Full message')
  expect(w.spawned.length).toBe(1)
})

test('coordinator literal payload preserves whitespace and embedded reminder tags, with or without the host suffix', async () => {
  const text = '  codex-effort: high\n\n<tag>**message**</tag>\n<system-reminder>literal</system-reminder>\n  \n'
  for (const address of [true, false]) expect(coordinatorPayload(DELIVERED(text, 'exact', address), true)).toBe(text)
  expect(coordinatorPayload(DELIVERED(text))).toBe(text.trim())
})

test('coordinator split keeps a surrogate pair intact at the 90,000 character boundary', async ($, on) => {
  const text = `${'a'.repeat(89999)}😀tail`
  world(on, { task: 'first', store: new Map([['agent:sess-1:agent-coordinator', quietCoordinatorRecord(text)]]) })
  const s = await step($, 'agent-coordinator')
  expect(coordinatorCalls(s.chunks).map(c => c.input.text)).toEqual([`(part 1/2)\n${'a'.repeat(89999)}`, '(part 2/2)\n😀tail'])
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
  const p = { agent: 'codex', model: 'm', effort: 'low', sandbox: 'read-only', actions: 2, thread: 'abcdefghij' }
  expect(footer(p, 'short')).toBe('codex · m · low')
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
  expect(handback(result)).toBe('PONG\n\ncodex · gpt-6.1-sol · medium')
})

test('extraConfig entries are passed as -c to every launch', { options: { extraConfig: ['tools.view_image=false'], lean: false } }, async ($, on) => {
  const w = world(on)
  await step($, 'agent-extra')
  const argv = w.spawned[0]!.argv
  expect(argv.filter((_, i) => argv[i - 1] === '-c')).toContain('tools.view_image=false')
})

test('option validation: every knob, defaults on refused values', async () => {
  const d = parseConfig({})
  expect(d).toMatchObject({
    lean: true, globalRules: true, archiveSessions: false, generic: { model: '', effort: 'medium', sandbox: 'workspace-write' }, projectRoles: true, allowProjectFullAccess: false,
    extraConfig: [], intervalMs: 1000, maxActionsPerStep: 10, handbackMode: 'auto', footer: 'full', timeoutMs: 0, nativeActions: true, ttlMs: 2 * 86_400_000, maxRunsPerWindow: 3, warnings: [],
  })
  expect(d.codexPath).toBe(undefined)
  expect(parseConfig({ archiveSessions: true }).archiveSessions).toBe(true)
  expect(parseConfig({ archiveSessions: 'true' })).toMatchObject({ archiveSessions: false, warnings: ['archiveSessions: not a boolean; default used'] })
  const good = parseConfig({
    codexPath: '/x/codex', defaultModel: 'gpt-6-luna', defaultEffort: 'ULTRA', defaultSandbox: 'read-only', projectRoles: false, allowProjectFullAccess: true, lean: false, globalRules: false,
    extraConfig: ['a.b=1'], progressIntervalMs: 0, maxActionsPerStep: 3, handbackMode: 'tool', footer: 'short', timeoutMinutes: 30, nativeActions: false, pruneDays: 7,
    maxRunsPerWindow: 5,
  })
  expect(good).toMatchObject({
    codexPath: '/x/codex', generic: { model: 'gpt-6-luna', effort: 'ultra', sandbox: 'read-only' }, projectRoles: false, allowProjectFullAccess: true, lean: false, globalRules: false,
    extraConfig: ['a.b=1'], intervalMs: 0, maxActionsPerStep: 3, handbackMode: 'tool', footer: 'short', timeoutMs: 1_800_000, nativeActions: false, ttlMs: 7 * 86_400_000, maxRunsPerWindow: 5, warnings: [],
  })
  const bad = parseConfig({
    defaultModel: 'bad model!', defaultEffort: 'not-an-effort', defaultSandbox: 'yolo', projectRoles: 'yes', allowProjectFullAccess: 1, lean: 'yes', globalRules: 1,
    extraConfig: ['novalue', 'model=gpt-x', 'sandbox_mode="danger-full-access"', 'ok=1'], progressIntervalMs: -5, maxActionsPerStep: 99, handbackMode: 'never',
    footer: 'huge', timeoutMinutes: 99999, nativeActions: 'no', pruneDays: 0, maxRunsPerWindow: 0,
  })
  expect(bad).toMatchObject({
    generic: { model: '', effort: 'medium', sandbox: 'workspace-write' }, projectRoles: true, allowProjectFullAccess: false, lean: true, globalRules: true, extraConfig: ['ok=1'],
    intervalMs: 1000, maxActionsPerStep: 10, handbackMode: 'auto', footer: 'full', timeoutMs: 0, nativeActions: true, ttlMs: 2 * 86_400_000, maxRunsPerWindow: 3,
  })
  for (const k of ['defaultModel', 'defaultEffort', 'defaultSandbox', 'projectRoles', 'allowProjectFullAccess', 'lean', 'globalRules', 'novalue', '"model"', '"sandbox_mode"', 'progressIntervalMs', 'maxActionsPerStep', 'handbackMode', 'footer', 'timeoutMinutes', 'nativeActions', 'pruneDays', 'maxRunsPerWindow']) {
    expect(bad.warnings.some(w => w.includes(k))).toBe(true)
  }
})

test('parseProjectRoles: valid file, defaults and length boundaries', async () => {
  const parsed = parseProjectRoles(PROJECT_ROLES)
  expect(Object.keys(parsed.roles)).toEqual(['implementer', 'implementer-high', 'auditor'])
  expect(parsed.roles.implementer).toEqual({ model: 'gpt-6.1-sol', effort: 'medium', sandbox: 'workspace-write', description: 'Bounded implementation.', instructions: 'Keep the change bounded.' })
  expect(parsed.warnings).toEqual([])
  const boundary = { model: 'm', effort: 'low', description: 'd'.repeat(600), instructions: 'i'.repeat(2000) }
  const names = { ['a'.repeat(32)]: boundary, constructor: boundary }
  expect(Object.keys(parseProjectRoles(JSON.stringify({ roles: names })).roles)).toEqual(Object.keys(names))
})

for (const [label, name, changes] of [
  ['bad name', 'Bad_role', {}],
  ['long name', 'a'.repeat(33), {}],
  ['codex name', 'codex', {}],
  ['long description', 'worker', { description: 'd'.repeat(601) }],
  ['long instructions', 'worker', { instructions: 'i'.repeat(2001) }],
  ['bad instructions type', 'worker', { instructions: 1 }],
  ['bad sandbox', 'worker', { sandbox: 'yolo' }],
  ['full access refused', 'worker', { sandbox: 'danger-full-access' }],
  ['missing model', 'worker', { model: undefined }],
  ['missing effort', 'worker', { effort: undefined }],
  ['missing description', 'worker', { description: undefined }],
  ['empty model', 'worker', { model: '' }],
  ['bad effort type', 'worker', { effort: 2 }],
] as const) {
  test(`parseProjectRoles: refuses ${label}`, async () => {
    const parsed = parseProjectRoles(JSON.stringify({ roles: { [name]: { model: 'm', effort: 'low', description: 'Task.', ...changes } } }))
    expect(Object.keys(parsed.roles)).toEqual([])
    expect(parsed.warnings.length).toBe(1)
  })
}

test('parseProjectRoles: skips roles beyond 16 with a warning', async () => {
  const roles = Object.fromEntries(Array.from({ length: 17 }, (_, i) => [`role-${i}`, { model: 'm', effort: 'low', description: 'Task.' }]))
  const parsed = parseProjectRoles(JSON.stringify({ roles }))
  expect(Object.keys(parsed.roles).length).toBe(16)
  expect(parsed.roles['role-16']).toBe(undefined)
  expect(parsed.warnings).toEqual(['at most 16 roles allowed; extra roles skipped'])
})

test('parseProjectRoles: full access allowed only by user opt-in; unknown keys ignored', async () => {
  const parsed = parseProjectRoles(JSON.stringify({ ignored: true, roles: { worker: { model: 'm', effort: 'low', sandbox: 'danger-full-access', description: 'Task.', extra: 'ignored' } } }), { allowFullAccess: true })
  expect(parsed.roles.worker).toEqual({ model: 'm', effort: 'low', sandbox: 'danger-full-access', description: 'Task.' })
  expect(parsed.warnings).toEqual(['project: unknown key "ignored" ignored', 'role worker: unknown key "extra" ignored'])
})

test('parseProjectRoles: malformed JSON and wrong shapes never throw', async () => {
  for (const text of ['{', 'null', '[]', '{}', '{"roles":null}', '{"roles":[]}', '{"roles":"bad"}']) {
    const parsed = parseProjectRoles(text)
    expect(Object.keys(parsed.roles)).toEqual([])
    expect(parsed.invalid).toBe(true)
    expect(parsed.warnings.length).toBe(1)
  }
  for (const value of [null, [], 1, 'bad']) {
    const parsed = parseProjectRoles(JSON.stringify({ roles: { worker: value } }))
    expect(Object.keys(parsed.roles)).toEqual([])
    expect(parsed.warnings.length).toBe(1)
  }
})

test('project roles: missing file silently registers only codex', async ($, on) => {
  const registered: string[] = []
  const w = world(on)
  on('process.run', () => runOk())
  on('agent.register', (_$, e: any) => {
    if (e.name !== 'codex-child') registered.push(e.name)
    return { value: { agent: `codex-mod:${e.name}` } }
  })
  await startSession($)
  expect(registered).toEqual(['codex'])
  expect(w.reads).toContain('.claude/codex-mod.json')
  expect(w.logs.filter(l => l.includes('.claude/codex-mod.json'))).toEqual([])
})

for (const [label, text, notifyThrows] of [['malformed JSON', '{', false], ['wrong shape', '{"roles":[]}', true]] as const) {
  test(`project roles: ${label} logs once per read and notices once per session with toast fallback`, async ($, on) => {
    const notices: string[] = []
    const toasts: string[] = []
    const w = world(on, { files: new Map([['.claude/codex-mod.json', text]]) })
    let registrations = 0
    on('process.run', () => runOk())
    on('agent.register', (_$, e: any) => {
      if (e.name !== 'codex-child') registrations++
      if (e.name !== 'codex-child' && registrations === 1) throw new Error('retry registration')
      return { value: { agent: `codex-mod:${e.name}` } }
    })
    on('ui.notify', (_$, e: any) => {
      notices.push(e.text)
      if (notifyThrows) throw new Error('unavailable')
      return { value: { isSent: false, reason: 'disabled' } }
    })
    on('ui.toast', (_$, e: any) => {
      toasts.push(e.text)
      return { value: undefined }
    })
    await startSession($)
    expect(w.logs.filter(l => l.includes('.claude/codex-mod.json')).length).toBe(1)
    await step($)
    expect(registrations).toBe(2)
    expect(w.logs.filter(l => l.includes('.claude/codex-mod.json')).length).toBe(2)
    expect(notices.length).toBe(1)
    expect(toasts).toEqual(notices)
    await step($, 'agent-codex')
    expect(w.spawned.length).toBe(1)
  })
}

test('options: leftover roles value is ignored with one warning', { options: { roles: ['old-role'] } }, async ($, on) => {
  const w = await startProject($, on)
  expect(parseConfig({ roles: ['old-role'] }).warnings).toEqual(['roles: removed in 1.2; declare roles in .claude/codex-mod.json'])
  expect(w.logs.filter(l => l.includes('roles: removed'))).toEqual(['codex-mod: option roles: removed in 1.2; declare roles in .claude/codex-mod.json'])
  await step($, 'agent-project')
  expect(w.spawned.length).toBe(1)
})

for (const allowed of [false, true]) {
  test(`project roles: registration gates full access (${allowed})`, { options: { allowProjectFullAccess: allowed } }, async ($, on) => {
    const file = JSON.stringify({ roles: { implementer: { model: 'm', effort: 'low', sandbox: 'danger-full-access', description: 'Task.' } } })
    const w = await startProject($, on, { files: new Map([['.claude/codex-mod.json', file]]) })
    await step($, 'agent-project')
    expect(w.spawned.length).toBe(allowed ? 1 : 0)
    if (allowed) expect(argOf(w.spawned[0]!.argv, '--sandbox')).toBe('danger-full-access')
    else expect(w.logs.some(l => l.includes('danger-full-access requires'))).toBe(true)
  })
}

test('project roles: follow-ups prepend instructions once; file and cwd edits do not reload', async ($, on) => {
  let conv: any[] = [user('codex-effort: high\nfirst')]
  const w = await startProject($, on, { messages: () => conv })
  await step($, 'agent-project')
  expect(w.spawned[0]!.input).toBe('Keep the change bounded.\n\nDo not spawn sub-agents.\n\nfirst')
  w.files.set('.claude/codex-mod.json', '{"roles":{}}')
  w.location.cwd = '/tmp/elsewhere'
  conv = [...conv, ...toolResult('SubagentHandback'), user('second')]
  const second = await step($, 'agent-project', 0, 'turn-2')
  expect(w.spawned[1]!.argv).toContain('resume')
  expect(w.spawned[1]!.argv).toContain('model_reasoning_effort="high"')
  expect(w.spawned[1]!.input).toBe('Keep the change bounded.\n\nDo not spawn sub-agents.\n\nsecond')
  expect(w.spawned[1]!.cwd).toBe('/tmp/project')
  expect(w.reads.filter(p => p === '.claude/codex-mod.json').length).toBe(1)
  expect(handback(second.result)).not.toContain('Keep the change bounded.')
  expect(w.store.get('agent:sess-1:agent-project')).toMatchObject({ lastTask: 'second', model: 'gpt-6.1-sol', effort: 'high' })
  expect((w.store.get('agent:sess-1:agent-project') as any).instructions).toBe(undefined)
  expect((w.store.get('agent:sess-1:agent-project') as any).description).toBe(undefined)
})

test('project roles: a removed role resumes from its persisted profile', async ($, on) => {
  const store = new Map<string, unknown>([['agent:sess-1:agent-project', { ...PERSISTED, agentName: 'implementer', sandbox: 'read-only', updatedAt: 1_000_000 }]])
  const w = world(on, { store, task: 'follow-up' })
  await step($, 'agent-project')
  expect(w.spawned[0]!.argv).toContain('resume')
  expect(w.spawned[0]!.argv).toContain('sandbox_mode="read-only"')
  expect(argOf(w.spawned[0]!.argv, '-m')).toBe('gpt-pinned')
  expect(w.spawned[0]!.input).toBe('Do not spawn sub-agents.\n\n' + 'follow-up')
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
  expect(w.spawned[0]!.env).toEqual({ CODEX_HOME: '/home/t/.codex' })
})

test('launch argv (pure): new and resumed runs, extra -c last before the prompt', async () => {
  const prof = { model: 'm', effort: 'max', sandbox: 'read-only' }
  expect(launchArgv({ codex: 'codex', prof, cwd: '/w', lean: [], extra: ['k=v'] })).toEqual([
    'codex', 'exec', '--json', '--skip-git-repo-check', '--sandbox', 'read-only', '-C', '/w', '-m', 'm', '-c', 'model_reasoning_effort="max"', '-c', 'k=v', '-c', 'approval_policy="never"', '-',
  ])
  expect(launchArgv({ codex: 'codex', prof, cwd: '/w', resume: 'th', lean: [], extra: [] })).toEqual([
    'codex', 'exec', 'resume', '--json', '--skip-git-repo-check', '-c', 'sandbox_mode="read-only"', '-m', 'm', '-c', 'model_reasoning_effort="max"', '-c', 'approval_policy="never"', 'th', '-',
  ])
})

test('agent registration refused at session start is retried once on the next main-loop step', async ($, on) => {
  const w = world(on)
  let calls = 0
  on('agent.register', (_$, e: any) => {
    if (e.name !== 'codex-child') calls++
    if (e.name !== 'codex-child' && calls === 1) throw new Error('session not bound')
    return { value: { agent: `codex-mod:${e.name}` } }
  })
  on('process.run', (_$, e: any) => runOk(e.argv[0] === 'which' ? '/bin/codex' : 'ok'))
  await $.session.start?.({ cwd: '/tmp/project', surface: null, isInteractive: false })
  expect(calls).toBe(1)
  w.files.set('.claude/codex-mod.json', PROJECT_ROLES)
  await step($)
  expect(calls).toBe(5)
  await step($)
  expect(calls).toBe(5)
  expect(w.reads.filter(p => p === '.claude/codex-mod.json').length).toBe(2)
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
  expect(w.spawned[0]!.input).toBe('Do not spawn sub-agents.\n\n' + LIVE_TASK.split('\n').slice(2).join('\n'))
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
  expect(w.spawned[1]!.input).toBe('Do not spawn sub-agents.\n\n' + 'Range 20 to 23 with squares; run it and show the output.')
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
  const w = world(on, { messages: () => conv })
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

for (const failure of [
  { text: NOT_ACTIVE_TEXT, isError: false },
  { text: 'No such tool available: SubagentHandback', isError: true },
  { text: 'Handback failed', isError: true },
]) {
  test(`auto session memo: ${failure.text}`, async ($, on) => {
    let conv: any[] = [user('first')]
    const opts: WorldOpts = { handback: false, noApi: true, messages: () => conv }
    const w = world(on, opts)
    const first = await step($, 'agent-codex')
    const answer = handback(first.result)
    conv = [...conv,
      { role: 'assistant', text: '', toolUses: [{ tool_use_id: 'hb', tool: 'SubagentHandback', input: { message: answer } }] },
      { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: 'hb', ...failure }] },
    ]
    const fallback = await step($, 'agent-codex', 1)
    expect(fallback.result.toolUses).toEqual([])
    expect(fallback.result.answer).toBe(answer)
    expect(w.store.get('session:sess-1:handback')).toEqual({ handbackLock: 'text', updatedAt: w.clock.now })

    conv = [user('second agent')]
    // Rows without a signal would default to the tool without the session memo.
    const second = await step($, 'agent-normal')
    expect(second.result.toolUses).toEqual([])
    expect(second.result.stopReason).toBe('end_turn')
    expect(firstLine(second.result.answer)).toBe('PONG')
    expect(lastLine(second.result.answer)).toContain('codex · gpt-6.1-sol · medium')
    expect(w.spawned.length).toBe(2)

    // The same agent must use the tool if the host now explicitly offers it.
    opts.noApi = false
    opts.handback = true
    conv = [user('host enabled handback')]
    const offered = await step($, 'agent-normal', 0, 'turn-2')
    expect(offered.result.toolUses.map((u: any) => u.name)).toEqual(['SubagentHandback'])
    expect(handback(offered.result).startsWith('PONG')).toBe(true)
  })
}

test('auto session memo: reloads from the store and stays within its session', async ($, on) => {
  const store = new Map<string, unknown>([['session:sess-1:handback', { handbackLock: 'text', updatedAt: 1_000_000 }]])
  const opts: WorldOpts = { store, handback: false, noApi: true }
  world(on, opts)
  const sameSession = await step($, 'agent-codex')
  expect(sameSession.result.toolUses).toEqual([])
  expect(firstLine(sameSession.result.answer)).toBe('PONG')
  opts.sessionId = 'sess-2'
  const otherSession = await step($, 'agent-normal')
  expect(otherSession.result.toolUses.map((u: any) => u.name)).toEqual(['SubagentHandback'])
})

test('auto session memo: remembers a historical failure even after a tool signal', async ($, on) => {
  let conv: any[] = [user('first'),
    { role: 'assistant', text: '', toolUses: [{ tool_use_id: 'hb', tool: 'SubagentHandback', input: {} }] },
    { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: 'hb', text: NOT_ACTIVE_TEXT }] },
    said('Previous answer'), meta(LIVE_ENFORCE), user('follow-up'),
  ]
  const opts: WorldOpts = { handback: false, messages: () => conv }
  const w = world(on, opts)
  const first = await step($, 'agent-codex')
  expect(first.result.toolUses.map((u: any) => u.name)).toEqual(['SubagentHandback'])
  expect(w.store.get('session:sess-1:handback')).toMatchObject({ handbackLock: 'text' })
  conv = [user('second agent')]
  opts.noApi = true
  const second = await step($, 'agent-normal')
  expect(second.result.toolUses).toEqual([])
  expect(firstLine(second.result.answer)).toBe('PONG')
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
  expect(parseCodexLine('{"type":"codexmod.steer","id":12,"status":"accepted"}')).toMatchObject({ kind: 'steer', id: '12', accepted: true })
  expect(parseCodexLine('{"type":"codexmod.steer","id":"x","status":"rejected","reason":"turn finished"}')).toMatchObject({ kind: 'steer', id: 'x', accepted: false, reason: 'turn finished' })
  expect(parseCodexLine('{"type":"codexmod.protocol","unknown_methods":["a/b"],"unknown_items":["c"]}')).toEqual({ kind: 'protocol', types: ['method a/b', 'item c'] })
  expect(parseCodexLine('{"type":"codexmod.fatal","message":"boom"}')).toEqual({ kind: 'fatal', text: 'boom' })
  expect(parseCodexLine('{"type":"codexmod.future"}')).toEqual({ kind: 'other' })
  expect(parseCodexLine('{"type":"item.updated","item":{}}')).toEqual({ kind: 'unknown', type: 'item undefined' })
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
    '--config', 'features.apps=false', '--config', 'web_search="disabled"', '--config', 'k=v', '--approval-mode', 'never', '--control', '/ctl',
  ])
  expect(runnerArgv({ node: 'n', runner: 'r', codex: 'c', prof: { model: 'm', effort: 'e', sandbox: 's' }, cwd: '/w', lean: [], extra: [], control: '/ctl' })).not.toContain('--thread')
  const p = { agent: 'codex', model: 'm', effort: 'low', sandbox: 'workspace-write', actions: 2 }
  expect(footer({ ...p, transport: 'app-server', steers: 2 })).toBe('codex · m · low · workspace-write · app-server · 2 steers · 2 actions')
  expect(footer({ ...p, transport: 'app-server', steers: 0 })).toBe('codex · m · low · workspace-write · app-server · 2 actions')
  expect(footer({ ...p, transport: 'app-server', steers: 1 }, 'short')).toBe('codex · m · low')
  expect(steerNote('accepted')).toBe('↪ steer delivered to Codex mid-turn')
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
function appWorld(on: On, opts: WorldOpts = {}, ready: { help?: number; protocol?: string; node?: boolean; history?: (e: any) => any } = {}) {
  const w = world(on, opts)
  const runs: string[][] = []
  const timers: number[] = []
  on('agent.register', (_$, e: any) => { opts.registeredAgents?.push(e); return { value: { agent: `codex-mod:${e.name}` } } })
  on('process.run', (_$, e: any) => {
    runs.push([...e.argv])
    const a = e.argv as string[]
    if (a[0] === '/usr/bin/env' && ['archive', 'unarchive'].includes(a[3]) && ready.history) return ready.history(e)
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
const CONTROL = /^\/home\/t\/\.cache\/codex-mod\/runs\/[a-z0-9]+-[a-z0-9]+-\d+$/

const HISTORY_THREAD = '019c6e27-e55b-73d1-87d8-4e01f1f75043'
const HISTORY_OTHER = '019c7714-3b77-74d1-9866-e1f484aae2ab'
const historyOutput = (thread = HISTORY_THREAD) => CODEX_JSONL.replace('t-1', thread)

/** Metadata commands are distinct from the one inference process in these fixtures. */
function historyWorld(on: On, mode: 'exec' | 'app-server' | 'fallback', opts: WorldOpts = {}, outcome: 'ok' | 'exit' | 'throw' = 'ok') {
  const commands: { argv: string[]; ended: number }[] = []
  let w: ReturnType<typeof world>
  const history = (e: any) => {
    commands.push({ argv: [...e.argv], ended: w.source.ended })
    if (outcome === 'throw') throw new Error('history command unavailable')
    return outcome === 'exit' ? { value: { ...runOk().value, exitCode: 1, stderr: 'Error: failed to unarchive session' } } : runOk()
  }
  if (mode === 'exec') {
    w = world(on, opts)
    on('process.run', (_$, e: any) => e.argv[0] === '/usr/bin/env' && ['archive', 'unarchive'].includes(e.argv[3]) ? history(e) : runOk())
  } else w = appWorld(on, opts, { help: mode === 'fallback' ? 2 : 0, history })
  return { ...w, history: commands }
}

for (const mode of ['exec', 'app-server', 'fallback'] as const) test(`session history ${mode}: default off makes no metadata commands`,
  { options: { transport: mode === 'exec' ? 'exec' : 'app-server' } }, async ($, on) => {
    const w = historyWorld(on, mode, { stdout: historyOutput() })
    const s = await step($, 'agent-codex')
    expect(firstLine(handback(s.result))).toBe('PONG')
    expect(w.history).toEqual([])
    expect(savedState(w, 'agent:sess-1:agent-codex').historyArchived).toBe(undefined)
  })

for (const mode of ['exec', 'app-server', 'fallback'] as const) test(`session history ${mode}: archive after process end, restore the same thread before follow-up`,
  { options: { archiveSessions: true, codexPath: '/opt/owned-codex', transport: mode === 'exec' ? 'exec' : 'app-server' } }, async ($, on) => {
    let conv: any[] = [user('first')]
    const w = historyWorld(on, mode, { messages: () => conv, stdout: historyOutput(), storeSnapshots: true })
    const first = await step($, 'agent-codex')
    expect(firstLine(handback(first.result))).toBe('PONG')
    expect(w.history).toEqual([{ argv: ['/usr/bin/env', 'CODEX_HOME=/home/t/.codex', '/opt/owned-codex', 'archive', '--', HISTORY_THREAD], ended: 1 }])
    const stored = savedState(w, 'agent:sess-1:agent-codex')
    expect(stored.historyArchived).toBe(true)
    expect((w.store.get('agent:sess-1:agent-codex') as any).historyArchived).toBe(true)
    expect(stored.effectiveFingerprint).toBe(configHash({ policy: stored.effectiveConfig.fingerprint, model: stored.model, effort: stored.effort, sandbox: stored.sandbox }))
    conv = [...conv, ...toolResult('SubagentHandback'), user('follow-up')]
    await step($, 'agent-codex', 0, 'history-follow-up')
    expect(w.history.map(c => [c.argv[3], c.ended])).toEqual([['archive', 1], ['unarchive', 1], ['archive', 2]])
    expect(w.history.every(c => c.argv[5] === HISTORY_THREAD && c.argv[1] === `CODEX_HOME=${w.spawned[0].env!.CODEX_HOME}`)).toBe(true)
    expect(w.spawned.length).toBe(2)
    expect(w.spawned[1].argv).toContain(mode === 'app-server' ? '--thread' : 'resume')
    expect(w.spawned[1].argv).toContain(HISTORY_THREAD)
    expect(w.spawned[1].env).toEqual(w.spawned[0].env)
    expect(savedState(w, 'agent:sess-1:agent-codex').effectiveFingerprint).toBe(stored.effectiveFingerprint)
    expect(w.spawned.every(s => !s.argv.includes('--thread-source') && !s.argv.includes('--ephemeral'))).toBe(true)
    expect(w.core).toEqual([])
  })

for (const transport of ['exec', 'app-server'] as const) test(`session history ${transport}: action yields and a live source cannot trigger archive`,
  { options: { archiveSessions: true, transport } }, async ($, on) => {
    const w = historyWorld(on, transport, { pieces: [THREAD(HISTORY_THREAD), cmdDone('/bin/zsh -lc pwd'), MESSAGE('done')] })
    const first = await step($, 'agent-progress')
    expect(w.source.ended).toBe(0)
    expect(w.history).toEqual([])
    await runCalls($, first.chunks, 'agent-progress')
    const last = await step($, 'agent-progress', 1)
    expect(firstLine(handback(last.result))).toBe('done')
    expect(w.history.map(c => [c.argv[3], c.ended])).toEqual([['archive', 1]])
  })

for (const transport of ['exec', 'app-server'] as const) test(`session history ${transport}: compact recovery restores an archived thread after opt-out in its recorded home`,
  { options: { archiveSessions: false, transport, globalRules: true } }, async ($, on) => {
    const policy = resolvePolicy(parseConfig({}), undefined, [], [], '/recorded/source-home').policy
    const key = 'agent:sess-1:agent-restarted'
    const rec = { ...PERSISTED, thread: HISTORY_THREAD, historyArchived: true, effectiveConfig: policy, updatedAt: 1_000_000 }
    const compact = compactStoreState(rec)
    expect(compact.historyArchived).toBe(true)
    const w = historyWorld(on, transport, { task: 'follow-up after reload', store: new Map([[key, compact]]), stdout: historyOutput(), storeSnapshots: true })
    const result = await step($, 'agent-restarted')
    expect(firstLine(handback(result.result))).toBe('PONG')
    expect(w.history).toEqual([{ argv: ['/usr/bin/env', 'CODEX_HOME=/recorded/source-home', 'codex', 'unarchive', '--', HISTORY_THREAD], ended: 0 }])
    expect(w.spawned.length).toBe(1)
    expect(w.spawned[0].argv).toContain(HISTORY_THREAD)
    expect(w.spawned[0].env).toEqual({ CODEX_HOME: '/recorded/source-home' })
    expect(savedState(w, key).historyArchived).toBe(undefined)
  })

for (const outcome of ['exit', 'throw'] as const) test(`session history archive ${outcome}: preserve the terminal result without replay`,
  { options: { archiveSessions: true } }, async ($, on) => {
    const w = historyWorld(on, 'exec', { stdout: historyOutput() }, outcome)
    const result = await step($, 'agent-codex')
    expect(handback(result.result)).toContain('PONG')
    expect(handback(result.result)).toContain('session archive failed; result preserved, no automatic retry')
    expect(w.history.length).toBe(1)
    expect(w.spawned.length).toBe(1)
    expect(savedState(w, 'agent:sess-1:agent-codex').historyArchived).toBe(undefined)
    expect(w.logs.some(l => l.includes('session archive') && l.includes('failed'))).toBe(true)
    expect(w.core).toEqual([])
  })

for (const resumeFails of [false, true]) test(`session history: unarchive failure ${resumeFails ? 'keeps a failed resume on its original thread' : 'allows an already active exact-ID resume'}`,
  { options: { archiveSessions: true } }, async ($, on) => {
    const key = 'agent:sess-1:agent-restarted'
    const w = historyWorld(on, 'exec', { task: 'follow-up', store: new Map([[key, { ...PERSISTED, thread: HISTORY_THREAD, historyArchived: true, updatedAt: 1_000_000 }]]),
      stdout: resumeFails ? '' : historyOutput(), code: resumeFails ? 1 : 0 }, 'exit')
    const result = await step($, 'agent-restarted')
    expect(w.history[0].argv).toEqual(['/usr/bin/env', 'CODEX_HOME=/home/t/.codex', 'codex', 'unarchive', '--', HISTORY_THREAD])
    expect(w.spawned.length).toBe(1)
    expect(w.spawned[0].argv.slice(1, 3)).toEqual(['exec', 'resume'])
    expect(w.spawned[0].argv).toContain(HISTORY_THREAD)
    expect(handback(result.result)).toContain(resumeFails ? 'codex failed: exit 1' : 'PONG')
    expect(w.history.map(c => c.argv[3])).toEqual(resumeFails ? ['unarchive'] : ['unarchive', 'archive'])
    expect(savedState(w, key).historyArchived).toBe(resumeFails ? true : undefined)
  })

for (const identity of ['missing', 'flag', 'changed'] as const) test(`session history excludes ${identity} source identity`,
  { options: { archiveSessions: true } }, async ($, on) => {
    const pieces = identity === 'missing' ? [MESSAGE('done')] : identity === 'flag' ? [THREAD('--all'), MESSAGE('done')]
      : [THREAD(HISTORY_THREAD), THREAD(HISTORY_OTHER), MESSAGE('done')]
    let conv: any[] = [user('first')]
    const w = historyWorld(on, 'exec', { pieces, messages: () => conv, storeSnapshots: true })
    const result = await step($, 'agent-codex')
    expect(handback(result.result)).toContain('done')
    expect(w.history).toEqual([])
    expect(w.spawned.length).toBe(1)
    if (identity === 'changed') {
      const key = 'agent:sess-1:agent-codex'
      expect(savedState(w, key).historyAmbiguous).toBe(true)
      conv = [...conv, ...toolResult('SubagentHandback'), user('follow-up')]
      await step($, 'agent-codex', 0, 'quarantined-follow-up')
      // A fresh agent/worker hydrates the same bounded record with its sticky
      // quarantine. The historical foreign ID never becomes archive authority.
      const compact = compactStoreState(savedState(w, key))
      expect(compact.historyAmbiguous).toBe(true)
      w.store.set('agent:sess-1:agent-restarted', compact)
      conv = [...conv, ...toolResult('SubagentHandback'), user('after reload')]
      await step($, 'agent-restarted', 0, 'quarantined-reload')
      expect(w.spawned.length).toBe(3)
      expect(w.history).toEqual([])
      expect(savedState(w, 'agent:sess-1:agent-restarted').historyAmbiguous).toBe(true)
    }
  })

test('session history: failed source process still archives only after its terminal result', { options: { archiveSessions: true } }, async ($, on) => {
  const w = historyWorld(on, 'exec', { stdout: historyOutput(), code: 1 })
  const result = await step($, 'agent-codex')
  expect(handback(result.result)).toContain('codex failed: exit 1')
  expect(handback(result.result)).toContain('PONG')
  expect(w.history.map(c => [c.argv[3], c.ended])).toEqual([['archive', 1]])
})

test('session history: an aborted source receives no cleanup command', { timeoutMs: 15000, options: { archiveSessions: true } }, async ($, on) => {
  const w = historyWorld(on, 'exec', { pieces: [THREAD(HISTORY_THREAD), cmdDone('/bin/zsh -lc pwd'), MESSAGE('not completed')] })
  on('turn.complete', () => ({ text: '' }))
  await step($, 'agent-abort')
  await $.turn.complete({ answer: '', durationMs: 1, isAborted: true, turnId: 'turn-1', agentId: 'agent-abort', reason: 'aborted' } as any)
  await new Promise<void>(r => setTimeout(() => r(), 300))
  expect(w.history).toEqual([])
  expect(w.kills.count).toBe(1)
})

test('session history: recovered mirror observation never owns archive or unarchive commands', { options: { archiveSessions: true, progressIntervalMs: 0 } }, async ($, on) => {
  const m = savedMirror()
  const w = historyWorld(on, 'exec', { task: m.token, store: mirrorStore(m, { historyArchived: true }),
    readFile: (path, text) => path.endsWith(`/events-${N_CHILD}.jsonl`) ? nestedJournal : path.endsWith('/owner.json') ? JSON.stringify({ generation: m.generation, ended: true }) : text })
  let final = ''
  for (let i = 0; i < 6; i++) {
    const result = await step($, m.host, i)
    if (result.result.toolUses.some(u => u.name === 'SubagentHandback')) { final = handback(result.result); break }
    await runCalls($, result.chunks, m.host)
  }
  expect(final).toContain('child checked the fixture')
  expect(w.history).toEqual([])
  expect(w.spawned).toEqual([])
})

test('app-server: session start checks node, the runner and codex app-server; a launch runs the runner with the same profile', { options: { transport: 'app-server', extraConfig: ['tools.view_image=false'] } }, async ($, on) => {
  const w = appWorld(on, { files: new Map([['/home/t/.codex/config.toml', CONFIG_TOML], ['.claude/codex-mod.json', PROJECT_ROLES]]), pieces: [THREAD('t-60'), TURN('tu-1'), MESSAGE('PONG'), USAGE] })
  await startSession($)
  expect(w.runs.map(r => (RUNNER_PATH.test(r[1] ?? '') ? ['node', 'RUNNER', ...r.slice(2)] : r).join(' '))).toEqual([
    'which codex', '/usr/local/bin/codex --version', '/usr/local/bin/codex login status',
    'which node', '/usr/local/bin/codex app-server --help', 'node RUNNER --version',
  ])
  expect(w.logs.some(l => l.includes('app-server transport ready'))).toBe(true)
  const { result } = await step($, 'agent-project')
  const argv = w.spawned[0]!.argv
  expect(argv[0]).toBe('/usr/local/bin/node')
  expect(argv[1]).toMatch(RUNNER_PATH)
  expect(argv.slice(2, 13)).toEqual(['run', '--codex', '/usr/local/bin/codex', '--cwd', '/tmp/project', '--model', 'gpt-6.1-sol', '--effort', 'medium', '--sandbox', 'workspace-write'])
  expect(argv).not.toContain('--thread')
  const configs = argv.filter((_, i) => argv[i - 1] === '--config')
  expect(configs).toContain('features.plugins=false')
  expect(configs).toContain('mcp_servers.node_repl.enabled=false')
  expect(configs).toContain('tools.view_image=false')
  expect(configs.some(c => c.startsWith('model_reasoning_effort'))).toBe(false)
  expect(argv.at(-2)).toBe('--control')
  expect(argv.at(-1)).toMatch(CONTROL)
  expect(w.spawned[0]!.input).toBe('Keep the change bounded.\n\nDo not spawn sub-agents.\n\nReply with the single word PONG')
  // the stale-dir guard removed the control dir before the launch
  expect(w.runs.some(r => r[0] === 'rm' && r[1] === '-rf' && r[2] === argv.at(-1))).toBe(true)
  expect(handback(result)).toBe('PONG\n\nimplementer · gpt-6.1-sol · medium · workspace-write · app-server · 0 actions · 277 new tokens (21K cached, 46 out) · thread t-60')
  expect(w.store.get('agent:sess-1:agent-project')).toMatchObject({ runSeq: 1, thread: 't-60' })
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
  expect(w.writes.map(x => x.path)).toEqual([`${control}/steer-000002.json`])
  expect(JSON.parse(w.writes[0].text)).toMatchObject({ text: 'Do not spawn sub-agents.\n\nalso add tests', expectedTurnId: 'tu-1' })
  // the control dir was created private before any steer file went into it
  expect(w.runs.some(r => r[0] === 'mkdir' && r.slice(1, 4).join(' ') === '-p -m 700' && r.includes('/home/t/.cache/codex-mod/runs') && r.at(-1) === control)).toBe(true)
  // the status note precedes Codex's answer without repeating the message
  expect(handback(s2.result).split('\n\n').slice(0, 2)).toEqual([steerNote('accepted'), 'built, with tests'])
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
  expect(handback(s2.result).split('\n\n').slice(0, 2)).toEqual(['↪ Queued after turn tu-1 · turn finished', 'built'])
  expect(w.logs.some(l => l.includes('steer 2 rejected; queued after turn'))).toBe(true)
  opts.pieces = [THREAD('t-63'), TURN('tu-2'), MESSAGE('linted')]
  conv = [...conv, ...toolResult('SubagentHandback', 'hb')]
  const s3 = await step($, 'agent-app-reject', 2)
  expect(w.spawned.length).toBe(2)
  const argv = w.spawned[1]!.argv
  expect(argOf(argv, '--thread')).toBe('t-63')
  expect(w.spawned[1]!.input).toBe('Do not spawn sub-agents.\n\n' + 'also lint')
  // each run gets its own control dir
  expect(argv.at(-1)).not.toBe(w.spawned[0]!.argv.at(-1))
  expect(argv.at(-1)!.endsWith('-2')).toBe(true)
  expect(handback(s3.result).startsWith('linted')).toBe(true)
})

test('app-server steer: a steer the runner never acked stays unknown without relaunch', { options: { transport: 'app-server' } }, async ($, on) => {
  let conv: any[] = [user('first')]
  const opts: WorldOpts = { messages: () => conv, pieces: [THREAD('t-64'), TURN('tu-1'), cmdDone('/bin/zsh -lc make'), MESSAGE('built')] }
  const w = appWorld(on, opts)
  const s1 = await step($, 'agent-app-unacked', 0)
  await runCalls($, s1.chunks, 'agent-app-unacked')
  conv = [...conv, ...toolResult('Bash', 'toolu_codexmod_u'), user('and docs')]
  const s2 = await step($, 'agent-app-unacked', 1)
  expect(w.writes.length).toBe(1)
  expect(handback(s2.result)).toContain('message outcome unknown; no automatic retry or relaunch')
  expect(lastLine(handback(s2.result))).not.toContain('steer')
  opts.pieces = [THREAD('t-64'), TURN('tu-2'), MESSAGE('documented')]
  conv = [...conv, ...toolResult('SubagentHandback', 'hb')]
  await step($, 'agent-app-unacked', 2)
  expect(w.spawned.length).toBe(1)
  expect((Object.values(savedState(w, 'agent:sess-1:agent-app-unacked').coordinator.outcomes)[0] as any).status).toBe('unknown')
})

test('app-server mid-step: while a step waits on the runner, a new message is steered within that same step', { timeoutMs: 15000, options: { transport: 'app-server' } }, async ($, on) => {
  let conv: any[] = [user('long task')]
  let w: ReturnType<typeof appWorld>
  const steered = () => w.writes.some(x => x.path.endsWith('/steer-000002.json'))
  w = appWorld(on, { files: new Map([['.claude/codex-mod.json', PROJECT_ROLES]]), messages: () => conv, pieces: [THREAD('t-65'), TURN('tu-1'), steered, ACK(2, 'accepted'), MESSAGE('done, steered'), USAGE] })
  await startSession($)
  const pending = step($, 'agent-project', 0)
  await new Promise<void>(r => setTimeout(r, 60))
  conv = [...conv, user('change of plan')]
  const { result } = await pending
  expect(w.timers.filter(ms => ms === 2000).length >= 1).toBe(true)
  expect(w.spawned[0]!.input).toBe('Keep the change bounded.\n\nDo not spawn sub-agents.\n\nlong task')
  expect(w.writes.map(x => JSON.parse(x.text))).toMatchObject([{ text: 'Keep the change bounded.\n\nDo not spawn sub-agents.\n\nchange of plan' }])
  // the pull that was pending when the checks ran was read on, nothing lost; the
  // accepted steer is announced before Codex's answer
  expect(handback(result).startsWith(`${steerNote('accepted')}\n\ndone, steered`)).toBe(true)
  expect(lastLine(handback(result))).toContain('app-server · 1 steer · 0 actions')
  expect(w.spawned.length).toBe(1)
})

test('app-server, nativeActions off: the accepted steer\'s note streams as text; the handback keeps Codex\'s answer', { timeoutMs: 15000, options: { transport: 'app-server', nativeActions: false } }, async ($, on) => {
  let conv: any[] = [user('long task')]
  let w: ReturnType<typeof appWorld>
  let delivered = false
  const steered = () => {
    // Deliver only after the fake child reaches its wait: a wall-clock delay
    // can otherwise replace the initial task before the hook has read it.
    if (!delivered) {
      delivered = true
      conv = [...conv, user('codex-model: gpt-6-astra\nchange of plan, use the other parser')]
    }
    return w.writes.some(x => x.path.endsWith('/steer-000002.json'))
  }
  w = appWorld(on, { messages: () => conv, pieces: [THREAD('t-69'), TURN('tu-1'), cmdDone('/bin/zsh -lc make'), steered, ACK(2, 'accepted'), MESSAGE('done'), USAGE] })
  const { chunks, result } = await step($, 'agent-app-plain-steer', 0)
  expect(chunks.filter(c => c.kind === 'text').map(c => c.text)).toEqual(['$ make', `\n\n${steerNote('accepted')}`])
  expect(result.toolUses.map((u: any) => u.name)).toEqual(['SubagentHandback'])
  expect(handback(result).startsWith('done\n\n')).toBe(true)
  expect(lastLine(handback(result))).toContain('app-server · 1 steer · 1 action')
})

test('app-server: a coordinator delivery appended as an attachment mid-step is steered within that step; the first message is not relaunched', { timeoutMs: 15000, options: { transport: 'app-server' } }, async ($, on) => {
  let conv: any[] = [user('long task')]
  let w: ReturnType<typeof appWorld>
  const steered = () => w.writes.some(x => x.path.endsWith('/steer-000001-row-7.json'))
  w = appWorld(on, { messages: () => conv, pieces: [THREAD('t-70'), TURN('tu-1'), steered, out('{"type":"codexmod.steer","id":"000001-row-7","status":"accepted"}'), MESSAGE('steered, done'), USAGE] })
  const pending = step($, 'agent-app-deliver', 0)
  await new Promise<void>(r => setTimeout(r, 60))
  await $.session.append(deliveryRow('agent-app-deliver', 'row-7', 'codex-effort: high\nchange of plan'))
  const { result } = await pending
  const control = w.spawned[0]!.argv.at(-1)!
  expect(w.writes.map(x => x.path)).toEqual([`${control}/steer-000001-row-7.json`])
  expect(JSON.parse(w.writes[0].text)).toMatchObject({ text: 'Do not spawn sub-agents.\n\nchange of plan', messageId: 'row-7' })
  expect(handback(result).split('\n\n').slice(0, 2)).toEqual([steerNote('accepted'), 'steered, done'])
  expect(lastLine(handback(result))).toContain('app-server · 1 steer · 0 actions')
  expect(w.store.get('agent:sess-1:agent-app-deliver')).toMatchObject({ lastTask: 'long task', userCount: 1, launchKey: '1:codex-effort: high\nchange of plan' })
  expect((w.store.get('agent:sess-1:agent-app-deliver') as any).followUps).toBe(undefined)
  // the handback's result ends the turn; nothing launches again
  conv = [...conv, ...toolResult('SubagentHandback', 'hb')]
  const s2 = await step($, 'agent-app-deliver', 1)
  expect(s2.result.stopReason).toBe('end_turn')
  conv = [...conv, said('x'), meta(LIVE_NO_OUTPUT)]
  await step($, 'agent-app-deliver', 2)
  expect(w.spawned.length).toBe(1)
  expect(w.modelCalls).toEqual([])
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
  const inspected: string[] = []
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
    { name: 'state-stale', kind: 'dir' as const, size: 0, mtimeMs: 0, isLink: false },
    { name: 'state-active', kind: 'dir' as const, size: 0, mtimeMs: 0, isLink: false },
    { name: 'stray.txt', kind: 'file' as const, size: 1, mtimeMs: 0, isLink: false },
  ] }))
  on('fs.stat', (_$, e: any) => {
    inspected.push(e.path)
    const stale = e.path.endsWith('/old') || e.path.endsWith('/state-stale/record.json') || e.path.endsWith('/state-active')
    return { value: { kind: 'dir' as const, size: 0, isLink: false, mtimeMs: stale ? 1_000_000 - 3 * 86_400_000 : 1_000_000 - 1000 } }
  })
  await startSession($)
  expect(removed).toEqual([`${runs}/old`, `${runs}/state-stale`])
  expect(inspected).toContain(`${runs}/state-active/record.json`)
})

// ---- Phase 3 item rendering and display-only guards ------------------------

const itemLine = (item: Record<string, unknown>, type = 'item.completed') => JSON.stringify({ type, item })
const itemPiece = (item: Record<string, unknown>, type = 'item.completed') => out(itemLine(item, type))
const webItem = { type: 'web_search', query: 'example docs', action: { type: 'search', query: 'example docs' }, results: [{ type: 'text_result', title: 'Example docs', url: 'https://example.test/docs', snippet: 'A reference.' }] }
const mcpItem = { type: 'mcp_tool_call', server: 'docs', tool: 'lookup', arguments: { topic: 'options' }, result: { content: [{ type: 'text', text: 'Found options.' }] }, error: null, status: 'completed' }
const planItem = { type: 'plan_update', explanation: 'Verify', steps: [{ step: 'Inspect', status: 'completed' }, { step: 'Test', status: 'inProgress' }, { step: 'Report', status: 'pending' }] }

test('phase 3 parser: real-shaped exec lines, repeated id keys, completed searches only', async () => {
  expect(parseCodexLine('{"type":"item.started","item":{"id":"item_1","type":"web_search","id":"exec-1","query":"","action":{"type":"other"}}}')).toEqual({ kind: 'other' })
  const event: any = parseCodexLine('{"type":"item.completed","item":{"id":"item_1","type":"web_search","id":"exec-1","query":"example docs","action":{"type":"search","query":"example docs"},"results":[{"type":"text_result","title":"Docs","url":"https://example.test","snippet":"Reference"}]}}')
  expect(event.kind).toBe('action')
  expect(event.action.tool).toBe('WebSearch')
  expect(event.action.input).toEqual({ query: 'example docs', mode: 'standard' })
  expect(event.action.result.results[0].content).toEqual([{ title: 'Docs', url: 'https://example.test', snippet: 'Reference' }])
  for (const [action, query] of [
    [{ type: 'openPage', url: 'https://example.test' }, 'https://example.test'],
    [{ type: 'findInPage', pattern: 'flags', url: 'https://example.test' }, 'flags in https://example.test'],
  ] as const) {
    const ev: any = parseCodexLine(itemLine({ type: 'web_search', action, query: '', results: { unexpected: true } }))
    expect(ev.display).toBe('codex_tool')
    expect(ev.action.input).toEqual({ server: 'web', name: action.type, arguments: { query: '', action } })
    expect(ev.action.result[0].text).toContain('unexpected')
  }
  const encoded: any = parseCodexLine(itemLine({ ...webItem, results: JSON.stringify(webItem.results) }))
  expect(encoded.action.result.results[0].content[0].title).toBe('Example docs')
})

test('display result validator mirrors the registered-tool union', async () => {
  for (const result of [[], [{ type: 'text', text: 'ok' }]]) expect(validDisplayResult(result)).toBe(true)
  for (const result of [undefined, 'ok', null, {}, { content: [{ type: 'text', text: 'ok' }] }, [null], [{ type: 'text', text: 1 }], [{ type: 'image', text: 'ok' }]]) expect(validDisplayResult(result)).toBe(false)
})

test('phase 3 parser: summary only, MCP/dynamic text and errors, TODO updates, plans and notes', async () => {
  expect(parseCodexLine(itemLine({ type: 'reasoning', text: 'Check evidence.', content: ['PRIVATE'] }))).toEqual({ kind: 'thinking', text: 'Check evidence.' })
  expect(parseCodexLine(itemLine({ type: 'reasoning', summary: ['Public summary'], content: ['PRIVATE'] }))).toEqual({ kind: 'thinking', text: 'Public summary' })
  expect(parseCodexLine(itemLine({ type: 'reasoning', content: ['PRIVATE'] }))).toEqual({ kind: 'other' })
  expect(parseCodexLine(itemLine({ type: 'reasoning', summary: [], text: 'PRIVATE' }))).toEqual({ kind: 'other' })
  const mcp: any = parseCodexLine(itemLine(mcpItem))
  expect(mcp).toMatchObject({ kind: 'action', display: 'codex_tool', action: { input: { server: 'docs', name: 'lookup', arguments: { topic: 'options' } } } })
  expect(mcp.action.result[0].text).toContain('Found options.')
  const failed: any = parseCodexLine(itemLine({ ...mcpItem, status: 'failed', result: null, error: { message: 'Unavailable' } }))
  expect(failed.action.error).toContain('Unavailable')
  const dynamic: any = parseCodexLine(itemLine({ type: 'dynamic_tool_call', namespace: 'local', tool: 'inspect', arguments: [1], success: false, content_items: [{ type: 'inputText', text: 'Failed' }, { type: 'inputImage', imageUrl: 'PRIVATE_IMAGE' }] }))
  expect(dynamic).toMatchObject({ display: 'codex_tool', action: { input: { server: 'local', name: 'inspect', arguments: [1] } } })
  expect(dynamic.action.error).toContain('Failed')
  expect(dynamic.action.result[0].text).toContain('inputImage')
  expect(dynamic.action.result[0].text).toContain('omitted')
  expect(dynamic.action.result[0].text.includes('PRIVATE_IMAGE')).toBe(false)
  for (const type of ['item.started', 'item.updated', 'item.completed']) {
    expect(parseCodexLine(itemLine({ type: 'todo_list', items: [{ text: 'Inspect', completed: true }, { text: 'Test', completed: false }] }, type))).toMatchObject({ display: 'codex_plan', action: { result: [{ type: 'text', text: planText({ steps: [{ step: 'Inspect', status: 'completed' }, { step: 'Test', status: 'pending' }] }) }], input: { steps: [{ step: 'Inspect', status: 'completed' }, { step: 'Test', status: 'pending' }] } } })
  }
  expect(parseCodexLine(itemLine(planItem, 'item.updated'))).toMatchObject({ display: 'codex_plan', action: { result: [{ type: 'text', text: planText({ explanation: 'Verify', steps: [{ step: 'Inspect', status: 'completed' }, { step: 'Test', status: 'in_progress' }, { step: 'Report', status: 'pending' }] }) }], input: { explanation: 'Verify', steps: [{ step: 'Inspect', status: 'completed' }, { step: 'Test', status: 'in_progress' }, { step: 'Report', status: 'pending' }] } } })
  expect(parseCodexLine(itemLine({ type: 'proposed_plan', text: 'Do the work.' }))).toEqual({ kind: 'interim', text: 'Proposed plan:\nDo the work.' })
  expect(parseCodexLine(itemLine({ type: 'note', text: 'Codex compacted context', dim: true }))).toEqual({ kind: 'note', text: '↪ Codex compacted context', dim: true })
  expect(parseCodexLine(itemLine({ type: 'agent_message', phase: 'commentary', text: 'Working.' }))).toEqual({ kind: 'interim', text: 'Working.' })
  expect(parseCodexLine(itemLine({ type: 'agent_message', text: 'Exec answer.' }))).toEqual({ kind: 'message', text: 'Exec answer.' })
  expect(parseCodexLine(itemLine({ type: 'error', message: 'Configuration notice' }))).toEqual({ kind: 'warning', text: 'Configuration notice' })
})

test('phase 3 parser: full collaboration fallback and waits without state transitions', () => {
  const spawn = { type: 'collab_tool_call', tool: 'spawn_agent', prompt: 'Inspect tests.\nReport back.', receiver_thread_ids: ['child-1'] }
  for (const tool of ['spawn_agent', 'send_input', 'sendMessage']) {
    const ev: any = parseCodexLine(itemLine({ ...spawn, tool }))
    expect(ev.display).toBe('codex_tool')
    expect(ev.action.input.arguments.prompt).toBe(spawn.prompt)
    expect(ev.action.result[0].text).toContain('richRows disabled')
  }
  expect(parseCodexLine(itemLine({ ...spawn, tool: 'wait' }))).toEqual({ kind: 'other' })
})

test('phase 3 steps use returned registered names; own calls are answered and counted, never executed', async ($, on) => {
  const events = [
    { type: 'reasoning', text: 'Check the evidence.', content: ['PRIVATE'] },
    { type: 'agent_message', phase: 'commentary', text: 'Checking sources.' },
    webItem, mcpItem, planItem,
    { type: 'dynamic_tool_call', namespace: 'local', tool: 'inspect', arguments: {}, success: false, content_items: [{ type: 'inputText', text: 'Inspection failed.' }] },
    { type: 'proposed_plan', text: '1. Verify' },
    { type: 'collab_tool_call', tool: 'spawn_agent', prompt: 'Inspect\ntests', receiver_thread_ids: ['child-1'] },
    { type: 'collab_tool_call', tool: 'send_input', receiver_thread_ids: ['child-1'] },
    { type: 'collab_tool_call', tool: 'wait', receiver_thread_ids: ['child-1'] },
    { type: 'note', text: 'Codex agent reviewer finished' },
    { type: 'note', text: 'Codex compacted context', dim: true },
    { type: 'agent_message', phase: 'final_answer', text: 'Verified.' },
  ]
  const w = world(on, { toolNamespace: 'runtime', pieces: [THREAD('phase3'), out(events.map(i => itemLine(i)).join('\n'))] })
  const registered: any[] = []
  on('agent.register', (_$, e: any) => {
    if (e.name !== 'codex-child') registered.push(e)
    return { value: { agent: `codex-mod:${e.name}` } }
  })
  await $.session.start?.({ cwd: '/tmp/project', surface: null, isInteractive: false })
  expect(registered.length).toBe(1)
  expect(registered[0].tools).toEqual(['Bash', 'Edit', 'Write', 'WebSearch', 'Agent', 'mcp__runtime__codex_tool', 'mcp__runtime__codex_plan', 'mcp__runtime__coordinator_message', 'mcp__runtime__codex_question'])
  const first = await step($, 'agent-progress')
  expect(first.chunks[0]).toEqual({ kind: 'thinking', index: 0, text: 'Check the evidence.' })
  expect(first.chunks[1]).toEqual({ kind: 'text', index: 1, text: 'Checking sources.' })
  expect(callsOf(first.chunks).map(c => c.name)).toEqual(['WebSearch', 'mcp__runtime__codex_tool', 'mcp__runtime__codex_plan', 'mcp__runtime__codex_tool', 'mcp__runtime__codex_tool', 'mcp__runtime__codex_tool'])
  expect(callsOf(first.chunks)[1].input).toEqual({ server: 'docs', name: 'lookup', arguments: { topic: 'options' } })
  expect(callsOf(first.chunks)[3].input).toEqual({ server: 'local', name: 'inspect', arguments: {} })
  const results: any[] = await runCalls($, first.chunks, 'agent-progress')
  expect(results[0].result.results[0].content[0].url).toBe('https://example.test/docs')
  expect(results[1].result[0].text).toContain('Found options.')
  expect(results[2]).toEqual({ result: [{ type: 'text', text: planText({ explanation: 'Verify', steps: [{ step: 'Inspect', status: 'completed' }, { step: 'Test', status: 'in_progress' }, { step: 'Report', status: 'pending' }] }) }] })
  expect(results[3].deny).toContain('Inspection failed.')
  const second = await step($, 'agent-progress', 1)
  const texts = second.chunks.filter(c => c.kind === 'text').map(c => c.text).join('\n')
  expect(first.chunks.filter(c => c.kind === 'text').map(c => c.text).join('\n')).toContain('Proposed plan:\n1. Verify')
  expect(texts).toContain('↪ Codex compacted context')
  expect(handback(second.result)).toContain('Verified.')
  expect(results[4].result[0].text).toContain('spawn_agent')
  expect(results[5].result[0].text).toContain('send_input')
  expect(handback(second.result)).toContain('↪ Codex agent reviewer finished')
  expect(handback(second.result)).toContain('6 actions')
  expect(handback(second.result)).not.toContain('Checking sources.')
  expect(handback(second.result)).not.toContain('Proposed plan:')
  expect(JSON.stringify([first, second])).not.toContain('PRIVATE')
  expect(w.core).toEqual([])
  expect(w.checks).toEqual([])
})

test('phase 3 reasoning shares paced action steps and the final step, never creating a step', { options: { progressIntervalMs: 250, maxActionsPerStep: 1 } }, async ($, on) => {
  const items = [{ type: 'reasoning', text: 'First summary' }, webItem, { type: 'reasoning', text: 'Second summary' }, webItem, { type: 'reasoning', text: 'Final summary' }, { type: 'agent_message', text: 'Done' }]
  const w = world(on, { pieces: [out(items.map(i => itemLine(i)).join('\n'))] })
  for (let i = 0; i < 2; i++) {
    const s = await step($, 'agent-throttle', i)
    expect(s.chunks[0]).toMatchObject({ kind: 'thinking', text: i === 0 ? 'First summary' : 'Second summary' })
    expect(callsOf(s.chunks).map(c => c.name)).toEqual(['WebSearch'])
    await runCalls($, s.chunks, 'agent-throttle')
  }
  const final = await step($, 'agent-throttle', 2)
  expect(final.chunks[0]).toMatchObject({ kind: 'thinking', text: 'Final summary' })
  expect(callsOf(final.chunks).map(c => c.name)).toEqual(['SubagentHandback'])
  expect(w.sleeps).toEqual([250])
  expect(w.core).toEqual([])
})

test('phase 3 reasoning and commentary alone finish without manufacturing a final answer', async ($, on) => {
  world(on, { pieces: [itemPiece({ type: 'reasoning', text: 'Summary' }), itemPiece({ type: 'agent_message', phase: 'commentary', text: 'Still working' })] })
  const s = await step($, 'agent-progress')
  expect(s.chunks[0]).toMatchObject({ kind: 'thinking', text: 'Summary' })
  expect(s.chunks[1]).toMatchObject({ kind: 'text', text: 'Still working' })
  expect(handback(s.result)).toContain('codex failed: no agent message')
  expect(handback(s.result)).not.toContain('Still working')
})

test('phase 3 nativeActions false degrades new items into text in one step', { options: { nativeActions: false, handbackMode: 'text' } }, async ($, on) => {
  const w = world(on, { pieces: [
    itemPiece({ type: 'reasoning', text: 'Check evidence', content: ['PRIVATE'] }),
    itemPiece({ type: 'agent_message', phase: 'commentary', text: 'Working.' }),
    itemPiece(webItem), itemPiece(mcpItem), itemPiece(planItem),
    itemPiece({ type: 'dynamic_tool_call', namespace: 'local', tool: 'inspect', arguments: {}, success: true, content_items: [] }),
    itemPiece({ type: 'proposed_plan', text: 'Verify it.' }),
    itemPiece({ type: 'note', text: 'Codex compacted context', dim: true }), MESSAGE('Done.'),
  ] })
  const s = await step($, 'agent-plain')
  expect(callsOf(s.chunks)).toEqual([])
  expect(s.chunks.some(c => c.kind === 'thinking')).toBe(false)
  expect(s.result.answer).toContain('Check evidence')
  expect(s.result.answer).toContain('Searched by Codex: example docs')
  expect(s.result.answer).toContain('Codex called docs.lookup')
  expect(s.result.answer).toContain('Codex called local.inspect')
  expect(s.result.answer).toContain('Verify\nCodex plan (display only):\n[x] Inspect\n[-] Test\n[ ] Report')
  expect(s.result.answer).toContain('Proposed plan:\nVerify it.')
  expect(s.result.answer).toContain('↪ Codex compacted context')
  expect(s.result.answer).toContain('Done.')
  expect(s.result.answer).toContain('4 actions')
  expect(s.result.answer).not.toContain('PRIVATE')
  expect(w.core).toEqual([])
})

test('phase 3 safety: WebSearch and registered display tools refuse foreign ids, owners and replay; tool.check always denies', async ($, on) => {
  const w = world(on, { pieces: [out([webItem, mcpItem, planItem].map(i => itemLine(i)).join('\n')), MESSAGE('Done')] })
  const s = await step($, 'agent-progress')
  for (const c of callsOf(s.chunks)) {
    for (const agentId of [undefined, 'agent-gp', 'agent-progress']) {
      const foreign: any = await $.tool.call({ tool: c.name, ...c.input, tool_use_id: 'foreign', ...(agentId ? { agentId } : {}) } as any)
      if (c.name === 'WebSearch' && agentId !== 'agent-progress') continue // other models keep their real search tool
      expect(foreign.deny).toContain('not executed')
      const check: any = await $.tool.check({ tool: c.name, input: c.input, tool_use_id: 'foreign', ...(agentId ? { agentId } : {}) } as any)
      expect(check.decision).toBe('deny')
    }
    const stolen: any = await $.tool.call({ tool: c.name, ...c.input, tool_use_id: c.id } as any)
    expect(stolen.deny).toContain('not executed')
    const backstop: any = await $.tool.check({ tool: c.name, input: c.input, tool_use_id: c.id, agentId: 'agent-progress' } as any)
    expect(backstop.decision).toBe('deny')
    const own: any = await $.tool.call({ tool: c.name, ...c.input, tool_use_id: c.id, agentId: 'agent-progress' } as any)
    assertDisplayAnswer(c.name, own)
    expect(own.result).toBeDefined()
    const replay: any = await $.tool.call({ tool: c.name, ...c.input, tool_use_id: c.id, agentId: 'agent-progress' } as any)
    expect(replay.deny).toContain('not executed')
  }
  expect(w.core.map(c => c.tool)).toEqual(['WebSearch', 'WebSearch'])
  expect(w.checks).toEqual([])
})

test('phase 3 safety: every guard exception denies, including main-model registered calls', async () => {
  const guards = new Map<string, { handler: any; catcher: any }>()
  codexRegister(((name: string, ...args: any[]) => {
    const entry = { handler: args.at(-1), catcher: undefined as any }
    guards.set(name, entry)
    return { catch: (handler: any) => { entry.catcher = handler } }
  }) as any, {})
  const $ = { agent: { list: async () => { throw new Error('Cannot resolve agent') } } }
  for (const tool of ['Bash', 'Edit', 'Write', 'WebSearch', 'Agent', 'TodoWrite', 'mcp__codex-mod__codex_tool', 'mcp__codex-mod__codex_plan', 'mcp__codex-mod__coordinator_message', 'mcp__codex-mod__codex_question']) {
    for (const name of ['tool.call', 'tool.check']) {
      const guard = guards.get(name)!
      const e = { tool, agentId: 'unresolved-phase3-agent', tool_use_id: 'foreign' }
      let reachedNext = false
      const next: any = () => { reachedNext = true; throw new Error('Must not run') }
      next.called = false
      // Simulate an engine timeout/re-entry: the .catch must cover every protected tool.
      const result = guard.catcher($, e, next)
      expect(name === 'tool.call' ? result.deny : result.decision).toBe(name === 'tool.call' ? 'codex-mod: not executed' : 'deny')
      expect(reachedNext).toBe(false)
      if (!tool.startsWith('mcp__')) {
        let failed = false
        try { await guard.handler($, e, next) } catch { failed = true }
        expect(failed).toBe(true)
      } else {
        const main = { tool, tool_use_id: 'foreign' }
        const denied = guard.catcher($, main, next)
        expect(name === 'tool.call' ? denied.deny : denied.decision).toBe(name === 'tool.call' ? 'codex-mod: not executed' : 'deny')
      }
    }
  }
})

test('phase 3 display inputs keep nested arguments out of the host envelope and answer by dispatch name', async ($, on) => {
  const arguments_ = { tool: 'Bash', tool_use_id: 'foreign', agentId: 'agent-gp', requestMeta: { spoofed: 'yes' }, input: {}, consent: 'spoofed', ceiling: 'allow' }
  const w = world(on, { pieces: [itemPiece({ ...mcpItem, arguments: arguments_ }), MESSAGE('Done')] })
  const s = await step($, 'agent-progress')
  const [call] = callsOf(s.chunks)
  expect(call.input).toEqual({ server: 'docs', name: 'lookup', arguments: arguments_ })
  const envelope = { tool: call.name, ...call.input, tool_use_id: call.id, agentId: 'agent-progress' }
  expect(envelope.tool).toBe('mcp__codex-mod__codex_tool')
  expect(envelope.tool_use_id).toBe(call.id)
  expect(envelope.agentId).toBe('agent-progress')
  const [result] = await runCalls($, s.chunks, 'agent-progress')
  expect(result.result[0].text).toContain('Found options.')
  expect(w.core).toEqual([])
  expect(w.checks).toEqual([])
})

// ---- Experimental rich rows ----------------------------------------------

const spawnItem = {
  type: 'collab_tool_call', tool: 'spawn_agent', prompt: 'Inspect the tests.\nReport findings.',
  receiver_thread_ids: ['child-1'], agents_states: { 'child-1': { name: 'reviewer', status: 'running' } },
  status: 'completed', model: 'gpt-6.1-sol',
}

// The completed branch of the host's output union, including every required field.
const spawnResult: Extract<BuiltinToolResults['Agent'], { status: 'completed' }> = {
  agentId: 'codex-display-sess-1-child-1', agentType: 'codex-mod:codex', status: 'completed',
  prompt: spawnItem.prompt, canContinueAgent: false, resolvedModel: 'gpt-6.1-sol',
  content: [{ type: 'text', text: 'Codex spawn returned; child child-1: running. Model gpt-6.1-sol. Display-only host operation: zero Claude tools, tokens and duration; Codex child usage and duration unreported. Child transcript unavailable; no host child task exists.' }],
  totalToolUseCount: 0, totalDurationMs: 0, totalTokens: 0,
  usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: null, cache_read_input_tokens: null, server_tool_use: null, service_tier: null, cache_creation: null },
}

test('richRows is opt-in and rejects non-boolean options', () => {
  expect(parseConfig({}).richRows).toBe(false)
  expect(parseConfig({ richRows: true })).toMatchObject({ richRows: true, warnings: [] })
  expect(parseConfig({ richRows: 'true' })).toMatchObject({ richRows: false, warnings: ['richRows: not a boolean; default used'] })
})

test('rich parser: completed spawn call and failure use different result paths', () => {
  const ev: any = parseCodexLine(itemLine(spawnItem), true)
  expect(ev.action.input).toEqual({ description: 'Codex spawn: Inspect the tests. Report findings.', prompt: spawnItem.prompt, subagent_type: 'codex-mod:codex' })
  expect(ev.action.result).toEqual({ ...spawnResult, agentId: 'codex-display-unreported-child-1' })
  for (const status of ['failed', 'declined']) {
    const failed: any = parseCodexLine(itemLine({ ...spawnItem, status }), true)
    expect(failed.action.result).toEqual({})
    expect(failed.action.error).toContain(status)
    expect(validAction(failed.action)).toBe(true)
  }
  for (const type of ['item.started', 'item.updated']) expect(parseCodexLine(itemLine(spawnItem, type), true)).toEqual({ kind: 'other' })
})

test('rich parser: exec todos and normalized app-server plan updates use required TodoWrite fields', () => {
  const todos = [
    { content: 'Inspect', status: 'completed', activeForm: 'Inspect' },
    { content: 'Test', status: 'pending', activeForm: 'Test' },
  ]
  for (const type of ['item.started', 'item.updated', 'item.completed']) {
    expect(parseCodexLine(itemLine({ type: 'todo_list', items: [{ text: 'Inspect', completed: true }, { text: 'Test', completed: false }] }, type), true, true)).toEqual({
      kind: 'action', action: {
        tool: 'TodoWrite', input: { todos }, result: { oldTodos: [], newTodos: todos },
      },
    })
  }
  const app: any = parseCodexLine(itemLine({ ...planItem, steps: [...planItem.steps, { step: 'Other', status: 'unknown' }, { step: 'Working', status: 'in_progress' }] }, 'item.updated'), true, true)
  expect(app.action.input).toEqual({ todos: [
    { content: 'Inspect', status: 'completed', activeForm: 'Inspect' },
    { content: 'Test', status: 'in_progress', activeForm: 'Test' },
    { content: 'Report', status: 'pending', activeForm: 'Report' },
    { content: 'Other', status: 'pending', activeForm: 'Other' },
    { content: 'Working', status: 'in_progress', activeForm: 'Working' },
  ] })
})

for (const [richRows, available] of [[false, false], [false, true], [true, false], [true, true]] as const) {
  test(`richRows ${richRows}, TodoWrite available ${available}: generic and project tools respect both switches`, { options: { richRows } }, async ($, on) => {
    const w = world(on, { files: new Map([['.claude/codex-mod.json', PROJECT_ROLES]]), availableTools: available ? ['Agent', 'TodoWrite'] : ['Agent'] })
    const specs: any[] = []
    on('agent.register', (_$, e: any) => {
      if (e.name !== 'codex-child') specs.push(e)
      return { value: { agent: `codex-mod:${e.name}` } }
    })
    await startSession($)
    expect(specs.map(s => s.name)).toEqual(['codex', 'implementer', 'implementer-high', 'auditor'])
    for (const s of specs) {
      expect(s.tools.includes('Agent')).toBe(true)
      expect(s.tools.includes('TodoWrite')).toBe(richRows && available)
    }
    expect(w.toolLists.length).toBe(1)
  })
}

for (const toolListThrows of [false, true]) {
  test(`rich plans fall back to codex_plan when TodoWrite ${toolListThrows ? 'availability fails' : 'is absent'}`, { options: { richRows: true } }, async ($, on) => {
    const todo = { type: 'todo_list', items: [{ text: 'Inspect', completed: true }, { text: 'Test', completed: false }] }
    const w = world(on, { availableTools: ['Agent'], toolListThrows, pieces: [out([spawnItem, todo, planItem, { type: 'agent_message', text: 'Done.' }].map(i => itemLine(i)).join('\n'))] })
    const specs: any[] = []
    on('agent.register', (_$, e: any) => {
      if (e.name !== 'codex-child') specs.push(e)
      return { value: { agent: `codex-mod:${e.name}` } }
    })
    await startSession($)
    expect(w.toolLists).toEqual([['Agent']])
    expect(specs.length).toBe(1)
    expect(specs[0].tools.includes('Agent')).toBe(!toolListThrows)
    expect(specs[0].tools.includes('TodoWrite')).toBe(false)
    const first = await step($, 'agent-progress')
    const calls = callsOf(first.chunks)
    expect(calls.map(c => c.name)).toEqual([toolListThrows ? 'mcp__codex-mod__codex_tool' : 'Agent', 'mcp__codex-mod__codex_plan', 'mcp__codex-mod__codex_plan'])
    expect(calls[1].input).toEqual({ steps: [{ step: 'Inspect', status: 'completed' }, { step: 'Test', status: 'pending' }] })
    expect(calls[2].input).toEqual({ explanation: 'Verify', steps: [{ step: 'Inspect', status: 'completed' }, { step: 'Test', status: 'in_progress' }, { step: 'Report', status: 'pending' }] })
    const results: any[] = await runCalls($, first.chunks, 'agent-progress')
    if (toolListThrows) expect(results[0].result[0].text).toContain('unavailable')
    else expect(results[0].result).toEqual(spawnResult)
    expect(results.slice(1)).toEqual([
      { result: [{ type: 'text', text: planText({ steps: [{ step: 'Inspect', status: 'completed' }, { step: 'Test', status: 'pending' }] }) }] },
      { result: [{ type: 'text', text: planText({ explanation: 'Verify', steps: [{ step: 'Inspect', status: 'completed' }, { step: 'Test', status: 'in_progress' }, { step: 'Report', status: 'pending' }] }) }] },
    ])
    const final = await step($, 'agent-progress', 1)
    expect(handback(final.result)).toContain('3 actions')
    expect(w.logs.some(l => l.includes('tool availability unknown'))).toBe(toolListThrows)
    expect(w.core).toEqual([])
    expect(w.checks).toEqual([])
  })
}

test('rich rows are guarded, counted and refuse foreign ids, owners, tools and replays', { options: { richRows: true } }, async ($, on) => {
  // No final newline exercises the EOF parser as well as ordinary line ingestion.
  const w = world(on, { stdout: [itemLine(spawnItem), itemLine({ type: 'agent_message', text: 'Done.' }), itemLine(planItem, 'item.updated')].join('\n') })
  on('agent.register', (_$, e: any) => ({ value: { agent: `codex-mod:${e.name}` } }))
  await startSession($)
  const first = await step($, 'agent-progress')
  expect(callsOf(first.chunks).map(c => c.name)).toEqual(['Agent'])
  const results: any[] = []
  for (let index = 0; index < 2; index++) {
    // The unterminated plan line is parsed when the next step observes EOF.
    const s = index === 0 ? first : await step($, 'agent-progress', index)
    const [c] = callsOf(s.chunks)
    expect(c.name).toBe(index === 0 ? 'Agent' : 'TodoWrite')
    expect(c.input).toEqual(index === 0
      ? { description: 'Codex spawn: Inspect the tests. Report findings.', prompt: spawnItem.prompt, subagent_type: 'codex-mod:codex' }
      : { todos: [
        { content: 'Inspect', status: 'completed', activeForm: 'Inspect' },
        { content: 'Test', status: 'in_progress', activeForm: 'Test' },
        { content: 'Report', status: 'pending', activeForm: 'Report' },
      ] })
    for (const id of ['foreign', 'toolu_codexmod_missing']) {
      const refused: any = await $.tool.call({ tool: c.name, ...c.input, tool_use_id: id, agentId: 'agent-progress' } as any)
      expect(refused.deny).toContain('not executed')
    }
    for (const agentId of [undefined, 'agent-gp', 'agent-progress']) {
      const check: any = await $.tool.check({ tool: c.name, input: c.input, tool_use_id: c.id, agentId } as any)
      expect(check.decision).toBe('deny')
    }
    for (const agentId of [undefined, 'agent-gp', 'agent-normal']) {
      const stolen: any = await $.tool.call({ tool: c.name, ...c.input, tool_use_id: c.id, agentId } as any)
      expect(stolen.deny).toContain('not executed')
    }
    const swapped: any = await $.tool.call({ tool: c.name === 'Agent' ? 'TodoWrite' : 'Agent', tool_use_id: c.id, agentId: 'agent-progress' } as any)
    expect(swapped.deny).toContain('not executed')
    results.push(...await runCalls($, s.chunks, 'agent-progress'))
    const replay: any = await $.tool.call({ tool: c.name, ...c.input, tool_use_id: c.id, agentId: 'agent-progress' } as any)
    expect(replay.deny).toContain('not executed')
  }
  // This discriminant selects the finished branch, rather than async_launched,
  // remote_launched, or the id-only AgentCallRecord accepted by ToolResultOf.
  expect(results[0].result).toEqual(spawnResult)
  expect(results[0].result.status).toBe('completed')
  expect(results[0].result.canContinueAgent).toBe(false)
  expect(results[1].result).toEqual({ oldTodos: [], newTodos: [
    { content: 'Inspect', status: 'completed', activeForm: 'Inspect' },
    { content: 'Test', status: 'in_progress', activeForm: 'Test' },
    { content: 'Report', status: 'pending', activeForm: 'Report' },
  ] })
  const final = await step($, 'agent-progress', 2)
  expect(handback(final.result)).toContain('2 actions')
  expect(w.core).toEqual([])
  expect(w.checks).toEqual([])
})

for (const richRows of [false, true]) {
  test(`richRows ${richRows}: main-thread and non-Codex Agent/TodoWrite calls pass through; Codex calls are refused`, { options: { richRows } }, async ($, on) => {
    const w = world(on)
    for (const tool of ['Agent', 'TodoWrite']) {
      const input = tool === 'Agent' ? { description: 'Real task', prompt: 'Inspect', subagent_type: 'general-purpose' } : { todos: [] }
      for (const agentId of [undefined, 'agent-gp']) {
        const call: any = await $.tool.call({ tool, ...input, tool_use_id: 'host-id', agentId } as any)
        expect(call.result.stdout).toBe('REALLY RAN')
        const check: any = await $.tool.check({ tool, input, tool_use_id: 'host-id', agentId } as any)
        expect(check.decision).toBe('allow')
      }
      // Resolve a Codex type before its first step (also the worker restart path).
      const refused: any = await $.tool.call({ tool, ...input, tool_use_id: 'host-id', agentId: 'agent-deny' } as any)
      expect(refused.deny).toContain('not executed')
      const backstop: any = await $.tool.check({ tool, input, tool_use_id: 'host-id', agentId: 'agent-codex' } as any)
      expect(backstop.decision).toBe('deny')
    }
    expect(w.core.map(c => [c.tool, c.agentId])).toEqual([['Agent', undefined], ['Agent', 'agent-gp'], ['TodoWrite', undefined], ['TodoWrite', 'agent-gp']])
    expect(w.checks.map(c => [c.tool, c.agentId])).toEqual([['Agent', undefined], ['Agent', 'agent-gp'], ['TodoWrite', undefined], ['TodoWrite', 'agent-gp']])
  })
}

test('richRows false preserves full spawn and display-only plan cards', { options: { richRows: false } }, async ($, on) => {
  const w = world(on, { pieces: [itemPiece(spawnItem), itemPiece(planItem), MESSAGE('Done.')] })
  const first = await step($, 'agent-progress')
  expect(callsOf(first.chunks).map(c => c.name)).toEqual(['mcp__codex-mod__codex_tool'])
  const [spawn] = await runCalls($, first.chunks, 'agent-progress')
  expect(spawn.result[0].text).toContain('Inspect the tests.')
  const second = await step($, 'agent-progress', 1)
  const [plan] = await runCalls($, second.chunks, 'agent-progress')
  expect(plan.result[0].text).toContain('[x] Inspect')
  const final = await step($, 'agent-progress', 2)
  expect(handback(final.result)).toContain('2 actions')
  expect(w.core).toEqual([])
})

test('rich rows with nativeActions false degrade to text and retain action counts', { options: { richRows: true, nativeActions: false, handbackMode: 'text' } }, async ($, on) => {
  const w = world(on, { pieces: [itemPiece(spawnItem), itemPiece(planItem), MESSAGE('Done.')] })
  const s = await step($, 'agent-plain')
  expect(callsOf(s.chunks)).toEqual([])
  expect(s.result.answer).toContain('Codex spawn returned; child child-1: running')
  expect(s.result.answer).toContain('Verify\nCodex plan (display only):\n[x] Inspect\n[-] Test\n[ ] Report')
  expect(s.result.answer).toContain('2 actions')
  expect(w.core).toEqual([])
  expect(w.checks).toEqual([])
})

// ---- Batch 1: public wire, schemas, capabilities and guard isolation --------

const foundationItems: Record<string, any>[] = [
  {
    "type": "userMessage",
    "id": "user",
    "clientId": "cli-1",
    "content": [
      {
        "type": "text",
        "text": "Task",
        "text_elements": []
      }
    ]
  },
  {
    "type": "hookPrompt",
    "id": "hook",
    "fragments": [
      {
        "text": "Hook instruction",
        "hookRunId": "hook-run"
      }
    ]
  },
  {
    "type": "agentMessage",
    "id": "message",
    "text": "Working",
    "phase": "partial_answer",
    "memoryCitation": {
      "entries": []
    },
    "delivery": "async",
    "questions": []
  },
  {
    "type": "functionCallOutput",
    "id": "output",
    "name": "inspect",
    "namespace": null,
    "output": [
      {
        "type": "inputText",
        "text": "Result"
      }
    ]
  },
  {
    "type": "plan",
    "id": "plan",
    "text": "Inspect then test"
  },
  {
    "type": "reasoning",
    "id": "reason",
    "summary": [
      "Public summary"
    ],
    "content": [
      "PRIVATE_RAW_REASONING"
    ]
  },
  {
    "type": "commandExecution",
    "id": "command",
    "pluginId": null,
    "scriptPath": null,
    "command": "cat a.txt",
    "cwd": "/work",
    "processId": "pty-1",
    "source": "unifiedExecStartup",
    "status": "completed",
    "commandActions": [
      {
        "type": "read",
        "command": "cat a.txt",
        "name": "a.txt",
        "path": "a.txt"
      }
    ],
    "aggregatedOutput": "a\r\n\n",
    "exitCode": null,
    "durationMs": 17
  },
  {
    "type": "fileChange",
    "id": "patch",
    "status": "completed",
    "changes": [
      {
        "path": "a.txt",
        "kind": {
          "type": "update",
          "move_path": "b.txt"
        },
        "diff": "@@ -1 +1 @@\n-a\n+b\n"
      }
    ]
  },
  {
    "type": "mcpToolCall",
    "id": "mcp",
    "server": "docs",
    "tool": "inspect",
    "status": "completed",
    "arguments": {
      "tool": "Bash",
      "agentId": "spoof"
    },
    "appContext": {
      "connectorId": "docs",
      "linkId": null,
      "resourceUri": "ui://a",
      "appName": "Docs",
      "actionName": "Inspect"
    },
    "mcpAppUi": {
      "resourceUri": "ui://a",
      "preferredModelDisplayMode": "inline"
    },
    "pluginId": null,
    "readOnlyHint": true,
    "result": {
      "content": [],
      "structuredContent": {
        "answer": 42
      },
      "_meta": {
        "key": "value"
      }
    },
    "error": null,
    "durationMs": 9
  },
  {
    "type": "dynamicToolCall",
    "id": "dynamic",
    "namespace": null,
    "tool": "inspect",
    "arguments": {},
    "status": "failed",
    "contentItems": [
      {
        "type": "inputAudio",
        "audioUrl": "data:audio/wav;base64,AUDIO"
      }
    ],
    "success": false,
    "durationMs": 3
  },
  {
    "type": "collabAgentToolCall",
    "id": "collab",
    "tool": "spawnAgent",
    "status": "completed",
    "senderThreadId": "thread",
    "receiverThreadIds": [
      "child"
    ],
    "prompt": "Inspect",
    "model": "gpt-6.1-sol",
    "reasoningEffort": "high",
    "agentsStates": {
      "child": {
        "status": "running",
        "message": null
      }
    }
  },
  {
    "type": "subAgentActivity",
    "id": "activity",
    "kind": "started",
    "agentThreadId": "child",
    "agentPath": "/root/child",
    "model": "gpt-6.1-sol",
    "reasoningEffort": "high"
  },
  {
    "type": "webSearch",
    "id": "web",
    "query": "docs",
    "action": {
      "type": "search",
      "query": null,
      "queries": [
        "docs",
        "api"
      ]
    },
    "results": [
      {
        "title": "Docs",
        "url": "https://example.test"
      }
    ]
  },
  {
    "type": "imageView",
    "id": "view",
    "path": "image.png"
  },
  {
    "type": "sleep",
    "id": "sleep",
    "durationMs": 14
  },
  {
    "type": "imageGeneration",
    "id": "generation",
    "status": "failed",
    "revisedPrompt": "Actual prompt",
    "result": "IMAGE_BYTES",
    "transparentBackground": true,
    "failure": {
      "type": "usageLimitExceeded",
      "limitId": "images",
      "resetsAt": null
    },
    "savedPath": "image.png"
  },
  {
    "type": "enteredReviewMode",
    "id": "review-start",
    "review": "Full review request\nline two"
  },
  {
    "type": "exitedReviewMode",
    "id": "review-end",
    "review": "Full review result\nline two"
  },
  {
    "type": "contextCompaction",
    "id": "compact"
  }
]

const sourceSnake = (key: string) => key.replace(/[A-Z]/g, c => `_${c.toLowerCase()}`)
const execItem = (item: Record<string, any>) => Object.fromEntries(Object.entries(item).map(([key, value]) =>
  [sourceSnake(key), key === 'type' ? ({ collabAgentToolCall: 'collab_tool_call', plan: 'proposed_plan' } as Record<string, string>)[value] ?? sourceSnake(value) : value]))

for (const item of foundationItems) for (const transport of ['exec', 'app-server'] as const) {
  test(`foundation wire: ${transport} ${item.type} retains public fields and identity`, () => {
    const raw = transport === 'exec' ? execItem(item) : item
    const line = transport === 'exec'
      ? JSON.stringify({ type: 'item.completed', thread_id: 'thread', turn_id: 'turn', item: raw })
      : JSON.stringify({ type: 'item.completed', item: { type: 'source_only' }, source: { transport, event: 'item/completed', threadId: 'thread', turnId: 'turn', item: raw, startedAtMs: 100, completedAtMs: 120 } })
    const source = normalizeSource(line, { cwd: '/fallback' })!
    expect(source).toMatchObject({ transport, threadId: 'thread', turnId: 'turn', itemId: item.id, cwd: item.cwd ?? '/fallback' })
    for (const [key, value] of Object.entries(item)) {
      if (key === 'content' && item.type === 'reasoning') continue
      expect(source.item![key]).toEqual(value)
    }
    expect(JSON.stringify(source)).not.toContain('PRIVATE_RAW_REASONING')
    if (transport === 'app-server') expect(source).toMatchObject({ startedAtMs: 100, completedAtMs: 120 })
  })
}

test('foundation ledger: start/complete/replay, distinct source namespaces, snake status, patch and terminal evidence', () => {
  const ledger = new SourceLedger()
  const capture = (item: any, event = 'item.completed', turnId = 'turn') => ledger.capture(normalizeSource(JSON.stringify({ type: event, thread_id: 'thread', turn_id: turnId, item }))!)
  const started = capture({ type: 'command_execution', id: 'same', status: 'in_progress', process_id: 'pty', command: 'cat a' }, 'item.started')
  expect(started.record.item).toMatchObject({ status: 'inProgress', sourceStatus: 'in_progress', processId: 'pty' })
  expect(capture({ type: 'command_execution', id: 'same', status: 'in_progress' }, 'item.started').render).toBe(false)
  expect(capture({ type: 'command_execution', id: 'same', status: 'completed', aggregated_output: 'a\n' }).record.item).toMatchObject({ command: 'cat a', processId: 'pty', aggregatedOutput: 'a\n' })
  expect(capture({ type: 'command_execution', id: 'same', status: 'completed' }).render).toBe(false)
  expect(capture({ type: 'command_execution', id: 'same', status: 'in_progress' }, 'item.started').render).toBe(false)
  expect(capture({ type: 'command_execution', id: 'same', status: 'completed' }, 'item.completed', 'other').render).toBe(true)
  const notification = (event: string, data: any) => ledger.capture(normalizeSource(JSON.stringify({ type: 'codexmod.source', source: { transport: 'app-server', event, threadId: 'thread', turnId: 'turn', data } }))!)
  notification('item/fileChange/patchUpdated', { itemId: 'patch', changes: foundationItems[7].changes })
  expect(capture({ type: 'file_change', id: 'patch', status: 'completed', changes: [] }).record.item!.changes).toEqual(foundationItems[7].changes)
  notification('item/commandExecution/terminalInteraction', { itemId: 'same', processId: 'pty', stdin: 'q' })
  expect(ledger.records.at(-1)!.data).toMatchObject({ processId: 'pty', stdin: 'q' })
  const count = ledger.records.length
  notification('turn/diff/updated', { diff: 'aggregate only' })
  expect(ledger.records.length).toBe(count + 1)
  expect(ledger.items.size).toBe(3)
})

test('foundation schema boundary: every baseline success, malformed Agent/search/display and mismatched fields', () => {
  const spawn: any = parseCodexLine(itemLine(spawnItem), true)
  const web: any = parseCodexLine(itemLine(webItem))
  web.action.result.results[0].tool_use_id = 'real-display-id'
  const plan: any = parseCodexLine(itemLine(planItem), true, true)
  const actions = [commandAction('printf ok', 'ok\n', null), patchActions({ path: '/a', kind: 'add', diff: '+new\n' }, undefined, 'new\n', 'completed')[0]!, patchActions({ path: '/a', kind: 'update', diff: '@@ -1 +1 @@\n-old\n+new\n' }, 'old\n', 'new\n', 'completed')[0]!, web.action, spawn.action, plan.action,
    { tool: 'codex_tool', input: { server: 'docs', name: 'inspect', arguments: {} }, result: [{ type: 'text', text: 'ok' }] }]
  for (const a of actions) expect(validAction(a)).toBe(true)
  for (const a of [
    { ...spawn.action, result: { agentId: 'fake' } },
    { ...spawn.action, result: { ...spawn.action.result, status: 'async_launched' } },
    { ...spawn.action, result: { ...spawn.action.result, usage: {} } },
    { ...web.action, input: { query: 'example docs' } },
    { ...web.action, result: { ...web.action.result, results: [{ tool_use_id: '', content: [] }] } },
    { ...actions[0], result: { stdout: '', stderr: '', interrupted: false, exitCode: 0 } },
    { ...actions[1], result: { ...actions[1].result, content: 'wrong' } },
    { ...actions[2], result: { ...actions[2].result, structuredPatch: [{}] } },
    { ...actions[6], result: { content: [{ type: 'text', text: 'ok' }] } },
  ]) expect(validAction(a)).toBe(false)
})

for (const richRows of [false, true]) for (const nativeActions of [false, true]) {
  test(`foundation guards: all protected names, normal/known/restarted/missing owners, both hooks (${richRows}/${nativeActions})`, { options: { richRows, nativeActions } }, async ($, on) => {
    const w = world(on)
    for (const tool of NATIVE_TOOLS) {
      for (const agentId of [undefined, 'agent-gp']) {
        const e = { tool, tool_use_id: 'host-id', agentId }
        expect((await $.tool.call(e as any) as any).result.stdout).toBe('REALLY RAN')
        expect((await $.tool.check({ ...e, input: {} } as any)).decision).toBe('allow')
      }
      for (const agentId of ['agent-codex', 'agent-restarted', 'foundation-unlisted']) {
        expect((await $.tool.call({ tool, tool_use_id: 'host-id', agentId } as any) as any).deny).toContain('not executed')
        expect((await $.tool.check({ tool, tool_use_id: 'host-id', input: {}, agentId } as any)).decision).toBe('deny')
      }
    }
    for (const tool of ['mcp__codex-mod__codex_tool', 'mcp__codex-mod__codex_plan', 'mcp__codex-mod__coordinator_message', 'mcp__codex-mod__codex_question']) {
      for (const agentId of [undefined, 'agent-gp', 'agent-codex', 'foundation-unlisted']) {
        expect((await $.tool.call({ tool, tool_use_id: 'ordinary', agentId } as any) as any).deny).toContain('not executed')
        expect((await $.tool.check({ tool, tool_use_id: 'ordinary', input: {}, agentId } as any)).decision).toBe('deny')
      }
    }
    for (const tool of [...NATIVE_TOOLS, 'Read', 'Glob', 'Grep', 'WebFetch', 'TaskCreate', 'TaskUpdate', 'TaskStop', 'ReportFindings', 'AskUserQuestion', 'SubagentHandback', 'mcp__external__real', 'FutureTool']) {
      for (const agentId of [undefined, 'agent-gp', 'agent-codex', 'foundation-unlisted']) {
        expect((await $.tool.call({ tool, tool_use_id: `${ID_PREFIX}missing`, agentId } as any) as any).deny).toContain('not executed')
        expect((await $.tool.check({ tool, tool_use_id: `${ID_PREFIX}missing`, input: {}, agentId } as any)).decision).toBe('deny')
      }
    }
    for (const tool of ['Read', 'Glob', 'Grep', 'WebFetch', 'TaskCreate', 'TaskUpdate', 'TaskStop', 'ReportFindings', 'AskUserQuestion', 'mcp__external__real']) {
      for (const agentId of [undefined, 'agent-gp']) {
        expect((await $.tool.call({ tool, tool_use_id: 'ordinary', agentId } as any) as any).result.stdout).toBe('REALLY RAN')
        expect((await $.tool.check({ tool, input: {}, tool_use_id: 'ordinary', agentId } as any)).decision).toBe('allow')
      }
    }
    expect(w.core.length).toBe(NATIVE_TOOLS.length * 2 + 20)
    expect(w.checks.length).toBe(w.core.length)
  })
}

test('foundation input binding: changed, added, stolen, swapped, session and replay calls refuse without consuming the answer', async ($, on) => {
  const w = world(on, { pieces: [cmdDone('printf original', 'original\n'), MESSAGE('Done')] })
  const s = await step($, 'agent-progress')
  const [c] = callsOf(s.chunks)
  for (const change of [{ command: 'printf forged' }, { extra: true }, { description: 'forged' }, { tool: 'Read' }, { agentId: 'agent-gp' }, { agentId: undefined }]) {
    const answer: any = await $.tool.call({ tool: c.name, ...c.input, tool_use_id: c.id, agentId: 'agent-progress', ...change } as any)
    expect(answer.deny).toContain('not executed')
  }
  const reversed = Object.fromEntries(Object.entries(c.input).reverse())
  const answer: any = await $.tool.call({ tool: c.name, ...reversed, tool_use_id: c.id, agentId: 'agent-progress' } as any)
  expect(answer.result).toEqual({ stdout: 'original\n', stderr: '', interrupted: false })
  expect((await $.tool.call({ tool: c.name, ...c.input, tool_use_id: c.id, agentId: 'agent-progress' } as any) as any).deny).toContain('not executed')
  const final = await step($, 'agent-progress', 1)
  const [hb] = callsOf(final.chunks)
  expect(hb.name).toBe('SubagentHandback')
  expect(hb.id.startsWith(HANDBACK_ID_PREFIX)).toBe(true)
  expect(hb.id.startsWith(ID_PREFIX)).toBe(false)
  await runCalls($, final.chunks, 'agent-progress')
  expect(w.core.map(c => c.tool)).toEqual(['SubagentHandback'])
  expect(w.spawned.length).toBe(1)
})

test('foundation errors: failed/declined/null/nonzero commands and failed spawns deny with actual output', { options: { richRows: true } }, async ($, on) => {
  const output = 'full output\r\n' + 'x'.repeat(31000) + '\n'
  const items = [
    { type: 'command_execution', id: 'null', command: 'unknown', aggregated_output: output, exit_code: null, status: 'completed' },
    { type: 'command_execution', id: 'nonzero', command: 'false', aggregated_output: 'actual failure\n', exit_code: 2, status: 'completed' },
    { type: 'command_execution', id: 'declined', command: 'denied', aggregated_output: 'actual decline', exit_code: null, status: 'declined' },
    { type: 'collab_tool_call', id: 'spawn', tool: 'spawn_agent', status: 'failed', prompt: 'Inspect', receiver_thread_ids: [], agents_states: {} },
  ]
  const w = world(on, { pieces: [out(items.map(i => itemLine(i)).join('\n')), MESSAGE('Done')] })
  const first = await step($, 'agent-progress')
  const answers: any[] = await runCalls($, first.chunks, 'agent-progress')
  expect(answers[0].result.stdout).toBe(output)
  expect(answers[0].result.stderr).toBe('')
  expect(answers[1].deny).toContain('exit code 2')
  expect(answers[1].deny).toContain('actual failure\n')
  expect(answers[2].deny).toContain('actual decline')
  expect(answers[3].deny).toContain('spawn failed')
  expect(w.core).toEqual([])
  await step($, 'agent-progress', 1)
  const rec: any = savedState(w, 'agent:sess-1:agent-progress')
  expect(rec.wire.records.filter((r: any) => r.item?.type === 'commandExecution').length).toBe(3)
  expect(Object.keys(rec.wire.rows).length).toBe(4)
})

test('foundation replay: one command row, one file row, no aggregate-diff row and one handback', async ($, on) => {
  const command = { type: 'command_execution', id: 'cmd', command: 'printf ok', status: 'completed', exit_code: 0, aggregated_output: 'ok\n' }
  const patch = { type: 'file_change', id: 'patch', status: 'completed', changes: [{ path: 'a', kind: { type: 'add' }, diff: '+new\n' }] }
  const transcript = [itemLine({ ...command, status: 'in_progress' }, 'item.started'), itemLine(command), itemLine(command), itemLine(patch), itemLine(patch), JSON.stringify({ type: 'codexmod.source', source: { transport: 'app-server', event: 'turn/diff/updated', threadId: 'thread', turnId: 'turn', data: { diff: '+new\n' } } }), itemLine({ type: 'agent_message', id: 'final', text: 'Done' }), itemLine({ type: 'agent_message', id: 'final', text: 'Done' })].join('\n')
  const w = world(on, { pieces: [out(transcript)], files: new Map([['/tmp/project/a', 'new\n']]) })
  const first = await step($, 'agent-progress')
  expect(callsOf(first.chunks).map(c => c.name)).toEqual(['Bash', 'Write'])
  await runCalls($, first.chunks, 'agent-progress')
  const final = await step($, 'agent-progress', 1)
  expect(callsOf(final.chunks).map(c => c.name)).toEqual(['SubagentHandback'])
  expect(handback(final.result).split('Done').length).toBe(2)
  expect(w.spawned.length).toBe(1)
  expect(w.core).toEqual([])
})

test('foundation capability failure: only registered tools are admitted; absent native rows fall back without execution', async ($, on) => {
  const w = world(on, { availableTools: [], pieces: [cmdDone('printf actual', 'actual\n'), MESSAGE('Done')] })
  const specs: any[] = []
  on('agent.register', (_$, e: any) => { if (e.name !== 'codex-child') specs.push(e); return { value: { agent: `codex-mod:${e.name}` } } })
  await startSession($)
  expect(specs[0].tools).toEqual(['mcp__codex-mod__codex_tool', 'mcp__codex-mod__codex_plan', 'mcp__codex-mod__coordinator_message', 'mcp__codex-mod__codex_question'])
  const s = await step($, 'agent-progress')
  expect(callsOf(s.chunks).map(c => c.name)).toEqual(['mcp__codex-mod__codex_tool'])
  const [answer]: any[] = await runCalls($, s.chunks, 'agent-progress')
  expect(answer.result[0].text).toContain('Bash unavailable')
  expect(answer.result[0].text).toContain('actual')
  expect(w.core).toEqual([])
})

test('foundation restart: durable Codex ownership survives list failure and ordinary cached ownership passes', async ($, on) => {
  const w = world(on, { listThrows: true, store: new Map([['agent:sess-1:foundation-restored', { model: 'gpt-6.1-sol', effort: 'medium', sandbox: 'workspace-write', agentName: 'codex', updatedAt: 1 }]]) })
  for (const tool of NATIVE_TOOLS) {
    expect((await $.tool.call({ tool, tool_use_id: 'ordinary', agentId: 'foundation-restored' } as any) as any).deny).toContain('not executed')
    expect((await $.tool.check({ tool, input: {}, tool_use_id: 'ordinary', agentId: 'foundation-restored' } as any)).decision).toBe('deny')
  }
  expect(w.core).toEqual([])
})

test('foundation all baseline answer inputs bind exactly, including nested arguments and source/session identity', { options: { richRows: true } }, async ($, on) => {
  const editPath = '/tmp/project/edit.txt'
  const files = new Map([[editPath, 'before\n'], ['/tmp/project/add.txt', 'added\n']])
  const items = [
    { type: 'command_execution', id: 'cmd', command: 'printf ok', status: 'completed', aggregated_output: 'ok\n', exit_code: 0 },
    { type: 'file_change', id: 'write', status: 'completed', changes: [{ path: 'add.txt', kind: 'add', diff: '+added\n' }] },
    { type: 'file_change', id: 'edit', status: 'completed', changes: [{ path: editPath, kind: 'update', diff: '@@ -1 +1 @@\n-before\n+after\n' }] },
    { ...webItem, id: 'web' }, { ...spawnItem, id: 'spawn' }, { ...planItem, id: 'plan' },
    { ...mcpItem, id: 'mcp', arguments: { nested: { token: 'original' } } },
  ]
  let sid = 'sess-1'
  const w = world(on, { sessionId: () => sid, files, pieces: [fileEv('item.started', editPath, 'update', undefined, 'edit'), () => { files.set(editPath, 'after\n'); return true }, out(items.map(i => itemLine(i)).join('\n')), MESSAGE('Done')] })
  const s = await step($, 'agent-progress')
  const calls = callsOf(s.chunks)
  expect(calls.map(c => c.name)).toEqual(['Bash', 'Write', 'Edit', 'WebSearch', 'Agent', 'TodoWrite', 'mcp__codex-mod__codex_tool'])
  for (const c of calls) {
    const input = JSON.parse(JSON.stringify(c.input))
    const key = Object.keys(input)[0]!
    input[key] = 'changed'
    expect((await $.tool.call({ tool: c.name, ...input, tool_use_id: c.id, agentId: 'agent-progress' } as any) as any).deny).toContain('not executed')
    expect((await $.tool.check({ tool: c.name, input: c.input, tool_use_id: c.id, agentId: 'agent-progress' } as any)).decision).toBe('deny')
    sid = 'other-session'
    expect((await $.tool.call({ tool: c.name, ...c.input, tool_use_id: c.id, agentId: 'agent-progress' } as any) as any).deny).toContain('not executed')
    sid = 'sess-1'
  }
  const mcp = calls.at(-1)!
  expect((await $.tool.call({ tool: mcp.name, ...mcp.input, arguments: { nested: { token: 'changed' } }, tool_use_id: mcp.id, agentId: 'agent-progress' } as any) as any).deny).toContain('not executed')
  const results: any[] = await runCalls($, s.chunks, 'agent-progress')
  for (let i = 0; i < results.length; i++) {
    expect(results[i].deny).toBe(undefined)
    expect(validAction({ tool: calls[i].name, input: calls[i].input, result: results[i].result })).toBe(true)
    expect((await $.tool.call({ tool: calls[i].name, ...calls[i].input, tool_use_id: calls[i].id, agentId: 'agent-progress' } as any) as any).deny).toContain('not executed')
  }
  expect(w.core).toEqual([])
})

test('foundation source-only notifications, unsupported variants, warnings and partial answers survive final handback', async ($, on) => {
  const sourceLine = (event: string, data: any) => JSON.stringify({ type: 'codexmod.source', source: { transport: 'app-server', threadId: 'thread', turnId: 'turn', event, data } })
  const w = world(on, { stdout: [
    sourceLine('item/fileChange/patchUpdated', { itemId: 'patch', changes: foundationItems[7].changes }),
    sourceLine('item/commandExecution/terminalInteraction', { itemId: 'cmd', processId: 'pty', stdin: 'q' }),
    sourceLine('thread/goal/updated', { goal: { objective: 'Inspect', status: 'active' } }),
    itemLine({ type: 'futureItem', id: 'future', arbitrary: { value: null } }),
    itemLine({ type: 'error', id: 'warning', message: 'Configuration warning' }),
    itemLine({ type: 'agent_message', id: 'partial', phase: 'partial_answer', text: 'Incomplete' }),
  ].join('\n') })
  const s = await step($, 'agent-progress')
  expect(handback(s.result)).toContain('codex failed:')
  expect(handback(s.result)).not.toContain('Incomplete')
  expect(s.chunks.some(c => c.kind === 'text' && c.text === 'Incomplete')).toBe(true)
  const wire: any = savedState(w, 'agent:sess-1:agent-progress').wire
  expect(wire.records.length).toBe(6)
  expect(wire.records[0].item.changes[0].kind.move_path).toBe('b.txt')
  expect(wire.records[1].data.stdin).toBe('q')
  expect(wire.records[3].item.arbitrary).toEqual({ value: null })
  expect(wire.records[4].item.message).toBe('Configuration warning')
  expect(w.core).toEqual([])
})

test('foundation guard catches protect every reserved-prefix tool even with unknown name, main scope and next.called', async () => {
  const guards = new Map<string, { handler: any; catcher: any }>()
  codexRegister(((name: string, ...args: any[]) => {
    const entry = { handler: args.at(-1), catcher: undefined as any }
    guards.set(name, entry)
    return { catch: (catcher: any) => { entry.catcher = catcher } }
  }) as any, {})
  for (const hook of ['tool.call', 'tool.check']) for (const tool of [...NATIVE_TOOLS, 'Read', 'FutureTool', 'SubagentHandback', 'mcp__external__real']) {
    const entry = guards.get(hook)!
    const next: any = () => { throw new Error('Executor must not run') }
    next.called = true
    const result = entry.catcher({}, { tool, tool_use_id: `${ID_PREFIX}missing` }, next)
    expect(hook === 'tool.call' ? result.deny : result.decision).toBe(hook === 'tool.call' ? 'codex-mod: not executed' : 'deny')
  }
})

test('foundation verified ordinary ownership stays cached during a later lookup outage', async ($, on) => {
  const opts = { listThrows: false }
  const w = world(on, opts)
  expect((await $.tool.call({ tool: 'Bash', command: 'true', tool_use_id: 'normal', agentId: 'agent-gp' } as any) as any).result.stdout).toBe('REALLY RAN')
  opts.listThrows = true
  for (const tool of NATIVE_TOOLS) {
    expect((await $.tool.call({ tool, tool_use_id: 'normal', agentId: 'agent-gp' } as any) as any).result.stdout).toBe('REALLY RAN')
    expect((await $.tool.check({ tool, input: {}, tool_use_id: 'normal', agentId: 'agent-gp' } as any)).decision).toBe('allow')
  }
  expect((await $.tool.call({ tool: 'Bash', tool_use_id: 'normal', agentId: 'foundation-unresolved-outage' } as any) as any).deny).toContain('not executed')
  expect(w.core.length).toBe(NATIVE_TOOLS.length + 1)
})

test('foundation missing native and display tools drain to exactly one handback with literal fallback', async ($, on) => {
  const w = world(on, { availableTools: [], toolRegisterThrows: 'codex_tool', pieces: [cmdDone('printf first', 'first\n'), cmdDone('printf second', 'second\n'), MESSAGE('Finished')] })
  const s = await step($, 'agent-progress')
  expect(callsOf(s.chunks).map(c => c.name)).toEqual(['SubagentHandback'])
  expect(handback(s.result)).toContain('Finished')
  const text = s.chunks.filter(c => c.kind === 'text').map(c => c.text).join('\n')
  expect(text).toContain('Bash unavailable')
  expect(text).toContain('first')
  expect(text).toContain('second')
  expect(w.spawned.length).toBe(1)
  expect(w.core).toEqual([])
})

test('foundation public wire excludes private reasoning inside turn/thread snapshots and retains envelope metadata', () => {
  const line = JSON.stringify({ type: 'future.event', transportMeta: { exact: true }, thread: { turns: [{ items: [{ type: 'reasoning', id: 'reasoning', summary: ['Public'], content: ['PRIVATE_RAW_REASONING'] }] }] } })
  const record = normalizeSource(line)!
  expect(JSON.stringify(record)).not.toContain('PRIVATE_RAW_REASONING')
  expect(record.data!.thread.turns[0].items[0].summary).toEqual(['Public'])
  expect(record.envelope).toMatchObject({ transportMeta: { exact: true } })
})

test('foundation compatibility records inherit their actual transport and source turn', () => {
  const record = normalizeSource(itemLine({ type: 'plan_update', steps: [] }, 'item.updated'), { transport: 'app-server', threadId: 'thread', turnId: 'turn' })!
  expect(record).toMatchObject({ transport: 'app-server', threadId: 'thread', turnId: 'turn' })
})

test('foundation coordinator registration retry respects the existing agent tool allowlist', async ($, on) => {
  const opts: WorldOpts = { task: 'first', toolRegisterThrows: 'coordinator_message', store: new Map([['agent:sess-1:agent-coordinator', quietCoordinatorRecord('Full receipt')]]) }
  const w = world(on, opts)
  const specs: any[] = []
  on('agent.register', (_$, e: any) => { if (e.name !== 'codex-child') specs.push(e); return { value: { agent: `codex-mod:${e.name}` } } })
  await startSession($)
  expect(specs[0].tools.includes('mcp__codex-mod__coordinator_message')).toBe(false)
  opts.toolRegisterThrows = undefined
  const s = await step($, 'agent-coordinator')
  expect(coordinatorCalls(s.chunks)).toEqual([])
  expect(s.chunks.some(c => c.kind === 'text' && c.text === 'Coordinator message:\n\nFull receipt')).toBe(true)
  expect(w.core).toEqual([])
})

const explorationSource = (item: Record<string, any>) => ({ transport: 'app-server' as const, event: 'item/completed', threadId: 'thread', turnId: 'turn', itemId: item.id, cwd: item.cwd, item })
const explorationLine = (item: Record<string, any>, event = 'item/completed') => JSON.stringify({ type: event === 'item/started' ? 'item.started' : 'item.completed',
  item: { ...item, type: 'command_execution', aggregated_output: item.aggregatedOutput, exit_code: item.exitCode }, source: { ...explorationSource(item), event } })

test('activity titles reach failed Bash rows from source metadata without native search reclassification', async ($, on) => {
  const command = "rg -n 'pilot | draft' docs"
  const item = { id: 'title-search', type: 'commandExecution', source: 'agent', cwd: '/workspace', command,
    status: 'failed', exitCode: 2, aggregatedOutput: 'rg: docs: Permission denied\n[output truncated]', truncated: true,
    commandActions: [{ type: 'search', command, query: 'pilot | draft', path: '/workspace/docs' }] }
  const w = world(on, { availableTools: [...NATIVE_TOOLS], stdout: explorationLine(item) + '\n' + itemLine({ type: 'agent_message', text: 'Done' }) })
  const s = await step($, 'agent-progress')
  const calls = callsOf(s.chunks)
  expect(calls.length).toBe(1)
  const call = calls[0]!
  expect(call.name).toBe('Bash')
  expect(call.input.command).toBe(command)
  expect(call.input.description).toBe('Search pilot | draft in docs')
  const answer: any = await $.tool.call({ tool: call.name, ...call.input, tool_use_id: call.id, agentId: 'agent-progress' } as any)
  expect(answer.deny).toContain('failed (exit code 2)')
  expect(answer.deny).toContain(item.aggregatedOutput)
  expect(w.core).toEqual([])
  expect(w.reads.some(p => p.startsWith('/workspace'))).toBe(false)
})

for (const { item, tool } of batch2Cases) {
  test(`batch 2 mapping: ${item.id} -> ${tool}`, () => {
    const action = explorationAction(explorationSource(item))
    expect(action?.tool ?? 'Bash').toBe(tool)
    if (action) {
      expect(validAction(action)).toBe(true)
      expect(action.source!.item!.aggregatedOutput).toBe(item.aggregatedOutput)
      expect(Object.keys(action.input).includes('_host')).toBe(false)
    }
  })
}

test('batch 2 exact results: whole/empty/CRLF/slices, glob scope, grep modes and literal regex escaping', () => {
  const action = (id: string): any => explorationAction(explorationSource(batch2Cases.find(c => c.item.id === id)!.item))!
  expect(action('whole').result).toEqual({ type: 'text', file: { filePath: '/workspace/a.txt', content: 'one\ntwo\n', numLines: 2, startLine: 1, totalLines: 2 } })
  expect(action('startup-shell-read').input).toEqual({ file_path: '/workspace/notes.txt' })
  expect(action('startup-shell-read').result.file).toEqual({ filePath: '/workspace/notes.txt', content: 'Exact file contents.\nSecond line.\n', numLines: 2, startLine: 1, totalLines: 2 })
  expect(action('empty').result.file).toMatchObject({ content: '', numLines: 0, totalLines: 0 })
  expect(action('crlf').result.file).toMatchObject({ content: 'one\r\ntwo\r\n', numLines: 2, totalLines: 2 })
  expect(action('no-final-newline').result.file).toMatchObject({ content: 'one\ntwo', numLines: 2, totalLines: 2 })
  expect(action('slice-tail').input).toEqual({ file_path: '/workspace/a.txt', offset: 3 })
  expect(action('slice-tail').result.file).toMatchObject({ numLines: 2, startLine: 3, totalLines: 4 })
  expect(action('slice-head-eof').input).toEqual({ file_path: '/workspace/a.txt', limit: 5 })
  expect(action('slice-head-eof').result.file.totalLines).toBe(2)
  expect(action('immediate-files').input).toEqual({ pattern: '*', path: '/workspace' })
  expect(action('recursive-files').result).toEqual({ durationMs: 12, numFiles: 2, filenames: ['/workspace/a.txt', '/workspace/sub/b.txt'], truncated: false })
  expect(action('rg-files').input).toEqual({ pattern: '**/*.ts', path: '/workspace/src' })
  expect(action('empty-list').result.numFiles).toBe(0)
  expect(action('duration-sentinel').result.durationMs).toBe(0)
  expect(action('content').result).toMatchObject({ mode: 'content', numFiles: 2, numLines: 2, filenames: ['/workspace/a.txt', '/workspace/sub/b.txt'] })
  expect(action('content').result.content).toBe('a.txt:1:x\nsub/b.txt:3:x again\n')
  expect(action('json-framing').result).toMatchObject({ numFiles: 1, numLines: 1, content: 'a.txt:x\n' })
  expect(action('multiline-result').result).toMatchObject({ numLines: 2, content: 'a.txt:x\na.txt:x again\n' })
  expect(action('content-no-newline').result).toMatchObject({ numLines: 2, content: 'a.txt:x\nb.txt:x\n' })
  expect(action('files').result).toEqual({ mode: 'files_with_matches', numFiles: 2, filenames: ['/workspace/a.txt', '/workspace/sub/b.txt'] })
  expect(action('count').result).toEqual({ mode: 'count', numFiles: 2, filenames: ['/workspace/a.txt', '/workspace/sub/b.txt'], content: 'a.txt\0' + '2\nsub/b.txt\0' + '3\n', numMatches: 5 })
  expect(action('fixed').input.pattern).toBe('a\\.b\\[\\$\\]')
  expect(action('flags').input).toEqual({ path: '/workspace', output_mode: 'content', head_limit: 0, '-i': true, '-n': true, '-A': 1, glob: '*.ts', type: 'ts', pattern: 'x' })
  for (const id of ['no-matches-files', 'no-matches-count', 'no-matches-json']) expect(action(id).result.numFiles).toBe(0)
  expect(action('no-matches-json').result).toMatchObject({ content: '', numLines: 0 })
})

test('batch 2 literal words distinguish quoted operators from executable shell syntax', () => {
  expect(literalWords("cat 'a | $(x) ; b'" )).toEqual(['cat', 'a | $(x) ; b'])
  expect(literalWords('cat "a \\$x \\`y\\`"')).toEqual(['cat', 'a $x `y`'])
  for (const command of ['cat a; cat b', 'cat a\ncat b', 'cat < a', 'cat a >> b', 'cat ${x}', 'cat <(echo x)', 'cat "`x`"', "cat 'a", 'cat a\\']) expect(literalWords(command)).toBeUndefined()
})

test('batch 2 schema boundary rejects invented fields, mismatched paths/counts, routing and invalid limits', () => {
  const get = (id: string): any => explorationAction(explorationSource(batch2Cases.find(c => c.item.id === id)!.item))!
  const read = get('whole')
  const glob = get('recursive-files')
  const grep = get('content')
  for (const action of [
    { ...read, input: { ...read.input, command: 'cat a.txt' } },
    { ...read, input: { ...read.input, offset: 0 } },
    { ...read, result: { ...read.result, file: { ...read.result.file, filePath: '/foreign', totalLines: 1 } } },
    { ...read, result: { ...read.result, file: { ...read.result.file, numLines: 1 } } },
    { ...glob, input: { ...glob.input, _host: 'foreign' } },
    { ...glob, result: { ...glob.result, numFiles: 99 } },
    { ...glob, result: { ...glob.result, durationMs: -1 } },
    { ...grep, input: { ...grep.input, offset: -1 } },
    { ...grep, input: { ...grep.input, head_limit: 1.5 } },
    { ...grep, result: { ...grep.result, mode: 'count' } },
    { ...grep, result: { ...grep.result, numLines: 999 } },
    { ...grep, result: { ...grep.result, content: undefined } },
  ]) expect(validAction(action)).toBe(false)
})

test('batch 2 all fixture rows answer from held output, with command/cwd visible and no executor or extra file reads', { options: { maxActionsPerStep: 50 } }, async ($, on) => {
  const w = world(on, { availableTools: [...NATIVE_TOOLS], stdout: batch2Cases.map(c => explorationLine(c.item)).join('\n') + '\n' + itemLine({ type: 'agent_message', text: 'Done' }) })
  let checked = 0
  for (let index = 0; checked < batch2Cases.length; index++) {
    const s = await step($, 'agent-progress', index)
    for (const c of callsOf(s.chunks)) {
      const fixture = batch2Cases[checked++]!
      expect(c.name).toBe(fixture.tool)
      const answer: any = await $.tool.call({ tool: c.name, ...c.input, tool_use_id: c.id, agentId: 'agent-progress' } as any)
      const expected = explorationAction(explorationSource(fixture.item)) ?? commandAction(fixture.item.command, fixture.item.aggregatedOutput, fixture.item.exitCode, fixture.item.status)
      expect(answer).toEqual(expected.error ? { deny: expected.error } : { result: expected.result })
      if (fixture.tool !== 'Bash') {
        expect(s.chunks.some(b => b.kind === 'text' && b.text.includes(fixture.item.command) && b.text.includes('/workspace'))).toBe(true)
        expect((await $.tool.call({ tool: c.name, ...c.input, tool_use_id: c.id, agentId: 'agent-progress' } as any) as any).deny).toContain('not executed')
      }
      const wire: any = savedState(w, 'agent:sess-1:agent-progress').wire
      expect(wire.rows[c.id].item.aggregatedOutput).toBe(fixture.item.aggregatedOutput)
    }
  }
  expect(w.core).toEqual([])
  expect(w.spawned.length).toBe(1)
  expect(w.reads.some(p => p.startsWith('/workspace'))).toBe(false)
})

for (const tool of ['Read', 'Glob', 'Grep']) {
  test(`batch 2 ${tool} guard: own ID, stolen owner/tool/input, main/ordinary calls, replay, exception and backstop`, async ($, on) => {
    const fixture = batch2Cases.find(c => c.tool === tool)!
    const w = world(on, { availableTools: [...NATIVE_TOOLS], stdout: explorationLine(fixture.item) + '\n' + itemLine({ type: 'agent_message', text: 'Done' }) })
    const s = await step($, 'agent-progress')
    const [call] = callsOf(s.chunks)
    const e = { tool, ...call.input, tool_use_id: call.id, agentId: 'agent-progress' }
    for (const change of [{ agentId: undefined }, { agentId: 'agent-gp' }, { agentId: 'agent-codex' }, { tool: 'Bash' }, { extra: true }, { ...call.input, [tool === 'Read' ? 'file_path' : 'path']: '/forged' }]) expect((await $.tool.call({ ...e, ...change } as any) as any).deny).toContain('not executed')
    expect((await $.tool.check({ tool, tool_use_id: call.id, agentId: 'agent-progress', input: call.input } as any)).decision).toBe('deny')
    expect((await $.tool.call(e as any) as any).result).toEqual(explorationAction(explorationSource(fixture.item))!.result)
    expect((await $.tool.call(e as any) as any).deny).toContain('not executed')
    for (const agentId of [undefined, 'agent-gp']) {
      expect((await $.tool.call({ tool, ...call.input, tool_use_id: 'ordinary', agentId } as any) as any).result.stdout).toBe('REALLY RAN')
      expect((await $.tool.check({ tool, input: call.input, tool_use_id: 'ordinary', agentId } as any)).decision).toBe('allow')
    }
    expect(w.core.length).toBe(2)
    expect(w.checks.length).toBe(2)
  })
  test(`batch 2 ${tool} ownership exception refuses in both guards`, async ($, on) => {
    const w = world(on, { listThrows: true })
    expect((await $.tool.call({ tool, tool_use_id: 'ordinary', agentId: 'unresolved-exploration' } as any) as any).deny).toContain('not executed')
    expect((await $.tool.check({ tool, input: {}, tool_use_id: 'ordinary', agentId: 'unresolved-exploration' } as any)).decision).toBe('deny')
    expect(w.core).toEqual([])
    expect(w.checks).toEqual([])
  })
}

test('batch 2 stream/poll interactions and replay produce one final row with authoritative output and one handback', async ($, on) => {
  const item = batch2Cases[0]!.item
  const notification = (event: string, data: any) => JSON.stringify({ type: 'codexmod.source', source: { transport: 'app-server', event, threadId: 'thread', turnId: 'turn', data: { itemId: item.id, processId: item.processId, ...data } } })
  const start = explorationLine({ ...item, status: 'inProgress', aggregatedOutput: null, exitCode: null }, 'item/started')
  const w = world(on, { availableTools: [...NATIVE_TOOLS], stdout: [start,
    notification('item/commandExecution/outputDelta', { delta: 'one\n' }),
    notification('item/commandExecution/terminalInteraction', { stdin: '' }),
    notification('item/commandExecution/outputDelta', { delta: 'two\n' }),
    explorationLine(item), explorationLine(item), start, itemLine({ type: 'agent_message', text: 'Done' }),
  ].join('\n') })
  const s = await step($, 'agent-progress')
  expect(callsOf(s.chunks).map(c => c.name)).toEqual(['Read'])
  const [answer]: any = await runCalls($, s.chunks, 'agent-progress')
  expect(answer.result.file.content).toBe('one\ntwo\n')
  const final = await step($, 'agent-progress', 1)
  expect(callsOf(final.chunks).map(c => c.name)).toEqual(['SubagentHandback'])
  await runCalls($, final.chunks, 'agent-progress')
  expect(w.core.map(c => c.tool)).toEqual(['SubagentHandback'])
  expect(w.spawned.length).toBe(1)
})

test('batch 2 unavailable exploration tool falls back to one original Bash row', async ($, on) => {
  const w = world(on, { availableTools: ['Bash'], stdout: explorationLine(batch2Cases[0]!.item) + '\n' + itemLine({ type: 'agent_message', text: 'Done' }) })
  const s = await step($, 'agent-progress')
  expect(callsOf(s.chunks).map(c => c.name)).toEqual(['Bash'])
  const [answer]: any = await runCalls($, s.chunks, 'agent-progress')
  expect(answer.result.stdout).toBe('one\ntwo\n')
  expect(s.chunks.some(c => c.kind === 'text' && c.text.includes('Read unavailable'))).toBe(true)
  expect(w.core).toEqual([])
})

test('batch 2 an unavailable Grep preserves the successful no-match outcome in Bash', async ($, on) => {
  const fixture = batch2Cases.find(c => c.item.id === 'no-matches-files')!
  const w = world(on, { availableTools: ['Bash'], stdout: explorationLine(fixture.item) + '\n' + itemLine({ type: 'agent_message', text: 'Done' }) })
  const s = await step($, 'agent-progress')
  expect(callsOf(s.chunks).map(c => c.name)).toEqual(['Bash'])
  expect(callsOf(s.chunks)[0].input.description).toBe('Search x in . (no matches; exit 1)')
  const [answer]: any = await runCalls($, s.chunks, 'agent-progress')
  expect(answer).toEqual({ result: { stdout: '', stderr: '', interrupted: false } })
  expect(w.core).toEqual([])
})

test('batch 2 nativeActions off displays exploration commands as text, preserving one handback', { options: { nativeActions: false } }, async ($, on) => {
  const fixtures = ['Read', 'Glob', 'Grep'].map(tool => batch2Cases.find(c => c.tool === tool)!.item)
  const w = world(on, { availableTools: [...NATIVE_TOOLS], stdout: fixtures.map(item => explorationLine(item)).join('\n') + '\n' + itemLine({ type: 'agent_message', text: 'Done' }) })
  const s = await step($, 'agent-progress')
  expect(callsOf(s.chunks).map(c => c.name)).toEqual(['SubagentHandback'])
  const text = s.chunks.filter(c => c.kind === 'text').map(c => c.text).join('\n')
  for (const item of fixtures) expect(text).toContain(item.command)
  expect(w.core).toEqual([])
})

test('batch 2 exploration tools are admitted in each registered Codex agent independently of richRows', async ($, on) => {
  world(on, { availableTools: [...NATIVE_TOOLS] })
  const specs: any[] = []
  on('agent.register', (_$, e: any) => { if (e.name !== 'codex-child') specs.push(e); return { value: { agent: `codex-mod:${e.name}` } } })
  await startSession($)
  for (const spec of specs) for (const tool of ['Read', 'Glob', 'Grep']) expect(spec.tools.includes(tool)).toBe(true)
})

for (const c of batch3Cases) {
  test(`batch 3 exact patch: ${c.id}`, () => {
    const rows = patchActions(c.change, c.before, c.after, c.status ?? 'completed', 'Actual source report', c.stable)
    expect(rows.map(r => r.tool)).toEqual(c.tools)
    let revision = c.before
    for (const row of rows) {
      expect(validAction(row)).toBe(true)
      expect(JSON.stringify(row.input)).not.toContain('more characters not shown')
      if (row.tool === 'Write') {
        expect(row.input.content).toBe(c.after ?? 'new\n')
        expect(row.result).toMatchObject({ type: 'create', originalFile: null, content: row.input.content })
      } else if (row.tool === 'Edit') {
        const old = String(row.input.old_string)
        expect(old).not.toBe('')
        expect(revision!.indexOf(old)).toBe(revision!.lastIndexOf(old))
        expect(revision!.includes(old)).toBe(true)
        if (!Array.isArray(row.result) && row.result.originalFile !== null) expect(row.result.originalFile).toBe(revision)
        revision = revision!.replace(old, String(row.input.new_string))
      } else {
        expect(String(row.input.command).startsWith('# Codex apply_patch: ')).toBe(true)
        expect(row.result).toMatchObject({ stderr: '', interrupted: false })
        if (c.status) expect(row.error).toContain(c.change.diff!)
      }
    }
    if (rows[0]!.tool === 'Edit') expect(revision).toBe(c.after)
    if (c.id === 'ordered-hunks') {
      expect((rows[1]!.result as any).structuredPatch[0]).toMatchObject({ oldStart: 4, newStart: 4 })
    }
    if (c.id === 'move-edit' || c.id === 'exec-move') {
      expect((rows[0]!.result as any).bashEditDiff).toMatchObject({ changedFiles: ['/work/old', '/work/new'],
        files: [{ filePath: '/work/old', deleted: true, hunks: [{ lines: ['-old'] }] }, { filePath: '/work/new', created: true, hunks: [{ lines: ['+new'] }] }] })
    }
    if (['delete-no-bytes', 'delete-sampled-only', 'move-metadata', 'binary-add'].includes(c.id)) expect((rows[0]!.result as any).bashEditDiff).toBeUndefined()
    if (['delete-diff', 'delete-no-snapshot'].includes(c.id)) expect((rows[0]!.result as any).bashEditDiff.files[0].deleted).toBe(true)
  })
}

test('batch 3 grammar refuses truncated/count-mismatched, overlapping, offset and binary patches', () => {
  for (const diff of ['@@ -1,2 +1 @@\n-old\n+new\n', '@@ -1 +1 @@\n-old\n+new', 'GIT binary patch\nliteral 0\n', '@@ -1 +1 @@\n\\ No newline at end of file\n-old\n+new\n']) {
    expect(parsePatch(diff, 'update')).toBeUndefined()
  }
  for (const diff of ['@@ -2 +2 @@\n-old\n+new\n', '@@ -1 +2 @@\n-old\n+new\n', '@@ -1 +1 @@\n-old\n+new\n@@ -1 +1 @@\n-old\n+new\n']) {
    expect(patchActions({ path: '/work/edit', kind: 'update', diff }, 'old\n', 'new\n', 'completed')[0]!.tool).toBe('Bash')
  }
})

for (const c of batch3Cases) {
  test(`batch 3 guarded lifecycle: ${c.id}`, async ($, on) => {
    const files = new Map<string, string>()
    if (c.before !== undefined) files.set(c.change.path, c.before)
    const move = typeof c.change.kind === 'object' ? c.change.kind.move_path : c.change.move_path
    const completedPath = move ?? c.change.path
    const item = { type: 'file_change', id: c.id, status: c.status ?? 'completed', changes: [c.change] }
    let completedReads = 0
    let completed = false
    const w = world(on, { files, readFile: (path, value) => {
      if (completed && path === completedPath && c.stable === false && ++completedReads === 2) return 'raced\n'
      return value
    }, pieces: [
      out(itemLine({ ...item, status: 'in_progress' }, 'item.started')),
      () => {
        completed = true
        if (c.after !== undefined) files.set(completedPath, c.after)
        else files.delete(completedPath)
        return true
      },
      out(itemLine(item)), out(itemLine(item)),
      out(JSON.stringify({ type: 'codexmod.source', source: { transport: 'app-server', event: 'turn/diff/updated', data: { diff: c.change.diff } } })),
      MESSAGE('Done'),
    ] })
    const first = await step($, 'agent-progress')
    const calls = callsOf(first.chunks)
    expect(calls.map(r => r.name)).toEqual(c.tools)
    const writes = w.writes.length
    for (const call of calls) {
      expect((await $.tool.check({ tool: call.name, input: call.input, tool_use_id: call.id, agentId: 'agent-progress' } as any)).decision).toBe('deny')
      expect((await $.tool.call({ tool: call.name, ...call.input, tool_use_id: call.id, agentId: 'agent-gp' } as any) as any).deny).toContain('not executed')
      expect((await $.tool.call({ tool: call.name, ...call.input, description: 'forged', tool_use_id: call.id, agentId: 'agent-progress' } as any) as any).deny).toContain('not executed')
    }
    const answers: any[] = await runCalls($, first.chunks, 'agent-progress')
    answers.forEach((answer, n) => {
      if (c.status) expect(answer.deny).toContain(c.change.diff!)
      else expect(validAction({ tool: calls[n].name, input: calls[n].input, result: answer.result })).toBe(true)
    })
    for (const call of calls) expect((await $.tool.call({ tool: call.name, ...call.input, tool_use_id: call.id, agentId: 'agent-progress' } as any) as any).deny).toContain('not executed')
    expect(w.writes.length).toBe(writes)
    expect(w.core).toEqual([])
    const final = await step($, 'agent-progress', 1)
    expect(handback(final.result)).toContain(`1 patch / ${calls.length} file row`)
    const record: any = savedState(w, 'agent:sess-1:agent-progress')
    expect(record.wire.records.filter((r: any) => r.event === 'item.completed' && r.item?.type === 'fileChange').length).toBe(1)
    expect(Object.keys(record.wire.rows).length).toBe(calls.length)
  })
}

test('batch 3 typed Bash boundary excludes false flags, extra shell metadata and malformed hunks', () => {
  const a = patchActions({ path: '/a', kind: 'delete', diff: '-old\n' }, undefined, undefined, 'completed')[0]!
  const result = a.result as any
  for (const d of [
    { ...result.bashEditDiff, moreFiles: -1 },
    { ...result.bashEditDiff, changedFiles: ['/other'] },
    { ...result.bashEditDiff, files: [{ filePath: '/a', hunks: [], deleted: false }] },
    { ...result.bashEditDiff, files: [{ filePath: '/a', hunks: [], deleted: true, created: true }] },
    { ...result.bashEditDiff, files: [{ filePath: '/a', hunks: [{ oldStart: -1, oldLines: 0, newStart: 0, newLines: 0, lines: [] }] }] },
  ]) expect(validAction({ ...a, result: { ...result, bashEditDiff: d } })).toBe(false)
  for (const extra of [{ exitCode: 0 }, { gitOperation: {} }, { backgroundTaskId: 'invented' }]) expect(validAction({ ...a, result: { ...result, ...extra } })).toBe(false)
})

test('batch 3 source cwd, relative move destination and late patchUpdated data bind to one patch', async ($, on) => {
  const files = new Map([['/elsewhere/old.txt', 'old\n']])
  const change = { path: 'old.txt', kind: { type: 'update', move_path: './new.txt' }, diff: '@@ -1 +1 @@\n-old\n+new\n' }
  const line = (event: string, item: any) => JSON.stringify({ type: event === 'item/started' ? 'item.started' : 'item.completed', item: { type: 'file_change' },
    source: { transport: 'app-server', event, threadId: 'thread', turnId: 'turn', item: { type: 'fileChange', id: 'move', cwd: '/elsewhere', ...item } } })
  const w = world(on, { files, pieces: [
    out(line('item/started', { status: 'inProgress', changes: [change] })),
    () => { files.delete('/elsewhere/old.txt'); files.set('/elsewhere/new.txt', 'new\n'); return true },
    out(JSON.stringify({ type: 'codexmod.source', source: { transport: 'app-server', event: 'item/fileChange/patchUpdated', threadId: 'thread', turnId: 'turn', data: { itemId: 'move', changes: [change] } } })),
    out(line('item/completed', { status: 'completed', changes: [{ path: 'old.txt', kind: change.kind }] })),
    MESSAGE('Done'),
  ] })
  const s = await step($, 'agent-progress')
  const [answer]: any[] = await runCalls($, s.chunks, 'agent-progress')
  expect(callsOf(s.chunks).map(c => c.name)).toEqual(['Bash'])
  expect(answer.result.bashEditDiff.changedFiles).toEqual(['/elsewhere/old.txt', '/elsewhere/new.txt'])
  expect(answer.result.stdout).toContain(change.diff)
  expect(w.core).toEqual([])
})

test('batch 3 whole-patch failure only admits individually confirmed successes', async ($, on) => {
  const changes = [
    { path: 'confirmed', kind: { type: 'add' }, diff: '+yes\n', status: 'completed' },
    { path: 'unproved', kind: { type: 'add' }, diff: '+maybe\n' },
  ]
  const w = world(on, { pieces: [out(itemLine({ type: 'file_change', id: 'partial', status: 'failed', error: { message: 'actual partial failure' }, changes })), MESSAGE('Done')] })
  const s = await step($, 'agent-progress')
  expect(callsOf(s.chunks).map(c => c.name)).toEqual(['Write', 'Bash'])
  const answers: any[] = await runCalls($, s.chunks, 'agent-progress')
  expect(answers[0].result.content).toBe('yes\n')
  expect(answers[1].deny).toContain('actual partial failure')
  expect(answers[1].deny).toContain('+maybe\n')
  const final = await step($, 'agent-progress', 1)
  expect(handback(final.result)).toContain('1 action · 1 patch / 2 file rows')
  expect(w.core).toEqual([])
})

test('batch 3 missing Write/Edit admission uses the typed Bash patch candidate', async ($, on) => {
  const w = world(on, { availableTools: ['Bash'], pieces: [out(itemLine({ type: 'file_change', id: 'add', status: 'completed', changes: [{ path: 'a', kind: { type: 'add' }, diff: '+new\n' }] })), MESSAGE('Done')] })
  const s = await step($, 'agent-progress')
  expect(callsOf(s.chunks).map(c => c.name)).toEqual(['Bash'])
  const [answer]: any[] = await runCalls($, s.chunks, 'agent-progress')
  expect(answer.result.bashEditDiff.files[0]).toMatchObject({ filePath: '/tmp/project/a', created: true })
  expect(answer.result.stdout).toContain('Write unavailable')
  expect(w.core).toEqual([])
})

test('batch 3 nativeActions off preserves patch failure and literal diff without executing a tool', { options: { nativeActions: false } }, async ($, on) => {
  const w = world(on, { pieces: [out(itemLine({ type: 'file_change', id: 'failed', status: 'declined', changes: [{ path: 'a', kind: 'add', diff: '+attempt\n' }] })), MESSAGE('Done')] })
  const s = await step($, 'agent-progress')
  expect(callsOf(s.chunks).map(c => c.name)).toEqual(['SubagentHandback'])
  const text = s.chunks.filter(c => c.kind === 'text').map(c => c.text).join('\n')
  expect(text).toContain('declined')
  expect(text).toContain('+attempt\n')
  expect(w.core).toEqual([])
})

test('batch 3 patch descriptions keep newline paths in a single display comment', () => {
  const row = patchActions({ path: '/a\nrm x', kind: 'delete' }, undefined, undefined, 'completed')[0]!
  expect(String(row.input.command).split('\n').length).toBe(1)
  expect(String((row.result as any).stdout)).toContain('/a\nrm x')
})

test('batch 3 one inexact hunk falls back for the whole file, without leaking prior exact rows', () => {
  const before = 'first\n' + 'o'.repeat(100001) + '\n'
  const after = 'FIRST\n' + 'n'.repeat(100001) + '\n'
  const diff = '@@ -1 +1 @@\n-first\n+FIRST\n@@ -2 +2 @@\n-' + 'o'.repeat(100001) + '\n+' + 'n'.repeat(100001) + '\n'
  const rows = patchActions({ path: '/a', kind: 'update', diff }, before, after, 'completed')
  expect(rows.map(r => r.tool)).toEqual(['Bash'])
  expect((rows[0]!.result as any).bashEditDiff.files[0].hunks.length).toBe(2)
})

test('batch 3 unreported failure paths/status still produce a native error row', async ($, on) => {
  const w = world(on, { pieces: [out(itemLine({ type: 'file_change', id: 'unknown', error: { message: 'actual unreported outcome' }, changes: [] })), MESSAGE('Done')] })
  const s = await step($, 'agent-progress')
  expect(callsOf(s.chunks).map(c => c.name)).toEqual(['Bash'])
  const [answer]: any[] = await runCalls($, s.chunks, 'agent-progress')
  expect(answer.deny).toContain('paths unreported')
  expect(answer.deny).toContain('actual unreported outcome')
  expect(w.core).toEqual([])
})

for (const tool of ['Write', 'Edit']) {
  test(`batch 3 parent paths: read path builder and rendered ${tool} retain literal segments`, async ($, on) => {
    const path = '/tmp/project/link/../a'
    // The host normalizes fs.read before hooks; assert the shared pure path builder instead.
    expect(absolute('/tmp/project', 'link/../a')).toBe(path)
    expect(absolute('/elsewhere', path)).toBe(path)
    const files = new Map([['/tmp/project/a', tool === 'Edit' ? 'old\n' : 'new\n']])
    const item = { type: 'file_change', id: `parent-${tool}`, status: 'completed', changes: [{ path: 'link/../a',
      kind: tool === 'Edit' ? 'update' : 'add', diff: tool === 'Edit' ? '@@ -1 +1 @@\n-old\n+new\n' : '+new\n' }] }
    const w = world(on, { files, pieces: [
      out(itemLine({ ...item, status: 'in_progress' }, 'item.started')),
      () => { files.set('/tmp/project/a', 'new\n'); return true },
      out(itemLine(item)), MESSAGE('Done'),
    ] })
    const s = await step($, 'agent-progress')
    expect(callsOf(s.chunks).map(c => [c.name, c.input.file_path])).toEqual([[tool, path]])
    await runCalls($, s.chunks, 'agent-progress')
    expect(w.core).toEqual([])
  })
}

// Batch 4: source fixtures are shared with the fake app-server, not invented host schemas.
const batch4Tool = (item: any) => item.type === 'webSearch' && item.id.startsWith('search-') && item.id !== 'search-no-query'
  ? 'WebSearch' : ['open-full', 'find-full', 'open-http-failure'].includes(item.id) ? 'WebFetch' : 'mcp__codex-mod__codex_tool'
const batch4Line = (item: any, transport: 'exec' | 'app-server' = 'app-server', event = 'completed') => {
  const raw = execItem(item)
  return JSON.stringify({ type: `item.${event}`, item: raw, ...(transport === 'app-server' ? { source: {
    transport, event: `item/${event}`, threadId: 'batch4-thread', turnId: 'batch4-turn', item,
  } } : {}) })
}

for (const item of batch4Items) for (const transport of ['exec', 'app-server'] as const) {
  test(`batch 4 ${transport} guarded source fidelity: ${item.id}`, async ($, on) => {
    const w = world(on, { availableTools: [...NATIVE_TOOLS, 'mcp__parity_fixture__lookup'], stdout:
      batch4Line({ ...item, ...('status' in item ? { status: 'inProgress' } : {}) }, transport, 'started') + '\n' +
      batch4Line(item, transport) + '\n' + batch4Line(item, transport) + '\n' + itemLine({ type: 'agent_message', text: 'Done' }) + '\n' })
    const first = await step($, 'agent-progress')
    const [call] = callsOf(first.chunks)
    expect(callsOf(first.chunks).length).toBe(1)
    expect(call.name).toBe(batch4Tool(item))
    expect((await $.tool.check({ tool: call.name, input: call.input, tool_use_id: call.id, agentId: 'agent-progress' } as any)).decision).toBe('deny')
    for (const change of [{ agentId: 'agent-gp' }, { tool: 'mcp__parity_fixture__lookup' }, { extra: 'forged' }]) {
      expect((await $.tool.call({ tool: call.name, ...call.input, tool_use_id: call.id, agentId: 'agent-progress', ...change } as any) as any).deny).toContain('not executed')
    }
    const answer: any = await $.tool.call({ tool: call.name, ...call.input, tool_use_id: call.id, agentId: 'agent-progress' } as any)
    const failed = item.status === 'failed' || ('success' in item && item.success === false) || ('result' in item && (item.result as any)?.isError === true)
    if (failed && item.id !== 'open-http-failure') expect(answer.deny).toContain('Codex')
    else {
      expect(answer.deny).toBe(undefined)
      expect(validAction({ tool: call.name, input: call.input, result: answer.result })).toBe(true)
      if (call.name === 'WebSearch') {
        for (const result of answer.result.results) if (typeof result === 'object') expect(result.tool_use_id).toBe(call.id)
      }
      if (item.id === 'open-http-failure') expect(answer.result.code).toBe(404)
    }
    expect((await $.tool.call({ tool: call.name, ...call.input, tool_use_id: call.id, agentId: 'agent-progress' } as any) as any).deny).toContain('not executed')
    expect(w.core).toEqual([])
    expect(w.checks).toEqual([])
    expect(w.writes).toEqual([])
    const final = await step($, 'agent-progress', 1)
    expect(callsOf(final.chunks).map(c => c.name)).toEqual(['SubagentHandback'])
    const record: any = savedState(w, 'agent:sess-1:agent-progress')
    const sources = record.wire.records.filter((s: any) => s.event.endsWith('completed') && s.item?.id === item.id)
    expect(sources.length).toBe(1)
    expect(sources[0].item.results ?? sources[0].item.result ?? sources[0].item.contentItems).toEqual(
      (item as any).results ?? (item as any).result ?? (item as any).contentItems)
    expect(Object.keys(record.wire.rows).length).toBe(1)
  })
}

test('batch 4 search exact empty/text/opaque/mixed results, query order, mode and timing', () => {
  const get = (id: string): any => webAction(batch4Items.find(i => i.id === id))
  expect(get('search-empty').result.results).toEqual([])
  expect(get('search-unparsed').result.results).toEqual(['not JSON: exact output'])
  expect(get('search-text').result.results).toEqual(['Exact reported text\nsecond line'])
  expect(get('search-opaque').result.results).toEqual(['{"opaque":{"answer":42}}', { tool_use_id: '', content: [{ title: 'Docs', url: 'https://example.test' }] }, 'tail text'])
  expect(get('search-null-results').result.results).toEqual(['null'])
  expect(get('search-queries').input.query).toBe('first actual query\nsecond actual query')
  expect(get('search-extended').input.mode).toBe('extended')
  const item = batch4Items.find(i => i.id === 'search-empty')!
  expect(webAction(item, { transport: 'exec', event: 'item.completed', item }).result.durationSeconds).toBe(0.015)
  expect(webAction({ ...item, results: JSON.stringify(item.results) }).result.results).toEqual([])
  expect(webAction(item, { transport: 'exec', event: 'item.completed', startedAtMs: 100, completedAtMs: 250 }).result.durationSeconds).toBe(0.15)
})

test('batch 4 WebFetch requires every reported response fact; rejects fabricated/invalid metadata', () => {
  const item: any = batch4Items.find(i => i.id === 'find-full')!
  const action = webAction(item)
  expect(action.input.prompt).toBe('Find "actual \\"pattern\\"" in the page reported by Codex')
  expect(action.result).toEqual(item.results[0])
  expect(webAction({ ...item, results: [{ ...item.results[0], headers: { actual: 'reported' } }] }).result).toEqual(item.results[0])
  for (const status of ['declined', 'failed']) expect(webAction({ ...item, status }).error).toContain(status)
  const untimed = { ...item.results[0] }
  delete untimed.durationMs
  expect(webAction({ ...item, results: [untimed] }, { transport: 'app-server', event: 'item/completed', startedAtMs: 10, completedAtMs: 32 }).result).toEqual({ ...item.results[0], durationMs: 22 })
  expect(webAction({ ...item, durationMs: 7, results: [untimed] }).result).toEqual({ ...item.results[0], durationMs: 7 })
  for (const key of ['url', 'bytes', 'code', 'codeText', 'result', 'durationMs']) {
    const r = { ...item.results[0] }
    delete r[key]
    expect(webAction({ ...item, results: [r] }).tool).toBe('codex_tool')
  }
  for (const invalid of [{ code: 0 }, { code: 600 }, { bytes: -1 }, { bytes: 1.5 }, { durationMs: -1 }, { url: 'https://unrelated.test' }]) {
    expect(webAction({ ...item, results: [{ ...item.results[0], ...invalid }] }).tool).toBe('codex_tool')
  }
  expect(validAction({ ...action, result: { ...item.results[0], invented: true } })).toBe(false)
  expect(validAction({ ...action, input: { ...action.input, agentId: 'forged' } })).toBe(false)
})

for (const available of [true, false]) test(`batch 4 WebFetch own allowlist and availability (${available})`, async ($, on) => {
  const w = world(on, { availableTools: available ? ['WebFetch'] : [], stdout: batch4Line(batch4Items.find(i => i.id === 'open-full')) + '\n' + itemLine({ type: 'agent_message', text: 'Done' }) })
  const specs: any[] = []
  on('agent.register', (_$, e: any) => { if (e.name !== 'codex-child') specs.push(e); return { value: { agent: `codex-mod:${e.name}` } } })
  await startSession($)
  expect(specs[0].tools.includes('WebFetch')).toBe(available)
  const first = await step($, 'agent-progress')
  expect(callsOf(first.chunks)[0].name).toBe(available ? 'WebFetch' : 'mcp__codex-mod__codex_tool')
  const [answer]: any[] = await runCalls($, first.chunks, 'agent-progress')
  if (!available) {
    expect(answer.result[0].text).toContain('WebFetch unavailable')
    expect(answer.result[0].text).toContain('Actual page text')
    expect(callsOf(first.chunks)[0].input.server).toBe('web')
    expect(callsOf(first.chunks)[0].input.name).toBe('openPage')
  }
  expect(w.core).toEqual([])
})

test('batch 4 tool fallback preserves structured/meta/media and reserved arguments without flattening', () => {
  for (const item of batch4Items.filter(i => ['mcpToolCall', 'dynamicToolCall'].includes(i.type))) {
    const action = toolFallback(item, 'Unknown host contract')
    expect(action.input.arguments).toEqual(item.arguments)
    expect(action.result[0].text).toContain('Unknown host contract')
    expect(JSON.stringify(action.result).includes('IMAGE_BYTES')).toBe(false)
    expect(JSON.stringify(action.result).includes('AUDIO_BYTES')).toBe(false)
    expect(JSON.stringify(action.result).includes('RESOURCE_BYTES')).toBe(false)
    expect(JSON.stringify(action.result).includes('DYNAMIC_IMAGE')).toBe(false)
    expect(JSON.stringify(action.result).includes('DYNAMIC_AUDIO')).toBe(false)
  }
  const structured: any = toolFallback(batch4Items.find(i => i.id === 'mcp-structured'), 'Unknown contract')
  expect(structured.result[0].text).toContain('"answer":42')
  expect(structured.result[0].text).toContain('"data":"literal data field"')
  expect(structured.result[0].text).toContain('"trace":"kept"')
  expect(publicToolText({ type: 'image', mimeType: 'image/png', data: 'SECRET' })).toContain('image/png')
})

for (const richRows of [false, true]) for (const nativeActions of [false, true]) {
  test(`batch 4 ordinary WebFetch and real MCP calls execute normally (${richRows}/${nativeActions})`, { options: { richRows, nativeActions } }, async ($, on) => {
    const w = world(on, { availableTools: ['WebFetch', 'mcp__parity_fixture__lookup'] })
    await startSession($)
    for (const tool of ['WebFetch', 'mcp__parity_fixture__lookup']) for (const agentId of [undefined, 'agent-gp']) {
      expect((await $.tool.call({ tool, tool_use_id: 'ordinary', agentId, topic: 'options' } as any) as any).result.stdout).toBe('REALLY RAN')
      expect((await $.tool.check({ tool, tool_use_id: 'ordinary', agentId, input: { topic: 'options' } } as any)).decision).toBe('allow')
    }
    expect(w.core.length).toBe(4)
    for (const tool of ['WebFetch', 'mcp__parity_fixture__lookup']) {
      expect((await $.tool.call({ tool, tool_use_id: `${ID_PREFIX}missing`, agentId: 'agent-progress' } as any) as any).deny).toContain('not executed')
    }
    expect(w.core.length).toBe(4)
  })
}

test('batch 4 fallback ToolUse labels exact source identity and keeps the native row after consumption', async ($, on) => {
  const w = world(on, { stdout: batch4Line(batch4Items.find(i => i.id === 'open-missing')) + '\n' + itemLine({ type: 'agent_message', text: 'Done' }) })
  on('ui.render', () => ({ type: 'Text', children: ['HOST'] }))
  const first = await step($, 'agent-progress')
  const [call] = callsOf(first.chunks)
  await runCalls($, first.chunks, 'agent-progress')
  const render = (tool: string, id: string) => $.ui.render({ component: 'ToolUse', surface: 'desktop', requestId: id,
    props: { tool, tool_use_id: id, input: { server: 'forged', name: 'forged' }, isRunning: false, isErrored: false, isInterrupted: false } } as any)
  const card: any = await render(call.name, call.id)
  expect(card.type).toBe('Box')
  expect(card.children[0].children).toEqual(['Codex web.openPage'])
  expect(card.children[1].children).toEqual(['HOST'])
  expect(w.reads.some(path => /state-row-cache\/row-\d+\.json$/.test(path))).toBe(true)
  const cached = [...w.files].find(([path]) => /state-row-cache\/row-\d+\.json$/.test(path))!
  expect(JSON.parse(cached[1]).row.source).toBe(undefined)
  expect(cached[1].length < 1024).toBe(true)
  await step($, 'agent-progress', 1)
  expect((await render(call.name, call.id) as any).children[0].children).toEqual(['Codex web.openPage'])
  const replay: any = await $.tool.call({ tool: call.name, ...call.input, tool_use_id: call.id, agentId: 'agent-progress' } as any)
  expect(replay.deny).toContain('not executed')
  for (const [tool, id] of [['Bash', call.id], [call.name, 'foreign'], [call.name, `${ID_PREFIX}missing`]]) {
    expect((await render(tool, id) as any).children).toEqual(['HOST'])
  }
})

test('batch 4 text mode keeps actual web and structured/media tool results without extra calls', { options: { nativeActions: false } }, async ($, on) => {
  const items = ['search-opaque', 'open-full', 'find-missing', 'mcp-structured', 'dynamic-image'].map(id => batch4Items.find(i => i.id === id)!)
  const w = world(on, { availableTools: [...NATIVE_TOOLS], stdout: items.map(i => batch4Line(i)).join('\n') + '\n' + itemLine({ type: 'agent_message', text: 'Done' }) })
  const result = await step($, 'agent-progress')
  const output = result.chunks.filter(c => c.kind === 'text').map(c => c.text).join('\n')
  expect(output).toContain('opaque')
  expect(output).toContain('Actual page text')
  expect(output).toContain('web.findInPage')
  expect(output).toContain('Only matches')
  expect(output).toContain('answer')
  expect(output).toContain('inputImage')
  expect(output.includes('DYNAMIC_IMAGE')).toBe(false)
  expect(w.core).toEqual([])
})

test('batch 4 open uses matched source timing before choosing its native row', async ($, on) => {
  const template: any = batch4Items.find(i => i.id === 'open-full')!
  const response = { ...template.results[0] }
  delete response.durationMs
  const item = { ...template, results: [response] }
  const line = (event: string, value: any, timing: any) => JSON.stringify({ type: `item.${event}`, item: execItem(value), source: {
    transport: 'app-server', event: `item/${event}`, threadId: 't', turnId: 'u', item: value, ...timing,
  } })
  const w = world(on, { availableTools: [...NATIVE_TOOLS], stdout:
    line('started', { ...item, results: null }, { startedAtMs: 100 }) + '\n' +
    line('completed', item, { completedAtMs: 120 }) + '\n' + itemLine({ type: 'agent_message', text: 'Done' }) })
  const first = await step($, 'agent-progress')
  expect(callsOf(first.chunks).map(c => c.name)).toEqual(['WebFetch'])
  const [answer]: any[] = await runCalls($, first.chunks, 'agent-progress')
  expect(answer.result.durationMs).toBe(20)
  expect(w.core).toEqual([])
})

// ---- Batch 5: shadow plans and nonexecuting child operation rows ----------
const b5Context = (tools = ['TaskCreate', 'TaskUpdate'], extra = {}) => ({ session: 's', agent: 'a', thread: 't', turn: 'turn', rich: true, tools: new Set(tools), ...extra })
const b5Actions = (rows: ReturnType<typeof planRows>) => rows.filter((r): r is Extract<typeof r, { kind: 'action' }> => r.kind === 'action').map(r => r.action)

test('batch 5 plan identity: rename, reorder, duplicates, completion, clear and restored snapshots', () => {
  let state = emptyDisplayState()
  const ctx = b5Context()
  const input: any = { explanation: 'Start', steps: [{ step: 'A', status: 'pending' }, { step: 'B', status: 'in_progress' }, { step: 'B', status: 'pending' }] }
  const first = b5Actions(planRows(input, state, ctx))
  expect(first.map(a => a.tool)).toEqual(['TaskCreate', 'TaskCreate', 'TaskUpdate', 'TaskCreate'])
  const ids = state.plans.t.steps.map(s => s.id)
  expect(new Set(ids).size).toBe(3)
  expect(planRows(input, state, ctx)).toEqual([])
  state = JSON.parse(JSON.stringify(state))
  const progress: any = { explanation: 'Progress', steps: input.steps.map(s => ({ ...s, status: 'completed' })) }
  const updates = b5Actions(planRows(progress, state, ctx))
  expect(updates.every(a => a.tool === 'TaskUpdate' && validAction(a))).toBe(true)
  expect(state.plans.t.steps.map(s => s.id)).toEqual(ids)
  const reordered = { ...progress, steps: [progress.steps[1], progress.steps[0], progress.steps[2]] }
  const reorder = b5Actions(planRows(reordered, state, ctx))
  expect(reorder.filter(a => a.input.status === 'deleted').map(a => a.input.taskId)).toEqual([ids[0], ids[1]])
  expect(state.plans.t.steps[2].id).toBe(ids[2])
  const renamed: any = { steps: [{ step: 'Renamed', status: 'pending' }] }
  expect(b5Actions(planRows(renamed, state, ctx)).filter(a => a.tool === 'TaskCreate').length).toBe(1)
  const clear = b5Actions(planRows({ steps: [] }, state, ctx))
  expect(clear.map(a => a.input.status)).toEqual(['deleted'])
  expect(planRows({ steps: [] }, state, ctx)).toEqual([])
  for (const a of [...first, ...updates, ...reorder, ...clear]) expect(validAction(a)).toBe(true)
  const isolated = emptyDisplayState()
  planRows(input, isolated, b5Context([], { thread: 'other' }))
  expect(state.plans.other).toBe(undefined)
  planRows(input, state, b5Context(['TaskCreate', 'TaskUpdate'], { thread: 'other' }))
  expect(state.plans.other.steps.some(s => ids.includes(s.id))).toBe(false)
  const foreign = emptyDisplayState()
  planRows(input, foreign, b5Context(['TaskCreate', 'TaskUpdate'], { agent: 'another' }))
  expect(foreign.plans.t.steps.some(s => ids.includes(s.id))).toBe(false)
})

test('batch 5 plan admission: exact TodoWrite history, paired Task tools, fallback checklist and surface changes', () => {
  const state = emptyDisplayState()
  const first: any = { steps: [{ step: 'A', status: 'pending' }] }
  const next: any = { explanation: 'Done\nFull explanation', steps: [{ step: 'A', status: 'completed' }] }
  const todo = b5Context(['TodoWrite', 'TaskCreate', 'TaskUpdate'])
  expect(b5Actions(planRows(first, state, todo))[0].result).toEqual({ oldTodos: [], newTodos: [{ content: 'A', status: 'pending', activeForm: 'A' }] })
  expect(b5Actions(planRows(next, state, todo))[0].result).toEqual({ oldTodos: [{ content: 'A', status: 'pending', activeForm: 'A' }], newTodos: [{ content: 'A', status: 'completed', activeForm: 'A' }] })
  for (const tools of [[], ['TaskCreate'], ['TaskUpdate']]) {
    const row = b5Actions(planRows(next, emptyDisplayState(), b5Context(tools)))[0]
    expect(row.tool).toBe('codex_plan')
    expect(row.result).toEqual([{ type: 'text', text: planText(next) }])
  }
  const switched = b5Actions(planRows(next, state, b5Context()))
  expect(switched.map(a => a.tool)).toEqual(['TaskCreate', 'TaskUpdate'])
  expect(b5Actions(planRows({ steps: [] }, emptyDisplayState(), b5Context([])))[0].result[0].text).toContain('empty checklist')
})

test('batch 5 child identity, completed spawn vs child lifetime, failed spawn, waits and activity dedup', () => {
  let state = emptyDisplayState()
  const ctx = b5Context(['Agent', 'SendMessage', 'TaskStop'])
  const spawn: any = batch5Items.find(e => e.item?.id === 'spawn').item
  const [a] = b5Actions(childRows(spawn, state, ctx))
  expect(validAction(a)).toBe(true)
  expect(a.result).toMatchObject({ status: 'completed', canContinueAgent: false, totalTokens: 0, agentId: displayChildId('s', B5_CHILD) })
  expect(a.result.content[0].text).toContain('child ' + B5_CHILD + ': running')
  expect(a.result.content[0].text).toContain('usage and duration unreported')
  expect(a.result.content[0].text).toContain('no host child task')
  const started: any = batch5Items.find(e => e.item?.id === 'started').item
  expect(childRows(started, state, ctx)).toEqual([])
  for (const status of ['failed', 'declined']) {
    const denied = b5Actions(childRows({ ...spawn, status, receiverThreadIds: ['failed-child'], agentsStates: {} }, state, ctx))[0]
    expect(denied.error).toContain(status)
    expect(denied.result).toEqual({})
    expect(state.children[JSON.stringify(['t', 'failed-child'])]).toBe(undefined)
  }
  state = JSON.parse(JSON.stringify(state))
  const send: any = batch5Items.find(e => e.item?.id === 'send').item
  const sent = b5Actions(childRows(send, state, b5Context(['SendMessage'], { session: 'resumed' })))[0]
  expect(sent.input.to).toEqual({ agentId: a.result.agentId })
  expect(sent.input.message).toBe(send.prompt)
  expect(sent.result).toEqual({ status: 'completed', agentsStates: send.agentsStates })
  expect(validAction(sent)).toBe(true)
  expect(childRows({ ...send, tool: 'wait' }, state, ctx)).toEqual([])
  const completed: any = batch5Items.find(e => e.item?.id === 'wait-completed').item
  const transition = childRows(completed, state, ctx)
  expect(transition.length).toBe(1)
  expect(transition[0].text).toContain('after 1200 ms')
  expect(transition[0].text).toContain('Exact child report\nAll checks passed.')
  expect(childRows(batch5Items.find(e => e.item?.id === 'completed').item, state, ctx)).toEqual([])
  expect(childRows(completed, state, ctx)).toEqual([])
})

test('batch 5 output contracts reject host IDs, owner/dependency writes, wrong updated fields and null send', () => {
  const state = emptyDisplayState()
  const plans = b5Actions(planRows({ steps: [{ step: 'A', status: 'completed' }] }, state, b5Context()))
  for (const a of plans) expect(validAction(a)).toBe(true)
  const create: any = plans[0], update: any = plans[1]
  const close: any = b5Actions(childRows(batch5Items.find(e => e.item?.id === 'close').item, state, b5Context(['TaskStop'])))[0]
  const send: any = b5Actions(childRows(batch5Items.find(e => e.item?.id === 'send').item, state, b5Context(['SendMessage'])))[0]
  for (const malformed of [
    { ...create, result: { task: { id: 'real-host-id', subject: create.input.subject } } },
    { ...update, input: { ...update.input, taskId: 'real-host-id' } },
    { ...update, input: { ...update.input, owner: 'main' } },
    { ...update, input: { ...update.input, addBlocks: ['real-host-id'] } },
    { ...update, result: { ...update.result, updatedFields: ['owner'] } },
    { ...update, result: { ...update.result, statusChange: { from: 'pending', to: 'pending' } } },
    { ...close, input: { task_id: 'real-host-child' } },
    { ...close, result: { ...close.result, task_type: 'local_agent' } },
    { ...send, result: null },
    { ...send, result: { success: true, message: 'Delivered' } },
    { ...send, input: { ...send.input, to: { agentId: 'real-host-child' } } },
  ]) expect(validAction(malformed)).toBe(false)
})

const b5Stream = (transport: 'exec' | 'app-server') => [JSON.stringify({ type: 'thread.started', thread_id: B5_THREAD }), ...batch5Items.flatMap((entry: any, index) => {
  if (entry.plan) return [JSON.stringify({ type: 'item.updated', thread_id: B5_THREAD, turn_id: 'b5-turn', item: { type: 'plan_update', id: 'plan-' + index, explanation: entry.plan.explanation, steps: entry.plan.plan } })]
  const item = entry.item
  return ['item.started', 'item.completed', 'item.completed'].map(event => JSON.stringify(transport === 'exec'
    ? { type: event, turn_id: 'b5-turn', item: { ...execItem(item), ...(event === 'item.started' ? { status: 'in_progress' } : {}) } }
    : { type: event, item: item.type === 'agentMessage' ? { type: 'agent_message', text: item.text, phase: item.phase } : { type: 'source_only' }, source: { transport, event: event.replace('.', '/'), threadId: B5_THREAD, turnId: 'b5-turn', item: { ...item, ...(event === 'item.started' ? { status: 'inProgress' } : {}) } } }))
})].join('\n') + '\n'

for (const transport of ['exec', 'app-server'] as const) for (const surface of ['tasks', 'todo', 'display', 'absent', 'registration-fails', 'text'] as const) {
  test(`batch 5 ${transport} ${surface}: own admission, source binding, schema, replay and no host execution`, { options: { richRows: surface !== 'display', nativeActions: surface !== 'text', transport, nestedAgents: false, progressIntervalMs: 0 } }, async ($, on) => {
    const tools = surface === 'absent' || surface === 'registration-fails' ? [] : ['Agent', 'SendMessage', 'TaskStop', ...(surface === 'todo' ? ['TodoWrite'] : ['TaskCreate', 'TaskUpdate'])]
    const w = world(on, { availableTools: tools, stdout: b5Stream(transport), toolRegisterThrows: surface === 'registration-fails' ? 'codex_tool' : undefined })
    if (transport === 'app-server') {
      on('process.run', (_$, e: any) => runOk(e.argv[0] === 'which' ? `/usr/local/bin/${e.argv[1]}` : RUNNER_PATH.test(e.argv[1] ?? '') ? '1' : 'codex-cli 0.163.0'))
      on('fs.exists', (_$, e: any) => ({ value: RUNNER_PATH.test(e.path) }))
    }
    const specs: any[] = []
    on('agent.register', (_$, e: any) => { if (e.name !== 'codex-child') specs.push(e); return { value: { agent: 'codex-mod:' + e.name } } })
    await startSession($)
    const emitted: any[] = [], results: any[] = []
    let final = '', text = ''
    for (let i = 0; i < 40; i++) {
      const s = await step($, 'agent-progress', i)
      text += s.chunks.filter(c => c.kind === 'text').map(c => c.text).join('\n')
      if (s.result.toolUses.some(u => u.name === 'SubagentHandback')) { final = handback(s.result); break }
      for (const c of callsOf(s.chunks)) {
        expect(specs[0].tools.includes(c.name)).toBe(true)
        emitted.push(c)
        for (const agentId of [undefined, 'agent-gp', 'agent-normal']) expect((await $.tool.call({ tool: c.name, ...c.input, tool_use_id: c.id, agentId } as any) as any).deny).toContain('not executed')
        expect((await $.tool.check({ tool: c.name, input: c.input, tool_use_id: c.id, agentId: 'agent-progress' } as any)).decision).toBe('deny')
        expect((await $.tool.call({ tool: c.name, ...c.input, tool_use_id: c.id, agentId: 'agent-progress', unexpected: 'tamper' } as any) as any).deny).toContain('not executed')
        const answer: any = await $.tool.call({ tool: c.name, ...c.input, tool_use_id: c.id, agentId: 'agent-progress' } as any)
        results.push(answer)
        expect((await $.tool.call({ tool: c.name, ...c.input, tool_use_id: c.id, agentId: 'agent-progress' } as any) as any).deny).toContain('not executed')
      }
    }
    expect(final).toContain('Batch 5 complete.')
    expect(w.core).toEqual([])
    expect(w.checks).toEqual([])
    expect(w.modelCalls).toEqual([])
    expect(w.spawned.length).toBe(1)
    expect(w.writes).toEqual([])
    const record: any = savedState(w, 'agent:sess-1:agent-progress')
    expect(record.display.plans[B5_THREAD].steps).toEqual([])
    expect(record.display.children[JSON.stringify([B5_THREAD, B5_CHILD])].displayId).toBe(displayChildId('sess-1', B5_CHILD))
    if (surface === 'text' || surface === 'registration-fails') {
      expect(emitted).toEqual([])
      expect(text + final).toContain('Literal <tag> & Unicode café.')
    } else if (surface === 'tasks' || surface === 'todo') {
      expect(emitted.some(c => c.name === (surface === 'tasks' ? 'TaskCreate' : 'TodoWrite'))).toBe(true)
      const agentIndexes = emitted.map((c, i) => c.name === 'Agent' ? i : -1).filter(i => i >= 0)
      expect(agentIndexes.length).toBe(4)
      expect(results[agentIndexes[0]].result.status).toBe('completed')
      expect(results[agentIndexes[1]].deny).toContain('Capacity exhausted')
      expect(results[agentIndexes[2]].deny).toContain('declined')
      expect(results[agentIndexes[3]].result.content[0].text).toContain(': unknown')
      expect(emitted.filter(c => c.name === 'SendMessage').map(c => c.input.message)).toEqual([
        'Check the reducer boundary.\nLiteral <tag> & Unicode café.', 'Full failed message', 'Follow-up body\nPreserve me.',
      ])
      expect(emitted.filter(c => c.name === 'TaskStop').length).toBe(3)
    } else {
      expect(emitted.every(c => c.name.startsWith('mcp__'))).toBe(true)
      expect(results.some(r => JSON.stringify(r).includes('empty checklist'))).toBe(true)
    }
  })
}

// Characterize Q1's evidence boundary, not an imported or invented host reducer.
// Native Task* persistence lives in the skipped executor; TodoWrite input can
// affect a derived main list only when the host loses the child parent scope.
test('batch 5 reducer evidence boundary: child stream/reload/resume cannot replace main todos when parent scope survives', { options: { richRows: true } }, async ($, on) => {
  const w = world(on, { availableTools: ['TodoWrite'], stdout: b5Stream('exec') })
  const main = [{ content: 'MAIN SENTINEL', status: 'pending', activeForm: 'MAIN SENTINEL' }]
  const mainReader = (rows: any[]) => rows.reduce((todos, row) => row.parent_tool_use_id != null || row.name !== 'TodoWrite' ? todos : row.input.todos, main)
  const rows: any[] = []
  for (let i = 0; i < 40; i++) {
    const s = await step($, 'agent-progress', i)
    if (s.result.toolUses.some(u => u.name === 'SubagentHandback')) break
    for (const c of callsOf(s.chunks)) {
      expect((c.input as any).parent_tool_use_id).toBe(undefined)
      rows.push({ ...c, parent_tool_use_id: 'actual-host-parent-spawn-id' })
    }
    await runCalls($, s.chunks, 'agent-progress')
  }
  expect(rows.some(r => r.name === 'TodoWrite')).toBe(true)
  for (const representation of [rows, JSON.parse(JSON.stringify(rows)), JSON.parse(JSON.stringify(rows))]) expect(mainReader(representation)).toEqual(main)
  expect(mainReader(rows.map(r => ({ ...r, parent_tool_use_id: null })))).toEqual([])
  expect(w.core).toEqual([])
  expect(w.writes).toEqual([])
})

// ---- Batch 6: images, prose/modes, questions and durable receipts ----------
const b6Line = (item: any, transport: 'exec' | 'app-server' = 'app-server') => transport === 'exec' ? itemLine(execItem(item)) : JSON.stringify({ type: 'item.completed',
  item: item.type === 'agentMessage' ? { type: 'agent_message', text: item.text, phase: item.phase }
    : item.type === 'reasoning' ? { type: 'reasoning', summary: item.summary } : { type: 'source_only' },
  source: { transport, event: 'item/completed', threadId: 'thr-1', turnId: 'turn-1', item } })
const b6Source = (event: string, data: any = {}) => JSON.stringify({ type: 'codexmod.source', source: { transport: 'app-server', event, threadId: 'thr-1', turnId: 'turn-1', data } })
const b6Request = (status: string, extra: any = {}) => out(JSON.stringify({ type: 'codexmod.request', token: 'request-token', requestId: 201, method: 'item/tool/requestUserInput', params: questionParams, status, ...extra }))
const b6Render = ($: any, call: any) => $.ui.render({ component: 'ToolUse', surface: 'desktop', requestId: call.id, props: {
  tool: call.name, tool_use_id: call.id, input: call.input, isRunning: false, isErrored: false, isInterrupted: false,
} })

// Assert exact bytes and format against original fixture bytes, not the filename.
test('batch 6 image contract sniffs MIME/size and rejects malformed, oversized and invented Read fields', () => {
  for (const image of batch6Images) expect(imageFile(image.base64)).toEqual({ base64: image.base64, type: image.mime, originalSize: image.size })
  const file = imageFile(PNG)!
  expect(file.type).toBe('image/png')
  expect(file.originalSize).toBe(PNG.length / 4 * 3 - (PNG.endsWith('==') ? 2 : PNG.endsWith('=') ? 1 : 0))
  const a: any = { tool: 'Read', input: { file_path: '/tmp/no-extension' }, result: { type: 'image', file } }
  expect(validAction(a)).toBe(true)
  for (const bad of ['', 'not base64', 'PHN2Zy8+', PNG.slice(4), 'A'.repeat(Math.ceil(IMAGE_MAX / 3) * 4 + 4)]) expect(imageFile(bad)).toBe(undefined)
  for (const result of [{ type: 'image', file: { ...file, originalSize: file.originalSize + 1 } }, { type: 'image', file: { ...file, type: 'image/svg+xml' } }, { type: 'image', file: { ...file, filePath: '/tmp/image' } }]) expect(validAction({ ...a, result })).toBe(false)
})

for (const failure of ['changed', 'oversize', 'unsupported', 'missing']) test(`batch 6 ${failure} image capture has a faithful fallback`, async () => {
  const size = imageFile(PNG)!.originalSize
  let stats = 0, reads = 0
  const api: any = { fs: {
    stat: async () => {
      if (failure === 'missing') throw new Error('ENOENT image')
      return { kind: 'file', size: failure === 'oversize' ? IMAGE_MAX + 1 : size, mtimeMs: failure === 'changed' ? ++stats : 1, isLink: false, realPath: '/tmp/image' }
    },
    read: async () => { reads++; return { base64: failure === 'unsupported' ? 'PHN2Zy8+' : PNG } },
  } }
  const result = await captureImage(api, '/tmp/image')
  expect(result.action).toBe(undefined)
  expect(result.reason).toContain(failure === 'oversize' ? '4 MiB' : failure === 'missing' ? 'ENOENT' : failure)
  if (failure === 'oversize') expect(reads).toBe(0)
})

for (const nativeActions of [true, false]) test(`batch 6 full image/mode corpus, nativeActions ${nativeActions}`, { options: { nativeActions, progressIntervalMs: 0 } }, async ($, on) => {
  const size = imageFile(PNG)!.originalSize
  const corpus = batch6Items.map(i => b6Line(i))
  const w = world(on, { availableTools: ['Read'], binary: new Map([['/tmp/project/batch6/view.png', PNG], ['/tmp/project/batch6/generated.png', PNG]]),
    stdout: [b6Source('thread/compacted'), ...corpus, b6Source('thread/compacted'), itemLine({ type: 'error', id: 'warning', message: 'Configuration warning' })].join('\n') })
  on('fs.stat', (_$, e: any) => {
    if (e.path.includes('missing')) throw new Error('ENOENT image')
    return { value: { kind: 'file', size, mtimeMs: 1, isLink: false, realPath: e.path } }
  })
  const emitted: any[] = [], answers: any[] = [], chunks: any[] = []
  let final = ''
  for (let index = 0; index < 20; index++) {
    const s = await step($, 'agent-progress', index)
    chunks.push(...s.chunks)
    if (callsOf(s.chunks).some(c => c.name === 'SubagentHandback')) { final = handback(s.result); break }
    emitted.push(...callsOf(s.chunks))
    answers.push(...await runCalls($, s.chunks, 'agent-progress'))
  }
  expect(final).toContain('Batch 6 complete.')
  expect(final).toContain('6 actions')
  for (const prose of ['Working commentary.', 'Incomplete partial answer.', 'Configuration warning', 'review mode', 'Codex waited']) expect(final).not.toContain(prose)
  const text = chunks.filter(c => c.kind === 'text').map(c => c.text).join('\n')
  expect(text).toContain(batch6Items.find(i => i.id === 'review-start')!.review)
  expect(text).toContain(batch6Items.find(i => i.id === 'review-end')!.review)
  expect(text.match(/Codex compacted context/g)?.length).toBe(1)
  expect(text).toContain('Codex waited 25 ms')
  expect(text).toContain('Configuration warning')
  expect(JSON.stringify(chunks)).not.toContain('PRIVATE_')
  if (nativeActions) {
    expect(emitted.map(c => c.name)).toEqual(['Read', 'mcp__codex-mod__codex_tool', 'Read', 'mcp__codex-mod__codex_tool', 'mcp__codex-mod__codex_tool'])
    expect(answers.filter(a => a.result?.type === 'image').map(a => a.result.file.base64)).toEqual([PNG, PNG])
    expect(answers.some(a => a.deny?.includes('image quota exceeded'))).toBe(true)
    expect(text).toContain('later file image')
    expect(chunks.some(c => c.kind === 'thinking' && c.text.includes('Public summary.'))).toBe(true)
  } else {
    expect(w.reads.some(p => p.endsWith('.png'))).toBe(false)
    expect(text).toContain('nativeActions:false')
    expect(text).toContain('Actual revised prompt')
  }
  expect(w.sleeps).toEqual([])
  expect(w.core).toEqual([])
  expect(w.writes).toEqual([])
})

test('batch 6 structured findings require every reported field and a matching guarded result', () => {
  const item: any = { level: 'medium', findings: [{ file: 'hooks/a.ts', line: 3, summary: 'Issue', failure_scenario: 'Trigger', verdict: 'PLAUSIBLE' }] }
  const a = findingsAction(item)!
  expect(validAction(a)).toBe(true)
  expect(validAction({ ...a, result: { ...a.result, count: 2 } })).toBe(false)
  expect(findingsAction({ findings: [{ file: 'a', summary: 'No failure scenario' }] })).toBe(undefined)
  expect(findingsAction({ ...item, level: 'invented' })).toBe(undefined)
})

test('batch 6 partial/commentary, review and warning alone never satisfy a missing final answer', async ($, on) => {
  const w = world(on, { stdout: batch6Items.filter(i => ['commentary', 'partial', 'review-end'].includes(i.id)).map(i => b6Line(i, 'exec')).join('\n') + '\n' + itemLine({ type: 'error', message: 'Configuration warning' }) })
  const s = await step($, 'agent-progress')
  expect(handback(s.result)).toContain('codex failed: no agent message')
  for (const text of ['Incomplete partial answer.', 'Working commentary.', 'Full review result.']) expect(handback(s.result)).not.toContain(text)
  expect(w.core).toEqual([])
})

test('batch 6 question normalization accepts only actual bounded, non-secret choice answers', () => {
  expect(choiceQuestions(questionParams)).toBe(true)
  expect(choiceResponse(questionParams, ANSWER)).toBe(true)
  const a = answeredQuestion(questionParams, ANSWER)!
  expect(a.input.answers).toEqual({ 'Which mode?': 'Small' })
  expect(validAction(a)).toBe(true)
  expect(validAction({ ...a, result: { ...a.result, answers: { 'Which mode?': 'Invented' } } })).toBe(false)
  for (const changes of [{ isSecret: true }, { isOther: true }, { options: null }, { header: 'header too long' }, { options: [questionParams.questions[0].options[0]] }]) expect(choiceQuestions({ ...questionParams, questions: [{ ...questionParams.questions[0], ...changes }] })).toBe(false)
  for (const result of [{ answers: {} }, { answers: { mode: { answers: [] } } }, { answers: { mode: { answers: ['Invented'] } } }, { answers: { mode: { answers: ['Small', 'Full'] } } }]) expect(answeredQuestion(questionParams, result)).toBe(undefined)
})

for (const cancel of [false, true]) test(`batch 6 owned pending question ${cancel ? 'cancel' : 'answer'} UI writes exactly once after explicit controls`, { options: { transport: 'app-server', lean: false, richRows: true, progressIntervalMs: 0 } }, async ($, on) => {
  const w = appWorld(on, { availableTools: ['AskUserQuestion'], pieces: [THREAD('thr-1'), TURN('turn-1'), b6Request('pending'), () => w.writes.some(v => v.path.includes('/response-')), b6Request(cancel ? 'cancelled' : 'answered', cancel ? { error: { code: -32800, message: 'user cancelled' } } : { result: ANSWER }), MESSAGE('Done')] })
  await startSession($)
  const s = await step($, 'agent-progress')
  const call = callsOf(s.chunks)[0]
  expect(call.name).toBe('mcp__codex-mod__codex_question')
  expect(w.spawned[0].argv.slice(-2)).toEqual(['--questions', 'choices'])
  const [ack]: any[] = await runCalls($, s.chunks, 'agent-progress')
  expect(JSON.stringify(ack)).toContain('awaiting an explicit user response')
  expect(w.writes).toEqual([])
  const card: any = await b6Render($, call)
  const buttons = card.children.filter((c: any) => c.type === 'Button')
  expect(buttons.length).toBe(4)
  // The resolved tree holds callback handles; ui.press invokes the actual handler.
  const press = (button: any) => $.ui.press({ plugin: 'codex-mod', surface: 'desktop', requestId: call.id, key: button.props.key } as any)
  if (!cancel) {
    await press(buttons[2])
    expect(w.writes).toEqual([])
    await press(buttons[0])
  }
  await press(buttons[cancel ? 3 : 2])
  await press(buttons[cancel ? 3 : 2])
  expect(w.writes.length).toBe(1)
  expect(JSON.parse(w.writes[0].text)).toMatchObject({ token: 'request-token', requestId: 201, threadId: 'thr-1', turnId: 'turn-1', itemId: 'question-1', ...(cancel ? { cancel: true } : { result: ANSWER }) })
  const next = await step($, 'agent-progress', 1)
  if (!cancel) {
    expect(callsOf(next.chunks).map(c => c.name)).toEqual(['AskUserQuestion'])
    const [answer]: any[] = await runCalls($, next.chunks, 'agent-progress')
    expect(answer.result.answers).toEqual({ 'Which mode?': 'Small' })
    const final = await step($, 'agent-progress', 2)
    expect(handback(final.result)).toContain('Done')
  } else expect(handback(next.result)).toContain('Done')
  expect(w.core).toEqual([])
})

for (const tool of ['AskUserQuestion', 'ReportFindings', 'Read']) test(`batch 6 ${tool} guards preserve ordinary work and refuse Codex, replay, foreign and unresolved calls`, async ($, on) => {
  const w = world(on)
  for (const agentId of [undefined, 'agent-gp']) {
    const result: any = await $.tool.call({ tool, tool_use_id: 'ordinary', agentId } as any)
    expect(result.result.stdout).toBe('REALLY RAN')
    expect((await $.tool.check({ tool, input: {}, tool_use_id: 'ordinary', agentId } as any)).decision).toBe('allow')
  }
  for (const [agentId, id] of [['agent-progress', 'ordinary'], ['agent-normal', ID_PREFIX + 'foreign'], [undefined, ID_PREFIX + 'main']]) {
    expect((await $.tool.call({ tool, tool_use_id: id, agentId } as any) as any).deny).toContain('not executed')
    expect((await $.tool.check({ tool, input: {}, tool_use_id: id, agentId } as any)).decision).toBe('deny')
  }
  expect(w.core.length).toBe(2)
})

test('batch 6 persisted coordinator render restores literal full body without restoring a guard answer', async ($, on) => {
  const text = 'codex-model: gpt-6.1-sol\n<tag>**literal**</tag>\n```\n😀 café\n  tail  '
  const id = ID_PREFIX + 'reopened'
  const record = quietCoordinatorRecord('unused') as any
  record.coordinator = { received: ['source'], pending: [], rows: { [id]: { tool: COORDINATOR_TOOL, sourceUuid: 'source', text } } }
  const w = world(on, { store: new Map([['agent:sess-1:agent-coordinator', record]]) })
  await startSession($)
  const card: any = await b6Render($, { name: COORDINATOR_TOOL, id, input: { sourceUuid: 'forged', text: 'forged' } })
  expect(card.children[1].children).toEqual([text])
  expect((await $.tool.call({ tool: COORDINATOR_TOOL, tool_use_id: id, agentId: 'agent-coordinator', sourceUuid: 'source', text } as any) as any).deny).toContain('not executed')
  const fallback = literalReceipt(text)
  expect(fallback).toContain('````text\n' + text + '\n````')
  expect(w.spawned).toEqual([])
  expect(w.core).toEqual([])
})

for (const surface of ['absent-read', 'registration-fails', 'generation-progress', 'findings-native', 'findings-fallback']) test(`batch 6 ${surface} selects only admitted, guarded rows`, { options: { richRows: true, progressIntervalMs: 0 } }, async ($, on) => {
  const review: any = { type: 'exitedReviewMode', id: 'review-findings', review: 'Preserve full review', findings: [{ file: 'a.ts', summary: 'Actual supplied finding', failure_scenario: 'Explicit source scenario' }], level: 'low' }
  const generation: any = { ...batch6Items.find(i => i.id === 'generation'), status: 'generating', result: 'Actual in-progress report' }
  const item = surface.startsWith('findings') ? review : surface === 'generation-progress' ? generation : surface === 'registration-fails' ? batch6Items.find(i => i.id === 'generation')! : batch6Items[0]
  const w = world(on, { availableTools: surface === 'findings-native' ? ['ReportFindings'] : [], toolRegisterThrows: surface === 'registration-fails' ? 'codex_tool' : undefined,
    stdout: b6Line(item) + '\n' + MESSAGE('Done').text })
  // With no session.start, no display registration exists: text is the valid fallback.
  // This case specifically exercises the registered-card branch.
  if (surface === 'findings-fallback') await startSession($)
  const first = await step($, 'agent-progress')
  const calls = callsOf(first.chunks)
  if (surface === 'findings-native') {
    expect(calls.map(c => c.name)).toEqual(['ReportFindings'])
    const [r]: any[] = await runCalls($, first.chunks, 'agent-progress')
    expect(r.result.findings).toEqual(review.findings)
  } else if (surface === 'findings-fallback' || surface === 'generation-progress') {
    expect(calls.map(c => c.name)).toEqual(['mcp__codex-mod__codex_tool'])
    const [r]: any[] = await runCalls($, first.chunks, 'agent-progress')
    expect(r.deny).toBe(undefined)
    expect(JSON.stringify(r)).toContain(surface === 'findings-fallback' ? 'Explicit source scenario' : 'Actual in-progress report')
  } else {
    expect(calls.map(c => c.name)).toEqual(['SubagentHandback'])
    expect(first.chunks.some(c => c.kind === 'text' && c.text.includes('Read unavailable'))).toBe(true)
  }
  expect(w.reads.some(p => p.endsWith('view.png'))).toBe(false)
  expect(w.core).toEqual([])
})

for (const option of ['lean', 'text', 'registration-fails']) test(`batch 6 question UI ${option} disables the runner adapter and errors without implying a response`, { options: { transport: 'app-server', lean: option === 'lean', nativeActions: option !== 'text', progressIntervalMs: 0 } }, async ($, on) => {
  const w = appWorld(on, { toolRegisterThrows: option === 'registration-fails' ? 'codex_question' : undefined,
    pieces: [THREAD('thr-1'), TURN('turn-1'), b6Request('unsupported', { error: { code: -32601, message: 'unsupported by codex-mod' } }), MESSAGE('Done')] })
  await startSession($)
  const s = await step($, 'agent-progress')
  expect(w.spawned[0].argv.includes('--questions')).toBe(false)
  expect(callsOf(s.chunks).every(c => c.name === 'SubagentHandback')).toBe(true)
  expect(w.writes).toEqual([])
  expect(handback(s.result)).not.toContain('unsupported')
  expect(w.core).toEqual([])
})

// Batch 7: explicit host-event harness. The real AgentSpawnInput has no effort
// in 2.1.302; passing it here tests detection of a future host, not that claim.
function b7Hooks(options: any = {}) {
  const hooks = new Map<string, { handler: any; catcher: any }>()
  codexRegister(((name: string, ...args: any[]) => {
    const filter = typeof args[0] === 'object' ? args[0].component ?? String(args[0].agentId ?? '') : ''
    const hook = { handler: args.at(-1), catcher: undefined as any }
    hooks.set(name + filter, hook)
    return { catch: (fn: any) => { hook.catcher = fn } }
  }) as any, options)
  return hooks
}
// Direct hook calls need EngineInterface, not the kit's public test driver.
// Use the same world state as the normal hook mocks so real steps can reload
// the captured selection and verify execution, rendering and follow-ups.
function b7Engine(w: ReturnType<typeof world>, agents: () => any[] = () => []) {
  return {
    plugin: { name: 'codex-mod', root: '/plugin' },
    agent: { list: async () => agents() },
    session: { id: async () => 'sess-1', cwd: async () => w.location.cwd },
    env: { get: async (name: string) => name === 'HOME' ? '/home/t' : undefined },
    clock: { now: async () => w.clock.now },
    ui: {
      log: (text: string) => { w.logs.push(text) },
      invalidate: () => {},
      toast: () => {},
      notify: async () => ({ isSent: false }),
    },
    fs: {
      read: async (path: string) => {
        w.reads.push(path)
        const text = w.files.get(path)
        if (text === undefined) throw new Error(`ENOENT ${path}`)
        return text
      },
      write: async (path: string, text: string) => {
        if (/\/runs\/state-[^/]+\/(?:record\.json(?:\.\d+)?|row-\d+\.json)$/.test(path)) {
          w.stateWrites.push({ path, text })
          w.files.set(path, text)
        } else w.writes.push({ path, text })
      },
    },
    store: {
      get: async (key: string) => w.store.get(key),
      keys: async () => [...w.store.keys()],
      set: async (key: string, value: unknown) => {
        expect(JSON.stringify(value).length <= RECORD_BUDGET).toBe(true)
        w.store.set(key, JSON.parse(JSON.stringify(value)))
      },
      delete: async (key: string) => { w.store.delete(key) },
    },
    process: { run: async (argv: string[]) => {
      expect(argv[0]).toBe('mkdir')
      return runOk().value
    } },
  }
}
const b7Event = (changes: any = {}) => ({ tool_use_id: 'b7-launch', prompt: 'First task', description: 'Inspect exports',
  subagentType: 'codex-mod:codex', provider: { plugin: 'codex-mod', tier: 'project' }, model: undefined,
  parentModel: 'claude-opus-4-7', permissionMode: 'default', background: true, fork: false, ...changes })
const b7Next = (fn: any) => Object.assign(fn, { origin: { plugin: 'engine', tier: 'core' }, signal: new AbortController().signal,
  budget: { remainingMs: 10000 }, called: false })
const b7Render = ($: any, id: string, tool = 'Agent', input: any = {}) => $.ui.render({ component: 'ToolUse', surface: 'desktop', requestId: id,
  props: { tool_use_id: id, tool, input, isRunning: false, isErrored: false, isInterrupted: false } })

for (const [label, task, native, base, model, effort] of [
  ['generic default', 'work', undefined, { model: '', effort: 'medium' }, 'gpt-6.1-sol', 'medium'],
  ['role default', 'work', undefined, { model: 'gpt-6-luna', effort: 'low' }, 'gpt-6-luna', 'low'],
  ['native wins role', 'work', 'high', { model: 'gpt-6-luna', effort: 'low' }, 'gpt-6-luna', 'high'],
  ['prompt wins native', 'codex-effort: xhigh\nwork', 'low', { model: 'gpt-6.1-sol', effort: 'medium' }, 'gpt-6.1-sol', 'xhigh'],
  ['model override validates native', 'codex-model: gpt-6-luna\nwork', 'ultra', { model: 'gpt-6.1-sol', effort: 'medium' }, 'gpt-6-luna', 'medium'],
  ['model type default', 'work', undefined, { model: 'gpt-6.1-sol', effort: 'low' }, 'gpt-6.1-sol', 'low'],
  ['sticky follow-up', 'next', undefined, { model: 'gpt-6-luna', effort: 'max' }, 'gpt-6-luna', 'max'],
] as const) test(`batch 7 precedence: ${label}`, async () => {
  const selected = resolveProfile({ ...base, sandbox: 'read-only' }, task, parseModelsCache(MODELS_CACHE), native)
  expect(selected.profile).toEqual({ model, effort, sandbox: 'read-only' })
  expect(selected.rest).toBe(task.includes('codex-') ? 'work' : task)
  expect(selected.invalid).toBe(undefined)
})

test('batch 7 invalid native effort notes fallback; invalid prompt overrides still fail', async () => {
  const list = parseModelsCache(MODELS_CACHE)
  const base = { model: 'gpt-6-luna', effort: 'high', sandbox: 'workspace-write' }
  for (const native of ['ultra', 'bogus', 7, null, 'HIGH']) {
    const selected = resolveProfile(base, 'work', list, native)
    expect(selected.profile.effort).toBe('high')
    expect(selected.note).toContain('using default high')
  }
  const switched = resolveProfile({ ...base, model: 'gpt-6.1-sol', effort: 'ultra' }, 'codex-model: gpt-6-luna\nwork', list, 'ultra')
  expect(switched.profile.effort).toBe('medium')
  expect(resolveProfile(base, 'codex-effort: ultra\nwork', list, 'low').invalid).toContain('not supported')
  expect(resolveProfile(base, 'codex-model: missing\nwork', list, 'low').invalid).toContain('not available')
  expect(resolveProfile({ model: '', effort: '', sandbox: 'read-only' }, 'work').profile).toEqual({ model: 'gpt-6.1-sol', effort: 'medium', sandbox: 'read-only' })
})

for (const enabled of [true, false]) test(`batch 7 catalog model registration modelAgents=${enabled}`, { options: { modelAgents: enabled } }, async ($, on) => {
  const registered: any[] = []
  world(on, { files: new Map([['/home/t/.codex/models_cache.json', MODELS_CACHE]]) })
  on('agent.register', (_$, e: any) => { registered.push(e); return { value: { agent: 'codex-mod:' + e.name } } })
  on('process.run', (_$, e: any) => runOk(e.argv[0] === 'which' ? '/bin/codex' : 'ok'))
  await startSession($)
  expect(registered.map(s => s.name)).toEqual(enabled ? ['codex', 'gpt-6-1-sol', 'gpt-6-luna', 'codex-child'] : ['codex', 'codex-child'])
  expect(registered.every(s => s.model === 'haiku' && s.effort === 'low')).toBe(true)
  if (enabled) expect(registered.find(s => s.name === 'gpt-6-1-sol').description).toBe('OpenAI Codex gpt-6.1-sol; pass effort to choose reasoning (low, medium, high, xhigh, max, ultra)')
})

test('batch 7 unreadable catalog keeps generic + roles; colliding project role wins', async ($, on) => {
  const registered: any[] = []
  const files = new Map([['.claude/codex-mod.json', JSON.stringify({ roles: { 'gpt-6-luna': { model: 'gpt-6.1-sol', effort: 'high', description: 'Project winner' } } })]])
  const w = world(on, { files })
  on('agent.register', (_$, e: any) => { registered.push(e); return { value: { agent: 'codex-mod:' + e.name } } })
  on('process.run', (_$, e: any) => runOk(e.argv[0] === 'which' ? '/bin/codex' : 'ok'))
  await startSession($)
  expect(registered.map(s => s.name)).toEqual(['codex', 'gpt-6-luna', 'codex-child'])
  files.set('/home/t/.codex/models_cache.json', MODELS_CACHE)
  registered.length = 0
  await startSession($)
  expect(registered.map(s => s.name)).toEqual(['codex', 'gpt-6-luna', 'gpt-6-1-sol', 'codex-child'])
  expect(registered[1].description).toContain('Project winner')
  expect(w.logs.some(l => l.includes('project role wins name collision'))).toBe(true)
})

for (const source of ['spawn', 'tool', 'both', 'absent', 'invalid', 'prompt'] as const) test(`batch 7 ${source} effort binds before first step; title, row, launch and footer agree`, async ($, on) => {
  let task = source === 'prompt' ? 'codex-model: gpt-6-luna\ncodex-effort: xhigh\nFirst task' : 'First task'
  const id = 'b7-' + source
  const host = 'b7-host-' + source
  const info = { id: host, type: 'codex-mod:codex', description: '', status: 'running' }
  const w = world(on, { messages: () => [user(task)], agentList: () => [info], files: new Map([['/home/t/.codex/models_cache.json', MODELS_CACHE]]) })
  on('ui.render', () => ({ type: 'Text', children: ['HOST CONTROLS'] }))
  on('agent.register', (_$, e: any) => ({ value: { agent: 'codex-mod:' + e.name } }))
  on('process.run', (_$, e: any) => runOk(e.argv[0] === 'which' ? '/bin/codex' : 'ok'))
  await startSession($)
  const hooks = b7Hooks()
  const $e = b7Engine(w, () => [info])
  const spawn = hooks.get('agent.spawn')!.handler
  const effort = source === 'absent' ? undefined : source === 'invalid' ? 'bogus' : 'high'
  const event = b7Event({ tool_use_id: id, prompt: task, ...(source === 'spawn' || source === 'both' || source === 'prompt' || source === 'invalid' ? { effort } : {}) })
  const expectedEffort = source === 'prompt' ? 'xhigh' : source === 'absent' || source === 'invalid' ? 'medium' : 'high'
  const expectedModel = source === 'prompt' ? 'gpt-6-luna' : 'gpt-6.1-sol'
  const launch = b7Next(async (e: any) => {
    expect(e.model).toBe(undefined)
    expect(e.parentModel).toBe(event.parentModel)
    expect(e.permissionMode).toBe(event.permissionMode)
    expect(e.provider).toEqual(event.provider)
    expect(e.prompt).toBe(task)
    info.description = e.description
    expect(e.description).toBe(`Codex ${expectedModel} · ${expectedEffort} · Inspect exports`)
    await hooks.get('turn.start')!.handler($e, { agentId: host, text: task }, b7Next(async () => ({ turnId: 'early' })))
    expect(w.store.get(`agent:sess-1:${host}`)).toMatchObject({ model: expectedModel, effort: expectedEffort })
    return { model: 'claude-haiku-4-5', agentId: host }
  })
  if (source === 'tool' || source === 'both') {
    await hooks.get('tool.call')!.handler($e, { tool: 'Agent', subagent_type: 'codex-mod:codex', effort: source === 'both' ? 'low' : effort, tool_use_id: id },
      b7Next(async () => ({ result: await spawn($e, event, launch) })))
  } else await spawn($e, event, launch)
  const first = await step($, host)
  expect(argOf(w.spawned[0]!.argv, '-m')).toBe(expectedModel)
  expect(w.spawned[0]!.argv).toContain(`model_reasoning_effort="${expectedEffort}"`)
  expect(handback(first.result)).toContain(`${expectedModel} · ${expectedEffort}`)
  if (source === 'invalid') expect(handback(first.result)).toContain('using default medium')
  if (source === 'absent') expect(w.logs.some(l => l.includes('spawn.effort=absent; Agent.effort=absent'))).toBe(true)
  if (source === 'tool') expect(w.logs.some(l => l.includes('spawn.effort=absent; Agent.effort=high'))).toBe(true)
  const row = JSON.stringify(await b7Render($, id))
  expect(row).toContain(`Codex ${expectedModel} · ${expectedEffort}`)
  expect(row).toContain('HOST CONTROLS')
  // A follow-up updates the current row and footer; the launch title stays fixed.
  task = 'codex-model: gpt-6-luna\ncodex-effort: low\nSecond task'
  const second = await step($, host, 0, 'turn-2')
  expect(w.spawned[1]!.argv).toContain('model_reasoning_effort="low"')
  expect(handback(second.result)).toContain('gpt-6-luna · low')
  expect(JSON.stringify(await b7Render($, id))).toContain('Codex gpt-6-luna · low')
  expect(info.description).toContain(`${expectedModel} · ${expectedEffort}`)
  expect(w.modelCalls).toEqual([])
  expect(w.core).toEqual([])
  expect(JSON.stringify(w.store.get(`agent:sess-1:${host}`)).length < RECORD_BUDGET).toBe(true)
})

test('batch 7 only pinned codex-mod spawns get titles; fixed workflow/resume descriptions and normal Claude spawns stay intact', async ($, on) => {
  const w = await startWithCatalog($, on)
  const spawn = b7Hooks().get('agent.spawn')!.handler
  for (const changes of [
    { subagentType: 'general-purpose' }, { provider: { plugin: 'other', tier: 'project' } },
    { subagentType: 'other:codex' }, { fork: true }, { workflow: { runId: 'wf_1', agentIndex: 1 } },
    { resume: { agentId: 'b7-resumed' } },
  ]) {
    const event = b7Event(changes)
    await spawn(b7Engine(w), event, b7Next(async (e: any) => {
      expect(e).toEqual(event)
      return { deny: 'fixture refusal' }
    }))
  }
})

test('batch 7 owned Agent renders restore from compact records, preserve native rows and ignore lookalike calls', async ($, on) => {
  const w = world(on, { store: new Map([['agent:sess-1:b7-restored', {
    model: 'gpt-6-luna', effort: 'max', sandbox: 'read-only', agentName: 'codex', updatedAt: 1,
    selection: { session: 'sess-1', toolUseId: 'b7-durable', type: 'codex-mod:codex', launchModel: 'gpt-6.1-sol', launchEffort: 'low' },
  }]]) })
  on('ui.render', () => ({ type: 'Text', children: ['HOST'] }))
  expect(JSON.stringify(await b7Render($, 'b7-durable'))).toContain('Codex gpt-6-luna · max')
  for (const [id, tool, input] of [['foreign', 'Agent', { subagent_type: 'codex-mod:codex' }], ['b7-durable', 'Bash', {}], ['foreign', 'Agent', { subagent_type: 'general-purpose' }]] as const) {
    expect(await b7Render($, id, tool, input)).toMatchObject({ type: 'Text', children: ['HOST'] })
  }
  const render = b7Hooks().get('ui.renderToolUse')!
  const e = { props: { tool: 'Agent', tool_use_id: 'b7-durable' } }
  const broken = { ...b7Engine(w), ui: { resolve: () => { throw new Error('unsupported surface') } } }
  let caught = false
  try { await render.handler(broken, e, b7Next(async () => ({ type: 'Text', children: ['HOST'] }))) } catch { caught = true }
  expect(caught).toBe(true)
  expect(await render.catcher($, e, b7Next(async () => ({ type: 'Text', children: ['HOST'] })))).toEqual({ type: 'Text', children: ['HOST'] })
  expect(w.spawned).toEqual([])
  expect(w.core).toEqual([])
})

test('batch 7 catalog agent defaults launch the exact model despite the host-safe type alias', async ($, on) => {
  const w = world(on, { files: new Map([['/home/t/.codex/models_cache.json', MODELS_CACHE]]),
    agentList: () => [{ id: 'b7-model-type', type: 'codex-mod:gpt-6-1-sol', description: 'Catalog selection', status: 'running' }] })
  on('agent.register', (_$, e: any) => ({ value: { agent: 'codex-mod:' + e.name } }))
  on('process.run', (_$, e: any) => runOk(e.argv[0] === 'which' ? '/bin/codex' : 'ok'))
  await startSession($)
  const s = await step($, 'b7-model-type')
  expect(argOf(w.spawned[0]!.argv, '-m')).toBe('gpt-6.1-sol')
  expect(w.spawned[0]!.argv).toContain('model_reasoning_effort="low"')
  expect(handback(s.result)).toContain('gpt-6.1-sol · low')
  expect(w.logs.some(l => l.includes('registering gpt-6-1-sol for Codex gpt-6.1-sol'))).toBe(true)
  expect(w.modelCalls).toEqual([])
})

test('batch 7 simultaneous launches keep distinct row IDs, parent scope and early effort selections', async ($, on) => {
  const infos: any[] = []
  const w = await startWithCatalog($, on, { agentList: () => infos })
  const hooks = b7Hooks()
  const spawn = hooks.get('agent.spawn')!.handler
  const $e = b7Engine(w, () => infos)
  const launch = (id: string, effort: string, parent: string) => spawn($e, b7Event({ tool_use_id: id, effort, parentAgentId: parent }),
    b7Next(async (e: any) => {
      infos.push({ id: 'host-' + id, type: e.subagentType, description: e.description, parentId: parent, status: 'running' })
      await hooks.get('turn.start')!.handler($e, { agentId: 'host-' + id, text: 'First task' }, b7Next(async () => ({ turnId: id })))
      return { model: 'claude-haiku-4-5', agentId: 'host-' + id }
    }))
  await Promise.all([launch('b7-concurrent-a', 'high', 'parent-a'), launch('b7-concurrent-b', 'low', 'parent-b')])
  expect(w.store.get('agent:sess-1:host-b7-concurrent-a')).toMatchObject({ effort: 'high', selection: { toolUseId: 'b7-concurrent-a' } })
  expect(w.store.get('agent:sess-1:host-b7-concurrent-b')).toMatchObject({ effort: 'low', selection: { toolUseId: 'b7-concurrent-b' } })
  expect(w.spawned).toEqual([])
})

test('batch 7 project role wins a sanitized model alias collision and supplies the launch profile', async ($, on) => {
  const registered: string[] = []
  const w = world(on, { files: new Map([['/home/t/.codex/models_cache.json', MODELS_CACHE],
    ['.claude/codex-mod.json', JSON.stringify({ roles: { 'gpt-6-1-sol': { model: 'gpt-6-luna', effort: 'high', description: 'Alias winner' } } })]]),
    agentList: () => [{ id: 'b7-alias-role', type: 'codex-mod:gpt-6-1-sol', description: 'Role', status: 'running' }] })
  on('agent.register', (_$, e: any) => { registered.push(e.name); return { value: { agent: 'codex-mod:' + e.name } } })
  on('process.run', (_$, e: any) => runOk(e.argv[0] === 'which' ? '/bin/codex' : 'ok'))
  await startSession($)
  expect(registered).toEqual(['codex', 'gpt-6-1-sol', 'gpt-6-luna', 'codex-child'])
  await step($, 'b7-alias-role')
  expect(argOf(w.spawned[0]!.argv, '-m')).toBe('gpt-6-luna')
  expect(w.spawned[0]!.argv).toContain('model_reasoning_effort="high"')
  expect(w.logs.some(l => l.includes('project role wins name collision'))).toBe(true)
})

// R5: real native delivery remains authoritative, with a model-only outcome.
test('steer v2: native SendMessage receives early, correlates append by scoped IDs, and returns additive exec queue context', async ($, on) => {
  const w = world(on, { task: 'first', pieces: [cmdDone('pwd'), MESSAGE('built')], sendDelivery: async (_$, e) => {
    await $.session.receive({ agentId: e.to, origin: { kind: 'coordinator' }, text: e.message })
    const early = savedState(w, 'agent:sess-1:agent-coordinator').coordinator.outcomes[`sess-1:${e.tool_use_id}`]
    expect(early.status).toBe('queued')
    expect(early.sourceUuid).toBe(undefined)
    await $.session.append(deliveryRow(e.to, `row-${e.tool_use_id}`, e.message))
    return { result: { status: 'completed', agentsStates: {} }, context: ['existing model context'] }
  } })
  await step($, 'agent-coordinator')
  for (const id of ['send-1', 'send-2']) {
    const result: any = await $.tool.call({ tool: 'SendMessage', tool_use_id: id, to: 'agent-coordinator', message: 'Identical literal body' } as any)
    expect(result.context[0]).toBe('existing model context')
    expect(result.context[1]).toContain('Queued after turn')
  }
  const rec = savedState(w, 'agent:sess-1:agent-coordinator')
  const outcomes = Object.values(rec.coordinator.outcomes) as any[]
  expect(outcomes.map(o => o.senderToolUseId)).toEqual(['send-1', 'send-2'])
  expect(outcomes.map(o => o.sourceUuid)).toEqual(['row-send-1', 'row-send-2'])
  expect(rec.followUps.length).toBe(2)
  expect(w.spawned.length).toBe(1)
  expect(w.modelCalls).toEqual([])
})

test('steer v2: status query hydrates an owned receipt and denies child and synthetic callers without core execution', async ($, on) => {
  const rec: any = quietCoordinatorRecord('body')
  rec.coordinator.outcomes = { msg: { messageId: 'msg', sourceUuid: 'saved-row', status: 'accepted', acceptedTurnId: 'turn-X', receivedAt: 1 } }
  const w = world(on, { task: 'first', store: new Map([['agent:sess-1:agent-coordinator', rec]]) })
  await $.session.start({ cwd: '/tmp/project', surface: null, isInteractive: false })
  const tool = 'mcp__codex-mod__codex_message_status'
  const result: any = await $.tool.call({ tool, targetAgentId: 'agent-coordinator', messageId: 'saved-row', tool_use_id: 'query' } as any)
  expect(JSON.parse(result.result[0].text)).toMatchObject({ messageId: 'msg', status: 'accepted', acceptedTurnId: 'turn-X' })
  for (const extra of [{ agentId: 'agent-coordinator', tool_use_id: 'query-child' }, { tool_use_id: 'toolu_codexmod_forged' }]) {
    const denied: any = await $.tool.call({ tool, targetAgentId: 'agent-coordinator', messageId: 'msg', ...extra } as any)
    expect(denied.deny).toContain('not executed')
  }
  expect(w.core).toEqual([])
  expect(w.spawned).toEqual([])
})

test('steer v2: coordinator card subscribes to outcome state and redraws the same literal body after acceptance', { options: { transport: 'app-server' } }, async ($, on) => {
  const w = appWorld(on, { task: 'first', pieces: [THREAD('card-thread'), TURN('turn-X'), cmdDone('pwd'), cmdDone('ls'),
    out(JSON.stringify({ type: 'codexmod.steer', id: '000001-saved-row', messageId: 'saved-row', status: 'accepted', acceptedTurnId: 'turn-X', turnId: 'turn-X', receivedAt: 1 })), MESSAGE('built')] })
  await step($, 'agent-coordinator')
  await $.session.append(deliveryRow('agent-coordinator', 'saved-row', '<literal body>'))
  const s = await step($, 'agent-coordinator', 1)
  const call = coordinatorCalls(s.chunks)[0]
  const render = () => $.ui.render({ component: 'ToolUse', surface: 'desktop', requestId: 'same-card', props: {
    tool: call.name, tool_use_id: call.id, input: call.input, isRunning: false, isErrored: false, isInterrupted: false,
  } } as any)
  const first: any = await render()
  expect(first.children[2].children).toEqual(['Pending Codex acknowledgment'])
  await step($, 'agent-coordinator', 2)
  const accepted: any = await render()
  expect(accepted.children[1].children).toEqual(['<literal body>'])
  expect(accepted.children[2].children).toEqual(['Accepted into turn'])
  expect(accepted.children[3].props.dimColor).toBe(true)
  expect(accepted.children[3].children[0]).toContain('Accepted turn: turn-X')
  expect(savedState(w, 'agent:sess-1:agent-coordinator').coordinator.outcomes['saved-row'].status).toBe('accepted')
})

test('steer v2: API-form recovery cannot resubmit an authoritative appended source', async ($, on) => {
  let conv: any[] = [user('first')]
  const w = world(on, { messages: () => conv, pieces: [cmdDone('pwd'), cmdDone('ls'), MESSAGE('built')] })
  await step($, 'agent-coordinator')
  await $.session.append(deliveryRow('agent-coordinator', 'source-uuid', 'One message'))
  conv.push(user(DELIVERED('One message')))
  await step($, 'agent-coordinator', 1)
  await step($, 'agent-coordinator', 2)
  const rec = savedState(w, 'agent:sess-1:agent-coordinator')
  expect(rec.followUps.length).toBe(1)
  expect(Object.keys(rec.coordinator.outcomes)).toEqual(['source-uuid'])
  expect(w.spawned.length).toBe(1)
})

test('steer v2: HTTP control acceptance reaches SendMessage context and never publishes a steer file', { options: { transport: 'app-server' } }, async ($, on) => {
  const posts: any[] = []
  const w = appWorld(on, { task: 'first', pieces: [THREAD('thread-X'), TURN('turn-X'), cmdDone('pwd'), MESSAGE('built')],
    readFile: (path, text) => path.endsWith('/control.json') ? JSON.stringify({ version: 2, generation: 'g', channel: 'unix', socketPath: '/tmp/fake.sock', runId: path.slice(0, -13) }) : text,
    sendDelivery: async (_$, e) => {
      await $.session.receive({ agentId: e.to, origin: { kind: 'coordinator' }, text: e.message })
      await $.session.append(deliveryRow(e.to, 'http-source', e.message))
      return { result: { status: 'completed', agentsStates: {} }, context: ['original'] }
    } })
  on('http.fetch', (_$, e: any) => {
    const body = e.init?.body ? JSON.parse(e.init.body) : undefined
    if (body) posts.push(body)
    const payload = e.url.endsWith('/health') ? { version: 2, generation: 'g', runId: w.spawned[0].argv.at(-1) }
      : { ...body, status: 'accepted', acceptedTurnId: 'turn-X', turnId: 'turn-X', rpcRequestId: 4 }
    return { value: { status: 200, ok: true, headers: {}, text: JSON.stringify(payload) } }
  })
  await step($, 'agent-coordinator')
  const result: any = await $.tool.call({ tool: 'SendMessage', tool_use_id: 'send-http', to: 'agent-coordinator', message: 'codex-effort: high\nKeep every literal line.' } as any)
  expect(result.context[0]).toBe('original')
  expect(result.context[1]).toContain('Accepted into turn turn-X')
  expect(posts.length).toBe(1)
  expect(posts[0]).toMatchObject({ messageId: 'sess-1:send-http', expectedTurnId: 'turn-X', text: 'Do not spawn sub-agents.\n\nKeep every literal line.' })
  expect(w.writes).toEqual([])
  const rec = savedState(w, 'agent:sess-1:agent-coordinator')
  expect(rec.coordinator.outcomes['sess-1:send-http']).toMatchObject({ sourceUuid: 'http-source', status: 'accepted' })
  expect(rec.followUps).toBe(undefined)
})

for (const scenario of ['blocked-health', 'lost-response']) test(`steer v2: ${scenario} negotiates once without a dual submission`, { options: { transport: 'app-server' } }, async ($, on) => {
  const w = appWorld(on, { task: 'first', pieces: [THREAD('thread-X'), TURN('turn-X'), cmdDone('pwd'), MESSAGE('built')],
    readFile: (path, text) => path.endsWith('/control.json') ? JSON.stringify({ version: 2, generation: 'g', channel: 'unix', socketPath: '/tmp/fake.sock', runId: path.slice(0, -13) }) : text })
  let posts = 0
  on('http.fetch', (_$, e: any) => {
    if (e.url.endsWith('/health') && scenario === 'lost-response') return { value: { status: 200, ok: true, headers: {}, text: JSON.stringify({ version: 2, generation: 'g', runId: w.spawned[0].argv.at(-1) }) } }
    if (!e.url.endsWith('/health')) posts++
    throw new Error('simulated host transport failure')
  })
  await step($, 'agent-coordinator')
  await $.session.append(deliveryRow('agent-coordinator', 'one-source', 'PRIVATE_BODY_SENT_ONCE'))
  const rec = savedState(w, 'agent:sess-1:agent-coordinator')
  expect(w.writes.length).toBe(scenario === 'blocked-health' ? 1 : 0)
  expect(posts).toBe(scenario === 'blocked-health' ? 0 : 1)
  expect(rec.coordinator.outcomes['one-source'].status).toBe(scenario === 'blocked-health' ? 'pending' : 'unknown')
  expect(w.logs.some(s => s.includes('PRIVATE_BODY_SENT_ONCE'))).toBe(false)
})

const senderRow = (uuid: string, ids: string[], text: string) => ({ uuid, door: 'response' as const,
  origin: { kind: 'model' as const, model: 'claude-sonnet-5-5' },
  message: { type: 'assistant' as const, role: 'assistant' as const, content: ids.map(id => ({ type: 'tool_use' as const, id, name: 'SendMessage', input: { to: 'steer-check', message: text } })) } })
const nativeQueued = (id = 'agent-coordinator') => ({ result: { success: true,
  message: 'Message queued for delivery at its next tool round.', pin: { id, name: 'steer-check', ref: 'ref' } }, context: ['existing'] })

test('steer v2 live order: two identical named sends precede receive/append while a child pull is held; cards and outcomes precede the next host round', { options: { transport: 'app-server', richRows: true }, timeoutMs: 15000 }, async ($, on) => {
  const posts: any[] = []
  let pulling = false
  const body = 'codex-effort: high\nKeep waiting; include MARKER in your answer.'
  const ids = ['native-send-one', 'native-send-two']
  const w = appWorld(on, { task: 'first',
    agentList: () => [{ id: 'agent-coordinator', name: 'steer-check', type: 'codex-mod:codex', description: 'Different title', status: 'running' }],
    pieces: [THREAD('thread-X'), TURN('turn-X'), cmdDone('pwd'), () => { pulling = true; return posts.length === 2 },
      out(ids.map(id => JSON.stringify({ type: 'codexmod.steer', id, messageId: `sess-1:${id}`, status: 'accepted', acceptedTurnId: 'turn-X', receivedAt: 1 })).join('\n')), MESSAGE('built')],
    readFile: (path, text) => path.endsWith('/control.json') ? JSON.stringify({ version: 2, generation: 'g', channel: 'unix', socketPath: '/tmp/fake.sock', runId: path.slice(0, -13) }) : text,
    // Match CLI 2.1.302: return the pin, raise neither receive nor child append.
    sendDelivery: async () => nativeQueued() })
  on('http.fetch', (_$, e: any) => {
    const input = e.init?.body ? JSON.parse(e.init.body) : undefined
    if (input) posts.push(input)
    return { value: { status: 200, ok: true, headers: {}, text: JSON.stringify(input ? { ...input, status: 'accepted', acceptedTurnId: 'turn-X', turnId: 'turn-X' }
      : { version: 2, generation: 'g', runId: w.spawned[0].argv.at(-1) }) } }
  })
  await step($, 'agent-coordinator')
  const held = step($, 'agent-coordinator', 1)
  for (let i = 0; !pulling && i < 100; i++) await new Promise<void>(r => setTimeout(r, 5))
  expect(pulling).toBe(true)
  // Parallel tool blocks share one persisted parent row UUID.
  await $.session.append(senderRow('parent-source', ids, body))
  const replies: any[] = await Promise.all(ids.map(id => $.tool.call({ tool: 'SendMessage', tool_use_id: id, to: 'steer-check', message: body } as any)))
  expect(replies.map(r => r.context[0])).toEqual(['existing', 'existing'])
  expect(replies.every(r => r.context[1].includes('Accepted into turn turn-X'))).toBe(true)
  expect(posts.map(p => p.messageId)).toEqual(ids.map(id => `sess-1:${id}`))
  expect(posts.every(p => p.text === 'Do not spawn sub-agents.\n\nKeep waiting; include MARKER in your answer.')).toBe(true)
  const displayed = await held
  const cards = coordinatorCalls(displayed.chunks)
  expect(cards.map(c => c.input)).toEqual(ids.map(() => ({ sourceUuid: 'parent-source', text: body })))
  expect(displayed.result.stopReason).toBe('tool_use')
  // The real host drains the native copies only AFTER this guarded tool round.
  for (const id of ids) {
    const received = await $.session.receive({ agentId: 'agent-coordinator', origin: { kind: 'coordinator' }, text: body })
    expect(received.consumed).toContain('already owned')
    const answer: any = await $.tool.call({ tool: 'mcp__codex-mod__codex_message_status', tool_use_id: `query-${id}`, targetAgentId: 'agent-coordinator', messageId: id } as any)
    expect(JSON.parse(answer.result[0].text)).toMatchObject({ messageId: `sess-1:${id}`, sourceUuid: 'parent-source', acceptedTurnId: 'turn-X' })
  }
  const ambiguous: any = await $.tool.call({ tool: 'mcp__codex-mod__codex_message_status', tool_use_id: 'query-parent', targetAgentId: 'agent-coordinator', messageId: 'parent-source' } as any)
  expect(JSON.parse(ambiguous.result[0].text).reason).toContain('multiple messages')
  expect(posts.length).toBe(2)
  expect(w.writes).toEqual([])
  expect(w.spawned.length).toBe(1)
  expect(w.core).toEqual([])
  expect(w.modelCalls).toEqual([])
})

test('steer v2 live order: append-only native copy reconciles with sender operation, while 1.1 unscoped queued_command still steers once', { options: { transport: 'app-server' } }, async ($, on) => {
  const w = appWorld(on, { task: 'first', pieces: [THREAD('t'), TURN('turn'), cmdDone('pwd'), MESSAGE('built')], sendDelivery: async () => nativeQueued() })
  await step($, 'agent-coordinator')
  await $.session.append(senderRow('parent-source', ['sender'], 'Identical body'))
  await $.tool.call({ tool: 'SendMessage', tool_use_id: 'sender', to: 'agent-coordinator', message: 'Identical body' } as any)
  expect(w.writes.length).toBe(1)
  // Host versions without a receive dispatch retain the authoritative child row.
  await $.session.append(deliveryRow('agent-coordinator', 'late-native-uuid', 'Identical body'))
  await $.session.append(deliveryRow('agent-coordinator', 'late-native-uuid', 'Identical body'))
  expect(w.writes.length).toBe(1)
  let rec = savedState(w, 'agent:sess-1:agent-coordinator')
  expect(rec.coordinator.outcomes['sess-1:sender']).toMatchObject({ sourceUuid: 'parent-source', deliveryUuid: 'late-native-uuid' })
  expect(rec.coordinator.pending.length).toBe(1)
  await $.session.append(deliveryRow('agent-coordinator', 'legacy-uuid', 'Identical body'))
  expect(w.writes.length).toBe(2)
  rec = savedState(w, 'agent:sess-1:agent-coordinator')
  expect(rec.coordinator.outcomes['legacy-uuid']).toMatchObject({ sourceUuid: 'legacy-uuid', status: 'pending' })
  expect(JSON.parse(w.writes[1].text).messageId).toBe('legacy-uuid')
  expect(w.spawned.length).toBe(1)
})

for (const pin of [undefined, 'agent-gp']) test(`steer v2: native failure or mismatched pin ${pin} cannot submit a sender receipt`, async ($, on) => {
  const w = world(on, { task: 'first', pieces: [cmdDone('pwd'), MESSAGE('built')], sendDelivery: async () => pin ? nativeQueued(pin) : { result: { success: false } } })
  await step($, 'agent-coordinator')
  await $.session.append(senderRow('parent-source', ['sender'], 'One body'))
  await $.tool.call({ tool: 'SendMessage', tool_use_id: 'sender', to: 'agent-coordinator', message: 'One body' } as any)
  expect(savedState(w, 'agent:sess-1:agent-coordinator').coordinator).toBe(undefined)
  expect(w.writes).toEqual([])
  expect(w.spawned.length).toBe(1)
})

// R6 policies and accounting. These fixtures do not call a model or provider.
const cacheThread = '01a14f50-c51c-7370-9bca-f123456789ab'
const cacheJsonl = (events: any[]) => events.map(e => JSON.stringify(e)).join('\n') + '\n'
const cacheUsageEvent = (u: any) => ({ type: 'turn.completed', usage: { input_tokens: u.input, cached_input_tokens: u.cached, output_tokens: u.output } })
const cacheFirst = { input: 53880, cached: 42112, output: 284 }
const cacheTotal = { input: 98934, cached: 86016, output: 651 }
const cacheRole = { model: 'gpt-6.1-sol', effort: 'medium', description: 'Cache fixture' }
const cacheCatalog = JSON.stringify({ models: [...batch7Models.models,
  { slug: 'gpt-6-sol', visibility: 'list', supported_reasoning_levels: ['medium', 'xhigh'], default_reasoning_level: 'medium' },
  { slug: 'gpt-5.6-sol', visibility: 'list', supported_reasoning_levels: ['low'], default_reasoning_level: 'low' },
] })
const cacheFiles = (role?: any) => new Map([
  ['/home/t/.codex/models_cache.json', cacheCatalog],
  ['.claude/codex-mod.json', JSON.stringify({ roles: { implementer: { ...cacheRole, ...role } } })],
  ['/home/t/.codex/config.toml', '[mcp_servers.rea]\ncommand="rea"\n[mcp_servers.other]\ncommand="other"'],
])

for (const value of [{ lean: 1 }, { capabilities: [] }, { capabilities: { webSearch: true } },
  { capabilities: { multiAgent: 'false' } }, { capabilities: { unknown: true } },
  { capabilities: { mcpServers: ['rea', 'rea'] } }, { capabilities: { mcpServers: ['rea.enabled=true'] } },
  { fallbackModels: ['gpt-6-sol', 'gpt-6-sol'] }, { fallbackModels: 'gpt-6-sol' }]) {
  test(`R6 schema rejects ${JSON.stringify(value)}`, () => {
    const parsed = parseProjectRoles(JSON.stringify({ roles: { implementer: { ...cacheRole, ...value } } }))
    expect(Object.keys(parsed.roles)).toEqual([])
    expect(parsed.warnings[0]).toContain('schema')
  })
}

test('R6 schema retains strict optional capabilities, lean and fallbackModels; user options validate', () => {
  const capabilities = { webSearch: 'live', mcpServers: ['rea'], multiAgent: false, skillsInstructions: false, apps: false, plugins: false, images: true }
  const role = { ...cacheRole, lean: true, capabilities, fallbackModels: [] }
  expect(parseProjectRoles(JSON.stringify({ roles: { implementer: role } })).roles.implementer).toMatchObject(role)
  expect(parseConfig({})).toMatchObject({ allowProjectNonLean: false, projectCapabilityAllowlist: [], capacityFallback: ['gpt-6-sol', 'gpt-5.6-sol'] })
  expect(parseConfig({ projectCapabilityAllowlist: ['*', 'mcp:rea'], capacityFallback: ['bad name'] })).toMatchObject({
    projectCapabilityAllowlist: ['mcp:rea'], capacityFallback: ['gpt-6-sol', 'gpt-5.6-sol'],
  })
})

test('R6 policy authority, canonical precedence and fingerprints', () => {
  const lean = ['features.multi_agent=false', 'features.apps=false', 'web_search="disabled"']
  const user = parseConfig({})
  const denied = resolvePolicy(user, { lean: false, capabilities: { webSearch: 'live', multiAgent: true } }, lean, [], '/real')
  expect(denied.policy).toMatchObject({ leanRequested: false, lean: true, multiAgent: false })
  expect(denied.warnings.length).toBe(3)
  const allowed = resolvePolicy(parseConfig({ projectCapabilityAllowlist: ['webSearch:live', 'mcp:rea', 'multiAgent'] }),
    { capabilities: { webSearch: 'live', mcpServers: ['rea'], multiAgent: true } }, lean, ['rea', 'other'], '/real')
  expect(allowed.policy.overrides).toContain('mcp_servers.rea.enabled=true')
  expect(allowed.policy.overrides).toContain('mcp_servers.other.enabled=false')
  expect(allowed.policy.multiAgent).toBe(true)
  const explicit = resolvePolicy(parseConfig({ allowProjectNonLean: true, extraConfig: ['features.multi_agent=false', 'web_search="disabled"'] }),
    { lean: false, capabilities: { webSearch: 'live', multiAgent: true } }, lean, [], '/real')
  expect(explicit.policy.multiAgent).toBe(false)
  expect(explicit.policy.overrides).toContain('web_search="disabled"')
  expect(resolvePolicy(parseConfig({ lean: false }), { lean: true }, lean, [], '/real').policy.lean).toBe(true)
  expect(resolvePolicy(parseConfig({ lean: false }), { capabilities: { apps: true } }, lean, [], '/real').policy.overrides).not.toContain('features.apps=true')
  expect(resolvePolicy(parseConfig({ allowProjectNonLean: true }), { lean: false }, lean, [], '/real').policy.lean).toBe(false)
  expect(canonicalOverrides(['z=1', 'a=false', 'z=2'])).toEqual(['a=false', 'z=2'])
  const again = resolvePolicy(user, undefined, [...lean].reverse(), [], '/real').policy
  const original = resolvePolicy(user, undefined, lean, [], '/real').policy
  expect(again.fingerprint).toBe(original.fingerprint)
  expect(resolvePolicy(user, { instructions: 'Different' }, lean, [], '/real').policy.fingerprint).not.toBe(original.fingerprint)
  expect(resolvePolicy(user, undefined, lean, [], '/shadow').policy.fingerprint).not.toBe(original.fingerprint)
  expect(policyTask(original, 'task')).toBe('Do not spawn sub-agents.\n\ntask')
  expect(policyTask({ ...original, multiAgent: true }, 'task')).toBe('task')
})

for (const transport of ['exec', 'app-server'] as const) test(`R6 ${transport} resolves a selective role once and keeps the snapshot on follow-up`,
  { options: { transport, projectCapabilityAllowlist: ['multiAgent', 'webSearch:live', 'mcp:rea'] } }, async ($, on) => {
    let conv: any[] = [user('first')]
    const opts = { files: cacheFiles({ capabilities: { multiAgent: true, webSearch: 'live', mcpServers: ['rea'] } }), messages: () => conv }
    const w = transport === 'exec' ? await startProject($, on, opts) : appWorld(on, opts)
    if (transport === 'app-server') await startSession($)
    await step($, 'agent-project')
    const first = savedState(w, 'agent:sess-1:agent-project')
    const flag = transport === 'exec' ? '-c' : '--config'
    expect(w.spawned[0].argv.filter((_, i, a) => a[i - 1] === flag)).toContain('features.multi_agent=true')
    expect(w.spawned[0].argv).toContain('web_search="live"')
    expect(w.spawned[0].input).toBe('first')
    expect(first.effectiveConfig.multiAgent).toBe(true)
    expect(first.effectiveFingerprint).toBe(configHash({ policy: first.effectiveConfig.fingerprint, model: first.model, effort: first.effort, sandbox: first.sandbox }))
    w.files.set('/home/t/.codex/config.toml', '[mcp_servers.changed]\ncommand="changed"')
    w.files.set('.claude/codex-mod.json', '{"roles":{}}')
    conv = [...conv, ...toolResult('SubagentHandback'), user('codex-effort: xhigh\nsecond')]
    const second = await step($, 'agent-project', 0, 'cache-follow')
    expect(savedState(w, 'agent:sess-1:agent-project').effectiveConfig).toEqual(first.effectiveConfig)
    expect(w.spawned[1].input).toBe('second')
    expect(w.spawned[1].argv).toContain('mcp_servers.rea.enabled=true')
    expect(w.spawned[1].argv).not.toContain('mcp_servers.changed.enabled=false')
    expect(handback(second.result)).toContain('cold start possible')
  })

test('R6 exec follow-up subtracts a persisted cumulative baseline; duplicate totals replace rather than add', async ($, on) => {
  let conv: any[] = [user('first')]
  const stream = (u: any) => cacheJsonl([{ type: 'thread.started', thread_id: cacheThread }, { type: 'item.completed', item: { type: 'agent_message', text: 'done' } }, cacheUsageEvent({ input: u.input - 10, cached: u.cached - 10, output: u.output - 1 }), cacheUsageEvent(u), cacheUsageEvent(u)])
  const w = world(on, { messages: () => conv, runs: [{ stdout: stream(cacheFirst) }, { stdout: stream(cacheTotal) }] })
  await step($, 'agent-codex')
  conv = [...conv, ...toolResult('SubagentHandback'), user('second')]
  const second = await step($, 'agent-codex', 0, 'cache-second')
  expect(handback(second.result)).toContain('1.1K new tokens (43.9K cached, 367 out)')
  expect(handback(second.result)).toContain(`thread ${cacheThread}`)
  expect(savedState(w, 'agent:sess-1:agent-codex').threadUsage).toEqual({ thread: cacheThread, total: cacheTotal, valid: true })
  expect(w.spawned[1].argv).toContain(cacheThread)
})

test('R6 unknown exec baseline is labeled instead of charging cumulative history to a new run', async ($, on) => {
  const store = new Map<string, unknown>([['agent:sess-1:agent-codex', { ...PERSISTED, agentName: 'codex', thread: cacheThread }]])
  const w = world(on, { store, task: 'new', stdout: cacheJsonl([{ type: 'thread.started', thread_id: cacheThread },
    { type: 'item.completed', item: { type: 'agent_message', text: 'done' } }, cacheUsageEvent(cacheTotal)]) })
  const result = await step($, 'agent-codex')
  expect(handback(result.result)).toContain('direct usage partial/unknown')
  expect(handback(result.result)).not.toContain('86K cached')
  expect(savedState(w, 'agent:sess-1:agent-codex').threadUsage.valid).toBe(true)
})

const capacityError = cacheJsonl([{ type: 'thread.started', thread_id: cacheThread },
  { type: 'turn.failed', error: { message: 'Selected model is at capacity. Please try a different model.' } }])
for (const transport of ['exec', 'app-server'] as const) test(`R6 ${transport} capacity fallback resumes once, notes the switch and counts both launches`,
  { options: { transport } }, async ($, on) => {
    const opts = { files: cacheFiles(), runs: [{ stdout: capacityError, code: 1 }, { stdout: cacheJsonl([
      { type: 'thread.started', thread_id: cacheThread }, { type: 'item.completed', item: { type: 'agent_message', text: 'recovered' } }, cacheUsageEvent(cacheFirst),
    ]) }] }
    const w = transport === 'exec' ? await startProject($, on, opts) : appWorld(on, opts)
    if (transport === 'app-server') await startSession($)
    const result = await step($, 'agent-project')
    expect(w.spawned.length).toBe(2)
    expect(w.spawned[1].argv).toContain(cacheThread)
    expect(w.spawned[1].argv).toContain('gpt-6-sol')
    expect(w.spawned[1].argv).toContain(transport === 'exec' ? 'model_reasoning_effort="medium"' : 'medium')
    expect(handback(result.result)).toContain('gpt-6.1-sol at capacity; continued on gpt-6-sol')
    expect(handback(result.result)).toContain('recovered')
    const rec = savedState(w, 'agent:sess-1:agent-project')
    expect(rec.launches.length).toBe(2)
    expect(rec.launchesSinceNew).toBe(2)
    expect(rec.capacityRetryKey).toBe(rec.launchKey)
    expect(rec.effectiveConfig).toMatchObject({ multiAgent: false })
    expect(w.core).toEqual([])
  })

for (const transport of ['exec', 'app-server'] as const) test(`capacity fallback ${transport}: one final footer with a short failed-attempt usage note`,
  { options: { transport } }, async ($, on) => {
    const failed = cacheJsonl([{ type: 'thread.started', thread_id: cacheThread }, cacheUsageEvent(cacheFirst),
      { type: 'turn.failed', error: { message: 'Selected model is at capacity' } }])
    const opts = { files: cacheFiles(), runs: [{ stdout: failed, code: 1 }, { stdout: cacheJsonl([
      { type: 'thread.started', thread_id: cacheThread }, { type: 'item.completed', item: { type: 'agent_message', text: 'recovered' } }, cacheUsageEvent(cacheTotal),
    ]) }] }
    const w = transport === 'exec' ? await startProject($, on, opts) : appWorld(on, opts)
    if (transport === 'app-server') await startSession($)
    const result = await step($, 'agent-project')
    const text = handback(result.result)
    expect(w.spawned.length).toBe(2)
    expect(text).toContain('capacity attempt usage:')
    expect(text).toContain('at capacity; continued on gpt-6-sol')
    expect(text.split('\n').filter(line => line.includes(' · thread ')).length).toBe(1)
    expect(text).not.toContain('implementer · gpt-6.1-sol ·')
  })

for (const failure of ['none', 'missing', 'write'] as const) test(`recovery reload ${failure}: long identities cannot relaunch completed work`, async ($, on) => {
  const task = 'task'.repeat(1100)
  const key = 'agent:sess-1:agent-restarted'
  const w = world(on, { task })
  const engine = b7Engine(w) as any
  const write = engine.fs.write
  engine.fs.write = async (path: string, body: string) => {
    expect(body.length <= 4 * 1024 * 1024).toBe(true)
    if (failure === 'write') throw new Error('disk full')
    return write(path, body)
  }
  const value = { ...PERSISTED, agentName: 'codex', lastTask: task, launchKey: `1:${task}`, userCount: 1, launchesSinceNew: 1, lastAnswer: 'a'.repeat(4 * 1024 * 1024 + 100), updatedAt: 1_000_000 }
  expect(await writeStoreState(engine, key, value)).toBe(failure !== 'write')
  const compact: any = w.store.get(key)
  expect(compact.lastTask).toBe(undefined)
  expect(compact.lastTaskFingerprint).toEqual(fingerprint(task))
  expect(compact.launchKeyFingerprint).toEqual(fingerprint(`1:${task}`))
  if (failure === 'missing') w.files.clear()
  const result = await step($, 'agent-restarted')
  expect(w.spawned.length).toBe(0)
  if (failure !== 'none') expect(handback(result.result)).toContain('codex failed: recovery state unavailable')
})

test('compact launch fingerprint alone still blocks the same queued message after reload', async ($, on) => {
  const task = 'same launch'.repeat(400)
  const record = { ...compactStoreState({ ...PERSISTED, agentName: 'codex', lastTask: 'previous', userCount: 1, launchKey: `1:receipt:${task}`, launchesSinceNew: 1, updatedAt: 1_000_000 }),
    followUps: [{ text: task, count: 1, uuid: 'receipt' }], handedBack: true }
  const w = world(on, { store: new Map([['agent:sess-1:agent-restarted', record]]), messages: () => [user('previous'), ...toolResult('SubagentHandback')] })
  const result = await step($, 'agent-restarted')
  expect(w.spawned.length).toBe(0)
  expect(handback(result.result)).toContain('this message already had its Codex run')
})

for (const mode of ['twice', 'guard', 'invalid', 'role', 'empty'] as const) test(`R6 capacity fallback ${mode}: bounded retry and validated per-role choices`,
  { options: { maxRunsPerWindow: mode === 'guard' ? 1 : 3, capacityFallback: mode === 'invalid' ? ['gpt-hidden', 'missing'] : ['gpt-6-sol', 'gpt-5.6-sol'] } }, async ($, on) => {
    const role = mode === 'role' ? { fallbackModels: ['missing', 'gpt-5.6-sol'] } : mode === 'empty' ? { fallbackModels: [] } : {}
    const w = await startProject($, on, { files: cacheFiles(role), runs: [{ stdout: capacityError, code: 1 }, { stdout: capacityError, code: 1 }] })
    const result = await step($, 'agent-project')
    expect(w.spawned.length).toBe(['twice', 'role'].includes(mode) ? 2 : 1)
    if (mode === 'role') {
      expect(w.spawned[1].argv).toContain('gpt-5.6-sol')
      expect(w.spawned[1].argv).toContain('model_reasoning_effort="low"')
    }
    if (mode === 'guard') expect(handback(result.result)).toContain('launch guard tripped')
    if (mode === 'invalid') expect(handback(result.result)).toContain('no different model validated')
  })

test('R6 capacity selection requires a visible catalog, skips self and keeps effort when supported', () => {
  const current = { model: 'gpt-6.1-sol', effort: 'xhigh', sandbox: 'read-only' }
  expect(capacityFallback(undefined, ['gpt-6-sol'], current)).toBe(undefined)
  expect(capacityFallback(parseModelsCache(cacheCatalog), ['missing', current.model, 'gpt-6-sol'], current)).toEqual({ ...current, model: 'gpt-6-sol' })
  expect(footer({ ...current, agent: 'a', actions: 0, thread: cacheThread })).toContain(cacheThread)
  expect(footer({ ...current, agent: 'a', actions: 0, thread: cacheThread.replace('89ab', '90cd') })).not.toBe(footer({ ...current, agent: 'a', actions: 0, thread: cacheThread }))
})

test('R6 exec multiAgent off detects a spawn and preserves its honest source report with unknown child usage',
  { options: { nativeActions: false, richRows: true } }, async ($, on) => {
    const w = world(on, { stdout: cacheJsonl([{ type: 'thread.started', thread_id: cacheThread },
      { type: 'item.completed', item: { type: 'collab_tool_call', id: 'spawn-r6', tool: 'spawn_agent', status: 'completed',
        receiver_thread_ids: ['child-r6'], prompt: 'bounded fixture', agents_states: { 'child-r6': { status: 'completed' } } } },
      { type: 'item.completed', item: { type: 'agent_message', text: 'parent done' } }, cacheUsageEvent(cacheFirst)]) })
    const result = await step($, 'agent-codex')
    expect(w.spawned[0].input).toContain('Do not spawn sub-agents.')
    expect(w.logs.filter(l => l.includes('multiAgent=false: Codex child spawn observed')).length).toBe(1)
    expect(handback(result.result)).toContain('multiAgent=false: Codex child spawn observed')
    expect(handback(result.result)).toContain('1 missing')
    expect(handback(result.result)).toContain('parent done')
    expect(w.core).toEqual([])
  })

// Owner grants, named launch requests and persisted execution policy share one resolver.
const policyFailure = async (operation: () => Promise<unknown>): Promise<string> => {
  try { await operation(); return 'unexpected success' } catch (error) { return String(error) }
}
const executionFs = (paths: Record<string, string> = {}, gitValues: Record<string, string> = {}) => ({ process: { run: async (argv: string[]) => {
  if (argv[0] === '/bin/sh') {
    const path = paths[argv[4]!] ?? argv[4]!
    return { exitCode: path === 'missing' ? 1 : 0, stdout: path === 'missing' ? '' : path + '\n', stderr: '' }
  }
  const key = argv.slice(2).join(' ')
  return { exitCode: gitValues[key] === undefined ? 128 : 0, stdout: gitValues[key] ?? '', stderr: gitValues[key] === undefined ? 'fatal: not a git repository' : '' }
} } }) as any

test('execution policy defaults are explicit, extraConfig is owner authority, and prompt TOML is never evaluated', async () => {
  const owner = parseConfig({})
  const policy = await resolveExecution(executionFs(), owner, {}, '/repo', 'workspace-write')
  expect(policy).toMatchObject({ cwd: '/repo', sandbox: 'workspace-write', approvalMode: 'never', networkAccess: false, writableRoots: [], source: 'owner' })
  expect(executionOverrides(policy)).toEqual(['approval_policy="never"', 'approvals_reviewer="user"', 'sandbox_workspace_write.network_access=false', 'sandbox_workspace_write.writable_roots=[]'])
  expect(ownerExecution(parseConfig({ approvalMode: 'ask', networkAccess: false, extraConfig: ['approval_policy="on-request"', 'approvals_reviewer="auto_review"', 'sandbox_workspace_write.network_access=true', "sandbox_workspace_write.writable_roots=['/extra']"] }))).toEqual({ approvalMode: 'auto', networkAccess: true, writableRoots: ['/extra'] })
  expect(executionRequest('codex-cwd: /worktree\ncodex-model: gpt-6-sol\ncodex-network: false\nTask /untrusted/path').rest).toBe('codex-model: gpt-6-sol\nTask /untrusted/path')
  expect(executionRequest('Task: use /untrusted/path and approval_policy="on-request"').request).toEqual({})
  expect(await policyFailure(() => resolveExecution(executionFs(), owner, { approvalMode: 'orchestrator' }, '/repo', 'workspace-write'))).toContain('not granted by the owner')
  expect(await policyFailure(() => resolveExecution(executionFs(), owner, { networkAccess: true }, '/repo', 'workspace-write'))).toContain('not granted by the owner')
  expect(await policyFailure(() => resolveExecution(executionFs(), owner, { writableRoots: ['/foreign'] }, '/repo', 'workspace-write'))).toContain('outside the owner grants')
  expect(await policyFailure(() => resolveExecution(executionFs(), owner, { sandbox: 'danger-full-access' }, '/repo', 'workspace-write'))).toContain('owner authority')
})

test('execution cwd accepts only canonical registered worktrees or explicit owner directory grants', async () => {
  const owner = parseConfig({})
  const gitValues = { '/repo rev-parse --show-toplevel': '/repo', '/repo rev-parse --path-format=absolute --git-common-dir': '/repo/.git', '/worktree rev-parse --path-format=absolute --git-common-dir': '/repo/.git',
    '/worktree rev-parse --show-toplevel': '/worktree', '/repo worktree list --porcelain': 'worktree /repo\n\nworktree /worktree\n' }
  const fs = executionFs({ '/link': '/worktree', '/missing': 'missing' }, gitValues)
  expect((await resolveExecution(fs, owner, { cwd: '/link' }, '/repo', 'workspace-write')).cwd).toBe('/worktree')
  expect(await policyFailure(() => resolveExecution(fs, owner, { cwd: '/missing' }, '/repo', 'workspace-write'))).toContain('directory unavailable')
  expect(await policyFailure(() => resolveExecution(fs, owner, { cwd: '/foreign' }, '/repo', 'workspace-write'))).toContain('cannot validate registered worktree')
  expect(await policyFailure(() => resolveExecution(executionFs({}, { ...gitValues, '/worktree rev-parse --path-format=absolute --git-common-dir': '/foreign/.git' }), owner, { cwd: '/worktree' }, '/repo', 'workspace-write'))).toContain('not a registered worktree')
  expect((await resolveExecution(executionFs(), parseConfig({ allowedCwdRoots: ['/allowed'] }), { cwd: '/allowed/child' }, '/repo', 'workspace-write')).cwd).toBe('/allowed/child')
  expect(await policyFailure(() => resolveExecution(executionFs({ '/allowed/escape': '/foreign' }), parseConfig({ allowedCwdRoots: ['/allowed'] }), { cwd: '/allowed/escape' }, '/repo', 'workspace-write'))).toContain('cannot validate registered worktree')
})

test('saved execution policy rejects privilege and target drift, revoked grants and missing policy recovery', async () => {
  const owner = parseConfig({ networkAccess: true, approvalMode: 'orchestrator', additionalWritableRoots: ['/extra'], allowProjectFullAccess: true })
  const saved = await resolveExecution(executionFs(), owner, {}, '/repo', 'workspace-write')
  expect(await resolveExecution(executionFs(), owner, {}, '/repo', 'workspace-write', saved)).toEqual(saved)
  for (const request of [{ networkAccess: false }, { approvalMode: 'never' as const }, { writableRoots: [] }, { sandbox: 'read-only' }]) expect(await policyFailure(() => resolveExecution(executionFs(), owner, request, '/repo', 'workspace-write', saved))).toContain('same-thread resume cannot change')
  expect(await policyFailure(() => resolveExecution(executionFs(), parseConfig({}), {}, '/repo', 'workspace-write', saved))).toContain('not granted by the owner')
  const legacy = await resolveExecution(executionFs(), owner, {}, '/repo', 'workspace-write', undefined, true)
  expect(legacy).toMatchObject({ approvalMode: 'never', networkAccess: false, writableRoots: [], source: 'legacy' })
  const compacted = compactStoreState({ model: 'm', effort: 'medium', sandbox: 'workspace-write', agentName: 'codex', thread: 'thread', executionFingerprint: saved.fingerprint,
    effectiveExecution: { ...saved, writableRoots: ['/x'.repeat(2000)] }, extra: 'z'.repeat(50000) })
  expect(compacted.executionFingerprint).toBe(saved.fingerprint)
  expect(compacted.effectiveExecution).toBe(undefined)
})

test('full access reports unrestricted network honestly; read-only never claims writable roots', async () => {
  const owner = parseConfig({ defaultSandbox: 'danger-full-access' })
  const full = await resolveExecution(executionFs(), owner, {}, '/repo', 'danger-full-access')
  expect(full.networkAccess).toBe(true)
  expect(permissionEvidence('api.github.com connection failed', full)).toContain('sandbox causality unproven')
  expect(permissionEvidence('error connecting to api.github.com', full)).toContain('sandbox causality unproven')
  expect(permissionEvidence('EPERM .git/FETCH_HEAD', full)).toContain('network=true')
  expect(permissionEvidence('EPERM .git/FETCH_HEAD', full)).toContain('unrestricted filesystem')
  expect(await policyFailure(() => resolveExecution(executionFs(), owner, { networkAccess: false }, '/repo', 'danger-full-access'))).toContain('cannot disable network')
  const read = await resolveExecution(executionFs(), parseConfig({ networkAccess: true, additionalWritableRoots: ['/extra'] }), {}, '/repo', 'read-only')
  expect(read).toMatchObject({ networkAccess: false, writableRoots: [] })
})

test('interactive execution never falls back to exec or launches without owned native ask controls', { options: { approvalMode: 'ask' } }, async ($, on) => {
  const w = world(on)
  const r = await step($, 'agent-codex')
  expect(w.spawned.length).toBe(0)
  expect(handback(r.result)).toContain('requires app-server')
})

test('new execution marker with missing private cache refuses resume before spawning', async ($, on) => {
  const key = 'agent:sess-1:agent-codex'
  const w = world(on, { store: new Map([[key, { model: 'gpt-6.1-sol', effort: 'medium', sandbox: 'workspace-write', agentName: 'codex', thread: 'thread-old', updatedAt: 1, executionFingerprint: 'saved-policy' }]]) })
  const r = await step($, 'agent-codex')
  expect(w.spawned.length).toBe(0)
  expect(handback(r.result)).toContain('saved execution policy unavailable')
})

for (const mode of ['ask', 'orchestrator']) test(`interactive ${mode} fails closed when native controls or authoritative parent are missing`,
  { options: { transport: 'app-server', approvalMode: mode, nativeActions: false } }, async ($, on) => {
    const w = appWorld(on, mode === 'orchestrator' ? { agentList: () => [{ id: 'agent-codex', type: 'codex-mod:codex', status: 'running' }] } : {})
    await startSession($)
    const r = await step($, 'agent-codex')
    expect(w.spawned.length).toBe(0)
    expect(handback(r.result)).toContain(mode === 'ask' ? 'native UI controls' : 'authoritative Claude parent identity')
  })

for (const reason of ['missing-entry', 'list-failure', 'codex-parent']) test(`orchestrator rejects ${reason} without a source launch`,
  { options: { transport: 'app-server', approvalMode: 'orchestrator' } }, async ($, on) => {
    let calls = 0
    const w = appWorld(on, { agentList: () => {
      calls++
      if (reason === 'list-failure' && calls > 1) throw new Error('authoritative agent list unavailable')
      if (reason === 'missing-entry' && calls > 1) return []
      return [{ id: 'agent-codex', type: 'codex-mod:codex', description: 'source', status: 'running', parentId: 'source-parent' },
        { id: 'source-parent', type: 'codex-mod:codex', description: 'source parent', status: 'running', parentId: undefined }] as any
    } })
    await startSession($)
    const r = await step($, 'agent-codex')
    expect(w.spawned.length).toBe(0)
    expect(handback(r.result)).toContain('codex failed')
  })

for (const nested of [false, true]) test(`orchestrator tool binds ${nested ? 'nested Claude' : 'main'} parent, rejects siblings/source/mirrors and consumes an exact decision once`,
  { options: { transport: 'app-server', approvalMode: 'orchestrator', progressIntervalMs: 0 } }, async ($, on) => {
    let parentActive = true
    const q = { type: 'codexmod.request', token: 'approval-token-123', requestId: 71, method: 'item/commandExecution/requestApproval', status: 'pending',
      params: { threadId: 'approval-thread', turnId: 'approval-turn', itemId: 'approval-item', approvalId: 'callback', kind: 'writeStdin', command: 'printf exact', startedAtMs: 1 } }
    const w = appWorld(on, { agentList: () => [
      { id: 'agent-codex', type: 'codex-mod:codex', description: 'source', status: 'running', ...(nested ? { parentId: 'claude-parent' } : {}) },
      { id: 'claude-parent', type: 'general-purpose', description: 'parent', status: parentActive ? 'running' : 'completed', parentId: undefined },
      { id: 'sibling', type: 'general-purpose', description: 'sibling', status: 'running', parentId: undefined },
      { id: 'source-mirror', type: 'codex-mod:codex-child', description: 'mirror', status: 'running', parentId: undefined },
    ], pieces: [THREAD('approval-thread'), TURN('approval-turn'), out(JSON.stringify(q)), cmdDone('printf permitted-parallel-command'), MESSAGE('done')] })
    await startSession($)
    await step($, 'agent-codex')
    const parent = nested ? { agentId: 'claude-parent' } : {}
    const inspect = { tool: 'mcp__codex-mod__codex_approval', tool_use_id: 'inspect-approval', targetAgentId: 'agent-codex', action: 'inspect' }
    for (const agentId of ['agent-codex', 'source-mirror', 'sibling', ...(nested ? [] : ['claude-parent'])]) {
      const denied: any = await $.tool.call({ ...inspect, agentId } as any)
      expect(denied.deny).toContain('immediate Claude parent')
    }
    if (nested) expect((await $.tool.call(inspect as any) as any).deny).toContain('immediate Claude parent')
    const pending: any = await $.tool.call({ ...inspect, ...parent } as any)
    const identity = JSON.parse(pending.result[0].text)[0].identity
    expect(identity).toMatchObject({ method: q.method, requestId: 71, token: q.token, approvalId: 'callback', kind: 'writeStdin' })
    const decide = { ...inspect, ...parent, action: 'decide', identity, decision: 'accept' }
    expect((await $.tool.call({ ...decide, identity: { ...identity, approvalId: 'foreign' } } as any) as any).deny).toContain('stale or mismatched')
    if (nested) {
      parentActive = false
      expect((await $.tool.call(decide as any) as any).deny).toContain('immediate Claude parent')
      parentActive = true
    }
    const accepted: any = await $.tool.call(decide as any)
    expect(accepted.result[0].text).toContain('submitted')
    expect(w.writes.filter(v => v.path.endsWith(`/response-${q.token}.json`)).length).toBe(1)
    expect(JSON.parse(w.writes.find(v => v.path.endsWith(`/response-${q.token}.json`))!.text)).toMatchObject({ ...identity, decision: 'accept', actor: 'orchestrator' })
    expect((await $.tool.call(decide as any) as any).deny).toContain('stale or mismatched')
    expect(w.core).toEqual([])
    expect(w.checks).toEqual([])
  })

const approvalPatch = [{ path: '/repo/exact.txt', kind: { type: 'update' }, diff: '@@ -1 +1 @@\n-old\n+exact-proposal\n' }]
const fileApprovalRequest = { type: 'codexmod.request', token: 'file-approval-token', requestId: 791, method: 'item/fileChange/requestApproval', status: 'pending',
  params: { threadId: 'approval-thread', turnId: 'approval-turn', itemId: 'approval-file', startedAtMs: 1, reason: 'Reason is not a proposed patch' } }
const approvalFileEvent = (id: string, changes = approvalPatch, status = 'inProgress', turn = 'approval-turn') => {
  const item = { id, type: 'fileChange', status, changes }
  return out(JSON.stringify({ type: status === 'inProgress' ? 'item.started' : 'item.completed', item: { ...item, type: 'file_change' },
    source: { transport: 'app-server', event: status === 'inProgress' ? 'item/started' : 'item/completed', threadId: 'approval-thread', turnId: turn, item } }))
}
const approvalHost = () => [{ id: 'agent-codex', type: 'codex-mod:codex', description: 'Owned source task', status: 'running' }]

test('file approval manual controls show only the exact proposal and submit its bound snapshot once',
  { options: { transport: 'app-server', approvalMode: 'ask', progressIntervalMs: 0 } }, async ($, on) => {
    const w = appWorld(on, { agentList: approvalHost, pieces: [THREAD('approval-thread'), TURN('approval-turn'),
      approvalFileEvent('competing-file', [{ path: '/repo/foreign.txt', kind: { type: 'delete' }, diff: '-foreign-proposal' }]),
      approvalFileEvent('approval-file'), out(JSON.stringify(fileApprovalRequest)), MESSAGE('done')] })
    await startSession($)
    const result = await step($, 'agent-codex')
    const call = callsOf(result.chunks).find(c => c.name === 'mcp__codex-mod__codex_question')!
    await runCalls($, result.chunks, 'agent-codex')
    const card: any = await b6Render($, call)
    const shown = JSON.parse(card.children.find((c: any) => c.type === 'Text' && c.children?.[0]?.includes('"changes"')).children[0])
    expect(shown.item.changes).toEqual(approvalPatch)
    expect(shown.identity).toMatchObject({ token: fileApprovalRequest.token, requestId: 791, itemId: 'approval-file' })
    expect(JSON.stringify(card)).not.toContain('foreign-proposal')
    const accept = card.children.find((c: any) => c.type === 'Button' && c.props.label === 'Approve once')
    await $.ui.press({ plugin: 'codex-mod', surface: 'desktop', requestId: call.id, key: accept.props.key } as any)
    await $.ui.press({ plugin: 'codex-mod', surface: 'desktop', requestId: call.id, key: accept.props.key } as any)
    const responses = w.writes.filter(v => v.path.endsWith(`/response-${fileApprovalRequest.token}.json`))
    expect(responses.length).toBe(1)
    expect(JSON.parse(responses[0].text)).toMatchObject({ ...shown.identity, fileChanges: shown, decision: 'accept', actor: 'human' })
    expect(w.core).toEqual([])
  })

for (const missing of ['wrong-item', 'wrong-turn', 'empty', 'oversized']) test(`file approval manual ${missing} evidence offers refusal controls without blind acceptance`,
  { options: { transport: 'app-server', approvalMode: 'ask', progressIntervalMs: 0 } }, async ($, on) => {
    const event = missing === 'wrong-item' ? approvalFileEvent('competing-file') : missing === 'wrong-turn' ? approvalFileEvent('approval-file', approvalPatch, 'inProgress', 'old-turn') :
      approvalFileEvent('approval-file', missing === 'empty' ? [] : [{ path: '/repo/too-large.txt', kind: { type: 'add' }, diff: 'z'.repeat(32768) }])
    const w = appWorld(on, { agentList: approvalHost, pieces: [THREAD('approval-thread'), TURN('approval-turn'), event, out(JSON.stringify(fileApprovalRequest)), MESSAGE('done')] })
    await startSession($)
    const result = await step($, 'agent-codex')
    const call = callsOf(result.chunks).find(c => c.name === 'mcp__codex-mod__codex_question')!
    await runCalls($, result.chunks, 'agent-codex')
    const card: any = await b6Render($, call)
    expect(JSON.stringify(card)).toContain('acceptance disabled')
    const labels = card.children.filter((c: any) => c.type === 'Button').map((c: any) => c.props.label)
    expect(labels).toEqual(['Decline', 'Cancel turn'])
    expect(w.writes).toEqual([])
    const decline = card.children.find((c: any) => c.type === 'Button' && c.props.label === 'Decline')
    await $.ui.press({ plugin: 'codex-mod', surface: 'desktop', requestId: call.id, key: decline.props.key } as any)
    expect(JSON.parse(w.writes[0].text)).toMatchObject({ decision: 'decline', itemId: 'approval-file', token: fileApprovalRequest.token })
  })

for (const stale of [false, true]) test(`file approval parent inspect provides exact changes and ${stale ? 'rejects a stale proposal' : 'requires the inspected proposal for acceptance'}`,
  { options: { transport: 'app-server', approvalMode: 'orchestrator', progressIntervalMs: 0 } }, async ($, on) => {
    const w = appWorld(on, { agentList: approvalHost, pieces: [THREAD('approval-thread'), TURN('approval-turn'),
      approvalFileEvent('competing-file', [{ path: '/repo/foreign.txt', kind: { type: 'delete' }, diff: '-foreign-proposal' }]),
      approvalFileEvent('approval-file'), out(JSON.stringify(fileApprovalRequest)), cmdDone('printf permitted-parallel-command'),
      approvalFileEvent('approval-file', [], 'completed'), cmdDone('printf after-proposal-closed'), MESSAGE('done')] })
    await startSession($)
    const first = await step($, 'agent-codex')
    const inspect = { tool: 'mcp__codex-mod__codex_approval', tool_use_id: 'file-inspect', targetAgentId: 'agent-codex', action: 'inspect' }
    const inspected: any = await $.tool.call(inspect as any)
    const pending = JSON.parse(inspected.result[0].text)[0]
    expect(pending.acceptAllowed).toBe(true)
    expect(pending.fileChanges.item.changes).toEqual(approvalPatch)
    expect(JSON.stringify(pending)).not.toContain('foreign-proposal')
    const decide = { ...inspect, action: 'decide', identity: pending.identity, decision: 'accept' }
    expect((await $.tool.call(decide as any) as any).deny).toContain('file proposal')
    if (stale) {
      await runCalls($, first.chunks, 'agent-codex')
      await step($, 'agent-codex', 1)
      expect((await $.tool.call({ ...decide, fileChanges: pending.fileChanges } as any) as any).deny).toContain('file proposal')
      const current: any = await $.tool.call(inspect as any)
      expect(JSON.parse(current.result[0].text)[0].acceptAllowed).toBe(false)
      expect(w.writes).toEqual([])
      expect((await $.tool.call({ ...decide, decision: 'decline' } as any) as any).result[0].text).toContain('submitted')
    } else {
      expect((await $.tool.call({ ...decide, fileChanges: { ...pending.fileChanges, item: { ...pending.fileChanges.item, id: 'competing-file' } } } as any) as any).deny).toContain('file proposal')
      expect((await $.tool.call({ ...decide, fileChanges: pending.fileChanges } as any) as any).result[0].text).toContain('submitted')
      expect(JSON.parse(w.writes[0].text).fileChanges).toEqual(pending.fileChanges)
    }
    expect(w.core).toEqual([])
  })

for (const context of ['opaque', 'stdin', 'item', 'network']) test(`command approval manual ${context} exposes actionable context without inventing stdin bytes`,
  { options: { transport: 'app-server', approvalMode: 'ask', progressIntervalMs: 0 } }, async ($, on) => {
    const q = { ...fileApprovalRequest, token: 'command-context-token', requestId: 792, method: 'item/commandExecution/requestApproval', params: { threadId: 'approval-thread', turnId: 'approval-turn',
      itemId: 'approval-command', startedAtMs: 2, kind: context === 'stdin' ? 'writeStdin' : 'command', ...(context === 'network' ? { networkApprovalContext: { host: 'api.example.test', protocol: 'https' } } : {}) } }
    const item = { id: 'approval-command', type: 'commandExecution', status: 'inProgress', command: 'ORIGINAL_COMMAND_IS_NOT_STDIN' }
    const commandItem = out(JSON.stringify({ type: 'item.started', item: { ...item, type: 'command_execution' }, source: { transport: 'app-server', event: 'item/started', threadId: 'approval-thread', turnId: 'approval-turn', item } }))
    const w = appWorld(on, { agentList: approvalHost, pieces: [THREAD('approval-thread'), TURN('approval-turn'), ...(['stdin', 'item'].includes(context) ? [commandItem] : []), out(JSON.stringify(q)), MESSAGE('done')] })
    await startSession($)
    const result = await step($, 'agent-codex')
    const call = callsOf(result.chunks).find(c => c.name === 'mcp__codex-mod__codex_question')!
    await runCalls($, result.chunks, 'agent-codex')
    const card: any = await b6Render($, call)
    const accept = card.children.find((c: any) => c.type === 'Button' && c.props.label === 'Approve once')
    if (['opaque', 'stdin'].includes(context)) {
      expect(accept).toBe(undefined)
      expect(JSON.stringify(card)).toContain('acceptance disabled')
      expect(JSON.stringify(card)).not.toContain('ORIGINAL_COMMAND_IS_NOT_STDIN')
    } else {
      expect(Boolean(accept)).toBe(true)
      if (context === 'network') expect(JSON.stringify(card)).toContain('api.example.test')
      else expect(JSON.stringify(card)).toContain('ORIGINAL_COMMAND_IS_NOT_STDIN')
      await $.ui.press({ plugin: 'codex-mod', surface: 'desktop', requestId: call.id, key: accept.props.key } as any)
      expect(JSON.parse(w.writes[0].text).commandContext.kind).toBe(context === 'network' ? 'network' : 'command')
    }
  })


test('execution launch refuses selecting protected descendants from a parent writable-root grant',
  { options: { additionalWritableRoots: ['/tmp/project'] } }, async ($, on) => {
    const w = world(on, { task: 'codex-writable-roots: ["/tmp/project/.git"]\nDo the bounded task' })
    const r = await step($, 'agent-codex')
    expect(w.spawned.length).toBe(0)
    expect(handback(r.result)).toContain('exactly match an explicit canonical owner root')
    expect(w.core).toEqual([])
  })
