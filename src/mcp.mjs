import { Server } from '@modelcontextprotocol/server'
import { z } from 'zod'
import metadata from '../package.json' with { type: 'json' }
import { playerName } from './config.mjs'
import { BlocksideError, safeError } from './errors.mjs'

const empty = z.strictObject({})
const tools = new Map([
  ['connect', {
    description: 'Connect to the operator-configured Java Edition server.',
    schema: empty,
    run: (game, input, signal) => game.connect(signal)
  }],
  ['status', {
    description: 'Read the connection and current action state.',
    schema: empty,
    run: game => game.status()
  }],
  ['follow', {
    description: 'Follow a visible Java player for up to 30 seconds within a 16-block leash.',
    schema: z.strictObject({ player: playerName, seconds: z.number().int().min(1).max(30) }),
    run: (game, input, signal) => game.follow(input, signal)
  }],
  ['collect', {
    description: 'Collect up to three matching dirt or oak log items within the radius after confirmed breaks. The receipt counts observed pickups. Item origin remains unverified.',
    schema: z.strictObject({
      block: z.enum(['dirt', 'oak_log']),
      count: z.number().int().min(1).max(3),
      radius: z.number().int().min(1).max(8)
    }),
    run: (game, input, signal) => game.collect(input, signal)
  }],
  ['stop', {
    description: 'Stop the active game action. An in-progress dig may require disconnecting.',
    schema: empty,
    run: game => game.stop()
  }],
  ['disconnect', {
    description: 'Stop any action and close the game connection.',
    schema: empty,
    run: game => game.disconnect()
  }]
])

function result(data, isError = false) {
  return {
    content: [{ type: 'text', text: JSON.stringify(data) }],
    structuredContent: data,
    ...(isError ? { isError: true } : {})
  }
}

export function createMcpServer(game) {
  const server = new Server({ name: metadata.name, version: metadata.version }, { capabilities: { tools: {} } })
  server.setRequestHandler('tools/list', () => ({
    tools: [...tools].map(([name, { description, schema }]) => ({
      name, description, inputSchema: z.toJSONSchema(schema)
    }))
  }))
  // The low-level tool handler keeps input errors and unknown names from echoing model-supplied values.
  server.setRequestHandler('tools/call', async ({ params }, { mcpReq }) => {
    try {
      const tool = tools.get(params.name)
      if (!tool) throw new BlocksideError('UNKNOWN_TOOL')
      const parsed = tool.schema.safeParse(params.arguments ?? {})
      if (!parsed.success) throw new BlocksideError('INVALID_INPUT')
      const output = await tool.run(game, parsed.data, mcpReq.signal)
      return result(output)
    } catch (error) {
      const failure = safeError(error)
      return result({
        code: failure.code,
        message: failure.message,
        ...(failure.receipt ? { receipt: failure.receipt } : {})
      }, true)
    }
  })
  server.onclose = () => game.disconnect()
  return server
}
