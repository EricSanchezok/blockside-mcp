# AI building plan

Artifact-Version: 1
Status: Draft

## Intent

Let the ChatGPT conversation turn an owner's build request and recent game observations into a small placement plan. Blockside can validate the plan at the boundary of a future approved build action. The chat supplies the design and the game adapter supplies the terrain and materials.

## Contract

- The adapter gives the model an opaque `snapshotId` for the exact immutable observation it receives. The observation binds the game session, world, dimension, and owner-selected build volume, including its origin and size of up to 8 × 4 × 8 blocks. It captures air, occupied and unknown cells, supporting faces in and directly adjacent to the volume, and inventory counts for the material palette. The palette contains stable full blocks that supply six supporting faces and consume one item per placement.
- The plan is a JSON object with exactly two fields, the `snapshotId` from the observation used for planning and a `placements` array of 1–64 entries in execution order. Each entry has exactly three integer offsets `x`, `y`, `z` from that snapshot's origin and one `block` name from its palette.
- Resolve the submitted ID to the exact snapshot issued to the model for that site. Require a unique, in-bounds, observed air cell for each placement, an observed supporting face or one supplied by an earlier placement, and enough inventory for the total count of each material. Reject invalid input and unknown IDs before placing any blocks. A change to the session, world, dimension, volume, captured cells, support, or inventory counts invalidates the ID for starting execution, even within the same session. Loss of observation also invalidates it.
- When the request permits a choice of site or material, the chat can choose another observed location within the volume or another material in the palette. When the stated requirements cannot be met, it reports the blocker to the owner.

Three blocks of cobblestone edging in an L use this placement list.

```json
{
  "snapshotId": "example-snapshot",
  "placements": [
    { "x": 0, "y": 0, "z": 0, "block": "cobblestone" },
    { "x": 1, "y": 0, "z": 0, "block": "cobblestone" },
    { "x": 0, "y": 0, "z": 1, "block": "cobblestone" }
  ]
}
```

## Plan

Add the validator when an approved build action can consume the placement list. Keep the model in the ChatGPT conversation and run preflight at the tool boundary. Route ordinary player placements and reachability checks through the existing controller and adapter that own the session, deadline, and cancellation.

Before each placement, require the same session, world, dimension, and volume. Compare live terrain, support, and inventory with the original snapshot plus the effects of confirmed placements. After sending a placement, advance only when the planned block is observed at its target and the inventory count of its item has decreased by exactly one within the action deadline. On a mismatch or missing confirmation, pause placements, invalidate the snapshot ID for execution, and report the confirmed steps and any unresolved attempt. Send each step at most once per plan. To continue after the action settles, take a fresh observation and generate a plan for the remaining work.

## Verification

Use synthetic snapshots and compare accepted placements and rejection reasons. The flat test volume contains observed air above a known solid floor at `y = -1`. Start with six oak planks and three cobblestone blocks.

| Request and observation | Expected plan or blocker |
| --- | --- |
| On the flat site, make a three-block-long, two-block-high oak screen running east–west. | Six `oak_planks` in one row along `x` at each of two successive `y` levels. The lower row precedes the upper row. |
| On the same site with the same inventory, make three cobblestone edging blocks in an L. | Three `cobblestone` placements at `y = 0` covering a corner and one adjacent cell on each horizontal axis. |
| Keep the cobblestone request and reduce the observed cobblestone count to two. | Report one missing cobblestone. The oak stock does not satisfy the explicit material request. |
| Keep the oak screen request and the full inventory. A rise occupies `(1, 0, 0)`. The rows at `y = 0` and `y = 1` along `x` at `z = 1` are clear with a solid floor beneath. The owner allows any spot within the volume. | A candidate in the clear rows meets the screen geometry. The original candidate through the rise fails preflight. |
| A chunk unloads after the observation, leaving a target in the clear row unknown. | Preflight rejects the stale snapshot. A fresh observation and plan are required. |

At the validator boundary, accept an exact-cap plan and reject 65 entries, duplicate coordinates, out-of-volume offsets, missing support, an extra `command` field, and a snapshot ID from another session, world, or build volume. Within the same session, change a captured block or, in a separate case, an inventory count that still covers the plan. Each change must block the first placement.

At the action boundary, change the site or inventory after a confirmed placement and verify that the next placement pauses. Drop confirmation for a placement that took effect and resubmit the plan. Check that the executor reports one unresolved attempt, rejects the old ID, and requires a fresh observation and plan that accounts for the occupied target and actual inventory.

## Evidence

- The default branch contains the governance baseline. The Java prototype advertises six tools. Its terrain and inventory reads serve collection, and its controller delegates follow and collection to the game adapter. A placement consumer and a bounded site observation are prerequisites for implementation. [Repository map](../architecture.md) · [Tool discovery test](https://github.com/EricSanchezok/blockside-mcp/blob/f7ef3e56fee4c4903d81dc609029ed5db4f81bcf/tests/mcp.test.mjs#L23-L34) · [Controller](https://github.com/EricSanchezok/blockside-mcp/blob/f7ef3e56fee4c4903d81dc609029ed5db4f81bcf/src/controller.mjs) · [Game adapter](https://github.com/EricSanchezok/blockside-mcp/blob/f7ef3e56fee4c4903d81dc609029ed5db4f81bcf/src/mineflayer.mjs)
- APT separates layout planning, block coordinates, and Mineflayer execution. Its blueprint stage generates Python to produce the coordinate list. The proposed plan adopts the coordinate list and separation of responsibilities. [APT, §3.2](https://arxiv.org/html/2411.17255v1#S3.SS2)
- Mindcraft stores blueprints by level and compares expected blocks with observed cells. Its benchmark helper emits `/setblock` commands. The proposed preflight uses the cell-by-cell comparison with explicit unknown cells. [Mindcraft construction blueprints and validation](https://github.com/mindcraft-bots/mindcraft/blob/e1c1fc3ffa481506c2445fc639e16dba504b5920/src/agent/tasks/construction_tasks.js#L134-L234)
- Evidence for this draft covers the repository boundary and the synthetic examples. Runtime verification depends on an approved placement consumer.
