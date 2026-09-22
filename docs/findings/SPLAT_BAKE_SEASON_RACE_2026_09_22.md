# Forest drawn as sand after a season change: a dropped splat bake (2026-09-22)

## What was seen

In a filtered perf capture, the forest shots that ran after `winter-noon` drew their whole land surface as flat,
untextured beige. The trees and the water were normal. Beige is Surface material 0, Sand, at weight 0: the splat
texels of those pages had never been written. It was deterministic per shot list. On House-Keeping `ea63db1`,
with no terrain change, `winter-noon` then `canopy-1200ft` drew 42.1 % of the lower frame as sand, and
`winter-noon` then `forest-line-highsun` 28.2 % (2 of 2 runs each). With `winter-noon` removed from the list
both were clean. The same list at `f9d2672` reproduced it exactly, so it predates the branch that found it. The
canonical full run did NOT escape it (see Evidence): two baselines promoted on 2026-09-21 carry it. It would
also reach a player who changes the date in flight.

It was first attributed to contention on the shared machine and then retracted. A two-shot re-check without
`winter-noon` in its list came back clean, and that was mistaken for the cure.

## Why

A season change re-bakes every resident page's splat in place (`dispatchSplatRebake`), because the ids and the
snow blanket are season-keyed. `PageSplatBake.bake()` returned 0 without baking whenever another bake was
running. Neither caller read the count. `dispatchChannelBake` publishes a new page once its occlusion bake and
its splat bake have both run, and after a season change its splat request met the running re-bake, was
dropped, and the page was published anyway. It was also marked baked for the current season, so no later
re-bake could repair it. The failure is permanent for the life of the page.

## The fix, and the second hazard it exposed

`PageSplatBake.bake()` now queues concurrent requests and returns the slots it actually wrote. The three callers
(the first bake, the season re-bake, and the prewarm) publish or mark only those, and release the rest to be
requested again.

Queuing alone was not enough, and the GPU test showed it. Babylon records a compute dispatch into the frame's
command encoder, which is submitted at `flushFramebuffer` or at the end of the frame. A `StorageBuffer.update`
is written to the device queue at once. A second bake started in the same frame therefore overwrote the first
bake's job buffer before the first dispatch ran, and both dispatches baked the second batch's pages. The first
page read all zero: sand again, by another route. A queued bake now waits until `engine.frameId` has passed the
frame that recorded the previous dispatch. `endFrame` submits, then advances the frame id, then notifies, so
passing the frame means submitted. A lone bake never waits. Waiters are released on dispose.

"`await dispatchWhenReady`" means recorded, not executed. Any producer that shares a job or uniform buffer
across calls within one frame has the same hazard.

## Evidence

- GPU (`tests/gpu/terrain-splat-bake.test.ts`, "queues a bake requested while another runs"): two bakes are
  requested without awaiting either, and each page's minimum weight sum is read back.
  - On the old class: the second call returned 0 and its page read 0.000.
  - On a queue without the frame wait: the first page read 0.000.
  - Fixed: 0.965 and 0.957.
- Node (`tests/render.webgpu-terrain-clipmap.test.ts`, "publishes a channel page only if its splat bake wrote
  it"): on the streaming fakes, a splat bake that writes nothing must not publish its page, and the page must be
  written later. It fails when the caller is reverted to publishing every occlusion-baked page.
- Captures on one machine, filtered lists and the canonical full run:
  - Before, on `ea63db1`: `winter-noon` then `canopy-1200ft` 42.1 % sand, 2 of 2; `winter-noon` then
    `forest-line-highsun` 28.2 %, 2 of 2. The three-shot list is timing-dependent: `forest-line-highsun` 28.2 %
    and 39.9 %, `canopy-1200ft` 0 % and 42.1 %.
  - After, on the fix: 0.0 % in all four two-shot runs, the three-shot list and the ten-shot list.
    `canopy-1200ft` after `winter-noon` matches its promoted baseline to 0.018/255.
  - Full canonical run, after against before, same machine, 39 shots. 35 shots are within 0.000-0.019 of 255,
    which is the floor of the before-run against the promoted baselines. `water-3m` 0.235 and
    `water-400ft-glitter` 0.074 are the ocean's cascade-phase class: the harness never resets the ocean frame
    counter, so a change in streaming frame counts moves the wave phase. Two shots change because their
    PROMOTED baselines carry this bug:
    - `approach-lights-outboard`: a sand slab in front of the aircraft, 11.2 % of the lower frame. The
      promotion review took it for a flat sand apron.
    - `apron-hangar-variety`: a sand block beside the hangars, 20.1 %.

    After the fix both are turf. Both baselines were promoted on 2026-09-21 (`19216c3`) with the defect in
    them and need re-shooting with the fix. No other promoted baseline shows it.
- Suites on the fixed tree: Node 237 files, 2,438 passed, 1 skipped. Unpinned GPU suite 60 files, 136 passed,
  no EXCEEDED.
