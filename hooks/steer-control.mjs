// Per-run HTTP control and durable operation journal. A client timeout never
// grants permission to replay a request through another channel.
import { createServer } from 'node:http'
import { createHash } from 'node:crypto'
import { chmodSync, closeSync, fsyncSync, openSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export const CONTROL_VERSION = 2

export function createSteerControl({ control, generation, destination, dispatch, emit, interrupt, waitMs = 150 }) {
  const operations = new Map()
  const pathFor = id => join(control, `message-${createHash('sha256').update(id).digest('hex')}.json`)
  const persist = entry => {
    const path = pathFor(entry.outcome.messageId)
    const temp = path + '.tmp'
    writeFileSync(temp, JSON.stringify(entry), { mode: 0o600 })
    const fd = openSync(temp, 'r')
    try { fsyncSync(fd) } finally { closeSync(fd) }
    renameSync(temp, path)
    const dir = openSync(control, 'r')
    try { fsyncSync(dir) } finally { closeSync(dir) }
  }
  for (const name of readdirSync(control).filter(n => /^message-[a-f0-9]{64}\.json$/.test(n))) {
    const entry = JSON.parse(readFileSync(join(control, name), 'utf8'))
    // The server offers correlation, not a documented idempotency guarantee.
    if (['received', 'pending'].includes(entry.outcome.status)) {
      entry.outcome.status = 'unknown'
      entry.outcome.reason = 'runner restarted before durable acknowledgment; no retry'
      persist(entry)
    }
    operations.set(entry.outcome.messageId, entry)
  }
  const publish = entry => {
    persist(entry)
    emit({ type: 'codexmod.steer', ...entry.outcome })
  }
  const submit = async body => {
    if (typeof body.messageId !== 'string' || !body.messageId || body.messageId.length > 512 || typeof body.text !== 'string' || body.text.length > 1000000) throw new Error('invalid message request')
    const identity = JSON.stringify([body.text, body.threadId ?? null, body.expectedTurnId ?? null, body.runId ?? null])
    const previous = operations.get(body.messageId)
    if (previous) {
      if (previous.identity !== identity) throw new Error('conflicting message ID')
      return previous
    }
    const target = destination(body)
    const outcome = { id: body.id ?? body.messageId, messageId: body.messageId, sourceUuid: body.sourceUuid,
      senderToolUseId: body.senderToolUseId, brokerGeneration: generation, sessionId: body.sessionId, agentId: body.agentId,
      runId: body.runId ?? control, threadId: target?.id ?? body.threadId, expectedTurnId: body.expectedTurnId ?? target?.turnId,
      status: 'received', receivedAt: Date.now() }
    const entry = { identity, outcome }
    // Persist intent before even scheduling the RPC. A crash here is uncertain.
    persist(entry)
    operations.set(body.messageId, entry)
    entry.done = (async () => {
      if (!target || target.done || !target.turnId || outcome.expectedTurnId !== target.turnId) {
        outcome.status = 'rejected'; outcome.reason = 'source turn stale or idle; no turn started'
        outcome.acknowledgedAt = Date.now(); publish(entry); return
      }
      outcome.status = 'pending'; outcome.submittedAt = Date.now()
      try {
        const reply = await dispatch({ threadId: target.id, expectedTurnId: outcome.expectedTurnId,
          clientUserMessageId: body.messageId, input: [{ type: 'text', text: body.text, text_elements: [] }] }, id => {
          outcome.rpcRequestId = id
          persist(entry)
        })
        outcome.status = reply?.turnId === outcome.expectedTurnId ? 'accepted' : 'unknown'
        if (outcome.status === 'accepted') { outcome.turnId = reply.turnId; outcome.acceptedTurnId = reply.turnId; if (outcome.echoedItemId) outcome.status = 'observed' }
        else outcome.reason = 'steer acknowledgement did not match the source turn'
      } catch (error) {
        outcome.status = error?.transport === true ? 'unknown' : 'rejected'
        outcome.error = error
        outcome.reason = String(error?.message ?? 'turn/steer failed')
      }
      outcome.acknowledgedAt = Date.now()
      publish(entry)
    })().catch(() => {
      // An ack that could not be journaled must never escape as accepted.
      outcome.status = 'unknown'; outcome.reason = 'outcome journal unavailable; no retry'
      emit({ type: 'codexmod.steer', ...outcome })
    })
    return entry
  }
  const observe = (threadId, turnId, item) => {
    if (item?.type !== 'userMessage' || typeof item.clientId !== 'string') return
    const entry = operations.get(item.clientId)
    const o = entry?.outcome
    if (!o || o.threadId !== threadId || o.expectedTurnId !== turnId || o.echoedItemId) return
    o.echoedItemId = item.id
    if (o.status === 'accepted') o.status = 'observed'
    publish(entry)
  }
  let server
  const socketPath = join(control, 'c.sock')
  const descriptor = { version: CONTROL_VERSION, generation, runId: control, channel: 'file' }
  const listen = async () => {
    try {
      if (Buffer.byteLength(socketPath) > 100) throw new Error('socket path exceeds portable limit')
      server = createServer(async (req, res) => {
        const respond = (status, body) => {
          if (res.destroyed || res.writableEnded) return
          let text = JSON.stringify(body)
          if (Buffer.byteLength(text) > 1000000) { status = 413; text = JSON.stringify({ error: 'control response too large; full outcome retained in journal' }) }
          res.writeHead(status, { 'content-type': 'application/json' }); res.end(text)
        }
        try {
          if (req.method === 'GET' && req.url === '/health') return respond(200, { ...descriptor, threadId: destination({})?.id, turnId: destination({})?.turnId })
          if (req.headers['x-codex-generation'] !== generation) return respond(409, { error: 'stale runner generation' })
          if (req.method === 'GET' && req.url.startsWith('/messages/')) {
            const o = operations.get(decodeURIComponent(req.url.slice(10)))?.outcome
            return respond(o ? 200 : 404, o ?? { error: 'unknown message ID' })
          }
          const chunks = []
          let bytes = 0
          for await (const chunk of req) {
            bytes += chunk.length
            if (bytes > 1100000) { respond(413, { error: 'request too large' }); return }
            chunks.push(chunk)
          }
          const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
          if (body.runId !== control) return respond(409, { error: 'stale run identity' })
          if (req.method === 'POST' && req.url === '/interrupt') { await interrupt(body); return respond(200, { status: 'requested' }) }
          if (req.method !== 'POST' || req.url !== '/messages') return respond(404, { error: 'unknown endpoint' })
          const entry = await submit(body)
          await Promise.race([entry.done, new Promise(resolve => setTimeout(resolve, waitMs))])
          respond(200, entry.outcome)
        } catch (error) { respond(409, { error: String(error?.message ?? error) }) }
      })
      server.requestTimeout = 2000
      server.headersTimeout = 2000
      await new Promise((resolve, reject) => { server.once('error', reject); server.listen(socketPath, resolve) })
      chmodSync(socketPath, 0o600)
      descriptor.channel = 'unix'; descriptor.socketPath = socketPath
    } catch {
      server?.close(); server = undefined
      descriptor.reason = 'private Unix socket unavailable; negotiated file controls'
    }
    writeFileSync(join(control, 'control.json'), JSON.stringify(descriptor), { mode: 0o600 })
    return descriptor
  }
  return { submit, observe, listen, get: id => operations.get(id)?.outcome,
    close() { server?.closeAllConnections(); server?.close(); try { unlinkSync(socketPath) } catch {} } }
}
