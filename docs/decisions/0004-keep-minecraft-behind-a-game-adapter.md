# Keep Minecraft behind a game adapter

## Status

Accepted
Class: architecture

## Context and Problem Statement

Blockside has to map a small model-facing contract onto game actions whose progress depends on a live Minecraft connection. The protocol version and the way a runner joins a world can evolve independently of the tools.

## Decision Drivers

- Keep outcome and cancellation rules in one place.
- Use maintained protocol, pathfinding, and pickup libraries.
- Exercise the action contract without a game server or Microsoft account.
- Allow a separate future Realms integration to reuse the tool and action layers.

## Considered Options

- Call Mineflayer directly from each MCP tool handler.
- Use a controller and one Minecraft adapter backed by Mineflayer.
- Implement the game protocol or require a Minecraft server plugin.

## Decision Outcome

The MCP layer delegates to the controller, which owns the single active action and connection lifecycle. The adapter owns the fixed game endpoint, Mineflayer lifecycle, navigation, and pickup observations. The lockfile pins the game packages. The operator selects an exact supported protocol in the private configuration before the runner starts.

## Pros and Cons of the Options

- Direct tool handlers have fewer seams, but each handler would share and manage raw bot state.
- A game adapter makes the connection and mutation boundaries explicit and supports mock and wire-level evidence. It adds one interface between the controller and the game libraries.
- A custom protocol client or required server plugin gives more control over the game boundary and adds protocol or server-side upkeep.

## Links

- [Prototype contract](../specs/0000-local-java-mvp.md)
- [Mineflayer 4.39.0](https://github.com/PrismarineJS/mineflayer/releases/tag/4.39.0)
- [Pathfinder 2.4.5](https://www.npmjs.com/package/mineflayer-pathfinder/v/2.4.5)
- [CollectBlock 1.6.0](https://www.npmjs.com/package/mineflayer-collectblock/v/1.6.0)
- [Minecraft protocol server API](https://github.com/PrismarineJS/node-minecraft-protocol)
