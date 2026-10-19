// Original protocol-derived fixtures: no source child is actually launched.
export const CHILD = '11111111-2222-4333-8444-555555555555'
export const THREAD = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
const call = (id, tool, extra = {}) => ({ type: 'collabAgentToolCall', id, tool, status: 'completed',
  senderThreadId: THREAD, receiverThreadIds: [CHILD], prompt: null, model: null, reasoningEffort: null,
  agentsStates: { [CHILD]: { status: 'running', message: null } }, ...extra })
const activity = (id, kind) => ({ type: 'subAgentActivity', id, kind, agentThreadId: CHILD,
  agentPath: '/root/check', model: 'gpt-6.1-sol', reasoningEffort: 'medium' })
const plan = (explanation, steps) => ({ explanation, plan: steps.map(([step, status]) => ({ step, status })) })
export default [
  { plan: plan('Inspect and verify\nKeep the main list unchanged.', [['Inspect', 'pending'], ['Test', 'inProgress'], ['Test', 'pending']]) },
  { item: call('spawn', 'spawnAgent', { prompt: 'Inspect tests.\nReport full findings.', model: 'gpt-6.1-sol', reasoningEffort: 'medium' }) },
  { item: activity('started', 'started') },
  { item: call('send', 'sendInput', { prompt: 'Check the reducer boundary.\nLiteral <tag> & Unicode café.', agentsStates: { [CHILD]: { status: 'running', message: 'Accepted by Codex' } } }) },
  { item: activity('interacted', 'interacted') },
  { item: call('wait-same', 'wait', { agentsStates: { [CHILD]: { status: 'running', message: 'Accepted by Codex' } } }) },
  { plan: plan('Progress', [['Inspect', 'completed'], ['Test', 'completed'], ['Test', 'inProgress']]) },
  { plan: plan('Reordered', [['Test', 'completed'], ['Inspect', 'completed'], ['Test', 'inProgress']]) },
  { plan: plan('Renamed', [['Verify', 'pending'], ['Inspect', 'completed']]) },
  { plan: plan('All done', [['Verify', 'completed'], ['Inspect', 'completed']]) },
  { plan: plan('Cleared', []) },
  { item: call('spawn-failed', 'spawnAgent', { status: 'failed', receiverThreadIds: [], prompt: 'Declined child', agentsStates: {}, error: { message: 'Capacity exhausted' } }) },
  { item: call('spawn-declined', 'spawnAgent', { status: 'declined', receiverThreadIds: [], prompt: 'No permission', agentsStates: {} }) },
  { item: call('resume', 'resumeAgent', { agentsStates: { [CHILD]: { status: 'running', message: 'Resumed existing source child' } } }) },
  { item: call('list', 'listAgents') },
  { item: call('wait-completed', 'wait', { durationMs: 1200, agentsStates: { [CHILD]: { status: 'completed', message: 'Exact child report\nAll checks passed.' } } }) },
  { item: activity('completed', 'completed') },
  { item: call('close', 'closeAgent', { agentsStates: { [CHILD]: { status: 'shutdown', message: null } } }) },
  { item: call('interrupt', 'interruptAgent', { agentsStates: { [CHILD]: { status: 'interrupted', message: 'Interrupted by Codex' } } }) },
  { item: activity('interrupted', 'interrupted') },
  { item: call('close-failed', 'closeAgent', { status: 'failed', error: { message: 'Child not found' }, agentsStates: { [CHILD]: { status: 'notFound', message: 'Child not found' } } }) },
  { item: call('send-failed', 'sendMessage', { status: 'failed', prompt: 'Full failed message', error: { message: 'Rejected' } }) },
  { item: call('followup', 'followupTask', { prompt: 'Follow-up body\nPreserve me.' }) },
  { item: call('send-missing', 'sendInput') },
  { item: call('multi-close', 'closeAgent', { receiverThreadIds: [CHILD, 'child-two'] }) },
  { item: call('unknown-spawn', 'spawnAgent', { status: 'completed', agentsStates: { [CHILD]: { message: 'State unreported' } }, prompt: 'Observe unknown child state' }) },
  { item: { type: 'agentMessage', id: 'final', text: 'Batch 5 complete.', phase: 'final_answer' } },
]
