import { createConnection } from 'node:net'
import { setTimeout as delay } from 'node:timers/promises'
import mineflayer from 'mineflayer'
import pathfinderPlugin from 'mineflayer-pathfinder'
import collectblock from 'mineflayer-collectblock'
import { microsoftOptions } from './auth.mjs'
import { checkAuthCache, javaVersion } from './config.mjs'
import { abortable, BlocksideError, safeError } from './errors.mjs'

const { Movements, goals, pathfinder } = pathfinderPlugin
const followRadius = 16
const collectReach = 4.5
const transientErrors = new Set(['ECONNRESET', 'ECONNABORTED', 'ETIMEDOUT', 'EPIPE'])
const airBlocks = new Set(['air', 'cave_air', 'void_air'])

function center(position) {
  return position.offset(0.5, 0.5, 0.5)
}

function within(position, origin, radius) {
  return position?.distanceTo(origin) <= radius
}

function isFooting(position, feet) {
  return feet.floored().offset(0, -1, 0).equals(position)
}

function hasCollectReach(bot, position, feet) {
  if (isFooting(position, feet)) return false
  const eye = feet.offset(0, bot.entity.eyeHeight, 0)
  const ray = center(position).minus(eye)
  const distance = ray.norm()
  if (!(distance > 0 && distance <= collectReach)) return false
  return bot.world.raycast(eye, ray.normalize(), distance)?.position.equals(position) ?? false
}

class CollectGoal extends goals.GoalLookAtBlock {
  constructor(bot, position) {
    super(position, bot.world)
    this.bot = bot
  }

  isEnd(node) {
    return hasCollectReach(this.bot, this.pos, node.offset(0.5, 0, 0.5))
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

function droppedItem(entity) {
  try {
    return entity.getDroppedItem?.()
  } catch {
    return undefined
  }
}

function observePickup(bot, position, itemType, origin, radius) {
  const removal = observeRemoval(bot, position)
  const previous = new Set(Object.values(bot.entities))
  const spawnedBeforeRemoval = new Map()
  const unidentified = new Set()
  const conflict = new AbortController()
  const before = bot.inventory.count(itemType)
  const blockCenter = center(position)
  let candidate
  let pickedUp = false

  const ambiguous = () => conflict.abort(new BlocksideError('PICKUP_AMBIGUOUS'))
  const onSpawn = entity => {
    if (entity.name !== 'item' || previous.has(entity) || spawnedBeforeRemoval.has(entity) ||
        !within(entity.position, blockCenter, 0.75) || !within(entity.position, origin, radius)) return
    spawnedBeforeRemoval.set(entity, !removal.confirmed)
    unidentified.add(entity)
  }
  const onDrop = entity => {
    if (!spawnedBeforeRemoval.has(entity)) return
    const item = droppedItem(entity)
    if (!item) return
    unidentified.delete(entity)
    if (item.type !== itemType) {
      if (candidate === entity) ambiguous()
      return
    }
    // Delayed metadata can identify a matching entity that spawned before removal.
    if (spawnedBeforeRemoval.get(entity) || item.count !== 1 || (candidate && candidate !== entity)) ambiguous()
    else candidate = entity
  }
  const onPickup = (collector, entity) => {
    if (collector !== bot.entity || (pickedUp && entity === candidate)) return
    const item = droppedItem(entity)
    if (entity !== candidate) {
      if (item?.type === itemType || unidentified.has(entity)) ambiguous()
      return
    }
    if (item?.type !== itemType || item.count !== 1 || bot.entities[entity.id] !== entity ||
        bot.inventory.count(itemType) !== before) {
      ambiguous()
      return
    }
    pickedUp = true
  }
  bot.on('entitySpawn', onSpawn)
  bot.on('itemDrop', onDrop)
  bot.on('playerCollect', onPickup)
  return {
    signal: conflict.signal,
    get pickedUp() { return pickedUp },
    ready() {
      if (!removal.confirmed || unidentified.size > 0) return undefined
      if (pickedUp) return candidate
      if (candidate?.isValid && bot.entities[candidate.id] === candidate &&
          within(candidate.position, origin, radius)) return candidate
    },
    confirmed() {
      return !conflict.signal.aborted && unidentified.size === 0 && pickedUp && bot.inventory.count(itemType) - before === 1
    },
    failure() {
      const unresolved = unidentified.size > 0 || bot.inventory.count(itemType) !== before
      return new BlocksideError(unresolved ? 'PICKUP_AMBIGUOUS' : 'NO_PICKUP')
    },
    detach() {
      removal.detach()
      bot.off('entitySpawn', onSpawn)
      bot.off('itemDrop', onDrop)
      bot.off('playerCollect', onPickup)
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
    const entity = this.#bot.players[player]?.entity
    if (!entity?.isValid || entity === this.#bot.entity) throw new BlocksideError('PLAYER_UNAVAILABLE')

    return this.#navigate(followRadius, requestSignal, async ({ origin, signal, guard }) => {
      const keepPlayerInRange = () => {
        if (!entity.isValid || this.#bot.players[player]?.entity !== entity) {
          guard.abort(new BlocksideError('PLAYER_UNAVAILABLE'))
        } else if (!within(entity.position, origin, followRadius)) {
          guard.abort(new BlocksideError('OUT_OF_RANGE'))
        }
      }
      const checkPath = ({ status }) => {
        if (status === 'noPath' || status === 'timeout') guard.abort(new BlocksideError('UNREACHABLE'))
      }
      keepPlayerInRange()
      signal.throwIfAborted()
      this.#bot.on('physicsTick', keepPlayerInRange)
      this.#bot.on('path_update', checkPath)
      try {
        this.#bot.pathfinder.setGoal(new goals.GoalFollow(entity, 2), true)
        await delay(seconds * 1000, undefined, { signal }).catch(() => signal.throwIfAborted())
        return { followed: true, seconds }
      } finally {
        this.#bot.off('physicsTick', keepPlayerInRange)
        this.#bot.off('path_update', checkPath)
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
          const target = await this.#reachCollectTarget(blockType, { origin, radius, signal })
          await this.#collectOne(target, itemType, { origin, radius, movements, signal, recordPickup })
        }
      }, { closeOnAbort: true })
    } catch (error) {
      throw new BlocksideError(safeError(error).code, { block, requested: count, collected })
    }
    return { block, requested: count, collected }
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

  async #reachCollectTarget(blockType, { origin, radius, signal }) {
    const bot = this.#bot
    const candidates = bot.findBlocks({ point: origin, matching: blockType, maxDistance: radius, count: 32 })
      .filter(position => within(center(position), origin, radius) && !isFooting(position, bot.entity.position))
    if (!candidates.length) throw new BlocksideError('NO_BLOCK')

    const goal = new goals.GoalCompositeAny(candidates.map(position => new CollectGoal(bot, position)))
    try {
      await abortable(bot.pathfinder.goto(goal), signal)
    } catch (error) {
      signal.throwIfAborted()
      throw safeError(error, 'UNREACHABLE')
    }
    signal.throwIfAborted()
    bot.pathfinder.setGoal(null)
    for (const position of candidates) {
      const block = this.#collectableBlock(position, blockType)
      if (block) return block
    }
    throw new BlocksideError('UNREACHABLE')
  }

  #collectableBlock(position, blockType) {
    const bot = this.#bot
    const block = bot.blockAt(position)
    if (block?.type !== blockType || !bot.canDigBlock(block) || !hasCollectReach(bot, position, bot.entity.position)) return
    return block
  }

  async #collectOne(block, itemType, { origin, radius, movements, signal, recordPickup }) {
    const bot = this.#bot
    const pickup = observePickup(bot, block.position, itemType, origin, radius)
    const work = AbortSignal.any([signal, pickup.signal])
    let operationPending = false
    const waitForOperation = operation => {
      operationPending = true
      return abortable(operation.finally(() => { operationPending = false }), work)
    }
    let confirmedAtCancel = false
    const onAbort = () => { confirmedAtCancel = pickup.confirmed() }
    signal.addEventListener('abort', onAbort, { once: true })
    try {
      // Mineflayer registers its dig cancellation after turning toward the block.
      await waitForOperation(bot.lookAt(center(block.position)))
      work.throwIfAborted()
      const target = this.#collectableBlock(block.position, block.type)
      if (!target) throw new BlocksideError('UNREACHABLE')
      if (bot.inventory.emptySlotCount() === 0) throw new BlocksideError('INVENTORY_FULL')
      await waitForOperation(bot.dig(target, 'ignore'))
      const drop = await until(pickup.ready, work, 1000)
      if (!drop) throw pickup.failure()
      work.throwIfAborted()
      if (!pickup.pickedUp) {
        bot.collectBlock.movements = movements
        try {
          await waitForOperation(bot.collectBlock.collect(drop, { chestLocations: [] }))
        } catch {
          work.throwIfAborted()
          if (!pickup.pickedUp) throw pickup.failure()
        }
      }
      if (!await until(pickup.confirmed, work, 1000)) throw pickup.failure()
      work.throwIfAborted()
    } finally {
      signal.removeEventListener('abort', onAbort)
      pickup.detach()
      if (signal.aborted ? confirmedAtCancel : pickup.confirmed()) recordPickup()
      if (operationPending) this.close()
    }
  }
}
