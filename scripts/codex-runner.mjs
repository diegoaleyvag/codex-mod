#!/usr/bin/env node
// codex-mod runner: a one-run sidecar that drives `codex app-server` and prints
// what `codex exec --json` would print, so hooks/codex.ts can keep one parser.
//
// Why: a mod hook can only write a spawned child's stdin once (its input is a
// single string) and `codex app-server` exits as soon as stdin hits EOF, so the
// hook cannot hold the app-server pipe open to send `turn/steer` or
// `turn/interrupt` mid-run. This process owns app-server's stdin for exactly
// one run; the hook negotiates private HTTP/Unix control (protocol 2),
// with control files as a compatibility fallback. Stdio events remain version 1.
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
import { appendFileSync, chmodSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { createSteerControl } from '../hooks/steer-control.mjs'
import { TreeUsage } from '../hooks/tree-usage.mjs'
import { QUESTION_METHOD, choiceQuestions, choiceResponse } from '../hooks/questions.mjs'

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
  'rawResponse/completed', 'thread/started', 'thread/status/changed', 'thread/tokenUsage/updated', 'thread/settings/updated',
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
const DEFERRED_ITEMS = ['userMessage', 'hookPrompt', 'functionCallOutput']
const KNOWN_ITEMS = new Set([
  ...DEFERRED_ITEMS, 'agentMessage', 'plan', 'reasoning', 'commandExecution',
  'fileChange', 'mcpToolCall', 'dynamicToolCall', 'collabAgentToolCall', 'subAgentActivity', 'webSearch',
  'imageView', 'imageGeneration', 'enteredReviewMode', 'exitedReviewMode', 'contextCompaction', 'sleep',
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
    case 'collabAgentToolCall': return { ...item, type: 'collab_tool_call', tool: item.tool.replace(/[A-Z]/g, c => `_${c.toLowerCase()}`), receiver_thread_ids: item.receiverThreadIds, agents_states: item.agentsStates }
    case 'subAgentActivity': {
      const agent = String(item.agentPath || item.agentThreadId).replace(/\s+/g, ' ')
      const text = item.kind === 'completed' ? `Codex agent ${agent} finished`
        : item.kind === 'interacted' ? `Codex messaged ${agent}`
        : item.kind === 'interrupted' ? `Codex interrupted agent ${agent}` : `Codex agent ${agent} started`
      return { type: 'note', text }
    }
    case 'contextCompaction': return { type: 'note', text: 'Codex compacted context', dim: true }
    case 'enteredReviewMode': return { ...item, type: 'entered_review_mode' }
    case 'exitedReviewMode': return { ...item, type: 'exited_review_mode' }
    case 'sleep': return { ...item, type: 'sleep' }
    case 'imageView': return { ...item, type: 'image_view' }
    case 'imageGeneration': return { ...item, type: 'image_generation' }
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
  if (argv[0] === 'observe') {
    const a = parseArgs(argv.slice(1))
    const until = Date.now() + 2000
    for (;;) {
      const owner = JSON.parse(readFileSync(join(a.control, 'owner.json'), 'utf8'))
      let text = ''
      try { text = readFileSync(join(a.control, `events-${a.thread}.jsonl`), 'utf8') } catch {}
      if (text.length > Number(a.cursor) || owner.ended || owner.generation !== a.generation || Date.now() >= until) return
      await new Promise(resolve => setTimeout(resolve, 100))
    }
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
  const bufferedRequests = []
  let badLineReported = false
  const unknownMethods = new Set()
  const unknownItems = new Set()
  const itemLifecycles = new Set()
  const turnWaiters = []
  const retries = new Map()
  const inflight = new Set()
  const questions = new Map()
  const requestIds = new Map()
  let ppid = process.ppid
  const nested = args.nested !== 'false'
  const generation = randomUUID()
  const threads = new Map()
  const early = new Map()
  const usage = new TreeUsage()
  let drainTimer
  let rootCode = 0
  let parentStopping = false
  const journal = id => join(args.control, `events-${id}.jsonl`)
  const ownerState = () => {
    const path = join(args.control, 'owner.json')
    writeFileSync(path + '.tmp', JSON.stringify({ generation, updatedAt: Date.now(), ended: finished }))
    renameSync(path + '.tmp', path)
  }
  const childEmit = (state, event) => {
    const tagged = event.type === 'codexmod.child' ? { ...event, owner_thread_id: state.id, owner_turn_id: state.turnId }
      : { ...event, thread_id: state.id, turn_id: state.turnId }
    appendFileSync(journal(state.id), JSON.stringify(tagged) + '\n', { mode: 0o600 })
    emit({ type: 'codexmod.childEvent', thread_id: state.id, turn_id: state.turnId, event: tagged })
  }
  const usageSnapshot = (final = false) => {
    if (!threadId || !turnId || !threads.size) return
    writeFileSync(join(args.control, 'usage.json'), JSON.stringify({ version: 1, generation, edges: [...usage.edges], turns: [...usage.turns], responses: [...usage.responses] }), { mode: 0o600 })
    for (const state of threads.values()) {
      const snapshot = usage.snapshot(state.id, state.rootTurnId)
      if (state.id === threadId && !final) emit({ type: 'codexmod.directUsage', usage: snapshot.direct, partial: snapshot.directPartial })
      else if (state.id !== threadId && !state.attaching && !state.failed) childEmit(state, { type: 'codexmod.directUsage', usage: snapshot.direct, partial: snapshot.directPartial })
      if (!snapshot.children) continue
      const event = { type: 'codexmod.treeUsage', ...snapshot,
        active: snapshot.threadIds.filter(id => id !== state.id && threads.has(id) && !threads.get(id).done && !threads.get(id).failed).length }
      if (state.id === threadId) emit(event)
      else childEmit(state, event)
    }
  }
  const maybeFinish = () => {
    clearTimeout(drainTimer)
    if (!turnDone || [...threads.values()].some(t => t.id !== threadId && (t.attaching || !t.done && !t.failed))) return
    // Final usage can follow terminal notifications on the same connection.
    drainTimer = setTimeout(() => { usageSnapshot(true); void finish(rootCode) }, 200)
  }

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
    ownerState()
    bridge.close()
    clearTimeout(drainTimer)
    clearInterval(poller)
    clearInterval(parentWatch)
    clearTimeout(interruptTimer)
    sweepControl(true)
    for (const q of questions.values()) settleQuestion(q, { error: { code: -32800, message: 'turn finished before a user response' } }, 'cancelled')
    if (unknownMethods.size > 0 || unknownItems.size > 0) {
      emit({ type: 'codexmod.protocol', unknown_methods: [...unknownMethods], unknown_items: [...unknownItems] })
    }
    await Promise.all([...threads.values()].filter(t => t.id !== threadId && !t.failed && t.done).map(t =>
      Promise.race([send('thread/unsubscribe', { threadId: t.id }).catch(() => {}), new Promise(resolve => setTimeout(resolve, 300))])))
    await killChild()
    flushAndExit(code)
  }

  const fatal = async message => {
    emit({ type: 'codexmod.fatal', message })
    await finish(1)
  }

  const send = (method, params, beforeWrite) =>
    new Promise((resolve, reject) => {
      const id = ++nextId
      try { beforeWrite?.(id) } catch { reject({ code: -1, message: 'operation journal unavailable', transport: true }); return }
      const timer = setTimeout(() => { pending.delete(id); reject({ code: -32000, message: `${method} outcome unknown (timeout)`, transport: true }) }, 10000)
      pending.set(id, { resolve: value => { clearTimeout(timer); resolve(value) }, reject: error => { clearTimeout(timer); reject(error) } })
      try {
        child.stdin.write(JSON.stringify({ id, method, params }) + '\n')
      } catch (e) {
        pending.delete(id)
        reject({ code: -1, message: String(e?.message ?? e), transport: true })
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
    for (const t of threads.values()) if (t.id !== threadId && t.turnId && !t.done && !t.failed) void interruptThread(t, 'owner shutdown')
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

  const ack = (id, status, reason, target) => {
    const event = { type: 'codexmod.steer', id, status, ...(reason ? { reason } : {}) }
    if (target && target.id !== threadId) childEmit(target, event)
    else emit(event)
  }
  const interrupted = new Set()
  const stoppedThreads = new Set()
  const stoppedAncestor = state => {
    const seen = new Set()
    while (state && !seen.has(state.id)) {
      if (stoppedThreads.has(state.id)) return true
      seen.add(state.id)
      state = threads.get(state.parent)
    }
    return false
  }
  const interruptThread = async (target, operationId) => {
    const key = JSON.stringify([target.id, target.turnId])
    if (!target.turnId || target.done || target.failed || interrupted.has(key)) return
    interrupted.add(key)
    try {
      await send('turn/interrupt', { threadId: target.id, turnId: target.turnId })
      childEmit(target, { type: 'codexmod.interrupt', operationId, status: 'accepted' })
    } catch (e) {
      childEmit(target, { type: 'codexmod.interrupt', operationId, status: 'unknown', message: String(e?.message ?? e) })
    }
  }

  const fileId = name => {
    const id = name.slice('steer-'.length, -'.json'.length)
    return /^\d+$/.test(id) ? Number(id) : id
  }
  const remove = path => {
    try {
      unlinkSync(path)
    } catch {}
  }

  const requestEvent = (q, status, extra = {}) => {
    const event = { type: 'codexmod.request', token: q.token, requestId: q.id, method: q.method, params: q.params, status, ...extra }
    const target = threads.get(q.params.threadId)
    if (target && target.id !== threadId && !target.attaching && !target.failed) childEmit(target, event)
    else if (q.params.threadId === undefined || q.params.threadId === threadId) emit(event)
  }
  const settleQuestion = (q, response, status) => {
    if (!questions.delete(q.token)) return
    const failed = () => requestEvent(q, 'failed', { error: { code: -32000, message: 'question response could not be delivered to Codex' } })
    try {
      if (!child.stdin.writable || child.stdin.destroyed) return failed()
      child.stdin.write(JSON.stringify({ id: q.id, ...response }) + '\n', err => err ? failed() : requestEvent(q, status, response))
    } catch { failed() }
  }
  const responseFile = (name, path, final) => {
    const token = name.slice('response-'.length, -'.json'.length)
    const q = questions.get(token)
    let body
    try { body = JSON.parse(readFileSync(path, 'utf8')) } catch { return }
    remove(path)
    if (!q || final || turnDone || body.token !== token || body.requestId !== q.id || body.threadId !== threadId || body.turnId !== turnId || body.itemId !== q.params.itemId) {
      emit({ type: 'codexmod.responseRejected', token, message: 'stale or mismatched question response; no answer delivered' })
      return
    }
    if (body.unsupported === true && body.result === undefined) settleQuestion(q, { error: { code: -32601, message: 'owned question UI unavailable; no user answer supplied' } }, 'unsupported')
    else if (body.cancel === true && body.result === undefined) settleQuestion(q, { error: { code: -32800, message: 'user cancelled the question' } }, 'cancelled')
    else if (choiceResponse(q.params, body.result)) settleQuestion(q, { result: body.result }, 'answered')
    else emit({ type: 'codexmod.responseRejected', token, message: 'invalid question response; no answer delivered' })
  }

  const bridge = createSteerControl({ control: args.control, generation,
    destination: body => {
      if (body.threadId && body.threadId !== threadId) {
        const t = threads.get(body.threadId)
        return t && !t.attaching && !t.failed ? t : undefined
      }
      return { id: threadId, turnId, done: turnDone || finished }
    },
    dispatch: (params, beforeWrite) => send('turn/steer', params, beforeWrite),
    emit: event => {
      const target = threads.get(event.threadId)
      if (target && target.id !== threadId) childEmit(target, event)
      else emit(event)
    },
    interrupt: async body => {
      if (body.threadId && body.threadId !== threadId) {
        const target = threads.get(body.threadId)
        if (!target || target.turnId !== body.turnId) throw new Error('stale child interrupt')
        stoppedThreads.add(target.id)
        for (const state of threads.values()) if (stoppedAncestor(state)) void interruptThread(state, body.operationId)
      } else {
        if (body.turnId && body.turnId !== turnId) throw new Error('stale root interrupt')
        parentStopping = true
        for (const t of threads.values()) if (t.id !== threadId) void interruptThread(t, 'parent stop')
        void interruptAndEnd()
      }
    },
  })
  await bridge.listen()
  const handleSteer = async (name, path, body) => {
    // The file remains until the durable journal owns the operation.
    try {
      const entry = await bridge.submit({ ...body, id: fileId(name), messageId: body.messageId ?? String(fileId(name)),
        expectedTurnId: body.expectedTurnId ?? body.turnId })
      remove(path)
      await entry.done
    } catch (error) {
      remove(path)
      ack(fileId(name), 'rejected', String(error?.message ?? error))
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
      if (/^response-[A-Za-z0-9-]+\.json$/.test(name)) {
        responseFile(name, path, final)
        continue
      }
      if (/^interrupt-.+\.json$/.test(name)) {
        let body
        try { body = JSON.parse(readFileSync(path, 'utf8')) } catch { continue }
        remove(path)
        const target = threads.get(body.threadId)
        if (!final && target && target.id !== threadId && target.turnId === body.turnId) {
          stoppedThreads.add(target.id)
          for (const state of threads.values()) if (stoppedAncestor(state)) void interruptThread(state, body.operationId)
        }
        continue
      }
      if (name === 'interrupt') {
        parentStopping = true
        for (const t of threads.values()) if (t.id !== threadId) void interruptThread(t, 'parent stop')
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
      if (!turnId && !final) continue
      let body
      try {
        body = JSON.parse(readFileSync(path, 'utf8'))
        if (typeof body?.text !== 'string') throw new Error('no text')
      } catch {
        const n = (retries.get(name) ?? 0) + 1
        retries.set(name, n)
        if (n >= 10 || final) { remove(path); ack(fileId(name), 'rejected', 'unparseable steer file') }
        continue
      }
      inflight.add(name)
      handleSteer(name, path, body).finally(() => inflight.delete(name))
    }
  }
  const poller = setInterval(() => { ownerState(); sweepControl() }, 200)
  ownerState()

  // --- translation ----------------------------------------------------------

  const changesOf = item =>
    (Array.isArray(item.changes) ? item.changes : [])
      .filter(c => typeof c?.path === 'string' && c.path !== '')
      .map(c => ({ ...c }))

  const handleNotification = (m, state) => {
    const threadId = state?.id ?? rootThread()
    const turnId = state?.turnId ?? rootTurn()
    const emit = event => state && state.id !== rootThread()
      ? childEmit(state, event) : rootEmit(event)
    const p = m.params ?? {}
    if (m.method === 'turn/completed') {
      const turns = state.terminalTurns ??= new Set()
      if (turns.has(turnId)) return
      turns.add(turnId)
    }
    if (!KNOWN_METHODS.has(m.method)) unknownMethods.add(m.method)
    const item = p.item
    discover(item, threadId, turnId)
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
        usage.cumulative(threadId, turnId, state?.rootTurnId ?? rootTurn(), u)
        usageSnapshot()
        if (u?.total) {
          if (state.baseline === undefined) {
            // total before this turn's first model call = first total - first last
            const l = u.last ?? {}
            state.baseline = {
              inputTokens: (u.total.inputTokens ?? 0) - (l.inputTokens ?? 0),
              cachedInputTokens: (u.total.cachedInputTokens ?? 0) - (l.cachedInputTokens ?? 0),
              outputTokens: (u.total.outputTokens ?? 0) - (l.outputTokens ?? 0),
            }
          }
          state.lastTotal = u.total
        }
        break
      }
      case 'rawResponse/completed':
        usage.response(threadId, turnId, p.rootTurnId ?? state.rootTurnId ?? rootTurn(), p.responseId, p.usage)
        usageSnapshot()
        break
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
        emit({ type: p.willRetry === false ? 'error' : 'codexmod.warning', message: p.error?.message ?? 'error' })
        break
      case 'warning':
      case 'configWarning':
      case 'deprecationNotice':
      case 'guardianWarning':
        emit({ type: 'codexmod.warning', message: p.message ?? p.summary ?? p.error?.message ?? JSON.stringify(p) })
        break
      case 'serverRequest/resolved': {
        const token = requestIds.get(JSON.stringify(p.requestId))?.token
        const q = questions.get(token)
        if (q) {
          questions.delete(token)
          requestEvent(q, 'cancelled', { error: { code: -32800, message: 'request resolved by Codex; late answers refused' } })
        }
        break
      }
      case 'turn/completed': {
        const t = p.turn ?? {}
        state.done = true
        if (threadId === rootThread()) { turnDone = true; rootCode = t.status === 'completed' ? 0 : 1 }
        if (t.status === 'completed') {
          const tot = state.lastTotal ?? {}
          const b = state.baseline ?? { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 }
          emit({
            type: 'turn.completed',
            usage: {
              input_tokens: Math.max(0, (tot.inputTokens ?? 0) - b.inputTokens),
              cached_input_tokens: Math.max(0, (tot.cachedInputTokens ?? 0) - b.cachedInputTokens),
              output_tokens: Math.max(0, (tot.outputTokens ?? 0) - b.outputTokens),
            },
          })
        } else if (t.status === 'interrupted') {
          emit({ type: 'turn.failed', status: 'interrupted', error: { message: 'interrupted' } })
        } else {
          emit({ type: 'turn.failed', status: 'failed', error: { message: t.error?.message ?? 'turn failed' } })
        }
        if (threadId === rootThread()) for (const w of turnWaiters.splice(0)) w()
        maybeFinish()
        break
      }
    }
  }

  const rootThread = () => threadId
  const rootTurn = () => turnId
  const rootEmit = emit
  const uuid = id => typeof id === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)

  const parentEmit = (state, event) => state.parent === threadId ? emit(event) : childEmit(threads.get(state.parent), event)

  const attach = async state => {
    try {
      const result = await send('thread/resume', { threadId: state.id, excludeTurns: true })
      const th = result?.thread
      if (th?.id !== state.id || th.parentThreadId !== state.parent) throw new Error('child ancestry mismatch or missing parent')
      if (th.historyMode && !['legacy', 'paginated'].includes(th.historyMode)) throw new Error(`unsupported child history mode ${th.historyMode}`)
      state.model = th.model ?? state.model
      // Buffer live notifications until history has been merged. Only this
      // source generation is replayed; fork history is not a child action.
      let cursor
      const cursors = new Set()
      do {
        const page = await send('thread/turns/list', { threadId: state.id, limit: 100, sortDirection: 'asc', itemsView: 'summary', ...(cursor ? { cursor } : {}) })
        if (!Array.isArray(page?.data)) throw new Error('invalid child turn history')
        for (const turn of page.data) {
          if (turn.rootTurnId !== state.rootTurnId) continue
          state.turnId = turn.id
          let itemCursor
          const itemCursors = new Set()
          do {
            const items = await send('thread/items/list', { threadId: state.id, turnId: turn.id, limit: 100, sortDirection: 'asc', ...(itemCursor ? { cursor: itemCursor } : {}) })
            if (!Array.isArray(items?.data)) throw new Error('invalid child item history')
            for (const entry of items.data) {
              if (entry.turnId !== turn.id || entry.completedAtMs == null) continue
              handleNotification({ method: 'item/completed', params: { ...entry, threadId: state.id, turnId: turn.id } }, state)
            }
            itemCursor = items.nextCursor
            if (itemCursor && itemCursors.has(itemCursor)) throw new Error('repeated child item cursor')
            itemCursors.add(itemCursor)
          } while (itemCursor)
          if (['completed', 'failed', 'interrupted'].includes(turn.status)) handleNotification({ method: 'turn/completed', params: { threadId: state.id, turn } }, state)
        }
        cursor = page.nextCursor
        if (cursor && cursors.has(cursor)) throw new Error('repeated child turn cursor')
        cursors.add(cursor)
      } while (cursor)
      state.attaching = false
      parentEmit(state, { type: 'codexmod.child', thread_id: state.id, parent_thread_id: state.parent,
        source_turn_id: state.spawnTurn, source_item_id: state.spawnItem, root_turn_id: state.rootTurnId, turn_id: state.turnId ?? state.buffer.find(m => m.method === 'turn/started')?.params?.turn?.id,
        path: state.path, model: state.model, effort: state.effort, status: 'attached', generation })
      for (const m of state.buffer.splice(0)) route(m)
      if (parentStopping || stoppedAncestor(state)) void interruptThread(state, 'ancestor stop during attachment')
      maybeFinish()
    } catch (e) {
      state.failed = true
      state.attaching = false
      state.buffer = []
      parentEmit(state, { type: 'codexmod.child', thread_id: state.id, parent_thread_id: state.parent,
        source_turn_id: state.spawnTurn, source_item_id: state.spawnItem, status: 'unavailable',
        reason: String(e?.message ?? e), generation })
      maybeFinish()
    }
  }

  function discover(item, parent, spawnTurn) {
    if (!nested || !item || ['failed', 'declined'].includes(item.status)) return
    const ids = item.type === 'subAgentActivity' && item.kind === 'started' ? [item.agentThreadId]
      : item.type === 'collabAgentToolCall' && item.tool === 'spawnAgent' ? item.receiverThreadIds ?? [] : []
    for (const id of ids) {
      if (!uuid(id) || id === threadId || threads.has(id)) continue
      if (!usage.edge(parent, id)) continue
      const state = { id, parent, spawnTurn, spawnItem: item.id, rootTurnId: threads.get(parent)?.rootTurnId ?? turnId,
        path: item.agentPath, model: item.model, effort: item.reasoningEffort, attaching: true, done: false,
        buffer: early.get(id) ?? [] }
      early.delete(id)
      threads.set(id, state)
      void attach(state)
    }
  }

  const route = m => {
    if (m.method === 'item/started' || m.method === 'item/completed') bridge.observe(m.params?.threadId, m.params?.turnId, m.params?.item)
    const p = m.params ?? {}
    if (!threadId) { buffered.push(m); return }
    const id = p.threadId ?? p.thread?.id ?? threadId
    if (id !== threadId) {
      if (!nested) return
      const state = threads.get(id)
      if (!state) {
        // Unsolicited data is held, never exposed without a verified edge.
        if (uuid(id) && early.size < 32) { const q = early.get(id) ?? []; if (q.length < 256) q.push(m); early.set(id, q) }
        return
      }
      if (state.failed) return
      if (state.attaching) {
        if (state.buffer.length >= 2048) { state.failed = true; state.buffer = []; emit({ type: 'codexmod.child', thread_id: id, parent_thread_id: state.parent, status: 'unavailable', reason: 'child replay buffer overflow' }) }
        else state.buffer.push(m)
        return
      }
      const tid = p.turnId ?? p.turn?.id
      if (m.method === 'turn/started') {
        if (p.turn.rootTurnId && p.turn.rootTurnId !== state.rootTurnId) return
        if (state.turnId !== tid) { state.baseline = undefined; state.lastTotal = undefined }
        state.turnId = tid
        state.done = false
        childEmit(state, { type: 'codexmod.turn', turn_id: tid })
        if (parentStopping || stoppedAncestor(state)) void interruptThread(state, 'ancestor stop')
      }
      if (tid && !state.turnId) state.turnId = tid
      if (tid && state.turnId !== tid) return
      handleNotification(m, state)
      return
    }
    if (m.method === 'turn/started' && !turnId && p.turn?.id) { setTurn(p.turn.id); return }
    const tid = p.turnId ?? p.turn?.id
    if (!turnId) { buffered.push(m); return }
    if (tid !== undefined && tid !== turnId) return
    handleNotification(m, threads.get(threadId))
  }

  function setTurn(id) {
    if (turnId) return
    turnId = id
    threads.set(threadId, { id: threadId, turnId: id, rootTurnId: id, done: false })
    emit({ type: 'codexmod.turn', turn_id: id })
    for (const m of buffered.splice(0)) route(m)
    for (const m of bufferedRequests.splice(0)) onLine(JSON.stringify(m))
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
      if (!turnId && !turnDone && m.params?.threadId === threadId) {
        bufferedRequests.push(m)
        return
      }
      const key = JSON.stringify(m.id)
      const previous = requestIds.get(key)
      if (previous) {
        if (previous.method !== m.method || JSON.stringify(previous.params) !== JSON.stringify(m.params)) emit({ type: 'codexmod.responseRejected', token: previous.token, message: 'RPC ID reused with different request; no answer delivered' })
        return
      }
      const q = { id: m.id, token: randomUUID(), method: m.method, params: publicSource(m.params ?? {}) }
      requestIds.set(key, q)
      if (m.method === QUESTION_METHOD && args.questions === 'choices' && choiceQuestions(q.params) && q.params.threadId === threadId && q.params.turnId === turnId && !turnDone && !finished) {
        questions.set(q.token, q)
        requestEvent(q, 'pending')
        return
      }
      const error = { code: -32601, message: 'unsupported by codex-mod (only enabled, non-secret bounded choice questions; approvals remain disabled)' }
      requestEvent(q, 'unsupported', { error })
      if (m.params?.threadId === undefined || m.params.threadId === threadId) {
        emit({ type: 'codexmod.source', source: { transport: 'app-server', event: m.method, threadId, turnId,
          data: publicSource({ ...m.params, requestId: m.id, response: error }) } })
      }
      try {
        child.stdin.write(JSON.stringify({ id: m.id, error }) + '\n')
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
    for (const h of pending.values()) h.reject({ code: -2, message: 'app-server exited', transport: true })
    pending.clear()
    if (out.trim() !== '') {
      const rest = out
      out = ''
      onLine(rest)
    }
    if (!childExpectedExit && !finished) {
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
