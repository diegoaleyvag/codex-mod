import { test, expect } from 'claude-code/testing'
import { admitMirrorLaunch, mirrorHostMatches, mirrorLaunchDigest, mirrorLaunchDiagnostic, MirrorDiagnostics } from '../hooks/mirror-launch.ts'
import type { MirrorAuthority, MirrorLaunch } from '../hooks/mirror-launch.ts'

const reservedInput = () => ({ subagentType: 'codex-mod:codex-child', prompt: 'one-time-private-token',
  description: 'Codex gpt-6.1-sol · /root/check', name: 'codex-child-thread', cwd: '/source/project' })
const reservation = (): MirrorLaunch => ({ ...reservedInput(), token: reservedInput().prompt,
  parentHost: 'parent-from-step', session: 'session-1', depth: 2, launch: 'launching', inputDigest: mirrorLaunchDigest(reservedInput()) })
const authority = (): MirrorAuthority => ({ parentHost: 'parent-from-step', session: 'session-1' })

// CLI 2.1.302: cwd is present but undefined, and parentAgentId is absent.
const liveSpawn = () => ({ tool_use_id: 'toolu_plugin_live_spawn', ...reservedInput(), cwd: undefined,
  provider: { plugin: 'codex-mod', tier: 'user' }, model: undefined, parentModel: 'claude-opus-4-7',
  permissionMode: 'default', background: true, fork: false })
const liveCall = () => {
  const { subagentType, ...input } = reservedInput()
  return { tool: 'Agent', tool_use_id: liveSpawn().tool_use_id, ...input, subagent_type: subagentType, run_in_background: true }
}

test('mirror admission matches the live host shape and binds one tool ID across call/check/spawn', () => {
  const m = reservation(), own = authority(), spawn = liveSpawn()
  expect(Object.prototype.hasOwnProperty.call(spawn, 'parentAgentId')).toBe(false)
  expect(Object.prototype.hasOwnProperty.call(spawn, 'cwd')).toBe(true)
  expect(spawn.cwd).toBe(undefined)
  expect(spawn.prompt === m.token).toBe(true)
  expect(mirrorLaunchDigest(spawn)).toBe(m.inputDigest)
  expect(admitMirrorLaunch(m, own, liveCall(), 'codex-mod', 'call')).toBe('admit')
  expect(admitMirrorLaunch(m, own, { ...liveCall(), cwd: undefined }, 'codex-mod', 'check')).toBe('admit')
  expect(admitMirrorLaunch(m, own, spawn, 'codex-mod', 'spawn')).toBe('admit')
  expect(m.hostToolId).toBe(spawn.tool_use_id)
  expect(m.parentHost).toBe('parent-from-step')
  expect(own.spawned).toBe(true)
  expect(admitMirrorLaunch(m, own, spawn, 'codex-mod', 'spawn')).toBe('reused')
  expect(admitMirrorLaunch(m, undefined, spawn, 'codex-mod', 'spawn')).toBe('no-authority')
})

test('mirror check accepts the nested input envelope using the same host tool ID', () => {
  const m = reservation(), own = authority()
  const { tool, tool_use_id, ...input } = liveCall()
  expect(admitMirrorLaunch(m, own, { tool, tool_use_id, input, ceiling: 'allow' }, 'codex-mod', 'check')).toBe('admit')
  expect(admitMirrorLaunch(m, own, liveSpawn(), 'codex-mod', 'spawn')).toBe('admit')
})


const spawnRejections = [
  ['token', { prompt: 'another-private-token' }],
  ['token', { prompt: undefined }],
  ['digest', { description: 'changed-description' }],
  ['digest', { name: undefined }],
  ['type', { subagentType: 'codex-mod:codex' }],
  ['tool-id', { tool_use_id: undefined }],
  ['tool-id', { tool_use_id: '' }],
  ['tool-id', { tool_use_id: 'toolu_codexmod_display' }],
  ['background', { background: false }],
  ['background', { background: undefined }],
  ['fork', { fork: true }],
  ['resume', { resume: { agentId: 'old-host' } }],
  ['workflow', { workflow: { runId: 'workflow', agentIndex: 1 } }],
  ['teammate', { isTeammate: true }],
  ['parent', { parentAgentId: 'another-parent' }],
  ['provider', { provider: { plugin: 'foreign', tier: 'user' } }],
] as const
for (const [index, [reason, change]] of spawnRejections.entries()) test(`mirror spawn reason ${reason} (${index}) leaves the reservation unconsumed`, () => {
  const m = reservation(), own = authority()
  expect(admitMirrorLaunch(m, own, { ...liveSpawn(), ...change }, 'codex-mod', 'spawn')).toBe(reason)
  expect(m.hostToolId).toBe(undefined)
  expect(own.spawned).toBe(undefined)
})

test('mirror admission reports missing authority and every reservation predicate', () => {
  expect(admitMirrorLaunch(undefined, authority(), liveSpawn(), 'codex-mod', 'spawn')).toBe('no-reservation')
  expect(admitMirrorLaunch(reservation(), undefined, liveSpawn(), 'codex-mod', 'spawn')).toBe('no-authority')
  expect(admitMirrorLaunch(reservation(), authority(), liveSpawn(), 'foreign', 'spawn')).toBe('origin')
  for (const [reason, change] of [['session', { session: 'foreign' }], ['parent', { parentHost: 'foreign' }]] as const) {
    expect(admitMirrorLaunch(reservation(), { ...authority(), ...change }, liveSpawn(), 'codex-mod', 'spawn')).toBe(reason)
  }
  for (const [reason, change] of [['state', { launch: 'reserved' }], ['state', { launch: 'bound' }],
    ['state', { launch: 'refused' }], ['state', { launch: 'uncertain' }], ['depth', { depth: 1 }], ['depth', { depth: 4 }],
    ['parent', { parentHost: '' }]] as const) {
    expect(admitMirrorLaunch({ ...reservation(), ...change }, authority(), liveSpawn(), 'codex-mod', 'spawn')).toBe(reason)
  }
})

test('mirror call/check report tool, keys, parent and background failures', () => {
  for (const [reason, change] of [['tool', { tool: 'Bash' }], ['parent', { agentId: 'foreign' }],
    ['keys', { resume: 'old-host' }], ['background', { run_in_background: false }]] as const) {
    expect(admitMirrorLaunch(reservation(), authority(), { ...liveCall(), ...change }, 'codex-mod', 'call')).toBe(reason)
  }
  const { tool, tool_use_id, ...input } = liveCall()
  for (const check of [{ tool, tool_use_id, input: { ...input, unexpected: true } }, { tool, tool_use_id, input, unexpected: true }]) {
    expect(admitMirrorLaunch(reservation(), authority(), check, 'codex-mod', 'check')).toBe('keys')
  }
})

test('mirror admission refuses a different tool ID and preserves the original claim', () => {
  const m = reservation(), own = authority()
  expect(admitMirrorLaunch(m, own, liveCall(), 'codex-mod', 'call')).toBe('admit')
  expect(admitMirrorLaunch(m, own, { ...liveSpawn(), tool_use_id: 'toolu_plugin_other' }, 'codex-mod', 'spawn')).toBe('tool-id')
  expect(admitMirrorLaunch(m, own, liveSpawn(), 'codex-mod', 'spawn')).toBe('admit')
  expect(admitMirrorLaunch({ ...reservation(), hostToolId: 'other' }, authority(), liveSpawn(), 'codex-mod', 'spawn')).toBe('tool-id')
})

test('mirror host binding diagnoses every mismatch and accepts omitted parent metadata', () => {
  const m = reservation()
  expect(admitMirrorLaunch(m, authority(), liveSpawn(), 'codex-mod', 'spawn')).toBe('admit')
  const info = { id: 'real-host', type: 'codex-mod:codex-child', spawnedBy: 'codex-mod' }
  expect(mirrorHostMatches(m, info.id, info)).toBe('admit')
  expect(mirrorHostMatches(m, info.id, undefined, true)).toBe('admit')
  expect(mirrorHostMatches(m, info.id, undefined)).toBe('no-host')
  expect(mirrorHostMatches(reservation(), info.id, info)).toBe('tool-id')
  expect(mirrorHostMatches(reservation(), info.id, undefined, true)).toBe('tool-id')
  expect(m.parentHost).toBe('parent-from-step')
  for (const [reason, change] of [['host-id', { id: 'another-host' }], ['type', { type: 'general-purpose' }],
    ['parent', { parentId: 'foreign' }], ['provider', { spawnedBy: 'foreign' }]] as const) {
    expect(mirrorHostMatches(m, info.id, { ...info, ...change })).toBe(reason)
  }
  expect(mirrorHostMatches({ ...m, host: 'another-host' }, info.id, info)).toBe('host-id')
  expect(mirrorHostMatches(m, '', info)).toBe('host-id')
  expect(mirrorHostMatches(m, m.parentHost, info)).toBe('parent')
  expect(mirrorHostMatches(reservation(), info.id, { ...info, parentId: m.parentHost })).toBe('admit')
})

test('nested dispatch authority is found only by the exact token, without event loop metadata', () => {
  const m = reservation(), own = authority()
  const authorities = new Map([[m.token, own]])
  const event = liveSpawn()
  expect(admitMirrorLaunch(m, authorities.get(event.prompt), event, 'codex-mod', 'spawn')).toBe('admit')
  // A durable reservation alone cannot authorize after restart or settlement.
  authorities.delete(m.token)
  expect(admitMirrorLaunch(m, authorities.get(event.prompt), event, 'codex-mod', 'spawn')).toBe('no-authority')
})

test('diagnostics expose field shape and reason without prompt, description or cwd values', () => {
  const m = reservation(), event = liveSpawn()
  const line = mirrorLaunchDiagnostic('spawn', 'no-authority', event, 'codex-mod', m)
  expect(line.startsWith('codex-mod: mirror launch refused at spawn: no-authority (')).toBe(true)
  for (const key of ['provider', 'model', 'parentModel', 'permissionMode', 'background', 'fork', 'depth']) expect(line.includes(key)).toBe(true)
  for (const secret of [m.token, event.description, event.name, '/source/project', event.parentModel]) expect(line.includes(secret)).toBe(false)
  for (const phase of ['call', 'check']) {
    expect(mirrorLaunchDiagnostic(phase, 'admit', liveCall(), 'codex-mod', m).includes(`mirror launch admitted at ${phase}: tool_use_id=${event.tool_use_id}`)).toBe(true)
  }
  const strange = mirrorLaunchDiagnostic('spawn', 'provider', { ...event, provider: { plugin: 'secret with spaces' }, background: 'secret with spaces' }, 'secret with spaces')
  expect(strange.includes('secret with spaces')).toBe(false)
})

test('re-entry diagnostics defer engine calls and drain once from an ordinary dispatch', () => {
  const diagnostics = new MirrorDiagnostics(), lines: string[] = []
  const log = (line: string) => { lines.push(line) }
  for (const phase of ['call', 'check', 'spawn']) diagnostics.add(mirrorLaunchDiagnostic(phase, 'no-authority', liveSpawn(), 'codex-mod'))
  expect(lines.length).toBe(0)
  diagnostics.flush(log)
  expect(lines.length).toBe(3)
  expect(lines[2].includes('refused at spawn: no-authority')).toBe(true)
  diagnostics.flush(log)
  expect(lines.length).toBe(3)
})
