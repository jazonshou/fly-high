# Babylon reads a pass's timestamps before the pass runs (2026-09-22)

## What was seen

`tests/gpu/terrain-page-erosion-cost.test.ts` failed six times out of six on two trees and two checkouts, always
with the same message, *"timed page 1 did not measure every breach dispatch: expected 1 to be 2"*, and only while
another process (Firefox, 78 % CPU plus 24 % in its GPU helper) was loading the GPU. On a quiet machine it passed.
The producer threw away any reading of zero, so one breach pass on page 1 had read exactly zero.

Chasing that zero found the cause: Babylon never measures the pass it attributes a time to. Every per-pass GPU
timing in this project is the duration of **whichever pass last used the same query slot in an earlier frame**,
and a slot nothing has used before on the device reads 0. The zero was not noise. It was the first use of a new
slot.

## Why

Babylon 9.21.2, per compute dispatch (`Engines/WebGPU/Extensions/engine.computeShader.pure.js:217-240`):

1. `startPass` puts `timestampWrites` for slots `index+2` and `index+3` on the pass descriptor, and the pass is
   recorded into **the frame's encoder**, `_renderEncoder`. That encoder is submitted only at `endFrame`
   (`flushFramebuffer`).
2. `endPass` immediately calls `WebGPUDurationMeasure.stopPass`, which calls
   `WebGPUQuerySet.readTwoValuesAndSubtract` → `_getBuffer` (`Engines/WebGPU/webgpuQuerySet.js:24-41`). That
   builds **a separate encoder**, resolves the two slots, copies them to a map buffer and **submits it at once**.
3. So on the GPU queue the resolve runs **before** the frame encoder that writes those slots. It reads what an
   earlier submitted frame left in them.
4. The slot index restarts at 0 every frame (`webgpuEngine.pure.js:2312`). Slot `k` is therefore whatever pass
   was `k`-th in the most recent earlier frame that reached `k`. A query set starts zeroed, so a slot index never
   reached before reads `0 → 0`. Babylon records a non-positive duration as 0 (`webgpuTimestampQuery.js:76`).

Render passes take slots the same way (`thinWebGPUEngine.js:64-67`, `webgpuEngine.pure.js:2504, 2548`).

This is the third instance of "recorded is not executed" in this codebase, after the splat bake's same-frame
buffer overwrite and the texture-array layer-0 mip blit (FI-5). This time it is in Babylon's own timing code.

## Evidence

An uncommitted probe (not kept in the tree; described here so it can be rebuilt) wraps the engine instance's
`_timestampQuery.endPass` and Babylon's `readTwoValuesAndSubtract` to keep each pass's slot, frame id and raw
pair. For every pass it also takes the **true** reading: in `onEndFrameObservable`, which fires after
`flushFramebuffer` has submitted the frame, it resolves the same slots on its own encoder and reads them back.
Tree `2ec55a2` (House-Keeping `e9d902d` plus the unusable-reading change), M2 Pro, two runs (Firefox's busiest
process at 20 % CPU for the first, about 1 % for the second).

### Positive control: a heavy pass and a trivial pass taking turns in slot 0, one per frame

| run | heavy, true ms | trivial, Babylon ms | trivial, true ms | heavy, Babylon ms |
|---|---|---|---|---|
| 1 | 7.84, 7.55, 7.67, 7.66, 7.58, 7.59 | the same six values, in order | 0.0074-0.0078 | 0.0074-0.0078 |
| 2 | 6.27, 6.12, 4.25, 3.02, 4.21, 4.10 | the same six values, in order | 0.0029-0.0037, then one 0.32 | 0.0029-0.0037 |

In each run, every reading after the first (the warm-up trivial pass and all twelve control passes, 26 in all) is
**exactly** the true duration of the previous pass in that slot. That holds as the heavy pass's own time swings from 2.5 to 7.8 ms with GPU clocks.
The first heavy pass lands on a never-used slot and reads raw `0 → 0` (true 7.69 and 2.54 ms). The true column
comes from the deferred read. It tells the two passes apart by three orders of magnitude, so the deferred read
is a working instrument.

### The erosion cost test's own page flow (a warm page, then four timed pages, as the test runs them)

- **Zeros happen only at new slots**, as predicted: 4 of 4, all in the warm page, all raw `0 → 0` at slots 0, 2, 4
  and 6 on first use (seed, two stream-power passes, and a third stream-power pass on the next frame). The timed
  pages read no zeros here: no frame packed more than 4 passes, so they reached no new slot. Three cost-test runs
  in the same window gave 12 of 12 pages with no unusable readings. Under load, the harness's rAF pumps and
  Babylon's frames drift apart, a frame can pack more than 4 passes, and page 1 reaches a new slot: that is the
  "expected 1 to be 2".
- **Page totals survive; stage attribution does not.** A page's Babylon total is close to its true total
  (26.76 vs 26.60 ms, 25.54 vs 25.44, 37.90 vs 37.91, 26.79 vs 26.96), because the readings are mostly the same
  passes shifted by one slot. But 44-55 of the 109 passes per page read more than 20 % (and more than 20 µs) off
  their own pass.

True vs Babylon per stage, per timed page (ms):

| stage (passes) | true, pages 1-4 | Babylon, pages 1-4 | pinned per page |
|---|---|---|---|
| seed (12) | 7.05, 9.27, 15.86, 11.24 | 6.75, 8.71, 14.74, 8.60 | 13.92 |
| geology (4) | 0.08, 0.09, 0.08, 0.87 | 0.57, 0.71, 1.25, 2.79 | 1.31 |
| **breach (2)** | **2.65, 2.38, 2.67, 2.33** | **0.05, 0.03, 0.04, 0.05** | **0.134** |
| decode (1) | 0.023, 0.010, 0.009, 0.010 | 0.038, 0.039, 0.059, 0.040 | 0.089 |
| streamPower (24) | 0.61, 2.20, 2.64, 0.49 | 3.55, 4.83, 5.41, 2.95 | 0.79 |
| talus (64) | 16.06, 11.37, 16.52, 11.92 | 15.44, 10.51, 16.07, 11.88 | 20.48 |
| fineBand (2) | 0.13, 0.12, 0.12, 0.11 | 0.36, 0.71, 0.33, 0.48 | 0.66 |

Page 1 around breach, pass by pass: breach-pit truly took **2.6152 ms** and was credited 0.0317 ms. The
stream-power pass that next used its slot (slot 2) was credited **2.6152 ms**. The stream-power "outliers" (0.367 ms)
and the decode outlier (0.816 ms) that `TerrainPageErosionGpu.ts` blames on "the counter, not the shader" are
this: the counter is working as designed and reporting another shader's time.

"Passes" are GPU compute passes. Seed and geology bands are batched into a pass's z dimension, so 109 passes
carry the 163 dispatch units the stage table counts.

## What reads per-pass timing

| reading | feeds | when |
|---|---|---|
| terrain page generator's shader (`TerrainPageAtlas`, `consumeGpuDispatchCostMs`) | `ComputeBudget` `terrainCompute` estimate; `gpuPassMs.terrainCompute` | pinned diagnostic captures |
| splat bake and occlusion bake (`PageOcclusionBake.ts`, twice) | `splatCompute`, `occlusionCompute` estimates | pinned diagnostic captures |
| ground-cover ring 0 (`GroundCoverSystem.ts:776`) | `groundCoverCompute` estimate | pinned diagnostic captures |
| erosion stage trackers (`TerrainPageErosionGpu.consumeMeasuredDispatchCostMs`) | `erosionCompute` estimate; the W-1d cost test's stage split | pinned diagnostic captures; `tests/gpu` |
| `engine.gpuTimeInFrameForMainPass`, the shadow render target's counter | `gpuPassMs.mainPass`, `gpuPassMs.shadows` in the capture report (reported, not gated) | pinned diagnostic captures |

Shipping runs with timing off, so none of these readings reach a player. **The prices measured with them do.**

Babylon's whole-frame GPU time (`getGPUFrameTimeCounter`, the capture's `gpuFrameMsP95`) is a different write,
through encoder-level `writeTimestamp`. Its read is submitted early in the same way, but it has only one
measurement per frame, so the error there is a lag of one frame, not a reading of another pass.

## Pinned prices measured on this instrument

| price | value | status |
|---|---|---|
| `TERRAIN_EROSION_STAGE_SEED_COST_MS` (the stage split) | seed 0.29, geology 0.082, breach 0.067, decode 0.089, streamPower 0.033, talus 0.32, fineBand 0.082 | **wrong in its split**; breach is off by about 20x |
| `COMPUTE_DISPATCH_SEED_COST_MS.erosionCompute` | 0.24 | a page average; the page total is roughly right, so probably close |
| `COMPUTE_DISPATCH_SEED_COST_MS.terrainCompute` | 1.9 | unverified; depends on which pass held its slot the frame before |
| `COMPUTE_DISPATCH_SEED_COST_MS.splatCompute` | 0.4 | unverified, same reason |
| `COMPUTE_DISPATCH_SEED_COST_MS.occlusionCompute` | 0.3 | unverified, same reason |
| `COMPUTE_DISPATCH_SEED_COST_MS.groundCoverCompute` | 0.06 | unverified; three rings share a frame, only ring 0 is timed |

A seed is likely close only when, in the run that measured it, the shader filled its own slot every frame in
steady state. Then "the previous occupant" is the same shader one frame earlier. Seed and talus in the erosion
table are that case: they occupy whole frames by themselves, and they agree within noise above.

**Shipping consequence (derived from the numbers above, not yet measured in a frame).** The erosion producer
admits each submit at its stage's pinned price. Breach-pit is one dispatch that really costs about 2.5 ms, and it
is admitted at 0.067 ms, roughly 37 times under. So each eroded page, as far as I can tell, puts one ~2.5 ms
dispatch into a frame whose erosion row is 0.2-0.4 ms. The comment beside the price, *"Cheap because almost no cell
is a pit: 0.13 ms for the pair"*, was written off this instrument.

## The unusable-reading change stands

`2ec55a2` counts a zero or non-finite reading as an "unusable" dispatch instead of dropping it, with at most 2 per
page. Under this mechanism a zero means "this slot has never been written", which is exactly a reading the counter
could not give, so the change is correct. It fixes the counting, not the attribution.

## Fix shape (approved, built below)

What Babylon allows without patching `node_modules`: replace, on the engine **instance**, the per-pass read that
`endPass` triggers. Keep Babylon's slot allocation and `timestampWrites` exactly as they are. Change only when the
slots are read:

1. `endPass(index, counter)` records `{index, counter, frameId}` for the current frame and resolves nothing.
2. In `onEndFrameObservable`, which fires after `flushFramebuffer(true)` has submitted the frame, take one
   `resolveQuerySet` over the frame's whole slot range, plus one copy and **one** `mapAsync`. When it resolves,
   give each pass its own duration through the counter's `_addDuration(frameId, duration)`. A pass recorded
   between frames belongs to the frame that submits it (its captured `frameId` is already the next one), which the
   probe handles by resolving everything whose `frameId` is below the engine's current one.
3. The queue order is then correct by construction: the resolve is submitted after the frame that wrote the
   slots, and before the next frame's encoder can overwrite them.

Side effect: one readback per frame instead of one per timed pass (the cost is re-measured below).

What it touches: Babylon internals (`_timestampQuery`, `_measureDuration._querySet`, `WebGPUPerfCounter._addDuration`).
It needs the same version-pinned source guard that `render.gpu-timing-policy.test.ts` already applies to Babylon's
shipped timing code. The probe's heavy/trivial control is the standing gate: after the fix, the trivial pass must
read microseconds.

Order, once the fix is in: every price in the table above is **re-measured on the fixed instrument before any
gate changes**, and none is adjusted to fit.

## The fix, built (`src/render/webgpu/core/DeferredPassTiming.ts`)

The instrument is the shape above. The renderer installs it right after the one timing switch, and a failure to
install is fatal on a timed run. So are the three GPU tests that switch timing on.

Building it exposed a second, smaller defect in the **consumers**. The erosion producer (and, the same way, the
page generator and the splat and occlusion bakes, through `consumeGpuDispatchCostMs`) polled Babylon's counter and
took `counter.current`, the latest frame's sum, whenever `count` moved:
- when two frames land between polls, the first is lost;
- a delivery that lands when no dispatch is pending is skipped without being marked seen, and is credited to the
  next dispatch, possibly on the next page;
- a delivered frame is divided by the batch dispatched last.

Deliveries now come a frame after the dispatch, so all three happen. On the fixed instrument, page 1's seed stage
read 0.54-1.20 ms away from the sum of its own passes. `PassCostTape` fixes it for the erosion producer. It records
each pass after dispatch, with its frame id and units, and pairs it with the delivery for that pass, in dispatch
order. A reading that never comes is dropped when a later frame's arrives, never priced.

Gates, all on the reference host (Firefox 0.1-4.8 % CPU):

| gate | result |
|---|---|
| (a) heavy/trivial control, both orders (`tests/gpu/deferred-pass-timing.test.ts`) | every heavy pass reads 3.78-7.17 ms, every trivial pass 0.004-0.009 ms |
| (b) each erosion stage's reading equals its own passes' delivered time (`terrain-page-erosion-cost.test.ts`) | within 1 µs, every stage, 12 of 12 timed pages, 3 of 3 runs |
| (c) unusable readings on a quiet machine | 0 on the warm page and on all 12 timed pages, 3 of 3 runs |
| (d) readbacks per frame | 1.00 at 20, 44 and 88 timed passes; 0 per-pass reads. Babylon's own read: 20.00, 44.00, 88.00 |
| (e) frame interval against timed passes per frame (base 8.33 ms) | Babylon's read: 8.33 / 8.34 / 12.37 ms at 20 / 44 / 88; deferred: 8.33-8.35 ms at every count |
| (f) `2ec55a2`'s tests | every case kept, rebuilt on the tape, plus the two lag cases above; 17 of 17 |

The GPU tests that time passes (`terrain-compute-cost`, `ground-cover-compute`, `terrain-erosion-live-pump`) pass
on it. The Node tests for the instrument (18) and the stage coverage (17) catch 14 of 14 mutations.

(e) does not reproduce the ~0.49 ms per timed pass of the synthetic probe (RESOLUTION_PLAN.md section 3.2). On this
host and browser, per-pass reads cost nothing up to 44 per frame and about 4 ms at 88. `GpuTimingPolicy.ts` now
says so.

**The prices are not changed here.** The same three cost runs, on the fixed instrument, put whole pages at
49.3-52.0 ms against the pinned 37.4. Per dispatch: seed 0.37-0.42 ms (pinned 0.29), talus 0.36-0.38 (0.32), and
breach 2.8-3.2 ms per dispatch unit (0.067). They are recorded for the re-price, which is its own commit.

## The three per-page meters on the tape

The terrain page generator, the occlusion bake and the splat bake priced a reading as "latest delivered frame ÷
batch dispatched last" (`consumeGpuDispatchCostMs`). The clipmap reads its meters before it dispatches, so that was
right only while a reading landed within one frame. They now record each batch on a `PassCostTape` once the pass
exists, with its own page count, and price each delivery by that count.

The control (`tests/gpu/pass-cost-consumers.test.ts`) keeps every frame GPU-bound with a filler pass and runs ten
batches of 1-8 pages through each meter. Each meter is read every frame in the clipmap's order, and the generator
dispatches whenever production's own limit (a free bounds-ring buffer) allows. Over three runs:

| meter | tape | old path, same deliveries |
|---|---|---|
| terrain page generator | 39 of 39 pages, all of 81.3-87.0 ms | 9 of 10 readings paired with the wrong batch, worst ×8.00 |
| occlusion bake | 39 of 39 pages, all of 8.5-10.4 ms | 8-9 of 10 paired wrong, worst ×6.00; one batch lost in one run |
| splat bake | 39 of 39 pages, all of 8.8-9.6 ms | 8-9 of 10 paired wrong, worst ×6.00; one batch lost in one run |

The control fails if the old path is not caught going wrong, so it cannot pass on a run that never lagged. An earlier
run that waited for no page readbacks at all before each generator batch was stricter than production, and there
the old path mispaired only 0-1 of 10.

Ground cover stays on `consumeGpuDispatchCostMs`: it dispatches each ring at most once a frame at the ring's fixed
lane count and prices ring 0 as a batch of 1, which that path handles correctly. A source guard pins that pattern.

On the fixed instrument and the tape, `terrain-compute-cost.test.ts` measured terrainCompute 2.079 ms per page
(pinned 1.9), occlusionCompute 0.173 (0.3), splatCompute 0.331 (0.4), and the coarse splat bake at 0.673. They are
recorded for the re-price, not applied.
