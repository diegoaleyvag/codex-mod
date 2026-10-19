import type { Action } from './codex.ts'

type Status = 'pending' | 'in_progress' | 'completed'
export type PlanInput = { steps: { step: string; status: Status }[]; explanation?: string }
type PlanStep = PlanInput['steps'][number] & { id: string }
export type DisplayState = {
  plans: Record<string, { revision: number; counter: number; steps: PlanStep[]; explanation?: string; surface?: string }>
  children: Record<string, ChildIdentity>
}
// Source identity only. A display ID is never a host task or an attachable mirror.
export type ChildIdentity = {
  claudeSessionId: string; parentCodexThreadId: string; codexThreadId: string; parentClaudeAgentId: string; displayId: string
  sourceTurnId?: string; path?: string; model?: string; effort?: string; status?: string; message?: string
  sourceSpawnTurnId?: string; sourceSpawnItemId?: string
  interactionPending?: boolean
}
export type Row = { kind: 'action'; action: Action; display?: 'codex_tool' | 'codex_plan' } | { kind: 'note'; text: string }
type Context = { session: string; agent: string; thread: string; turn?: string; rich: boolean; tools: Set<string> }
export const emptyDisplayState = (): DisplayState => ({ plans: {}, children: {} })
const short = (s: string, n = 120) => s.replace(/\s+/g, ' ').trim().slice(0, n)
const textResult = (text: string) => [{ type: 'text' as const, text }]
const component = (s: string) => encodeURIComponent(s)
export const displayChildId = (session: string, child: string) => `codex-display-${component(session)}-${component(child)}`
export const planText = (input: PlanInput) => [input.explanation, 'Codex plan (display only):',
  ...input.steps.map(s => `${s.status === 'completed' ? '[x]' : s.status === 'in_progress' ? '[-]' : '[ ]'} ${s.step}`),
  ...(input.steps.length ? [] : ['(empty checklist)'])].filter(s => s !== undefined).join('\n')

/** Snapshots and IDs belong only to this agent's source thread, including after resume. */
export function planRows(input: PlanInput, state: DisplayState, ctx: Context): Row[] {
  const key = ctx.thread
  const old = Object.prototype.hasOwnProperty.call(state.plans, key) ? state.plans[key]! : { revision: 0, counter: 0, steps: [] }
  const surface = ctx.rich && ctx.tools.has('TodoWrite') ? 'todo' : ctx.rich && ctx.tools.has('TaskCreate') && ctx.tools.has('TaskUpdate') ? 'tasks' : 'display'
  if (old.revision && old.surface === surface && old.explanation === input.explanation && JSON.stringify(old.steps.map(({ step, status }) => ({ step, status }))) === JSON.stringify(input.steps)) return []
  const revision = old.revision + 1
  let counter = old.counter
  const used = new Set<number>()
  const matches = input.steps.map(s => {
    if (surface === 'tasks' && old.surface !== 'tasks') return -1
    const index = old.steps.findIndex((p, i) => !used.has(i) && p.step === s.step)
    if (index >= 0) used.add(index)
    return index
  })
  // Crossing occurrences have ambiguous identity after reordering. Remove/create
  // them explicitly rather than transferring a different step's status or ID.
  const crossed = new Set<number>()
  for (let i = 0; i < matches.length; i++) for (let j = i + 1; j < matches.length; j++) {
    if (matches[i]! >= 0 && matches[j]! >= 0 && matches[i]! > matches[j]!) { crossed.add(i); crossed.add(j) }
  }
  const steps = input.steps.map((s, i) => ({ ...s, id: matches[i]! >= 0 && !crossed.has(i)
    ? old.steps[matches[i]!]!.id : `codex-plan-${component(ctx.agent + ':' + ctx.thread)}-${revision}-${++counter}` }))
  Object.defineProperty(state.plans, key, { value: { revision, counter, steps, surface, ...(input.explanation !== undefined ? { explanation: input.explanation } : {}) }, enumerable: true, writable: true, configurable: true })
  if (ctx.rich && ctx.tools.has('TodoWrite')) {
    const todos = (ss: PlanStep[]) => ss.map(s => ({ content: s.step, status: s.status, activeForm: s.step }))
    return [{ kind: 'action', action: { tool: 'TodoWrite', input: { todos: todos(steps) }, result: { oldTodos: todos(old.steps), newTodos: todos(steps) } } }]
  }
  if (ctx.rich && ctx.tools.has('TaskCreate') && ctx.tools.has('TaskUpdate')) {
    const rows: Row[] = [{ kind: 'note', text: 'Codex plan tasks are display-only IDs; no host task records are created.\n' + planText(input) }]
    const update = (id: string, changes: Record<string, string>, from: Status) => rows.push({ kind: 'action', action: {
      tool: 'TaskUpdate', input: { taskId: id, ...changes }, result: { success: true, taskId: id, updatedFields: Object.keys(changes),
        ...(changes.status && changes.status !== from ? { statusChange: { from, to: changes.status } } : {}) } } })
    for (const p of old.surface === 'tasks' ? old.steps : []) if (!steps.some(s => s.id === p.id)) update(p.id, { status: 'deleted' }, p.status)
    for (const s of steps) {
      const previous = old.steps.find(p => p.id === s.id)
      const description = [s.step, input.explanation].filter(v => v !== undefined).join('\n')
      if (!previous) {
        const subject = 'Codex plan: ' + s.step
        rows.push({ kind: 'action', action: { tool: 'TaskCreate', input: { subject, description, activeForm: s.step,
          metadata: { codexPlan: true, sourceThread: ctx.thread, sourceRevision: revision } }, result: { task: { id: s.id, subject } } } })
        if (s.status !== 'pending') update(s.id, { status: s.status }, 'pending')
      } else {
        const changes: Record<string, string> = {}
        if (previous.status !== s.status) changes.status = s.status
        if (old.explanation !== input.explanation) changes.description = description
        if (Object.keys(changes).length) update(s.id, changes, previous.status)
      }
    }
    return rows
  }
  return [{ kind: 'note', text: !ctx.rich ? 'Native plan rows disabled (richRows:false); showing codex_plan.' : 'TodoWrite or paired TaskCreate/TaskUpdate unavailable in this agent; showing codex_plan.' },
    { kind: 'action', display: 'codex_plan', action: { tool: 'codex_plan', input, result: textResult(planText(input)) } }]
}

const failed = (item: any) => ['failed', 'declined'].includes(item.status)
const toolName = (item: any) => String(item.tool ?? '').replace(/_/g, '').toLowerCase()
const statesOf = (item: any) => item.agentsStates ?? item.agents_states ?? {}
const receiversOf = (item: any): string[] => {
  const ids = item.receiverThreadIds ?? item.receiver_thread_ids ?? (item.agentThreadId ? [item.agentThreadId] : [])
  return [...new Set<string>([...(Array.isArray(ids) ? ids.filter(id => typeof id === 'string' && id) : []), ...Object.keys(statesOf(item))])]
}
const sourceFields = (item: any) => Object.fromEntries(['receiverThreadIds', 'receiver_thread_ids', 'prompt', 'message', 'agentsStates', 'agents_states', 'status', 'result', 'error', 'model', 'reasoningEffort'].filter(k => item[k] !== undefined).map(k => [k, item[k]]))
function fallback(item: any, reason: string): Row {
  const report = `${reason}\nCodex ${item.tool ?? item.kind}:\n${JSON.stringify(sourceFields(item), null, 2)}`
  return { kind: 'action', display: 'codex_tool', action: { tool: 'codex_tool', input: { server: 'codex', name: item.tool ?? item.kind, arguments: sourceFields(item) },
    result: textResult(report), ...(failed(item) ? { error: report } : {}) } }
}

/** Completed operation rows never launch, message or stop a host agent. */
export function childRows(item: any, state: DisplayState, ctx: Context): Row[] {
  const ids = receiversOf(item)
  const states = statesOf(item)
  const tool = toolName(item)
  const transitions: Row[] = []
  for (const id of ids) {
    const key = JSON.stringify([ctx.thread, id])
    const previous = state.children[key]
    const source = states[id] ?? {}
    const activityStatus = ({ started: 'running', interrupted: 'interrupted', completed: 'completed' } as Record<string, string>)[item.kind]
    const status = source.status ?? activityStatus
    const child: ChildIdentity = { ...previous, claudeSessionId: previous?.claudeSessionId ?? ctx.session, parentCodexThreadId: ctx.thread, codexThreadId: id, parentClaudeAgentId: ctx.agent,
      displayId: previous?.displayId ?? displayChildId(ctx.session, id), ...(ctx.turn ? { sourceTurnId: ctx.turn } : {}) }
    if (tool === 'spawnagent' && !failed(item)) {
      if (ctx.turn && !child.sourceSpawnTurnId) child.sourceSpawnTurnId = ctx.turn
      if (typeof item.id === 'string' && !child.sourceSpawnItemId) child.sourceSpawnItemId = item.id
    }
    for (const [key, value] of Object.entries({ path: item.agentPath, model: source.model ?? item.model,
      effort: source.reasoningEffort ?? item.reasoningEffort ?? item.reasoning_effort, status, message: source.message })) {
      if (typeof value === 'string') (child as any)[key] = value
    }
    // A failed spawn has no successfully created child identity.
    if (tool === 'spawnagent' && failed(item)) continue
    state.children[key] = child
    if (['sendinput', 'sendmessage', 'followuptask'].includes(tool) && item.status === 'completed') child.interactionPending = true
    if (status && (previous?.status !== status || previous?.message !== child.message)) transitions.push({ kind: 'note',
      text: `↪ Codex child ${id}${child.path ? ` (${child.path})` : ''}: ${status}${typeof item.durationMs === 'number' ? ` after ${item.durationMs} ms` : ''}${child.model ? `, model ${child.model}` : ''}${child.effort ? `, effort ${child.effort}` : ''}${child.message ? `\n${child.message}` : ''}` })
  }
  if (item.type === 'subAgentActivity' || item.type === 'sub_agent_activity') {
    if (item.kind === 'interacted' && ids.some(id => state.children[JSON.stringify([ctx.thread, id])]?.interactionPending)) {
      for (const id of ids) state.children[JSON.stringify([ctx.thread, id])].interactionPending = false
      return transitions
    }
    if (item.kind === 'interacted' && !transitions.length) return [{ kind: 'note', text: `↪ Codex child ${ids.join(', ')} interacted${item.model ? `, model ${item.model}` : ''}${item.reasoningEffort ? `, effort ${item.reasoningEffort}` : ''}` }]
    return transitions
  }
  if (tool === 'wait' || tool === 'waitagent') return transitions
  const displayId = (id: string) => state.children[JSON.stringify([ctx.thread, id])]?.displayId ?? displayChildId(ctx.session, id)
  if (tool === 'spawnagent' && ctx.rich && ctx.tools.has('Agent')) {
    const prompt = typeof item.prompt === 'string' ? item.prompt : ''
    const input = { description: short('Codex spawn: ' + prompt, 60), prompt, subagent_type: 'codex-mod:codex' }
    if (failed(item)) return [{ kind: 'action', action: { tool: 'Agent', input, result: {}, error: `Codex spawn ${item.status}: ${JSON.stringify(item)}` } }]
    if (item.status !== 'completed' || !ids.length || typeof item.prompt !== 'string') return [fallback(item, 'Spawn completion, child ID or actual prompt unreported.')]
    const report = ids.map(id => `${id}: ${states[id]?.status ?? 'unknown'}${states[id]?.message ? `\n${states[id].message}` : ''}`).join('; ')
    const model = item.model ?? states[ids[0]!]?.model
    const effort = item.reasoningEffort ?? item.reasoning_effort
    return [{ kind: 'action', action: { tool: 'Agent', input, result: {
      agentId: displayId(ids[0]!), agentType: 'codex-mod:codex', status: 'completed', prompt, canContinueAgent: false,
      content: textResult(`Codex spawn returned; child ${report}.${typeof model === 'string' ? ` Model ${model}.` : ''}${typeof effort === 'string' ? ` Effort ${effort}.` : ''} Display-only host operation: zero Claude tools, tokens and duration; Codex child usage and duration unreported. Child transcript unavailable; no host child task exists.`),
      ...(typeof model === 'string' ? { resolvedModel: model } : {}), totalToolUseCount: 0, totalDurationMs: 0, totalTokens: 0,
      usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: null, cache_read_input_tokens: null, server_tool_use: null, service_tier: null, cache_creation: null },
    } } }]
  }
  if (ctx.rich && ids.length === 1 && ['sendinput', 'sendmessage', 'followuptask'].includes(tool) && ctx.tools.has('SendMessage')) {
    const body = item.prompt ?? item.message
    if (typeof body !== 'string' || !body) return [fallback(item, 'Actual message body unreported.')]
    // The probed host mapper accepts this source acknowledgement object, but
    // rejects null despite its declared unknown result. Never add delivery flags.
    if (item.status !== 'completed' && !failed(item)) return [fallback(item, 'Message acknowledgement unreported.')]
    return [{ kind: 'action', action: { tool: 'SendMessage', input: { to: { agentId: displayId(ids[0]!) }, message: body, summary: short(body) },
      result: { status: item.status, agentsStates: states }, ...(failed(item) ? { error: `Codex ${item.tool} ${item.status}: ${JSON.stringify(item)}` } : {}) } }]
  }
  if (ctx.rich && ids.length === 1 && ['closeagent', 'interruptagent'].includes(tool) && ctx.tools.has('TaskStop')) {
    if (item.status !== 'completed' && !failed(item)) return [fallback(item, 'Close/interrupt outcome unreported.')]
    const task_id = displayId(ids[0]!)
    return [{ kind: 'action', action: { tool: 'TaskStop', input: { task_id }, result: { task_id, task_type: 'codex',
      message: `Codex ${tool === 'closeagent' ? 'closed' : 'interrupted'} child ${ids[0]}; display only.\n${JSON.stringify(sourceFields(item))}` },
      ...(failed(item) ? { error: `Codex ${item.tool} ${item.status}: ${JSON.stringify(item)}` } : {}) } }]
  }
  return [fallback(item, !ctx.rich ? 'richRows disabled.' : ['resumeagent', 'listagents'].includes(tool) ? 'No equivalent host child lifecycle tool.' : 'Native child operation unavailable or target identity is ambiguous.')]
}
