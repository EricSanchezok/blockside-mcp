import { Server } from '@modelcontextprotocol/server'
import { z } from 'zod'
import metadata from '../package.json' with { type: 'json' }
import { playerName } from './config.mjs'
import { BlocksideError, safeError } from './errors.mjs'
import { collectibleBlocks, collectCountLimit, collectRadiusLimit, craftableItems, craftCountLimit, planCraft } from './item-actions.mjs'

const empty = z.strictObject({})
const toolDefinitions = new Map([
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
    description: 'Collect up to three dirt or oak log drops within the specified radius.',
    schema: z.strictObject({
      block: z.enum(collectibleBlocks),
      count: z.number().int().min(1).max(collectCountLimit),
      radius: z.number().int().min(1).max(collectRadiusLimit)
    }),
    run: (game, input, signal) => game.collect(input, signal)
  }],
  ['craft', {
    description: 'Craft an approved item from stock in the player inventory. For four oak planks, use item oak_planks and count 4. Request whole recipe outputs and check inventory after an incomplete craft.',
    schema: z.strictObject({
      item: z.enum(craftableItems),
      count: z.number().int().min(1).max(craftCountLimit)
    }).refine(({ item, count }) => planCraft(item, count) !== null),
    run: (game, input, signal) => game.craft(input, signal)
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

export function createMcpServer(game, { draftCraft = false } = {}) {
  const tools = new Map(toolDefinitions)
  if (draftCraft !== true) tools.delete('craft')
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
