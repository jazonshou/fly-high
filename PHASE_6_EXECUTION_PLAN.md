# Phase 6 Execution Plan — the eroded world, water in motion, ecology, final tiers

**Created:** 2026-08-30. **Branch:** `jazonshou/Phase-6-Implementation` (off `a272d83`).
**Verified against:** merge `a272d83` (post trees-overhaul waves V/T/G/P/Q/R + governor
freeze `3fa0839` + CI determinism `8ec1c45`). Every file:line below was re-checked at
this commit — do **not** trust `PHASE_6_PREPLANNING.md`'s line numbers; nearly every
water and vegetation citation in it moved after `6a5b29e`. This draft was itself
adversarially reviewed (4-lens refutation panel, 2026-08-30); its findings are folded in.
**Binding order:** `ARCHITECTURE.md` decision log (normative) → `RESOLUTION_PLAN.md` →
this plan → `RENDERING_PLAN.md` §Phase 6 / §5.3. Deviations land in §11 here plus the
decision log, per house rule.

---

## 0. Standing decisions (recorded 2026-08-30, Jason's answers to PHASE_6_PREPLANNING §4)

| Q | Decision | Consequence |
|---|---|---|
| **Q1+Q2** | **Eroded-first.** The GPU-erosion workstream precedes Phase 6's items. Features land on real substrates (channel graphs, lakeDepth/soilDepth, eroded bathymetry) and stay dark in the shipping analytic default until the workstream re-earns the eroded default. | Gate W (§4) plans and prices the workstream now — this satisfies `PHASE_5_EXECUTION_PLAN.md` §14.2(d)'s "price it when it is planned" (a fresh price, no carried number). The analytic default **stays shipping** the whole phase; re-defaulting is a gated decision (§8), never a side effect. This does not contradict `RESOLUTION_PLAN.md`'s ship-on-analytic decision — that plan itself deferred the GPU port to "a separate later workstream", which is now scheduled. |
| **Q3** | 6-1's capillary half is **done** — answered differently by fix-pack W1–W3, then extended by wave R (4 octaves, roughness-as-field, physical Hs). | 6-1 re-prices to flow-advection + standing waves + lake chop only. The 5th/6th-cascade question is **dropped**: every 5-slot uniform family gained a mesh-Nyquist sibling in wave R, so a sixth cascade is dearer than ever, and the fragment-side pattern is proven. |
| **Q4** | 6-5 is a **water-side field item**. The shader response is live and verbatim ([TerrainSurfacePlugin.ts:1964-1965](src/render/webgpu/terrain/TerrainSurfacePlugin.ts)); `setWetness` has zero callers; the 5-12/D15 lakeDepth head start **does not exist** (`git log -S lakeDepth` — never entered the plugin or water systems). | 6-5 re-priced at 2.0 d including the never-wired lake-bed term and the aux-plumbing work. |
| **Q5** | **Full 6-11**: four-tier × three-viewport delivery sweep plus cold-start deadlines. | §7. Cold start is measured for the analytic default (acceptance) *and* the eroded path (Gate W exit input). |
| **Q6** | **C-8 flies first.** The three named Phase 5 flights run against today's CPU-eroded world *before* implementation starts. | Gate F (§3). Findings feed Gate W's targets — the GPU port must not freeze a landscape nobody has approved. |
| **Q7** | **QR-1 settles inside 6-11** (vegetation shadow tier rows decided from the sweep's measured headroom). QR-2 lands with 6-8. | §6, §7. |

Also recorded: **6-10 is not in this phase** (shipped as 4-0b, `ComputeBudget.ts`);
QR-3 (ocean shore foam) is **substantially discharged** by wave R fix 6
([SpectralOceanSystem.ts:678-692](src/render/webgpu/water/SpectralOceanSystem.ts)) — only
run-up/streaking/wet-sand remain, in 6-2. **6-6's "shelter" channel is re-scoped away
with reason** (§6). The four wave-R decision-log open items are each routed: lake/river
geometry → W-5, horizon-shadow term → 6-8, DryGrass sward retune → Wave 2, planar shore
reflection → declined (§5 watch-list).

---

## 1. The non-regression contract

The user goal this phase must not damage: tier 1 today delivers **min 113.4 wall fps,
worst p95 10.2 ms, zero hitches over 24 shots** (2026-08-28 reference-host run, post
governor freeze), with SSIM ≥ per-shot floors against committed baselines.

**Honesty first: today's gates do not protect today's numbers.** The strict tier-1
contract floors are 60 fps / p95 16.67 ms
([scripts/perf-capture.mts:44-48](scripts/perf-capture.mts)); the 16 legacy per-shot
`minFps` ceilings (19–57) were pinned 2026-08-18, three representation generations ago;
and the 8 newest shots — **including both water shots** — carry `ceilings: null`. As
the gates stand, the phase could shed ~45% of current delivery, wave by wave, with
everything green. Delivery gates are also enforced **only on the local pinned reference
host** — both CI capture jobs set `VITE_PERF_UNPINNED_HOST=1` and *report* delivery
rather than gate it. Gate 0 (§3) closes both holes before any phase work starts. The
rules, after Gate 0:

1. **Re-pinned per-shot delivery floors, all 24 shots.** Gate 0 pins per-shot
   wall-fps/p95/hitch floors from three clean idle-host runs at today's levels minus a
   ~15% thermal-drift margin (the `PerfCaptureShotCeilings` mechanism exists; the 8
   null rows get real values), plus measured `drawCalls` ceilings on the vegetation-
   and water-heavy shots (today drawCalls are recorded but asserted against nothing).
   Floors move only at the §9 rebaseline points, by recorded decision, and are re-pinned
   at each of them. Enforcement cadence: a full reference-host `npm run perf:capture`
   at **every item close** (recorded in the item's landing evidence), plus one
   mid-Gate-W checkpoint after W-1 — not just wave closes.
2. **Dark-by-default via the parity-sentinel pattern — with its cost measured.** Every
   eroded-only feature reads its channel through the zero-sentinel fallback (the splat
   classifier's `flowAccumulationValid` pattern,
   [LandCoverClassifier.ts:517-525](src/render/webgpu/terrain/LandCoverClassifier.ts)):
   analytic worlds sample zero-initialised atlases and keep today's behaviour. The
   shipping analytic build stays **pixel-identical except at sanctioned rebaselines**.
   But the sentinel is pixel-dark, **not cost-dark** — the analytic shader still pays
   the samples, bindings and ALU. Therefore every item that adds analytic-mode shader
   or binding cost (6-1, 6-5, 6-6, 6-8, 6-9, and any Gate W residency change) carries a
   mandatory **same-host A/B pin**: reference-host capture before/after, wall-fps delta
   ≤ 2% on the affected shots, logged at item close. TerrainSurfacePlugin already
   declares ~9 sampled textures against WebGPU's 16-per-stage base limit — 6-5/6-8's
   new bindings must count them.
3. **All GPU compute admits through `ComputeBudget`** (owners.ts: "every GPU compute
   producer admits through it"), under the existing per-tier caps
   (`erosionCompute` 0.2/0.4/0.7/1.2 ms, [PerformanceBudget.ts:83/96/112/126](src/render/webgpu/core/PerformanceBudget.ts)),
   with 4.5-B2 floor-of-one semantics. The governor freeze (`3fa0839`) means captures
   can no longer shed levers to hide an over-cap burst — it shows in p95 directly.
4. **Memory is at the wall, and the gate is the wrong instrument.** At the binding
   shot (reference-viewport, the shot created because the tier-1 cap binds there),
   **inventoried** GPU memory is 489.0 MiB against the 480 MiB ceiling while the
   *gating estimate* reads 380.7 MiB — only the estimate gates, ~100 MiB of false
   headroom. Gate 0 executes 6-11.4a: a capture-time assert on
   `inventoriedGpuMemoryMiB` (ceiling + small recorded tolerance for the pre-existing
   overage) so Wave 1–3 allocations are caught by the real number, and every item's
   `DYNAMIC_ALLOCATIONS` row is checked against the measured inventory delta at item
   close. Full estimate-model reconciliation completes in 6-11.4 (§7).
5. **Draw ceilings are regression guards, not budgets.** `VEGETATION_DRAW_CEILING =
   [50, 58, 515, 675]` ([renderedDensity.ts:377-387](src/render/webgpu/detail/renderedDensity.ts))
   asserts the *model*; Gate 0's per-shot measured drawCalls ceilings guard the
   *renderer* (the model cannot see 6-9's conservative shadow-pass draws or W-5's new
   lake/river meshes). 6-8/6-9 may not raise a ceiling; B-2's crown/trunk merge stays
   measured-and-rejected — do not re-litigate.
6. **The ratchet** (`RENDERING_PLAN.md:837`, quoted exactly): "**The ratchet:** `4-10`
   and `6-11` may not raise a count row without a fidelity row moving in the same
   commit, and any surplus that later work frees — `6-8`'s recovered instances,
   `6-9`'s cheaper scatter — is booked against the fidelity list, not against count."
   (4-10 is closed; the rule binds 6-11 here.) The ready-made fidelity row: wave T's
   undelivered leaf-spray atlas layers (foliageAtlasMiB 6.0 → ~8.0).
7. **The tier rule is absolute.** The grandfathered `.tier`-reader list is now empty
   ([architecture.boundaries.test.ts:154](tests/architecture.boundaries.test.ts)) —
   every tier-varying knob this phase adds lands as a `WebGpuQualityProfile` data field.
8. **Boundary tripwires** (all enforced by `npm test`): new page channels go through
   `payload.ts` only; hydrology consumers import `TerrainPageHydrology`'s owned
   accessors, never re-derive; terrain may import detail only via the `densityField`
   entry point; any new shadow caster uses `createGuardedShadowDepthWrapper`; any new
   seasonal field takes `dayOfYear`/`EnvironmentClock` in a type position from first
   write.
9. **Measurement discipline** (house knowledge): captures on an idle reference host
   only, same-host A/Bs (thermal drift ~20%); never time anything in the in-app
   browser pane (paint-gated RAF); GPU readbacks go through the buffer ring; benchmark
   with `tsx`, not vitest; `test:gpu` output to a file (zombie exit); WGSL hashes must
   survive world-scale ids (no sin-fract); reversed `smoothstep` now **throws** plus a
   source-scan test. A green suite is not evidence of anything visual — read the PNGs.
10. **Watched flake:** a ~460 ms single-frame stall in `motion-banked-turn` (twice on
   2026-08-28, not since). If it recurs in an acceptance run, check the wave R row
   before attributing it to phase work — it would breach the 50 ms gate on its own.

**The merge/overlap principle:** no analytic-visible pixel change merges into the
capture-gated branch before its wave's sanctioned rebaseline point. Work may develop
concurrently on side branches (6-2's ocean half and 6-4 may proceed during Gate W),
but Gate W's close proof — an unchanged-SSIM full run — must execute on a tree
containing **zero** Wave-1+ pixel changes.

---

## 2. What the tree already provides (delta since PHASE_6_PREPLANNING.md)

The preplanning was verified at `6a5b29e`; six waves landed after it. The load-bearing
changes for this plan:

- **The sea was rebuilt** (wave R): FFT normalisation gained the spectral cell measure
  (Hs 0.14 mm → 0.9–2.6 m), roughness became a field, capillary include rewritten
  (4 octaves, reach 14→63 m), mesh-Nyquist vertex fades, per-tier `oceanPresentation`
  lattices, and a **depth-keyed ocean shore-foam band already ships**. 6-1/6-2/6-4
  reasoning done against the old mirror-sea is void.
- **Trees changed representation a third time** (wave T): skeletal bark tubes + leaf-card
  shell at near AND mid, hull inverted to hidden interior core, near radii 110–240 m,
  ceilings 515/675. 6-8's plan-row impostor-radius trade ("drop 4 km → 2.5 km, save
  ~110k instances") is **dead**: draws scale with chunks × meshes, a presentation chunk
  is 4,096 m, so radius moves a couple of far chunks and no near mesh
  ([renderedDensity.ts:345-375](src/render/webgpu/detail/renderedDensity.ts)).
- **A GPU scatter path already exists** (wave G): per-frame compute blade field, fixed
  lanes writing degenerate zeros — no atomics, counters, indirect draws or readbacks —
  behind a capability gate with a protocol-threaded CPU fallback. 6-9 re-scopes from
  "build GPU scatter" to "generalise the proven pattern and pay its two debts"
  (no `groundCoverCompute` budget client; no governor rung — P-5 unimplemented and
  unrecorded).
- **Impostors are species-true and shadow-receiving** (waves Q/R): same
  `treePrototypeMode` datum as geometry bands; hand-packed fragment-side CSM receiver.
  QR-1's premise ("what a canopy is beyond the impostor radius") changed under it;
  vegetation still **casts** nothing below tier 2.
- **The baseline is 24 shots**, not 17; `tests/perf/baseline/report.json` is a committed
  17-shot fossil the harness never reads; `docs/PERFORMANCE.md`'s tier row and
  vegetation sections are three waves stale (dead `VEGETATION_FRAME_DEBT_RATIO` symbol).
- **Unchanged debts, re-verified at `a272d83`:** `lakeDepth`/`soilDepth` have **zero
  consumers** (C-9; `hydrologyTextures()` has zero callers); `setWetness` has zero
  callers; the riparian WGSL mirror is composed into no live shader; the shore-distance
  GPU atlas (index 9) is bound nowhere; scatter for trees/shrubs/rocks/clutter is still
  the CPU inline|worker|blocked path; the GitHub runner's detail worker still never
  comes up (inline is first-class).

---

## 3. Gate 0 — instruments and access (1.25 d), then Gate F — the three named flights

### Gate 0 (before anything else; 0.75 d + 0.5 d of 6-11.4a executed early)
- **0-a Delivery floor re-pin (0.5 d).** Three clean idle-host full runs → per-shot
  wall-fps/p95/hitch floors at measured-minus-~15% for all 24 shots (replacing the
  2026-08-18 values and the 8 `ceilings: null` rows), plus measured drawCalls ceilings
  on vegetation/water-heavy shots. Commit the pinning; record the source runs.
- **0-b Eroded access toggle (0.25 d).** There is **no runtime path to fly eroded
  today**: `FlightGame.tsx` calls `createWorld(seed)` with no options and no
  query-param/env/UI toggle exists. Thread `worldEvolution` through a dev-only toggle
  (query param or debug UI), with a test pinning that the shipped default is unchanged.
  Gate F is blocked on this.
- **0-c = 6-11.4a Memory instrument (0.5 d, booked to 6-11).** Capture-time assert on
  `inventoriedGpuMemoryMiB` per §1.4, tolerance for the recorded pre-existing overage
  (489.0 MiB at reference-viewport), so every later allocation is caught by the real
  number.
- **0-d PR-CI subset extension (in 0-a's commit).** `perf:capture:ci`'s 5-shot subset
  contains **no water or coast shot**; for the duration of the phase add `water-3m`,
  `water-25ft` (and `coast-10km-lowsun` during 6-2/6-5) — safe since `8ec1c45` keys
  phase to canonical index. Without this, every Wave-1 PR merges ungated on the
  surfaces it touches.

### Gate F (Jason, ~0.5 d triage)
Fly C-8 against today's CPU-eroded world via 0-b's toggle: **F-1** 10,000 ft
dendritic/divide survey, **F-2** 500 ft headwater-to-delta run, **F-3** 800 ft lake
circuit with spill outlet — plus the "no tree in any river" check, and capture the
**confluence and delta stills** C-8 carries (they fall naturally out of F-2). Expect
**~11–13 s to first ready** (the recorded eroded whole-app loads: 11,098 ms dev /
13,255 ms built; the oft-quoted 7,497 ms is the macro *algorithm benchmark*, not
time-to-ready) and single-worker page latency of ~2.1–5.5 s/page in flight.

Triage note: page-starvation artifacts during fast traverse (flat plates, coarse
nodes chasing the aircraft) are the **known CPU-reference producer-latency class** —
route them to W-1, not to landscape-shape defects. Output: a defect/verdict list
triaged into Gate W targets (shape/hydrology), Phase 6 item scope (appearance), or
declined-with-reason. Gate W does not start porting until the triage exists — porting
an unapproved landscape to the GPU would freeze its defects behind a determinism suite.

## 4. Gate W — the GPU-erosion workstream (≈19.0 d, range 16.5–23)

Now planned and priced, absorbing every §14.2 register row routed to it. Exit
criterion: the eroded world is **candidate-default** — production-quality, fast enough,
deterministic, capture-pinned — with the actual re-default decided in §8.

| Item | Register | Scope | d |
|---|---|---|---|
| W-1 | C-1 | GPU macro + page erosion passes (WGSL compute ports of the CPU reference operators), admitted through `ComputeBudget.erosionCompute`; **eroded time-to-ready ≤ 1.5 s** at tier 1 (recorded loads today: 11,098 ms dev / 13,255 ms built; the CPU macro benchmark alone is 7,497 ms); measured per-page GPU cost recorded (the 4.5-B2 ~1.9 ms/page finding is the prior). **Mid-gate checkpoint capture at W-1 close** (§1.1) | 6.0 |
| W-2 | C-2 | Resident-parent convergence chain + multi-frame page DAG (pages compose from converged parents, never from raw macro) | 2.0 |
| W-3 | C-3 | Assertions 91 (grid-bytes = page-bytes on adapter) and 93 (analyticServed = 0 below 500 m AGL over `sim.flight`) written and green | 0.5 |
| W-4 | C-4 | Lloyd-relaxed plate model + post-erosion fine-band masking | 2.0 |
| W-5 | C-5 | Real lake polygons (marching squares → Douglas-Peucker → ear-clip, with holes) + arc-length river resampling with Frenet frames and delta expansion — **the geometry 6-1/6-3 animate**; also retires wave R's "fans and 512 m ribbons" open item. New meshes count against Gate 0's drawCalls ceilings | 2.5 |
| W-6 | C-6 | Eroded bathymetry overlays resident L0 pages (today it samples the 512 m canonical macro at cell centres — the recorded floor under any surf zone). Water consumers may not work around it independently (ARCHITECTURE 5-10 row) | 1.5 |
| W-7 | C-7 | Eroded-mode capture. **Includes real harness work, not just a list edit**: no per-shot `worldEvolution` mechanism exists and the harness builds one renderer/world per run — mixed-mode canonical runs need a world teardown/rebuild (or second session) with settle/phase-keying re-derived and no double-resident world at the memory wall. Shots **appended** (append-only; canonical-index keying from `8ec1c45` preserved): dendritic, valley, lake, **plus one eroded motion/page-thrash shot with residencyCeilings** — the static surveys cannot see in-flight page-erosion admission bursts, which is the eroded mode's distinctive steady-state cost. First eroded baseline promoted; assertions 96/97/98 as a real statistics suite; **87 and 88 domain-wide** (88's lake-spill/fill-surface half is C-7's too); the 384-seed audit. Note: once appended, every future full-set rebaseline candidate re-runs and re-reviews these shots — priced-in review inflation | 3.0 |
| W-8 | C-10 | Erosion-halo composed-reach guard (composed reach 72 texels > 64-texel halo; theorem currently single-operator). **Blocks re-default** — resolved before §8 can say yes | 1.0 |
| W-9 | C-11 | RESOLUTION_PLAN A-3 TWI wetness window (`TERRAIN_TWI_DRY/WET` re-windowed against real eroded flow statistics, [TerrainPageHydrology.ts:42-43](src/render/webgpu/terrain/TerrainPageHydrology.ts)) | 0.5 |

Rules: W-1's steady-state page erosion admits under the existing tier caps — no cap may
be raised for it (shrinking the compute budget is Governor lever 0, and the governor is
frozen under captures, so an over-cap port fails the p95 gate honestly). The analytic
24-shot set is untouched by all of Gate W (mode-gated code + sentinel fallbacks);
prove it at Gate W close with an unchanged-SSIM full run **on a tree containing no
Wave-1+ pixel changes** (§1 merge principle), plus the delivery floors from Gate 0.

Findings from Gate F that are *shape* defects land here as W-x sub-items before W-7
pins anything.

---

## 5. Wave 1 — water in motion (6-1..6-4, 9.0 d)

All four items are **mode-shared where the substrate allows**: ocean-side work (6-2's
run-up, 6-3's shelf shoaling, 6-4) renders in both worlds; channel-driven work (6-1's
advection) is eroded-only behind the sentinel with today's wind-advection as the
analytic fallback. Mode-shared pixels obey the §1 merge principle: develop freely,
merge at R1.

### 6-1 river/lake flow — **re-scoped to advection only** (3.0 d)
Dual-phase flow-map advection (Vlachos) of the existing capillary/detail layers, driven
by flow direction+speed exported from the channel graph onto W-5's resampled lanes;
world-locked standing waves keyed to channel grade ("water moving through a wave that
stays put"); fetch-limited lake chop from W-5 lake polygons + the wave-R gust field.
**Fragment-side only** — no new cascade, no `OceanConfig` schema change; the wave-R
include stack (`WATER_DETAIL_NOISE_WGSL` + rewritten `WATER_CAPILLARY_DETAIL_WGSL`,
[WaterShaders.ts:247/372](src/render/webgpu/water/WaterShaders.ts)) is the substrate.
Wind ownership stays with the world definition (wave R fix 8).
Pins: TS/WGSL flow-sample parity; analytic world byte-identical shader output
(sentinel) **and** the §1.2 same-host A/B frame-cost pin; advected phase continuous
across page/lane seams.

### 6-2 shoreline run-up — **delta on wave R's shore band** (2.0 d)
What ships: depth-keyed Worley-broken foam band + reachable crest foam
(`foamThreshold` 0.88). What lands here: Hunt run-up with phase locked to the **same
cascade the visible swell comes from** (binding rule; the per-cascade fades are
addressable on the varyings, [SpectralOceanSystem.ts:392-398](src/render/webgpu/water/SpectralOceanSystem.ts)),
shore-normal streaking, and a wet-sand persistence band that **writes the 6-5 wetness
field** (§6) rather than a private term. Inland: generalise `shoreFoam`/`rapidFoam` to
the run-up pattern on W-5 banks. The ocean half has no W-x dependency and may develop
during Gate W on a branch (§1 merge principle).
Pins: run-up phase/cascade agreement test; foam coverage within the Monahan band on the
`water-3m`/`water-25ft` shots.

### 6-3 shallow-water dispersion (2.0 d)
Shoaling + depth-limited breaking, gated depth < 60 m inside the finely-tessellated
inner rings. Sequenced **after W-6** so eroded depth is L0-true; the 16 m bathymetry
texel remains the resolution floor (the shipped shore band had to go wide to hide it —
same constraint applies here). Fragment-biased implementation: the mesh-Nyquist fade
will correctly refuse vertex-band wavelengths the lattice cannot carry; do not fight
it, shade instead. Analytic mode keys off the analytic shelf profile.
Pins: dispersion-relation spot checks vs `tanh(k·depth)`; no visible cell grid at
grazing angles (the sin-hash/moiré lesson).

### 6-4 caustics (2.0 d)
Jacobian-driven, shallow-gated. The Jacobian is already stored (slope_foam alpha +
displacement_jacobian alpha, [OceanShaders.ts:372-373](src/render/webgpu/nature/OceanShaders.ts))
and — critically — only became physically meaningful when wave R restored real
amplitude. Composes into the refracted-bed term of `WATER_DEPTH_OPTICS_WGSL` in both
materials (the depth-include parity test must keep passing verbatim). May develop
during Gate W on a branch; **merges only at R1** (its analytic pixels would break RW's
unchanged-SSIM proof otherwise).
Pins: caustics vanish beyond the depth gate; parity test unchanged; `water-3m` SSIM
rebaseline at the Wave-1 point only.

**Wave 1 rebaseline point** (§9 R1): water shots + appended rapids/surf shots, delivery
floors re-pinned. Watch-list: wave R's "planar shore reflection" open item is
**explicitly declined** for Wave 1 (it is an SSR-class term; the plan's water cut list
still stands) — logged here so §11 doesn't have to rediscover the decision.

---

## 6. Wave 2 — wet ground and ecology (6-5..6-7 + retune, 5.75 d), then canopy and scatter (6-8/6-9, 8.0 d)

### 6-5 terrain wetness — the field (2.0 d)
Produce `terrainWetness` per-pixel from: ocean/lake proximity (signed shore distance +
`lakeDepth` — **this is `lakeDepth`'s first named consumer**, satisfying half of C-9
here by explicit assignment), 6-2's wet-sand run-up persistence, and capillary rise
above the waterline. GPU side: first binder of the hydrology atlas textures
(`hydrologyTextures()` currently has zero callers) into `TerrainSurfacePlugin`'s
sampler set — mind the 16-textures-per-stage limit (§1.2). CPU side unaffected.
Analytic fallback: sea-level band only (today's submerged term stays authoritative
under water). Not seasonal — it does not join `SEASONAL_FIELD_FAMILY` (no
precipitation model exists; log if that changes).
Pins: `setWetness`/field path drives the two live response instructions; lakes above
sea level finally render wet-bedded in eroded mode; analytic captures byte-stable +
the §1.2 A/B frame-cost pin.

### 6-6 ecology channels — the consumers (2.0 d)
C-9's other half plus the species/appearance work. The binding rule ("three channels,
each with a **named** ground-layer consumer") is met with a **redefined channel
triple**, recorded as a deviation: RENDERING_PLAN's row named riparian/shelter/soil,
but **no shelter page channel exists** — Phase 5's producer ships flow/TWI, shore
distance, lakeDepth, soilDepth only. Shelter's named consumers (moss weight, deadfall
accumulation) are **declined-with-reason**: noise-driven shelter terms are already
live in the density field and archetype weighting, and 2-15 already gates moss on
moisture and places deadfall by closure. The triple becomes:
- **soilDepth** → swap 2-15 clutter's moisture stand-in ([generation.ts:1072](src/render/webgpu/detail/generation.ts))
  to a real `terrainSoilDepthMeters` read, + litter-depth term in the forest-floor splat.
- **shore distance** → the species half: reed/fern archetype weight keyed to shore
  distance (today moisture-keyed at generation.ts:971-975) + wet-litter darkening in
  the splat. Density half already live (riparian factors).
- **lakeDepth** → consumed by 6-5 (recorded split of C-9). Flow/TWI already has its
  consumer (the classifier); W-9 is its truth fix — 6-6 claims no credit for it.
CPU consumers extend `TerrainAuxPagePublication` (today it carries only
shoreDistance); GPU consumers bind the atlas — both paths itemised, neither silently
re-derives (owned-symbol rule). Analytic: sentinel fallback to today's moisture proxy.
"Net stem count falls" binds.
Pins: consumer-per-channel table asserted by test (no dark channels); riparian
TS/WGSL parity extended to the species term; §1.2 A/B pin.

### 6-7 talus/scree placement (1.5 d)
Placement law only — the 2-15 instancing/lithology-normals/snow substrate survived the
overhaul intact. Density from slope × shallow-soil (soilDepth inverse) × lithology,
concentrated below failure faces; consumes 6-6's channels, so it lands after.
Pins: scree density ∝ law fixture test; draw/triangle budgets unchanged (rocks ride
existing clutter ceilings).

### DryGrass sward retune (0.25 d)
Wave R's fourth recorded open item (metre-scale absolute power doubled by its mask
fix; sward retune filed). A material-tuning change needing a sanctioned pixel point —
lands inside the R2 window with its own before/after frames.

### 6-8 canopy-terrain handoff — economics rewritten (3.0 d)
The plan-row trade is dead (§2). What survives, re-derived for the skeletal era:
- **Canopy closure and grass cover as splat inputs**, baked at page-splat time with
  vegetation's `densityField` as the **single owner** (terrain reads through the
  densityField entry point — the boundary test's one sanctioned route). No new
  world-page channel unless payload-borne (then via `payload.ts` alone).
- **Canopy height added to terrain height at coarse LOD only** for forested ridgeline
  silhouettes (far beyond the 240 m near band, well below Nyquist).
- **Far-field handoff**: albedo/roughness/AO ramp beyond the impostor radius,
  complementary to the **live** fade lanes in `DetailInstanceMaterialPlugin` (re-derive
  against band codes 0–4 and the species-true impostor handoff wave R just repaired —
  not the 2026-08-18 dither description).
- **Absorbs QR-2** (under-canopy darkening — closure-driven terrain term, the F5
  design) and **absorbs the wave-R vegetation horizon-shadow term** (far impostors lit
  on horizon-shadowed dusk terrain; donor: terrain's 8-azimuth horizon map). Both are
  canopy↔terrain lighting couplings with the same single-owner shape.
- **Explicitly not doing:** raising `vegetationDistance`, moving band radii, or
  re-attempting draw merges. Any recovered budget books against the fidelity list (§1.6).
Pins: closure channel matches rendered density law within tolerance (the lit-brightness
lesson: calibrate the *lighting* response across representations, not albedo means);
QR-4 re-verified against the card-shell shed path while touching the handoff; §1.2
A/B pin.

### 6-9 GPU scatter — generalise wave G (5.0 d)
Scope, in order: (1) **pay the debts** — `groundCoverCompute` becomes a real
`ComputeBudget` client with a `PerformanceBudget` row (G-1), and the governor gains its
ground-cover rung (P-5) recorded as a deviation-close; (2) **generalise the blade
pattern** to the remaining per-frame ground-cover archetypes (reed/fern/heather
patches) with the same fixed-lane/degenerate-zero contract, becoming the first live
composer of `VEGETATION_DENSITY_FIELD_WGSL` (re-verify TS/WGSL parity in the composed
context — today the mirror is dead code pinned by tests); (3) **GPU cull for the
instanced main pass** per §7 R4 verbatim: CPU-readback count as the default path
(through the readback buffer ring), indirect draw behind a loud startup capability
assertion, main pass only (per-pass indirect buffers make shadow/reflection
conservative — those extra real draws are exactly what Gate 0's measured drawCalls
ceilings watch), Babylon private-API existence test, `@babylonjs/core` pinned.
Landmines already pinned in-tree: packed u32 lanes travel as `uint32x4` attributes;
`forcedInstanceCount` plugins force INSTANCES/THIN_INSTANCES off. The inline CPU path
stays first-class (CI's detail worker never comes up). Cheaper scatter authorises
**zero** new plants (§1.6).
Pins: budget-client admission tests (floor-aware); capability-assertion failure is
loud; count parity CPU vs GPU on a fixture chunk; §1.2 A/B pin.

**Wave 2/3 rebaseline points** (§9 R2, R3), floors re-pinned at each.

---

## 7. Wave 4 — final tiers and truth (6-11 remainder + 6-12, 4.5 d)

### 6-11 quality-tiers-v2 (3.5 d total; 0.5 executed as Gate 0-c, 3.0 here)
1. **Four-tier × three-viewport delivery sweep** on the reference host: pinned
   captures per tier (governor frozen = shipping-profile levers, which is exactly what
   a tier row promises), strict contract applied at each tier's own frame target
   (13.7/13.7/13.7/30.0 ms rows). Tier rows in §5.3 are rebuilt from the **amended**
   table (erosion-scope row struck; Ultra 1 m L0 struck; PCSS struck; Balanced 2
   cascades; Ultra material 512²; Ultra ocean stays 5-cascade — the "6 @ 256" row is
   deleted as unreachable). Expect rows to move 30–50%; every change obeys the ratchet.
   **The per-tier outputs are archived acceptance reports, not standing baselines** —
   only the canonical tier-1 set remains the standing regression gate; if a tier row is
   later to be *guarded*, that is a recorded decision adding it to a scheduled run
   (e.g. the weekly cron), not an implicit one.
2. **QR-1 settled** (per Q7): `vegetationCastsShadows` tier rows decided from measured
   headroom per tier, as profile data; any new caster path uses the guarded factory.
   The decision — whatever it is — gets a decision-log row closing the T1–T8 residual.
3. **Cold-start deadlines**: analytic default time-to-ready measured on the reference
   host and committed as an acceptance number with startup-stage split, failing on
   **timeout or console error** (both halves — the 5-10 failure class hung with *no*
   error, so only a hard timeout catches it); eroded time-to-ready reported against
   W-1's ≤1.5 s budget. Both sourced independently of steady capture.
4. **Memory truth completion**: reconcile the estimate model against the measured
   inventory (Gate 0-c's assert has been accumulating per-item deltas all phase) —
   either the estimate rows are re-derived or a ceiling moves with its fidelity trade,
   judged at the binding shot (489.0 MiB inventoried at reference-viewport today).
Pins: per-tier delivery reports archived; tier table asserted from profile data in CI;
cold-start gate wired into the perf workflow (enforced local, reported unpinned).

### 6-12 documentation truth pass (1.5 d)
The verified untruth list (grown since preplanning): PERFORMANCE.md §Vegetation
(ceilings two generations stale + dead `VEGETATION_FRAME_DEBT_RATIO` symbol),
§"Current measured tier row" (17-shot, pre-overhaul numbers), cold-start framing
("default-eroded" — re-point per the §8 outcome), `tests/perf/baseline/report.json`
(17-shot fossil — recommit-at-promotion or delete, decide once),
`RENDERING_PLAN.md` §5.3 Ultra ocean row, ARCHITECTURE §1 table missing the three
waves-T/G owner rows + stale LandCoverClassifier "planned 4-6" duplicate, stale
"impostors neither cast nor receive shadows" comments (superseded on receive),
**retroactive decision-log rows for wave P and the governor freeze** (both currently
unrecorded — the log is normative and incomplete), and this phase's own rows.
Pins: doc-truth tests read the profile table, the startup number, and the ceilings
constants so drift fails `npm test`.

---

## 8. The re-default decision (end of phase, 0 d — it is a decision, not work)

Eroded becomes `DEFAULT_WORLD_EVOLUTION` **only if all five hold**:
1. W-8/C-10 resolved (hard blocker, recorded as such in the register);
2. the full capture set — analytic and eroded shots, **including W-7's eroded
   motion/page-thrash shot** — green under the strict tier-1 contract and Gate 0's
   re-pinned floors on the reference host;
3. eroded cold time-to-ready ≤ the committed deadline (W-1 target 1.5 s);
4. the eroded default's **inventoried** tier-1 GPU memory holds under the ceiling
   after 6-11.4's reconciliation (re-defaulting changes what is resident in the
   shipped configuration; the frame contract cannot see memory);
5. Jason's flight verdicts (Gate F, re-flown post-Gate-W if F found shape defects)
   approve the landscape.

If any fails, the analytic default ships on and eroded stays a flag — that outcome is
**acceptable by Q1's own terms** and is not a phase failure. Either way the decision
gets a decision-log row and 6-12 re-points the docs to match.

---

## 9. Sequencing, ledger, rebaseline points

```
Gate 0 (1.25) ─→ Gate F (0.5) ─→ Gate W (19.0) ─→ Wave 1 water (9.0) ─→ Wave 2 (5.75)
                                    └ RW ┘           └─ R1 ─┘             └─ R2 ─┘
              ─→ Wave 3 canopy/scatter (8.0) ─→ Wave 4 tiers/truth (4.5) ─→ §8 decision
                   └─ R3 ─┘                        └ R4: archived tier reports ┘
```

Within-wave dependencies: 6-1←W-5; 6-3←W-6; 6-2-inland←W-5 (its ocean half is free);
6-2 feeds 6-5; 6-7←6-6; 6-8←6-6; 6-9←6-8; 6-11←all; 6-12←6-11. 6-4 and 6-2's ocean
half may develop on branches during Gate W but **merge only at R1** (§1 merge
principle — RW's proof requires a Wave-1-clean tree).

| Block | d (nominal) | Range |
|---|---|---|
| Gate 0 (instruments/access; incl. 0.5 of 6-11) | 1.25 | 1–1.5 |
| Gate F triage | 0.5 | 0.5–1.0 |
| Gate W (erosion workstream) | 19.0 | 16.5–23 |
| Wave 1 (6-1..6-4) | 9.0 | 8–11 |
| Wave 2 (6-5..6-7 + DryGrass retune) | 5.75 | 5–7 |
| Wave 3 (6-8, 6-9) | 8.0 | 7–10 |
| Wave 4 (6-11 remainder, 6-12) | 4.5 | 4–5.5 |
| **Total** | **48.0** | **42–59** |

Ledger reconciliation: the itemized remaining scope in `RENDERING_PLAN` is **≈27.5 d**
(30.0 total − 2.0 for 6-10 → 4-0b − 0.5 for 6-6's half → Gate B;
`PHASE_5_EXECUTION_PLAN.md:245`'s "≈27.0" was a 0.5 arithmetic slip — noted for 6-12).
This plan's item sum is also 27.5 — the re-pricing nets to zero (6-1 −1.0 and 6-2 −1.0,
both because the fix-pack and wave R shipped their halves; 6-5 +0.5 field-from-scratch;
6-8 +0.5 QR-2 + horizon-shadow absorption; 6-11 +0.5 QR-1 + memory truth;
6-12 +0.5 grown list). The 48.0 total = 27.5 items + 19.0 Gate W + 0.75 Gate 0
(non-item half) + 0.5 Gate F + 0.25 DryGrass retune. The four historical ledger
figures (30.0/28.0/27.5/27.0) never reconciled; this table supersedes them for Phase 6.

**Rebaseline points** (full-set candidate → review → manual promotion, never
mid-item; delivery floors re-pinned at each per §1.1): **RW** eroded baseline creation
at Gate W close (analytic shots SSIM-unchanged in the same run — the Gate W
non-regression proof); **R1** Wave 1 water pixels + appended shots; **R2** Wave 2
ground/ecology pixels + DryGrass retune; **R3** Wave 3 handoff pixels; **R4** the
6-11 sweep's archived per-tier acceptance reports (not standing baselines — §7.1).
Between points, all analytic shots hold their current baselines exactly.

**Assertion numbering:** global assertion ids continue from the registry's next free
number (118 was 4.5's last; verify before authoring). Gate W consumes the
already-allocated 87, 88, 91, 93, 96, 97, 98. Plan-local pins above map onto ids when
authored.

---

## 10. Risks

| # | Risk | Mitigation |
|---|---|---|
| 1 | W-1 misses 1.5 s on the reference host | The budget is the *exit* bar, not a mid-item gate; if the measured floor is higher, §8 fails honestly on criterion 3 and the phase still ships its features behind the flag |
| 2 | Eroded captures are non-deterministic (worker scheduling, seed drift, W-7's world-rebuild machinery) | Phase 5's evict/regenerate determinism assertions + the frozen governor are the instruments; W-7 runs them before any baseline is promoted |
| 3 | Tier-1 memory wall (489.0 inventoried vs 480 at the binding shot) blocks a Wave-1/2 allocation | Gate 0-c's inventoried assert catches it at the offending item, whose scope shrinks in-wave rather than deferring the overrun to Wave 4; every item's `DYNAMIC_ALLOCATIONS` row is checked against its measured delta |
| 4 | 6-9's indirect path breaks on a Babylon bump | §7 R4's private-API existence test + pinned `@babylonjs/core`; CPU-readback default means the feature degrades, not breaks |
| 5 | Gate F finds landscape defects too large for Gate W's price | Triage explicitly may move work *out* (decline-with-reason into the register) — Gate W's range widens only by recorded decision, not silently |
| 6 | Phase-long analytic drift sneaks in between local runs | Gate 0-d puts the water shots in PR CI for the phase; main-push CI runs the full set's visual gates; delivery floors are enforced by the per-item-close reference-host run (§1.1) — the cadence, not CI, is the delivery guard, and it is now explicit |
| 7 | The adversarial-review lesson | Before each wave close, run the adversarial diff review (6+ finders, refutation panel) — every prior phase found real defects the suites missed; budget it inside each wave's range |

## 11. Deviation log

*(Empty at plan time, except one entry recorded at planning: 6-6's shelter channel
re-scoped away — see §6 — because no shelter producer exists and its consumers are
discharged by live noise-driven terms. Further deviations land here with evidence,
plus a normative row in ARCHITECTURE.md's decision log, per house rule.)*
