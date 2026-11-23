# Local Java Edition prototype

Artifact-Version: 1
Status: Approved

## Intent

The owner approved a first Java Edition prototype that lets a local MCP client connect a bot to one operator-approved world, follow a visible player, collect a small number of blocks, and stop or disconnect on demand. The game version is Java Edition 1.21.11.

The runner uses local stdio. On a future cloud host it can reach Minecraft over loopback or a trusted private network. Players use the game's player endpoint separately. The scope covers isolated development tests and excludes live installation, public server tests, deployment, and a remote MCP control plane.

## Contract

- Startup requires an operator-owned configuration with one loopback or RFC 1918 IPv4 address and port, an explicit authentication mode, and a local profile name. The game endpoint stays fixed for the process. Tools accept no address, port, credential, command, or chat input.
- The tools are `connect`, `status`, `follow`, `collect`, `stop`, and `disconnect`. One connection attempt or action can run at a time. Status and cancellation remain available during work. Status exposes only the connection and action state.
- An explicit connect request has a 15-second deadline and can retry once against the same target after a transient game transport failure before spawn. Authentication failures, kicks, cancellation, and expired deadlines end the request. Disconnects after spawn, death, or a world transition end any active action and require a new explicit connect request. Actions are never replayed.
- Follow accepts a Java player name and a duration of 1–30 seconds. It follows a visible player at a short distance with a 16-block leash from the bot's starting position. The action ends if the player becomes unavailable or leaves the leash.
- Collect accepts `dirt` or `oak_log`, a count of 1–3, and a search radius of 1–8 blocks. It uses a 20-second deadline and stays inside the requested radius from the starting position. A pickup needs a server-confirmed removal, one new matching item near the target, the bot's pickup of that exact entity, and a one-item inventory gain. An item seen before the removal update can qualify for pickup if it remains the sole eligible target when the bot starts pursuing it after the update. A premature pickup of an early item, competing items, or conflicting evidence returns `PICKUP_AMBIGUOUS` with the previously confirmed count.
- The pickup event identifies the collector and item. The adapter correlates a pickup with the selected block using observed position, removal, and entity identity. The server packets provide no item-to-block origin field.
- Navigation excludes opportunistic digging, placing blocks, opening doors, and using chests. Collection only attempts the selected allowed block. The bot uses ordinary player permissions.
- Stopping cancels movement promptly. An MCP client cancellation uses the same stop path for its active request. A canceled or timed-out collection may close the game connection to prevent further digging. A conflict during active pursuit also closes the connection to stop that pursuit. Disconnect cancels any action and closes the game connection. A cancellation can leave a previously started block change in the world. Any partial receipt includes pickups confirmed before cancellation.
- Offline authentication is for the isolated fixture or an explicitly configured local offline test. Microsoft authentication uses a separate human-run device sign-in and a private local cache. The stdio process returns redacted errors and keeps terminal login codes, server text, and addresses out of tool results and runtime logs.

## Plan

Use the official MCP stdio SDK for the tool boundary. Keep configuration validation, action lifecycle, and the Mineflayer adapter separate. Pin Mineflayer, pathfinder, and collectblock and capture their resolution in the lockfile.

## Verification

Use a fake game adapter for lifecycle and receipt scenarios, exercise the MCP contract over stdio, and connect the real adapter to an isolated 1.21.11 loopback protocol fixture where supported. A separate live validation will require the owner's configured non-operator account and vanilla server.

## Evidence

- Controller tests cover retry, action exclusivity, cancellation, and disconnect without replay. [Controller tests](../../tests/controller.test.mjs)
- The shipped stdio entry is exercised for tool discovery, validation, redaction, the absent-cache response, and client cancellation during follow. [MCP tests](../../tests/mcp.test.mjs) and [protocol tests](../../tests/protocol.test.mjs)
- The loopback fixture exercises the 1.21.11 protocol, follow movement, partial receipts, pickups with the spawn on either side of the removal update, ambiguous and unconfirmed pickups, and stopping before or after pickup confirmation. [Protocol tests](../../tests/protocol.test.mjs)
- Live Microsoft sign-in, vanilla server behavior, and Realms remain separate validation work.
