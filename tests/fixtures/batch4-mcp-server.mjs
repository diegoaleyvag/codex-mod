#!/usr/bin/env node
// Offline MCP fixture. Log calls separately so the harness can detect any replay.
import { appendFileSync } from 'node:fs'
import { createInterface } from 'node:readline'

const inputSchema = { type: 'object', additionalProperties: false, properties: { topic: { type: 'string' } }, required: ['topic'] }
const tools = [
  { name: 'lookup', description: 'Batch 4 offline lookup fixture.', inputSchema },
  { name: 'structured', description: 'Batch 4 structured-only result.', inputSchema,
    outputSchema: { type: 'object', additionalProperties: false, properties: { answer: { type: 'integer' } }, required: ['answer'] } },
  { name: 'media', description: 'Batch 4 media result.', inputSchema },
  { name: 'fail', description: 'Batch 4 failed result.', inputSchema },
]

createInterface({ input: process.stdin }).on('line', line => {
  const m = JSON.parse(line)
  if (process.env.FAKE_MCP_LOG) appendFileSync(process.env.FAKE_MCP_LOG, JSON.stringify(m) + '\n')
  if (m.id === undefined) return
  const reply = result => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result }) + '\n')
  const error = message => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message } }) + '\n')
  switch (m.method) {
    case 'initialize': return reply({ protocolVersion: m.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'batch4-fixture', version: '1' } })
    case 'ping': return reply({})
    case 'tools/list': return reply({ tools })
    case 'tools/call': {
      if (!tools.some(t => t.name === m.params.name)) return error('Unknown fixture tool')
      if (m.params.name === 'structured') return reply({ content: [], structuredContent: { answer: 42 } })
      if (m.params.name === 'fail') return reply({ content: [{ type: 'text', text: 'Actual MCP failure' }], isError: true })
      if (m.params.name === 'media') return reply({ content: [
        { type: 'image', mimeType: 'image/png', data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=' },
        { type: 'audio', mimeType: 'audio/wav', data: 'UklGRiQAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YQAAAAA=' },
      ] })
      return reply({ content: [{ type: 'text', text: `Actual fixture executor: ${m.params.arguments?.topic}` }] })
    }
    default: return error('Unsupported fixture method')
  }
})
