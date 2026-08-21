# Phase 5 Execution Plan — Landscape Evolution

**Status:** execution reference for Phase 5 of `RENDERING_PLAN.md`, binding over that table where they differ. It does not restate the plan; it decides everything the plan leaves to implementation time, against the codebase as it will exist when Phase 5 starts.
**Runs after:** Gate B (§15, new — the felt frame), Gate A (`PRE_PHASE_4_REALIGNMENT.md` §1), and `PHASE_4_EXECUTION_PLAN.md`. Phase 4's exit checklist is this plan's precondition set.
**Basis:** `TERRAIN_AUDIT.md` §2 root causes #2/#8/#9, `RENDERING_PLAN.md` §2 Phase 5 / §1.3 / §3.1 / §3.3 / §5 / §6 / §7 (R2, R8, R9, R10), `ARCHITECTURE.md` (normative), `PRE_PHASE_4_REALIGNMENT.md` §8's pre-`5-1` demand, and `PHASE_4_EXECUTION_PLAN.md` (binding for everything it decides).
**Verified against:** the merged Phase 0–3 tree on `jazonshou/Planning` (2026-08-19), `@babylonjs/core` 9.21.2 as installed, the committed 14-shot perf baseline, and two measurement sweeps run for this plan (a 6-seed 965k-sample kernel sweep; a 40×40 km density-field sweep). Every file:line below was re-derived on this tree. **Several refute the source plans** — recorded in §3 and amended in §4. Phase 4 is *not yet implemented*: every claim about Phase 4 artifacts cites its binding plan, and §1's preconditions re-verify them against code before this phase starts.
**Effort:** **Phase 5 = 57.25 days** (~12.7 weeks at 4.5 d/wk), stated range **55–68** — the erosion items carry the programme's largest tuning risk and are priced at ranges. Plus **Gate B = 7.25 days**, which is *not* Phase 5 work: it is scheduled before Phase 4 (§15).
**Engine:** Babylon `@babylonjs/core` 9.21.2, WebGPU. No engine or API change is in scope, considered, or permitted.

**Implementation reconciliation — 2026-08-20:** a Phase-5 implementation
candidate is present in the working tree. It is **not** a phase-close record:
the current erosion producers are deterministic CPU-worker references behind
the intended runtime boundaries, and the final-GPU/reference-performance,
capture, rebaseline and flown-acceptance evidence remains open. See §14.1 for the exact live scope
and deviations; the original requirements below remain the acceptance target.

---

## 0. What this document adds

Phase 5 breaks the `h = f(x, z)` contract — audit root cause #2, "the single largest realism change in the program." The analytic kernel stops being the terrain and becomes the **uplift input** to a simulated landscape evolution; collision moves from the kernel to a readback of the eroded grid; rivers and lakes stop being ribbons pasted on slopes and become the residue of the drainage the erosion actually computed.

What this document decides beyond the plan's table:

1. **What the codebase actually is** (§3) — sixteen findings, several of which change the phase's shape: the world is unbounded but drainage is global, so the macro flood needs a *domain* no plan document ever defined; the `5-2` readback has no worker-side plumbing at all despite `ARCHITECTURE.md`'s "one file" promise; the ocean has no depth substrate of any kind; the hydrology worker regenerates the world from the seed, which eroded terrain makes impossible; and §5.3's tier-dependent erosion scope would make the collision surface a function of a graphics setting — the exact rule Phase 4 used to strike the Ultra 1 m row.
2. **Fifteen amendments** (§4), including the **activation-commit strategy** that satisfies risk R10's "rebase once" while letting erosion be developed and tuned incrementally behind a flag, a reorder that puts the tectonic uplift *before* erosion tuning and the water optics *before* the dark stretch, and **Gate B — the felt frame** (§15), a 7.25-day fix-pack answering the user's 2026-08-19 flight-test reports ("choppy on anything but lowest settings; the plane constantly feels like it's shaking"; "too much foliage — forests are good, but there should be variance") with the measured mechanisms behind both.
3. **The evolution contract** (§5) — the macro domain, the authority ladder, the export list, the page-generation DAG, and the tier-invariance rule.
4. **A work order with a week ledger** (§6), item detail per gate (§7–§11), **verification** (§12, assertions 87–106), a **risk register** (§13), an **exit checklist** (§14), and a **decision log** (§16).

Read §3 and §4 before writing any code.

---

## 1. Preconditions

**Amended 2026-08-20: Phase 4 is implemented.** The preconditions below are now facts to re-check rather than promises, and the status column records what the implementation actually delivered. Read `PHASE_4_EXECUTION_PLAN.md` §4 D13–D17 and its ticked exit checklist before planning against this table — five deviations were forced by measurement, and four exit boxes did not close.

| # | Precondition | Status after Phase 4 |
|---|---|---|
| **P1** | Height pages generate on the GPU; L0 is supersample-free at width 0 | ✅ `terrainSupersampleOffsets(0)` has one entry, asserted in both projects. Parity: 3.78 mm at ±10⁴ m, 3.44 mm at ±10⁵ m, **2.37 mm at ±2.8×10⁶ m** — flat with radius. Criterion 4 is **5 mm, not 1 mm** (§4 D16): f32 accumulation floors at ~3.6 mm and the runway crown itself carries 5.8 mm of chord error at L0 vertex spacing. Measured through the atlas: 0.056 mm. |
| **P2** | `publishPage` has real call sites; `fallbackSampleCount` counts | ✅ `PublishingTerrainCollisionMirror` has a page ring, a bilinear query and a miss counter, and `src/sim/terrainGrid.ts` carries `setGroundHeightMirror` — a one-line seam. **`5-2` swaps a PRODUCER**, not plumbing. The interpolation kernel is deliberately bilinear; `5-2` replaces it with Catmull-Rom alongside the producer. |
| **P3** | `ComputeBudget` with `erosionCompute` live; Governor B rung 0 fires first | ✅ `core/ComputeBudget.ts`, four clients, reservation-then-surplus admission under one cap. Rung 0 is **two notches** (0.6, 0.35), not one — §4 D15. |
| **P4** | The classifier is live with `dayOfYear` in its signature and a swappable wetness proxy | ✅ `LandCoverClassifier.ts`. The wetness proxy is `LandCoverInput.moisture`; `5-5` swaps its producer. Note the reference-day rule: the ECOLOGY reads the classifier at the reference day and only the splat bake passes the real one, because snow is paint (`2-18`). |
| **P5** | The global height pyramid exists (512 m/texel, 256² over 128 km) | ✅ `GlobalHeightPyramid.ts`, recentred in whole texels, band-limited at its own texel size. |
| **P6** | The GPU harness reads back r32float; `tests/gpu/webgpu-limits.test.ts` is committed | ✅ Committed, and it settled a second question the plan left open: **binding an r32float texture as `texture_2d<f32>` and reading it with `textureLoad` validates and returns exact values**, so the occlusion bake reads the height atlas directly rather than routing pages through a storage buffer. |
| **P7** | The world-churn inventory is re-derived on the post-Phase-4 tree | ⚠️ **Re-derive it.** `src/world/tile.ts`, `TerrainGenerationClient.ts`, `terrain.worker.ts`, `terrainProtocol.ts`, `tests/world.tile.test.ts` and `tests/world.tile-normals.test.ts` are all deleted; `terrainQueue.ts` is now `boundedPriorityQueue.ts`; `tests/render.webgpu-terrain-clipmap.test.ts` is a quadtree suite. |

### Work Phase 4 did not close, carried here

Four items, each named in `PHASE_4_EXECUTION_PLAN.md` §13 with its reason:

1. **The three named flights** (§11.2: full descent, cruise over a mountain range at low sun, season scrub across a bucket boundary). These are human deliverables — a recorded capture treated as a baseline — and no automated substitute exists for *no popping*, *ridges shadow valleys* or *material identity stops being a coin flip*. The measurable halves are asserted; the flights are not flown.
2. **Assertion 83b** — a fragment-stage readback proving `vPositionW` equals the DISPLACED height at a known slope. The hook choice is asserted (the displacement compiles into both the beauty and the shadow vertex sources) and documented, but the direct measurement is not written. Cheap to add beside `tests/gpu/terrain-physics-parity.test.ts`.
3. **Assertion 85** — cross-level splat consistency (a level-N page's weights equal the box average of the four level-(N−1) pages beneath it, within quantisation). The bake supersamples 2×2 and averages weight vectors, which is the mechanism this would measure; the comparison is not written.
4. **The tier re-measure and the `perf:capture` rebaseline.** `4-10` landed the page-thrash and CDLOD-transition scenes with residency ceilings, but the ceilings are DESIGN INTENTS and every SSIM baseline in `tests/perf/baseline` is stale after `4-5`/`4-6`/`4-7` — the three rebaselines the plan sanctions. **Run `npm run perf:capture:rebaseline` on the reference machine before trusting any Phase 5 performance claim**, and re-pin the ceilings from what it reports.

### Amended 2026-08-20 again: Phase 4.5 is implemented

`PHASE_4_5_EXECUTION_PLAN.md` was written and executed between Phase 4 and
this one. It closes three of the four carried items above — 83b and 85 are
written (`tests/gpu/terrain-splat-filtering.test.ts` and
`tests/gpu/terrain-splat-bake.test.ts`), and the sanctioned rebaseline is
taken with the residency ceilings re-pinned from what the fixed selector
produces (196 → 88). **The three named flights are still not flown**, and are
carried a third time.

Six things it changed or found that this plan must account for before `5-1`.
Read `PHASE_4_5_EXECUTION_PLAN.md` §10 for the measurements behind each.

| # | What | What Phase 5 must do |
|---|---|---|
| **X1** | **`PAGES_ARE_FINAL_AT_DISPATCH`** — `TerrainPageGenerator` publishes a page's TEXELS at dispatch-submit and lets its bounds/deviation readback land later. That is legal only while a page is final at dispatch. | `5-4`'s convergence rule (D12: a slot is never sampled mid-erosion, publish is the DAG's last stage) **retires this flag and deletes the branch it guards**. The constant exists so that retirement is a deletion, not an argument. `TerrainAtlasResidency.publishTexels` and the `texelsResident` field go with it, or become the DAG's own publish step. |
| **X2** | **A height page costs ~1.9 ms of GPU**, measured through `timestamp-query` (264² texels × 4× supersampling through the ~750-line kernel), against a 0.7 ms tier-1 `terrainCompute` row and a 1.55 ms whole-compute cap. No height page can be admitted through `planComputeAdmissions`' normal two-pass plan at any tier. | Two consequences. First, `erosionCompute`'s 0.4 ms row is almost certainly the same kind of guess and must be measured before `5-1` prices anything against it — `tests/gpu/terrain-compute-cost.test.ts` is the harness, and `COMPUTE_DISPATCH_SEED_COST_MS.erosionCompute` is a placeholder this phase owns. Second, the meter has **no notion of amortising one dispatch across several frames**; the `4.5-B2(b)` floor of one stands in for it. If the erosion DAG needs several dispatches per frame, that mechanism has to exist. |
| **X3** | **The floor of one.** `planComputeAdmissions` always admits one dispatch for the highest-priority client with demand, inside `ComputeBudget` (so `4-0b`'s "everything is admitted through the meter" invariant survives). The cap can therefore be exceeded by exactly one dispatch. | **Assertion 105 ("caps hold on burst traces") must be authored floor-aware**, or it fails on the first burst it sees. Erosion is the LOWEST-priority client, so the floor never fires for it while terrain has demand — which is the intended behaviour and worth asserting. |
| **X4** | **Supersampling is 4× at every level above L0** and is the dominant term in that 1.9 ms. The analytic `filterWidthMeters` band-limit already runs; the supersample is on top of it. | Grading or dropping it is a ~4× cut in the single most expensive compute client, and `5-4` is the item that rewrites page generation. It changes stored page heights, so it needs its own visual measurement and it lands with the DAG or not at all. |
| **X5** | **`splatIdHi` is written and never read.** `4.5-A2` takes the season-bucket ids from the LOW bucket alone (the `mix(idLo, idHi, blend)` it replaced was a latent defect its own comment already contradicted), so one of the seven channel-family textures is baked and stored for nothing. | Retiring it is a `WORLD_PAGE_GPU_CHANNELS` change with a memory-estimator row behind it — page-payload territory, which is this phase's. It returns a channel-atlas row and a share of every splat bake. |
| **X6** | **The bounds readback needs a ring of buffers.** Sharing one silently completed pages at min `+Infinity`, max `−Infinity`, deviation 0, which converged the whole CDLOD selector at the root ring with every automated test green. | Any DAG stage that dispatches and reads back on the same buffer has the same hazard: `copyBufferToBuffer` is encoded when the read is ISSUED, which is a microtask after the dispatch resolves — i.e. in the next frame's encoder, after that frame's `update()` has already overwritten the buffer. `tests/gpu/terrain-streaming-convergence.test.ts` is the instrument that catches this class; extend it rather than trusting a green suite. |

The original (pre-implementation) precondition table follows.



| # | Precondition | Source | What to verify |
|---|---|---|---|
| **P1** | Height pages generate on the GPU into the atlas; L0 pages are supersample-free with `filterWidthMeters = 0` (bit-faithful to the physics kernel by construction) | `4-3`, Phase 4 §5.6 | Assertion 80; parity assertions 73–76 green |
| **P2** | `TerrainCollisionMirror.publishPage` has real call sites and `fallbackSampleCount` is a mutable counter | `4-2` | Both are inert today: `publishPage` has **zero call sites** and the counter is a `readonly 0` ([`TerrainCollisionMirror.ts:28`](src/render/webgpu/terrain/TerrainCollisionMirror.ts:28)). **Note the counting-site correction in §4 D9** — the real counter lives in the *sim worker*, and Phase 4 should not over-build the render side. |
| **P3** | `ComputeBudget` exists with the reserved `erosionCompute` row live, and Governor B rung 0 fires first | `4-0b` | The budget *rows* already exist (0.2/0.4/0.7/1.2 ms, [`PerformanceBudget.ts:36`](src/render/webgpu/core/PerformanceBudget.ts:36)); the scheduler does not. |
| **P4** | The classifier (`4-6`) is live with `dayOfYear` in its signature and its wetness proxy **swappable in one line** for the real TWI | `4-6`, `RENDERING_PLAN.md` §3.2 | `5-5` performs that swap. |
| **P5** | The global height pyramid exists (512 m/texel, 256² over 128 km) | `4-7` | `5-3`'s macro domain supersedes its coverage — §5.1 decides whether it merges or remains. |
| **P6** | The GPU test harness reads back r32float storage textures; `tests/gpu/webgpu-limits.test.ts` is committed | Phase 4 P2 | Verified ad hoc on this machine 2026-08-19; the committed test is Phase 4's to land. |
| **P7** | The world-churn test inventory of §3.13 is re-derived on the post-Phase-4 tree | §3.16 rule | Phase 4 deletes the CPU tile path; several churn-sensitive tests move or change form. |
| **P8** | Gate B has landed (or its deferral is recorded) | §15 | Not a hard dependency — but every fps number captured in Phase 5 is contaminated by the vegetation draw debt and the presentation-timing defect until it lands, and `4-10`'s tier re-measure bakes in whatever state exists. |

Two standing conditions carry forward: **Babylon stays pinned at `9.21.2`**, and **one branch per gate** (`phase5/gate-5a` … `-5e`).

---

## 2. The engineering standard, applied to Phase 5

The lifetime classification carries forward: **P** permanent, **K** kernel, **T** transitional, **D** disposable.

- **Everything in `5-3`, `5-4`, `5-8` is Class K by proxy**: the eroded grid *is* the physics authority after `5-2`, so erosion kernels get the same discipline `src/world/{seed,noise,terrain,geology}.ts` has had since Phase 0 — deterministic, seeded, tested for bit-reproducibility, and never dependent on frame timing, admission order, or tier.
- **`5-2` is Class P and the phase's only game-breaking item.** `RENDERING_PLAN.md` §7 R9: *"A mismatch is game-breaking; treat every item in §1.3 as a hard gate on the Phase 5 merge."* Every §1.3 clause appears in this plan as a named assertion.
- **The tracer set is Class T and dies at `5-12`**: `traceDownhillPath`, `buildSourceCandidates`, `smoothTrace`, `buildBasinLake`, `maximumRiverGrade` — all carry their own deletion notes in source already. Do not extend them.
- **The false-colour overlay work in `5-3` is Class P, not D.** The plan mandates it *before* tuning; Phase 4's `TerrainDebugOverlay` (4-3) is its host. Erosion without the overlay is untunable — this is the lesson `RENDERING_PLAN.md` §7 R2(b) states as non-optional.

---

## 3. What the codebase actually is

Sixteen findings from this plan's recon (seven parallel line-cited sweeps over the current tree, 2026-08-19, plus two measurement runs). Line numbers cite the current tree; **the plan documents' citations are stale throughout** — `RENDERING_PLAN.md` cites the 35° fabric at `geology.ts:41-42` (now [`geology.ts:57-58`](src/world/geology.ts:57)) and `traceDownhillPath` at `HydrologyGeneration.ts:317-404` (now [`:331-418`](src/render/webgpu/water/HydrologyGeneration.ts:331)). **Rule for this phase: prefer symbol names; re-derive every line number against the branch you are writing on.**

### 3.1 The macro flood has no domain, and the world is unbounded

The world is infinite procedural: coordinates need only be finite, and every noise lattice wraps at 2¹⁷ cells ([`noise.ts:46-61`](src/world/noise.ts:46)). Drainage is a **global** computation — `5-3`'s own binding constraint says the coarse flood is "the sole authority on base levels and lake spill elevations." A global operation over an infinite domain is not a thing. No plan document defines the flood's extent, anchoring, or boundary condition; the two coarse grids that exist or are planned disagree with each other (§1.3's fallback names "level-6, 128 m/texel, 512², 1 MiB" = 65.5 km; `4-7`'s pyramid is 512 m/texel over 128 km; `5-3` says "L8"). **§5.1 decides this** — it is the single largest undefined architectural constant in the phase.

### 3.2 `5-2`'s plumbing does not exist end-to-end, and "one file" is only half true

`ARCHITECTURE.md` §3 promises "`5-2` changes exactly one file" ([`terrainGrid.ts:17-21`](src/sim/terrainGrid.ts:17)). Verified: `terrainGrid.ts` is the only *physics-query* site. But the transport does not exist at all: `SimulationCommand` has no terrain-page variant ([`protocol.ts:22-40`](src/workers/protocol.ts:22)), `publishPage` has zero call sites, no bicubic sampling code exists anywhere, and the diagnostics counter ([`FlightRenderer.ts:1019`](src/render/FlightRenderer.ts:1019)) reads a main-thread field **no message updates** — while the only place that can actually count fallback samples (it alone knows AGL and which authority served) is the **sim worker**. The publish path — renderer → `postMessage` → worker page ring → counter → diagnostics message back — is new code, and `5-2`'s 4.5 days are priced for it.

Two hot-path facts that shape the design: the worker samples terrain height **≥ 2× per 120 Hz step at every altitude** (telemetry AGL runs every step, [`simulation.worker.ts:142`](src/workers/simulation.worker.ts:142)), so the lookup must be allocation-free and the >500 m fallback is on a permanent hot path; and crash recovery samples up to **61 km** from the aircraft (ring radii [180, 420, 720] m at test points far outside any page ring, [`spawn.ts:19,78-101`](src/game/spawn.ts:19)) — the macro fallback grid is a correctness requirement, not an optimization. `next.config.ts` sets no COOP/COEP, confirmed — transferables, not `SharedArrayBuffer`.

### 3.3 The runway short-circuit is crowned now, not flat

Phase 3's `3-8` changed both collision entry points: `sampleTerrainCollisionHeight` short-circuits to `elevation + runwayCrownHeight(...)` (the 0.35 m camber, [`terrain.ts:248-261`](src/world/terrain.ts:248)) and `sampleTerrainCollision`'s runway branch returns a camber-tilted normal, not `(0,1,0)` ([`terrain.ts:305-342`](src/world/terrain.ts:305)). `RENDERING_PLAN.md` §1.3's runway invariant describes the pre-Phase-3 flat forms. **`5-2` must preserve the crowned fast path bit-for-bit** — assertion 63 pins collision to the rendered profile within 1 mm, and the readback swap must not reroute the runway branch through the grid.

### 3.4 §5.3's tier-dependent erosion scope forks the physics authority

`RENDERING_PLAN.md` §5.3 rows: erosion scope "macro only / macro + pages L ≤ 3 / all pages / all pages, +50% iterations". After `5-2`, page content **is** the collision surface. A tier that erodes L0 at High but not at Low gives two users two different grounds — and gives one user a ground that changes shape when they change a graphics setting. This is *exactly* the argument `PHASE_4_EXECUTION_PLAN.md` §3.3 used to strike the Ultra 1 m L0 row ("a tier-dependent L0 spacing makes the render-height authority tier-dependent, which breaks §1.3 by construction"). **Both rows are struck** (§4 D11): erosion parameters are world constants; tiers control only the *pacing* of page admission through the compute cap, never the converged content.

### 3.5 The ocean has no depth substrate of any kind

There is no bathymetry data anywhere. The sea floor is the kernel continuing below sea level to the −105 m shelf ([`terrain.ts:109`](src/world/terrain.ts:109)); `OceanConfig.representativeDepthMeters = 2000` is a dispersion constant, not spatial data. The ocean fragment shader binds **no terrain or depth input** and hardcodes `alpha = 1.0` ([`SpectralOceanSystem.ts:541`](src/render/webgpu/water/SpectralOceanSystem.ts:541)); despite its name, `deepAbsorption` is a constant *additive* body colour, not Beer-Lambert. The only depth-aware shading in the repo is the inland water's Beer-Lambert against a *heuristic* per-vertex depth (`0.22 + width·0.075`). No mesh anywhere sets `alphaIndex` (the plan's `5-11` note "give rivers a lower alphaIndex" starts from an unused mechanism — today ordering is purely opaque-ocean-then-blended-rivers). And hydrology meshes lack the ocean's earth-curvature drop ([`SpectralOceanSystem.ts:340-343`](src/render/webgpu/water/SpectralOceanSystem.ts:340) has it; [`HydrologySystem.ts:117-155`](src/render/webgpu/water/HydrologySystem.ts:117) does not). `5-10`/`5-11` start from zero and are priced accordingly (§4 D5).

### 3.6 The hydrology worker cannot survive erosion as designed

`hydrology.worker.ts:29` rebuilds the entire world **from the seed** inside the worker, and hydrology samples terrain at **filterWidth 0 via the analytic kernel** on both worker and fallback paths — never the band-limited render kernel, never any page. Post-activation, eroded heights are a GPU product not derivable from the seed on the CPU, so the worker's whole premise dies. §5.2 replaces it: the channel graph is extracted **once per seed from the macro readback** on the main thread; the worker becomes a mesh-builder that receives graph data by transfer, not a world-rebuilder.

### 3.7 A hydrology page channel already exists — dead, and with different fields than `5-5` names

[`payload.ts`](src/render/webgpu/world/payload.ts:25) declares `QuantizedHydrologyPage` — `flowXZ` (rg16snorm), `waterDepth` (r16uint), `shoreDistance` (r16sint), `discharge` (r16uint, log2-encoded) — with **zero producers and zero consumers**. `5-5`'s named channels (flowAccum, lakeDepth, soilDepth) don't exist. The channel rule says every page-channel addition goes through one PR against `payload.ts`; `5-5` must **reconcile** the dead spec with the real one, not add a parallel family (§4 D8). Note `shoreDistance` is exactly what `5-13`'s riparian exclusion needs — the dead spec was right about that.

### 3.8 The erosion halo cannot be the page gutter, and its name is constrained

The seam theorem needs a 64-texel halo; the shipped page gutter is **4** ([`pageGeometry.ts:32`](src/render/webgpu/world/pageGeometry.ts:32)), validated max 8. The halo is therefore internal to the erosion scratch (384² = 256 + 2×64), never a payload property. And the boundary test fails **any** `const`/`let` whose name contains `GUTTER` or `PAGE_EXTENT` outside `src/render/webgpu/world/` ([`architecture.boundaries.test.ts:107-109`](tests/architecture.boundaries.test.ts:107)) — name it `EROSION_HALO_TEXELS`, import page geometry, declare nothing page-shaped locally.

### 3.9 Two `plannedBy` markers point at the wrong items

`owners.ts` pins `TerrainErosionCompute.ts` at `plannedBy: "5-1"` — but `5-1` is a specification item that creates no compute file — and `ChannelNetwork.ts` at `plannedBy: "5-5"`, while the plan's channel-graph item is `5-9` ([`owners.ts:454-462`](src/render/webgpu/owners.ts:454); `RENDERING_PLAN.md:385`). The boundary test requires the marker removed **in the commit that creates the file**, so a mismatched marker becomes a broken build at the worst moment. `5-0` re-points both (§4 D10).

### 3.10 The compute substrate is half-built, with two readiness idioms

`erosionCompute` frame-budget rows exist per tier; no scheduler, no profile knob, no memory row exists (erosion's working set currently has nowhere to land but the flat 8–13 MiB other-detail allowance). `FrameGraph` cadence is written and completely unused — all five registered passes run every frame — and there is no terrain-compute pass at all (hydrology piggybacks on `spectral-ocean-compute` in the *water* phase). Two compute-readiness idioms coexist: the ocean's awaited `waitForComputeReady` barrier + `fastMode` ([`SpectralOceanSystem.ts:94-161,882`](src/render/webgpu/water/SpectralOceanSystem.ts:94)) versus the clouds' per-frame `isReady()` polling. **Erosion uses the ocean's** — an erosion pass that silently skips frames while pipelines compile would corrupt the page DAG (§5.4).

### 3.11 The kernel's carve terms are hand-painted proxies for what erosion computes

`valleyCarve` (`pow(1−ridges, 3.1)`, [`terrain.ts:156-163`](src/world/terrain.ts:156)), `ravineCarve` and the mean-removed `talusRidges` ([`geology.ts:99-121`](src/world/geology.ts:99)) are pointwise imitations of incision and talus. Eroding *on top of* them double-carves every valley. They are deleted at activation, not before (§4 D4), because until activation they are the shipped look. The uplift/detail partition of every kernel term is recorded in §7's `5-8a`.

### 3.12 The 35° fabric is smaller than advertised, and there is a second grain

The rotation lives at [`geology.ts:57-58`](src/world/geology.ts:57) with exactly three consumers (fractureRidges 390/980 m, fractureVariation 155/240 m, talusRidges 120/280 m — axis ratios only 2.5:1/1.6:1/2.3:1; the audit's 23.6:1 is the *composite's measured* anisotropy, not a coefficient). A **second hard-coded direction exists outside geology**: the rain-shadow moisture shear, factor 0.42 (~22.8°) at [`terrain.ts:355-359`](src/world/terrain.ts:355) — a `5-8` scoped only to geology leaves the climate field gridded to one compass bearing forever. And the `MAX_TERRAIN_HEIGHT = 2200` clamp **never fires**: measured max over 965k samples across 6 seeds is 1,809.6 m. The raise to 4,500 m is pure headroom until `5-8a`'s uplift actually uses it — the churn event is the uplift, not the constant. Also: `sampleTerrainMoisture` and `sampleTerrainTemperature` accept `filterWidthMeters` and **ignore it** (assert-only) — band-limiting was wired into the height chain only.

### 3.13 The world-churn blast radius, enumerated

When the terrain's shape changes, these fail or must re-pin: all 13 SSIM'd capture baselines (the committed `report.json` is a rebaseline artifact — its SSIMs are all null; the PNGs are the gate); the **384-seed airport audit** ([`world.test.ts:453-499`](tests/world.test.ts:453)) — new terrain statistics can break *site selection*, not just thresholds; the relief-statistics pins for two named seeds; `world.geology.test.ts`'s amplitude envelope (dies with the fabric it pins); and `world.band-limit.test.ts` assertions 23–25 (survive only if the *analytic kernel entry points* keep their band-limit semantics — the uplift restructure must preserve them or re-pin them). Shape-robust: determinism/continuity/bounds (bounds read the constants, so 4,500 auto-propagates), tile edge-matching, kernel portability, page geometry. **Capture shots must be APPENDED, never inserted** — the driver pins per-shot simulation time by array index ([`perf-capture.mts:443-447`](scripts/perf-capture.mts:443)). One outstanding obligation rides this phase's churn: `runway-on-approach`'s ceilings were pinned from one run, not three.

### 3.14 The felt frame: the user's report is the committed baseline, and two mechanisms own the "shaking"

The 2026-08-19 flight-test report ("choppy/almost laggy on anything but lowest settings; the plane constantly feels like it's shaking") is not a regression — it is the shipped state. **9 of 14 committed baseline shots run below 30 fps at tier 1** (22.0–29.1 fps on every near-ground shot; the five far-field shots run 75–91), the floors having been re-pinned *down* as recorded perf debt. The frame is a **vegetation draw-call workload**: sub-30 shots carry 675–968 draws at ~26 µs each; the structural fix — merging crown and trunk meshes, 347 → 186 draws, 9.0 → 4.8 ms at tier 1, at identical fidelity — is priced in [`renderedDensity.ts:326-357`](src/render/webgpu/detail/renderedDensity.ts:326) and deliberately left **unscheduled**. Nothing before Phase 6 (`6-8`/`6-9`) touches it.

The *shaking* is a second, unowned mechanism. The renderer interpolates sim snapshots, but the interpolator clamps `alpha` to [0,1] (no extrapolation) and re-anchors its timeline to **main-thread message arrival** ([`SimulationClient.ts:98-109`](src/game/SimulationClient.ts:98)); at tier-1 frame times (33–46 ms against 16.7–25 ms snapshot spans) it degrades to snapping-to-latest at message-burst granularity. The chase camera then smooths its *position* but aims `setTarget()` at the **raw** interpolated aircraft position every frame and copies the aircraft's up-vector unsmoothed in the default (non-reduced-motion) mode ([`FlightRenderer.ts:1289-1306`](src/render/FlightRenderer.ts:1289)) — so every snap rotates the whole view. (The FOV *is* smoothed by the same response factor — one recon claim corrected.) Two more contributors: the floating-origin rebase fires `cameraCut` every ~50–80 s of cruise, and a **plausible latent bug** — vegetation chunks rebuild their origin-relative instance buffers amortized at 1 chunk/frame with the origin in the chunk *signature* but no mesh-level compensation, so stale chunks would render offset by the 2–4 km origin delta for up to ~6–9 frames per rebase ([`WorldDetailRuntime.ts:281,860-916`](src/render/webgpu/detail/WorldDetailRuntime.ts:281); unverified at runtime; no test covers rebase). **No plan item in any phase owns any of this.** Gate B (§15) does now. One observability note rides with it: the committed numbers do not reconcile — sub-30 shots pace at 33–46 ms while `gpuFrameMsP95` (11.8–20.4) + `cpuFrameMsP95` (5.3–7.4) sum to well under that; attribute before tuning (B-0).

### 3.15 The forest pattern: the variance is authored and then flattened, and openings never open

The second report ("sometimes too much foliage; forests are good but there should be variance") also has a measured mechanism, in two parts. (a) The glade field is floored at **0.3** and disturbance at **0.15** ([`densityField.ts:103-112`](src/render/webgpu/detail/densityField.ts:103)) — wet-lowland closed forest authors ~800 stems/ha, so a glade at its floor still authors ~240/ha. (b) The rendered near band caps at **~78 stems/ha** (tier 1) and thins by cell-wide canopy rank — so *every* cell authored above the cap renders the same stem total, and a floored glade (240/ha ≈ 3× cap) renders as mild thinning, **never as ground**. Measured over 40×40 km: 45% of land ≥ 200 authored stems/ha, 32% < 50/ha — the world is not literally forest everywhere; the percept comes from km-wide soft moisture gradients being the *only* pattern, 80% of area fully undisturbed, and no opening ever reaching zero. The `6-6` amendment half that fixes this (glade floor → ~0, a hard-edged disturbance class, a forest-edge margin term) has **zero dependency on Phase 5 erosion outputs** — it edits noise terms that exist today — and is pulled into Gate B (B-3). One genuinely Phase-5 consequence: vegetation has **no water input at all** (no hydrology reference anywhere in `detail/`; stems author inside today's river ribbons) — `5-12`'s carved rivers make that collision glaring, so a minimal riparian/channel exclusion (`5-13`) lands *with* the rivers, not in Phase 6.

### 3.16 Assertion numbering, and the tests `5-12` deletes

Highest implemented assertion is **66** (67 carried open — no per-pass GPU timer exists, still); Phase 4 reserves **68–86**; Phase 5 numbers from **87**, and Gate B — which lands *before* Phase 4 — letters onto Phase 3's last number as **67a–67f** (precedent: 45b, 51b). The pure-hydrology suite ([`render.webgpu-hydrology.test.ts`](tests/render.webgpu-hydrology.test.ts)) tests **exactly the functions `5-12` deletes** — budget its rewrite, not its extension (§4 D6). `collisionSamplesServedByFallback` already exists end-to-end as a diagnostics field and HUD row; only the authority behind it is missing.

---

## 4. Amendments

Binding over `RENDERING_PLAN.md` Phase 5 and, where marked, over `PHASE_4_EXECUTION_PLAN.md`.

### D1 — Gate B, "the felt frame" (7.25 d), scheduled before Phase 4

§3.14/§3.15. Full spec in §15. Runs **before Gate A** (recommended — it answers the user's most recent reports, its items are independent of everything, and `4-10`'s tier re-measure must not bake the debt in). Order becomes **Gate B → Gate A → Phase 4 → Phase 5**. `PHASE_4_EXECUTION_PLAN.md`'s "Runs after" line is amended by its 2026-08-19 banner.

### D2 — The macro domain: finite, world-anchored, open-rimmed

The evolution authority is **one world-anchored macro grid: 1024² texels at 512 m/texel = 524.3 km square, centred on the world origin** (the spawn airport's neighbourhood), r32float, ~4 MiB, flooded eagerly at world load. Boundary condition: the rim is **open** (drains outward at sea level), so no artificial rim lakes form. Beyond the rim the analytic kernel continues unmodified through a 16-texel blend band — no erosion, no rivers, no lakes outside the domain. This bounds "endless": ~262 km of eroded world in every direction (~70 min of cruise), analytic terrain beyond, recorded as a deliberate product decision (§16) rather than an accident. Re-anchoring windows were considered and rejected: a lake's spill elevation must never change because the aircraft moved — determinism-of-place is the §1.3 invariant one level up. `4-7`'s 128 km pyramid remains the *occlusion* pyramid; the macro grid supersedes it as the *height* fallback (they may share storage if `5-3` finds it clean — a decision-log item, not a requirement).

### D3 — `5-8` splits, and the uplift lands before the flood

`5-8a tectonic-uplift` (4.5 d) moves **ahead of `5-3`**: plates, orogens, the per-region fabric direction field (double-angle encoded), lithology → erodibility, the shelf→slope→abyssal bathymetric profile, and the uplift partition of the existing kernel. Reason: erosion parameters are tuned against their uplift field, and tuning them twice — once against today's isotropic blobs draining to a flat −105 m shelf, again after `5-8` replaces both — is the schedule risk R2 warns about, doubled. `5-8b` (0.5 d, in Gate 5D) is the lithology-erodibility coupling inside the page kernel, tuned with `5-4`. The rain-shadow moisture shear (§3.12) is re-aimed by the regional fabric in `5-8a` — one line's worth of coupling that removes the *second* global grain for free. None of `5-8a` changes rendered pixels before activation (D4).

### D4 — The activation commit: every world-shape change ships dark, then flips once

All of `5-8a`'s uplift, `5-3`'s macro flood, `5-4`'s page erosion, `5-7`'s fine band and the carve-proxy deletions develop behind a single world-level flag (`worldEvolution: "analytic" | "eroded"`, a `WorldDefinition` option — **not** a profile field; the tier rule and §3.4 both forbid that), visible meanwhile only through the debug overlay and tests. **`5-A` (new, 1.5 d) flips it once**: eroded pages become the height authority, `MAX_TERRAIN_HEIGHT` rises to 4,500, the carve proxies are deleted, the world-test re-pins and the 384-seed airport audit re-tune land, and the phase's **single terrain rebaseline** happens — R10's "land them together so the baselines rebase once," satisfied without a mega-merge. Between `5-A` and `5-12`, inland ribbons are **disabled** (the tracer samples the analytic kernel, which after activation is no longer the rendered ground — ribbons would float and clip); a dry-valleys interim of ~2 weeks is recorded as this phase's R-25-style known interim, with the macro-sampler stopgap named as fallback if review judges it unacceptable (§16).

### D5 — Water optics move to the head of the phase, and are re-priced

`5-10`/`5-11` run as **Gate 5B, immediately after the readback gate** — they depend on nothing erosion produces (§3.5: the bed *is* the terrain field, whatever authority generates it). The bathymetry clipmap samples the current height authority (pre-activation: the `4-1` kernel include + earthworks; post-activation: eroded pages/macro — re-sourced in `5-A`, ~0.5 d already inside `5-A`). This gives the phase an early user-visible payoff (real shallows, soft shorelines, underwater light) before the erosion dark stretch, and de-risks `5-12`'s rendering half. `5-11` is re-priced 4.0 → **4.5** — §3.5: the ocean is opaque with a hardcoded alpha and no depth input; making it shore-aware (alpha or bed-blend near shore, `alphaIndex` ordering vs rivers, the below-surface camera) is substrate work the 4.0 assumed existed. This adds the phase's **second sanctioned rebaseline** (water pixels change at 5B close) — deliberate: the alternative is deferring visible water wins ~8 weeks to ride `5-A`'s churn.

### D6 — `5-12` re-priced 6.0 → 7.0, and the mesh strategy is "conservative cover + per-pixel trim"

Two corrections. (a) The pure-hydrology test suite tests exactly what `5-12` deletes (§3.16) — +1.0 d for its rewrite around the graph builder. (b) The lake/river mesh does **not** need pixel-exact shorelines: with `5-11`'s depth-driven shoreline alpha, water geometry only needs to *conservatively cover* the wetted area — the per-pixel bed-vs-surface depth trims the visible edge exactly. Lake polygons therefore come from the macro lake mask (marching squares → Douglas-Peucker → ear clipping, every vertex at the exported spill elevation), slightly overreached, with no fine-page dependency; river ribbons cover the exported wetted width with per-vertex surface elevations from the graph. This removes `5-12`'s hardest dependency (fine-page residency for shoreline extraction). Also: `maximumRivers` is 7 today, not the plan's 10 (R-24) — the "raise" the plan asks for is a raise from 7, and the caps that replace it are contract quantities (D7/`5-1`). Region paging survives as *mesh* paging; the hydrology worker becomes a transfer-fed mesh builder (§3.6).

### D7 — The lake caps are replaced by contract, per the realignment's demand

`PRE_PHASE_4_REALIGNMENT.md` §8: decide before `5-1` what replaces `maximumLakes: 5` / `maximumLakeRadiusMeters: 900`. Decided: **no count or radius caps.** Lakes are whatever the macro flood retains; the budget-bearing quantities are a **minimum meshed surface area** (lakes below it render as terrain wetness, not water surface — one splat-side term) and a **per-region mesh triangle budget** asserted in the estimator. Spill elevations are flood outputs, never tunables. Numbers proposed in `5-1` and pinned by its tests: minimum meshed lake area 0.04 km² (~200×200 m), region mesh budget sized from the measured mesh cost at `5-12`.

### D8 — `5-5` re-priced 2.0 → 2.5, and it reconciles the dead hydrology channel

§3.7. `5-5`'s named sub-steps: reconcile `QuantizedHydrologyPage` with the real channel family (keep `shoreDistance` and `discharge`; add `lakeDepth`, `soilDepth`; `flowAccum` supersedes `discharge` or maps onto it — one PR against `payload.ts` per the channel rule), bake them into the 136² channel atlas, and **perform the classifier TWI swap** (`4-6` shipped a curvature proxy "swappable in one line" — this is the line, plus its golden re-pin).

### D9 — `5-2`'s true scope, the authority ladder, and a Phase 4 note

§3.2. `5-2` builds: the `terrainPage`/`terrainMacro` `SimulationCommand` variants (transferables), the worker-side 5×5 L0 page ring with Catmull-Rom bicubic sampling (bilinear C0 kinks read as bumps through a gear model), the macro grid transfer at load, the **worker-side** fallback counters plumbed back on the existing snapshot message, and the §1.3.6 headless parity harness. The **authority ladder** is: L0 readback ring → eroded macro grid → analytic kernel; the analytic kernel is demoted to *last* resort (outside the domain, or pre-load) because post-activation it no longer resembles the rendered world even at altitude. The counter splits: `macroServed` (informational) vs `analyticServed` (must be 0 below 500 m AGL inside the domain — assertion 93). **Phase 4 note (binding on `4-2`):** wire `publishPage` and make the counter mutable as planned, but do not build worker plumbing — the counting site moves into the sim worker at `5-2`; `4-2`'s counter is the render-side aggregation only. Recorded as an amendment banner on `PHASE_4_EXECUTION_PLAN.md`.

### D10 — `owners.ts` reconciliations, in `5-0`

`TerrainErosionCompute.ts` `plannedBy` "5-1" → "**5-3**" (the item that creates the file); `ChannelNetwork.ts` `plannedBy` "5-5" → "**5-9**". New rows land with their artifacts: `TerrainEvolutionContract.ts` (5-0), `TerrainMacroEvolution.ts` (5-3), `BathymetryClipmap.ts` (5-10).

### D11 — Erosion output is tier-invariant; §5.3's scope rows are struck

§3.4. Struck from `RENDERING_PLAN.md` §5.3: the erosion-scope row and Ultra's "+50% iterations". Iteration counts, halo, seeds and operators are world constants. Tiers keep exactly one erosion lever: the **admission pacing** (`erosionCompute` ms cap, which already exists per tier) — a Low-tier machine converges the same pages more slowly, never to different content. A unit test asserts the erosion kernel configuration takes no tier argument (the `texelSizeMeters` precedent, assertion 68's sibling).

### D12 — Erosion runs under `ComputeBudget`, on the ocean's readiness idiom, in a new pass

§3.10. A `terrain-evolution` frame-graph pass registers in the **visibility** phase (after `world-page-visibility`, which decides what pages exist; before shadows, which consume their content). Compute pipelines are compiled behind the ocean's awaited `waitForComputeReady` barrier with `fastMode` set after; per-frame dispatches are admitted through `4-0b`'s meter against the `erosionCompute` row. A page mid-erosion holds the lifecycle `generating` state `4-2` adds; its slot is not sampled until converged (the DAG rule, §5.4).

### D13 — `5-13 riparian-and-channel-exclusion` (0.75 d, new)

§3.15. `densityField` gains a water term from the exported channel data (`shoreDistance`/wetted width/lake mask): zero authored stems inside wetted areas, a riparian density/species-weight boost within the bank band. This is the minimal G-A-correctness piece so `5-12`'s rivers don't run through trees; `6-6`'s full ecology channels (riparian archetypes, shelter, soil-depth litter) stay in Phase 6.

### D14 — Assertion 86 is re-scoped at `5-A`

Phase 4's assertion 86 (`collisionSamplesServedByFallback` = 0 below 500 m AGL) is re-scoped to the eroded authority as assertion 93: `analyticServed = 0` below 500 m AGL *within the macro domain*, over the full `sim.flight` profile, with the readback authority live.

### D15 — Phase 6 knock-ons

`6-6` loses its +0.5 d amendment half to Gate B (B-3) → Phase 6 ≈ **27.0 d**. `6-1`/`6-2`/`6-3`/`6-4` consume `5-10`/`5-11`/`5-12` as planned, unchanged. `6-5` (terrain wetness) gains a head start: `5-12` wires lake-bed wetting from `lakeDepth` (one term, noted in its item), which `6-5` generalizes.

### Amended ledger

| Gate | Items | `RENDERING_PLAN.md` | This plan |
|---|---|---:|---:|
| 5A — Contracts and the readback | `5-0` `5-1` `5-2` | 7.5 | **9.00** |
| 5B — Water that has depth | `5-10` `5-11` | 8.0 | **8.50** |
| 5C — The uplift and the macro flood | `5-8a` `5-3` | (5-3: 9.0) | **13.50** |
| 5D — Page erosion and the activation | `5-4` `5-8b` `5-7` `5-6` `5-5` `5-A` | 14.0 + (5-8: 5.0 split) | **16.50** |
| 5E — Rivers and lakes from the graph | `5-9` `5-12` `5-13` | 8.0 | **9.75** |
| **Phase 5** | | **51.5** | **57.25 d ≈ 12.7 weeks (range 55–68)** |

Net **+5.75 d**: the contract (`5-0`, 1.5), the activation machinery and churn work (`5-A`, 1.5), the ocean's missing depth substrate (+0.5 on `5-11`), the TWI swap and payload reconciliation (+0.5 on `5-5`), the hydrology-suite rewrite (+1.0 on `5-12`), riparian exclusion (`5-13`, 0.75). Gate B adds **7.25 d before Phase 4**. Reconciled programme: ≈330 − 51.5 + 57.25 + 7.25 − 0.5 (Phase 6) ≈ **343 d**; v1 cut line ≈ 217 + 7.25 ≈ **224 d**.

---

## 5. The evolution contract (`5-0` + `5-1`)

`src/render/webgpu/terrain/TerrainEvolutionContract.ts` (types, constants, keys; no Babylon import) plus `src/render/webgpu/world/payload.ts` (the channel PR). Eleven consumers depend on these two files; they land before everything.

### 5.1 The macro authority

- **Domain:** D2's constants — `EVOLUTION_DOMAIN_TEXELS = 1024`, `EVOLUTION_TEXEL_METERS = 512` (matches L8 page texel spacing, so the page hierarchy's top parent *is* a macro region), world-anchored at the origin, open rim, 16-texel analytic blend band.
- **Pipeline at world load** (GPU, once per seed, behind the existing load screen; budget ≤ 1.5 s on the reference machine, measured and recorded): uplift + lithology + fabric fields from `5-8a`'s include → multigrid Planchon–Darboux fill (8 relaxations × 7 levels, ε = 1e-3 m/texel) → MFD accumulation (hierarchical atomic-free gather) → stream-power incision (implicit Jacobi, fixed iteration count) → talus (two-pass mass-conserving) → **readback** (4 MiB) → exports.
- **Exports (CPU-resident, deterministic per seed):** the eroded macro height grid; flow accumulation; the lake mask with **per-lake spill elevation and outlet texel**; base levels per drainage; channel seeds (every texel whose accumulation exceeds the channel-initiation threshold). These are the sole authority on base levels and lake spills — fine pages may deepen an existing lake, never create one (assertion 88).
- **Consumers:** the sim worker (fallback grid, transferred once), page erosion (parent seed for L7-and-coarser page generation), `ChannelNetwork` (5-9), the debug overlay, crash recovery.

### 5.2 The export list (`5-1`) — the erosion↔hydrology interface, typed and tested

The best-specified item in the design set, now with the codebase's names. One interface family in `TerrainEvolutionContract.ts`:

- **Per-page channels** (through `payload.ts`, D8): `flowAccum` (r16f, log-encoded — dynamic range spans 1 texel to the whole domain), `lakeDepth` (r16f, metres, 0 almost everywhere), `soilDepth` (r8unorm, 0–8 m — `soilDepth = f(slope, curvature, log A)` is what produces the crest/valley roughness contrast), `shoreDistance` (kept from the dead spec, r16sint, signed metres to the nearest wetted edge).
- **The channel graph** (`5-9`'s output type, defined here so `5-4`'s carving and `5-12`'s meshes agree by construction): nodes `(x, z, elevation, accumulation A)`, edges with **exported** hydraulic geometry — `Q = k·A^0.7`, `w = a·Q^0.5`, `d = c·Q^0.4` — plus per-edge bank and thalweg elevations sampled from the eroded grid at export time. **Rendering never recomputes any of these** (assertion 102's string check); carving and geometry disagree only if someone breaks the contract.
- **Lakes** (D7): `(polygonRef, spillElevation, outletNodeId, maxDepth, surfaceAreaM2)` — no count caps; `MINIMUM_MESHED_LAKE_AREA_M2` gates meshing; below it, wetness only.
- **Determinism rule, stated as a constant of the contract:** every export is a pure function of `(seed, device)` — never of tier, admission order, frame timing, or flight path. Same-device bit-reproducibility is asserted (assertion 89); cross-device identity is *not* promised (R10's recorded open question — if replays or shared seeds ever matter, the collision mirror becomes the transmitted authority).

### 5.3 The authority ladder and its counters (`5-2`)

```
collision height =
  L0 readback ring (25 pages, Catmull-Rom)   — the bit source near the ground
  → eroded macro grid (512 m/texel, bilinear) — everywhere inside the domain
  → analytic kernel (width 0)                 — outside the domain, or pre-load
```

Counters (worker-side, on the snapshot message): `readbackServed`, `macroServed`, `analyticServed`. Assertion 93 pins `analyticServed = 0` below 500 m AGL inside the domain. The runway short-circuit (§3.3) bypasses the ladder entirely and keeps its crowned analytic form — assertion 94 re-proves assertion 63 against the eroded world, plus the erosion-mask half: the eroded L0 page *inside the apron* equals the earthworks profile within 1 mm (i.e. `5-6` actually held).

### 5.4 The page-generation DAG

Post-`5-4`, generating a page at level L is a multi-frame pipeline, all inside the `generating` lifecycle state, admitted through `ComputeBudget`:

```
uplift-gen (kernel include, filterWidth = texel)     [terrainCompute row]
→ seed: bicubic(parent eroded) + bandLimited detail  [parent MUST be converged]
→ erode: pit-breach(≤16 texels) → MFD → stream power → talus, fixed counts, 384² scratch
→ min/max reduction (CDLOD AABB)                     [erosionCompute row]
→ aux channels (5-5) → splat/occlusion re-bake       [splat/occlusion rows]
→ publish: L0 → collision readback; slot becomes sampleable
```

Rules, each an assertion or a reviewed invariant: **the parent-dependency rule** — a page's erosion never starts until its parent (chain terminating at the macro grid) is converged; coarse pages are few and wide, so the LRU pins them effectively for free. **The seam rule** — talus and Jacobi propagate ≤ 1 texel/iteration, max radius 32 texels < the 64-texel scratch halo, so adjacent same-level pages are bit-identical on their 4-texel stored overlap (assertion 90 — *exact equality, not tolerance*). **The convergence rule** — a slot is never sampled (by the vertex shader, the splat bake, or the collision publish) mid-erosion; the CDLOD falls back to the parent until `markGenerated`. **The determinism rule** — evict-and-regenerate yields bit-identical content (assertion 89), which requires fixed iteration counts and workgroup-order-independent operators (ping-pong Jacobi, hierarchical gather — no atomics on results).

### 5.5 Profile, estimator, and budget rows (the Z-4 pattern: rows move with inputs)

- **Profile:** no new erosion fields (D11). The existing `erosionCompute` budget row is the only tier lever.
- **Estimator rows (new, form-tested):** `macroEvolutionMiB` (≈ 4 grid + ≈ 8 flow/lake working set at load, ≈ 5 resident), `erosionScratchMiB` (6 × 384² r32float ≈ 3.5, reused forever), `bathymetryClipmapMiB` (2 × 1024² R16F ≈ 4), `channelGraphMiB` (measured at `5-9`, expected ≤ 2), aux-channel additions inside `channelAtlasMiB`. Balanced's D3 table headroom after Phase 4 is ~36 MiB (444/480); these rows add ~12 resident — it closes to ~456/480. **Regenerate Phase 4's D3 table with these rows in `5-0`** and record it; if it breaches, the named fallback is the Phase 4 standing one (`msaaSamples` 4 → 2 at tier 1, −39.5 MiB).
- **Frame rows:** `erosionCompute` exists. `5-0` adds no new rows; the bathymetry update and channel-mesh builds are booked under existing water/terrain rows and measured at their items.

### 5.6 Naming, boundaries, and idioms

`EROSION_HALO_TEXELS = 64`, declared in `TerrainErosionCompute.ts` (contains neither forbidden substring; §3.8). No `profile.tier` reads outside `core/` — erosion consumes budget caps as data. All channel types through `payload.ts`. Compute readiness: the ocean idiom (D12). WGSL erosion kernels live in `TerrainErosionCompute.ts` under the existing owner row; the uplift include lives with `4-1`'s kernel (`TerrainKernel.ts`) — one height-kernel definition site, per the ownership table.

---

## 6. Work order

### 6.1 Dependencies

```
5-0 ──→ 5-1 ──→ 5-2 ─────────────────────────────┐
  └───→ 5-10 ──→ 5-11 ──────────────┐             │
5-1 ──→ 5-8a ──→ 5-3 ──→ 5-4 ──→ {5-8b, 5-7, 5-6, 5-5} ──→ 5-A ──→ 5-9 ──→ 5-12 ──→ 5-13
                                                  (5-11 ──→ 5-12;  5-9 ──→ 5-13)
```

`5-2` must be live before `5-A` (activation may not happen until collision reads pages). `5-9` runs after `5-A` because the graph must be extracted from the *activated* flood, not a tuning-era one.

### 6.2 Gate order, and why each gate is visible

- **5A — Contracts and the readback.** *Visible:* the HUD's authority/fallback counters, and nothing else. Short and dark by design; it front-loads the phase's only game-breaking item against the *analytic* pages, where parity is guaranteed by Phase 4's construction, so the machinery is proven before erosion makes the answer interesting.
- **5B — Water that has depth.** *Visible, immediately:* shallow water glows over a visible bed, shorelines feather instead of hard-clipping, deep water is blue because red is absorbed, and ditching past the surface shows Snell's window instead of the skybox. The phase's early payoff, deliberately ahead of the dark stretch.
- **5C — The uplift and the macro flood.** *Visible only in the overlay* — continental spines, dendritic flow, lakes with real spills, fabric that turns with each range — while the rendered world is untouched. The dark stretch, stated plainly; the overlay is the deliverable.
- **5D — Page erosion and the activation.** *The payoff of the programme:* at `5-A` the world becomes "a landscape that something happened to" — V-notched headwaters, alluvial floors under angular crests, continuous divides, gullies at 500 ft, a real shelf and abyssal plain. One commit, one rebaseline.
- **5E — Rivers and lakes from the graph.** *Visible:* rivers sit *in* carved valleys with real confluences and deltas; lakes are flat at their spill elevation with soft depth-driven shores; no tree grows out of a river.

### 6.3 Week ledger — 4.5 productive days per week

| Week | Days | Work | Cumulative |
|---|---|---|---|
| 1 | 0 → 4.5 | `5-0` contract (1.5) · `5-1` export contract (3.0) | 4.50 |
| 2 | 4.5 → 9.0 | `5-2` collision readback (4.5) → **Gate 5A closes, d9.0** | 9.00 |
| 3 | 9.0 → 13.5 | `5-10` bathymetry clipmap (4.0) · `5-11` start (0.5) | 13.50 |
| 4 | 13.5 → 18.0 | `5-11` water-depth optics (4.0) → **Gate 5B closes, d17.5** · rebaseline #1 · `5-8a` start (0.5) | 18.00 |
| 5 | 18.0 → 22.5 | `5-8a` tectonic uplift (4.0; done d22.0) · `5-3` start (0.5) | 22.50 |
| 6 | 22.5 → 27.0 | `5-3` macro drainage (4.5) | 27.00 |
| 7 | 27.0 → 31.5 | `5-3` finish (4.0) → **Gate 5C closes, d31.0** · `5-4` start (0.5) | 31.50 |
| 8 | 31.5 → 36.0 | `5-4` page erosion (4.5) | 36.00 |
| 9 | 36.0 → 40.5 | `5-4` finish (3.0) · `5-8b` erodibility (0.5) · `5-6` runway mask (1.0) | 40.50 |
| 10 | 40.5 → 45.0 | `5-7` fine band (3.0) · `5-5` aux channels (1.5) | 45.00 |
| 11 | 45.0 → 49.5 | `5-5` finish (1.0) · `5-A` **activation + rebaseline #2** (1.5) → **Gate 5D closes, d47.5** · `5-9` start (2.0) | 49.50 |
| 12 | 49.5 → 54.0 | `5-12` carved rivers and lakes (4.5) | 54.00 |
| 13 | 54.0 → 57.25 | `5-12` finish (2.5) · `5-13` riparian exclusion (0.75) → **Gate 5E / Phase 5 closes, d57.25** | 57.25 |

The erosion items carry their stated ranges (`5-3` 8–14, `5-4` 7–14); at the top of both ranges the phase runs ~68 d. The ranges are real — `RENDERING_PLAN.md` §0.3 names erosion tuning as the programme's single most likely slip, and D3/D4 exist precisely to keep a slip inside Gate 5C/5D instead of letting it cascade.

---

## 7. Gate 5A — Contracts and the readback (9.0 d)

**Branch:** `phase5/gate-5a`.

### `5-0` — Evolution spine contract (1.5 d) · Class P

§5 is the specification: the macro domain constants, the authority-ladder types, the DAG and its four rules, the estimator rows with the regenerated D3 table, the `owners.ts` re-points (D10) and new rows, the flag plumbing (`worldEvolution`, D4), and the tier-invariance assertion.

**Gate:** `tests/render.webgpu-evolution-contract.test.ts` — domain constants frozen and derived (texels × texelMeters = extent); estimator rows move with inputs; erosion kernel config takes no tier argument; `plannedBy` markers consistent with this plan's item numbers.

### `5-1` — Erosion-hydrology export contract (3.0 d) · Class P (spec + tests, no rendering)

§5.2 verbatim, as code: the typed exports, the hydraulic-geometry functions with pinned exponents, the lake-cap replacement (D7), the log-encoding for `flowAccum` with round-trip tests, quantization decisions for every channel, and golden tests over synthetic drainage fixtures (a known cone, a two-basin saddle, a rim-crossing channel) that pin topology, spills, and hydraulic values before any GPU code exists.

### `5-2` — Collision readback, fallback ladder, parity harness (4.5 d) · Class P · **the §1.3 hard gate**

D9's scope. Sub-steps, in order: (1) the protocol variants + transferable plumbing (the terrain worker's `getTerrainTileTransferables` pattern); (2) the worker-side page ring (25 × 256² Float32, pooled buffers, allocation-free Catmull-Rom sampling — verified against the ≥240 samples/s hot path of §3.2); (3) the macro-grid transfer at load and the crash-recovery re-route onto the ladder; (4) worker-side counters on the snapshot message, HUD unchanged; (5) the **headless parity harness** (§1.3.6): a `tests/gpu/` test that drives the real atlas → readback → worker-grid path and asserts grid == page bytes (assertion 91) and Catmull-Rom C1 continuity (assertion 92) — because `sim.flight.test.ts` runs in Node against the analytic fallback and *cannot* see a readback divergence (§3.16).

Landing this against Phase 4's analytic pages means parity is exact by construction (L0 is `filterWidth 0`, supersample-free) — the machinery is proven while the answer is boring.

**Gate:** assertions 91–93 (93 in its pre-activation form: ladder live, `analyticServed = 0` below 500 m over the profile); assertion 63/64 still green (the runway fast path untouched); `sim.flight` and the 384-seed audit unchanged (they run on the analytic authority in Node — recorded, not accidental).

---

## 8. Gate 5B — Water that has depth (8.5 d)

**Branch:** `phase5/gate-5b`. **Closes with sanctioned rebaseline #1** (water pixels change on coast/slant shots).

### `5-10` — Bathymetry clipmap (4.0 d) · Class P

`src/render/webgpu/water/BathymetryClipmap.ts` (new owner row, owner: water). Two toroidal R16F levels: L0 1024² at 16 m/texel (16.4 km), L1 1024² at 128 m/texel (131 km), storing `bedElevation − seaLevel` clamped to ±256 m in L0 (~0.06 m precision in the shallow band, per the plan). Filled by compute sampling the **current height authority** — pre-activation, the `4-1` kernel include + earthworks; the `5-A` re-source swaps the sampler, not the clipmap. Toroidal strip updates on camera texel-crossings (compute #19 in the plan's inventory, <0.05 ms). The toroidal-addressing helper the Phase 2 weather map deferred to `5-10` gets written here, in this file, once.

**Gate:** assertion 100 — clipmap values equal the authority within R16F quantization at both levels; no seam across a toroidal wrap (GPU test); update cost within its booked row.

### `5-11` — Water-depth optics (4.5 d) · Class P

On both water materials, from the shared includes in `WaterShaders.ts` so ocean and rivers cannot drift (the 2-8a lesson): **Beer-Lambert** with real absorption (~0.45/0.07/0.02 m⁻¹ RGB — red dies 20× faster than blue, which is *why* deep water is blue), **analytic Snell-refracted bed shading** against the terrain surface's albedo (stable, no scene-colour copy), **single-scatter turbidity** (shallow water glows instead of being a dark bed behind a filter), and the **soft shoreline** `alpha = smoothstep(0, 0.4 m, depth)` with depth from the bathymetry clipmap. The ocean becomes depth-aware: near-shore pixels blend/alpha against the bed (the D5 substrate work — the material moves off hardcoded `alpha 1.0`; ordering vs rivers decided with `alphaIndex` now that something needs it). Below the surface: flipped normal, total-internal-reflection Fresnel (critical angle 48.6°, Snell's window), Beer-Lambert as fog. The heuristic inland absorption constants and fake bed colours are deleted in the same commit.

**Gate:** assertion 101 (coefficients pinned; shoreline smoothstep present; underwater branch compiles on-adapter in both materials); coast shots visibly show a shallow band (flown, captured); rebaseline #1 committed; frame cost within the water row.

---

## 9. Gate 5C — The uplift and the macro flood (13.5 d)

**Branch:** `phase5/gate-5c`. Everything in this gate is dark (D4) except the overlay.

### `5-8a` — Tectonic uplift (4.5 d) · Class K

In `TerrainKernel.ts` (WGSL include) + its TS mirror, behind the flag:

- **Plates:** Lloyd-relaxed cells at 200–500 km from the seed; per-plate motion vectors; uplift from convergent boundaries as **linear orogens** (5:1–20:1 aspect), rifts, hotspot tracks. The macro domain (524 km) spans a handful of cells — enough for one or two ranges and a coastline with structure, which is what a flight around the origin can see.
- **Fabric:** per-region structural direction from the local boundary orientation, blended as a **double-angle-encoded 2D vector** (the plan's own trap note: a scalar angle tears at the wraparound). The three `geology.ts` anisotropic channels consume it in place of the 35° constants; the rain-shadow shear (§3.12) re-aims from the same field.
- **Lithology → erodibility:** per-region K and repose fields, plus the uplift/detail partition of the existing kernel: provinces, `ridges`, `mountainHeight`, `foothillHeight`, `rolling`, `continentalShelf` survive as **uplift**; `fine`, `rockyKnolls`, `cragDetail`, `outcropLift`, ground/soil noise move to the **lithology/detail** field `5-7` extends (erosion acts on them rather than decorating its result); `valleyCarve`/`ravineCarve`/mean-removed talus are marked for deletion at `5-A` (§3.11).
- **Bathymetric profile:** shelf (−0 to −140 m) → slope → abyssal (−4,000 m) replacing the flat −105 m lerp, with `MIN_TERRAIN_HEIGHT` re-derived. `MAX_TERRAIN_HEIGHT` 4,500 is *staged* here but flips at `5-A` (nothing exceeds 2,200 until the flag flips).

**Gate:** golden tests on the mirror (orogen aspect ratios, fabric continuity across region boundaries — no angular tear); the band-limit assertions 23–25 re-proven against the uplift entry points; zero rendered-pixel change with the flag off (SSIM-exact capture check — the gate's own regression proof).

### `5-3` — Macro drainage (9.0 d, range 8–14) · Class K

`TerrainMacroEvolution.ts` + `TerrainErosionCompute.ts` (owner row goes live; marker removed). **The false-colour overlay lands first** — flow accumulation, lake mask, base levels, fabric, erodibility as `TerrainDebugOverlay` channels — before any parameter is tuned; this is non-optional (R2). Then §5.1's pipeline, eagerly at load, with the load-time budget measured and recorded. Tuning happens *here*, at macro scale, against the `5-8a` uplift — with the overlay, at 512 m/texel, iterations are seconds, not minutes.

**Gate:** assertions 87 (pit density < 0.1/km² at 50 m sampling within the domain — today: 8.5) and 88 (spill authority; every channel terminates at the sea, a lake outlet, or the rim); the load budget number recorded; overlay flown and captured.

---

## 10. Gate 5D — Page erosion and the activation (16.5 d)

**Branch:** `phase5/gate-5d`.

### `5-4` — Hierarchical page erosion (8.0 d, range 7–14) · Class K

§5.4's DAG, in `TerrainErosionCompute.ts`, admitted through `ComputeBudget`, inside the `generating` lifecycle state (its first real multi-frame exerciser — the `evicting → resident` cancellation and cancel-during-upload paths Phase 4's plan flagged as dormant get named tests here). Per page: seed from converged parent (`Z = bicubic(parentZ) + bandLimitedDetail(texelSize)`, `A = bicubic(parentA)·0.25`, receiver hints from parent flow), then bounded operators only — local pit-breach ≤ 16 texels (never the global fill), MFD, implicit stream power, talus — at fixed iteration counts inside the 384² scratch.

**Gate:** assertion 90 (seam: *bit equality* on the 4-texel overlap, adjacent pages, multiple seeds/levels); assertion 89 (evict/regenerate determinism); admission under the `erosionCompute` cap on synthetic burst traces (assertion 105); convergence rule proven (no mid-erosion slot ever sampled — a frame-graph ordering test).

### `5-8b` — Lithology-erodibility coupling (0.5 d) · Class K

The page kernel consumes `5-8a`'s K/repose fields; tuned alongside `5-4`'s parameters (soft rock → rolling hills, hard rock → cliffs).

### `5-6` — Runway erosion mask (1.0 d) · Class K

`K = 0`, `repose = 0` inside the apron+batter (from the platform SDF and `terrainBlendDistance`, whose "inward-only modulation" invariant is preserved), plus the perimeter drainage diversion — approach channels route around the field the way a real perimeter ditch does, instead of terminating at a wall. **Gate:** assertion 94's mask half (eroded page inside the apron equals the earthworks profile within 1 mm); influence-1.0 and crowned-collision assertions still green.

### `5-7` — Fine band (3.0 d) · Class K

24 m and 9 m ridged octaves in the **uplift/lithology** field (never the output height), masked by soil depth, curvature and fabric, band-limited per level by the existing `filterWidth` machinery. Most of the 8–43 m hole fills for free from talus facets and incision gullies; this supplies the rest. **Gate:** assertion 97's transect FFT (smooth power law to ~6 m) measured on L0 readbacks — today it cliffs at 43 m.

### `5-5` — Aux page channels + the TWI swap (2.5 d) · Class P

D8: the `payload.ts` reconciliation PR (one PR, per the channel rule), the channel-atlas bake of `flowAccum`/`lakeDepth`/`soilDepth`/`shoreDistance` (136², r16 family, season-invariant `variant 0`), and the classifier's wetness proxy swapped for real `ln((1+A)/(tan S + ε))` with its golden re-pin. **Gate:** channel round-trip quantization tests; cross-level consistency of the aux channels (level-N equals box-average of children within quantization — the assertion 85 pattern); classifier swap re-pinned.

### `5-A` — The activation (1.5 d) · Class P · **sanctioned rebaseline #2**

One commit: `worldEvolution: "eroded"` becomes the default; carve proxies deleted from kernel and mirror (assertion 95); `MAX_TERRAIN_HEIGHT` → 4,500; the bathymetry clipmap re-sources; inland ribbons disabled (D4's recorded interim); the world-churn inventory re-pinned (§3.13) — relief statistics, geology envelope (rewritten around the fabric field), and the **384-seed airport audit** re-run with site-selection thresholds re-tuned if needed (the gate's named risk, R-5C); three new capture shots **appended** (`dendritic-10000ft`, `carved-valley-500ft`, `lake-shore-800ft` — cameras chosen at the flown review); `runway-on-approach` re-pinned from three clean runs, absorbing §3.13's outstanding obligation; one rebaseline, on an idle machine.

**Gate:** assertions 96 (global 30–50° anisotropy < 1.3:1, locally anisotropic per range), 98 (valley:crest curvature ≥ 3:1 — today 1.18:1), 99 (rim continuity; 4,500 propagation); 93 in its final form (assertion 86 re-scoped, D14); every §1.3 assertion green on the eroded authority. **Demo state:** *"It looks like a landscape that something happened to."*

---

## 11. Gate 5E — Rivers and lakes from the graph (9.75 d)

**Branch:** `phase5/gate-5e`.

### `5-9` — Channel graph (2.0 d) · Class P

`src/render/webgpu/water/ChannelNetwork.ts` (owner row live, marker removed — the D10 re-point makes this legal). CPU extraction from the macro exports: threshold accumulation → thin → build confluence topology (nodes ordered downstream, junctions merge at the node — the vestigial `"confluence"` termination type finally gets a producer) → attach `5-1`'s exported hydraulic geometry and bank/thalweg elevations. Deterministic per seed; serialized for worker transfer. **Gate:** assertion 102 (A monotone downstream; widths from exports only; every channel terminates legally) over multiple seeds; the synthetic fixtures from `5-1` re-validated end-to-end.

### `5-12` — Carved rivers and lakes (7.0 d) · Class P

The mesh half of D6's "conservative cover + per-pixel trim": five-lane ribbons (feathered outer pair) over the exported wetted width, arc-length resampling, a proper Frenet frame so banks stay perpendicular through bends, per-vertex surface elevations from the graph (monotone by construction — the graph's, not a clamp's), confluences merged at junction nodes, deltas where the graph meets the sea; lakes as marching-squares polygons from the macro lake mask at the exported spill elevation (every vertex exactly at spill — assertion 103's bit check), ear-clipped with holes; lake-bed wetting from `lakeDepth` in the surface plugin (D15's one term). Earth-curvature term added to the hydrology vertex shader (§3.5's parity gap). **Deletes:** the tracer set, `maximumRiverGrade`, the width heuristics, `buildBasinLake`, and the count/radius caps (D7); the hydrology worker becomes the transfer-fed mesh builder; the pure-hydrology suite is rewritten around the graph (the +1.0 d). The planar-reflection lake re-point stays available and untouched (its receiver contract survives verbatim) — wiring a lake capture is *optional* stretch, zero days committed. Trunk rivers reach 100–300 m; the depth test plus `alphaIndex` (from `5-11`) orders water correctly.

**Gate:** assertion 103; region mesh budgets in the estimator; the hydrology suite green in its new form; flown captures of a trunk confluence and a delta.

### `5-13` — Riparian and channel exclusion (0.75 d) · Class P

D13: `densityField` consumes the channel exports — zero stems in wetted areas, riparian boost in the bank band; species weights untouched (that is `4-6`/`6-6` territory per R-27). **Gate:** assertion 104; scatter-spectrum suite green (the exclusion is a multiplicative field — no lattice).

---

## 12. Verification

### 12.1 Assertions Phase 5 adds (87–106; Phase 4 ends at 86; Gate B uses 67a–67f)

| # | Assertion | Where | Instrument |
|---|---|---|---|
| 87 | Macro pit density < 0.1/km² at 50 m sampling within the domain | `gpu/macro-drainage` | P6 |
| 88 | Every lake spill equals the flood's fill surface at its outlet; fine pages never create a lake | `gpu/macro-drainage` | P6 |
| 89 | Evict-and-regenerate yields bit-identical page content | `gpu/erosion-determinism` | P6 |
| 90 | Adjacent same-level pages bit-equal on the 4-texel overlap | `gpu/erosion-seams` | P6 |
| 91 | Sim-worker grid bytes equal atlas page bytes through the transfer | `gpu/collision-readback` | P6 |
| 92 | Catmull-Rom collision sampling is C1 (no kink above bound on synthetic ramps) | `sim.terrain-authority` | — |
| 93 | `analyticServed = 0` below 500 m AGL inside the domain, full flight profile (86 re-scoped) | `sim.flight` + harness | — |
| 94 | Apron: influence 1.0; collision = crowned profile ≤ 1 mm; eroded page = earthworks ≤ 1 mm | `sim.terrain-authority` | — |
| 95 | Carve proxies absent post-activation; no 0.819/0.574 rotation constants anywhere | `world.kernel` (string) | — |
| 96 | Gradient-orientation 30–50° band < 1.3:1 globally; ≥ 2:1 locally along each range | `world.evolution-stats` | — |
| 97 | 500 m transect FFT: smooth power law to ~6 m (today cliffs at 43 m) | `gpu/` readback | P6 |
| 98 | 20 m RMS curvature valley:crest ≥ 3:1 (today 1.18:1) | `world.evolution-stats` | — |
| 99 | Rim blend continuous; `MAX_TERRAIN_HEIGHT` 4,500 propagates through bounds tests | `world.test` | — |
| 100 | Bathymetry clipmap equals the authority within R16F quantization; no toroidal seam | `gpu/bathymetry` | P6 |
| 101 | Beer-Lambert coefficients + shoreline smoothstep pinned; underwater branch compiles | `gpu/water-optics` | P6 |
| 102 | Graph: A monotone downstream; hydraulics from exports only; legal terminations | `water.channel-network` | — |
| 103 | River surface between bed+minDepth and bank along every lane; lake vertices exactly at spill | `water.carved-geometry` | — |
| 104 | Zero authored stems in wetted areas; riparian boost present statistically | `render.webgpu-detail-*` | — |
| 105 | Erosion dispatches admitted only through `ComputeBudget`; caps hold on burst traces | `render.webgpu-compute-budget` | — |
| 106 | New memory rows move with their inputs; D3 table regenerated and legal at all tiers | `render.webgpu-budget` | — |

### 12.2 What cannot be asserted

Three outcomes are irreducibly visual — *the landscape reads as caused*, *rivers sit in their valleys*, *shorelines feather* — and get named flights with committed captures, per the Phase 4 pattern: (1) cruise at 10,000 ft over the domain, low sun — the dendritic/divide gate; (2) a valley-following run at 500 ft from headwater to delta; (3) a lake circuit at 800 ft, spill outlet in frame; (4) the coast shot before/after 5B. The per-pass GPU timer still does not exist (assertion 67 carried open through two phases now) — erosion cost enforcement rides `ComputeBudget`'s own accounting plus the whole-frame budget probe, and this plan does not pretend otherwise.

---

## 13. Risk register

| ID | Risk | Trigger | Response |
|---|---|---|---|
| **R-5A** | **Erosion tuning slips** (the programme's named largest risk; 2× budgeted). | Gates 5C/5D. | The ranges are in the ledger (8–14, 7–14). D3 (tune against final uplift, once) and the overlay-first rule are the structural mitigations; the macro scale makes iteration seconds-cheap. If 5D still slips, the cut line inside the phase is `5-7` (fine band — a missing feature, not a broken one) then `5-8b` (uniform K); never `5-6` (physics) or the DAG rules. |
| **R-5B** | **An operator violates the seam theorem** (propagation > halo). | `5-4`, assertion 90 red. | The theorem is arithmetic: fix the operator's reach or iteration count, never feather the seam — feathering hides the violation until a lake straddles it. The global fill stays macro-only, enforced by code shape (no fill kernel in the page path). |
| **R-5C** | **The 384-seed airport audit breaks under new terrain statistics** — site selection, not thresholds. | `5-A`. | Budgeted inside `5-A`; if re-tuning site selection exceeds a day, the recorded fallback is constraining spawn-airport candidate sites to low-relief macro cells (a *generation* rule, not a physics change), decided with Jason. |
| **R-5D** | **Silent analytic fallback in Node tests** hides a readback divergence. | Any time post-`5-2`. | §1.3.6's harness is a blocking `5-2` deliverable (assertion 91/93); `sim.flight`'s Node run is *recorded* as analytic-authority, so nobody mistakes it for coverage. |
| **R-5E** | **The activation commit is a mega-merge in disguise.** | `5-A`. | It is a flag flip plus deletions plus re-pins — all content landed dark and tested in prior gates. Rehearse the rebaseline on a throwaway branch in week 10; `VITE_PERF_SHOTS` partial runs can never rewrite baselines (harness rule). |
| **R-5F** | **Cross-device non-determinism** of GPU erosion. | Latent. | Same-device determinism is asserted (89); cross-device identity is explicitly *not* promised — recorded from R10. If replay/shared-seed features ever land, the mirror becomes the transmitted authority. |
| **R-5G** | **Water-optics rework destabilizes the committed ocean look** beyond intent. | Gate 5B. | The changes ride `WaterShaders.ts` includes with the 2-8a hash-gate flow: deliberate change, re-pinned hash, one rebaseline. Crest SSS/foam/sun-lobe code paths untouched. |
| **R-5H** | **The dry-valleys interim (5-A → 5-12) is judged a worse sim.** | Review at `5-A`. | Recorded interim (D4) with the named fallback: a macro-sampler stopgap feeding the old tracer (~0.5 d) — approximate rivers in the right valleys, clipping accepted, deleted at `5-12`. |
| **R-5I** | **Memory closes on paper, not on the machine** (new rows + Phase 4's 444/480 at Balanced). | `5-0`, `5-10`, `5-A`. | The D3-table regeneration in `5-0` is the evidence; the standing fallback (tier-1 MSAA 4→2, −39.5 MiB) is named; `perf:capture` reports estimated vs inventoried every run. |
| **R-5J** | **Load-time regression** from the eager macro flood. | `5-3`. | Budget ≤ 1.5 s, measured and recorded; it overlaps the existing staged startup (material synthesis already paces itself from the frame loop). If over, slice the flood through `ComputeBudget` behind the load screen — never ship a longer black screen silently. |

---

## 14. Exit checklist

**Gate 5A** — Contract types land with tests; `owners.ts` markers re-pointed; D3 table regenerated, legal at all tiers. Readback authority live against analytic pages; assertions 91–93 green; runway fast path bit-untouched (63/64 green); headless parity harness in `tests/gpu/` and green.

**Gate 5B** — Bathymetry clipmap live at both levels (100); Beer-Lambert/shoreline/underwater shipped from shared includes on both materials (101); heuristic depth constants deleted; rebaseline #1 committed; coast flight captured.

**Gate 5C** — Overlay shows flow, lakes, fabric, erodibility; macro flood converges at load within the recorded budget; 87/88 green; zero rendered-pixel change with the flag off (SSIM-exact); band-limit assertions re-proven on uplift entry points.

**Gate 5D** — Seam bit-equality (90) and regeneration determinism (89) green across seeds and levels; convergence rule proven; runway mask holds (94); fine-band FFT (97) green; aux channels cross-level consistent; TWI swap re-pinned. **Activation:** one commit, one rebaseline; 93/95/96/98/99 green; 384-seed audit green (re-tune recorded if any); three shots appended; `runway-on-approach` re-pinned from three runs; dry-valleys interim recorded.

**Gate 5E** — Graph legal on multiple seeds (102); carve/render agreement (103); tracer set and caps deleted; hydrology suite rewritten and green; riparian exclusion (104); no tree in any river (flown); confluence and delta captured.

**Phase** — Audit root causes #2, #8, #9 closed (twelve of twelve). Every `RENDERING_PLAN.md` Phase 5 exit criterion green in its amended form. `npm run verify` and `npm run test:gpu` green. Exactly two sanctioned rebaselines (5B, 5-A) plus Gate B's one. Decision log complete. `RENDERING_PLAN.md` §5.3 erosion rows struck; ledger updated.

### 14.1 Phase 5 implementation record — 2026-08-20

**Status: implementation candidate; acceptance open.** The tree now contains an
operative eroded-world path from startup macro generation through atlas pages,
simulation publication, channel extraction, bathymetry, inland-water geometry,
water optics and riparian response. That statement records code ownership and
runtime wiring only. It does not tick Gate 5A–5E or the phase exit above.

| Area | Implemented candidate | Reconciliation with this plan |
|---|---|---|
| `5-0`/`5-1` contract | `TerrainEvolutionContract.ts` owns the 1024² × 512 m cell-centred macro layout, open rim, 16-texel analytic blend, authority ladder, transferable macro/page/graph/lake exports and one physical hydraulic law. `worldEvolution` is world content and has no tier input. | Matches D2/D9/D11. The performance estimator reserves the target GPU macro/scratch/graph layouts, but those rows are conservative final-layout headroom rather than measured live GPU inventory in the current CPU reference. |
| `5-3` macro evolution | `TerrainMacroEvolutionClient` samples the full analytic uplift/lithology authority in a dedicated Worker, runs the deterministic open-rim fill/MFD/stream-power/talus reference, transfers the canonical arrays, and exposes progress/state/disposal. `TerrainEvolutionRuntime` extracts `ChannelNetwork`, retains a safe simulation macro grid and publishes that grid once. | **Material deviation:** this is a CPU-worker reference, not the planned production GPU macro pass. A local production-shape CPU benchmark on seed `phase5-production-benchmark` measured uplift+K/repose sampling **3,174 ms**, evolution **4,323 ms**, total **7,497 ms**, with 15,068 lakes and 18,441 channel seeds. That is non-vacuous local reference evidence, not reference-machine/GPU acceptance; it misses Gate 5C/R-5J's 1.5 s target. The final GPU producer should replace it behind the client/result boundary. |
| Evolution debug surface | `TerrainDebugOverlay` now previews macro flow accumulation, lake mask, drainage base levels, double-angle fabric and erodibility from the live canonical result. | The required debugging surface exists. No flown/captured overlay review or tuning evidence is recorded here, so the visual half of Gate 5C remains open. |
| `5-4`/`5-6` page evolution | `TerrainErosionCompute`, `TerrainPageErosion`, the client/protocol/Worker and `TerrainPageAtlas` implement a deterministic 64-texel-halo page pass with bounded 16-texel pit breach, fixed MFD/stream-power/talus counts, full runway-earthworks erosion exclusion, exact stored overlap, final atlas upload and L0 collision publication. `generateTerrainErodedPage` also supplies deterministic, strictly-downhill, acyclic receiver overrides that divert drainage around the earthworks perimeter. | **Material deviations:** production is the CPU-worker reference; exactly **one page is in flight** so stale flight-path work cannot fill the queue. Pages seed height and accumulation directly from the canonical macro plus band-limited fine detail, **not** from a resident-parent convergence chain. The production runway mask and perimeter-drain policy are live and focused tests cover legality; the multi-frame GPU DAG, parent-chain proof and measured per-page cost remain open. |
| `5-2` height authority | `terrainAuthority.ts`, simulation protocol/client plumbing and the renderer publisher implement the worker-side complete-stencil L0 Catmull-Rom ring, cell-centred macro fallback, analytic recovery, split counters, one-shot macro transfer and completed-L0 page transfer. `TerrainConsumerAuthority.ts` adapts the same ladder to rich height/normal/slope samples used by detail and wildlife while retaining analytic climate/material fields. | Implements the live L0 → macro → analytic ladder for physics and ecology consumers. The old render-side collision proxy is no longer the fallback counter; diagnostics read the simulation worker's authority counters. Final on-adapter parity/flight acceptance remains governed by the exit checklist. |
| `5-5` aux fields | `TerrainPageHydrology` derives flow accumulation, lake depth, soil depth and signed shore distance before erosion scratch disposal. The erosion transfer carries them; four heterogeneous atlas resources upload and become resident atomically with the page, then the committed aux page is published to `TerrainConsumerAuthority`. Flow/TWI feeds the live splat classifier and signed shore distance feeds the riparian density path; lake/soil remain resident and exposed through atlas accessors. | The producer, transfer, atomic upload and post-residency publication contract is live. Lake depth and soil depth have no later shader consumer yet; their residency is not evidence that Phase-6 water/ecology consumers shipped. |
| `5-8a`/`5-7`/`5-A` terrain activation | The default world is `"eroded"`; the uplift authority adds seeded broad range/convergence structure, rotating double-angle fabric, lithology/erodibility/repose fields, 24 m and 9 m fine bands, a shelf/slope/−4,000 m abyssal profile and ±4,500 m declared bounds. The eroded uplift omits the historical faux-carve terms. | **Material deviations:** this is not the planned Lloyd-relaxed 200–500 km plate model: it has no per-plate motion boundaries, rifts or hotspot tracks. Fine bands are fabric/lithology/local-rock masked before erosion, not post-erosion soil-depth-and-curvature masked. **Compatibility deviation:** explicit `"analytic"` worlds keep the historical kernel bit-compatible, including valley/ravine/talus proxies and fixed rain-shadow shear. The 384-seed audit, new capture shots and activation rebaseline are not claimed here. |
| `5-9`/`5-12` inland water | `ChannelNetwork` deterministically extracts a monotone graph with exported hydraulics from the canonical macro result. Eroded `HydrologySystem` builds and retains graph geometry without entering legacy paging. Riparian/channel exclusion is present in the vegetation density path. | **Material deviations:** the current reference builds one retained world mesh; river cover follows the graph segments directly rather than the planned arc-length resampling/delta expansion, and lake components use a conservative convex boundary plus centre-fan triangulation rather than marching squares, Douglas-Peucker and ear clipping with holes. Depth-driven shoreline trimming keeps the conservative cover safe, but those are not geometry-completion evidence. **Compatibility deviation:** the historical tracer/generator remains public and live only for explicit analytic worlds; eroded worlds do not call it. Graph legality and conversion have focused tests, but confluence/delta flights, no-tree-in-river flown evidence and the planned full tracer deletion are not claimed. |
| `5-10`/`5-11` water depth | `BathymetryClipmap` owns two toroidal 1024² R16F levels (16 and 128 m/texel), uploads macro height to a read-only GPU buffer, and uses the shared depth substrate in both ocean and inland-water shaders for Beer-Lambert volume colour, shoreline alpha, underwater response and air-to-water refracted bed coordinates. | **Material deviations:** eroded bathymetry currently samples/blends the canonical **macro** authority at cell centres; it does not overlay resident L0 page erosion. The refracted bed albedo is a deterministic analytic mineral proxy rather than the terrain material arrays. Analytic height mode remains exact. Coast/lake visual review, timings and the sanctioned water rebaseline remain open. |

**Verification and acceptance evidence.** On this final candidate tree,
`npm run verify` is green: ESLint reports zero errors (one existing unused-
constant warning), TypeScript passes, all **92** Node test files pass with
**700 passed / 1 skipped**, and the production build completes. The complete
Chromium WebGPU project is also green via `npm run test:gpu`: **28 files / 50
tests**. The run fixed and now pins the Phase-5 final-publication boundary in
the direct splat/occlusion fixtures and keeps the Phase-4 cold-streaming
fixture explicitly analytic; it converged to 319/320 nodes at L2 with 36
resident pages.

The performance capture, either sanctioned Phase-5 rebaseline, the appended
dendritic/valley/lake shots, the named coast/confluence/delta flights and the
three-run runway re-pin remain unperformed. The 7,497 ms value above is the
only recorded production-shape startup timing and is explicitly a local
CPU-reference measurement that fails the planned load target; no Phase-5
per-page, reference-GPU or steady-frame timing has been inferred from declared
iteration counts or budget seeds. Those are the remaining gate evidence, not
documentation polish.

**Branch hand-off.** The requested local
`jazonshou/Phase-3.5-Implementation` branch was created at the prerequisite-
complete Phase-4.5 base and now carries this Phase-5 working tree. Its remote
counterpart was a strict ancestor with no divergent commits (15 commits behind
the prerequisite base), so no history rewrite or conflict resolution was
needed. The local branch tracks that remote; no commit or push is represented
by this record.

---

## 15. Gate B — The felt frame (7.25 d) · runs before Gate A and Phase 4

Not Phase 5 work — scheduled first, created by this plan from the 2026-08-19 flight-test reports, evidenced in §3.14/§3.15. G-C is the goal it serves; every item is independent of the terrain chain.

| ID | Item | Days | What and why |
|---|---|---|---|
| **B-0** | `frame-attribution` | 0.5 | §3.14's reconciliation gap: 33–46 ms frames vs 12+7 ms of counters. Attribute present-to-present time (CPU busy / GPU counter / present-wait) before touching anything, so B-2's projected win is checked against the real bottleneck, not asserted. Output: a recorded number and, if needed, one new diagnostics field. |
| **B-1** | `presentation-timing` | 2.0 | Fix the shaking's mechanism, not its symptoms: anchor the interpolation timeline to **snapshot sim-time** with a worker-clock offset estimator (EMA of arrival − simTime) instead of raw arrival re-anchoring; add **bounded extrapolation** (≤ 50 ms, from snapshot velocity/turn rates — extend `FlightVisualState` with angular velocity if absent) so heavy frames coast instead of snapping; smooth the chase camera's **target and up-vector** with the same exponential response its position already uses (cockpit stays exact; `cameraCut` on rebase kept). Assertions **67a** (monotone sampled sim-time under jittered synthetic arrival streams; bounded extrapolation error) and **67b** (camera target frame-to-frame delta bounded at fixed sim state) — `SimulationClient` is pure enough to unit-test. |
| **B-4** | `rebase-stale-chunks` | 0.75 | Write the failing test first for §3.14's latent bug (simulated rebase → assert every live batch's rendered origin matches the current floating origin). If confirmed, the cheap correct fix: each batch keeps the origin it was built against and compensates via `mesh.position = builtOrigin − currentOrigin` (a uniform, not a rebuild), letting the amortized sweep proceed at leisure. Assertion **67d**. If refuted, the test stays as the regression guard and the finding is corrected in this file. |
| **B-2** | `vegetation-draw-merge` | 2.5 | The priced structural fix (§3.14): crown + trunk as one prototype/mesh per (species, variant, band), radial aspect resolved per-instance — 347 → 186 draws, 9.0 → 4.8 ms at tier 1 at identical fidelity. **Go/no-go is measured, not assumed** ([`renderedDensity.ts`](src/render/webgpu/detail/renderedDensity.ts) says exactly this): the R-2E risk is trunks leaving the opaque bucket that pre-fills depth. Accept if the five sub-30 shots improve ≥ 2 ms GPU each and none regresses; on rejection, record the measurement and revert (the branch-per-gate rule makes this cheap). Re-pin `VEGETATION_DRAW_CEILING`/`VEGETATION_FRAME_DEBT_RATIO`; assertion **67c**. |
| **B-3** | `forest-pattern-variance` | 1.5 | §3.15, and the user's words ("forests are good, but there should be variance"): glade floor 0.3 → **0.02** with a sharpened band so openings actually open (authored density must fall *below* the ~78/ha render cap to read as ground — the constraint no plan stated); disturbance amplitude 0.85 → 1.0 plus one **hard-edged** class (windthrow/burn/cut — some forest edges are genuinely hard); a new multi-km `forestFraction` gate field in `densityField.ts` (the only legal import site per the boundary test) so whole valleys can be meadow while others are unbroken forest; the forest-edge margin term (shorter, bushier stems where closure gradient is high). Net authored stems **fall**. Species/stand selection untouched (R-27 owns it at `4-6`). Re-pins: the scatter fixture's 300–800/ha window, canopy-closure window selection, spectral bounds (assertions **67e/67f**). Draw-call honesty: this is argued on looks and the §5.3 trade-off rule, *not* performance — draws scale with chunks × meshes, so meadows save memory and generation, not milliseconds. |

**Order:** B-0 → B-1 → B-4 → B-2 → B-3. **One sanctioned vegetation-look rebaseline** at gate close (B-2 + B-3 change pixels together). **Exit:** 67a–67f green; the banked-turn temporal metric holds or improves; the five sub-30 shots' measured deltas recorded against B-0's attribution; a flown before/after of the shaking at tier 1. **Honesty clause:** Gate B does not close G-C — 22–29 fps near the ground needs Phase 4's terrain spine and Phase 6's vegetation work; it removes the two *mechanisms* the user can feel that no phase owned, takes the one priced structural draw win, and makes every later measurement clean.

### 15.1 Gate B implementation record — 2026-08-19

Gate B is implemented on the Phase 3.5 implementation branch, with B-2
**measured and rejected** under its own conditional rule. The accepted runtime
therefore contains B-0, B-1, B-3 and B-4; it deliberately retains split opaque
trunks and the pre-gate draw/debt ceilings.

- **B-0 / attribution.** The committed pre-tuning report's nine sub-30 shots
  pace at 34.4–45.5 ms from sustained fps, while CPU p95 is 5.3–7.4 ms and GPU
  p95 is 11.8–20.45 ms. Treating CPU and GPU as overlapping leaves a coarse
  **17.3–33.6 ms pacing/uncaptured envelope** (`interval − max(cpu,gpu)`), not
  evidence that their durations should be added. The implementation adds the
  actual start-to-start interval p95 to diagnostics/HUD/capture. CPU work is
  paired with the interval that ends at the following frame start. Babylon's
  asynchronous WebGPU counter exposes no submitted frame id, so it remains an
  independent aggregate and `presentWait` stays `null`; the code does not
  fabricate a per-frame or p95 present timer by subtracting unrelated samples.
- **B-1 / presentation.** `SimulationClient` estimates `arrival − simTime`
  with a 0.1 EMA, presents one snapshot interval behind, never samples time
  backwards, resets the estimator on worker-clock restart, and coasts for at
  most 50 ms using velocity plus the simulation's body-rate quaternion
  convention. `angularVelocity` already existed end-to-end, so the planned
  protocol extension was unnecessary. Exterior camera position, target, up
  and FOV now share one exponential response; cockpit remains exact and cuts
  snap. Assertions 67a/67b cover jitter, duplicate snapshots, the coast bound,
  target and up-vector deltas.
- **B-4 / rebases.** The latent finding was confirmed. Every live batch keeps
  its build origin and immediately receives `builtOrigin − currentOrigin` as
  its mesh translation while the one-chunk rebuild sweep catches up. The plan's
  mesh-only recipe was insufficient: band culling and impostor facing run in
  the vertex plugin before Babylon applies the mesh world transform, so a
  per-submesh `detailMeshOffset` uniform mirrors the same translation there.
  Assertion 67d checks every live batch immediately and after rebuild; a real
  WebGPU test renders a non-zero 2,048 m rebase with stale batches carrying
  distinct offsets through one shared material.
- **B-3 / forest variance.** The density owner now combines a multi-kilometre
  7.2 × 5.4 km province gate, a sharpened 260 m glade field with a 0.02 floor,
  full-amplitude 1.4 km succession and a thresholded 3.6 × 1.7 km windthrow
  class. Transition bands publish `forestEdge`; generation shortens stems by
  up to 34% and widens crowns by up to 48% there. Species and stand selection
  are untouched. Deterministic closed-forest fixture selection replaces the
  old assumption that world zero is forest; the 300–800 stems/ha, canopy
  closure and spectral assertions remain strict. Assertions 67e/67f prove
  multi-kilometre meadow/forest extremes, below-render-cap openings, a hard
  boundary, shorter/bushier margins and lower broad-domain mean stems.

**B-2 result (67c).** The merged prototype compiled and rendered correctly,
preserved packed trunk ratio/phase endpoints, bark BRDF/season semantics and
CSM casting, and reduced the expected draw/batch counts. It nevertheless moved
trunks out of the opaque depth pre-fill and failed the measured gate. Values
below are `committed GPU p95 − merged GPU p95`, so negative is a regression:

| Shot | GPU improvement (ms) |
|---|---:|
| `approach-500ft` | -1.725 |
| `reference-viewport` | -2.087 |
| `winter-noon` | -1.013 |
| `night` | -0.784 |
| `motion-banked-turn` | -1.169 |
| `forest-500ft-sunbehind` | -1.467 |
| `ground-2m-lowsun` | +0.858 |
| `canopy-1200ft` | -1.163 |
| `runway-on-approach` | +3.837 |

All five core shots regressed; only one of all nine cleared +2 ms. The merge,
its packed instance semantics and its re-pinned ceilings were reverted. 67c is
the green **conditional-decision** guard: it preserves the split runtime and
records why the attractive 347 → 186 draw model was not accepted.

**Recorded deviations and close evidence.**

1. §3.14 and the committed report say nine shots are sub-30, while the B-2 and
   exit prose says five. The implementation applies the rule to the named five
   core shots and reports all nine; this is stricter and avoids silently
   excluding the four later near-ground captures.
2. B-2/B-3 implementation work overlapped before the isolated Gate A-free
   capture instead of landing serially. Because B-3 remains in the measured
   image, rejection is conservative; no claimed B-2 win is inferred from the
   model. The accepted state is B-3 plus the original split materials.
3. The accepted-state sanctioned capture completed all 14 scenes and rewrote
   the intended forest pixels. On this host, back-to-back eight-minute WebGPU
   runs degraded even one-batch high-altitude shots (about 5.2 → 8.9 ms GPU)
   and failed the unchanged approach fps floor. No floor was re-pinned. The
   B-0 fields made the failure explicit: interval p95 reached 23.8–70.9 ms,
   CPU p95 stayed 3.8–7.3 ms, and the uncorrelated present residual correctly
   remained unavailable. Final gate verification records that host result
   rather than converting it into an accepted budget.
4. The banked-turn accepted-state capture improved temporal structure from
   min/mean consecutive SSIM 0.7530/0.7605 to 0.8301/0.8406. Maximum mean-luma
   delta moved 0.00157 → 0.00178, still far inside the committed 0.01 ceiling.
   The synthetic jitter/camera tests and this scripted flown turn are the
   repeatable before/after for the reported shaking; no claim is made that
   Gate B closes the remaining near-ground frame-rate debt.

---

## 16. Decision log

| Date | Item | Decision | Measurement / rationale |
|---|---|---|---|
| 2026-08-19 | D2 | Macro domain: 1024² × 512 m, world-anchored, open rim; "endless" qualified to ~262 km of eroded world | A lake's spill must never depend on flight path; re-anchoring windows change base levels mid-flight. *Record the measured load-time cost at `5-3`.* |
| 2026-08-19 | D3 | Uplift before flood; erosion tuned once, against its final input | Tuning erosion twice is R2 doubled; `5-8a` changes zero pixels behind the flag |
| 2026-08-19 | D4 | One activation commit; all shape work dark behind `worldEvolution` | R10's single churn without a mega-merge; the overlay is the dev surface |
| 2026-08-19 | D4 | Inland ribbons disabled between `5-A` and `5-12` (recorded interim) | The tracer samples the analytic kernel, which post-activation is not the ground; floating/clipping ribbons are worse than dry valleys. Fallback named (R-5H). |
| 2026-08-19 | D11 | Erosion output is tier-invariant; §5.3 scope rows struck | Same rule that struck Ultra's 1 m L0: the collision surface may not be a function of a graphics setting |
| 2026-08-19 | D5 | Water optics precede erosion; two sanctioned rebaselines this phase + one in Gate B | Bed = terrain field under any authority; an early visible payoff beats a 8-week dark stretch |
| 2026-08-19 | D6 | Water meshes are conservative covers; the pixel-exact shoreline is `5-11`'s depth alpha | Removes fine-page residency from `5-12`'s critical path |
| 2026-08-19 | D7 | Lake caps replaced by minimum meshed area + region mesh budget; spills are never tunables | The realignment's pre-`5-1` demand, answered |
| 2026-08-19 | D9 | Authority ladder: readback → macro → analytic; counters split; counting site is the sim worker | Post-activation the analytic kernel no longer resembles the world at any altitude |
| 2026-08-19 | §3.14 | Gate B created from flight-test reports; runs first | The report is the committed baseline (9/14 shots < 30 fps); the shaking has a named mechanism no phase owned |
| 2026-08-19 | B-2 | Crown/trunk merge behind a measured go/no-go | The perf-debt pass priced it and left it *because* the R-2E trade must be measured; Gate B measures it |
| 2026-08-19 | §3.15 | Openings require authored density below the render cap; glade floor → 0.02 | Measured: floored glades author 240/ha against a 78/ha cap — invisible from the air by arithmetic |
| 2026-08-19 | B-0 close | GPU timestamps stay an independent aggregate; present residual is null without a correlatable frame id | CPU/interval pairs are aligned, but Babylon's async counter does not identify the submitted frame. Subtracting marginal p95s would manufacture a number. The new interval-p95 field exposes the real pacing gap. |
| 2026-08-19 | B-2 close | **Merge rejected and reverted; split opaque trunks remain live** | All five core sub-30 shots regressed 0.78–2.09 ms GPU; only one of all nine exceeded +2 ms. The conditional experiment completed successfully by refusing a failed optimisation. |
| 2026-08-19 | B-3 close | Forest provinces use 7.2 × 5.4 km gate scales; windthrow is the hard-edge class; edge morphology is density-owned | Pure deterministic fields preserve the future WGSL boundary and leave R-27 species/stand ownership untouched. |
| 2026-08-20 | `5-3` implementation | CPU-worker macro evolution is the current correctness reference; the canonical client/result boundary is the replacement seam for the final GPU pass | Keeps the 1024² uplift sampling and global evolution off the main thread. A local production-shape run measured 7,497 ms total and misses the 1.5 s target; it is reference evidence for the CPU implementation, not final-GPU/reference-machine acceptance. |
| 2026-08-20 | `5-4` implementation | Admit one CPU-worker page at a time and seed every page directly from canonical macro height/accumulation plus band-limited detail | Prevents stale flight-path queue growth and removes resident-parent arrival order from deterministic output. This deviates from the planned parent chain and does not close the future multi-frame GPU DAG. |
| 2026-08-20 | `5-10` implementation | Eroded bathymetry samples the cell-centred macro authority with the 16-texel rim blend; analytic worlds ignore it | A single read-only macro upload preserves deterministic toroidal strips. Resident L0 overlay remains a named refinement; no consumer may invent a separate height authority. |
| 2026-08-20 | `5-A` compatibility | Keep historical carve proxies, rain-shadow shear and tracer for explicit analytic worlds; exclude them from eroded uplift/runtime | `worldEvolution: "analytic"` is a real compatibility promise. Eroded worlds use the canonical graph and never retrace the historical kernel. |
| 2026-08-20 | Performance reservation | Keep target-GPU macro/scratch/channel-graph memory reserved while the CPU-worker reference is live | Prevents later work consuming the final producer's headroom twice. These declared rows are not measured live GPU inventory or timing evidence. |
| — | `5-1` | Minimum meshed lake area (proposed 0.04 km²) | *pin from the first flown lake review* |
| — | `5-3` | Whether `4-7`'s pyramid merges into the macro grid | *decide on measured occlusion-bake quality against the eroded macro* |
| — | `5-A` | Airport site-selection re-tune contents | *record what the 384-seed audit needed* |

---

## Appendix A — File manifest

**Original planned manifest (7 groups):** `terrain/TerrainEvolutionContract.ts` (5-0) · `terrain/TerrainMacroEvolution.ts` (5-3) · `terrain/TerrainErosionCompute.ts` (5-3/5-4; owner row exists, marker re-pointed by 5-0) · `water/BathymetryClipmap.ts` (5-10) · `water/ChannelNetwork.ts` (5-9; owner row exists, marker re-pointed) · `sim` worker page-ring module (5-2, inside `src/workers/`) · `tests/gpu/` erosion/parity/bathymetry suites.

**Actual implementation additions (2026-08-20):** the three planned terrain
owners plus `terrain/TerrainMacroEvolutionClient.ts`,
`terrain/TerrainEvolutionRuntime.ts`, `terrain/TerrainPageErosion.ts`,
`terrain/TerrainPageErosionClient.ts` and `terrain/TerrainPageHydrology.ts`;
both planned water owners; `workers/terrainAuthority.ts`,
`workers/terrainErosionProtocol.ts`, `workers/terrainErosion.worker.ts`,
`workers/terrainMacroEvolutionProtocol.ts`,
`workers/terrainMacroEvolutionRuntime.ts` and
`workers/terrainMacroEvolution.worker.ts`; and focused Node suites for the
evolution contract/algorithms/runtime/client/page path, authority ladder,
uplift, channel network, riparian density and water depth. The split is the
runtime boundary required by the CPU-worker reference deviation, not a second
evolution authority.

**Substantially modified:** `sim/terrainGrid.ts` (the promised one-file physics swap) · `workers/protocol.ts` + `workers/simulation.worker.ts` (5-2) · `world/payload.ts` (5-5, one channel PR) · `world/terrain.ts` + `world/geology.ts` + `terrain/TerrainKernel.ts` (5-8a/5-7/5-A) · `water/HydrologyGeneration.ts` → graph mesh-builder + `water/HydrologySystem.ts` + `water/WaterShaders.ts` + `water/SpectralOceanSystem.ts` (5-11/5-12) · `detail/densityField.ts` (B-3, 5-13) · `game/SimulationClient.ts` + `render/FlightRenderer.ts` (B-1) · `detail/WorldDetailRuntime.ts` + `detail/prototypeGeometry` family (B-2, B-4).

**Original deletion target, reconciled:** the eroded uplift no longer includes
`valleyCarve`/`ravineCarve`/mean-removed talus or the fixed 35° fabric, and the
eroded hydrology runtime no longer calls `traceDownhillPath`, source candidates,
trace smoothing, heuristic widths or basin-lake construction. Those historical
definitions remain for explicit analytic compatibility. The shared water-depth
include replaces heuristic absorption/bed constants on the active materials.

## Appendix B — Audit-root-cause acceptance target after Phase 5

| # | Root cause | Required status at Phase-5 close |
|---|---|---|
| 2 | Pointwise analytic height → erosion impossible | **Closed** — `5-3`/`5-4`; the kernel is the uplift input |
| 8 | No geometry below 43 m | **Closed** — `5-7` + talus/incision |
| 9 | No macro-geology; global 35° fabric | **Closed** — `5-8a`; both hard-coded grains replaced |
| 1, 3–7, 10–12 | | Closed in Phases 1–4 |

**This is the acceptance target, not the current evidence statement.** §14.1's
implementation candidate supplies the mechanisms, but the missing GPU,
performance and visual gates prevent claiming twelve of twelve today. Once the
phase closes, what remains is Phase 6 (water in motion, ecology channels, honest
tiers — where the vegetation frame row finally closes via `6-8`/`6-9`) and
Phase 7 (night operations and airfield identity). Against the user's goals:
**G-A** gains its last missing element — terrain *shape* and water *placement*;
**G-B** is unchanged (erosion is deliberately season-invariant); **G-C** gains
clean instruments while the full frame-rate close stays measured rather than
hoped.
