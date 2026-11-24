import assert from 'node:assert/strict'
import { once } from 'node:events'
import { test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import minecraftData from 'minecraft-data'
import protocol from 'minecraft-protocol'
import createChunk from 'prismarine-chunk'
import vec3 from 'vec3'
import { javaVersion } from '../src/config.mjs'
import { GameController } from '../src/controller.mjs'
import { mineflayerFactory } from '../src/mineflayer.mjs'
import { startStdio } from './stdio-fixture.mjs'

const data = minecraftData(javaVersion)
const Chunk = createChunk(javaVersion)
const { Vec3 } = vec3
const pickupPosition = { x: 4, y: 64, z: 2 }
const spawn = { x: 2.5, y: 64, z: 2.5 }
const guideId = '00000000-0000-4000-8000-000000000011'
const guideEntityId = 10
const guideInfo = {
  action: { add_player: true },
  data: [{ uuid: guideId, player: { name: 'Guide', properties: [] } }]
}
const dropId = '00000000-0000-4000-8000-000000000012'
const pickupFence = 926_582_309_446n

function spawnEntity(client, entityId, uuid, type, position) {
  client.write('spawn_entity', {
    entityId, objectUUID: uuid, type: data.entitiesByName[type].id, ...position,
    velocity: { x: 0, y: 0, z: 0 },
    yaw: 0, pitch: 0, headPitch: 0, objectData: 0
  })
}

function guidePosition(x) {
  return {
    entityId: guideEntityId, x, y: 64, z: 2.5, dx: 0, dy: 0, dz: 0, yaw: 0, pitch: 0, onGround: true
  }
}

async function loopback(t, { guide = false, pickup, sectionUpdate = false, resource = 'dirt', obstacles = [] } = {}) {
  const server = protocol.createServer({
    host: '127.0.0.1', port: 0, version: javaVersion, 'online-mode': false, hideErrors: true
  })
  const chunk = new Chunk()
  const movements = []
  const digs = []
  const digging = Promise.withResolvers()
  const following = Promise.withResolvers()
  const pickupProcessed = Promise.withResolvers()
  let connectedClient
  let joins = 0
  let dropPosition
  let pickupSent = false
  let playerLoaded = false
  const stone = data.blocksByName.stone.defaultState
  for (let x = 0; x < 16; x++) {
    for (let z = 0; z < 16; z++) {
      chunk.setBlockStateId(new Vec3(x, 63, z), stone)
    }
  }
  for (const { x, y, z } of obstacles) {
    chunk.setBlockStateId(new Vec3(x, y, z), stone)
  }
  if (pickup) {
    const { x, y, z } = pickupPosition
    chunk.setBlockStateId(new Vec3(x, y, z), data.blocksByName[resource].defaultState)
  }

  server.on('playerJoin', client => {
    connectedClient = client
    joins++
    client.on('player_loaded', () => { playerLoaded = true })
    client.write('login', { ...data.loginPacket, entityId: client.id })
    client.write('map_chunk', {
      x: 0, z: 0, heightmaps: [], chunkData: chunk.dump(), blockEntities: [], ...chunk.dumpLight()
    })
    if (guide) {
      client.write('player_info', guideInfo)
      spawnEntity(client, guideEntityId, guideId, 'player', { x: 7.5, y: 64, z: 2.5 })
    }
    client.write('position', { ...spawn, teleportId: 1, dx: 0, dy: 0, dz: 0, yaw: 0, pitch: 0, flags: {} })
    client.write('update_health', { health: 20, food: 20, foodSaturation: 5 })

    const item = {
      itemCount: 1, itemId: data.itemsByName[resource].id,
      addedComponentCount: 0, removedComponentCount: 0, components: [], removeComponents: []
    }
    const sendPickup = () => {
      pickupSent = true
      client.write('collect', { collectedEntityId: 11, collectorEntityId: client.id, pickupItemCount: 1 })
      if (pickup !== 'unconfirmed') client.write('set_player_inventory', { slotId: 0, contents: item })
      if (pickup === 'pending') {
        // The reply proves the bot processed the collect and inventory packets in order.
        client.write('keep_alive', { keepAliveId: pickupFence })
      } else {
        client.write('entity_destroy', { entityIds: [11] })
      }
    }
    client.on('keep_alive', ({ keepAliveId }) => {
      if (BigInt(keepAliveId) === pickupFence) pickupProcessed.resolve()
    })
    const onMovement = position => {
      movements.push(position.x)
      if (guide && position.x > spawn.x + 0.25) following.resolve()
      if (!dropPosition || pickupSent || Math.hypot(position.x - dropPosition.x, position.z - dropPosition.z) > 0.9) return
      sendPickup()
    }
    client.on('position', onMovement)
    client.on('position_look', onMovement)
    client.on('block_dig', ({ status, location }) => {
      digs.push({ status, location })
      if (status === 0) digging.resolve(location)
      if (status !== 2 || !pickup) return
      const { x, y, z } = pickupPosition
      dropPosition = { x: x + 0.5, y: y + 0.25, z: z + 0.5 }
      const spawnDrop = () => spawnEntity(client, 11, dropId, 'item', dropPosition)
      if (pickup === 'unrelated') spawnDrop()
      const air = data.blocksByName.air.defaultState
      if (sectionUpdate) {
        const record = (air << 12) | (x << 8) | (z << 4) | (y & 15)
        client.write('multi_block_change', { chunkCoordinates: { x: 0, y: 4, z: 0 }, records: [record] })
      } else {
        client.write('block_change', { location: pickupPosition, type: air })
      }
      if (pickup !== 'unrelated') spawnDrop()
      client.write('entity_metadata', {
        entityId: 11,
        metadata: [{ key: data.supportFeature('metadataIxOfItem'), type: 'item_stack', value: item }]
      })
      if (pickup === 'unrelated') sendPickup()
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
    config, game, movements, digs, digging: digging.promise, following: following.promise,
    pickupProcessed: pickupProcessed.promise,
    get client() { return connectedClient },
    get joins() { return joins },
    loaded: () => playerLoaded, sentPickup: () => pickupSent
  }
}

test('Java 1.21.11 loopback follows a moving guide to completion', { timeout: 10_000 }, async t => {
  const fixture = await loopback(t, { guide: true })
  const { game } = fixture
  assert.equal((await game.connect()).connection, 'connected')
  const followed = game.follow({ player: 'Guide', seconds: 3 })
  await fixture.following
  fixture.client.write('sync_entity_position', guidePosition(10.5))
  assert.deepEqual(await followed, { followed: true, seconds: 3 })
  assert.equal(fixture.loaded(), true)
  assert.ok(fixture.movements.some(x => x > 7))
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

test('the shipped runner rejects an occluded dig, stops a detour and collects on the same connection', { timeout: 15_000 }, async t => {
  const wallX = pickupPosition.x - 1
  const openingZ = 5
  const obstacles = Array.from({ length: 16 }, (_, z) => [64, 65].map(y => ({ x: wallX, y, z }))).flat()
  const fixture = await loopback(t, { guide: true, pickup: 'confirmed', resource: 'oak_log', obstacles })
  const { client } = await startStdio(t, fixture.config)
  assert.equal((await client.callTool({ name: 'connect' })).structuredContent.connection, 'connected')

  const collect = { name: 'collect', arguments: { block: 'oak_log', count: 1, radius: 8 } }
  const blocked = await Promise.race([client.callTool(collect), fixture.digging.then(() => null)])
  assert.ok(blocked, 'The blocked collection sent a dig packet')
  assert.equal(blocked.isError, true)
  assert.equal(blocked.structuredContent.code, 'UNREACHABLE')
  assert.deepEqual(blocked.structuredContent.receipt, { block: 'oak_log', requested: 1, collected: 0 })

  const terrainFence = 826_056_318_267n
  const passageApplied = once(fixture.client, 'keep_alive')
  for (const location of obstacles.filter(position => position.z === openingZ)) {
    fixture.client.write('block_change', { location, type: data.blocksByName.air.defaultState })
  }
  fixture.client.write('keep_alive', { keepAliveId: terrainFence })
  const [reply] = await passageApplied
  assert.equal(BigInt(reply.keepAliveId), terrainFence)

  const crossed = Promise.withResolvers()
  const observePassage = ({ x, z }) => {
    if (x > wallX + 0.5 && Math.abs(z - (openingZ + 0.5)) < 0.75) crossed.resolve()
  }
  fixture.client.on('position', observePassage)
  fixture.client.on('position_look', observePassage)
  const follow = client.callTool({ name: 'follow', arguments: { player: 'Guide', seconds: 20 } })
  try {
    await Promise.race([crossed.promise, follow.then(() => assert.fail('Follow ended before reaching the passage'))])
  } finally {
    fixture.client.off('position', observePassage)
    fixture.client.off('position_look', observePassage)
  }
  assert.equal((await client.callTool({ name: 'stop' })).structuredContent.stopped, true)
  assert.equal((await follow).structuredContent.code, 'CANCELED')
  assert.deepEqual((await client.callTool({ name: 'status' })).structuredContent, {
    connection: 'connected', action: null, stopping: false
  })
  assert.deepEqual(fixture.digs, [])

  const collected = await client.callTool(collect)
  assert.deepEqual(collected.structuredContent, { block: 'oak_log', requested: 1, collected: 1 })
  assert.deepEqual(fixture.digs, [{ status: 0, location: pickupPosition }, { status: 2, location: pickupPosition }])
  assert.equal(fixture.sentPickup(), true)
  assert.equal(fixture.joins, 1)
  assert.equal((await client.callTool({ name: 'disconnect' })).structuredContent.connection, 'disconnected')
})

test('Java 1.21.11 loopback manual stop cancels movement and follow stays idle', { timeout: 10_000 }, async t => {
  const fixture = await loopback(t, { guide: true })
  const { game } = fixture
  await game.connect()
  const canceled = assert.rejects(game.follow({ player: 'Guide', seconds: 5 }), { code: 'CANCELED' })
  await fixture.following
  const stoppedAt = fixture.movements.at(-1)
  assert.deepEqual(game.stop(), { stopped: true, connection: 'connected', action: 'follow', stopping: true })
  await canceled

  fixture.client.write('sync_entity_position', guidePosition(12.5))
  await delay(750)
  assert.ok(fixture.movements.every(x => x < stoppedAt + 0.75))
  assert.deepEqual(game.status(), { connection: 'connected', action: null, stopping: false })
})

test('Java 1.21.11 loopback follow ends when the guide leaves and returns in one bundle', { timeout: 10_000 }, async t => {
  const fixture = await loopback(t, { guide: true })
  const { game } = fixture
  await game.connect()
  await assert.rejects(game.follow({ player: 'Missing', seconds: 2 }), { code: 'PLAYER_UNAVAILABLE' })

  const unavailable = assert.rejects(game.follow({ player: 'Guide', seconds: 2 }), { code: 'PLAYER_UNAVAILABLE' })
  await fixture.following
  fixture.client.writeBundle([
    ['player_remove', { players: [guideId] }],
    ['player_info', guideInfo],
    ['sync_entity_position', guidePosition(12.5)]
  ])
  await unavailable
  const stoppedAt = fixture.movements.at(-1)
  await delay(750)
  assert.ok(fixture.movements.every(x => x < stoppedAt + 0.75))
  assert.deepEqual(game.status(), { connection: 'connected', action: null, stopping: false })
})

test('Java 1.21.11 loopback follow ends when the guide crosses the leash', { timeout: 10_000 }, async t => {
  const fixture = await loopback(t, { guide: true })
  const { game } = fixture
  await game.connect()
  const outOfRange = assert.rejects(game.follow({ player: 'Guide', seconds: 2 }), { code: 'OUT_OF_RANGE' })
  await fixture.following
  fixture.client.writeBundle([
    ['sync_entity_position', guidePosition(19.5)],
    ['sync_entity_position', guidePosition(12.5)]
  ])
  await outOfRange
  assert.equal(game.status().action, null)
})

test('Java 1.21.11 loopback disconnect interrupts follow without reconnecting or replaying', { timeout: 10_000 }, async t => {
  const fixture = await loopback(t, { guide: true })
  const { game } = fixture
  await game.connect()
  const interrupted = assert.rejects(game.follow({ player: 'Guide', seconds: 5 }), { code: 'DISCONNECTED' })
  await fixture.following
  fixture.client.socket.destroy()
  await interrupted

  await delay(250)
  assert.equal(fixture.joins, 1)
  assert.deepEqual(game.status(), { connection: 'disconnected', action: null, stopping: false })
  const beforeReconnect = fixture.movements.length
  await game.connect()
  await delay(750)
  assert.equal(fixture.joins, 2)
  assert.ok(fixture.movements.length > beforeReconnect)
  assert.ok(fixture.movements.slice(beforeReconnect).every(x => x === spawn.x))
  assert.deepEqual(game.status(), { connection: 'connected', action: null, stopping: false })
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
  assert.deepEqual(fixture.digs.filter(dig => dig.status === 2), [{ status: 2, location: pickupPosition }])
})

test('Java 1.21.11 loopback collection returns a receipt for a completed pickup', { timeout: 10_000 }, async t => {
  const fixture = await loopback(t, { pickup: 'confirmed' })
  await fixture.game.connect()
  assert.deepEqual(await fixture.game.collect({ block: 'dirt', count: 1, radius: 5 }), {
    block: 'dirt', requested: 1, collected: 1
  })
  assert.equal(fixture.sentPickup(), true)
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

test('Java 1.21.11 loopback collection rejects a same-type drop spawned before the block broke', { timeout: 10_000 }, async t => {
  const fixture = await loopback(t, { pickup: 'unrelated' })
  await fixture.game.connect()
  await assert.rejects(fixture.game.collect({ block: 'dirt', count: 1, radius: 5 }), error => {
    assert.equal(error.code, 'NO_PICKUP')
    assert.deepEqual(error.receipt, { block: 'dirt', requested: 1, collected: 0 })
    return true
  })
  assert.equal(fixture.sentPickup(), true)
  assert.deepEqual(fixture.digs.filter(dig => dig.status === 2), [{ status: 2, location: pickupPosition }])
})

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
  assert.deepEqual(fixture.digs.filter(dig => dig.status === 2), [{ status: 2, location: pickupPosition }])
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
  assert.deepEqual(await fixture.digging, pickupPosition)
  assert.equal(fixture.game.stop().connection, 'disconnected')
  await stopped
  assert.equal(fixture.digs.some(dig => dig.status === 2), false)
  assert.equal(fixture.sentPickup(), false)
})
