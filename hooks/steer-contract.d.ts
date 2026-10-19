export type CodexModMessageOutcome = {
  id?: string | number; messageId: string; sourceUuid?: string; deliveryUuid?: string; senderToolUseId?: string
  brokerGeneration?: string; sessionId?: string; agentId?: string; runId?: string; threadId?: string
  expectedTurnId?: string; turnId?: string; acceptedTurnId?: string; queuedAfterTurnId?: string
  status: 'received' | 'pending' | 'accepted' | 'observed' | 'queued' | 'rejected' | 'unknown'
  reason?: string; error?: { code?: number; message?: string; data?: unknown }
  rpcRequestId?: number; receivedAt: number; submittedAt?: number; acknowledgedAt?: number; echoedItemId?: string
}

declare module 'claude-code' {
  interface PluginState {
    'codex-mod': { messageStatus: { readonly byId: CodexModMessageOutcome } }
  }
}
