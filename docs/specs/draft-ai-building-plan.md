# AI building plan

Artifact-Version: 1
Status: Draft

## Intent

Let the ChatGPT conversation turn an owner's build request and recent game observations into a small placement plan. Blockside can validate the plan at the boundary of a future approved build action. The chat supplies the design and the game adapter supplies the terrain and materials.

## Contract

- A game adapter snapshot fixes the origin and dimensions of the owner-selected build volume, up to 8 × 4 × 8 blocks. It supplies observed air, occupied and unknown cells, observed supporting faces in and directly adjacent to the volume, and counts of supported materials in inventory. The executor's material palette contains stable full blocks that supply six supporting faces and consume one item per placement.
- The plan is a JSON object with one `placements` array of 1–64 entries. Each entry has exactly three integer offsets `x`, `y`, `z` from the snapshot origin and one `block` name from the adapter's material palette. The array specifies placement order. The plan cannot change its observation, bounds, or palette.
- Validate the full plan against the snapshot tied to the current game session. Require a unique, in-bounds, observed air cell for each placement, an observed supporting face or one supplied by an earlier placement, and enough inventory for the total count of each material. Reject the whole candidate for invalid fields, malformed or oversized input, unavailable terrain, insufficient resources, or a stale observation.
- When the request permits a choice of site or material, the chat can choose another observed location within the volume or another material in the palette. When the stated requirements cannot be met, it reports the blocker to the owner.

Three blocks of cobblestone edging in an L use this placement list.

```json
{
  "placements": [
    { "x": 0, "y": 0, "z": 0, "block": "cobblestone" },
    { "x": 1, "y": 0, "z": 0, "block": "cobblestone" },
    { "x": 0, "y": 0, "z": 1, "block": "cobblestone" }
  ]
}
```

## Plan

Add the validator when an approved build action can consume the placement list. Keep the model in the ChatGPT conversation and run preflight at the tool boundary with observations from the game adapter. Route ordinary player placements through the same controller and adapter that own the game session, action deadline, and cancellation. The executor rechecks the live target, support, and inventory before each placement and stops on a conflict. Snapshot validation establishes fit and material cost at observation time. Reachability and placement success belong to the executor.

## Verification

Use synthetic snapshots and compare accepted placements and rejection reasons. The flat test volume contains observed air above a known solid floor at `y = -1`. Start with six oak planks and three cobblestone blocks.

| Request and observation | Expected plan or blocker |
| --- | --- |
| On the flat site, make a three-block-long, two-block-high oak screen running east–west. | Six `oak_planks` in one row along `x` at each of two successive `y` levels. The lower row precedes the upper row. |
| On the same site with the same inventory, make three cobblestone edging blocks in an L. | Three `cobblestone` placements at `y = 0` covering a corner and one adjacent cell on each horizontal axis. |
| Keep the cobblestone request and reduce the observed cobblestone count to two. | Report one missing cobblestone. The oak stock does not satisfy the explicit material request. |
| Keep the oak screen request and the full inventory. A rise occupies `(1, 0, 0)`. The rows at `y = 0` and `y = 1` along `x` at `z = 1` are clear with a solid floor beneath. The owner allows any spot within the volume. | A candidate in the clear rows meets the screen geometry. The original candidate through the rise fails preflight. |
| Mark a target in that clear row as unknown after unloading its chunk. | The candidate using that row fails preflight until the target has a fresh observation. |

At the validator boundary, include a valid exact-cap plan, then reject 65 entries, duplicate coordinates, out-of-volume offsets, missing support, an extra `command` field, and a snapshot from a closed session. At the existing action boundary, test a world or inventory change between preflight and placement. Use an isolated synthetic fixture for those checks.

## Evidence

- The default branch contains the governance baseline. The Java prototype advertises six tools. Its terrain and inventory reads serve collection, and its controller delegates follow and collection to the game adapter. A placement consumer and a bounded site observation are prerequisites for implementation. [Repository map](../architecture.md) · [Tool discovery test](https://github.com/EricSanchezok/blockside-mcp/blob/f7ef3e56fee4c4903d81dc609029ed5db4f81bcf/tests/mcp.test.mjs#L23-L34) · [Controller](https://github.com/EricSanchezok/blockside-mcp/blob/f7ef3e56fee4c4903d81dc609029ed5db4f81bcf/src/controller.mjs) · [Game adapter](https://github.com/EricSanchezok/blockside-mcp/blob/f7ef3e56fee4c4903d81dc609029ed5db4f81bcf/src/mineflayer.mjs)
- APT separates layout planning, block coordinates, and Mineflayer execution. Its blueprint stage generates Python to produce the coordinate list. The proposed plan adopts the coordinate list and separation of responsibilities. [APT, §3.2](https://arxiv.org/html/2411.17255v1#S3.SS2)
- Mindcraft stores blueprints by level and compares expected blocks with observed cells. Its benchmark helper emits `/setblock` commands. The proposed preflight uses the cell-by-cell comparison with explicit unknown cells. [Mindcraft construction blueprints and validation](https://github.com/mindcraft-bots/mindcraft/blob/e1c1fc3ffa481506c2445fc639e16dba504b5920/src/agent/tasks/construction_tasks.js#L134-L234)
- Evidence for this draft covers the repository boundary and the synthetic examples. Runtime verification depends on an approved placement consumer.
