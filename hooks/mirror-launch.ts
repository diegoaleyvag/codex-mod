// Host events can omit the loop ID and cwd. Authority comes from the step
// currently awaiting its own API spawn, never from an event's missing fields.
export type MirrorLaunch = {
  token: string; parentHost: string; session: string; depth: number
  inputDigest: string; launch: string; hostToolId?: string; host?: string
}
export type MirrorAuthority = { parentHost: string; session: string; toolUseId?: string; spawned?: boolean }
export type MirrorVerdict = 'admit' | 'no-reservation' | 'no-authority' | 'origin' | 'state' | 'depth' | 'session' |
  'type' | 'token' | 'digest' | 'parent' | 'background' | 'fork' | 'resume' | 'workflow' | 'teammate' |
  'reused' | 'provider' | 'tool' | 'keys' | 'tool-id' | 'host-id' | 'no-host'
type Phase = 'call' | 'check' | 'spawn'
const object = (v: any) => v !== null && typeof v === 'object' && !Array.isArray(v)

export const mirrorLaunchDigest = (input: any): string => JSON.stringify({
  subagentType: input.subagentType, prompt: input.prompt, description: input.description, name: input.name,
})

/** Consume one source-step capability, allowing its call/check/spawn phases
 * to share exactly one core tool ID. A second spawn cannot reuse the token. */
export function admitMirrorLaunch(m: MirrorLaunch | undefined, authority: MirrorAuthority | undefined, e: any, origin: string, phase: Phase): MirrorVerdict {
  if (!m) return 'no-reservation'
  if (!authority) return 'no-authority'
  if (origin !== 'codex-mod') return 'origin'
  if (m.launch !== 'launching') return 'state'
  if (![2, 3].includes(m.depth)) return 'depth'
  if (authority.session !== m.session) return 'session'
  if (!m.parentHost || authority.parentHost !== m.parentHost) return 'parent'
  const nested = phase === 'check' && object(e.input)
  const input = nested ? e.input : e
  const type = phase === 'spawn' ? input.subagentType : input.subagent_type
  if (type !== 'codex-mod:codex-child') return 'type'
  if (input.prompt !== m.token) return 'token'
  if (typeof input.name !== 'string' || typeof input.description !== 'string' ||
    mirrorLaunchDigest({ subagentType: type, prompt: input.prompt, description: input.description, name: input.name }) !== m.inputDigest) return 'digest'
  const parent = phase === 'spawn' ? e.parentAgentId : e.agentId
  if (parent !== undefined && parent !== authority.parentHost) return 'parent'
  if (phase === 'spawn') {
    if (e.background !== true) return 'background'
    if (e.fork !== false) return 'fork'
    if (e.resume) return 'resume'
    if (e.workflow) return 'workflow'
    if (e.isTeammate) return 'teammate'
    if (authority.spawned) return 'reused'
    if (e.provider?.plugin !== undefined && !ours(e.provider.plugin)) return 'provider'
  } else {
    if (e.tool !== 'Agent') return 'tool'
    if (input.run_in_background === false) return 'background'
    const keys = nested ? Object.keys(e.input) : Object.keys(e).filter(k => !['tool', 'tool_use_id', 'agentId', 'requestMeta', 'consent', ...(phase === 'check' ? ['ceiling'] : [])].includes(k))
    if (keys.some(k => !['subagent_type', 'prompt', 'description', 'name', 'cwd', 'run_in_background'].includes(k))) return 'keys'
    if (nested && Object.keys(e).some(k => !['tool', 'tool_use_id', 'agentId', 'input', 'ceiling'].includes(k))) return 'keys'
  }
  const id = e.tool_use_id
  if (typeof id !== 'string' || id === '' || id.startsWith('toolu_codexmod_') || authority.toolUseId !== undefined && authority.toolUseId !== id ||
    m.hostToolId !== undefined && m.hostToolId !== id) return 'tool-id'
  authority.toolUseId = id
  m.hostToolId = id
  if (phase === 'spawn') authority.spawned = true
  return 'admit'
}

/** Explicit host metadata must agree. Omitted metadata needs the admitted
 * core tool ID; a first turn can precede both the spawn ack and list entry. */
export function mirrorHostMatches(m: MirrorLaunch, host: string, info: any, admitted = false): MirrorVerdict {
  if (typeof host !== 'string' || !host || m.host !== undefined && m.host !== host) return 'host-id'
  if (host === m.parentHost) return 'parent'
  if (!info && !admitted) return 'no-host'
  if (info) {
    if (info.id !== host) return 'host-id'
    if (info.type !== 'codex-mod:codex-child') return 'type'
    if (info.parentId !== undefined && info.parentId !== m.parentHost) return 'parent'
    if (info.spawnedBy !== undefined && !ours(info.spawnedBy)) return 'provider'
  }
  return info?.parentId !== undefined || typeof m.hostToolId === 'string' && m.hostToolId !== '' ? 'admit' : 'tool-id'
}

// Only field names, boolean flags and identity tags enter diagnostics. Never
// log prompt tokens, descriptions, names, cwd, model text or raw event values.
const tag = (v: unknown) => v === undefined ? 'absent' : typeof v === 'string' && /^[\w:.@-]{1,100}$/.test(v) ? v : 'other'
// The host names a plugin either bare or with its marketplace (`codex-mod@codex-mod`).
const ours = (v: unknown) => v === 'codex-mod' || typeof v === 'string' && v.startsWith('codex-mod@')
const flag = (v: unknown) => v === true ? true : v === false ? false : v === undefined ? 'absent' : 'other'
export function mirrorLaunchDiagnostic(phase: string, verdict: MirrorVerdict, e: any, origin: string, m?: MirrorLaunch): string {
  const summary = { keys: Object.keys(e).sort(), inputKeys: object(e.input) ? Object.keys(e.input).sort() : undefined,
    origin: tag(origin), provider: { plugin: tag(e.provider?.plugin), tier: tag(e.provider?.tier) },
    background: flag(e.background ?? e.input?.run_in_background ?? e.run_in_background), fork: flag(e.fork), depth: m?.depth ?? 'absent' }
  return verdict === 'admit'
    ? `codex-mod: mirror launch admitted at ${phase}: tool_use_id=${tag(e.tool_use_id)} (${JSON.stringify(summary)})`
    : `codex-mod: mirror launch refused at ${phase}: ${verdict} (${JSON.stringify(summary)})`
}

/** Re-entry catches cannot use engine APIs. The live parent drains their
 * diagnostics after spawn settles; ordinary dispatches also drain leftovers. */
export class MirrorDiagnostics {
  private lines: string[] = []
  add(line: string): void { this.lines.push(line) }
  flush(log: (line: string) => void): void {
    for (const line of this.lines.splice(0)) log(line)
  }
}
