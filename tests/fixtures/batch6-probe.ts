import type { Register } from 'claude-code'

// Disposable MAIN-session probe: no subagent, executor or provider call.
export const register: Register = (on) => {
  let done = false
  const questions = [{ question: 'Which mode?', header: 'Mode', options: [{ label: 'Small', description: 'Bounded' }, { label: 'Full', description: 'Complete' }], multiSelect: false }]
  const answers = { 'Which mode?': 'Small' }
  const candidates: any[] = [
    ['Read', { file_path: '/tmp/codex-mod-batch6-probe/original.png' }, { type: 'image', file: { base64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNQaDjwHwAEhAJgikCezQAAAABJRU5ErkJggg==', type: 'image/png', originalSize: 70 } }],
    ['AskUserQuestion', { questions, answers }, { questions, answers }],
    ['ReportFindings', { findings: [{ file: 'probe.ts', summary: 'Reported example', failure_scenario: 'Explicit fixture' }] }, { count: 1, findings: [{ file: 'probe.ts', summary: 'Reported example', failure_scenario: 'Explicit fixture' }] }],
  ]
  on('tool.call', async ($, e, next) => {
    if (!e.tool_use_id?.startsWith('toolu_batch6probe_')) return next(e)
    const index = Number(e.tool_use_id.slice('toolu_batch6probe_'.length))
    await $.fs.write('/tmp/codex-mod-batch6-probe/guard-' + index + '.json', JSON.stringify({ tool: e.tool, result: candidates[index]?.[2] }))
    return { result: candidates[index]?.[2] } as any
  })
  on('tool.check', (_$, e, next) => e.tool_use_id?.startsWith('toolu_batch6probe_') ? { decision: 'deny', reason: 'Display probe must never execute' } : next(e))
  on('turn.step', async function* ($, e) {
    const toolUses: any[] = []
    if (!done) {
      done = true
      const names = (await $.tool.list()).map(t => t.name)
      await $.fs.write('/tmp/codex-mod-batch6-probe/tools.json', JSON.stringify(names))
      for (let i = 0; i < candidates.length; i++) {
        const [name, input] = candidates[i]
        if (!names.includes(name)) continue
        yield { kind: 'tool', index: i, id: 'toolu_batch6probe_' + i, name }
        yield { kind: 'input', index: i, json: JSON.stringify(input) }
        toolUses.push({ name, input })
      }
    } else {
      await $.fs.write('/tmp/codex-mod-batch6-probe/messages.json', JSON.stringify(await $.session.messages({ as: 'api' })))
      yield { kind: 'text', index: 0, text: 'BATCH6 PROBE DONE' }
    }
    const stopReason = toolUses.length ? 'tool_use' : 'end_turn'
    yield { kind: 'stop', stopReason, usage: null }
    return { turnId: e.turnId, index: e.index, answer: toolUses.length ? '' : 'BATCH6 PROBE DONE', toolUses, stopReason, usage: null }
  })
}
