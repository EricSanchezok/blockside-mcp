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

const data = minecraftData(javaVersion)
const Chunk = createChunk(javaVersion)
const { Vec3 } = vec3
const dirt = { x: 4, y: 64, z: 2 }
const spawn = { x: 2.5, y: 64, z: 2.5 }
const guideId = '00000000-0000-4000-8000-000000000011'
const guideEntityId = 10
const guideInfo = {
  action: { add_player: true },
  data: [{ uuid: guideId, player: { name: 'Guide', properties: [] } }]
}
const dropId = '00000000-0000-4000-8000-000000000012'

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

async function loopback(t, { guide = false, pickup } = {}) {
  const server = protocol.createServer({
    host: '127.0.0.1', port: 0, version: javaVersion, 'online-mode': false, hideErrors: true
  })
  const chunk = new Chunk()
  const movements = []
  const digs = []
  const digging = Promise.withResolvers()
  const walking = Promise.withResolvers()
  let connectedClient
  let joins = 0
  let dropPosition
  let pickupSent = false
  let playerLoaded = false
  for (let x = 0; x < 16; x++) {
    for (let z = 0; z < 16; z++) {
      chunk.setBlockStateId(new Vec3(x, 63, z), data.blocksByName.stone.defaultState)
    }
  }
  if (pickup) chunk.setBlockStateId(new Vec3(dirt.x, dirt.y, dirt.z), data.blocksByName.dirt.defaultState)

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
      itemCount: 1, itemId: data.itemsByName.dirt.id,
      addedComponentCount: 0, removedComponentCount: 0, components: [], removeComponents: []
    }
    const onMovement = position => {
      movements.push(position.x)
      if (position.x > spawn.x + 0.5) walking.resolve(position.x)
      if (!dropPosition || pickupSent || Math.hypot(position.x - dropPosition.x, position.z - dropPosition.z) > 0.9) return
      pickupSent = true
      client.write('collect', { collectedEntityId: 11, collectorEntityId: client.id, pickupItemCount: 1 })
      if (pickup === 'confirmed') client.write('set_player_inventory', { slotId: 0, contents: item })
      client.write('entity_destroy', { entityIds: [11] })
    }
    client.on('position', onMovement)
    client.on('position_look', onMovement)
    client.on('block_dig', ({ status, location }) => {
      digs.push({ status, location })
      if (status === 0) digging.resolve(location)
      if (status !== 2 || !pickup) return
      client.write('block_change', { location: dirt, type: data.blocksByName.air.defaultState })
      dropPosition = { x: dirt.x + 0.5, y: dirt.y + 0.25, z: dirt.z + 0.5 }
      spawnEntity(client, 11, dropId, 'item', dropPosition)
      client.write('entity_metadata', {
        entityId: 11,
        metadata: [{ key: data.supportFeature('metadataIxOfItem'), type: 'item_stack', value: item }]
      })
    })
  })

  await once(server, 'listening')
  const host = '127.0.0.1'
  const port = server.socketServer.address().port
  const game = new GameController(mineflayerFactory({ host, port, auth: 'offline', profile: 'FixtureBot' }))
  t.after(async () => {
    game.disconnect()
    const closed = once(server, 'close')
    server.close()
    await closed
  })
  return {
    game, movements, digs, digging: digging.promise, walking: walking.promise,
    get client() { return connectedClient },
    get joins() { return joins },
    loaded: () => playerLoaded,
    sentPickup: () => pickupSent
  }
}

test('Java 1.21.11 loopback follows a moving guide and completes at the requested time', { timeout: 10_000 }, async t => {
  const fixture = await loopback(t, { guide: true })
  const { game } = fixture
  assert.equal((await game.connect()).connection, 'connected')
  const followed = game.follow({ player: 'Guide', seconds: 3 })
  await fixture.walking
  fixture.client.write('sync_entity_position', guidePosition(10.5))
  assert.deepEqual(await followed, { followed: true, seconds: 3 })
  assert.equal(fixture.loaded(), true)
  assert.ok(fixture.movements.some(x => x > 7))
  assert.equal(fixture.digs.length, 0)
  assert.equal(game.disconnect().connection, 'disconnected')
})

test('Java 1.21.11 loopback manual stop cancels movement and follow stays idle', { timeout: 10_000 }, async t => {
  const fixture = await loopback(t, { guide: true })
  const { game } = fixture
  await game.connect()
  const canceled = assert.rejects(game.follow({ player: 'Guide', seconds: 5 }), { code: 'CANCELED' })
  await fixture.walking
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
  await fixture.walking
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
  await fixture.walking
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
  await fixture.walking
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
  const fixture = await loopback(t, { pickup: 'confirmed' })
  await fixture.game.connect()
  await assert.rejects(fixture.game.collect({ block: 'dirt', count: 2, radius: 5 }), error => {
    assert.equal(error.code, 'NO_BLOCK')
    assert.deepEqual(error.receipt, { block: 'dirt', requested: 2, collected: 1 })
    return true
  })
  assert.equal(fixture.sentPickup(), true)
  assert.deepEqual(fixture.digs.filter(dig => dig.status === 2), [{ status: 2, location: dirt }])
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
