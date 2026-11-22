import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { Client } from '@modelcontextprotocol/client'
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio'

const execute = promisify(execFile)
const entry = fileURLToPath(new URL('../src/main.mjs', import.meta.url))

async function configFile(t, config) {
  const directory = await mkdtemp(join(tmpdir(), 'blockside-stdio-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const path = join(directory, 'runner.json')
  await writeFile(path, JSON.stringify(config), { mode: 0o600 })
  return path
}

const offline = { host: '127.0.0.1', port: 1, auth: 'offline', profile: 'FixtureBot' }

test('the shipped stdio entry advertises exactly six tools and redacts rejected input', { timeout: 10_000 }, async t => {
  const path = await configFile(t, offline)
  const client = new Client({ name: 'blockside-contract-test', version: '1' })
  const transport = new StdioClientTransport({ command: process.execPath, args: [entry, path], stderr: 'pipe' })
  t.after(() => client.close())
  let diagnostics = ''
  transport.stderr.on('data', chunk => { diagnostics += chunk })
  await client.connect(transport)
  const { tools } = await client.listTools()
  assert.deepEqual(tools.map(tool => tool.name).sort(), ['collect', 'connect', 'disconnect', 'follow', 'status', 'stop'])
  assert.equal(tools.find(tool => tool.name === 'connect').inputSchema.additionalProperties, false)
  assert.deepEqual(tools.find(tool => tool.name === 'connect').inputSchema.properties, {})

  const status = await client.callTool({ name: 'status' })
  assert.deepEqual(status.structuredContent, { connection: 'disconnected', action: null, stopping: false })
  const rejectedInputs = [
    ['connect', { host: 'PRIVATE_MCP_TEST_VALUE', port: 444 }],
    ['follow', { player: 'Guide', seconds: 31 }],
    ['collect', { block: 'bedrock', count: 1, radius: 2 }],
    ['collect', { block: 'dirt', count: 4, radius: 2 }],
    ['collect', { block: 'dirt', count: 1, radius: 9 }]
  ]
  for (const [name, args] of rejectedInputs) {
    const result = await client.callTool({ name, arguments: args })
    assert.equal(result.isError, true)
    assert.equal(result.structuredContent.code, 'INVALID_INPUT')
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE_MCP_TEST_VALUE/)
  }
  const needsConnection = await client.callTool({ name: 'follow', arguments: { player: 'Guide', seconds: 1 } })
  assert.equal(needsConnection.structuredContent.code, 'NOT_CONNECTED')
  assert.equal(diagnostics, '')
})

test('startup refuses public addresses, hostnames and extra configuration fields', { timeout: 10_000 }, async t => {
  for (const config of [
    { ...offline, host: '203.0.113.1' },
    { ...offline, host: 'localhost' },
    { ...offline, PRIVATE_MCP_TEST_VALUE: 'unused' }
  ]) {
    const path = await configFile(t, config)
    await assert.rejects(execute(process.execPath, [entry, path], { timeout: 3000 }), error => {
      assert.equal(error.code, 1)
      assert.equal(error.stdout, '')
      assert.equal(error.stderr, 'Blockside MCP: Supply a valid operator configuration file.\n')
      return true
    })
  }
})

test('Microsoft connect with no local cache returns a redacted sign-in requirement', { timeout: 10_000 }, async t => {
  const path = await configFile(t, { ...offline, auth: 'microsoft' })
  const client = new Client({ name: 'blockside-auth-contract-test', version: '1' })
  const transport = new StdioClientTransport({ command: process.execPath, args: [entry, path], stderr: 'pipe' })
  t.after(() => client.close())
  await client.connect(transport)
  const result = await client.callTool({ name: 'connect' })
  assert.equal(result.isError, true)
  assert.equal(result.structuredContent.code, 'AUTH_REQUIRED')
  assert.doesNotMatch(JSON.stringify(result), /127\.0\.0\.1|FixtureBot/)
})
