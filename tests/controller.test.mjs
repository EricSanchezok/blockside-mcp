import assert from 'node:assert/strict'
import { test } from 'node:test'
import { GameController } from '../src/controller.mjs'
import { abortable, BlocksideError } from '../src/errors.mjs'

test('connect retries once only for a transient failure before spawn', async () => {
  for (const [failure, expectedAttempts] of [['TRANSIENT_CONNECT', 2], ['CONNECT_FAILED', 1], ['AUTH_REQUIRED', 1]]) {
    let attempts = 0
    let closes = 0
    const game = new GameController(() => {
      attempts++
      return {
        ready: Promise.reject(new BlocksideError(failure)),
        close() { closes++ }
      }
    })

    await assert.rejects(game.connect(), { code: failure })
    assert.equal(attempts, expectedAttempts)
    assert.equal(closes, expectedAttempts)
    assert.equal(game.status().connection, 'disconnected')
  }
})

test('a successful connection stays single and stop can cancel a bounded follow', async () => {
  let opens = 0
  let halts = 0
  let closes = 0
  const game = new GameController(() => {
    opens++
    return {
      ready: Promise.resolve(),
      follow: (_, signal) => abortable(new Promise(() => {}), signal),
      halt() { halts++ },
      close() { closes++ }
    }
  })

  await game.connect()
  await game.connect()
  assert.equal(opens, 1)
  const pending = game.follow({ player: 'Guide', seconds: 30 })
  assert.equal(game.status().action, 'follow')
  assert.throws(() => game.collect({ block: 'dirt', count: 1, radius: 3 }), { code: 'BUSY' })
  assert.equal(game.stop().stopped, true)
  await assert.rejects(pending, { code: 'CANCELED' })
  assert.equal(halts, 1)
  assert.equal(closes, 0)
  assert.deepEqual(game.status(), { connection: 'connected', action: null, stopping: false })
  assert.equal(game.disconnect().connection, 'disconnected')
  assert.equal(closes, 1)
})

test('a disconnect interrupts collection and never replays it after reconnection', async () => {
  let opens = 0
  let collections = 0
  let signalLoss
  const game = new GameController(onLost => {
    opens++
    signalLoss = onLost
    return {
      ready: Promise.resolve(),
      collect: (_, signal) => {
        collections++
        return abortable(new Promise(() => {}), signal)
      },
      close() {}
    }
  })

  await game.connect()
  const pending = game.collect({ block: 'dirt', count: 1, radius: 3 })
  signalLoss(new BlocksideError('DISCONNECTED'))
  await assert.rejects(pending, { code: 'DISCONNECTED' })
  assert.equal(game.status().connection, 'disconnected')
  assert.equal(opens, 1)
  await game.connect()
  assert.equal(opens, 2)
  assert.equal(collections, 1)
  game.disconnect()
})

test('external request cancellation stops an in-flight connect without another attempt', async () => {
  let attempts = 0
  let closed = false
  const game = new GameController(() => {
    attempts++
    return { ready: new Promise(() => {}), close() { closed = true } }
  })
  const cancel = new AbortController()
  const pending = game.connect(cancel.signal)
  cancel.abort()
  await assert.rejects(pending, { code: 'CANCELED' })
  assert.equal(attempts, 1)
  assert.equal(closed, true)
  assert.equal(game.status().connection, 'disconnected')
})
