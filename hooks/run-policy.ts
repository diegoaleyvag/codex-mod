// Repository requests are bounded by user authority before either transport
// sees them. Keep one sorted override map, and retain it for thread resumes.
export type Capabilities = {
  webSearch?: 'disabled' | 'cached' | 'live'
  mcpServers?: string[]
  multiAgent?: boolean
  skillsInstructions?: boolean
  apps?: boolean
  plugins?: boolean
  images?: boolean
}
export type RolePolicy = { lean?: boolean; capabilities?: Capabilities; fallbackModels?: string[]; instructions?: string }
export type EffectiveConfig = {
  leanRequested?: boolean
  lean: boolean
  multiAgent: boolean
  overrides: string[]
  instructions?: string
  instructionHash: string
  home: string
  globalRules: boolean
  fingerprint: string
}
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
export const boundedNames = (v: unknown, pattern = /^[\w.:-]{1,100}$/): v is string[] =>
  Array.isArray(v) && v.length <= 32 && v.every(s => typeof s === 'string' && pattern.test(s)) && new Set(v).size === v.length

export function validCapabilities(v: unknown): v is Capabilities {
  if (!object(v)) return false
  return Object.entries(v).every(([k, value]) => {
    if (k === 'webSearch') return ['disabled', 'cached', 'live'].includes(String(value)) && typeof value === 'string'
    if (k === 'mcpServers') return boundedNames(value, /^[A-Za-z0-9_-]{1,64}$/)
    return ['multiAgent', 'skillsInstructions', 'apps', 'plugins', 'images'].includes(k) && typeof value === 'boolean'
  })
}

// A stable diagnostic fingerprint, not an authorization token or secret hash.
export function configHash(value: unknown): string {
  let a = 2166136261, b = 5381
  for (const c of JSON.stringify(value)) { a = Math.imul(a ^ c.charCodeAt(0), 16777619); b = Math.imul(b, 33) ^ c.charCodeAt(0) }
  return [a, b].map(n => (n >>> 0).toString(16).padStart(8, '0')).join('')
}
export function canonicalOverrides(entries: readonly string[]): string[] {
  const map = new Map<string, string>()
  for (const entry of entries) {
    const at = entry.indexOf('=')
    if (at > 0) map.set(entry.slice(0, at).trim().replace(/"([\w-]+)"/g, '$1'), entry.slice(at + 1).trim())
  }
  return [...map].sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}=${v}`)
}

export function resolvePolicy(user: { lean: boolean; allowProjectNonLean: boolean; projectCapabilityAllowlist: string[]; extraConfig: string[]; globalRules: boolean },
  role: RolePolicy | undefined, leanOverrides: string[], servers: string[], home: string): { policy: EffectiveConfig; warnings: string[] } {
  const warnings: string[] = []
  let lean = role?.lean ?? user.lean
  if (!lean && user.lean && !user.allowProjectNonLean) {
    lean = true
    warnings.push('role lean=false refused: enable user allowProjectNonLean to expand the lean preset')
  }
  const entries = lean ? [...leanOverrides] : []
  const capabilities = role?.capabilities ?? {}
  // Rich inherits the user's baseline; it does not authorize a repository to
  // override an independently disabled connected tool in config.toml.
  const grant = (name: string) => user.allowProjectNonLean || user.projectCapabilityAllowlist.includes(name)
  const set = (key: string, value: string | boolean) => entries.push(`${key}=${typeof value === 'string' ? JSON.stringify(value) : value}`)
  const allow = (name: string, enable: boolean) => {
    if (!enable || grant(name)) return true
    warnings.push(`role capability ${name} refused: absent from user projectCapabilityAllowlist`)
    return false
  }
  if (capabilities.webSearch !== undefined && allow(`webSearch:${capabilities.webSearch}`, capabilities.webSearch !== 'disabled')) set('web_search', capabilities.webSearch)
  if (capabilities.mcpServers !== undefined) {
    for (const name of servers) set(`mcp_servers.${name}.enabled`, false)
    for (const name of capabilities.mcpServers) {
      if (!servers.includes(name)) warnings.push(`role MCP ${name} refused: not discovered in user config.toml`)
      else if (allow(`mcp:${name}`, true)) set(`mcp_servers.${name}.enabled`, true)
    }
  }
  const keys = { multiAgent: ['features.multi_agent'], skillsInstructions: ['skills.include_instructions'],
    apps: ['features.apps'], plugins: ['features.plugins', 'features.remote_plugin'], images: ['features.image_generation'] }
  for (const [name, configKeys] of Object.entries(keys)) {
    const value = capabilities[name as keyof typeof keys]
    if (value !== undefined && allow(name, value)) for (const key of configKeys) set(key, value)
  }
  const requested = canonicalOverrides(entries)
  const overrides = canonicalOverrides([...requested, ...user.extraConfig])
  if (lean && requested.some(kv => !overrides.includes(kv))) warnings.push('user extraConfig overrides the requested lean policy; lean is partial')
  const multi = overrides.find(kv => kv.startsWith('features.multi_agent='))?.split('=')[1]
  const policy = { leanRequested: role?.lean, lean, multiAgent: multi === undefined ? !lean : multi !== 'false', overrides,
    instructions: role?.instructions, instructionHash: configHash(role?.instructions ?? ''), home, globalRules: user.globalRules }
  return { policy: { ...policy, fingerprint: configHash(policy) }, warnings }
}

export const policyTask = (policy: Pick<EffectiveConfig, 'instructions' | 'multiAgent'>, text: string): string =>
  [policy.instructions, policy.multiAgent ? undefined : 'Do not spawn sub-agents.', text].filter(s => s !== undefined && s !== '').join('\n\n')

export function capacityFallback(models: readonly { slug: string; efforts: string[]; defaultEffort?: string }[] | undefined,
  names: readonly string[], current: { model: string; effort: string; sandbox: string }) {
  for (const name of names) {
    const info = models?.find(m => m.slug === name && m.slug !== current.model)
    if (!info) continue
    const effort = !info.efforts.length || info.efforts.includes(current.effort) ? current.effort
      : info.defaultEffort && info.efforts.includes(info.defaultEffort) ? info.defaultEffort : info.efforts[0]!
    return { ...current, model: info.slug, effort }
  }
}
