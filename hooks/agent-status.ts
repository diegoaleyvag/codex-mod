import type { SourceRecord } from './codex.ts'

const ACTIONS = new Set(['commandExecution', 'fileChange', 'webSearch', 'mcpToolCall', 'dynamicToolCall',
  'collabAgentToolCall', 'subAgentActivity', 'imageView', 'imageGeneration'])
const completed = (event: string) => ['item.completed', 'item/completed'].includes(event)

/** Bound serialized UTF-8 bytes too, including control-character escaping. */
function clipped(text: string, budget: number) {
  let used = 0, value = ''
  for (const char of text) {
    const code = char.codePointAt(0)!
    const bytes = code < 128 ? JSON.stringify(char).length - 2 : code >= 0xd800 && code <= 0xdfff ? 6 : code < 2048 ? 2 : code < 65536 ? 3 : 4
    if (used + bytes > budget) break
    value += char
    used += bytes
  }
  return { text: value, clipped: value.length !== text.length }
}

type StatusRun = {
  ledger: { records: SourceRecord[] }
  startedAtMs?: number
  lastSourceObservedAtMs?: number
  thread?: string
  turnId?: string
  cwd: string
  prof: { model: string; effort: string }
  transport: string
  execution?: { sandbox: string; networkAccess: boolean; approvalMode: string }
}

/** Pure projection: never reads results, arguments, prompts or reasoning. */
export function agentStatus(run: StatusRun, observedAt: number | null, pending: { approvals: number; questions: number }, describe?: (command: string, source: SourceRecord) => string) {
  let sourceState = 'unknown'
  let lastAction: Record<string, unknown> | null = null
  const active = new Map<string, Record<string, unknown>>()
  let activeUnknown = false
  let publicUpdate: Record<string, unknown> | null = null
  const finished = new Set<string>()
  let countUnknown = false
  for (const record of run.ledger.records) {
    if (record.threadId !== run.thread || record.turnId !== run.turnId) continue
    if (['turn.started', 'turn/started', 'codexmod.turn'].includes(record.event)) sourceState = 'inProgress'
    if (['turn.completed', 'turn/completed', 'turn.failed'].includes(record.event)) {
      const status = record.data?.turn?.status ?? record.data?.status
      sourceState = ['completed', 'failed', 'interrupted'].includes(status) ? status : record.event === 'turn.failed' ? 'failed' : record.event === 'turn.completed' ? 'completed' : 'unknown'
      active.clear()
      activeUnknown = false
    }
    const item = record.item
    if (!item) continue
    if (ACTIONS.has(item.type)) {
      if (completed(record.event)) {
        if (record.itemId) finished.add(JSON.stringify([record.threadId, record.turnId, record.itemId]))
        else countUnknown = true
      }
      lastAction = { type: item.type, status: ['inProgress', 'completed', 'failed', 'declined', 'interrupted'].includes(item.status) ? item.status : null,
        lifecycle: completed(record.event) ? 'completed' : ['item.started', 'item/started'].includes(record.event) ? 'started' : 'updated',
        ...(item.type === 'commandExecution' && typeof item.command === 'string' ? { command: clipped(item.command, 700),
          ...(describe ? { label: clipped(describe(item.command, record), 240) } : {}) } : {}) }
      if (record.itemId) {
        const key = JSON.stringify([record.threadId, record.turnId, record.itemId])
        if (completed(record.event) || ['completed', 'failed', 'declined', 'interrupted'].includes(item.status)) active.delete(key)
        else if (['item.started', 'item/started'].includes(record.event) || item.status === 'inProgress' || active.has(key)) {
          active.delete(key)
          active.set(key, lastAction)
        }
      } else if (!completed(record.event)) activeUnknown = true
    }
    if (item.type === 'agentMessage' && ['commentary', 'partial_answer'].includes(item.phase) && typeof item.text === 'string') {
      publicUpdate = { kind: 'commentary', ...clipped(item.text, 700) }
    } else if (item.type === 'plan' && typeof item.text === 'string') {
      publicUpdate = { kind: 'plan', ...clipped(item.text, 700) }
    } else if (['todo_list', 'plan_update'].includes(item.type)) {
      const steps = item.type === 'todo_list' ? item.items : item.steps
      if (Array.isArray(steps)) {
        // Stop collecting before joining: a source plan can itself be enormous.
        const lines: string[] = []
        for (const step of steps.slice(0, 4)) {
          const text = item.type === 'todo_list' ? step?.text : step?.step
          if (typeof text === 'string') lines.push(clipped(text, 180).text)
        }
        const text = clipped(lines.join('\n'), 700)
        publicUpdate = { kind: 'plan', ...text, clipped: text.clipped || steps.length > 4 || steps.some((s: any) => typeof (s?.text ?? s?.step) === 'string' && clipped(s.text ?? s.step, 180).clipped) }
      }
    }
  }
  return { available: true, observedAt,
    launchedAt: run.startedAtMs ?? null,
    elapsedMs: observedAt !== null && run.startedAtMs !== undefined ? Math.max(0, observedAt - run.startedAtMs) : null,
    lastSourceObservedAt: run.lastSourceObservedAtMs ?? null,
    sourceState, currentAction: [...active.values()].at(-1) ?? null, activeActions: activeUnknown ? null : active.size, lastAction, publicUpdate,
    completedActions: countUnknown ? null : finished.size, pending,
    execution: { cwd: clipped(run.cwd, 400), model: clipped(run.prof.model, 100), effort: clipped(run.prof.effort, 20),
      sandbox: run.execution?.sandbox ?? null, networkAccess: run.execution?.networkAccess ?? null,
      approvalMode: run.execution?.approvalMode ?? null, transport: run.transport } }
}
