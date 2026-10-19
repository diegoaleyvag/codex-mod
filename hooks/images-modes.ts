import type { Action } from './codex.ts'
import type { EngineInterface } from 'claude-code'

export const IMAGE_MAX = 4 * 1024 * 1024
const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

/** Decode only the bounded bytes needed for sniffing; no Node globals in hooks. */
const bytesAt = (base64: string, start: number, count: number): number[] => {
  const out: number[] = []
  for (let n = start; n < start + count; n++) {
    const i = Math.floor(n / 3) * 4
    const word = [0, 1, 2, 3].reduce((v, j) => (v << 6) | Math.max(0, alphabet.indexOf(base64[i + j]!)), 0)
    out.push((word >>> (16 - (n % 3) * 8)) & 255)
  }
  return out
}

export function imageFile(base64: unknown): { base64: string; type: string; originalSize: number } | undefined {
  if (typeof base64 !== 'string' || base64.length % 4 !== 0 || base64.length > Math.ceil(IMAGE_MAX / 3) * 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(base64)) return
  const size = base64.length / 4 * 3 - (base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0)
  if (size < 14 || size > IMAGE_MAX) return
  const b = bytesAt(base64, 0, Math.min(size, 32))
  const end = bytesAt(base64, Math.max(0, size - 12), Math.min(12, size))
  const ascii = (a: number[]) => a.map(n => String.fromCharCode(n)).join('')
  const be = (at: number) => b.slice(at, at + 4).reduce((v, n) => v * 256 + n, 0)
  const le = (at: number) => b.slice(at, at + 4).reverse().reduce((v, n) => v * 256 + n, 0)
  let type: string | undefined
  if (size >= 45 && ascii(b.slice(0, 8)) === '\x89PNG\r\n\x1a\n' && be(8) === 13 && ascii(b.slice(12, 16)) === 'IHDR' && be(16) > 0 && be(20) > 0 && ascii(end.slice(4, 8)) === 'IEND') type = 'image/png'
  else if (b[0] === 255 && b[1] === 216 && b[2] === 255 && end.at(-2) === 255 && end.at(-1) === 217) type = 'image/jpeg'
  else if (['GIF87a', 'GIF89a'].includes(ascii(b.slice(0, 6))) && (b[6]! | b[7]! << 8) > 0 && (b[8]! | b[9]! << 8) > 0 && end.at(-1) === 59) type = 'image/gif'
  else if (size >= 20 && ascii(b.slice(0, 4)) === 'RIFF' && le(4) + 8 === size && ascii(b.slice(8, 12)) === 'WEBP' && ['VP8 ', 'VP8L', 'VP8X'].includes(ascii(b.slice(12, 16)))) type = 'image/webp'
  return type ? { base64, type, originalSize: size } : undefined
}

/** A later file preview, acquired through fs.*, never Claude's Read executor. */
export async function captureImage($: EngineInterface, path: string): Promise<{ action?: Action; reason?: string }> {
  try {
    const before = await $.fs.stat(path, { resolve: true })
    if (before.kind !== 'file' || before.size > IMAGE_MAX) return { reason: 'image is not a regular file or exceeds the 4 MiB preview bound' }
    const { base64 } = await $.fs.read(path, { as: 'bytes' })
    const after = await $.fs.stat(path, { resolve: true })
    const file = imageFile(base64)
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.realPath !== after.realPath || after.kind !== 'file' || file && file.originalSize !== after.size) return { reason: 'image changed during preview capture' }
    if (!file) return { reason: 'unsupported or invalid image bytes (PNG/JPEG/GIF/WebP required)' }
    return { action: { tool: 'Read', input: { file_path: path }, result: { type: 'image', file } } }
  } catch (err) {
    return { reason: `image preview unavailable: ${err instanceof Error ? err.message : String(err)}` }
  }
}

export function validImage(a: Action): boolean {
  const r: any = a.result, i = a.input
  if (a.error || a.tool !== 'Read' || Object.keys(i).length !== 1 || typeof i.file_path !== 'string' || !i.file_path.startsWith('/')) return false
  if (r?.type !== 'image' || Object.keys(r).length !== 2 || !r.file || Object.keys(r.file).some(k => !['base64', 'type', 'originalSize'].includes(k))) return false
  const file = imageFile(r.file.base64)
  return file !== undefined && file.type === r.file.type && file.originalSize === r.file.originalSize
}

export function generationAction(item: Record<string, any>): Action {
  const args = Object.fromEntries(['status', 'revisedPrompt', 'result', 'savedPath', 'transparentBackground', 'failure'].filter(k => k in item).map(k => [k, item[k]]))
  return { tool: 'codex_tool', input: { server: 'codex', name: 'imageGeneration', arguments: args },
    result: [{ type: 'text', text: `Codex image generation\n${JSON.stringify(args, null, 2)}` }],
    ...(['failed', 'declined'].includes(item.status) || item.failure ? { error: `Codex image generation ${item.status ?? 'failed'}: ${JSON.stringify(args)}` } : {}) }
}

export function findingsAction(item: Record<string, any>): Action | undefined {
  const findings = item.findings
  if (!Array.isArray(findings) || !findings.every(f => f && typeof f === 'object' && !Array.isArray(f) &&
    Object.keys(f).every(k => ['file', 'summary', 'failure_scenario', 'line', 'short_summary', 'category', 'verdict', 'outcome'].includes(k)) &&
    ['file', 'summary', 'failure_scenario'].every(k => typeof f[k] === 'string') &&
    (f.line === undefined || Number.isInteger(f.line) && f.line >= 1) &&
    ['short_summary', 'category'].every(k => f[k] === undefined || typeof f[k] === 'string') &&
    (f.verdict === undefined || ['CONFIRMED', 'PLAUSIBLE'].includes(f.verdict)) &&
    (f.outcome === undefined || ['fixed', 'skipped', 'no_change_needed'].includes(f.outcome)))) return
  if (item.level !== undefined && !['low', 'medium', 'high', 'xhigh', 'max'].includes(item.level)) return
  const input = { findings, ...(item.level === undefined ? {} : { level: item.level }) }
  return { tool: 'ReportFindings', input, result: { count: findings.length, ...input } }
}

/** Markdown fallback must display even tags, fences and leading override lines. */
export function literalReceipt(text: string): string {
  if (!/[<`*_#\[\]~\\]|^(?:[ >|+-]|\d+\.)/m.test(text)) return `Coordinator message:\n\n${text}`
  const runs = text.match(/`+/g) ?? []
  const fence = '`'.repeat(Math.max(3, ...runs.map(s => s.length + 1)))
  return `Coordinator message:\n\n${fence}text\n${text}\n${fence}`
}
