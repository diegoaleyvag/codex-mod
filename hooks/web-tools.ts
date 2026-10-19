import type { Action, SourceRecord } from './codex.ts'

const object = (v: unknown): v is Record<string, any> => v !== null && typeof v === 'object' && !Array.isArray(v)
const number = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0
const text = (v: unknown): v is string => typeof v === 'string' && v.length > 0
const FETCH_FIELDS = ['bytes', 'code', 'codeText', 'result', 'durationMs', 'url']

/** Keep media metadata readable without copying encoded bytes into a text row. */
export function publicToolText(value: unknown): string {
  const safe = (v: any): any => {
    if (Array.isArray(v)) return v.map(safe)
    if (typeof v === 'string' && /^data:/i.test(v)) return `[media URL omitted; ${v.length} characters]`
    if (!object(v)) return v
    const media = ['image', 'audio', 'inputImage', 'inputAudio'].includes(v.type)
    return Object.fromEntries(Object.entries(v).map(([k, child]) => [k,
      ((media && ['data', 'imageUrl', 'audioUrl'].includes(k)) || k === 'blob') && typeof child === 'string'
        ? `[encoded payload omitted; ${child.length} characters]` : safe(child)]))
  }
  return typeof value === 'string' ? safe(value) : JSON.stringify(safe(value)) ?? String(value)
}

export function sourceDuration(source?: SourceRecord): number | undefined {
  const d = source?.item?.durationMs ?? source?.item?.duration_ms
  if (number(d)) return d
  if (number(source?.startedAtMs) && number(source?.completedAtMs) && source.completedAtMs >= source.startedAtMs) return source.completedAtMs - source.startedAtMs
  return undefined
}

function parsedResults(value: any): any {
  if (typeof value !== 'string') return value
  try { return JSON.parse(value) } catch { return value }
}

/** R1 WebSearch's union retains opaque/text entries alongside actual sources. */
function searchResults(value: any): any[] {
  value = parsedResults(value)
  if (!Array.isArray(value)) return [publicToolText(value)]
  const results: any[] = []
  for (const entry of value) {
    if (object(entry) && typeof entry.title === 'string' && typeof entry.url === 'string') {
      let last = results.at(-1)
      if (!object(last)) results.push(last = { tool_use_id: '', content: [] })
      last.content.push({ title: entry.title, url: entry.url, ...(typeof entry.snippet === 'string' ? { snippet: entry.snippet } : {}) })
    } else results.push(publicToolText(entry))
  }
  return results
}

/** RFetch requires reported response facts, never guessed HTTP success/bytes. */
export function validFetchResult(r: any, url: unknown): boolean {
  return object(r) && r.url === url && number(r.bytes) && Number.isSafeInteger(r.bytes) &&
    Number.isInteger(r.code) && r.code >= 100 && r.code <= 599 && typeof r.codeText === 'string' &&
    typeof r.result === 'string' && number(r.durationMs) &&
    Object.keys(r).every(k => FETCH_FIELDS.includes(k))
}

export function webFallback(item: any, reason: string): Action {
  return {
    tool: 'codex_tool', input: { server: 'web', name: item.action?.type ?? 'other', arguments: { query: item.query ?? null, action: item.action ?? null } },
    result: [{ type: 'text', text: `${reason}\n${publicToolText({ results: item.results ?? null, ...(item.error != null ? { error: item.error } : {}) })}` }],
    ...(item.error != null || ['failed', 'declined'].includes(item.status) ? { error: `Codex web action failed/was declined: ${publicToolText(item)}` } : {}),
  }
}

export function webAction(item: any, source?: SourceRecord): Action {
  const a = item.action
  if (['openPage', 'findInPage'].includes(a?.type)) {
    const values = parsedResults(item.results)
    const r = Array.isArray(values) && values.length === 1 ? values[0] : values
    const duration = sourceDuration(source) ?? sourceDuration({ transport: 'exec', event: 'item.completed', item })
    const response = object(r) ? Object.fromEntries(FETCH_FIELDS.map(k => [k, k === 'durationMs' ? r[k] ?? duration : r[k]])) : undefined
    if (!text(a.url) || (a.type === 'findInPage' && typeof a.pattern !== 'string') || !validFetchResult(response, a.url)) {
      return webFallback(item, 'WebFetch requires a URL, find pattern and reported bytes/code/codeText/text/duration/url metadata.')
    }
    return {
      tool: 'WebFetch', input: { url: a.url, prompt: a.type === 'openPage' ? 'Show the page content reported by Codex' : `Find ${JSON.stringify(a.pattern)} in the page reported by Codex` },
      result: response!, ...(item.error != null || item.status === 'declined' || (item.status === 'failed' && response!.code < 400)
        ? { error: `Codex web action failed/was declined: ${publicToolText(item)}` } : {}),
    }
  }
  if (a != null && a.type !== 'search') return webFallback(item, 'Unrepresentable web action; preserving the reported action and results.')
  const query = text(a?.query) ? a.query
    : Array.isArray(a?.queries) && a.queries.length > 0 && a.queries.every(text) ? a.queries.join('\n') : item.query
  if (!text(query)) return webFallback(item, 'WebSearch requires a reported nonempty search query.')
  return {
    tool: 'WebSearch', input: { query, mode: item.mode === 'extended' || a?.mode === 'extended' ? 'extended' : 'standard' },
    result: { query, results: searchResults(item.results), durationSeconds: (sourceDuration(source) ?? 0) / 1000 },
    ...(item.error != null || ['failed', 'declined'].includes(item.status) ? { error: `Codex web search failed/was declined: ${publicToolText(item)}` } : {}),
  }
}

/** ContentItems are dynamic input* variants, not renamed MCP content blocks. */
export function toolFallback(item: any, reason: string): Action {
  const dynamic = ['dynamicToolCall', 'dynamic_tool_call'].includes(item.type)
  const blocks = dynamic ? item.contentItems ?? item.content_items : item.result?.content
  const texts = Array.isArray(blocks) ? blocks.filter(b => object(b) && b.type === (dynamic ? 'inputText' : 'text') && typeof b.text === 'string').map(b => b.text) : []
  const failed = item.error != null || ['failed', 'declined'].includes(item.status) || item.success === false || item.result?.is_error === true || item.result?.isError === true
  const report = publicToolText(dynamic
    ? { contentItems: blocks ?? null, success: item.success ?? null, status: item.status ?? null, durationMs: item.durationMs ?? item.duration_ms ?? null }
    : { result: item.result ?? null, error: item.error ?? null, status: item.status ?? null, durationMs: item.durationMs ?? item.duration_ms ?? null })
  const output = `${reason}\n${texts.join('\n')}${texts.length ? '\n' : ''}${report}`
  return {
    tool: 'codex_tool', input: { server: item.server ?? item.namespace ?? 'dynamic', name: item.tool ?? '', arguments: item.arguments === undefined ? null : item.arguments },
    result: [{ type: 'text', text: output }], ...(failed ? { error: `Codex tool call failed/was declined: ${output}` } : {}),
  }
}
