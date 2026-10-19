import type { Action, SourceRecord } from './codex.ts'

// Glob/Grep are runtime tools absent from BuiltinToolResults in this host.
// Contracts: research/r1/CLAUDE-TOOLS.md, runtime schemas at 2014 and 2034.
export type GlobResult = { durationMs: number; numFiles: number; filenames: string[]; truncated: boolean }
export type GrepResult = { mode: 'content' | 'files_with_matches' | 'count'; numFiles: number; filenames: string[]; content?: string; numLines?: number; numMatches?: number }

const integer = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0
const lines = (s: string) => s === '' ? 0 : s.split('\n').length - (s.endsWith('\n') ? 1 : 0)
const keys = (v: Record<string, unknown>, allowed: string[]) => Object.keys(v).every(k => allowed.includes(k))

/** No expansion or evaluation: only literal shell words in one simple command. */
export function literalWords(command: string): string[] | undefined {
  const words: string[] = []
  let word = ''
  let active = false
  let quote = ''
  for (let n = 0; n < command.length; n++) {
    const c = command[n]!
    if (quote === "'") {
      if (c === "'") quote = ''
      else word += c
    } else if (c === '\\') {
      const next = command[n + 1]
      if (next === undefined || next === '\n') return undefined
      if (quote === '"' && !'"\\$`'.includes(next)) word += c
      else {
        word += next
        n++
      }
      active = true
    } else if (quote === '"') {
      if (c === '"') quote = ''
      else if ('$`'.includes(c)) return undefined
      else word += c
    } else if (c === '"' || c === "'") {
      quote = c
      active = true
    } else if (c === ' ' || c === '\t') {
      if (active) words.push(word)
      word = ''
      active = false
    } else {
      if ('\n\r\0|&;<>($`)*?[]{}~#!'.includes(c)) return undefined
      word += c
      active = true
    }
  }
  if (quote) return undefined
  if (active) words.push(word)
  return words.length ? words : undefined
}

// Lexical resolution only. Never sample today's filesystem to explain old output.
const pathAt = (cwd: string, path: string): string | undefined => {
  if (!cwd.startsWith('/') || !path || /[\0\r\n]/.test(path)) return undefined
  const parts: string[] = []
  for (const p of (path.startsWith('/') ? path : `${cwd}/${path}`).split('/')) {
    // Resolving .. without the source filesystem can cross a symlink differently.
    if (p === '..') return undefined
    if (p && p !== '.') parts.push(p)
  }
  return '/' + parts.join('/')
}

const nulPaths = (output: string): string[] | undefined => {
  if (!output) return []
  if (!output.endsWith('\0')) return undefined
  const paths = output.slice(0, -1).split('\0')
  return paths.every(p => p !== '' && !/[\r\n]/.test(p)) ? paths : undefined
}

const globPattern = (pattern: string): string | undefined => {
  // A single basename filter has the same recursive scope in rg and Glob.
  if (!pattern || /[\/\\!{}\[\]\r\n]/.test(pattern)) return undefined
  return `**/${pattern}`
}

/** Undefined means that Bash is the truthful representation. */
function parseExploration(source: SourceRecord | undefined): Action | undefined {
  const item = source?.item
  if (!item || item.type !== 'commandExecution' || !['agent', 'unifiedExecStartup'].includes(item.source) ||
    !['completed', 'failed'].includes(item.status) || ![0, 1].includes(item.exitCode) ||
    typeof item.command !== 'string' || typeof item.aggregatedOutput !== 'string' ||
    !Array.isArray(item.commandActions) || item.commandActions.length !== 1) return undefined
  const action = item.commandActions[0]
  let command = item.command
  let args = literalWords(command)
  // Decode exactly one shell -c argument, never a suffix of a compound command.
  if (args?.length === 3 && /^(?:\/(?:usr\/)?bin\/)?(?:ba|z|da)?sh$/.test(args[0]!) && ['-c', '-lc'].includes(args[1]!)) {
    command = args[2]!
    args = literalWords(command)
  }
  if (!action || (action.command !== item.command && action.command !== command)) return undefined
  const cwd = source!.cwd
  const output: string = item.aggregatedOutput
  if (!args || !cwd?.startsWith('/') || item.stderr || item.error || item.failure || item.timedOut || item.interrupted || item.truncated === true ||
    /(?:\[.*truncated.*\]|Warning: truncated output|tokens truncated)/i.test(output)) return undefined
  const program = args.shift()
  if (action.type === 'read') {
    if (item.status !== 'completed' || item.exitCode !== 0 || output.includes('\0')) return undefined
    let offset = 1
    let limit: number | undefined
    let total = lines(output)
    if (program === 'head' && args[0] === '-n' && /^[1-9]\d*$/.test(args[1] ?? '')) {
      limit = Number(args.splice(0, 2)[1])
      // A full window does not establish the required file total.
      if (!integer(limit) || total >= limit) return undefined
    } else if (program === 'tail' && args[0] === '-n' && /^\+[1-9]\d*$/.test(args[1] ?? '')) {
      offset = Number(args.splice(0, 2)[1]!.slice(1))
      if (!integer(offset) || (offset > 1 && !output)) return undefined
      total += offset - 1
    } else if (program !== 'cat') return undefined
    if (args[0] === '--') args.shift()
    if (args.length !== 1 || args[0]!.startsWith('-') || args[0] === '-') return undefined
    const path = pathAt(cwd, args[0]!)
    if (!path || typeof action.path !== 'string' || pathAt(cwd, action.path) !== path) return undefined
    return { tool: 'Read', input: { file_path: path, ...(offset !== 1 ? { offset } : {}), ...(limit !== undefined ? { limit } : {}) },
      result: { type: 'text', file: { filePath: path, content: output, numLines: lines(output), startLine: offset, totalLines: total } }, source }
  }
  const root = action.path == null ? cwd : typeof action.path === 'string' ? pathAt(cwd, action.path) : undefined
  if (!root) return undefined
  if (action.type === 'listFiles') {
    if (item.status !== 'completed' || item.exitCode !== 0) return undefined
    let pattern: string | undefined
    let target = '.'
    if (program === 'find') {
      target = args.shift() ?? ''
      if (target.startsWith('-')) return undefined
      if (JSON.stringify(args) === JSON.stringify(['-maxdepth', '1', '-type', 'f', '-print0'])) pattern = '*'
      if (JSON.stringify(args) === JSON.stringify(['-type', 'f', '-print0'])) pattern = '**/*'
    } else if (program === 'rg') {
      let files = false
      let nul = false
      let filter: string | undefined
      const paths: string[] = []
      for (let n = 0; n < args.length; n++) {
        const arg = args[n]!
        if (arg === '--files' && !files) files = true
        else if ((arg === '-0' || arg === '--null') && !nul) nul = true
        else if ((arg === '-g' || arg === '--glob') && filter === undefined) {
          filter = args[++n]
          if (filter === undefined) return undefined
        } else if (!arg.startsWith('-')) paths.push(arg)
        else return undefined
      }
      if (!files || !nul || paths.length > 1) return undefined
      target = paths[0] ?? '.'
      pattern = filter === undefined ? '**/*' : globPattern(filter)
    }
    if (!pattern || pathAt(cwd, target) !== root) return undefined
    const reported = nulPaths(output)
    if (!reported) return undefined
    const filenames = reported.map(p => pathAt(cwd, p))
    if (filenames.some(p => !p)) return undefined
    const elapsed = item.durationMs ?? (source!.startedAtMs !== undefined && source!.completedAtMs !== undefined ? source!.completedAtMs - source!.startedAtMs : undefined)
    return { tool: 'Glob', input: { pattern, path: root },
      result: { durationMs: typeof elapsed === 'number' && elapsed >= 0 ? elapsed : 0, numFiles: filenames.length, filenames: filenames as string[], truncated: false }, source }
  }
  if (action.type !== 'search' || program !== 'rg') return undefined
  const input: Record<string, any> = { path: root, output_mode: 'content', head_limit: 0 }
  let fixed = false
  let json = false
  let nul = false
  let withFilename = false
  let query: string | undefined
  const paths: string[] = []
  let options = true
  for (let n = 0; n < args.length; n++) {
    const arg = args[n]!
    if (options && arg === '--') { options = false; continue }
    if (options && arg.startsWith('-')) {
      if (arg === '--json') json = true
      else if (arg === '-0' || arg === '--null') nul = true
      else if (arg === '-H' || arg === '--with-filename') withFilename = true
      else if (arg === '-l' || arg === '--files-with-matches') input.output_mode = 'files_with_matches'
      else if (arg === '--count-matches') input.output_mode = 'count'
      else if (arg === '-F' || arg === '--fixed-strings') fixed = true
      else if (['-i', '-n', '-o'].includes(arg)) input[arg] = true
      else if (['-g', '--glob', '-t', '--type', '-A', '-B', '-C'].includes(arg)) {
        const value = args[++n]
        if (value === undefined) return undefined
        if (arg === '-g' || arg === '--glob') {
          if (input.glob !== undefined || !globPattern(value)) return undefined
          input.glob = value
        } else if (arg === '-t' || arg === '--type') {
          if (input.type !== undefined || !/^[\w-]+$/.test(value)) return undefined
          input.type = value
        } else {
          if (!/^\d+$/.test(value) || !integer(Number(value))) return undefined
          input[arg] = Number(value)
        }
      } else return undefined
    } else if (query === undefined) query = arg
    else paths.push(arg)
  }
  // With no explicit path rg can read inherited stdin instead of the cwd.
  if (query === undefined || query !== action.query || paths.length !== 1 || paths[0] === '-' || pathAt(cwd, paths[0]!) !== root) return undefined
  input.pattern = fixed ? query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') : query
  const mode = input.output_mode as GrepResult['mode']
  if ((mode === 'content' && (!json || nul || withFilename)) || (mode !== 'content' && (json || !nul)) ||
    (mode === 'count' && (!withFilename || input['-o'])) || (mode !== 'content' && ['-A', '-B', '-C'].some(k => k in input))) return undefined
  // rg's documented 1 means no matches only when it produced no error/output.
  if (item.exitCode === 1 && output !== '' && mode !== 'content') return undefined
  if (item.exitCode === 0 && item.status !== 'completed') return undefined
  const filenames: string[] = []
  let count = 0
  let content = ''
  let numLines = 0
  const add = (p: string) => {
    const path = pathAt(cwd, p)
    if (!path) return false
    if (!filenames.includes(path)) filenames.push(path)
    return true
  }
  if (output && mode === 'content') {
    if (!output.endsWith('\n')) return undefined
    try {
      let matches = 0
      let emptySummary = false
      for (const line of output.slice(0, -1).split('\n')) {
        const record = JSON.parse(line)
        if (!['begin', 'match', 'context', 'end', 'summary'].includes(record.type)) return undefined
        if (record.type === 'summary') emptySummary = record.data?.stats?.matches === 0 && record.data?.stats?.matched_lines === 0
        if (record.type === 'match' || record.type === 'context') {
          const data = record.data
          if (typeof data?.path?.text !== 'string' || data.path.text === '<stdin>' || typeof data?.lines?.text !== 'string' || data.lines.text.includes('\0') || !add(data.path.text)) return undefined
          if (input['-o']) return undefined // JSON mode reports full lines even with -o.
          if (input['-n'] && (!integer(data.line_number) || data.line_number < 1)) return undefined
          const text: string = data.lines.text
          const delivered = lines(text)
          const pieces = text.split('\n')
          if (content && !content.endsWith('\n') && delivered) content += '\n'
          for (let n = 0; n < delivered; n++) {
            const sep = record.type === 'context' ? '-' : ':'
            content += `${data.path.text}${input['-n'] ? `${sep}${data.line_number + n}` : ''}${sep}${pieces[n]}${n < delivered - 1 || text.endsWith('\n') ? '\n' : ''}`
          }
          numLines += delivered
          if (record.type === 'match') matches++
        }
      }
      if (item.exitCode === 1 ? matches !== 0 || filenames.length !== 0 || !emptySummary : matches === 0) return undefined
    } catch { return undefined }
  } else if (mode === 'files_with_matches') {
    const reported = nulPaths(output)
    if (!reported || !reported.every(add)) return undefined
  } else if (output && mode === 'count') {
    let rest = output
    while (rest) {
      const end = rest.indexOf('\0')
      if (end < 1 || !add(rest.slice(0, end))) return undefined
      rest = rest.slice(end + 1)
      const match = /^(\d+)\n/.exec(rest)
      if (!match || !integer(Number(match[1]))) return undefined
      count += Number(match[1])
      rest = rest.slice(match[0].length)
    }
  }
  return { tool: 'Grep', input,
    result: { mode, numFiles: filenames.length, filenames,
      ...(mode === 'content' ? { content, numLines } : {}),
      ...(mode === 'count' ? { content: output, numMatches: count } : {}) }, source }
}

export function explorationAction(source: SourceRecord | undefined): Action | undefined {
  const action = parseExploration(source)
  return action && validExploration(action) ? action : undefined
}

/** Exact local subset of R1. No _host routing or extra provenance schema keys. */
export function validExploration(a: Action): boolean {
  const i = a.input
  const r: any = a.result
  if (!r || Array.isArray(r)) return false
  const path = (p: unknown) => typeof p === 'string' && p.startsWith('/') && !/[\0\r\n]/.test(p)
  if (a.tool === 'Read') return keys(i, ['file_path', 'offset', 'limit']) && path(i.file_path) &&
    (i.offset === undefined || (integer(i.offset) && i.offset > 0)) && (i.limit === undefined || (integer(i.limit) && i.limit > 0)) &&
    keys(r, ['type', 'file']) && r.type === 'text' && r.file && typeof r.file === 'object' && !Array.isArray(r.file) &&
    keys(r.file, ['filePath', 'content', 'numLines', 'startLine', 'totalLines']) && r.file.filePath === i.file_path &&
    typeof r.file.content === 'string' && r.file.numLines === lines(r.file.content) && r.file.startLine === (i.offset ?? 1) &&
    integer(r.file.totalLines) && r.file.totalLines >= r.file.startLine - 1 + r.file.numLines &&
    (i.limit === undefined || r.file.numLines <= i.limit)
  if (!Array.isArray(r.filenames) || !r.filenames.every(path) || r.numFiles !== r.filenames.length) return false
  if (a.tool === 'Glob') return keys(i, ['pattern', 'path']) && typeof i.pattern === 'string' && path(i.path) &&
    keys(r, ['durationMs', 'numFiles', 'filenames', 'truncated']) && typeof r.durationMs === 'number' && Number.isFinite(r.durationMs) && r.durationMs >= 0 && r.truncated === false
  if (a.tool !== 'Grep' || !keys(i, ['pattern', 'path', 'output_mode', 'glob', '-n', '-i', '-o', '-A', '-B', '-C', 'type', 'multiline', 'head_limit', 'offset']) ||
    typeof i.pattern !== 'string' || !path(i.path) || !['content', 'files_with_matches', 'count'].includes(String(i.output_mode)) ||
    !['glob', 'type'].every(k => i[k] === undefined || typeof i[k] === 'string') ||
    !['-n', '-i', '-o', 'multiline'].every(k => i[k] === undefined || typeof i[k] === 'boolean') ||
    !['-A', '-B', '-C', 'head_limit', 'offset'].every(k => i[k] === undefined || integer(i[k])) || r.mode !== i.output_mode) return false
  return keys(r, ['mode', 'numFiles', 'filenames', 'content', 'numLines', 'numMatches']) &&
    (r.mode === 'files_with_matches' ? r.content === undefined && r.numLines === undefined && r.numMatches === undefined :
      typeof r.content === 'string' && (r.mode === 'content' ? integer(r.numLines) && r.numLines === lines(r.content) && r.numMatches === undefined : integer(r.numMatches) && r.numLines === undefined))
}
