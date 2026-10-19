// Shared by the hook and sidecar so a UI selection cannot widen the RPC contract.
const object = v => v !== null && typeof v === 'object' && !Array.isArray(v)
const only = (v, keys) => Object.keys(v).every(k => keys.includes(k))
export const QUESTION_METHOD = 'item/tool/requestUserInput'

export function choiceQuestions(params) {
  const qs = params?.questions
  if (!object(params) || !['threadId', 'turnId', 'itemId'].every(k => typeof params[k] === 'string' && params[k] !== '') || typeof params.isBlocking !== 'boolean') return false
  return Array.isArray(qs) && qs.length >= 1 && qs.length <= 4 &&
    new Set(qs.map(q => q?.id)).size === qs.length && new Set(qs.map(q => q?.question)).size === qs.length && qs.every(q =>
      object(q) && typeof q.id === 'string' && q.id !== '' && typeof q.question === 'string' && q.question !== '' &&
      typeof q.header === 'string' && q.header.length >= 1 && q.header.length <= 12 && q.isSecret === false && q.isOther === false &&
      Array.isArray(q.options) && q.options.length >= 2 && q.options.length <= 4 && new Set(q.options.map(o => o?.label)).size === q.options.length &&
      q.options.every(o => object(o) && typeof o.label === 'string' && o.label !== '' && typeof o.description === 'string'))
}

export function choiceResponse(params, result) {
  return choiceQuestions(params) && object(result) && only(result, ['answers']) && object(result.answers) &&
    Object.keys(result.answers).length === params.questions.length && params.questions.every(q => {
      const a = Object.hasOwn(result.answers, q.id) ? result.answers[q.id] : undefined
      return object(a) && only(a, ['answers']) && Array.isArray(a.answers) && a.answers.length === 1 && q.options.some(o => o.label === a.answers[0])
    })
}

/** Only an acknowledged Codex RPC answer can supply a native reported-answer row. */
export function answeredQuestion(params, response) {
  if (!choiceResponse(params, response)) return
  const questions = params.questions.map(q => ({ question: q.question, header: q.header, options: q.options.map(o => ({ label: o.label, description: o.description })), multiSelect: false }))
  const answers = Object.fromEntries(params.questions.map(q => [q.question, response.answers[q.id].answers[0]]))
  return { tool: 'AskUserQuestion', input: { questions, answers }, result: { questions, answers } }
}

export function validAnsweredQuestion(action) {
  const i = action.input, r = action.result
  if (action.tool !== 'AskUserQuestion' || !object(i) || !only(i, ['questions', 'answers']) || !object(i.answers) || !Array.isArray(i.questions)) return false
  const params = { threadId: 'held', turnId: 'held', itemId: 'held', isBlocking: true,
    questions: i.questions.map((q, n) => ({ ...q, id: String(n), isOther: false, isSecret: false })) }
  if (!choiceQuestions(params) || i.questions.some(q => !only(q, ['question', 'header', 'options', 'multiSelect']) || q.multiSelect !== false || q.options.some(o => !only(o, ['label', 'description'])))) return false
  if (Object.keys(i.answers).length !== i.questions.length || !i.questions.every(q => Object.hasOwn(i.answers, q.question) && q.options.some(o => o.label === i.answers[q.question]))) return false
  return object(r) && only(r, ['questions', 'answers']) && JSON.stringify(r) === JSON.stringify({ questions: i.questions, answers: i.answers })
}
