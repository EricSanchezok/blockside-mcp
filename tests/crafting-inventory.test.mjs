import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { createRequire } from 'node:module'
import { test } from 'node:test'
import { watchCraftingInventory } from '../src/crafting-inventory.mjs'
import { BlocksideError } from '../src/errors.mjs'

const require = createRequire(import.meta.url)
const { createSerializer, createDeserializer } = require('minecraft-protocol')
const wireVersion = { state: 'play', version: '26.1.2' }
const serializer = createSerializer({ ...wireVersion, isServer: true })
const deserializer = createDeserializer({ ...wireVersion, isServer: false })

const empty = { itemCount: 0 }
const oak = { itemId: 134, itemCount: 1, addedComponentCount: 0, removedComponentCount: 0, components: [], removeComponents: [] }
const full = (stateId, slot = empty) => {
  const items = Array.from({ length: 46 }, () => empty)
  items[36] = oak
  items[45] = slot
  return { name: 'window_items', params: { windowId: 0, stateId, items, carriedItem: empty } }
}
const setSlot = (stateId, slot = 45, item = empty, windowId = 0) => ({
  name: 'set_slot', params: { windowId, stateId, slot, item }
})
const decodeWire = packet => deserializer.parsePacketBuffer(serializer.createPacketBuffer(packet)).data

function fixture() {
  const bot = new EventEmitter()
  const client = new EventEmitter()
  const writes = []
  const signal = new AbortController().signal
  bot.inventory = { id: 0, slots: Array(46).fill(null) }
  bot._client = client
  client.write = (name, payload) => writes.push({ name, payload })
  bot.craft = async ({ stateId, beforeWrite }) => {
    beforeWrite?.()
    client.write('window_click', { windowId: 0, stateId, slot: 36 })
  }
  const inventory = watchCraftingInventory(bot)
  const emit = ({ name, params }) => client.emit(name, params)
  function sync(...packets) {
    bot._syncWindow = async () => {
      for (const packet of packets) emit(packet)
    }
    return inventory.sync(signal)
  }
  return { bot, inventory, emit, sync, writes, signal }
}

test('Paper 775 r8 pickup, r9 full and adjacent r10 empty offhand allow a current first click', async () => {
  const game = fixture()
  const pickup = decodeWire(setSlot(8, 36, oak))
  const snapshot = decodeWire(full(9))
  const offhand = decodeWire(setSlot(10))
  assert.deepEqual(snapshot.params.items[45], empty)
  assert.deepEqual(offhand.params.item, empty)
  game.emit(pickup)
  const ticket = await game.sync(snapshot, offhand)
  assert.equal(game.inventory.ticketFor(snapshot.params), ticket)
  assert.deepEqual(game.writes, [])
  await assert.rejects(game.inventory.craftBatch({ stateId: 9 }, game.signal, ticket), { code: 'CRAFT_UNCONFIRMED' })
  assert.deepEqual(game.writes, [])
  await game.inventory.craftBatch({ stateId: 10 }, game.signal, ticket)
  assert.deepEqual(game.writes, [{ name: 'window_click', payload: { windowId: 0, stateId: 10, slot: 36 } }])
})

test('revision 8 log removal before stale revision 7 full cannot produce a readback or a write', async () => {
  const game = fixture()
  await assert.rejects(game.sync(decodeWire(setSlot(8, 36)), decodeWire(full(7))), { code: 'CRAFT_UNCONFIRMED' })
  assert.deepEqual(game.writes, [])
})

test('a real change to the same offhand slot supersedes the ticket even if it is emptied again', async () => {
  const game = fixture()
  const ticket = await game.sync(decodeWire(full(9)), decodeWire(setSlot(10)))
  game.emit(decodeWire(setSlot(11, 45, oak)))
  game.emit(decodeWire(setSlot(12)))
  await assert.rejects(game.inventory.craftBatch({ stateId: 12 }, game.signal, ticket), { code: 'CRAFT_UNCONFIRMED' })
  assert.deepEqual(game.writes, [])
})

test('the adjacent revision wraps from 32767 to zero and the write must use zero', async () => {
  const game = fixture()
  const ticket = await game.sync(decodeWire(full(32767)), decodeWire(setSlot(0)))
  await game.inventory.craftBatch({ stateId: 0 }, game.signal, ticket)
  assert.equal(game.writes.length, 1)
  assert.equal(game.writes[0].payload.stateId, 0)
})

test('cancellation at the first attempted click writes no packet', async () => {
  const game = fixture()
  const ticket = await game.sync(decodeWire(full(9)), decodeWire(setSlot(10)))
  const cancel = new AbortController()
  const recipe = { stateId: 10, beforeWrite: () => cancel.abort(new BlocksideError('CANCELED')) }
  await assert.rejects(game.inventory.craftBatch(recipe, cancel.signal, ticket), { code: 'CANCELED' })
  assert.deepEqual(game.writes, [])
})

test('a missing, malformed, conflicting or uncorrelated slot supplies no unchanged-slot proof', async t => {
  const unknown = full(9)
  delete unknown.params.items[45]
  for (const [label, snapshot, update] of [
    ['unknown stored slot', unknown, setSlot(10)],
    ['unexpected fields on a claimed empty slot', full(9), setSlot(10, 45, { itemCount: 0, itemId: 134 })],
    ['invalid slot index', full(9), setSlot(10, 46)],
    ['same revision with conflicting contents', full(9), setSlot(9, 45, oak)],
    ['unexplained revision gap', full(9), setSlot(11)],
    ['other window', full(9), setSlot(10, 45, empty, 3)]
  ]) {
    await t.test(label, async () => {
      const game = fixture()
      await assert.rejects(game.sync(snapshot, update), { code: 'CRAFT_UNCONFIRMED' })
      assert.deepEqual(game.writes, [])
    })
  }
})

test('opening or replacing the inventory after readback prevents the first click', async () => {
  for (const replace of [
    bot => { bot.currentWindow = { id: 3 } },
    bot => { bot.inventory = { ...bot.inventory } }
  ]) {
    const game = fixture()
    const ticket = await game.sync(decodeWire(full(9)), decodeWire(setSlot(10)))
    replace(game.bot)
    await assert.rejects(game.inventory.craftBatch({ stateId: 10 }, game.signal, ticket), { code: 'CRAFT_UNCONFIRMED' })
    assert.deepEqual(game.writes, [])
  }
})

test('a readback still requires a full snapshot during its own request', async () => {
  const game = fixture()
  await game.sync(decodeWire(full(9)))
  await assert.rejects(game.sync(decodeWire(setSlot(10))), { code: 'CRAFT_UNCONFIRMED' })
  assert.deepEqual(game.writes, [])
})
