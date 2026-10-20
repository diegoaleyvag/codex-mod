import type { EngineInterface } from 'claude-code'
import { fingerprint } from './fingerprint.ts'

// The host limits the whole plugin store to 4 Mi characters. Payloads belong
// in the private run cache; store entries are only bounded recovery metadata.
export const RECORD_BUDGET = 32 * 1024
export const FIELD_BUDGET = 2048
export const DEDUP_LIMIT = 128
// Even four-byte UTF-8 text and JSON escapes stay below the host's 4 MiB I/O cap.
export const CACHE_CHUNK = 256 * 1024
type State = Record<string, any>
const size = (v: unknown) => JSON.stringify(v)?.length ?? 0
const payloads = new Set(['wire', 'display', 'followUps'])
const sameFields = (a: State, b: State) => Object.keys(a).every(k => JSON.stringify(a[k]) === JSON.stringify(b[k]))
const pendingMigrations = new Map<string, State>()
const writing = new Map<string, Promise<boolean>>()

async function orderedWrite(key: string, operation: () => Promise<boolean>): Promise<boolean> {
  const previous = writing.get(key)
  const current = (async () => {
    await previous
    return operation()
  })()
  writing.set(key, current)
  try {
    return await current
  } finally {
    if (writing.get(key) === current) writing.delete(key)
  }
}

export function compactStoreState(value: State): State {
  const out: State = {}
  for (const [key, value0] of Object.entries(value)) {
    if (key === 'cachedState' || payloads.has(key)) continue
    let v = value0
    if (key === 'coordinator') {
      v = { received: (v?.received ?? []).slice(-DEDUP_LIMIT).filter((id: unknown) => typeof id === 'string' && id.length <= 128), pending: [] }
      while (size(v) > FIELD_BUDGET) v.received.shift()
    } else if (key === 'playback') v = Object.fromEntries(['segment', 'cursor', 'prefix', 'actions', 'usage', 'usageCanonical', 'usagePartial', 'turnId'].filter(k => v?.[k] !== undefined).map(k => [k, v[k]]))
    else if (key === 'mirror') v = compactStoreState(v)
    else if (Array.isArray(v)) v = v.slice(-DEDUP_LIMIT)
    if (v !== undefined && size(v) <= FIELD_BUDGET) out[key] = v
  }
  for (const key of ['lastTask', 'launchKey', 'capacityRetryKey']) {
    if (typeof value[key] === 'string') out[`${key}Fingerprint`] = fingerprint(value[key])
  }
  if (typeof value.guardTrip?.key === 'string') {
    out.guardTrip ??= { reason: value.guardTrip.reason }
    out.guardTripKeyFingerprint = fingerprint(value.guardTrip.key)
  }
  // A total guard is necessary even when every individual field is small.
  // Required identity/guard fields go first; optional snapshots are expendable.
  const required = ['executionFingerprint', 'historyArchived', 'historyAmbiguous', 'model', 'effort', 'sandbox', 'agentName', 'thread', 'updatedAt', 'version', 'session', 'parentHost', 'parentThread', 'control', 'generation', 'token', 'depth', 'launch', 'state', 'host', 'handedBack', 'handback', 'handbackLock', 'userCount', 'launchesSinceNew', 'runSeq', 'lastTaskFingerprint', 'launchKeyFingerprint', 'capacityRetryKeyFingerprint', 'guardTripKeyFingerprint', 'guardTrip', 'launches', 'recoveryUnavailable']
  const bounded: State = {}
  for (const key of [...required, ...Object.keys(out).filter(k => !required.includes(k))]) {
    if (out[key] !== undefined && size({ ...bounded, [key]: out[key], cachedState: true, recoveryUnavailable: true, cacheFingerprint: { length: 0, sha256: '0'.repeat(64) } }) <= RECORD_BUDGET) bounded[key] = out[key]
  }
  return bounded
}

/** Publish the manifest last. A partial chunk write cannot become a checkpoint. */
export async function writeCachePayload($: EngineInterface, path: string, body: string): Promise<void> {
  if (body.length <= CACHE_CHUNK) return $.fs.write(path, body)
  const identity = fingerprint(body)
  const chunks = Math.ceil(body.length / CACHE_CHUNK)
  for (let i = 0; i < chunks; i++) {
    // JSON strings preserve a surrogate pair split at a chunk boundary.
    await $.fs.write(`${path}.${i}`, JSON.stringify(body.slice(i * CACHE_CHUNK, (i + 1) * CACHE_CHUNK)))
  }
  await $.fs.write(path, JSON.stringify({ chunked: 1, chunks, ...identity }))
}

export async function readCachePayload($: EngineInterface, path: string): Promise<any> {
  const manifest = JSON.parse(String(await $.fs.read(path)))
  if (manifest?.chunked !== 1) return manifest
  if (!Number.isSafeInteger(manifest.chunks) || manifest.chunks < 1 || manifest.chunks !== Math.ceil(manifest.length / CACHE_CHUNK)) throw new Error('invalid state manifest')
  const parts: string[] = []
  for (let i = 0; i < manifest.chunks; i++) {
    const part = JSON.parse(String(await $.fs.read(`${path}.${i}`)))
    if (typeof part !== 'string' || part.length > CACHE_CHUNK) throw new Error('invalid state chunk')
    parts.push(part)
  }
  const body = parts.join('')
  const identity = fingerprint(body)
  if (identity.length !== manifest.length || identity.sha256 !== manifest.sha256) throw new Error('state chunks do not match checkpoint')
  return JSON.parse(body)
}

async function statePath($: EngineInterface, key: string): Promise<string> {
  const home = (await $.env.get('HOME')) ?? ''
  const cache = (await $.env.get('XDG_CACHE_HOME')) || `${home}/.cache`
  return `${cache.replace(/\/$/, '')}/codex-mod/runs/state-${encodeURIComponent(key)}/record.json`
}

/** Never let persistence interrupt execution or the final handback. */
export async function writeStoreState($: EngineInterface, key: string, value: State, legacySize = 0): Promise<boolean> {
  // A receipt and a step can checkpoint the same agent concurrently. Keep
  // the recovery file and its store metadata in the same write order.
  return orderedWrite(key, () => persistState($, key, value, legacySize))
}

async function persistState($: EngineInterface, key: string, value: State, legacySize: number): Promise<boolean> {
  try {
    if (value.coordinator) {
      value.coordinator.received = value.coordinator.received.slice(-DEDUP_LIMIT)
      if (value.coordinator.rows) value.coordinator.rows = Object.fromEntries(Object.entries(value.coordinator.rows).slice(-DEDUP_LIMIT))
    }
    const compact = compactStoreState(value)
    const snapshot = { ...value }
    delete snapshot.cachedState
    delete snapshot.cacheFingerprint
    const body = JSON.stringify(snapshot)
    let cached = false
    const needsCache = !sameFields(snapshot, compact)
    if (needsCache) {
      $.ui.log(`codex-mod: compacting store record ${key} (${body.length} -> ${size(compact)} characters; budget ${RECORD_BUDGET})`, { to: 'debug' })
      try {
        const path = await statePath($, key)
        const dir = path.slice(0, path.lastIndexOf('/'))
        await $.process.run(['mkdir', '-p', '-m', '700', dir], { timeoutMs: 10000 })
        await writeCachePayload($, path, body)
        compact.cachedState = true
        compact.cacheFingerprint = fingerprint(body)
        cached = true
      } catch (err) {
        $.ui.log(`codex-mod: state cache write failed: ${String(err)}`, { to: 'debug' })
      }
    }
    if (needsCache && !cached) compact.recoveryUnavailable = true
    if (size(compact) > RECORD_BUDGET) throw new Error('compact record exceeds budget')
    try {
      await $.store.set(key, compact)
    } catch (err) {
      // An already oversized store may reject even a shrinking replacement.
      // Only remove legacy payloads after their complete recovery file exists.
      if (!cached || legacySize <= size(compact)) throw err
      await $.store.delete(key)
      pendingMigrations.set(key, compact)
      await $.store.set(key, compact)
    }
    pendingMigrations.delete(key)
    return !needsCache || cached
  } catch (err) {
    $.ui.log(`codex-mod: store write failed for ${key}: ${String(err)}`, { to: 'debug' })
    return false
  }
}

/** Retry removed legacy entries after the rest of pruning has freed space. */
export async function flushStoreMigrations($: EngineInterface): Promise<void> {
  for (const key of pendingMigrations.keys()) {
    await orderedWrite(key, async () => {
      try {
        const compact = pendingMigrations.get(key)
        if (!compact) return true
        if (size(compact) > RECORD_BUDGET) throw new Error('compact record exceeds budget')
        await $.store.set(key, compact)
        pendingMigrations.delete(key)
        return true
      } catch (err) {
        $.ui.log(`codex-mod: store migration retry failed for ${key}: ${String(err)}`, { to: 'debug' })
        return false
      }
    })
  }
}

/** Restore data only, never guard capabilities or executable held answers. */
export async function readStoreState($: EngineInterface, key: string, value: State): Promise<State> {
  if (value.cachedState) {
    try {
      const saved = await readCachePayload($, await statePath($, key))
      if (value.cacheFingerprint && JSON.stringify(fingerprint(JSON.stringify(saved))) !== JSON.stringify(value.cacheFingerprint)) throw new Error('state checkpoint fingerprint does not match store metadata')
      if (saved && typeof saved === 'object' && saved.updatedAt === value.updatedAt) return saved
      throw new Error('state checkpoint does not match store metadata')
    } catch (err) {
      $.ui.log(`codex-mod: state cache read failed for ${key}: ${String(err)}`, { to: 'debug' })
      return { ...value, recoveryUnavailable: true }
    }
  } else if (JSON.stringify(value) !== JSON.stringify(compactStoreState(value))) {
    await writeStoreState($, key, value, size(value))
  }
  if (!value.lastTask && !value.lastTaskFingerprint && !value.launchKey && !value.launchKeyFingerprint && value.userCount > 0) return { ...value, recoveryUnavailable: true }
  return value
}
