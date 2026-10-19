import type { EngineInterface } from 'claude-code'
import { messageStatus } from './steer-control-text.mjs'
export { messageStatus }

import type { CodexModMessageOutcome as MessageOutcome } from './steer-contract.d.ts'
export type { CodexModMessageOutcome as MessageOutcome } from './steer-contract.d.ts'
type Channel = { channel: 'unix' | 'file'; generation?: string; runId: string; socketPath?: string }
const channels = new Map<string, Promise<Channel>>()

/** Negotiate before submitting anything. Only a failed health probe permits
 * file fallback; a failed POST has an uncertain outcome and cannot switch. */
async function channel($: EngineInterface, control: string): Promise<Channel> {
  let pending = channels.get(control)
  if (!pending) {
    pending = (async () => {
      try {
        const d = JSON.parse(String(await $.fs.read(`${control}/control.json`)))
        if (d.version !== 2 || d.runId !== control || d.channel !== 'unix' || typeof d.socketPath !== 'string') throw new Error('file controls')
        const r = await $.http.fetch('http://codex-mod/health', { socketPath: d.socketPath })
        const h = JSON.parse(r.text)
        if (!r.ok || h.version !== 2 || h.generation !== d.generation || h.runId !== control) throw new Error('health mismatch')
        $.ui.log('codex-mod: steer v2 channel=unix protocol=2', { to: 'debug' })
        return d as Channel
      } catch {
        $.ui.log('codex-mod: steer v2 channel=file (Unix health unavailable)', { to: 'debug' })
        return { channel: 'file' as const, runId: control }
      }
    })()
    channels.set(control, pending)
  }
  return pending
}
export async function controlRequest($: EngineInterface, control: string, path: '/messages' | '/interrupt', body: Record<string, unknown>, file: string): Promise<MessageOutcome | undefined> {
  const c = await channel($, control)
  if (c.channel === 'file') {
    // A partial file is retried by the runner; its journal deduplicates replays.
    await $.fs.write(`${control}/${file}`, JSON.stringify(body))
    return
  }
  const response = await $.http.fetch(`http://codex-mod${path}`, { socketPath: c.socketPath, method: 'POST',
    headers: { 'content-type': 'application/json', 'x-codex-generation': c.generation! }, body: JSON.stringify({ ...body, runId: control }) })
  if (!response.ok) throw new Error(`control request refused (${response.status}); no fallback`)
  if (path === '/messages') return JSON.parse(response.text)
}
export async function queryOutcome($: EngineInterface, control: string, messageId: string): Promise<MessageOutcome | undefined> {
  const c = await channel($, control)
  if (c.channel !== 'unix') return
  const r = await $.http.fetch(`http://codex-mod/messages/${encodeURIComponent(messageId)}`, { socketPath: c.socketPath,
    headers: { 'x-codex-generation': c.generation! } })
  return r.ok ? JSON.parse(r.text) : undefined
}
export async function publishOutcome($: EngineInterface, outcome: MessageOutcome): Promise<void> {
  await $.state.set({ plugin: 'codex-mod', key: 'messageStatus', id: outcome.messageId }, outcome).catch(() => undefined)
  $.ui.invalidate('ui.render')
  $.ui.log(`codex-mod: steer v2 message=${outcome.messageId} status=${outcome.status}${outcome.acceptedTurnId ? ` turn=${outcome.acceptedTurnId}` : ''}`, { to: 'debug' })
}
