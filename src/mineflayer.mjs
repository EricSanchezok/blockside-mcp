import { createConnection } from 'node:net'
import { setTimeout as delay } from 'node:timers/promises'
import mineflayer from 'mineflayer'
import pathfinderPlugin from 'mineflayer-pathfinder'
import collectblock from 'mineflayer-collectblock'
import { microsoftOptions } from './auth.mjs'
import { checkAuthCache, javaVersion } from './config.mjs'
import { watchCraftingInventory } from './crafting-inventory.mjs'
import { abortable, BlocksideError, safeError } from './errors.mjs'
import { planCraft } from './item-actions.mjs'

const { Movements, goals, pathfinder } = pathfinderPlugin
const followRadius = 16
const transientErrors = new Set(['ECONNRESET', 'ECONNABORTED', 'ETIMEDOUT', 'EPIPE'])
const airBlocks = new Set(['air', 'cave_air', 'void_air'])

function center(position) {
  return position.offset(0.5, 0.5, 0.5)
}

function within(position, origin, radius) {
  return position?.distanceTo(origin) <= radius
}

function craftingGridClear(inventory) {
  return !inventory.selectedItem && inventory.slots.slice(0, 5).every(item => item == null)
}

function inventoryStateAfter(stateId, previousStateId) {
  if (!Number.isInteger(stateId) || stateId < 0 || stateId > 0x7fff) return false
  if (previousStateId === undefined) return true
  // Container revisions wrap after 32767 on the Java server.
  const advance = (stateId - previousStateId) & 0x7fff
  return advance > 0 && advance < 0x4000
}

async function syncCraftingInventory(bot, signal, afterStateId, expectedBatch, inventoryProof) {
  const { inventory, _client: client } = bot
  const slots = inventory.slots.length
  const authoritative = Promise.withResolvers()
  let latestStateId = afterStateId
  let ticket
  const observe = packet => {
    if (packet.windowId !== inventory.id || bot.currentWindow || bot.inventory !== inventory ||
        !inventoryStateAfter(packet.stateId, latestStateId)) return
    latestStateId = packet.stateId
    if (packet.items.length !== slots || packet.carriedItem === undefined) {
      authoritative.reject(new BlocksideError('CRAFT_UNCONFIRMED'))
      return
    }
    const snapshotTicket = inventoryProof.ticketFor(packet)
    if (snapshotTicket === null) return
    // Paper sends full snapshots before the result reaches the player's inventory.
    // A clear grid and unchanged counts are insufficient to confirm the current batch.
    if (!craftingGridClear(inventory)) return
    const input = inventory.count(expectedBatch.inputType)
    const output = inventory.count(expectedBatch.outputType)
    if (input === expectedBatch.inputCount && output === expectedBatch.outputCount) {
      ticket = snapshotTicket
      authoritative.resolve({ input, output })
    }
  }
  client.on('window_items', observe)
  try {
    // Mineflayer requests a full snapshot, but its waiter accepts the first window packet.
    // Source: https://github.com/PrismarineJS/mineflayer/blob/4.39.0/lib/plugins/inventory.js
    const [snapshot] = await abortable(Promise.all([
      authoritative.promise,
      bot._syncWindow(inventory)
    ]), signal)
    signal.throwIfAborted()
    return { snapshot, ticket }
  } finally {
    client.off('window_items', observe)
  }
}

async function until(observe, signal, milliseconds) {
  const deadline = performance.now() + milliseconds
  for (;;) {
    signal.throwIfAborted()
    const result = observe()
    if (result || performance.now() >= deadline) return result
    await delay(25, undefined, { signal }).catch(() => signal.throwIfAborted())
  }
}

function observeRemoval(bot, position) {
  let confirmed = false
  const confirmAir = stateId => {
    if (airBlocks.has(bot.registry.blocksByStateId[stateId]?.name)) confirmed = true
  }
  const onBlockChange = ({ location, type }) => {
    if (position.equals(location)) confirmAir(type)
  }
  const onSectionChange = ({ chunkCoordinates, records }) => {
    if (chunkCoordinates.x !== (position.x >> 4) || chunkCoordinates.y !== (position.y >> 4) ||
        chunkCoordinates.z !== (position.z >> 4)) return
    // A section record stores local x, z and y in its low 12 bits.
    const local = ((position.x & 15) << 8) | ((position.z & 15) << 4) | (position.y & 15)
    const record = records.find(value => (value & 4095) === local)
    if (record !== undefined) confirmAir(record >> 12)
  }
  // Mineflayer can predict air at the end of a dig. Require a server update.
  const client = bot._client
  client.on('block_change', onBlockChange)
  client.on('multi_block_change', onSectionChange)
  return {
    get confirmed() { return confirmed },
    detach() {
      client.off('block_change', onBlockChange)
      client.off('multi_block_change', onSectionChange)
    }
  }
}

export function mineflayerFactory(config) {
  return onLost => {
    if (config.auth === 'microsoft') checkAuthCache(config.profilesFolder)
    return new MineflayerSession(config, onLost)
  }
}

class MineflayerSession {
  #bot
  #craftingInventory
  #socket
  #closed = false
  #spawned = false
  #failReady
  #onLost

  constructor(config, onLost) {
    this.#onLost = onLost
    const connect = client => {
      // Microsoft authentication may finish after the owner has canceled a request.
      if (this.#closed) return
      this.#socket = createConnection({ host: config.host, port: config.port })
      client.setSocket(this.#socket)
    }
    const authOptions = config.auth === 'microsoft'
      ? {
          ...microsoftOptions,
          profilesFolder: config.profilesFolder,
          onMsaCode: () => { throw new BlocksideError('AUTH_REQUIRED') }
        }
      : {}

    try {
      this.#bot = mineflayer.createBot({
        ...authOptions,
        connect,
        host: config.host,
        port: config.port,
        username: config.profile,
        auth: config.auth,
        version: javaVersion,
        hideErrors: true,
        logErrors: false,
        respawn: false
      })
      this.#bot.loadPlugin(pathfinder)
      this.#bot.loadPlugin(collectblock.plugin)
      if (config.draftCraft) this.#craftingInventory = watchCraftingInventory(this.#bot)
    } catch (error) {
      this.#socket?.destroy()
      throw error
    }

    this.ready = new Promise((resolve, reject) => {
      this.#failReady = reject
      this.#bot.once('spawn', () => {
        if (this.#closed) return
        this.#spawned = true
        resolve()
      })
    })
    this.#bot.on('error', error => {
      const retryable = this.#socket && !this.#spawned && transientErrors.has(error?.code)
      const code = retryable ? 'TRANSIENT_CONNECT' : 'CONNECT_FAILED'
      this.#finish(safeError(error, code))
    })
    this.#bot.on('end', reason => {
      const beforeSpawn = !this.#spawned && reason === 'socketClosed'
      this.#finish(new BlocksideError(beforeSpawn ? 'TRANSIENT_CONNECT' : 'DISCONNECTED'))
    })
    this.#bot.on('kicked', () => this.#finish(new BlocksideError('CONNECT_FAILED')))
    this.#bot.on('death', () => this.#finish(new BlocksideError('DISCONNECTED')))
    this.#bot.on('respawn', () => this.#finish(new BlocksideError('DISCONNECTED')))
  }

  get closed() {
    return this.#closed
  }

  halt() {
    this.#bot.pathfinder?.setGoal(null)
    this.#bot.clearControlStates?.()
    this.#bot.stopDigging?.()
  }

  close() {
    this.#finish(new BlocksideError('DISCONNECTED'))
  }

  #finish(error) {
    if (this.#closed) return
    this.#closed = true
    try {
      this.halt()
    } finally {
      this.#socket?.destroy()
      this.#failReady(error)
      this.#onLost(error)
    }
  }

  async follow({ player, seconds }, requestSignal) {
    const bot = this.#bot
    const entity = bot.players[player]?.entity
    if (!entity?.isValid || entity === bot.entity) throw new BlocksideError('PLAYER_UNAVAILABLE')

    return this.#navigate(followRadius, requestSignal, async ({ origin, signal, guard }) => {
      const checkPosition = moved => {
        if (moved === entity && !within(moved.position, origin, followRadius)) {
          guard.abort(new BlocksideError('OUT_OF_RANGE'))
        }
      }
      const unavailable = () => guard.abort(new BlocksideError('PLAYER_UNAVAILABLE'))
      const onEntityGone = gone => {
        if (gone === entity) unavailable()
      }
      const onPlayerLeft = ({ username }) => {
        if (username === player) unavailable()
      }
      const checkPath = ({ status }) => {
        if (status === 'noPath' || status === 'timeout') guard.abort(new BlocksideError('UNREACHABLE'))
      }
      checkPosition(entity)
      signal.throwIfAborted()
      bot.on('entityMoved', checkPosition)
      bot.on('entityGone', onEntityGone)
      bot.on('playerLeft', onPlayerLeft)
      bot.on('path_update', checkPath)
      try {
        bot.pathfinder.setGoal(new goals.GoalFollow(entity, 2), true)
        await delay(seconds * 1000, undefined, { signal })
        return { followed: true, seconds }
      } catch (error) {
        signal.throwIfAborted()
        throw error
      } finally {
        bot.off('entityMoved', checkPosition)
        bot.off('entityGone', onEntityGone)
        bot.off('playerLeft', onPlayerLeft)
        bot.off('path_update', checkPath)
      }
    })
  }

  async collect({ block, count, radius }, requestSignal) {
    let collected = 0
    const recordPickup = () => { collected++ }
    try {
      await this.#navigate(radius, requestSignal, async ({ origin, movements, signal }) => {
        const blockType = this.#bot.registry.blocksByName[block].id
        const itemType = this.#bot.registry.itemsByName[block].id
        for (let index = 0; index < count; index++) {
          signal.throwIfAborted()
          if (this.#bot.inventory.emptySlotCount() === 0) throw new BlocksideError('INVENTORY_FULL')
          const position = this.#bot.findBlocks({ point: origin, matching: blockType, maxDistance: radius, count: 32 })
            .find(position => within(center(position), origin, radius) && !this.#isFooting(position))
          if (!position) throw new BlocksideError('NO_BLOCK')
          await this.#collectOne(position, blockType, itemType, { origin, radius, movements, signal, recordPickup })
        }
      }, { closeOnAbort: true })
    } catch (error) {
      throw new BlocksideError(safeError(error).code, { block, requested: count, collected })
    }
    return { block, requested: count, collected }
  }

  async craft({ item, count }, signal) {
    signal.throwIfAborted()
    const plan = planCraft(item, count)
    if (!plan) throw new BlocksideError('INVALID_INPUT')
    const { ingredient, inputPerBatch, outputPerBatch, batches } = plan
    const bot = this.#bot
    const { inventory, registry } = bot
    const input = registry.itemsByName[ingredient]
    const output = registry.itemsByName[item]
    if (!input || !output || count > output.stackSize || bot.currentWindow || !bot.supportFeature('stateIdUsed')) {
      throw new BlocksideError('CRAFT_UNAVAILABLE')
    }

    const matchesRecipe = recipe => !recipe.requiresTable && !recipe.outShape &&
      recipe.result.id === output.id && recipe.result.count === outputPerBatch &&
      recipe.delta.length === 2 &&
      recipe.delta.some(delta => delta.id === input.id && delta.metadata == null && delta.count === -inputPerBatch) &&
      recipe.delta.some(delta => delta.id === output.id && delta.metadata == null && delta.count === outputPerBatch)
    if (!bot.recipesAll(output.id, null, null).some(matchesRecipe)) throw new BlocksideError('CRAFT_UNAVAILABLE')

    const client = bot._client
    const closeOnContainer = () => this.close()
    let crafted = 0
    let batchPending = false
    let windowStateId
    const rememberPlayerWindowState = ({ windowId, stateId }) => {
      if (windowId === inventory.id && !bot.currentWindow && inventoryStateAfter(stateId, windowStateId)) {
        windowStateId = stateId
      }
    }
    client.on('window_items', rememberPlayerWindowState)
    client.on('set_slot', rememberPlayerWindowState)
    // Mineflayer changes currentWindow on these packets, before it emits windowOpen.
    client.prependListener('open_window', closeOnContainer)
    client.prependListener('open_horse_window', closeOnContainer)
    try {
      let ticket = await this.#craftingInventory.sync(signal)
      signal.throwIfAborted()
      if (!craftingGridClear(inventory)) throw new BlocksideError('CRAFT_UNAVAILABLE')
      const required = inputPerBatch * batches
      signal.throwIfAborted()
      let beforeInput = inventory.count(input.id)
      let beforeOutput = inventory.count(output.id)
      if (beforeInput < required) throw new BlocksideError('MISSING_INGREDIENTS')
      if (inventory.emptySlotCount() === 0) throw new BlocksideError('INVENTORY_FULL')
      const recipe = bot.recipesFor(output.id, null, count, null).find(matchesRecipe)
      if (!recipe || !craftingGridClear(inventory)) throw new BlocksideError('CRAFT_UNAVAILABLE')

      for (let batch = 0; batch < batches; batch++) {
        signal.throwIfAborted()
        batchPending = true
        let confirmed
        try {
          await this.#craftingInventory.craftBatch(recipe, signal, ticket)
          signal.throwIfAborted()
          const proof = await syncCraftingInventory(bot, signal, windowStateId, {
            inputType: input.id,
            outputType: output.id,
            inputCount: beforeInput - inputPerBatch,
            outputCount: beforeOutput + outputPerBatch
          }, this.#craftingInventory)
          signal.throwIfAborted()
          confirmed = proof.snapshot
          ticket = proof.ticket
        } catch (error) {
          signal.throwIfAborted()
          this.close()
          throw safeError(error, 'CRAFT_UNCONFIRMED')
        }

        const { input: afterInput, output: afterOutput } = confirmed
        if (!craftingGridClear(inventory)) throw new BlocksideError('CRAFT_UNCONFIRMED')

        crafted += outputPerBatch
        batchPending = false
        beforeInput = afterInput
        beforeOutput = afterOutput
      }
      return { item, requested: count, crafted }
    } catch (error) {
      if (crafted === 0) throw error
      throw new BlocksideError(safeError(error).code, {
        item, requested: count, crafted, remaining: batchPending ? null : count - crafted
      })
    } finally {
      client.off('window_items', rememberPlayerWindowState)
      client.off('set_slot', rememberPlayerWindowState)
      client.off('open_window', closeOnContainer)
      client.off('open_horse_window', closeOnContainer)
    }
  }

  #isFooting(position) {
    return this.#bot.entity.position.floored().offset(0, -1, 0).equals(position)
  }

  async #navigate(radius, requestSignal, action, { closeOnAbort = false } = {}) {
    requestSignal.throwIfAborted()
    const bot = this.#bot
    const origin = bot.entity.position.clone()
    const guard = new AbortController()
    const signal = AbortSignal.any([requestSignal, guard.signal])
    const movements = new Movements(bot)
    Object.assign(movements, {
      canDig: false,
      canOpenDoors: false,
      allow1by1towers: false,
      allowParkour: false,
      allowSprinting: false,
      maxDropDown: 1,
      scafoldingBlocks: []
    })
    movements.exclusionAreasStep.push(block => within(block.position?.offset(0.5, 0, 0.5), origin, radius) ? 0 : 100)
    bot.pathfinder.searchRadius = radius
    bot.pathfinder.thinkTimeout = 1000
    bot.pathfinder.setMovements(movements)

    const checkRange = () => {
      if (within(bot.entity?.position, origin, radius)) return
      guard.abort(new BlocksideError('OUT_OF_RANGE'))
      if (closeOnAbort) this.close()
      else this.halt()
    }
    bot.on('move', checkRange)
    try {
      return await action({ origin, movements, signal, guard })
    } finally {
      bot.off('move', checkRange)
      this.halt()
    }
  }

  async #reach(goal, signal) {
    signal.throwIfAborted()
    const bot = this.#bot
    let emptyFailure = false
    // Source: Mineflayer Pathfinder 2.4.5 resolves goto for empty failed paths.
    // https://github.com/PrismarineJS/mineflayer-pathfinder/blob/2.4.5/lib/goto.js
    const checkPath = ({ status, path }) => {
      if (bot.pathfinder.goal === goal && status !== 'success' && path.length === 0) emptyFailure = true
    }
    bot.on('path_update', checkPath)
    try {
      await abortable(bot.pathfinder.goto(goal), signal)
    } catch (error) {
      signal.throwIfAborted()
      throw safeError(error, 'UNREACHABLE')
    } finally {
      bot.off('path_update', checkPath)
    }
    signal.throwIfAborted()
    if (emptyFailure) throw new BlocksideError('UNREACHABLE')
  }

  async #collectOne(position, blockType, itemType, { origin, radius, movements, signal, recordPickup }) {
    const bot = this.#bot
    await this.#reach(new goals.GoalLookAtBlock(position, bot.world), signal)
    signal.throwIfAborted()
    const block = bot.blockAt(position)
    if (block?.type !== blockType || this.#isFooting(position) || !bot.canDigBlock(block)) {
      throw new BlocksideError('UNREACHABLE')
    }

    const removal = observeRemoval(bot, position)
    const spawned = new Set()
    const drops = new Set()
    const before = bot.inventory.count(itemType)
    const blockCenter = center(position)
    let pickedUp = false
    const nearTarget = entity => within(entity.position, blockCenter, 0.75) && within(entity.position, origin, radius)
    const onSpawn = entity => {
      if (removal.confirmed && entity.name === 'item' && nearTarget(entity)) spawned.add(entity)
    }
    const onDrop = entity => {
      // Item metadata can arrive after the removal for an entity that spawned earlier.
      if (spawned.has(entity) && nearTarget(entity) && entity.getDroppedItem()?.type === itemType) drops.add(entity)
    }
    const onPickup = (collector, entity) => {
      if (collector.id === bot.entity.id && drops.has(entity)) pickedUp = true
    }
    const hasConfirmedPickup = () => pickedUp && bot.inventory.count(itemType) > before
    let confirmedAtCancel = false
    const onAbort = () => { confirmedAtCancel = hasConfirmedPickup() }
    bot.on('entitySpawn', onSpawn)
    bot.on('itemDrop', onDrop)
    bot.on('playerCollect', onPickup)
    signal.addEventListener('abort', onAbort, { once: true })
    try {
      // Navigate with digging disabled. Only this explicit call breaks a block.
      await abortable(bot.dig(block), signal)
      const drop = await until(() => pickedUp || [...drops].find(entity => entity.isValid), signal, 1000)
      if (!drop) throw new BlocksideError('NO_PICKUP')
      signal.throwIfAborted()
      if (!pickedUp) {
        bot.collectBlock.movements = movements
        try {
          await abortable(bot.collectBlock.collect(drop, { chestLocations: [] }), signal)
        } catch (error) {
          signal.throwIfAborted()
          if (!pickedUp) throw safeError(error, 'NO_PICKUP')
        }
      }
      if (!await until(hasConfirmedPickup, signal, 1000)) {
        throw new BlocksideError('NO_PICKUP')
      }
      signal.throwIfAborted()
    } finally {
      signal.removeEventListener('abort', onAbort)
      removal.detach()
      bot.off('entitySpawn', onSpawn)
      bot.off('itemDrop', onDrop)
      bot.off('playerCollect', onPickup)
      if (signal.aborted ? confirmedAtCancel : hasConfirmedPickup()) recordPickup()
    }
  }
}
