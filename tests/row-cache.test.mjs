import test from 'node:test'
import assert from 'node:assert/strict'
import { RowCache, ROW_LIMIT, ROW_SLOTS, ROW_BYTES, saveRow, loadRow } from '../hooks/row-cache.ts'
import { journalLine, journalPath, journalIndex } from '../hooks/child-journal.mjs'

test('presentation LRU stays bounded across many rows and runs and touches recent entries', async () => {
  const rows = new RowCache()
  const files = new Map()
  const $ = {
    env: { get: async name => name === 'HOME' ? '/cache-test' : undefined },
    process: { run: async () => ({ code: 0 }) },
    fs: { write: async (path, body) => { assert.ok(Buffer.byteLength(body) <= ROW_BYTES); files.set(path, body) }, read: async path => files.get(path) },
    ui: { log: () => {} },
  }
  for (let run = 0; run < 30; run++) {
    for (let i = 0; i < ROW_LIMIT * 2; i++) {
      const id = `${run}:${i}`
      const row = { sessionId: 's', agentId: `a${run}`, tool: 'codex_tool', sourceDigest: 'a'.repeat(64), label: 'Codex web.open' }
      rows.set(id, row)
      await saveRow($, id, row, { steps: ['original plan'] })
      assert.ok(rows.size <= ROW_LIMIT)
    }
    // A completed/killed run releases its in-memory presentation entries.
    for (const [id, row] of rows) if (row.agentId === `a${run}`) rows.delete(id)
    assert.equal(rows.size, 0)
  }
  assert.ok(files.size <= ROW_SLOTS + 1)
  const id = '29:255'
  assert.equal((await loadRow($, id, 's')).row.label, 'Codex web.open')
  assert.deepEqual((await loadRow($, id, 's')).plan.steps, ['original plan'])
  assert.equal(await loadRow($, id, 'foreign-session'), undefined)
  for (let i = 0; i < ROW_LIMIT; i++) rows.set(String(i), { label: 'small' })
  rows.get('0')
  rows.set('new', {})
  assert.ok(rows.has('0'))
  assert.equal(rows.has('1'), false)
})

test('journal I/O failures back off without changing the cursor and are distinct from truncation', async () => {
  const line = JSON.stringify({ type: 'turn.completed', thread_id: 'child' }) + '\n'
  const files = new Map([[journalPath('/run', 'child'), line], [journalIndex('/run', 'child'), '{"segment":0}']])
  const sleeps = []
  let failures = 2
  const $ = { fs: { exists: async path => files.has(path), read: async path => {
    if (path.endsWith('.jsonl') && failures-- > 0) throw new Error('host read limit or transient I/O')
    return files.get(path)
  } }, clock: { sleep: async ms => { sleeps.push(ms) } } }
  const cursor = { segment: 0, cursor: 0, prefix: '' }
  assert.equal((await journalLine($, '/run', 'child', cursor)).line, line.trim())
  assert.deepEqual(sleeps, [50, 100])
  assert.deepEqual(cursor, { segment: 0, cursor: 0, prefix: '' })
  failures = 9
  await assert.rejects(journalLine($, '/run', 'child', cursor), /child journal read failed after 3 attempts/)
  failures = 0
  await assert.rejects(journalLine($, '/run', 'child', { ...cursor, cursor: 999 }), /truncated or replaced/)
})
