import { closeSync, openSync, writeSync } from 'node:fs'
import { isatty } from 'node:tty'
import { checkAuthCache, loadConfig, prepareLocalProcess } from './config.mjs'
import { BlocksideError, safeError } from './errors.mjs'

prepareLocalProcess()

let terminal
try {
  const config = await loadConfig(process.argv.slice(2))
  if (config.auth !== 'microsoft' || !isatty(process.stdin.fd)) throw new BlocksideError('AUTH_FAILED')
  terminal = openSync('/dev/tty', 'w')
  checkAuthCache(config.profilesFolder, true)
  const { default: prismarineAuth } = await import('prismarine-auth')
  const { microsoftOptions } = await import('./auth.mjs')
  const flow = new prismarineAuth.Authflow(config.profile, config.profilesFolder, microsoftOptions, ({ user_code }) => {
    if (!/^[A-Z0-9-]{4,16}$/.test(user_code)) throw new BlocksideError('AUTH_FAILED')
    writeSync(terminal, `Open https://www.microsoft.com/link and enter ${user_code}.\n`)
  })
  const { token, profile } = await flow.getMinecraftJavaToken({ fetchProfile: true })
  if (!token || !profile?.name) throw new BlocksideError('AUTH_FAILED')
  process.stderr.write('Microsoft sign-in is ready.\n')
} catch (error) {
  process.stderr.write(`Blockside MCP: ${safeError(error, 'AUTH_FAILED').message}\n`)
  process.exitCode = 1
} finally {
  if (terminal !== undefined) closeSync(terminal)
}
