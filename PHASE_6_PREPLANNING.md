# Phase 6 Pre-planning — Water in motion, ecology and final tiers

**Created:** 2026-08-26.
**What this is:** a **planning input**, not the plan. It records what the tree
*already provides or preempts* for each of `RENDERING_PLAN.md` §Phase 6's twelve
items (`6-1`..`6-12`), so that whoever writes `PHASE_6_EXECUTION_PLAN.md` starts
from the codebase rather than from a table written on 2026-08-18. It decides
nothing, prices nothing and amends nothing.
**Verified against:** commit `6a5b29e` (branch `jazonshou/Phase-5-Implementation`),
2026-08-26. Every "already live" claim below carries a file:line or a test name.
Where an instrument does not exist, this document says so. An unrelated
aircraft/sim change from a concurrent session was in the working tree at the
time; every citation below was re-checked against it, and the one place it
matters is noted in §2.
**Read first:** `PHASE_5_EXECUTION_PLAN.md` §14.2 (the Phase 5 close record and
its eleven-row carried-work register), `RESOLUTION_PLAN.md` (binding — the
analytic default and the GPU-erosion re-scope), `VISUAL_FIXPACK_PLAN.md` and its
deviation log, `docs/PERFORMANCE.md` ("Current measured tier row"), and
`ARCHITECTURE.md`'s decision log (normative — the `4-0b`, `2-15`, fix-pack and
Phase-5 rows in particular).

---

## 0. Three facts that shape the whole phase

1. **The shipped world is analytic.** `DEFAULT_WORLD_EVOLUTION = "analytic"`
   ([`src/world/world.ts:30`](src/world/world.ts:30), G0-1, commit `26ee76e`),
   and both `FlightGame.tsx:112` and `tests/perf/perf-capture.test.ts:240` take
   that default. Phase 6's water and ecology items sit on substrates that behave
   *differently in the two modes*: page hydrology channels, the channel graph and
   the eroded bathymetry only exist in eroded worlds. **The eroded-vs-analytic
   priority must be settled before item selection** — see §3 Q1.
2. **The 2026-08-25 visual fix-pack landed inside three Phase-6 item scopes
   ahead of them.** `6-1`'s capillary half, `6-5`'s response half and part of
   `6-2`'s hydrology-side foam are already shipped, tuned and pinned. Those items
   need **reconciling, not re-implementing**; a plan that re-specifies them from
   the 2026-08-18 table would regress shipped work.
3. **`6-10` already shipped.** It moved to Phase 4 as `4-0b`. Do not carry it.

---

## 1. Item-by-item preconditions

### `6-1` `river-flow-advection` (4.0 d) — **PARTIALLY PREEMPTED**

**Already live (fix-pack W1–W3, 2026-08-25).**
`WATER_CAPILLARY_DETAIL_WGSL` ([`WaterShaders.ts:247`](src/render/webgpu/water/WaterShaders.ts:247))
is a **shared** include composed by both the ocean
([`SpectralOceanSystem.ts:422`](src/render/webgpu/water/SpectralOceanSystem.ts:422))
and inland water ([`HydrologySystem.ts:198`](src/render/webgpu/water/HydrologySystem.ts:198)).
It supplies two wind-advected, world-locked ripple octaves (~0.42 m and ~0.16 m)
with per-octave pixel-footprint Nyquist fades, **plus the analytically-integrated
unresolved mean-square slope of everything below them**, folded into GGX
roughness. Hydrology also re-evaluates its three-sine wave gradient **per
fragment** now, which is what fixed the lake centre-fan's near-constant
interpolated normals. The plan row's premise — "adding a capillary cascade" — has
therefore **already been answered a different way**, entirely outside the FFT
cascade system and at ALU cost only (measured p95 ≤ 9.2 ms on the water shots).

**What that leaves open for `6-1`:** dual-phase **flow-map advection** (Vlachos),
three scales with independent speeds, amplitude scaled by the exported flow
speed, world-locked standing waves on steep grade, and fetch-limited lake chop.
None of that exists. The capillary layer is drift-advected by wind, not by
channel flow, and it is not scale-decomposed the way the advection design is.

**Reconcile the plan row's warnings against today's code before pricing:**

| Plan-row warning | State on this tree |
|---|---|
| "raising the 5-cascade cap (`OceanConfig.ts:163-165`)" | Still exactly 5: [`OceanConfig.ts:163`](src/render/webgpu/nature/OceanConfig.ts:163) throws above five cascades. |
| "`resolution` is a **single global config field**" | Confirmed — [`OceanConfig.ts:23`](src/render/webgpu/nature/OceanConfig.ts:23), applied globally at [`:109-118`](src/render/webgpu/nature/OceanConfig.ts:109). A per-cascade `N` is still a schema change. |
| "the Nyquist assertion will throw at 0.05 m" | Confirmed — [`OceanConfig.ts:178-182`](src/render/webgpu/nature/OceanConfig.ts:178). |
| "`assertAscending` forces the new cascade to index 0, renumbering every existing cascade" | Confirmed — [`OceanConfig.ts:166`](src/render/webgpu/nature/OceanConfig.ts:166) on patch lengths. **And it is worse than the row says:** `resolveSpectralOceanConfig` selects a tier's cascades by `cascades.slice(0, profile.oceanCascades)` ([`SpectralOceanSystem.ts:279`](src/render/webgpu/water/SpectralOceanSystem.ts:279)), so inserting at index 0 changes which bands *every* tier gets, not just the numbering. |
| "audit the unrolled `sampleNormalFoam` loop" | **That symbol no longer exists.** The unrolled path is now the vertex displacement chain at [`SpectralOceanSystem.ts:341-344`](src/render/webgpu/water/SpectralOceanSystem.ts:341), hard-wired to **five** slots by uniform shape (`cascadeFadeRadii0: vec4f` + `cascadeFadeRadius4: f32`, `patchLengths0` + `patchLength4`, `displacement0..4`). A sixth cascade needs new uniforms and a new texture binding, not just a raised cap. |

**Stale table row to fix in `6-12`:** `RENDERING_PLAN.md` §5.3 lists Ultra as
"6 @ 256 (+ capillary)", which the 5-cascade cap makes **unreachable**;
`QualityProfile.ts:438` ships `oceanCascades: 5` at tier 3.

### `6-2` `shoreline-foam-runup` (3.0 d) — **OPEN, with an inland head start**

Ocean-side: **open.** Fix-pack W4 (near foam / contact foam from the already
sampled bathymetry) was **deferred** — `VISUAL_FIXPACK_PLAN.md` deviation D-5:
"the capillary band + roughness tail deliver the near-field realism the report
asked for; foam is additive polish." The ocean's only foam is the `2-8`
Jacobian-driven breaking term with history decay
([`OceanShaders.ts:366-368`](src/render/webgpu/nature/OceanShaders.ts:366)) — a
crest mechanism, not a shore mechanism. There is no depth-driven breaking band,
no Hunt run-up, no shore-normal streaking, no wet-sand persistence.

Inland-side: **partially live.** `HydrologySystem` already computes a
`shoreFoam` from the water-info depth channel and a `rapidFoam` term
([`HydrologySystem.ts:327-334`](src/render/webgpu/water/HydrologySystem.ts:327)).
Treat that as the pattern to generalise, not as the item.

Substrate is ready either way: the depth field `6-2` needs is the same
`waterDepthFromBathymetry` both materials already sample (`5-10`/`5-11`).

The plan row's rule still binds and is now checkable: derive the run-up phase
from the **same cascade the visible swell comes from** — the per-cascade fades
are on the varyings at `SpectralOceanSystem.ts:333-338`, so the phase source is
addressable without new plumbing.

### `6-3` `shallow-water-dispersion` (2.0 d) — **OPEN**

Nothing shoaling-related exists. The gate the plan asks for (depth < 60 m) is
directly available: `5-10`'s `BathymetryClipmap` is live at both levels and
`WATER_DEPTH_OPTICS_WGSL` is composed verbatim into both water materials
(asserted by "composes exactly the same depth include into both materials" in
`tests/render.webgpu-water-depth.test.ts`). Depth is currently consumed for
absorption, shoreline alpha and the refracted bed only.

**Carried-in caveat:** in eroded worlds the depth substrate samples the
**canonical macro** at cell centres, not resident L0 page erosion (§14.2 register
row C-6). A shoaling term keyed to 512 m-resolution bathymetry will not resolve a
real surf zone. Sequence `6-3` after C-6, or scope it to the ocean shelf profile.

### `6-4` `caustics` (2.0 d) — **OPEN**

No caustics of any kind on this tree. Its two dependencies (`5-11` water optics,
`2-8` ocean spectrum) are both live, and the Jacobian the design wants is already
stored — `OceanShaders.ts:371` writes it into the alpha lane of `slope_foam`
alongside slope and foam. That is a genuinely cheap start.

### `6-5` `terrain-wetness` (1.5 d) — **HALF WIRED, exactly as planned**

**Already live.** `TerrainSurfacePlugin` carries the full `3-7` wetness response
in the fragment path
([`TerrainSurfacePlugin.ts:1792-1811`](src/render/webgpu/terrain/TerrainSurfacePlugin.ts:1792)),
and it is **literally the plan row's two instructions**:

```wgsl
terrainRoughness = mix(terrainRoughness, terrainRoughness * 0.35 + 0.02, terrainWetness);
terrainAlbedo   *= mix(1.0, 0.62, terrainWetness);
```

The **submerged** half is live and load-bearing: `terrainSubmerged` is derived
from sea level carried in `terrainSurfaceWetness.y`, and a further silt/biofilm
tint rides on top of it — the comment records that without it "the first capture
after this plugin landed turned every lake grey". The **driven** half is a
constant: `private wetness = 0` ([`:1931`](src/render/webgpu/terrain/TerrainSurfacePlugin.ts:1931)),
with the setter at [`:2074-2077`](src/render/webgpu/terrain/TerrainSurfacePlugin.ts:2074)
annotated "`3-7`'s wetness input; `6-5` supplies the field".

**So `6-5` is not a shader item at all.** Its entire open half is the **water-side
field definition** — what produces a per-pixel or per-texel wetness for ground
that is *near* water rather than *under* it, and how it decays (spray band,
recent-inundation persistence, capillary rise above the waterline). Re-price
accordingly; the 1.5 d assumed the shader work was in scope.

Note also that `5-12` already wired lake-bed wetting from `lakeDepth` per §4 D15
— check whether that head start survived the eroded-mode re-scope before
counting on it.

### `6-6` `ecology-channels` (2.5 d; 2.0 after §4 D15 moved the glade half to Gate B) — **SUBSTRATE RESIDENT, CONSUMERS MISSING**

This is the item Phase 5 most directly hands over, and §14.2 register row **C-9**
assigns it here explicitly.

| Channel | Producer | Named consumer today |
|---|---|---|
| Flow accumulation / TWI | `TerrainPageHydrology` (`r16float`) | **Live** — the splat classifier (`LandCoverClassifier.ts:94-96`, WGSL at `:350-357`) |
| Signed shore distance | `TerrainPageHydrology` (`r16sint`) | **Live** — `riparianVegetationFactors` in [`densityField.ts:186-197`](src/render/webgpu/detail/densityField.ts:186), mirrored in [`densityFieldWgsl.ts:126-128`](src/render/webgpu/detail/densityFieldWgsl.ts:126) |
| **Lake depth** (`r16float`) | `TerrainPageHydrology` | **NONE.** Grepped: the name appears only in payload/validation/atlas plumbing — no shader, no detail, no water consumer |
| **Soil depth** (`r8unorm`) | `TerrainPageHydrology` | **NONE**, same |

All four upload and become resident **atomically with the height page** and are
exposed through atlas accessors (ARCHITECTURE `5-5` row). The plan row's own rule
— "three channels, each with a **named ground-layer consumer**, or the item
produces data nothing reads" — is therefore *already half violated by shipped
data*, which makes `6-6` a debt-clearing item rather than a greenfield one.

**Two consumers are already waiting with stand-ins in place:**
- `2-15` places clutter (log/stump/branch-litter/moss) by canopy closure plus a
  **moisture bonus that ARCHITECTURE's `2-15` row calls a "soil-depth stand-in
  until 6-6"**. Swapping that producer is the shortest path to a named soil-depth
  consumer.
- The riparian path exists but is a *density* term only; the plan's "reed/fern
  archetype weight and wet-litter darkening in the forest-floor splat" is the
  species/appearance half and is not written.

**Note the eroded-only dependency:** none of these channels exist in an analytic
world, so every `6-6` consumer needs a defined analytic fallback or the item
ships dark by default. See §3 Q1.

### `6-7` `talus-scree-placement` (1.5 d) — **OPEN**

No scree or talus placement anywhere in `src/render/webgpu/`. The word `talus`
appears only in the analytic height kernel
([`geology.ts:124-132`](src/world/geology.ts:124), a mean-removed ridged term)
and in the erosion operator's repose pass — both *shape*, not *placement*.

Its dependency `2-15` is fully live: displaced-icosphere rocks (320 tris) with
per-lithology normals, `normalAlignedQuaternion` orientation, the
`radius·flattening·(0.12+0.25·hash)` sink, and `applySnowCover` with the
slope-shedding weight (rocks reach slope 0.9 where trees stop at 0.2). So the
instancing, materials and snow behaviour `6-7` needs already exist; the item is
the placement law. Its other dependency, `5-5`, is the resident soil-depth
channel — i.e. `6-7` inherits **C-9** and probably wants to land after `6-6`.

### `6-8` `canopy-terrain-handoff` (2.5 d) — **OPEN, and its economics must be re-derived**

Nothing splat-side exists: canopy closure is not a channel, and canopy height is
not added to terrain height at any LOD. `tests/render.webgpu-canopy-closure.test.ts`
is the **Gate 2C rendered-density law** (crown closure in the near band, the
thinning-with-range law, the far floor, per-tier closure) — a vegetation-side
contract, not `6-8`'s terrain-side channel.

**The impostor-radius trade in the plan row is stale and must be re-derived
against today's draw ceilings.** The row promises the impostor radius can "drop
from 4 km to ~2.5 km, saving ~110,000 instances", and `RENDERING_PLAN.md:837`'s
ratchet books the recovered budget against the fidelity list. Between then and
now the vegetation workload changed twice:

- **The near/mid crown representation changed** from `2-12`'s alpha-tested cards
  to **closed opaque hulls** (80-tri icosphere / stacked cones, `DETAIL_OPAQUE_CROWN`)
  in commit `6e13d6e`, recorded retroactively in ARCHITECTURE's "60 fps push" row.
  The far impostor now **bakes from the hull**, so the impostor's appearance and
  the near band's are coupled in a way `6-8`'s "exactly complementary to the
  impostor dither fade" claim was not written against.
- **The rendered-density law's draw ceilings moved by an order of magnitude.**
  `VEGETATION_DRAW_CEILING` is now `[50, 58, 450, 600]`
  ([`renderedDensity.ts:366-377`](src/render/webgpu/detail/renderedDensity.ts:366)) —
  the 60 fps family path submits three one-variant prototypes rather than seven
  species × several variants, modelled at 41.1 draws at tier 0 and 47.8 at tier 1.
  `docs/PERFORMANCE.md`'s §Vegetation section still quotes the `4.5-C1`-era
  ceilings **160/200/500/650** and a `VEGETATION_FRAME_DEBT_RATIO`, **and that
  symbol no longer exists in `src/`** — a `6-12` documentation-truth row.
- **The fix-pack added a near-band-only alpha-card fringe** over the opaque hull
  (8/6 cards, D-3: sized down from 12/10 after ~4 ms of measured p95). Any
  band-radius change interacts with it.

`vegetationDistance` is still defined equal to the impostor radius
(`QualityProfile.ts:265/339/399/444` — 2.0/3.0/4.0/6.0 km). Re-derive the trade
from the current ceilings and the current 17-shot measured row, not from the
2026-08-18 numbers.

### `6-9` `gpu-scatter` (5.0 d) — **OPEN**

Scatter is still a **CPU Worker** path: `src/workers/detail.worker.ts` +
`detailProtocol.ts`, driven by `WorldDetailRuntime` with an `inline | worker |
blocked` build source ([`WorldDetailRuntime.ts:223`](src/render/webgpu/detail/WorldDetailRuntime.ts:223))
— and note `docs/PERFORMANCE.md` records that the GitHub-hosted runner's detail
Worker **does not come up at all**, so every chunk is synthesised inline there.
That is a real portability constraint on any design that assumes the worker.

The plan row's two rules still bind verbatim: CPU-readback count is the
**default** and indirect draw is an optimisation behind a loud startup capability
assertion; and "cheaper scatter does not authorise more plants" — surplus is
booked against §5.3's fidelity list, and `6-11` may not raise a count row without
a fidelity row moving in the same commit.

### `6-10` `compute-scheduler` (2.0 d) — **ALREADY SHIPPED. Do not carry it.**

Delivered as **`4-0b`**, per `PHASE_4_EXECUTION_PLAN.md` (and
`RENDERING_PLAN.md:343`, which records the move). The artifact is
[`src/render/webgpu/core/ComputeBudget.ts`](src/render/webgpu/core/ComputeBudget.ts),
listed in **ARCHITECTURE.md's ownership table as "Shared amortised-compute meter
… live (`4-0b`, = `6-10` moved)"**, with the mechanism recorded in the
**`4.5-B2` decision-log row** (measured per-dispatch costs, the ~1.9 ms/page
finding, and the floor-of-one admission that Phase 5's assertion 105 had to be
authored around).

It is real, not nominal: four compute rows including `erosionCompute` with
per-tier caps (`PerformanceBudget.ts:83/96/112/126` → 0.2/0.4/0.7/1.2 ms),
reservation-then-surplus admission under one cap, Governor B rung 0 as the
promised "lever 0", and thirteen green tests in
`tests/render.webgpu-compute-budget.test.ts` covering priority order, whole-or-nothing
admission, cross-frame smoothing and assertions 112/113/114.

### `6-11` `quality-tiers-v2` (3.0 d) — **PARTIALLY SUPERSEDED**

**Already exists:**
- **A strict tier-1 delivery contract, enforced.** Medium/balanced has a
  non-negotiable raw frame-delivery gate over each 240-frame window: ≥ 60 wall
  fps, interval p95 ≤ 16.67 ms, ≤ 5 intervals over 27.4 ms, none over 50 ms
  (`docs/PERFORMANCE.md` §Capture harness). This is exactly
  `RESOLUTION_PLAN.md` §3.5's proposal, landed.
- **A measured tier-1 row over seventeen shots**, promoted 2026-08-25 —
  minimum 120.6 raw fps, worst p95 9.4 ms, worst single frame 17.7 ms, zero
  hitches, on Apple Metal 3 / headless Chrome 151 (`docs/PERFORMANCE.md`,
  "Current measured tier row").
- **The CI enforced/reported split** (`RESOLUTION_PLAN.md` D-11):
  `VITE_PERF_UNPINNED_HOST=1` reports the host-dependent delivery rows on the
  GitHub runner and names every row it declined to gate, while every
  host-independent gate still asserts there — uncaptured GPU errors, Babylon/
  console errors, blank-or-structureless frames, the render-scale pin, settling
  fences, resident-slot capacity, temporal-stability floors and every SSIM
  comparison. Pinned by `tests/perf-capture-policy.test.ts:164-171`.
- **`assertWithinBudget()` across four tiers at three viewports** is *already*
  green as assertion 19 (`tests/render.webgpu-budget.test.ts:61-73`) — but that
  is the **memory** budget, not the delivery contract.

**What genuinely remains:**
1. **The four-tier delivery sweep at three viewports.** Only tier 1 has measured
   delivery numbers. Tiers 0, 2 and 3 have declared rows and no measurement.
2. **The cold-start deadline.** `docs/PERFORMANCE.md` is explicit that the steady
   capture "begins after renderer creation and therefore cannot catch a startup
   Promise that never settles" — precisely the `5-10` failure class — and that
   cold time-to-ready is a separate measurement. The only numbers on record
   (11,098 ms dev reload, 13,255 ms built-server navigation) are **labelled
   diagnostics, not acceptance**, and they were taken against the *eroded*
   default that no longer ships. **The plan row's wording — "measure
   default-eroded cold startup" — is now wrong** and must be re-pointed at the
   analytic default, with the eroded path measured separately if at all.
3. The ratchet rule (`RENDERING_PLAN.md:837`) applies to every row this item
   touches.

### `6-12` Documentation truth pass (1.0 d) — **PARTIALLY SUPERSEDED, and it has new work**

`docs/PERFORMANCE.md` was substantially rewritten through Gate B, `4.5-C1`, the
Gate-0 work and the fix-pack close, so the row's original targets are largely
handled. Three **new** untruths found while writing this document, each
verified:

1. **`docs/PERFORMANCE.md` §Vegetation quotes ceilings 160/200/500/650 and a
   `VEGETATION_FRAME_DEBT_RATIO`.** Current ceilings are `[50, 58, 450, 600]`
   and **`FRAME_DEBT` does not exist anywhere in `src/` or `tests/`.**
2. **`RENDERING_PLAN.md` §5.3 lists Ultra ocean as "6 @ 256 (+ capillary)".**
   The config caps at five cascades and tier 3 ships five.
3. **`docs/PERFORMANCE.md` §Capture harness still frames the cold-start
   measurement as "cold **default-eroded** time-to-ready".** G0-1 made the
   default analytic, so that sentence names a path the shipped app no longer
   takes — and the two numbers it qualifies (11,098 / 13,255 ms) measure the
   eroded world. (`README.md:98` is *not* wrong here: it says eroded macro
   terrain uses bounded CPU workers, which is still true.)

Its dependency on `6-11` stands: the tier table cannot be made true before the
sweep exists.

---

## 2. Known quality residuals Phase 6 items would naturally absorb

All four are **recorded accepted residuals**, not new findings. Each is cited to
where it was accepted.

| # | Residual | Recorded in | Natural absorber |
|---|---|---|---|
| **QR-1** | **The tier-2 vegetation shadow question.** Vegetation casts no shadows below tier 2 (`4.5-C1`, the largest single draw lever). Back-face shadow casting then halved which alpha-*card* casters contribute depth at tiers ≥ 2, and "a canopy's card union still shadows — revisit with the tier-2 shadow work". | ARCHITECTURE fix-pack **T1–T8** row, accepted residual #1 | `6-11` (it is a tier-row decision) with `6-8`, which changes what a canopy *is* beyond the impostor radius |
| **QR-2** | **F5 under-canopy terrain darkening not landed.** The dappled-light stand-in for the tier-1 no-shadows decision. Deferred because "F5 adds a cross-owner terrain↔vegetation coupling", explicitly "deferred with the tier-2 shadow question it belongs to". | `VISUAL_FIXPACK_PLAN.md` deviation **D-4** | `6-8` — it is exactly a canopy-closure→terrain-splat coupling, which is `6-8`'s single-owner design |
| **QR-3** | **W4 ocean shore/contact foam not landed.** "The capillary band + roughness tail deliver the near-field realism the report asked for; foam is additive polish." | `VISUAL_FIXPACK_PLAN.md` deviation **D-5** | `6-2` — it is that item's first half |
| **QR-4** | **The seasonal fringe halo.** During the autumn shed window the near-band fringe cards dissolve by leaf fraction while the opaque hull contracts geometrically, so a partially-shed broadleaf can carry a sparse card halo just outside its contracted hull. | ARCHITECTURE fix-pack **F1–F4** row, "accepted residual" | `6-8` or `6-9` — whichever re-touches the band/impostor handoff; it is a shed-schedule/geometry agreement bug, not a shading one |

A fifth, **not** a fix-pack residual but worth knowing before Phase 6 planning:
at commit `6a5b29e` `tests/sim.rebuild.test.ts` fails 2 of 16 deterministically
(light-trainer `DirectPitchRetention` tolerances at `:291` and `:325`), which
contradicts the fix-pack `A1–A5` row's claim that "trainer suites pass
unchanged". A concurrent working-tree change re-pinned both during this
document's writing and the file is green again, **uncommitted**. It is aircraft
work, not Phase 6 scope — but the fix-pack deviation log still owes it a row.

---

## 3. Carried in from Phase 5

`PHASE_5_EXECUTION_PLAN.md` §14.2's register hands exactly **one** row to Phase 6:

- **C-9 — named shader consumers for the resident `lakeDepth` and `soilDepth`
  page channels** → `6-6`, which already owns the "named consumer or the item
  produces data nothing reads" rule.

Every other register row goes to the **GPU-erosion workstream** (C-1..C-7,
C-10, C-11) or to **the user** (C-8, the three named flights). Two of them
constrain Phase 6 sequencing even though they are not Phase 6 work:

- **C-6** (eroded bathymetry samples the canonical macro, not resident L0 pages)
  bounds what `6-3` can resolve in eroded worlds.
- **C-5** (conservative convex lake cover and un-resampled river lanes) is the
  geometry `6-1`/`6-3` would animate; `6-1`'s per-fragment work will inherit
  whatever mesh quality that workstream lands.

---

## 4. Planning questions for the user

These are the decisions a Phase 6 execution plan cannot make for itself.

1. **Eroded or analytic — which world is Phase 6 for?** `6-3`, `6-6` and much of
   `6-1`/`6-2` are far more valuable against eroded terrain (real channel graphs,
   real soil-depth and shore-distance fields, real bathymetry), and several of
   them produce *nothing* in an analytic world without a defined fallback. But
   the analytic world is what ships today. Options: (a) build Phase 6 for the
   analytic default and give every eroded-only channel an analytic proxy;
   (b) build for eroded and accept that the features are dark by default until
   the GPU-erosion workstream re-earns it; (c) split the phase.
2. **Does the GPU-erosion workstream precede or follow Phase 6?** It is unplanned
   and unpriced (§14.2 (d)). If it precedes, Q1 answers itself and `6-3`/`6-6`
   land on real substrates. If it follows, Phase 6 must be planned to Q1 option
   (a) or (c) — and C-6/C-5 stay as ceilings on what `6-1`/`6-3` can look like.
3. **Is `6-1`'s capillary half considered done?** The fix-pack shipped
   sub-Nyquist ripple + the unresolved roughness tail on both water surfaces.
   If yes, `6-1` re-prices to flow-map advection + standing waves + lake chop
   only, and the 5-cascade/6-cascade question may be dropped entirely.
4. **`6-5` is a water-side item now.** The terrain shader half is already live
   and the driven field is the whole remaining scope. Confirm that reading before
   it is priced at 1.5 d.
5. **How much of `6-11` do you want?** The strict tier-1 contract, the measured
   tier-1 row and the CI enforced/reported split already exist. Is the remaining
   ask the full four-tier × three-viewport delivery sweep plus a cold-start
   deadline, or only the cold-start deadline (the one thing that has bitten the
   project twice)?
6. **The three named Phase 5 flights (C-8) are yours to fly.** Do you want them
   flown against the eroded world before Phase 6 starts — which would be the
   first visual review the eroded landscape has ever had — or is the eroded world
   parked until the GPU workstream?
7. **QR-1, the tier-2 vegetation shadow question, is the oldest open quality
   decision** and it blocks QR-2. Do you want it settled inside `6-11`'s tier
   work, or as its own item?
