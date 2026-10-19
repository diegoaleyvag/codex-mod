import type { Action, FileChange } from './codex.ts'

// R1 Bash/Edit/Write contracts; source grammar is unified per-file diffs (R2).
export type Hunk = { oldStart: number; oldLines: number; newStart: number; newLines: number; lines: string[] }
type ParsedHunk = { hunk: Hunk; old: string[]; next: string[] }
export const PATCH_TEXT_MAX = 100000
const quote = (s: string) => `'${s.replace(/\r/g, '\\r').replace(/\n/g, '\\n').replace(/'/g, `'\\''`)}'`
const text = (s: string | undefined): s is string => s !== undefined && !s.includes('\0') && !s.includes('\ufffd')
const fileLines = (s: string): string[] => s.match(/[^\n]*\n|[^\n]+$/g) ?? []

/** Keep payload CRs and EOF markers: splitting/trimEnd would change file bytes. */
export function parsePatch(diff: string, kind: string): ParsedHunk[] | undefined {
  if (diff.includes('\0') || diff.includes('\ufffd') || (!diff.endsWith('\n') && !diff.endsWith('\\ No newline at end of file'))) return undefined
  const lines = diff.split('\n')
  if (lines.at(-1) === '') lines.pop()
  if (!lines.length) return undefined
  const parsed: ParsedHunk[] = []
  let current: ParsedHunk | undefined
  let previous = ''
  const raw = !lines.some(l => l.startsWith('@@')) && ['add', 'delete'].includes(kind)
  if (raw) {
    current = { hunk: { oldStart: kind === 'add' ? 0 : 1, oldLines: 0, newStart: kind === 'add' ? 1 : 0, newLines: 0, lines: [] }, old: [], next: [] }
    parsed.push(current)
  }
  for (const line of lines) {
    const header = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@[^\r\n]*\r?$/.exec(line)
    if (header) {
      current = { hunk: { oldStart: Number(header[1]), oldLines: Number(header[2] ?? 1), newStart: Number(header[3]), newLines: Number(header[4] ?? 1), lines: [] }, old: [], next: [] }
      parsed.push(current)
      previous = ''
    } else if (!current && /^(diff --git |index |--- |\+\+\+ |new file mode |deleted file mode |old mode |new mode )/.test(line)) {
      continue
    } else if (current && line === '\\ No newline at end of file') {
      if (!previous) return undefined
      if (' -'.includes(previous)) current.old[current.old.length - 1] = current.old.at(-1)!.slice(0, -1)
      if (' +'.includes(previous)) current.next[current.next.length - 1] = current.next.at(-1)!.slice(0, -1)
      current.hunk.lines.push(line)
      previous = ''
    } else if (current && /^[ +\-]/.test(line)) {
      const prefix = line[0]!
      if (raw && prefix !== (kind === 'add' ? '+' : '-')) return undefined
      const payload = line.slice(1) + '\n'
      if (prefix !== '+') current.old.push(payload)
      if (prefix !== '-') current.next.push(payload)
      current.hunk.lines.push(line)
      previous = prefix
    } else return undefined
  }
  if (raw && current) {
    current.hunk.oldLines = current.old.length
    current.hunk.newLines = current.next.length
  }
  if (!parsed.length || parsed.some(p => p.old.length !== p.hunk.oldLines || p.next.length !== p.hunk.newLines ||
    (kind === 'add' && p.old.length !== 0) || (kind === 'delete' && p.next.length !== 0) ||
    ![p.hunk.oldStart, p.hunk.oldLines, p.hunk.newStart, p.hunk.newLines].every(Number.isSafeInteger))) return undefined
  return parsed
}

/** Reject offsets, fuzzy matches, overlapping hunks and nonterminal EOF markers. */
function apply(before: string, parsed: ParsedHunk[]): string | undefined {
  const lines = fileLines(before)
  const out: string[] = []
  let cursor = 0
  let delta = 0
  for (const p of parsed) {
    const start = p.hunk.oldStart - (p.hunk.oldLines ? 1 : 0)
    const nextStart = p.hunk.newStart - (p.hunk.newLines ? 1 : 0)
    if (start < cursor || start > lines.length || nextStart !== start + delta ||
      p.old.join('') !== lines.slice(start, start + p.old.length).join('')) return undefined
    for (const line of lines.slice(cursor, start)) out.push(line)
    for (const line of p.next) out.push(line)
    cursor = start + p.old.length
    delta += p.next.length - p.old.length
  }
  for (const line of lines.slice(cursor)) out.push(line)
  if (out.slice(0, -1).some(l => !l.endsWith('\n'))) return undefined
  return out.join('')
}

const unique = (whole: string, part: string) => part !== '' && whole.indexOf(part) === whole.lastIndexOf(part)

function edit(before: string, parsed: ParsedHunk[], after: string): Action | undefined {
  const lines = fileLines(before)
  const first = parsed[0]!
  const last = parsed.at(-1)!
  let start = first.hunk.oldStart - (first.hunk.oldLines ? 1 : 0)
  let end = last.hunk.oldStart - (last.hunk.oldLines ? 1 : 0) + last.old.length
  const delta = after.length - before.length
  let context = 1
  // Real neighbouring lines make pure insertions and repeated text unambiguous.
  for (;;) {
    const offset = lines.slice(0, start).join('').length
    const old = lines.slice(start, end).join('')
    const next = after.slice(offset, offset + old.length + delta)
    if (old.length > PATCH_TEXT_MAX || next.length > PATCH_TEXT_MAX) return undefined
    if (unique(before, old) && before.slice(0, offset) + next + before.slice(offset + old.length) === after) {
      return { tool: 'Edit', input: { old_string: old, new_string: next, replace_all: false }, result: {
        oldString: old, newString: next, originalFile: before.length <= PATCH_TEXT_MAX ? before : null,
        structuredPatch: parsed.map(p => p.hunk), userModified: false, replaceAll: false,
      } }
    }
    if (start > 0) start = Math.max(0, start - context)
    else if (end < lines.length) end = Math.min(lines.length, end + context)
    else return undefined
    context *= 2
  }
}

function imageHunk(content: string, created: boolean): Hunk[] {
  const lines = fileLines(content)
  if (!lines.length) return []
  return [{ oldStart: created ? 0 : 1, oldLines: created ? 0 : lines.length,
    newStart: created ? 1 : 0, newLines: created ? lines.length : 0,
    lines: lines.flatMap(l => [(created ? '+' : '-') + (l.endsWith('\n') ? l.slice(0, -1) : l), ...(!l.endsWith('\n') ? ['\\ No newline at end of file'] : [])]),
  }]
}

/** A patch is evidence, never a shell command or permission to replay a write. */
export function patchActions(change: FileChange, before: string | undefined, after: string | undefined,
  status: string | undefined, report = '', stable = true, fallbackReason?: string): Action[] {
  const kind = typeof change.kind === 'string' ? change.kind : change.kind?.type ?? 'unknown'
  const move = typeof change.kind === 'object' ? change.kind?.move_path : change.move_path
  const destination = typeof move === 'string' ? move : undefined
  const path = change.path
  const operation = destination ? 'move' : ['add', 'update', 'delete'].includes(kind) ? kind : 'unknown'
  const label = destination ? `${quote(path)} → ${quote(destination)}` : quote(path)
  const parsed = typeof change.diff === 'string' ? parsePatch(change.diff, kind) : undefined
  const actualHunks = parsed?.map(p => p.hunk)
  const raw = change.diff === undefined ? '' : `\nReported diff:\n${change.diff}`
  const summary = destination ? `Codex moved ${path} → ${destination}` : `Codex apply_patch ${kind}: ${path}`
  const fallback = (reason: string, files?: Record<string, unknown>[]): Action[] => [{
    tool: 'Bash', input: { command: `# Codex apply_patch: ${operation} ${label}`, description: `Codex patch: ${operation} ${label}` },
    result: { stdout: `${summary}\n${reason}${report ? `\n${report}` : ''}${raw}`, stderr: '', interrupted: false,
      ...(files ? { bashEditDiff: { files, moreFiles: 0, changedFiles: files.map(f => f.filePath) } } : {}),
    },
  }]
  if (status !== 'completed') {
    const state = status === 'declined' ? 'declined' : status === 'failed' ? 'failed' : 'outcome unconfirmed'
    const rows = fallback(`Patch ${state}; individual application is unproved.`)
    rows[0]!.input.description = `Codex patch ${state}: ${operation} ${label}`
    rows[0]!.error = `Codex patch ${state}: ${operation} ${label}\n${report}${raw}`
    return rows
  }
  if (destination) {
    const verified = stable && text(before) && text(after) &&
      (parsed ? apply(before, parsed) === after : change.diff === '' && before === after)
    return fallback(verified ? 'Verified move images; modification diff retained below.' : 'Move reported; exact old/new images unavailable.', verified ? [
      { filePath: path, hunks: imageHunk(before!, false), deleted: true },
      { filePath: destination, hunks: imageHunk(after!, true), created: true },
    ] : undefined)
  }
  if (kind === 'delete') return fallback('Deletion reported by completed source patch.', actualHunks ? [{ filePath: path, hunks: actualHunks, deleted: true }] : undefined)
  const patchFiles = actualHunks ? [{ filePath: path, hunks: actualHunks, ...(kind === 'add' ? { created: true } : {}) }] : undefined
  if (fallbackReason) return fallback(fallbackReason, patchFiles)
  if (kind === 'add') {
    // Empty files need a completed image; an empty/missing diff alone is ambiguous.
    const content = parsed ? apply('', parsed) : change.diff === '' && after === '' ? '' : undefined
    if (text(content) && stable && (after === undefined || after === content) && content.length <= PATCH_TEXT_MAX) return [{
      tool: 'Write', input: { file_path: path, content }, result: { type: 'create', filePath: path, content, structuredPatch: actualHunks ?? [], originalFile: null },
    }]
    return fallback('Exact complete addition unavailable, oversized, binary, or completed image disagrees.', patchFiles)
  }
  if (kind !== 'update' || !parsed || !text(before) || !text(after) || !stable || apply(before, parsed) !== after) {
    return fallback('Exact update unavailable: missing/invalid diff or base, binary text, or racing completed image.', patchFiles)
  }
  const bind = (a: Action) => ({ ...a, input: { file_path: path, ...a.input }, result: { ...a.result, filePath: path } })
  const combined = edit(before, parsed, after)
  if (combined) return [bind(combined)]
  // A bounded combined span can be unavailable while each hunk is exact.
  const rows: Action[] = []
  let intermediate = before
  let delta = 0
  for (const p of parsed) {
    const adjusted = { ...p, hunk: { ...p.hunk, oldStart: p.hunk.oldStart + delta } }
    const next = apply(intermediate, [adjusted])
    if (next === undefined) return fallback('No exact intermediate hunk revision.', patchFiles)
    const row = edit(intermediate, [adjusted], next)
    if (!row) return fallback('Not every hunk has a unique bounded replacement.', patchFiles)
    rows.push(bind(row))
    intermediate = next
    delta += p.next.length - p.old.length
  }
  return intermediate === after ? rows : fallback('Hunk revisions disagree with completed image.', patchFiles)
}
