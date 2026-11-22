import { abortable, BlocksideError, safeError } from './errors.mjs'

export class GameController {
  #openSession
  #session = null
  #work = null

  constructor(openSession) {
    this.#openSession = openSession
  }

  status() {
    const work = this.#work
    const connecting = work?.name === 'connect' && !work.signal.aborted
    return {
      connection: this.#session ? 'connected' : connecting ? 'connecting' : 'disconnected',
      action: work?.name ?? null,
      stopping: work?.signal.aborted ?? false
    }
  }

  async connect(requestSignal) {
    if (this.#work) throw new BlocksideError('BUSY')
    if (!this.#session) {
      await this.#run('connect', requestSignal, 15_000, null, async (work) => {
        for (let attempt = 0; attempt < 2; attempt++) {
          work.signal.throwIfAborted()
          let session
          try {
            session = this.#openSession((error) => this.#connectionLost(session, error))
            work.session = session
            await abortable(session.ready, work.signal)
            work.signal.throwIfAborted()
            if (session.closed) throw new BlocksideError('DISCONNECTED')
            this.#session = session
            return
          } catch (error) {
            session?.close()
            work.session = null
            work.signal.throwIfAborted()
            if (attempt === 0 && error instanceof BlocksideError && error.code === 'TRANSIENT_CONNECT') continue
            throw safeError(error, 'CONNECT_FAILED')
          }
        }
      })
    }
    return this.status()
  }

  follow(input, requestSignal) {
    return this.#runAction('follow', input, requestSignal, (input.seconds + 1) * 1000)
  }

  collect(input, requestSignal) {
    return this.#runAction('collect', input, requestSignal, 20_000)
  }

  stop() {
    const stopped = this.#cancel(this.#work, new BlocksideError('CANCELED'))
    return { stopped, ...this.status() }
  }

  disconnect() {
    const disconnected = Boolean(this.#session || this.#work?.session)
    this.#cancel(this.#work, new BlocksideError('DISCONNECTED'))
    const session = this.#session
    this.#session = null
    session?.close()
    return { disconnected, ...this.status() }
  }

  #connectionLost(session) {
    if (this.#session !== session) return
    this.#session = null
    if (this.#work?.session === session) this.#cancel(this.#work, new BlocksideError('DISCONNECTED'))
  }

  #cancel(work, reason) {
    if (!work || work.signal.aborted) return false
    work.abort.abort(reason)
    if (work.name === 'follow') {
      work.session?.halt()
    } else {
      if (this.#session === work.session) this.#session = null
      work.session?.close()
    }
    return true
  }

  #runAction(name, input, requestSignal, timeLimit) {
    if (this.#work) throw new BlocksideError('BUSY')
    const session = this.#session
    if (!session) throw new BlocksideError('NOT_CONNECTED')
    return this.#run(name, requestSignal, timeLimit, session, (work) => session[name](input, work.signal))
  }

  async #run(name, requestSignal, timeLimit, session, task) {
    if (requestSignal?.aborted) throw new BlocksideError('CANCELED')
    const abort = new AbortController()
    const work = { name, abort, signal: abort.signal, session }
    this.#work = work
    const cancel = () => this.#cancel(work, new BlocksideError('CANCELED'))
    requestSignal?.addEventListener('abort', cancel, { once: true })
    const timer = setTimeout(() => this.#cancel(work, new BlocksideError('DEADLINE')), timeLimit)
    try {
      return await task(work)
    } finally {
      clearTimeout(timer)
      requestSignal?.removeEventListener('abort', cancel)
      this.#work = null
    }
  }
}
