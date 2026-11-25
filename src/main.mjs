import { loadConfig, prepareLocalProcess } from './config.mjs'
import { GameController } from './controller.mjs'
import { safeError } from './errors.mjs'

prepareLocalProcess()

let game
let handle
let closing = false

async function close(failure) {
  if (closing) return
  closing = true
  if (failure) process.stderr.write(`Blockside MCP: ${failure.message}\n`)
  try {
    game?.disconnect()
    await handle?.close()
  } finally {
    process.exit(failure ? 1 : 0)
  }
}

try {
  const config = await loadConfig(process.argv.slice(2))
  const { mineflayerFactory } = await import('./mineflayer.mjs')
  const { createMcpServer } = await import('./mcp.mjs')
  const { serveStdio, StdioServerTransport } = await import('@modelcontextprotocol/server/stdio')
  game = new GameController(mineflayerFactory(config))
  handle = serveStdio(() => createMcpServer(game, { draftCraft: config.draftCraft }), {
    transport: new StdioServerTransport(process.stdin, process.stdout, { maxBufferSize: 32_768 })
  })
  process.stdin.once('end', () => void close())
  process.once('SIGINT', () => void close())
  process.once('SIGTERM', () => void close())
  process.once('uncaughtException', () => void close(safeError(null)))
  process.once('unhandledRejection', () => void close(safeError(null)))
} catch (error) {
  await close(safeError(error))
}
