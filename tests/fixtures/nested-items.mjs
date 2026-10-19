export const PARENT = '11111111-1111-4111-8111-111111111111'
export const CHILD = '22222222-2222-4222-8222-222222222222'
export const PARENT_TURN = '33333333-3333-4333-8333-333333333333'
export const CHILD_TURN = '44444444-4444-4444-8444-444444444444'
export const nestedCommand = { type: 'commandExecution', id: 'child-command', command: 'printf child', aggregatedOutput: 'child', exitCode: 0, status: 'completed' }
export const nestedFile = { type: 'fileChange', id: 'child-file', status: 'completed', changes: [
  { path: 'nested-child.txt', kind: { type: 'add' }, diff: '*** Begin Patch\n*** Add File: nested-child.txt\n+child\n*** End Patch' },
] }
export const nestedActivity = { type: 'subAgentActivity', id: 'spawn-1', kind: 'started', agentThreadId: CHILD,
  agentPath: '/root/check', model: 'gpt-6.1-sol', reasoningEffort: 'medium' }
export const nestedUsage = (inputTokens, cachedInputTokens, outputTokens) => {
  const total = { inputTokens, cachedInputTokens, outputTokens, reasoningOutputTokens: 20, cacheWriteInputTokens: 0, totalTokens: inputTokens + outputTokens }
  return { total, last: total, modelContextWindow: null }
}
