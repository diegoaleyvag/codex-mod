#!/usr/bin/env node
// codex-mod runner: a one-run sidecar that drives `codex app-server` and prints
// what `codex exec --json` would print, so hooks/codex.ts can keep one parser.
//
// Why: a mod hook can only write a spawned child's stdin once (its input is a
// single string) and `codex app-server` exits as soon as stdin hits EOF, so the
// hook cannot hold the app-server pipe open to send `turn/steer` or
// `turn/interrupt` mid-run. This process owns app-server's stdin for exactly
// one run; the hook talks to it through files in a control directory.
//
// CLI:  node codex-runner.mjs run --codex <path> --cwd <dir> --model <m>
//         --effort <e> --sandbox <s> [--thread <id>] [--config k=v]...
//         --control <dir>            (prompt: stdin until EOF)
//       node codex-runner.mjs --version      (prints the protocol version, 1)
// `--codex` is an executable; when it ends in `.mjs` the runner launches it
// with process.execPath instead (that is how tests inject a fake app-server).
//
// Control dir (created mode 0700 with the chain above it, since steer files
// carry prompt text; polled every 200 ms, processed in name order, deleted
// after use): `steer-<id>.json` {"text": ".."} -> turn/steer, answered on stdout by
// a `codexmod.steer` line (id is a number when the file id is all digits);
// `interrupt` -> turn/interrupt. An unparseable file is retried on the next
// poll up to 10 times, then deleted with a rejected ack.
//
// Output (JSONL): exec-compatible `thread.started`, `item.started|completed`
// (including reasoning, web_search, mcp_tool_call, plan_update, proposed_plan
// and note), `turn.completed` (usage of this turn only), `turn.failed`, `error`; plus runner-only `codexmod.turn`,
// `codexmod.steer`, `codexmod.protocol` (drift evidence) and `codexmod.fatal`.
// Exit code: 0 when the turn completed, 1 otherwise. Never writes outside the
// control dir; never prints credentials.

import { spawn } from 'node:child_process'
import { chmodSync, mkdirSync, readdirSync, readFileSync, unlinkSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

const PROTOCOL_VERSION = 1
const PLUGIN_VERSION = '1'
const OPT_OUT = [
  'item/agentMessage/delta',
  'item/reasoning/summaryTextDelta',
  'item/reasoning/summaryPartAdded',
  'item/reasoning/textDelta',
  'item/fileChange/outputDelta',
]
// Notifications / item types we know about (handled or deliberately ignored).
// Anything else is reported once at the end as protocol drift evidence.
const KNOWN_METHODS = new Set([
  'error', 'warning', 'configWarning', 'deprecationNotice', 'guardianWarning',
  'thread/started', 'thread/status/changed', 'thread/tokenUsage/updated', 'thread/settings/updated',
  'thread/name/updated', 'thread/goal/updated', 'thread/goal/cleared', 'thread/readState/changed', 'thread/prediction/updated', 'thread/compacted', 'thread/closed', 'thread/queue/changed',
  'turn/started', 'turn/completed', 'turn/diff/updated', 'turn/plan/updated', 'turn/moderationMetadata',
  'hook/started', 'hook/completed', 'item/started', 'item/completed', 'rawResponseItem/completed',
  'item/autoApprovalReview/started', 'item/autoApprovalReview/completed', 'serverRequest/resolved',
  'item/fileChange/patchUpdated', 'item/plan/delta', 'item/mcpToolCall/progress',
  'item/commandExecution/terminalInteraction', 'mcpServer/startupStatus/updated',
  'item/commandExecution/outputDelta',
  'account/updated', 'account/rateLimits/updated', 'model/rerouted', 'model/verification',
  'model/safetyBuffering/updated', 'skills/changed', 'app/list/updated', 'remoteControl/status/changed',
  ...OPT_OUT,
])
const DEFERRED_ITEMS = ['userMessage', 'hookPrompt', 'functionCallOutput', 'imageView']
const KNOWN_ITEMS = new Set([
  ...DEFERRED_ITEMS, 'agentMessage', 'plan', 'reasoning', 'commandExecution',
  'fileChange', 'mcpToolCall', 'dynamicToolCall', 'collabAgentToolCall', 'subAgentActivity', 'webSearch',
  'imageGeneration', 'enteredReviewMode', 'exitedReviewMode', 'contextCompaction', 'sleep',
])

// --- output ---------------------------------------------------------------

let stdoutBroken = false
const emit = obj => {
  if (stdoutBroken) return
  try {
    process.stdout.write(JSON.stringify(obj) + '\n')
  } catch {
    stdoutBroken = true
  }
}

// Completed turn/thread snapshots may contain private reasoning as well.
const publicSource = value => {
  if (Array.isArray(value)) return value.map(publicSource)
  if (value === null || typeof value !== 'object') return value
  return Object.fromEntries(Object.entries(value)
    .filter(([key]) => value.type !== 'reasoning' || key !== 'content')
    .map(([key, child]) => [key, publicSource(child)]))
}

// --- args / config values ---------------------------------------------------

/** Splits `a, 'b,c', [d]` at top-level commas, honouring quotes and brackets. */
function splitTop(s) {
  const out = []
  let depth = 0
  let quote = ''
  let cur = ''
  for (const ch of s) {
    if (quote) {
      cur += ch
      if (ch === quote) quote = ''
    } else if (ch === '"' || ch === "'") {
      quote = ch
      cur += ch
    } else if (ch === '[') {
      depth++
      cur += ch
    } else if (ch === ']') {
      depth--
      cur += ch
    } else if (ch === ',' && depth === 0) {
      out.push(cur)
      cur = ''
    } else cur += ch
  }
  if (cur.trim() !== '') out.push(cur)
  return out
}

/** A TOML-ish scalar/array: true/false, numbers, "quoted", 'literal', [..], else the raw string. */
export function tomlValue(raw) {
  const s = raw.trim()
  if (s === 'true') return true
  if (s === 'false') return false
  if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s)
  if (s.length >= 2 && s.startsWith('"') && s.endsWith('"')) {
    try {
      return JSON.parse(s)
    } catch {
      return s.slice(1, -1)
    }
  }
  if (s.length >= 2 && s.startsWith("'") && s.endsWith("'")) return s.slice(1, -1)
  if (s.startsWith('[') && s.endsWith(']')) return splitTop(s.slice(1, -1)).map(tomlValue)
  return s
}

function parseArgs(argv) {
  const a = { config: [] }
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i]
    if (!k.startsWith('--')) continue
    const v = argv[++i]
    if (k === '--config') a.config.push(v ?? '')
    else a[k.slice(2)] = v
  }
  return a
}

/**
 * Creates the control dir (and the `runs` chain above it) private to the
 * user: steer files carry prompt text. Mode 0o700 at creation, then chmod on
 * every directory this call created (best effort: a umask or an unusual file
 * system may ignore either), and on the dir itself when it already existed.
 */
function makeControlDir(dir) {
  const target = resolve(dir)
  const first = mkdirSync(target, { recursive: true, mode: 0o700 })
  const made = []
  if (first !== undefined) {
    for (let d = target; ; d = dirname(d)) {
      made.push(d)
      if (d === resolve(first) || dirname(d) === d) break
    }
  } else made.push(target)
  for (const d of made) {
    try {
      chmodSync(d, 0o700)
    } catch {}
  }
}

/** Completed items only: started searches and calls do not carry usable results. */
function completedItem(item, changesOf) {
  switch (item?.type) {
    case 'fileChange': return { ...item, type: 'file_change', changes: changesOf(item) }
    case 'commandExecution': return { ...item, type: 'command_execution', aggregated_output: item.aggregatedOutput, exit_code: item.exitCode }
    case 'agentMessage': return { type: 'agent_message', text: item.text ?? '', ...(item.phase != null ? { phase: item.phase } : {}) }
    // Only the public summary crosses the pipe; never reasoning.content.
    case 'reasoning': return { type: 'reasoning', text: (Array.isArray(item.summary) ? item.summary : []).filter(s => typeof s === 'string').join('\n\n') }
    case 'webSearch': return { type: 'web_search', query: item.query, action: item.action, results: item.results }
    case 'mcpToolCall': return { type: 'mcp_tool_call', server: item.server, tool: item.tool, arguments: item.arguments, result: item.result, error: item.error, status: item.status }
    case 'dynamicToolCall': return { type: 'dynamic_tool_call', namespace: item.namespace, tool: item.tool, arguments: item.arguments, content_items: item.contentItems, success: item.success, status: item.status }
    case 'plan': return { type: 'proposed_plan', text: item.text }
    case 'collabAgentToolCall': return { type: 'collab_tool_call', tool: item.tool.replace(/[A-Z]/g, c => `_${c.toLowerCase()}`), receiver_thread_ids: item.receiverThreadIds, prompt: item.prompt, agents_states: item.agentsStates, status: item.status }
    case 'subAgentActivity': {
      const agent = String(item.agentPath || item.agentThreadId).replace(/\s+/g, ' ')
      const text = item.kind === 'completed' ? `Codex agent ${agent} finished`
        : item.kind === 'interacted' ? `Codex messaged ${agent}`
        : item.kind === 'interrupted' ? `Codex interrupted agent ${agent}` : `Codex agent ${agent} started`
      return { type: 'note', text }
    }
    case 'contextCompaction': return { type: 'note', text: 'Codex compacted context', dim: true }
    case 'enteredReviewMode': return { type: 'note', text: 'Codex entered review mode', dim: true }
    case 'exitedReviewMode': return { type: 'note', text: 'Codex exited review mode', dim: true }
    case 'sleep': return { type: 'note', text: `Codex slept for ${item.durationMs} ms`, dim: true }
    case 'imageGeneration': return { type: 'note', text: `Codex image generation: ${item.status}${item.savedPath ? ` (${item.savedPath})` : ''}`, dim: true }
    // imageView is deliberately deferred; the known-item list still exempts it from drift.
    default: return undefined
  }
}

// --- main -----------------------------------------------------------------

async function main() {
  const argv = process.argv.slice(2)
  if (argv[0] === '--version') {
    process.stdout.write(`${PROTOCOL_VERSION}\n`)
    return
  }
  if (argv[0] !== 'run') {
    process.stderr.write('usage: codex-runner.mjs run --codex <path> --cwd <dir> --model <m> --effort <e> --sandbox <s> [--thread <id>] [--config k=v]... --control <dir>\n')
    process.exit(2)
  }
  const args = parseArgs(argv.slice(1))
  for (const k of ['codex', 'cwd', 'model', 'effort', 'sandbox', 'control']) {
    if (!args[k]) {
      process.stderr.write(`codex-runner: missing --${k}\n`)
      process.exit(2)
    }
  }
  makeControlDir(args.control)

  // State.
  let child
  let childExpectedExit = false
  let stderrTail = ''
  let nextId = 0
  const pending = new Map()
  let threadId
  let turnId
  let turnDone = false
  let finished = false
  let pendingInterrupt = false
  let interruptTimer
  let codexVersion = 'unknown'
  const buffered = []
  let badLineReported = false
  const unknownMethods = new Set()
  const unknownItems = new Set()
  const itemLifecycles = new Set()
  let baseline // total usage before this turn
  let lastTotal
  const turnWaiters = []
  const retries = new Map()
  const inflight = new Set()
  let ppid = process.ppid

  const flushAndExit = code => {
    const t = setTimeout(() => process.exit(code), 500)
    t.unref?.()
    try {
      process.stdout.write('', () => process.exit(code))
    } catch {
      process.exit(code)
    }
  }

  const killChild = async () => {
    if (!child || child.exitCode !== null || child.signalCode !== null) return
    childExpectedExit = true
    const exited = new Promise(r => child.once('exit', r))
    try {
      child.stdin.end()
    } catch {}
    const wait = ms => Promise.race([exited.then(() => true), new Promise(r => setTimeout(() => r(false), ms))])
    if (await wait(3000)) return
    child.kill('SIGTERM')
    if (await wait(2000)) return
    child.kill('SIGKILL')
    await wait(500)
  }

  const finish = async code => {
    if (finished) return
    finished = true
    clearInterval(poller)
    clearInterval(parentWatch)
    clearTimeout(interruptTimer)
    sweepControl(true)
    if (unknownMethods.size > 0 || unknownItems.size > 0) {
      emit({ type: 'codexmod.protocol', unknown_methods: [...unknownMethods], unknown_items: [...unknownItems] })
    }
    await killChild()
    flushAndExit(code)
  }

  const fatal = async message => {
    emit({ type: 'codexmod.fatal', message })
    await finish(1)
  }

  const send = (method, params) =>
    new Promise((resolve, reject) => {
      const id = ++nextId
      pending.set(id, { resolve, reject })
      try {
        child.stdin.write(JSON.stringify({ id, method, params }) + '\n')
      } catch (e) {
        pending.delete(id)
        reject({ code: -1, message: String(e?.message ?? e) })
      }
    })
  const notify = method => {
    try {
      child.stdin.write(JSON.stringify({ method }) + '\n')
    } catch {}
  }

  // Interrupt the active turn, then wait up to `ms` for turn/completed.
  const interrupt = async ms => {
    if (finished || turnDone) return
    if (!turnId) {
      pendingInterrupt = true
      return
    }
    send('turn/interrupt', { threadId, turnId }).catch(() => {})
    await Promise.race([new Promise(r => turnWaiters.push(r)), new Promise(r => setTimeout(r, ms))])
  }
  // An `interrupt` from the control dir: interrupt the turn and end the run.
  // turn/completed normally finishes it; a server that never answers within
  // 5 s is reported as interrupted and the run ends anyway.
  const interruptAndEnd = async () => {
    await interrupt(5000)
    if (!turnDone && !finished) {
      emit({ type: 'turn.failed', error: { message: 'interrupted' } })
      await finish(1)
    }
  }

  const shutdown = async () => {
    if (finished) return
    if (turnId && !turnDone) await interrupt(2000)
    await finish(1)
  }
  for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(sig, shutdown)
  process.stdout.on('error', () => {
    stdoutBroken = true
    shutdown()
  })
  const parentWatch = setInterval(() => {
    if (process.ppid !== ppid) {
      ppid = process.ppid
      shutdown()
    }
  }, 1000)

  // --- control directory ----------------------------------------------------

  const ack = (id, status, reason) => emit({ type: 'codexmod.steer', id, status, ...(reason ? { reason } : {}) })
  const fileId = name => {
    const id = name.slice('steer-'.length, -'.json'.length)
    return /^\d+$/.test(id) ? Number(id) : id
  }
  const remove = path => {
    try {
      unlinkSync(path)
    } catch {}
  }

  const handleSteer = async (name, path, text) => {
    const id = fileId(name)
    remove(path)
    try {
      await send('turn/steer', { threadId, expectedTurnId: turnId, input: [{ type: 'text', text, text_elements: [] }] })
      ack(id, 'accepted')
    } catch (e) {
      ack(id, 'rejected', String(e?.message ?? 'turn/steer failed'))
    }
  }

  // `final`: the turn is over, so answer whatever is still queued as rejected.
  function sweepControl(final = false) {
    let names
    try {
      names = readdirSync(args.control).sort()
    } catch {
      return
    }
    for (const name of names) {
      const path = join(args.control, name)
      if (name === 'interrupt') {
        if (final || turnDone) {
          remove(path)
          continue
        }
        if (!turnId) {
          remove(path)
          pendingInterrupt = true
          continue
        }
        remove(path)
        void interruptAndEnd()
        continue
      }
      if (!/^steer-.+\.json$/.test(name) || inflight.has(name)) continue
      if (final || turnDone) {
        remove(path)
        ack(fileId(name), 'rejected', 'turn finished')
        continue
      }
      if (!turnId) continue // hold until the turn id is known
      let text
      try {
        const body = JSON.parse(readFileSync(path, 'utf8'))
        if (typeof body?.text !== 'string') throw new Error('no text')
        text = body.text
      } catch {
        const n = (retries.get(name) ?? 0) + 1
        retries.set(name, n)
        if (n >= 10) {
          remove(path)
          ack(fileId(name), 'rejected', 'unparseable steer file')
        }
        continue
      }
      inflight.add(name)
      handleSteer(name, path, text).finally(() => inflight.delete(name))
    }
  }
  const poller = setInterval(() => sweepControl(), 200)

  // --- translation ----------------------------------------------------------

  const changesOf = item =>
    (Array.isArray(item.changes) ? item.changes : [])
      .filter(c => typeof c?.path === 'string' && c.path !== '')
      .map(c => ({ ...c }))

  const handleNotification = m => {
    const p = m.params ?? {}
    if (!KNOWN_METHODS.has(m.method)) unknownMethods.add(m.method)
    const item = p.item
    if (item?.id && ['item/started', 'item/completed'].includes(m.method)) {
      const key = JSON.stringify([threadId, turnId, item.id, m.method])
      if (itemLifecycles.has(key) || (m.method === 'item/started' && itemLifecycles.has(JSON.stringify([threadId, turnId, item.id, 'item/completed'])))) return
      itemLifecycles.add(key)
    }
    if (item && typeof item.type === 'string' && !KNOWN_ITEMS.has(item.type)) unknownItems.add(item.type)
    // The compatibility view below keeps today's rows. This parallel record
    // keeps the source contract, including variants without a renderer. Raw
    // reasoning is intentionally excluded from both views and from deltas.
    const publicItem = publicSource(item)
    const source = { transport: 'app-server', event: m.method, threadId, turnId,
      ...(p.startedAtMs !== undefined ? { startedAtMs: p.startedAtMs } : {}),
      ...(p.completedAtMs !== undefined ? { completedAtMs: p.completedAtMs } : {}),
      ...(item ? { item: publicItem } : {}),
      data: publicSource(Object.fromEntries(Object.entries(p).filter(([key]) => key !== 'item'))) }
    if (!['item/started', 'item/completed', 'rawResponseItem/completed', 'item/reasoning/textDelta'].includes(m.method)) {
      emit({ type: 'codexmod.source', source })
    }
    switch (m.method) {
      case 'thread/tokenUsage/updated': {
        const u = p.tokenUsage
        if (u?.total) {
          if (baseline === undefined) {
            // total before this turn's first model call = first total - first last
            const l = u.last ?? {}
            baseline = {
              inputTokens: (u.total.inputTokens ?? 0) - (l.inputTokens ?? 0),
              cachedInputTokens: (u.total.cachedInputTokens ?? 0) - (l.cachedInputTokens ?? 0),
              outputTokens: (u.total.outputTokens ?? 0) - (l.outputTokens ?? 0),
            }
          }
          lastTotal = u.total
        }
        break
      }
      case 'item/started':
        emit({ type: 'item.started', item: item?.type === 'fileChange' ? completedItem(item, changesOf) : { type: 'source_only' }, source })
        break
      case 'item/completed': {
        const translated = completedItem(item, changesOf)
        emit({ type: 'item.completed', item: translated ?? { type: 'source_only' }, source })
        break
      }
      case 'turn/plan/updated':
        emit({ type: 'item.updated', item: { type: 'plan_update', explanation: p.explanation, steps: p.plan } })
        break
      case 'error':
        if (p.willRetry === false) emit({ type: 'error', message: p.error?.message ?? 'error' })
        break
      case 'turn/completed': {
        const t = p.turn ?? {}
        turnDone = true
        if (t.status === 'completed') {
          const tot = lastTotal ?? {}
          const b = baseline ?? { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 }
          emit({
            type: 'turn.completed',
            usage: {
              input_tokens: Math.max(0, (tot.inputTokens ?? 0) - b.inputTokens),
              cached_input_tokens: Math.max(0, (tot.cachedInputTokens ?? 0) - b.cachedInputTokens),
              output_tokens: Math.max(0, (tot.outputTokens ?? 0) - b.outputTokens),
            },
          })
        } else if (t.status === 'interrupted') {
          emit({ type: 'turn.failed', error: { message: 'interrupted' } })
        } else {
          emit({ type: 'turn.failed', error: { message: t.error?.message ?? 'turn failed' } })
        }
        for (const w of turnWaiters.splice(0)) w()
        finish(t.status === 'completed' ? 0 : 1)
        break
      }
    }
  }

  // Ours when it belongs to our thread and (once known) our turn.
  const route = m => {
    const p = m.params ?? {}
    if (p.threadId !== undefined && p.threadId !== threadId) return
    if (m.method === 'turn/started' && !turnId && p.turn?.id) {
      setTurn(p.turn.id)
      return
    }
    const tid = p.turnId ?? p.turn?.id
    if (!turnId) {
      buffered.push(m)
      return
    }
    if (tid !== undefined && tid !== turnId) return
    handleNotification(m)
  }

  function setTurn(id) {
    if (turnId) return
    turnId = id
    emit({ type: 'codexmod.turn', turn_id: id })
    for (const m of buffered.splice(0)) route(m)
    if (pendingInterrupt) {
      pendingInterrupt = false
      void interruptAndEnd()
    }
  }

  // --- app-server I/O -------------------------------------------------------

  const onLine = line => {
    if (line.trim() === '') return
    let m
    try {
      m = JSON.parse(line)
    } catch {
      if (!badLineReported) {
        badLineReported = true
        emit({ type: 'error', message: 'codex-runner: skipped a malformed line from app-server' })
      }
      return
    }
    if (m === null || typeof m !== 'object') return
    if (m.id !== undefined && m.method === undefined) {
      const h = pending.get(m.id)
      if (!h) return
      pending.delete(m.id)
      if (m.error) h.reject(m.error)
      else h.resolve(m.result)
      return
    }
    if (m.id !== undefined && typeof m.method === 'string') {
      if (m.params?.threadId === undefined || m.params.threadId === threadId) {
        emit({ type: 'codexmod.source', source: { transport: 'app-server', event: m.method, threadId, turnId,
          data: publicSource({ ...m.params, requestId: m.id, response: { code: -32601, message: 'unsupported by codex-mod' } }) } })
      }
      try {
        child.stdin.write(JSON.stringify({ id: m.id, error: { code: -32601, message: 'unsupported by codex-mod' } }) + '\n')
      } catch {}
      return
    }
    if (typeof m.method === 'string') route(m)
  }

  const isProtocolError = e => e?.code === -32601
  const rpcFail = (what, e) =>
    fatal(
      isProtocolError(e)
        ? `app-server protocol changed (codex-cli ${codexVersion}): ${what} -> ${e.message ?? 'method not found'}`
        : `app-server ${what} failed: ${e?.message ?? JSON.stringify(e)}`,
    )

  // Read the prompt first so a hook that writes stdin late never races startup.
  const chunks = []
  for await (const c of process.stdin) chunks.push(c)
  const prompt = Buffer.concat(chunks).toString('utf8')
  if (prompt.trim() === '') return fatal('empty prompt')

  const isMjs = args.codex.endsWith('.mjs')
  try {
    child = spawn(isMjs ? process.execPath : args.codex, isMjs ? [args.codex, 'app-server'] : ['app-server'], {
      cwd: args.cwd,
      env: process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
  } catch (e) {
    return fatal(`cannot start app-server: ${e?.message ?? e}`)
  }
  child.on('error', e => {
    if (!finished) fatal(`cannot start app-server: ${e?.message ?? e}`)
  })
  child.stdin.on('error', () => {})
  child.stderr.on('data', d => {
    stderrTail = (stderrTail + d).slice(-2000)
  })
  let out = ''
  child.stdout.on('data', d => {
    out += d
    let n
    while ((n = out.indexOf('\n')) >= 0) {
      const line = out.slice(0, n)
      out = out.slice(n + 1)
      onLine(line)
    }
  })
  child.on('exit', (code, signal) => {
    for (const h of pending.values()) h.reject({ code: -2, message: 'app-server exited' })
    pending.clear()
    if (out.trim() !== '') {
      const rest = out
      out = ''
      onLine(rest)
    }
    if (!childExpectedExit && !finished && !turnDone) {
      fatal(`app-server exited early (${signal ?? code}): ${stderrTail.trim()}`)
    }
  })

  let init
  try {
    init = await send('initialize', {
      clientInfo: { name: 'codex-mod', title: null, version: PLUGIN_VERSION },
      capabilities: { experimentalApi: false, requestAttestation: false, optOutNotificationMethods: OPT_OUT },
    })
  } catch (e) {
    if (finished) return
    return rpcFail('initialize', e)
  }
  const ua = typeof init?.userAgent === 'string' ? /([0-9]+\.[0-9]+\.[0-9]+[^\s;)]*)/.exec(init.userAgent) : null
  if (ua) codexVersion = ua[1]
  notify('initialized')

  const config = { model_reasoning_effort: args.effort }
  for (const kv of args.config) {
    const i = kv.indexOf('=')
    if (i > 0) config[kv.slice(0, i).trim()] = tomlValue(kv.slice(i + 1))
  }
  const base = { cwd: args.cwd, model: args.model, sandbox: args.sandbox, approvalPolicy: 'never', config }
  let th
  try {
    th = args.thread
      ? await send('thread/resume', { threadId: args.thread, ...base })
      : await send('thread/start', { ...base, serviceName: 'codex_mod', ephemeral: false })
  } catch (e) {
    if (finished) return
    return rpcFail(args.thread ? 'thread/resume' : 'thread/start', e)
  }
  threadId = th?.thread?.id
  if (typeof threadId !== 'string') return fatal('app-server protocol changed: thread response has no thread id')
  emit({ type: 'thread.started', thread_id: threadId })

  sweepControl() // an interrupt written during startup
  if (pendingInterrupt) {
    emit({ type: 'turn.failed', error: { message: 'interrupted' } })
    return finish(1)
  }
  let ts
  try {
    ts = await send('turn/start', {
      threadId,
      input: [{ type: 'text', text: prompt, text_elements: [] }],
      effort: args.effort,
      model: args.model,
    })
  } catch (e) {
    if (finished) return
    return rpcFail('turn/start', e)
  }
  if (typeof ts?.turn?.id !== 'string') return fatal('app-server protocol changed: turn/start response has no turn id')
  setTurn(ts.turn.id)
}

main().catch(e => {
  emit({ type: 'codexmod.fatal', message: `runner crashed: ${e?.message ?? e}` })
  process.exit(1)
})
