export function messageStatus(o) {
  if (!o) return 'Received · pending Codex acknowledgment'
  if (o.status === 'accepted' || o.status === 'observed') return `Accepted into turn ${o.acceptedTurnId ?? o.turnId}${o.echoedItemId ? ' · observed input' : ''}`
  if (o.status === 'queued') return `Queued after turn ${o.queuedAfterTurnId ?? 'current'}${o.reason ? ` · ${o.reason}` : ''}`
  if (o.status === 'rejected') return `Rejected: ${o.reason ?? o.error?.message ?? 'no reason supplied'}`
  if (o.status === 'unknown') return `Delivery uncertain · query ${o.messageId}`
  return 'Received · pending Codex acknowledgment'
}

