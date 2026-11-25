import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/client'
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio'

export const runnerEntry = fileURLToPath(new URL('../src/main.mjs', import.meta.url))

export async function configFile(t, config) {
  const directory = await mkdtemp(join(tmpdir(), 'blockside-stdio-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const path = join(directory, 'runner.json')
  await writeFile(path, JSON.stringify(config), { mode: 0o600 })
  return path
}

export async function startStdio(t, config) {
  const path = await configFile(t, config)
  const client = new Client({ name: 'blockside-contract-test', version: '1' })
  const transport = new StdioClientTransport({ command: process.execPath, args: [runnerEntry, path], stderr: 'pipe' })
  t.after(() => client.close())
  let diagnostics = ''
  transport.stderr.on('data', chunk => { diagnostics += chunk })
  await client.connect(transport)
  return { client, diagnostics: () => diagnostics }
}
