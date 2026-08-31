# Phase 7 Execution Plan — night operations, the lighting engine, and airfield identity

**Created:** 2026-08-31. **Branch:** to be cut from Phase 6's close commit (see §1).
**Verified against:** the `jazonshou/Phase-6-Implementation` working tree at `98d87c4` plus
Phase 6's uncommitted Gate W + Waves 1–3. Every file:line below was re-checked in that tree
by an eight-dimension recon with an adversarial refutation panel over its "does not exist"
claims (2026-08-31; 4 of 24 gap claims were refuted and are corrected in place).
**Do not trust `RENDERING_PLAN.md` §Phase 7's citations** — `AirportSystem.ts:72-83` and
`:111` are both stale, and `AirportSystemOptions.includeHangars` never existed (D-2).
**Binding order:** `ARCHITECTURE.md` decision log (normative) → this plan →
`RENDERING_PLAN.md` §Phase 7 / §1.6 / §5.3. Deviations land in §11 here plus the decision
log, per house rule.

---

## 0. Standing decisions (recorded 2026-08-31, Jason's answers)

| Q | Decision | Consequence |
|---|---|---|
| **Q1 Start line** | **Phase 6 finishes first; Phase 7 plans clean.** No absorbing Gate-0 that duplicates Phase 6 work. | §1 is a verified *entry-condition checklist*, not a work gate. Phase 7 still opens with its own Gate 7-0 (§4) for instruments Phase 6 never had to build — night shots, a night entry point, a lighting budget row, and the adapter spike. |
| **Q2 Memory** | **The vegetation atlases fund Phase 7.** `impostorAtlasMiB` 9.33 and `foliageAtlasMiB` 6.0 ([PerformanceBudget.ts:312-388](src/render/webgpu/core/PerformanceBudget.ts)) are the fidelity rows that pay for cluster/tile-mask buffers, the light-point instance buffer, photometric textures and 7-11's material arrays. | Settles D-16's unbooked surplus in the opposite direction from booking wave T's leaf-spray layers — **6-11 must not book them**. Every allocation is measured against the enforced inventoried assert, not the estimate (§2.4). The ratchet binds: no count row rises without its fidelity row moving in the same commit. |
| **Q3 Airfield scope** | **Runway, hangars, and an ATC tower.** *"Airport specifics don't matter too much, but it should still look real."* | Taxiway lighting, apron markings and apron floodlighting are **re-scoped away with reason** (D-0) — none of that ground exists and 3-9 declined to build it. A new item **7-15 ATC tower** (3.0 d) is added (D-1); it mounts 7-7's rotating beacon and 7-14's obstruction lights and is the second scale reference on final. "It should still look real" is tested by the §8 acceptance flights, not by a count of fixtures. |
| **Q4 Night HDR** | **7-4 builds a real scene pre-exposure and a highlight-preserving rod response.** | The largest single change in the phase and the one that moves *every* pixel in *every* shot. It gets its own solitary rebaseline **R7-1**, before any light exists to blame. It reopens `MAX_EXPOSURE`'s derivation and both art-directed night constants — all test-pinned (§5, D-5). 6-11's sweep will deliberately pin nothing downstream of exposure, so this is Phase 7's to move. |
| **Q5 Which world ships** | **The ANALYTIC world is the shipped default. SETTLED, not assumed.** Jason re-flew the eroded world after d7's fixes, found it still badly wrong, and made an executive call on 2026-08-31 to **shelve it for this phase** — §8 resolving **NO**, which the Phase 6 plan explicitly sanctions ("the analytic default ships on and eroded stays a flag — that outcome is acceptable by Q1's own terms and is not a phase failure"). | **Eroded is out of Phase 7's scope entirely.** There is no Gate W dependency, no eroded prerequisite, and no eroded night shot; a future reader should not go looking for one. All 24 + 4 capture shots are `worldEvolution: "analytic"`. **The eroded code is parked behind its `?world=eroded` flag, not removed** — it is shelved with its state recorded, not abandoned, and someone will want to resume it. This was the assumption Phase 7 was already written on, so nothing structural changes; it simply stopped being able to move mid-phase. |

Also standing: **Gate 7A shipped in Phase 2.5** (`46bc24a`) — 7-1 moon, 7-2 scotopic vision,
7-3 star field are done; Phase 7 is 7B/7C/7D only. Gate 7A's own deviations hand two
decisions forward by name: the **pre-exposure** decision to 7-4 ([AtmosphereSystem.ts:55-77](src/render/webgpu/atmosphere/AtmosphereSystem.ts),
[docs/PERFORMANCE.md:387-389](docs/PERFORMANCE.md)) and the **moonlight-shadow trade** to
7-9 (`RENDERING_PLAN.md:466-470`). Both are honoured here.

---

## 1. Entry conditions — Phase 6 must be closed, and closure is *verified*, not assumed

Phase 7 does not start until every row below is true in the tree it branches from. Each is
a one-command check; none of them is Phase 7 work.

**Every row is satisfied by rendered, reviewed evidence — never by a gate's own green
status.** This is not a stylistic preference. On 2026-08-31 Jason flew the eroded world and
found it **completely broken**: no relief anywhere, landmasses rendering as flat page-shaped
plates at one elevation with water between them, reproduced against an analytic control at
the same seed (`1s9phln`) which renders correctly, **silent across four loads with zero
console errors**, and 20–60 s to ready against W-1's ≤1.5 s target. Gate W had closed on
byte-determinism, seam audits, statistics suites, timing and 24/24 green analytic shots —
and **not one instrument in the entire gate ever rendered the eroded world into an image a
human looked at.** W-7's eroded shots were never appended and no eroded baseline was ever
promoted, so nothing in the gate could have caught it. **Outcome: Jason re-flew it after
d7's fixes, found it still badly wrong, and shelved the eroded world for this phase** (Q5) —
so the lesson here is not "eroded was fixed", it is *the gate's green status was worth
nothing and only flying it found that out*. Accordingly: no row below may be closed by
citing "Gate W closed", and any future session reading this section should treat a gate's
green status as a claim to be checked, not as evidence. This is the same rule §2.10 states
for Phase 7's own night work, and it is stated twice on purpose.

| # | Condition | Verification | Owner today |
|---|---|---|---|
| E-1 | **6-11 closed** — four-tier × three-viewport sweep archived; QR-1 settled with a decision-log row (`vegetationCastsShadows` still carries 4.5-C1's `false/false/true/true` at [QualityProfile.ts:312,399,468,519](src/render/webgpu/core/QualityProfile.ts) and `grep QR-1 ARCHITECTURE.md` is empty); cold-start deadlines instrumented (**no instrument exists in any form** — no script, no test, no CI step, and `.github/workflows/` holds only `ci.yml` and `gpu-tests.yml`, so this is build-from-zero, and it must fail on **timeout OR console error**: the failure class it guards hung with *no* error, so an error check alone cannot catch it); 6-11.4 memory reconciliation done; **and 6-11 item 4** — `TERRAIN_SAMPLED_BINDINGS` derived from `effect.fragmentSourceCode` and pinned against that derivation, added 2026-08-31 after this plan's recon found the list stale in both directions (see 7-0-d) | tier table asserted from profile data in CI; a cold-start gate exists in the perf workflow; the sampler list derived, not hand-maintained | `flight-simulator-d7` |
| E-2 | **6-12 closed** — documentation truth. Its recorded list is itself incomplete: `docs/PERFORMANCE.md:36,47-49,105-113` still describe erosion as CPU-only after Gate W shipped the GPU producer, and `RENDERING_PLAN.md` §5.3 is the staler of the two documents (msaa Balanced published 4 / shipped 1; CDLOD node budget published 160/240/320/448 / shipped 224/320/448/640; ocean published 3@128,4@256,5@256,6@256 / shipped 128/3,128/4,256/5,256/5). `ARCHITECTURE.md:67` still carries a duplicate LandCoverClassifier row marked "planned 4-6", `:98-99` still asserts the default eroded world renders completed pages, `:308` still says impostors neither cast nor receive shadows | doc-truth tests fail `npm test` on drift | `flight-simulator-d7` |
| E-3 | **R1+R2+R3 promoted** as one reviewed pass. The committed baseline has not moved since 2026-08-28 (`6a46742`); the post-D-19 candidate exists on disk only. `tests/perf/baseline/report.json` is still a 17-shot fossil against 24 tracked PNGs and nothing reads it — 6-12 owes a decide-once on recommit-or-delete | `tests/perf/baseline/` mtimes move; 24 shots in the promoted report | `flight-simulator-d7` |
| ~~E-4~~ | **STRUCK 2026-08-31 — shelved with the eroded world, not discharged.** This row required D-7's canonical-split fix and D-9's bounds re-tightening. Both exist only to make the *eroded* page producer's seams sound, and both were entry conditions solely because they blocked §8's re-default. §8 has resolved NO, so **they block nothing in Phase 7** and requiring them would block this phase on work that has been deliberately shelved. **Their state is recorded, not erased**, for whoever resumes the eroded path: `TERRAIN_PAGE_EROSION_GPU_SEAM_CRITERIA` still carries the loosened `worstAbsoluteToleranceMeters: 0.06` at [TerrainPageErosionGpu.ts:342-344](src/render/webgpu/terrain/TerrainPageErosionGpu.ts), no `canonicalBlock`/`worldBlock` symbol exists in `TerrainKernel.ts` or `TerrainPageErosionGpu.ts`, and D-9's loosening is therefore still outliving its cause — which is exactly the condition D-9 warned becomes permission if left | n/a — struck | shelved with the eroded path |
| E-5 | **The horizon-shadow work has landed or been withdrawn.** Status per its own session: **implemented and verified, pending a capture pin and a merge slot** — not landed, not speculative. Worktree `nifty-williamson-2aca66`, branch `claude/nifty-williamson-2aca66`, uncommitted; Node 123 files / 1163 passed, GPU 42 files / 93 passed, typecheck and lint clean. The open item is sequencing (d7 wants it as its own churn point after the R1+R2+R3 promotion) plus an owed §2.3 same-host A/B pin on a quarantined idle host | merged at its sanctioned churn point, with its A/B pin recorded | `nifty-williamson-2aca66` + d7 |

**Gate F is discharged by events, not by flying it.** The three named flights (F-1 10,000 ft
dendritic survey, F-2 500 ft headwater-to-delta, F-3 800 ft lake circuit) existed to gate
**W-7's eroded baseline promotion** and **§8 criterion 5**. Jason's own flights answered the
question they were asked to answer — the eroded world is not shippable this phase — so §8
resolved NO and both gated things are moot. They were never entry conditions for Phase 7 and
are now not entry conditions for anything. **Retained here as context for whoever resumes
the eroded path:** the flights remain the right instrument, and the reason they mattered is
now demonstrated rather than argued — the eroded world was broken in a way that only flying
it could reveal, and Gate W's entire instrument set was blind to it.

**Phase 6's remaining scope is analytic-only:** 6-11, 6-12 (which now also records the
shelving), the horizon-shadow merge, and §8 as a one-row decision that has already been
made. That is what Phase 7 follows on from — **no eroded prerequisites of any kind**.

**E-5's measured deltas, supplied by that session and reproduced here so Phase 7 plans
against numbers rather than a rumour:** **zero** new `WebGpuQualityProfile` fields, **zero**
new `SubsystemBudgetMs` rows and **zero** new `ComputeBudgetClient`s — the global horizon
bake shares the existing `occlusionCompute` row rather than finding tier 2's 0.05 ms wall.
Memory: **0.125 MiB** total (two rgba8 128² `RawTexture`s, which land in
`inventoryGpuMemoryMiB`'s *texture* walk, not in `GpuBufferInventory`) plus a **32-byte**
registered `StorageBuffer`. On `TerrainSurfacePlugin`: **zero** sampler, uniform-lane and
inter-stage delta — its change there is a pure extraction of `terrainSurfaceHorizonShadow`'s
body into a shared include. Its additions are all on the **detail** material, which
clustered lighting does not compose into: samplers 4 → 6, UBO lanes 14 → 15, **varyings
12 → 12** (the receiver recomputes world position in the fragment stage from `vPositionW` +
`detailWorldOrigin`, wave R's trick for a material already at the 16-input limit). One new
constant, `DETAIL_HORIZON_SOFT_BAND = 0.05`, deliberately a module constant rather than a
tier row so 6-11's sweep may promote it. **Nothing of E-5's collides with Phase 7.**

---

## 2. The non-regression contract

The user goal this phase must not damage: at Phase 6's last measured candidate, tier 1
delivers **min 118.75 wall fps, worst p95 10.2 ms, zero hitches, worst single frame 17.3 ms
over 24 shots**, with **inventoried GPU memory 492.3 MiB against the enforced 495 MiB pin**
— **2.7 MiB of real headroom** ([scripts/perf-capture.mts:102](scripts/perf-capture.mts);
`PHASE_6_EXECUTION_PLAN.md:253-255`). The gating *estimate* reads ~380.7 MiB against a
480 MiB tier-1 ceiling and is therefore ~112 MiB low; **the estimate is not the instrument**.

1. **Delivery floors hold, per-item, on the reference host.** All 24 shots carry Gate
   0-a's re-pinned `ceilings` rows (zero `ceilings: null` remain) plus host-independent
   `drawCalls` ceilings. Full `npm run perf:capture` at **every item close**, recorded in
   the item's landing evidence. Floors move only at §9's rebaseline points.
2. **Night is dark-by-default, and daylight must not move.** Every light point and every
   clustered light contributes **exactly zero** above a sun-elevation gate, proved by a
   same-host A/B on the ten default-clock shots. **The one sanctioned exception is 7-4a's
   pre-exposure**, which moves every pixel by construction and therefore lands alone at
   R7-1 (§9) before any light exists to be blamed for it.
3. **Every item that adds cost to the daylight path carries a same-host A/B pin** —
   reference-host capture before/after, wall-fps delta ≤ 2% on the affected shots, logged
   at item close. Clustered lighting is *not* cost-dark: the container adds a
   `vViewDepth` inter-stage varying, a sampled `lightDataTexture` and a fragment-stage
   `tileMaskBuffer` to every PBR material whether or not a light is on.
4. **Memory is measured against the enforced inventoried assert.** `PERF_CAPTURE_INVENTORIED_MEMORY_CEILING_MIB = 495`
   is asserted hard on **every host including CI**, outside the delivery row. Every
   `new StorageBuffer(` site must also call `registerGpuBufferBytes` — a source scan whose
   allowlist is `[]` and is asserted `toHaveLength(0)`
   ([tests/render.gpu-buffer-inventory-policy.test.ts:28-79](tests/render.gpu-buffer-inventory-policy.test.ts)).
   **Per Q2, Phase 7's allocations are funded by cutting `impostorAtlasMiB` and
   `foliageAtlasMiB` in the same commit that raises them.** No 7B/7C/7D item lands before
   its row is funded. Both are real textures walked by the inventory, so cutting them frees
   **real inventoried bytes**, not merely estimate-model bytes.
   **And the pin ratchets down.** `PERF_CAPTURE_INVENTORIED_MEMORY_CEILING_MIB` exists to
   catch growth: if Phase 7 frees 15 MiB and the pin stays at 495, it stops catching
   anything for the rest of the project. **Re-pin it from each promoting capture; never
   loosen it.** The one sanctioned rise is 6-11.4's reconciliation moving it *with* a
   recorded fidelity trade — d7 will message the landed numbers when measured, and Phase 7's
   trade is re-sized against them rather than against the 495/492.3 pair quoted here.
   **Two accounting paths feed one enforced number.** `inventoryGpuMemoryMiB` walks
   `scene.textures` and mesh geometry *and then adds* `inventoriedGpuBufferBytes()`
   ([FlightRenderer.ts:1485-1531](src/render/FlightRenderer.ts)). So a `RawTexture` that
   never touches `GpuBufferInventory` still counts against the capture pin exactly like an
   atlas — E-5's 0.125 MiB is precisely this case. Phase 7's photometric/IES textures and
   7-11's material arrays land in the texture walk, its cluster and light-point buffers in
   the buffer registry, and **the trade arithmetic must sum both**; only the combined number
   is enforced.
   **The eroded overage is moot.** Shelving the eroded world (Q5) removes the eroded
   configuration's 527.5 MiB against the 495 ceiling from the picture entirely. The
   operative number is the **analytic 492.3 MiB, which fits** — so Phase 7's memory question
   is simpler and safer than when this plan was drafted, and the Q2 trade is sized against a
   configuration that actually ships rather than hedged across two.
5. **Draw ceilings are hard on every host.** `night` 160, `runway-on-approach` 169,
   `approach-500ft` 158 ([scripts/perf-capture.mts:188-195](scripts/perf-capture.mts)).
   **~200 light points must be one instanced draw** — this is a design constraint, not an
   aspiration. 7D's hangars, tower and furniture are the other pressure and are budgeted
   against the same ceilings.
6. **The ratchet binds** (`RENDERING_PLAN.md:837`): no count row rises without a fidelity
   row moving in the same commit.
7. **The tier rule is absolute.** The `.tier`-reader grandfather list is
   `new Set<string>([])` and the regex is a bare `/\.tier\b/u` over comment-stripped
   source ([tests/architecture.boundaries.test.ts:143-165](tests/architecture.boundaries.test.ts)).
   Every per-tier light knob — cluster tiles, depth slices, clustered-light count,
   light-point count, night shadow policy — is a **`WebGpuQualityProfile` data field**.
8. **Boundary tripwires.** Each artifact gets an `owners.ts` row **in the same commit**
   (there is none today for clustered lighting, light points, volumetrics, airfield
   lighting, aircraft lighting, hangars or `AirportSystem` itself); any new shadow caster
   uses `createGuardedShadowDepthWrapper` (assertion 117); no raw `new ShadowDepthWrapper`;
   any new `ComputeShader` is `withoutDispatchTiming(`-wrapped or listed in
   `TIMED_ON_PURPOSE` with a named consumer; assertion 51b's swizzle-compound-assignment
   scan applies to every new WGSL string. **Note the terrain→detail import rule**: a
   Phase 7 file under `terrain/` cannot import `mainRenderPassId` from
   [indirectDrawCapability.ts:102-110](src/render/webgpu/detail/indirectDrawCapability.ts)
   — only `densityField`/`densityFieldWgsl` are permitted. If a lighting path needs it, the
   helper moves to `core/` with an owner row.
9. **Measurement discipline** (house standing list): captures on an idle reference host
   only; same-host A/Bs run **B→A→B** so thermal drift (~20%) cannot masquerade as the
   effect; never time anything in the in-app browser pane (paint-gated RAF); GPU readbacks
   go through the buffer ring **and carry `noDelay: true`** (Babylon defers a plain
   `StorageBuffer.read()` to the next frame's submit, so a headless harness reads freshly
   allocated zeros — D-20); benchmark with `tsx`, not vitest; `test:gpu` output to a file
   (zombie exit); WGSL hashes must survive world-scale ids (no sin-fract); reversed
   `smoothstep` throws. **A green suite is not evidence of anything visual — read the
   PNGs.** D-18 refused a rebaseline that passed 23 gates.
10. **No Phase 7 item closes without a reviewed night frame — this rule outranks every
    metric in this contract.** Phase 7's entire subject matter is *only* visible in
    rendered frames: a lighting engine whose output is never looked at is indistinguishable
    from one that draws nothing, and the pass that would hide it (§5's rod response, which
    compresses 10⁵:1 into 1.10:1 before 7-4a) is *already in the tree*. This is the exact
    failure class that just cost Gate W an entire workstream — proxy measurements standing
    in for a picture, silently, with zero console errors and every suite green. Therefore:
    every item's landing evidence carries **the appended night/dusk frames, read by a
    human**, alongside its numbers; "the light count is right" and "the budget row holds"
    are not evidence that anything is lit. An item whose visual effect cannot be seen in any
    shot is not done — it is unmeasured, and it says so in its landing note (Wave 1's
    invisible inland water is the precedent: *do not read "no pixel movement" as "no work
    landed"; read it as "the capture set cannot see this yet"*).
11. **Watched instruments.** The `night` shot's SSIM floor is already relaxed to **0.96**
    because the scotopic gain amplifies cloud jitter in a near-black frame (0.972 measured
    between two runs of an identical build) — it **cannot** distinguish a 7-5 regression
    from its own noise, which is why 7-0-a appends shots rather than leaning on it. The
    **two-seed hazard** (`world.seedHash` ≠ `world.sourceSeedHash` on any
    guaranteed-airport world) is live: `ARCHITECTURE.md:381` records the rule, and 7D's
    hash-driven variation must pick its authority's seed explicitly.

---

## 3. What the tree actually provides (delta since `RENDERING_PLAN.md` §Phase 7 was written)

**The lighting engine is genuine greenfield.** The whole scene has **three** lights —
`DirectionalLight("sun")`, `DirectionalLight("moon")`, `HemisphericLight("sky-ambient")`
([AtmosphereSystem.ts:496,499,506](src/render/webgpu/atmosphere/AtmosphereSystem.ts)).
There is no `PointLight`, no `SpotLight`, no clustered anything in `src/`.

**Babylon 9.21.2 does ship what 7-4/7-5 name** — `ClusteredLightContainer extends Light`
with `IsLightSupported`, `horizontalTiles`/`verticalTiles`/`depthSlices`/`maxRange`, a
scene component, and a Light-independent `LoadIESData` parser. Pinned exactly at
`package.json:28`. The traps are in §5.

**Reusable substrate that already exists and must not be re-derived:**
- `StarFieldSystem` is a working additive emissive billboard pass — quad soup, `ALPHA_ADD`,
  `disableDepthWrite`, pixel-sized in clip space, magnitude-driven Gaussian PSF whose
  **flux is held constant when the radius changes**
  ([StarField.ts:213-260](src/render/webgpu/atmosphere/StarField.ts)). 7-5 clones this.
- Point-source **atmospheric extinction** is already implemented and tested:
  `relativeAirMass` (Kasten–Young), `starIlluminanceLux`, `starVisibilityForSunElevation`
  ([StarCatalogue.ts:523,539](src/render/webgpu/atmosphere/StarCatalogue.ts)).
- `AERIAL_PERSPECTIVE_WGSL` is a single owned artifact with five ShaderMaterial consumers
  and `applyAerialPerspectiveToShaderMaterial`
  ([AerialPerspective.ts:265-499](src/render/webgpu/atmosphere/AerialPerspective.ts)).
  `SharedReceiverRegistry`'s docblock names Phase 7's clustered lighting as **the fourth
  subclass it exists to prevent hand-rolling**
  ([SharedReceiverRegistry.ts:14-20](src/render/webgpu/core/SharedReceiverRegistry.ts)).
- A **depth prepass already runs every frame** — a `DepthRenderer` storing camera-space Z
  in metres (0 = sky), in `scene.customRenderTargets`, exposed as `sceneDepth`, consumed by
  the cloud raymarch ([AtmosphereGpuResources.ts:201-221](src/render/webgpu/atmosphere/AtmosphereGpuResources.ts)).
  **Its render list is one mesh** — `mesh.name === "terrain-cdlod"` (`:59-63`). 7-6 extends
  and re-owns it rather than building one.
- The **aircraft already carries lamps**: `port-navigation-light` (red, z = +5.43),
  `starboard-navigation-light` (green, z = −5.43), `landing-light` cylinder at
  (1.18, 0.22, 1.7), all emissive PBR with `castsShadow: false`, plus a **real cockpit
  interior** with five emissive gauges
  ([createAircraft.ts:187-199,553-562,678-685](src/render/webgpu/aircraft/createAircraft.ts)).
- The **threshold datum 7-7's PAPI needs already exists and is test-pinned**:
  `runwayCrownHeight` is exactly 0 on the centreline, so `getRunwayEndpoints`' y **is**
  `runwayPlatformHeight(airport, 0)` ([RunwayEarthworks.ts:162-178](src/render/webgpu/terrain/RunwayEarthworks.ts);
  pinned to 9 dp at [tests/world.test.ts:409](tests/world.test.ts) and
  [tests/sim.terrain-authority.test.ts:98](tests/sim.terrain-authority.test.ts)). The
  platform is **level along its length**, so the geometric glideslope is exact, not
  ill-defined.
- A **3° approach surface** is already in the site search:
  `permittedHeight = elevation + 18 + distance * 0.0524` swept to 4,200 m from both ends,
  with `corridorHalfWidth = 70 + distance * 0.095`
  ([airportSite.ts:479-488](src/world/airportSite.ts)). The approach lighting system
  follows that corridor rather than inventing one.
- Threshold/TDZ/centreline paint datums exist in `runwayMarkingProfile`
  (`thresholdInsetMeters: 48`, `touchdownFromThresholdMeters: 300`,
  `centrelineStripeMeters: 30`) ([RunwaySurface.ts:41-60](src/render/webgpu/terrain/RunwaySurface.ts)).

**Plan rows that are dead or wrong, corrected here:**
- `AirportSystemOptions.includeHangars` **never existed**; `AirportSystem`'s constructor is
  three positional arguments and the file is 106 lines, with the hangar loop at `:50-73`
  and the `CreateBox` at `:53` (D-2).
- **There is no apron, no taxiway, and no bloom.** 3-9 deleted the apron slab and recorded
  a deviation declining to replace it ([RunwaySurface.ts:32-37](src/render/webgpu/terrain/RunwaySurface.ts));
  `rg -in taxiway src tests scripts` returns zero; the post chain is exactly
  ScotopicVision → ACES → FXAA with no `DefaultRenderingPipeline`, no glow layer
  ([FlightRenderer.ts:955-995](src/render/FlightRenderer.ts)). D-0 and D-4.
- **There is no way to fly at night.** `TimeOfDayPreset` is `"dawn" | "day" | "golden"`
  ([src/game/types.ts:18](src/game/types.ts)); the only route to night is dragging the
  solar-time slider. 7-0-c fixes this or the §8 flights cannot happen.
- **Only one shot is below the horizon** (`night`, −21.5°) and the next lowest is
  `coast-10km-lowsun` at +6.5°. **The mesopic band — where `rodFraction ∈ (0,1)` and
  lights first read against a lit sky — has zero coverage.**

---

## 4. Gate 7-0 — instruments and access for night (2.5 d)

Phase 6's instruments cannot see anything Phase 7 does. None of this is Phase 6 work.

- **7-0-d The adapter spike — FIRST ACTION OF THE PHASE (0.75 d).** Before anything is
  built: on the reference adapter, attach a `ClusteredLightContainer` to
  production-parity terrain, foliage, water and aircraft materials with the 4-cascade CSM
  and `scene.environmentTexture`, and **measure** (a) inter-stage variable count, (b)
  fragment-stage storage buffers, (c) sampler count, (d) whether the pipeline compiles at
  all. This mirrors `1A-7`/`R-20`'s precedent. **If the container does not fit, 7-4 changes
  shape and Gate 7B re-prices** — that is a recorded outcome, not a failure. Re-run after
  E-5's horizon-shadow work merges.
  **Consume the derived sampler count; do not build a second list.** Three numbers were in
  circulation for `TerrainSurfacePlugin`'s samplers — 11 from `getSamplers`, 8 module-scope
  `var terrain*Sampler` declarations, and a 15-entry `TERRAIN_SAMPLED_BINDINGS` audited list
  ([TerrainSpineContract.ts:517-540](src/render/webgpu/terrain/TerrainSpineContract.ts)) —
  because the contract list is hand-maintained, checked only for uniqueness and against 16,
  and **stale in both directions at once**: it includes six PBR samplers the terrain material
  never binds, and omits the CSM shadow sampler, the cloud-shadow projection sampler **and
  both hydrology atlases Phase 6 itself added** (6-6's `terrainShoreDistanceAtlas`, 6-5's
  `terrainLakeDepthAtlas`). 6-5 and 6-6 each did explicit sampler arithmetic against it and
  were therefore reasoning against a model rather than the renderer; the app compiles, so the
  list over-counts and real headroom is *larger* than those items believed — the benign
  direction, but unverified.
  **This is now 6-11 item 4 and is fixed there** (E-1): the count is derived from
  `effect.fragmentSourceCode` via 6-8's existing compiled-source assertion in
  `tests/gpu/terrain-surface-compile.test.ts`, and the list is pinned against that
  derivation. **7-0-d must not duplicate it.** If the spike wants its own assertion for the
  light-path samplers, it extends the same derivation — a second hand-maintained list would
  reproduce the original defect with an extra copy.
- **7-0-a Night capture shots, appended (0.75 d).** Shots are **appended, never inserted**
  — the driver pins `simulationTime = 500 + canonicalShotIndex * 120`, so an insertion
  shifts every later shot's phase and fails its SSIM with no renderer change
  ([scripts/perf-capture.mts:567-570](scripts/perf-capture.mts)). Append:
  `night-short-final` (the `runway-on-approach` pose — 61 m AGL, −900/0, 3° pitch down —
  at solar 23.75 h), `night-runway-ground` (2 m on the runway, hangars and tower framed),
  `dusk-mesopic` (sun ≈ −3°, the uncovered `rodFraction ∈ (0,1)` regime), and
  `night-beacon-offset` (a half-period `simulationTime` offset — see 7-8's phase trap).
  Ceilings and `drawCallCeiling` pinned from three clean idle-host runs at each rebaseline.
- **7-0-b The `lighting` budget row, funded (0.5 d).** `SubsystemBudgetMs` has twelve rows
  and none is lighting; `COMPUTE_BUDGET_CLIENTS` has five and none is lighting.
  **Tier 2 has 0.05 ms of slack** (13.65 against a 13.7 ms target) and assertion 20 is a
  hard `toBeLessThanOrEqual` — so the row must be funded by cutting an existing row in the
  same commit. Book Q2's memory trade at the same time: `impostorAtlasMiB` and
  `foliageAtlasMiB` reduced, with the fidelity consequence stated and framed **before and
  after**. Sequencing note: the trade is sized against 6-11.4's landed numbers, which d7
  will message when measured — until then 7-0-b holds a costed *menu*, not a committed cut
  (Risk 7). All 24 + 4 shots run `worldEvolution: "analytic"` per Q5; no eroded night shot
  is appended in this phase.
- **7-0-c A night entry point (0.5 d).** A `night` `TimeOfDayPreset` and a night runway
  start, so §8's flights are flyable without slider-dragging. Pin that the shipped default
  preset is unchanged.

---

## 5. Gate 7B — the lighting engine (7-4, 7-5, 7-6 — 14.0 d)

### 7-4 clustered lighting **and the pre-exposure** (6.0 d; was 4.0)

**7-4a Scene pre-exposure and highlight-preserving rods (2.0 d).** Per Q4, and per Gate
7A's own hand-off. The problem, measured: `ScotopicVision`'s Naka–Rushton response
`nits / (nits + sigma)` half-saturates at the **scene's key luminance**, not the physical
adapted luminance ([ScotopicVision.ts:158-166](src/render/webgpu/atmosphere/ScotopicVision.ts);
σ passed from [FlightRenderer.ts:1850-1853](src/render/FlightRenderer.ts)). At the `night`
shot σ ≈ 4.21 cd/m² while physical adapted luminance is 8.0e-5, so `rodFraction = 1` and
the rod image fully replaces the scene. With `displayGain = 0.16 / 4.698 = 0.03406`,
scene-linear values of **0.01, 1 and 1000 all land at 0.1449 / 0.1598 / 0.1600** — a
10⁵:1 range compressed to **1.10:1**. Every light point would render at the same
brightness. The pass also takes four extra taps on a rotated cross at up to 3 texels and
evaluates the response on the **blurred** value.
What lands: a scene pre-exposure so the fp16 beauty target carries the range; a
highlight-preserving term so sources above σ survive the rod response; and an emissive-aware
path so the rod blur does not smear point sources. **This reopens pinned constants** —
`MAX_EXPOSURE = 4.698` and the assertion that it binds exactly at midnight
([tests/render.webgpu-atmosphere-luts.test.ts:141-144](tests/render.webgpu-atmosphere-luts.test.ts)),
`MOON_PEAK_LIGHT_INTENSITY = 0.055` and `STAR_ZERO_MAGNITUDE_SCENE_VALUE = 0.5`. Fix the
source docstring while there: it claims ~4.66 against a pinned 4.698.
*Pins:* the exposure ladder re-derived, not re-chosen, with its new derivation in the
docblock; a monotonicity test that N scene-linear decades map to N distinguishable output
decades at the night clock; the rod blur proved not to smear a one-pixel source.
**Lands alone at R7-1.**

**7-4b The clustered container (4.0 d).** Integrate `ClusteredLightContainer` as the
subsystem `SharedReceiverRegistry` was written to anticipate. The measured traps, each of
which is a sub-item:
- **`maxSimultaneousLights` defaults to 4 and nothing sets it.** The scene has 3 lights and
  the container **is a Light** — it takes slot 4, and `PrepareDefinesForLights` simply
  `break`s at the cap, so the next light silently stops contributing
  ([pbrBaseMaterial.pure.js:577](node_modules/@babylonjs/core/Materials/PBR/pbrBaseMaterial.pure.js);
  `materialHelper.functions.js:661-667`). Raise it explicitly and pin it.
- **`GetSupportedSimultaneousLights` clamps to `maxUniformBuffersPerShaderStage - 4`**, and
  `REQUIRED_WEBGPU_LIMITS` declares no such limit
  ([Capabilities.ts:21-37](src/render/webgpu/core/Capabilities.ts)). Declare and probe it.
- **The container adds a `vViewDepth` inter-stage varying unconditionally** whenever
  `CLUSTLIGHT_BATCH > 0`. This project has already measured 17 inter-stage inputs on a
  material and disabled impostor shadow receiving to get under the limit. 7-0-d measures
  this before anything is built.
- **It adds the project's first fragment-stage storage buffer** (`tileMaskBuffer{X}`), and
  the clustering pass itself needs a read_write atomic storage buffer in the fragment
  stage. `maxStorageBuffersInFragmentStage` is neither declared nor probed.
- **The terrain plugin attenuates the light *sum*.** `TerrainSurfacePlugin`'s
  BEFORE_FINALCOLORCOMPOSITION hook does `finalDiffuse *= terrainHorizonShadow *
  terrainCanopyDirect` where `finalDiffuse = diffuseBase` — the accumulator every light
  writes into ([TerrainSurfacePlugin.ts:2783-2797](src/render/webgpu/terrain/TerrainSurfacePlugin.ts)).
  A runway edge light would be dimmed by *sun* occlusion. The same shape exists in
  `DetailInstanceMaterialPlugin` (`finalDiffuse *= impostorSunShadow`). **7-4b must split
  the attenuation so it applies to the sun/moon contribution only** — there is no existing
  hook between the light loop and final composition, so this is real shader surgery across
  the five `MaterialPluginBase` subclasses (terrain 180, detail 190, ground cover 195,
  aerial 205, cloud shadow 210).
- **`IsLightSupported` rejects any light with a shadow generator** while shadows are
  enabled, any non-default falloff, anything that is not a point/spot, and any spot with a
  projection or IES texture ([clusteredLightContainer.pure.js:68-89](node_modules/@babylonjs/core/Lights/Clustered/clusteredLightContainer.pure.js)).
  `addLight` merely warns and returns. **Recorded consequence: 7-8's landing lights are
  clustered and therefore cast no shadows.**
- **Tile defaults are 64×64×16, not the plan's "start 16×8"**, and changing them at runtime
  reallocates the tile-mask texture, storage buffer and thin-instance matrix buffer. Set
  once from profile data.
- **`_updateLightData` calls `engine.flushFramebuffer()` on WebGPU whenever light data
  changes**, and the scene component runs `_updateBatches` on every camera render. A beacon
  at 45 fpm and strobes at 60 fpm would flush every frame. **Architectural rule: animated
  intensity lives on the light *points* (billboards); clustered light data is static per
  fixture.**
- The container owns an RTT, a proxy mesh and a proxy material **outside** the five passes
  `WebGpuFrameGraph` registers. Wrap or register it so the graph can name, time and disable it.
*Pins:* compiled-fragment-source assertions for every define the integration sets (a define
missing from a plugin's constructor map silently reads false — the project's own recorded
lesson); the sun/moon-only attenuation proved by a fixture where a clustered light lies in
horizon shadow; §2.3 A/B pin; an `owners.ts` row.

### 7-5 light points (5.0 d; was 4.0)

Instanced emissive billboards for the ~200 lights you *see*; they illuminate nothing
(`RENDERING_PLAN.md:183-190`). Clone `StarFieldSystem`'s pattern including the
constant-flux PSF. **One instanced draw** (§2.5).
- **Photometry.** `LoadIESData` is a Light-free parser returning `{width, height: 1, data:
  Float32Array}` of candela values — upload as a `RawTexture` (the pattern already exists at
  [SpectralOceanSystem.ts:993](src/render/webgpu/water/SpectralOceanSystem.ts)) and sample
  it in the billboard shader. **But Babylon's IES is one-dimensional and rotationally
  symmetric** — 180 vertical-angle samples at horizontal angle 0, indexed as
  `acos(dot(-lightDirection, L)) / PI`. **A PAPI is azimuthally asymmetric with a sharp
  vertical transition and a runway edge light has a horizontal cutoff — neither is a
  function of polar angle about one axis** (D-3). IES carries the rotationally-symmetric
  fixtures; the PAPI's law is authored analytically in 7-7.
- **Extinction must be applied by hand.** `isOpaqueAerialReceiver` rejects alpha < 1 and any
  non-zero `transparencyMode`, so an additive billboard cannot join the aerial-perspective
  registry ([AerialPerspective.ts:628-636](src/render/webgpu/atmosphere/AerialPerspective.ts)).
  Use `applyAerialPerspectiveToShaderMaterial` — the owned include, not a second model —
  plus `relativeAirMass` for the near-horizon fixtures.
- **Near→far transition** from a lit quad to a pure glow, or lights pop on approach.
- **Bloom does not exist** (D-4). A new post-process between the scotopic pass and ACES,
  which means renegotiating MSAA and first-pass ownership with `ScotopicVisionPass` at slot
  0 ([FlightRenderer.ts:955-995](src/render/FlightRenderer.ts)) and funding a `post` budget
  row against tier 2's 0.05 ms slack.
*Pins:* one draw call asserted on the night shots; HDR range preserved through 7-4a
(the monotonicity test re-run with real light points); extinction agrees with the star
path's air mass at matched elevations; §2.3 A/B pin.

### 7-6 light volumetrics (3.0 d) — **the phase's first cut candidate**

Billboard cones with a soft depth intersection for landing lights and floods, reusing the
aerial include's participating-media terms (`aerialRayleighPhase`, `aerialMiePhase`,
`aerialExponentialPathIntegral`) rather than a second fog model. **The depth buffer it
needs is terrain-only** — `renderListPredicate = isCloudRaymarchDepthOccluder` — so 7-6
must extend and re-own that render list, which is a single-owner change against the
atmosphere subsystem. Cut this first if the budget bites.

**Rebaselines: R7-1 (7-4a, alone), then R7-2 at Gate 7B close.**

---

## 6. Gate 7C — airfield and aircraft lighting (7-7, 7-8, 7-9 — 9.0 d)

### 7-7 airfield lighting (3.5 d; was 4.0 — taxiway cut, PAPI harness added)

Generated from `AirportDefinition` + `runwayMarkingProfile` + `getRunwayEndpoints`, so it
survives a seed change. What ships: runway edge (white, amber final 600 m), bidirectional
threshold (green to arrivals / red to departures), centreline, TDZ, **PAPI**, the approach
lighting system along `airportSite.ts`'s existing 3° corridor, and the rotating beacon
(alternating white/green, civil field) mounted on 7-15's tower. **Taxiway blue-edge and
green-centreline lights are cut** (D-0) — no taxiway geometry exists anywhere.
- **The PAPI is the one piece that must be numerically right.** Author its angular law
  analytically (D-3), with a TS/WGSL parity pin in the house pattern, and verify the
  red/white transition against the geometric glideslope from the threshold to **0.1°**.
  The datum is sound: the platform is level along its length and the centreline crown is
  exactly zero.
- **Fixture height trap.** `runwayToWorld` returns `y = airport.elevation`, which is correct
  only on the centreline. Edge lights at `across = ±(runwayWidth/2 + margin)` sit
  `runwayCrownHeight(airport, across)` **below** it — up to the full 0.35 m camber. Place
  every off-centreline fixture through `runwayPlatformHeight(airport, across)`.
- **Do not transliterate the airport SDF a fourth time.** Three WGSL copies exist and one of
  them — the splat bake's — was a 240 m disc under a comment claiming the rounded
  rectangle, reading 0.000 where the CPU returned 0.807, for months (D-19). Compose
  `RUNWAY_SDF_WGSL`.
- **Pick the right rectangle.** Three are in active use: the paved runway (1,320 × 34 m,
  `isPointOnRunway`), the graded platform (1,480 × 62 m, `getAirportInfluence == 1`), and
  the influence footprint including the blend (1,960 × 542 m, erosion protection). Edge
  lights key on the paved rectangle; the approach system leaves all three.
*Pins:* PAPI angle within 0.1° over a swept approach fixture; TS/WGSL parity; light count
and draw calls under the appended night shots' ceilings; a no-airport world renders no
fixtures (the old influence form returned 1 everywhere with no airport — D-19).

### 7-8 aircraft lighting (3.0 d)

Nav lights with correct split angles (red port 110°, green starboard 110°, white tail 140°),
red anti-collision beacon ~45 fpm, white strobes ~60 fpm, landing and taxi lights as
clustered spots, cockpit instrument glow. The lamps and the cockpit interior already exist
as emissive geometry; this item makes them lights.
- **Settle the body-axis contract first — the nav lights may be reversed.**
  `AircraftVisual`'s docblock and `configureRoot` metadata declare
  `bodyAxes: { forward: "+x", up: "+y", port: "+z" }` and place the **red**
  `port-navigation-light` at z = +5.43. But [src/input/index.ts:36-49](src/input/index.ts)
  states the opposite about the rendered basis and **inverts keyboard roll to compensate**:
  *"the current aircraft mesh/chase basis presents body +Z as starboard even though the
  simulator's public comments describe it as port."* Geometrically, right-handed with
  forward = +X and up = +Y gives starboard = +Z, which agrees with the input module. 7-8's
  entire premise — inferring heading from which colours you can see — depends on this.
  Settle it, fix whichever side is wrong, delete the local compensation, and record a
  decision-log row (D-6).
- **Phase-anchor the timers to `simulationTime`**, per the propeller precedent
  ([createAircraft.ts:594-600](src/render/webgpu/aircraft/createAircraft.ts)). **But note the
  capture trap:** shots are spaced exactly 120 s apart and both 45 fpm (0.75 Hz) and 60 fpm
  (1 Hz) divide 120 s into whole periods, so **every shot samples an identical phase**.
  Deterministic, but the capture set can never see the off phase — hence
  `night-beacon-offset` at 7-0-a.
- **Do not gate the landing light on `gear` alone.** Every capture shot flies with
  `gear: 1, onGround: false`, so a gear-driven light switches on in all 24 including
  `slant-10km`, `high-10000ft-down` and `cruise-horizon`, churning baselines that have
  nothing to do with night. Gate on AGL **and** gear **and** an explicit setting.
- Landing/taxi lights are clustered and therefore **cast no shadows** (7-4b's recorded
  consequence).
*Pins:* split angles verified by sampling visibility around the airframe; beacon and strobe
provably out of phase with each other; landing light off in all ten default-clock shots.

### 7-9 night-perf-tiers (2.5 d; was 2.0)

Night is a different workload — fewer shadow casters, far more lights — and gets its own
tier row, not a scaled daytime one. All as `WebGpuQualityProfile` data fields (§2.7):
clustered-light count, light-point count, cluster tile/slice resolution, light-point LOD
and cull radii, night shadow policy.
- **Absorbs Gate 7A deviation 4's moonlight-shadow trade.** Measure it rather than inherit
  it: a second cascade set costs a full duplicate — tier 1 is 1280² × 2 × 4 B = **12.5 MiB**
  and a 0.7 ms `shadows` row; tier 3 is 2048² × 4 × 4 B = 64 MiB and 1.8 ms. Against
  2.7 MiB of headroom the answer is very likely still no, but it is now *measured* no.
- **Terrain occlusion for artificial lights is a separate answer, not a reuse.** E-5's
  horizon field returns 1.0 whenever `sunDirection.y <= 0` and multiplies into direct
  diffuse and specular only, never ambient — so it contributes nothing at night and cannot
  double-darken the scene. **It must not be reinterpreted for the moon or for point lights:**
  it is baked against the sun's convention and is a max-over-azimuth, which is simply wrong
  for a local source. If Phase 7 wants terrain occlusion for lights, the honest route is the
  same shared operator with a different consumer. Recorded on that session's own advice.
- **Both halves of every shortening trade.** `4-8b` shortened the shadow cascades to contact
  range on the explicit grounds that the horizon map covers the far field
  ([QualityProfile.ts:284](src/render/webgpu/core/QualityProfile.ts)) — and only *terrain*
  ever received the far-field half; impostors stayed unconditionally lit from
  `shadowDistance` out to `vegetationDistance` for two phases, invisibly, because each half
  was individually correct. **When 7-9 shortens or re-budgets anything on that reasoning,
  check that every representation of the affected thing got both halves.**
- **Absorbs the PCSS residual with reason.** `QualityProfile.ts:436-441` records PCSS as
  "a Phase 7 conversation" because `1A-5` deleted the colour attachment
  `computeShadowWithCSMPCSS` needs. Decline it explicitly with that citation rather than
  leaving it open a fourth phase.
- **The governor gains its first lighting rung.** The GPU ladder's nine rungs contain
  nothing for lights ([AdaptiveGovernor.ts:174-197](src/render/webgpu/core/AdaptiveGovernor.ts)).
  Add one — and remember the governor is **frozen under captures**, so the rung's real
  behaviour needs its own unpinned test, not a capture.
*Pins:* per-tier night delivery reports archived (**acceptance reports, not standing
baselines** — only the canonical tier-1 set remains the regression gate); tier table
asserted from profile data; no light-count-dependent shader recompilation during flight.

**Rebaseline: R7-3 at Gate 7C close.**

---

## 7. Gate 7D — hangars, tower and airfield identity (7-10…7-15 — 15.5 d)

Per Q3 this gate is **runway-adjacent structure only**: hangars, a tower, and the furniture
that makes them read as operated. No apron network, no taxiways.

### 7-10 parametric hangar (5.0 d)
Replaces the three `CreateBox` calls in the loop at
[AirportSystem.ts:50-73](src/render/webgpu/detail/AirportSystem.ts) (**not** `:72-83` —
D-2). Gabled and arched roof profiles, ribbed corrugated cladding, sliding door tracks and
panels with open/closed states, clerestory strips, ridge vents, gutters, downspouts,
service doors, pilasters, concrete skirt. Parameterised on bay count. Corrugation is
**geometry on the silhouette and a normal map inboard**.
- **The ground problem is real and currently wrong.** Each hangar sits at
  `across = runwayWidth*0.5 + 118` (~135 m) — **104 m outside the 62 m graded half-width**,
  on the natural batter — and is re-seated by a **single centre-point** height sample, so a
  46 × 34 m box buries one corner and floats another. 7-10's concrete skirt is the fix, and
  it needs a real ground query over the footprint. **Keep the skirt render-only:** the
  moment it changes ground *height* it becomes Class K, because collision short-circuits
  through the same earthworks profile and assertion 63 pins the two to under 1 mm.
- **Register meshes correctly or they silently lose cloud shadows and aerial perspective.**
  `FlightRenderer` calls `airport.root.getChildMeshes(false)` **once at construction**
  ([FlightRenderer.ts:765-768,877,893](src/render/FlightRenderer.ts)) and `shadowCasters` is
  a frozen array captured in the constructor. A generator that builds lazily or reparents
  misses both registries with no error.
- **Seed discipline.** Hangar bay counts and "visually distinct under the same seed" are
  hash-driven. The airfield is earthworks-coupled and therefore terrain-authority: it takes
  `world.seedHash`, recorded explicitly, with a test — a guaranteed-airport world has
  `seedHash ≠ sourceSeedHash` and this is the exact collision that caught two Phase 6 items.

### 7-11 hangar and tower materials (2.5 d)
Procedural corrugated metal (normal + roughness), vertical rust and streak weathering
driven by a downward-flow accumulation term from bolt lines, gutter mouths and roof edges,
oxidation biased by aspect, concrete with form-tie marks, and the tower's glass. Reuses the
Phase 3 synthesis infrastructure — no new pipeline. **This is the largest single memory
consumer in 7D** and is funded from Q2's vegetation-atlas trade.

### 7-12 hangar interior (2.0 d) — **cut candidate**
Interior shell visible through open doors, dark PBR, emissive strip lighting at night, a
parked aircraft silhouette. An open door onto a black void is worse than a closed door.

### 7-13 airfield furniture (2.0 d; was 3.5 — apron markings, tie-downs and GSE cut, D-0)
Wind-driven animated windsock, fuel tanks, perimeter fence, runway/taxiway signage with
emissive faces (doubling as 7-5 light points).
- **The windsock needs a per-object wind sample.** The renderer's only wind consumer samples
  `sampleWind` at the **aircraft** and forwards four scalars to `detail.setWind`
  ([FlightRenderer.ts:2044-2059](src/render/FlightRenderer.ts)). Sample at the sock.
- **Validate on a crosswind seed.** The runway's preferred heading and the prevailing wind
  are the *same* hash expression — both `unitFloatFromHash(mixSeed(seedHash, 301)) * 2π`
  — and site selection adds a 4× wind-axis penalty
  ([airportSite.ts:847-942](src/world/airportSite.ts), [world.ts:150-152](src/world/world.ts)).
  The sock will point roughly along the runway by construction, which is authentic but makes
  it a weak test of the wind path.

### 7-14 obstruction lighting (1.0 d; re-pointed, D-0)
Red obstruction lights on the tower cab and mast and on hangar roofs; **hangar-face floods
instead of apron floods** (there is no apron). Feeds through 7-5's light points and 7-4b's
clustered lights respectively.

### 7-15 ATC tower (3.0 d) — **NEW, D-1**
Not in `RENDERING_PLAN.md`; added at Jason's request. A parametric tower: shaft, cab with
raked glass, gallery walkway and railing, antenna mast, base structure. Placed runway-local
from `AirportDefinition` on the hangar side. At night: a lit cab interior (one clustered
light plus emissive), obstruction lights (7-14), and **it is the mount for 7-7's rotating
beacon**. In daylight it is the second scale reference on final approach after the hangars.
Materials from 7-11. Same ground-query, mesh-registration and seed rules as 7-10.

**Gate 7D exit criteria.** No `CreateBox` primitive remains in `AirportSystem.ts` (the
criterion is measured against that file, so one surviving call fails it). Hangars are
visually distinct from one another under the same seed. The windsock tracks the simulated
wind vector at its own position. The tower reads as a tower from 3 NM.

**Rebaseline: R7-4 at Gate 7D close** — this moves the *day* shots, and four of them share
one pose (`approach-500ft`, `reference-viewport`, `winter-noon`, `night` are all
−2500/0 at 152 m AGL), so one structural change moves four baselines at once.

---

## 8. The night-approach acceptance flights (Jason, ~0.5 d triage)

The exit criteria that matter here are perceptual, and Q3's standard — *"it should still
look real"* — is not a number. Three named flights, flown on the reference host through
7-0-c's night entry point:

- **N-1 the full night circuit.** Depart the runway, fly the pattern, return. Does the
  beacon pick the field out from ten miles? Do the approach lights sequence you in? Does
  the PAPI show two red and two white and change as you drift off? Do the edge lights
  resolve from a smear into individual sources? Does the landing light throw a cone onto
  asphalt?
- **N-2 the mesopic descent.** Sun −3° to −8° — the band with zero capture coverage — with
  lights on, watching the rod hand-over. This is where 7-4a either works or is obvious.
- **N-3 the daylight walk-around.** 2 m on the ground and again on short final: hangars,
  tower, windsock, signage, skirt-to-ground contact. Does it look like an airfield somebody
  operates?

Output: a defect/verdict list triaged into 7-x sub-items, into a later phase, or
declined-with-reason. **No Phase 7 baseline is promoted before N-1 and N-3 have verdicts** —
D-18's lesson is that a green suite is not evidence of anything visual.

---

## 9. Sequencing, ledger, rebaseline points

```
[Phase 6 close: E-1…E-5] ─→ Gate 7-0 (2.5) ─→ 7-4a pre-exposure (2.0) ─→ Gate 7B rest (12.0)
                                                      └─ R7-1 ─┘              └─ R7-2 ─┘
   ─→ Gate 7C airfield+aircraft (9.0) ─→ Gate 7D structure (15.5) ─→ N-flights (0.5)
          └─ R7-3 ─┘                          └─ R7-4 ─┘              └ R7-5: archived tier reports ┘
```

Dependencies: everything ← 7-0-d's spike; 7-5 ← 7-4a (its HDR range is meaningless before
the pre-exposure); 7-6 ← 7-5; 7-7 ← 7-5 and 7-15 (the beacon needs its mount, so 7-15 may
start during 7C); 7-8 ← 7-4b and 7-5; 7-9 ← 7-6 and 7-8; 7-11 ← 7-10 and 7-15; 7-12 ← 7-10
and 7-4b; 7-13/7-14 ← 7-10 and 7-15.

| Block | d (nominal) | Range |
|---|---|---|
| Gate 7-0 (instruments, spike, night access) | 2.5 | 2–3.5 |
| Gate 7B (7-4 6.0, 7-5 5.0, 7-6 3.0) | 14.0 | 12–19 |
| Gate 7C (7-7 3.5, 7-8 3.0, 7-9 2.5) | 9.0 | 8–11.5 |
| Gate 7D (7-10 5.0, 7-11 2.5, 7-12 2.0, 7-13 2.0, 7-14 1.0, 7-15 3.0) | 15.5 | 14–19 |
| N-flight triage | 0.5 | 0.5–1 |
| **Total** | **41.5** | **36–54** |

**Ledger reconciliation.** `RENDERING_PLAN.md`'s remaining Phase 7 is **34.0 d**
(7B 11.0 + 7C 9.0 + 7D 14.0, per its 2026-08-19 amendment removing Gate 7A's 7.5). This
plan's item sum is **38.5 d**, a net **+4.5**: **7-4 +2.0** (the pre-exposure sub-item Gate
7A handed here by name is real work, not a tuning pass); **7-5 +1.0** (bloom does not exist
and is a new post-process; PAPI cannot come from IES; extinction must be hand-applied
because additive materials are refused by the aerial registry); **7-7 −0.5** (taxiway
lighting cut −1.0, PAPI verification harness +0.5); **7-9 +0.5** (the moon-shadow trade and
the governor's first lighting rung); **7-13 −1.5** (apron markings, tie-downs and GSE cut);
**7-15 +3.0** (the ATC tower, new). The 41.5 total = 38.5 items + 2.5 Gate 7-0 + 0.5
triage. Programme effect: the remaining-Phase-7 figure moves 34.0 → 41.5.

**Internal cut line.** 7-6 (3.0), 7-12 (2.0) and half of 7-13 (1.0) defer without breaking
anything else — a **35.5-day** Phase 7 that still delivers a flyable, lit night approach,
detailed hangars and the tower. **Do not cut 7-0-d or 7-4a**: the first tells you whether
the phase is buildable and the second is the difference between light points and a flat
grey smear.

**Rebaseline points** (full-set candidate → frame-by-frame review → manual promotion, never
mid-item; delivery floors re-pinned at each): **R7-1** the pre-exposure, alone and early —
every shot moves and this is the only point at which that is expected; **R7-2** Gate 7B
close, night shots carrying light points; **R7-3** Gate 7C close, airfield and aircraft
lighting; **R7-4** Gate 7D close, day shots moving on structure; **R7-5** 7-9's archived
per-tier night acceptance reports, which are **not** standing baselines. Between points all
shots hold their baselines exactly.

**Assertion numbering: Phase 7 starts at 119.** Verified two ways — the highest id
referenced anywhere in `src`, `tests`, `scripts`, `docs` or any `*.md` is **118**
(`118a`/`118b` at [tests/gpu/shadow-depth-wrapper-reset-guard.test.ts:262,287](tests/gpu/shadow-depth-wrapper-reset-guard.test.ts)),
and Gate W plus Waves 1–3 allocated **no new global ids**. **Do not reuse the gaps** —
94, 95, 99, 100, 101, 103 and 104 are allocated-but-unwritten from Phase 5's registry and
still belong to their original items.

---

## 10. Risks

| # | Risk | Mitigation |
|---|---|---|
| 1 | **`ClusteredLightContainer` does not fit** — `vViewDepth` overflows the 16 inter-stage limit, or the fragment-stage storage buffer is unavailable, producing an invalid pipeline that poisons the render bundle to a **black frame with no error** | 7-0-d measures all four limits on the reference adapter as the phase's first action, on production-parity materials. A miss re-prices 7-4 into a hand-rolled tile/light-list path rather than discovering it in week three |
| 2 | **The memory trade is not enough.** 2.7 MiB of real headroom against cluster buffers, ~200 instances, photometric textures and 7-11's material arrays | Q2 books `impostorAtlasMiB` + `foliageAtlasMiB` at 7-0-b, before any allocation lands; every item's inventory delta is checked at its close; the source-scan policy means an unregistered buffer cannot hide. If the trade is exhausted, the item shrinks in-gate — it does not defer the overrun to 7-9 |
| 3 | **7-4a's pre-exposure moves every pixel and the review cannot keep up.** It reopens three test-pinned constants and rebaselines all 24 shots plus the four new ones | R7-1 is solitary and early, before any light exists to confound it; the monotonicity pin makes the change *measurable* rather than judged only by eye; the night shot's own 0.96 relaxation means the appended shots, not `night`, carry the verdict |
| 4 | **Draw ceilings fail on CI before the gate closes.** They are asserted hard on every host, outside the delivery row, and 7D adds structure to a pose four shots share | One instanced draw for all light points is a stated design constraint, not a target; 7D's meshes are budgeted per item against `runway-on-approach` 169 and the appended night ceilings; the ceilings are re-pinned only at R7-3/R7-4 |
| 5 | **Babylon's clustered path changes under a bump.** The integration depends on `IsLightSupported`'s private rules, `_updateBatches`' scene-component hook, and shader-include names | `@babylonjs/core` stays pinned exactly at 9.21.2; a private-API existence test reads the installed sources (6-9's precedent); the guarded-wrapper pattern shows how a throwing construction-time probe beats a silent degradation |
| 6 | **Phase 6 does not actually close and E-1, E-2, E-3 or E-5 rot.** Phase 7 then builds on an unpromoted baseline and untruthful docs | §1 is a verification checklist with named owners, not an assumption; both owners have confirmed their rows. Gate F is deliberately *not* an entry condition, so the one item with no agent owner cannot block the phase — it only blocks the eroded default, which Q5 already assumes away |
| 7 | **6-11.4's reconciliation moves the memory ground under Q2's trade.** The honest expectation from its owner is that the *estimate rises toward the inventory* rather than the inventory falling — i.e. the likely outcome is a **ceiling move with a recorded fidelity trade, not a saving** — and the number cannot be invented in advance | Phase 7 does not size its trade against 495/492.3 as a constant. 7-0-b books the trade only after d7 messages the landed `MEMORY_CEILING_MIB[1]` and capture-pin values; until then the trade is a *menu*, not a commitment. The ratchet-down rule (§2.4) applies to whatever the new pin is |
| 8 | **Phase 7 ships a lighting engine nobody looked at.** The precedent is not hypothetical: Gate W closed an entire workstream on byte-determinism, seam audits, statistics suites, timing and 24/24 green analytic shots, and the eroded world it produced renders as flat page-shaped plates with no relief — silently, zero console errors, because **no instrument in the gate ever rendered it into an image**. A night phase is the most exposed possible case, since its whole subject is invisible to every non-visual metric | §2.10 makes a reviewed night frame a closing condition that outranks every metric, and 7-0-a appends the shots *before* 7B starts so there is something to review from day one. Note the ordering is deliberate: shots first, then engine — the reverse is how Gate W got here |
| 9 | **The adversarial-review lesson** | Before each gate close, run the adversarial diff review (6+ finders, refutation panel). Every prior phase found real defects the suites missed — Phase 6's own recon refuted 4 of 24 "does not exist" claims *in this document's research*, two of which would have invented days of work. Budget it inside each gate's range |

---

## 11. Deviation log

- **D-0 (at planning, Jason Q3):** **taxiway lighting, apron markings, tie-downs, GSE and
  apron floodlighting are re-scoped away.** Reason, verified: `AirportDefinition` carries
  nine scalar fields and no taxiway or apron data ([src/world/types.ts:18-34](src/world/types.ts));
  `rg -in taxiway src tests scripts` returns zero hits; and 3-9 deleted the apron slab and
  recorded a deviation explicitly declining to replace it because the ground slopes
  ([RunwaySurface.ts:32-37](src/render/webgpu/terrain/RunwaySurface.ts)). Building an apron
  means either extending the earthworks footprint — Class K, gated by assertion 63 and the
  on-adapter runway-earthworks parity test — or painting concrete onto a batter. Jason's
  scope is *runway, hangars, tower*. 7-7 −1.0 d, 7-13 −1.5 d, 7-14 re-pointed to the tower
  and hangar faces.
- **D-1 (at planning, Jason Q3):** **7-15 ATC tower added (3.0 d)**, which
  `RENDERING_PLAN.md` never had. It is the natural mount for 7-7's rotating beacon and
  7-14's obstruction lights — both of which currently have nowhere to sit — and the second
  scale reference on final approach.
- **D-2 (at planning):** **`AirportSystemOptions.includeHangars` does not exist and never
  did**, so `RENDERING_PLAN.md:137`'s "`AirportSystemOptions.includeHangars` is dropped" is
  void. `AirportSystem`'s constructor is three positional arguments
  `(scene, definition, groundHeight)`; the file is 106 lines; the hangar loop is `:50-73`
  with the `CreateBox` at `:53`; `:111` (cited for `specularIntensity`/`environmentIntensity`)
  is actually `:102`. Every `AirportSystem.ts` citation in the master plan is unverified and
  has been re-derived here.
- **D-3 (at planning):** **IES cannot carry the PAPI, and cannot ride a clustered light at
  all.** Two independent facts. (a) `ClusteredLightContainer.IsLightSupported` returns false
  for any spot with `iesProfileTexture` — "Extra texture bindings per light are not
  supported" — and the clustered WGSL includes contain no IES branch, so 7-4b's illuminating
  lights are plain non-IES cluster members. (b) `LoadIESData` is nonetheless a
  Light-independent parser returning a `Float32Array` of candela values that a billboard
  shader can sample as a `RawTexture`, so **7-5 needs no rescope** — but Babylon's profile is
  one-dimensional and rotationally symmetric (180 vertical samples at horizontal angle 0,
  `height: 1`, indexed by `acos(dot(-lightDirection, L))/PI`), while a PAPI is azimuthally
  asymmetric and an edge light has a horizontal cutoff. **The PAPI's law is authored
  analytically in 7-7 with a TS/WGSL parity pin;** IES carries the rotationally-symmetric
  fixtures. *Recorded so it is not re-litigated: an earlier recon claimed 7-5's IES work was
  blocked by the clustered restriction. It is not — 7-5's IES rides the billboards, which
  clustered lighting never touches.*
- **D-4 (at planning):** **"bloom coupling" is not a coupling.** There is no bloom, no glow
  layer and no `DefaultRenderingPipeline` anywhere in the tree; the post chain is exactly
  ScotopicVision → ACES → FXAA ([FlightRenderer.ts:955-995](src/render/FlightRenderer.ts)).
  7-5 prices a new post-process, its MSAA/first-pass renegotiation with the scotopic pass at
  slot 0, and a `post` budget row against tier 2's 0.05 ms of slack.
- **D-5 (at planning, Jason Q4):** **the pre-exposure decision is taken, and it is the
  largest single change in the phase.** Gate 7A deviation 2 handed it here by name. Measured
  justification: at the `night` clock the scotopic pass's σ is **4.21 cd/m²** against a
  physical adapted luminance of **8.0e-5**, `rodFraction = 1`, and with
  `displayGain = 0.16/4.698` the scene-linear values 0.01 / 1 / 1000 map to
  **0.1449 / 0.1598 / 0.1600** — a 10⁵:1 range compressed to **1.10:1**. Without 7-4a, every
  light point in 7-5 renders at the same brightness and **no existing test would catch it**:
  the only night pixel gate is the `night` shot, whose SSIM floor is already relaxed to 0.96
  for its own noise. *Note the risk the master plan names is inverted:* it warns that flying
  past a floodlight would strobe the image, but σ is purely environmental and never reads
  the framebuffer, so a floodlight cannot strobe anything — it simply vanishes into the
  saturated response. The real hazard is crush, not strobe.
- **D-6 (at planning):** **the aircraft body-axis contract is contested and the nav lights
  may be reversed.** `AircraftVisual`'s docblock and `configureRoot` metadata declare
  `port: "+z"` and the red `port-navigation-light` sits at z = +5.43
  ([types.ts:19-24](src/render/webgpu/aircraft/types.ts),
  [createAircraft.ts:553-562](src/render/webgpu/aircraft/createAircraft.ts)), while
  [src/input/index.ts:36-49](src/input/index.ts) states that the rendered basis presents
  body +Z as **starboard** and inverts keyboard roll to compensate, keeping the compensation
  local "until the complete body-axis contract can be settled". In a right-handed frame with
  forward = +X and up = +Y, starboard = forward × up = **+Z** — which agrees with the input
  module and not with the aircraft metadata. 7-8 settles this, fixes whichever side is
  wrong, deletes the compensation, and records a normative row. This is a shipped defect, and
  7-8's exit criterion ("nav-light colours correctly identify another aircraft's heading")
  cannot be met without settling it.
- **D-7 (at planning):** **the capture set cannot see two things Phase 7 needs it to see.**
  (a) Beacon and strobe timers phase-anchored to `simulationTime` sample an **identical
  phase in every shot**, because shots are spaced exactly 120 s apart and both 0.75 Hz and
  1 Hz divide 120 s into whole periods. (b) There is **no shot in the mesopic band** — the
  only sub-horizon shot is `night` at −21.5° and the next lowest is `coast-10km-lowsun` at
  +6.5°, so the entire `rodFraction ∈ (0,1)` regime, where 7-4a's hand-over lives, is
  unmeasured. 7-0-a appends `night-beacon-offset` and `dusk-mesopic` for exactly these.

- **D-8 (2026-08-31, before implementation — the eroded world is shelved and entry
  condition E-4 is struck):** Jason flew the eroded world, found it rendering as flat
  page-shaped plates with no relief anywhere (reproduced against an analytic control at seed
  `1s9phln`, silent across four loads with zero console errors, 20–60 s to ready against
  W-1's ≤1.5 s target), re-flew it after d7's fixes, found it still badly wrong, and made an
  executive call to shelve it. **§8 resolves NO** — the outcome the Phase 6 plan explicitly
  sanctions as "acceptable by Q1's own terms and not a phase failure".
  *Effect on this plan:* Q5 changes from a planning assumption to a settled fact; **E-4 is
  struck** because D-7's canonical-split fix and D-9's re-tightening exist only to make the
  eroded page producer's seams sound and blocked nothing but §8's re-default, so requiring
  them would block Phase 7 on deliberately shelved work; Gate F is discharged by events; and
  the eroded configuration's 527.5 MiB memory overage leaves the picture, making the Q2
  trade a single-configuration question against the analytic 492.3 MiB.
  *What is deliberately NOT done:* **no eroded material is deleted or rewritten anywhere in
  this plan.** The code is parked behind `?world=eroded`, not removed; E-4's struck row
  retains the full state (the loosened `worstAbsoluteToleranceMeters: 0.06`, the absent
  world-block snap, and the fact that D-9's loosening now outlives its cause — precisely the
  condition D-9 warned becomes permission) so a resumer inherits the truth rather than a
  gap.
  *The lesson this phase must carry, and the reason it is stated twice (§1 preamble and
  §2.10):* Gate W closed on byte-determinism, seam audits, statistics suites, timing and
  24/24 green analytic shots, and **not one instrument in it ever rendered the eroded world
  into an image a human looked at** — W-7's eroded shots were never appended and no eroded
  baseline was ever promoted. A whole workstream's green status was worth nothing, and only
  flying it found that out. Phase 7 is a *night lighting* phase, which is the most exposed
  possible case of the same failure: its entire subject matter is invisible to every
  non-visual metric, and the pass that would hide a black frame is already in the tree.

*(Further deviations land here with evidence, plus a normative row in `ARCHITECTURE.md`'s
decision log, per house rule.)*

---

## 12. Exit criteria and goal certification

**Gate 7B.** 200+ light points and 16 clustered illuminating lights hold the tier frame
budget; no light-count-dependent shader recompilation during flight; scene-linear decades
remain distinguishable through the night post chain.
**Gate 7C.** A full night circuit is flyable on Balanced within budget; PAPI indication
matches the geometric glideslope to within **0.1°**; nav-light colours correctly identify
another aircraft's heading on the settled body-axis contract.
**Gate 7D.** No `CreateBox` primitive remains in `AirportSystem.ts`; hangars are visually
distinct from one another under the same seed; the windsock tracks the simulated wind vector
at its own position; the tower reads as a tower from 3 NM.
**Phase.** All four tiers pass `assertWithinBudget()` at three viewport sizes with the night
rows applied; the 24 + 4 shot set is green under the strict tier-1 contract on the reference
host; N-1 and N-3 have verdicts.

Against the three goals: **G-A** gains the last two named elements that were still
placeholders — the airfield the plane departs from and returns to, and the aircraft's own
lighting; **G-B** gains the half of *time of day* that has been a placeholder since 1C-10,
because for the first time the world at 22:00 is lit by something the world contains rather
than merely being dim; **G-C** is defended by the same measured instrument as every prior
phase, with night given its own tier row rather than a scaled daytime one — and 7-0-d exists
so that the phase learns in its first day whether the engine it is priced against will
actually compile here.
