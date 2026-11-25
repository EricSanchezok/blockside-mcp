# Bounded inventory crafting

Artifact-Version: 1
Status: Draft

## Intent

The local Java Edition runner can fulfill a small crafting request from its player inventory. The candidate is scoped to an isolated local test world.

## Contract

- The operator can expose the draft action in an isolated runner by adding `"draftCraft": true` to its local JSON configuration with `"auth": "offline"` and an IPv4 loopback endpoint. The default runner omits the tool and rejects direct calls as `UNKNOWN_TOOL`.
- `craft` accepts an approved output `item` and an exact output `count`. The initial recipe consumes one `oak_log` for four `oak_planks` in the player crafting grid. Valid counts are 4, 8, and 12. Unsupported items and counts return `INVALID_INPUT`.
- The player inventory must contain the required ingredients before the recipe starts.
- The controller admits a single `craft` action with a 20-second deadline. Stop, cancellation, timeout, or the first packet opening another container closes the game connection. An accepted interaction can have already changed the world or inventory when the action stops.
- Crafting requires a fresh complete player-window snapshot before crafting and between batches. Older window revisions, inconsistent same-revision slots, and conflicting unversioned player or cursor updates leave inventory unconfirmed. An adjacent player-window revision that repeats a known empty slot retains the current snapshot and advances its revision. Other windows supply no player-window freshness proof. A superseded snapshot or stale inventory during a batch blocks subsequent gameplay clicks.
- The runner checks a complete snapshot of the current player inventory after each batch. A fresh snapshot with an empty crafting grid and cursor confirms the batch when both the output gain and ingredient consumption match. Success returns `{item, requested, crafted}`.
- An interrupted or unconfirmed craft keeps its error code and includes a receipt when at least one batch was confirmed. The receipt counts the confirmed output and sets `remaining` to `null` while an active batch has an unresolved inventory effect. A clean unchanged snapshot may arrive before that batch settles, so the runner keeps waiting for matching evidence within the existing action deadline. Any subsequent craft uses a fresh inventory observation and a new explicit request.
- A missing recipe or occupied crafting grid returns `CRAFT_UNAVAILABLE`. Insufficient ingredients and inventory space return `MISSING_INGREDIENTS` and `INVENTORY_FULL` respectively.

## Plan

Extend the existing stdio tool registry and action controller. Resolve the allowlisted recipe through Mineflayer and confirm it using the pinned inventory synchronization method.

## Verification

Run `npm test`. Exercise default denial, isolated opt-in, stocked crafting, late exact deltas and unresolved batches, conflicting deltas, unsolicited statistics, action admission, cancellation and deadline receipts, and a replacement container that opens before its contents arrive. Check accepted inventory and outbound clicks through the fixed Java 1.21.11 runner. Replay the captured Java 26.1.2 offhand ordering through the inventory watcher with the locked wire codec.

## Evidence

Pending draft verification.
