// Source usage only. Host Agent results and forked message history are never
// inputs to this ledger. A cumulative snapshot replaces, rather than adds to,
// the previous snapshot for its owning turn.
const zero = () => ({ input: 0, cached: 0, output: 0 })
const add = (a, b) => ({ input: a.input + b.input, cached: a.cached + b.cached, output: a.output + b.output })
const value = u => ({ input: Math.max(0, u.inputTokens ?? u.input_tokens ?? 0),
  cached: Math.max(0, u.cachedInputTokens ?? u.cached_input_tokens ?? 0),
  output: Math.max(0, u.outputTokens ?? u.output_tokens ?? 0) })

export class TreeUsage {
  edges = new Map()
  turns = new Map()
  responses = new Map()

  edge(parent, child) {
    if (!parent || !child || parent === child) return false
    if (this.edges.has(child)) return this.edges.get(child) === parent
    for (let id = parent; id; id = this.edges.get(id)) if (id === child) return false
    this.edges.set(child, parent)
    return true
  }

  cumulative(thread, turn, root, u) {
    if (!u?.total || !turn) return
    const key = JSON.stringify([thread, turn])
    const previous = this.turns.get(key)
    const total = value(u.total)
    const last = value(u.last ?? {})
    const baseline = previous?.baseline ?? {
      input: Math.max(0, total.input - last.input), cached: Math.max(0, total.cached - last.cached),
      output: Math.max(0, total.output - last.output),
    }
    const delta = { input: Math.max(0, total.input - baseline.input), cached: Math.max(0, total.cached - baseline.cached),
      output: Math.max(0, total.output - baseline.output) }
    this.turns.set(key, { thread, turn, root, baseline, usage: {
      input: Math.max(previous?.usage.input ?? 0, delta.input), cached: Math.max(previous?.usage.cached ?? 0, delta.cached),
      output: Math.max(previous?.usage.output ?? 0, delta.output),
    }, partial: previous?.partial || !u.last })
  }

  response(thread, turn, root, responseId, usage) {
    if (!responseId || !turn || !usage) return
    const key = JSON.stringify([thread, responseId])
    if (!this.responses.has(key)) this.responses.set(key, { thread, turn, root, usage: value(usage) })
  }

  direct(thread, root) {
    const groups = new Map()
    for (const r of this.responses.values()) {
      if (r.thread !== thread || r.root !== root) continue
      groups.set(r.turn, add(groups.get(r.turn) ?? zero(), r.usage))
    }
    // Cumulative and exact response notifications overlap. Keep the larger
    // covered interval; never add the two views of the same source turn.
    for (const t of this.turns.values()) if (t.thread === thread && t.root === root) {
      const exact = groups.get(t.turn)
      groups.set(t.turn, exact && exact.input >= t.usage.input && exact.output >= t.usage.output ? exact : t.usage)
    }
    return [...groups.values()].reduce(add, zero())
  }

  snapshot(thread, root) {
    const ids = new Set([thread])
    let changed = true
    while (changed) {
      changed = false
      for (const [child, parent] of this.edges) if (ids.has(parent) && !ids.has(child)) { ids.add(child); changed = true }
    }
    const direct = this.direct(thread, root)
    const tree = [...ids].reduce((sum, id) => add(sum, this.direct(id, root)), zero())
    const unavailable = id => ![...this.turns.values(), ...this.responses.values()].some(t => t.thread === id && t.root === root) ||
      [...this.turns.values()].some(t => t.thread === id && t.root === root && t.partial)
    const missing = [...ids].filter(unavailable).length
    return { direct, tree, children: ids.size - 1, missing, directPartial: unavailable(thread), threadIds: [...ids] }
  }
}
