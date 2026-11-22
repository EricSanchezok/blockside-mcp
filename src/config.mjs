import { lstatSync, mkdirSync } from 'node:fs'
import { open } from 'node:fs/promises'
import { isIPv4 } from 'node:net'
import { dirname, resolve } from 'node:path'
import { z } from 'zod'
import { BlocksideError } from './errors.mjs'

export const javaVersion = '1.21.11'
export const playerName = z.string().regex(/^[A-Za-z0-9_]{1,16}$/)

function isLocalAddress(host) {
  if (!isIPv4(host)) return false
  const [first, second] = host.split('.').map(Number)
  return first === 127 || first === 10 ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168)
}

const configSchema = z.strictObject({
  host: z.string().refine(isLocalAddress),
  port: z.number().int().min(1).max(65535),
  auth: z.enum(['offline', 'microsoft']),
  profile: playerName
})

export async function loadConfig(args) {
  try {
    if (args.length !== 1) throw new Error()
    const path = resolve(args[0])
    const file = await open(path, 'r')
    try {
      const stat = await file.stat()
      if (!stat.isFile() || stat.size === 0 || stat.size > 4096) throw new Error()
      const value = configSchema.parse(JSON.parse(await file.readFile('utf8')))
      return Object.freeze({ ...value, profilesFolder: resolve(dirname(path), '.blockside-auth') })
    } finally {
      await file.close()
    }
  } catch {
    throw new BlocksideError('CONFIG_INVALID')
  }
}

export function checkAuthCache(folder, create = false) {
  try {
    if (create) mkdirSync(folder, { mode: 0o700, recursive: true })
    const stat = lstatSync(folder)
    if (!stat.isDirectory() || (stat.mode & 0o077) || stat.uid !== process.getuid()) throw new Error()
  } catch {
    throw new BlocksideError('AUTH_REQUIRED')
  }
}

export function prepareLocalProcess() {
  process.umask(0o077)
  process.env.DEBUG = ''
  // Upstream error messages can include server text and authentication details.
  // This entrypoint owns its stdout (MCP) and stderr (fixed diagnostics).
  for (const method of ['log', 'info', 'debug', 'warn', 'error', 'trace']) console[method] = () => {}
}
