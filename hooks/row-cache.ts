import type { EngineInterface } from 'claude-code'
import { fingerprint } from './fingerprint.ts'

export const ROW_LIMIT = 128
export const ROW_SLOTS = 512
export const ROW_BYTES = 256 * 1024

/** Touch on reads as well as writes; payload caches cannot grow with history. */
export class RowCache<T> extends Map<string, T> {
  get(key: string): T | undefined {
    const value = super.get(key)
    if (value !== undefined) {
      super.delete(key)
      super.set(key, value)
    }
    return value
  }
  set(key: string, value: T): this {
    super.delete(key)
    super.set(key, value)
    while (this.size > ROW_LIMIT) super.delete(this.keys().next().value!)
    return this
  }
}

export type RowPresentation = {
  sessionId: string; agentId: string; tool: string; sourceDigest: string
  label?: string; childThread?: string; model?: string; effort?: string
}
async function location($: EngineInterface, id: string): Promise<string> {
  const cache = (await $.env.get('XDG_CACHE_HOME')) || `${await $.env.get('HOME')}/.cache`
  const slot = parseInt(fingerprint(id).sha256.slice(0, 8), 16) % ROW_SLOTS
  return `${cache.replace(/\/$/, '')}/codex-mod/runs/state-row-cache/row-${slot}.json`
}

// Fixed slots bound disk use too. A collision loses presentation only; it
// never supplies a tool answer or grants an executor capability.
export async function saveRow($: EngineInterface, id: string, row: RowPresentation, plan?: unknown): Promise<void> {
  try {
    const path = await location($, id)
    await $.process.run(['mkdir', '-p', '-m', '700', path.slice(0, path.lastIndexOf('/'))], { timeoutMs: 10000 })
    let body = JSON.stringify({ id, row, plan })
    if (body.length > ROW_BYTES / 4) body = JSON.stringify({ id, row })
    await $.fs.write(path, body)
    // The normal run-cache pruner uses this file's mtime, including when a
    // fixed slot is overwritten without changing the directory's mtime.
    await $.fs.write(path.slice(0, path.lastIndexOf('/')) + '/record.json', '{}')
  } catch (err) {
    $.ui.log(`codex-mod: row presentation cache unavailable: ${String(err)}`, { to: 'debug' })
  }
}

export async function loadRow($: EngineInterface, id: string, sid: string): Promise<{ row: RowPresentation; plan?: any } | undefined> {
  try {
    const body = await $.fs.read(await location($, id))
    if (typeof body !== 'string' || body.length > ROW_BYTES / 4) return
    const saved = JSON.parse(body)
    if (saved.id === id && saved.row?.sessionId === sid) return saved
  } catch {
    // History retains the host's native rendering when its slot has expired.
  }
}
