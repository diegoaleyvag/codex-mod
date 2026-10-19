// Offline CLI fixture for the headless R6 harness. State is restricted to an
// explicitly supplied temporary root; no authentication or network is used.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve, join, sep } from 'node:path'
import { tmpdir } from 'node:os'

if (!process.argv.includes('exec')) {
  process.env.FAKE_SCENARIO ??= 'cache-accounting'
  await import('./fake-app-server.mjs')
} else {
  const supplied = process.env.FAKE_CACHE_ROOT
  const root = supplied && resolve(supplied)
  const temp = resolve(tmpdir())
  if (!root || ![temp, '/tmp', '/private/tmp'].some(dir => root.startsWith(dir + sep))) throw new Error('FAKE_CACHE_ROOT must be an explicit temporary subdirectory')
  mkdirSync(root, { recursive: true, mode: 0o700 })
  const fixture = JSON.parse(readFileSync(new URL('./cache-exec-cumulative.json', import.meta.url), 'utf8'))
  const args = process.argv.slice(2)
  const model = args[args.indexOf('-m') + 1]
  const thread = args.includes('resume') ? args.at(-2) : fixture.thread
  if (thread !== fixture.thread) throw new Error('fixture does not own requested thread')
  let prompt = ''
  for await (const chunk of process.stdin) prompt += chunk
  if (!prompt.trim()) throw new Error('empty fixture task')
  const emit = event => process.stdout.write(JSON.stringify(event) + '\n')
  emit({ type: 'thread.started', thread_id: thread })
  emit({ type: 'turn.started' })
  if (process.env.FAKE_SCENARIO === 'cache-capacity' && model === 'gpt-6.1-sol') {
    emit({ type: 'turn.failed', error: { message: 'Selected model is at capacity. Please try a different model.' } })
    process.exitCode = 1
  } else {
    const file = join(root, 'exec-count.json')
    let count = 0
    try { count = JSON.parse(readFileSync(file, 'utf8')).count } catch {}
    const usage = count === 0 ? fixture.first : fixture.followUpTotal
    emit({ type: 'item.completed', item: { id: `cache-final-${count}`, type: 'agent_message', text: `CACHE_OK ${count + 1}` } })
    const event = { type: 'turn.completed', usage: { input_tokens: usage.input, cached_input_tokens: usage.cached, output_tokens: usage.output } }
    emit(event)
    emit(event)
    writeFileSync(file, JSON.stringify({ count: count + 1 }), { mode: 0o600 })
  }
}
