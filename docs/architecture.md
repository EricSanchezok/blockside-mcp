# Architecture

**Blockside MCP is an unofficial companion project for Minecraft.** It has no approval from or association with Mojang or Microsoft.

## Repository map

- The stdio entry loads operator configuration and starts the MCP server. The server lists the tools, validates inputs, and returns redacted results. [Entry](../src/main.mjs) · [Tools](../src/mcp.mjs)
- The controller owns the connection and one active action, including deadlines, cancellation, and the pre-spawn retry. [Controller](../src/controller.mjs)
- The game adapter drives Mineflayer against Java Edition 1.21.11 and confirms pickups through game events and inventory updates. [Game adapter](../src/mineflayer.mjs)

## Product direction

Standard ChatGPT Chat is the intended model-facing interface. Blockside is the game client and action executor. The runner uses neither a second model nor a model API key. Local stdio is the development harness. Public MCP access is a separate integration.

Self-managed vanilla can provide a controlled, version-pinned integration target. Java Realms is a candidate for consumer onboarding. A Realms integration has to verify invitation and Realm selection by ID, account access, and compatibility with the live protocol independently of the pinned fixture. It belongs behind the game adapter.

## Structural changes

Update this map when the repository gains an implementation boundary. Follow the repository workflow for changes that cross a risk boundary or establish a durable design choice. [Governance loop](../AGENTS.md#governance-loop-hard-rules)
