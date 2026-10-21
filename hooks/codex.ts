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
// session, and the footer says why. Each per-run sidecar exposes HTTP over a
// private Unix socket. The host's socketPath API is probed before submission;
// unsupported or policy-blocked hosts negotiate file controls. Submitted
// operations never switch paths. Journals and lossless bodies stay in the
// private run cache, with bounded host-store metadata.
//
// Steer: scoped session.receive routes early, session.append records the
// authoritative UUID, and conversation polling remains a recovery path.
// Successful RPC acceptance must match the expected turn; explicit rejection
// can queue after it. Missing acknowledgments stay uncertain without replay.
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
// app-server run is first asked to stop (the negotiated control channel) and given 1.5 s.
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
// so the user-level AGENTS.md is not loaded. The module leaves auth and config
// files alone; optional session history changes use the Codex CLI.

import { admitMirrorLaunch, mirrorHostMatches, mirrorLaunchDigest, mirrorLaunchDiagnostic, MirrorDiagnostics, isMirrorAutoModeNoVerdict, prepareMirrorRetry } from './mirror-launch.ts'
import type { MirrorAuthority } from './mirror-launch.ts'
import { explorationAction, validExploration, literalWords } from './exploration.ts'
import { patchActions, PATCH_TEXT_MAX } from './patches.ts'
import { webAction, webFallback, toolFallback, sourceDuration, validFetchResult } from './web-tools.ts'
import { childRows, planRows, planText, emptyDisplayState } from './plans-children.ts'
import { captureImage, validImage, generationAction, findingsAction, literalReceipt } from './images-modes.ts'
import { QUESTION_METHOD, choiceQuestions, answeredQuestion, validAnsweredQuestion } from './questions.mjs'
import { controlRequest, queryOutcome, publishOutcome, messageStatus } from './steer.ts'
import type { MessageOutcome } from './steer.ts'
import { compactStoreState, flushStoreMigrations, readStoreState, writeStoreState } from './store-state.ts'
import { fingerprint, matchesIdentity } from './fingerprint.ts'
import type { Fingerprint } from './fingerprint.ts'
import { journalLine, journalRead } from './child-journal.mjs'
import { RowCache, saveRow, loadRow } from './row-cache.ts'
import type { RowPresentation } from './row-cache.ts'
import { boundedNames, validCapabilities, resolvePolicy, policyTask, configHash, capacityFallback } from './run-policy.ts'
import type { RolePolicy, EffectiveConfig } from './run-policy.ts'
import { executionRequest, resolveExecution, executionOverrides, executionOverride, permissionEvidence, APPROVAL_MODES } from './execution-policy.ts'
import type { ApprovalMode, ExecutionPolicy } from './execution-policy.ts'
import { APPROVAL_METHODS, approvalRequest, approvalIdentity, matchesApproval, approvalResponse, approvalParent, parentMayDecide, fileApprovalEvidence, FILE_APPROVAL_UNAVAILABLE, commandApprovalContext, COMMAND_APPROVAL_UNAVAILABLE } from './approval-policy.mjs'
import { agentStatus } from './agent-status.ts'
import { execDelta, zeroUsage, validUsage } from './exec-usage.mjs'
import { displayBashCommand } from './display-input.ts'
import type { DisplayState, PlanInput } from './plans-children.ts'
import type { GlobResult, GrepResult } from './exploration.ts'
export { explorationAction, literalWords } from './exploration.ts'
import type {
  BuiltinToolInputs,
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
const STORE_PREFIX = 'agent:'
const SESSION_PREFIX = 'session:'
const DAY_MS = 24 * 60 * 60 * 1000
// In this host a subagent's result reaches its caller through this tool when
// it is active for the agent; its input is `{ message }`.
const HANDBACK_TOOL = 'SubagentHandback'
/** Reserved for nonexecuting display calls, including unknown future tools. */
export const ID_PREFIX = 'toolu_codexmod_'
export const HANDBACK_ID_PREFIX = 'toolu_codexhandback_'
/** The built-in tools Codex's actions are drawn as; never executed for a Codex agent. */
export const NATIVE_TOOLS = ['Bash', 'Read', 'Glob', 'Grep', 'Edit', 'Write', 'WebSearch', 'WebFetch', 'Agent', 'TodoWrite', 'TaskCreate', 'TaskUpdate', 'SendMessage', 'TaskStop', 'ReportFindings', 'AskUserQuestion'] as const
const RICH_TOOLS = new Set<string>(['Agent', 'TodoWrite', 'TaskCreate', 'TaskUpdate', 'SendMessage', 'TaskStop', 'ReportFindings', 'AskUserQuestion'])
type DisplayTool = 'codex_tool' | 'codex_plan' | 'coordinator_message' | 'codex_question'
const displayTools: Partial<Record<DisplayTool, string>> = {}
const displayNames = new Set(['mcp__codex-mod__codex_tool', 'mcp__codex-mod__codex_plan', 'mcp__codex-mod__coordinator_message', 'mcp__codex-mod__codex_question'])
// Kept after the guard consumes its answer, so resolved rows still render.
const coordinatorRows = new RowCache<{ sessionId: string; tool: string; text: string; messageId?: string; outcome?: MessageOutcome }>()
const planCards = new RowCache<PlanInput>()
type Question = { token: string; requestId: string | number; method: string; params: any; status: string; result?: any; error?: any }
const questionRows = new RowCache<{ session: string; agent: string; control: string; question: Question; selected: Record<string, string> }>()
const COORDINATOR_PART_MAX = 90000
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
type ProjectRole = Profile & RolePolicy & { description: string }
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
    if (!/^[a-z][a-z0-9-]{0,31}$/.test(name) || ['codex', 'codex-child'].includes(name)) {
      bad('invalid or reserved name')
      continue
    }
    if (!object(value)) {
      bad('expected an object')
      continue
    }
    unknown(value, ['model', 'effort', 'sandbox', 'description', 'instructions', 'lean', 'capabilities', 'fallbackModels'], `role ${name}`)
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
    if (value.lean !== undefined && typeof value.lean !== 'boolean' || value.capabilities !== undefined && !validCapabilities(value.capabilities) || value.fallbackModels !== undefined && !boundedNames(value.fallbackModels)) {
      bad('invalid lean, capabilities or fallbackModels schema')
      continue
    }
    roles[name] = { model, effort, sandbox, description, ...(instructions !== undefined ? { instructions } : {}),
      ...(value.lean !== undefined ? { lean: value.lean as boolean } : {}),
      ...(value.capabilities !== undefined ? { capabilities: value.capabilities as RolePolicy['capabilities'] } : {}),
      ...(value.fallbackModels !== undefined ? { fallbackModels: value.fallbackModels as string[] } : {}) }
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
  archiveSessions: boolean
  approvalMode: ApprovalMode
  allowedApprovalModes: string[]
  networkAccess: boolean
  additionalWritableRoots: string[]
  allowedCwdRoots: string[]
  generic: Profile
  projectRoles: boolean
  modelAgents: boolean
  allowProjectFullAccess: boolean
  allowProjectNonLean: boolean
  projectCapabilityAllowlist: string[]
  capacityFallback: string[]
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
  nestedAgents: boolean
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
    archiveSessions: bool('archiveSessions', false),
    approvalMode: oneOf<ApprovalMode>('approvalMode', 'never', APPROVAL_MODES),
    allowedApprovalModes: list('allowedApprovalModes', []).filter(v => (APPROVAL_MODES as readonly string[]).includes(v)),
    networkAccess: bool('networkAccess', false),
    additionalWritableRoots: list('additionalWritableRoots', []),
    allowedCwdRoots: list('allowedCwdRoots', []),
    generic: {
      model: model !== '' && /^[\w.:-]+$/.test(model) ? model : '',
      effort: /^[a-z]+$/.test(effort) ? effort : (bad('defaultEffort', 'not an effort name'), FALLBACK_EFFORT),
      sandbox: oneOf('defaultSandbox', 'workspace-write', SANDBOXES),
    },
    projectRoles: bool('projectRoles', true),
    modelAgents: bool('modelAgents', true),
    allowProjectFullAccess: bool('allowProjectFullAccess', false),
    allowProjectNonLean: bool('allowProjectNonLean', false),
    projectCapabilityAllowlist: list('projectCapabilityAllowlist', []).filter((s, i) => {
      const valid = i < 32 && /^(?:webSearch:(?:cached|live)|mcp:[A-Za-z0-9_-]{1,64}|multiAgent|skillsInstructions|apps|plugins|images)$/.test(s)
      if (!valid) warnings.push(`projectCapabilityAllowlist: invalid grant ${JSON.stringify(s)} ignored`)
      return valid
    }),
    capacityFallback: (() => {
      const names = list('capacityFallback', ['gpt-6-sol', 'gpt-5.6-sol'])
      return boundedNames(names) ? names : (bad('capacityFallback', 'expected at most 32 unique model names'), ['gpt-6-sol', 'gpt-5.6-sol'])
    })(),
    extraConfig,
    intervalMs: int('progressIntervalMs', 1000, 0, 60000),
    maxActionsPerStep: int('maxActionsPerStep', 10, 1, 50),
    handbackMode: oneOf<HandbackMode>('handbackMode', 'auto', ['auto', 'tool', 'text']),
    footer: oneOf<FooterMode>('footer', 'full', ['full', 'short', 'off']),
    timeoutMs: int('timeoutMinutes', 0, 0, 1440) * 60000,
    maxRunsPerWindow: int('maxRunsPerWindow', 3, 1, 100),
    nativeActions: bool('nativeActions', true),
    richRows: bool('richRows', false),
    nestedAgents: bool('nestedAgents', true),
    ttlMs: int('pruneDays', 2, 1, 365) * DAY_MS,
    transport: oneOf<Transport>('transport', 'exec', ['exec', 'app-server']),
    nodeOverride: nodePath === '' ? undefined : nodePath,
    warnings,
  }
}

/** Kept per agent between steps, runs, worker restarts and resumes. */
export type AgentRecord = Profile & {
  agentName: string
  // Only small row identity/profile metadata belongs in the host store.
  selection?: { session: string; toolUseId: string; type: string; launchModel: string; launchEffort: string; note?: string }
  modelRowIds?: string[]
  thread?: string
  // Archive state survives option changes so a follow-up can restore this thread.
  historyArchived?: boolean
  // Conflicting source IDs permanently remove this record's history authority.
  historyAmbiguous?: true
  effectiveConfig?: EffectiveConfig
  effectiveExecution?: ExecutionPolicy
  executionFingerprint?: string
  effectiveFingerprint?: string
  fallbackModels?: string[]
  capacityRetryKey?: string
  lastTaskFingerprint?: Fingerprint
  launchKeyFingerprint?: Fingerprint
  capacityRetryKeyFingerprint?: Fingerprint
  guardTripKeyFingerprint?: Fingerprint
  recoveryUnavailable?: boolean
  // A missing total after interruption invalidates the next exec baseline.
  threadUsage?: { thread: string; total: Usage; valid: boolean }
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
  guardTrip?: { key?: string; reason: string }
  // user messages folded into the turn while a run was active, run next
  followUps?: FollowUp[]
  // Receipt IDs are bounded in the store; bodies recover from private cache files.
  coordinator?: { received: string[]; pending: { uuid: string; text: string; messageId?: string; sourceUuid?: string; mirrorClaimed?: true }[]; rows?: Record<string, { tool: string; text: string; sourceUuid: string; messageId?: string }> ; outcomes?: Record<string, MessageOutcome>; sources?: Record<string, string>; authoritative?: true; ingress?: { messageId: string; senderToolUseId: string; count: number; fromSend?: true; text?: string }[] }
  // app-server runs launched so far: the <n> of each run's control dir
  runSeq?: number
  // Runtime/cache only: never put lossless source evidence in the host store.
  wire?: { records: SourceRecord[]; rows: Record<string, SourceRecord | null> }
  display?: DisplayState
  mirror?: ChildMirror
  playback?: { segment?: number; cursor: number; prefix: string; texts: string[]; queue: Queued[]; actions: number; usage?: Usage; usageCanonical?: boolean; usagePartial?: boolean; turnId?: string }
  updatedAt: number
}

/**
 * A user message folded in mid-run: its text and the conversation's genuine
 * message count when it came. A coordinator delivery the transcript carries as
 * an attachment, not a user row (see `deliveries`), also has the row's `uuid`
 * and shares the count of the message it interrupted.
 */
export type FollowUp = { text: string; count: number; uuid?: string; messageId?: string; senderToolUseId?: string }

export type FileChange = { path: string; kind: string | { type: string; move_path?: string | null }; move_path?: string | null; diff?: string; status?: string }

/** Public source evidence, independent of the current choice of display row. */
export type SourceRecord = {
  transport: Transport
  event: string
  threadId?: string
  turnId?: string
  itemId?: string
  cwd?: string
  executionPolicy?: ExecutionPolicy
  startedAtMs?: number
  completedAtMs?: number
  item?: Record<string, any>
  data?: Record<string, any>
  envelope?: Record<string, unknown>
}

/** Turn/thread snapshots can contain reasoning items too, not only item events. */
function publicSource(value: any): any {
  if (Array.isArray(value)) return value.map(publicSource)
  if (value === null || typeof value !== 'object') return value
  return Object.fromEntries(Object.entries(value)
    .filter(([key]) => value.type !== 'reasoning' || key !== 'content')
    .map(([key, child]) => [key, publicSource(child)]))
}

const ITEM_TYPES: Record<string, string> = {
  user_message: 'userMessage', hook_prompt: 'hookPrompt', agent_message: 'agentMessage',
  function_call_output: 'functionCallOutput', proposed_plan: 'plan', reasoning: 'reasoning',
  command_execution: 'commandExecution', file_change: 'fileChange', mcp_tool_call: 'mcpToolCall',
  dynamic_tool_call: 'dynamicToolCall', collab_tool_call: 'collabAgentToolCall',
  sub_agent_activity: 'subAgentActivity', web_search: 'webSearch', image_view: 'imageView',
  sleep: 'sleep', image_generation: 'imageGeneration', entered_review_mode: 'enteredReviewMode',
  exited_review_mode: 'exitedReviewMode', context_compaction: 'contextCompaction',
}
const SOURCE_FIELDS = ['aggregatedOutput', 'exitCode', 'commandActions', 'processId', 'durationMs',
  'senderThreadId', 'receiverThreadIds', 'agentsStates', 'reasoningEffort', 'contentItems',
  'agentThreadId', 'agentPath', 'revisedPrompt', 'savedPath', 'transparentBackground', 'memoryCitation',
  'clientId', 'pluginId', 'scriptPath', 'appContext', 'mcpAppUi', 'mcpAppResourceUri', 'readOnlyHint']
const snake = (key: string) => key.replace(/[A-Z]/g, c => `_${c.toLowerCase()}`)

/** Preserve unknown fields too; only private reasoning is deliberately removed. */
export function normalizeSource(line: string, context: { transport?: Transport; threadId?: string; turnId?: string; cwd?: string } = {}): SourceRecord | undefined {
  let ev: any
  try { ev = publicSource(JSON.parse(line)) } catch { return undefined }
  if (ev === null || typeof ev !== 'object') return undefined
  const src = ev.source
  const raw = src?.item ?? ev.item
  const item = raw && typeof raw === 'object' ? { ...raw, sourceType: raw.type, type: ITEM_TYPES[raw.type] ?? raw.type } : undefined
  if (item) {
    for (const key of SOURCE_FIELDS) if (key in raw || snake(key) in raw) item[key] = key in raw ? raw[key] : raw[snake(key)]
    if (item.type === 'reasoning') delete item.content
    if (typeof item.status === 'string') {
      item.sourceStatus = item.status
      if (item.status === 'in_progress') item.status = 'inProgress'
    }
    if (Array.isArray(item.changes)) item.changes = item.changes.map((c: any) => ({ ...c,
      kind: typeof c.kind === 'string' ? { type: c.kind, ...(c.move_path !== undefined ? { move_path: c.move_path } : {}) } : c.kind }))
  }
  if (!src && !item && typeof ev.type !== 'string') return undefined
  return {
    transport: src?.transport ?? context.transport ?? 'exec',
    event: src?.event ?? ev.type,
    threadId: src?.threadId ?? ev.thread_id ?? context.threadId,
    turnId: src?.turnId ?? ev.turn_id ?? context.turnId,
    itemId: typeof item?.id === 'string' ? item.id : src?.data?.itemId,
    cwd: item?.cwd ?? context.cwd,
    ...(typeof src?.startedAtMs === 'number' ? { startedAtMs: src.startedAtMs } : {}),
    ...(typeof src?.completedAtMs === 'number' ? { completedAtMs: src.completedAtMs } : {}),
    ...(item ? { item, ...(src?.data ? { data: src.data } : {}) } : { data: src?.data ?? ev }),
    ...(!src ? { envelope: Object.fromEntries(Object.entries(ev).filter(([key]) => !['item', 'source'].includes(key))) } : {}),
  }
}

/** One lifecycle per source identity. Deltas are evidence, never new actions. */
export class SourceLedger {
  records: SourceRecord[] = []
  items = new Map<string, SourceRecord>()
  private completed = new Set<string>()
  private started = new Set<string>()
  private plans = new Map<string, string>()
  private usageTurns = new Set<string>()

  capture(record: SourceRecord): { record: SourceRecord; render: boolean } {
    const key = JSON.stringify([record.threadId, record.turnId, record.itemId])
    if (record.event === 'turn.completed') {
      const turn = JSON.stringify([record.threadId, record.turnId])
      if (this.usageTurns.has(turn)) return { record, render: false }
      this.usageTurns.add(turn)
    }
    const end = ['item.completed', 'item/completed'].includes(record.event)
    const start = ['item.started', 'item/started'].includes(record.event)
    if (record.itemId && ((end && this.completed.has(key)) || (start && (this.started.has(key) || this.completed.has(key))))) return { record: this.items.get(key) ?? record, render: false }
    if (record.itemId) {
      const previous = this.items.get(key)
      record = { ...previous, ...record, ...(record.item ? { item: { ...previous?.item, ...record.item } } : {}) }
      if (end && record.item?.type === 'fileChange' && !record.item.changes?.length && previous?.item?.changes?.length) record.item.changes = previous.item.changes
      if (end && record.item?.type === 'fileChange' && previous?.item?.changes) {
        record.item.changes = record.item.changes?.map((c: any) => ({ ...previous.item!.changes.find((p: any) => p.path === c.path), ...c }))
      }
      if (record.event === 'item/fileChange/patchUpdated') record.item = { ...previous?.item, type: 'fileChange', id: record.itemId, changes: record.data?.changes }
      this.items.set(key, record)
      if (end) this.completed.add(key)
      if (start) this.started.add(key)
    }
    this.records.push(record)
    // Exec todos can repeat the same snapshot at started/updated/completed.
    if (['todo_list', 'plan_update'].includes(record.item?.type)) {
      const planKey = JSON.stringify([record.threadId, record.turnId, record.itemId, record.item?.type])
      const value = stableJSON(record.item)
      if (this.plans.get(planKey) === value) return { record, render: false }
      this.plans.set(planKey, value)
    }
    return { record, render: true }
  }
}

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
  | { kind: 'warning'; text: string }
  | { kind: 'question'; question: Question }
  // runner-only lines (app-server transport)
  | { kind: 'turn'; id: string }
  | { kind: 'steer'; id: string; accepted: boolean; reason?: string; outcome: MessageOutcome }
  | { kind: 'protocol'; types: string[] }
  | { kind: 'fatal'; text: string }
  // a line that is not JSON, or of a type `codex exec --json` does not print
  | { kind: 'unknown'; type: string }
  | { kind: 'other' }

type ActionResult = Record<string, unknown> | { type: 'text'; text: string }[]

/** One of Codex's actions as a tool call, and the result it is answered with. */
export type Action = { tool: string; input: Record<string, unknown>; result: ActionResult; error?: string; source?: SourceRecord; patchPath?: string; mirror?: string }

type NativeName = typeof NATIVE_TOOLS[number]
type NativeResult = BuiltinToolResults[Exclude<NativeName, 'Glob' | 'Grep'>] | GlobResult | GrepResult
type DisplayResult = { type: 'text'; text: string }[]
type GuardAnswer = { result: NativeResult | DisplayResult } | { deny: string }
const object = (v: unknown): v is Record<string, any> => v !== null && typeof v === 'object' && !Array.isArray(v)
const strings = (v: unknown): v is string[] => Array.isArray(v) && v.every(s => typeof s === 'string')
const number = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0
const keysOnly = (v: Record<string, unknown>, keys: string[]) => Object.keys(v).every(key => keys.includes(key))
const textBlocks = (v: unknown): v is DisplayResult => Array.isArray(v) && v.every(b => object(b) && keysOnly(b, ['type', 'text']) && b.type === 'text' && typeof b.text === 'string')
const hunks = (v: unknown): boolean => Array.isArray(v) && v.every(h => object(h) &&
  keysOnly(h, ['oldStart', 'oldLines', 'newStart', 'newLines', 'lines']) &&
  ['oldStart', 'oldLines', 'newStart', 'newLines'].every(k => number(h[k]) && Number.isInteger(h[k])) && strings(h.lines))
const todos = (v: unknown): boolean => Array.isArray(v) && v.every(t => object(t) &&
  keysOnly(t, ['content', 'status', 'activeForm']) && typeof t.content === 'string' && typeof t.activeForm === 'string' && ['pending', 'in_progress', 'completed'].includes(t.status))

/** Canonical, collision-free JSON binding, including nested display arguments. */
const stableJSON = (value: unknown): string => JSON.stringify(value, (_key, v) =>
  object(v) ? Object.fromEntries(Object.keys(v).sort().map(key => [key, v[key]])) : v)

/** Validate our deliberately bounded result subset before emission AND consumption. */
export function validAction(a: Action): a is Action & { result: NativeResult | DisplayResult } {
  const i = a.input
  const r = a.result
  if (!object(i)) return false
  if (a.tool === 'Read' && validImage(a)) return true
  if (['Read', 'Glob', 'Grep'].includes(a.tool)) return a.error === undefined && validExploration(a)
  if (a.tool === 'AskUserQuestion') return a.error === undefined && validAnsweredQuestion(a)
  if (a.tool === 'ReportFindings') {
    const expected = findingsAction(i)
    return expected !== undefined && keysOnly(i, ['findings', 'level']) && stableJSON(r) === stableJSON(expected.result)
  }
  let inputOK = false
  if (a.tool === 'Bash') inputOK = keysOnly(i, ['command', 'description']) && typeof i.command === 'string' && typeof i.description === 'string'
  else if (a.tool === 'Edit') inputOK = keysOnly(i, ['file_path', 'old_string', 'new_string', 'replace_all']) && ['file_path', 'old_string', 'new_string'].every(k => typeof i[k] === 'string') && (i.replace_all === undefined || i.replace_all === false)
  else if (a.tool === 'Write') inputOK = keysOnly(i, ['file_path', 'content']) && typeof i.file_path === 'string' && typeof i.content === 'string'
  else if (a.tool === 'WebSearch') inputOK = keysOnly(i, ['query', 'mode']) && typeof i.query === 'string' && i.query !== '' && ['standard', 'extended'].includes(i.mode)
  else if (a.tool === 'WebFetch') inputOK = keysOnly(i, ['url', 'prompt']) && typeof i.url === 'string' && i.url !== '' && typeof i.prompt === 'string'
  else if (a.tool === 'Agent') inputOK = keysOnly(i, ['description', 'prompt', 'subagent_type']) && typeof i.description === 'string' && typeof i.prompt === 'string' && (i.subagent_type === 'codex-mod:codex' || i.subagent_type === 'codex-mod:codex-child' && validMirrorLink(a))
  else if (a.tool === 'TodoWrite') inputOK = keysOnly(i, ['todos']) && todos(i.todos)
  else if (a.tool === 'TaskCreate') inputOK = keysOnly(i, ['subject', 'description', 'activeForm', 'metadata']) && typeof i.subject === 'string' && i.subject.startsWith('Codex plan: ') && typeof i.description === 'string' && typeof i.activeForm === 'string' && object(i.metadata) && keysOnly(i.metadata, ['codexPlan', 'sourceThread', 'sourceRevision']) && i.metadata.codexPlan === true && typeof i.metadata.sourceThread === 'string' && Number.isInteger(i.metadata.sourceRevision) && i.metadata.sourceRevision > 0
  else if (a.tool === 'TaskUpdate') inputOK = keysOnly(i, ['taskId', 'status', 'description']) && typeof i.taskId === 'string' && i.taskId.startsWith('codex-plan-') && (i.status === undefined || ['pending', 'in_progress', 'completed', 'deleted'].includes(i.status)) && (i.description === undefined || typeof i.description === 'string') && Object.keys(i).length > 1
  else if (a.tool === 'TaskStop') inputOK = keysOnly(i, ['task_id']) && typeof i.task_id === 'string' && i.task_id.startsWith('codex-display-')
  else if (a.tool === 'SendMessage') inputOK = keysOnly(i, ['to', 'message', 'summary']) && object(i.to) && keysOnly(i.to, ['agentId']) && typeof i.to.agentId === 'string' && i.to.agentId.startsWith('codex-display-') && typeof i.message === 'string' && i.message !== '' && typeof i.summary === 'string'
  else if (isDisplay(a.tool) || a.tool === 'codex_tool') inputOK = keysOnly(i, ['server', 'name', 'arguments']) && typeof i.server === 'string' && typeof i.name === 'string' && 'arguments' in i
  // Display names are host-owned; use their registered identity to choose the input schema.
  if (a.tool === displayTools.codex_plan || a.tool === 'codex_plan') inputOK = keysOnly(i, ['steps', 'explanation']) && (i.explanation === undefined || typeof i.explanation === 'string') && Array.isArray(i.steps) && i.steps.every(s => object(s) && keysOnly(s, ['step', 'status']) && typeof s.step === 'string' && ['pending', 'in_progress', 'completed'].includes(s.status))
  if (a.tool === displayTools.coordinator_message) inputOK = keysOnly(i, ['sourceUuid', 'text']) && typeof i.sourceUuid === 'string' && typeof i.text === 'string'
  if (!inputOK) return false
  if (a.error !== undefined) return typeof a.error === 'string' && a.error !== ''
  if (!isNative(a.tool)) return textBlocks(r)
  if (!object(r)) return false
  switch (a.tool) {
    case 'Bash': {
      const d = r.bashEditDiff
      return keysOnly(r, ['stdout', 'stderr', 'interrupted', 'bashEditDiff']) && typeof r.stdout === 'string' && typeof r.stderr === 'string' && typeof r.interrupted === 'boolean' &&
        (d === undefined || (object(d) && keysOnly(d, ['files', 'moreFiles', 'changedFiles']) && d.moreFiles === 0 && strings(d.changedFiles) && Array.isArray(d.files) &&
          d.files.every(f => object(f) && keysOnly(f, ['filePath', 'hunks', 'created', 'deleted']) && typeof f.filePath === 'string' && hunks(f.hunks) &&
            (f.created === undefined || f.created === true) && (f.deleted === undefined || f.deleted === true) && !(f.created && f.deleted)) &&
          stableJSON(d.changedFiles) === stableJSON(d.files.map(f => f.filePath))))
    }
    case 'Edit': return keysOnly(r, ['filePath', 'oldString', 'newString', 'originalFile', 'structuredPatch', 'userModified', 'replaceAll']) && r.filePath === i.file_path && r.oldString === i.old_string && r.newString === i.new_string && (r.originalFile === null || typeof r.originalFile === 'string') && hunks(r.structuredPatch) && r.userModified === false && r.replaceAll === false
    case 'Write': return keysOnly(r, ['type', 'filePath', 'content', 'structuredPatch', 'originalFile']) && ['create', 'update'].includes(r.type) && r.filePath === i.file_path && r.content === i.content && hunks(r.structuredPatch) && (r.originalFile === null || typeof r.originalFile === 'string')
    case 'WebSearch': return keysOnly(r, ['query', 'results', 'durationSeconds']) && r.query === i.query && number(r.durationSeconds) && Array.isArray(r.results) && r.results.every(s => typeof s === 'string' || (object(s) && keysOnly(s, ['tool_use_id', 'content']) && typeof s.tool_use_id === 'string' && s.tool_use_id !== '' && Array.isArray(s.content) && s.content.every(c => object(c) && keysOnly(c, ['title', 'url', 'snippet']) && typeof c.title === 'string' && typeof c.url === 'string' && (c.snippet === undefined || typeof c.snippet === 'string'))))
    case 'WebFetch': return validFetchResult(r, i.url)
    case 'TodoWrite': return keysOnly(r, ['oldTodos', 'newTodos']) && todos(r.oldTodos) && todos(r.newTodos) && stableJSON(r.newTodos) === stableJSON(i.todos)
    case 'TaskCreate': return keysOnly(r, ['task']) && object(r.task) && keysOnly(r.task, ['id', 'subject']) && typeof r.task.id === 'string' && r.task.id.startsWith('codex-plan-') && r.task.subject === i.subject
    case 'TaskUpdate': return keysOnly(r, ['success', 'taskId', 'updatedFields', 'statusChange']) && r.success === true && r.taskId === i.taskId && stableJSON(r.updatedFields) === stableJSON(Object.keys(i).filter(k => k !== 'taskId')) && (r.statusChange === undefined || (object(r.statusChange) && keysOnly(r.statusChange, ['from', 'to']) && ['pending', 'in_progress', 'completed'].includes(r.statusChange.from) && r.statusChange.to === i.status))
    case 'TaskStop': return keysOnly(r, ['message', 'task_id', 'task_type']) && r.task_id === i.task_id && r.task_type === 'codex' && typeof r.message === 'string' && r.message !== ''
    case 'SendMessage': return keysOnly(r, ['status', 'agentsStates']) && r.status === 'completed' && object(r.agentsStates)
    case 'Agent': {
      const u = r.usage
      return keysOnly(r, ['agentId', 'agentType', 'status', 'prompt', 'content', 'canContinueAgent', 'totalToolUseCount', 'totalDurationMs', 'totalTokens', 'usage', 'resolvedModel']) && typeof r.agentId === 'string' && r.agentType === i.subagent_type && r.status === 'completed' && r.prompt === i.prompt && textBlocks(r.content) && r.canContinueAgent === false && ['totalToolUseCount', 'totalDurationMs', 'totalTokens'].every(k => r[k] === 0) && (r.resolvedModel === undefined || typeof r.resolvedModel === 'string') && object(u) && keysOnly(u, ['input_tokens', 'output_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens', 'server_tool_use', 'service_tier', 'cache_creation']) && u.input_tokens === 0 && u.output_tokens === 0 && ['cache_creation_input_tokens', 'cache_read_input_tokens', 'server_tool_use', 'service_tier', 'cache_creation'].every(k => u[k] === null)
    }
  }
  return false
}

type Usage = { input: number; cached: number; output: number }

const oneLine = (text: string, max = 160): string => {
  const t = text.replace(/\s+/g, ' ').trim()
  return t.length > max ? `${t.slice(0, max - 3)}...` : t
}

const changesOf = (item: any): FileChange[] =>
  Array.isArray(item?.changes)
    ? item.changes.filter((c: any) => typeof c?.path === 'string' && c.path !== '').map((c: any) => ({ ...c }))
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
    if (type === 'codexmod.request' && typeof ev.token === 'string' && typeof ev.method === 'string') return { kind: 'question', question: ev }
    if (type === 'codexmod.warning' || type === 'codexmod.responseRejected') return { kind: 'warning', text: String(ev.message ?? 'warning') }
    if (type === 'codexmod.turn' && typeof ev.turn_id === 'string') return { kind: 'turn', id: ev.turn_id }
    if (type === 'codexmod.steer' && (typeof ev.id === 'string' || typeof ev.id === 'number')) {
      return { kind: 'steer', id: String(ev.id), accepted: ev.status === 'accepted' || ev.status === 'observed', outcome: ev as unknown as MessageOutcome, ...(typeof ev.reason === 'string' ? { reason: ev.reason } : {}) }
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
    return { kind: ['commentary', 'partial_answer'].includes(item.phase) ? 'interim' : 'message', text: item.text }
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
      return { kind: 'action', display: 'codex_plan', action: { tool: 'codex_plan', input, result: [{ type: 'text', text: planText(input) }] } }
    }
  }
  // Only completed items have reliable queries and tool results. JSON.parse
  // keeps exec's last repeated id key; the source ledger deduplicates that id.
  if (ev.type === 'item.completed') {
    if (item?.type === 'reasoning') {
      const text = Array.isArray(item.summary) ? item.summary.filter((s: unknown) => typeof s === 'string').join('\n\n') : typeof item.text === 'string' ? item.text : ''
      return text.trim() ? { kind: 'thinking', text } : { kind: 'other' }
    }
    if (item?.type === 'web_search') {
      const action = webAction(ev.source?.item ?? item)
      return { kind: 'action', action, ...(action.tool === 'codex_tool' ? { display: 'codex_tool' as const } : {}) }
    }
    if (item?.type === 'mcp_tool_call' || item?.type === 'dynamic_tool_call') {
      return { kind: 'action', display: 'codex_tool', action: toolFallback(ev.source?.item ?? item, 'Host input schema and verified server binding unavailable; replacement contract unknown.') }
    }
    if (item?.type === 'proposed_plan' && typeof item.text === 'string') return { kind: 'interim', text: `Proposed plan:\n${item.text}` }
    if (item?.type === 'error') return { kind: 'warning', text: String(item.message ?? 'Codex warning') }
    if (item?.type === 'note' && typeof item.text === 'string') return { kind: 'note', text: `↪ ${oneLine(item.text, 300)}`, ...(item.dim === true ? { dim: true as const } : {}) }
    if (item?.type === 'collab_tool_call' || item?.type === 'collabAgentToolCall') {
      return childRows(item, emptyDisplayState(), { session: 'unreported', agent: 'unreported', thread: 'unreported', rich: richRows, tools: new Set(richRows ? ['Agent'] : []) })[0] ?? { kind: 'other' }
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
  if (item && ![...Object.keys(ITEM_TYPES), ...Object.values(ITEM_TYPES), 'note', 'todo_list', 'plan_update', 'source_only', 'error'].includes(item.type)) return { kind: 'unknown', type: `item ${String(item.type)}` }
  return { kind: 'other' }
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
export function coordinatorPayload(text: string, verbatim = false): string | undefined {
  // Match the host's closing tag (including its id), beyond any tags in the body.
  const raw = /<system-reminder(\s[^>]*)?>\nThe coordinator sent a message while you were working:[ \t]*\n([\s\S]*)<\/system-reminder\1>/.exec(text)?.[2]
  if (raw !== undefined) {
    const suffix = '\n\nAddress this before completing your current task.\n'
    const body = raw.endsWith(suffix) ? raw.slice(0, -suffix.length) : raw.endsWith('\n') ? raw.slice(0, -1) : raw
    return verbatim ? body : body.trim()
  }
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
  latest?: { text: string; count: number; coordinator?: true }
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
    const payload = coordinatorPayload(it.text)
    const text = payload ?? cleanText(it.text)
    if (text === '') {
      if (sawAssistant) nudged = true
      continue
    }
    count++
    latest = { text, count, ...(payload !== undefined ? { coordinator: true as const } : {}) }
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
 * The footer line retains the full thread ID; token counts are rounded for display.
 * an app-server run adds `app-server` (and `N steers`) after the sandbox, a fallback run why it is exec.
 */
export function footer(p: Profile & { agent: string; actions: number; usage?: Usage; thread?: string; transport?: string; steers?: number; patches?: number; patchRows?: number; usagePartial?: boolean; treeUsage?: TreeSnapshot; configNote?: string }, mode: FooterMode = 'full'): string {
  if (mode === 'off') return ''
  if (mode === 'short') return [p.agent, p.model, p.effort, p.configNote].filter(Boolean).join(' · ')
  const parts = [p.agent, p.model, p.effort, p.sandbox]
  if (p.transport !== undefined) parts.push(p.transport)
  if (p.steers !== undefined && p.steers > 0) parts.push(`${p.steers} steer${p.steers === 1 ? '' : 's'}`)
  parts.push(`${p.actions} action${p.actions === 1 ? '' : 's'}`)
  if (p.patches) parts.push(`${p.patches} patch${p.patches === 1 ? '' : 'es'} / ${p.patchRows} file row${p.patchRows === 1 ? '' : 's'}`)
  if (p.usagePartial) parts.push('direct usage partial/unknown')
  else if (p.usage !== undefined) {
    const fresh = Math.max(0, p.usage.input - p.usage.cached)
    parts.push(`${compact(fresh)} new tokens (${compact(p.usage.cached)} cached, ${compact(p.usage.output)} out)`)
  }
  if (p.treeUsage) {
    const t = p.treeUsage
    const exact = (n: number) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
    parts.push(`tree ${exact(t.tree.input + t.tree.output)} tokens (direct ${exact(t.direct.input + t.direct.output)}; children ${exact(t.tree.input + t.tree.output - t.direct.input - t.direct.output)}) · new ${compact(t.tree.input - t.tree.cached)} / cached ${compact(t.tree.cached)} / out ${compact(t.tree.output)}${t.active || t.missing ? ` (partial: ${t.active} active, ${t.missing} missing)` : ''}`)
  }
  if (p.thread !== undefined) parts.push(`thread ${p.thread}`)
  if (p.configNote) parts.push(p.configNote)
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

/** One resolver for spawn presentation and execution. Explicit prompt errors
 * still fail the run; an unsupported native Agent effort uses the default. */
export function resolveProfile(base: Profile, task: string, list?: readonly ModelInfo[], nativeEffort?: unknown): { profile: Profile; rest: string; note?: string; invalid?: string } {
  const o = parseOverrides(executionRequest(task).rest)
  const model = o.model ?? (base.model || list?.[0]?.slug || FALLBACK_MODEL)
  const info = list?.find(m => m.slug === model)
  const defaultEffort = base.effort || info?.defaultEffort || FALLBACK_EFFORT
  let effort = o.effort ?? defaultEffort
  let note: string | undefined
  if (o.effort === undefined && nativeEffort !== undefined) {
    const supported = info?.efforts.length ? info.efforts : ['low', 'medium', 'high', 'xhigh', 'max', 'ultra']
    if (typeof nativeEffort === 'string' && supported.includes(nativeEffort)) effort = nativeEffort
    else {
      effort = supported.includes(defaultEffort) ? defaultEffort
        : info?.defaultEffort && supported.includes(info.defaultEffort) ? info.defaultEffort : supported[0]!
      const supplied = typeof nativeEffort === 'string' ? oneLine(nativeEffort, 80) : typeof nativeEffort
      note = `Agent effort ${JSON.stringify(supplied)} is not supported by ${model}; using default ${effort}`
    }
  }
  return { profile: { model, effort, sandbox: base.sandbox }, rest: o.rest, note, invalid: checkProfile(list, model, effort) }
}

export const modelTitle = (profile: Pick<Profile, 'model' | 'effort'>, description: string): string =>
  `Codex ${profile.model} · ${profile.effort} · ${description}`

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

// Labels alone use this bounded scanner. It never evaluates shell syntax or
// supplies evidence for the separate, stricter native exploration classifier.
function shellLabelParts(command: string): string[] | undefined {
  if (command.length > 8192) return undefined
  const parts: string[] = []
  let quote = '', start = 0
  for (let i = 0; i < command.length; i++) {
    const c = command[i]!
    if (quote === "'") { if (c === "'") quote = ''; continue }
    if (c === '\\') { if (i + 1 >= command.length || command[i + 1] === '\n') return undefined; i++; continue }
    if (quote === '"') {
      if (c === '"') quote = ''
      else if ('$`'.includes(c)) return undefined
      continue
    }
    if (c === "'" || c === '"') { quote = c; continue }
    if ('\r\0<>($`){}#'.includes(c)) return undefined
    if (';|&\n'.includes(c)) {
      const part = command.slice(start, i).trim()
      if (part) parts.push(part)
      if (parts.length > 6) return undefined
      start = i + 1
    }
  }
  if (quote) return undefined
  const tail = command.slice(start).trim()
  if (tail) parts.push(tail)
  return parts.length && parts.length <= 6 ? parts : undefined
}

const COMMAND_FAMILIES = ['git', 'npm', 'pnpm', 'yarn', 'bun', 'npx', 'cargo', 'go', 'make', 'uv', 'pip', 'swift', 'gh']
const commandProgram = (words: string[]) => {
  const prog = (words[0] ?? '').split('/').pop() ?? ''
  return /^[\w.+-]{1,40}$/.test(prog) && activityOperand(prog) ? prog : undefined
}
const commandName = (words: string[], prog: string) => {
  const sub = COMMAND_FAMILIES.includes(prog) ? words.slice(1).find(w => !w.startsWith('-')) : undefined
  return sub && /^[\w.+-]{1,40}$/.test(sub) && activityOperand(sub) ? `${prog} ${sub}` : prog
}

// Titles expose selected literal operands, never arbitrary flags, environment
// assignments or script bodies. Keep controls and common credential forms out.
function activityOperand(value: unknown, max = 72): string | undefined {
  if (typeof value !== 'string' || !value || /[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/.test(value) ||
    /(?:\b(?:password|passwd|token|secret|api[_-]?key|authorization)\s*[:=]|\bBearer\s|\b(?:sk-|gh[pousr]_)[\w-]{8,}|-----BEGIN)/i.test(value)) return undefined
  return value.length > max ? `${value.slice(0, 24)}...${value.slice(-(max - 27))}` : value
}

const activityPath = (path: string, cwd?: string) => {
  if (!path || /[\x00-\x1f\x7f]/.test(path) || path.split('/').includes('..')) return undefined
  if (!path.startsWith('/') && !cwd?.startsWith('/')) return path.replace(/^\.\//, '')
  return '/' + (path.startsWith('/') ? path : `${cwd}/${path}`).split('/').filter(p => p && p !== '.').join('/')
}

function readActivity(words: string[], prog: string): string | undefined {
  let args = words.slice(1)
  let verb = 'Read'
  if (prog === 'head' || prog === 'tail') {
    verb = prog === 'head' ? 'Read start of' : 'Read end of'
    if (args[0] === '-n' && /^\+?\d+$/.test(args[1] ?? '')) args = args.slice(2)
  } else if (prog === 'nl') {
    verb = 'Read with line numbers'
    if (args[0] === '-ba') args = args.slice(1)
  } else if (prog === 'sed') {
    if (args[0] !== '-n' || !/^\d+(?:,\d+)?p$/.test(args[1] ?? '')) return undefined
    verb = 'Read part of'
    args = args.slice(2)
  } else if (prog !== 'cat') return undefined
  if (args[0] === '--') args = args.slice(1)
  if (args.length !== 1 || args[0]!.startsWith('-')) return undefined
  const path = activityOperand(args[0])
  return path ? `${verb} ${path}` : undefined
}

function testActivity(words: string[], prog: string): string | undefined {
  let args = words.slice(1)
  if (['python', 'python3'].includes(prog) && args[0] === '-m' && args[1] === 'pytest') args = args.slice(2)
  else if (prog === 'uv' && args[0] === 'run' && args[1] === 'pytest') args = args.slice(2)
  else if (prog !== 'pytest') return undefined
  const targets = args.filter(arg => !['-q', '-v', '-vv', '-x', '-s', '--verbose', '--quiet', '--exitfirst'].includes(arg))
  // Unknown options may consume the next word; never present that value as a target.
  if (targets.length > 2 || targets.some(t => t.startsWith('-') || !activityOperand(t))) return undefined
  return `Run pytest${targets.length ? ` ${targets.map(t => activityOperand(t)).join(', ')}` : ''}`
}

function sourceActivity(words: string[], prog: string, part: string, command: string, source?: SourceRecord): string | undefined {
  const item = source?.item
  if (!item || item.type !== 'commandExecution' || item.command !== command ||
    !Array.isArray(item.commandActions) || item.commandActions.length > 6) return undefined
  const matches = item.commandActions.filter((a: any) => a && typeof a.command === 'string' &&
    (a.command === part || (part === unwrapShell(command) && a.command === command)))
  if (matches.length !== 1) return undefined
  const action = matches[0]
  if (action.type !== 'search' || !['rg', 'grep'].includes(prog)) return undefined
  let query: string | undefined
  const paths: string[] = []
  let options = true
  for (let n = 1; n < words.length; n++) {
    const word = words[n]!
    if (options && word === '--') { options = false; continue }
    if (options && word.startsWith('-')) {
      if (['-n', '-i', '-F', '-S', '-s', '-l', '-H', '-r', '-R', '-0', '--null', '--json', '--hidden', '--no-ignore', '--fixed-strings', '--files-with-matches', '--count-matches'].includes(word)) continue
      if (['-g', '--glob', '-t', '--type', '-A', '-B', '-C', '--max-count'].includes(word) && words[n + 1] !== undefined) { n++; continue }
      return undefined
    }
    if (query === undefined) query = word
    else paths.push(word)
  }
  // The metadata must agree with the literal command, including its search root.
  if (query !== action.query || paths.length !== 1 || paths[0] === '-' || typeof action.path !== 'string' ||
    !activityPath(paths[0]!, source?.cwd) || activityPath(paths[0]!, source?.cwd) !== activityPath(action.path, source?.cwd)) return undefined
  const label = activityOperand(query, 60)
  const path = activityOperand(paths[0])
  return label && path ? `Search ${label} in ${path}` : undefined
}

/** A short description of the whole command, without inferring its result. */
export function describeCommand(command: string, source?: SourceRecord, original = command): string {
  // Unwrapping is also used for display, but an expanding outer shell word
  // cannot establish literal operands for a richer activity title.
  if (original !== command && (original.length > 8192 || !literalWords(original))) return 'Run shell command'
  if (/^\s*(?:if|case)\b/.test(command)) return 'Run conditional shell command'
  if (/^\s*(?:for|while|until|select|function)\b/.test(command)) return 'Run compound shell command'
  const parts = shellLabelParts(command)
  if (!parts) return 'Run shell command'
  if (parts.some(p => /^(?:if|elif|then|else|fi|case|esac)\b/.test(p))) return 'Run conditional shell command'
  if (parts.some(p => /^(?:for|while|until|do|done|select|function)\b/.test(p))) return 'Run compound shell command'
  const commands = parts.map(p => literalWords(p))
  if (commands.some(words => !words || !commandProgram(words))) return 'Run shell command'
  if (commands.length > 1) {
    const labels = commands.map((words, n) => {
      const prog = commandProgram(words!)!
      return sourceActivity(words!, prog, parts[n]!, original, source) ?? readActivity(words!, prog) ??
        testActivity(words!, prog) ?? commandName(words!, prog)
    })
    return oneLine(`Run shell commands: ${labels.join(', ')}`, 240)
  }
  const words = commands[0]!
  const prog = commandProgram(words)!
  const activity = sourceActivity(words, prog, parts[0]!, original, source) ?? readActivity(words, prog) ?? testActivity(words, prog)
  if (activity) return activity
  if (prog === 'sed') return words.includes('-i') ? 'Edit file in place' : 'Read part of a file'
  if (COMMAND_FAMILIES.includes(prog)) return `Run ${commandName(words, prog)}`
  return DESCRIBE[prog] ?? (prog ? `Run ${prog}` : 'Run a command')
}

/** A finished command as a `Bash` call answered with Codex's output and exit code. */
export function commandAction(command: string, output: string, exitCode: number | null, status?: string, source?: SourceRecord): Action {
  const inner = unwrapShell(command)
  return {
    tool: 'Bash',
    input: { command: inner, description: `${describeCommand(inner, source, command)}${exitCode === null ? ' (exit unreported)' : ''}` },
    result: {
      stdout: output,
      stderr: '',
      interrupted: false,
    } satisfies BuiltinToolResults['Bash'],
    ...((exitCode !== null && exitCode !== 0) || ['failed', 'declined'].includes(status ?? '') ? {
      error: `Codex command ${status === 'declined' ? 'was declined' : 'failed'}${exitCode !== null ? ` (exit code ${exitCode})` : ''}:\n${output}`,
    } : {}),
  }
}

/** One action as a plain text line (nativeActions off). */
export function actionLine(a: Action): string {
  if (['Read', 'Glob', 'Grep'].includes(a.tool)) return `$ ${oneLine(String(a.source?.item?.command), 300)} (${a.tool}, cwd ${String(a.source?.cwd)})`
  if (a.tool === 'Edit') return `Edited ${String(a.input.file_path)}`
  if (a.tool === 'TodoWrite') return planText({ ...(typeof a.source?.item?.explanation === 'string' ? { explanation: a.source.item.explanation } : {}), steps: (a.input.todos as { content: string; status: 'pending' | 'in_progress' | 'completed' }[]).map(t => ({ step: t.content, status: t.status })) })
  if (['Agent', 'TodoWrite', 'TaskCreate', 'TaskUpdate', 'SendMessage', 'TaskStop'].includes(a.tool)) return `Codex ${a.tool} (display only):\n${JSON.stringify(a.input)}\n${a.error ?? JSON.stringify(a.result)}`
  if (a.tool === 'WebFetch') return `Codex ${a.source?.item?.action?.type ?? 'openPage'}: ${String(a.input.url)}\n${a.error ?? JSON.stringify(a.result)}`
  if (a.tool === 'WebSearch') return `Searched by Codex: ${String(a.input.query)}\n${a.error ?? JSON.stringify(a.result)}${sourceDuration(a.source) === undefined ? '\nDuration unreported (0-second display sentinel).' : ''}`
  if ('server' in a.input) return `Codex called ${oneLine(String(a.input.server))}.${oneLine(String(a.input.name))}\n${a.error ?? (Array.isArray(a.result) ? a.result.map(b => b.text).join('\n') : JSON.stringify(a.result))}`
  if ('steps' in a.input) return planText(a.input as PlanInput)
  const result = Array.isArray(a.result) ? {} : a.result
  if (a.tool === 'Write') return `${result.type === 'create' ? 'Created' : 'Wrote'} ${String(a.input.file_path)}`
  const cmd = String(a.input.command)
  if (cmd.startsWith('# Codex apply_patch: ')) return `${String(a.input.description)}\n${a.error ?? result.stdout}`
  const err = String(result.stderr ?? '')
  const status = a.error ? /exit code \d+/.exec(a.error)?.[0] ?? 'failed or declined' : err.toLowerCase()
  return `$ ${oneLine(cmd, 300)}${status !== '' ? ` (${status})` : ''}`
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
/** The real Codex home: CODEX_HOME, else ~/.codex. */
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

/** History commands accept only a source UUID, never Codex's name-based fallback. */
async function sessionHistory($: EngineInterface, codex: string, home: string, operation: 'archive' | 'unarchive', thread: string): Promise<boolean> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(thread)) {
    $.ui.log(`codex-mod: session ${operation} skipped: source thread UUID unavailable`, { to: 'debug' })
    return false
  }
  try {
    // process.run has no env override. Pass an assignment through env as one
    // argv entry, without a shell, so cleanup cannot target the ambient home.
    const result = await $.process.run(['/usr/bin/env', `CODEX_HOME=${home}`, codex, operation, '--', thread], { timeoutMs: 10000 })
    if (result.exitCode === 0) return true
    $.ui.log(`codex-mod: session ${operation} ${thread} failed (exit ${result.exitCode}): ${oneLine(result.stderr, 300)}`, { to: 'debug' })
  } catch (err) {
    $.ui.log(`codex-mod: session ${operation} ${thread} failed: ${errText(err)}`, { to: 'debug' })
  }
  return false
}

/** Do not change history while another locally known consumer owns this source. */
const historyInUse = (thread: string, home: string): boolean => [...runs.values()].some(run =>
  !run.ended && !run.mirror && run.thread === thread && run.policy?.home === home)

/** The argv of one launch (pure). */
export function launchArgv(p: {
  codex: string
  prof: Profile
  cwd: string
  resume?: string
  lean: string[]
  extra: readonly string[]
  execution?: ExecutionPolicy
}): string[] {
  const { prof, resume } = p
  return [
    p.codex, 'exec', ...(resume ? ['resume'] : []), '--json', '--skip-git-repo-check',
    ...(resume ? ['-c', `sandbox_mode="${prof.sandbox}"`] : ['--sandbox', prof.sandbox, '-C', p.cwd]),
    '-m', prof.model, '-c', `model_reasoning_effort="${prof.effort}"`, ...p.lean,
    ...p.extra.flatMap(kv => ['-c', kv]),
    ...(p.execution ? executionOverrides(p.execution) : ['approval_policy="never"']).flatMap(kv => ['-c', kv]),
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
  questions?: boolean
  nestedAgents?: boolean
  execution?: ExecutionPolicy
}): string[] {
  const overrides = [...p.lean.filter((_, i) => p.lean[i - 1] === '-c'), ...p.extra, ...(p.execution ? executionOverrides(p.execution) : [])]
  return [
    p.node, p.runner, 'run', '--codex', p.codex, '--cwd', p.cwd,
    '--model', p.prof.model, '--effort', p.prof.effort, '--sandbox', p.prof.sandbox,
    ...(p.resume ? ['--thread', p.resume] : []),
    ...overrides.flatMap(kv => ['--config', kv]),
    '--approval-mode', p.execution?.approvalMode ?? 'never',
    '--control', p.control,
    ...(p.questions ? ['--questions', 'choices'] : []),
    ...(p.nestedAgents === false ? ['--nested', 'false'] : []),
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
export function steerNote(what: 'accepted' | 'finished' | 'queued'): string {
  if (what === 'accepted') return '↪ steer delivered to Codex mid-turn'
  if (what === 'finished') return '↪ Codex had already finished; this message runs next, on the same thread'
  return '↪ queued: runs after this turn (exec transport has no mid-turn steer)'
}

/** One Codex child and what has been read from it so far. */
type Run = {
  sessionId: string
  // Live observation timestamps only; receipt/store writes must not refresh them.
  startedAtMs?: number
  lastSourceObservedAtMs?: number
  ledger: SourceLedger
  rows: Record<string, SourceRecord | null>
  agentId: string
  name: string
  prof: Profile
  cwd: string
  child: HookStream<ProcessSpawnChunk, ProcessSpawnResult>
  // Only a launched source owns history cleanup; mirrors never get this identity.
  history?: { codex: string; home: string; archive: boolean; thread?: string; observed?: true; ambiguous?: true }
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
  patches: number
  patchRows: number
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
  mirror?: ChildMirror
  treeUsage?: TreeSnapshot
  usageCanonical?: boolean
  usagePartial?: boolean
  execBaseline?: Usage
  execTotal?: Usage
  policy?: EffectiveConfig
  execution?: ExecutionPolicy
  approvalParent?: { main?: boolean; agentId?: string; sourceId: string }
  configNote?: string
  capacityRetried?: boolean
  rawTask?: string
  messageCount?: number
  delivery?: string
  spawnDetected?: Set<string>
  observedChildren?: Set<string>
  childSources?: Map<string, SourceRecord>
  compactions?: Map<string, { notification: boolean; items: string[] }>
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
const deliveries = new Map<string, { uuid: string; text: string; messageId?: string }[]>()
// Scope native sends per target. Receive has no UUID: only a scoped delivery
// gets early control; append-only/uncorrelated ingress uses its source UUID.
// Parent assistant rows are persisted before tool dispatch, including parallel
// tool blocks sharing a UUID. Tool IDs distinguish those source messages.
const nativeSources = new Map<string, { uuid: string; text: string }>()
const nativeSends = new Map<string, { id: string; received?: string }>()
const sendGates = new Map<string, Promise<void>>()
let statusTool: string | undefined
let agentStatusTool: string | undefined
let approvalTool: string | undefined
const pendingApprovals = new Map<string, { run: Run; question: Question }>()
const MAX_DELIVERIES = 20
// tool_use id -> the answer of one action call this module emitted.
type HeldAnswer = { sessionId: string; agentId: string; action: Action; inputDigest: string; sourceDigest: string }
const answers = new Map<string, HeldAnswer>()
// Only pending guard bindings stay resident. History presentation is loaded
// lazily from fixed-size private disk slots, never as executor capabilities.
const sourceRows = new RowCache<RowPresentation>()
let seq = 0
// Set by session.start when Codex is missing or logged out.
let preflight: string | undefined
// The models Codex lists; undefined: not read yet; null: unreadable (nothing validated).
let catalog: ModelInfo[] | null | undefined
// The config of the loaded module (set by register).
let cfg: Config = parseConfig({})
// Unavailable until registration confirms the session offers it; guards stay on.
let todoWriteAvailable = false
let availableTools: Set<string> | undefined
const agentTools = new Map<string, Set<string>>()
// Session-start snapshot, refreshed only when registration is retried, never on cwd changes.
let projectRoles = new Map<string, ProjectRole>()
let modelProfiles = new Map<string, Profile>()
type ModelLaunch = { session: string; toolUseId: string; type: string; parent?: string; description: string; prompt?: string;
  profile: Profile; recordProfile: Profile; note?: string; host?: string }
// Pending launch bodies stay in memory only. Durable rows bind to agent records.
const modelLaunches = new Map<string, ModelLaunch>()
const agentEfforts = new Map<string, unknown>()
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
  hasPrefix(e.tool_use_id) || isDisplay(e.tool) || (isNative(e.tool) && isCodexAgent(e.agentId))
/** A built-in display call of a subagent whose type is not resolved yet. */
const unresolved = (e: { tool?: unknown; agentId?: unknown }): boolean =>
  isNative(e.tool) && typeof e.agentId === 'string' && !known.has(e.agentId)

/** The answer to a guarded call: the stored result of our own action, else a refusal. Never runs anything. */
export function answerGuarded(e: { tool?: unknown; tool_use_id?: unknown; agentId?: unknown; [key: string]: unknown }, sid: string, refused?: (reason: string) => void): GuardAnswer {
  const id = typeof e.tool_use_id === 'string' ? e.tool_use_id : ''
  const held = hasPrefix(id) ? answers.get(id) : undefined
  // e.tool is the dispatch name, distinct from codex_tool's input.name.
  const row = sourceRows.get(id)
  const input = Object.fromEntries(Object.entries(e).filter(([key]) => !['tool', 'tool_use_id', 'agentId', 'requestMeta', 'consent'].includes(key)))
  const reason = held === undefined ? 'missing-answer'
    : held.sessionId !== sid ? 'session'
    : held.agentId !== e.agentId ? 'agent'
    : held.action.tool !== e.tool ? 'tool'
    : !isCodexAgent(e.agentId) ? 'agent-type'
    : row === undefined ? 'missing-row'
    : row.sessionId !== sid || row.agentId !== e.agentId || row.tool !== e.tool ? 'row-binding'
    : stableJSON(input) !== held.inputDigest ? 'input'
    : row.sourceDigest !== held.sourceDigest ? 'source'
    : !validAction(held.action) ? 'action' : undefined
  if (reason !== undefined) {
    refused?.(reason)
    return { deny: `${NOT_EXECUTED} (${String(e.tool)} is display-only for Codex agents; only a stored Codex result can answer this call)` }
  }
  answers.delete(id)
  sourceRows.delete(id)
  planCards.delete(id)
  return held.action.error !== undefined ? { deny: held.action.error } : { result: held.action.result }
}

function holdAnswer(id: string, sid: string, agentId: string, action: Action): boolean {
  if (!validAction(action)) return false
  if (action.tool === 'WebSearch' && !Array.isArray(action.result) && (action.result.results as any[]).some(r => object(r) && r.tool_use_id !== id)) return false
  const status = action.source?.item?.status
  const patch = action.source?.item?.type === 'fileChange'
  const file = patch && action.patchPath !== undefined ? changesOf(action.source!.item).find(c =>
    absolute(action.source!.cwd ?? '', c.path) === action.patchPath) : undefined
  const completedFile = file?.status === 'completed'
  if (['Write', 'Edit'].includes(action.tool)) {
    const kind = typeof file?.kind === 'string' ? file.kind : file?.kind?.type
    const move = typeof file?.kind === 'object' ? file.kind?.move_path : file?.move_path
    if (!file || action.patchPath !== action.input.file_path || move || kind !== (action.tool === 'Write' ? 'add' : 'update')) return false
  }
  // Unconfirmed patches still need native error rows. Individual success must
  // be explicitly reported for this file; a sampled filesystem change cannot grant it.
  if (patch && !action.error && status !== 'completed' && !completedFile) return false
  const generation = action.source?.item?.type === 'imageGeneration' && action.tool === displayTools.codex_tool
  if (status !== undefined && !['completed', 'failed', 'declined'].includes(status) && !completedFile && !(patch && action.error) && !generation) return false
  const noMatches = ['Grep', 'Bash'].includes(action.tool) && action.source?.item?.exitCode === 1 && explorationAction(action.source)?.tool === 'Grep'
  if (['failed', 'declined'].includes(status) && !action.error && !noMatches && !completedFile && !(status === 'failed' && action.tool === 'WebFetch' && !Array.isArray(action.result) && Number(action.result.code) >= 400)) return false
  // Snapshot before handing anything to core; later caller/input mutations must
  // never alter the answer or its source binding.
  const snapshot: Action = JSON.parse(JSON.stringify(action))
  const source = snapshot.source
  const sourceDigest = fingerprint(stableJSON(source ?? null)).sha256
  const item = source?.item
  const receivers = item?.receiverThreadIds ?? item?.receiver_thread_ids
  const states = item?.agentsStates ?? item?.agents_states
  const short = (v: unknown) => typeof v === 'string' ? v.slice(0, 256) : undefined
  const label = item?.type === 'webSearch' ? `Codex web.${item.action?.type ?? 'other'}`
    : item && ['mcpToolCall', 'dynamicToolCall'].includes(item.type) ? `Codex ${item.server ?? item.namespace ?? 'dynamic'}.${item.tool}` : undefined
  sourceRows.set(id, { sessionId: sid, agentId, tool: snapshot.tool, sourceDigest, label: short(label), childThread: short(source?.data?.thread_id),
    model: short(item?.model ?? states?.[receivers?.[0]]?.model), effort: short(item?.reasoningEffort ?? item?.reasoning_effort) })
  answers.set(id, { sessionId: sid, agentId, action: snapshot, inputDigest: stableJSON(snapshot.input), sourceDigest })
  return true
}

/** The profile of an agent type name; undefined for a name this module does not define. */
const profileOf = (name: string): Profile | undefined => {
  if (name === 'codex') return { ...cfg.generic }
  const role = projectRoles.get(name) ?? modelProfiles.get(name)
  return role === undefined ? undefined : { model: role.model, effort: role.effort, sandbox: role.sandbox }
}

function ownedSpawn($: EngineInterface, e: any): string | undefined {
  const prefix = `${$.plugin.name}:`
  if (typeof e.subagentType !== 'string' || !e.subagentType.startsWith(prefix)) return
  const provider = e.provider?.plugin
  if (provider !== $.plugin.name && !(typeof provider === 'string' && provider.startsWith(`${$.plugin.name}@`))) return
  return e.subagentType.slice(prefix.length)
}

async function bindModelLaunch($: EngineInterface, launch: ModelLaunch, host: string): Promise<void> {
  const alreadyBound = launch.host === host
  launch.host = host
  const rec = await loadRecord($, host) ?? { ...launch.recordProfile, agentName: launch.type.slice(launch.type.indexOf(':') + 1), updatedAt: 0 }
  if (!alreadyBound && !runs.has(host)) Object.assign(rec, launch.recordProfile)
  rec.selection ??= { session: launch.session, toolUseId: launch.toolUseId, type: launch.type,
    launchModel: launch.profile.model, launchEffort: launch.profile.effort, note: launch.note }
  rec.selection.session = launch.session
  const ids = [...new Set([...(rec.modelRowIds ?? [rec.selection.toolUseId]), launch.toolUseId])].filter(id => id.length <= 128)
  rec.modelRowIds = [ids[0]!, ...ids.slice(1).slice(-7)].filter(Boolean)
  delete launch.prompt
  known.set(host, rec.agentName)
  await saveRecord($, host, rec)
  $.ui.invalidate('ui.render')
}

/** Core may start the first step before its spawn acknowledgement. Bind only
 * a unique pending launch with the host's actual type/title/parent identity. */
async function bindPendingModelLaunch($: EngineInterface, host: string, text?: string): Promise<void> {
  if ((await loadRecord($, host))?.selection) return
  const sid = await sessionId($)
  const pending = [...modelLaunches.values()].filter(l => l.session === sid && !l.host && (text === undefined || l.prompt === text))
  if (!pending.length) return
  const info = (await $.agent.list()).find(a => a.id === host)
  if (!info) return
  const matches = pending.filter(l => l.type === info.type && l.description === info.description && l.parent === info.parentId)
  if (matches.length === 1) await bindModelLaunch($, matches[0]!, host)
  else if (matches.length > 1 && matches.every(l => stableJSON(l.recordProfile) === stableJSON(matches[0]!.recordProfile)) && !await loadRecord($, host)) {
    // Identical concurrent titles cannot establish a row ID before the ack.
    // Their agreed profile is still safe to checkpoint before the first step.
    const name = info.type.slice(info.type.indexOf(':') + 1)
    known.set(host, name)
    await saveRecord($, host, { ...matches[0]!.recordProfile, agentName: name, updatedAt: 0 })
  }
}

async function agentRowProfile($: EngineInterface, id: string): Promise<{ model: string; effort: string; note?: string } | undefined> {
  const sid = await sessionId($)
  const launch = modelLaunches.get(id)
  if (launch?.session === sid) {
    const rec = launch.host ? await loadRecord($, launch.host) : undefined
    return { ...(rec ?? launch.profile), note: launch.note }
  }
  // A reopened row has no live launch or held executor capability.
  for (const key of await $.store.keys()) {
    if (!key.startsWith(`${STORE_PREFIX}${sid}:`)) continue
    const value = await $.store.get(key)
    if (!isRecord(value) || value.selection?.session !== sid || value.selection.toolUseId !== id && !value.modelRowIds?.includes(id)) continue
    const host = key.slice(`${STORE_PREFIX}${sid}:`.length)
    const rec = await loadRecord($, host)
    if (rec) return { ...rec, note: rec.selection?.note }
  }
  const owned = sourceRows.get(id) ?? (await loadRow($, id, sid))?.row
  if (!owned || owned.sessionId !== sid || owned.tool !== 'Agent') return
  const mirror = owned.childThread ? mirrors.get(mirrorKey(sid, owned.childThread)) : undefined
  if (mirror) return { model: mirror.model, effort: mirror.effort }
  if (owned.model) return { model: owned.model, effort: owned.effort ?? 'unreported effort' }
}

/** Shared by launches and live steers; instructions never enter task records or rendered notes. */
const roleTask = (name: string, text: string, policy?: EffectiveConfig): string =>
  policyTask(policy ?? { instructions: projectRoles.get(name)?.instructions, multiAgent: !cfg.lean }, text)

type TreeSnapshot = { direct: Usage; tree: Usage; children: number; missing: number; active: number }
type ChildMirror = {
  version: 1; session: string; thread: string; parentThread: string; parentHost: string
  host?: string; hostToolId?: string; displayToolId?: string
  sourceTurn?: string; sourceItem?: string; rootTurn?: string
  control: string; generation: string; token: string; inputDigest: string; node: string; reader: string; activeTurn?: string; cwd?: string
  depth: number; model: string; effort: string; sandbox: string; path?: string
  launch: 'reserved' | 'launching' | 'bound' | 'refused' | 'uncertain'
  state: 'waiting' | 'running' | 'stopping' | 'completed' | 'failed' | 'aborted'
  messages?: { id: string; status: 'submitted' | 'accepted' | 'rejected' | 'unknown' }[]
  reason?: string; stopSent?: boolean; updatedAt: number
}
const mirrors = new Map<string, ChildMirror>()
// Only a live source step can authorize infrastructure; disk records alone cannot.
const mirrorAuthorities = new Map<string, MirrorAuthority>()
const mirrorDiagnostics = new MirrorDiagnostics()
const flushMirrorDiagnostics = ($: EngineInterface) => mirrorDiagnostics.flush(line => $.ui.log(line, { to: 'debug' }))
const mirrorKey = (sid: string, thread: string) => `mirror:${sid}:${thread}`
const validThreadId = (id: unknown): id is string => typeof id === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)
const isMirror = (m: any): m is ChildMirror => m?.version === 1 && validThreadId(m.thread) && typeof m.parentHost === 'string' &&
  typeof m.session === 'string' && typeof m.control === 'string' && typeof m.token === 'string' && typeof m.generation === 'string' && [2, 3, 4].includes(m.depth)

async function hydrateMirrors($: EngineInterface): Promise<void> {
  const sid = await sessionId($)
  for (const key of await $.store.keys()) {
    if (!key.startsWith(`mirror:${sid}:`) || mirrors.has(key)) continue
    const stored = await $.store.get(key)
    const value = stored && await readStoreState($, key, stored)
    // A simultaneous abort/receipt may have published a newer reservation
    // while this store read was in flight. Never overwrite that live state.
    if (isMirror(value) && !mirrors.has(key)) mirrors.set(key, value)
  }
}

async function saveMirror($: EngineInterface, m: ChildMirror): Promise<boolean> {
  m.updatedAt = await $.clock.now()
  mirrors.set(mirrorKey(m.session, m.thread), m)
  // Launch reservations must be durable before core can create a host loop.
  const saved = await writeStoreState($, mirrorKey(m.session, m.thread), m)
  if (m.host) {
    const rec = records.get(m.host)
    if (rec) { rec.mirror = m; await saveRecord($, m.host, rec) }
  }
  return saved
}

async function bindMirror($: EngineInterface, m: ChildMirror, host: string): Promise<void> {
  const firstBind = m.launch !== 'bound'
  const info = (await $.agent.list()).find(a => a.id === host)
  const verdict = mirrorHostMatches(m, host, info, mirrorAuthorities.get(m.token)?.spawned === true)
  if (verdict !== 'admit') {
    mirrorDiagnostics.add(mirrorLaunchDiagnostic('bind', verdict, info ?? {}, 'codex-mod', m))
    flushMirrorDiagnostics($)
    throw new Error(`mirror host identity mismatch: ${verdict}`)
  }
  m.host = host
  m.launch = 'bound'
  if (m.state === 'waiting') m.state = 'running'
  known.set(host, 'codex-child')
  const loaded = await loadRecord($, host)
  const rec: AgentRecord = loaded ?? { model: m.model, effort: m.effort, sandbox: m.sandbox, agentName: 'codex-child', thread: m.thread, updatedAt: 0 }
  rec.mirror = m
  records.set(host, rec)
  await saveMirror($, m)
  if (firstBind) $.ui.log(`codex-mod: mirror bound: host=${host}; sourceParent=${m.parentHost}; thread=${m.thread}`, { to: 'debug' })
}

/** An API launch may traverse tool guards. Only its exact held capability
 * and plugin origin allow infrastructure through; source actions never do. */
function heldMirrorCall(e: any, origin: string, phase: 'call' | 'check' = 'call'): boolean {
  const prompt = phase === 'check' && object(e.input) ? e.input.prompt : e.prompt
  const m = [...mirrors.values()].find(m => m.token === prompt)
  // The nested dispatch carries the exact capability in prompt. No event
  // loop ID or async-local context participates in the authority lookup.
  const verdict = admitMirrorLaunch(m, mirrorAuthorities.get(prompt), e, origin, phase)
  const input = phase === 'check' && object(e.input) ? e.input : e
  if (m || input.subagent_type === 'codex-mod:codex-child') mirrorDiagnostics.add(mirrorLaunchDiagnostic(phase, verdict, e, origin, m))
  return verdict === 'admit'
}

function heldMirrorSpawn(e: any, origin: string): ChildMirror | undefined {
  const m = [...mirrors.values()].find(m => m.token === e.prompt)
  const verdict = admitMirrorLaunch(m, mirrorAuthorities.get(e.prompt), e, origin, 'spawn')
  mirrorDiagnostics.add(mirrorLaunchDiagnostic('spawn', verdict, e, origin, m))
  return verdict === 'admit' ? m : undefined
}

function validMirrorLink(a: Action): boolean {
  if (!a.mirror || !object(a.result)) return false
  const m = mirrors.get(a.mirror)
  return !!m && m.launch === 'bound' && m.host === a.result.agentId && a.input.prompt === `Observe existing Codex child ${m.thread}` &&
    a.source?.threadId === m.parentThread && a.source?.data?.thread_id === m.thread
}

function mirrorFallbackStatus(reason: string, launch?: ChildMirror['launch'], attachmentStatus?: string): string {
  const afterRetry = 'auto mode could not evaluate observer launch after one unchanged retry: '
  const withoutRetry = 'auto mode could not evaluate observer launch: '
  if (reason.startsWith(afterRetry) && isMirrorAutoModeNoVerdict(reason.slice(afterRetry.length))) return 'Auto mode could not evaluate the observer after one retry.'
  if (reason.startsWith(withoutRetry) && isMirrorAutoModeNoVerdict(reason.slice(withoutRetry.length))) return 'Auto mode could not evaluate the observer; no retry.'
  if (reason.startsWith('host creation outcome unknown: ') || launch === 'uncertain') return 'Observer launch outcome unknown; no retry.'
  if (reason.includes('checkpoint unavailable')) return 'Observer launch unavailable; no retry.'
  if (reason === 'host returned no agentId') return 'Observer identity unavailable; no retry.'
  if (reason === 'observer dispatch depth limit 3') return 'Observer nesting limit reached.'
  if (attachmentStatus && attachmentStatus !== 'attached' || reason.includes('attachment')) return 'Observer attachment incomplete.'
  if (reason.includes('no relaunch') || reason.startsWith('previous launch ')) return 'Observer recovery unavailable; no relaunch.'
  return launch === 'refused' ? 'Observer launch declined.' : 'Observer unavailable.'
}

async function mirrorFallback($: EngineInterface, run: Run, data: any, reason: string): Promise<void> {
  const m = mirrors.get(mirrorKey(run.sessionId, data.thread_id))
  const summary = mirrorFallbackStatus(reason, m?.launch, data.status)
  const child = validThreadId(data.thread_id) ? data.thread_id.slice(-8) : oneLine(String(data.thread_id ?? 'unknown'), 12)
  const text = `↪ Codex child ${child}: observer transcript unavailable. ${summary} Showing reported child activity.`
  run.queue.push({ kind: 'note', text })
  $.ui.log(`codex-mod: ↪ Codex child ${data.thread_id}: mirror unavailable (${reason}); using Batch 5 lifecycle/report view. Child transcript unavailable.`, { to: 'debug' })
  const source = run.childSources?.get(data.thread_id)
  run.childSources?.delete(data.thread_id)
  if (source?.item) {
    const rec = records.get(run.agentId)
    if (rec) {
      const state = rec.display ??= emptyDisplayState()
      const tools = agentTools.get(run.name) ?? new Set<string>()
      for (const row of childRows(source.item, state, { session: run.sessionId, agent: run.agentId, thread: run.thread!, turn: source.turnId, rich: cfg.richRows, tools })) await handle($, run, row, source)
    }
  }
}

async function launchMirror($: EngineInterface, run: Run, data: any): Promise<void> {
  if (!cfg.nestedAgents || run.transport !== 'app-server' || !run.control || data.parent_thread_id !== run.thread || !validThreadId(data.thread_id)) return
  if (data.status !== 'attached') return mirrorFallback($, run, data, data.reason ?? 'child attachment failed')
  await hydrateMirrors($)
  const key = mirrorKey(run.sessionId, data.thread_id)
  let m = mirrors.get(key)
  if (m) {
    if (m.launch !== 'bound') return mirrorFallback($, run, data, m.reason ?? `previous launch ${m.launch}; creation outcome not retried`)
    const info = (await $.agent.list()).find(a => a.id === m!.host)
    const verdict = mirrorHostMatches(m, m.host!, info)
    if (verdict !== 'admit') {
      mirrorDiagnostics.add(mirrorLaunchDiagnostic('recover', verdict, info ?? {}, 'codex-mod', m))
      flushMirrorDiagnostics($)
    }
    if (m.parentHost !== run.agentId || verdict !== 'admit' || m.generation !== data.generation) return mirrorFallback($, run, data, 'previous host or broker unavailable; no relaunch')
    if (!m.displayToolId && !run.queue.some(q => q.kind === 'action' && q.action.mirror === key)) return mirrorFallback($, run, data, `existing host ${m.host}; launch row recovery incomplete; no relaunch`)
    return
  }
  const list = await $.agent.list()
  let depth = run.mirror?.depth ?? 1
  let parent = list.find(a => a.id === run.agentId)
  const seen = new Set<string>()
  while (!run.mirror && parent?.parentId) {
    if (seen.has(parent.id)) return mirrorFallback($, run, data, 'host ancestry cycle')
    seen.add(parent.id)
    depth++
    parent = list.find(a => a.id === parent!.parentId)
    if (!parent) return mirrorFallback($, run, data, 'host ancestry unavailable')
  }
  // Plugin API spawns in 2.1.302 use the session context (depth 1, no
  // parent). Preserve the source relation in both supported title surfaces.
  const parentTitle = oneLine(list.find(a => a.id === run.agentId)?.description || run.agentId, 100)
  const description = modelTitle({ model: data.model ?? run.prof.model, effort: data.effort ?? run.prof.effort }, `Codex child of ${parentTitle} · ${oneLine(data.path ?? data.thread_id, 120)}`)
  const token = `codex-mirror:${Date.now().toString(36)}:${Math.random().toString(36).slice(2)}:${Math.random().toString(36).slice(2)}`
  const input = { subagentType: `${$.plugin.name}:codex-child`, prompt: token, description, name: `codex-${data.thread_id}`, cwd: run.cwd }
  m = { version: 1, session: run.sessionId, thread: data.thread_id, parentThread: run.thread!, parentHost: run.agentId,
    sourceTurn: data.source_turn_id, sourceItem: data.source_item_id, rootTurn: data.root_turn_id,
    control: run.control, node: appServer && 'node' in appServer ? appServer.node : 'node', reader: appServer && 'runner' in appServer ? appServer.runner : `${$.plugin.root}/${RUNNER}`, activeTurn: data.turn_id, generation: data.generation, token, inputDigest: mirrorLaunchDigest(input), cwd: run.cwd, depth: depth + 1,
    model: data.model ?? run.prof.model, effort: data.effort ?? run.prof.effort, sandbox: run.prof.sandbox,
    path: data.path, launch: 'reserved', state: 'waiting', updatedAt: 0 }
  if (!await saveMirror($, m)) return mirrorFallback($, run, data, 'mirror identity checkpoint unavailable; no host launched')
  if (m.depth > 3) {
    m.launch = 'refused'; m.reason = 'observer dispatch depth limit 3'
    await saveMirror($, m)
    return mirrorFallback($, run, data, m.reason)
  }
  m.launch = 'launching'
  if (!await saveMirror($, m)) return mirrorFallback($, run, data, 'mirror launch checkpoint unavailable; no host launched')
  const authority: MirrorAuthority = { parentHost: run.agentId, session: run.sessionId, spawned: false }
  mirrorAuthorities.set(token, authority)
  let retried = false
  try {
    // Only the source relation is ours: core chooses host parent/depth.
    // This creates an observer for the already running Codex child.
    let result = await $.agent.spawn(input)
    const live = () => mirrors.get(key) === m && mirrorAuthorities.get(token) === authority && runs.get(run.agentId) === run && !run.killed &&
      m.launch === 'launching' && m.host === undefined && m.parentHost === run.agentId && m.session === run.sessionId &&
      authority.parentHost === run.agentId && authority.session === run.sessionId && authority.spawned === false
    if (isMirrorAutoModeNoVerdict(result.deny) && live() && await $.session.id().catch(() => undefined) === run.sessionId &&
      live() && prepareMirrorRetry(m, authority, result, input, run.agentId, run.sessionId)) {
      // Retire the denied core ID before any await: delayed first-attempt
      // events cannot claim the fresh ID used by the unchanged API request.
      if (!await saveMirror($, m)) {
        m.launch = 'refused'; m.reason = 'mirror retry checkpoint unavailable; no retry'
        await saveMirror($, m)
        return mirrorFallback($, run, data, m.reason)
      }
      if (await $.session.id().catch(() => undefined) === run.sessionId && live() &&
        authority.toolUseId === undefined && m.hostToolId === undefined) {
        retried = true
        result = await $.agent.spawn(input)
      }
    }
    // turn.start may bind a core identity before the launch call resolves.
    // Reconcile that verified identity when a host omits it from the ack.
    const early = mirrors.get(key)
    const host = result.agentId ?? (early?.launch === 'bound' ? early.host : undefined)
    if (result.deny || !host) {
      m.launch = m.host ? 'uncertain' : 'refused'
      m.reason = isMirrorAutoModeNoVerdict(result.deny)
        ? `auto mode could not evaluate observer launch${retried ? ' after one unchanged retry' : ''}: ${result.deny}`
        : result.deny ?? 'host returned no agentId'
      await saveMirror($, m)
      return mirrorFallback($, run, data, m.reason)
    }
    await bindMirror($, m, host)
  } catch (err) {
    // Core may already have created a task. An unknown outcome is never
    // retried automatically, even after a worker restart.
    m.launch = 'uncertain'; m.reason = errText(err)
    await saveMirror($, m)
    return mirrorFallback($, run, data, `host creation outcome unknown: ${m.reason}`)
  } finally {
    mirrorAuthorities.delete(token)
    flushMirrorDiagnostics($)
  }
  run.childSources?.delete(data.thread_id)
  const source = normalizeSource(JSON.stringify(data), { transport: 'app-server', threadId: run.thread, turnId: run.turnId, cwd: run.cwd })!
  source.threadId = run.thread
  source.data = data
  const prompt = `Observe existing Codex child ${m.thread}`
  const action: Action = { tool: 'Agent', mirror: key, input: { description, prompt, subagent_type: 'codex-mod:codex-child' }, source,
    result: { agentId: m.host, agentType: 'codex-mod:codex-child', status: 'completed', prompt, canContinueAgent: false,
      content: [{ type: 'text', text: `Observation link to real host agent ${m.host} for Codex child ${m.thread}, child of ${parentTitle} (host ${run.agentId}). Host launch ${m.hostToolId ?? 'ID unavailable'}; child lifecycle and transcript belong to that host task. Plugin API spawns may appear at depth 1 without a native parent. This completed link operation reports no host usage; Codex source usage is in the direct/tree footer.` }],
      resolvedModel: m.model, totalToolUseCount: 0, totalDurationMs: 0, totalTokens: 0,
      usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: null, cache_read_input_tokens: null, server_tool_use: null, service_tier: null, cache_creation: null } } }
  run.queue.push({ kind: 'action', action })
}

async function stopMirror($: EngineInterface, m: ChildMirror): Promise<void> {
  m = mirrors.get(mirrorKey(m.session, m.thread)) ?? m
  if (m.stopSent || !['waiting', 'running'].includes(m.state)) return
  const run = m.host ? runs.get(m.host) : undefined
  const turnId = run?.turnId ?? (m.host ? records.get(m.host)?.playback?.turnId : undefined) ?? m.activeTurn
  m.stopSent = true
  m.state = 'stopping'
  // Reserve before awaiting: abort and turn.complete can arrive together.
  if (!await saveMirror($, m)) {
    $.ui.log(`codex-mod: mirror stop unknown: checkpoint unavailable; thread=${m.thread}; no retry`, { to: 'debug' })
    return
  }
  if (!turnId) {
    $.ui.log(`codex-mod: mirror stop unknown: active turn unavailable; thread=${m.thread}; no retry`, { to: 'debug' })
    return
  }
  try {
    await controlRequest($, m.control, '/interrupt', { threadId: m.thread, turnId, operationId: `host-stop:${m.host}` }, `interrupt-${m.thread}.json`)
    $.ui.log(`codex-mod: mirror stop submitted: host=${m.host}; thread=${m.thread}; turn=${turnId}; awaiting source terminal`, { to: 'debug' })
  } catch (err) {
    $.ui.log(`codex-mod: mirror stop unknown: thread=${m.thread}; ${errText(err)}; no retry`, { to: 'debug' })
  }
}

/** Host tasks can be siblings. Cascade by our verified source ownership,
 * including recovered observers, rather than trusting native host nesting. */
async function stopMirrorDescendants($: EngineInterface, parentHost: string): Promise<void> {
  try {
    await hydrateMirrors($)
  } catch (err) {
    // Store recovery must not prevent cancellation of already known targets
    // or the owning runner. Unknown descendants remain explicitly unresolved.
    $.ui.log(`codex-mod: mirror cascade recovery unavailable: ${errText(err)}; stopping known descendants`, { to: 'debug' })
  }
  const sid = await sessionId($)
  const hosts = new Set([parentHost])
  const targets = new Set<ChildMirror>()
  for (let changed = true; changed;) {
    changed = false
    for (const m of mirrors.values()) {
      if (m.session !== sid || !hosts.has(m.parentHost) || targets.has(m)) continue
      targets.add(m)
      if (m.host) hosts.add(m.host)
      changed = true
    }
  }
  for (const m of targets) try {
    await stopMirror($, m)
  } catch (err) {
    $.ui.log(`codex-mod: mirror cascade stop unknown: thread=${m.thread}; ${errText(err)}`, { to: 'debug' })
  }
}

/** A journal consumer owns no process. Every pull settles inside one step;
 * a worker reload resumes its cursor or reports a source gap, never executes. */
function mirrorStream($: EngineInterface, rec: AgentRecord): HookStream<ProcessSpawnChunk, ProcessSpawnResult> {
  const m = rec.mirror!
  let segment = rec.playback?.segment ?? 0
  let cursor = rec.playback?.cursor ?? 0
  let prefix = rec.playback?.prefix ?? ''
  let ended = false
  let code = 0
  let quiet = 0
  let settle: (r: ProcessSpawnResult) => void
  const result = new Promise<ProcessSpawnResult>(resolve => { settle = resolve })
  const done = () => { ended = true; const value = { code, signal: null } as ProcessSpawnResult; settle(value); return { done: true as const, value } }
  return {
    result,
    [Symbol.asyncIterator]() { return this },
    async next() {
      if (ended) return done()
      let drained = false
      for (;;) {
        const entry = await journalLine($, m.control, m.thread, { segment, cursor, prefix })
        if (entry) {
          quiet = 0
          const { line } = entry
          segment = entry.segment
          cursor = entry.cursor
          prefix = entry.prefix
          const ev = JSON.parse(line)
          if (ev.type === 'codexmod.child' ? ev.parent_thread_id !== m.thread : ev.thread_id !== m.thread) throw new Error('foreign child journal identity')
          if (ev.type === 'turn.failed') code = 1
          if (ev.type === 'codexmod.turn' && !m.stopSent) m.state = 'running'
          const run = m.host ? runs.get(m.host) : undefined
          if (run && ['turn.completed', 'turn.failed'].includes(ev.type)) {
            // Source terminal evidence settles the observer; do not echo a stop.
            m.state = ev.status === 'interrupted' || ev.error?.message === 'interrupted' ? 'aborted' : code ? 'failed' : 'completed'
            $.ui.log(`codex-mod: mirror source terminal: host=${m.host}; thread=${m.thread}; state=${m.state}`, { to: 'debug' })
          }
          if (ev.type === 'codexmod.steer') {
            const message = m.messages?.find(message => message.id === String(ev.id))
            if (message && message.status === 'submitted') message.status = ev.status === 'accepted' ? 'accepted' : ev.status === 'rejected' ? 'rejected' : 'unknown'
            $.ui.log(`codex-mod: mirror steer acknowledgement: host=${m.host}; thread=${m.thread}; id=${ev.id}; status=${message?.status ?? 'unmatched'}`, { to: 'debug' })
          }
          rec.playback = { segment, cursor, prefix, texts: run?.texts ?? [], queue: run?.queue ?? [], actions: run?.actions ?? 0, usage: run?.usage, usageCanonical: run?.usageCanonical, usagePartial: run?.usagePartial, turnId: ev.turn_id ?? run?.turnId }
          return { done: false as const, value: { stream: 'stdout' as const, text: line + '\n' } }
        }
        const owner = JSON.parse(await journalRead($, `${m.control}/owner.json`))
        // The owner can finish between our index read and this read. Drain
        // once more against its final index before deciding the journal ended.
        if (owner.ended && !drained) {
          drained = true
          continue
        }
        if (owner.generation !== m.generation || owner.ended || !Number.isFinite(owner.updatedAt) || Date.now() - owner.updatedAt > 15000) {
          if (!['completed', 'failed', 'aborted'].includes(m.state)) throw new Error('child source owner unavailable; partial transcript, no relaunch')
          return done()
        }
        const run = m.host ? runs.get(m.host) : undefined
        if (['completed', 'failed', 'aborted'].includes(m.state) && ++quiet >= 2) return done()
        if (run?.killed || m.state === 'stopping') return done()
        await mirrorMessages($, rec, run)
        // A bounded read-only wait in the host keeps polling out of the
        // dispatch's CPU/sleep budget. It starts no Codex or provider work.
        await $.process.run([m.node, m.reader, 'observe', '--control', m.control, '--thread', m.thread, '--segment', String(segment), '--cursor', String(cursor), '--generation', m.generation], { timeoutMs: 3000 })
      }
    },
    async return() { return done() },
  } as HookStream<ProcessSpawnChunk, ProcessSpawnResult>
}

async function mirrorMessages($: EngineInterface, rec: AgentRecord, run?: Run): Promise<void> {
  const m = rec.mirror!
  const c = await conversation($, m.host!)
  const read = readConversation(c.items)
  const count = read.latest?.count ?? rec.userCount ?? 0
  // Presentation owns this queue and removes a receipt only after emission.
  // Claim delivery separately so a long pending display cannot resend it
  // after the bounded received-ID window has rolled over.
  const received = [...(rec.coordinator?.pending ?? []).filter(p => !p.mirrorClaimed).map(p => ({ ...p, count })), ...takeDeliveries(m.host!, count)]
  const latest = read.latest
  if (latest && latest.text !== m.token && latest.text !== rec.lastTask && latest.count > (rec.userCount ?? 0)) received.push({ text: latest.text, count: latest.count })
  for (const message of received) {
    const receipt = rec.coordinator?.pending.find(p => p.uuid === message.uuid)
    if (receipt) receipt.mirrorClaimed = true
    const id = steerFileId(message)
    const control = (rec.coordinator ??= { received: [], pending: [] })
    const key = `mirror:${id}`
    if (control.received.includes(key)) continue
    control.received.push(key)
    // Journal intent first. A crash after this write has an unknown outcome,
    // so recovery does not send it twice or convert it to a new run.
    rec.lastTask = message.text; rec.userCount = message.count
    if (rec.handedBack || m.state !== 'running' || !(run?.turnId ?? rec.playback?.turnId ?? m.activeTurn)) {
      const note = '↪ child message rejected: source turn idle, terminal or unknown; no new turn started'
      if (run) run.queue.push({ kind: 'note', text: note })
      else rec.lastAnswer = [rec.lastAnswer, note].filter(Boolean).join('\n\n')
      await saveRecord($, m.host!, rec)
      continue
    }
    const delivery: NonNullable<ChildMirror['messages']>[number] = { id: `${m.thread}-${id}`, status: 'submitted' }
    m.messages = [...(m.messages ?? []).slice(-127), delivery]
    if (!await saveRecord($, m.host!, rec)) {
      delivery.status = 'unknown'
      $.ui.log(`codex-mod: mirror steer unknown: checkpoint unavailable; thread=${m.thread}; id=${delivery.id}; no retry`, { to: 'debug' })
      continue
    }
    try {
      const o: MessageOutcome = { messageId: message.uuid ?? `${m.thread}:${id}`, id: delivery.id, sourceUuid: message.uuid,
        sessionId: m.session, agentId: m.host!, runId: m.control, threadId: m.thread,
        expectedTurnId: run?.turnId ?? rec.playback?.turnId ?? m.activeTurn, status: 'pending', receivedAt: Date.now() }
      await recordOutcome($, m.host!, o)
      const outcome = await controlRequest($, m.control, '/messages', { ...o, text: roleTask(rec.agentName, parseOverrides(message.text).rest.trim(), rec.effectiveConfig), turnId: o.expectedTurnId }, `steer-${m.thread}-${id}.json`)
      if (outcome) { await recordOutcome($, m.host!, outcome); delivery.status = ['accepted', 'observed'].includes(outcome.status) ? 'accepted' : outcome.status === 'rejected' ? 'rejected' : outcome.status === 'unknown' ? 'unknown' : 'submitted' }
      $.ui.log(`codex-mod: mirror steer submitted: host=${m.host}; thread=${m.thread}; id=${delivery.id}`, { to: 'debug' })
    } catch (err) {
      delivery.status = 'unknown'
      await recordOutcome($, m.host!, { messageId: message.uuid ?? `${m.thread}:${id}`, sourceUuid: message.uuid, status: 'unknown', receivedAt: Date.now(), reason: 'control outcome unavailable; no retry' })
      await saveRecord($, m.host!, rec)
      $.ui.log(`codex-mod: mirror steer unknown: thread=${m.thread}; id=${delivery.id}; ${errText(err)}; no retry`, { to: 'debug' })
      continue
    }
    if (run) run.queue.push({ kind: 'note', text: `↪ child message submitted (${message.uuid ?? id}); awaiting Codex acknowledgement` })
  }
}

async function checkpointMirror($: EngineInterface, run: Run): Promise<void> {
  if (!run.mirror) return
  const rec = records.get(run.agentId)
  if (!rec?.playback) return
  Object.assign(rec.playback, { texts: run.texts, queue: run.queue, actions: run.actions, usage: run.usage, usageCanonical: run.usageCanonical, usagePartial: run.usagePartial, turnId: run.turnId })
  rec.wire = { records: run.ledger.records, rows: run.rows }
  await saveMirror($, run.mirror)
}

async function* answerMirror($: EngineInterface, e: TurnStepInput, signal: AbortSignal, rec: AgentRecord): AsyncGenerator<TurnStepChunk, TurnStepResult> {
  if (rec.recoveryUnavailable) return yield* handBack($, e, 'codex failed: recovery state unavailable', '', false)
  const m = rec.mirror!
  if (!isMirror(m) || m.host !== e.agentId) return yield* failStep(e, 'codex-child', 'codex failed: unowned mirror; no run launched', false)
  mirrors.set(mirrorKey(m.session, m.thread), m)
  const c = await conversation($, e.agentId!)
  const read = readConversation(c.items)
  const handback = handbackFor(e.agentId!, read.signal, c.source)
  if (rec.handedBack) {
    await mirrorMessages($, rec)
    return yield* redeliver($, e, e.agentId!, rec, handback)
  }
  let run = runs.get(e.agentId!)
  if (!run) {
    const ledger = new SourceLedger()
    for (const source of rec.wire?.records ?? []) ledger.capture(source)
    const p = rec.playback
    run = { sessionId: m.session, ledger, rows: rec.wire?.rows ?? {}, agentId: e.agentId!, name: 'codex-child', prof: rec,
      cwd: m.cwd ?? await $.session.cwd(), child: mirrorStream($, rec), thread: m.thread, turnId: p?.turnId, buffered: '', stderrTail: '',
      texts: p?.texts ?? [], queue: p?.queue ?? [], errors: [], snapshots: new Map(), actions: p?.actions ?? 0, usage: p?.usage, usageCanonical: p?.usageCanonical, usagePartial: p?.usagePartial,
      patches: 0, patchRows: 0, actionSteps: 0, lastEmit: -Infinity, ended: false, killed: false, timedOut: false,
      handback, followUps: [], transport: 'app-server', control: m.control, transportNote: 'app-server mirror', pendingSteers: [], steers: 0,
      unknown: 0, unknownTypes: [], mirror: m }
    runs.set(e.agentId!, run)
  } else {
    // Engine interfaces belong to a dispatch. Replace only the inert reader
    // between steps so all filesystem/control calls use this step's interface.
    await run.child.return(undefined as unknown as ProcessSpawnResult)
    run.child = mirrorStream($, rec)
  }
  await mirrorMessages($, rec, run)
  return yield* pump($, e, signal, run)
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
    await registerDisplayTools($).catch(err => $.ui.log(`codex-mod: display tools not registered: ${errText(err)}`, { to: 'debug' }))
    agentsReady = await registerAgents($, config)
    return next(e)
  })

  // Pruning only: a running child dies with the module (process exit) or with
  // its agent's turn (turn.complete below); a /clear also ends the session.
  on('session.end', async ($, e, next) => {
    answers.clear()
    sourceRows.clear()
    planCards.clear()
    questionRows.clear()
    coordinatorRows.clear()
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
    const held = heldMirrorCall(e, next.origin.plugin)
    flushMirrorDiagnostics($)
    if (held) return next(e)
    if (e.tool === approvalTool) return approvalCall($, e)
    if (e.tool === agentStatusTool) return agentStatusCall($, e)
    if (e.tool === statusTool) {
      if (e.agentId !== undefined || hasPrefix(e.tool_use_id)) return { deny: NOT_EXECUTED }
      const agentId = (e as any).targetAgentId
      const messageId = (e as any).messageId
      if (typeof agentId !== 'string' || typeof messageId !== 'string' || await agentName($, agentId) === undefined) return { deny: 'codex-mod: unknown target or message' }
      const rec = await loadRecord($, agentId)
      const sourceId = rec?.coordinator?.sources?.[messageId] ?? messageId
      const matches = Object.values(rec?.coordinator?.outcomes ?? {}).filter(v => v.sourceUuid === sourceId || v.senderToolUseId === messageId)
      if (!rec?.coordinator?.outcomes?.[sourceId] && matches.length > 1) return { result: [{ type: 'text', text: JSON.stringify({ messageId, status: 'unknown', reason: 'source row contains multiple messages; use a message ID or sender tool-use ID' }) }] }
      let o = rec?.coordinator?.outcomes?.[sourceId] ?? matches[0]
      if (o?.runId && ['pending', 'received', 'unknown'].includes(o.status)) {
        const updated = await queryOutcome($, o.runId, o.messageId).catch(() => undefined)
        if (updated) { await recordOutcome($, agentId, updated); o = records.get(agentId)?.coordinator?.outcomes?.[o.messageId] }
      }
      if (!o && rec?.coordinator?.received.includes(sourceId)) o = { messageId: sourceId, sourceUuid: sourceId, status: 'received', receivedAt: rec.updatedAt }
      return { result: [{ type: 'text', text: JSON.stringify(o ?? { messageId, status: 'unknown', reason: 'no owned receipt' }) }] }
    }
    const refused = (reason: string) => { $.ui.log(`codex-mod: display guard refused (${reason})`, { to: 'debug' }) }
    if (guarded(e)) return answerGuarded(e, await sessionId($), refused)
    if (unresolved(e) && (await agentName($, e.agentId!)) !== undefined) return answerGuarded(e, await sessionId($), refused)
    // The current host omits effort from agent.spawn but exposes the Agent
    // input here. Keep it scoped to this real call's lifetime and tool ID.
    if (e.tool === 'Agent' && typeof (e as any).subagent_type === 'string' && (e as any).subagent_type.startsWith(`${$.plugin.name}:`) && typeof e.tool_use_id === 'string') {
      agentEfforts.set(e.tool_use_id, (e as any).effort)
      try { return await next(e) } finally { agentEfforts.delete(e.tool_use_id) }
    }
    if (e.tool === 'SendMessage' && e.agentId === undefined && typeof (e as any).message === 'string' && (e as any).message !== '') {
      const target = await nativeTarget($, (e as any).to)
      if (target) {
        const previous = sendGates.get(target)
        let release!: () => void
        const gate = new Promise<void>(resolve => { release = resolve })
        sendGates.set(target, gate)
        await previous
        const ticket = { id: e.tool_use_id, received: undefined as string | undefined }
        nativeSends.set(target, ticket)
        try {
          const result = await next(e)
          if (result.deny !== undefined || result.isError) return result
          const receipt = nativeSources.get(ticket.id)
          // CLI 2.1.302 raises receive only when the child's next tool round
          // drains its inbox. A long step cannot wait for that callback.
          const pin = nativeSendPin(result)
          const run = runs.get(target)
          if (receipt && pin === target && run && !run.ended && !run.killed && !run.mirror &&
              !Object.values(records.get(target)?.coordinator?.outcomes ?? {}).some(o => o.senderToolUseId === ticket.id)) {
            const rec = records.get(target)!
            const c = rec.coordinator ??= { received: [], pending: [] }
            const messageId = `${await sessionId($)}:${ticket.id}`
            ticket.received = messageId
            c.authoritative = true
            c.received.push(receipt.uuid)
            c.pending.push({ uuid: messageId, sourceUuid: receipt.uuid, messageId, text: receipt.text })
            c.ingress ??= []
            c.ingress.push({ messageId, senderToolUseId: ticket.id, count: rec.userCount ?? 0, fromSend: true, text: receipt.text })
            // UUID and tool ID come from the stored parent row; pin comes from
            // the native result. No body marker or second native send is used.
            await foldIn($, run, { uuid: receipt.uuid, messageId, senderToolUseId: ticket.id, text: receipt.text, count: rec.userCount ?? 0 })
            $.ui.log(`codex-mod: steer v2 sender receipt target=${target} message=${messageId} source=${receipt.uuid}`, { to: 'debug' })
          }
          let o = Object.values(records.get(target)?.coordinator?.outcomes ?? {}).find(o => o.senderToolUseId === ticket.id)
          // The sidecar independently advances this finite query, even when the
          // child view has not pulled its next stdout chunk.
          if (o?.runId && ['received', 'pending'].includes(o.status)) {
            const updated = await queryOutcome($, o.runId, o.messageId).catch(() => undefined)
            if (updated) { await recordOutcome($, target, updated); o = records.get(target)?.coordinator?.outcomes?.[o.messageId] }
          }
          const feedback = o ? `${messageStatus(o)} (messageId=${o.messageId}; targetAgentId=${target})`
            : `Codex acknowledgment pending; query codex_message_status with targetAgentId=${target}, messageId=${ticket.received ?? ticket.id}`
          return { ...result, context: [...(result.context ?? []), feedback] }
        } finally {
          nativeSends.delete(target)
          release()
          if (sendGates.get(target) === gate) sendGates.delete(target)
        }
      }
    }
    return next(e)
  }).catch(($, e, next) => {
    if (e.tool === statusTool || e.tool === approvalTool || e.tool === agentStatusTool) return { deny: NOT_EXECUTED }
    if (next.error?.kind === 're-entry' && heldMirrorCall(e, next.origin.plugin)) return next(e)
    if (!guarded(e) && !unresolved(e)) return next(e)
    const held = typeof e.tool_use_id === 'string' ? answers.get(e.tool_use_id) : undefined
    return held ? answerGuarded(e, held.sessionId) : { deny: NOT_EXECUTED }
  })

  // GUARD 2. `tool.check` runs inside `tool.call`'s `next`, which guard 1
  // never calls for these calls; reaching it means guard 1 was bypassed, so
  // the verdict is deny, whatever the id.
  on('tool.check', async ($, e, next) => {
    if (e.tool === statusTool || e.tool === approvalTool || e.tool === agentStatusTool) return { decision: 'deny' as const, reason: NOT_EXECUTED }
    const held = heldMirrorCall(e, next.origin.plugin, 'check')
    flushMirrorDiagnostics($)
    if (held) return next(e)
    if (!hasPrefix(e.tool_use_id) && !isDisplay(e.tool) && unresolved(e)) await agentName($, e.agentId!)
    return guarded(e) ? { decision: 'deny' as const, reason: NOT_EXECUTED } : next(e)
  }).catch(($, e, next) => {
    if (e.tool === agentStatusTool) return { decision: 'deny' as const, reason: NOT_EXECUTED }
    if (next.error?.kind === 're-entry' && heldMirrorCall(e, next.origin.plugin, 'check')) return next(e)
    return guarded(e) || unresolved(e) ? { decision: 'deny' as const, reason: NOT_EXECUTED } : next(e)
  })

  on('ui.render', { component: 'AssistantMessage' }, ($, e, next) => {
    if (!dimNotes.has(e.props.text)) return next(e)
    return $.ui.resolve(e).Text({ dimColor: true, children: e.props.text })
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'ToolUse' }, async ($, e, next) => {
    const id = e.props.tool_use_id
    const sid = hasPrefix(id) ? await sessionId($) : undefined
    const saved = hasPrefix(id) && !sourceRows.has(id) ? await loadRow($, id, sid!) : undefined
    const owned = hasPrefix(id) ? sourceRows.get(id) ?? saved?.row : undefined
    if (e.props.tool === 'Agent') {
      const profile = await agentRowProfile($, id)
      if (profile) {
        const { Box, Text } = $.ui.resolve(e)
        // Retain the host tree, including status, navigation and accessibility.
        const native = await next(e)
        return Box({ flexDirection: 'column', children: [
          Text({ weight: 'semibold', children: `Codex ${profile.model} · ${profile.effort}` }),
          ...(profile.note ? [Text({ children: profile.note })] : []), native,
        ] })
      }
    }
    let row = hasPrefix(id) ? coordinatorRows.get(id) : undefined
    if (row?.sessionId !== sid) row = undefined
    // Reopened history need not have called turn.step or consumed a guard.
    // A matching row cache and received receipt attest a host-returned name
    // even before registration. Restore presentation only, never an answer.
    const legacyCoordinatorTool = e.props.tool === `mcp__${$.plugin.name}__coordinator_message`
    const owner = owned?.sessionId === sid && owned?.tool === e.props.tool && typeof owned?.agentId === 'string' && owned.agentId !== '' ? owned.agentId : undefined
    if (!row && hasPrefix(id) && (legacyCoordinatorTool || owner !== undefined)) {
      for (const key of await $.store.keys()) {
        if (!key.startsWith(`${STORE_PREFIX}${sid}:`)) continue
        if (!legacyCoordinatorTool && key !== `${STORE_PREFIX}${sid}:${owner}`) continue
        const stored = await $.store.get(key)
        const rec = stored && await readStoreState($, key, stored)
        if (!isRecord(rec)) continue
        const saved = rec.coordinator?.rows?.[id]
        if (saved && saved.tool === e.props.tool && rec.coordinator!.received.includes(saved.sourceUuid)) {
          row = { ...saved, sessionId: sid!, outcome: saved.messageId ? rec.coordinator?.outcomes?.[saved.messageId] : undefined }
          coordinatorRows.set(id, row)
          break
        }
      }
    }
    const questionRow = questionRows.get(id)
    if (questionRow && e.props.tool === displayTools.codex_question && owned?.tool === e.props.tool && questionRow.session === await sessionId($)) {
      const { Box, Text, Button } = $.ui.resolve(e)
      const q = questionRow.question
      if (APPROVAL_METHODS.has(q.method)) {
        const run = runs.get(questionRow.agent)
        const valid = q.status === 'pending' && run && !run.ended && !run.killed && !run.mirror && run.execution?.approvalMode === 'ask' &&
          run.sessionId === questionRow.session && run.control === questionRow.control && run.thread === q.params.threadId && run.turnId === q.params.turnId
        if (typeof Button !== 'function') {
          if (valid) await $.fs.write(`${questionRow.control}/response-${q.token}.json`, JSON.stringify({ ...approvalIdentity(q), unsupported: true, actor: 'human' }))
          return Text({ children: 'Codex approval unsupported: native buttons unavailable; no consent supplied.' })
        }
        const fileChanges = run ? proposedFileChanges(run, q) : undefined
        const commandContext = run ? proposedCommand(run, q) : undefined
        const approvalBody = (decision: string) => ({ ...approvalIdentity(q), decision, actor: 'human', ...(fileChanges ? { fileChanges } : {}), ...(commandContext ? { commandContext } : {}) })
        const decide = async (decision: string) => {
          const current = runs.get(questionRow.agent)
          if (!valid || current !== run || current.ended || current.killed || q.status !== 'pending') return
          const body = approvalBody(decision)
          if (!approvalResponse(q, body, proposedFileChanges(current, q), proposedCommand(current, q))) { $.ui.invalidate('ui.render'); return }
          q.status = 'submitting'
          $.ui.invalidate('ui.render')
          try { await $.fs.write(`${questionRow.control}/response-${q.token}.json`, JSON.stringify(body)) }
          catch { q.status = 'pending'; $.ui.invalidate('ui.render') }
        }
        return Box({ flexDirection: 'column', children: [Text({ weight: 'semibold', children: `Codex approval: ${q.params.kind ?? q.method}` }),
          Text({ children: JSON.stringify(q.params) }),
          ...(q.method === 'item/fileChange/requestApproval' ? [Text({ children: fileChanges ? JSON.stringify(fileChanges) : FILE_APPROVAL_UNAVAILABLE })] : []),
          ...(q.method === 'item/commandExecution/requestApproval' ? [Text({ children: commandContext ? JSON.stringify(commandContext) : COMMAND_APPROVAL_UNAVAILABLE })] : []),
          Text({ children: `${q.status}; one-shot decision, no command replay` }),
          ...(valid ? ['accept', 'decline', 'cancel'].filter(decision => approvalResponse(q, approvalBody(decision), fileChanges, commandContext)).map(decision =>
            Button({ key: `${q.token}:${decision}`, label: decision === 'accept' ? 'Approve once' : decision === 'decline' ? 'Decline' : 'Cancel turn', onPress: () => { void decide(decision) } })) : [])] })
      }
      const send = async (cancel = false) => {
        const run = runs.get(questionRow.agent)
        if (q.status !== 'pending' || !run || run.ended || run.killed || run.control !== questionRow.control || run.thread !== q.params.threadId || run.turnId !== q.params.turnId) return
        const result = { answers: Object.fromEntries(q.params.questions.map((v: any) => [v.id, { answers: [questionRow.selected[v.id]] }])) }
        if (!cancel && q.params.questions.some((v: any) => !v.options.some((o: any) => o.label === questionRow.selected[v.id]))) return
        q.status = 'submitting'
        $.ui.invalidate('ui.render')
        try {
          await $.fs.write(`${questionRow.control}/response-${q.token}.json`, JSON.stringify({ token: q.token, requestId: q.requestId,
            threadId: q.params.threadId, turnId: q.params.turnId, itemId: q.params.itemId, ...(cancel ? { cancel: true } : { result }) }))
        } catch {
          q.status = 'pending'
          $.ui.invalidate('ui.render')
        }
      }
      return Box({ flexDirection: 'column', children: [Text({ weight: 'semibold', children: 'Codex question' }),
        Text({ children: `${q.status}; receipt is not an answer or approval` }),
        ...q.params.questions.flatMap((v: any) => [Text({ children: v.question }), ...v.options.map((o: any) =>
          q.status === 'pending' ? Button({ key: `${q.token}:${v.id}:${o.label}`, label: `${questionRow.selected[v.id] === o.label ? '✓ ' : ''}${o.label}: ${o.description}`,
            onPress: () => {
              if (q.status === 'pending') {
                questionRow.selected[v.id] = o.label
                $.ui.invalidate('ui.render')
              }
            } }) : Text({ children: `${o.label}: ${o.description}` }))]),
        ...(q.status === 'pending' ? [Button({ key: `${q.token}:submit`, label: 'Send selected answers', onPress: () => { void send() } }),
          Button({ key: `${q.token}:cancel`, label: 'Cancel question', onPress: () => { void send(true) } })] : []),
        ...(q.result ? [Text({ children: JSON.stringify(q.result) })] : []),
        ...(q.error ? [Text({ children: JSON.stringify(q.error) })] : []),
      ] })
    }
    const plan = planCards.get(e.props.tool_use_id) ?? saved?.plan
    if (plan && owned && owned.tool === displayTools.codex_plan && e.props.tool === owned.tool) {
      const { Box, Text } = $.ui.resolve(e)
      return Box({ flexDirection: 'column', children: [Text({ weight: 'semibold', children: 'Codex plan (display only)' }),
        ...(plan.explanation === undefined ? [] : [Text({ children: plan.explanation })]),
        ...plan.steps.map(s => Text({ children: `${s.status === 'completed' ? '☑' : s.status === 'in_progress' ? '◐' : '☐'} ${s.step}` })),
        ...(plan.steps.length ? [] : [Text({ children: '(empty checklist)' })]),
      ] })
    }
    if (owned && owned.tool === displayTools.codex_tool && e.props.tool === owned.tool && owned.label) {
      const label = owned.label
      // Keep the host's expansion, errors and controls under an owned identity label.
      const { Box, Text } = $.ui.resolve(e)
      return next(e).then(child => Box({ flexDirection: 'column', children: [Text({ weight: 'semibold', children: label }), child] }))
    }
    if (row === undefined || e.props.tool !== row.tool) return next(e)
    let outcome = row.outcome
    if (row.messageId) {
      try { outcome = (await $.state.get({ plugin: 'codex-mod', key: 'messageStatus', id: row.messageId })).value ?? outcome } catch {
        // Saved receipt status remains useful when the live state is absent.
      }
    }
    const { Box, Text } = $.ui.resolve(e)
    const labels: Record<MessageOutcome['status'], string> = {
      received: 'Received · pending Codex acknowledgment', pending: 'Pending Codex acknowledgment',
      accepted: 'Accepted into turn', observed: 'Observed in Codex input', queued: 'Queued for Codex',
      rejected: 'Rejected', unknown: 'Delivery uncertain',
    }
    let status = outcome ? labels[outcome.status] ?? labels.received : labels.received
    if (outcome?.status === 'queued' && outcome.queuedAfterTurnId) status = 'Queued after turn'
    if (outcome?.status === 'accepted' && outcome.echoedItemId) status += ' · observed in input'
    const reason = outcome?.reason ?? outcome?.error?.message ?? (outcome?.status === 'rejected' ? 'no reason supplied' : undefined)
    if (reason) status += ` · ${reason}`
    const details = [
      ['Message', row.messageId ?? outcome?.messageId], ['Turn', outcome?.turnId], ['Accepted turn', outcome?.acceptedTurnId],
      ['Expected turn', outcome?.expectedTurnId], ['Queued after turn', outcome?.queuedAfterTurnId],
    ].filter(([, value]) => value !== undefined).map(([label, value]) => `${label}: ${value}`)
    return Box({ flexDirection: 'column', children: [
      Text({ weight: 'semibold', children: 'Coordinator' }),
      Text({ children: row.text }),
      Text({ children: status }),
      ...(details.length ? [Text({ dimColor: true, children: details.join(' · ') })] : []),
    ] })
  }).catch(($, e, next) => next(e))

  on('session.receive', async ($, e, next) => {
    const target = e.agentId
    const ticket = target && nativeSends.get(target)
    const run = target && runs.get(target)
    if (target && e.origin.kind === 'coordinator' && !('plugin' in e.origin) &&
        await reconcileNativeCopy($, target, e.text)) {
      return { consumed: 'codex-mod: coordinator message already owned by its recorded SendMessage operation' }
    }
    if (target && ticket && !ticket.received && run && e.origin.kind === 'coordinator' && !('plugin' in e.origin) && !run.mirror) {
      const rec = records.get(target)
      if (rec) {
        const c = rec.coordinator ??= { received: [], pending: [] }
        const messageId = `${await sessionId($)}:${ticket.id}`
        ticket.received = messageId
        // Native sends are serialized per target; keep their receive order as
        // well as tool IDs, so identical bodies never identify operations.
        c.ingress ??= []
        c.ingress.push({ messageId, senderToolUseId: ticket.id, count: rec.userCount ?? 0 })
        await saveRecord($, target, rec)
        await foldIn($, run, { text: e.text, count: rec.userCount ?? 0, messageId, senderToolUseId: ticket.id })
      }
    }
    const result = await next(e)
    if (target && ticket?.received && result.consumed !== undefined) {
      const rec = records.get(target)
      if (rec?.coordinator) {
        rec.coordinator.ingress = rec.coordinator.ingress?.filter(i => i.messageId !== ticket.received)
        await saveRecord($, target, rec)
      }
    }
    return result
  }).catch(($, e, next) => next(e))

  // A coordinator's message delivered into an agent's running turn is an
  // attachment row (`queued_command`), promoted to a system turn in the
  // request, so the conversation read never shows it: it is recorded here, as
  // the row is appended, for the next look for messages. Always relayed as is.
  on('session.append', async ($, e, next) => {
    if (e.agentId === undefined && e.origin.kind === 'model' && e.message.type === 'assistant') {
      for (const block of e.message.content) {
        if (block.type !== 'tool_use' || block.name !== 'SendMessage' || typeof block.id !== 'string' ||
            !object(block.input) || typeof block.input.message !== 'string') continue
        nativeSources.set(block.id, { uuid: e.uuid, text: block.input.message })
        while (nativeSources.size > 128) nativeSources.delete(nativeSources.keys().next().value!)
      }
    }
    // only the doors a delivery comes in by: a prompt row the API form carries is read there
    if (e.agentId !== undefined && e.origin.kind === 'coordinator' && (e.door === 'attachment' || e.door === 'delivery' || e.door === 'prompt' && runs.has(e.agentId))) {
      const content = rowText(e.message.content)
      const text = coordinatorPayload(content) ?? (e.door === 'delivery' || e.door === 'prompt' ? content : undefined)
      const name = text === undefined ? undefined : await agentName($, e.agentId)
      if (text !== undefined && text !== '' && name !== undefined) {
        const loaded = await loadRecord($, e.agentId)
        const rec = records.get(e.agentId) ?? loaded ?? { ...profileOf(name)!, agentName: name, updatedAt: 0 }
        // Unknown retired roles need an existing valid record, just as their steps do.
        if (!isRecord(rec)) return next(e)
        const coordinator = rec.coordinator ??= { received: [], pending: [] }
        if (coordinator.received.includes(e.uuid)) return next(e)
        // Older hosts may append without receive. Reconcile the known native
        // copy by target FIFO plus its recorded source/tool identity and body.
        if (await reconcileNativeCopy($, e.agentId, coordinatorPayload(content, true) ?? content, e.uuid)) return next(e)
        const sender = !('plugin' in e.origin) ? nativeSends.get(e.agentId) : undefined
        if (sender) {
          sender.received ??= e.uuid
          coordinator.sources = Object.fromEntries([...Object.entries(coordinator.sources ?? {}).filter(([id]) => id !== sender.id), [sender.id, e.uuid]].slice(-128))
        }
        coordinator.authoritative = true
        coordinator.received.push(e.uuid)
        coordinator.pending.push({ uuid: e.uuid, text: coordinatorPayload(content, true) ?? content })
        const ordinal = sender?.received ? coordinator.ingress?.findIndex(i => i.messageId === sender.received) ?? -1 : 0
        const ingress = !('plugin' in e.origin) && ordinal >= 0 ? coordinator.ingress?.splice(ordinal, 1)[0] : undefined
        if (ingress) {
          const outcome = coordinator.outcomes?.[ingress.messageId]
          if (outcome) {
            outcome.sourceUuid = e.uuid
            await publishOutcome($, outcome)
          }
        }
        // Publish without an await so simultaneous first receipts share state.
        records.set(e.agentId, rec)
        await saveRecord($, e.agentId, rec, true)
        if (rec.mirror) { await mirrorMessages($, rec, runs.get(e.agentId)); return next(e) }
        $.ui.log(`codex-mod: agent ${e.agentId}: coordinator message delivered mid-run (${e.door}${e.message.name ? ` ${e.message.name}` : ''}, row ${e.uuid})`, { to: 'debug' })
        const run = runs.get(e.agentId)
        if (ingress) {
          for (const f of [...(run?.pendingSteers ?? []), ...(run?.followUps ?? [])]) if (f.messageId === ingress.messageId) f.uuid = e.uuid
          await saveRecord($, e.agentId, rec, true)
          return next(e)
        }
        const message = { uuid: e.uuid, text }
        if (run && !run.ended && !run.killed) {
          await foldIn($, run, { ...message, count: rec.userCount ?? 0 })
          return next(e)
        }
        const list = deliveries.get(e.agentId) ?? []
        if (!list.some(d => d.uuid === e.uuid)) list.push({ uuid: e.uuid, text })
        deliveries.set(e.agentId, list.slice(-MAX_DELIVERIES))
        $.ui.log(`codex-mod: agent ${e.agentId}: coordinator message delivered mid-run (${e.door}${e.message.name ? ` ${e.message.name}` : ''}, row ${e.uuid})`, { to: 'debug' })
      }
    }
    return next(e)
  }).catch(($, e, next) => (next.called ? next(e) : next(e)))

  on('agent.offer', ($, e, next) => e.agent === `${$.plugin.name}:codex-child` ? { isOffered: false } : next(e))
    .catch(($, e, next) => e.agent.endsWith(':codex-child') ? { isOffered: false } : next(e))

  on('agent.spawn', async ($, e, next) => {
    if (e.subagentType !== `${$.plugin.name}:codex-child`) {
      const name = ownedSpawn($, e)
      if (!name || e.fork) return next(e)
      await loadCatalog($)
      const base = e.resume ? await loadRecord($, e.resume.agentId) : undefined
      const defaults = base ?? profileOf(name)
      if (!defaults) return next(e)
      const spawnEffort = (e as any).effort
      const native = spawnEffort !== undefined ? spawnEffort : agentEfforts.get(e.tool_use_id)
      const resolved = resolveProfile(defaults, e.prompt, catalog ?? undefined, native)
      const tag = (v: unknown) => v === undefined ? 'absent' : typeof v === 'string' && /^[a-z]+$/.test(v) ? v : 'other'
      $.ui.log(`codex-mod: model selection: spawn keys=${Object.keys(e).sort().join(',')}; spawn.effort=${tag((e as any).effort)}; Agent.effort=${tag(agentEfforts.get(e.tool_use_id))}; resolved=${resolved.profile.model}/${resolved.profile.effort}${resolved.note ? `; ${resolved.note}` : ''}`, { to: 'debug' })
      // Workflow/resume content is fixed by core. Their row/footer can still
      // show the selected profile without attempting a forbidden title edit.
      const description = e.resume || e.workflow ? e.description : modelTitle(resolved.profile, e.description)
      const launch: ModelLaunch = { session: await sessionId($), toolUseId: e.tool_use_id, type: e.subagentType,
        parent: e.parentAgentId, description, prompt: e.prompt, profile: resolved.profile,
        recordProfile: resolved.invalid ? resolveProfile(defaults, '', catalog ?? undefined).profile : resolved.profile, note: resolved.note }
      modelLaunches.set(e.tool_use_id, launch)
      try {
        if (e.resume) await bindModelLaunch($, launch, e.resume.agentId)
        const result = await next(description === e.description ? e : { ...e, description })
        if (result.agentId) await bindModelLaunch($, launch, result.agentId)
        else modelLaunches.delete(e.tool_use_id)
        return result
      } catch (err) {
        modelLaunches.delete(e.tool_use_id)
        throw err
      }
    }
    const held = heldMirrorSpawn(e, next.origin.plugin)
    flushMirrorDiagnostics($)
    if (!held) return { deny: 'codex-mod: unowned or unsupported mirror launch' }
    if (!await saveMirror($, held)) return { deny: 'codex-mod: mirror launch checkpoint unavailable' }
    return next(e)
  }).catch(($, e, next) => {
    if (!e.subagentType.endsWith(':codex-child')) return next(e)
    const held = next.error.kind === 're-entry' ? heldMirrorSpawn(e, next.origin.plugin) : undefined
    if (!held) return { deny: 'codex-mod: mirror launch failed closed' }
    // The ancestor's spawn observer is inherited by grandchildren. Its
    // pure guard can admit only another held observer, without engine APIs.
    held.hostToolId = e.tool_use_id
    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    flushMirrorDiagnostics($)
    if (!e.agentId) return next(e)
    await hydrateMirrors($)
    const held = [...mirrors.values()].find(m => m.token === e.text && m.launch === 'launching')
    if (held) await bindMirror($, held, e.agentId)
    else await bindPendingModelLaunch($, e.agentId, e.text)
    return next(e)
  })

  // A turn that ends while its Codex run is still active (interrupted, an
  // error, maxTurns reached) kills the child.
  on('turn.complete', async ($, e, next) => {
    const run = e.agentId === undefined ? undefined : runs.get(e.agentId)
    const mirror = e.agentId ? (await loadRecord($, e.agentId))?.mirror : undefined
    if (mirror && !run && e.isAborted && !['completed', 'failed', 'aborted'].includes(mirror.state)) await stopMirror($, mirror)
    if (e.agentId && e.isAborted) await stopMirrorDescendants($, e.agentId)
    if (run?.mirror && !e.isAborted && (e.reason === 'answer' || (e.reason as string) === 'end_turn')) {
      await killRun(run)
      return next(e)
    }
    if (run !== undefined) {
      $.ui.log(`codex-mod: agent ${run.agentId} turn ended (${e.reason}) while Codex ran; killing it`, { to: 'debug' })
      await stopRun($, run)
    }
    if (e.agentId) dropAnswers(e.agentId)
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
    await bindPendingModelLaunch($, e.agentId)
    let name: string | undefined
    try {
      name = await agentName($, e.agentId)
    } catch (err) {
      // the type list failed: an agent we ran before is still known by its record
      name = (await loadRecord($, e.agentId))?.agentName
      if (name === undefined) throw err
      known.set(e.agentId, name)
    }
    if (name === undefined || name === 'codex-child') return yield* next(e)
    if (profileOf(name) === undefined && await loadRecord($, e.agentId) === undefined) {
      return yield* failStep(e, name, `codex failed: agent type ${$.plugin.name}:${name} is not declared by this project (.claude/codex-mod.json) or this version of the plugin`, handbackFor(e.agentId, undefined))
    }
    budgets.set(next.signal, () => next.budget.remainingMs)
    return yield* withCoordinatorMessages($, e, answerWithCodex($, e, next.signal, config, name))
  }).catch(async function* ($, e, next) {
    if (next.called) return yield* next(e)
    const agentId = e.agentId
    const name = agentId === undefined ? undefined : (known.get(agentId) ?? records.get(agentId)?.agentName)
    if (name === 'codex-child') {
      if (next.error.kind === 're-entry') return yield* next(e)
      return yield* failStep(e, name, 'codex failed: mirror dispatch failed closed', false)
    }
    if (agentId === undefined || name === undefined) return yield* next(e)
    const run = runs.get(agentId)
    if (run !== undefined) void killRun(run)
    const rec = records.get(agentId)
    if (rec !== undefined) rec.handedBack = true
    return yield* failStep(e, name, `codex failed: ${failureText(next.error)}`, handbackFor(agentId, undefined))
  })

  // A spawning hook is skipped by the loop it creates. Separate consumers
  // for two source child generations keep grandchildren intercepted too;
  // these dispatch depths do not assert native host nesting.
  for (const depth of [2, 3]) on('turn.step', { agentId: depth === 2 ? /.+/ : /[\s\S]+/ }, async function* ($, e, next) {
    if (!e.agentId) return yield* next(e)
    const saved = await loadRecord($, e.agentId)
    if (saved?.mirror) known.set(e.agentId, 'codex-child')
    if (await agentName($, e.agentId) !== 'codex-child') return yield* next(e)
    const rec = await loadRecord($, e.agentId)
    if (!rec?.mirror || !isMirror(rec.mirror) || ![2, 3].includes(rec.mirror.depth)) return yield* failStep(e, 'codex-child', 'codex failed: mirror identity unavailable; no run launched', false)
    if (rec.mirror.depth !== depth) return yield* next(e)
    budgets.set(next.signal, () => next.budget.remainingMs)
    return yield* withCoordinatorMessages($, e, answerMirror($, e, next.signal, rec))
  }).catch(async function* ($, e, next) {
    // No engine APIs here: a failure must never fall through to a provider.
    const mirror = e.agentId ? records.get(e.agentId)?.mirror : undefined
    if (mirror && mirror.depth !== depth && [2, 3].includes(mirror.depth) && next.error.kind === 're-entry') return yield* next(e)
    if (e.agentId && (known.get(e.agentId) === 'codex-child' || mirror)) {
      if (mirror) mirror.state = 'failed'
      const run = runs.get(e.agentId)
      if (run) void killRun(run)
      return yield* failStep(e, 'codex-child', 'codex failed: mirror consumer failed closed; no run launched', false)
    }
    if (e.agentId && !known.has(e.agentId)) return yield* failStep(e, 'codex-child', 'codex failed: mirror ownership unavailable', false)
    return yield* next(e)
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
      // Recovery files are updated in place; their directory mtime may be old.
      const st = await $.fs.stat(`${dir}/${ent.name}${ent.name.startsWith('state-') ? '/record.json' : ''}`)
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

const proposedFileChanges = (run: Run, q: Question) => fileApprovalEvidence(q,
  run.ledger.items.get(JSON.stringify([q.params.threadId, q.params.turnId, q.params.itemId])))
const proposedCommand = (run: Run, q: Question) => commandApprovalContext(q,
  run.ledger.items.get(JSON.stringify([q.params.threadId, q.params.turnId, q.params.itemId])))

/** Only the authoritative immediate Claude parent of a live source qualifies. */
async function agentStatusCall($: EngineInterface, e: any): Promise<any> {
  const deny = () => ({ deny: 'codex-mod: only the authoritative immediate Claude parent may read live source status' })
  if (hasPrefix(e.tool_use_id)) return deny()
  const run = typeof e.targetAgentId === 'string' ? runs.get(e.targetAgentId) : undefined
  if (run) {
    const currentSession = await $.session.id().catch(() => undefined)
    if (typeof currentSession !== 'string' || !currentSession || run.sessionId !== currentSession) return deny()
  }
  if (!run || run.ended || run.killed || run.mirror) {
    // Without a live root binding no subagent caller can establish parenthood.
    if (e.agentId !== undefined) return deny()
    return { result: [{ type: 'text', text: JSON.stringify({ available: false, reason: 'Live owned source status unavailable; use the final report. Completed, restarted and mirror reads are not supported.' }) }] }
  }
  const list = await $.agent.list().catch(() => undefined)
  if (!Array.isArray(list) || new Set(list.map(a => a?.id)).size !== list.length) return deny()
  const isCodex = (a: any) => typeof a?.type !== 'string' || a.type.startsWith(`${$.plugin.name}:`) || records.has(a.id) || runs.has(a.id)
  const parent = approvalParent(list, run.agentId, isCodex)
  if (!parent || JSON.stringify(parent) !== JSON.stringify(run.approvalParent) || !parentMayDecide(parent, e.agentId, list, isCodex)) return deny()
  // Requests count from source evidence even before their display row is emitted.
  const questions = new Map<string, Question>()
  for (const source of run.ledger.records) {
    const q = source.data as Question | undefined
    if (source.event === 'codexmod.request' && q?.params?.threadId === run.thread && q.params?.turnId === run.turnId &&
        typeof q.token === 'string' && /^[A-Za-z0-9-]+$/.test(q.token) && q.method === QUESTION_METHOD && choiceQuestions(q.params)) questions.set(q.token, q)
  }
  const pending = { approvals: [...pendingApprovals.values()].filter(p => p.run === run && p.question.status === 'pending' && p.question.params.threadId === run.thread && p.question.params.turnId === run.turnId).length,
    questions: [...questions.values()].filter(q => q.status === 'pending').length }
  const observedAt = await $.clock.now().catch(() => null)
  return { result: [{ type: 'text', text: JSON.stringify(agentStatus(run, observedAt, pending, describeCommand)) }] }
}

/** No source-provided identity is trusted by the delegated approval endpoint. */
async function approvalCall($: EngineInterface, e: any): Promise<any> {
  const deny = (reason: string) => ({ deny: `codex-mod: ${reason}` })
  if (hasPrefix(e.tool_use_id)) return deny('display calls cannot grant approvals')
  const run = typeof e.targetAgentId === 'string' ? runs.get(e.targetAgentId) : undefined
  if (!run || run.ended || run.killed || run.mirror || run.execution?.approvalMode !== 'orchestrator' || run.sessionId !== await sessionId($)) return deny('no live owner-delegated approval target')
  const list = await $.agent.list().catch(() => undefined)
  const isCodex = (a: any) => typeof a?.type !== 'string' || a.type.startsWith(`${$.plugin.name}:`) || records.has(a.id) || runs.has(a.id)
  const parent = approvalParent(list, run.agentId, isCodex)
  if (!parent || JSON.stringify(parent) !== JSON.stringify(run.approvalParent) || !parentMayDecide(parent, e.agentId, list, isCodex)) return deny('only the authoritative immediate Claude parent may inspect or decide')
  const pending = [...pendingApprovals.values()].filter(p => p.run === run && p.question.status === 'pending' && p.question.params.threadId === run.thread && p.question.params.turnId === run.turnId)
  if (e.action === 'inspect') return { result: [{ type: 'text', text: JSON.stringify(pending.map(p => {
    const fileChanges = proposedFileChanges(run, p.question)
    const commandContext = proposedCommand(run, p.question)
    return { identity: approvalIdentity(p.question), request: p.question.params, ...(p.question.method === 'item/fileChange/requestApproval'
      ? { acceptAllowed: !!fileChanges, ...(fileChanges ? { fileChanges } : { fileChangesUnavailable: FILE_APPROVAL_UNAVAILABLE }) } :
      p.question.method === 'item/commandExecution/requestApproval' ? { acceptAllowed: !!commandContext, ...(commandContext ? { commandContext } : { commandContextUnavailable: COMMAND_APPROVAL_UNAVAILABLE }) } : {}) }
  })) }] }
  if (e.action !== 'decide' || !object(e.identity)) return deny('inspect before deciding; exact approval identity required')
  const match = pending.find(p => matchesApproval(p.question, e.identity) && Object.keys(e.identity).length === Object.keys(approvalIdentity(p.question)).length)
  if (!match || !run.control) return deny('stale or mismatched approval identity')
  const body = { ...e.identity, decision: e.decision, ...(e.permissions === undefined ? {} : { permissions: e.permissions }),
    ...(e.fileChanges === undefined ? {} : { fileChanges: e.fileChanges }), ...(e.commandContext === undefined ? {} : { commandContext: e.commandContext }), actor: 'orchestrator' }
  if (!approvalResponse(match.question, body, proposedFileChanges(run, match.question), proposedCommand(run, match.question))) return deny('unsupported decision, missing or changed file proposal, or permission grant; inspect the exact current request before deciding')
  match.question.status = 'submitting'
  try { await $.fs.write(`${run.control}/response-${match.question.token}.json`, JSON.stringify(body)) }
  catch { match.question.status = 'pending'; return deny('approval control write failed; no approval delivered') }
  return { result: [{ type: 'text', text: 'Exact one-shot decision submitted to the owned runner; delivery is not yet confirmed. No command was replayed.' }] }
}

/**
 * The API owns full names. These tools have no executor, only the guards above.
 * Inputs must not shadow the host's flat envelope (tool, tool_use_id,
 * agentId, requestMeta, consent) or tool-check fields.
 */
async function registerDisplayTools($: EngineInterface): Promise<void> {
  for (const name of ['codex_tool', 'codex_plan', 'coordinator_message', 'codex_question'] as const) {
    if (displayTools[name]) continue
    const tool = name === 'codex_tool' || name === 'codex_question'
    const coordinator = name === 'coordinator_message'
    const registered = await $.tool.register({
      name,
      description: name === 'codex_question'
        ? 'Display-only controls for a pending Codex question or owner-enabled approval. Only an explicit human answer, one-shot approval, decline or cancel submits a response. Never call this tool: all other calls are refused and it executes no source operation.'
        : `Display-only ${tool ? 'tool result' : coordinator ? 'coordinator message' : 'plan update'} drawn for Codex agents. Never call this tool: all other calls are refused and it performs no work.`,
      ...(coordinator || name === 'codex_question' ? { isDeferred: false } : {}),
      inputSchema: {
        type: 'object', additionalProperties: false,
        properties: coordinator ? { sourceUuid: { type: 'string' }, text: { type: 'string' } } : tool ? { server: { type: 'string' }, name: { type: 'string' }, arguments: {} } : {
          explanation: { type: 'string' },
          steps: { type: 'array', items: { type: 'object', additionalProperties: false, properties: { step: { type: 'string' }, status: { enum: ['pending', 'in_progress', 'completed'] } }, required: ['step', 'status'] } },
        },
        required: coordinator ? ['sourceUuid', 'text'] : tool ? ['server', 'name', 'arguments'] : ['steps'],
      },
    })
    displayTools[name] = registered.tool
    displayNames.add(registered.tool)
  }
  if (!approvalTool && (cfg.approvalMode === 'orchestrator' || cfg.allowedApprovalModes.includes('orchestrator'))) {
    const registered = await $.tool.register({ name: 'codex_approval', isDeferred: false,
      description: 'Inspect or decide an exact pending one-shot Codex approval. Only the authoritative immediate Claude parent may use this owner-delegated tool. Inspect before deciding; copy the complete identity and, for file acceptance, the exact fileChanges returned by inspect. No command is replayed.',
      inputSchema: { type: 'object', additionalProperties: false, properties: { targetAgentId: { type: 'string' }, action: { enum: ['inspect', 'decide'] },
        identity: { type: 'object' }, decision: { enum: ['accept', 'decline', 'cancel'] }, permissions: { type: 'object' }, fileChanges: { type: 'object' }, commandContext: { type: 'object' } }, required: ['targetAgentId', 'action'] } })
    approvalTool = registered.tool
  }
  if (!statusTool) {
    const registered = await $.tool.register({ name: 'codex_message_status', isDeferred: false,
      description: 'Read a Codex coordinator message outcome. Use the target agent ID and message ID, source UUID or SendMessage tool use ID. Never sends messages or starts work.',
      inputSchema: { type: 'object', additionalProperties: false,
        properties: { targetAgentId: { type: 'string' }, messageId: { type: 'string' } }, required: ['targetAgentId', 'messageId'] } })
    statusTool = registered.tool
  }
  if (!agentStatusTool) {
    const registered = await $.tool.register({ name: 'codex_agent_status', isDeferred: false,
      description: 'Read compact deterministic progress already observed for a live owned Codex source. Only its authoritative immediate Claude parent may query. Does not poll Codex, summarize with a model, send messages or start work. Unavailable after end/restart and for mirrors; use the final report.',
      inputSchema: { type: 'object', additionalProperties: false, properties: { targetAgentId: { type: 'string' } }, required: ['targetAgentId'] } })
    agentStatusTool = registered.tool
  }
}

/** Registers generic, project and optional catalog types; all use haiku as
 * the host execution placeholder, never a GPT provider model ID. */
async function registerAgents($: EngineInterface, config: Config): Promise<boolean> {
  // without the display tools their rows degrade to text; the agents must still register
  await registerDisplayTools($).catch(err => $.ui.log(`codex-mod: display tools not registered: ${errText(err)}`, { to: 'debug' }))
  await loadProjectRoles($, config)
  await loadCapabilities($, true)
  let failed = false
  const list = catalog ?? undefined
  const models = list !== undefined ? ` Codex models available here: ${catalogLine(list)}.` : ''
  const override = ' Start the prompt with a line "codex-model: <model>" and/or "codex-effort: <effort>" to override the defaults.'
  const specs: { name: string; description: string; profile?: Profile }[] = []
  const g = config.generic
  specs.push({
    name: 'codex',
    description: `${GENERIC_SUMMARY} Defaults: ${g.model || list?.[0]?.slug || FALLBACK_MODEL} at ${g.effort} reasoning, sandbox ${g.sandbox}.${override}${models}`,
  })
  for (const [name, r] of projectRoles) {
    specs.push({ name, description: `${r.description} Runs OpenAI Codex ${r.model} at ${r.effort} reasoning in a ${r.sandbox} sandbox (declared by this project).${override}${models}` })
  }
  modelProfiles = new Map()
  if (config.modelAgents) for (const info of list ?? []) {
    const alias = info.slug.replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 64)
    if (projectRoles.has(info.slug) || projectRoles.has(alias)) {
      $.ui.log(`codex-mod: model agent ${info.slug} not registered: project role wins name collision`, { to: 'debug' })
      continue
    }
    if (['codex', 'codex-child'].includes(info.slug)) continue
    specs.push({ name: info.slug, profile: { model: info.slug, effort: info.defaultEffort || info.efforts[0] || FALLBACK_EFFORT, sandbox: g.sandbox },
      description: `OpenAI Codex ${info.slug}; pass effort to choose reasoning (${info.efforts.join(', ') || 'not reported'})` })
  }
  specs.push({ name: 'codex-child', description: 'Internal observation loop for an existing Codex child. Never dispatch directly.' })
  for (const s of specs) {
    try {
      const tools = [...NATIVE_TOOLS.filter(tool => availableTools!.has(tool) && (config.richRows || tool === 'Agent' && config.nestedAgents || !RICH_TOOLS.has(tool))), ...Object.values(displayTools)]
      const spec = {
        name: s.name,
        description: s.description,
        prompt: PLACEHOLDER_PROMPT,
        // the tools Codex's actions are drawn as must be the agent's own, or
        // the engine refuses them before the tool.call guard answers them
        tools,
        model: 'haiku',
        effort: 'low',
        maxTurns: 400,
        background: true,
        omitClaudeMd: true,
      }
      try {
        await $.agent.register(spec)
      } catch (err) {
        // 2.1.302 rejects dots at the API boundary, before registration hooks.
        // Try the literal slug first so a future host can support exact names.
        const alias = s.name.replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 64)
        if (!s.profile || alias === s.name || !alias || modelProfiles.has(alias) || ['codex', 'codex-child'].includes(alias)) throw err
        $.ui.log(`codex-mod: model type ${s.name} refused (${errText(err)}); registering ${alias} for Codex ${s.profile.model}`, { to: 'debug' })
        spec.name = alias
        await $.agent.register(spec)
      }
      if (s.profile) modelProfiles.set(spec.name, s.profile)
      agentTools.set(spec.name, new Set(tools))
    } catch (err) {
      failed = true
      $.ui.log(`codex-mod: agent ${s.name} not registered: ${errText(err)}`, { to: 'debug' })
    }
  }
  return !failed
}

async function loadCapabilities($: EngineInterface, refresh = false): Promise<void> {
  if (availableTools !== undefined && !refresh) return
  availableTools = new Set()
  try {
    availableTools = new Set((await $.tool.list()).map(tool => tool.name))
  } catch (err) {
    $.ui.log(`codex-mod: tool availability unknown (${errText(err)}); native rows use display fallback`, { to: 'debug' })
  }
  todoWriteAvailable = cfg.richRows && availableTools.has('TodoWrite')
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
    try { list = await $.agent.list() } catch {
      const rec = await loadRecord($, agentId)
      if (rec !== undefined) {
        known.set(agentId, rec.agentName)
        return rec.agentName
      }
      throw new Error('agent ownership unavailable')
    }
  }
  const info = list.find(a => a.id === agentId)
  if (info === undefined) {
    // not listed (dropped already): one we ran before still has its record
    const rec = await loadRecord($, agentId)
    if (rec === undefined) throw new Error('agent ownership unavailable')
    known.set(agentId, rec.agentName)
    return rec.agentName
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

/** Only a native success pin confirms which local recipient was queued. */
function nativeSendPin(answer: { result?: unknown; text?: string }): string | undefined {
  let result = answer.result
  if (!object(result) && typeof answer.text === 'string') {
    try { result = JSON.parse(answer.text) } catch { return }
  }
  return object(result) && result.success === true && object(result.pin) && typeof result.pin.id === 'string' ? result.pin.id : undefined
}

/** Receive order is per owned target and all matching native sends are
 * serialized. Text is an integrity check, never the identity of an operation. */
async function reconcileNativeCopy($: EngineInterface, agentId: string, text: string, deliveryUuid?: string): Promise<boolean> {
  const rec = records.get(agentId) ?? await loadRecord($, agentId)
  const c = rec?.coordinator
  const head = c?.ingress?.[0]
  const o = head && c?.outcomes?.[head.messageId]
  if (!rec || !c || !head?.fromSend || head.text !== text || !o || o.senderToolUseId !== head.senderToolUseId) return false
  c.ingress!.shift()
  if (deliveryUuid) {
    c.received.push(deliveryUuid)
    c.sources = Object.fromEntries([...Object.entries(c.sources ?? {}), [deliveryUuid, head.messageId]].slice(-128))
    o.deliveryUuid = deliveryUuid
  }
  await saveRecord($, agentId, rec)
  $.ui.log(`codex-mod: steer v2 native copy reconciled target=${agentId} message=${head.messageId}${deliveryUuid ? ` row=${deliveryUuid}` : ''}`, { to: 'debug' })
  return true
}

async function nativeTarget($: EngineInterface, to: unknown): Promise<string | undefined> {
  const value = typeof to === 'string' ? to : object(to) && typeof to.agentId === 'string' ? to.agentId : undefined
  if (!value) return
  const list = await $.agent.list()
  const matches = list.filter(a => a.id === value || a.name === value)
  if (matches.length !== 1) return
  return await agentName($, matches[0]!.id) !== undefined ? matches[0]!.id : undefined
}

/** The text of a row's blocks: API text blocks, or an attachment's recorded rendering (`{ content }`). */
const rowText = (content: unknown): string =>
  typeof content === 'string' ? content : Array.isArray(content) ? content.map(b => (typeof b?.text === 'string' ? b.text : typeof b?.content === 'string' ? b.content : '')).join('\n') : ''

/**
 * The coordinator deliveries recorded for the agent, taken (each once) as
 * follow-ups under `count`, the count of the message they interrupted; one
 * identified by source UUID rather than by body text.
 */
function takeDeliveries(agentId: string, count: number): FollowUp[] {
  const list = deliveries.get(agentId)
  if (list === undefined || list.length === 0) return []
  deliveries.delete(agentId)
  return list.map(d => ({ ...d, count }))
}

/** Two follow-ups are the same message: by row for a delivery, by count for a transcript message. */
const sameFollowUp = (a: FollowUp) => (b: FollowUp) => a.messageId && b.messageId ? a.messageId === b.messageId : (a.uuid !== undefined || b.uuid !== undefined ? a.uuid === b.uuid : a.count === b.count)

/** The file id of a steer: the message count, zero-padded so the runner's name order is arrival order; a delivery adds its row id. */
const steerFileId = (f: FollowUp) => (f.uuid === undefined ? f.senderToolUseId ? `${steerId(f.count)}-${f.senderToolUseId.replace(/[^A-Za-z0-9_-]/g, '_')}` : steerId(f.count) : `${steerId(f.count)}-${f.uuid.replace(/[^A-Za-z0-9_-]/g, '_')}`)

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
      await writeStoreState($, key, { handbackLock: 'text', updatedAt: await $.clock.now() })
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
    const key = recordKey(sid, agentId)
    const stored = await $.store.get(key)
    const own = isRecord(stored) ? await readStoreState($, key, stored) as AgentRecord : stored
    // A receipt may have published a record while this read was in flight.
    if (records.has(agentId)) return records.get(agentId)
    if (isRecord(own)) {
      records.set(agentId, own)
      $.ui.log(`codex-mod: agent ${agentId} record reloaded from the store (thread=${own.thread ?? 'none'})`, { to: 'debug' })
      return own
    }
    // The session id changes on --resume and /clear: find the agent under any.
    let best: { key: string; rec: AgentRecord } | undefined
    for (const key of await $.store.keys()) {
      if (!key.startsWith(STORE_PREFIX) || !key.endsWith(`:${agentId}`)) continue
      const stored = await $.store.get(key)
      const v = isRecord(stored) ? await readStoreState($, key, stored) as AgentRecord : stored
      if (isRecord(v) && (best === undefined || v.updatedAt > best.rec.updatedAt)) best = { key, rec: v }
    }
    if (best !== undefined) {
      if (records.has(agentId)) return records.get(agentId)
      records.set(agentId, best.rec)
      if (await writeStoreState($, recordKey(sid, agentId), best.rec) && best.key !== recordKey(sid, agentId)) await $.store.delete(best.key)
      $.ui.log(`codex-mod: agent ${agentId} record moved from ${best.key}`, { to: 'debug' })
      return best.rec
    }
  } catch (err) {
    $.ui.log(`codex-mod: store read failed: ${errText(err)}`, { to: 'debug' })
  }
  return records.get(agentId)
}

async function saveRecord($: EngineInterface, agentId: string, rec: AgentRecord, currentOnly = false): Promise<boolean> {
  let now: number | undefined
  try {
    now = await $.clock.now()
  } catch {
    // keep the previous stamp
  }
  // Receipt-only writes must not replace newer launch/thread/handback fields.
  if (currentOnly) rec = records.get(agentId) ?? rec
  if (now !== undefined) rec.updatedAt = now
  // Merge after the await: a first receipt can arrive while a copied launch
  // record is waiting for its timestamp, before it shares the receipt state.
  rec.coordinator = records.get(agentId)?.coordinator ?? rec.coordinator
  records.set(agentId, rec)
  try {
    const key = recordKey(await sessionId($), agentId)
    return await writeStoreState($, key, records.get(agentId) ?? rec)
  } catch (err) {
    $.ui.log(`codex-mod: store write failed: ${errText(err)}`, { to: 'debug' })
    return false
  }
}

/** Deletes agent records and session handback memos not updated for `ttlMs` (and malformed ones). */
async function pruneRecords($: EngineInterface, ttlMs: number): Promise<void> {
  try {
    const now = await $.clock.now()
    for (const key of await $.store.keys()) {
      if (!key.startsWith(STORE_PREFIX) && !key.startsWith('mirror:') && !(key.startsWith(SESSION_PREFIX) && key.endsWith(':handback'))) continue
      const v = await $.store.get(key)
      const valid = key.startsWith(STORE_PREFIX) ? isRecord(v) : key.startsWith('mirror:') ? isMirror(v) : isHandbackMemo(v)
      if (!valid || !(now - (v as AgentRecord | HandbackMemo).updatedAt < ttlMs)) {
        if (key.startsWith(STORE_PREFIX)) {
          const agent = key.slice(key.lastIndexOf(':') + 1)
          dropAnswers(agent)
          if (!runs.has(agent)) records.delete(agent)
        }
        await $.store.delete(key).catch(err => $.ui.log(`codex-mod: store prune failed for ${key}: ${errText(err)}`, { to: 'debug' }))
      } else if (!v.cachedState && JSON.stringify(v) !== JSON.stringify(compactStoreState(v))) {
        await writeStoreState($, key, v, JSON.stringify(v).length)
      }
    }
  } catch (err) {
    $.ui.log(`codex-mod: store prune failed: ${errText(err)}`, { to: 'debug' })
  }
  await flushStoreMigrations($)
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
  if (rec?.recoveryUnavailable) {
    return yield* handBack($, e, 'codex failed: recovery state unavailable', '', handbackFor(agentId, rd.signal, conv.source))
  }
  if (rec !== undefined) {
    rec.followUps = followUpsOf(rec)
    // a coordinator delivery that came after the run ended runs as a follow-up
    const arrived = takeDeliveries(agentId, rd.latest?.count ?? rec.userCount ?? 0).filter(d => !rec.followUps!.some(sameFollowUp(d)))
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
  const isNew = latest !== undefined && !(latest.coordinator && rec?.coordinator?.authoritative) && (!rec || !matchesIdentity(rec, 'lastTask', latest.text) || (rec.userCount !== undefined && latest.count > rec.userCount))
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
  if (latest !== undefined && !isCompactionText(latest.text)) {
    const seen = rec?.userCount
    if (seen !== undefined ? latest.count > seen : latest.text !== rec?.lastTask) {
      if (!(latest.coordinator && rec?.coordinator?.authoritative)) fresh.push(latest)
    }
  }
  fresh.push(...takeDeliveries(run.agentId, latest?.count ?? rec?.userCount ?? 0))
  for (const f of fresh) {
    const same = sameFollowUp(f)
    if (f.uuid && Object.values(rec?.coordinator?.outcomes ?? {}).some(o => o.sourceUuid === f.uuid)) continue
    if (run.followUps.some(same) || run.pendingSteers.some(same) || followUpsOf(rec).some(same)) continue
    await foldIn($, run, f)
  }
}

/** Persist an outcome and redraw its owned receipt without touching transcript rows. */
async function recordOutcome($: EngineInterface, agentId: string, o: MessageOutcome): Promise<boolean> {
  const rec = records.get(agentId) ?? await loadRecord($, agentId)
  if (!rec) return false
  const c = rec.coordinator ??= { received: [], pending: [] }
  const previous = c.outcomes?.[o.messageId]
  // A delayed pending reply must not overwrite a stdout acknowledgment.
  if (previous && !['received', 'pending'].includes(previous.status) && ['received', 'pending'].includes(o.status)) return true
  const outcome = { ...previous, ...o, sourceUuid: o.sourceUuid ?? previous?.sourceUuid,
    ...(previous?.status === 'queued' && o.status === 'rejected' ? { status: 'queued' as const, queuedAfterTurnId: previous.queuedAfterTurnId } : {}) }
  c.outcomes = Object.fromEntries([...Object.entries(c.outcomes ?? {}).filter(([id]) => id !== o.messageId), [o.messageId, outcome]].slice(-128))
  const saved = await saveRecord($, agentId, rec)
  await publishOutcome($, outcome)
  return saved
}

async function foldIn($: EngineInterface, run: Run, f: FollowUp): Promise<void> {
  const rec = records.get(run.agentId)
  const messageId = f.messageId ?? f.uuid ?? `cm-${Array.from({ length: 4 }, () => Math.floor(Math.random() * 0x100000000).toString(16).padStart(8, '0')).join('')}`
  f.messageId = messageId
  const previous = rec?.coordinator?.outcomes?.[messageId]
  if (previous) return
  const o: MessageOutcome = { id: steerFileId(f), messageId, sourceUuid: f.uuid, sessionId: run.sessionId, agentId: run.agentId,
    senderToolUseId: f.senderToolUseId ?? nativeSends.get(run.agentId)?.id, runId: run.control, threadId: run.thread, expectedTurnId: run.turnId,
    status: 'received', receivedAt: Date.now() }
  // Journal ownership before any transport call, including the exec FIFO.
  if (rec && !f.uuid && !o.senderToolUseId) { rec.userCount = f.count; rec.lastTask = f.text }
  if (!await recordOutcome($, run.agentId, o)) {
    await recordOutcome($, run.agentId, { ...o, status: 'unknown', reason: 'receipt checkpoint unavailable; no submission' })
    return
  }
  const steeringRequest = executionRequest(f.text)
  if (Object.keys(steeringRequest.request).length) {
    run.queue.push({ kind: 'note', text: '↪ execution policy headers cannot change a running or resumed thread; start a new agent with the requested owner-granted policy' })
    if (f.messageId || f.uuid) await recordOutcome($, run.agentId, { messageId: f.messageId ?? f.uuid!, sourceUuid: f.uuid, status: 'rejected', receivedAt: Date.now(), reason: 'execution policy headers require a new agent' })
    return
  }
  const text = parseOverrides(steeringRequest.rest).rest.trim()
  if (run.transport === 'app-server' && run.control !== undefined && !run.ended && !run.killed && text !== '') {
    run.pendingSteers.push(f)
    try {
      const outcome = await controlRequest($, run.control, '/messages', { ...o, id: steerFileId(f), text: roleTask(run.name, text, run.policy),
        ...(run.mirror ? { threadId: run.mirror.thread } : {}) }, `steer-${steerFileId(f)}.json`)
      if (outcome) await handle($, run, { kind: 'steer', id: String(outcome.id), accepted: ['accepted', 'observed'].includes(outcome.status), reason: outcome.reason, outcome })
      else await recordOutcome($, run.agentId, { ...o, status: 'pending' })
    } catch {
      await recordOutcome($, run.agentId, { ...o, status: 'unknown', reason: 'control outcome unavailable; no retry' })
    }
    return
  }
  run.followUps.push(f)
  if (rec) rec.followUps = [...followUpsOf(rec).filter(f => !run.followUps.some(sameFollowUp(f))), ...run.followUps]
  const saved = rec && await saveRecord($, run.agentId, rec)
  await recordOutcome($, run.agentId, { ...o, status: saved ? 'queued' : 'unknown', queuedAfterTurnId: run.turnId,
    reason: saved ? undefined : 'follow-up checkpoint unavailable; no retry' })
  if (!saved) {
    run.followUps = run.followUps.filter(v => !sameFollowUp(f)(v))
    if (rec?.followUps) rec.followUps = rec.followUps.filter(v => !sameFollowUp(f)(v))
    run.queue.push({ kind: 'note', text: '↪ follow-up checkpoint unavailable; outcome unknown, no automatic retry' })
    return
  }
  if (run.transport === 'app-server' || !run.queuedNoted) run.queue.push({ kind: 'note', text: steerNote(run.transport === 'app-server' ? 'finished' : 'queued') })
  run.queuedNoted = true
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
  retry?: { profile: Profile; key: string; note: string },
): AsyncGenerator<TurnStepChunk, TurnStepResult> {
  const agentId = e.agentId!
  if (base.recoveryUnavailable) return yield* handBack($, e, 'codex failed: recovery state unavailable', '', handback)
  await loadCatalog($)
  const launch = executionRequest(rawTask)
  const resolved = retry ? { profile: retry.profile, rest: parseOverrides(launch.rest).rest, invalid: checkProfile(catalog ?? undefined, retry.profile.model, retry.profile.effort) }
    : resolveProfile(base, launch.rest, catalog ?? undefined)
  const lastTask = delivery !== undefined && base.lastTask !== undefined ? base.lastTask : rawTask
  const rec: AgentRecord = {
    ...base,
    agentName: name,
    ...resolved.profile,
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
  const invalid = resolved.invalid
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
    base.guardTrip && (base.guardTrip.key === key || matchesIdentity({ guardTripKeyFingerprint: base.guardTripKeyFingerprint }, 'guardTripKey', key)) ? base.guardTrip.reason
    : retry && (retry.key !== key || matchesIdentity(base, 'capacityRetryKey', key)) ? 'capacity retry already used or message changed'
    : !retry && matchesIdentity(base, 'launchKey', key) && (base.launchesSinceNew ?? 0) >= 1 ? 'this message already had its Codex run'
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
  rec.launchesSinceNew = matchesIdentity(base, 'launchKey', key) ? (base.launchesSinceNew ?? 0) + 1 : 1
  rec.launchKey = key
  rec.guardTrip = undefined
  if (retry) rec.capacityRetryKey = key
  rec.fallbackModels ??= projectRoles.get(name)?.fallbackModels ?? config.capacityFallback
  await saveRecord($, agentId, rec)
  $.ui.invalidate('ui.render')
  if (base.lastTask === undefined && base.selection?.note) carry = [carry, `↪ ${base.selection.note}`].filter(Boolean).join('\n\n')
  const sessionCwd = await $.session.cwd()
  if (rec.executionFingerprint && !rec.effectiveExecution) return yield* handBack($, e, 'codex failed: saved execution policy unavailable; restore its private cache before resuming', '', handback)
  if (rec.effectiveExecution && rec.executionFingerprint !== rec.effectiveExecution.fingerprint) return yield* handBack($, e, 'codex failed: saved execution policy fingerprint mismatch; no resume launched', '', handback)
  const execution = await resolveExecution($, config, launch.request, sessionCwd, prof.sandbox, rec.effectiveExecution, !!rec.thread && !rec.effectiveExecution)
  rec.effectiveExecution = execution
  rec.executionFingerprint = execution.fingerprint
  rec.sandbox = prof.sandbox = execution.sandbox
  const cwd = execution.cwd
  let configNote = base.thread && (base.model !== rec.model || base.effort !== rec.effort)
    ? 'model/effort changed on follow-up; cold start possible' : undefined
  if (execution.source === 'legacy') configNote = [configNote, 'legacy execution baseline unknown; pinned current cwd with never approvals, no network or extra roots'].filter(Boolean).join('; ')
  if (!rec.effectiveConfig) {
    if (rec.effectiveFingerprint) {
      return yield* handBack($, e, 'codex failed: saved thread policy unavailable; restore its private state cache before resuming', '', handback)
    }
    const overrides = await leanArgs($)
    let home: string
    try {
      home = config.globalRules ? await codexHome($) : await shadowHome($)
    } catch (err) {
      return yield* handBack($, e, `codex failed: could not prepare the CODEX_HOME without global rules (${errText(err)})`, '', handback)
    }
    const policy = resolvePolicy(config, projectRoles.get(name), overrides.filter((_, i) => overrides[i - 1] === '-c'),
      overrides.flatMap(s => /^mcp_servers\.([A-Za-z0-9_-]+)\.enabled=/.exec(s)?.[1] ?? []),
      home)
    rec.effectiveConfig = policy.policy
    for (const warning of policy.warnings) $.ui.log(`codex-mod: agent ${agentId}: ${warning}`, { to: 'debug' })
    if (policy.warnings.length) configNote = [configNote, ...policy.warnings].filter(Boolean).join('; ')
    if (base.thread) configNote = [configNote, 'legacy thread policy baseline unknown; snapshot retained from this turn'].filter(Boolean).join('; ')
  }
  rec.effectiveFingerprint = configHash({ policy: rec.effectiveConfig.fingerprint, ...prof })
  await saveRecord($, agentId, rec)
  const task = roleTask(name, resolved.rest, rec.effectiveConfig)
  const lean = rec.effectiveConfig.overrides.filter(kv => !executionOverride(kv)).flatMap(kv => ['-c', kv])
  const env = { CODEX_HOME: rec.effectiveConfig.home }
  const via = await transportFor($, config)
  if (execution.approvalMode !== 'never' && via.transport !== 'app-server') return yield* handBack($, e, `codex failed: approval mode ${execution.approvalMode} requires app-server; ${via.transport === 'exec' ? via.note ?? 'exec transport selected' : ''}. No fallback run was made.`, '', handback)
  // Status uses the same launch-bound host identity in every approval mode.
  const hostAgents = await $.agent.list().catch(() => undefined)
  const parent: Run['approvalParent'] = Array.isArray(hostAgents) && new Set(hostAgents.map(a => a?.id)).size === hostAgents.length
    ? approvalParent(hostAgents, agentId, (a: any) => typeof a?.type !== 'string' || a.type.startsWith(`${$.plugin.name}:`) || records.has(a.id) || runs.has(a.id)) : undefined
  if (execution.approvalMode === 'orchestrator') {
    if (!parent || !approvalTool) return yield* handBack($, e, 'codex failed: authoritative Claude parent identity or approval tool unavailable; orchestrator approvals refused', '', handback)
  }
  if (execution.approvalMode === 'ask' && (!config.nativeActions || !displayTools.codex_question || agentTools.get(name) && !agentTools.get(name)!.has(displayTools.codex_question!))) return yield* handBack($, e, 'codex failed: ask approvals require owned native UI controls; host UI unavailable', '', handback)
  if (rec.thread && !rec.mirror && !rec.historyAmbiguous && (config.archiveSessions || rec.historyArchived === true) && !historyInUse(rec.thread, env.CODEX_HOME)) {
    // The CLI also fails for an already active thread. Keep the normal exact-ID
    // resume as the state check: never retry it or replace it with a new thread.
    if (await sessionHistory($, config.codexPath ?? 'codex', env.CODEX_HOME, 'unarchive', rec.thread)) {
      rec.historyArchived = undefined
      await saveRecord($, agentId, rec)
    }
  }
  if (retry) carry = [carry, `↪ ${retry.note}`].filter(Boolean).join('\n\n')
  let argv: string[]
  let control: string | undefined
  if (via.transport === 'app-server') {
    // a fresh control dir per run: no file of an earlier run may steer this one
    rec.runSeq = (rec.runSeq ?? 0) + 1
    await saveRecord($, agentId, rec)
    const safe = (s: string) => {
      let a = 2166136261, b = 5381
      for (const c of s) { a = Math.imul(a ^ c.charCodeAt(0), 16777619); b = Math.imul(b, 33) ^ c.charCodeAt(0) }
      return `${(a >>> 0).toString(36)}${(b >>> 0).toString(36)}`
    }
    const runs = await runsDir($)
    control = `${runs}/${safe(await sessionId($))}-${safe(agentId)}-${rec.runSeq}`
    await $.process.run(['rm', '-rf', control], { timeoutMs: 10000 }).catch(() => undefined)
    // created private (0700) here, before any steer file (prompt text) is written
    // into it: `$.fs.write` would create missing directories with the default mode
    await $.process.run(['mkdir', '-p', '-m', '700', `${runs.slice(0, runs.lastIndexOf('/'))}`, runs, control], { timeoutMs: 10000 }).catch(() => undefined)
    const questionTool = displayTools.codex_question
    const questions = config.nativeActions && !rec.effectiveConfig.lean && questionTool !== undefined && (agentTools.get(name)?.has(questionTool) ?? true)
    argv = runnerArgv({ node: via.node, runner: via.runner, codex: config.codexPath ?? 'codex', prof, cwd, resume: rec.thread, lean, extra: [], control, questions, nestedAgents: config.nestedAgents, execution })
    $.ui.log(`codex-mod: agent ${agentId} -> ${argv.join(' ')}${env ? ` (CODEX_HOME=${env.CODEX_HOME})` : ''} (prompt ${task.length} chars on stdin)`, { to: 'debug' })
  } else {
    argv = launchArgv({ codex: config.codexPath ?? 'codex', prof, cwd, resume: rec.thread, lean, extra: [], execution })
    $.ui.log(`codex-mod: agent ${agentId} -> ${argv.slice(0, -1).join(' ')}${env ? ` (CODEX_HOME=${env.CODEX_HOME})` : ''} (prompt ${task.length} chars on stdin)`, { to: 'debug' })
  }

  await loadCapabilities($)
  const run: Run = {
    sessionId: await sessionId($),
    startedAtMs: await $.clock.now().catch(() => undefined),
    ledger: new SourceLedger(),
    rows: {},
    agentId,
    name,
    prof,
    cwd,
    child: $.process.spawn({ argv, cwd, input: task, ...(env ? { env } : {}) }),
    history: { codex: config.codexPath ?? 'codex', home: env.CODEX_HOME, archive: config.archiveSessions, thread: rec.thread, ambiguous: rec.historyAmbiguous },
    thread: rec.thread,
    buffered: '',
    stderrTail: '',
    texts: [],
    errors: [],
    queue: [],
    snapshots: new Map(),
    actions: 0,
    patches: 0,
    patchRows: 0,
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
    policy: rec.effectiveConfig,
    execution,
    approvalParent: parent,
    configNote,
    capacityRetried: !!retry,
    rawTask,
    messageCount: count,
    delivery,
    execBaseline: rec.thread ? rec.threadUsage?.thread === rec.thread && rec.threadUsage.valid ? rec.threadUsage.total : undefined : zeroUsage(),
  }
  if (rec.thread) rec.threadUsage = { thread: rec.thread, total: rec.threadUsage?.total ?? zeroUsage(), valid: false }
  rec.wire = { records: run.ledger.records, rows: run.rows }
  await saveRecord($, agentId, rec)
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
  const ids = new Set([...Object.keys(records.get(agentId)?.wire?.rows ?? {}), ...Object.keys(records.get(agentId)?.coordinator?.rows ?? {})])
  for (const [id, row] of sourceRows) if (row.agentId === agentId) ids.add(id)
  for (const [id, row] of questionRows) if (row.agent === agentId) ids.add(id)
  for (const id of ids) {
    sourceRows.delete(id)
    planCards.delete(id)
    questionRows.delete(id)
    coordinatorRows.delete(id)
  }
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
  const record = records.get(run.agentId)
  if (record && run.thread && !run.ended && !run.mirror) {
    record.threadUsage = { thread: run.thread, total: run.execTotal ?? record.threadUsage?.total ?? zeroUsage(), valid: false }
    await saveRecord($, run.agentId, record)
  }
  await stopMirrorDescendants($, run.agentId)
  if (run.mirror) { await stopMirror($, run.mirror); return killRun(run) }
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

/** Request interruption once, then drain until terminal evidence or the grace deadline. */
async function interruptRun($: EngineInterface, run: Run): Promise<void> {
  try {
    await controlRequest($, run.control!, '/interrupt', { turnId: run.turnId }, 'interrupt')
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
    if (line !== '') await feedLine($, run, line)
  }
}

async function feedLine($: EngineInterface, run: Run, line: string): Promise<void> {
  let envelope: any
  try { envelope = JSON.parse(line) } catch {}
  if (envelope?.type === 'codexmod.childEvent') return
  if (envelope?.type === 'codexmod.treeUsage') { run.treeUsage = envelope; run.usage = envelope.direct; run.usagePartial = envelope.directPartial; run.usageCanonical = true; return }
  if (envelope?.type === 'codexmod.directUsage') { run.usage = envelope.usage; run.usageCanonical = true; run.usagePartial = envelope.partial; return }
  if (envelope?.type === 'codexmod.threadUsage') {
    const rec = records.get(run.agentId)
    if (rec && envelope.thread_id === run.thread && validUsage(envelope.total)) {
      rec.threadUsage = { thread: run.thread!, total: envelope.total, valid: true }
      await saveRecord($, run.agentId, rec)
    }
    return
  }
  if (envelope?.type === 'codexmod.child') {
    detectSpawn($, run, envelope.thread_id, envelope.thread_id)
    await launchMirror($, run, envelope)
    return
  }
  const source = normalizeSource(line, { transport: run.transport, threadId: run.thread, turnId: run.turnId, cwd: run.cwd })
  if (source && (envelope?.source || EXEC_TYPES.includes(source.event) || source.event === 'codexmod.turn')) {
    run.lastSourceObservedAtMs = await $.clock.now().catch(() => run.lastSourceObservedAtMs)
  }
  if (source && run.execution) source.executionPolicy = run.execution
  if (source?.event === 'turn.started' && source.turnId) run.turnId = source.turnId
  const captured = source ? run.ledger.capture(source) : undefined
  if (captured?.record.item?.type === 'fileChange') $.ui.invalidate('ui.render')
  if (captured?.render === false) {
    if (run.transport === 'exec' && envelope?.type === 'turn.completed') await handle($, run, parseCodexLine(line), source)
    return
  }
  const item = captured?.record.item
  if (item && (item.type === 'subAgentActivity' && item.kind === 'started' ||
      item.type === 'collabAgentToolCall' && String(item.tool).replace(/_/g, '').toLowerCase() === 'spawnagent')) {
    const receivers = item.receiverThreadIds ?? item.receiver_thread_ids
    const ids = Array.isArray(receivers) ? receivers : typeof item.agentThreadId === 'string' ? [item.agentThreadId] : []
    if (ids.length) for (const id of ids) detectSpawn($, run, id, id)
    else detectSpawn($, run, `${source?.threadId}:${item.id}`)
  }
  const complete = ['item.completed', 'item/completed'].includes(source?.event ?? '')
  if (item?.type === 'imageGeneration' && !complete && ['item.started', 'item/started', 'item.updated'].includes(source?.event ?? '')) {
    run.queue.push({ kind: 'interim', text: `Codex image generation status:\n${JSON.stringify(item)}` })
    return
  }
  if (source?.event === 'thread/compacted' || complete && item?.type === 'contextCompaction') {
    const key = JSON.stringify([source?.threadId, source?.turnId])
    const seen = (run.compactions ??= new Map()).get(key) ?? { notification: false, items: [] }
    let show = false
    if (item) {
      if (!seen.items.includes(item.id)) {
        show = seen.items.length > 0 || !seen.notification
        seen.items.push(item.id)
      }
    } else {
      show = !seen.notification && seen.items.length === 0
      seen.notification = true
    }
    run.compactions.set(key, seen)
    if (show) run.queue.push({ kind: 'interim', text: '↪ Codex compacted context' })
    return
  }
  if (complete && item && ['imageView', 'imageGeneration'].includes(item.type)) {
    if (item.type === 'imageGeneration') await handle($, run, { kind: 'action', display: 'codex_tool', action: generationAction(item) }, captured?.record)
    else run.actions++
    const path = item.type === 'imageView' ? item.path : item.savedPath
    if (typeof path !== 'string' || path === '' || item.type === 'imageGeneration' && (item.status !== 'completed' || item.failure)) {
      if (item.type === 'imageView' || item.status === 'completed') run.queue.push({ kind: 'interim', text: 'Codex image preview unavailable: no real saved image path reported; remote result strings are not fetched.' })
      return
    }
    const resolved = absolute(source?.cwd ?? run.cwd, path)
    const ownTools = agentTools.get(run.name) ?? availableTools
    if (!cfg.nativeActions || !ownTools?.has('Read')) {
      run.queue.push({ kind: 'interim', text: `Codex ${item.type} ${JSON.stringify(resolved)}: preview unavailable (${cfg.nativeActions ? "Read unavailable in this agent's tools" : 'nativeActions:false'}).` })
      return
    }
    const preview = await captureImage($, resolved)
    run.queue.push({ kind: 'interim', text: `Codex ${item.type} preview ${JSON.stringify(resolved)}: ${preview.action ? 'later file image captured after the reported operation; original viewed bytes are not established.' : preview.reason}` })
    if (preview.action) run.queue.push({ kind: 'action', action: { ...preview.action, source: captured?.record } })
    return
  }
  if (complete && item && ['enteredReviewMode', 'exitedReviewMode'].includes(item.type)) {
    run.queue.push({ kind: 'interim', text: `Codex ${item.type === 'enteredReviewMode' ? 'entered' : 'exited'} review mode${typeof item.review === 'string' ? `\n${item.review}` : ''}` })
    if (item.findings !== undefined) {
      const action = findingsAction(item)
      if (action && cfg.richRows) await handle($, run, { kind: 'action', action }, captured?.record)
      else run.queue.push({ kind: 'interim', text: `Codex review findings (${action ? 'richRows disabled' : 'required structured fields missing'}):\n${JSON.stringify(item.findings)}` })
    }
    return
  }
  if (complete && item?.type === 'sleep') {
    run.queue.push({ kind: 'interim', text: `Codex waited ${item.durationMs ?? item.duration_ms ?? '(duration unreported)'} ms` })
    return
  }
  const child = ['collabAgentToolCall', 'subAgentActivity'].includes(item?.type)
  const plan = ['todo_list', 'plan_update'].includes(item?.type)
  if (child || plan) {
    if (child && cfg.nestedAgents && run.transport === 'app-server' && (item?.kind === 'started' || String(item?.tool).replace(/_/g, '').toLowerCase() === 'spawnagent') && !['failed', 'declined'].includes(item?.status)) {
      const ids = item?.agentThreadId ? [item.agentThreadId] : item?.receiverThreadIds ?? []
      if (ids.some(validThreadId)) {
        for (const id of ids.filter(validThreadId)) (run.childSources ??= new Map()).set(id, captured!.record)
        return
      }
    }
    if (child && !['item.completed', 'item/completed'].includes(source!.event)) return
    if (item?.type === 'collabAgentToolCall' && item.status === 'inProgress') return
    if (child && cfg.nestedAgents && run.transport === 'exec') $.ui.log('codex-mod: nested mirror unavailable on exec; using Batch 5 lifecycle/report rows', { to: 'debug' })
    const rec = records.get(run.agentId)
    if (!rec) return
    const state = rec.display ??= emptyDisplayState()
    const tools = agentTools.get(run.name) ?? new Set([...NATIVE_TOOLS.filter(t => availableTools?.has(t) && (cfg.richRows || !RICH_TOOLS.has(t))), ...Object.values(displayTools)])
    const context = { session: run.sessionId, agent: run.agentId, thread: source?.threadId ?? run.thread ?? 'unreported', turn: source?.turnId ?? run.turnId, rich: cfg.richRows, tools }
    let rows
    if (child) rows = childRows(item, state, context)
    else {
      const parsed = parseCodexLine(line) as Extract<CodexEvent, { kind: 'action' }>
      if (parsed.kind !== 'action') return
      rows = planRows(parsed.action.input as PlanInput, state, context)
    }
    await saveRecord($, run.agentId, rec)
    for (const row of rows) await handle($, run, row, captured?.record)
    return
  }
  const ev = parseCodexLine(line, cfg.richRows, todoWriteAvailable)
  if ((ev.kind === 'files' || ev.kind === 'fileStart') && captured?.record.item) ev.changes = changesOf(captured.record.item)
  await handle($, run, ev, captured?.record)
}

function detectSpawn($: EngineInterface, run: Run, key: string, child?: string): void {
  if (child) (run.observedChildren ??= new Set()).add(child)
  if (run.policy?.multiAgent !== false || (run.spawnDetected ??= new Set()).has(key)) return
  run.spawnDetected.add(key)
  const note = 'multiAgent=false: Codex child spawn observed despite instruction; tool removal is unsupported'
  $.ui.log(`codex-mod: agent ${run.agentId}, thread ${run.thread ?? 'unknown'}: ${note} (${key})`, { to: 'debug' })
  if (!run.configNote?.includes(note)) {
    run.configNote = [run.configNote, note].filter(Boolean).join('; ')
    run.queue.push({ kind: 'note', text: `↪ ${note}; preserving real child rows and mirrors` })
  }
}

export const absolute = (cwd: string, path: string) => {
  const parts: string[] = []
  for (const part of (path.startsWith('/') ? path : `${cwd}/${path}`).split('/')) {
    // Let the filesystem resolve parents; collapsing them could cross a symlink.
    if (part !== '' && part !== '.') parts.push(part)
  }
  return '/' + parts.join('/')
}
const snapshotKey = (source: SourceRecord | undefined, path: string) => JSON.stringify([source?.threadId, source?.turnId, source?.itemId, path])

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
  if (text !== undefined && text.length <= 4 * PATCH_TEXT_MAX) run.snapshots.set(path, text)
  else run.snapshots.delete(path)
}

async function handle($: EngineInterface, run: Run, ev: CodexEvent, source?: SourceRecord): Promise<void> {
  if (ev.kind === 'thread') {
    run.thread = ev.id
    if (run.history) {
      if (run.history.thread !== undefined && run.history.thread !== ev.id) run.history.ambiguous = true
      else {
        run.history.thread = ev.id
        run.history.observed = true
      }
    }
    const rec = records.get(run.agentId)
    if (rec && run.history?.ambiguous) rec.historyAmbiguous = true
    if (rec?.historyArchived && !run.mirror) {
      rec.historyArchived = undefined
      await saveRecord($, run.agentId, rec)
    }
    if (rec !== undefined && rec.thread !== ev.id) {
      rec.thread = ev.id
      rec.threadUsage = { thread: ev.id, total: zeroUsage(), valid: false }
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
    const evidence = permissionEvidence(`${ev.action.error ?? ''} ${JSON.stringify(ev.action.result)}`, run.execution)
    if (evidence && !run.queue.some(q => q.kind === 'note' && q.text === evidence)) run.queue.push({ kind: 'note', text: evidence })
    if (source?.item?.type === 'webSearch') {
      ev.action = webAction(source.item, source)
      ev.display = ev.action.tool === 'codex_tool' ? 'codex_tool' : undefined
    }
    ev.action.source = source
    if (source?.item?.status === 'inProgress' && source.item.type !== 'imageGeneration') return
    if (['failed', 'declined'].includes(source?.item?.status) && !ev.action.error && !(source?.item?.status === 'failed' && ev.action.tool === 'WebFetch' && !Array.isArray(ev.action.result) && Number(ev.action.result.code) >= 400)) ev.action.error = `Codex ${source!.item!.type} ${source!.item!.status}: ${JSON.stringify(source!.item)}`
    if (ev.action.tool === 'WebSearch' && object(ev.action.result)) ev.action.result.durationSeconds = (sourceDuration(source) ?? 0) / 1000
    if (ev.display) {
      await registerDisplayTools($).catch(err => $.ui.log(`codex-mod: display tools not registered: ${errText(err)}`, { to: 'debug' }))
      const tool = displayTools[ev.display]
      // no registered display tool: the action is shown as its text line, never as a row
      if (tool === undefined) {
        run.queue.push({ kind: ev.action.input.name === 'imageGeneration' ? 'interim' : 'note', text: actionLine(ev.action) })
        return
      }
      ev.action.tool = tool
    }
    run.queue.push({ kind: 'action', action: ev.action })
  } else if (ev.kind === 'error') run.errors.push(ev.text)
  else if (ev.kind === 'warning') run.queue.push({ kind: 'interim', text: `Codex warning: ${ev.text}` })
  else if (ev.kind === 'question') {
    const q = ev.question
    if (run.transport !== 'app-server' || !run.control || q.params?.threadId !== run.thread || q.params?.turnId !== run.turnId || !/^[A-Za-z0-9-]+$/.test(q.token)) {
      run.queue.push({ kind: 'interim', text: `Codex request ignored: unbound RPC ${JSON.stringify(q.requestId)} (${q.method})` })
      return
    }
    if (q.status === 'pending') run.lastSourceObservedAtMs = await $.clock.now().catch(() => run.lastSourceObservedAtMs)
    for (const row of questionRows.values()) if (row.agent === run.agentId && row.question.token === q.token) row.question = q
    $.ui.invalidate('ui.render')
    if (APPROVAL_METHODS.has(q.method)) {
      if (q.status !== 'pending') pendingApprovals.delete(q.token)
      if (q.status === 'pending' && approvalRequest(q.method, q.params)) {
        if (run.mirror || !run.execution || !['ask', 'orchestrator'].includes(run.execution.approvalMode)) return
        pendingApprovals.set(q.token, { run, question: q })
        if (run.execution.approvalMode === 'orchestrator') {
          run.queue.push({ kind: 'interim', text: `Codex approval pending: parent must inspect codex_approval with targetAgentId=${run.agentId}. No consent supplied.` })
          return
        }
        const tool = displayTools.codex_question
        if (!tool || !cfg.nativeActions || agentTools.get(run.name) && !agentTools.get(run.name)!.has(tool)) {
          await $.fs.write(`${run.control}/response-${q.token}.json`, JSON.stringify({ ...approvalIdentity(q), unsupported: true, actor: 'human' }))
          run.queue.push({ kind: 'interim', text: 'Codex approval unsupported: owned native UI controls unavailable; no consent supplied.' })
          return
        }
        run.queue.push({ kind: 'action', action: { tool, input: { server: 'codex', name: q.method, arguments: { ...q.params, requestId: q.requestId, token: q.token, status: q.status } },
          result: [{ type: 'text', text: 'Approval received; awaiting explicit one-shot decision. Receipt is not consent.' }], source } })
        return
      }
    }
    if (q.status === 'pending' && q.method === QUESTION_METHOD && choiceQuestions(q.params)) {
      const tool = displayTools.codex_question
      const ownTools = agentTools.get(run.name)
      if (!cfg.nativeActions || (run.policy?.lean ?? cfg.lean) || !tool || ownTools && !ownTools.has(tool)) {
        await $.fs.write(`${run.control}/response-${q.token}.json`, JSON.stringify({ token: q.token, requestId: q.requestId,
          threadId: q.params.threadId, turnId: q.params.turnId, itemId: q.params.itemId, unsupported: true }))
        run.queue.push({ kind: 'interim', text: 'Codex question unsupported: owned question UI unavailable; no answer or consent supplied.' })
        return
      }
      // Registration provides the ToolUse site; only its explicit controls write a response.
      const action: Action = { tool, input: { server: 'codex', name: q.method, arguments: { ...q.params, requestId: q.requestId, token: q.token, status: 'pending' } },
        result: [{ type: 'text', text: 'Question received; awaiting an explicit user response. Receipt does not answer or approve.' }], source }
      run.queue.push({ kind: 'action', action })
    } else {
      run.queue.push({ kind: 'interim', text: `Codex request ${q.status} (${q.method}, RPC ${JSON.stringify(q.requestId)}):\n${JSON.stringify(q.error ?? q.result ?? q.params)}` })
      const action = q.status === 'answered' ? answeredQuestion(q.params, q.result) : undefined
      if (action && cfg.richRows) await handle($, run, { kind: 'action', action }, source)
    }
  }
  else if (ev.kind === 'turn') { run.turnId = ev.id; if (run.mirror) run.mirror.activeTurn = ev.id }
  else if (ev.kind === 'steer') {
    if (run.mirror) {
      if (ev.outcome.messageId) await recordOutcome($, run.agentId, ev.outcome)
      run.queue.push({ kind: 'note', text: `↪ child steer ${ev.id}: ${ev.accepted ? 'accepted' : ev.reason ?? 'rejected'}; no automatic retry` }); return }
    if (ev.outcome.status === 'pending' || ev.outcome.status === 'received') {
      if (ev.outcome.messageId) await recordOutcome($, run.agentId, ev.outcome)
      return
    }
    const i = run.pendingSteers.findIndex(f => (ev.outcome.messageId && f.messageId === ev.outcome.messageId) || (f.uuid === undefined && String(f.count) === ev.id) || steerFileId(f) === ev.id)
    if (i < 0) {
      if (ev.outcome.messageId) await recordOutcome($, run.agentId, ev.outcome)
      return
    }
    const [s] = run.pendingSteers.splice(i, 1)
    const outcome = { ...ev.outcome, messageId: ev.outcome.messageId ?? s!.messageId!, sourceUuid: s!.uuid }
    await recordOutcome($, run.agentId, outcome)
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
      run.queue.push({ kind: 'note', text: steerNote('accepted') })
      $.ui.log(`codex-mod: agent ${run.agentId}: steer ${ev.id} accepted`, { to: 'debug' })
    } else if (ev.outcome.status === 'unknown') {
      run.queue.push({ kind: 'note', text: `↪ ${messageStatus(outcome)}; no automatic retry` })
    } else {
      run.followUps.push(s!)
      const rec = records.get(run.agentId)
      if (rec) rec.followUps = [...followUpsOf(rec).filter(f => !run.followUps.some(sameFollowUp(f))), ...run.followUps]
      const saved = rec && await saveRecord($, run.agentId, rec)
      await recordOutcome($, run.agentId, { ...outcome, status: saved ? 'queued' : 'unknown', queuedAfterTurnId: run.turnId })
      if (!saved) {
        run.followUps = run.followUps.filter(v => !sameFollowUp(s!)(v))
        if (rec?.followUps) rec.followUps = rec.followUps.filter(v => !sameFollowUp(s!)(v))
      }
      run.queue.push({ kind: 'note', text: `↪ ${messageStatus({ ...outcome, status: saved ? 'queued' : 'unknown', queuedAfterTurnId: run.turnId })}` })
      $.ui.log(`codex-mod: agent ${run.agentId}: steer ${ev.id} rejected; ${saved ? 'queued after turn' : 'checkpoint unavailable'}`, { to: 'debug' })
    }
  } else if (ev.kind === 'protocol') {
    run.unknown += ev.types.length
    for (const t of ev.types) if (run.unknownTypes.length < 3 && !run.unknownTypes.includes(t)) run.unknownTypes.push(t)
  } else if (ev.kind === 'fatal') run.fatal = ev.text
  else if (ev.kind === 'unknown') {
    run.unknown++
    if (run.unknownTypes.length < 3 && !run.unknownTypes.includes(ev.type)) run.unknownTypes.push(ev.type)
  } else if (ev.kind === 'usage') {
    if (run.usageCanonical) return
    const total = { input: ev.input, cached: ev.cached, output: ev.output }
    if (run.transport === 'exec' && !run.mirror) {
      run.execTotal = total
      const delta = execDelta(total, run.execBaseline)
      run.usage = delta.usage
      run.usagePartial = delta.partial
      const rec = records.get(run.agentId)
      if (rec && run.thread && validUsage(total)) {
        rec.threadUsage = { thread: run.thread, total, valid: true }
        await saveRecord($, run.agentId, rec)
      }
    } else run.usage = total
  } else if (ev.kind === 'command') {
    run.actions++
    if (source?.item?.status === 'inProgress') return
    run.queue.push({ kind: 'action', action: explorationAction(source) ?? { ...commandAction(ev.command, ev.output, ev.exitCode, source?.item?.status, source), source } })
  } else if (ev.kind === 'fileStart') {
    for (const c of ev.changes) {
      const path = absolute(source?.cwd ?? run.cwd, c.path)
      const kind = (typeof c.kind === 'object' ? c.kind?.type : c.kind) ?? 'unknown'
      const key = snapshotKey(source, path)
      if (kind !== 'add' && !run.snapshots.has(key)) remember(run, key, await readText($, path))
    }
  } else if (ev.kind === 'files') {
    if (source?.item?.status === 'inProgress') return
    // Count source patches independently of files and ordered hunk rows.
    run.actions++
    run.patches++
    if (ev.changes.length > 1) run.queue.push({ kind: 'note', text: `Codex apply_patch ${source?.itemId ?? '(ID unreported)'}: ${ev.changes.length} files in one source patch.` })
    if (!ev.changes.length) {
      const status = source?.item?.status
      const report = `Codex patch ${status ?? 'outcome unconfirmed'}; paths unreported.\n${JSON.stringify(source?.item ?? {})}`
      run.patchRows++
      run.queue.push({ kind: 'action', action: { tool: 'Bash', source,
        input: { command: '# Codex apply_patch: paths unreported', description: `Codex patch ${status ?? 'outcome unconfirmed'}: paths unreported` },
        result: { stdout: report, stderr: '', interrupted: false }, ...(status === 'completed' ? {} : { error: report }),
      } })
    }
    for (const c of ev.changes) {
      const cwd = source?.cwd ?? run.cwd
      const path = absolute(cwd, c.path)
      const key = snapshotKey(source, path)
      const before = run.snapshots.get(key)
      const kind = (typeof c.kind === 'object' ? c.kind?.type : c.kind) ?? 'unknown'
      const move = typeof c.kind === 'object' ? c.kind?.move_path : c.move_path
      const destination = typeof move === 'string' ? absolute(cwd, move) : undefined
      const after = kind === 'delete' ? undefined : await readText($, destination ?? path)
      const stable = kind === 'delete' || after === await readText($, destination ?? path)
      const change = { ...c, path, ...(destination ? { kind: { type: kind, move_path: destination } } : {}) }
      const report = JSON.stringify(Object.fromEntries(Object.entries(source?.item ?? {}).filter(([key]) => key !== 'changes')))
      const actions = patchActions(change, before, after, c.status ?? source?.item?.status, report, stable)
      run.patchRows += actions.length
      if (actions.length > 1) run.queue.push({ kind: 'note', text: `Codex apply_patch ${source?.itemId ?? '(ID unreported)'}: ${path}, ${actions.length} ordered hunk rows for one file.` })
      for (const action of actions) {
        action.source = source
        action.patchPath = path
        run.queue.push({ kind: 'action', action })
      }
      run.snapshots.delete(key)
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
          return yield* actionStep($, e, signal, run)
        }
      }
      // A sender receipt can wake this pull through the steer ack. Returning
      // here emits its guarded card and lets the host drain its native inbox;
      // no child pull is left pending and Codex keeps the same running turn.
      if (!run.ended && cfg.nativeActions && !run.pull && displayTools.coordinator_message &&
          records.get(run.agentId)?.coordinator?.pending.some(p => p.messageId)) return yield* emit(e, [])
      if (run.ended) break
      let r: IteratorResult<ProcessSpawnChunk, ProcessSpawnResult>
      try {
        r = run.transport === 'app-server' ? await pullWatching($, run, signal) : await run.child.next()
      } catch (err) {
        if (run.timedOut) continue
        if (signal.aborted || run.killed) throw err
        // a spawn that cannot start rejects its first pull
        failure = { reason: `${run.mirror ? 'child observation lost' : 'could not start Codex'} (${errText(err)})` }
        break
      }
      if (run.timedOut) continue
      if (run.killed) throw new Error('killed')
      if (r.done) {
        run.ended = true
        for (const [id] of run.childSources ?? []) await mirrorFallback($, run, { thread_id: id }, 'child attachment unavailable')
        if (run.buffered.trim() !== '') await feedLine($, run, run.buffered.trim())
        run.buffered = ''
        continue
      }
      await feed($, run, r.value)
      await checkpointMirror($, run)
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
 * Present receipts only at output boundaries, independently of the run/answer.
 * Reindex after an inserted block: a streamed text block may resume afterwards.
 * Never insert between a tool header and its input, or feed display text back
 * into the inner generator's streamed answer, launch or handback records.
 */
async function* withCoordinatorMessages(
  $: EngineInterface,
  e: TurnStepInput,
  inner: AsyncGenerator<TurnStepChunk, TurnStepResult>,
): AsyncGenerator<TurnStepChunk, TurnStepResult> {
  const indexes = new Map<number, number>()
  let index = 0
  let originalTools = 0
  let answer = ''
  let textInserted = false
  const inserted: { at: number; name: string; input: Record<string, unknown> }[] = []
  for (;;) {
    const r = await inner.next()
    if (r.done) {
      const toolUses = [...r.value.toolUses]
      inserted.forEach((t, i) => toolUses.splice(t.at + i, 0, { name: t.name, input: t.input }))
      return { ...r.value, toolUses, ...(textInserted ? { answer } : {}), ...(inserted.length > 0 ? { stopReason: 'tool_use' as const } : {}) }
    }
    const chunk = r.value
    if (chunk.kind !== 'input') {
      const rec = records.get(e.agentId!) ?? await loadRecord($, e.agentId!)
      const coordinator = rec?.coordinator
      if (rec !== undefined && coordinator !== undefined && coordinator.pending.length > 0) {
        if (cfg.nativeActions) await registerDisplayTools($).catch(err => $.ui.log(`codex-mod: display tools not registered: ${errText(err)}`, { to: 'debug' }))
        for (const message of [...coordinator.pending]) {
          const parts: string[] = []
          for (let start = 0; start < message.text.length;) {
            let end = Math.min(start + COORDINATOR_PART_MAX, message.text.length)
            // Keep a Unicode surrogate pair together at a row boundary.
            if (end < message.text.length && /[\uD800-\uDBFF]/.test(message.text[end - 1]!) && /[\uDC00-\uDFFF]/.test(message.text[end]!)) end--
            parts.push(message.text.slice(start, end))
            start = end
          }
          if (parts.length === 0) parts.push('')
          for (let part = 0; part < parts.length; part++) {
            const text = parts.length > 1 ? `(part ${part + 1}/${parts.length})\n${parts[part]}` : parts[part]!
            const registered = cfg.nativeActions ? displayTools.coordinator_message : undefined
            const ownTools = agentTools.get(known.get(e.agentId!) ?? '')
            const tool = registered && (ownTools === undefined || ownTools.has(registered)) ? registered : undefined
            if (tool === undefined) {
              const o = message.messageId ? coordinator.outcomes?.[message.messageId] : Object.values(coordinator.outcomes ?? {}).find(o => o.sourceUuid === message.uuid)
              const echo = literalReceipt(text) + (o ? `\n${messageStatus(o)}\n` : '')
              answer += echo
              textInserted = true
              yield { kind: 'text', index: index++, text: echo }
            } else {
              const id = mintId(e)
              const input = { sourceUuid: message.sourceUuid ?? message.uuid, text }
              const o = message.messageId ? coordinator.outcomes?.[message.messageId] : Object.values(coordinator.outcomes ?? {}).find(o => o.sourceUuid === message.uuid)
              coordinatorRows.set(id, { sessionId: await sessionId($), tool, text, messageId: o?.messageId, outcome: o })
              const rows = coordinator.rows ??= {}
              rows[id] = { tool, text, sourceUuid: message.sourceUuid ?? message.uuid, messageId: o?.messageId }
              if (!holdAnswer(id, await sessionId($), e.agentId!, { tool, input, result: [{ type: 'text', text: messageStatus(o) }] })) throw new Error('invalid coordinator display answer')
              await saveRow($, id, sourceRows.get(id)!)
              yield { kind: 'tool', index, id, name: tool }
              yield { kind: 'input', index: index++, json: JSON.stringify(input) }
              inserted.push({ at: originalTools, name: tool, input })
            }
          }
          // Only mark shown after every part was handed to the host.
          coordinator.pending = coordinator.pending.filter(p => p.uuid !== message.uuid)
          await saveRecord($, e.agentId!, rec)
        }
        indexes.clear()
      }
    }
    if (chunk.kind === 'tool') originalTools++
    if (chunk.kind === 'text') answer += chunk.text
    if (chunk.kind === 'text' || chunk.kind === 'thinking' || chunk.kind === 'tool' || chunk.kind === 'input') {
      if (!indexes.has(chunk.index)) indexes.set(chunk.index, index++)
      yield { ...chunk, index: indexes.get(chunk.index)! } as TurnStepChunk
    } else {
      yield chunk.kind === 'stop' && inserted.length > 0 ? { ...chunk, stopReason: 'tool_use' } : chunk
    }
  }
}

/**
 * Ends the step with the queued messages and actions up to the last action
 * (at most maxActionsPerStep): each message a text block, each action a
 * call whose answer is stored for the `tool.call` guard.
 */
async function* actionStep($: EngineInterface, e: TurnStepInput, signal: AbortSignal, run: Run): AsyncGenerator<TurnStepChunk, TurnStepResult> {
  await loadCapabilities($)
  let hostCwd: string | undefined
  const tools = agentTools.get(run.name) ?? new Set([...NATIVE_TOOLS.filter(tool => availableTools!.has(tool) && (cfg.richRows || !RICH_TOOLS.has(tool))), ...Object.values(displayTools)])
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
      if (['Read', 'Glob', 'Grep'].includes(q.action.tool) && q.action.source?.item?.type === 'commandExecution') {
        const source = q.action.source
        const item = source.item!
        const durationUnknown = q.action.tool === 'Glob' && item.durationMs == null && (source.startedAtMs === undefined || source.completedAtMs === undefined)
        blocks.push({ text: `Codex command (cwd ${JSON.stringify(source.cwd)}):\n${item.command}${durationUnknown ? '\nDuration unreported (0 ms display sentinel).' : ''}` })
      }
      if (['WebSearch', 'WebFetch'].includes(q.action.tool) && !tools.has(q.action.tool) && q.action.source?.item && displayTools.codex_tool && tools.has(displayTools.codex_tool)) {
        const original = q.action
        q.action = { ...webFallback(original.source!.item, `${original.tool} unavailable in this agent's tools.`), tool: displayTools.codex_tool, source: original.source }
      }
      if (q.action.tool === 'WebSearch' && sourceDuration(q.action.source) === undefined) blocks.push({ text: 'Web search duration unreported (0-second display sentinel).' })
      if (q.action.tool === 'WebSearch' && !Array.isArray(q.action.result) && Array.isArray(q.action.result.results)) {
        for (const r of q.action.result.results) if (r && typeof r === 'object') r.tool_use_id = id
      }
      if (!tools.has(q.action.tool)) {
        if (['Write', 'Edit'].includes(q.action.tool) && tools.has('Bash') && q.action.source?.item) {
          const original = q.action
          const cwd = original.source!.cwd ?? run.cwd
          const change = changesOf(original.source!.item).find(c => absolute(cwd, c.path) === original.input.file_path)
          if (change) q.action = { ...patchActions({ ...change, path: String(original.input.file_path) }, undefined, undefined,
            change.status ?? original.source!.item!.status, '', true, `${original.tool} unavailable in this agent's tools.`)[0]!, source: original.source, patchPath: original.patchPath }
        }
        if (['Read', 'Glob', 'Grep'].includes(q.action.tool) && tools.has('Bash') && q.action.source?.item?.type === 'commandExecution') {
          const original = q.action
          const item = original.source!.item!
          blocks.push({ text: `${original.tool} unavailable in this agent's tools; showing the original Bash command.` })
          q.action = { ...commandAction(item.command, item.aggregatedOutput, item.exitCode, item.status, original.source), source: original.source }
          if (original.tool === 'Grep' && item.exitCode === 1) {
            delete q.action.error
            q.action.input.description = `${q.action.input.description} (no matches; exit 1)`
          }
        }
      }
      if (!tools.has(q.action.tool)) {
        const original = q.action
        const reason = `${original.tool} unavailable in this agent's tools`
        if (displayTools.codex_tool && tools.has(displayTools.codex_tool)) {
          q.action = { tool: displayTools.codex_tool,
            input: { server: 'codex', name: original.tool, arguments: original.input },
            result: [{ type: 'text', text: `${reason}\n${JSON.stringify(original.result)}` }],
            source: original.source, patchPath: original.patchPath, ...(original.error ? { error: original.error } : {}) }
        } else {
          blocks.push({ text: `${reason}; display tool unavailable\n${JSON.stringify(original.input)}\n${original.error ?? JSON.stringify(original.result)}` })
          continue
        }
      }
      if (q.action.tool === 'Bash' && typeof q.action.input.command === 'string') {
        hostCwd ??= await $.session.cwd()
        const command = displayBashCommand(q.action.input.command, hostCwd)
        if (command !== q.action.input.command) {
          const source = q.action.source
          blocks.push({ text: `Codex command (cwd ${JSON.stringify(source?.cwd ?? run.cwd)}):\n${source?.item?.command ?? q.action.input.command}` })
          // Bind the exact emitted native input before the host sees it. The
          // source command, result, failure and digest remain unchanged.
          q.action = { ...q.action, input: { ...q.action.input, command } }
        }
      }
      if (!holdAnswer(id, run.sessionId, run.agentId, q.action)) {
        blocks.push({ text: `codex-mod: output-schema rejection (${q.action.tool}); not executed\n${JSON.stringify(q.action.input)}\n${q.action.error ?? JSON.stringify(q.action.result)}` })
        continue
      }
      if (q.action.tool === displayTools.codex_plan) planCards.set(id, JSON.parse(JSON.stringify(q.action.input)) as PlanInput)
      await saveRow($, id, sourceRows.get(id)!, planCards.get(id))
      if (q.action.tool === displayTools.codex_question && run.control) {
        const data: any = q.action.source?.data
        if (data?.status === 'pending') questionRows.set(id, { session: run.sessionId, agent: run.agentId, control: run.control, question: data, selected: {} })
      }
      if (q.action.mirror) { const m = mirrors.get(q.action.mirror); if (m) { m.displayToolId = id; await saveMirror($, m) } }
      run.rows[id] = q.action.source ?? null
      blocks.push({ tool: q.action.tool, id, input: q.action.input })
    }
  }
  if (!blocks.some(b => 'tool' in b)) {
    // A text fallback must not end a still-running agent before its handback.
    run.queue.unshift(...blocks.map((b): Queued => 'thinking' in b ? { kind: 'thinking', text: b.thinking } : { kind: 'interim', text: 'text' in b ? b.text : '' }))
    return yield* pump($, e, signal, run)
  }
  run.actionSteps++
  await checkpointMirror($, run)
  const rec = records.get(run.agentId)
  if (rec !== undefined) {
    rec.wire = { records: run.ledger.records, rows: run.rows }
    await saveRecord($, run.agentId, rec)
  }
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
  // An unacknowledged submission may already have reached Codex. Never replay it.
  if (run.mirror && run.pendingSteers.length) {
    run.queue.push({ kind: 'note', text: '↪ child message outcome unknown; no automatic retry or relaunch' }); run.pendingSteers = []
  }
  if (run.pendingSteers.length > 0) {
    for (const f of run.pendingSteers) await recordOutcome($, run.agentId, { messageId: f.messageId ?? f.uuid ?? steerFileId(f), sourceUuid: f.uuid,
      status: 'unknown', receivedAt: Date.now(), reason: 'runner ended before acknowledgment; no retry' })
    run.pendingSteers = []
    run.queue.push({ kind: 'note', text: '↪ message outcome unknown; no automatic retry or relaunch' })
  }
  let reason = failure?.reason
  let detail = failure?.detail ?? ''
  let processEnded = false
  if (failure === undefined) {
    let ended: ProcessSpawnResult | undefined
    try {
      ended = await run.child.result
      processEnded = ended !== undefined
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
  const evidence = permissionEvidence([reason, detail, tail, ...run.errors].filter(Boolean).join('\n'), run.execution)
  if (evidence) detail = [detail, evidence].filter(Boolean).join('\n')
  if (reason !== undefined && preflight) detail = [detail, `(launch check: ${preflight})`].filter(Boolean).join('\n')
  const record = records.get(run.agentId)
  if (run.history?.archive && !run.mirror && run.ended && processEnded && !run.killed && !signal.aborted &&
      run.history.observed && !run.history.ambiguous && run.thread && run.history.thread === run.thread && record?.thread === run.thread && !record.mirror && !record.historyAmbiguous &&
      !historyInUse(run.thread, run.history.home)) {
    if (await sessionHistory($, run.history.codex, run.history.home, 'archive', run.thread)) {
      record.historyArchived = true
      await saveRecord($, run.agentId, record)
    } else run.queue.push({ kind: 'note', text: '↪ session archive failed; result preserved, no automatic retry' })
  }
  const atCapacity = reason !== undefined && [reason, detail, ...run.errors, run.fatal ?? '', tail].some(s => s.includes('Selected model is at capacity'))
  const capacityBeforeWork = run.actions === 0 && run.texts.length === 0 && !run.ledger.records.some(r => r.item)
  if (record && run.thread && atCapacity && run.transport === 'exec' && !run.execTotal && run.execBaseline && capacityBeforeWork) {
    record.threadUsage = { thread: run.thread, total: run.execBaseline, valid: true }
    await saveRecord($, run.agentId, record)
  }
  if (atCapacity && run.transport === 'exec' && !run.execTotal && !capacityBeforeWork) run.usagePartial = true
  if (record && run.thread && reason !== undefined && !atCapacity) {
    // Failed/interrupted exec can incur unreported calls after its last total.
    // Do not attribute those tokens to a later successful follow-up.
    if (run.transport === 'exec') record.threadUsage = { thread: run.thread, total: run.execTotal ?? record.threadUsage?.total ?? zeroUsage(), valid: false }
    run.usagePartial = true
    await saveRecord($, run.agentId, record)
  }
  if (atCapacity && !run.mirror && !run.capacityRetried && !signal.aborted && !run.killed && record && run.thread && run.rawTask !== undefined) {
    const next = capacityFallback(catalog ?? undefined, record.fallbackModels ?? cfg.capacityFallback, run.prof)
    if (next) {
      const note = `${run.prof.model} at capacity; continued on ${next.model}`
      const previous = cfg.footer === 'off' ? undefined : run.usagePartial ? '↪ capacity attempt usage: partial/unknown'
        : run.usage ? `↪ capacity attempt usage: ${run.usage.input} input (${run.usage.cached} cached), ${run.usage.output} output tokens` : undefined
      for (const f of run.followUps) if (!followUpsOf(record).some(sameFollowUp(f))) (record.followUps ??= []).push(f)
      const carry = [run.carry, previous].filter(Boolean).join('\n\n')
      const resumed = startRun($, e, signal, cfg, run.name, record, run.rawTask, run.handback, run.messageCount!, carry || undefined, run.delivery,
        { profile: next, key: record.launchKey!, note })
      if (streamed !== undefined) return yield* prefixed(streamed, resumed)
      return yield* resumed
    }
    run.configNote = [run.configNote, 'capacity fallback unavailable: no different model validated in models_cache.json'].filter(Boolean).join('; ')
  }
  if (run.mirror) for (const message of run.mirror.messages ?? []) if (message.status === 'submitted') {
    message.status = 'unknown'
    run.queue.push({ kind: 'note', text: `↪ child message ${message.id}: outcome unknown; no automatic retry or relaunch` })
  }
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
    const queued = [...followUpsOf(rec)]
    for (const f of run.followUps) if (!queued.some(sameFollowUp(f))) queued.push(f)
    rec.followUps = queued.length > 0 ? queued : undefined
  }
  if (run.transport === 'exec' && run.observedChildren?.size && !run.treeUsage) {
    const direct = run.usage ?? zeroUsage()
    run.treeUsage = { direct, tree: direct, children: run.observedChildren.size, missing: run.observedChildren.size + (run.usagePartial ? 1 : 0), active: 0 }
  }
  const foot = footer({ ...run.prof, agent: run.name, actions: run.actions, usage: run.usage, thread: run.thread, transport: run.transportNote, usagePartial: run.usagePartial, treeUsage: run.treeUsage, steers: run.steers, patches: run.patches, patchRows: run.patchRows, configNote: run.configNote }, cfg.footer)
  const shown = [run.carry, body].filter(Boolean).join('\n\n')
  run.carry = undefined
  // Text mode ends the turn with this step, so a follow-up folded in meanwhile
  // runs now, in the same step, after this answer.
  if (run.mirror) {
    if (!['aborted', 'stopping'].includes(run.mirror.state)) run.mirror.state = reason ? 'failed' : 'completed'
    await saveMirror($, run.mirror)
  }
  if (!run.mirror && !run.handback && rec !== undefined && rec.followUps !== undefined && rec.followUps.length > 0) {
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
  const blocks: Block[] = handback ? [{ tool: HANDBACK_TOOL, id: `${HANDBACK_ID_PREFIX}${e.turnId.replace(/[^A-Za-z0-9]/g, '').slice(-12)}_${e.index}_${++seq}`, input: { message } }] : message === '' ? [] : [{ text: message }]
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
