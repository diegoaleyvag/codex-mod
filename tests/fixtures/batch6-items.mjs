// Original one-pixel PNG fixture; generation reports are protocol-derived examples.
export const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNQaDjwHwAEhAJgikCezQAAAABJRU5ErkJggg=='
export const questionParams = { threadId: 'thr-1', turnId: 'turn-1', itemId: 'question-1', isBlocking: true, autoResolutionMs: null,
  questions: [{ id: 'mode', header: 'Mode', question: 'Which mode?', isOther: false, isSecret: false,
    options: [{ label: 'Small', description: 'Bounded change' }, { label: 'Full', description: 'Complete change' }] }] }
export const ANSWER = { answers: { mode: { answers: ['Small'] } } }
export default [
  { type: 'imageView', id: 'view', path: 'batch6/view.png' },
  { type: 'imageView', id: 'missing', path: 'batch6/missing.png' },
  { type: 'imageView', id: 'unsupported', path: 'batch6/vector.svg' },
  { type: 'imageGeneration', id: 'generation', status: 'completed', revisedPrompt: 'Actual revised prompt\nUnicode café', result: 'reported-generation-result', savedPath: 'batch6/generated.png', transparentBackground: true, failure: null },
  { type: 'imageGeneration', id: 'generation-failed', status: 'failed', revisedPrompt: null, result: '', failure: { message: 'image quota exceeded', limitId: 'images' } },
  { type: 'imageGeneration', id: 'generation-remote', status: 'completed', revisedPrompt: null, result: 'https://invalid.example/not-fetched.png', failure: null },
  { type: 'reasoning', id: 'reason', summary: ['Public summary.', 'Check the actual result.'], content: ['PRIVATE_RAW_REASONING'] },
  { type: 'reasoning', id: 'reason-empty', summary: [], content: ['PRIVATE_EMPTY_REASONING'] },
  { type: 'agentMessage', id: 'commentary', phase: 'commentary', text: 'Working commentary.' },
  { type: 'agentMessage', id: 'partial', phase: 'partial_answer', text: 'Incomplete partial answer.' },
  { type: 'enteredReviewMode', id: 'review-start', review: 'Review all changes.\n' + 'Preserve this full review request. '.repeat(20) },
  { type: 'exitedReviewMode', id: 'review-end', review: 'Full review result.\nLiteral <tag> & Unicode 😀\nLast line.' },
  { type: 'contextCompaction', id: 'compact' },
  { type: 'sleep', id: 'sleep', durationMs: 25 },
  { type: 'agentMessage', id: 'final', phase: 'final_answer', text: 'Batch 6 complete.' },
]
