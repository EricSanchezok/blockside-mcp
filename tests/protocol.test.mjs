import assert from 'node:assert/strict'
import { once } from 'node:events'
import { test } from 'node:test'
import { setImmediate as nextTurn } from 'node:timers/promises'
import minecraftData from 'minecraft-data'
import protocol from 'minecraft-protocol'
import mineflayer from 'mineflayer'
import createChunk from 'prismarine-chunk'
import vec3 from 'vec3'
import { javaVersion } from '../src/config.mjs'
import { GameController } from '../src/controller.mjs'
import { mineflayerFactory } from '../src/mineflayer.mjs'
import { startStdio } from './stdio-fixture.mjs'

const data = minecraftData(javaVersion)
const Chunk = createChunk(javaVersion)
const { Vec3 } = vec3
const dirt = { x: 4, y: 64, z: 2 }
const spawn = { x: 2.5, y: 64, z: 2.5 }
const guideId = '00000000-0000-4000-8000-000000000011'
const dropId = '00000000-0000-4000-8000-000000000012'
const competingDropId = '00000000-0000-4000-8000-000000000013'
const pickupFence = 926_582_309_446n
function spawnEntity(client, entityId, uuid, type, position) {
  client.write('spawn_entity', {
    entityId, objectUUID: uuid, type: data.entitiesByName[type].id, ...position,
    velocity: { x: 0, y: 0, z: 0 },
    yaw: 0, pitch: 0, headPitch: 0, objectData: 0
  })
}

function configureBotOnSpawn(t, configure) {
  const createBot = mineflayer.createBot
  t.mock.method(mineflayer, 'createBot', options => {
    const bot = createBot(options)
    bot.once('spawn', () => configure(bot))
    return bot
  })
}

async function loopback(t, {
  guide = false, pickup, sectionUpdate = false, spawnBeforeRemoval = false,
  target = dirt, material = 'dirt', terrain = []
} = {}) {
  const server = protocol.createServer({
    host: '127.0.0.1', port: 0, version: javaVersion, 'online-mode': false, hideErrors: true
  })
  const chunk = new Chunk()
  const movements = []
  const digs = []
  const digOrigins = []
  const digging = Promise.withResolvers()
  const following = Promise.withResolvers()
  const pickupProcessed = Promise.withResolvers()
  const inventoryReleased = Promise.withResolvers()
  const drops = Promise.withResolvers()
  const targetBlock = new Vec3(target.x, target.y, target.z)
  const dropOrigin = targetBlock.offset(0.5, 0.25, 0.5)
  let dropPosition
  let pickupSent = false
  let playerLoaded = false
  let inventorySlot
  let lastPosition = spawn
  for (let x = 0; x < 16; x++) {
    for (let z = 0; z < 16; z++) {
      chunk.setBlockStateId(new Vec3(x, 63, z), data.blocksByName.stone.defaultState)
    }
  }
  for (const { position, block } of terrain) chunk.setBlockStateId(position, data.blocksByName[block].defaultState)
  if (pickup) chunk.setBlockStateId(targetBlock, data.blocksByName[material].defaultState)

  server.on('playerJoin', client => {
    client.on('player_loaded', () => { playerLoaded = true })
    client.write('login', { ...data.loginPacket, entityId: client.id })
    client.write('map_chunk', {
      x: 0, z: 0, heightmaps: [], chunkData: chunk.dump(), blockEntities: [], ...chunk.dumpLight()
    })
    if (guide) {
      client.write('player_info', {
        action: { add_player: true },
        data: [{ uuid: guideId, player: { name: 'Guide', properties: [] } }]
      })
      spawnEntity(client, 10, guideId, 'player', { x: 7.5, y: 64, z: 2.5 })
    }
    client.write('position', { ...spawn, teleportId: 1, dx: 0, dy: 0, dz: 0, yaw: 0, pitch: 0, flags: {} })
    client.write('update_health', { health: 20, food: 20, foodSaturation: 5 })

    const item = {
      itemCount: 1, itemId: data.itemsByName[material].id,
      addedComponentCount: 0, removedComponentCount: 0, components: [], removeComponents: []
    }
    const announceItem = entityId => client.write('entity_metadata', {
      entityId,
      metadata: [{ key: data.supportFeature('metadataIxOfItem'), type: 'item_stack', value: item }]
    })
    const spawnDrop = () => spawnEntity(client, 11, dropId, 'item', dropOrigin)
    const announceDrop = () => {
      spawnDrop()
      announceItem(11)
    }
    const announceCompetingDrop = () => {
      spawnEntity(client, 12, competingDropId, 'item', { ...dropOrigin, z: dropOrigin.z + 0.15 })
      announceItem(12)
    }
    drops.resolve({ announceDrop, announceCompetingDrop })
    const sendPickup = (entityId = 11) => {
      pickupSent = true
      client.write('collect', { collectedEntityId: entityId, collectorEntityId: client.id, pickupItemCount: 1 })
      const sendInventorySlot = () => {
        inventorySlot = item
        client.write('set_player_inventory', { slotId: 0, contents: inventorySlot })
      }
      if (pickup === 'cursor-only') {
        client.write('window_items', {
          windowId: 0, stateId: 1, items: Array.from({ length: 46 }, () => ({ itemCount: 0 })), carriedItem: item
        })
      } else if (pickup === 'delayed-slot') {
        inventoryReleased.promise.then(() => {
          sendInventorySlot()
          sendInventorySlot()
        })
      } else if (pickup !== 'unconfirmed') {
        sendInventorySlot()
      }
      if (pickup !== 'pending') client.write('entity_destroy', { entityIds: [entityId] })
      if (pickup === 'pending' || pickup === 'delayed-slot') {
        // The reply shows the client has processed the earlier packets on this connection.
        client.write('keep_alive', { keepAliveId: pickupFence })
      }
    }
    client.on('keep_alive', ({ keepAliveId }) => {
      if (BigInt(keepAliveId) === pickupFence) pickupProcessed.resolve()
    })
    const onMovement = position => {
      lastPosition = position
      movements.push(position.x)
      if (guide && position.x > spawn.x + 0.25) following.resolve()
      if (!dropPosition || pickupSent) return
      if (pickup === 'competing-during-pursuit' && position.x > spawn.x + 0.35) {
        announceCompetingDrop()
        sendPickup(12)
      } else if (Math.hypot(position.x - dropPosition.x, position.z - dropPosition.z) <= 0.9) {
        if (pickup === 'empty-pursuit') {
          client.write('entity_destroy', { entityIds: [11] })
          dropPosition = null
        } else {
          sendPickup()
        }
      }
    }
    client.on('position', onMovement)
    client.on('position_look', onMovement)
    client.on('block_dig', ({ status, location }) => {
      digs.push({ status, location })
      if (status === 0) {
        digOrigins.push(new Vec3(lastPosition.x, lastPosition.y, lastPosition.z))
        digging.resolve(location)
        if (pickup === 'unrelated-at-start') {
          dropPosition = dropOrigin
          announceDrop()
        }
      }
      if (status !== 2 || !pickup || !targetBlock.equals(location)) return
      dropPosition = dropOrigin
      if (spawnBeforeRemoval || pickup === 'unrelated') spawnEntity(client, 11, dropId, 'item', dropPosition)
      if (spawnBeforeRemoval) announceItem(11)
      const air = data.blocksByName.air.defaultState
      chunk.setBlockStateId(targetBlock, air)
      if (sectionUpdate) {
        const record = (air << 12) | (target.x << 8) | (target.z << 4) | (target.y & 15)
        client.write('multi_block_change', { chunkCoordinates: { x: 0, y: target.y >> 4, z: 0 }, records: [record] })
      } else {
        client.write('block_change', { location: target, type: air })
      }
      if (!spawnBeforeRemoval && pickup !== 'unrelated-at-start') {
        if (pickup !== 'unrelated') spawnEntity(client, 11, dropId, 'item', dropPosition)
        announceItem(11)
      }
      if (pickup === 'unrelated') sendPickup()
      if (pickup === 'competing') {
        announceCompetingDrop()
        sendPickup(12)
      }
    })
  })

  await once(server, 'listening')
  const host = '127.0.0.1'
  const port = server.socketServer.address().port
  const config = { host, port, auth: 'offline', profile: 'FixtureBot' }
  const game = new GameController(mineflayerFactory(config))
  t.after(async () => {
    game.disconnect()
    const closed = once(server, 'close')
    server.close()
    await closed
  })
  return {
    config, game, movements, digs, digOrigins, digging: digging.promise, following: following.promise,
    pickupProcessed: pickupProcessed.promise, releaseInventory: inventoryReleased.resolve, drops: drops.promise,
    loaded: () => playerLoaded, sentPickup: () => pickupSent,
    blockAt: position => chunk.getBlock(position).name,
    inventory: () => inventorySlot && { itemId: inventorySlot.itemId, count: inventorySlot.itemCount }
  }
}

function buriedResource(block) {
  const position = new Vec3(dirt.x, dirt.y, dirt.z)
  const coveringBlocks = [[-1, 0, 0], [1, 0, 0], [0, 1, 0], [0, 0, -1], [0, 0, 1]]
  return [{ position, block }, ...coveringBlocks.map(([x, y, z]) => ({ position: position.offset(x, y, z), block: 'stone' }))]
}

test('Java 1.21.11 loopback spawn, follow movement and disconnect', { timeout: 10_000 }, async t => {
  const fixture = await loopback(t, { guide: true })
  const { game } = fixture
  assert.equal((await game.connect()).connection, 'connected')
  assert.deepEqual(await game.follow({ player: 'Guide', seconds: 2 }), { followed: true, seconds: 2 })
  assert.equal(fixture.loaded(), true)
  assert.ok(fixture.movements.some(x => x > spawn.x + 1))
  assert.equal(fixture.digs.length, 0)
  assert.equal(game.disconnect().connection, 'disconnected')
})

test('the shipped stdio runner stops an active follow when the MCP client cancels', { timeout: 10_000 }, async t => {
  const fixture = await loopback(t, { guide: true })
  const { client } = await startStdio(t, fixture.config)
  assert.equal((await client.callTool({ name: 'connect' })).structuredContent.connection, 'connected')
  const abort = new AbortController()
  const follow = client.callTool({ name: 'follow', arguments: { player: 'Guide', seconds: 20 } }, { signal: abort.signal })
  const canceled = assert.rejects(follow, /Fixture canceled follow/)
  await fixture.following
  assert.equal((await client.callTool({ name: 'status' })).structuredContent.action, 'follow')
  abort.abort(new Error('Fixture canceled follow'))
  await canceled
  assert.deepEqual((await client.callTool({ name: 'status' })).structuredContent, {
    connection: 'connected', action: null, stopping: false
  })
  assert.equal((await client.callTool({ name: 'disconnect' })).structuredContent.connection, 'disconnected')
})

test('Java 1.21.11 loopback collection confirms the pickup and reports a partial count', { timeout: 10_000 }, async t => {
  const fixture = await loopback(t, { pickup: 'confirmed', sectionUpdate: true })
  await fixture.game.connect()
  await assert.rejects(fixture.game.collect({ block: 'dirt', count: 2, radius: 5 }), error => {
    assert.equal(error.code, 'NO_BLOCK')
    assert.deepEqual(error.receipt, { block: 'dirt', requested: 2, collected: 1 })
    return true
  })
  assert.equal(fixture.sentPickup(), true)
  assert.deepEqual(fixture.digs.filter(dig => dig.status === 2), [{ status: 2, location: dirt }])
})

test('the shipped collect tool picks exposed dirt past a closer buried block', { timeout: 10_000 }, async t => {
  const target = new Vec3(2, 64, 6)
  const fixture = await loopback(t, { pickup: 'confirmed', target, terrain: buriedResource('dirt') })
  const { client } = await startStdio(t, fixture.config)
  assert.equal((await client.callTool({ name: 'connect' })).structuredContent.connection, 'connected')

  const result = await client.callTool({ name: 'collect', arguments: { block: 'dirt', count: 1, radius: 6 } })
  assert.equal(result.isError, undefined)
  assert.deepEqual(result.structuredContent, { block: 'dirt', requested: 1, collected: 1 })
  assert.deepEqual(fixture.digs, [{ status: 0, location: { ...target } }, { status: 2, location: { ...target } }])
  assert.equal(fixture.blockAt(target), 'air')
  assert.equal(fixture.blockAt(new Vec3(dirt.x, dirt.y, dirt.z)), 'dirt')
  assert.deepEqual(fixture.inventory(), { itemId: data.itemsByName.dirt.id, count: 1 })
})

test('the shipped collect tool reports partial oak log collection when the rest are inaccessible', { timeout: 12_000 }, async t => {
  const target = new Vec3(1, 64, 6)
  const outside = new Vec3(2, 64, 11)
  const terrain = [...buriedResource('oak_log'), { position: outside, block: 'oak_log' }]
  for (let x = 0; x < 4; x++) terrain.push({ position: new Vec3(x, 64, 5), block: 'stone' })
  const fixture = await loopback(t, { pickup: 'confirmed', target, material: 'oak_log', terrain })
  const { client } = await startStdio(t, fixture.config)
  assert.equal((await client.callTool({ name: 'connect' })).structuredContent.connection, 'connected')

  const result = await client.callTool({ name: 'collect', arguments: { block: 'oak_log', count: 2, radius: 7 } })
  assert.equal(result.isError, true)
  assert.equal(result.structuredContent.code, 'UNREACHABLE')
  assert.deepEqual(result.structuredContent.receipt, { block: 'oak_log', requested: 2, collected: 1 })
  assert.deepEqual(fixture.digs, [{ status: 0, location: { ...target } }, { status: 2, location: { ...target } }])
  assert.ok(fixture.digOrigins[0].distanceTo(spawn) > 0.5)
  assert.equal(fixture.blockAt(target), 'air')
  assert.equal(fixture.blockAt(new Vec3(dirt.x, dirt.y, dirt.z)), 'oak_log')
  assert.equal(fixture.blockAt(outside), 'oak_log')
  assert.deepEqual(fixture.inventory(), { itemId: data.itemsByName.oak_log.id, count: 1 })
  assert.deepEqual((await client.callTool({ name: 'status' })).structuredContent, {
    connection: 'connected', action: null, stopping: false
  })
})

test('Java 1.21.11 loopback confirms a targeted pickup when the item spawns after removal', { timeout: 10_000 }, async t => {
  const fixture = await loopback(t, { pickup: 'confirmed' })
  await fixture.game.connect()
  assert.deepEqual(await fixture.game.collect({ block: 'dirt', count: 1, radius: 5 }), {
    block: 'dirt', requested: 1, collected: 1
  })
  assert.equal(fixture.sentPickup(), true)
})

test('Java 1.21.11 loopback leaves a matching spawn before the removal update ambiguous', { timeout: 10_000 }, async t => {
  const fixture = await loopback(t, { pickup: 'confirmed', spawnBeforeRemoval: true })
  await fixture.game.connect()
  await assert.rejects(fixture.game.collect({ block: 'dirt', count: 1, radius: 5 }), error => {
    assert.equal(error.code, 'PICKUP_AMBIGUOUS')
    assert.deepEqual(error.receipt, { block: 'dirt', requested: 1, collected: 0 })
    return true
  })
  assert.equal(fixture.sentPickup(), false)
})

test('Java 1.21.11 loopback item disappearance without inventory gain gives no receipt', { timeout: 10_000 }, async t => {
  const fixture = await loopback(t, { pickup: 'unconfirmed' })
  await fixture.game.connect()
  await assert.rejects(fixture.game.collect({ block: 'dirt', count: 1, radius: 5 }), error => {
    assert.equal(error.code, 'NO_PICKUP')
    assert.deepEqual(error.receipt, { block: 'dirt', requested: 1, collected: 0 })
    return true
  })
  assert.equal(fixture.sentPickup(), true)
})

test('Java 1.21.11 loopback does not count a pickup held only on the cursor', { timeout: 10_000 }, async t => {
  let inventory
  configureBotOnSpawn(t, bot => { inventory = bot.inventory })
  const fixture = await loopback(t, { pickup: 'cursor-only' })
  await fixture.game.connect()
  await assert.rejects(fixture.game.collect({ block: 'dirt', count: 1, radius: 5 }), error => {
    assert.equal(error.code, 'NO_PICKUP')
    assert.deepEqual(error.receipt, { block: 'dirt', requested: 1, collected: 0 })
    return true
  })
  assert.equal(fixture.sentPickup(), true)
  assert.equal(inventory.selectedItem?.name, 'dirt')
  assert.equal(inventory.selectedItem.count, 1)
  assert.deepEqual(inventory.items(), [])
})

test('Java 1.21.11 loopback settles a delayed pickup once despite a repeated slot update', { timeout: 10_000 }, async t => {
  let inventory
  const slotsProcessed = Promise.withResolvers()
  configureBotOnSpawn(t, bot => {
    inventory = bot.inventory
    let updates = 0
    bot._client.on('set_player_inventory', () => {
      if (++updates === 2) slotsProcessed.resolve()
    })
  })
  const fixture = await loopback(t, { pickup: 'delayed-slot' })
  const { game } = fixture
  await game.connect()
  const collection = game.collect({ block: 'dirt', count: 1, radius: 5 })

  await Promise.race([fixture.pickupProcessed, collection])
  assert.equal(game.status().action, 'collect')
  assert.deepEqual(inventory.items(), [])
  fixture.releaseInventory()

  const [receipt] = await Promise.all([collection, slotsProcessed.promise])
  assert.deepEqual(receipt, { block: 'dirt', requested: 1, collected: 1 })
  assert.equal(inventory.count(data.itemsByName.dirt.id), 1)
  assert.deepEqual(fixture.digs.filter(dig => dig.status === 2), [{ status: 2, location: dirt }])
})

test('Java 1.21.11 loopback leaves a prematurely collected early drop ambiguous', { timeout: 10_000 }, async t => {
  const fixture = await loopback(t, { pickup: 'unrelated' })
  await fixture.game.connect()
  await assert.rejects(fixture.game.collect({ block: 'dirt', count: 1, radius: 5 }), error => {
    assert.equal(error.code, 'PICKUP_AMBIGUOUS')
    assert.deepEqual(error.receipt, { block: 'dirt', requested: 1, collected: 0 })
    return true
  })
  assert.equal(fixture.sentPickup(), true)
  assert.deepEqual(fixture.digs.filter(dig => dig.status === 2), [{ status: 2, location: dirt }])
})

test('Java 1.21.11 loopback does not credit a lone matching item spawned at dig start', { timeout: 10_000 }, async t => {
  const fixture = await loopback(t, { pickup: 'unrelated-at-start' })
  await fixture.game.connect()
  await assert.rejects(fixture.game.collect({ block: 'dirt', count: 1, radius: 5 }), error => {
    assert.equal(error.code, 'PICKUP_AMBIGUOUS')
    assert.deepEqual(error.receipt, { block: 'dirt', requested: 1, collected: 0 })
    return true
  })
  assert.deepEqual(await fixture.digging, dirt)
  assert.equal(fixture.sentPickup(), false)
  assert.equal(fixture.digs.some(dig => dig.status === 2), false)
  assert.equal(fixture.game.status().connection, 'disconnected')
})

test('Java 1.21.11 loopback leaves a competing same-type pickup ambiguous', { timeout: 10_000 }, async t => {
  const fixture = await loopback(t, { pickup: 'competing' })
  await fixture.game.connect()
  await assert.rejects(fixture.game.collect({ block: 'dirt', count: 2, radius: 5 }), error => {
    assert.equal(error.code, 'PICKUP_AMBIGUOUS')
    assert.deepEqual(error.receipt, { block: 'dirt', requested: 2, collected: 0 })
    return true
  })
  assert.equal(fixture.sentPickup(), true)
  assert.deepEqual(fixture.digs.filter(dig => dig.status === 2), [{ status: 2, location: dirt }])
})

test('Java 1.21.11 loopback stops a pursuit when a competing item appears', { timeout: 10_000 }, async t => {
  const fixture = await loopback(t, { pickup: 'competing-during-pursuit' })
  await fixture.game.connect()
  await assert.rejects(fixture.game.collect({ block: 'dirt', count: 2, radius: 5 }), error => {
    assert.equal(error.code, 'PICKUP_AMBIGUOUS')
    assert.equal(error.receipt.collected, 0)
    return true
  })
  assert.equal(fixture.sentPickup(), true)
  assert.equal(fixture.game.status().connection, 'disconnected')
  assert.deepEqual(fixture.digs.filter(dig => dig.status === 2), [{ status: 2, location: dirt }])
})

test('Java 1.21.11 loopback keeps the connection on a conflict after an empty pursuit ends', { timeout: 10_000 }, async t => {
  const finished = Promise.withResolvers()
  configureBotOnSpawn(t, bot => bot.once('collectBlock_finished', () => finished.resolve()))
  const fixture = await loopback(t, { pickup: 'empty-pursuit' })
  await fixture.game.connect()
  const failure = assert.rejects(fixture.game.collect({ block: 'dirt', count: 1, radius: 5 }), error => {
    assert.equal(error.code, 'PICKUP_AMBIGUOUS')
    assert.deepEqual(error.receipt, { block: 'dirt', requested: 1, collected: 0 })
    return true
  })
  await finished.promise
  const { announceCompetingDrop } = await fixture.drops
  announceCompetingDrop()
  await failure
  assert.equal(fixture.game.status().connection, 'connected')
})

for (const { operation, code } of [
  { operation: 'an early matching item appears during the turn', code: 'PICKUP_AMBIGUOUS' },
  { operation: 'explicit stop', code: 'CANCELED' }
]) {
  test(`Java 1.21.11 loopback prevents a delayed dig start after ${operation}`, { timeout: 10_000 }, async t => {
    const looking = Promise.withResolvers()
    const release = Promise.withResolvers()
    const digWrites = []
    configureBotOnSpawn(t, bot => {
      const lookAt = bot.lookAt
      const write = bot._client.write.bind(bot._client)
      t.mock.method(bot, 'lookAt', async (...args) => {
        await lookAt(...args)
        looking.resolve()
        await release.promise
      })
      t.mock.method(bot._client, 'write', (name, packet) => {
        if (name === 'block_dig') digWrites.push(packet.status)
        return write(name, packet)
      })
      t.after(() => bot.stopDigging())
    })
    t.after(release.resolve)
    const fixture = await loopback(t, { pickup: 'confirmed' })
    const { game } = fixture
    await game.connect()
    const stopped = assert.rejects(game.collect({ block: 'dirt', count: 1, radius: 5 }), error => {
      assert.equal(error.code, code)
      assert.equal(error.receipt.collected, 0)
      return true
    })

    await looking.promise
    assert.deepEqual(digWrites, [])
    if (code === 'CANCELED') {
      assert.equal(game.stop().stopped, true)
    } else {
      const { announceDrop } = await fixture.drops
      announceDrop()
    }
    await stopped
    release.resolve()
    await nextTurn()
    assert.deepEqual(digWrites.slice(), [])
    assert.deepEqual(fixture.digs, [])
    assert.equal(game.status().connection, 'disconnected')
  })
}

test('Java 1.21.11 loopback stop preserves a confirmed pickup while collection is pending', { timeout: 10_000 }, async t => {
  const fixture = await loopback(t, { pickup: 'pending' })
  await fixture.game.connect()
  const pending = fixture.game.collect({ block: 'dirt', count: 2, radius: 5 })
  const stopped = assert.rejects(pending, error => {
    assert.equal(error.code, 'CANCELED')
    assert.deepEqual(error.receipt, { block: 'dirt', requested: 2, collected: 1 })
    return true
  })
  await fixture.pickupProcessed
  assert.equal(fixture.game.status().action, 'collect')
  assert.equal(fixture.game.stop().connection, 'disconnected')
  await stopped
  assert.deepEqual(fixture.digs.filter(dig => dig.status === 2), [{ status: 2, location: dirt }])
})

test('Java 1.21.11 loopback stop closes the session during a dig', { timeout: 10_000 }, async t => {
  const fixture = await loopback(t, { pickup: 'confirmed' })
  await fixture.game.connect()
  const pending = fixture.game.collect({ block: 'dirt', count: 1, radius: 5 })
  const stopped = assert.rejects(pending, error => {
    assert.equal(error.code, 'CANCELED')
    assert.equal(error.receipt.collected, 0)
    return true
  })
  assert.deepEqual(await fixture.digging, dirt)
  assert.equal(fixture.game.stop().connection, 'disconnected')
  await stopped
  assert.equal(fixture.digs.some(dig => dig.status === 2), false)
  assert.equal(fixture.sentPickup(), false)
})
