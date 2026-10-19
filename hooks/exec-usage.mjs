const keys = ['input', 'cached', 'output']
export const zeroUsage = () => ({ input: 0, cached: 0, output: 0 })
export const addUsage = (a, b) => Object.fromEntries(keys.map(k => [k, a[k] + b[k]]))
export const validUsage = u => u && keys.every(k => Number.isSafeInteger(u[k]) && u[k] >= 0) && u.cached <= u.input

// Exec completion events are thread totals. Replace duplicate snapshots and
// subtract only a known full-thread baseline; never sum cumulative events.
export function execDelta(total, baseline) {
  if (!validUsage(total)) return { partial: true }
  if (!validUsage(baseline) || keys.some(k => total[k] < baseline[k])) return { partial: true }
  const usage = Object.fromEntries(keys.map(k => [k, total[k] - baseline[k]]))
  return validUsage(usage) ? { usage, partial: false } : { partial: true }
}
