import { isDeepStrictEqual } from 'node:util'
import { abortable, BlocksideError } from './errors.mjs'

// Java menu state IDs are local to a menu and wrap at 15 bits.
const stateMask = 0x7fff
const halfStateRange = 0x4000
const playerWindow = 0
const emptyWireSlot = { itemCount: 0 }

function stateDistance(next, previous) {
  return (next - previous) & stateMask
}

function windowSlot(slot) {
  if (!Number.isInteger(slot) || slot < 0 || slot > 40) return null
  if (slot < 9) return slot + 36
  if (slot < 36) return slot
  return slot === 40 ? 45 : 44 - slot
}

export function watchCraftingInventory(bot) {
  const client = bot._client
  let revision = null
  let sequence = 0
  let snapshot = null
  let trusted = false
  let inventorySize
  const menuSlots = new Map()
  let menuCursor
  const playerUpdates = new Map()
  let cursorUpdate
  let unknownPlayerUpdate = false

  const invalidate = () => {
    trusted = false
    snapshot = null
  }
  const isCurrent = ticket => trusted && ticket !== null && ticket === snapshot &&
    ticket.through === sequence && ticket.inventory === bot.inventory && !bot.currentWindow

  function observeRevision(packet) {
    sequence++
    inventorySize ??= bot.inventory?.slots.length
    const next = packet.stateId
    if (packet.windowId !== playerWindow || !Number.isInteger(next) || next < 0 || next > stateMask ||
        (revision !== null && stateDistance(next, revision) >= halfStateRange)) {
      invalidate()
      return false
    }
    if (next !== revision) {
      menuSlots.clear()
      menuCursor = undefined
      revision = next
    }
    return true
  }

  function onSlot(packet) {
    const current = isCurrent(snapshot) ? snapshot : null
    const previousRevision = revision
    if (!observeRevision(packet)) return
    const { slot, item } = packet
    if (inventorySize === undefined || !Number.isInteger(slot) || slot < 0 || slot >= inventorySize || item === undefined ||
        (menuSlots.has(slot) && !isDeepStrictEqual(menuSlots.get(slot), item))) {
      invalidate()
      return
    }
    const direct = playerUpdates.get(slot)
    if (direct && !isDeepStrictEqual(direct.item, item) &&
        (direct.revision === null || stateDistance(revision, direct.revision) === 0 ||
         stateDistance(revision, direct.revision) >= halfStateRange)) {
      invalidate()
      return
    }
    playerUpdates.delete(slot)
    menuSlots.set(slot, item)
    // An adjacent empty-to-empty update preserves the full snapshot's contents.
    if (current && stateDistance(revision, previousRevision) === 1 &&
        isDeepStrictEqual(current.packet.items[slot], emptyWireSlot) && isDeepStrictEqual(item, emptyWireSlot)) {
      current.through = sequence
    }
  }

  function onSnapshot(packet) {
    if (!observeRevision(packet)) return
    const { items, carriedItem } = packet
    if (bot.currentWindow || !Array.isArray(items) || items.length !== inventorySize || carriedItem === undefined ||
        unknownPlayerUpdate ||
        (cursorUpdate !== undefined && !isDeepStrictEqual(cursorUpdate, carriedItem)) ||
        (menuCursor !== undefined && !isDeepStrictEqual(menuCursor, carriedItem)) ||
        [...menuSlots].some(([slot, item]) => !isDeepStrictEqual(item, items[slot])) ||
        [...playerUpdates].some(([slot, direct]) => !isDeepStrictEqual(direct.item, items[slot]))) {
      invalidate()
      return
    }
    items.forEach((item, slot) => menuSlots.set(slot, item))
    menuCursor = carriedItem
    playerUpdates.clear()
    cursorUpdate = undefined
    trusted = true
    snapshot = { packet, inventory: bot.inventory, sequence, through: sequence }
  }

  function onPlayerSlot({ slotId, contents }) {
    sequence++
    invalidate()
    const slot = windowSlot(slotId)
    if (slot === null || contents === undefined) {
      unknownPlayerUpdate = true
      return
    }
    menuSlots.delete(slot)
    playerUpdates.set(slot, { item: contents, revision })
  }

  function onCursor({ contents }) {
    sequence++
    invalidate()
    menuCursor = undefined
    cursorUpdate = contents
    if (contents === undefined) unknownPlayerUpdate = true
  }

  const listeners = [
    ['window_items', onSnapshot], ['set_slot', onSlot],
    ['set_player_inventory', onPlayerSlot], ['set_cursor_item', onCursor]
  ]
  for (const [packet, observe] of listeners) client.prependListener(packet, observe)
  bot.once('end', () => {
    invalidate()
    for (const [packet, observe] of listeners) client.off(packet, observe)
  })

  return {
    ticketFor(packet) {
      return isCurrent(snapshot) && packet === snapshot.packet ? snapshot : null
    },

    async sync(signal) {
      signal.throwIfAborted()
      const before = sequence
      // The pinned Mineflayer sync awaits a player-window snapshot. Check its wire evidence separately.
      // Source: https://github.com/PrismarineJS/mineflayer/blob/4.39.0/lib/plugins/inventory.js
      await abortable(bot._syncWindow(bot.inventory), signal)
      signal.throwIfAborted()
      if (!isCurrent(snapshot) || snapshot.sequence <= before) throw new BlocksideError('CRAFT_UNCONFIRMED')
      return snapshot
    },

    async craftBatch(recipe, signal, ticket) {
      signal.throwIfAborted()
      if (!isCurrent(ticket)) throw new BlocksideError('CRAFT_UNCONFIRMED')
      const previous = Object.getOwnPropertyDescriptor(client, 'write')
      const write = client.write
      let firstClick = true
      let refused = false
      let active = true
      function guardedWrite(name, packet, ...rest) {
        if (active && name === 'window_click') {
          signal.throwIfAborted()
          if (!trusted || bot.currentWindow || ticket.inventory !== bot.inventory ||
              packet.windowId !== playerWindow || packet.stateId !== revision ||
              (firstClick && !isCurrent(ticket))) {
            refused = true
            throw new BlocksideError('CRAFT_UNCONFIRMED')
          }
          firstClick = false
        }
        return Reflect.apply(write, this, [name, packet, ...rest])
      }
      client.write = guardedWrite
      try {
        // A settled recipe error may still leave accepted inventory changes to reconcile.
        await abortable(bot.craft(recipe, 1, null), signal).catch(() => signal.throwIfAborted())
        signal.throwIfAborted()
        if (refused) throw new BlocksideError('CRAFT_UNCONFIRMED')
      } finally {
        active = false
        if (client.write === guardedWrite) {
          if (previous) Object.defineProperty(client, 'write', previous)
          else delete client.write
        }
      }
    }
  }
}
