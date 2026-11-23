const messages = {
  AUTH_FAILED: 'Microsoft sign-in could not be completed.',
  AUTH_REQUIRED: 'Run the local Microsoft sign-in command before connecting.',
  BUSY: 'A game action is already in progress.',
  CANCELED: 'The action was stopped.',
  CONFIG_INVALID: 'Supply a valid operator configuration file.',
  CONNECT_FAILED: 'The configured game server could not be reached or rejected the connection.',
  DEADLINE: 'The game action reached its time limit.',
  DISCONNECTED: 'The game connection closed.',
  GAME_ERROR: 'The game action did not complete.',
  INVENTORY_FULL: 'The bot needs a free inventory slot.',
  INVALID_INPUT: 'The tool arguments are invalid.',
  NOT_CONNECTED: 'Connect the bot before starting a game action.',
  NO_BLOCK: 'No matching loaded block is within reach of the action area.',
  NO_PICKUP: 'The game did not confirm a matching pickup.',
  OUT_OF_RANGE: 'The action reached its movement limit.',
  PICKUP_AMBIGUOUS: 'The game observations could not establish a unique pickup for the selected block.',
  PLAYER_UNAVAILABLE: 'The player is outside the bot’s view.',
  TRANSIENT_CONNECT: 'The game connection closed before spawn.',
  UNKNOWN_TOOL: 'The tool is unavailable.',
  UNREACHABLE: 'The bot could not reach the selected target.'
}

export class BlocksideError extends Error {
  constructor(code, receipt) {
    super(messages[code])
    this.code = code
    this.receipt = receipt
  }
}

export function safeError(error, fallback = 'GAME_ERROR') {
  return error instanceof BlocksideError ? error : new BlocksideError(fallback)
}

export function abortable(promise, signal) {
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason)
    // Observe the original promise even when cancellation wins.
    Promise.resolve(promise).then(resolve, reject).finally(() => signal.removeEventListener('abort', abort))
    if (signal.aborted) abort()
    else signal.addEventListener('abort', abort, { once: true })
  })
}
