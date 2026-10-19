// Shared names and bounded readers; this module also runs in the hooks worker.
export const JOURNAL_BYTES = 1024 * 1024
export const journalPath = (control, thread, segment = 0) => `${control}/events-${thread}${segment ? `-${segment}` : ''}.jsonl`
export const journalIndex = (control, thread) => `${control}/events-${thread}.index.json`
const missing = err => /ENOENT|not found|no such file/i.test(String(err))

export async function journalRead($, path, optional = false) {
  for (let attempt = 0; ; attempt++) {
    try {
      if (optional && !await $.fs.exists(path)) return undefined
      const value = await $.fs.read(path)
      if (typeof value !== 'string') throw new Error('expected journal text')
      return value
    } catch (err) {
      if (optional && missing(err)) return undefined
      if (attempt === 2) throw new Error(`child journal read failed after 3 attempts: ${String(err)}; no relaunch`)
      await $.clock.sleep(50 * (attempt + 1))
    }
  }
}

/** Read one complete line across immutable segments, keeping only one segment
 * resident per read. A failed read never changes the caller's committed cursor. */
export async function journalLine($, control, thread, position) {
  const indexText = await journalRead($, journalIndex(control, thread), true)
  const index = indexText === undefined ? { segment: 0 } : JSON.parse(indexText)
  if (!Number.isSafeInteger(index.segment) || index.segment < position.segment) throw new Error('child journal truncated or replaced; no relaunch')
  let { segment, cursor, prefix } = position
  const parts = []
  for (;;) {
    const text = await journalRead($, journalPath(control, thread, segment))
    if (text.length < cursor || cursor && text.slice(Math.max(0, cursor - 160), cursor) !== prefix) throw new Error('child journal truncated or replaced; no relaunch')
    const nl = text.indexOf('\n', cursor)
    if (nl >= 0) return { line: [...parts, text.slice(cursor, nl)].join(''), segment, cursor: nl + 1, prefix: text.slice(Math.max(0, nl + 1 - 160), nl + 1) }
    parts.push(text.slice(cursor))
    if (segment === index.segment) return undefined
    segment++
    cursor = 0
    prefix = ''
  }
}
