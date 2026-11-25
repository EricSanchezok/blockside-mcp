import assert from 'node:assert/strict'
import { on, once } from 'node:events'
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

function inventoryItem(name, itemCount = 1) {
  return itemCount ? {
    itemCount, itemId: data.itemsByName[name].id,
    addedComponentCount: 0, removedComponentCount: 0, components: [], removeComponents: []
  } : { itemCount: 0 }
}

function craftingInventory({ logs = 0, planks = 0, outcome = 'confirmed', otherLogSlots = [] }) {
  const stack = (name, count = 1) => inventoryItem(name, count)
  const slots = Array.from({ length: 46 }, () => stack(null, 0))
  slots[36] = stack('oak_log', logs)
  slots[9] = stack('oak_planks', planks)
  for (const slot of otherLogSlots) slots[slot] = stack('oak_log')
  const gridEntered = Promise.withResolvers()
  const foreignClick = Promise.withResolvers()
  const firstClick = Promise.withResolvers()
  const heldBatch = Promise.withResolvers()
  const unresolvedObserved = Promise.withResolvers()
  let statsRequests = 0
  const snapshots = []
  const clicks = []
  let stateId = outcome === 'wrap-revision' ? 32765 : 4
  const nextRevision = () => { stateId = (stateId + 1) & 0x7fff; return stateId }
  return {
    attach(client) {
      let ready = false
      let resultTaken = false
      let ingredientSlot = 36
      let acceptedBatches = 0
      let syncs = 0
      let finishLateBatch
      const sendResult = item => client.write('set_slot', { windowId: 0, stateId: nextRevision(), slot: 0, item })
      client.on('client_command', ({ actionId }) => {
        if (actionId === 'request_stats') statsRequests++
      })
      client.on('window_click', ({ windowId, slot, mode }) => {
        if (windowId !== 0) {
          foreignClick.resolve({ windowId, slot })
          return
        }
        if (mode === 5) {
          if ((outcome === 'hold-second-sync' && acceptedBatches === 2) ||
              (outcome === 'hold-gather-sync' && syncs === 1)) {
            heldBatch.resolve()
            return
          }
          if (syncs === 1 && ['stale-revision', 'same-revision', 'unversioned-player', 'unversioned-cursor',
            'snapshot-before-slot'].includes(outcome)) {
            const oldItems = slots.slice()
            const emptyItem = stack(null, 0)
            slots[36] = emptyItem
            const before = nextRevision()
            const removal = ['set_slot', { windowId: 0,
              stateId: outcome === 'same-revision' ? before : nextRevision(), slot: 36, item: emptyItem }]
            const snapshot = ['window_items', { windowId: 0,
              stateId: ['unversioned-player', 'unversioned-cursor'].includes(outcome) ? nextRevision() : before,
              items: oldItems, carriedItem: emptyItem }]
            if (outcome === 'unversioned-player') {
              client.writeBundle([['set_player_inventory', { slotId: 0, contents: emptyItem }], snapshot])
            } else if (outcome === 'unversioned-cursor') {
              client.writeBundle([['set_cursor_item', { contents: oldItems[36] }], snapshot])
            } else {
              client.writeBundle(outcome === 'snapshot-before-slot' ? [snapshot, removal] : [removal, snapshot])
            }
            return
          }
          if (outcome === 'lost-before-craft' && syncs === 1) slots[36] = stack(null, 0)
          const items = outcome === 'truncated' && syncs > 0 ? slots.slice(0, 9) : slots
          syncs++
          snapshots.push(acceptedBatches)
          if (outcome === 'foreign-revision' && syncs === 1) {
            client.write('set_slot', { windowId: 3, stateId: 256, slot: 36, item: stack(null, 0) })
          }
          client.write('window_items', { windowId: 0, stateId: nextRevision(), items, carriedItem: stack(null, 0) })
          const unresolved = outcome === 'unconfirmed' ? syncs === 2
            : ['unresolved', 'late-second', 'conflicting'].includes(outcome) && syncs === 3
          if (unresolved) {
            // The unsolicited response precedes any final evidence for this batch.
            client.write('statistics', { entries: [] })
            const marker = 903467821n
            const observed = ({ keepAliveId }) => {
              if (BigInt(keepAliveId) !== marker) return
              client.off('keep_alive', observed)
              unresolvedObserved.resolve(finishLateBatch)
            }
            client.on('keep_alive', observed)
            client.write('keep_alive', { keepAliveId: marker })
          }
          return
        }

        clicks.push(slot)
        firstClick.resolve(slot)
        if (slot >= 1 && slot <= 4) {
          gridEntered.resolve()
          if (outcome === 'pending') return
          if (outcome === 'hold-second-grid' && acceptedBatches === 1) {
            heldBatch.resolve()
            return
          }
          ready = slots[ingredientSlot].itemCount > 0
          if (outcome === 'stale-mid-batch') {
            const old = stateId
            client.writeBundle([
              ['set_slot', { windowId: 0, stateId: nextRevision(), slot: 0, item: stack('oak_planks', 4) }],
              ['set_slot', { windowId: 0, stateId: old, slot: 36, item: stack(null, 0) }]
            ])
            return
          }
          sendResult(stack('oak_planks', ready ? 4 : 0))
        } else if (slot === 0) {
          resultTaken = ready
          ready = false
          sendResult(stack(null, 0))
        } else if (resultTaken) {
          resultTaken = false
          if (outcome === 'unconfirmed' || (['unresolved', 'truncated'].includes(outcome) && acceptedBatches > 0)) return
          assert.ok(slot >= 9 && slot < 45)
          const commit = () => {
            const existing = slots[slot].itemId === data.itemsByName.oak_planks.id ? slots[slot].itemCount : 0
            slots[ingredientSlot] = stack('oak_log', slots[ingredientSlot].itemCount - 1)
            if (outcome !== 'conflicting' || acceptedBatches === 0) {
              slots[slot] = stack('oak_planks', existing + 4)
            }
            acceptedBatches++
          }
          if (outcome === 'late-second' && acceptedBatches === 1) {
            finishLateBatch = () => {
              commit()
              client.write('window_items', { windowId: 0, stateId: nextRevision(), items: slots, carriedItem: stack(null, 0) })
            }
            return
          }
          commit()
        } else if (slots[slot]?.itemId === data.itemsByName.oak_log.id) {
          ingredientSlot = slot
        }
      })
    },
    pickup(item) { slots[36] = item },
    nextRevision,
    count(name) {
      return slots.filter(slot => slot.itemId === data.itemsByName[name].id)
        .reduce((sum, slot) => sum + slot.itemCount, 0)
    },
    clicks,
    firstClick: firstClick.promise,
    snapshots,
    heldBatch: heldBatch.promise,
    unresolvedObserved: unresolvedObserved.promise,
    get statsRequests() { return statsRequests },
    foreignClick: foreignClick.promise,
    gridEntered: gridEntered.promise
  }
}

async function loopback(t, { guide = false, pickup, sectionUpdate = false, resource = 'dirt', obstacles = [], crafting } = {}) {
  const server = protocol.createServer({
    host: '127.0.0.1', port: 0, version: javaVersion, 'online-mode': false, hideErrors: true
  })
  const chunk = new Chunk()
  const movements = []
  const digs = []
  const digging = Promise.withResolvers()
  const grounded = Promise.withResolvers()
  const following = Promise.withResolvers()
  const pickupProcessed = Promise.withResolvers()
  const craft = crafting && craftingInventory(crafting)
  const early = pickup?.startsWith('early-')
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
    craft?.attach(client)
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

    const item = inventoryItem(resource, 1)
    const sendStock = contents => {
      craft?.pickup(contents)
      if (early) client.write('set_slot', { windowId: 0, stateId: craft?.nextRevision() ?? 6, slot: 36, item: contents })
      else client.write('set_player_inventory', { slotId: 0, contents })
    }
    const sendPickup = () => {
      pickupSent = true
      const collect = id => client.write('collect', { collectedEntityId: id, collectorEntityId: client.id, pickupItemCount: 1 })
      if (pickup === 'early-stock-first') sendStock(item)
      if (pickup !== 'early-stock-only') collect(pickup === 'early-wrong-entity' ? 12 : 11)
      if (pickup === 'early-second-pickup') collect(12)
      if (pickup !== 'unconfirmed' && pickup !== 'early-stock-first') {
        sendStock(pickup === 'early-extra-stock' ? inventoryItem(resource, 2) : item)
      }
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
    const observeGround = ({ flags }) => {
      if (flags?.onGround) grounded.resolve()
    }
    client.on('flying', observeGround)
    client.on('look', observeGround)
    const onMovement = position => {
      observeGround(position)
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
      const sendMetadata = () => client.write('entity_metadata', {
        entityId: 11,
        metadata: [{ key: data.supportFeature('metadataIxOfItem'), type: 'item_stack', value: item }]
      })
      if (pickup === 'unrelated' || early) spawnDrop()
      if (early) sendMetadata()
      const air = data.blocksByName.air.defaultState
      if (sectionUpdate) {
        const record = (air << 12) | (x << 8) | (z << 4) | (y & 15)
        client.write('multi_block_change', { chunkCoordinates: { x: 0, y: 4, z: 0 }, records: [record] })
      } else {
        client.write('block_change', { location: pickupPosition, type: air })
      }
      if (pickup !== 'unrelated' && !early) spawnDrop()
      sendMetadata()
      if (pickup === 'unrelated' || early) sendPickup()
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
    config, game, movements, digs, craft, digging: digging.promise, grounded: grounded.promise, following: following.promise,
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
  const keepAlives = on(fixture.client, 'keep_alive', { signal: t.signal })
  for (const location of obstacles.filter(position => position.z === openingZ)) {
    fixture.client.write('block_change', { location, type: data.blocksByName.air.defaultState })
  }
  fixture.client.write('keep_alive', { keepAliveId: terrainFence })
  for await (const [{ keepAliveId }] of keepAlives) {
    if (BigInt(keepAliveId) === terrainFence) break
  }

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

test('Java 1.21.11 loopback rejects harvest attribution for a same-type drop spawned before air', { timeout: 10_000 }, async t => {
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

const makeOakPlanks = { name: 'craft', arguments: { item: 'oak_planks', count: 4 } }
const makeTwoBatches = { name: 'craft', arguments: { item: 'oak_planks', count: 8 } }

async function observeUnresolvedBatch(client, fixture, pending) {
  const finish = await Promise.race([
    fixture.craft.unresolvedObserved,
    pending.then(result => assert.fail(JSON.stringify(result.structuredContent)))
  ])
  assert.equal((await client.callTool({ name: 'status' })).structuredContent.action, 'craft')
  assert.equal(fixture.craft.statsRequests, 0)
  return finish
}

const observedIngredient = { block: 'oak_log', requested: 1, collected: 0, observedAcquired: 1 }

for (const outcome of ['stale-revision', 'same-revision', 'unversioned-player', 'unversioned-cursor', 'snapshot-before-slot']) {
  test(`Java 1.21.11 sends no craft click for ${outcome} inventory`, { timeout: 10_000 }, async t => {
    const fixture = await loopback(t, {
      pickup: 'early-confirmed', resource: 'oak_log', crafting: { outcome }
    })
    const { client } = await startStdio(t, { ...fixture.config, draftCraft: true })
    assert.equal((await client.callTool({ name: 'connect' })).structuredContent.connection, 'connected')
    await fixture.grounded
    const result = await Promise.race([
      client.callTool(makeOakPlanks),
      fixture.craft.firstClick.then(slot => assert.fail(`Stale inventory sent a craft click to slot ${slot}`))
    ])
    assert.equal(result.isError, true)
    assert.equal(result.structuredContent.code, 'CRAFT_UNCONFIRMED')
    assert.deepEqual(fixture.craft.clicks, [])
    assert.equal(fixture.craft.count('oak_log'), 0)
    assert.equal(fixture.craft.count('oak_planks'), 0)
    assert.deepEqual(fixture.digs.map(dig => dig.status), [0, 2])
  })
}

for (const outcome of ['foreign-revision', 'wrap-revision']) {
  test(`Java 1.21.11 uses a current player snapshot through ${outcome}`, { timeout: 10_000 }, async t => {
    const gather = outcome === 'foreign-revision'
    const fixture = await loopback(t, {
      pickup: gather ? 'early-confirmed' : undefined,
      resource: 'oak_log', crafting: { outcome, logs: gather ? 0 : 1 }
    })
    const { client } = await startStdio(t, { ...fixture.config, draftCraft: true })
    assert.equal((await client.callTool({ name: 'connect' })).structuredContent.connection, 'connected')
    if (gather) await fixture.grounded
    const result = await client.callTool(makeOakPlanks)
    assert.deepEqual(result.structuredContent, {
      item: 'oak_planks', requested: 4, crafted: 4, ...(gather ? { ingredients: observedIngredient } : {})
    })
    assert.equal(fixture.craft.count('oak_planks'), 4)
  })
}

test('Java 1.21.11 refuses further craft clicks when an older correction arrives mid-batch', { timeout: 10_000 }, async t => {
  const fixture = await loopback(t, {
    crafting: { logs: 1, outcome: 'stale-mid-batch' }
  })
  const { client } = await startStdio(t, { ...fixture.config, draftCraft: true })
  assert.equal((await client.callTool({ name: 'connect' })).structuredContent.connection, 'connected')
  const result = await client.callTool(makeOakPlanks)
  assert.equal(result.isError, true)
  assert.equal(result.structuredContent.code, 'CRAFT_UNCONFIRMED')
  assert.ok(fixture.craft.clicks.length > 0)
  assert.equal(fixture.craft.clicks.includes(0), false)
  assert.equal(fixture.craft.count('oak_planks'), 0)
})

for (const draftCraft of [false, true]) {
  const label = draftCraft ? 'includes observed stock in draft receipts' : 'keeps the default collection receipt'
  test(`Java 1.21.11 early pickup ${label}`, { timeout: 10_000 }, async t => {
    const fixture = await loopback(t, { pickup: 'early-confirmed', resource: 'oak_log' })
    const { client } = await startStdio(t, draftCraft ? { ...fixture.config, draftCraft } : fixture.config)
    assert.equal((await client.callTool({ name: 'connect' })).structuredContent.connection, 'connected')
    assert.equal(fixture.client.protocolVersion, 774)
    await fixture.grounded
    const result = await client.callTool({ name: 'collect', arguments: { block: 'oak_log', count: 1, radius: 8 } })
    assert.equal(result.isError, true)
    assert.equal(result.structuredContent.code, 'NO_PICKUP')
    assert.deepEqual(result.structuredContent.receipt, draftCraft
      ? observedIngredient
      : { block: 'oak_log', requested: 1, collected: 0 })
    assert.deepEqual(fixture.digs.map(dig => dig.status), [0, 2])
  })
}

for (const logs of [1, 0]) {
  const label = logs ? 'uses preexisting material without a gather receipt' : 'uses verified usable stock through the same gather action'
  test(`Java 1.21.11 craft ${label}`, { timeout: 10_000 }, async t => {
    const fixture = await loopback(t, {
      pickup: 'early-confirmed', resource: 'oak_log', crafting: { logs }
    })
    const { client } = await startStdio(t, { ...fixture.config, draftCraft: true })
    assert.equal((await client.callTool({ name: 'connect' })).structuredContent.connection, 'connected')
    assert.equal(fixture.client.protocolVersion, 774)
    if (!logs) await fixture.grounded
    const result = await client.callTool(makeOakPlanks)
    assert.deepEqual(result.structuredContent, {
      item: 'oak_planks', requested: 4, crafted: 4, ...(!logs ? { ingredients: observedIngredient } : {})
    })
    assert.equal(fixture.craft.count('oak_log'), 0)
    assert.equal(fixture.craft.count('oak_planks'), 4)
    assert.equal(fixture.sentPickup(), !logs)
    assert.deepEqual(fixture.digs.map(dig => dig.status), logs ? [] : [0, 2])
  })
}

for (const { pickup, outcome, logs, acquisition } of [
  { pickup: 'early-stock-only', logs: 1 },
  { pickup: 'early-stock-first', logs: 1 },
  { pickup: 'early-extra-stock', logs: 2 },
  { pickup: 'early-wrong-entity', logs: 1 },
  { pickup: 'early-second-pickup', logs: 1 },
  { pickup: 'early-confirmed', outcome: 'lost-before-craft', logs: 0, acquisition: 1 }
]) {
  test(`Java 1.21.11 craft refuses unreliable usable stock from ${outcome ?? pickup}`, { timeout: 10_000 }, async t => {
    const fixture = await loopback(t, {
      pickup, resource: 'oak_log', crafting: { outcome }
    })
    const { client } = await startStdio(t, { ...fixture.config, draftCraft: true })
    assert.equal((await client.callTool({ name: 'connect' })).structuredContent.connection, 'connected')
    await fixture.grounded
    const result = await client.callTool(makeOakPlanks)
    assert.equal(result.isError, true)
    assert.equal(result.structuredContent.code, 'NO_PICKUP')
    assert.deepEqual(result.structuredContent.receipt, {
      block: 'oak_log', requested: 1, collected: 0, ...(acquisition ? { observedAcquired: acquisition } : {})
    })
    assert.equal(fixture.craft.count('oak_log'), logs)
    assert.equal(fixture.craft.count('oak_planks'), 0)
    assert.deepEqual(fixture.craft.clicks, [])
    assert.deepEqual(fixture.digs.map(dig => dig.status), [0, 2])
  })
}

for (const code of ['CANCELED', 'DEADLINE']) {
  test(`Java 1.21.11 craft respects ${code} while rechecking usable stock`, { timeout: 30_000 }, async t => {
    const fixture = await loopback(t, {
      pickup: 'early-confirmed', resource: 'oak_log',
      crafting: { outcome: 'hold-gather-sync' }
    })
    const { client } = await startStdio(t, { ...fixture.config, draftCraft: true })
    assert.equal((await client.callTool({ name: 'connect' })).structuredContent.connection, 'connected')
    await fixture.grounded
    const pending = client.callTool(makeOakPlanks)
    await Promise.race([fixture.craft.heldBatch, pending.then(result => assert.fail(JSON.stringify(result.structuredContent)))])
    const disconnected = once(fixture.client, 'end')
    if (code === 'CANCELED') assert.equal((await client.callTool({ name: 'stop' })).structuredContent.stopped, true)
    const result = await pending
    await disconnected
    assert.equal(result.structuredContent.code, code)
    assert.deepEqual(fixture.craft.clicks, [])
    assert.equal(fixture.craft.count('oak_log'), 1)
    assert.equal(fixture.craft.count('oak_planks'), 0)
    assert.equal(fixture.joins, 1)
    assert.deepEqual((await client.callTool({ name: 'status' })).structuredContent, {
      connection: 'disconnected', action: null, stopping: false
    })
  })
}

for (const logs of [1, 0]) {
  const label = logs ? 'uses a log already in inventory' : 'collects a missing log first'
  test(`shipped stdio crafting ${label}`, { timeout: 10_000 }, async t => {
    const fixture = await loopback(t, { pickup: 'confirmed', resource: 'oak_log', crafting: { logs, planks: 4 } })
    const { client } = await startStdio(t, { ...fixture.config, draftCraft: true })
    assert.equal((await client.callTool({ name: 'connect' })).structuredContent.connection, 'connected')
    if (!logs) await fixture.grounded
    const result = await client.callTool(makeOakPlanks)
    assert.deepEqual(result.structuredContent, { item: 'oak_planks', requested: 4, crafted: 4 })
    assert.equal(fixture.craft.count('oak_log'), 0)
    assert.equal(fixture.craft.count('oak_planks'), 8)
    assert.equal(fixture.sentPickup(), logs === 0)
    assert.deepEqual(fixture.digs.map(dig => dig.status), logs ? [] : [0, 2])
  })
}

test('shipped stdio crafting requires a server-confirmed gain beyond existing planks', { timeout: 10_000 }, async t => {
  const fixture = await loopback(t, { crafting: { logs: 1, planks: 4, outcome: 'unconfirmed' } })
  const { client } = await startStdio(t, { ...fixture.config, draftCraft: true })
  assert.equal((await client.callTool({ name: 'connect' })).structuredContent.connection, 'connected')
  const pending = client.callTool(makeOakPlanks)
  await observeUnresolvedBatch(client, fixture, pending)
  assert.equal((await client.callTool({ name: 'stop' })).structuredContent.stopped, true)
  const result = await pending
  assert.equal(result.isError, true)
  assert.equal(result.structuredContent.code, 'CANCELED')
  assert.ok(fixture.craft.clicks.includes(0))
  assert.equal(fixture.craft.count('oak_log'), 1)
  assert.equal(fixture.craft.count('oak_planks'), 4)
  assert.equal(result.structuredContent.receipt, undefined)
})

test('shipped stdio stop cancels the admitted craft before taking the result', { timeout: 10_000 }, async t => {
  const fixture = await loopback(t, { pickup: 'confirmed', resource: 'oak_log', crafting: { outcome: 'pending' } })
  const { client } = await startStdio(t, { ...fixture.config, draftCraft: true })
  assert.equal((await client.callTool({ name: 'connect' })).structuredContent.connection, 'connected')
  await fixture.grounded
  const pending = client.callTool(makeOakPlanks)
  await Promise.race([fixture.craft.gridEntered, pending.then(result => assert.fail(JSON.stringify(result.structuredContent)))])
  assert.equal(fixture.sentPickup(), true)
  assert.equal((await client.callTool({ name: 'status' })).structuredContent.action, 'craft')
  assert.equal((await client.callTool(makeOakPlanks)).structuredContent.code, 'BUSY')
  const ended = once(fixture.client, 'end')
  assert.equal((await client.callTool({ name: 'stop' })).structuredContent.stopped, true)
  const result = await pending
  assert.equal(result.structuredContent.code, 'CANCELED')
  assert.equal(result.structuredContent.receipt, undefined)
  await ended
  assert.equal(fixture.craft.clicks.includes(0), false)
  assert.equal(fixture.craft.count('oak_planks'), 0)
  assert.equal(fixture.joins, 1)
})

test('shipped stdio crafting returns late exact success despite unsolicited statistics', { timeout: 10_000 }, async t => {
  const fixture = await loopback(t, {
    crafting: { logs: 1, otherLogSlots: [12], planks: 4, outcome: 'late-second' }
  })
  const { client } = await startStdio(t, { ...fixture.config, draftCraft: true })
  assert.equal((await client.callTool({ name: 'connect' })).structuredContent.connection, 'connected')
  const pending = client.callTool(makeTwoBatches)
  const finish = await observeUnresolvedBatch(client, fixture, pending)
  finish()
  const result = await pending
  assert.notEqual(result.isError, true)
  assert.deepEqual(result.structuredContent, { item: 'oak_planks', requested: 8, crafted: 8 })
  assert.equal(fixture.craft.count('oak_log'), 0)
  assert.equal(fixture.craft.count('oak_planks'), 12)
  assert.deepEqual(fixture.craft.snapshots, [0, 1, 1])
  assert.equal(fixture.craft.clicks.filter(slot => slot === 0).length, 2)
  assert.equal(fixture.craft.statsRequests, 0)
  t.diagnostic(JSON.stringify(result.structuredContent))
})

test('shipped stdio crafting retains the confirmed batch when the second stays unresolved', { timeout: 30_000 }, async t => {
  const fixture = await loopback(t, {
    crafting: { logs: 1, otherLogSlots: [12], planks: 4, outcome: 'unresolved' }
  })
  const { client } = await startStdio(t, { ...fixture.config, draftCraft: true })
  assert.equal((await client.callTool({ name: 'connect' })).structuredContent.connection, 'connected')
  const pending = client.callTool(makeTwoBatches)
  await observeUnresolvedBatch(client, fixture, pending)
  const disconnected = once(fixture.client, 'end')
  const result = await pending
  await disconnected
  assert.equal(result.isError, true)
  assert.equal(result.structuredContent.code, 'DEADLINE')
  assert.deepEqual(result.structuredContent.receipt, { item: 'oak_planks', requested: 8, crafted: 4, remaining: null })
  assert.equal(fixture.craft.count('oak_log'), 1)
  assert.equal(fixture.craft.count('oak_planks'), 8)
  assert.deepEqual(fixture.craft.snapshots, [0, 1, 1])
  assert.equal(fixture.craft.clicks.filter(slot => slot === 0).length, 2)
  assert.equal(fixture.craft.statsRequests, 0)
  t.diagnostic(JSON.stringify(result.structuredContent))
})

test('shipped stdio crafting keeps conflicting inventory unresolved', { timeout: 10_000 }, async t => {
  const fixture = await loopback(t, { crafting: { logs: 1, otherLogSlots: [12], planks: 4, outcome: 'conflicting' } })
  const { client } = await startStdio(t, { ...fixture.config, draftCraft: true })
  assert.equal((await client.callTool({ name: 'connect' })).structuredContent.connection, 'connected')
  const pending = client.callTool(makeTwoBatches)
  await observeUnresolvedBatch(client, fixture, pending)
  assert.equal((await client.callTool({ name: 'stop' })).structuredContent.stopped, true)
  const result = await pending
  assert.equal(result.structuredContent.code, 'CANCELED')
  assert.deepEqual(result.structuredContent.receipt, { item: 'oak_planks', requested: 8, crafted: 4, remaining: null })
  assert.equal(fixture.craft.count('oak_log'), 0)
  assert.equal(fixture.craft.count('oak_planks'), 8)
  assert.equal(fixture.craft.clicks.filter(slot => slot === 0).length, 2)
})

test('shipped stdio crafting rejects a truncated inventory frame', { timeout: 10_000 }, async t => {
  const fixture = await loopback(t, { crafting: { logs: 1, otherLogSlots: [12], planks: 4, outcome: 'truncated' } })
  const { client } = await startStdio(t, { ...fixture.config, draftCraft: true })
  assert.equal((await client.callTool({ name: 'connect' })).structuredContent.connection, 'connected')
  const result = await client.callTool(makeTwoBatches)
  assert.equal(result.isError, true)
  assert.equal(result.structuredContent.code, 'CRAFT_UNCONFIRMED')
  assert.match(result.structuredContent.message, /Check the current inventory/)
  assert.equal(result.structuredContent.receipt, undefined)
  assert.equal(fixture.craft.count('oak_log'), 1)
  assert.equal(fixture.craft.count('oak_planks'), 8)
  assert.equal(fixture.craft.clicks.filter(slot => slot === 0).length, 1)
})

for (const { code, outcome, actualBatches } of [
  { code: 'CANCELED', outcome: 'hold-second-sync', actualBatches: 2 },
  { code: 'DEADLINE', outcome: 'hold-second-grid', actualBatches: 1 }
]) {
  test(`shipped stdio crafting preserves the confirmed batch on ${code}`, { timeout: 30_000 }, async t => {
    const fixture = await loopback(t, { crafting: { logs: 1, otherLogSlots: [12], planks: 4, outcome } })
    const { client } = await startStdio(t, { ...fixture.config, draftCraft: true })
    assert.equal((await client.callTool({ name: 'connect' })).structuredContent.connection, 'connected')
    const pending = client.callTool({ name: 'craft', arguments: { item: 'oak_planks', count: 8 } })
    await Promise.race([fixture.craft.heldBatch, pending.then(result => assert.fail(JSON.stringify(result.structuredContent)))])
    const disconnected = once(fixture.client, 'end')
    if (code === 'CANCELED') {
      const stop = await client.callTool({ name: 'stop' })
      assert.equal(stop.structuredContent.stopped, true)
      assert.equal(stop.structuredContent.connection, 'disconnected')
    }
    const result = await pending
    await disconnected
    assert.equal(result.isError, true)
    assert.equal(result.structuredContent.code, code)
    assert.deepEqual(result.structuredContent.receipt, { item: 'oak_planks', requested: 8, crafted: 4, remaining: null })
    assert.deepEqual(fixture.craft.snapshots, [0, 1])
    assert.equal(fixture.craft.count('oak_log'), 2 - actualBatches)
    assert.equal(fixture.craft.count('oak_planks'), 4 + 4 * actualBatches)
    assert.equal(fixture.craft.clicks.filter(slot => slot === 0).length, actualBatches)
    assert.equal(fixture.joins, 1)
    assert.deepEqual((await client.callTool({ name: 'status' })).structuredContent, {
      connection: 'disconnected', action: null, stopping: false
    })
  })
}

test('shipped stdio crafting reconciles twelve items across main inventory and hotbar stacks', { timeout: 10_000 }, async t => {
  const fixture = await loopback(t, { crafting: { logs: 1, otherLogSlots: [12, 13], planks: 4 } })
  const { client } = await startStdio(t, { ...fixture.config, draftCraft: true })
  assert.equal((await client.callTool({ name: 'connect' })).structuredContent.connection, 'connected')
  const result = await client.callTool({ name: 'craft', arguments: { item: 'oak_planks', count: 12 } })
  assert.deepEqual(result.structuredContent, { item: 'oak_planks', requested: 12, crafted: 12 })
  assert.equal(fixture.craft.count('oak_log'), 0)
  assert.equal(fixture.craft.count('oak_planks'), 16)
  assert.equal(fixture.craft.clicks.filter(slot => slot === 0).length, 3)
  assert.deepEqual(fixture.digs, [])
})

const containerOpens = [
  ['open_window', { windowId: 1, inventoryType: 0, windowTitle: { type: 'string', value: 'Fixture container' } }],
  ['open_horse_window', { windowId: 1, nbSlots: 2, entityId: 15 }]
]

for (const [packetName, packet] of containerOpens) {
  test(`shipped stdio crafting stops on ${packetName} before container contents arrive`, { timeout: 10_000 }, async t => {
    const fixture = await loopback(t, { crafting: { logs: 1, outcome: 'pending' } })
    const { client } = await startStdio(t, { ...fixture.config, draftCraft: true })
    assert.equal((await client.callTool({ name: 'connect' })).structuredContent.connection, 'connected')
    const pending = client.callTool(makeOakPlanks)
    await Promise.race([fixture.craft.gridEntered, pending.then(result => assert.fail(JSON.stringify(result.structuredContent)))])
    const disconnected = once(fixture.client, 'end')
    // The player's pending result arrives before the replacement window has contents.
    fixture.client.writeBundle([
      [packetName, packet],
      ['set_slot', { windowId: 0, stateId: 2, slot: 0, item: inventoryItem('oak_planks', 4) }]
    ])
    const result = await Promise.race([
      pending,
      fixture.craft.foreignClick.then(({ windowId, slot }) => assert.fail(`Craft clicked slot ${slot} in container ${windowId}`))
    ])
    await disconnected
    assert.equal(result.isError, true)
    assert.equal(result.structuredContent.code, 'DISCONNECTED')
    assert.equal(result.structuredContent.receipt, undefined)
    assert.equal(fixture.craft.clicks.includes(0), false)
    assert.equal(fixture.craft.count('oak_planks'), 0)
    assert.equal(fixture.joins, 1)
  })
}
