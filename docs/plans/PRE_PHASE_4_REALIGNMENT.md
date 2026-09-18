# Pre-Phase-4 Realignment — binding amendments to the programme

**Date:** 2026-08-18. **Status:** binding. Amends `RENDERING_PLAN.md`,
`PHASE_2_EXECUTION_PLAN.md`, `PHASE_3_EXECUTION_PLAN.md` and `ARCHITECTURE.md`.

**Why this document exists.** Phase 0 and Phase 1 are merged; Phase 2 and Phase 3
are planned in full; Phase 4 is next to be planned. Before writing that plan the
whole programme was re-read against the three goals the user actually stated, and
every claim was checked against code rather than against the plan text. Twenty-two
findings survived adversarial verification. Most confirm the programme is on
track. Six change what gets built and in what order, and they are the reason this
file is binding rather than advisory.

> **Status (2026-08-19).** Phase 2 closed 2026-08-19. Gate 7A and the vegetation
> perf-debt pass executed 2026-08-19 as Phase 2.5 (commit `46bc24a`).
> `PHASE_4_EXECUTION_PLAN.md` has since been written (see §8b) and re-prices
> Phase 4 at **46.5 d**.

Amendments are numbered `R-n` and are quoted by the documents they amend.

---

## 0. The three goals, defined once

`RENDERING_PLAN.md` refers to "user goals" `G1`–`G10` in eight places and
**never defines them anywhere in the repository.** The two coverage claims it
makes against that undefined list contradict each other — line 38 says "nine of
the ten user goals" at ~156 days, line 336 says "Eight of nine user goals" at
~147 days, for the same cut line. An undefined goal list cannot be checked for
coverage, and that is precisely how the single largest gap in the programme
(§1 below) went unnoticed through three planning documents.

The goals are therefore restated here, in the user's own terms, and these three
supersede `G1`–`G10` as the coverage authority:

| | Goal | Test |
|---|---|---|
| **G-A** | **Genuine, realistic graphics.** Clouds, water, *where water is placed*, mountains, terrain surface, trees, *where trees are placed*, all other foliage, **and what the plane looks like**. | Every named element has a costed item with exit criteria. |
| **G-B** | **Graphics align with season and time of day.** | Scrubbing the clock changes what the world looks like, not only where the sun is. |
| **G-C** | **Medium settings run with no flicker, no lag, no inconsistency on a MacBook Pro.** | A measured number at the reference viewport, asserted in CI — not an impression. |

"Medium" is **tier 1**: `QUALITY_WEIGHT.medium (1) + MODE_WEIGHT.balanced (0)`
→ [`QualityProfile.ts:103`](../../src/render/webgpu/core/QualityProfile.ts:103).
1.5 Mpx cap, `renderScale 0.86`, DPR ceiling 1.5, MSAA 4×, 2 cascades at 7 km,
480 MiB ceiling. Every G-C number in this document is that tier at the reference
viewport of 1512×982 CSS @ DPR 2.

**R-10 (0.5 d).** Add this table to `RENDERING_PLAN.md` as §0.4; delete or define
`G1`–`G10`; reconcile the two cut-line sentences; back-port the `B1`–`B7` and
`C1`–`C7` amendments into §2 so the master plan and the execution plans stop
disagreeing about item numbers and day totals.

---

## 1. The aircraft and the wildlife have no appearance work anywhere

**The finding.** The user named the plane explicitly. The programme allocates
**zero of its days to it.**

- [`createAircraft.ts`](../../src/render/webgpu/aircraft/createAircraft.ts) is 715
  lines of 44 `box`/`cylinder`/`sphere` primitive calls.
- [`builders.ts:44-47`](../../src/render/webgpu/aircraft/builders.ts:44) gives every
  part a `PBRMaterial` with `albedoColor` only — `metallic 0.08`,
  `roughness 0.48`, no map of any kind.
- `grep -rn "Texture" src/render/webgpu/aircraft/` returns nothing. There are
  **zero image assets in the repository** — the only `.png` files are the three
  perf baselines.
- The only aircraft row in 278 days is `7-8 aircraft-lighting` (3.0 d, Phase 7),
  which is nav lights and strobes. It is not appearance work.
- The hangars the user never mentioned get **13.0 days** (`7-10`, `7-11`).

The same hole exists one layer down and was not noticed at all:
[`WildlifeSystem.ts:573,:582`](../../src/render/webgpu/wildlife/WildlifeSystem.ts:573)
builds gulls, hawks, deer and boar from `CreateSphere({diameter: 1})` and
`CreateBox({size: 1})` with one flat `PBRMaterial` each. Across all eight plan
documents wildlife appears exactly twice — as an aerial-perspective consumer and
as a Governor B cut lever. Deer and boar sit at the 2 m ground scale that `2-16`
exists to serve on approach.

**Why this matters more each phase.** The aircraft is on screen 100% of flight
time at the highest screen-space pixel density in the frame. Every phase that
makes the world more realistic makes it the most conspicuously unreal object in
the picture. Phase 3's demo state is *"nothing looks like plastic"* while the
single most-viewed object literally is.

**R-1 — new Gate A, "the things you look at" (12.75 d), after Phase 3.**
It sits after Phase 3 because `3-1 material-array-gpu` builds exactly the
procedural-synthesis pipeline and `TextureArrayMips` reducer this needs — the
same reuse `7-11 hangar-materials` already assumes. It has **no dependency on the
terrain chain**, so it is also the fallback mitigation for Phase 4's dark stretch.

| ID | Item | Days | Notes |
|---|---|---|---|
| `A-1` | `aircraft-form` — lofted fuselage and real airfoil-section wings replacing the cylinder and extruded planforms; gear legs, struts, control-surface gaps | 3.0 | Silhouette first. A textured box is still a box. |
| `A-2` | `aircraft-materials` — synthesised paint with panel lines, rivets, seams, filler, exhaust soot, leading-edge wear, a livery decal layer; per-part metallic/roughness | 3.0 | On the `3-1` pipeline. No new synthesis infrastructure. |
| `A-3` | `windscreen-and-cockpit` — clearcoat glass with real transmission and IBL reflection; an interior panel with instruments visible in cockpit view | 3.0 | Cockpit view currently has neither windscreen nor panel. |
| `A-4` | `prop-disc` + cockpit shadow fix | 0.75 | See `R-2` and `R-3`. |
| `A-5` | `wildlife-forms` — species silhouettes and fur/feather materials replacing unit spheres and boxes | 3.0 | Same recipes, different subjects. |

**Also:** add an `aircraft` row to `SubsystemName` in
[`owners.ts`](../../src/render/webgpu/owners.ts) and to `ARCHITECTURE.md` §1 **before**
`A-1`, so the ownership contract covers it the way it covers everything else.

---

## 2. Two shipped defects that are literally the G-C bar

### R-2 — the propeller strobes ~4.4 times a second

[`createAircraft.ts:358-360`](../../src/render/webgpu/aircraft/createAircraft.ts:358):

```ts
propeller.setEnabled(
  normalizedRpm < 0.12 || Math.sin(propeller.rotation.x * 0.27) > -0.82,
);
```

This disables the whole propeller node — hub and both blades — periodically.
At cruise `rotorRadiansPerSecond ≈ 102` ([`animation.ts:70`](../../src/render/webgpu/aircraft/animation.ts:70)),
so the gate argument advances at 27.5 rad/s: period 0.229 s, off for 19.4% of it.
The propeller vanishes and reappears **about 4.4 times per second**, on the
object the user named, in the view they fly in. Deviation `D-10` fixed the
capture's *determinism*, not the flicker.

**Fix (0.5 d, inside `A-4`).** Solid blades below ~15 rad/s, cross-fading to a
translucent radially-blurred disc above it. Delete the `setEnabled` sinusoid.
Assert `propeller.isEnabled()` never changes between consecutive `update()` calls
at fixed rpm. *(The jet path does not have this defect —
[`createAircraft.ts:657`](../../src/render/webgpu/aircraft/createAircraft.ts:657) sets
rotation only.)*

### R-3 — cockpit view deletes the fuselage from the shadow map

Cockpit-occluding meshes are hidden with `isVisible = false`, which removes them
from the CSM caster list as well as from the camera. In cockpit view the
aircraft's own shadow on the runway becomes a disembodied pair of wings — during
takeoff roll, low pass and flare, where that shadow is the height cue.

**Fix (0.25 d, inside `A-4`).** Hide via `mesh.layerMask` against
`camera.layerMask`, never via `isVisible`. Assert in
`tests/render.webgpu-aircraft.test.ts` that every mesh with
`metadata.castsShadow !== false` has `isVisible === true` in both camera modes.

### Gate A implementation record — 2026-08-19

Gate A is implemented on the Phase 3.5 implementation branch. The historical
finding and estimates above are retained as the audit record; the shipped
result reconciles them with the code that existed at implementation time:

- **A-1:** the trainer and jet primary bodies are capped elliptical lofts and
  the wings/tails are finite NACA-like airfoil volumes with UVs and outward
  right-handed normals. Separate ailerons, elevators and flaps leave physical
  hinge gaps. The code already had useful gear legs, wheels, braces and control
  transforms, so those were preserved and tested rather than rebuilt to match
  the audit's stale primitive count.
- **A-2:** three small deterministic maps per paint recipe carry every named
  feature — panels, rivets, seams, filler, soot, leading-edge wear and livery —
  with per-part BRDF values. Phase 3 ultimately shipped CPU synthesis rather
  than the older GPU-compute sketch; Gate A therefore reuses the shipped
  `TextureArrayMips.buildMipChain` box/Toksvig reducers and explicit mip upload
  at 64², without adding a second generic synthesis framework or an imported
  asset pipeline. The worst live aircraft uses about **0.188 MiB** of these
  fixed surface maps.
- **A-3:** both aircraft use PBR clearcoat plus subsurface refraction/
  transmission against the existing sky IBL, and both have modeled seats,
  panels, gauges, needles and emissive markings visible from cockpit view.
- **A-4:** a pure 15–35 rad/s smoothstep crossfade replaces the sinusoidal
  enable/disable strobe; the hub, blades and radial-alpha disc remain enabled.
  Cockpit-obscuring skin occupies one reserved camera layer, while every
  shadow caster remains `isVisible === true` in chase and cockpit modes.
- **A-5:** gull, hawk, deer and boar now have species-specific procedural
  silhouettes and feather/fur/keratin PBR character. The runtime still owns
  exactly ten shared prototype batches and thin-instance matrices — no
  per-animal mesh path was introduced. Right-handed signed-volume and outward-
  normal tests guard every prototype. Measured steady allocation is **37,716
  bytes** of prototype position/normal/index data plus the unchanged
  **1,310,720-byte** fixed matrix buffers (**1,348,436 bytes / 1.286 MiB**).

The existing planned aircraft row in `ARCHITECTURE.md` was activated rather
than duplicated, and `aircraft` is now a live `SubsystemName` with a manifest
entry. Focused aircraft/wildlife/receiver/architecture suites passed 32/32;
both aircraft material combinations and all ten wildlife prototypes also
compiled and rendered on the real WebGPU adapter without validation errors.

That production-style adapter test exposed and closed one integration defect
the older flat aircraft materials had not exercised. Babylon 9.21.2 could
drop the cloud receiver's implicit effect-cache marker when the aerial plugin
was attached second, then reuse a cloud-injected effect for an aerial-only
emissive aircraft material that had no cloud sampler binder. The cloud plugin
now publishes an explicit sentinel define, the former capture allowlist for
that warning is deleted, and cloud+aerial versus aerial-only material contexts
must compile and render with zero Babylon or GPU errors.

**Close-policy decision.** The original Gate A omitted a formal exit list,
memory rule and screenshot-churn policy. The implementation uses the structural
and on-adapter tests above, the allocations recorded here, and the full gate
verification suite as its exit. Because the aircraft is intentionally present
in persistent capture pixels, **exactly one Gate-A-close visual rebaseline is
authorised**, after Gate B's own sanctioned vegetation rebaseline. It may
rewrite the intended aircraft pixels but may not re-pin fps/hitch floors or
hide unrelated image drift. This is an implementation-time completion of the
missing policy, not an amendment to an already implemented phase.

**Close evidence.** The authorised Gate-A-close run completed all fourteen
fixed scenes and the intended aircraft/forest pixels were inspected. Against
the immediately preceding Gate-B-only run, the rebuilt aircraft adds 35–46
draws per scene while GPU p95 moves between **−0.21 and +0.45 ms**; that is the
measured Gate A cost on this capture state, not a re-pinned budget. The already
hot host again missed the unchanged `approach-500ft` floor (**18.2 vs 24 fps**)
with a 63.4 ms interval p95 against 5.6 ms CPU and 17.64 ms GPU, so the failure
is retained rather than normalised away. The banked-turn min/mean consecutive
SSIM is **0.8313/0.8421** and maximum mean-luminance delta is **0.0019**,
holding the Gate-B temporal improvement and remaining far inside the 0.01
ceiling. After the cache-sentinel fix, a filtered full-renderer capture was
warning-free and passed the committed image gate; no second baseline rewrite
was required.

---

## 3. G-C has no instrument, and the one it has is measuring idle time

This is the largest structural finding. The programme's performance engineering
is genuinely good — the absolute pixel cap, the anti-ratchet, the depth-only CSM,
a first-principles memory estimator, a deterministic screenshot baseline. But
**nothing in the repository asserts a measured performance number**
([`perf-capture.test.ts:231-238`](../../tests/perf/perf-capture.test.ts:231) asserts
only `meanLuminance > 0.01` and SSIM ≥ 0.985; assertion 20 only checks that a
static table of hand-written rows sums below a hand-written target), and the
signal the governors run on is not what it is believed to be.

*Not* claimed: that G-C has no owner. `6-11 quality-tiers-v2` — *"four tiers on
measured numbers, asserted in CI"* — exists and Phase 6's exit criterion is
explicitly *"Balanced holds 60 fps on the reference M2 Pro … measured by
`perf:capture`, not by impression."* The defensible claim is narrower and still
serious: **that gate sits roughly 100 effort-days after the code whose cost it
bounds.** Phases 2–5 add the entire visual load of the programme against an
instrument that will not be built until afterwards. The *measurement* half of
`6-11` must move to Phase 2; the four-tier redesign can stay.

### R-4 — the GPU signal falls back to a proxy that measures pacing, not load

`gpuFrameMsP95` is `null` in all three committed baseline shots
(`tests/perf/baseline/report.json`), so the fallback at
[`AdaptiveGovernor.ts:206`](../../src/render/webgpu/core/AdaptiveGovernor.ts:206) is
what ran, not a hypothetical:

```ts
const proxy = Math.max(0, signals.intervalP95Ms - cpu);
```

Under vsync, `intervalP95` is *pacing*, not load. A frame comfortably making
60 fps with `cpuP95 = 4 ms` synthesises `gpu = 12.7 ms`, which exceeds
`cpu × 1.15` → classified **gpu-bound**; and 12.7 sits between the up-trigger
(10.96) and the down-trigger (15.07) → mode `holding`, indefinitely.

**Correction worth recording:** the null is *not* a missing browser feature.
Instrumenting a capture-like run in the same headless Chromium reads
`diagnostics.gpuP95Ms = 11.97 ms`. The null is a sampling-window artefact —
[`FlightRenderer.ts:1200-1206`](../../src/render/FlightRenderer.ts:1200) resets the
sample set every window and gates on freshness and `MIN_GPU_TIMING_SAMPLES`, so
the value is discarded before the capture reads it. That makes the fix cheap, and
it means the proxy path is live **exactly when the window fails to fill** — which
is every committed shot. No work item validates that it fills on the reference
machine.

This is the precondition for R-5 and R-6 and must be diagnosed first.

### R-5 — Governor B walks load *up* while the frame is GPU-bound

When `classification === "gpu-bound"` **and** `resolutionInsensitive` is latched,
[`AdaptiveGovernor.ts:286`](../../src/render/webgpu/core/AdaptiveGovernor.ts:286) is
skipped (the guard is `&& !next.resolutionInsensitive`), the `cpu-bound` block at
`:321` is skipped, and control falls through to the trailing branch at `:357`:

```ts
// Balanced: recover CPU work slowly when genuinely calm, otherwise hold.
```

which *decrements* `cpuWorkLevel` whenever `cpuP95 < 6 ms`. Several rungs of
`CPU_WORK_LADDER` are GPU costs, not CPU costs —
`cloud-shadow-cadence` (`:107`), `shadow-caster-distance` (`:111`),
`vegetation-distance` (`:113`), `planar-reflection-cadence` (`:105`). So on a
GPU-bound frame with a calm CPU the governor **adds GPU work**. Combined with
R-4, that state is the *default* on the reference machine.

### R-6 — at Balanced on the reference display, Governor A has no lever at all

Tier 1: `renderScale 0.86`, DPR ceiling 1.5, cap 1.5 Mpx. At 1512×982 @ DPR 2 the
DPR clamps to 1.5 → 2268×1473 = 3.34 Mpx; × 0.86² = 2.47 Mpx, still above the
1.5 Mpx cap. The cap binds, a downward `renderScale` step changes no pixels,
`observeRenderScaleApplication` latches `resolutionInsensitive` immediately
([`AdaptiveGovernor.ts:384`](../../src/render/webgpu/core/AdaptiveGovernor.ts:384)),
and the renderer's only remaining adaptation is Governor B — which by design
fires only on `cpu-bound`. **On the exact machine and tier the user named, a
GPU-bound frame has no closed loop behind it.**

### R-7 — neither governor can respond on the timescale the user feels

`windowFrames = 120` (≈2 s), `downCooldownFrames = 90`,
`CPU_HOT_WINDOWS_REQUIRED = 2`, and the ladder has 14 rungs at one rung per two
windows — walking level 0 → 14 takes ≈56 seconds. Governor A is one 0.05 step per
90 frames. The adaptive machinery is a **slow-drift mechanism**; it cannot touch
the transients G-C names (banking into closed forest at 500 ft, the first cloud
noise-volume bake, a page-atlas upload burst). Worse, the timing pipeline
*discards* those frames: a 120-frame p95 ignores the worst 6 in every window and
samples over 250 ms are dropped outright. **The metric is blind to the single
most user-visible failure mode in G-C.**

### R-8 — the screenshot gate compares images that are 20.5% black

`context.drawImage(canvas, 0, 0)`
([`tests/perf/perf-capture.test.ts:183`](../../tests/perf/perf-capture.test.ts:183))
uses the 3-argument form, which copies the drawing buffer at 1:1. With tier 1's
`renderScale 0.86` the buffer is 1100×619 inside a 1280×720 canvas, so **180 of
880 tiles in every committed baseline are pure black** (measured, not inferred:
`renderPixels: 680900`, and the non-black bounding box of every baseline PNG is
exactly 1100×619).

Consequences for phases that are almost entirely pixel work: a regression
confined to the rendered 79.5% is diluted by a fifth of constant-identical area,
and the harness silently contradicts its own spec —
[`vitest.perf.config.ts:9-11`](../../vitest.perf.config.ts:9) and
`RENDERING_PLAN.md:791` both say *"DPR 1, 1280×720"*.

**Correction worth recording:** the 0.86 is the **static tier-1 profile
`renderScale`**, not a governor step — re-running `npm run perf:capture` holds
`renderPixels` at 680900 on all three shots. So the letterbox is stable, and the
"a governor step rewrites every pixel" hazard is not this mechanism. The
run-to-run instability is real but lives elsewhere: the same machine recorded
`fps 54` in the committed baseline and `fps 38` on a re-run, which is its own
argument that these numbers are not yet trustworthy.

### R-9 — the far-plane opacity criterion was only ever tested at sea level

The assertion that justified `camera.maxZ = 45 km` and the terrain-ring cut is
titled, verbatim, *"reaches ≥95% luminance opacity at the far plane in clear
weather **at ground level**"*
([`tests/render.webgpu-aerial-perspective.test.ts:178`](../../tests/render.webgpu-aerial-perspective.test.ts:178)).
Evaluating the shipped closed form gives **4.6%** transmittance at 45 km at sea
level — matching the code's own stated figure — but a fragment at the far plane
seen from 10,000 ft is terrain at ~0 m, and that slanted path gives **T ≈ 0.25,
i.e. 75% opacity**, materially weaker than the ≥95% the ring-cull decision was
argued on.

*Not* claimed: a visible world edge. The `slant-10km` baseline is a level chase
shot at 1,200 m whose forward horizon occupies the upper third of the frame, and
the mountains fade into haze with no edge visible. What survives is that **there
is no altitude sweep anywhere**, so the criterion holds only at the one altitude
it was measured at, and Phase 4's CDLOD work will be planned against it.

### The amendment: Gate 2Z — the evaluation surface (4.0 d, before Gate 2A)

Phase 2 and Phase 3 are 74 days of pixel work gated by an instrument that cannot
see pixels reliably and cannot see time at all. Fix the instrument first.

| ID | Item | Days |
|---|---|---|
| `Z-1` | `capture-pin` — pin `renderScale = 1.0` for the perf project (governors disabled or `scaleFloor = scaleCeiling = 1`); assert `renderPixels === WIDTH × HEIGHT`; drive the loop from rAF so `fps` is a frame rate and not a macrotask-yield artefact; fail the capture on any renderer console error. One sanctioned rebaseline, recorded. | 1.0 |
| `Z-2` | `perf-gate` — diagnose why `gpuFrameMsP95` is null in the capture browser (R-4) and fix it or record the documented fallback; add `maxFrameMs`, `p999FrameMs` and `hitchCount` (frames > 2× `FRAME_TARGET_MS[tier]`) to `RenderDiagnostics`, the HUD and `PerfCaptureShotReport`; count over-250 ms samples instead of dropping them; assert every one against a committed per-shot ceiling. | 1.25 |
| `Z-3` | `capture-coverage` — two new shots: **the reference viewport** 1512×982 @ DPR 2 (the only configuration where the tier-1 pixel cap binds, i.e. where Governor A is dead), and **cruise horizon** at 3,048 m level forward (R-9). Plus a **motion** scene: N consecutive frames through a banked turn at 500 ft over the treeline, asserting a temporal-stability metric — the only reading of "no flicker" that is not an opinion. | 1.0 |
| `Z-4` | `budget-rows` — replace the flat `DETAIL_ALLOWANCE_MIB` with `detailInstancesMiB`/`foliageAtlasMiB`/`impostorAtlasMiB`; add `cloudVolumesMiB` and `materialArraysMiB`; add the Phase-3 form-56 assertion ("the row moves when the input moves"); re-pin `ESTIMATE_FUDGE_FACTOR` against a real allocation reading, which has never been taken. | 0.75 |

**`R-11` — governor repair (1.0 d), immediately after Gate 2Z.** Never recover a
work step while `classification === "gpu-bound"`. Split `CpuWorkSettings` into
CPU-cost and GPU-cost levers, and let Governor A shed the GPU-cost levers when it
is latched — that is the missing actuator from R-6. Two synthetic-trace tests.

**`R-12` — pull `6-10 compute-scheduler` forward to Phase 4 at the latest.** It
depends only on `1A-1`. It is Governor B's designated rung 0 — the first,
cheapest, invisible lever — and it does not exist, so the ladder's first
actuation is already a visible one. Phase 5 otherwise runs ~440 erosion
dispatches with no shared budget and no meter, which is R-7's blind spot at its
worst.

### The harness passes while the renderer logs errors

`npm run perf:capture` emits **36 Babylon error lines** — 18
`Texture "cloudShadowSampler" not found` and 18
`Sampler "cloudShadowSamplerSampler" not found`, across three material contexts —
and the test passes. The errors are transient: all 36 carry one timestamp two
seconds into a 63-second run, a startup window between
`CloudShadowMaterialPlugin._enable(true)` and the first bind/effect compile, so
**no committed baseline pixel is affected**. The defect is small; the property it
exposes is not. `Z-1` adds a console-error assertion so the capture fails on a
renderer error rather than logging it — the same gate Phase 2 wants for `2-5`.

### Two free wins found in the same pass

- **Tier 1 keeps `msaaSamples: 4`** while tier 2 was cut to 2× *because 4×
  overspent the memory ceiling* (`ARCHITECTURE.md` `1B-11` row). At the reference
  viewport 4× MSAA is ~69 MiB of the estimator's ~103 MiB framebuffer row, and
  the plan itself states alpha-to-coverage is off, so **alpha-tested foliage —
  what Phase 2 makes dominant — gets no MSAA benefit from it**. Dropping tier 1
  to 2× is the cheapest ~34 MiB in the programme.
- **`docs/PERFORMANCE.md` is wrong precisely about tier 1.** Five of its
  thirteen tier-1 rows disagree with `QualityProfile.ts` (cascades 3 vs **2**,
  distance 9 km vs **7 km**, ocean 256² vs **128²**, cloud scale 0.50 vs
  **0.45**, primary steps 72 vs **60**), the terrain-levels row says 8/8/8
  against `terrainRings 6/7/7/7`, and there is no tier-3 column although tier 3
  exists. Tiers 0 and 2 are correct. `README.md` still advertises villages, which
  `1B-5` deleted. `6-12`'s documentation truth pass is scheduled four phases
  away; **pull the tier table and the villages line forward now (0.5 d)** — this
  is exactly the mechanism `ARCHITECTURE.md` blames for the original regressions
  going unnoticed.

---

## 4. Season is one thing today, and the file that must carry it is the one file
the threading rule does not cover

The threading rule is real and enforced:
[`architecture.boundaries.test.ts:192-200`](../../tests/architecture.boundaries.test.ts:192)
fails the build for any `SEASONAL_FIELD_FAMILY` member whose source lacks a
type-position `EnvironmentClock`/`dayOfYear`, and requires a `plannedBy` marker
for members not yet written. `2-18`, `3-10` and `4-6` cannot quietly ship without
it. That is good architecture and it holds.

But the check is **syntactic**, and `densityField.ts` is the proof: `dayOfYear`
is declared at [`:36`](../../src/render/webgpu/detail/densityField.ts:36) and read
nowhere in the body — honestly documented as deliberate, but it means the family
test would pass on a field that is entirely season-blind.

### R-13 — the seasonal kernel term (1.0 d), in Phase 2

`grep -n 'dayOfYear\|EnvironmentClock' src/world/terrain.ts src/world/geology.ts`
returns **nothing**. Yet:

- `classifyBiome` ([`terrain.ts:342`](../../src/world/terrain.ts:342)) is what decides
  snow today: `if (temperature < 0.2 || height > world.seaLevel + 1_520) return TerrainBiome.SNOW`.
- `ARCHITECTURE.md` §5 makes `src/world/{seed,noise,terrain,geology}.ts`
  *"simultaneously the physics authority and the source `4-1` transliterates into
  WGSL"* — so `4-6`'s seasonal classifier will be transliterated from a kernel
  that has no clock. That is the exact retrofit §1.6 was written to prevent.
- `3-2` ships a **provisional vertex-colour splat path** fed by that same
  classifier, so `3-10`'s "seasonal palette" will tint a season-invariant
  material assignment for ~35 days.

Meanwhile [`EnvironmentDirector.ts:152-154`](../../src/render/webgpu/nature/EnvironmentDirector.ts:152)
hardcodes `snowCoverage`, `surfaceWetness` and `precipitation` to `0`, no plan
item owns them, and `2-18` (canopy snow) and `4-6` (snow-pack) will each invent
their own winter. `grep -rn snowCoverage` over all four plan documents returns
zero hits.

**The amendment.** Add one pure kernel function in `src/world` —
`seasonalTemperatureOffsetK(dayOfYear, latitudeDegrees)` — transliterable under
the `0-4` portability rules, and thread it into `sampleTerrainTemperature` and
`classifyBiome`. Then:

- the snowline that already ships **migrates with the calendar** instead of
  switching, in one place, for under a day;
- Phase 3's provisional splat path inherits it free;
- `4-6` reuses the term rather than reinventing it;
- `EnvironmentDirector` can fill the `snowCoverage`/`surfaceWetness` fields it
  already packs into the uniform;
- **add `src/world/terrain.ts` to `SEASONAL_FIELD_FAMILY`** in the same commit.

Add seasonal humidity in the same function: deviation `D-5` shipped
`mieTurbidityMultiplier = 1 + humidity·26`, so a seasonal humidity term moves the
haze with **no new plumbing at all**. Winter air is clearer; that is a free,
highly visible seasonal cue.

### R-14 — stop scheduling season last, twice (0 d)

`2-18` is the last item of Phase 2 and `3-10` is the last item of Phase 3, and
both are the designated *second cut* in their risk registers. The user's #2 goal
is therefore the most likely casualty of two consecutive slips — for a dependency
that mostly does not exist (both depend only on `1C-9`, which shipped).

- Split `2-18` → **`2-13a seasonal-crown`** (1.0 d, deciduous leaf-out/leaf-fall
  tint and alpha, conifers hold; lands right after `2-13`) and
  **`2-17a season-buckets`** (1.0 d, impostor atlas buckets, after `2-17`,
  cuttable).
- Move `3-10`'s palette curve to immediately after `3-2` — it needs only the
  arrays and the plugin. Leave the wetness/roughness pass late.

Same day totals. Season becomes visible ~6 weeks earlier in Phase 2 and ~4 in
Phase 3, and it stops being the thing that gets cut. It also closes the ~29-day
window in which bare autumn crowns stand over season-blind summer-green ground.

### R-15 — the season/G-C interaction nobody has measured

At 45°N, declination puts midsummer noon at ~68.4° and midwinter noon at ~21.6° —
a **~6× longer shadow**, i.e. a directly proportional increase in cascade extent
and shadow-caster count. Every tier table and every `FRAME_BUDGET_MS` row was set
against a harness pinned at `dayOfYear 171, solarTimeHours 12.5`
([`perf-capture.test.ts:96`](../../tests/perf/perf-capture.test.ts:96), set **once**,
outside the shot loop). The clock configuration that maximises the shadow
workload is the one configuration G-C's budget has never been measured at.

Fold into `Z-3`: give `PERF_CAPTURE_SHOTS` a per-shot `clock` field, move
`setAtmosphere` inside the loop (settling deterministically, per `D-10`), and add
a **winter-noon** shot and a **night** shot.

### R-16 — two open questions to settle before Phase 4 designs the season epoch

- **Does the clock advance in flight?** Nothing in the code advances it, and
  deviation `D-6` — the six-faces-per-change probe strategy — is a *shipped
  performance decision resting on "the sun is static between scrubs."* Promote
  that to a stated invariant in `ARCHITECTURE.md` §4, or reopen `D-6` at the same
  time as adding any time-rate control.
- **`precipitation` is declared, GPU-packed, and Phase 2 will bake it as a real
  weather channel — with no renderer in any of the seven phases.** §1.6's
  "explicitly not responding" list is silent on it, so it is excluded by omission
  rather than by decision. Decide it out loud, or after `2-1` the programme is
  baking a channel with no consumer.

---

## 5. (was, until executed 2026-08-19:) Night is 7.5 independent days sitting at day ~270 of 278

`7-1` depends on `1C-10` only; `7-2` on `7-1`; `7-3` on `7-1`
(`RENDERING_PLAN.md:406-408`). `1C-10` shipped. Gate 7A has **no dependency on
Phases 2–6.** The stated reason Phase 7 is last — that it needs the atmosphere
spine, the material synthesis and the runway — is true of Gates 7B/7C/7D and
false of 7A.

What ships in the meantime: stars are a hash, the moon is nailed to the exact
anti-solar point and is therefore always full
([`AtmosphereSystem.ts:91`](../../src/render/webgpu/atmosphere/AtmosphereSystem.ts:91)),
the sun palette's below-horizon anchor is `intensity: 0.0`, and `ambient.intensity`
is an unconditional `0.05`. **At 22:00 the ground is black.** Half of the user's
second-ranked goal is a placeholder for roughly 200 more days.

> **EXECUTED 2026-08-19.** Gate 7A ran between Phase 2 and Phase 3, in this
> order, alongside the vegetation perf-debt pass. Both constants named below
> are reopened and both are derived rather than chosen: `MAX_EXPOSURE` is the
> curve's own value at the illuminance where vision hands over to the rods
> (4.698), and `ambientIntensity` follows the sky's illuminance with a stated
> night floor. See `RENDERING_PLAN.md`'s Gate 7A block for the four recorded
> deviations — chiefly that the star catalogue is authored rather than
> vendored, and that night's absolute scale is art-directed because the fp16
> beauty target cannot hold a 4.8 × 10⁵ range without a scene pre-exposure
> this programme does not have. That pre-exposure decision is handed to `7-4`,
> which meets the same range with light points.

**R-17 — move Gate 7A (7-3 → 7-1 → 7-2, 7.5 d) to sit between Phase 2 and
Phase 3.** Stars first, so the gate has pixels on screen without the moon.
Placing it *before* Phase 3 means the ten-material set gets tuned once under both
day and night rather than tuned in daylight and re-judged at day 270 — which is
the cheaper order for the same days. Phase 7 becomes 34.0 d (7B/7C/7D).

Record while doing it: `exposureForState`'s hard clamp of `2.6` and the
unconditional `ambientIntensity = 0.05` are the two constants `7-2` must reopen.
Assertion 29 forbids any private shader exposure, so the single curve is the only
lever and its ceiling is currently a magic number with no stated night rationale.

---

## 6. Amendments to the Phase 2 plan

The Phase 2 plan's codebase forensics are unusually strong — six of §3's specific
claims were re-verified against `src/` and `node_modules` and every one held. The
weaknesses are in what it *assumed*, not what it observed.

| ID | Amendment | Days |
|---|---|---|
| **R-18** | **`2-0`'s preconditions are false.** The adopted cloud shader needs a sky-view LUT (never designed), GPU uploads of both LUTs (they are CPU-only — deviation `D-4`), a scene-depth resource, a blue-noise resource and MRT — none of which exist anywhere in `src/`, none owned by clouds, none priced. Split out **`2-0a atmosphere-gpu-resources`** (owner: lighting) and re-price `2-0`. | +1.75 |
| **R-19** | **`2-0` and `2-7` re-mandate a term deviation `D-7` deliberately did not implement.** Executed literally they multiply cloud-shadow strength by aerial-perspective transmittance a second time, double-fading distant shadows — the precise failure `D-7` was written to prevent. Strike it from both; add a **negative** criterion to the Gate 2A checklist so a re-introduction fails review. | 0 |
| **R-20** | **`2-11a`'s 32-byte instance format cannot be built through the API it cites.** The workable route is `mesh.forcedInstanceCount` plus manually constructed instanced `VertexBuffer`s with explicit component types, bypassing `thinInstance*` entirely — which also changes how `2-12`/`2-14`/`2-16`/`2-17` upload and how bounds and shadow casters register. Insert a 0.5 d GPU spike as the first action of Gate 2C (mirroring `1A-7`'s role), re-price `2-11a` to 2.5 d, and name the 64 B fallback. | +1.5 |
| **R-21** | **`D-2` is invisible to the Phase 2 plan.** Phase 2 re-derives the same ~80 stems/ha rendered ceiling from a memory budget without noticing that the ecological field is authored and the renderer thins by rendered share. Copy the `D-2` split verbatim into `PHASE_2_EXECUTION_PLAN.md` §3, and derive a rendered-stems/ha-versus-radius budget at the head of Gate 2C — at week 6, not at week 10 when `2-17` is the only thing left to cut. **Extended 2026-08-18:** the artefact is a three-column table — rendered stems/ha × radius × triangles-per-plant, summed per LOD tier against §5.4's vegetation row — and it must either adopt `D-2`'s constants as the programme's rendered-density law or replace them, restating every instance-count estimate in the plan set (including `6-8`'s ~110,000) against whichever is chosen. It must also spend the near budget so closed-forest cells reach crown-overlap closure while open cells surrender their share, rather than applying one global scalar per cell — a uniform share turns a clumped field into a stipple. | +0.5 |
| **R-22** | **`assertWithinBudget()` cannot see what Phase 2 allocates.** It is nominated as the arbiter of `2-18`'s bucket count and of assertion 47, but vegetation memory is a hard-coded constant and cloud memory omits the new volumes — so those assertions pass vacuously. Covered by `Z-4`; correct `PHASE_2_EXECUTION_PLAN.md:37` and `:615`, which currently misstate what CI enforces. | 0 |
| **R-23** | **Three exit criteria a broken build passes.** A `2-8` that still stores normals passes "mip N equals the box average of mip N−1"; a `2-8a` that changes the water BRDF passes "byte-identical" (nothing hashes the buffer); a `2-7` whose shadows do not correspond to the clouds overhead passes its criterion. Restate all three against the quantity they are guarding. | 0 |
| **R-24** | **Rivers get sharper before they get placed correctly.** `2-8a` extracts the water helpers into `WaterShaders.ts` *consumed by both the ocean and `HydrologySystem`*, so Phase 2's water work lands on the fake river ribbons — a photoreal shader on a ribbon lying across an uncarved hillside reads *worse*, violating §2.0's own "no gate leaves the sim worse". The plan also says of the inland-water path: **"do not invest in it."** So the answer is not a new item but a one-line clamp inside `2-9`: the tracer already enforces a minimum descent (`minimumDownhillDropMeters: 0.08`); add a **maximum grade** above which no ribbon is emitted, and lower `maximumRivers` to match. `5-12` deletes it with `traceDownhillPath`. | +0.25 |

**Phase 2 total: 44.0 → 48.0 d** *(and 50.5 → 54.5 after the 2026-08-18 vegetation-quality amendments in `PHASE_2_EXECUTION_PLAN.md` §4)*, plus Gate 2Z (4.0) and `R-11` (1.0) and
`R-13` (1.0) ahead of it.

---

## 7. Amendments to the Phase 3 plan

Phase 3's plan is the strongest of the three — `3-0`'s surface contract, `C5`'s
catch that the runway crown breaks the collision fast path, and `C6`'s discipline
of landing profile fields and budget rows in the commit that creates them are all
exactly right, and `C6` is the template `Z-4` and `4-0` copy.

| ID | Amendment | Days |
|---|---|---|
| **R-25** | **`3-2`'s provisional path is fed by the classifier the audit indicts.** Between Phase 3 close and `4-6`, ten well-synthesised materials are selected by the same 8-bit per-vertex threshold cascade that `TERRAIN_AUDIT.md` measures putting 41–50% of adjacent vertex pairs in *different* biomes past 5 km. Better materials chosen by a random-looking selector is the same relative-regression mechanism as R-24. State it as a known interim in the plan, and add a Gate 3A checklist line acknowledging the boundary quality is `4-6`'s to close. | 0 |
| **R-26** | **Retire the light-rig palette.** Deviations `D-6` (SH below-horizon attenuation, floor 0.25) and `D-9` (the palette persisting for the light rig) are both ground-bounce fakes tuned against a ground colour Phase 3 replaces. Once real albedo exists they double-count against it, and G-B's seasonal ground albedo will fight a hardcoded 0.25 floor. Add an item adjacent to `3-10`: derive the `HemisphericLight` ground colour and the SH attenuation from the surface system's mean albedo; delete the floor; name `D-6`/`D-9` in it so the deviations finally have an owner. | +0.5 |
| **R-27** | **One classifier-consumers contract, not three items.** `chooseTreeSpecies`, `chooseShrubSpecies` and the wildlife habitat predicates are all threshold cascades on `classifyBiome`. After `4-6` the *ground* is classified by a continuous supersampled softmax while the *forest growing on it* is still classified by discrete thresholds — two authorities that visibly disagree at every ecotone, which is the artefact `4-6` exists to remove. Decide the output contract **before Phase 4 starts**: export the classifier's weight vector as the species-suitability basis, and add an `ARCHITECTURE.md` row — *"Land-cover classification — the one authority for terrain splat, vegetation species and wildlife habitat"*. Cost it into `4-6` (7.0 → 9.0 d) or as `4-6b` (2.0 d). | +2.0 (Phase 4) |
| **R-14** | `3-10` moves to immediately after `3-2` (see §4). | 0 |

**Phase 3 total: 29.75 → 30.25 d**, followed by Gate A (12.75 d).

---

## 8. What Phase 4's plan must absorb

Phases 4–7 are still the pre-Phase-0 tables. *(Amended 2026-08-19:
`PHASE_4_EXECUTION_PLAN.md` now exists and absorbed this section, with the §8b
corrections; Phases 5–7 remain pre-Phase-0 tables.)* The subsystem specs in §3.1–§3.2 are
in better shape than the tables and already carry CDLOD, the atlas layout, the
classifier and the occlusion bake in a form the current code can accept. What the
tables do not know:

- **`4-0 terrain-spine contract` (1.25 d) is mandatory.** Every argument `C6`
  made for `3-0` applies at larger scale: ownership rows and `owners.ts` entries
  for the WGSL kernel include, the page/channel atlases, the occlusion format and
  the global height pyramid; `heightAtlasMiB`/`channelAtlasMiB`/`heightPyramidMiB`
  estimator rows; the `cdlodPixelThreshold`/`cdlodNodeBudget`/`finestResidentLevel`
  profile fields; and **the 24-bucket `dayOfYear` season cache key on the atlas
  key type**, which `RENDERING_PLAN.md:155` is explicit about — adding it later is
  a re-architecture. Also restate §5.3's Ultra 1 m L0 row, which is inexpressible
  under the normative page geometry.
- **`4-1`'s parity criterion is unachievable as written.** `|h_GPU − h_CPU| < 0.05 m`
  at |x| = 5×10⁶ m cannot hold given how `noise.ts` wraps and `terrain.ts` warps.
  Split it: bit-exact agreement on the hash/lattice/`unitFloatFromHash` layer at
  all |x| (achievable — `seed.ts` already guarantees it), and a slope-relative
  bound far from the origin, keeping the absolute 0.05 m within ±10⁵ m. Implement
  `smoothstep` manually in WGSL: `octaveBandWeight` gates a `weight >= 1` vs
  `weight > 0` branch in `ridgedFbm2D`, and a one-ULP difference flips the branch
  and moves height by metres *(corrected 2026-08-19 — see §8b: the switch is
  continuous at both points; a flip moves height by ≲ 1e-4 m)*. Re-price `4-1`
  at 5.5–6.0 d.
- **Three Phase 4 items each independently invalidate the §1.3 invariant test**
  (`4-3`'s 2×2 supersampling, `4-4`'s retirement of the CPU tile path, `4-9`).
  Phase 4's exit criteria never mention it. Make them gate conditions on `4-4`:
  re-home invariant test 3 into `tests/gpu/` against a height-atlas readback,
  exclude L0 from supersampling (the finest kernel wavelength is 43 m against a
  2 m L0 texel — supersampling buys nothing there and costs parity), and add
  `|h_render(L0) − h_physics| = 0` to the exit criteria explicitly.
- **The `ShadowDepthWrapper` siting has no automated guard.** *(A stronger claim —
  that `C1`'s deferral to `4-4` attaches the wrapper to an already-compiled
  material — was raised and refuted: nothing persists a compiled Babylon effect
  across phases, and `RENDERING_PLAN.md:778` and `PHASE_3_EXECUTION_PLAN.md:357`
  already bind construction-time attachment deliberately.)* What remains is that
  the failure mode is **silent** — a late attachment falls back to the undisplaced
  depth pass with no error. Make it a named sub-step inside the terrain material
  factory and add a GPU assertion against the real material, mirroring
  `tests/gpu/shadow-depth-wrapper.test.ts`.
- **Reorder for memory: `4-0 → 4-1 → 4-2 → 4-3 → 4-7 → 4-8 → 4-4 → 4-5 → 4-6 → 4-9`.**
  *(corrected 2026-08-19 — see §8b: the stated CI-failure reason is wrong, and
  `4-8` cannot precede `4-7`; it splits instead.)*
  As written, Phase 4 spends the atlas allocations before `4-8` refunds the
  shadow map, so `assertWithinBudget()` fails in CI from `4-2` until `4-8` at the
  upper tiers. The reorder also moves the phase's most visible payoff —
  *"ridges cast real shadows across valleys at 40 km"* — into the dark stretch.
  Add to `4-8`: restore `msaaSamples: 4` at tier 2, and reconcile the item's
  "3×1536, 1.8 km, PCSS" text with §5.3's actual Balanced row.
- **`densityField` is unfiltered and TypeScript-only**, but `4-6` must read it
  for the canopy splat channel. Point-sampling a 260 m-lattice field onto a
  128 m-texel level-5 page re-rolls an arbitrary phase per level — the same defect
  `1B-2` fixed for height. Thread `filterWidthMeters` through its signature under
  the `0-4` convention and port it as a shared WGSL include, not a copy.
- **Add `4-10 tier re-measure` (1.0 d)** — `6-11` minus the four-tier redesign —
  so G-C has evidence at the cut line rather than tier rows measured before
  Phase 2 existed.
- **Five preconditions to verify against code before Phase 4 starts:**
  (P1) estimator headroom at all four tiers after Phase 3's material arrays;
  (P2) `tests/gpu` acquires an adapter and can read back an r32float storage
  texture — every `4-1` parity test blocks on it;
  (P3) the invariant tests pass on the Phase 3 branch including `3-8`'s fifth
  earthworks assertion;
  (P4) `TerrainSurfacePlugin` exists as the single terrain-appearance owner with
  `TerrainMaterialPlugin` deleted, and the material factory is in one place;
  (P5) `WORLD_PAGE_LAYOUT`, `WorldPageLifecycle` and
  `calculateWorldPageStreamingPriority` are still consumed by
  `TerrainClipmapSystem` and not re-forked — `4-2` reuses them verbatim.

**Also decide before `5-1`:** lakes are hard-capped at `maximumLakes: 5`,
`maximumLakeRadiusMeters: 900`. `5-12`'s note says only *"raise `maximumRivers`
and `maximumRiverWidthMeters`"* and never says what replaces the lake caps, while
`5-3` makes the macro flood the sole authority on lake spill elevations. Five
≤900 m ponds per world is a larger misplaced water *area* than ten 22 m ribbons.
That is a `5-1 erosion-hydrology-contract` question, i.e. ~40 days before `5-12`.

---

## 8b. Corrections to this document, from Phase 4 planning

Recorded so the next reviewer does not re-litigate them. Both were found by reading the code
that §8 reasons about.

- **The `ridgedFbm2D` branch-cliff hazard in §8 is wrong.** §8 says a one-ULP difference in
  `octaveBandWeight` flips the `weight >= 1` vs `weight > 0` branch and "moves height by
  metres". Branch B is `MEAN + (ridge² − MEAN)·weight`, which at `weight == 1` evaluates to
  exactly branch A and at `weight == 0` to exactly branch C
  ([`noise.ts:231-245`](../../src/world/noise.ts:231)). The three-way switch is algebraically
  continuous at both points; a flip moves height by ≲ 1e-4 m. The *recommendation* that
  survives is different and better: pass `filterWidthMeters = 0.0` at L0 so no weight is
  computed at all and the L0 page is bit-identical to the physics path by construction.
- **The reorder's stated reason is wrong, and the reorder alone does not fix it.** §8 says
  `assertWithinBudget()` "fails in CI from `4-2` until `4-8` at the upper tiers". Tier 1 —
  the tier G-C names — never breaches at any point in Phase 4. Tier 3 breaches at Phase 3's
  close; tier 2 has 3.5 MiB of margin there and breaches at `4-2`. And because `4-8` depends
  on `4-7`, moving it earlier is not possible: it has to **split** into a dependency-free
  cascade resize at the head of the phase and the near-field item after `4-7`.
  See `PHASE_4_EXECUTION_PLAN.md` §3.2 and §4 D3.

---

## 9. The corrected ledger

| Phase | Was | Now | Change |
|---|---:|---:|---:|
| 0 — Architecture shift | 16.8 | **16.8** | shipped |
| 1 — Foundation and atmosphere | 43.0 | **43.0** | shipped |
| **2Z — Evaluation surface** | — | **4.0** | new (§3) |
| **R-11/R-13 — governor + seasonal kernel** | — | **2.0** | new (§3, §4) |
| 2 — Sky, sea surface, living ground | 44.0 | **54.5** | §6 + vegetation quality |
| **7A — Night sky and night vision** | (in P7) | **7.5** | moved (§5) |
| 3 — Terrain surface and the runway | 29.75 | **30.25** | §7 |
| **A — The things you look at** | — | **12.75** | new (§1) |
| 4 — The terrain GPU spine | 34.5 | **~38.5** | §8 |
| 5 — Landscape evolution | 51.5 | 51.5 | — |
| 6 — Water in motion, ecology, tiers | 29.5 | ~28.0 | `6-10` moved to P4 |
| 7 — Airfield lighting and identity | 41.5 | **34.0** | 7A moved out |
| **Programme** | **278.1** *(stale)* | **≈316** | |
| **v1 cut line** (through Phase 4) | *"147–156"* | **≈203** | now includes the aircraft, wildlife, night and a real G-C gate |

*(Footnote 2026-08-19: the totals as printed don't sum — the "Now" rows give
≈322.8 programme / ≈209.3 through Phase 4; the ≈316/≈203 predate the Phase 2
row's 54.5. The Phase 4 row is also superseded by the binding
`PHASE_4_EXECUTION_PLAN.md` at **46.5 d**, and Phase 6 by ~27.5 (`6-10` moved to
Phase 4 per that plan's D2). Reconciled 2026-08-19: programme ≈330 d, v1 cut
line ≈217 d, shipped through Phase 2.5 = 127.8 d.)*

The old cut-line figure was never achievable: it omitted Phase 0 entirely, used a
stale Phase 1 number, and counted a "nine of ten goals served" claim against a
goal list that does not exist. ~203 days ≈ 45 weeks at 4.5 productive d/wk. The
honest trade is that the cut line now delivers something the old one did not — a
world *and an aeroplane* that both look real, at a frame rate that is a measured
number.

---

## 10. What was checked and found sound

Recorded so the next reviewer does not re-litigate it:

- All 16 promised Phase 1 CI assertions (19–34) exist as named tests. `npm test`
  is green at **56 files / 376 tests**; `npm run test:gpu` at 5 files / 8 tests.
- The aerial-perspective *"one include, every consumer"* claim holds in code —
  terrain, ocean, hydrology, clouds, vegetation, **aircraft** and airport all
  register through `AerialPerspectiveRegistry`
  ([`FlightRenderer.ts:506-517`](../../src/render/FlightRenderer.ts:506)).
- The seasonal-family boundary test is real, including the `plannedBy` gate for
  files that do not exist yet.
- The page-geometry contract, the single-exposure rule (assertion 29 greps `src/`
  so no shader can multiply a private exposure again), the `0-9` shadow-wrapper
  incantation and the `1C-4` turbidity calibration are all sound and all
  load-bearing for later phases.
- Deviations `D-1`, `D-3`, `D-4`, `D-5`, `D-7` and `D-8` carry no debt into
  Phase 2. `D-2`, `D-6` and `D-9` do, and now have owners (`R-21`, `R-26`).
- Both execution plans' forensic sections were spot-checked against `src/` and
  `node_modules`; every claim held except the four corrected in §6.
