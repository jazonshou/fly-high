# Resolution Plan — Repairing the WebGPU Build

**Created:** 2026-08-21
**Decision:** Repair the current branch. Do **not** restart from `7d2c964`.
**Performance goal (set 2026-08-21):** a strict **60 fps at tier 1 (medium/balanced)**.
**Nominal estimate:** ~30 working days for correctness. **+ the 60 fps programme — see §3.**
**Status:** G0-2 has been RUN; its result is in §3 and it changes the plan. Everything else not started.

---

## 1. The decision, and why

The prompting question was whether to abandon the 104-commit Babylon/WebGPU migration and restart from the
three.js prototype at `7d2c964` ("Improve rendering and controls", 2026-08-16), which felt smoother and
subjectively better-looking.

**Three facts decided it.**

1. **`src/sim/*` and `src/input/index.ts` are byte-identical between `7d2c964` and the branch tip.** The flight
   model, assists, pitch retention and input handling never changed. "Feels smoother" is therefore frame
   *delivery*, not handling — and restarting carries no guarantee of fixing it, because the code that produces
   the feel is already the same code.
2. **The defects are concentrated in the newest two commits, not in the migration.** `2531c1a` + `7f09f8a`
   changed 51 files under `src/` (+9,277/−319) in the last ~18 hours, including the entire land-cover/splat path
   and a 1,500-line new water stack whose shader did not compile until `7f09f8a`. The Phase-4.5 capture of the
   same shots has none of the worst artifacts.
3. **Every defect found is a located, named bug** — three of them numeric-range or units errors of a few lines.
   None is a property of Babylon or WebGPU. The same pipeline concurrently renders correct grass micro-detail at
   2 m, correct river networks, a correct sky, and 190 draws at 47.8 fps.

Restarting costs ~266 renderer files, the real-adapter GPU suite, and `perf:capture` — the only instrument that
has ever caught a visual defect in this project, and which caught all of these the first time it was pointed at
the branch. The old build's terrain structurally *cannot* splotch because it is a continuous HSL lerp with no
material classes; that is the same fact as its graphics being plain.

---

## 2. Evidence base

Everything below is grounded in a **fresh 16-shot `perf:capture` run on the branch tip**, executed 2026-08-21
09:04–09:20 from a clean worktree of `jazonshou/Phase-5-Implementation`. It is not the committed baseline.

### 2.1 The committed baseline is stale — do not quote it

`git log --follow` on every file in `tests/perf/baseline/` terminates at **`e8b90b1` "Implement Phase 4.5"**.
`git diff e8b90b1 7f09f8a -- tests/perf/baseline/` is empty; the blobs are bit-identical at both ends. The
committed `report.json` is byte-identical to the 15:39 post-fix rebaseline.

**Therefore the committed baseline describes `e8b90b1` — two commits and 51 source files ago.** Today's capture is
*faster* in 12 of 16 shots. Any number quoted from `tests/perf/baseline/report.json` is describing a build that no
longer exists.

### 2.2 The branch tip fails its own regression gate

The fresh run **failed**. SSIM against the committed baseline, threshold 0.985:

| Shot | SSIM | fps (tip) | fps (4.5) | CPU ms | GPU ms | interval P95 | draws |
|---|---:|---:|---:|---:|---:|---:|---:|
| canopy-1200ft | **0.307** | 18.0 | 20.9 | 7.2 | 13.08 | 59.9 | 539 |
| approach-500ft | **0.479** | 19.1 | 19.1 | 7.1 | 10.44 | 57.2 | 441 |
| forest-500ft-sunbehind | **0.563** | 16.5 | 20.6 | 7.8 | 13.77 | 67.3 | 553 |
| reference-viewport | 0.559 | 22.1 | 15.8 | 6.4 | 10.76 | 49.9 | 440 |
| winter-noon | 0.666 | 24.3 | 18.7 | 5.6 | 10.36 | 45.7 | 440 |
| ground-2m-lowsun | 0.666 | 26.5 | 25.0 | 6.1 | 13.32 | 42.8 | 539 |
| runway-on-approach | 0.718 | 20.1 | 18.9 | 7.1 | 13.82 | 55.9 | 573 |
| coast-10km-lowsun | 0.872 | 44.9 | 41.2 | 3.9 | 5.14 | 27.1 | 268 |
| slant-10km | 0.893 | 47.6 | 43.9 | 3.6 | 4.31 | 25.7 | 243 |
| cruise-horizon | 0.904 | 43.9 | 43.9 | 4.0 | 5.76 | 28.4 | 295 |
| high-10000ft-down | 0.969 | 42.2 | 38.0 | 4.0 | 5.73 | 28.2 | 295 |
| cdlod-transition | — | 47.8 | 40.3 | 3.7 | 2.45 | 31.8 | 190 |

Phase 5 changed the appearance of everything near the ground and was never rebaselined.

### 2.3 Confidence labelling

Findings below carry one of three labels. This matters: an adversarial verification pass refuted 2 of 3 lenses on
most root causes, and 3 of 3 on one. **Treat unverified mechanisms as hypotheses to test, not as work orders.**

- **[VERIFIED]** — independently confirmed by direct inspection of source, git, or the rendered frame.
- **[EVIDENCED]** — specific file:line citations and measurements supplied, internally consistent, not
  independently re-derived.
- **[HYPOTHESIS]** — plausible mechanism, materially contested during verification, must be A/B'd before any work
  is scheduled against it.

---

## 3. The 60 fps goal — measured, not estimated

**Goal:** a strict 60 fps at tier 1. `medium` is tier 1 (`QualityProfile.ts:183-185`).

**This is looser than what the codebase already declares.** Tier 1 sets `frameTargetMs: 13.7`
(`QualityProfile.ts:277`) — about 73 fps — and defines a *hitch* as any frame slower than twice
that, i.e. 27.4 ms. At today's 43–67 ms P95, the near-ground shots are **entirely hitches by the
project's own definition**. The goal is not a new bar; it is enforcing an existing one that was
never measured.

60 fps = **16.67 ms**. For a strict goal the gate must be the **P95 frame interval**, not mean fps —
mean fps hides exactly the tail the user is feeling.

### 3.1 G0-2 has been run. Result below.

Interleaved **B → A → B** on one host (Apple M3 Pro, 14 GPU cores), 1280×720, DPR 1, plus the three
earlier control runs. `VITE_NO_GPU_TIMING=1` disables `engine.enableGPUTimingMeasurements`.

| shot | timing **ON** (fps / P95 ms / hitches / triangles) | timing **OFF** (fps / P95 ms / hitches / triangles) | valid? |
|---|---|---|---|
| `cdlod-transition` | 48.6, 50.6, 55.2 / 27–34 / 4 / **1.52–1.55 M** | 95.8, 94.6 / 20.5–22.3 / 3–4 / **0.31 M** | ❌ **NO** |
| `forest-500ft-sunbehind` | 16.8, 18.8, 19.7 / 56–67 / 38, 94, 222 / **3,009,077** | 22.0, 20.9 / 50.7–54.7 / 4, 13 / **3,009,077** | ✅ yes |

> **`cdlod-transition` is INVALID and must not be quoted.** The timing-off runs rendered a scene with
> **4.9× fewer triangles** (313,875 vs ~1.52 M) and fewer than half the resident pages (22 vs 55–57).
> Faster frames changed how much had streamed in by the measurement window, so the comparison measures
> a lighter scene, not the flag. An earlier revision of this plan quoted its 50.6 → 95.2 fps as the
> headline result. **That was wrong.** Re-run it with page residency pinned before believing anything
> about the light-frame class.

**The one valid in-app measurement** is `forest-500ft-sunbehind`, where triangles (3,009,077) and
draw calls (521) match exactly across conditions:

- **fps: 18.8 → 21.5 median. ~+14%**, about 7 ms off a ~59 ms frame.
- **hitches: 94 → 8 median.** Large, and the thing the user actually feels — but note resident pages
  still differed (109–110 vs 92–93), so even this is not perfectly controlled for streaming.

### 3.2 What it means

**Established in-app:** GPU timestamp instrumentation costs ~7 ms of a ~59 ms heavy frame (+14% fps)
and sharply reduces hitches. **Not established:** anything about the light-frame class — see the
invalidated row above.

**Isolated in a controlled probe** (synthetic WebGPU harness on this host, not the app — treat as
`[EVIDENCED]`, not `[VERIFIED]`): the cost is **not** the instrumentation as such. Individually and
combined, none of these moved the rAF interval off 8.33 ms — 96 extra bare `queue.submit`s/frame,
150 `mapAsync`es/frame, 44 compute passes carrying `timestampWrites`, 440 draws + 44 computes.

**The one configuration that costs is `resolveQuerySet` issued in its own command buffer, once per
timed pass:** 20 passes → 9.9 ms, 44 → 21.1 ms, 53 → 25.5 ms, 88 → 43.2 ms. Slope **0.489 ms per
timed pass**, intercept ≈ 0.

**Batching those resolves into one submit per frame restored 8.33 ms at every N tested.** Headed
control on a real 60 Hz panel: 16.66 ms base → 20.51 ms with 44 per-pass resolves → **16.67 ms
batched**. So it is not a headless artifact, and on a 60 Hz display this alone is the difference
between hitting and missing 60.

**This changes the remediation for the better.** The plan previously said duty-cycle the timing,
accepting a blinded governor between samples. Batch the resolves instead and you keep full
instrumentation at no cost. Do not ship a disabled flag.

> **Caveat on the law:** 0.489 ms/pass is calibrated on a synthetic probe. It does not reconcile
> cleanly with the in-app forest result (~52 timed passes would predict ~25 ms; only ~7 ms was
> observed), which means either the app's timed-pass count is much lower than derived, or the heavy
> frame is bottlenecked elsewhere so the saving does not show 1:1. **Do not treat 0.489 ms/pass as a
> committed constant.** Use it for ranking, not budgeting.

**Two honest qualifications.**

1. **Even the light frame fails a strict P95 gate.** 95 fps mean, but P95 interval 20.5–22.3 ms —
   a tail equivalent to 45–49 fps. Mean fps ≥ 60 is met; P95 ≤ 16.67 ms is not.
2. **Turning timing off blinds the instrument.** `gpuFrameMsP95` reads exactly `0.00` in every B
   run. The `RenderInvariants.ts` comment is right: this silently blinds Governor A and every perf
   capture. **The fix is duty-cycled timing, not a disabled flag** — and the invariant is asserted
   in **two** places (`FlightRenderer.ts:513` and `:816`), not one.

### 3.3 The risk case is now the actual case

With instrumentation removed, `forest-500ft-sunbehind` still sits at 21.5 fps / 52.7 ms P95 with
only 8.8 ms of CPU. **~40 ms remains unattributed in the heavy frame**, at identical triangle and
draw counts. This is the finding that survives; it does not depend on the invalidated shot.

Therefore **workstream D is promoted from conditional to mandatory**, exactly as the risk case
predicted. Reaching 60 fps near the ground needs roughly a **3× improvement** on vegetation-heavy
frames, which the instrumentation fix does not deliver.

### 3.4 Frame budget at tier 1, 16.67 ms

| Line | Cruise class today | Near-ground today | Target | How |
|---|---:|---:|---:|---|
| CPU (in `render()`) | 4.0–6.6 | 6.6–8.8 | ≤ 6 | cpu-side work, workstream D |
| GPU | 2.5–2.9 | 12.6–14.3 | ≤ 10 | vegetation overdraw, MSAA, shadows |
| Timestamp instrumentation | *unmeasured* | ~7 (measured) | **0** | batch `resolveQuerySet` (G0-2) |
| Unattributed remainder | *unmeasured* | ~40 (measured) | ≤ 2 | **workstream D — the open term** |
| **P95 interval** | **27–34** | **56–67** | **≤ 16.67** | |

The near-ground column does not close without D. That is the honest statement. **The cruise column
is currently unmeasured at matched geometry** — do not plan against it until §3.1's invalid shot is
re-run.

### 3.5 The 60 fps gate, as an enforceable test

Do not gate on mean fps. Add to `perf:capture` ceilings:

- **`frameIntervalMsP95 ≤ 16.67`** on every shot at tier 1.
- **`hitchCount ≤ 5`** per 240 measured frames (the project's own hitch definition, 2 × 13.7 ms).
- **`maxFrameMs ≤ 50`** — today's B runs still spike to 1026 and 1445 ms, which no fps average
  reveals and which is likely what "not smooth" actually is.
- Gate the **worst** shot, not the mean of shots.

**This gate is not meaningful until C-2 lands.** The harness currently varies hitchCount 14 vs 232
on identical code. Ship determinism before the ceiling, or the gate will flap.

---

## 4. Implementation log — 2026-08-21

### 4.1 Gate 0 is DONE and committed

| commit | item | result |
|---|---|---|
| `26ee76e` | **G0-1** analytic default | `forest-500ft` 3,009,077 -> 1,663,462 tris, 521 -> 396 draws |
| `bcf0934` | **G0-2** selective GPU timing | P95 -20% on both shots, GPU counter intact |

**G0-2 did not land as planned.** The plan said "batch the `resolveQuerySet` calls". Built that
first: it patches Babylon's `WebGPUQuerySet` to coalesce the frame's readbacks into one submit.
It won on mean fps and lost on everything else — see the deviation log (D-7).

What shipped instead: Babylon gates BOTH the timestamp write and the resolve on
`if (gpuPerfCounter)` (`Extensions/engine.computeShader.pure.js`), so clearing `gpuTimeInFrame`
removes a dispatch from the timing system outright. Only three counters have consumers here
(main pass, shadow target, and `TerrainPageAtlas`/`PageOcclusionBake` -> `ComputeBudget`), and the
ocean's ~44 dispatches per frame are not among them. `withoutDispatchTiming` drops the counter at
the seven sites outside that set; a static test requires every future `new ComputeShader` to be
wrapped or to name its consumer.

Measured, matched geometry, control run back-to-back:

| shot | control P95 | G0-2 P95 | control fps | G0-2 fps |
|---|---:|---:|---:|---:|
| `cdlod-transition` | 30.6 | **24.4** | 44.6 | **59.8** |
| `forest-500ft-sunbehind` | 45.8 | **37.5** | 24.3 | **29.6** |

### 4.2 What the envelope is NOT

Four candidates eliminated by measurement, not argument. **Do not re-litigate these.**

| candidate | effect on P95 | verdict |
|---|---|---|
| GPU timing instrumentation | **-6 ms** | real; fixed in `bcf0934` |
| Ocean compute (all 44 dispatches disabled) | -1.1 / -1.6 ms | **not the envelope** |
| Cloud compute (`clouds.update` disabled) | -0.3 / -0.8 ms | **not the envelope** |
| Harness rAF pump serialisation | **0.0 ms** | **not the envelope** |

**The ocean visibility gate named in G0-2 is CANCELLED.** It buys ~1.5 ms, not the ~20 ms
assumed. The ablation cost one capture and saved building it.

The rAF-pump theory deserves a note because it was wrong in an instructive way: the harness
re-registers `requestAnimationFrame` only after `render()` returns, which cannot pipeline, and the
vsync arithmetic fit both shots exactly. Pre-registering the frame changed nothing (24.1 -> 24.0,
38.8 -> 39.2). **Arithmetic that fits is not evidence.**

### 4.3 What the envelope IS: vsync quantisation

| condition (`cdlod-transition`) | fps | P95 |
|---|---:|---:|
| no rendering at all | **121.3** | — |
| render, vsync on | 59.4 | 24.1 |
| render, `--disable-gpu-vsync --disable-frame-rate-limit` | 71.4 | 29.8 |

**The environment is not the constraint** — it delivers ~8.24 ms rAF cadence (120 Hz) with
rendering skipped. And 59.4 fps is not incidental: it is exactly TWO vsyncs
(2 x 8.33 = 16.67 ms = 60.0 fps). Frames land on vsync boundaries, and the "unattributed
envelope" is the wait for the next boundary, not work.

Restated for each shot:

- `cdlod-transition`: work ~7.6 ms, fits 2 vsyncs -> **already 60 fps mean**. It fails a strict
  P95 gate (24.1 ms = 3 vsyncs) because some frames slip one boundary.
- `forest-500ft`: cpu 6.6 + gpu 10.0 = 16.6 ms, lands at **4 vsyncs** -> 28.8 fps. Pipelined it
  would be `max(6.6, 10.0)` = 10 ms -> 2 vsyncs -> 60 fps. It is not pipelining.

**Unlocking vsync is not a fix.** Mean fps rises to 71.4 while P95 gets worse (29.8) and
`maxFrameMs` reaches 1487. The goal is P95, so this is a regression dressed as an improvement.

### 4.4 The 60 fps problem, correctly posed

Two questions, in this order:

1. **Why does 16.6 ms of measured work cost 33 ms of wall clock?** cpu and gpu appear to
   serialise rather than pipeline. If they pipelined, `forest-500ft` would already be at 60 fps.
   This is worth more than any amount of draw-count work and it is **plan item C-1**.
2. **Then** reduce work to fit one 16.67 ms window with margin.

**C-1 is promoted ahead of D-1.** Draw-count reduction does not address serialisation, and until
question 1 is answered its 8-16 days would be aimed at the wrong term — the same mistake the
cancelled ocean gate nearly repeated.

---

## Gate 0 — two experiments that gate everything

**1.5 days. Nothing else starts until both land.** Both are cheap and either could invalidate weeks of planning
in either direction.

### G0-1 — Flip the world evolution default back to `"analytic"` (0.5 d)

`DEFAULT_WORLD_EVOLUTION` is set to `"eroded"` at `src/world/world.ts:16`, and `src/game/FlightGame.tsx:111`
calls `createWorld(seed)` with no override, so the shipped app takes it unconditionally. **[VERIFIED]**

In that path, height-page generation abandons the batched WGSL dispatch (~1.9 ms/page) and short-circuits to one
page at a time through a single CPU worker at ~2.1 s (L0) to ~5.5 s (L2+), with a full second recomputation for
any separately-admitted channel slot. **[EVIDENCED]**

The consequence chain is that page *supply collapses below demand*, and then every downstream system correctly
does the right thing with nothing to work on:

- `deviationFor` returns null for a non-resident page → `measured:false` → 4.5-A1 **correctly refuses to split**
  → nodes stay at `COARSEST_NODE_LEVEL` 9, a 32,768 m span
- `slotFor` returns −1 → `terrainSampleHeight` returns literal `0.0` (`TerrainSurfacePlugin.ts:332-333`) → flat
  at sea level
- `provisionalAxisFor` returns the `Grass` fallback axis → the one surviving per-node constant material

That is a large flat sea-level grass plate — i.e. **splotches**, produced without any of the Phase 4.5 fixes
having regressed. The plan records that explicit `"analytic"` worlds stay bit-compatible with the historical
kernel, so this is a flag flip, not a revert.

**Exit:** app reaches the start screen in ≪ 11 s; re-run `perf:capture`; record which artifacts survive.
**This is also the cheapest possible experiment separating "Phase 5 broke it" from "the migration is bad."**

### G0-2 — ~~The timestamp-flag A/B that has never been run~~ **RUN 2026-08-21 — see §3.1** (2 d)

Across today's 16 shots there is a **~21 ms floor at 190 draws rising to ~47–53 ms at 553 draws**, while measured
GPU time moves only 2.45 → 13.82 ms. That is roughly 93 µs per draw landing outside *both* instruments — far
above the repo's own 26 µs/draw GPU ledger. **[VERIFIED — the arithmetic, from the fresh report]**

`src/render/FlightRenderer.ts:506` sets `engine.enableGPUTimingMeasurements` unconditionally, while line 493 in
the same options object gates debug markers on `NODE_ENV`. The proposed mechanism — that Babylon 9.21.2 responds
by issuing one out-of-band `device.queue.submit` plus one `mapAsync` readback per timestamped pass, ~50–75 per
frame instead of one — is **[HYPOTHESIS]**. It was contested on sufficiency during verification and I think that
challenge was fair.

**Run:** set the flag false, relax the `RenderInvariants.ts:71-77` startup assertion, gate the
`spectral-ocean-compute` frame-graph node (`FlightRenderer.ts:1342`) on water visibility, then `perf:capture`
back-to-back against an unmodified worktree on one idle host.

**RESULT (§3.1):** at matched geometry, disabling timing gives the heavy frame only +14%
(18.8 → 21.5 fps), leaving ~40 ms unattributed. The light-frame reading was invalid. **Workstream D
is now mandatory**, and a controlled probe points the fix at batching `resolveQuerySet` rather than
disabling instrumentation.

**Remaining work here is no longer the experiment but the landing:** duty-cycle the timing rather
than disabling it (a disabled flag zeroes `gpuFrameMsP95` and blinds Governor A), relax **both**
invariant assertions (`FlightRenderer.ts:513` and `:816` — there are two, not one), give the
governor a signal that survives, and gate the ungated `spectral-ocean-compute` node. Re-sized 1 d → 2 d.

> **Host caveat.** Same code on the same host today varied `hitchCount` 14 vs 232 on one shot and up to 75% in
> triangle count, and fps drifts ~20% with thermal state. Run A and B back-to-back on one host, in both orders.

---

## Workstream A — Visual defects

### A-1 — Water-surface placement regression (3 d) — `[VERIFIED]`

`coast-10km-lowsun.png` has a **flat saturated teal quad hanging in mid-air over dry land** directly ahead of the
aircraft, with a hard-edged grey rectangle and diagonal hatched ring fringes to its right.
`cdlod-transition.png` has a pale-blue rectangle clipping across a headland and a second cyan rectangle over
land. Nothing in the ten-material terrain classifier is cyan — cyan is water. The Phase-4.5 capture of the
identical shots contains none of them.

Source: the Phase-5 water stack — `BathymetryClipmap.ts` (748 new lines, whose shader did not compile until
`7f09f8a` renamed the WGSL reserved word `target`) and `ChannelNetwork.ts` (773 new lines), plus `HydrologySystem`.

**Work:** debug elevation, extent and culling of the bathymetry and channel clipmap rings.
**This is the single clearest defect and the newest code. It is what you are actually looking at.**

### A-2 — Vegetation radial-scale units bug (4 d) — `[EVIDENCED]`

`ground-2m-lowsun.png` shows trunks as enormous vertically-smeared cones and canopies as shredded vertical
ribbons.

`DetailInstanceMaterialPlugin.ts:196` computes `detailRadial = (0.5 + instanceScale.y*1.1) *
uniforms.detailRadialAspect`, and `:200` applies it as `positionUpdated * vec3f(H*detailRadial, H,
H*detailRadial)`. That transform is only correct for a prototype normalised to unit radius. The **rock path does
normalise** (`WorldDetailRuntime.ts:1290-1300` divides its prototype's own 1.10 radius out) — which is the proof
of the intended convention. The **tree and shrub paths pass `aspect = prototype.boundingRadius`**
(`:1904-1910`, `:2044-2046`) while `prototypeGeometry.finalizeGeometry` performs no normalisation, so the aspect
is applied twice. `radialMultiplier` (`:1719-1729`) solves `mult = r/(H·aspect)`, leaving the rendered radius
short by exactly one factor of `aspect`.

Reported measurement, seed 7, variant 0:

| species | crownAspect | intended R (m) | rendered R (m) | ratio | card stretch |
|---|---:|---:|---:|---:|---:|
| spruce | 0.296 | 5.28 | 1.56 | 0.30 | 6.25× |
| pine | 0.361 | 5.58 | 2.02 | 0.36 | 5.54× |
| cedar | 0.371 | 7.35 | 2.73 | 0.37 | 4.76× |
| birch | 0.387 | 5.28 | 2.04 | 0.39 | 4.55× |
| maple | 0.478 | 7.80 | 3.73 | 0.48 | 3.33× |
| oak | 0.515 | 8.00 | 4.12 | 0.52 | 3.13× |
| willow | 0.608 | 7.77 | 4.72 | 0.61 | 2.70× |

All seven trunks additionally fall below `DETAIL_INSTANCE_RADIAL_MIN = 0.5` and clamp, decoupling trunk radius
from the generator entirely.

**Scope warning — this is not a one-line fix.** One quantised `instanceScale` lane is decoded by three different
formulas (near/mid cards, far impostors at `DetailInstanceMaterialPlugin.ts:150`, rocks). The lane's `[0.5,1.6]`
range cannot represent forest-edge or krummholz crowns even after correction, and authored prototype crown
proportions disagree with the generator's `crownRatio` by ~1.6–2.1×, so some card stretch survives any pure scale
fix unless prototypes are re-authored. Budget for the impostor band moving, and add the missing round-trip
assertion.

### A-3 — TWI wetness driver window (1.5 d) — `[EVIDENCED]`

`approach-500ft.png` ground is uniform flat brown with no material variety. The flow-accumulation field feeding
the new TWI wetness driver has a hard 262,144 m² floor (`EVOLUTION_TEXEL_METERS` 512, squared;
`TerrainErosionCompute.ts:390-392` discards the local MFD result). Over the `TERRAIN_TWI_DRY=4 .. WET=18` window
that pins dry=0 and wet=1 for **every slope from 1° to 45°, worldwide** — zeroing `DryGrass` outright, damping
`Shrub` to 0.4, and pinning `Grass`/`ForestFloor` at max.

**Work:** divide contributing area by local cell area before the log, *or* re-window `TERRAIN_TWI_DRY/WET`
against the field's measured distribution, *or* stop discarding the local MFD result. Re-check the other
consumers (soil depth, riparian density).

> The hierarchical-boundary comment at `TerrainErosionCompute.ts:381-386` is a **deliberate invariant**. Decide
> against it explicitly; do not just widen the window.

### A-4 — Foliage dither crossfade has no resolve (3 d) — `[EVIDENCED]`

The near/mid/far band system is built on an ordered-Bayer screen-space crossfade whose companion resolve was
never implemented: the alpha test is a `discard`, so MSAA resolves nothing; FXAA is detached whenever MSAA > 1
(`FlightRenderer.ts:804-805`); and no scene TAA exists. The result is the harsh green/black stipple and per-pixel
shimmer.

**This is the strongest candidate for "feels less smooth" that is independent of fps** — `motion-banked-turn`'s
frame-to-frame SSIM tracks vegetation presence exactly, at constant brightness.

**Work:** enable alpha-to-coverage on the alpha-test detail bucket (MSAA 2× is already paid for and currently
buys foliage nothing), or re-attach FXAA alongside MSAA for vegetation-heavy tiers.

### A-5 — Coarse-LOD height residency fallback (4 d) — `[EVIDENCED]`

When a node's page is not resident, `terrainSampleHeight` returns literal `0.0`
(`TerrainSurfacePlugin.ts:332-333`) and `provisionalAxisFor` falls back to a constant `Grass` axis. Any producer
latency therefore degrades to a 32.8 km flat sea-level grass plate.

G0-1 removes today's *trigger*, but not the failure class: this re-fires on cold load, on eviction churn, on fast
traverse, and whenever `AdaptiveGovernor` sheds terrain page admissions — which is its first three CPU rungs.

**Work:** sample the nearest resident ancestor page (the shader already samples a parent at
`TerrainSurfacePlugin.ts:406-416`) or the existing `GlobalHeightPyramid`.

### A-6 — Splat texel size at range (4 d) — `[EVIDENCED]`

A channel texel is `4·2^L` m, so at coarse CDLOD levels the filtered footprint is hundreds of metres and material
boundaries stay hard blocks in the mid-field. Visible in `slant-10km.png` and `cruise-horizon.png`, both at
`vegetationBatches = 1`.

This is the one piece of the *original* splotch report that Phase 4.5 explicitly did **not** fix
(`PHASE_4_5_EXECUTION_PLAN.md:303-307`), deferring it to a §5.2 that Phase 5 then reassigned to erosion. It is the
last visual item standing between the build and "not splotchy at cruise altitude."

Same pass: delete the baked-and-never-read `splatIdHi` channel.

---

## Workstream B — Frame delivery

### B-1 — Act on the Gate 0 result (0 d — decision point)

If G0-2 collapses the envelope, land the flag gating properly: give `AdaptiveGovernor` a GPU signal that survives
it (duty-cycled timing — enable N frames every M seconds — or steer Governor A on `frameIntervalP95Ms`), amend
`RenderInvariants.ts:71-77` and its test, and re-pin the Z-2 ceilings.

If it does not collapse, **workstream D becomes mandatory and this plan's estimate changes.** Say so out loud
before continuing.

---

## Workstream C — Instrument repair

### C-1 — Real frame attribution, and close assertion 67 (5 d) — `[VERIFIED]`

`presentWaitMs` is hard-wired to `null`: `FlightRenderer.ts:1857` passes a literal `null` for `gpuBusy`, and
`frameAttribution.ts:39-41` nulls `presentWaitMs` whenever `gpuBusy` is null. **The one field designed to name
the 20–47 ms envelope has never been capable of showing a number.** Assertion 67 (per-pass GPU timer) has been
carried open across three phases.

**Work:** stop passing the literal null; add main-thread-outside-`render()` accounting; add a present/compositor
timer or an honest, labelled upper bound.

### C-2 — Make `perf:capture` deterministic, then rebaseline on HEAD (in C-1's 5 d)

Same code, same host, two runs today: `hitchCount` 14 vs 232, triangle counts varying up to 75%. **Until this
lands, no ms-level claim about this build can be trusted in either direction — including the claims in this plan.**

> **Read SSIM correctly during this work.** The committed baseline fails 13 of its own 16 minFps ceilings, and the
> SSIM oracle is self-referential against that same degraded baseline. A uniformly degraded frame currently scores
> *better* on every gate the harness has. **Fixing the pixels will make SSIM drop, not rise.** Do not read that as
> a regression.

---

## Workstream D — Draw count `[MANDATORY — promoted 2026-08-21 by the G0-2 result]`

### D-1 — Vegetation draw-count reduction (8 d)

**Now required for the 60 fps goal.** Crown/trunk mesh merge (already priced at 347 → 186 draws) and
presentation-chunk re-tiering.

§3.1 measured the heavy shot at 21.5 fps / 52.7 ms P95 with instrumentation off and only 8.8 ms of
CPU — ~40 ms still unattributed, with draw count (190 vs 521) the distinguishing variable between the
two shots. Reaching 16.67 ms near the ground needs roughly **3×**, and nothing else in the plan
delivers it.

**8 d is the merge and re-tier only.** If that does not close the gap, the next levers are a depth
prepass for the alpha-test vegetation bucket, GPU-side scatter, and moving tier-1 vegetation settings
down — each of which costs visible quality on medium. Budget a further 5–8 d and expect a scope
conversation.

This is the one item in the plan that is genuinely architectural. Note it becomes *more* urgent after A-2, which
increases rasterised foliage area 1.7–3.3× on exactly the slowest shots.

---

## Sequencing

```
Gate 0        G0-1 flag flip ──┐
(1.5 d)       G0-2 timestamp A/B ──┴──> DECISION: nominal or risk case
                                          │
Wave 1        A-1 water quads (3 d) ──────┤   newest code, clearest defect
(~8.5 d)      A-3 TWI window (1.5 d) ─────┤   restores near-field material variety
              A-4 alpha-to-coverage (3 d) ┤   the "smoothness" that is not fps
                                          │
Wave 2        A-2 vegetation units (4 d) ─┤   largest visible-quality win
(~8 d)        A-5 residency fallback (4 d)┤   removes a failure class permanently
                                          │
Wave 3        C-1 + C-2 attribution and   │
(~5 d)            determinism (5 d) ──────┤   makes every later number trustworthy
                                          │
Wave 4        A-6 splat texel size (4 d) ─┤   last cruise-altitude visual item
(~4 d)                                    │
                                          │
Wave 5        D-1 draw count (8 d) ───────┘   MANDATORY for 60 fps (was conditional)
(~8-16 d)     + depth prepass / GPU scatter / tier re-cut if 8 d does not close it
```

**Correctness only (waves 0–4): ~27–30 days.**
**Strict 60 fps at tier 1: + 8–16 days on top, and a scope conversation if the merge alone
does not close the near-ground frame.** Whether the cruise/high-altitude class clears 60 fps from
G0-2 alone is **unproven** — the run that suggested it was invalid (§3.1). Re-measure with pinned
page residency as the first task of the 60 fps programme.

Wave 1 is ordered first deliberately: it is the newest code, the clearest defects, and the fastest path to
something that looks right. A-2 sits in Wave 2 rather than Wave 1 because it will *cost* fps until D-1 or the
Gate 0 fix lands, and it is better to take that hit against a known frame budget.

---

## Risks

1. ~~**The ~21 ms floor + ~93 µs/draw is not bounded from source.**~~ **RESOLVED 2026-08-21 (§3.1).**
   Instrumentation owns ~12 ms of the light frame and ~7 ms of the heavy one. ~40 ms remains
   unattributed in the heavy frame after removing it. D-1 is mandatory; the estimate moved.
2. **No shot has ever exceeded 47.8 fps at matched geometry.** The 95.8 fps `cdlod-transition`
   reading is invalid (4.9× fewer triangles). A controlled probe *does* show a real 60 Hz panel going
   16.66 → 20.51 → 16.67 ms with per-pass vs batched resolves, so the ceiling is plausibly the
   instrument — but that is **not yet demonstrated in the app**. Re-run with pinned residency.
   **"The old build feels smoother" is still entirely unmeasured on this host**, and now matters
   more, not less: if `7d2c964` also sat near 20 fps over forest, the felt difference was hitches and
   stipple, not framerate. Capture it before committing to workstream D's later half.
3. **The harness is not deterministic** (see C-2). Every conclusion before C-2 lands is provisional.
4. **A-2 will temporarily make fps worse**, multiplying rasterised foliage area 1.7–3.3× in a discard-based
   alpha-test bucket with no depth prepass, on shots already at 16–20 fps. Expect a regression between A-2 and D-1.
5. **A-2 is less contained than it reads** — three decoders of one quantised lane, a range that cannot represent
   edge cases, and prototype proportions that disagree with the generator by 1.6–2.1×.
6. **Phase 5's headline deliverable is not viable as shipped.** The eroded world costs 2–5.5 s per page on one CPU
   worker plus a 7.5 s macro pass gating all height generation. Keeping it means the unbuilt GPU port (plan items
   5-3/5-4, 8–14 d each), whose dominant kernels — priority-flood pit-breach, elevation-topologically-ordered MFD
   accumulation — are not naturally data-parallel. **This plan assumes you ship on `"analytic"` and treat the GPU
   port as a separate later workstream.**
7. **The build is WebGPU-only and enforced by test.** The 706-line 2D-canvas fallback and the WebGL2 context-loss
   recovery path were deleted, and `tests/render.webgpu-only.test.ts` forbids reintroducing them. Any machine
   without WebGPU that ran the old build cannot run this one at all.

---

## Explicitly not doing

- **Do not revert to `7d2c964`.** It fixes the splotches by deleting the features that splotch. Its real cost is
  re-doing Phases 1–5 on a backend with no compute shaders at all — the terrain kernel, ocean FFT, erosion DAG and
  cloud raymarch either die or move to CPU. Realistically 3–6 months to a lower ceiling than the build already
  standing.
- **Do not start with the performance work.** G0-2 is an hour of real work that could invalidate weeks of planning
  in either direction.
- **Do not quote `tests/perf/baseline/report.json`.** It describes `e8b90b1`.
- **Do not chase "smoother" through the flight model or input path.** Both are byte-identical to the old build.
- **Do not build the GPU erosion port to fix the splotches.** Flip the flag off and fix the rendering bugs.
- **Do not resolve the foliage stipple with scene TAA as a first move.** With a floating origin, CDLOD morphing
  and wind-animated instanced foliage, TAA is a new subsystem. Alpha-to-coverage is already paid for.
- **Do not accept a green test suite as evidence of anything visual.** 650 passing tests coexisted with four
  Phase-4 defects that only a PNG revealed, and the suite is green today against the frames in this plan.

---

## Deviation log

Record every departure from this plan here, with the reason and the evidence that prompted it.

| # | Item | Deviation | Why | Date |
|---|---|---|---|---|
| D-1 | G0-2 | Ran the experiment during planning rather than as the first work item. | The 60 fps goal could not be costed without it. | 2026-08-21 |
| D-2 | G0-2 | Sized 1 d → 2 d. | The timing invariant is asserted in **two** places, not one, and the flag cannot simply be disabled — it zeroes `gpuFrameMsP95` and blinds Governor A, so it must be duty-cycled. | 2026-08-21 |
| D-3 | D-1 | Promoted from `[CONDITIONAL]` to `[MANDATORY]`. | G0-2 collapsed the light-frame envelope but not the heavy-frame one (§3.1). | 2026-08-21 |
| D-4 | Risks 1–2 | Risk 1 resolved. Risk 2 **re-opened** after an initial "disproved". | The 95.8 fps reading came from a scene with 4.9× fewer triangles. Corrected same day. | 2026-08-21 |
| D-5 | G0-2 method | The A/B patched the same worktree a parallel analysis was reading, and overwrote `tests/perf/artifacts/report.json` mid-analysis. | Avoidable. Use a second worktree for experiments that run alongside analysis. | 2026-08-21 |
| D-6 | G0-2 remediation | Changed from "duty-cycle the timing" to "batch the `resolveQuerySet` calls". | Probe shows batching restores full speed with instrumentation intact — strictly better than sampling. | 2026-08-21 |
| D-7 | G0-2 | Batching REPLACED by selective per-dispatch timing. | Batching won mean fps (74.9/34.4) but regressed P95 to 29.4/63.1, took forest hitches 3 -> 44, and collapsed `gpuFrameMsP95` to an identical 0.3239 on both shots — a dead governor signal, via a vendor-internals patch. Selective is simpler, keeps the counter, and wins on P95. | 2026-08-21 |
| D-8 | G0-2 | Ocean visibility gate CANCELLED. | Ablation: disabling all 44 ocean dispatches moves P95 1.1-1.6 ms, not the ~20 ms assumed. | 2026-08-21 |
| D-9 | §4.3 | "No shot has ever exceeded 47.8 fps" finally explained. | Not a ceiling — vsync quantisation on a 120 Hz surface. The no-render floor is 121.3 fps. | 2026-08-21 |
| D-10 | Sequencing | C-1 promoted ahead of D-1. | The dominant term is CPU/GPU serialisation, which draw-count work does not address. | 2026-08-21 |

---

## Appendix — reproducing the evidence

```bash
# Clean worktree of the branch tip (this plan's evidence base)
git worktree add /tmp/phase5 jazonshou/Phase-5-Implementation
cd /tmp/phase5 && npm install && npx playwright install chromium

# The 16-shot capture. ~16 min. Writes PNGs + report.json to tests/perf/artifacts/.
npm run perf:capture

# Frames that show the defects, in priority order:
#   tests/perf/artifacts/coast-10km-lowsun.png   A-1  teal quad over dry land
#   tests/perf/artifacts/cdlod-transition.png    A-1  cyan rectangles over a headland
#   tests/perf/artifacts/ground-2m-lowsun.png    A-2  smeared trunks, shredded canopies
#   tests/perf/artifacts/approach-500ft.png      A-3  uniform flat brown ground
#   tests/perf/artifacts/slant-10km.png          A-6  hard splat blocks in the mid-field
```

Provenance checks used to establish that the committed baseline is stale:

```bash
git log --follow --oneline -- tests/perf/baseline/report.json   # terminates at e8b90b1
git diff --stat e8b90b1 7f09f8a -- tests/perf/baseline/         # empty
git diff --stat e8b90b1 7f09f8a -- src/                         # 51 files, +9,277/-319
```

### Reproducing the G0-2 A/B

The worktree was patched to gate the flag on an env var, feeding the same value to **both**
`assertStartupInvariants` call sites (`FlightRenderer.ts:513` and `:816`):

```ts
const timingEnabled = timestampQueries && import.meta.env.VITE_NO_GPU_TIMING !== "1";
engine.enableGPUTimingMeasurements = timingEnabled;
// ...and pass `timestampQuerySupported: timingEnabled` at BOTH assert sites.
```

```bash
SHOTS="cdlod-transition,forest-500ft-sunbehind"
VITE_NO_GPU_TIMING=1 VITE_PERF_SHOTS="$SHOTS" npm run perf:capture   # B
VITE_PERF_SHOTS="$SHOTS" npm run perf:capture                        # A
VITE_NO_GPU_TIMING=1 VITE_PERF_SHOTS="$SHOTS" npm run perf:capture   # B
```

Interleave B→A→B, not A→B→A: it puts the control between the two experimental runs so thermal
drift cannot masquerade as the effect. The capture test will FAIL on SSIM and ceilings either
way — that is expected; `tests/perf/artifacts/report.json` is still written. Note `gpuFrameMsP95`
reads `0.00` in every B run: disabling the flag removes the GPU signal entirely.
