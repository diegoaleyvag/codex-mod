import type { Register } from 'claude-code'

// Disposable main-loop probe: the spawn hook refuses before creating any
// agent. Neither the coordinator nor a worker can reach a provider request.
export const register: Register = (on) => {
  let emitted = false
  on('session.start', async ($, e, next) => {
    await $.agent.register({ name: 'codex', description: 'Offline field probe; always refuses spawn', prompt: 'Never call a model.', model: 'haiku', effort: 'low', background: true })
    return next(e)
  })
  on('tool.call', async ($, e, next) => {
    if (e.tool === 'Agent') await log($, 'tool-call', e)
    return next(e)
  })
  on('agent.spawn', async ($, e) => {
    await log($, 'agent-spawn', e)
    return { deny: 'Offline Batch 7 field probe: no agent created' }
  }).catch(() => ({ deny: 'Offline field probe failed closed' }))
  on('turn.step', async function* ($, e) {
    if (!emitted && !e.agentId) {
      emitted = true
      const input = { subagent_type: 'codex-mod:codex', description: 'Offline effort probe', prompt: 'Do not launch', effort: 'high' }
      yield { kind: 'tool', index: 0, id: 'toolu_batch7probe_1', name: 'Agent' }
      yield { kind: 'input', index: 0, json: JSON.stringify(input) }
      yield { kind: 'stop', stopReason: 'tool_use', usage: null }
      return { turnId: e.turnId, index: e.index, answer: '', toolUses: [{ name: 'Agent', input }], stopReason: 'tool_use', usage: null }
    }
    yield { kind: 'text', index: 0, text: 'BATCH7 FIELD PROBE DONE' }
    yield { kind: 'stop', stopReason: 'end_turn', usage: null }
    return { turnId: e.turnId, index: e.index, answer: 'BATCH7 FIELD PROBE DONE', toolUses: [], stopReason: 'end_turn', usage: null }
  }).catch(async function* (_$, e) {
    yield { kind: 'stop', stopReason: 'end_turn', usage: null }
    return { turnId: e.turnId, index: e.index, answer: 'Probe failed closed', toolUses: [], stopReason: 'end_turn', usage: null }
  })
}

async function log($: any, phase: string, e: any): Promise<void> {
  const data = { keys: Object.keys(e).sort(), toolUseId: e.tool_use_id, effort: e.effort ?? 'absent',
    model: e.model ?? 'absent', parentModel: e.parentModel ?? 'absent', provider: e.provider ?? 'absent' }
  await $.fs.write(`/tmp/codex-mod-batch7-probe/${phase}.json`, JSON.stringify(data))
  $.ui.log(`batch7-probe: ${phase} ${JSON.stringify(data)}`, { to: 'debug' })
}
