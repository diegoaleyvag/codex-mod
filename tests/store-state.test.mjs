import test from 'node:test'
import assert from 'node:assert/strict'
import { compactStoreState, readStoreState, writeStoreState, flushStoreMigrations, RECORD_BUDGET, FIELD_BUDGET, DEDUP_LIMIT } from '../hooks/store-state.ts'

const record = () => ({ model: 'gpt-6.1-sol', effort: 'medium', sandbox: 'workspace-write', agentName: 'codex', thread: 'resume-me', updatedAt: 100 })
function host({ limit = Infinity, reject = false, diskFails = false } = {}) {
  const store = new Map()
  const files = new Map()
  const logs = []
  const writes = []
  const $ = {
    env: { get: async name => name === 'HOME' ? '/private/cache-test' : undefined },
    ui: { log: text => logs.push(text) },
    process: { run: async () => ({ code: 0 }) },
    fs: {
      write: async (path, body) => { if (diskFails) throw new Error('disk full'); files.set(path, body) },
      read: async path => { if (!files.has(path)) throw new Error('missing cache'); return files.get(path) },
    },
    store: {
      set: async (key, value) => {
        assert.ok(JSON.stringify(value).length <= RECORD_BUDGET)
        assert.equal(value.wire, undefined)
        writes.push({ key, value })
        if (reject || JSON.stringify(Object.fromEntries(new Map([...store, [key, value]]))).length > limit) throw new Error('host store limit')
        store.set(key, structuredClone(value))
      },
      delete: async key => { store.delete(key) },
    },
  }
  return { $, store, files, logs, writes }
}

test('load migrates 900 KB legacy wire and oversized unknown fields; full source survives outside store', async () => {
  const h = host()
  const old = { ...record(), wire: { records: [{ event: 'completed', data: 'x'.repeat(900_000) }], rows: {} }, legacyBody: 'y'.repeat(10_000) }
  h.store.set('agent:s:a', old)
  const loaded = await readStoreState(h.$, 'agent:s:a', old)
  assert.equal(loaded.wire.records[0].data.length, 900_000)
  const metadata = h.store.get('agent:s:a')
  assert.equal(metadata.wire, undefined)
  assert.equal(metadata.legacyBody, undefined)
  assert.equal(metadata.thread, 'resume-me')
  assert.equal((await readStoreState(h.$, 'agent:s:a', metadata)).legacyBody.length, 10_000)
})

test('saving excludes wire regardless of its size and preserves replay cursors and source dedup', async () => {
  const h = host()
  const value = { ...record(), wire: { records: [{ event: 'completed', item: { id: 'one', output: 'x'.repeat(900_000) } }], rows: {} },
    playback: { cursor: 1234, prefix: 'journal-tail', actions: 10, texts: ['final answer'], queue: [{ kind: 'action', action: { source: 'body' } }] } }
  assert.equal(await writeStoreState(h.$, 'agent:s:a', value), true)
  const metadata = h.store.get('agent:s:a')
  assert.deepEqual(metadata.playback, { cursor: 1234, prefix: 'journal-tail', actions: 10 })
  const restored = await readStoreState(h.$, 'agent:s:a', metadata)
  assert.deepEqual(restored, value)
  assert.equal(h.writes.length, 1)
})

test('nested identities, launch input, coordinator sets, bodies and replay queues remain bounded', async () => {
  const h = host()
  const mirror = { version: 1, session: 's', thread: 'child', parentHost: 'parent', control: '/runs/one', generation: 'g', token: 'capability', depth: 2, updatedAt: 100, inputDigest: 'prompt'.repeat(100_000) }
  const received = Array.from({ length: 5000 }, (_, i) => `source-${i}`)
  const value = { ...record(), mirror, coordinator: { received, pending: [{ uuid: 'latest', text: 'x'.repeat(900_000) }], rows: Object.fromEntries(received.map(id => [id, { text: 'body' }])) },
    display: { children: Object.fromEntries(received.map(id => [id, { message: 'body' }])) },
    playback: { cursor: 4567, prefix: 'tail', actions: 12, texts: ['x'.repeat(900_000)], queue: received.map(text => ({ kind: 'text', text })) } }
  assert.equal(await writeStoreState(h.$, 'agent:s:a', value), true)
  assert.equal(await writeStoreState(h.$, 'mirror:s:child', mirror), true)
  const metadata = h.store.get('agent:s:a')
  assert.equal(metadata.display, undefined)
  assert.deepEqual(metadata.coordinator.pending, [])
  assert.ok(metadata.coordinator.received.length <= DEDUP_LIMIT)
  assert.ok(JSON.stringify(metadata.coordinator).length <= FIELD_BUDGET)
  assert.equal(metadata.coordinator.received.at(-1), 'source-4999')
  assert.equal(h.store.get('mirror:s:child').inputDigest, undefined)
  const restored = await readStoreState(h.$, 'agent:s:a', metadata)
  assert.equal(restored.mirror.inputDigest, mirror.inputDigest)
  assert.equal(restored.coordinator.received.length, DEDUP_LIMIT)
  assert.equal(Object.keys(restored.coordinator.rows).length, DEDUP_LIMIT)
  assert.equal(restored.playback.queue.length, 5000)
})

test('total serialized budget applies when many individual fields are below their budget', () => {
  const value = { ...record(), ...Object.fromEntries(Array.from({ length: 1000 }, (_, i) => [`field${i}`, 'x'.repeat(2000)])) }
  const compact = compactStoreState(value)
  assert.ok(JSON.stringify({ ...compact, cachedState: true }).length <= RECORD_BUDGET)
  assert.equal(compact.thread, 'resume-me')
})

test('rejected writes return normally, log debug, and retain source state in cache', async () => {
  const h = host({ reject: true })
  assert.equal(await writeStoreState(h.$, 'agent:s:a', { ...record(), wire: { records: ['source'], rows: {} } }), false)
  assert.ok(h.logs.some(line => line.includes('store write failed')))
  assert.equal(h.files.size, 1)
})

test('an already oversized store can be compacted without losing temporarily removed records', async () => {
  const h = host({ limit: 1_000_000 })
  for (const key of ['a', 'b', 'c']) h.store.set(key, { ...record(), wire: { records: ['x'.repeat(900_000)], rows: {} } })
  for (const [key, value] of [...h.store]) await writeStoreState(h.$, key, value, JSON.stringify(value).length)
  await flushStoreMigrations(h.$)
  assert.equal(h.store.size, 3)
  for (const [key, metadata] of h.store) {
    assert.equal(metadata.wire, undefined)
    assert.equal((await readStoreState(h.$, key, metadata)).wire.records[0].length, 900_000)
  }
})

test('cache write failures still permit bounded metadata writes', async () => {
  const h = host({ diskFails: true })
  assert.equal(await writeStoreState(h.$, 'agent:s:a', { ...record(), wire: { records: ['x'.repeat(900_000)] } }), true)
  assert.equal(h.store.get('agent:s:a').cachedState, undefined)
  assert.ok(h.logs.some(line => line.includes('state cache write failed')))
})

test('small handback memos need no cache file or cache marker', async () => {
  const h = host()
  const memo = { handbackLock: 'text', updatedAt: 100 }
  assert.equal(await writeStoreState(h.$, 'session:s:handback', memo), true)
  assert.deepEqual(h.store.get('session:s:handback'), memo)
  assert.equal(h.files.size, 0)
})

test('concurrent checkpoints serialize file and metadata writes for an agent', async () => {
  const h = host()
  let release
  let entered
  const blocked = new Promise(resolve => { release = resolve })
  const started = new Promise(resolve => { entered = resolve })
  const write = h.$.fs.write
  let first = true
  h.$.fs.write = async (...args) => {
    if (first) { first = false; entered(); await blocked }
    await write(...args)
  }
  const old = writeStoreState(h.$, 'agent:s:a', { ...record(), lastAnswer: 'old'.repeat(1000) })
  await started
  const latest = { ...record(), updatedAt: 101, lastAnswer: 'new'.repeat(1000) }
  const next = writeStoreState(h.$, 'agent:s:a', latest)
  release()
  assert.deepEqual(await Promise.all([old, next]), [true, true])
  assert.deepEqual(await readStoreState(h.$, 'agent:s:a', h.store.get('agent:s:a')), latest)
})
