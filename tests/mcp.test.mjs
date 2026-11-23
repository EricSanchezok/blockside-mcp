import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { test } from 'node:test'
import { promisify } from 'node:util'
import { configFile, runnerEntry, startStdio } from './stdio-fixture.mjs'

const execute = promisify(execFile)
const offline = { host: '127.0.0.1', port: 1, auth: 'offline', profile: 'FixtureBot' }

test('the shipped stdio entry advertises exactly six tools and redacts rejected input', { timeout: 10_000 }, async t => {
  const { client, diagnostics } = await startStdio(t, offline)
  const { tools } = await client.listTools()
  assert.deepEqual(tools.map(tool => tool.name).sort(), ['collect', 'connect', 'disconnect', 'follow', 'status', 'stop'])
  assert.equal(tools.find(tool => tool.name === 'connect').inputSchema.additionalProperties, false)
  assert.deepEqual(tools.find(tool => tool.name === 'connect').inputSchema.properties, {})

  const status = await client.callTool({ name: 'status' })
  assert.deepEqual(status.structuredContent, { connection: 'disconnected', action: null, stopping: false })
  const rejectedInputs = [
    ['connect', { host: 'PRIVATE_MCP_TEST_VALUE', port: 444 }],
    ['connect', { javaVersion: '26.1' }],
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
  assert.equal(diagnostics(), '')
})

test('startup refuses public addresses, hostnames, unsupported versions and extra fields', { timeout: 10_000 }, async t => {
  for (const config of [
    { ...offline, host: '203.0.113.1' },
    { ...offline, host: 'localhost' },
    { ...offline, javaVersion: '26.3' },
    { ...offline, PRIVATE_MCP_TEST_VALUE: 'unused' }
  ]) {
    const path = await configFile(t, config)
    await assert.rejects(execute(process.execPath, [runnerEntry, path], { timeout: 3000 }), error => {
      assert.equal(error.code, 1)
      assert.equal(error.stdout, '')
      assert.equal(error.stderr, 'Blockside MCP: Supply a valid operator configuration file.\n')
      return true
    })
  }
})

test('Microsoft connect with no local cache returns a redacted sign-in requirement', { timeout: 10_000 }, async t => {
  const { client } = await startStdio(t, { ...offline, auth: 'microsoft' })
  const result = await client.callTool({ name: 'connect' })
  assert.equal(result.isError, true)
  assert.equal(result.structuredContent.code, 'AUTH_REQUIRED')
  assert.doesNotMatch(JSON.stringify(result), /127\.0\.0\.1|FixtureBot/)
})
