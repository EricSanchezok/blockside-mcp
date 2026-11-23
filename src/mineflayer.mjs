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
const transientErrors = new Set(['ECONNRESET', 'ECONNABORTED', 'ETIMEDOUT', 'EPIPE'])

function center(position) {
  return position.offset(0.5, 0.5, 0.5)
}

function within(position, origin, radius) {
  return position?.distanceTo(origin) <= radius
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
          await this.#collectOne(position, blockType, itemType, { origin, radius, movements, signal })
          collected++
        }
      }, { closeOnAbort: true })
    } catch (error) {
      throw new BlocksideError(safeError(error).code, { block, requested: count, collected })
    }
    return { block, requested: count, collected }
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

  async #collectOne(position, blockType, itemType, { origin, radius, movements, signal }) {
    const bot = this.#bot
    try {
      await abortable(bot.pathfinder.goto(new goals.GoalLookAtBlock(position, bot.world)), signal)
    } catch (error) {
      signal.throwIfAborted()
      throw safeError(error, 'UNREACHABLE')
    }
    signal.throwIfAborted()
    const block = bot.blockAt(position)
    if (block?.type !== blockType || this.#isFooting(position) || !bot.canDigBlock(block)) {
      throw new BlocksideError('UNREACHABLE')
    }

    const initialEntities = new Set(Object.keys(bot.entities).map(Number))
    const drops = new Map()
    const before = bot.inventory.count(itemType)
    const blockCenter = center(position)
    let pickedUp = false
    const onDrop = entity => {
      if (!initialEntities.has(entity.id) &&
          within(entity.position, blockCenter, 0.75) && within(entity.position, origin, radius) &&
          entity.getDroppedItem()?.type === itemType) drops.set(entity.id, entity)
    }
    const onPickup = (collector, entity) => {
      if (collector.id === bot.entity.id && drops.has(entity.id)) pickedUp = true
    }
    bot.on('itemDrop', onDrop)
    bot.on('playerCollect', onPickup)
    try {
      // Navigate with digging disabled. Only this explicit call breaks a block.
      await abortable(bot.dig(block), signal)
      const drop = await until(() => pickedUp || [...drops.values()].find(entity => entity.isValid), signal, 1000)
      if (!drop) throw new BlocksideError('NO_PICKUP')
      if (!pickedUp) {
        bot.collectBlock.movements = movements
        try {
          await abortable(bot.collectBlock.collect(drop, { chestLocations: [] }), signal)
        } catch (error) {
          signal.throwIfAborted()
          if (!pickedUp) throw safeError(error, 'NO_PICKUP')
        }
      }
      if (!await until(() => pickedUp && bot.inventory.count(itemType) > before, signal, 1000)) {
        throw new BlocksideError('NO_PICKUP')
      }
    } finally {
      bot.off('itemDrop', onDrop)
      bot.off('playerCollect', onPickup)
    }
  }
}
