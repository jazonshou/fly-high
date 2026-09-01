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

   **AMENDED 2026-08-31 — a pin is A→B→A, never A→B.** The two-arm form this rule
   used to permit *cannot resolve a 2% claim on this host*, and that is measured,
   not cautionary. Taking the horizon-shadow pin: the second AFTER arm read
   **−4.27% on `reference-viewport`** against BEFORE — over this rule's own
   threshold, and on a two-arm pin I would have reported it as a real cost and
   blocked a clean merge. A third arm, **same tree**, read −0.08%. The same-tree
   spread across three runs of identical code was **74.0 → 115.1 → 120.1 fps** on
   that shot; on pixels, `canopy-1200ft` read 0.99820 / 0.99820 / **1.00000**, a
   same-tree spread larger than any before/after difference.
   So: **run the AFTER arm twice** (or the BEFORE arm twice — the repeated arm is
   the control), and **compare the A/B delta against the same-tree spread before
   reading it as a result**. A delta smaller than the control spread is not a
   measurement, whatever its sign. Discard any arm that follows a Vite
   dep-optimizer miss or a failed run: the first arm here read a mean of 106.6 fps
   against the others' ~120 and would have poisoned the comparison in the
   flattering direction. This is distinct from, and additional to, D-6/D-18's
   "never measure under load" — a QUIET host still needs the control arm, because
   the within-tree variance on some shots exceeds the effect being measured by an
   order of magnitude.
3. **All GPU compute admits through `ComputeBudget`** (owners.ts: "every GPU compute
   producer admits through it"), under the existing per-tier caps
   (`erosionCompute` 0.2/0.4/0.7/1.2 ms, [PerformanceBudget.ts:83/96/112/126](src/render/webgpu/core/PerformanceBudget.ts)),
   with 4.5-B2 floor-of-one semantics. The governor freeze (`3fa0839`) means captures
   can no longer shed levers to hide an over-cap burst — it shows in p95 directly.
4. **Memory is at the wall, and the gate is the wrong instrument.** At the binding
   shot (reference-viewport, the shot created because the tier-1 cap binds there),
   **inventoried** GPU memory is 489.0 MiB while the tier-1 ceiling the *estimate*
   is checked against is 480 MiB, and that estimate reads only 380.7 MiB — ~100 MiB
   of false headroom in the gating instrument. Read that as "the real number already
   exceeds the declared tier ceiling", NOT as available headroom: those are two
   different measurements of the same physical thing. **Headroom for a new
   allocation is measured against Gate 0-c's enforced inventoried assert** —
   `PERF_CAPTURE_INVENTORIED_MEMORY_CEILING_MIB = 495` against a measured 492.3,
   i.e. **2.7 MiB**, which is the number any new allocation must actually fit in. Gate 0 executes 6-11.4a: a capture-time assert on
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
| W-4 | C-4 | Lloyd-relaxed plate model + post-erosion fine-band masking. **Targets are now measured, not guessed** (W-7's statistics suite): (a) the 24 m/9 m ridged bands move off the *uplift input* (C-4's recorded deviation) onto a *post-erosion* soil-depth-and-curvature mask — one mechanism drives two failures, sub-macro pit density 3.289/km² against < 0.1 and valley:crest 20 m RMS curvature 0.608:1 against ≥ 3:1 (inverted, because ridges keep every band while page erosion planes valley floors); (b) per-plate motion boundaries so range-local gradient anisotropy reaches 2:1 everywhere (76% today, median 2.430:1). Re-verify assertion 96-global after any macro-shape change — it passes with only 11% margin | 2.0 |
| W-5 | C-5 | Real lake polygons (marching squares → Douglas-Peucker → ear-clip, with holes) + arc-length river resampling with Frenet frames and delta expansion — **the geometry 6-1/6-3 animate**; also retires wave R's "fans and 512 m ribbons" open item. New meshes count against Gate 0's drawCalls ceilings | 2.5 |
| W-6 | C-6 | Eroded bathymetry overlays resident L0 pages (today it samples the 512 m canonical macro at cell centres — the recorded floor under any surf zone). Water consumers may not work around it independently (ARCHITECTURE 5-10 row) | 1.5 |
| W-7 | C-7 | Eroded-mode capture. **Includes real harness work, not just a list edit**: no per-shot `worldEvolution` mechanism exists and the harness builds one renderer/world per run — mixed-mode canonical runs need a world teardown/rebuild (or second session) with settle/phase-keying re-derived and no double-resident world at the memory wall. Shots **appended** (append-only; canonical-index keying from `8ec1c45` preserved): dendritic, valley, lake, **plus one eroded motion/page-thrash shot with residencyCeilings** — the static surveys cannot see in-flight page-erosion admission bursts, which is the eroded mode's distinctive steady-state cost. First eroded baseline promoted; assertions 96/97/98 as a real statistics suite; **87 and 88 domain-wide** (88's lake-spill/fill-surface half is C-7's too); the 384-seed audit. Note: once appended, every future full-set rebaseline candidate re-runs and re-reviews these shots — priced-in review inflation | 3.0 |
| W-8 | C-10 | Erosion-halo composed-reach guard (composed reach 72 texels > 64-texel halo; theorem currently single-operator). **Blocks re-default** — resolved before §8 can say yes | 1.0 |
| W-9 | C-11 | RESOLUTION_PLAN A-3 TWI wetness window (`TERRAIN_TWI_DRY/WET` re-windowed against real eroded flow statistics, [TerrainPageHydrology.ts:42-43](src/render/webgpu/terrain/TerrainPageHydrology.ts)) | 0.5 |

### Gate W status — **CLOSED 2026-08-30**

| Item | State | Evidence |
|---|---|---|
| W-1a GPU stream-power + talus | **landed** | 2,020 → ~100 ms; GPU-vs-GPU byte-deterministic; CPU-oracle tolerance pinned |
| W-1b GPU input sampling | **landed + wired** | 1,011 → 28.8 ms; 6-seed extraction sweep green; `gpu-macro-v2` provenance family |
| W-1c CPU legs (bit-preserving) | **landed** | floods 476→151, MFDs 477→170, stage 2 1,844→324 ms; byte-identical at 1024² on two seeds |
| W-1e eroded startup | **landed** | extraction 3.9× and moved into the macro worker; readiness semantics unchanged |
| W-1d + W-2 page DAG | **landed** | 34–37 ms/page, 12–19 frames, ~1.4 pages/s vs the CPU path's 0.2–0.5; seed cost measured 0.4 → 0.24 ms; determinism holds across evict/regenerate and across dispatch rates; seam relaxed per D-7 |
| W-3 assertions 91 + 93 | **landed** | 4-hop byte equality through the real transfer; 31,917 readback-served / 0 analytic below 500 m |
| W-4 plates + fine-band masking | **landed, 2 targets still unmet** | plate model delivered every gain; the C-4 diagnosis was disproved by ablation (D-8) and the two remaining misses re-routed to their real causes |
| W-5 lake/river geometry | **landed** | 2,654 → 9,173 lakes meshed; arc-length rivers; analytic path sha-pinned |
| W-6 bathymetry L0 overlay | **landed** | plus a root-caused pre-existing `writeBuffer` race in the dual-rect path |
| W-7 statistics + harness | **partial** | statistics suite landed (4 pinned, 3 recorded); per-shot `worldEvolution` machinery landed dormant; eroded shots + baseline promotion held for Gate F |
| W-8 composed-reach guard | **closed** | 36/36 production page pairs bit-exact + a pinned production-ratio fixture (D-4) |
| W-9 TWI re-window | **closed** | [4,18] → [15,24] from ~431k measured texels × 2 seeds |

Macro leg measured end to end: **~1,779 → ~825 ms**. Whole-path eroded
time-to-ready projects to ~1.27–1.5 s (D-5) — at budget, no margin.

**Close evidence (idle host, Wave-1-clean tree):** 24/24 capture shots pass with
delivery gates ENFORCED — min 112.44 wall fps, worst p95 10.3 ms, zero hitches,
against the pre-Gate-W floor of 113.4 / 10.2 / zero. The analytic set is
SSIM-unchanged (23 shots ≥ 0.999 luma; the one below it measures the same on a
pre-Gate-W control capture, which also settles D-6 finding 4: the W-6 race fix
has no detectable analytic pixel effect). `npm test` 951 / 114 files;
`test:gpu` 73 / 36 files; seam audit 32/32 bit-exact; inventoried memory 492.3
MiB at the binding shot with every allocation site now registering (was 489.0
with buffers invisible), 2.7 MiB under the ceiling.

**Carried out of Gate W:** D-7's canonical-split fix (blocks re-default),
D-9's loosened page-parity bounds (re-tighten after D-7), W-4's two unmet
targets routed to operator reach and to W-2's boundary condition, and Gate F's
flights — which still gate any eroded baseline promotion (D-1).

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

### Wave 1 status (2026-08-30)

| Item | State | Notes |
|---|---|---|
| 6-4 caustics | **landed + merged** | built on a side branch during Gate W, merged after the close proof; clean 3-way merge, zero conflicts |
| 6-1 flow advection | **landed** | dual-phase advection at 9 / 1.6 / 0.36 m drifting at 1.0 / 0.85 / 0.7× surface velocity; standing waves λ = 2πv²/g with steepness set by GRADE (the first formulation made torrents break *less* than riffles — caught by measurement and changed); SMB/JONSWAP fetch-limited lake chop; world-locking proven bit-identical from 0.5 s to 20,000 s; analytic byte-identity proven as an exact-zero struct on hardware |
| 6-2 shoreline run-up | **landed** | see D-12; ocean fragment hash re-pinned deliberately, vertex hash deliberately unchanged as proof it is a fragment-side delta |

Wave 2: **6-6 landed** (see D-10) — C-9's soilDepth half discharged, stem count
fell as required, analytic byte-identity measured against a reconstructed
pre-6-6 tree. **6-7 landed** (D-11) — it corrected 2-15's inverted slope term and net rock
instances fell everywhere. 6-5 waits on 6-2's wetness field.
| 6-3 shallow-water dispersion | **landed** | see D-13; **Wave 1 complete** |

### Wave 2 and Wave 3 status (2026-08-31) — ALL ITEMS LANDED

| Item | State | Notes |
|---|---|---|
| 6-5 terrain wetness | **landed** | D-15; `lakeDepth` consumed at last, **C-9 fully discharged** (the consumer table now asserts zero pending channels) |
| 6-6 ecology channels | **landed** | D-10; `soilDepth` given its first consumer, stem count fell |
| 6-7 talus/scree | **landed** | D-11; corrected 2-15's inverted slope term, rock instances fell everywhere |
| 6-8 canopy handoff | **landed** | D-14; QR-2 and the far ramp proved to be one quantity; QR-4 moot; horizon-shadow declined with reason → 6-11 |
| 6-9 GPU scatter | **landed** | D-16; both wave-G debts paid, a real ComputeBudget bug fixed, drawn blades −39.6% |

Only **6-11** (four-tier sweep, QR-1, cold start, memory truth) and **6-12**
(documentation truth) remain, and both are capture-driven — the main session owns
them because they require a quarantined idle host.

**Owed rebaselines: R1, R2 and R3 are all outstanding.** Waves 1–3 moved analytic
pixels in three separate areas (ocean surf and caustics; the coast wet strip;
ground materials, scree and ground cover), each measured by its own item. They
should be reviewed and promoted together in ONE sanctioned pass rather than three,
since no capture has been promoted between them.

**A scoping fact R1 must absorb:** 6-1's pixels are **invisible in all 24 current
shots**. Both water shots are open-ocean analytic views and no current shot frames
inland water or runs eroded, so flow advection, standing waves and lake chop
cannot appear until the appended **eroded rapids/lake shot** exists — and eroded
shots are held for Gate F's verdicts (D-1). Caustics is the opposite: its ocean
half moves the two water shots now, while its inland half is equally invisible.
So R1 rebaselines what caustics does to the ocean, and Wave 1's inland work
stays unpinned until the eroded shot set lands. Do not read "no pixel movement"
as "no work landed"; read it as "the capture set cannot see this yet".

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
sea level finally render wet-bedded in eroded mode; **the "analytic captures
byte-stable" pin is SUPERSEDED by D-15** (the wet strip is necessarily
terrain-side, so three coast shots move and earn an R2 rebaseline) + the §1.2 A/B
frame-cost pin.

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
4. **`TERRAIN_SAMPLED_BINDINGS` must be checked against a COMPILED shader.**
   Raised by the Phase 7 planning session and verified here: the list is
   hand-maintained and validated only for uniqueness and against the 16-per-stage
   limit — never against a real compiled effect. It carries **15 fragment
   entries** including six PBR samplers the terrain material does not bind, while
   OMITTING the CSM shadow sampler, the cloud-shadow projection sampler, and both
   hydrology atlases 6-5 and 6-6 added. That is why three different sampler counts
   (11 / 8 / 15) are in circulation, and it means **6-5's and 6-6's sampler
   arithmetic was reasoned against a model rather than the renderer** — the same
   defect shape as the draw-ceiling model, which asserts the law rather than the
   frame. The app compiles, so the list over-counts and the true headroom is
   larger than those items believed; that is the benign direction, but it is
   unverified. 6-8 already added a compiled-source assertion
   (`tests/gpu/terrain-surface-compile.test.ts`) — extend it to derive the real
   count from `effect.fragmentSourceCode` and pin the list against it.
5. **Memory truth completion**: reconcile the estimate model against the measured
   inventory (Gate 0-c's assert has been accumulating per-item deltas all phase) —
   either the estimate rows are re-derived or a ceiling moves with its fidelity trade,
   judged at the binding shot (489.0 MiB inventoried at reference-viewport today).
Pins: per-tier delivery reports archived; tier table asserted from profile data in CI;
cold-start gate wired into the perf workflow (enforced local, reported unpinned).

### 6-12 documentation truth pass (1.5 d)

**A general form this phase earned, to be recorded rather than re-derived:**
*a hand-maintained list asserted only against a limit — never against the thing
it models — is decorative.* It will pass forever while drifting arbitrarily far
from reality, and every number quoted from it inherits the drift. Three live
instances, found by three different accidents:
- **`TERRAIN_SAMPLED_BINDINGS`** — checked for uniqueness and against the
  16-per-stage limit, never against a compiled effect. Stale in *both*
  directions (six phantom PBR samplers; missing CSM, cloud-shadow, and both
  hydrology atlases Phase 6 itself added), which is why three sampler counts are
  in circulation. Fixed by 6-11 item 4.
- **`VEGETATION_DRAW_CEILING`** — asserts the rendered-density *model*, not the
  renderer. Partly closed already: Gate 0-a added per-shot measured `drawCalls`
  ceilings, so an independent renderer-side check now exists beside the model.
  The model assertion itself is still model-only.
- **`SEASONAL_FIELD_FAMILY`** — the boundary test iterates the list and checks
  each member conforms, so it verifies *conformance of members* but never
  *completeness of membership*. A new seasonal field that simply never registers
  is invisible to it, which is precisely the failure the rule exists to prevent.
  Unfixed; needs a scan for the shape (a field taking `dayOfYear`/
  `EnvironmentClock`) rather than a walk of the roster.
The rule to write down: **every list that models something must be derived from,
or asserted against, the thing it models.** Uniqueness and bounds checks are not
verification — they only prove the list is internally tidy.

**And the half of the rule this phase learned last, which is the stronger half:
a decorative list has no immune response to REGRESSION either.** The argument
above is about drift — a list quietly diverging from reality. The sharper point
is that a list nothing asserts against can be *un-fixed* exactly as quietly as
it was broken, by an ordinary merge, the day after it is corrected.
This is not hypothetical. On 2026-08-31, one day after D-22 replaced
`TERRAIN_SAMPLED_BINDINGS` with a compiled-shader-derived list, a peer session
rebasing a horizon-shadow branch found its stale copy of
`TerrainSpineContract.ts` would have restored the six phantom PBR samplers and
dropped `environmentBrdfSampler` and `shadowTexture`. **Nothing would have
failed** — the pre-D-22 assertions were uniqueness and a bound, and the reverted
list satisfies both. It was caught because the peer read the deletion side of
its own diff, which is diligence, not a mechanism. The regression would have
reached the tree by the same route the original drift did, and the fix would
have been undone in silence.
So the reason to derive from the artifact is not only that it finds the bug:
**it protects the fix.** A value asserted against the compiled shader cannot be
reverted without a red test, no matter who merges what. That is the difference
between a finding and a guarantee, and it is the strongest instance this phase
produced.

Worth recording alongside it: all three of this phase's deepest defects were
caught by the same mechanism, and none by careful reasoning. D-18's forest floor
was caught by *looking at the frame*; D-20's readback by *a guard on an
impossible value*; the sampler list by *an agent asked to verify one claim
against the tree*. Reasoning found none of them, because each was a case where
the model and the artifact had quietly diverged and only the artifact could say so.

**A second general form this phase earned, from two independent instances in one
day:** *admission-gated compute can be entirely correct and never run, and
nothing that drives the producer directly can see it.*

A GPU producer that admits through `ComputeBudget` only executes when the meter
admits it. That makes "is it correct?" and "does it ever run?" **separate
questions with separate evidence**, and every natural test answers only the
first — a harness calls the producer, so the producer runs, so the harness can
never observe the case where nothing calls it.

Both instances landed on 2026-08-31, in unrelated subsystems, and neither was
found by the tests that covered the code:
- **D-23 (`fine-band`).** `demand()` returned zero for a stage its own `advance()`
  could reach, so the clipmap submitted nothing, the meter admitted nothing, and
  the page was never pumped again. **No eroded page ever became resident and the
  whole world rendered flat, silently.** Every erosion test pumped the DAG
  unconditionally, so `demand()` — the function that failed — was called by no
  test in the project.
- **D-25 (horizon bake).** The bake competes for the `occlusionCompute` row
  against page streaming, which saturates that row during a cold spawn. A
  correct, compiled, correctly-bound term could therefore **win no admission and
  do nothing forever**, shipping as a dead feature behind a green capture pin.
  Every test drove `bakeHorizon()` directly; none proved the renderer calls it.

One froze a world and one would have shipped a no-op. The difference in symptom
is luck; the mechanism is identical.

**The rule, and it generalises to the next admission-gated feature:** for any
producer behind an admission meter, add one test that **drives the real pump
under realistic competition and asserts the output becomes resident within a
FRAME BOUND** — not "eventually". The bound is not fussiness: a feature that
arrives after the first two hundred frames is absent for the part of the session
a player actually meets, which is the same defect wearing a slower disguise.
Testing the operator proves the maths; only this proves the maths ever executes.
Related and not the same: [[harness-must-drive-like-production]] is about a
harness driving a subsystem *differently* from production; this is about
production *not driving it at all*.

**A third form, and the corrected memory rule (2026-08-31).** *Know an
instrument's variance before you gate on it — and do not assume the variance
exists either.*

`inventoryGpuMemoryMiB` (`FlightRenderer.ts:1522+`) walks `scene.textures` and
`scene.meshes` and computes bytes **arithmetically from dimensions — it never
queries the driver.** Two things follow, and the second is the one that was
wrong.
1. There is no surface for "unexplained driver overhead", so any theory
   invoking it is unfounded. A previously circulating ~60% overhead figure is
   retracted.
2. It was then inferred that because the walk enumerates what is RESIDENT at the
   instant of measurement, `inventoriedGpuMemoryMiB` must carry residency
   jitter the way wall fps carries thermal jitter — and that the enforced
   **2.7 MiB headroom** might therefore be gating on its own noise.
   **Measured, and that inference is FALSE.** Across three runs of an identical
   tree (the horizon A/B's three AFTER arms), resident page count varied on
   **24 of 24 shots**, by as much as 9 pages (30 / 39 / 37 on
   `approach-500ft`) — while inventoried memory moved by **less than the
   report's 0.05 MiB resolution on every shot.**
   The mechanism, verified rather than assumed: terrain pages occupy SLOTS in
   an atlas allocated once at `terrainAtlasEdgeTexels(profile.heightAtlasSlots,
   …)`. Residency changes which slots are *occupied*, never how many bytes
   *exist*, and the walk sees the atlas texture at full size either way. Page
   residency and page memory are decoupled by construction.
   **So the 2.7 MiB headroom is real and the ceiling is not gating on noise.**
   Two limits on that claim, stated because they are where it stops holding:
   it was measured on the capture's SETTLED state (every run drained to
   `pendingTerrainPages === 0`), so it says nothing about a live session
   mid-stream; and a **tier** change resizes the atlases themselves, so memory
   *will* move across the sweep — that is signal, not jitter.

**The corrected rule for memory claims**, replacing "measure deltas, never
arithmetic", which was too strong:
- **Known, static construction parameters → ARITHMETIC against the inventory's
  own formula is preferable**, because it is deterministic while a measurement
  carries whatever spread the instrument has. The horizon work's hand-computed
  0.125 MiB was the *more* reliable number; my +0.20 MiB measurement was the
  less reliable one, and I should not have told it to prefer mine.
- **Aggregate totals and headroom → measure, with a same-tree control arm**,
  per §1.2's A→B→A amendment. This is that rule applied to memory instead of fps.
- **Never reason arithmetically about an allocation you have not traced to an
  allocator.** That was the original sin (D-6's storage buffers, invisible to
  the walk and therefore absent from every total), and it is a *different*
  failure from either of the above — an omitted category, not a mis-estimated
  one.
The family resemblance to the two forms above: in all three, an instrument was
trusted past the point where anyone had characterised it. The fix is the same
shape every time — **characterise the instrument, then gate on it.**

**A fourth general form, and the only one that indicts the guards themselves:**
*an instrument that models "code doing X" while actually matching "text
containing X", never re-checked against the difference.*

`tests/architecture.boundaries.test.ts` enforces the ownership manifest with
bare regexes over source text — `/\bnew\s+ShadowDepthWrapper\b/u` at `:131`,
`/\.tier\b/u` at `:155`. `withoutImportClauses` (`:31`) strips comments, imports
and re-export clauses before they run, and its own docstring gives the purpose:
"so that a mention inside a comment cannot satisfy a convention check".
**It does not strip string literals.** Verified by replicating the function
against both forms rather than by reading it: a comment containing either token
is stripped and passes; the same text inside a string literal **fails the
build**.

**The consequence inverts the obvious guidance, which is why it went unnoticed.**
You may comment about these constructs freely — that is what the strip is for.
What you cannot do is put their vocabulary in a **string**: an error message, a
thrown `Error`, a `note:` field, a test name. **So the guards are hardest on the
single most useful error message an author can write — the one naming the
construct it forbids.** A guard meant to enforce a convention actively degrades
the explanation of that convention, pushing authors toward vaguer wording
exactly where precision matters most. The guards' own failure messages are
exempt only because that file sits outside `SOURCE_ROOT` (`src/`) — luck, not
design.

**Recorded as a trap plus an open question, not a fix.** Whether these guards
*should* strip string literals is a real decision with a cost on both sides: a
string containing `new ShadowDepthWrapper` can be a genuine dynamic construction
site — a registry key, a `Function` body, a dynamic import — so stripping
strings opens a hole in a guard whose entire job is to have none. Trading a
false positive for a false negative in a boundary guard is an architectural
call, not a cleanup. The full note lives on `withoutImportClauses`'s docstring,
where an author who trips it will meet it.

**`SEASONAL_FIELD_FAMILY` is the roster case — and this section WITHDRAWS its own
proposed fix.** The gap is real: `:236` iterates the roster and checks each
member conforms, so it verifies **conformance of members** and never
**completeness of membership**; a seasonal field that never registers is
invisible to it. This section previously proposed "a scan for the shape (a field
taking `dayOfYear`/`EnvironmentClock`) rather than a walk of the roster".
**That instruction is wrong and is struck.** Measured with the file's own shape
regex and its own strip function over `src/`: **27 files match the shape, 5 are
roster definition sites, 23 match and are not on the roster** — the clock's own
definition (`world/environmentClock.ts`), `render/types.ts` which merely *passes*
it, and the rest plumbing. **The shape cannot distinguish a field that DERIVES
from the clock from a consumer that THREADS it, and §1.6 requires everyone to
thread it.** A guard with an ~85% false-positive rate acquires an exception list
within a week and is decorative again, in the more dangerous way: it *looks*
enforced. The open question — what machine-readable property separates a
seasonal FIELD from a seasonal-clock CONSUMER — is a design decision and is
deliberately not answered here; note the two existing "NOT a member"
declarations (`detail/talusField.ts:62`, `TerrainSurfacePlugin.ts:274`) are
**comments**, so the strip removes them and they cannot serve as exclusions.
Worth keeping: this is the first time in the phase that **a proposed fix was
measured before being implemented and turned out to be worse than the gap it
closed.** The measurement cost minutes; the guard would have cost a permanently
weakened boundary test.

**Four members, four distinct ways an instrument can be wrong:** a decorative
list models an artifact and *drifts* from it; admission-gated compute is
*correct and never runs*; a memory gate was *uncharacterised*, its variance
assumed rather than measured in both directions; and a source guard *matches
text while claiming to match code*. The common root is that the model and the
artifact had quietly diverged and **only the artifact could say so** — none was
found by reasoning, and three were found by accident.

**Two corollaries from the P0 seam work, both about proxies standing in for the
artifact — the same disease as the four forms above, one level down.**

**A mesh's NAME is a convention; its DEFINES are what compiled.** A compiled-
source assertion selected impostor effects with
`mesh.name.startsWith("detail-impostor")` and matched only the **prototype
template quad** — never submitted, never carrying the shadow define. It failed
identically before and after a working fix and **would have reported that fix as
broken.** The meshes the renderer actually draws are
`detail-tree-impostor-chunk-*`. Select on the compiled define, which is a fact
about the artifact, not on the name, which is a fact about whoever named it.

**A guard that false-positives acquires an exception list and is decorative
within a week — in the more dangerous way, because it then LOOKS enforced.**
`tests/render.webgpu-plugin-define-declaration.test.ts` nearly did this on its
first run: it reported `GroundCoverMaterialPlugin` as undeclared because that
plugin writes its define map inline (`{ GROUND_COVER_BLADES: false },`) and the
scan was anchored to line starts. One false positive out of two findings. Had it
shipped, the fix would have been an allowlist entry, and the guard would have
been decorative from its first week. **Measure a new guard's false-positive rate
before landing it** — the `SEASONAL_FIELD_FAMILY` scan was withdrawn for exactly
this reason at ~85%, and this one would have shipped at 50%.

**A hazard specific to a harness that writes to FIXED PATHS: comparing an
artifact against a copy of itself.** Twice in one day. `tests/perf/artifacts/`
holds one file per shot name, so two runs of the same shot produce one filename
— and a comparison that reads "the artifact" before and after a change may be
reading the same bytes twice. Instance one: a rebaseline candidate was compared
against `artifacts/report.json` in the belief it was the baseline-era record; it
is regenerated by every capture and gitignored, so the comparison was the run
against itself and reported no differences at all. Instance two: an altitude A/B
on `veg-seam-1600ft-oblique` produced byte-identical luminance profiles at two
altitudes, because the second capture had overwritten the first PNG before the
comparison read it.
**The failure mode is what makes this dangerous: it returns a PERFECT result,
not an error.** No differences, identical profiles, everything agrees — which
reads as evidence of stability rather than as a broken measurement. **The rule:
a capture comparison must verify its two inputs are distinct files before
comparing them.** `cmp -s a b && echo IDENTICAL` is the whole check, and copying
each run's artifact to a distinct name at the moment it is produced is the whole
fix.

**One corollary earned the hard way, because it is how this section's own
bookkeeping went wrong.** A draft of the wave-P decision row asserted that the
viewer mode's synthetic-state seam "was never recorded at all". It is recorded —
`ARCHITECTURE.md:358`, the wave-**V** row, in as many words. The search had been
for *"viewer mode"*; the row says *"Terrain Viewer"*, *"setViewerMode"*,
*"viewer behaviour"*, and never that bigram. **The plan's phrasing was searched
for instead of the artifact's.** So: *a negative grep result feels like evidence
of absence and is only ever evidence about your search string* — and **a row
claiming a gap is a claim like any other, verified against the artifact or not
made at all.** Back-filling four rows to match a promise would have added three
duplicates and one fiction to a log whose whole value is that a row means a
decision was reviewed.
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

Eroded becomes `DEFAULT_WORLD_EVOLUTION` **only if all six hold**:
1. W-8/C-10 resolved (hard blocker, recorded as such in the register);
2. the full capture set — analytic and eroded shots, **including W-7's eroded
   motion/page-thrash shot** — green under the strict tier-1 contract and Gate 0's
   re-pinned floors on the reference host;
3. eroded cold time-to-ready ≤ the committed deadline (W-1 target 1.5 s);
4. the eroded default's **inventoried** tier-1 GPU memory holds under the ceiling
   after 6-11.4's reconciliation (re-defaulting changes what is resident in the
   shipped configuration; the frame contract cannot see memory). Three concrete
   inputs, all known now: the ceiling must first be **re-pinned from a fresh
   idle-host capture** with the previously-blind storage buffers registered
   (D-6); W-5's real water geometry adds ~29 MB of eroded-only mesh, which needs
   either a `DYNAMIC_ALLOCATIONS` row it fits under or a refine-knob/fidelity
   trade; and the page-erosion DAG's scratch must be registered and reconciled
   at its item close;
5. Jason's flight verdicts (Gate F, re-flown post-Gate-W if F found shape defects)
   approve the landscape;
6. **D-7's canonical-split fix has landed and assertion 90's bit-exact seam
   holds for the GPU producer.** Re-default makes the eroded surface the shipped
   collision authority, and the seam bound scales with terrain height — it is
   ~2.5× under the physics tolerance at the 2,400 m ceiling today and shrinks if
   W-4 raises peaks. This is the one criterion that is cheaper to satisfy than
   to argue about.

If any fails, the analytic default ships on and eroded stays a flag — that outcome is
**acceptable by Q1's own terms** and is not a phase failure. Either way the decision
gets a decision-log row and 6-12 re-points the docs to match.

### §8 RESOLVED — **NO**, 2026-08-31. Analytic ships on; eroded stays a flag.

Decided by Jason after re-flying the eroded world post-`fine-band` fix. This is
the branch above, taken on its own terms — **not a phase failure**. Against the
six criteria, at the moment of the decision:

| # | criterion | state |
|---|---|---|
| 1 | W-8/C-10 resolved | met |
| 2 | full capture set green, **including eroded shots** | **NOT met.** The eroded shots did not exist until 2026-08-31 (D-23); W-7 left them unwritten, which is the root of the whole failure. |
| 3 | cold time-to-ready ≤ 1.5 s | **UNKNOWN, and honestly so.** Every measurement taken was in a paint-gated pane and has been retracted (D-23). Throughput is ~31 frames/page with one page in flight, which projects to ~90 s for a working set — but that is a projection, not a measurement. |
| 4 | inventoried memory under the ceiling | **NOT met.** 527.5 MiB eroded against the 495 pin. (Analytic reads 492.3 and fits, which is why this criterion evaporates on the analytic path.) |
| 5 | Jason's flight verdicts approve | **NOT met — this is the criterion that decided it.** |
| 6 | D-7 landed, seam bit-exact | **NOT met**, and now shelved. |

Four of six unmet and one unknown, so the decision is not close and did not turn
on a judgement call. **Criterion 5 is the one that actually resolved it**, and
the sequencing is worth recording: 2, 3, 4 and 6 were all knowable without a
human, and none of them had been established when a human first looked. The gate
that should have caught this is criterion 2, and criterion 2 was unmeasurable
because the instrument it names was never built.

Consequences, all recorded in D-24: eroded work stops and the code parks behind
its flag; `DEFAULT_WORLD_EVOLUTION` is unchanged; the three `eroded-*` shots are
removed from the capture set; D-7, D-9, the throughput finding, the zero-height
provisional page, the analytic-pyramid/eroded-atlas horizon mismatch and the
memory overage become the reviver's reading list. 6-12 re-points the docs.

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

- **D-0 (at planning):** 6-6's shelter channel re-scoped away — see §6 — because no
  shelter producer exists and its consumers are discharged by live noise-driven terms.
- **D-1 (2026-08-30, implementation start):** Gate F runs **in parallel** with Gate W
  rather than strictly before it. Jason directed implementation to proceed; the
  eroded toggle (0-b) landed first so the flights are unblocked, and the gate's
  rationale — never freeze an unapproved landscape — is preserved by holding **W-7's
  baseline promotion** (the freezing step) until his flight verdicts arrive. Shape
  defects found by the flights land as W-x sub-items before any eroded baseline is
  promoted.

- **D-2 (2026-08-30, Gate W staging):** Gate W executes in **bit-churn-minimizing
  order**, not row order: W-8's halo decision, W-2's seeding design, and W-4's
  macro-shape changes land **with** W-1's port, before W-7 pins anything. Evidence:
  the implementation recon showed W-2 (parent-converged seeding replaces the
  bilinear-macro boundary condition), W-8 (any halo change), and W-4 (macro shape)
  each alter every eroded page's bits — porting W-1 first against macro-seeded
  64-halo pages would invalidate its own fingerprints and any mid-gate captures
  twice over. The W-1-close checkpoint capture measures the **analytic** set
  (non-regression) plus eroded timings, not eroded pixels.
- **D-3 (2026-08-30, parity strategy):** Bit-exact CPU==GPU parity is **not
  attempted** — the CPU reference operators accumulate in `Float64Array` internally
  and round to f32 only at outputs (TerrainMacroEvolution.ts stream-power/talus),
  so no f32 WGSL port can match bits. Per the recon's plan-consistent option: the
  authority assertions become **GPU-vs-GPU bit determinism** (assertion 89
  evict/regenerate, 90 seam equality, on-adapter), **CPU-oracle tolerance parity**
  with a frozen measured-criteria contract (the TERRAIN_HEIGHT_PARITY_CRITERIA
  doctrine: point count is part of the criterion, tolerances measured-not-conceded),
  and **atlas-bytes == sim-grid-bytes** (assertion 91) as the collision truth. The
  CPU reference stays in-tree as the oracle and the worker fallback. Consequence
  for Gate F: the flights approve the CPU landscape's *shape*; the GPU port must
  stay tolerance-bounded to that shape, and per D-1 no eroded baseline is promoted
  until the verdicts are in.

- **D-4 (2026-08-30, W-8 closed as measured guard, halo not grown):** The composed
  72-texel reach does not breach the 64-texel halo on real content: 36/36 adjacent
  production L0/L1 page pairs across valley/slope/ridge regimes were IEEE-bit-exact
  on their stored overlaps (`scripts/erosion-seam-audit.mts`, seed 333438), and an
  adversarial fixture with the composed reach at 112.5% of the halo (the production
  ratio) with all three operators verified active stays bit-exact
  (`tests/render.webgpu-erosion-seams.test.ts`). C-10 resolves as: (a) the pinned
  ratio test in `npm test`; (b) the full-scale audit re-run required at every Gate W
  boundary and before the §8 re-default (criterion 1 now reads "W-8's two
  instruments clean", not a theorem). Growing the halo to 80 (+17% page area,
  hydrology-halo re-derivation, full eroded bit-churn) is the recorded fallback if
  either instrument ever fails. W-9 also closed: TWI window re-measured over 2
  seeds × 24 eroded pages (~431k texels each) and re-pinned [4,18] → [15,24]
  (`scripts/twi-stats.mts`; constants docblock carries the distribution).

- **D-5 (2026-08-30, W-1's exit re-priced honestly):** the ≤ 1.5 s eroded
  time-to-ready target is measured against a critical path that W-5's real water
  geometry lengthened after the target was written. Landed legs: macro ≈ 825 ms
  (was ~1,779 ms — GPU sampling 28.8 ms replacing 1,011 ms CPU, GPU stream-power
  and talus ~100 ms replacing 2,020 ms, stage 2 324 ms after the duplicate
  flood/MFD pass was removed), plus an eroded water tail of ~441 ms main-thread
  with extraction (246 ms) overlapped behind construction. Projected whole path
  ≈ 1.27 s when the overlap holds, ≈ 1.5 s when it does not — i.e. **at the budget
  with no margin**, before the GPU page path's own contribution to first-ready.
  The remaining named levers, in order, are: mesh assembly to a transfer-fed
  worker (399 ms, needs a new worker file), `MeshArrays` to typed arrays with a
  counting pre-pass (touches the analytic path and its byte pin), and per-lake
  scratch reuse in the macro-lake field (~80 ms, in `TerrainPageHydrology`).
  If the measured cold number misses after those, §8 criterion 3 fails honestly
  per Risk 1 — the features still ship behind the flag.

- **D-6 (2026-08-30, adversarial review of the landed Gate W work — Risk 7):**
  six finders over the landed subsystems produced 16 candidate defects; a
  refutation panel killed 3 and confirmed 4. Fixed in this pass:
  1. **The memory wall was blind to every storage buffer** (major, and a hole in
     Gate 0-c's own instrument): `inventoryGpuMemoryMiB` walks `scene.textures`
     and mesh geometry, and *every* allocation this phase adds is a
     `StorageBuffer`. The assert would have returned a byte-identical reading no
     matter how much scratch an item allocated, and its `DYNAMIC_ALLOCATIONS`
     reconciliation would have recorded 0.0 MiB — §8 criterion 4 would have been
     reached believing memory was policed. Now `core/GpuBufferInventory.ts`
     accounts registered bytes into the inventory floor, the macro-erosion and
     bathymetry allocations register, and
     `tests/render.gpu-buffer-inventory-policy.test.ts` source-scans every
     `new StorageBuffer(` site so the blindness cannot return quietly. Three
     pre-existing sites (ground cover, height pyramid, occlusion bake) are
     allowlisted with reasons: registering them RAISES the measured inventory
     the 495 MiB ceiling was pinned against, so they land with the fresh
     idle-host re-pin at the Gate W close capture, and the list's length is
     itself asserted so a discharged row must be removed.
  2. **The sampling leg could not fail open** (major): Babylon's
     `dispatchWhenReady` never settles when a pipeline fails to compile, so the
     documented CPU fallback was unreachable — an adapter that rejected the
     sampler WGSL would hang the load to the 180 s evolution timeout instead of
     costing ~1 s. The terrain producer now polls with a deadline and REJECTS,
     matching the water stack's existing bounded-dispatch helper.
  3. **Unbounded per-delta rect fan-out** (minor): the bathymetry overlay issues
     one compute pass, bind-group rebuild and buffer pair per changed page, with
     no cap and an unused full-square path — a residency-wide turnover (atlas
     reshape, large camera jump) fans out to one pass per tile. It now promotes
     to a single full-square repaint past `BATHYMETRY_PAGE_RECT_BATCH_LIMIT`.
  4. **Whether W-6's race fix moves ANALYTIC water pixels: UNPROVEN, deferred to
     the close capture.** The finding is mechanically sound (before the fix, two
     same-frame rects read the last rect's params). Measured on this host the
     analytic shots scored luma 0.9893–0.9989 against baselines that used to
     score 1.0000 — but a control capture of a clean worktree at the pre-Gate-W
     commit, under the same load, scored 0.99/0.999 identically. **The drift is
     contention, not code**, and this host cannot resolve the question while
     agents run. The Gate W close's unchanged-SSIM run must therefore happen on
     a quarantined idle machine, and if a real analytic delta survives there it
     is a *bug fix* and gets a sanctioned rebaseline with frame-by-frame review,
     not a silent pass.
  Refuted (recorded so they are not re-litigated): that the retired lake
  overfill gate rests on a false invariant; that lake polygons swallow islands
  in a way the retired gate caught; and that the W-7 world-swap path is
  unreachable dead code.

- **D-7 (2026-08-30, assertion 90's bit-exact seam is relaxed for the GPU page
  producer — accepted for Gate W, MUST be closed before §8 re-default):**
  adjacent GPU-produced pages are NOT bit-equal on their stored overlap. Measured
  1.22e-4 m east-west and 9.54e-5 m north-south over 2,112 texels per axis —
  about 8 f32 ulps. The cause is structural, not an operator error: the WGSL
  kernels take page-relative split-origin lattice coordinates (the world-scale
  precision rule that keeps f32 honest at ±262 km), so two pages evaluate the
  same world texel through different `(origin, local)` decompositions and round
  differently. A **CPU control on the identical fixture is bit-exact (0.0)**,
  which proves this is a property of the port and NOT of the composed operator
  reach W-8 measures — the two findings are independent.
  *Why it is acceptable now:* the error is invisible (0.12 mm over a 2 m texel is
  a normal-angle error of ~0.003°) and it never reaches gameplay through physics,
  which carries a measured 5 mm tolerance.
  *Why it is not acceptable forever:* the bound is ALTITUDE-DEPENDENT, because an
  f32 ulp scales with the value. 8 ulps is 0.008 mm at 10 m elevation but
  **1.95 mm at the 2,400 m terrain ceiling** — i.e. the pinned 2e-3 m bound is
  not comfortable headroom, it is precisely the ulp ceiling at maximum terrain
  height, leaving only ~2.5× margin under the physics tolerance. Anything that
  raises peak elevations (W-4 is exactly that) eats into it.
  *The known fix, to be implemented before re-default:* make the split canonical
  in WORLD space rather than page space — snap the lattice origin to the 512 m
  block containing each texel instead of to the evaluating page's own origin.
  A page's 768 m scratch span touches at most 3×3 such blocks, and the kernel
  already takes an ARRAY of page uniforms with a runtime selector
  (`kSelectPage`), so this is a uniform-packing and per-texel-selection change,
  not a new precision scheme. Both pages then resolve a shared texel through
  identical arithmetic and bit-equality returns.
  Until then: the CPU producer remains the bit-exact oracle, the CPU control
  stays in the test as the discriminator, and `TERRAIN_PAGE_EROSION_GPU_SEAM_CRITERIA`
  is pinned with the ulp analysis recorded beside it.

- **D-8 (2026-08-30, W-4 landed and DISPROVED the recorded C-4 diagnosis):**
  C-4 blamed both the sub-macro pit density and the inverted valley:crest
  curvature on the fine ridged bands sitting on the uplift input. W-4 moved them
  post-erosion under a measured soil-depth/curvature mask as specified — and
  then **measured the ablation**, which is what the register row never did:
  deleting the bands entirely moves 87-fine only 3.289 → 2.961/km² and 98 not at
  all (0.608 → 0.605:1), and applying the masked bands at ×1/×2/×4 leaves the
  pit count *identical*. A 24 m band box-averaged into a 50 m cell has nothing
  left to make a hollow with. **The improvements W-4 did deliver are the plate
  model's**, not the mask's: 96-global 1.1716 → 1.0661:1 (margin 11% → 18%),
  96-local median 2.430 → 2.913:1, 87-fine 3.289 → 2.574/km², 98 0.608 → 0.805:1,
  with all four previously-passing measurements held.
  The real mechanisms, measured and now recorded in the suite:
  - **87-fine:** every remaining pit is a 4–20 cm sill inside 1.2–6.4 m rims, a
    hollow 1–3 cells across. The page breach searches 16 texels (32 m) and the
    macro flood works at 512 m — **nothing drains anything between 32 m and
    512 m**. That is a reach problem, and more reach grows the composed operator
    reach W-8 audits, so it is a deliberate design question, not a tuning knob.
  - **98:** a page has **no hillslope domain**. Its contributing-area field is
    the macro's 512 m accumulation upsampled, so the p1 area at a 2 m texel is
    2.9e5 m² — every texel believes it drains 29 hectares and stream power
    incises uniformly. That is **W-2's boundary condition**, not a fine-band
    property; a diagnostic soil-creep pass restricted to low flow recovers
    0.581 → 0.672 the moment its threshold selects anything. The creep operator
    was deliberately NOT shipped (new operator, new reach, new GPU pass, outside
    W-4's scope).
  Both remaining misses are therefore **routed out of W-4 with evidence** rather
  than tuned to green. Also recorded: the CPU-reference sampling leg costs +32%
  (943 → 1,247 ms) for the plate model, which is the fallback/oracle path only —
  the shipping GPU sampler measured 26.2 ms, no regression — and the fine-band
  GPU pass costs +8 dispatches / +0.6–0.9 ms (2.4%) per page.
- **D-9 (2026-08-30, CPU/GPU page agreement genuinely loosened — re-tighten after
  D-7's fix):** `TERRAIN_PAGE_EROSION_GPU_PARITY_CRITERIA` moved mean 5e-3 →
  0.04, p99 2e-3 → 0.01, max 8 → 30 m, plus a new `reroutedTexelShare` of 0.02,
  and `TERRAIN_PAGE_EROSION_GPU_SEAM_CRITERIA` moved 2e-3 → 0.06 m. This is a
  real reduction in agreement and is recorded as such rather than absorbed. The
  cause is one near-sea-level page with a **contested trunk channel**: 505 of
  69,696 texels (0.72%) in a single cluster disagree, the other 99.28% agree to
  0.68 mm, and both producers report the same min/max to 1e-5 m. That is a
  topological divergence — an f32 tie flipping a receiver, which then reroutes a
  channel — not a rounding envelope, and it makes **D-7's canonical-split fix
  materially more urgent than its original 8-ulp framing suggested**: the seam
  disagreement measured 2.41e-2 m, five times the 5 mm physics tolerance, where
  my earlier ulp analysis predicted ~2 mm. The fix addresses the root cause
  (both pages would see identical inputs, so no tie can flip between them), and
  **these criteria must be re-tightened once it lands** — a loosened bound that
  outlives its cause becomes permission. GPU-vs-GPU determinism and the CPU
  reference's own bit-exact seam are untouched.

- **D-10 (2026-08-30, 6-6 landed — C-9's soilDepth half discharged):** `soilDepth`
  has named consumers for the first time in the project's history (clutter density
  and the moss gate via a shared `soilLitterFactor` law, forest-floor suitability
  baked in the splat compute, and a CPU delivery path), and shore distance gained
  its species/appearance half (reed/fern archetype weight and wet-litter
  darkening). `lakeDepth` remains 6-5's by the recorded split and is now asserted
  as the **only** open row in a consumer-per-channel table test — the item's own
  rule made executable. Two deviations, both improvements on the brief:
  1. **GPU consumers are split by stage.** soilDepth binds into the splat bake
     COMPUTE shader rather than the fragment, because litter is a per-page
     property — so it costs zero per-fragment samplers. Only shore distance binds
     into the fragment (as `texture_2d<i32>` read by `textureLoad`, so it needs no
     companion sampler and the sampler budget does not move: 9 fragment textures
     against the 16-per-stage limit, and only 8 in the shipping analytic build).
  2. **The fragment consumer is gated by a compile-time define, not §1.2's runtime
     zero-sentinel**, so it is cost-dark as well as pixel-dark — nothing is
     compiled into the analytic shader at all. This is strictly stronger than the
     rule asked for; §1.2's A/B for 6-6 is therefore zero-by-construction on the
     fragment, and the only analytic cost added anywhere is four extra
     `textureLoad`s per channel texel in the page splat bake, which is amortised
     page work rather than per-frame.
  Evidence quality worth noting: analytic byte-identity was **measured, not
  asserted** — a tree with the pre-6-6 files restored produced digest `a46e54b1`
  against the post-6-6 tree's `a46e54b1`, and the same harness shows HEAD's
  "soil present" run was bit-identical to analytic, i.e. the channel really was
  dark and now is not. Stem counts FELL as §5.3 requires (clutter −6.0%, moss
  −24.3%, trees and shrubs byte-equal).

- **D-11 (2026-08-31, 6-7 landed — the placement law runs in BOTH worlds and
  analytic pixels move by design):** talus/scree is not an eroded-only feature.
  Slope and lithology (`sampleTerrainEvolutionGeology.reposeDegrees`) exist
  analytically, and 5-5's soil depth enters as a *factor* whose analytic fallback
  is the owned `terrainSoilDepthMeters` at zero curvature and zero contributing
  area — the same law with less information, not a second soil model.
  **The item is a redistribution, not an addition, and it corrects a real defect
  in shipped code:** 2-15's rock term scaled with `slope·0.35` *without limit
  toward vertical*, so the steeper a face got the more loose blocks it carried —
  exactly backwards, since a face above the local angle of repose is a failure
  face that sheds. 55% of that population now leaves the face and lands on the
  apron below it, distributed by an upslope fall-line probe (metres of
  above-repose face above you), a runout falloff, and a soil-exposure factor.
  Net rock instances FALL in every measured window (broad −10.9%, mountain
  −21.4%, foothill −2.4%, flat 0.0%), the mid-radius-drawn boulder population —
  where rock instance pressure actually lives — falls 13–31%, and draws are
  unchanged by construction (no new prototype, no new variant). Grain size uses
  fall sorting (chips arrest early, blocks roll to the toe, so the apron fines
  *upslope* toward its source — the opposite of a water-laid deposit) with the
  direction pinned by test so it cannot drift into its opposite. Snow burial is
  keyed to the REFERENCE snowline rather than `FoliageSeason`, so rocks cannot
  pop with the calendar. Analytic byte-identity where the law is inert was
  measured against a reconstructed pre-6-7 tree (`e8b749d3` → `e8b749d3`), not
  asserted. One finding carried forward: the detail field keys its geology on
  `world.sourceSeedHash` while the erosion operators key on `world.seedHash`,
  which differ when the airport region search relocates — so the lithology field
  the scree reads is a valid but DIFFERENT realisation from the one eroded
  terrain's repose/erodibility use. Worth closing if a terrain-side scree albedo
  ever lands.

- **D-12 (2026-08-31, 6-2 landed — run-up, and where the wet-sand field must live):**
  Hunt (1959) run-up `R = tanβ·√(H·L₀)`, with the binding same-cascade phase-lock
  rule implemented as ONE named function (`waterDominantShoreSwell`) so the GPU
  test exercises the shipped selection rather than a reimplementation. The
  selection is the argmax of visible **amplitude**, not visible slope — `a = √(2·mss)/k`
  rises with wavelength while `mss` falls, so a sea with a hundredfold slope on
  the finest cascade still correctly beats at 64 m. Three deviations, all
  deliberate:
  (a) **The run-up phase is a shallow-water eikonal in DEPTH, not a shore-distance
  field.** On a plane beach the travel time from the waterline integrates in
  closed form (`φ = ω·(t + 2√h/(tanβ·√g))`), whose spatial gradient is exactly the
  shallow-water wavenumber `ω/√(gh)`. Crest spacing narrows shoreward on its own
  and bands run parallel to the depth contours — refraction for free, at one sqrt
  and one divide, with no shore-distance texture bound.
  (b) **Open-coast streaks deliberately do NOT use 6-1's dual phase.** Swash
  advection is bounded and oscillatory; 6-1's Vlachos pair exists to bound an
  *unbounded* Lagrangian age, which swash does not have. The inland bank streaks
  do use it, as intended.
  (c) **The CPU sea state comes from wind+fetch, not from the GPU spectrum**
  (no readback exists), through the same SPM/CEM growth laws 6-1 uses for lake
  chop — the two raw coefficients are now named once and both consumers derive
  from them, value-identical and pinned. Agreement with the shader's own selected
  band is pinned rather than assumed (2.12 m at 77.5 m, inside cascade 2's band,
  frequencies agreeing within 20%).
  **The wetness field is terrain-side, and the reason is geometric:** the ocean
  disk is a plane at sea level with depth write off, so on any beach above the
  waterline the terrain fragment is nearer and the disk is depth-tested away —
  the water surface *physically cannot* draw the sheet running up the beach face.
  Surf below the waterline is 6-2's; wet sand above it is 6-5's;
  `waterShoreWetness` is the seam, and it is deliberately self-contained (no
  uniform, texture, derivative or external helper — enforced by a call-graph scan
  AND a standalone GPU compile) so it composes into a terrain shader that has
  never heard of the water lattice.
  Two quality notes worth carrying: the foam modulation is **mean-preserving**
  (cycle mean exactly 1, measured over 200k samples and on hardware), so 6-2
  *redistributes* wave R's foam rather than adding any and its coverage is
  untouched; and the 16 m-texel claim is measured with a **control that must
  fail** — the same chain on a point-sampled bed is required to exceed a ratio of
  3, so the measurement cannot pass vacuously.

- **D-13 (2026-08-31, 6-3 landed — WAVE 1 COMPLETE):** shoaling uses the FULL
  `√(c_g0/c_g)` coefficient rather than Green's law alone, because the difference
  is visible in the shipped regime: at the plan's 60 m gate a 256 m swell is
  transitional (`k₀h = 1.5`), and only the full coefficient reproduces the
  textbook shoaling **dip** (measured minimum 0.9137 at `k₀h = 0.99`; literature
  0.9129). Because `ω² = g k₀`, the coefficient collapses to `Ks² = kh/(2 n k₀h)`
  — no frequency, period or celerity is ever formed. Breaking is a clipped
  Rayleigh distribution against a slope-dependent McCowan limit
  (`γ = clamp(0.78·ξ₀^0.17, 0.6, 0.9)`), which makes the cap **exact rather than
  approximate** (`1 − e^(−R²) ≤ R²`) and yields the whitewater fraction for free —
  no second law, no tuned onset.
  **Consistency with 6-2 is structural, not tuned:** band heights are 6-2's law
  *called* (pinned by a source scan asserting 6-3 does not define it), the
  aggregation weight is character-for-character the expression 6-2 takes the
  argmax of, both share one bed probe and one beach-slope clamp, and **6-2's bore
  and streaks are now multiplied by 6-3's breaking fraction** — so a wave 6-3
  says is unbroken at 3 m cannot be drawn as a bore there. Mean-preservation
  survives the gating at every weight, so 6-2's pinned foam coverage does not
  move. A fourth coupling is measured rather than asserted: 6-3's solved `k(h)`
  and 6-2's eikonal gradient are provably one-sided and converge shoreward (8% at
  2 m, 0.3% at 0.2 m).
  **The GPU test caught a defect no oracle could:** WGSL `tanh` is lowered to
  `(e^(2x)−1)/(e^(2x)+1)`, which overflows f32 above x ≈ 44 and returns NaN — and
  `min(NaN, guard)` in WGSL returns the *guard*, so every short band silently took
  a 6× slope-gain ceiling across most of the shelf, at depths inside the shipped
  gate. Fixed by capping both `tanh` arguments at 20 (exactly 1.0 in f64 AND f32,
  so oracle and shader agree bit-for-bit in the saturated limit) and pinned by a
  source scan. Entirely fragment-side, evidenced rather than claimed: the ocean
  VERTEX hash is byte-identical to 6-2's while the fragment hash was re-pinned.

- **D-14 (2026-08-31, 6-8 landed — QR-2 and the far ramp turn out to be ONE
  quantity):** the item's real content is a representation split that is exact by
  construction: `rendered + deficit ≡ closure` and `shade + surface ≡ deficit` at
  every range (asserted to 12 decimals over a 0–8 km sweep). The canopy the
  renderer fails to draw is *shade* while you stand inside the stand and
  *surface* once you are outside it — so QR-2's under-canopy darkening and the
  far-field ramp are not two features but two views of the same residual, and
  that residual is measured (the authored field's 3.40 m mean crown against the
  5.80 m crown of the stems the law actually renders), not a tuning constant.
  **The channel costs nothing:** closure rides the alpha lane of both seasonal
  splat-weight textures, because the fourth material weight is redundant (the
  bake normalises each bucket) and the fragment reconstructs it as `1 − w0 − w1 −
  w2` — 0 atlas bytes against a 107 MiB channel atlas and a breached memory wall,
  0 new fragment samplers, and the reconstructed vector now sums to exactly 1
  where the stored one only did up to quantisation.
  **Lighting was calibrated, not albedo** — the recorded 4–7× lesson made
  executable: the canopy target is the impostor material's own measured response
  (albedo from the impostor atlas across all 7 species × 16 views, ambient 0.62
  = the impostor's own `environmentIntensity`), giving a **1.53% lit-luminance
  mismatch across the ring** where wave R's bug was +28% — and the suite carries a
  NEGATIVE CONTROL proving an albedo-identical canopy that keeps terrain's probe
  is 40.5% wrong.
  Its own test caught the first version of the coarse-LOD height lift raising
  ground at 400 m where stems still stand — which would sink drawn trees into the
  terrain. Height is now gated on the impostor-cull complement rather than the
  appearance ramp, so canopy volume is drawn exactly once at every range.
  **QR-4 is MOOT in its recorded form** (wave T left no hull silhouette to halo
  outside of) with its successor questions asserted on the shipped prototypes.
  **The horizon-shadow term is DECLINED with an architectural reason:** its donor
  is a page-atlas channel addressed by a per-vertex CDLOD slot lane that the
  detail path structurally cannot carry, because materials are shared across
  presentation chunks *by design* — that sharing being the draw-call architecture
  the ratchet exists to protect. Both feasible routes (marching the height
  pyramid in the impostor vertex shader; giving the pyramid 8-azimuth horizon
  layers) are recorded with costs and routed to 6-11, where QR-1 decides the same
  surface. Draws, instances and vegetation generation are byte-identical — the
  ratchet is not engaged — and analytic movement was measured against a
  reconstructed pre-6-8 classifier: dark-channel digest identical, live 18.19% of
  probes changing dominant material, in the correcting direction (the old
  classifier spent 30% of its weight on forest floor where 11% crown cover
  stands).

- **D-15 (2026-08-31, 6-5 landed — C-9 FULLY DISCHARGED, and one of this plan's
  own pins superseded):** the wetness field is a **maximum, not a sum** — ground
  is as wet as the wettest reason it has, and a max of terms each in [0,1] cannot
  leave [0,1], so 3-7's response stays in the range it was tuned on without a
  saturating clamp hiding a runaway term. Its three sources are sea/lake
  submergence, 6-2's swash persistence (composed, not restated — that block's
  self-containment is exactly what let it cross into a shader that has never
  heard of the water lattice), and a capillary rise that uses ONE height constant
  against two waterlines, converting signed shore distance to a freeboard through
  the same gradient source.
  **`lakeDepth` finally has a consumer, and it fixes a visible bug**: it answers
  a case `seaLevel − y` structurally cannot, because a lake at 400 m has hugely
  negative freeboard and was rendering as the WATER biome's primary material —
  dry sand, the brightest entry in the table. The consumer-per-channel table test
  now asserts **zero** pending channels.
  Judgment worth recording: it deliberately did NOT add a CPU delivery path,
  because "a `sampleLakeDepth` with no consumer would recreate C-9's exact defect
  one layer down".
  Economy: zero new samplers (r16float read by `textureLoad`, no companion
  sampler) and zero new uniform vec4s for two of three drivers, by repacking a
  lane whose `x` was 3-7's never-driven constant and whose `w` was reserved-zero.
  It also added an **exact** early-out — above 6.06 m of freeboard the ocean half
  cannot be non-zero for any slope — tested for exactness *and* tightness.
  **This supersedes the plan's own 6-5 pin, "analytic captures byte-stable".**
  That pin was written when the item was scoped lake-only; 6-2's depth-test
  geometry (D-12) means the ocean disk *cannot* draw the sheet above the
  waterline, so the wet strip is necessarily terrain-side and therefore
  analytic-visible. Measured: 1.111% of field probes move, in a window of exactly
  freeboard ∈ [−0.9996, +1.4435] m; 0.556% of a 160,801-sample world grid; the
  wet band is 13/24/44 m wide (p10/median/p90) across 119 shore transects. Only
  **3 of 24 shots** frame a shoreline, and at coast-10km-lowsun the band projects
  to well under a pixel of vertical extent. **An R2 rebaseline is owed for those
  three shots.** Continuity was measured both ways: with the swell removed the
  composed field has ZERO steps (largest 9e-4), and with it, exactly one — 6-2's
  own documented uprush arrival.

- **D-16 (2026-08-31, 6-9 landed — WAVE 3 COMPLETE; it fixed a real meter bug and
  found R4's sharp edge on the device):** wave G's two debts are paid —
  `groundCoverCompute` is a real `ComputeBudget` client with a measured seed and
  its own budget row, and the governor gained the ground-cover rung P-5 specified
  (multiplying the altitude gate, so radii and per-lane survival move while
  lattice sizes and dispatch counts stay fixed).
  **A wrong assumption, measured and then fixed in the mechanism rather than
  argued away:** the agent first reasoned that declaring the new client LAST made
  a late declaration safe. It is not — the reservation pass runs for every client
  before the surplus pass, so a new low-priority reservation preempted a
  high-priority client's surplus and occlusion dropped 2 → 1 dispatches. The fix
  went into the meter: **reading an admission settles it** (count frozen,
  milliseconds charged), pinned by test.
  **R4's real trap was found on hardware, and it is not the one R4 predicted:**
  `Constants.RENDERPASS_MAIN` (0) is NOT the id the main pass draws under —
  `Scene.render` uses `activeCamera.outputRenderTarget?.renderPassId ??
  activeCamera.renderPassId`. A blade mesh carried TWO draw wrappers (id 0
  non-instanced, the camera's id 1 instanced) and **both had indirect buffers**,
  so writing id 0's succeeds completely, raises no validation error, and fixes a
  pass that never draws. Resolved via a runtime `mainRenderPassId()` that rebinds
  when the id changes.
  Compliance is as R4 demands: CPU readback is the DEFAULT (through a 3-deep
  counter ring so a re-zero cannot outrun a copy), indirect is opt-in behind a
  loud capability assertion with a private-API existence test reading the
  installed Babylon sources, `@babylonjs/core` is pinned exactly, and only the
  main pass is culled while shadow and reflection take a conservative count.
  Drawn blade instances fell **39.6%** (107,592 → 64,932) with draw calls
  unchanged and +0.0157 MiB of memory. **The ratchet was NOT engaged:** no count
  row moved upward, every population fell, and the freed budget is deliberately
  left *available but unbooked* — booking wave T's leaf-spray layers would raise
  inventoried memory at a shot already over its ceiling, and that needs a
  reference-host capture this item was not permitted to run.

- **D-17 (2026-08-31, the "environmental flake" was a real race, and it is fixed):**
  `tests/gpu/terrain-page-erosion-cost.test.ts` failing with
  `drainageHeight[0] must be finite` was attributed to host contention by FOUR
  separate agents across Gate W and Waves 1–3, and documented as environmental
  twice. It was not. `runReadbackAndMfd` issued four `StorageBuffer.read()`s
  through `Promise.all`; concurrent reads race Babylon's staging/`mapAsync`
  machinery, and a copy that has not been submitted when its map resolves yields
  **zeros rather than an error**. Zero then decodes to `~0 >>> 0` = 0xFFFFFFFF =
  NaN, the NaN flows into the MFD stage, and the run dies hundreds of lines away
  naming a symptom in a different subsystem — which is exactly why four
  investigations stopped at "contention".
  The fault is *detectable* because of an arithmetic property of the encoding,
  now proven by test rather than assumed: `pOrderableEncode` maps a positive
  float to `bits | 0x80000000` (high bit always set) and a negative one to
  `~bits` (zero only for the NaN payload 0xFFFFFFFF), so **zero is not a legal
  encoding of any finite float** and an all-zero buffer is unambiguous evidence
  the copy never landed. Three changes: the reads are **serialized** (one queue,
  same submits, no measurable cost, no race); a faulted readback is **retried
  once** because the GPU buffer still holds the result, so it is recoverable
  rather than fatal; and `decodeOrderableFloatBits` now refuses a faulted buffer
  with `TerrainErosionReadbackFaultError`, naming the readback instead of the
  arithmetic. Result: the full GPU suite is **41 files / 90 tests, zero
  failures**, where the same suite had been intermittently red on a quiet tree.
  Lesson worth carrying: "flaky under load" is a hypothesis, not a diagnosis —
  and a guard that turns an impossible value into a *named* error is what turns
  a four-agent misdirection into a one-line fix.

- **D-18 (2026-08-31, the Wave 1–3 rebaseline is REFUSED — the review caught a
  real regression that every gate passed):** the candidate run cleared EVERY
  non-SSIM gate — strict tier-1 delivery (min 118.75 wall fps, worst p95 10.2 ms,
  zero hitches), Gate 0-a's re-pinned floors, the drawCall ceilings, inventoried
  memory at 492.3 MiB, content, settling and renderer errors — and it is still
  not promotable. Reading the frames, which the house rule requires and which no
  number substitutes for:
  * **`grove-forest-2m` (luma 0.6191, worst tile 0.4222) is a REGRESSION.** The
    forest floor's brown litter and mottled micro-detail are gone, replaced by a
    flat, uniform bright-green sward — a forest floor rendered as a meadow — with
    unexplained grey-blue rounded shapes scattered among the blades.
  * `ground-2m-lowsun` (0.9423) by contrast is FINE: slightly sparser ground
    cover, consistent with 6-9's measured −39.6% blade instances.
  Two distinct suspects, both to be confirmed by ablation rather than guessed:
  (a) **6-8's closure → classifier coupling** appears to under-read crown cover
  in the near field, flipping the dominant ground material from forest floor to
  grass exactly where canopy is densest. Its own broad-probe measurement
  (ForestFloor −2.78 pp, Grass +3.11 pp) did not reveal this because averaging
  over ~19 km of mixed terrain hides a large flip confined to closed groves —
  the measurement was real but not diagnostic of the case that matters.
  (b) **6-9's new ground-cover archetypes** (fern/heather/reed) appear to render
  grey-blue rather than as vegetation, suggesting a wrong albedo or material
  binding on the generalised lanes.
  The breadth is also unexplained: shots predicted byte-identical by their own
  items moved (`coast-10km-lowsun` 0.9826, `runway-on-approach` 0.9744,
  `grove-meadow-2m` 0.9709), and near-sky shots moved too (`night` 0.9767,
  `slant-10km` 0.9640). Some of that is legitimately 6-8's global ground-material
  shift, but each prediction that failed is a claim to re-check, not to absorb.
  **This is precisely the failure mode the phase's own rules exist to catch** —
  "a green test suite is not evidence of anything visual" — and it is the reason
  a rebaseline requires frame-by-frame review before promotion rather than after.

- **D-19 (2026-08-31, D-18's regression diagnosed — the closure channel was
  baked from a DIFFERENT WORLD, and 6-8's coupling was innocent):** the ground
  defect is not in the classifier. Its two seams, their signs and their gains
  are all correct *given closure*; what reached them was another world's canopy.
  **A world carries two seeds.** `createWorld`'s guaranteed-airport search
  replaces `world.seedHash` with the chosen region's, while every plant is
  placed from `hashSeed(String(world.seed))` = `world.sourceSeedHash` — which
  `FlightRenderer` states outright where it builds `GroundCoverSystem` ("the
  field and the cards must key the SAME realisation or the handoff at the field
  radius swaps species"). `6-8` appended the vegetation density field's eleven
  lattices to the TERRAIN kernel's page uniform, where they silently inherited
  the terrain seed. Measured at the `grove-forest-2m` camera: **closure 0.008
  baked against 0.90 standing, 2 stems/ha against 630/ha** — and
  `generateDetailCell` independently places **509 stems/ha within 30 m** there.
  At 0.008 the forest-floor gain is ×1.004 and the sward gain ×1.32, so a 3.6%
  pre-6-8 suitability margin became a 32% margin for grass; at the true 0.90
  they are ×1.50 and ×1.04 and forest floor wins. Over the framed 320 m box the
  dominant material flips to grass at **51 of 81** probes with the wrong seed
  and **7 of 81** with the right one. `TerrainKernelPageInput` gains
  `extraSeedHash` (omitted is byte-identical; it moves exactly the appended
  lattices' 44 seed bytes), `PageSplatBake` takes the vegetation seed, and
  `TerrainClipmapSystem` passes `sourceSeedHash`.
  **D-18's hypothesis (a) was right about the symptom and wrong about the
  cause:** the under-read is real (74× in stem density) but it is not
  "densest-canopy-specific" and it is not a sign or magnitude error in the
  coupling — a seed mismatch is uncorrelated with canopy density. **D-14's own
  probe could not have caught it**, and that is structural rather than
  unlucky: it classifies the same probe set with and without the channel using
  ONE seed for both, so a seed mismatch is invisible to it by construction. Its
  −2.78 pp / +3.11 pp is reproduced here (−2.50 / +2.50 over 9,679 probes) and
  is a real measurement of a coupling that was reading fiction.
  **Fixing the seed exposed a second, older wrong field.** `ground-2m-lowsun`
  regressed (0.9423 → 0.8539) because the bake's airport influence was
  `1 - length(p - centre)/blend` — a 240 m **disc** about the runway centre —
  under a comment already claiming "the same rounded-rectangle field the
  earthworks key on". A 1,320 m runway is five times longer than that disc, so
  the bake read **0.000** where `getAirportInfluence` returns **0.807**: the
  classifier lost its `airfield * 2.4` mown-grass decree AND `splatCanopy` lost
  the apron's woody-stem clearance, so the ground grew a closed stand (0.810
  closure) where the renderer plants ~88 stems/ha. `splatAirportInfluence` now
  transliterates `worldToRunway` + `roundedRectangleSignedDistance` +
  `getAirportInfluence` through a new `runway` job lane; parity against the CPU
  oracle over a 3.2 km sweep is **2.2e-16**, and `smoothstep(0, blend, d) ≡
  smoothstep(0, 1, d/blend)` means no constant was added. It also repairs a
  latent case: with NO airport the old form returned influence **1 everywhere**
  (its inverse blend radius was 0, so the term it scaled vanished with it).
  **`6-9`'s blobs are a units error, not a binding one:** the archetype
  `color` rows are the CARD path's instance tints, copied verbatim from
  `generation.ts`'s `buildGroundCoverGrid`, where they multiply a textured
  card — and the blade path mixed them ADDITIVELY into the ground's *linear*
  albedo. The grass row proves the units: `[0.42, 0.56, 0.30]` against the
  Grass material's `referenceAlbedo` `[0.118, 0.183, 0.058]`, a factor of
  3.1–3.6, invisible only because grass's `colorMix` is 0. Fern/heather/reed at
  mix 0.5–0.62 rendered at linear luminance 0.32–0.36 against a forest floor of
  0.084 — **3.5–3.9× too bright**, desaturated toward the tint's own grey.
  `groundCoverArchetypeAlbedoTint` divides each row by the reference row and
  the vertex stage MULTIPLIES, which lands every archetype at 0.92–1.06× the
  ground and leaves grass byte-identical. No constant was retuned; the table's
  docblock already declared grass the reference.
  Result on the reviewed frames: `grove-forest-2m` 0.6191 → **0.7321** (worst
  tile 0.4222 → 0.5297) with brown litter, mottling and in-palette blades
  restored; `ground-2m-lowsun` back to **0.9387** from 0.8539; and
  `runway-on-approach` **improved** to 0.9765 (worst tile 0.8621 → **0.9420**)
  because the apron is mown grass again. Lesson worth carrying: **a channel
  handed from one authority to another must carry that authority's seed and its
  drivers, or it describes a world that is not being drawn** — and neither a
  green suite nor a before/after probe that substitutes the same wrong input on
  both sides can see it.

- **D-20 (2026-08-31, D-17 was right but INCOMPLETE — the real cause was a
  missing explicit flush, and the guard is what found it):** the 6-8 fix agent
  challenged D-17 with evidence — the erosion cost test still failed, now 3/3
  deterministically on an idle machine, which the contention theory cannot
  explain. It was correct to push back. Serializing the reads removed a genuine
  hazard but not the dominant one: **Babylon defers a plain `StorageBuffer.read()`
  to the next frame's submit**, so in any context without a render loop pumping
  frames — the GPU cost test, any headless harness — the recorded DAG dispatches
  are never submitted and every buffer reads back as freshly-allocated zeros.
  The macro producers already carry `noDelay: true` for exactly this reason and
  say so in a comment ("startup has no render loop pumping frames, so the flush
  must be explicit"); the page DAG's two readbacks omitted it. Adding it turns the
  test from a deterministic failure into a pass (283 ms failing → 1,058 ms green).
  **The part worth keeping is why this was findable at all.** Before D-17's guard,
  the zeros decoded to NaN and the cost test *passed with garbage* — it measures
  dispatch timings, not correctness, so a page full of NaN heights still produced
  plausible milliseconds. The guard converted a silent corruption into a named
  error at the point of failure, which is what let the next investigator reach the
  real mechanism in one step instead of five. A guard that fires on an impossible
  value earns its keep even when its author's diagnosis is only half right.

- **D-21 (2026-08-31, R1+R2+R3 reviewed and APPROVED — every moved shot traced to
  a landed item, and the two shots that looked wrong were not):** capture
  `2026-08-31T16-39-53.222Z`, 24/24 shots, all enforced gates green with margin
  (min wall 117.73 fps against a 60 floor, worst p95 9.80 ms against 16.67, zero
  hitches, zero frames over 27.4 ms, max frame 18.10 ms). The review was run as
  the D-18 rule requires — *a shot that moves against its own item's prediction is
  a defect to investigate, not a rebaseline to absorb* — and two shots did move
  against prediction. Both were chased to the source before approval:
  1. **`night`, worst-tile RGB SSIM 0.5568.** Not a defect: the frames are
     visually identical and the shot's mean luminance is 10.2/255. SSIM is
     unstable on near-uniform dark tiles, so the *worst-tile* statistic collapses
     on a shot that is mostly black while its whole-frame value stays 0.980.
     Worst-tile is the right gate for lit shots and a false alarm on `night`.
  2. **`canopy-1200ft` +9.7% mean luminance, `grove-forest-2m` −13.0%** — opposite
     directions, which is what made it look like a defect. Attributed at first to
     6-6, whose §6 line promises "Analytic: sentinel fallback to today's moisture
     proxy", and D-10 records analytic byte-identity. **That attribution was
     wrong, and checking it rather than trusting it is the point.** The mover is
     6-8's `canopyClosure`/`grassCover` seams, which
     [LandCoverClassifier.ts:420-423](src/render/webgpu/terrain/LandCoverClassifier.ts)
     documents as deliberately live in BOTH worlds and carrying no zero-sentinel,
     on the stated ground that a canopy is a vegetation property, not an erosion
     product. 6-6's soilDepth is separately gated (`if (input.soilDepthValid <
     0.5) { return 0.0; }`) and
     [generation.ts:1136](src/render/webgpu/detail/generation.ts) states the
     analytic case explicitly: no soil channel, no `soilDepthMeters`, every
     downstream number bit-identical. **D-10 stands and the parity test is not
     decorative** — its "channel omitted" probe *is* the real analytic case.
  The pixel change is an improvement in both directions and corrects a defect of
  the same family as D-18: closure now separates the two cases that were
  previously conflated. Under closed canopy the floor reads leaf litter; in
  glades and open pasture it reads grass. `approach-500ft` is the clearest
  evidence — a lowland approach that was flat grey-brown dirt is now green
  pasture. The meadow/forest pair is the discriminating test and it passes:
  `grove-meadow-2m` keeps its sward (−2.6%) and grows a litter band only under
  the treeline, while `grove-forest-2m` turns to duff throughout.
  Remaining predictions verified by measurement, not eye: `water-3m` puts 80% of
  its difference in 35 of 720 rows (y=270..305), a crisp waterline band, which is
  6-5/6-2 as predicted; `coast-10km-lowsun`'s movement is in the land region at
  ~1.2% magnitude, so it is 6-8 rather than a waterline defect; `cruise-horizon`
  moves at noise level (max row delta 1.47/255).
  **Floors deliberately NOT re-pinned, against §1.2's "re-pinned at each"
  instruction.** The documented rule is
  [`floor(min-across-runs × 0.85)`](scripts/perf-capture.mts:72) and this is ONE
  run on a cool host. Per [[flyhigh-capture-host-thermal]] the same tree measures
  ~20% apart cold vs warm; the standing floors (98–102) came from three runs
  whose warm minima were ~101–103, and re-deriving from this run's 117.7–120.2
  yields 100–102 — i.e. numerically indistinguishable from the current pins while
  being sampled entirely from the favourable end of the drift band. Re-pinning
  would encode a cool-host bias for no gain, so the pins stay and this paragraph
  is the recorded decision §1.2 asks for. Re-pin properly at R4, from ≥3 runs.
  **Carried forward as a constraint, not a finding:** draw-call slack is a
  near-uniform +8 across all 24 shots (+7 on `mountain-close`, ~5%), and
  inventoried GPU memory is 492.3 MiB against the 495 ceiling — 0.5% headroom.
  6-11's tier sweep and Phase 7 have very little room in either.

- **D-22 (2026-08-31, 6-11.4 landed — the sampler contract was wrong in BOTH
  directions, and the enforcement it cited did not exist):**
  `tests/gpu/terrain-sampler-budget.test.ts` now derives the sampled-binding set
  from `effect.fragmentSourceCode`/`vertexSourceCode` and pins
  `TERRAIN_SAMPLED_BINDINGS` against it, in two compiled permutations. What the
  measurement found:
  1. **Six PBR samplers the material never declares** (`albedoSampler`,
     `bumpSampler`, `reflectivitySampler`, `reflectionSampler`,
     `metallicReflectanceSampler`, `lightmapSampler`) were listed, while
     `environmentBrdfSampler` and the shadow sampler a `receiveShadows` mesh
     compiles in were both missing. Measured fragment total is **10**, not the
     listed 15 — a fourth number, matching none of the 11 / 8 / 15 in
     circulation.
  2. **The vertex list was wrong too, and its correct value is EMPTY.** The
     CDLOD vertex stage binds `terrainHeightAtlas` but reconstructs bilinear
     from four `textureLoad`s at the texel corners, so it declares no sampler.
     Listing it is what a declaration-site reading gives you rather than a
     compiled-source one.
  3. **The docstring claimed "the material factory asserts these against
     `engine.getCaps().maxTexturesImageUnits` (assertion 70c)". No such
     assertion existed** — the only occurrence of that capability name anywhere
     in `src/` was inside the claim itself. The list asserted a model, and the
     enforcement it named was fictional.
  4. **6-5's hydrology permutation costs ZERO sampled bindings, not one or
     two** — stronger than its own headroom paragraph assumed. Both channels are
     `textureLoad` reads: shore distance is r16sint (an integer texture cannot be
     filtered, so it needs no sampler by rule) and lake depth is r16float read at
     an exact texel. Recorded as `TERRAIN_HYDROLOGY_ADDS_SAMPLED_BINDINGS = 0`
     and asserted by compiling both permutations, so the zero is measured rather
     than argued.
  **A trap worth carrying:** the first version of this test compiled a scene
  with only a `HemisphericLight` and measured 9 bindings. That permutation is
  NARROWER than ships — the shipping beauty mesh sets `receiveShadows = true`
  (`TerrainClipmapSystem.ts:498`) under a cascaded generator, which adds a
  sampler. Pinning from it would have replaced a wrong number with a differently
  wrong number while looking rigorous, so the harness now builds the sun and CSM
  too. *Deriving from the artifact is necessary but not sufficient: the artifact
  has to be the one that ships.* Babylon suffixes the shadow sampler with the
  light's scene index, which is scene construction rather than a material
  property, so the derivation normalises it; exactly one generator ships
  (`AtmosphereSystem` builds one for the sun, and 7-1's moon is deliberately not
  a caster). The empty vertex expectation is separately guarded against
  vacuity — an empty set passes both when the stage samples nothing and when it
  never compiled, so the test also asserts the atlas IS declared and IS read by
  `textureLoad` with no companion sampler.

- **D-23 (2026-08-31, GATE F FAILED — the eroded world rendered flat, and the
  cause was one missing `switch` case that no test could reach):** Jason flew
  `?world=eroded` and reported "no mountains, no terrain or anything, just a
  green floating mess". Reproduced immediately, then root-caused by measurement.
  **Mechanism.** `TerrainPageErosionGpu.demand()` answers the admission meter
  with the current DAG stage's remaining dispatch count. W-4 added a `fine-band`
  stage and wired it into the stage union, `advance()`, both ping-pong shaders,
  the measured cost row (`fineBand: 0.082`) and the cost trackers — **but not
  into `demand()`'s switch**, whose `default` returned zero. Every link after
  that is silent:
  `demand → 0` → the clipmap never submits → `ComputeBudget.admitted` returns 0
  for a client that never submitted → `dispatchPageGeneration` returns at its
  `admitted <= 0` guard → the page is never pumped again → **no eroded page ever
  becomes resident** → the terrain draws with no height data.
  Measured, not inferred: the capture report reads `resident=0 pending=40` on
  every eroded shot before the fix and `resident=70/116/168 pending=0` after,
  with triangles rising 810k → 2.0–2.4M. A probe driving the DAG through a real
  `ComputeBudget` never converged in 2,000 frames (28 pumped, 1,972 admitted
  zero, **1,970 frames parked in `fine-band`**) and converges in 31 after.
  **Why nineteen days of green instruments could not see it.** The GPU harness
  pumps the producer unconditionally, once per frame. The renderer pumps only
  what the meter admits. So `demand()` — the function that failed — *was not
  called by any test in the project*. Byte-determinism, seam audits, CPU-oracle
  tolerance parity, the statistics suites and the timing tests were all
  meaningful and all green, and none of them could reach the defect, because
  every one of them drives a pump loop the application does not use. The general
  rule, now a memory: **a test that drives a subsystem differently from
  production is not testing production**, and the difference is usually the
  convenience that made the harness easy to write.
  **The fix is two changes, one of them the class fix.** The `fine-band` case,
  banded like geology; and `default:` now fails **OPEN** (one dispatch) instead
  of **CLOSED** (zero), behind a `never` exhaustiveness check so the next stage
  added to the DAG is a compile error rather than a flat world. An admission
  meter that stops asking when it meets a stage it does not recognise has its
  failure direction backwards. The exhaustiveness check paid immediately: it
  caught a second unhandled member (`idle`) at the first compile.
  **Instruments landed** (this is the deliverable, not the fix):
  1. `tests/gpu/terrain-erosion-live-pump.test.ts` — drives the DAG through a
     real `ComputeBudget` exactly as the renderer does, and asserts structurally
     that only async/terminal stages may report zero demand. **Both tests were
     verified to FAIL on the reintroduced defect** and to name the offending
     stage in the failure message.
  2. Three `eroded-*` shots appended to the capture list — the eroded world is
     now *rendered and reviewed*, which W-7 left undone and which is the actual
     root cause of a broken world reaching a human first.
  3. The capture harness wrote its frames only **after** every gate passed, so
     the first failing gate produced **no images at all** — the instrument
     withheld its evidence exactly when something was wrong. Frames are now
     written BEFORE the gates, with the "a failed run must not look promotable"
     property preserved explicitly by a `STATUS.txt` that reads NOT APPROVABLE
     until every gate passes.
  **Two findings this exposed that are NOT fixed and must not be closed
  silently:** eroded inventoried GPU memory is **527.5 MiB against the 495
  ceiling**, which fails on its own terms; and a water body renders as a flat
  opaque sheet in `eroded-valley-500ft`, visible in the post-fix frame.
  **GATE F IS NOT CLOSED, and this deviation must not be read as closing it.**
  The deadlock above is real, is fixed, and is proven fixed *in the capture
  harness*. Whether the live app is still broken **is unknown**, and the honest
  statement of why is itself worth recording.
  **RETRACTED — the post-fix live-app observations, mine and the PM session's
  alike.** Both of us watched the eroded world in the in-app Browser pane and
  reported it still flat (me for 110+ seconds, the PM for ~5 minutes, with
  "20 / 60 / 85 s to ready" load figures). Per
  [[browser-pane-raf-paint-gated]] **that pane only advances frames when it
  paints**, and a hidden pane paints when something forces it — so the app was
  frame-starved throughout and the eroded path was barely pumped. None of those
  numbers are load times and none of them show the world failing to fill in.
  The rule was already written down after costing time once before; it cost time
  again here, in two sessions at once. *A timing or streaming observation taken
  in that pane is not evidence.*
  What survives the retraction: **Jason's original report**, from a normally
  painting browser, which is the primary evidence and is untouched; and the
  **A/B**, because analytic-correct and eroded-flat were observed under the same
  starvation, so the comparison is controlled even though the absolute timings
  are junk.
  **Measured throughput, which is real and points somewhere.** The live-pump
  test settles one L3 page in **31 frames** driven through a real
  `ComputeBudget` at tier-1 medium (29 of them pumped), and the producer holds
  exactly ONE page in flight. A working set of 70/116/168 pages — the three
  eroded shots' measured residency — therefore projects to roughly 2,200/3,600/
  5,200 frames, i.e. **36/60/87 seconds at 60 fps**, against W-1's ≤1.5 s exit
  target. If that is what the app does, the eroded world is not broken so much
  as unusably slow to fill, and it would look exactly like Jason's report for
  the first minute of a flight.
  **Not evidence, and recorded so nobody re-derives it as such:** the residency
  growth across the three eroded shots (70 → 116 → 168) is NOT progressive
  fill-in. Those shots sit at 3,048 m, 600 m and 150 m AGL, so a larger working
  set at lower altitude explains it entirely.
  **The harness/app divergence is now QUANTIFIED, and it is not a code path —
  it is a frame budget.** The capture's streaming loop runs up to
  `maxStreamingFrames = 6_000` frames per shot *as fast as the machine allows*,
  breaking early only once `pendingTerrainPages === 0`. At the measured 31
  frames per page, serial, the deepest eroded shot's 168-page working set costs
  **5,208 frames — 87% of that budget**, which is why the harness reaches
  `pending=0` and renders correctly. The app runs the identical 5,208 frames at
  60 fps: **~87 seconds**. Same code, same work, same result — the capture is
  simply fast-forwarding, and the app is not. This closes the "what does the
  harness do differently" question for this defect without needing a browser at
  all, and it accounts for every observation: correct in-harness, flat for the
  first minute-plus in a real session, and completely silent because nothing
  fails — it is only slow.
  **A near-miss, now MEASURED and worse than projected — fixed.** Instrumenting
  the streaming loop shows `eroded-cruise-horizon` settling in **5,700 frames,
  95% of the old 6,000 budget** (the other eroded shots at 4,320 and 3,780;
  every analytic shot at 360–840, i.e. 1.5–3.5%). One more page and the capture
  would have exhausted the loop, screenshotted a PARTIALLY STREAMED world,
  recorded the `pendingTerrainPages > 0` that proved it, and passed.
  It would have passed because the "streaming finished" assertion existed only
  inside `if (isMotion)` — and **exactly three** shots declare `kind: "motion"`,
  none of them eroded. The 24 static shots recorded the number and asserted
  nothing against it, while the neighbouring `pendingDetailWork` was asserted to
  be 0 for every shot unconditionally. Detail was guarded; terrain was not.
  Three changes: `pendingTerrainPages === 0` is now asserted for every shot that
  does not carry an explicit `residencyCeilings` allowance (the two
  streaming-stress shots keep theirs, since a rising queue is what they exist to
  measure); `maxStreamingFrames` is raised to 24,000, which is only safe because
  exhausting it is now loud; and the **margin itself is asserted** — a shot
  using more than 75% of its budget fails while there is still room, so the shot
  creeping toward the cap is caught on the run before the one that crosses it.
  Worst shot is now 23.8%.
  **A correction to my own model, recorded so it is not re-derived:** I
  projected 5,208 frames from `168 resident pages × 31 frames/page`. The real
  worst case is a shot with FEWER resident pages (70) and MORE frames (5,700),
  because `residentTerrainPages` at capture is not the number of pages
  *streamed* — a high-altitude shot cycles pages through the atlas and evicts
  them, so residency at the end undercounts the work. Per-page cost times final
  residency is a lower bound, not an estimate.
  **The remaining test needs a normally painting browser:** load eroded, fly for
  one to two minutes, and watch whether relief progressively appears. This is
  now confirmation of a quantified prediction rather than an open question — the
  prediction is that relief fills in over roughly a minute and a half. It could
  not be run from either session: the in-app pane cannot paint, and the Chrome
  extension is not connected. Progressive fill-in confirms the throughput account and
  makes this a performance defect; permanently flat means something still never
  writes. Neither session can run it — the PM's pane cannot paint, and this
  session's harness is the environment already known to diverge from the app.
  **Separately real either way:** a provisional (admitted but not yet written)
  page should show the ANALYTIC FALLBACK, not zero height. That is the
  difference between "the eroded world loads in slowly" and "the eroded world is
  broken until it finishes", and it is the behaviour a player actually meets.
  Do not promote an eroded baseline, and do not report Gate F as passed, until a
  live flight in a real browser shows relief.

- **D-24 (2026-08-31, §8 RESOLVED NO — the eroded world is SHELVED, not
  cancelled, and analytic ships):** Jason re-flew the eroded world after D-23's
  fix and called it. This is §8's planned branch, taken on its own terms: *"If
  any fails, the analytic default ships on and eroded stays a flag — that
  outcome is acceptable by Q1's own terms and is not a phase failure."* The code
  stays in the tree behind `?world=eroded`. What stops is spending effort on it.
  **Work stopped, all of it eroded-only:** D-7 (canonical-split lattice
  snapping), D-9 (re-tighten CPU/GPU parity bounds after D-7), the streaming
  throughput fix, the provisional analytic-fallback for unwritten pages, the
  eroded memory overage (527.5 MiB vs the 495 ceiling — an ANALYTIC capture
  reads 492.3 and fits), W-4's two unmet targets, and all eroded capture work.
  None of these gate an analytic ship.

  **What Waves 1–3 actually delivered on the shipping path.** Verdicts traced to
  the mechanism, not inferred from the sequencing table:
  | item | analytic | mechanism |
  |---|---|---|
  | **6-1** flow advection, standing waves, lake chop | **DARK — both halves** | Every 6-1 term sits inside `if (input.waterInfo.w > 0.0)` ([HydrologySystem.ts:314](src/render/webgpu/water/HydrologySystem.ts)). The w lane is written by four builders: `appendRiver` and `appendLake` (analytic) push a literal `0`; only `appendGraphRiver` and `appendGraphLake` push a payload. **The lake-chop half is dark too** — fetch reaches the shader solely through `appendGraphLake`, so an analytic lake has no fetch and no chop. |
  | **6-2** run-up, streaking, wet sand | **PARTIAL** | The OCEAN half is visible: it lives in `SpectralOceanSystem`/`WaterShaders` with no evolution dependency. The INLAND half (bank run-up, bank normal) is inside the same `waterInfo.w` sentinel and is dark. |
  | **6-3** shoaling and breaking | **VISIBLE** | Ocean-only by construction ("an inland lake has no continental shelf to shoal across") and driven by `BathymetryClipmap`, which has a first-class analytic path — `if (worldEvolution === "analytic" \|\| macro === null) return analyticHeightMeters`. The `6-3←W-6` row was a sequencing dependency on the eroded OVERLAY, not a data dependency; the analytic seabed predates it. |
  | **6-5** lake wetness / shore distance | **DARK** | Its fragment block is behind `TERRAIN_SURFACE_HYDROLOGY_CHANNELS`, which requires both hydrology atlases bound, and the channel atlas only requests hydrology when eroded. Compile-time dark, not merely pixel-dark. |
  | **6-6** ecology channels | **DARK by design** | `soilDepth` is gated on `soilDepthValid`, false analytically, and the analytic path is the pre-6-6 moisture proxy — bit-identical by measurement (D-10). |
  | **6-7** talus/scree | **VISIBLE** | D-11: the placement law runs in BOTH worlds and corrects a real defect in shipped analytic code (2-15's inverted slope term). |
  | **6-8** canopy/grass seams | **VISIBLE** | Deliberately no sentinel — a canopy is a vegetation property, not an erosion product. Proven in the R1–R3 frames: litter under closed canopy, grass in glades. |
  So Wave 1 ships **6-3 whole, 6-2's ocean half, and none of 6-1**; Waves 2–3
  ship **6-7 and 6-8 whole**. The honest summary is that the water-motion wave
  landed about half its visible value on the shipping path, and the ecology wave
  landed nearly all of it.

  **The three `eroded-*` capture shots were REMOVED, not skipped.** Removal is
  safe *here specifically*: temporal phase is keyed by canonical INDEX
  (`PERF_CAPTURE_SHOTS.findIndex` by name → `simulationTime = 500 + index*120`),
  and these were the trailing entries, so no surviving shot's index moves and
  every analytic shot keeps its exact phase and pixels. The append-only rule
  still binds for INSERTION; this is a tail truncation. They could not simply be
  left in place: `readBaselinePixels` is called with `required = !REBASELINE`,
  so a shot with no committed baseline is fatal to a normal capture, and they
  were never promoted. Gating them out instead would still have spent ~17,000
  streaming frames per run on a shelved feature. Their definitions are recorded
  in this deviation's history for whoever revives the work.

  **The one-sentence account, and it is not a defect description.** The right
  framing is d6's: ***Gate W's instrument set could not see its own product.***
  Every instrument the gate had was a proxy — byte-determinism, seam
  bit-equality, statistics distributions, dispatch timings, and analytic capture
  shots which *by construction* never render the eroded world. Each was
  individually sound and each passed honestly. The gate simply had no instrument
  of the form *look at the thing it makes*, and W-7 — the item that would have
  added one — is the item that was held for Gate F. That is a structural fact
  about how the gate was assembled, and it is worth more to a resumer, or to
  anyone assembling a future gate, than "it rendered flat".

  **Parking record — what a reviver must read first.** The eroded world is ~90%
  working and cost 19 days. Known state: (0) **D-9's loosening now outlives its
  cause and is the FIRST thing to re-tighten.** It loosened CPU/GPU page
  agreement pending D-7, and D-7 is shelved, so a temporary concession has
  become permanent — which D-9 itself named as the way one becomes permission.
  Scoped and contained: `worstAbsoluteToleranceMeters: 0.06` lives in the
  eroded-only `TerrainPageErosionGpu.ts`, asserted at one site in
  `tests/gpu/terrain-page-erosion-gpu.test.ts`, so it weakens only the shelved
  producer and touches nothing analytic. No ship risk; re-tighten alongside D-7,
  whose fix is known (snap the lattice origin to the 512 m world block rather
  than to the evaluating page's own origin). (1) the `fine-band` admission
  deadlock
  is FIXED (D-23) and regression-tested; (2) fill-in is throughput-bound at ~31
  frames/page with one page in flight, so a real session takes ~90 s to build a
  working set — the likely reason it still looked broken in flight; (3) an
  admitted-but-unwritten page renders ZERO HEIGHT rather than the analytic
  fallback, which is what makes a slow fill look like a broken world and is
  probably the highest-value single fix; (4) eroded inventoried GPU memory is
  527.5 MiB against a 495 ceiling; (5) D-7 and D-9 remain open; (6) **the global
  height pyramid is analytic-only and the page occlusion bake mixes it with
  eroded page heights** — `GlobalHeightPyramid` bakes from `terrainNaturalHeight`
  with no eroded path, while `PageOcclusionBake.occlusionHeightAt` reads the
  eroded height atlas inside the page and falls through to the analytic pyramid
  beyond it, so an eroded horizon march steps from eroded to analytic heights at
  the page boundary and marches analytic for the remaining ~44 km. That
  reintroduces exactly the discontinuity 4-7's pyramid exists to remove, via a
  data mismatch rather than reach, and it would be worst in the deep valleys
  erosion exists to carve. Unmeasured and deliberately so; the two resolutions
  (bake the pyramid from the eroded field, or accept and document the near/far
  split) are a DECISION, recorded here so it is made once rather than
  rediscovered. Credit: surfaced by `nifty-williamson`, verified independently.
  The same property makes the horizon-shadow work structurally free of eroded
  dependencies, so its 4-8b argument stands unchanged on the shipping path.

  **Remaining Phase 6 scope, analytic only:** 6-11 (four-tier × three-viewport
  sweep, QR-1, cold-start, memory truth — where the ceiling question is now
  simply 492.3 against 495 and fits), 6-12 (documentation truth, including this
  shelving), the horizon-shadow merge with its same-host A/B pin, and one §8 row.

- **D-25 (2026-08-31, the wave-R vegetation horizon-shadow term lands — it is
  not a late feature, it is the unpaid half of `4-8b`):** `6-8` declined this
  and routed it to `6-11`. Its reason was sound and survives: the terrain's
  horizon map is a page-atlas channel addressed through a per-vertex CDLOD slot
  lane, and `DetailInstanceMaterialPlugin` materials are SHARED across every
  presentation chunk — that sharing being the draw-call architecture the
  `RENDERING_PLAN.md:837` ratchet protects — so no per-chunk page uniform can
  reach the detail path. `6-8` also named the condition under which either
  route becomes admissible: **extract the horizon operator into a shared WGSL
  include so both consumers run one operator.** This item is that extraction
  first and the feature second.
  **The justification is a conditional licence the tree already took.**
  `RENDERING_PLAN.md:360` (the `4-8` row): "**Now** it is safe to shorten the
  distance: the horizon map covers everything beyond. Doing it earlier leaves
  distant mountains unshadowed for months." `PHASE_4_EXECUTION_PLAN.md:231`
  states it as a rule — `4-8b` "may only shorten the shadow distance once the
  horizon map is actually being sampled". §5.4's budget row
  (`RENDERING_PLAN.md:849`) says *terrain* leaves the far field, and only
  terrain; `QualityProfile.ts:284` says the cascades "stop being a distance
  instrument and become a CONTACT one". The licence was taken for every
  representation and paid for one: impostors sampled no horizon map at all, so
  from `shadowDistance` out to `vegetationDistance` they were unconditionally
  lit over horizon-shadowed ground — 1.1 km at tier 0, 1.6 km at tier 1,
  2.2 km at tier 2, 3.6 km at Ultra, `detailSunShadow` having faded to 1.0 at
  `maxZ`. The phase booked the payment and only half-paid it.
  **`6-8`'s recorded cost was wrong in one word.** It priced the pyramid-layers
  route as "roughly 2-3 ms one-off". `TerrainClipmapSystem`'s channel pump
  calls `pyramid.recenter()` every frame and the pyramid re-bakes on every
  512 m of observer travel, so the cost RECURS. A 2-3 ms unsplit dispatch
  exceeds every tier's compute row, §1.3 forces tiling, a tiled rewrite is a
  visibly torn terminator, and avoiding the tear forces a second copy to read
  from — which is what turns the recorded 0.5 MiB into 1.0.
  **What landed:** `HorizonField.ts` owns the march, the max-of-pairs packing
  and the consumer lookup — the whole chain from geometry to visibility scalar,
  because anything left unshared is somewhere two representations can drift.
  The two things that legitimately differ are holes: the height SOURCE is a
  textual composition hole (`horizonFieldHeightAt`; WGSL has no closures) and
  the texture FETCH stays consumer-side (the lookup takes packed texels as
  values). Two producers compose the march (`PageOcclusionBake`, the new global
  bake), two consumers compose the lookup (terrain surface, far impostors).
  Global horizon layers at 128²/1,024 m over the height pyramid's exact span,
  ONE admitted whole-field dispatch. Coarser is principled: the horizon is a
  max over a 45 km march, so it is band-limited far below its source by
  construction. The field's origin publishes only on completion, so it may lag
  the height pyramid by one recentre — half a texel in a 131 km field, versus
  flickering the far field to fully lit every 512 m.
  **Costs.** +0.20 MiB measured (two rgba8 128² textures plus 32 B of
  registered `StorageBuffer`; my +0.125 estimate missed alignment overhead —
  the measured number is the one to carry). Detail material +2 samplers
  (compiled fragment measured at **7 of 16**), +1 vec4 UBO lane, **zero** new
  inter-stage varyings — the receiver recomputes world position in the fragment
  stage from `vPositionW` + `detailWorldOrigin`, wave R's trick for the
  material that had already hit the 16-input limit. `TerrainSurfacePlugin`
  delta is **zero** on every axis; its change is a pure extraction, and D-22's
  `terrain-sampler-budget.test.ts` — a compiled-source instrument, not a
  hand-maintained list — passes unchanged in both permutations. **Zero**
  `WebGpuQualityProfile` fields, **zero** `SubsystemBudgetMs` rows, **zero**
  new `ComputeBudgetClient`, so QR-1's surface is untouched.
  **Why no compute row.** Measured 2026-08-31: tier 0 8.150/13.7, tier 1
  11.930/13.7, **tier 2 13.650/13.7 — 0.050 ms of slack**, tier 3 27.750/30.0.
  `SubsystemBudgetMs.groundCoverCompute` warned that "the next row addition
  finds the wall rather than discovering it"; this was that addition. A new
  client's row must cover one dispatch at every tier and this bake prices at
  ~0.27 ms, so no row fits tier 2 without a fidelity trade. The bake therefore
  SHARES the `occlusionCompute` row: the pump submits one extra dispatch when
  one is owed and hands it the first admission, priced at the channel PAIR's
  cost — over-pricing only ever admits it less often, the safe direction for a
  term that degrades to "last position's field".
  **THE PIN BOUNDS COST, NOT CORRECTNESS — the two claims are recorded
  separately and deliberately.** Same-host A/B (run by the 6-11 session on the
  reference host): **no pixel movement on any of the 24 shots, worst wall-fps
  delta −1.37% (`motion-banked-turn`), +0.20 MiB, draw calls identical.**
  *Read that under §1.2's A→B→A amendment, which this run is what produced:*
  the second AFTER arm read `reference-viewport` at **−4.27%**, over the 2%
  bar, and a third AFTER on the identical tree put it at −0.08%; same-tree
  spread on that shot was 74.0 → 115.1 → 120.1 fps. **A reader applying the
  old two-arm rule to this data reaches the opposite conclusion.** The pin is
  clean under the corrected method and only under it.
  **What the pin does NOT establish:** that the feature works. Zero pixel
  movement is equally consistent with "correctly inert on this shot set" and
  with "no shot frames the geometry". I measured which, and the easy answer is
  wrong: sun elevations at 45°N are `hills-dusk-glint` 14.33°,
  `ground-2m-lowsun` 11.35°, `coast-10km-lowsun` 6.52°, and the baked field's
  horizon angles run p50 2.5° / p90 10° / p99 27° over 131,072 samples on each
  of three seeds — so **4.6–5.6% of azimuth-samples occlude
  `hills-dusk-glint`'s sun and 7.0–8.3% occlude `ground-2m-lowsun`'s.** The
  geometry IS present; "nothing moved" is not explained by its absence. The
  remaining explanations — that those shots frame the flat majority, or that
  the affected impostors are below the 0.0018 same-tree luma variance — are
  both benign and neither is proven.
  **So the behaviour is evidenced by tests, not by the capture**, and the
  chain is deliberately complete: the bake matches a CPU oracle of the same
  operator to better than rgba8 quantisation (`terrain-horizon-pyramid`);
  the field ARMS through the real pump under streaming competition, resident
  before frame 200, which is the failure that would have shipped a feature
  that silently never fires; the define and the shared lookup reach the
  COMPILED shader (`foliage-material-compile`); the shipped operator text
  returns 1.0 on flat ground, 0.0 under a horizon above the sun, 0.5 exactly
  at grazing, and 1.0 again for the SAME 0.90 horizon under a zenith sun
  (`horizon-shadow-operator`, on-adapter); and the fragment multiplies it into
  direct diffuse and specular and nothing else. That last control matters:
  the first version of the operator test asserted a 52.75° sun clears a 0.90
  (64.2°) horizon, which is false, and the test caught the error — evidence it
  discriminates rather than confirms.
  **Unaffected by D-24's shelving of eroded**, structurally: the height
  pyramid this field marches bakes `terrainNaturalHeight`, so it only ever
  described the shipping world. (The eroded-mode trap that follows from the
  same fact is recorded in D-24 for whoever revives it.)
  **Evidence.** Node 123 files / 1164 passed; GPU 45 files / 99 passed;
  typecheck and lint clean, rebased onto `d0a372c`. Mutation-tested: a
  transposed pyramid mapping and a double-included march each turn their
  guards red.

- **D-26 (2026-08-31, 6-11 partially landed — everything that is not a
  measurement; the sweep itself awaits a cold host):** the reference host had
  been running captures for hours and had fallen from min 117.73 fps this
  morning to **min 31.0 / median 45.5** — a 2.6x degradation across every shot
  with the Node suite green throughout. Per §1.2's own A→B→A amendment that is a
  thermometer, not a measurement, so the tier numbers are deliberately not
  taken. What landed:
  1. **Item 4 (`TERRAIN_SAMPLED_BINDINGS`) — DONE**, see D-22.
  2. **Item 3's harness — BUILT and validated** (`tests/perf/cold-start.test.ts`).
     Nothing in the project measured startup before it: `perf:capture` boots one
     renderer and holds it for the whole shot list, so its numbers are a warm
     steady state and describe none of the first seconds a player meets. It
     fails on **timeout OR console error**, and neither half is redundant — the
     `4.5-0` crash hung with no error (an error-only check watches it hang
     forever), and Gate F's eroded world logged nothing while taking ~90 s (a
     timeout-only check calls that healthy until it crosses). "Ready" means a
     frame was PRESENTED, not that `create()` resolved, because a renderer that
     resolves and cannot draw is the black-frame failure wearing a green hat.
     Needed a small addition to `FlightRenderer`: an opt-in startup-stage trace,
     inert unless a harness calls `beginRendererStartupTrace()`.
     **First reading, on the hot host: total 1,520 ms, first frame 84 ms** —
     which is already at W-1's ≤1.5 s line before the host is even cold. The
     number is NOT pinned; the ceiling in the file is a loose hang-catcher until
     a cold-host figure exists.
     **The stage split immediately paid for itself:** the six named stages sum
     to **284 ms of the 1,520**. Roughly **81% of cold start is outside every
     stage the renderer names** — material synthesis, scene construction and
     whatever else runs between the awaits. Any startup work aimed at the named
     stages would be optimising a fifth of the problem. That is the first thing
     to attribute before anyone tunes startup.
  3. **Item 5 (memory truth) — RECONCILED, and the estimate model is wrong by a
     third.** Measured on the current analytic tree: the estimate reads
     367.5–380.7 MiB while the inventory reads 483.9–492.3, a shortfall of
     **111–119 MiB at a remarkably consistent 1.29–1.32x**. That consistency is
     the finding: a ratio this stable across shots with different content is a
     whole CATEGORY of allocation the model omits, not accumulated drift. The
     verdict item 5 asks for is therefore *neither* "re-derive the rows" nor
     "move the ceiling" but: **the estimate is not a usable proxy for the
     ceiling and the ceiling must be judged on the inventory**, which is now
     what the capture asserts. Headroom on the measured number is **2.7 MiB
     (0.5%)** — and with eroded shelved, the 527.5 MiB overage is moot.
  4. **Sweep infrastructure — BUILT and tested, numbers outstanding.** Tier and
     viewport knobs; a sweep run cannot compare to baselines or produce a
     candidate by construction; a tier-aware delivery contract added BESIDE the
     standing tier-1 gate (tiers 0–2 share tier 1's, since §5.3 gives all three
     the same 13.7 ms target; tier 3 gets 30 fps / 33.34 ms from
     `FRAME_TARGET_MS[3]`), with a test pinning both functions to identical
     tier-1 verdicts across six samples including failures so the generalised
     one cannot become a quietly weaker definition of "delivered".
     **Two findings from building it, each of which would have produced a wrong
     tier table:**
     - **The tier `maxRenderPixels` caps (1.0 / 1.5 / 2.4 / 4.0 M) mean the
       three viewport columns are not three resolutions.** At tier 1 both 1080p
       and 1440p render at the 1.5 M cap — the same workload with different
       presentation. A published tier table MUST mark which columns are
       cap-bound or it reports resolution scaling that never happened.
     - **A viewport sweep needs the browser WINDOW resized, not just the
       canvas.** Playwright's window is 1280x720 — the canonical size, which is
       why this never mattered. Asking for 1920x1080 produced a report
       faithfully recording 1080p while the renderer drew **1333x750**, clamped
       by layout. The instrument would have published a "1080p row" that was
       nothing of the kind. Found only because the render-pixel pin failed, and
       it failed describing a scale error rather than the cap and clamp that
       were actually responsible — the third time this phase that a pin failing
       for the "wrong" reason was what exposed the real problem.
     Recorded against my own change: adding `--window-size` unconditionally
     measured a lower median than without it (56.6 vs 45.5 on adjacent runs).
     On a hot host that is two samples and settles nothing, so by the amendment
     above it is not called a cost — the flag is **sweep-only** instead, leaving
     the canonical run byte-identical to before the sweep existed. The standing
     gate is not the place to discover whether a flag is free.
  5. **The sweep is itself the workload that exhausts the host — so the run is
     designed against its own confound.** Raised by the PM session and correct:
     twelve configurations back to back is hours of continuous GPU load, the
     same pattern that took this machine from 117.73 to 38.7 fps today. Run in
     tier order, tier 3 would be measured on a hotter machine than tier 0 and a
     monotonic thermal ramp would read as *"higher tiers cost more"* — the exact
     conclusion the sweep exists to produce, and invisible in the numbers. This
     is §1.2's A→B→A lesson one level up, and **strictly worse**: there the
     variance was noise that averages out; here the drift CORRELATES with the
     independent variable, and correlated drift does not average out.
     `scripts/tier-sweep.sh` and `scripts/tier-sweep-analyse.mjs` answer it with
     three mechanisms, in increasing order of trust: a **balanced tier order**
     so each third of the run holds each tier about once; **cool-down gaps**;
     and — the one that actually matters — a **repeated control configuration**
     run first, middle and last. The first two reduce drift; **only the control
     detects it.** The analyser refuses to print a tier table at all when the
     control spread exceeds 5%, which is roughly the smallest tier-to-tier
     difference the sweep is trying to resolve: if the control moves as far as
     the effect, no arithmetic recovers the effect, so the honest output is
     "void, re-run" rather than a table with a caveat nobody carries forward.
     Both paths are verified against synthetic runs — a 33% control spread
     voids, a 1.7% spread prints and correctly flags a cap-bound row. Each
     report is stamped with its sweep label, order and start time, so a tier row
     never has to have its thermal context reconstructed from file mtimes.
     **Scope answer:** attempt all twelve rather than pre-emptively cutting to a
     "safe" subset — the 7-shot delivery subset puts a configuration at ~3–4
     minutes rather than the full set's ~10, so 15 runs with cool-downs is
     ~1.5–2 hours, not the projected 2+ hours of solid load. The control design
     makes the scope question **empirical**: if the host cannot hold twelve in
     one thermal envelope, the analyser says so from the data and the sweep is
     re-run in chunks. That is better than guessing the answer in either
     direction, and per §7.1 these are archived acceptance reports rather than
     standing gates, so a reduced-but-sound sweep with its scope recorded always
     beats a complete one that is confounded.
  **Outstanding and needing only a cold host:** the twelve sweep configurations,
  QR-1's per-tier headroom decision (which is a measurement), and pinning the
  cold-start acceptance number.

*(Further deviations land here with evidence, plus a normative row in
ARCHITECTURE.md's decision log, per house rule.)*
