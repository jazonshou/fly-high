# CDLOD node selection per frame — design note (P5, no code yet)

**Status:** a proposal for the PM, 2026-09-29. Nothing is implemented.

**Parent documents:**
- [`LOW_TIER_PERFORMANCE_PLAN.md`](LOW_TIER_PERFORMANCE_PLAN.md) (item P5)
- [`LOW_TIER_THROTTLE_BASELINE_2026_09_29.md`](../findings/LOW_TIER_THROTTLE_BASELINE_2026_09_29.md)

## What it costs today

`TerrainClipmapSystem.update()` runs three things every frame, from scratch:

1. `selectTerrainNodes`, the whole CDLOD tree from the 7×7 ring of 32.8 km
   roots;
2. `updateAtlasResidency`;
3. `writeNodeBuffers`, including `resolveTerrainResidentCornerMorphs`.

### In the game (4× baseline, tier 0, cruise; the host had one background core busy)

| Measure | Cessna | Notes |
| --- | ---: | --- |
| Terrain nodes selected | 224 of 224 | Selection stops on the **budget**, not the pixel threshold. |
| `TerrainClipmapSystem.update`, inclusive | 23.9% of the main thread | ≈ 5 ms of a ~20 ms throttled frame; ≈ 1.2 ms at 1×. |
| `selectTerrainNodes`, inclusive | 14.7% | ≈ 3.2 ms per frame at 4×. |
| `writeNodeBuffers`, inclusive | 6.0% | `resolveTerrainResidentCornerMorphs` alone is 3.1% self. |
| `world-page-visibility` pass, CPU p95 | 9.4 ms at 4× | Terrain, detail and wildlife together. |

The 747 has the same shape. `selectTerrainNodes` is still the top self-time
entry there.

### In isolation

`scripts/cdlod-selection-benchmark.mts` runs the real functions on the tier's
real inputs, over a 3,000 ft cruise path. `DEVIATION_SCALE=16` makes the budget
bind, as it does in flight.

| Tier | Nodes | `selectTerrainNodes` at 1× | Corner morphs at 1× |
| --- | ---: | ---: | ---: |
| 0 (budget 224, 4 px, finest L1) | 224 | 1.4-2.5 ms | 0.25-0.7 ms |

The spread comes from host load: other sessions were running, and the note
does not rely on a single figure. At an unbound deviation the selection stops
at 72 nodes and 0.16 ms, which shows that **the cost follows the number of
splits the budget buys.**

## What the selection's output depends on

The output changes when any of these change. An amortised design must
invalidate on every one:

- camera position;
- `pixelsPerMeterAtUnitDistance` (render height, field of view);
- the tier's `pixelThreshold`, `nodeBudget` and `finestResidentLevel`;
- **page residency**, through `deviationFor` / `heightRangeFor`. A page going
  resident changes what may split.

The morph factors (`morphK`, corner morphs) change continuously with camera
distance. The topology (which leaves exist) changes only when a split decision
crosses the threshold, or the budget ordering changes.

## Options

### C — Same output, less work (recommended first; all tiers)

- **Changes:**
  - Replace the string keys (`${level}:${x}:${z}` per candidate) with
    numeric keys. `invariantSlotKey(address)` is built twice per candidate in
    `TerrainClipmapSystem`'s `deviationFor`/`heightRangeFor`.
  - Reuse the candidate map, heap and sets across frames instead of
    allocating them per frame.
  - Skip corner-morph re-resolution for nodes whose quantised morphs did not
    change.
- **Output:** bit-identical by construction. **Proof:** a Node test that
  replays recorded selection inputs (the benchmark path, and the clipmap
  test's fixtures) through the old and new selector and asserts deep-equal
  node arrays and packed buffers.
- **Pins moved: none** (same nodes, same buffers, same pixels at every tier).
- **Saving:** unknown until prototyped. The string and allocation work is a
  large share of a ~1.6 µs-per-candidate cost, so a 30-50% cut in selection
  time is plausible, not promised. That is ≈ 1-1.5 ms per throttled frame. The
  benchmark prices it before any capture.

### A — Reuse the topology under small motion (tier 0 only, if C is not enough)

- **Change:**
  - Run the full selection only when one of these holds: the camera has moved
    more than *d* since the last full selection, or any invalidation input
    above changed (a residency version counter, the profile, the pixel
    scale).
  - Otherwise keep the previous leaves, and only refresh `distanceMeters`,
    `morphK` and the corner morphs.
- **Proposed d:** 1/8 of the finest emitted node's span. At tier 0 that is
  L2 = 256 m, so *d* = 32 m.
- **How often the full selection runs:** every ~0.5 s in a Cessna cruise
  (60 m/s), about every 0.25 s in the 747. That is about 1 frame in 12-25 at
  the throttled 50 fps.
- **Output:**
  - The topology lags by at most *d* of travel. The morph is still continuous,
    so a split lands slightly later rather than popping.
  - The 2:1 invariant and the budget hold, because the leaves always come
    from a legal selection.
  - A static pose is bit-identical, provided the invalidation is complete.
    The rig teleports, so its first frame at a pose is a full selection.
- **Pins moved: none,** if it is gated to tier 0. The capture rig shoots at
  tier 1 (`CAPTURE_QUALITY = "medium"`, balanced), so tier-0-only behaviour
  sits outside every pinned baseline and draw ceiling. Enabled at tier 1, the
  motion shots (`motion-banked-turn`, `page-thrash-turn`, `cdlod-transition`)
  could move, and would be re-measured on a quiet host.
- **Saving:** most of `selectTerrainNodes`, ≈ 3 ms per throttled frame, and
  the residency walk on the skipped frames.
- **Risk:** a missed invalidation shows as terrain holes or stale LOD.
  - Guard: a debug assertion mode that runs both and compares on every frame
    in tests.
  - Guard: a Node test that walks residency changes and asserts re-selection.

### B — Half-rate selection at tier 0 (the simplest; not recommended)

- **Change:** select every other frame, and refresh the morphs every frame.
- **Saving:** ≈ 50%.
- **Downside:** it lags by one frame even when the camera is fast (a
  take-off turn), where A lags only on slow motion. A is better on both
  counts.

## Recommendation

1. **C first**, at all tiers, as a pure refactor with a bit-identity test.
   Priced by the benchmark, then confirmed by the probe at 4×.
2. **A at tier 0 only**, if the take-off margin still needs it after P1/P2/P3.
   Take-off is currently 31 fps against a bar of 24, and the 4× take-off
   frame is where terrain streaming is heaviest.
3. Neither touches `src/render/webgpu/aircraft/**` or the cockpit pins. C
   touches `TerrainQuadtree.ts` and `TerrainClipmapSystem.ts` plus tests; A
   adds a tier-0 flag in `QualityProfile.ts`.
