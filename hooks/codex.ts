// codex-mod: the generic and project-declared agent types are
// answered by OpenAI Codex (`codex exec --json`) running on this machine,
// never by an Anthropic model.
//
// How: a streaming `turn.step` hook. For a step whose loop (`e.agentId`) is an
// agent of one of this plugin's types, the hook never calls `next(e)`, so no
// model request is sent. It reads the agent's task from its conversation and
// starts Codex with `$.process.spawn`. One Codex run spans several steps:
//
//   - while Codex works, each step pulls the child's output until one of
//     Codex's actions is done (a command, a file change), then ends as a model
//     that called the matching built-in tool (`Bash`, `Write`, `Edit`) with
//     what Codex did, Codex's interim messages as text before the calls (stop
//     reason `tool_use`). With `nativeActions` off the whole run streams in
//     one step as text lines instead;
//   - those calls are NEVER executed: they carry a tool_use id with the prefix
//     `toolu_codexmod_`, and this module's `tool.call` hook answers each one
//     from the result Codex reported without calling `next`, so neither the
//     permission path nor the tool runs. Any Bash/Edit/Write/WebSearch of a Codex agent
//     (or of an agent whose type cannot be resolved) without a stored answer is
//     refused. Registered display tools refuse other callers too. The hook's
//     `.catch` refuses when the hook itself fails, and
//     `tool.check` denies such a call should it ever be reached;
//   - when Codex ends, the step hands the answer back ONCE: as the
//     `SubagentHandback` call when the conversation mentions the tool or the
//     engine sends its `[handback-send-enforce]` nudge, else as final text if
//     the API form has no signal or the session has seen a not-active result.
//     Auto still defaults to the tool on incomplete reads and falls back to
//     text on a not-active result, re-delivering the same answer, no Codex run.
//
// Tasks: the conversation is read in its API form, meta rows included (the
// rows form of `$.session.messages` leaves isMeta rows out: the host's
// SubagentHandback reminder, engine nudges, a coordinator's delivery). Engine
// nudges and reminder-only rows are never tasks: on one, the stored last
// answer is re-delivered. Only a genuinely new user/coordinator message
// launches Codex, and a launch guard (one launch per message, at most
// `maxRunsPerWindow` per agent in 10 minutes, counters in the record) backs
// that up independently.
//
// Agent types are registered with `$.agent.register` at session start, so they
// exist only while this module is loaded; models and efforts are validated
// against Codex's own model list (`<CODEX_HOME>/models_cache.json`, read only).
//
// Transport (userConfig `transport`): `exec` (the default) spawns `codex exec
// --json` with the prompt on stdin. `app-server` (opt-in) spawns our sidecar
// `scripts/codex-runner.mjs` with node instead: it owns one `codex app-server`
// for the run (the hook cannot keep a child's stdin open) and prints the same
// JSONL `codex exec --json` does, plus `codexmod.*` lines (turn id, steer
// acks, protocol drift, fatal). Everything else (pump, actions, handback,
// footer, record, launch guard) is shared. Session start checks node, `codex
// app-server --help` and the runner; any failure falls back to exec for the
// session, and the footer says why. The hook talks to a live runner through
// files in its control dir (`<cache>/codex-mod/runs/<session>-<agent>-<n>/`,
// created mode 0700 at launch since steer files carry prompt text, pruned
// with the records): `steer-<id>.json` and `interrupt`.
//
// Steer (app-server only): a user/coordinator message that arrives while the
// run is active is written as a steer file instead of being queued; an
// accepted steer counts as that message's launch, a rejected one (or one never
// acked) runs after the handback, as an exec follow-up does. Messages are
// looked for at each step and, while a step waits on the runner, every 2 s.
// A coordinator's SendMessage into a running turn is no user row: the engine
// appends it as a `queued_command` attachment rendered as a reminder block
// ("The coordinator sent a message while you were working: ...") and promotes
// it to a system turn, so `$.session.messages` never shows it. The
// `session.append` hook records those deliveries per agent (in memory) and the
// next look for messages takes them; a delivery that does reach the API form
// as a user text block (bare or wrapped) is read there as a message instead.
// What became of a mid-run message is shown as a `↪` note: a text line in the
// run's queue (before the next step's calls, or streamed when nativeActions is
// off), never in place of Codex's own final answer, which it precedes.
//
// Budget: a hook's budget (10 s of its own time per step) stops only while a
// `$` call OF THAT STEP is in flight. So every step pulls the child's stream
// itself (`run.child.next()`), and no pull is ever left pending across a step
// boundary. The 2 s check of an app-server run races the step's one pending
// pull with a `$.clock.after` timer and waits on that same pull again; it is
// skipped when `next.budget` runs low, and the pull always settles in the step.
//
// Kill behaviour: the child lives until its stream ends or is `return()`ed.
// It is killed when `next.signal` of any step aborts (interrupt, stop), when a
// step sees the agent is no longer running, when the agent's turn completes
// while a run is still active, when `timeoutMinutes` elapses, and when the
// module unloads (the engine kills every spawn of an unloaded module). An
// app-server run is first asked to stop (`interrupt` file) and given 1.5 s.
//
// Continuity: one record per agent `{ thread, model, effort, sandbox,
// lastTask, agentName, handedBack, handback, lastAnswer, handbackLock,
// userCount, launch-guard counters, runSeq, updatedAt }`, kept in memory and
// in `$.store` under `agent:<sessionId>:<agentId>`, so it survives a
// hooks-worker restart, a hot reload and a `--resume`. Records not updated for
// `pruneDays` are pruned at session start/end. A not-active handback memo lives
// under `session:<sessionId>:handback` in the same store with the same pruning.
//
// Drift: lines of an unknown type (or not JSON) are counted; a run that ends
// with no agent message and some of them fails as "protocol changed" with the
// codex-cli version session start read (`codex --version`; below 0.163.0 is
// warned about once). A non-openai `model_provider` in config.toml makes a
// failing `codex login status` a debug note instead of the logged-out blocker.
//
// Lean launches (userConfig `lean`, default on): `-c` overrides that turn off
// Codex plugins, apps, skills instructions, web search, multi-agent and the
// other tool families a worker does not need, plus every MCP server named in
// `<CODEX_HOME>/config.toml` (read only, never written).
//
// Global rules (userConfig `globalRules`, default on): when off (experimental),
// Codex runs with CODEX_HOME set to a plugin-owned folder holding symbolic
// links to the real home's auth.json, config.toml and models_cache.json only,
// so the user-level AGENTS.md is not loaded. Nothing in the real home is
// written or deleted by this module.

import type {
  BuiltinToolResults,
  EngineInterface,
  HookStream,
  ProcessSpawnChunk,
  ProcessSpawnResult,
  Register,
  SessionMessage,
  Timer,
  TurnStepChunk,
  TurnStepInput,
  TurnStepResult,
} from 'claude-code'

const FALLBACK_MODEL = 'gpt-6.1-sol'
const FALLBACK_EFFORT = 'medium'
const SANDBOXES = ['read-only', 'workspace-write', 'danger-full-access']
const OVERRIDE = /^\s*codex-(model|effort):[ \t]*(\S+)[ \t]*\n/i
// A reminder block; an attachment's rendering puts an id on BOTH tags (`<system-reminder id="x">...</system-reminder id="x">`).
const REMINDER = /<system-reminder(?:\s[^>]*)?>[\s\S]*?<\/system-reminder(?:\s[^>]*)?>/g
const REMINDER_WRAP = /^<system-reminder(?:\s[^>]*)?>\s*([\s\S]*?)\s*<\/system-reminder(?:\s[^>]*)?>$/
// A compaction summary or continuation notice standing as the newest user row.
const COMPACTION = /^\s*This session is being continued from a previous conversation|<\/?compact[-_]summary>/i
// The engine's framing of a message the coordinator sent mid-run.
const COORDINATOR = /^\s*The coordinator sent a message while you were working:[ \t]*\n([\s\S]*?)\s*(?:\n\s*Address this before completing your current task\.?)?\s*$/
// Any mention of the tool in the agent's conversation (meta or not, any role): tool mode.
const HANDBACK_MENTION = /SubagentHandback/
// The engine's nudge after a final text when SubagentHandback is active: tool mode for good.
const ENFORCE = /^\s*\[handback-send-enforce\]/
// The engine taking SubagentHandback away from the agent: text mode.
const COUNTERMAND = /SubagentHandback is not available in this run/i
// A SubagentHandback result saying nothing was sent because the tool is not the agent's.
const NOT_ACTIVE = /not active for this agent|is not available in this run|No such tool available/i
// An engine notice line at the edge of a user row: `[some-tag] ...` or a whole `[Sentence ...]` line.
const NOTICE_LINE = /^\s*(?:\[[a-z]+(?:-[a-z]+)+\][^\n]*|\[[A-Z][^\n\]]{15,}\])\s*$/
// The launch window of the anti-loop guard (`maxRunsPerWindow` launches per agent at most).
const WINDOW_MS = 10 * 60 * 1000
// The most re-deliveries of a stored answer without a new message (each costs no Codex run).
const MAX_REDELIVER = 6
// After SLOW_AFTER action steps, at most one per max(SLOW_MS, progressIntervalMs);
// past MAX_ACTION_STEPS actions are only counted (maxTurns is 400: each step is a turn).
const SLOW_AFTER = 60
const SLOW_MS = 5000
const MAX_ACTION_STEPS = 300
// What one action shows at most: a command's output, a file's content.
const OUTPUT_MAX = 30000
const FILE_MAX = 100000
const STORE_PREFIX = 'agent:'
const SESSION_PREFIX = 'session:'
const DAY_MS = 24 * 60 * 60 * 1000
// In this host a subagent's result reaches its caller through this tool when
// it is active for the agent; its input is `{ message }`.
const HANDBACK_TOOL = 'SubagentHandback'
/** Every tool_use id this module mints starts with it. */
export const ID_PREFIX = 'toolu_codexmod_'
/** The built-in tools Codex's actions are drawn as; never executed for a Codex agent. */
export const NATIVE_TOOLS = ['Bash', 'Edit', 'Write', 'WebSearch', 'Agent', 'TodoWrite'] as const
const RICH_TOOLS = new Set<string>(['Agent', 'TodoWrite'])
type DisplayTool = 'codex_tool' | 'codex_plan'
const displayTools: Partial<Record<DisplayTool, string>> = {}
const displayNames = new Set(['mcp__codex-mod__codex_tool', 'mcp__codex-mod__codex_plan'])
const dimNotes = new Set<string>()
export const NOT_EXECUTED = 'codex-mod: not executed'
// Feature flags a lean launch turns off (`-c features.<name>=false`; an
// unknown name is ignored by Codex).
const LEAN_FEATURES = [
  'plugins', 'remote_plugin', 'apps', 'multi_agent', 'image_generation', 'computer_use', 'browser_use',
  'browser_use_external', 'in_app_browser', 'goals', 'tool_suggest', 'skill_search', 'sleep_tool',
]
// What a shadow CODEX_HOME links from the real one (globalRules off). Sessions
// stay in the shadow, so `exec resume` works there (verified on codex-cli 0.163).
export const SHADOW_LINKS = ['auth.json', 'config.toml', 'models_cache.json'] as const
// `-c` keys extraConfig may not set: the plugin sets them per agent.
const RESERVED_KEYS = ['model', 'model_reasoning_effort', 'sandbox_mode']
/** Where Codex is commonly installed, tried after PATH (`~` is the home folder). */
export const CODEX_CANDIDATES = [
  '/opt/homebrew/bin/codex',
  '/usr/local/bin/codex',
  '~/.local/bin/codex',
  '~/.npm-global/bin/codex',
  '~/.bun/bin/codex',
  '~/.volta/bin/codex',
  '/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex',
  '/Applications/Codex.app/Contents/Resources/codex',
]
/** Where node is commonly installed, tried after PATH (app-server transport). */
export const NODE_CANDIDATES = ['/opt/homebrew/bin/node', '/usr/local/bin/node', '/usr/bin/node']
/** The sidecar, under the plugin root, and the protocol version its `--version` prints. */
const RUNNER = 'scripts/codex-runner.mjs'
const RUNNER_PROTOCOL = '1'
/** The oldest codex-cli this module was verified on (a pre-release of it counts as it). */
const MIN_CODEX = [0, 163, 0] as const
/** The `type`s `codex exec --json` prints (codex-cli 0.163); any other counts as drift. */
const EXEC_TYPES = ['thread.started', 'turn.started', 'turn.completed', 'turn.failed', 'item.started', 'item.updated', 'item.completed', 'error']
// While a step waits on an app-server run, new messages are looked for this
// often, as long as the step's budget keeps MID_STEP_RESERVE_MS.
const MID_STEP_MS = 2000
const MID_STEP_RESERVE_MS = 4000
// How long an interrupted app-server run gets to end before it is killed.
const INTERRUPT_GRACE_MS = 1500

// ---- roles -----------------------------------------------------------------

type Profile = { model: string; effort: string; sandbox: string }
type ProjectRole = Profile & { description: string; instructions?: string }
const PROJECT_FILE = '.claude/codex-mod.json'

/** Validates an untrusted project file without I/O; catalog checks happen at registration. */
export function parseProjectRoles(text: string, { allowFullAccess = false } = {}): { roles: Record<string, ProjectRole>; warnings: string[]; invalid?: true } {
  const roles: Record<string, ProjectRole> = Object.create(null)
  const warnings: string[] = []
  const object = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return { roles, warnings: ['invalid JSON; project roles ignored'], invalid: true }
  }
  if (!object(parsed) || !object(parsed.roles)) {
    return { roles, warnings: ['expected an object with a roles object; project roles ignored'], invalid: true }
  }
  const unknown = (o: Record<string, unknown>, keys: string[], where: string) => {
    for (const k of Object.keys(o)) if (!keys.includes(k)) warnings.push(`${where}: unknown key ${JSON.stringify(k)} ignored`)
  }
  unknown(parsed, ['roles'], 'project')
  const entries = Object.entries(parsed.roles)
  if (entries.length > 16) warnings.push('at most 16 roles allowed; extra roles skipped')
  for (const [name, value] of entries.slice(0, 16)) {
    const bad = (why: string) => warnings.push(`role ${JSON.stringify(name)} skipped: ${why}`)
    if (!/^[a-z][a-z0-9-]{0,31}$/.test(name) || name === 'codex') {
      bad('invalid or reserved name')
      continue
    }
    if (!object(value)) {
      bad('expected an object')
      continue
    }
    unknown(value, ['model', 'effort', 'sandbox', 'description', 'instructions'], `role ${name}`)
    const { model, effort, description, instructions } = value
    const sandbox = value.sandbox === undefined ? 'workspace-write' : value.sandbox
    if (typeof model !== 'string' || model.trim() === '' || typeof effort !== 'string' || effort.trim() === '' || typeof description !== 'string') {
      bad('model, effort and description must be strings (model and effort nonempty)')
      continue
    }
    if (description.length > 600 || (instructions !== undefined && (typeof instructions !== 'string' || instructions.length > 2000))) {
      bad('description must be at most 600 chars; instructions must be a string of at most 2000 chars')
      continue
    }
    if (typeof sandbox !== 'string' || !SANDBOXES.includes(sandbox)) {
      bad('invalid sandbox')
      continue
    }
    if (sandbox === 'danger-full-access' && !allowFullAccess) {
      bad('danger-full-access requires the user-level allowProjectFullAccess option')
      continue
    }
    roles[name] = { model, effort, sandbox, description, ...(instructions !== undefined ? { instructions } : {}) }
  }
  return { roles, warnings }
}
const GENERIC_SUMMARY = 'Delegates the task to OpenAI Codex (codex exec) running locally in the session\'s working directory. Use for a self-contained coding or research task you want done by Codex rather than Claude. The prompt is sent to Codex verbatim.'
const PLACEHOLDER_PROMPT = 'You are a placeholder. The codex-mod plugin answers this agent\'s turns with OpenAI Codex and no Anthropic request is sent. If you are reading this, the plugin\'s turn.step hook did not run: reply with exactly "codex-mod: hook not active; no Codex run was made." and nothing else. Do not call any tool.'

// ---- options -----------------------------------------------------------------

export type HandbackMode = 'auto' | 'tool' | 'text'
export type FooterMode = 'full' | 'short' | 'off'
export type Transport = 'exec' | 'app-server'

export type Config = {
  /** The userConfig override, if any. */
  codexOverride?: string
  /** What is launched: the override, else what session start resolved, else `codex` on PATH. */
  codexPath?: string
  lean: boolean
  globalRules: boolean
  generic: Profile
  projectRoles: boolean
  allowProjectFullAccess: boolean
  extraConfig: string[]
  intervalMs: number
  maxActionsPerStep: number
  handbackMode: HandbackMode
  footer: FooterMode
  /** Kill a run after this long; 0: never. */
  timeoutMs: number
  /** Launch guard: the most Codex launches per agent in WINDOW_MS. */
  maxRunsPerWindow: number
  nativeActions: boolean
  richRows: boolean
  ttlMs: number
  /** What a run is launched with; `app-server` falls back to exec when its checks fail. */
  transport: Transport
  /** The userConfig node override (app-server transport), if any. */
  nodeOverride?: string
  /** Option values that were refused (the default was used), for the debug log. */
  warnings: string[]
}

/** Validates the userConfig values; a refused value falls back to its default with a warning. */
export function parseConfig(raw: unknown): Config {
  const o = (raw ?? {}) as Record<string, unknown>
  const warnings: string[] = []
  const bad = (k: string, why: string) => warnings.push(`${k}: ${why}; default used`)
  const str = (k: string, d: string): string => {
    const v = o[k]
    if (v === undefined || v === null || v === '') return d
    if (typeof v !== 'string') return bad(k, 'not a string'), d
    return v.trim()
  }
  const bool = (k: string, d: boolean): boolean => {
    const v = o[k]
    if (v === undefined || v === null) return d
    if (typeof v !== 'boolean') return bad(k, 'not a boolean'), d
    return v
  }
  const int = (k: string, d: number, min: number, max: number): number => {
    const v = o[k]
    if (v === undefined || v === null || v === '') return d
    const n = typeof v === 'string' ? Number(v) : v
    if (typeof n !== 'number' || !Number.isFinite(n) || n < min || n > max) return bad(k, `not a number from ${min} to ${max}`), d
    return Math.round(n)
  }
  const oneOf = <T extends string>(k: string, d: T, allowed: readonly T[]): T => {
    const v = str(k, d)
    if (!(allowed as readonly string[]).includes(v)) return bad(k, `not one of ${allowed.join(', ')}`), d
    return v as T
  }
  const list = (k: string, d: string[]): string[] => {
    const v = o[k]
    if (v === undefined || v === null) return d
    if (typeof v === 'string') return v.split(/[\n,]/).map(s => s.trim()).filter(Boolean)
    if (!Array.isArray(v) || v.some(x => typeof x !== 'string')) return bad(k, 'not a list of strings'), d
    return v.map(s => s.trim()).filter(Boolean)
  }

  const model = str('defaultModel', '')
  if (model !== '' && !/^[\w.:-]+$/.test(model)) bad('defaultModel', 'not a model name')
  const effort = str('defaultEffort', FALLBACK_EFFORT).toLowerCase()
  if (Object.prototype.hasOwnProperty.call(o, 'roles')) warnings.push('roles: removed in 1.2; declare roles in .claude/codex-mod.json')
  const extraConfig = list('extraConfig', []).filter(kv => {
    const m = /^([A-Za-z0-9_.\-"]+)=([\s\S]+)$/.exec(kv)
    if (!m) return warnings.push(`extraConfig: "${kv}" is not key=value; ignored`), false
    if (RESERVED_KEYS.includes(m[1]!)) return warnings.push(`extraConfig: "${m[1]}" is set by the plugin per agent; ignored`), false
    return true
  })
  const codexPath = str('codexPath', '')
  const nodePath = str('nodePath', '')
  return {
    codexOverride: codexPath === '' ? undefined : codexPath,
    codexPath: codexPath === '' ? undefined : codexPath,
    lean: bool('lean', true),
    globalRules: bool('globalRules', true),
    generic: {
      model: model !== '' && /^[\w.:-]+$/.test(model) ? model : '',
      effort: /^[a-z]+$/.test(effort) ? effort : (bad('defaultEffort', 'not an effort name'), FALLBACK_EFFORT),
      sandbox: oneOf('defaultSandbox', 'workspace-write', SANDBOXES),
    },
    projectRoles: bool('projectRoles', true),
    allowProjectFullAccess: bool('allowProjectFullAccess', false),
    extraConfig,
    intervalMs: int('progressIntervalMs', 1000, 0, 60000),
    maxActionsPerStep: int('maxActionsPerStep', 10, 1, 50),
    handbackMode: oneOf<HandbackMode>('handbackMode', 'auto', ['auto', 'tool', 'text']),
    footer: oneOf<FooterMode>('footer', 'full', ['full', 'short', 'off']),
    timeoutMs: int('timeoutMinutes', 0, 0, 1440) * 60000,
    maxRunsPerWindow: int('maxRunsPerWindow', 3, 1, 100),
    nativeActions: bool('nativeActions', true),
    richRows: bool('richRows', false),
    ttlMs: int('pruneDays', 2, 1, 365) * DAY_MS,
    transport: oneOf<Transport>('transport', 'exec', ['exec', 'app-server']),
    nodeOverride: nodePath === '' ? undefined : nodePath,
    warnings,
  }
}

/** Kept per agent between steps, runs, worker restarts and resumes. */
export type AgentRecord = Profile & {
  agentName: string
  thread?: string
  lastTask?: string
  handedBack?: boolean
  // true when the host delivers this agent's report through SubagentHandback
  handback?: boolean
  // the route the conversation last asked for (auto mode): its latest handback signal
  handbackLock?: 'tool' | 'text'
  // the last message handed back (answer + footer), re-delivered on an engine nudge
  lastAnswer?: string
  // re-deliveries of lastAnswer since the last launch
  redeliveries?: number
  // how many genuine user messages the conversation held at the last launch
  userCount?: number
  // launch guard: launch times (ms) in the window, the message of the last
  // launch, the launches for it, and a trip that blocks that message for good
  launches?: number[]
  launchKey?: string
  launchesSinceNew?: number
  guardTrip?: { key: string; reason: string }
  // user messages folded into the turn while a run was active, run next
  followUps?: FollowUp[]
  // app-server runs launched so far: the <n> of each run's control dir
  runSeq?: number
  updatedAt: number
}

/**
 * A user message folded in mid-run: its text and the conversation's genuine
 * message count when it came. A coordinator delivery the transcript carries as
 * an attachment, not a user row (see `deliveries`), also has the row's `uuid`
 * and shares the count of the message it interrupted.
 */
export type FollowUp = { text: string; count: number; uuid?: string }

export type FileChange = { path: string; kind: string }

/** What one `codex exec --json` line means to us. */
export type CodexEvent =
  | { kind: 'message'; text: string }
  | { kind: 'thinking' | 'interim'; text: string }
  | { kind: 'note'; text: string; dim?: true }
  | { kind: 'action'; action: Action; display?: DisplayTool }
  | { kind: 'thread'; id: string }
  | { kind: 'command'; command: string; output: string; exitCode: number | null }
  | { kind: 'fileStart'; changes: FileChange[] }
  | { kind: 'files'; changes: FileChange[] }
  | { kind: 'usage'; input: number; cached: number; output: number }
  | { kind: 'error'; text: string }
  // runner-only lines (app-server transport)
  | { kind: 'turn'; id: string }
  | { kind: 'steer'; id: string; accepted: boolean; reason?: string }
  | { kind: 'protocol'; types: string[] }
  | { kind: 'fatal'; text: string }
  // a line that is not JSON, or of a type `codex exec --json` does not print
  | { kind: 'unknown'; type: string }
  | { kind: 'other' }

type ActionResult = Record<string, unknown> | { type: 'text'; text: string }[]

/** One of Codex's actions as a tool call, and the result it is answered with. */
export type Action = { tool: string; input: Record<string, unknown>; result: ActionResult; isError?: true }

type Usage = { input: number; cached: number; output: number }

const oneLine = (text: string, max = 160): string => {
  const t = text.replace(/\s+/g, ' ').trim()
  return t.length > max ? `${t.slice(0, max - 3)}...` : t
}

const changesOf = (item: any): FileChange[] =>
  Array.isArray(item?.changes)
    ? item.changes.filter((c: any) => typeof c?.path === 'string' && c.path !== '').map((c: any) => ({ path: c.path, kind: String(c.kind ?? 'update') }))
    : []

/**
 * Maps one JSONL line of `codex exec --json` (verified on codex-cli 0.163), or
 * a `codexmod.*` line of the app-server runner.
 */
export function parseCodexLine(line: string, richRows = false, todoWriteAvailable = false): CodexEvent {
  let ev: any
  try {
    ev = JSON.parse(line)
  } catch {
    return { kind: 'unknown', type: 'non-JSON' }
  }
  const type = typeof ev?.type === 'string' ? ev.type : undefined
  if (type?.startsWith('codexmod.')) {
    if (type === 'codexmod.turn' && typeof ev.turn_id === 'string') return { kind: 'turn', id: ev.turn_id }
    if (type === 'codexmod.steer' && (typeof ev.id === 'string' || typeof ev.id === 'number')) {
      return { kind: 'steer', id: String(ev.id), accepted: ev.status === 'accepted', ...(typeof ev.reason === 'string' ? { reason: ev.reason } : {}) }
    }
    if (type === 'codexmod.protocol') {
      const names = (v: unknown, tag: string) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').map(x => `${tag} ${x}`) : [])
      return { kind: 'protocol', types: [...names(ev.unknown_methods, 'method'), ...names(ev.unknown_items, 'item')] }
    }
    if (type === 'codexmod.fatal') return { kind: 'fatal', text: String(ev.message ?? 'runner failed') }
    return { kind: 'other' }
  }
  if (type === undefined || !EXEC_TYPES.includes(type)) return { kind: 'unknown', type: type ?? 'untyped' }
  const item = ev?.item
  if (ev?.type === 'thread.started' && typeof ev.thread_id === 'string') return { kind: 'thread', id: ev.thread_id }
  if (ev?.type === 'item.completed' && item?.type === 'agent_message' && typeof item.text === 'string') {
    return { kind: item.phase === 'commentary' ? 'interim' : 'message', text: item.text }
  }
  if (ev?.type === 'item.completed' && item?.type === 'command_execution') {
    return {
      kind: 'command',
      command: String(item.command ?? ''),
      output: typeof item.aggregated_output === 'string' ? item.aggregated_output : '',
      exitCode: typeof item.exit_code === 'number' ? item.exit_code : null,
    }
  }
  if (ev?.type === 'item.started' && item?.type === 'file_change') return { kind: 'fileStart', changes: changesOf(item) }
  if (ev?.type === 'item.completed' && item?.type === 'file_change') return { kind: 'files', changes: changesOf(item) }
  if (ev.type === 'item.started' || ev.type === 'item.completed' || ev.type === 'item.updated') {
    if (item?.type === 'todo_list' || item?.type === 'plan_update') {
      const steps: { step: string; status: 'pending' | 'in_progress' | 'completed' }[] = item.type === 'todo_list'
        ? (Array.isArray(item.items) ? item.items : []).map((s: any) => ({ step: String(s?.text ?? ''), status: s?.completed ? 'completed' : 'pending' }))
        : (Array.isArray(item.steps) ? item.steps : []).map((s: any) => ({ step: String(s?.step ?? ''), status: s?.status === 'inProgress' ? 'in_progress' : ['pending', 'in_progress', 'completed'].includes(s?.status) ? s.status : 'pending' }))
      const input = { ...(typeof item.explanation === 'string' ? { explanation: item.explanation } : {}), steps }
      if (richRows && todoWriteAvailable) {
        // BuiltinToolInputs['TodoWrite'] requires activeForm on every entry.
        const todos = steps.map(({ step, status }) => ({ content: step, status, activeForm: step }))
        // These are display snapshots of Codex's plan, never the host's todo state.
        const result: BuiltinToolResults['TodoWrite'] = { oldTodos: [], newTodos: todos }
        return { kind: 'action', action: { tool: 'TodoWrite', input: { todos }, result } }
      }
      return { kind: 'action', display: 'codex_plan', action: { tool: 'codex_plan', input, result: [{ type: 'text', text: 'Plan updated by Codex' }] } }
    }
  }
  // Only completed items have reliable queries and tool results. JSON.parse
  // deliberately accepts exec's repeated id keys; rendering never keys on id.
  if (ev.type === 'item.completed') {
    if (item?.type === 'reasoning') {
      const text = Array.isArray(item.summary) ? item.summary.filter((s: unknown) => typeof s === 'string').join('\n\n') : typeof item.text === 'string' ? item.text : ''
      return text.trim() ? { kind: 'thinking', text } : { kind: 'other' }
    }
    if (item?.type === 'web_search') return { kind: 'action', action: webAction(item) }
    if (item?.type === 'mcp_tool_call' || item?.type === 'dynamic_tool_call') {
      const failed = item.error != null || item.status === 'failed' || item.success === false || item.result?.is_error === true || item.result?.isError === true
      const text = typeof item.error?.message === 'string' ? item.error.message : resultText(item.result?.content ?? item.content_items) || (failed ? 'Codex tool call failed (no text output)' : 'Called by Codex (no text output)')
      return {
        kind: 'action', display: 'codex_tool', action: {
          tool: 'codex_tool', input: { server: String(item.server ?? item.namespace ?? 'dynamic'), name: String(item.tool ?? ''), arguments: item.arguments ?? {} },
          result: [{ type: 'text', text }], ...(failed ? { isError: true as const } : {}),
        },
      }
    }
    if (item?.type === 'proposed_plan' && typeof item.text === 'string') return { kind: 'interim', text: `Proposed plan:\n${item.text}` }
    if (item?.type === 'note' && typeof item.text === 'string') return { kind: 'note', text: `↪ ${oneLine(item.text, 300)}`, ...(item.dim === true ? { dim: true as const } : {}) }
    if (item?.type === 'collab_tool_call' || item?.type === 'collabAgentToolCall') {
      const tool = String(item.tool ?? '').replace(/_/g, '').toLowerCase()
      if (tool === 'wait' || tool === 'waitagent') return { kind: 'other' }
      const receivers = item.receiver_thread_ids ?? item.receiverThreadIds
      if (richRows && tool === 'spawnagent') return { kind: 'action', action: spawnAction(item, receivers) }
      const agents = Array.isArray(receivers) ? receivers.join(', ') : 'agent'
      const text = tool === 'spawnagent' ? `Codex spawned an agent: ${oneLine(String(item.prompt ?? ''))}`
        : ['sendinput', 'sendmessage', 'followuptask'].includes(tool) ? `Codex messaged ${agents}`
        : tool === 'closeagent' ? `Codex closed agent ${agents}`
        : tool === 'resumeagent' ? `Codex resumed agent ${agents}`
        : tool === 'interruptagent' ? `Codex interrupted agent ${agents}` : 'Codex listed agents'
      return { kind: 'note', text: `↪ ${oneLine(text, 300)}` }
    }
  }
  if (ev?.type === 'turn.completed' && ev.usage) {
    return {
      kind: 'usage',
      input: Number(ev.usage.input_tokens ?? 0),
      cached: Number(ev.usage.cached_input_tokens ?? 0),
      output: Number(ev.usage.output_tokens ?? 0),
    }
  }
  if (ev?.type === 'turn.failed') return { kind: 'error', text: String(ev.error?.message ?? 'turn failed') }
  if (ev?.type === 'error') return { kind: 'error', text: String(ev.message ?? 'error') }
  return { kind: 'other' }
}

function spawnAction(item: any, receivers: unknown): Action {
  const prompt = typeof item.prompt === 'string' ? item.prompt : ''
  const states = item.agents_states ?? item.agentsStates ?? {}
  const ids = [...new Set<string>([
    ...(Array.isArray(receivers) ? receivers.filter((id): id is string => typeof id === 'string') : []),
    ...Object.keys(states),
  ])]
  const reports = (ids.length ? ids : ['agent']).map(id => {
    const state = states[id]
    const name = state?.name ?? item.name
    const status = typeof state?.status === 'string' ? state.status : String(item.status ?? 'unknown')
    const model = state?.model ?? item.model
    return `${id}${typeof name === 'string' ? ` (${oneLine(name)})` : ''}: ${oneLine(status)}${typeof model === 'string' ? `, model ${oneLine(model)}` : ''}`
  })
  const model = item.model ?? states[ids[0]!]?.model
  // The spawn call is finished, but its Codex child may still be running. A
  // completed display result must not offer continuation of a synthetic host id.
  const result: Extract<BuiltinToolResults['Agent'], { status: 'completed' }> = {
    agentId: `codex-${ids[0] ?? (typeof item.id === 'string' ? item.id : 'agent')}`,
    agentType: 'codex-mod:codex', status: 'completed', prompt, canContinueAgent: false,
    content: [{ type: 'text', text: `Codex reported ${reports.join('; ')}` }],
    ...(typeof model === 'string' ? { resolvedModel: model } : {}),
    // No Claude work occurred; Codex did not report per-spawn usage or timing.
    totalToolUseCount: 0, totalDurationMs: 0, totalTokens: 0,
    usage: {
      input_tokens: 0, output_tokens: 0,
      cache_creation_input_tokens: null, cache_read_input_tokens: null,
      server_tool_use: null, service_tier: null, cache_creation: null,
    },
  }
  return {
    tool: 'Agent',
    // Use only BuiltinToolInputs['Agent'] fields; Codex model names are not Claude models.
    input: { description: oneLine(prompt.split(/\r?\n/)[0]!, 60) || 'Codex sub-agent', prompt, subagent_type: 'codex-mod:codex' },
    result,
  }
}

/** Text content only: image/audio payloads and raw reasoning are never displayed. */
function resultText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.map(c => typeof c?.text === 'string' && ['text', 'inputText'].includes(c.type) ? c.text : '').filter(Boolean).join('\n')
}

function webAction(item: any): Action {
  const a = item.action
  const query = a?.type === 'openPage' ? String(a.url ?? '')
    : a?.type === 'findInPage' ? `${String(a.pattern ?? '')} in ${String(a.url ?? '')}`
    : String(item.query || a?.query || (Array.isArray(a?.queries) ? a.queries.join(', ') : ''))
  let results = item.results
  if (typeof results === 'string') {
    try { results = JSON.parse(results) } catch { results = [] }
  }
  const sources = (Array.isArray(results) ? results : []).filter(r => typeof r?.title === 'string' && typeof r?.url === 'string')
    .map(r => ({ title: r.title, url: r.url, ...(typeof r.snippet === 'string' ? { snippet: r.snippet } : {}) }))
  return {
    tool: 'WebSearch', input: { query },
    result: { query, results: sources.length ? [{ tool_use_id: '', content: sources }] : ['Searched by Codex'], durationSeconds: 0 },
  }
}

/** A coordinator's mid-run message without the engine's framing; other text unchanged. */
export function stripCoordinator(text: string): string {
  const m = COORDINATOR.exec(text)
  return m ? m[1]!.trim() : text
}

/**
 * The coordinator's message when `text` holds the engine's delivery of one
 * sent mid-run as a reminder block (an attachment's rendering, alone or among
 * other blocks); undefined for anything else, a peer session's or a plugin's
 * "sent a message while you were working" included. A bare delivery (no
 * wrapper) is `cleanText`'s to unwrap.
 */
export function coordinatorPayload(text: string): string | undefined {
  for (const block of text.match(REMINDER) ?? []) {
    const inner = REMINDER_WRAP.exec(block.trim())?.[1] ?? ''
    const m = COORDINATOR.exec(inner)
    if (m) return m[1]!.trim()
  }
  return undefined
}

/** Drops engine notice lines (`[handback-send-enforce] ...`, `[Your previous response ...]`) from both edges. */
function stripNotices(text: string): string {
  const lines = text.split('\n')
  while (lines.length > 0 && (lines[0]!.trim() === '' || NOTICE_LINE.test(lines[0]!))) lines.shift()
  while (lines.length > 0 && (lines.at(-1)!.trim() === '' || NOTICE_LINE.test(lines.at(-1)!))) lines.pop()
  return lines.join('\n')
}

/**
 * A user row's text as Codex should read it: reminders, engine notices and the
 * coordinator framing removed; '' for a row that is only engine prose (a
 * system reminder, a nudge such as `[handback-send-enforce]`), never a task.
 */
export const cleanText = (text: string): string => stripCoordinator(stripNotices(text.replace(REMINDER, '')).trim())

/** One block of the agent's conversation, flattened in order. */
export type ConvItem =
  | { role: 'user'; kind: 'text'; text: string }
  | { role: 'user'; kind: 'result'; id: string; text: string; isError: boolean }
  | { role: 'assistant'; kind: 'text'; text: string }
  | { role: 'assistant'; kind: 'use'; id: string; tool: string }

const blockText = (c: unknown): string =>
  typeof c === 'string' ? c : Array.isArray(c) ? c.map(b => (typeof b === 'string' ? b : b?.type === 'text' && typeof b.text === 'string' ? b.text : '')).join('') : ''

/**
 * The Messages API form (`$.session.messages({ agentId, as: "api" })`), which
 * holds every row a request carries, the meta rows included (the host's
 * SubagentHandback reminder, engine nudges, a coordinator's delivery).
 */
export function itemsFromApi(messages: readonly any[]): ConvItem[] {
  const items: ConvItem[] = []
  for (const m of messages) {
    const role = m?.role === 'assistant' ? 'assistant' : m?.role === 'user' ? 'user' : undefined
    if (role === undefined) continue
    const blocks: any[] = typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : Array.isArray(m.content) ? m.content : []
    for (const b of blocks) {
      if (b?.type === 'text' && typeof b.text === 'string') items.push({ role, kind: 'text', text: b.text } as ConvItem)
      else if (role === 'assistant' && b?.type === 'tool_use') items.push({ role, kind: 'use', id: String(b.id ?? ''), tool: String(b.name ?? '') })
      else if (role === 'user' && b?.type === 'tool_result') items.push({ role, kind: 'result', id: String(b.tool_use_id ?? ''), text: blockText(b.content), isError: b.is_error === true })
    }
  }
  return items
}

/** The rows form (SessionMessage). The engine leaves meta rows OUT of it, so it is only the fallback. */
export function itemsFromRows(rows: readonly SessionMessage[]): ConvItem[] {
  const items: ConvItem[] = []
  for (const r of rows) {
    if (r.role === 'assistant') {
      if (r.text !== '') items.push({ role: 'assistant', kind: 'text', text: r.text })
      for (const u of r.toolUses ?? []) items.push({ role: 'assistant', kind: 'use', id: u.tool_use_id, tool: u.tool })
    } else {
      for (const t of r.toolResults ?? []) items.push({ role: 'user', kind: 'result', id: t.tool_use_id, text: String(t.text ?? ''), isError: t.isError === true })
      if (r.text !== '') items.push({ role: 'user', kind: 'text', text: r.text })
    }
  }
  return items
}

/** What a step needs to know of the agent's conversation. */
export type Reading = {
  /** The latest handback signal: a reminder/mention/enforce nudge (tool) or a countermand/not-active result (text). */
  signal?: 'tool' | 'text'
  /** Any failed/not-active handback result, even if later blocks supersede the signal. */
  handbackFailed: boolean
  /** An engine `[handback-send-enforce]` nudge is in the conversation. */
  enforce: boolean
  /** The newest genuine user message (cleaned) and how many genuine user messages there are. */
  latest?: { text: string; count: number }
  /** Tool results after the last assistant block, each with the tool it answers when known. */
  results: { id: string; tool?: string; text: string; isError: boolean }[]
  /** A genuine user message follows those results. */
  textAfterResults: boolean
  /** After the last assistant block, a user row that is only engine prose (a nudge, a reminder). */
  nudged: boolean
}

/** Reads the conversation: handback signals, the newest genuine user message, the trailing tool results. */
export function readConversation(items: readonly ConvItem[]): Reading {
  const toolOf = new Map<string, string>()
  let signal: Reading['signal']
  let handbackFailed = false
  let enforce = false
  let latest: Reading['latest']
  let count = 0
  let results: Reading['results'] = []
  let textAfterResults = false
  let nudged = false
  let sawAssistant = false
  for (const it of items) {
    if (it.role === 'assistant') {
      results = []
      textAfterResults = false
      nudged = false
      sawAssistant = true
      if (it.kind === 'use') toolOf.set(it.id, it.tool)
      else if (HANDBACK_MENTION.test(it.text)) signal = 'tool'
      continue
    }
    if (it.kind === 'result') {
      const tool = toolOf.get(it.id)
      results.push({ id: it.id, tool, text: it.text, isError: it.isError })
      if (tool === HANDBACK_TOOL && (it.isError || NOT_ACTIVE.test(it.text))) {
        signal = 'text'
        handbackFailed = true
      }
      continue
    }
    if (COUNTERMAND.test(it.text)) signal = 'text'
    else if (ENFORCE.test(it.text)) {
      signal = 'tool'
      enforce = true
    }
    else if (HANDBACK_MENTION.test(it.text)) signal = 'tool'
    // a coordinator's delivery rendered as a reminder block is a message, not engine prose
    const text = coordinatorPayload(it.text) ?? cleanText(it.text)
    if (text === '') {
      if (sawAssistant) nudged = true
      continue
    }
    count++
    latest = { text, count }
    if (results.length > 0) textAfterResults = true
  }
  return { signal, handbackFailed, enforce, latest, results, textAfterResults, nudged }
}

type ConversationSource = 'api' | 'rows' | 'denied'

/** A missing signal is evidence for text only in the API form, which preserves meta reminders. */
export function chooseHandback(mode: HandbackMode, source: ConversationSource, signal?: Reading['signal'], lock?: Reading['signal'], sessionInactive = false): boolean {
  if (mode === 'tool') return true
  if (mode === 'text') return false
  return (signal ?? lock ?? (sessionInactive || source === 'api' ? 'text' : 'tool')) === 'tool'
}

/** True for a compaction summary / continuation notice (no flag on the row type). */
export function isCompactionText(text: string): boolean {
  return COMPACTION.test(text)
}

/** Leading `codex-model:` / `codex-effort:` lines, and the task without them. */
export function parseOverrides(task: string): { model?: string; effort?: string; rest: string } {
  const out: { model?: string; effort?: string; rest: string } = { rest: task }
  for (let m = OVERRIDE.exec(out.rest); m; m = OVERRIDE.exec(out.rest)) {
    if (m[1]!.toLowerCase() === 'model') out.model = m[2]!
    else out.effort = m[2]!.toLowerCase()
    out.rest = out.rest.slice(m[0].length)
  }
  return out
}

/** 950 -> "950", 37412 -> "37.4K", 154000 -> "154K", 1250000 -> "1.3M". */
export function compact(n: number): string {
  if (n < 1000) return String(n)
  if (n < 100000) return `${(n / 1000).toFixed(1).replace(/\.0$/, '')}K`
  if (n < 1000000) return `${Math.round(n / 1000)}K`
  return `${(n / 1000000).toFixed(1).replace(/\.0$/, '')}M`
}

/**
 * The footer line of every handback: `codex · gpt-6-luna · low · workspace-write · 3 actions · ... · thread 01a14f50`;
 * an app-server run adds `app-server` (and `N steers`) after the sandbox, a fallback run why it is exec.
 */
export function footer(p: Profile & { agent: string; actions: number; usage?: Usage; thread?: string; transport?: string; steers?: number }, mode: FooterMode = 'full'): string {
  if (mode === 'off') return ''
  if (mode === 'short') return [p.agent, p.model, p.effort].join(' · ')
  const parts = [p.agent, p.model, p.effort, p.sandbox]
  if (p.transport !== undefined) parts.push(p.transport)
  if (p.steers !== undefined && p.steers > 0) parts.push(`${p.steers} steer${p.steers === 1 ? '' : 's'}`)
  parts.push(`${p.actions} action${p.actions === 1 ? '' : 's'}`)
  if (p.usage !== undefined) {
    const fresh = Math.max(0, p.usage.input - p.usage.cached)
    parts.push(`${compact(fresh)} new tokens (${compact(p.usage.cached)} cached, ${compact(p.usage.output)} out)`)
  }
  if (p.thread !== undefined) parts.push(`thread ${p.thread.slice(0, 8)}`)
  return parts.join(' · ')
}

// ---- model catalog -----------------------------------------------------------

export type ModelInfo = { slug: string; efforts: string[]; defaultEffort?: string }

/** The models Codex lists (visibility `list`), by priority, from models_cache.json; undefined when unreadable. */
export function parseModelsCache(json: string): ModelInfo[] | undefined {
  let d: any
  try {
    d = JSON.parse(json)
  } catch {
    return undefined
  }
  if (!Array.isArray(d?.models)) return undefined
  return d.models
    .filter((m: any) => typeof m?.slug === 'string' && m.slug !== '' && m.visibility === 'list')
    .map((m: any, i: number) => ({ m, i, p: typeof m.priority === 'number' ? m.priority : Number.POSITIVE_INFINITY }))
    .sort((a: any, b: any) => a.p - b.p || a.i - b.i)
    .map(({ m }: any) => ({
      slug: m.slug,
      efforts: Array.isArray(m.supported_reasoning_levels)
        ? m.supported_reasoning_levels.map((l: any) => (typeof l === 'string' ? l : l?.effort)).filter((x: unknown): x is string => typeof x === 'string')
        : [],
      defaultEffort: typeof m.default_reasoning_level === 'string' ? m.default_reasoning_level : undefined,
    }))
}

/** Why `model`/`effort` cannot run, given the catalog; undefined when they can (or no catalog is known). */
export function checkProfile(catalog: readonly ModelInfo[] | undefined, model: string, effort: string): string | undefined {
  if (catalog === undefined || catalog.length === 0) return undefined
  const info = catalog.find(m => m.slug === model)
  if (info === undefined) return `model ${model} not available (available: ${catalog.map(m => m.slug).join(', ')})`
  if (info.efforts.length > 0 && !info.efforts.includes(effort)) {
    return `effort ${effort} not supported by ${model} (supported: ${info.efforts.join(', ')})`
  }
  return undefined
}

/** `gpt-a (low|medium), gpt-b (low)`: the catalog as agent descriptions list it. */
export function catalogLine(catalog: readonly ModelInfo[]): string {
  return catalog.map(m => (m.efforts.length > 0 ? `${m.slug} (${m.efforts.join('|')})` : m.slug)).join(', ')
}

// ---- actions ---------------------------------------------------------------

/** Unquotes one shell word (`'a'\''b'`, `"x \"y\""`, `pwd`); undefined if it is not exactly one word. */
function unquoteWord(s: string): string | undefined {
  let out = ''
  let i = 0
  while (i < s.length) {
    const c = s[i]!
    if (c === "'") {
      const j = s.indexOf("'", i + 1)
      if (j < 0) return undefined
      out += s.slice(i + 1, j)
      i = j + 1
    } else if (c === '"') {
      let j = i + 1
      for (;;) {
        if (j >= s.length) return undefined
        const d = s[j]!
        if (d === '\\' && j + 1 < s.length && '"\\$`\n'.includes(s[j + 1]!)) {
          out += s[j + 1]
          j += 2
          continue
        }
        if (d === '"') break
        out += d
        j++
      }
      i = j + 1
    } else if (c === '\\' && i + 1 < s.length) {
      out += s[i + 1]
      i += 2
    } else if (/\s/.test(c)) {
      return undefined
    } else {
      out += c
      i++
    }
  }
  return out
}

/** `/bin/zsh -lc 'mkdir x'` -> `mkdir x`; anything else unchanged. */
export function unwrapShell(command: string): string {
  const m = /^(?:\/usr)?(?:\/bin\/)?(?:ba|z|da)?sh\s+-l?c\s+([\s\S]+)$/.exec(command.trim())
  if (!m) return command
  return unquoteWord(m[1]!.trim()) ?? command
}

const DESCRIBE: Record<string, string> = {
  ls: 'List files', cat: 'Show file contents', head: 'Read the start of a file', tail: 'Read the end of a file',
  nl: 'Show file with line numbers', mkdir: 'Create directory', rm: 'Remove files', cp: 'Copy files', mv: 'Move files',
  touch: 'Create file', rg: 'Search files', grep: 'Search files', find: 'Find files', pwd: 'Show current directory',
  echo: 'Print text', printf: 'Print text', wc: 'Count lines', diff: 'Compare files', chmod: 'Change file mode',
  python: 'Run Python', python3: 'Run Python', node: 'Run Node.js', test: 'Check a condition', which: 'Locate a program',
}

/** A short, active description of a command, as Claude's own Bash calls carry. */
export function describeCommand(command: string): string {
  const words = command.trim().replace(/^cd\s+\S+\s*&&\s*/, '').split(/\s+/)
  const prog = (words[0] ?? '').split('/').pop() ?? ''
  if (prog === 'sed') return words.includes('-i') ? 'Edit file in place' : 'Read part of a file'
  if (['git', 'npm', 'pnpm', 'yarn', 'bun', 'npx', 'cargo', 'go', 'make', 'uv', 'pip', 'swift', 'gh'].includes(prog)) {
    const sub = words.slice(1).find(w => !w.startsWith('-'))
    return sub ? `Run ${prog} ${sub}` : `Run ${prog}`
  }
  return DESCRIBE[prog] ?? (prog ? `Run ${prog}` : 'Run a command')
}

const clipTail = (text: string, max: number): string =>
  text.length > max ? `[... ${text.length - max} earlier characters not shown]\n${text.slice(-max)}` : text
const clipHead = (text: string, max: number): string =>
  text.length > max ? `${text.slice(0, max)}\n[... ${text.length - max} more characters not shown]` : text

/** A finished command as a `Bash` call answered with Codex's output and exit code. */
export function commandAction(command: string, output: string, exitCode: number | null): Action {
  const inner = unwrapShell(command)
  return {
    tool: 'Bash',
    input: { command: inner, description: describeCommand(inner) },
    result: {
      stdout: clipTail(output.replace(/\n$/, ''), OUTPUT_MAX),
      stderr: exitCode !== null && exitCode !== 0 ? `Exit code ${exitCode}` : '',
      interrupted: false,
    },
  }
}

type Hunk = { oldStart: number; oldLines: number; newStart: number; newLines: number; lines: string[] }

/** The changed region of `before` -> `after` as Edit's old/new strings and one hunk (3 lines of context). */
export function diffEdit(before: string, after: string): { oldString: string; newString: string; hunk: Hunk } | undefined {
  if (before === after || before === '') return undefined
  const a = before.split('\n')
  const b = after.split('\n')
  let p = 0
  while (p < a.length && p < b.length && a[p] === b[p]) p++
  let s = 0
  while (s < a.length - p && s < b.length - p && a[a.length - 1 - s] === b[b.length - 1 - s]) s++
  // a pure insertion: take one neighbouring line in, so old_string is not empty
  if (a.length - s - p === 0) {
    if (p > 0) p--
    else if (s > 0) s--
  }
  const oldMid = a.slice(p, a.length - s)
  const newMid = b.slice(p, b.length - s)
  const pre = a.slice(Math.max(0, p - 3), p)
  const post = a.slice(a.length - s, Math.min(a.length, a.length - s + 3))
  const start = p - pre.length + 1
  return {
    oldString: oldMid.join('\n'),
    newString: newMid.join('\n'),
    hunk: {
      oldStart: start,
      oldLines: pre.length + oldMid.length + post.length,
      newStart: start,
      newLines: pre.length + newMid.length + post.length,
      lines: [...pre.map(l => ` ${l}`), ...oldMid.map(l => `-${l}`), ...newMid.map(l => `+${l}`), ...post.map(l => ` ${l}`)],
    },
  }
}

const shellQuote = (s: string) => (/^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`)

/**
 * One file change as a call: an added file (or an update whose previous text
 * is unknown) as `Write` with its content now; an update with a known
 * previous text as `Edit`; a deletion, or a file that cannot be read as text,
 * as a `Bash` row whose command is a shell comment.
 */
export function fileAction(change: FileChange, rel: string, before: string | undefined, after: string | undefined): Action {
  const path = change.path
  const note = (what: string, description: string): Action => ({
    tool: 'Bash',
    input: { command: `# codex apply_patch: ${what} ${shellQuote(rel)}`, description },
    result: { stdout: '', stderr: '', interrupted: false },
  })
  if (change.kind === 'delete') return note('delete', 'Delete file')
  if (after === undefined || after.includes('\u0000')) return note(change.kind, change.kind === 'add' ? 'Create file' : 'Edit file')
  const edit = change.kind === 'add' || before === undefined ? undefined : diffEdit(before, after)
  if (edit !== undefined && edit.oldString.length <= FILE_MAX && edit.newString.length <= FILE_MAX) {
    return {
      tool: 'Edit',
      input: { file_path: path, old_string: edit.oldString, new_string: edit.newString },
      result: {
        filePath: path,
        oldString: edit.oldString,
        newString: edit.newString,
        originalFile: before!.length <= FILE_MAX ? before! : null,
        structuredPatch: [edit.hunk],
        userModified: false,
        replaceAll: false,
      },
    }
  }
  const content = clipHead(after, FILE_MAX)
  return {
    tool: 'Write',
    input: { file_path: path, content },
    result: {
      type: change.kind === 'add' ? 'create' : 'update',
      filePath: path,
      content,
      structuredPatch: [],
      originalFile: before !== undefined && before.length <= FILE_MAX ? before : null,
    },
  }
}

/** One action as a plain text line (nativeActions off). */
export function actionLine(a: Action): string {
  if (a.tool === 'Edit') return `Edited ${String(a.input.file_path)}`
  if (a.tool === 'Agent') return `Codex spawned an agent: ${oneLine(String(a.input.prompt), 300)}`
  if (a.tool === 'TodoWrite') return `Codex updated plan: ${(a.input.todos as { content: string; status: string }[]).map(t => `[${t.status}] ${oneLine(t.content)}`).join('; ')}`
  if (a.tool === 'WebSearch') return `Searched by Codex: ${oneLine(String(a.input.query), 300)}`
  if ('server' in a.input) return `Codex called ${oneLine(String(a.input.server))}.${oneLine(String(a.input.name))}`
  if ('steps' in a.input) return `Codex updated plan: ${(a.input.steps as { step: string; status: string }[]).map(s => `[${s.status}] ${oneLine(s.step)}`).join('; ')}`
  const result = Array.isArray(a.result) ? {} : a.result
  if (a.tool === 'Write') return `${result.type === 'create' ? 'Created' : 'Wrote'} ${String(a.input.file_path)}`
  const cmd = String(a.input.command)
  if (cmd.startsWith('# codex apply_patch: ')) return `${String(a.input.description)}: ${cmd.slice('# codex apply_patch: '.length).replace(/^\S+\s+/, '')}`
  const err = String(result.stderr ?? '')
  return `$ ${oneLine(cmd, 300)}${err !== '' ? ` (${err.toLowerCase()})` : ''}`
}

// ---- launch ------------------------------------------------------------------

/** The MCP server names declared in a Codex config.toml that can be named in a bare `-c` dotted key. */
export function mcpServerNames(toml: string): string[] {
  const names = new Set<string>()
  for (const line of toml.split('\n')) {
    const m =
      /^\s*\[\s*mcp_servers\.(?:([A-Za-z0-9_-]+)|"([^"]*)")\s*\]\s*(?:#.*)?$/.exec(line) ??
      /^mcp_servers\.(?:([A-Za-z0-9_-]+)|"([^"]*)")\s*=/.exec(line)
    const name = m?.[1] ?? m?.[2]
    // a name a bare key cannot spell is left alone: a quoted -c key would add
    // a second, invalid server and Codex would refuse to load its config
    if (name !== undefined && /^[A-Za-z0-9_-]+$/.test(name)) names.add(name)
  }
  return [...names]
}

const homeDir = async ($: EngineInterface): Promise<string> => ((await $.env.get('HOME')) ?? '').replace(/\/$/, '')
/** The real Codex home: CODEX_HOME, else ~/.codex. Only ever read. */
const codexHome = async ($: EngineInterface): Promise<string> => (await $.env.get('CODEX_HOME')) || `${await homeDir($)}/.codex`

/** The `-c` overrides of a lean launch, MCP servers read from the user's config.toml (read only). */
export async function leanArgs($: EngineInterface): Promise<string[]> {
  const args: string[] = []
  for (const f of LEAN_FEATURES) args.push('-c', `features.${f}=false`)
  args.push('-c', 'web_search="disabled"', '-c', 'skills.include_instructions=false')
  try {
    const toml = await $.fs.read(`${await codexHome($)}/config.toml`)
    for (const name of mcpServerNames(toml)) args.push('-c', `mcp_servers.${name}.enabled=false`)
  } catch (err) {
    $.ui.log(`codex-mod: config.toml not read, MCP servers left as configured: ${errText(err)}`, { to: 'debug' })
  }
  return args
}

/**
 * The plugin-owned CODEX_HOME of a launch without global rules: links to the
 * real home's SHADOW_LINKS only (never AGENTS.md / AGENTS.override.md). Writes
 * only inside the shadow folder; the real home is never written or deleted.
 */
export async function shadowHome($: EngineInterface): Promise<string> {
  const real = (await codexHome($)).replace(/\/$/, '')
  const shadow = `${await cacheDir($)}/home`
  if (shadow === real || shadow.startsWith(`${real}/`)) throw new Error(`shadow folder ${shadow} would be inside the real Codex home`)
  const ok = async (argv: string[]) => {
    const r = await $.process.run(argv, { timeoutMs: 10000 })
    if (r.exitCode !== 0) throw new Error(`${argv.join(' ')}: ${r.stderr.trim().slice(-200)}`)
  }
  await ok(['mkdir', '-p', shadow])
  // instructions a user-level file would add: never in the shadow
  await ok(['rm', '-f', `${shadow}/AGENTS.md`, `${shadow}/AGENTS.override.md`])
  for (const name of SHADOW_LINKS) {
    if (!(await $.fs.exists(`${real}/${name}`))) continue
    const there = await $.fs.stat(`${shadow}/${name}`).catch(() => undefined)
    // a regular file here means Codex replaced the link (a token refresh, say): keep it
    if (there !== undefined && !there.isLink) {
      $.ui.log(`codex-mod: ${shadow}/${name} is no longer a link to the real Codex home; left as is`, { to: 'debug' })
      continue
    }
    await ok(['ln', '-sfn', `${real}/${name}`, `${shadow}/${name}`])
  }
  return shadow
}

/** The argv of one launch (pure). */
export function launchArgv(p: {
  codex: string
  prof: Profile
  cwd: string
  resume?: string
  lean: string[]
  extra: readonly string[]
}): string[] {
  const { prof, resume } = p
  return [
    p.codex, 'exec', ...(resume ? ['resume'] : []), '--json', '--skip-git-repo-check',
    ...(resume ? ['-c', `sandbox_mode="${prof.sandbox}"`] : ['--sandbox', prof.sandbox, '-C', p.cwd]),
    '-m', prof.model, '-c', `model_reasoning_effort="${prof.effort}"`, ...p.lean,
    ...p.extra.flatMap(kv => ['-c', kv]),
    ...(resume ? [resume] : []), '-',
  ]
}

/**
 * The argv of one app-server launch (pure): node running the runner, the same
 * profile and overrides as `launchArgv` (`--config` for each `-c`), the prompt on stdin.
 */
export function runnerArgv(p: {
  node: string
  runner: string
  codex: string
  prof: Profile
  cwd: string
  resume?: string
  lean: string[]
  extra: readonly string[]
  control: string
}): string[] {
  const overrides = [...p.lean.filter((_, i) => p.lean[i - 1] === '-c'), ...p.extra]
  return [
    p.node, p.runner, 'run', '--codex', p.codex, '--cwd', p.cwd,
    '--model', p.prof.model, '--effort', p.prof.effort, '--sandbox', p.prof.sandbox,
    ...(p.resume ? ['--thread', p.resume] : []),
    ...overrides.flatMap(kv => ['--config', kv]),
    '--control', p.control,
  ]
}

/** `codex-cli 0.163.0-alpha.10.2` -> `0.163.0-alpha.10.2`; undefined when no version is in the text. */
export function parseCodexVersion(text: string): string | undefined {
  return /(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/.exec(text)?.[1]
}

/** True when `version` is below MIN_CODEX (its pre-release tag is ignored: 0.163.0-alpha counts as 0.163.0). */
export function codexTooOld(version: string): boolean {
  const n = version.split('-')[0]!.split('.').map(Number)
  for (let i = 0; i < MIN_CODEX.length; i++) {
    if ((n[i] ?? 0) !== MIN_CODEX[i]) return (n[i] ?? 0) < MIN_CODEX[i]!
  }
  return false
}

/** The top-level `model_provider` of a Codex config.toml (before any table), undefined when unset. */
export function modelProvider(toml: string): string | undefined {
  for (const line of toml.split('\n')) {
    if (/^\s*\[/.test(line)) return undefined
    const m = /^\s*model_provider\s*=\s*(?:"([^"]*)"|'([^']*)'|([A-Za-z0-9_.-]+))\s*(?:#.*)?$/.exec(line)
    if (m) return m[1] ?? m[2] ?? m[3]
  }
  return undefined
}

/** The plugin's cache folder (XDG_CACHE_HOME, else ~/.cache), `<cache>/codex-mod`. */
const cacheDir = async ($: EngineInterface): Promise<string> =>
  `${((await $.env.get('XDG_CACHE_HOME')) || `${await homeDir($)}/.cache`).replace(/\/$/, '')}/codex-mod`

/** Where app-server runs keep their control dirs. */
const runsDir = async ($: EngineInterface): Promise<string> => `${await cacheDir($)}/runs`

// ---- state -----------------------------------------------------------------

/** The `$.store` key of an agent's record. */
export const recordKey = (sessionId: string, agentId: string): string => `${STORE_PREFIX}${sessionId}:${agentId}`
const sessionHandbackKey = (sessionId: string): string => `${SESSION_PREFIX}${sessionId}:handback`

// `note`: a `↪` line of ours about a mid-run message; shown like a message, but
// never standing in for Codex's final answer.
type Queued = { kind: 'text' | 'note' | 'interim' | 'thinking'; text: string; dim?: true } | { kind: 'action'; action: Action }

/** The `↪` line shown for a mid-run message: what codex-mod did with it. */
export function steerNote(what: 'accepted' | 'finished' | 'queued', text = ''): string {
  if (what === 'accepted') return `↪ steer delivered to Codex mid-turn: "${oneLine(parseOverrides(text).rest, 80)}"`
  if (what === 'finished') return '↪ Codex had already finished; this message runs next, on the same thread'
  return '↪ queued: runs after this turn (exec transport has no mid-turn steer)'
}

/** One Codex child and what has been read from it so far. */
type Run = {
  agentId: string
  name: string
  prof: Profile
  cwd: string
  child: HookStream<ProcessSpawnChunk, ProcessSpawnResult>
  thread?: string
  buffered: string
  stderrTail: string
  // every agent message, in order
  texts: string[]
  errors: string[]
  usage?: Usage
  // what the next steps show, in order: interim messages and finished actions
  queue: Queued[]
  // file text as last seen, for Edit's old/new strings
  snapshots: Map<string, string>
  actions: number
  actionSteps: number
  lastEmit: number
  ended: boolean
  killed: boolean
  timedOut: boolean
  timer?: Timer
  // the report goes through SubagentHandback (else: final text)
  handback: boolean
  // text shown before this run's first block (a previous run's answer, text mode)
  carry?: string
  // follow-up user messages folded into the turn while this run was active
  followUps: FollowUp[]
  // what launched it; app-server runs have a control dir
  transport: Transport
  control?: string
  // the footer's word for the transport (app-server, or why it is exec)
  transportNote?: string
  // the runner's turn id, once the turn started (app-server)
  turnId?: string
  // messages written as steer files and not acked yet; accepted steers
  pendingSteers: FollowUp[]
  steers: number
  // the exec run's "queued" note was shown (once per run)
  queuedNoted?: boolean
  // the one pull in flight, shared by the step and an interrupt's drain
  pull?: Promise<IteratorResult<ProcessSpawnChunk, ProcessSpawnResult>>
  // drift evidence: unknown lines, their first types; the runner's fatal line
  unknown: number
  unknownTypes: string[]
  fatal?: string
}

/** What session start found for the app-server transport: the launch, or why runs fall back to exec. */
type AppServer = { node: string; runner: string } | { why: string }

// agentId -> profile name (undefined: not ours). An agent's type never changes.
const known = new Map<string, string | undefined>()
// agentId -> its record (mirrors `$.store`).
const records = new Map<string, AgentRecord>()
// agentId -> the active Codex run.
const runs = new Map<string, Run>()
// agentId -> coordinator messages delivered mid-run that the transcript keeps
// as attachments (door `attachment`, a `queued_command` rendered as a reminder
// block, role system), which `$.session.messages` does not carry as user rows:
// `session.append` records them here, the next look for messages takes them.
// In memory only: a hooks-worker restart loses one not taken yet.
const deliveries = new Map<string, { uuid: string; text: string }[]>()
const MAX_DELIVERIES = 20
// tool_use id -> the answer of one action call this module emitted.
const answers = new Map<string, { agentId: string; tool: string; result: ActionResult; isError?: true }>()
let seq = 0
// Set by session.start when Codex is missing or logged out.
let preflight: string | undefined
// The models Codex lists; undefined: not read yet; null: unreadable (nothing validated).
let catalog: ModelInfo[] | null | undefined
// The config of the loaded module (set by register).
let cfg: Config = parseConfig({})
// Unavailable until registration confirms the session offers it; guards stay on.
let todoWriteAvailable = false
// Session-start snapshot, refreshed only when registration is retried, never on cwd changes.
let projectRoles = new Map<string, ProjectRole>()
const projectNotified = new Set<string>()
// False after a session start whose agent registration failed: retried once on the next main-loop step.
let agentsReady = true
// The app-server transport as checked (session start, else the first launch); undefined: not checked.
let appServer: AppServer | undefined
// The codex-cli version session start read; undefined: unknown.
let codexVersion: string | undefined
// The old-version warning is shown once per module load.
let versionWarned = false
// A step's signal -> what is left of its budget (read live from its `next.budget`).
const budgets = new WeakMap<AbortSignal, () => number>()

/** True when the loop is an agent this module answers (known from its first step). */
const isCodexAgent = (agentId: unknown): boolean => typeof agentId === 'string' && known.get(agentId) !== undefined
const hasPrefix = (id: unknown): boolean => typeof id === 'string' && id.startsWith(ID_PREFIX)
// Guard rich tools even when disabled, including stale calls after a worker restart.
const isNative = (tool: unknown): boolean => (NATIVE_TOOLS as readonly unknown[]).includes(tool)
const isDisplay = (tool: unknown): boolean => typeof tool === 'string' && displayNames.has(tool)
/** A display call this module must answer or refuse: never one the engine may run. */
const guarded = (e: { tool?: unknown; tool_use_id?: unknown; agentId?: unknown }): boolean =>
  isDisplay(e.tool) || (isNative(e.tool) && (hasPrefix(e.tool_use_id) || isCodexAgent(e.agentId)))
/** A built-in display call of a subagent whose type is not resolved yet. */
const unresolved = (e: { tool?: unknown; agentId?: unknown }): boolean =>
  isNative(e.tool) && typeof e.agentId === 'string' && !known.has(e.agentId)

/** The answer to a guarded call: the stored result of our own action, else a refusal. Never runs anything. */
export function answerGuarded(e: { tool?: unknown; tool_use_id?: unknown; agentId?: unknown }): { result: ActionResult; isError?: true } | { deny: string } {
  const id = typeof e.tool_use_id === 'string' ? e.tool_use_id : ''
  const held = hasPrefix(id) ? answers.get(id) : undefined
  // e.tool is the dispatch name, distinct from codex_tool's input.name.
  if (held === undefined || held.agentId !== e.agentId || held.tool !== e.tool || !isCodexAgent(e.agentId)) {
    return { deny: `${NOT_EXECUTED} (${String(e.tool)} is display-only for Codex agents; only a stored Codex result can answer this call)` }
  }
  answers.delete(id)
  return { result: held.result, ...(held.isError ? { isError: true as const } : {}) }
}

/** The profile of an agent type name; undefined for a name this module does not define. */
const profileOf = (name: string): Profile | undefined => {
  if (name === 'codex') return { ...cfg.generic }
  const role = projectRoles.get(name)
  return role === undefined ? undefined : { model: role.model, effort: role.effort, sandbox: role.sandbox }
}

/** Shared by launches and live steers; instructions never enter task records or rendered notes. */
const roleTask = (name: string, text: string): string => {
  const instructions = projectRoles.get(name)?.instructions
  return instructions ? `${instructions}\n\n${text}` : text
}

export const register: Register = (on, options) => {
  cfg = parseConfig(options)
  const config = cfg

  on('session.start', async ($, e, next) => {
    for (const w of config.warnings) $.ui.log(`codex-mod: option ${w}`, { to: 'debug' })
    await pruneRecords($, config.ttlMs)
    await pruneRuns($, config.ttlMs)
    await loadCatalog($, true)
    config.codexPath = config.codexOverride ?? (await findCodex($))
    preflight = await checkCodex($, config.codexPath ?? 'codex')
    if (preflight === undefined) {
      $.ui.log(`codex-mod: Codex ready (${config.codexPath})`, { to: 'debug' })
    } else {
      const text = `codex-mod: ${preflight}`
      $.ui.log(text, { to: 'debug' })
      const sent = await $.ui.notify(text).catch(() => ({ isSent: false as const }))
      if (!sent.isSent) $.ui.toast(text, { timeoutMs: 10000 })
    }
    if (codexVersion !== undefined && codexTooOld(codexVersion) && !versionWarned) {
      versionWarned = true
      const text = `codex-mod: codex-cli ${codexVersion} is older than ${MIN_CODEX.join('.')}, the version this plugin was verified on; runs may fail`
      $.ui.log(text, { to: 'debug' })
      await $.ui.notify(text).catch(() => undefined)
    }
    appServer = undefined
    if (config.transport === 'app-server') appServer = await checkAppServer($, config)
    await registerDisplayTools($)
    agentsReady = await registerAgents($, config)
    return next(e)
  })

  // Pruning only: a running child dies with the module (process exit) or with
  // its agent's turn (turn.complete below); a /clear also ends the session.
  on('session.end', async ($, e, next) => {
    await pruneRecords($, config.ttlMs)
    await pruneRuns($, config.ttlMs)
    return next(e)
  })

  // GUARD 1. Built-in display calls of a Codex agent, or carrying our id
  // prefix, are answered here and never reach `next` (no permission path, no
  // tool run): our own action calls get the result Codex reported, anything
  // else is refused. A subagent not seen yet (after a worker restart, say) has
  // its type resolved first; if that fails, `.catch` refuses the call.
  on('tool.call', async ($, e, next) => {
    if (guarded(e)) return answerGuarded(e) as never
    if (unresolved(e) && (await agentName($, e.agentId!)) !== undefined) return answerGuarded(e) as never
    return next(e)
  }).catch(($, e, next) => (next.called ? next(e) : guarded(e) || unresolved(e) ? { deny: NOT_EXECUTED } : next(e)))

  // GUARD 2. `tool.check` runs inside `tool.call`'s `next`, which guard 1
  // never calls for these calls; reaching it means guard 1 was bypassed, so
  // the verdict is deny, whatever the id.
  on('tool.check', async ($, e, next) => {
    if (unresolved(e)) await agentName($, e.agentId!)
    return guarded(e) ? { decision: 'deny' as const, reason: NOT_EXECUTED } : next(e)
  }).catch(($, e, next) => (next.called ? next(e) : guarded(e) || unresolved(e) ? { decision: 'deny' as const, reason: NOT_EXECUTED } : next(e)))

  on('ui.render', { component: 'AssistantMessage' }, ($, e, next) => {
    if (!dimNotes.has(e.props.text)) return next(e)
    return $.ui.resolve(e).Text({ dimColor: true, children: e.props.text })
  }).catch(($, e, next) => next(e))

  // A coordinator's message delivered into an agent's running turn is an
  // attachment row (`queued_command`), promoted to a system turn in the
  // request, so the conversation read never shows it: it is recorded here, as
  // the row is appended, for the next look for messages. Always relayed as is.
  on('session.append', async ($, e, next) => {
    // only the doors a delivery comes in by: a prompt row the API form carries is read there
    if (e.agentId !== undefined && (e.door === 'attachment' || e.door === 'delivery')) {
      const text = coordinatorPayload(rowText(e.message.content))
      if (text !== undefined && text !== '') {
        const list = deliveries.get(e.agentId) ?? []
        if (!list.some(d => d.uuid === e.uuid)) list.push({ uuid: e.uuid, text })
        deliveries.set(e.agentId, list.slice(-MAX_DELIVERIES))
        $.ui.log(`codex-mod: agent ${e.agentId}: coordinator message delivered mid-run (${e.door}${e.message.name ? ` ${e.message.name}` : ''}, row ${e.uuid})`, { to: 'debug' })
      }
    }
    return next(e)
  }).catch(($, e, next) => (next.called ? next(e) : next(e)))

  // A turn that ends while its Codex run is still active (interrupted, an
  // error, maxTurns reached) kills the child.
  on('turn.complete', async ($, e, next) => {
    const run = e.agentId === undefined ? undefined : runs.get(e.agentId)
    if (run !== undefined) {
      $.ui.log(`codex-mod: agent ${run.agentId} turn ended (${e.reason}) while Codex ran; killing it`, { to: 'debug' })
      await stopRun($, run)
    }
    // deliveries to an agent that is not ours are nobody's
    if (e.agentId !== undefined && known.has(e.agentId) && known.get(e.agentId) === undefined) deliveries.delete(e.agentId)
    return next(e)
  })

  // A step of one of our agents never reaches the model: if this hook fails,
  // `.catch` ends the step with "codex failed" (it calls no `$`).
  on('turn.step', async function* ($, e, next) {
    if (e.agentId === undefined) {
      if (!agentsReady) {
        agentsReady = true
        await registerAgents($, config)
      }
      return yield* next(e)
    }
    let name: string | undefined
    try {
      name = await agentName($, e.agentId)
    } catch (err) {
      // the type list failed: an agent we ran before is still known by its record
      name = (await loadRecord($, e.agentId))?.agentName
      if (name === undefined) throw err
      known.set(e.agentId, name)
    }
    if (name === undefined) return yield* next(e)
    if (profileOf(name) === undefined && await loadRecord($, e.agentId) === undefined) {
      return yield* failStep(e, name, `codex failed: agent type ${$.plugin.name}:${name} is not declared by this project (.claude/codex-mod.json) or this version of the plugin`, handbackFor(e.agentId, undefined))
    }
    budgets.set(next.signal, () => next.budget.remainingMs)
    return yield* answerWithCodex($, e, next.signal, config, name)
  }).catch(async function* ($, e, next) {
    if (next.called) return yield* next(e)
    const agentId = e.agentId
    const name = agentId === undefined ? undefined : (known.get(agentId) ?? records.get(agentId)?.agentName)
    if (agentId === undefined || name === undefined) return yield* next(e)
    const run = runs.get(agentId)
    if (run !== undefined) void killRun(run)
    const rec = records.get(agentId)
    if (rec !== undefined) rec.handedBack = true
    return yield* failStep(e, name, `codex failed: ${failureText(next.error)}`, handbackFor(agentId, undefined))
  })
}

const errText = (err: unknown) => (err instanceof Error ? err.message : String(err))
const failureText = (f: { kind: string; message?: string }) =>
  f.kind === 'timeout' ? `hook timed out${f.message ? ` (${oneLine(f.message)})` : ''}` : `hook error (${oneLine(f.message ?? f.kind)})`

/** Reads `<CODEX_HOME>/models_cache.json` once (again when `force`); null when unreadable. */
async function loadCatalog($: EngineInterface, force = false): Promise<void> {
  if (catalog !== undefined && !force) return
  try {
    const parsed = parseModelsCache(await $.fs.read(`${await codexHome($)}/models_cache.json`))
    catalog = parsed !== undefined && parsed.length > 0 ? parsed : null
  } catch (err) {
    catalog = null
    $.ui.log(`codex-mod: models_cache.json not read; models and efforts are not validated: ${errText(err)}`, { to: 'debug' })
  }
}

/** Codex on PATH (`which codex`), else the first common install location that exists; undefined: none found. */
export async function findCodex($: EngineInterface): Promise<string | undefined> {
  try {
    const r = await $.process.run(['which', 'codex'], { timeoutMs: 10000 })
    const path = r.stdout.trim().split('\n')[0]?.trim()
    if (r.exitCode === 0 && path) return path
  } catch {
    // no `which`, or PATH is not the shell's: try the usual places
  }
  const home = await homeDir($).catch(() => '')
  for (const c of CODEX_CANDIDATES) {
    const path = c.startsWith('~/') ? `${home}${c.slice(1)}` : c
    if (await $.fs.exists(path).catch(() => false)) return path
  }
  return undefined
}

/**
 * Runs `codex --version` (the version is kept for drift reports) and `codex
 * login status`; the problem, if any. A failing login status is no problem
 * when config.toml names a model_provider other than openai (a debug note).
 */
export async function checkCodex($: EngineInterface, codex: string): Promise<string | undefined> {
  try {
    const v = await $.process.run([codex, '--version'], { timeoutMs: 15000 })
    if (v.exitCode !== 0) return `Codex at ${codex} failed --version (exit ${v.exitCode}): ${v.stderr.trim().slice(-200)}`
    codexVersion = parseCodexVersion(v.stdout)
    const l = await $.process.run([codex, 'login', 'status'], { timeoutMs: 15000 })
    if (l.exitCode !== 0) {
      const why = (l.stderr || l.stdout).trim().slice(-200)
      const provider = await $.fs.read(`${await codexHome($)}/config.toml`).then(t => modelProvider(String(t)), () => undefined)
      if (provider !== undefined && provider !== 'openai') {
        $.ui.log(`codex-mod: codex login status failed (${why}); model_provider is ${provider}, so it is not treated as logged out`, { to: 'debug' })
        return undefined
      }
      return `Codex is not logged in (${why}); run "codex login" or "codex login --device-auth"`
    }
    return undefined
  } catch (err) {
    return `Codex not found or not runnable at ${codex}: ${errText(err)}; install it or set the codexPath option`
  }
}

/** The nodePath option, else node on PATH (`which node`), else the first common install location that exists. */
async function findNode($: EngineInterface, override: string | undefined): Promise<string | undefined> {
  if (override !== undefined) return override
  try {
    const r = await $.process.run(['which', 'node'], { timeoutMs: 10000 })
    const path = r.stdout.trim().split('\n')[0]?.trim()
    if (r.exitCode === 0 && path) return path
  } catch {
    // no `which`, or PATH is not the shell's: try the usual places
  }
  for (const path of NODE_CANDIDATES) {
    if (await $.fs.exists(path).catch(() => false)) return path
  }
  return undefined
}

/**
 * Checks the app-server transport: node, the runner (present, speaking our
 * protocol) and `codex app-server --help`. The launch, or why runs fall back
 * to exec (logged).
 */
async function checkAppServer($: EngineInterface, config: Config): Promise<AppServer> {
  const codex = config.codexPath ?? 'codex'
  const result = await (async (): Promise<AppServer> => {
    try {
      const node = await findNode($, config.nodeOverride)
      if (node === undefined) return { why: 'node not found; set the nodePath option' }
      const runner = `${$.plugin.root.replace(/\/$/, '')}/${RUNNER}`
      if (!(await $.fs.exists(runner))) return { why: `${RUNNER} missing from the plugin` }
      const h = await $.process.run([codex, 'app-server', '--help'], { timeoutMs: 15000 })
      if (h.exitCode !== 0) return { why: `codex app-server --help failed (exit ${h.exitCode})` }
      const v = await $.process.run([node, runner, '--version'], { timeoutMs: 15000 })
      const said = v.stdout.trim().split('\n')[0]?.trim() ?? ''
      if (v.exitCode !== 0) return { why: `runner did not start with ${node} (exit ${v.exitCode}): ${oneLine(v.stderr, 80)}` }
      if (said !== RUNNER_PROTOCOL) return { why: `runner protocol ${oneLine(said, 20) || 'unknown'}, expected ${RUNNER_PROTOCOL}` }
      return { node, runner }
    } catch (err) {
      return { why: oneLine(errText(err), 120) }
    }
  })()
  $.ui.log('why' in result ? `codex-mod: app-server transport unavailable (${result.why}); runs use codex exec` : `codex-mod: app-server transport ready (${result.node} ${result.runner})`, { to: 'debug' })
  return result
}

/** The transport of a launch: exec, app-server (checked once), or exec with why app-server is not used. */
async function transportFor($: EngineInterface, config: Config): Promise<{ transport: 'exec'; note?: string } | { transport: 'app-server'; node: string; runner: string }> {
  if (config.transport === 'exec') return { transport: 'exec' }
  if (appServer === undefined) appServer = await checkAppServer($, config)
  return 'why' in appServer ? { transport: 'exec', note: `exec (app-server unavailable: ${appServer.why})` } : { transport: 'app-server', ...appServer }
}

/** Deletes app-server control dirs not touched for `ttlMs`. */
async function pruneRuns($: EngineInterface, ttlMs: number): Promise<void> {
  try {
    const dir = await runsDir($)
    if (!(await $.fs.exists(dir))) return
    const now = await $.clock.now()
    for (const ent of await $.fs.list(dir)) {
      if (ent.kind !== 'dir') continue
      const st = await $.fs.stat(`${dir}/${ent.name}`)
      if (!(now - st.mtimeMs < ttlMs)) await $.process.run(['rm', '-rf', `${dir}/${ent.name}`], { timeoutMs: 10000 })
    }
  } catch (err) {
    $.ui.log(`codex-mod: run dir prune failed: ${errText(err)}`, { to: 'debug' })
  }
}

/** Reads relative to the session cwd, only at registration; a missing file is normal. */
async function loadProjectRoles($: EngineInterface, config: Config): Promise<void> {
  projectRoles = new Map()
  if (!config.projectRoles) return
  let text: string
  try {
    text = await $.fs.read(PROJECT_FILE)
  } catch {
    // The file is optional; a failed read must leave the generic agent usable.
    return
  }
  const parsed = parseProjectRoles(text, { allowFullAccess: config.allowProjectFullAccess })
  for (const w of parsed.warnings) $.ui.log(`codex-mod: ${PROJECT_FILE}: ${w}`, { to: 'debug' })
  projectRoles = new Map(Object.entries(parsed.roles).filter(([name, role]) => {
    const why = checkProfile(catalog ?? undefined, role.model, role.effort)
    if (why === undefined) return true
    $.ui.log(`codex-mod: role ${name} not registered: ${why}`, { to: 'debug' })
    return false
  }))
  if (parsed.invalid) {
    const sid = await sessionId($)
    if (projectNotified.has(sid)) return
    projectNotified.add(sid)
    const notice = `codex-mod: ${PROJECT_FILE}: ${parsed.warnings[0]}; the generic codex agent is still available`
    const sent = await $.ui.notify(notice).catch(() => ({ isSent: false as const }))
    if (!sent.isSent) {
      try {
        $.ui.toast(notice, { timeoutMs: 10000 })
      } catch {
        // UI availability must not prevent generic agent registration either.
      }
    }
  }
}

/**
 * The API owns full names. These tools have no executor, only the guards above.
 * Inputs must not shadow the host's flat envelope (tool, tool_use_id,
 * agentId, requestMeta, consent) or tool-check fields.
 */
async function registerDisplayTools($: EngineInterface): Promise<void> {
  for (const name of ['codex_tool', 'codex_plan'] as const) {
    if (displayTools[name]) continue
    const tool = name === 'codex_tool'
    const registered = await $.tool.register({
      name,
      description: `Display-only ${tool ? 'tool result' : 'plan update'} drawn for Codex agents. Never call this tool: all other calls are refused and it performs no work.`,
      inputSchema: {
        type: 'object', additionalProperties: false,
        properties: tool ? { server: { type: 'string' }, name: { type: 'string' }, arguments: {} } : {
          explanation: { type: 'string' },
          steps: { type: 'array', items: { type: 'object', additionalProperties: false, properties: { step: { type: 'string' }, status: { enum: ['pending', 'in_progress', 'completed'] } }, required: ['step', 'status'] } },
        },
        required: tool ? ['server', 'name', 'arguments'] : ['steps'],
      },
    })
    displayTools[name] = registered.tool
    displayNames.add(registered.tool)
  }
}

/** Registers the generic agent and each project role whose model Codex lists. */
async function registerAgents($: EngineInterface, config: Config): Promise<boolean> {
  // without the display tools their rows degrade to text; the agents must still register
  await registerDisplayTools($).catch(err => $.ui.log(`codex-mod: display tools not registered: ${errText(err)}`, { to: 'debug' }))
  await loadProjectRoles($, config)
  todoWriteAvailable = false
  if (config.richRows) {
    try {
      todoWriteAvailable = (await $.tool.list()).some(tool => tool.name === 'TodoWrite')
    } catch (err) {
      $.ui.log(`codex-mod: TodoWrite availability unknown (${errText(err)}); plan updates use codex_plan`, { to: 'debug' })
    }
  }
  let failed = false
  const list = catalog ?? undefined
  const models = list !== undefined ? ` Codex models available here: ${catalogLine(list)}.` : ''
  const override = ' Start the prompt with a line "codex-model: <model>" and/or "codex-effort: <effort>" to override the defaults.'
  const specs: { name: string; description: string }[] = []
  const g = config.generic
  specs.push({
    name: 'codex',
    description: `${GENERIC_SUMMARY} Defaults: ${g.model || list?.[0]?.slug || FALLBACK_MODEL} at ${g.effort} reasoning, sandbox ${g.sandbox}.${override}${models}`,
  })
  for (const [name, r] of projectRoles) {
    specs.push({ name, description: `${r.description} Runs OpenAI Codex ${r.model} at ${r.effort} reasoning in a ${r.sandbox} sandbox (declared by this project).${override}${models}` })
  }
  for (const s of specs) {
    try {
      await $.agent.register({
        name: s.name,
        description: s.description,
        prompt: PLACEHOLDER_PROMPT,
        // the tools Codex's actions are drawn as must be the agent's own, or
        // the engine refuses them before the tool.call guard answers them
        tools: ['Read', ...NATIVE_TOOLS.filter(tool => (config.richRows || !RICH_TOOLS.has(tool)) && (tool !== 'TodoWrite' || todoWriteAvailable)), ...Object.values(displayTools)],
        model: 'haiku',
        effort: 'low',
        maxTurns: 400,
        background: true,
        omitClaudeMd: true,
      })
    } catch (err) {
      failed = true
      $.ui.log(`codex-mod: agent ${s.name} not registered: ${errText(err)}`, { to: 'debug' })
    }
  }
  return !failed
}

/**
 * The agent's name under this plugin (any `<plugin>:<name>` type, defined or
 * not), or undefined for another plugin's or a built-in type. Rejects when
 * the agent list cannot be read twice in a row.
 */
async function agentName($: EngineInterface, agentId: string): Promise<string | undefined> {
  if (known.has(agentId)) return known.get(agentId)
  let list
  try {
    list = await $.agent.list()
  } catch {
    list = await $.agent.list()
  }
  const info = list.find(a => a.id === agentId)
  if (info === undefined) {
    // not listed (dropped already): one we ran before still has its record
    return (await loadRecord($, agentId))?.agentName
  }
  const prefix = `${$.plugin.name}:`
  const mine = info.type.startsWith(prefix) ? info.type.slice(prefix.length) : undefined
  known.set(agentId, mine)
  return mine
}

/**
 * Whether this agent's report goes through SubagentHandback: the option, else
 * the conversation's latest signal, else the stored one. Unknown reads still
 * default to the tool; a complete API read without a signal defaults to text.
 */
function handbackFor(agentId: string, signal?: Reading['signal'], source: ConversationSource = 'denied', sessionInactive = false): boolean {
  return chooseHandback(cfg.handbackMode, source, signal, records.get(agentId)?.handbackLock, sessionInactive)
}

/** The agent's conversation, meta rows included (API form), else the rows; `denied` when neither reads. */
async function conversation($: EngineInterface, agentId: string): Promise<{ items: ConvItem[]; source: ConversationSource; denied?: string }> {
  const api = await $.session.messages({ agentId, as: 'api' }).catch(() => undefined)
  if (Array.isArray(api)) return { items: itemsFromApi(api), source: 'api' }
  const rows = await $.session.messages({ agentId })
  if (Array.isArray(rows)) return { items: itemsFromRows(rows), source: 'rows' }
  return { items: [], source: 'denied', denied: rows.deny }
}

/** Old records kept follow-ups as plain strings. */
const followUpsOf = (rec: AgentRecord | undefined): FollowUp[] =>
  (rec?.followUps ?? []).map(f => (typeof f === 'string' ? { text: f, count: rec?.userCount ?? 0 } : f))

/** The text of a row's blocks: API text blocks, or an attachment's recorded rendering (`{ content }`). */
const rowText = (content: unknown): string =>
  typeof content === 'string' ? content : Array.isArray(content) ? content.map(b => (typeof b?.text === 'string' ? b.text : typeof b?.content === 'string' ? b.content : '')).join('\n') : ''

/**
 * The coordinator deliveries recorded for the agent, taken (each once) as
 * follow-ups under `count`, the count of the message they interrupted; one
 * whose text the transcript shows as the newest message anyway is dropped.
 */
function takeDeliveries(agentId: string, count: number, shown?: string): FollowUp[] {
  const list = deliveries.get(agentId)
  if (list === undefined || list.length === 0) return []
  deliveries.delete(agentId)
  return list.filter(d => d.text !== shown).map(d => ({ text: d.text, count, uuid: d.uuid }))
}

/** Two follow-ups are the same message: by row for a delivery, by count for a transcript message. */
const sameFollowUp = (a: FollowUp) => (b: FollowUp) => (a.uuid !== undefined || b.uuid !== undefined ? a.uuid === b.uuid : a.count === b.count)

/** The file id of a steer: the message count, zero-padded so the runner's name order is arrival order; a delivery adds its row id. */
const steerFileId = (f: FollowUp) => (f.uuid === undefined ? steerId(f.count) : `${steerId(f.count)}-${f.uuid.replace(/[^A-Za-z0-9_-]/g, '_')}`)

// ---- records ---------------------------------------------------------------

async function sessionId($: EngineInterface): Promise<string> {
  try {
    const id = await $.session.id()
    if (typeof id === 'string' && id !== '') return id
  } catch {
    // fall through
  }
  return 'nosession'
}

const isRecord = (v: unknown): v is AgentRecord =>
  typeof v === 'object' && v !== null && typeof (v as any).model === 'string' && typeof (v as any).effort === 'string' &&
  typeof (v as any).sandbox === 'string' && typeof (v as any).agentName === 'string'

type HandbackMemo = { handbackLock: 'text'; updatedAt: number }
const isHandbackMemo = (v: unknown): v is HandbackMemo =>
  typeof v === 'object' && v !== null && (v as any).handbackLock === 'text' && typeof (v as any).updatedAt === 'number'

/** A failed handback teaches later agents in this session; explicit agent signals still win. */
async function sessionHandbackInactive($: EngineInterface, failed: boolean): Promise<boolean> {
  try {
    const key = sessionHandbackKey(await sessionId($))
    if (failed) {
      await $.store.set(key, { handbackLock: 'text', updatedAt: await $.clock.now() })
      return true
    }
    return isHandbackMemo(await $.store.get(key))
  } catch (err) {
    $.ui.log(`codex-mod: session handback memo failed: ${errText(err)}`, { to: 'debug' })
    return failed
  }
}

/** The agent's record: memory first, then `$.store` (this session's key, then any session's). */
async function loadRecord($: EngineInterface, agentId: string): Promise<AgentRecord | undefined> {
  const held = records.get(agentId)
  if (held !== undefined) return held
  try {
    const sid = await sessionId($)
    const own = await $.store.get(recordKey(sid, agentId))
    if (isRecord(own)) {
      records.set(agentId, own)
      $.ui.log(`codex-mod: agent ${agentId} record reloaded from the store (thread=${own.thread ?? 'none'})`, { to: 'debug' })
      return own
    }
    // The session id changes on --resume and /clear: find the agent under any.
    let best: { key: string; rec: AgentRecord } | undefined
    for (const key of await $.store.keys()) {
      if (!key.startsWith(STORE_PREFIX) || !key.endsWith(`:${agentId}`)) continue
      const v = await $.store.get(key)
      if (isRecord(v) && (best === undefined || v.updatedAt > best.rec.updatedAt)) best = { key, rec: v }
    }
    if (best !== undefined) {
      records.set(agentId, best.rec)
      await $.store.set(recordKey(sid, agentId), best.rec)
      if (best.key !== recordKey(sid, agentId)) await $.store.delete(best.key)
      $.ui.log(`codex-mod: agent ${agentId} record moved from ${best.key}`, { to: 'debug' })
      return best.rec
    }
  } catch (err) {
    $.ui.log(`codex-mod: store read failed: ${errText(err)}`, { to: 'debug' })
  }
  return undefined
}

async function saveRecord($: EngineInterface, agentId: string, rec: AgentRecord): Promise<void> {
  try {
    rec.updatedAt = await $.clock.now()
  } catch {
    // keep the previous stamp
  }
  records.set(agentId, rec)
  try {
    await $.store.set(recordKey(await sessionId($), agentId), rec)
  } catch (err) {
    $.ui.log(`codex-mod: store write failed: ${errText(err)}`, { to: 'debug' })
  }
}

/** Deletes agent records and session handback memos not updated for `ttlMs` (and malformed ones). */
async function pruneRecords($: EngineInterface, ttlMs: number): Promise<void> {
  try {
    const now = await $.clock.now()
    for (const key of await $.store.keys()) {
      if (!key.startsWith(STORE_PREFIX) && !(key.startsWith(SESSION_PREFIX) && key.endsWith(':handback'))) continue
      const v = await $.store.get(key)
      const valid = key.startsWith(STORE_PREFIX) ? isRecord(v) : isHandbackMemo(v)
      if (!valid || !(now - (v as AgentRecord | HandbackMemo).updatedAt < ttlMs)) await $.store.delete(key)
    }
  } catch (err) {
    $.ui.log(`codex-mod: store prune failed: ${errText(err)}`, { to: 'debug' })
  }
}

// ---- steps -----------------------------------------------------------------

async function* answerWithCodex(
  $: EngineInterface,
  e: TurnStepInput,
  signal: AbortSignal,
  config: Config,
  name: string,
): AsyncGenerator<TurnStepChunk, TurnStepResult> {
  const agentId = e.agentId!

  // A Codex run is active: this step is the one after an action step.
  const active = runs.get(agentId)
  if (active !== undefined) {
    const info = await $.agent.list().then(l => l.find(a => a.id === agentId), () => undefined)
    if (info !== undefined && ['completed', 'failed', 'killed'].includes(info.status)) {
      $.ui.log(`codex-mod: agent ${agentId} is ${info.status}; killing Codex`, { to: 'debug' })
      await stopRun($, active)
      yield STOP
      return finish(e)
    }
    await noteFollowUp($, active)
    return yield* pump($, e, signal, active)
  }

  const conv = await conversation($, agentId)
  const rd = readConversation(conv.items)
  const rec = await loadRecord($, agentId)
  if (rec !== undefined) {
    rec.followUps = followUpsOf(rec)
    // a coordinator delivery that came after the run ended runs as a follow-up
    const arrived = takeDeliveries(agentId, rd.latest?.count ?? rec.userCount ?? 0, rd.latest?.text).filter(d => !rec.followUps!.some(sameFollowUp(d)))
    if (arrived.length > 0) {
      rec.followUps.push(...arrived)
      await saveRecord($, agentId, rec)
    }
    if (rec.followUps.length === 0) rec.followUps = undefined
    // the latest signal wins; an enforce nudge makes it the tool until the engine says otherwise
    if (rd.signal !== undefined && rec.handbackLock !== rd.signal) {
      $.ui.log(`codex-mod: agent ${agentId}: handback route now ${rd.signal}${rd.enforce ? ' (engine enforce nudge seen)' : ''}`, { to: 'debug' })
      rec.handbackLock = rd.signal
      await saveRecord($, agentId, rec)
    }
  }
  const sessionInactive = cfg.handbackMode === 'auto' && await sessionHandbackInactive($, rd.handbackFailed)
  const handback = handbackFor(agentId, rd.signal, conv.source, sessionInactive)
  $.ui.log(`codex-mod: agent ${agentId}: handback route ${handback ? 'tool' : 'text'} (mode ${cfg.handbackMode}, ${conv.source} read, signal ${rd.signal ?? 'none'}, lock ${rec?.handbackLock ?? 'none'}, session not active ${sessionInactive})`, { to: 'debug' })
  const fallback = (): AgentRecord => rec ?? { ...profileOf(name)!, agentName: name, updatedAt: 0 }

  // 1. Our SubagentHandback came back "not active": the same answer again as text, no Codex run.
  const refused = rd.results.find(r => r.tool === HANDBACK_TOOL && (r.isError || NOT_ACTIVE.test(r.text)))
  if (refused !== undefined && !rd.textAfterResults && cfg.handbackMode !== 'tool') {
    $.ui.log(`codex-mod: agent ${agentId}: SubagentHandback not active (${oneLine(refused.text, 80)}); answer re-delivered as text`, { to: 'debug' })
    return yield* redeliver($, e, agentId, rec, false)
  }

  // 2. Tool results with nothing new after them: the result of our handback
  // (end the turn, or run a follow-up folded in meanwhile), or of an action
  // call whose run was lost when the hooks worker restarted.
  if (rd.results.length > 0 && !rd.textAfterResults) {
    const lostAction = rd.results.some(r => hasPrefix(r.id) && (r.tool === undefined || isNative(r.tool)))
    const queued = rec?.handedBack ? rec.followUps?.shift() : undefined
    if (queued !== undefined && rec !== undefined) {
      if (rec.followUps?.length === 0) rec.followUps = undefined
      return yield* startRun($, e, signal, config, name, rec, queued.text, handback, queued.count, undefined, queued.uuid)
    }
    if (rec?.handedBack || rd.results.some(r => r.tool === HANDBACK_TOOL) || !lostAction) {
      if (rec?.handedBack) {
        rec.handedBack = false
        await saveRecord($, agentId, rec)
      }
      yield STOP
      return finish(e)
    }
    const prof = fallback()
    const why = 'run lost (hooks worker restarted or plugin reloaded mid-run); send a follow-up to resume its thread'
    $.ui.log(`codex-mod: agent ${agentId}: ${why}`, { to: 'debug' })
    return yield* handBack($, e, `codex failed: ${why}`, footer({ ...prof, agent: name, actions: 0, thread: rec?.thread }, config.footer), handback)
  }

  const latest = rd.latest
  if (latest !== undefined && isCompactionText(latest.text)) {
    $.ui.log(`codex-mod: agent ${agentId}: newest user row is a compaction summary; no new task, no Codex run`, { to: 'debug' })
    yield STOP
    return finish(e)
  }

  // 3. Only a genuinely new user/coordinator message launches Codex. Engine
  // nudges and reminders are never tasks (cleanText leaves them empty).
  const isNew = latest !== undefined && (rec?.lastTask === undefined || latest.text !== rec.lastTask || (rec.userCount !== undefined && latest.count > rec.userCount))
  if (isNew) {
    const base = fallback()
    // a queued follow-up that is this very message runs now, not again later
    if (base.followUps !== undefined) {
      base.followUps = base.followUps.filter(f => f.uuid !== undefined || f.count !== latest.count)
      if (base.followUps.length === 0) base.followUps = undefined
    }
    return yield* startRun($, e, signal, config, name, base, latest.text, handback, latest.count)
  }

  // 4. Nothing new. After an engine nudge or reminder: the last answer again,
  // through the right route. Otherwise (nothing appended): end the step.
  if (rec?.lastAnswer !== undefined && rd.nudged) {
    $.ui.log(`codex-mod: agent ${agentId}: no new message (engine notice); last answer re-delivered, no Codex run`, { to: 'debug' })
    return yield* redeliver($, e, agentId, rec, handback)
  }
  if (rec !== undefined && latest !== undefined) {
    $.ui.log(`codex-mod: agent ${agentId}: no new message; no Codex run`, { to: 'debug' })
    if (rec.handedBack) {
      rec.handedBack = false
      await saveRecord($, agentId, rec)
    }
    yield STOP
    return finish(e)
  }
  const prof = fallback()
  const why = conv.denied !== undefined ? `session read denied: ${conv.denied}` : latest === undefined ? 'the agent has no task message' : 'no new message to run and no stored answer to re-deliver'
  return yield* handBack($, e, `codex failed: ${why}`, footer({ ...prof, agent: name, actions: 0, thread: rec?.thread }, config.footer), handback)
}

/** Hands the stored last answer back again (no Codex run); past MAX_REDELIVER, ends the step silently. */
async function* redeliver($: EngineInterface, e: TurnStepInput, agentId: string, rec: AgentRecord | undefined, handback: boolean): AsyncGenerator<TurnStepChunk, TurnStepResult> {
  if (rec === undefined || rec.lastAnswer === undefined) {
    yield STOP
    return finish(e)
  }
  rec.redeliveries = (rec.redeliveries ?? 0) + 1
  if (rec.redeliveries > MAX_REDELIVER) {
    $.ui.log(`codex-mod: agent ${agentId}: ${MAX_REDELIVER} re-deliveries without a new message; ending the step`, { to: 'debug' })
    await saveRecord($, agentId, rec)
    yield STOP
    return finish(e)
  }
  rec.handedBack = true
  rec.handback = handback
  await saveRecord($, agentId, rec)
  return yield* finalBlocks(e, rec.lastAnswer, '', handback)
}

/** The file id of a steer: the message count, zero-padded so the runner's name order is arrival order. */
const steerId = (count: number) => String(count).padStart(6, '0')

/**
 * A user message folded into the turn while a run is active: steered into an
 * app-server run (a steer file in its control dir, acked on its stdout), else
 * kept for after the run. Never rejects.
 */
async function noteFollowUp($: EngineInterface, run: Run): Promise<void> {
  const conv = await conversation($, run.agentId).catch(() => undefined)
  if (conv === undefined) return
  const latest = readConversation(conv.items).latest
  const rec = records.get(run.agentId)
  const fresh: FollowUp[] = []
  let shown: string | undefined
  if (latest !== undefined && !isCompactionText(latest.text)) {
    const seen = rec?.userCount
    if (seen !== undefined ? latest.count > seen : latest.text !== rec?.lastTask) {
      fresh.push(latest)
      shown = latest.text
    }
  }
  fresh.push(...takeDeliveries(run.agentId, latest?.count ?? rec?.userCount ?? 0, shown))
  for (const f of fresh) {
    const same = sameFollowUp(f)
    if (run.followUps.some(same) || run.pendingSteers.some(same) || followUpsOf(rec).some(same)) continue
    await foldIn($, run, f)
  }
}

/** Steers one follow-up into an app-server run (a steer file), else keeps it for after the run, with its `↪` note. */
async function foldIn($: EngineInterface, run: Run, f: FollowUp): Promise<void> {
  // override lines cannot change a running turn's model: the rest is steered
  const text = parseOverrides(f.text).rest.trim()
  if (run.transport === 'app-server' && run.control !== undefined && !run.ended && !run.killed && text !== '') {
    try {
      await $.fs.write(`${run.control}/steer-${steerFileId(f)}.json`, JSON.stringify({ text: roleTask(run.name, text) }))
      run.pendingSteers.push(f)
      $.ui.log(`codex-mod: agent ${run.agentId}: message received mid-run; steered into the running turn`, { to: 'debug' })
      return
    } catch (err) {
      $.ui.log(`codex-mod: agent ${run.agentId}: steer not written (${errText(err)}); it runs after this one`, { to: 'debug' })
    }
  }
  run.followUps.push(f)
  if (run.transport !== 'app-server') {
    if (!run.queuedNoted) run.queue.push({ kind: 'note', text: steerNote('queued') })
    run.queuedNoted = true
  } else run.queue.push({ kind: 'note', text: steerNote('finished') })
  $.ui.log(`codex-mod: agent ${run.agentId}: follow-up received mid-run; it runs after this one`, { to: 'debug' })
}

/** Resolves and validates the profile (record + new override lines), saves the record and starts Codex. */
async function* startRun(
  $: EngineInterface,
  e: TurnStepInput,
  signal: AbortSignal,
  config: Config,
  name: string,
  base: AgentRecord,
  rawTask: string,
  handback: boolean,
  count: number,
  carry?: string,
  // the row id of a coordinator delivery: the transcript's newest user message
  // stays the record's task, so that message is not judged new after this run
  delivery?: string,
): AsyncGenerator<TurnStepChunk, TurnStepResult> {
  const agentId = e.agentId!
  await loadCatalog($)
  const list = catalog ?? undefined
  const o = parseOverrides(rawTask)
  const model = o.model ?? (base.model || list?.[0]?.slug || FALLBACK_MODEL)
  const lastTask = delivery !== undefined && base.lastTask !== undefined ? base.lastTask : rawTask
  const rec: AgentRecord = {
    ...base,
    agentName: name,
    model,
    effort: o.effort ?? (base.effort || list?.find(m => m.slug === model)?.defaultEffort || FALLBACK_EFFORT),
    sandbox: base.sandbox,
    thread: base.thread,
    lastTask,
    userCount: count,
    handedBack: false,
    handback,
    redeliveries: 0,
    followUps: base.followUps,
    updatedAt: base.updatedAt,
  }
  const prof: Profile = { model: rec.model, effort: rec.effort, sandbox: rec.sandbox }
  const invalid = checkProfile(list, prof.model, prof.effort)
  if (invalid !== undefined) {
    // nothing runs; the record keeps the last profile that could
    await saveRecord($, agentId, { ...base, agentName: name, lastTask, userCount: count, handedBack: false, handback, redeliveries: 0 })
    const body = [carry, `codex failed: ${invalid}`].filter(Boolean).join('\n\n')
    return yield* handBack($, e, body, footer({ ...prof, agent: name, actions: 0, thread: base.thread }, config.footer), handback)
  }

  // Launch guard, independent of how the message was judged new: at most one
  // launch per message, at most maxRunsPerWindow per agent in WINDOW_MS; a
  // trip is kept in the record (a worker restart does not reset it) and that
  // message is never launched again.
  const now = await $.clock.now().catch(() => Date.now())
  const key = `${count}:${delivery !== undefined ? `${delivery}:` : ''}${rawTask}`
  const recent = (base.launches ?? []).filter(t => now - t < WINDOW_MS)
  const trip =
    base.guardTrip?.key === key ? base.guardTrip.reason
    : base.launchKey === key && (base.launchesSinceNew ?? 0) >= 1 ? 'this message already had its Codex run'
    : recent.length >= config.maxRunsPerWindow ? `${recent.length} launches in the last ${WINDOW_MS / 60000} min (maxRunsPerWindow ${config.maxRunsPerWindow})`
    : undefined
  if (trip !== undefined) {
    $.ui.log(`codex-mod: agent ${agentId}: launch guard tripped (${trip}); no Codex run`, { to: 'debug' })
    rec.launches = recent
    rec.guardTrip = { key, reason: trip }
    await saveRecord($, agentId, rec)
    const body = [carry, `codex failed: launch guard tripped (${trip})`].filter(Boolean).join('\n\n')
    return yield* handBack($, e, body, footer({ ...prof, agent: name, actions: 0, thread: rec.thread }, config.footer), handback)
  }
  rec.launches = [...recent, now]
  rec.launchesSinceNew = base.launchKey === key ? (base.launchesSinceNew ?? 0) + 1 : 1
  rec.launchKey = key
  rec.guardTrip = undefined
  await saveRecord($, agentId, rec)
  const task = roleTask(name, o.rest)

  const cwd = await $.session.cwd()
  const lean = config.lean ? await leanArgs($) : []
  let env: Record<string, string> | undefined
  if (!config.globalRules) {
    try {
      env = { CODEX_HOME: await shadowHome($) }
    } catch (err) {
      const body = [carry, `codex failed: could not prepare the CODEX_HOME without global rules (${errText(err)})`].filter(Boolean).join('\n\n')
      return yield* handBack($, e, body, footer({ ...prof, agent: name, actions: 0, thread: rec.thread }, config.footer), handback)
    }
  }
  const via = await transportFor($, config)
  let argv: string[]
  let control: string | undefined
  if (via.transport === 'app-server') {
    // a fresh control dir per run: no file of an earlier run may steer this one
    rec.runSeq = (rec.runSeq ?? 0) + 1
    await saveRecord($, agentId, rec)
    const safe = (s: string) => s.replace(/[^A-Za-z0-9_-]/g, '_')
    const runs = await runsDir($)
    control = `${runs}/${safe(await sessionId($))}-${safe(agentId)}-${rec.runSeq}`
    await $.process.run(['rm', '-rf', control], { timeoutMs: 10000 }).catch(() => undefined)
    // created private (0700) here, before any steer file (prompt text) is written
    // into it: `$.fs.write` would create missing directories with the default mode
    await $.process.run(['mkdir', '-p', '-m', '700', `${runs.slice(0, runs.lastIndexOf('/'))}`, runs, control], { timeoutMs: 10000 }).catch(() => undefined)
    argv = runnerArgv({ node: via.node, runner: via.runner, codex: config.codexPath ?? 'codex', prof, cwd, resume: rec.thread, lean, extra: config.extraConfig, control })
    $.ui.log(`codex-mod: agent ${agentId} -> ${argv.join(' ')}${env ? ` (CODEX_HOME=${env.CODEX_HOME})` : ''} (prompt ${task.length} chars on stdin)`, { to: 'debug' })
  } else {
    argv = launchArgv({ codex: config.codexPath ?? 'codex', prof, cwd, resume: rec.thread, lean, extra: config.extraConfig })
    $.ui.log(`codex-mod: agent ${agentId} -> ${argv.slice(0, -1).join(' ')}${env ? ` (CODEX_HOME=${env.CODEX_HOME})` : ''} (prompt ${task.length} chars on stdin)`, { to: 'debug' })
  }

  const run: Run = {
    agentId,
    name,
    prof,
    cwd,
    child: $.process.spawn({ argv, cwd, input: task, ...(env ? { env } : {}) }),
    thread: rec.thread,
    buffered: '',
    stderrTail: '',
    texts: [],
    errors: [],
    queue: [],
    snapshots: new Map(),
    actions: 0,
    actionSteps: 0,
    // the first action goes out at once
    lastEmit: -Infinity,
    ended: false,
    killed: false,
    timedOut: false,
    handback,
    carry,
    followUps: [],
    transport: via.transport,
    control,
    transportNote: via.transport === 'app-server' ? 'app-server' : via.note,
    pendingSteers: [],
    steers: 0,
    unknown: 0,
    unknownTypes: [],
  }
  if (config.timeoutMs > 0) {
    try {
      run.timer = $.clock.after(config.timeoutMs, () => {
        if (run.ended || run.killed) return
        run.timedOut = true
        void run.child.return(undefined as unknown as ProcessSpawnResult).catch(() => undefined)
      })
    } catch (err) {
      $.ui.log(`codex-mod: run timeout not set: ${errText(err)}`, { to: 'debug' })
    }
  }
  runs.set(agentId, run)
  return yield* pump($, e, signal, run)
}

/** Forgets the answers of an agent's calls that were never made. */
function dropAnswers(agentId: string): void {
  for (const [id, a] of answers) if (a.agentId === agentId) answers.delete(id)
}

/** Kills a run's child (idempotent) and forgets it. */
async function killRun(run: Run, interrupted = false): Promise<void> {
  if (runs.get(run.agentId) === run) runs.delete(run.agentId)
  dropAnswers(run.agentId)
  try {
    run.timer?.cancel()
  } catch {
    // already fired
  }
  if (run.killed && !interrupted) return
  run.killed = true
  try {
    await run.child.return(undefined as unknown as ProcessSpawnResult)
  } catch {
    // already ended
  }
}

/**
 * Kills a run as `killRun` does; an app-server run is first asked to stop (its
 * turn interrupted) and read for up to INTERRUPT_GRACE_MS within this call.
 */
async function stopRun($: EngineInterface, run: Run): Promise<void> {
  if (run.killed || run.transport !== 'app-server' || run.control === undefined || run.ended) return killRun(run)
  // marked killed first: the step pulling meanwhile ends, and no second stop starts
  run.killed = true
  if (runs.get(run.agentId) === run) runs.delete(run.agentId)
  await interruptRun($, run)
  return killRun(run, true)
}

/** The run's one pull in flight, started if none is: a step and an interrupt's drain share it. */
function pullOnce(run: Run): Promise<IteratorResult<ProcessSpawnChunk, ProcessSpawnResult>> {
  if (run.pull === undefined) {
    const p = run.child.next()
    run.pull = p
    const clear = () => {
      if (run.pull === p) run.pull = undefined
    }
    p.then(clear, clear)
  }
  return run.pull
}

/** A `$.clock.after` wait as a promise and its timer; no timer when one cannot be set. */
function lateAfter($: EngineInterface, ms: number): { done: Promise<'late'>; timer?: Timer } {
  let timer: Timer | undefined
  const done = new Promise<'late'>(resolve => {
    try {
      timer = $.clock.after(ms, () => resolve('late'))
    } catch {
      // no timer: the caller waits without one
    }
  })
  return { done, timer }
}

const cancel = (timer: Timer | undefined) => {
  try {
    timer?.cancel()
  } catch {
    // already fired
  }
}

/** Writes the run's `interrupt` file, then reads the run until it ends or INTERRUPT_GRACE_MS passes. */
async function interruptRun($: EngineInterface, run: Run): Promise<void> {
  try {
    await $.fs.write(`${run.control}/interrupt`, 'interrupt\n')
  } catch (err) {
    $.ui.log(`codex-mod: agent ${run.agentId}: interrupt not written (${errText(err)}); killing the runner`, { to: 'debug' })
    return
  }
  const t = lateAfter($, INTERRUPT_GRACE_MS)
  if (t.timer === undefined) return
  try {
    for (;;) {
      const r = await Promise.race([pullOnce(run), t.done])
      if (r === 'late' || r.done) break
    }
  } catch {
    // the stream closed
  } finally {
    cancel(t.timer)
  }
}

/**
 * The next piece of an app-server run, read in THIS step. While it is late,
 * every MID_STEP_MS the conversation is checked for a message to steer in and
 * the same pull is waited on again, so it settles before the step returns.
 * No check when the step's budget is low (or no timer can be set).
 */
async function pullWatching($: EngineInterface, run: Run, signal: AbortSignal): Promise<IteratorResult<ProcessSpawnChunk, ProcessSpawnResult>> {
  const pending = pullOnce(run)
  for (;;) {
    const left = budgets.get(signal)?.() ?? Number.POSITIVE_INFINITY
    if (left < MID_STEP_RESERVE_MS || signal.aborted || run.killed) return await pending
    const t = lateAfter($, MID_STEP_MS)
    if (t.timer === undefined) return await pending
    let r: IteratorResult<ProcessSpawnChunk, ProcessSpawnResult> | 'late'
    try {
      r = await Promise.race([pending, t.done])
    } finally {
      cancel(t.timer)
    }
    if (r !== 'late') return r
    await noteFollowUp($, run)
  }
}

/** Parses one piece of output into the run's state. */
async function feed($: EngineInterface, run: Run, piece: ProcessSpawnChunk): Promise<void> {
  if (piece.stream === 'stderr') {
    run.stderrTail = (run.stderrTail + piece.text).slice(-2000)
    return
  }
  run.buffered += piece.text
  let nl: number
  while ((nl = run.buffered.indexOf('\n')) >= 0) {
    const line = run.buffered.slice(0, nl).trim()
    run.buffered = run.buffered.slice(nl + 1)
    if (line !== '') await handle($, run, parseCodexLine(line, cfg.richRows, todoWriteAvailable))
  }
}

const absolute = (cwd: string, p: string) => (p.startsWith('/') ? p : `${cwd.replace(/\/$/, '')}/${p}`)
const relative = (cwd: string, p: string) => {
  const root = `${cwd.replace(/\/$/, '')}/`
  return p.startsWith(root) ? p.slice(root.length) : p
}

/** A file's text (read only), or undefined when it cannot be read. */
async function readText($: EngineInterface, path: string): Promise<string | undefined> {
  try {
    const text = await $.fs.read(path)
    return typeof text === 'string' ? text : undefined
  } catch {
    return undefined
  }
}

const remember = (run: Run, path: string, text: string | undefined) => {
  if (text !== undefined && text.length <= 4 * FILE_MAX) run.snapshots.set(path, text)
  else run.snapshots.delete(path)
}

async function handle($: EngineInterface, run: Run, ev: CodexEvent): Promise<void> {
  if (ev.kind === 'thread') {
    run.thread = ev.id
    const rec = records.get(run.agentId)
    if (rec !== undefined && rec.thread !== ev.id) {
      rec.thread = ev.id
      await saveRecord($, run.agentId, rec)
    }
  } else if (ev.kind === 'message') {
    run.texts.push(ev.text)
    run.queue.push({ kind: 'text', text: ev.text })
  } else if (ev.kind === 'thinking' || ev.kind === 'interim' || ev.kind === 'note') {
    run.queue.push(ev)
    if (ev.kind === 'note' && ev.dim) dimNotes.add(ev.text)
  } else if (ev.kind === 'action') {
    run.actions++
    if (ev.display) {
      await registerDisplayTools($).catch(err => $.ui.log(`codex-mod: display tools not registered: ${errText(err)}`, { to: 'debug' }))
      const tool = displayTools[ev.display]
      // no registered display tool: the action is shown as its text line, never as a row
      if (tool === undefined) {
        run.queue.push({ kind: 'note', text: actionLine(ev.action) })
        return
      }
      ev.action.tool = tool
    }
    run.queue.push({ kind: 'action', action: ev.action })
  } else if (ev.kind === 'error') run.errors.push(ev.text)
  else if (ev.kind === 'turn') run.turnId = ev.id
  else if (ev.kind === 'steer') {
    const i = run.pendingSteers.findIndex(f => (f.uuid === undefined && String(f.count) === ev.id) || steerFileId(f) === ev.id)
    if (i < 0) return
    const [s] = run.pendingSteers.splice(i, 1)
    if (ev.accepted) {
      run.steers++
      // the steered message had its launch: it never also runs after the handback
      const rec = records.get(run.agentId)
      if (rec !== undefined) {
        if (rec.userCount === undefined || s!.count > rec.userCount) {
          rec.userCount = s!.count
          rec.lastTask = s!.text
        }
        rec.launchKey = `${s!.count}:${s!.text}`
        rec.launchesSinceNew = 1
        await saveRecord($, run.agentId, rec)
      }
      run.queue.push({ kind: 'note', text: steerNote('accepted', s!.text) })
      $.ui.log(`codex-mod: agent ${run.agentId}: steer ${ev.id} accepted`, { to: 'debug' })
    } else {
      run.followUps.push(s!)
      run.queue.push({ kind: 'note', text: steerNote('finished') })
      $.ui.log(`codex-mod: agent ${run.agentId}: steer ${ev.id} rejected (${ev.reason ?? 'no reason'}); it runs after this one`, { to: 'debug' })
    }
  } else if (ev.kind === 'protocol') {
    run.unknown += ev.types.length
    for (const t of ev.types) if (run.unknownTypes.length < 3 && !run.unknownTypes.includes(t)) run.unknownTypes.push(t)
  } else if (ev.kind === 'fatal') run.fatal = ev.text
  else if (ev.kind === 'unknown') {
    run.unknown++
    if (run.unknownTypes.length < 3 && !run.unknownTypes.includes(ev.type)) run.unknownTypes.push(ev.type)
  } else if (ev.kind === 'usage') {
    const u = run.usage ?? { input: 0, cached: 0, output: 0 }
    run.usage = { input: u.input + ev.input, cached: u.cached + ev.cached, output: u.output + ev.output }
  } else if (ev.kind === 'command') {
    run.actions++
    run.queue.push({ kind: 'action', action: commandAction(ev.command, ev.output, ev.exitCode) })
  } else if (ev.kind === 'fileStart') {
    // the text before the patch, when it is read in time (best effort)
    for (const c of ev.changes) {
      const path = absolute(run.cwd, c.path)
      if (c.kind !== 'add' && !run.snapshots.has(path)) remember(run, path, await readText($, path))
    }
  } else if (ev.kind === 'files') {
    for (const c of ev.changes) {
      run.actions++
      const path = absolute(run.cwd, c.path)
      const before = run.snapshots.get(path)
      const after = c.kind === 'delete' ? undefined : await readText($, path)
      run.queue.push({ kind: 'action', action: fileAction({ path, kind: c.kind }, relative(run.cwd, path), before, after) })
      remember(run, path, after)
    }
  }
}

const interval = (run: Run) => (run.actionSteps >= SLOW_AFTER ? Math.max(SLOW_MS, cfg.intervalMs) : cfg.intervalMs)
const hasAction = (run: Run) => run.queue.some(q => q.kind === 'action')
const hasNote = (run: Run) => run.queue.some(q => q.kind === 'note' || q.kind === 'interim' || q.kind === 'thinking')
const timeoutText = () => `timeout after ${Math.round(cfg.timeoutMs / 60000)} min (timeoutMinutes); Codex was stopped`

/**
 * Reads the run's output in THIS step until an action is done (ends the step
 * with the actions as tool calls) or Codex ends (hands the report back). With
 * nativeActions off, everything streams as text into this one step instead.
 */
async function* pump($: EngineInterface, e: TurnStepInput, signal: AbortSignal, run: Run): AsyncGenerator<TurnStepChunk, TurnStepResult> {
  const onAbort = () => void stopRun($, run)
  signal.addEventListener?.('abort', onAbort, { once: true })
  let failure: { reason: string; detail?: string } | undefined
  // text streamed in this step so far (nativeActions off)
  const streamed = { used: false, answer: '' }
  const say = function* (text: string): Generator<TurnStepChunk> {
    const piece = streamed.used ? `\n\n${text}` : text
    streamed.used = true
    streamed.answer += piece
    yield { kind: 'text', index: 0, text: piece }
  }
  try {
    if (!cfg.nativeActions && run.carry !== undefined) {
      yield* say(run.carry)
      run.carry = undefined
    }
    for (;;) {
      if (run.timedOut) {
        failure = { reason: timeoutText() }
        break
      }
      if (signal.aborted || run.killed) throw new Error('aborted')
      if (!cfg.nativeActions) {
        // every message, note and action as it comes; the final answer is held back
        while (run.queue.length > 0 && (hasAction(run) || hasNote(run) || run.ended)) {
          const q = run.queue[0]!
          if (q.kind !== 'action' && run.ended && !hasAction(run)) break
          run.queue.shift()
          if (q.kind !== 'action') {
            yield* say(q.text)
          } else {
            yield* say(actionLine(q.action))
          }
        }
      } else if (hasAction(run)) {
        if (run.actionSteps >= MAX_ACTION_STEPS) {
          // past the cap actions are counted only; messages stay for the answer
          run.queue = run.queue.filter(q => q.kind !== 'action')
        } else {
          const wait = interval(run) - ((await $.clock.now()) - run.lastEmit)
          if (wait > 0) await $.clock.sleep(wait, { signal })
          if (signal.aborted || run.killed) throw new Error('aborted')
          run.lastEmit = await $.clock.now()
          return yield* actionStep(e, run)
        }
      }
      if (run.ended) break
      let r: IteratorResult<ProcessSpawnChunk, ProcessSpawnResult>
      try {
        r = run.transport === 'app-server' ? await pullWatching($, run, signal) : await run.child.next()
      } catch (err) {
        if (run.timedOut) continue
        if (signal.aborted || run.killed) throw err
        // a spawn that cannot start rejects its first pull
        failure = { reason: `could not start Codex (${errText(err)})` }
        break
      }
      if (run.timedOut) continue
      if (run.killed) throw new Error('killed')
      if (r.done) {
        run.ended = true
        if (run.buffered.trim() !== '') await handle($, run, parseCodexLine(run.buffered.trim(), cfg.richRows, todoWriteAvailable))
        run.buffered = ''
        continue
      }
      await feed($, run, r.value)
    }
  } catch (err) {
    const wasKilled = run.killed
    await killRun(run)
    if (signal.aborted || wasKilled) {
      yield STOP
      return finish(e)
    }
    failure = { reason: `hook error (${errText(err)})` }
  } finally {
    signal.removeEventListener?.('abort', onAbort)
  }
  return yield* complete($, e, signal, run, failure, streamed.used ? streamed.answer : undefined)
}

type Block = { text: string; dim?: true } | { thinking: string } | { tool: string; id: string; input: Record<string, unknown> }

const mintId = (e: TurnStepInput) => `${ID_PREFIX}${e.turnId.replace(/[^A-Za-z0-9]/g, '').slice(-12)}_${e.index}_${++seq}`

/**
 * Ends the step with the queued messages and actions up to the last action
 * (at most maxActionsPerStep): each message a text block, each action a
 * call whose answer is stored for the `tool.call` guard.
 */
async function* actionStep(e: TurnStepInput, run: Run): AsyncGenerator<TurnStepChunk, TurnStepResult> {
  let cut = -1
  let n = 0
  for (let i = 0; i < run.queue.length && n < cfg.maxActionsPerStep; i++) {
    if (run.queue[i]!.kind === 'action') {
      cut = i
      n++
    }
  }
  const taken = run.queue.splice(0, cut + 1)
  const blocks: Block[] = []
  if (run.carry !== undefined) {
    blocks.push({ text: run.carry })
    run.carry = undefined
  }
  for (const q of taken) {
    if (q.kind === 'thinking') {
      blocks.push({ thinking: q.text })
    } else if (q.kind !== 'action') {
      const prev = blocks.at(-1)
      if (!q.dim && prev !== undefined && 'text' in prev && !prev.dim) prev.text += `\n\n${q.text}`
      else blocks.push({ text: q.text, ...(q.dim ? { dim: true as const } : {}) })
    } else {
      const id = mintId(e)
      if (q.action.tool === 'WebSearch' && !Array.isArray(q.action.result) && Array.isArray(q.action.result.results)) {
        for (const r of q.action.result.results) if (r && typeof r === 'object') r.tool_use_id = id
      }
      answers.set(id, { agentId: run.agentId, tool: q.action.tool, result: q.action.result, ...(q.action.isError ? { isError: true as const } : {}) })
      blocks.push({ tool: q.action.tool, id, input: q.action.input })
    }
  }
  run.actionSteps++
  return yield* emit(e, blocks)
}

/** Codex ended (or could not start, or timed out): its answer, handed back once with the footer. */
async function* complete(
  $: EngineInterface,
  e: TurnStepInput,
  signal: AbortSignal,
  run: Run,
  failure: { reason: string; detail?: string } | undefined,
  streamed: string | undefined,
): AsyncGenerator<TurnStepChunk, TurnStepResult> {
  if (runs.get(run.agentId) === run) runs.delete(run.agentId)
  dropAnswers(run.agentId)
  try {
    run.timer?.cancel()
  } catch {
    // already fired
  }
  const tail = run.stderrTail.trim().split('\n').slice(-5).join('\n')
  // a steer the runner never acked (it ended first) runs after this run, as a follow-up
  if (run.pendingSteers.length > 0) {
    run.followUps.push(...run.pendingSteers)
    run.pendingSteers = []
    run.queue.push({ kind: 'note', text: steerNote('finished') })
  }
  let reason = failure?.reason
  let detail = failure?.detail ?? ''
  if (failure === undefined) {
    let ended: ProcessSpawnResult | undefined
    try {
      ended = await run.child.result
    } catch (err) {
      reason = `stream closed (${errText(err)})`
    }
    if (ended !== undefined && run.fatal !== undefined) {
      reason = oneLine(run.fatal, 300)
      detail = tail
    } else if (ended !== undefined && ended.code !== 0) {
      const how = ended.signal ? `signal ${ended.signal}` : `exit ${ended.code}`
      reason = run.errors.length > 0 ? `${how}: ${oneLine(run.errors.join('; '))}` : how
      detail = tail || (run.errors.length > 0 ? '' : 'no output')
    } else if (ended !== undefined && run.errors.length > 0) {
      reason = oneLine(run.errors.join('; '))
      detail = tail
    } else if (ended !== undefined && run.texts.length === 0) {
      reason = driftText(run) ?? 'no agent message'
      detail = tail
    }
  }
  if (reason !== undefined && preflight) detail = [detail, `(launch check: ${preflight})`].filter(Boolean).join('\n')
  // Commentary, proposed plans and summaries are emitted before the handback,
  // never used as a substitute for a missing final message.
  // the answer: the messages not shown yet (those after the last action), else the last
  // one; the notes not shown yet go before it, so a note never stands in for the answer
  const unseen = run.queue.filter(q => q.kind === 'text').map(q => q.text)
  const notes = run.queue.filter(q => q.kind === 'note' && !q.dim).map(q => q.text)
  const leading: Block[] = []
  for (const q of run.queue) {
    if (q.kind === 'thinking') leading.push(cfg.nativeActions ? { thinking: q.text } : { text: q.text })
    else if (q.kind === 'interim' || (q.kind === 'note' && q.dim)) leading.push({ text: q.text })
  }
  run.queue = []
  const said = unseen.length > 0 ? unseen.join('\n\n') : streamed !== undefined && !run.handback ? '' : (run.texts.at(-1) ?? '')
  const answer = [...notes, said].filter(Boolean).join('\n\n')
  const body = reason === undefined ? answer : [`codex failed: ${reason}`, detail, answer].filter(Boolean).join('\n')
  const rec = records.get(run.agentId)
  if (rec !== undefined) {
    if (run.thread !== undefined) rec.thread = run.thread
    const queued = [...followUpsOf(rec), ...run.followUps]
    rec.followUps = queued.length > 0 ? queued : undefined
  }
  const foot = footer({ ...run.prof, agent: run.name, actions: run.actions, usage: run.usage, thread: run.thread, transport: run.transportNote, steers: run.steers }, cfg.footer)
  const shown = [run.carry, body].filter(Boolean).join('\n\n')
  run.carry = undefined
  // Text mode ends the turn with this step, so a follow-up folded in meanwhile
  // runs now, in the same step, after this answer.
  if (!run.handback && rec !== undefined && rec.followUps !== undefined && rec.followUps.length > 0) {
    const next = rec.followUps.shift()!
    if (rec.followUps.length === 0) rec.followUps = undefined
    const carry = [shown, foot].filter(Boolean).join('\n\n')
    if (streamed !== undefined) {
      // nativeActions off: the stream so far stands; the next run continues it
      const rest = startRun($, e, signal, cfg, run.name, rec, next.text, false, next.count, carry, next.uuid)
      return yield* prefixed(streamed, rest)
    }
    return yield* startRun($, e, signal, cfg, run.name, rec, next.text, false, next.count, carry, next.uuid)
  }
  if (streamed !== undefined) return yield* handBack($, e, shown, foot, run.handback, { index: 1, answer: streamed }, leading)
  return yield* handBack($, e, shown, foot, run.handback, undefined, leading)
}

/** Why a run with no agent message failed when it printed lines we do not know: the protocol changed. */
function driftText(run: Run): string | undefined {
  if (run.unknown === 0) return undefined
  const what = run.transport === 'app-server' ? 'codex app-server' : 'codex exec --json'
  return `${what} protocol changed (codex-cli ${codexVersion ?? 'unknown'}): ${run.unknown} unknown event${run.unknown === 1 ? '' : 's'} (${run.unknownTypes.join(', ')})`
}

/** Re-yields a step's chunks after text already streamed at index 0 (block indexes shifted by one). */
async function* prefixed(streamed: string, inner: AsyncGenerator<TurnStepChunk, TurnStepResult>): AsyncGenerator<TurnStepChunk, TurnStepResult> {
  for (;;) {
    const r = await inner.next()
    if (r.done) return { ...r.value, answer: streamed + r.value.answer }
    const c = r.value
    yield c.kind === 'text' || c.kind === 'thinking' || c.kind === 'tool' || c.kind === 'input' ? ({ ...c, index: c.index + 1 } as TurnStepChunk) : c
  }
}

const STOP: TurnStepChunk = { kind: 'stop', stopReason: 'end_turn', usage: null }

function finish(e: TurnStepInput): TurnStepResult {
  return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn', usage: null }
}

/**
 * Hands `body` + footer back ONCE: as the SubagentHandback call (the step
 * after its result ends the turn), or as this step's final text, ending the turn.
 */
async function* handBack(
  $: EngineInterface,
  e: TurnStepInput,
  body: string,
  foot: string,
  handback: boolean,
  after?: { index: number; answer: string },
  leading: Block[] = [],
): AsyncGenerator<TurnStepChunk, TurnStepResult> {
  const rec = records.get(e.agentId!)
  if (rec !== undefined) {
    rec.handedBack = true
    rec.handback = handback
    rec.lastAnswer = [after?.answer, body, foot].filter(Boolean).join('\n\n')
    await saveRecord($, e.agentId!, rec)
  }
  return yield* finalBlocks(e, body, foot, handback, after, leading)
}

/** A failure before any run: `body`, the agent's name as the footer (no `$` call, so `.catch` can use it). */
const failStep = (e: TurnStepInput, name: string, body: string, handback: boolean) =>
  finalBlocks(e, body, cfg.footer === 'off' ? '' : name, handback)

/** The final blocks of a run: the SubagentHandback call, or the final text. */
async function* finalBlocks(e: TurnStepInput, body: string, foot: string, handback: boolean, after?: { index: number; answer: string }, leading: Block[] = []): AsyncGenerator<TurnStepChunk, TurnStepResult> {
  const message = [body, foot].filter(Boolean).join('\n\n')
  const blocks: Block[] = handback ? [{ tool: HANDBACK_TOOL, id: mintId(e), input: { message } }] : message === '' ? [] : [{ text: message }]
  return yield* emit(e, [...leading, ...blocks], after)
}

// Ends the step as a model whose response is `blocks`: text chunks, and per
// call a `tool` chunk and its arguments as one `input` chunk; then a stop:
// `tool_use` when it called a tool, else `end_turn`. Codex's tokens are not
// reported as this step's usage (they are not Anthropic tokens); the footer
// carries them.
async function* emit(e: TurnStepInput, blocks: Block[], after?: { index: number; answer: string }): AsyncGenerator<TurnStepChunk, TurnStepResult> {
  const toolUses: { name: string; input: Record<string, unknown> }[] = []
  let answer = after?.answer ?? ''
  const base = after?.index ?? 0
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i]!
    const index = base + i
    if ('thinking' in b) {
      yield { kind: 'thinking', index, text: b.thinking }
    } else if ('text' in b) {
      yield { kind: 'text', index, text: b.text }
      answer += b.text
    } else {
      yield { kind: 'tool', index, id: b.id, name: b.tool }
      yield { kind: 'input', index, json: JSON.stringify(b.input) }
      toolUses.push({ name: b.tool, input: b.input })
    }
  }
  const stopReason = toolUses.length > 0 ? ('tool_use' as const) : ('end_turn' as const)
  yield { kind: 'stop', stopReason, usage: null }
  return { turnId: e.turnId, index: e.index, answer, toolUses, stopReason, usage: null }
}
