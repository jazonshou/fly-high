# Phase 4.5 Execution Plan — Run-the-App Defects at the G-C Bar

**Status:** execution reference for an unplanned corrective phase between `PHASE_4_EXECUTION_PLAN.md` and `PHASE_5_EXECUTION_PLAN.md`. It exists because the shipped Phase 4 tree fails all three project goals *as experienced from the pilot's seat*: loads crash (G-A unreachable), medium/balanced is choppy (G-C violated at the reference viewport), and the terrain has visibly regressed against the Phase 3.5 baselines (G-A regressed). Nothing in this document duplicates a numbered future item — §5 is the anti-duplication map, and every item below either names why it cannot wait for its future owner or has no future owner at all.
**Basis:** a 2026-08-20 investigation of the running app on `jazonshou/Phase-4-Implementation` (HEAD `093f5c9`): two live-captured renderer crashes with instrumented bind-skip traces, a fresh `perf:capture` run against the committed Phase 3.5 baselines, an independent Node reproduction of the CDLOD selector on real kernel deviations, and execution of `planComputeAdmissions` with the real tier-1 rows.

**Evidence grading — read before quoting any number below.** Nine findings across three investigations were handed to a second reader who was asked to refute them against the source; all nine came back confirmed, several with corrections that are folded in below. They cover: the crash chain and its latent terrain twin (`4.5-0`), the vegetation draw debt, the stale-atlas `setProfile` kill, the compute-admission starvation, the CDLOD fixed point, the NEAREST-splat/primary-only sampling, and the per-node fallback. **Everything else is single-reader investigator confidence** — specifically the readback serialization (B1), the FIFO ordering (B3), the startup compile/synthesis hitches (C2), the frame-attribution gap (C3), the double-`beginFrame` and splat-bypass halves of B2(c), and **every millisecond in §7's ranking below rows 1–2**. Those are load-bearing enough to schedule and not load-bearing enough to quote as measurements: each carries a measure-first step in its item.
**Precedence:** `ARCHITECTURE.md` stays normative. This plan absorbs and schedules the four carried items of `PHASE_5_EXECUTION_PLAN.md` §1 ("Work Phase 4 did not close") — the three named flights, assertions 83b and 85, and the tier re-measure / rebaseline — because §2's sequencing shows the rebaseline **must not run before Gate 4.5-A lands** or it blesses the visual regression into the baselines.
**Effort:** **≈15 days** (range 13–18). Item `4.5-0` is already implemented and verified (§3).
**Engine:** Babylon `@babylonjs/core` 9.21.2, WebGPU. No engine change is in scope.

---

## 0. Three symptoms, two systems

The user reported three defects and one request:

1. **"Unable to continue flight" on most loads** — `createBindGroup: Required member is undefined`.
2. **Choppy on medium/balanced; terrain constantly struggles to load.**
3. **Splotches of solid color instead of coherent terrain.**
4. A ranked list of graphics features to trade away for performance (§7).

The investigation collapsed these into two mechanisms plus one pre-existing debt:

- **The crash (1)** is a race between foliage batch growth and the CSM pass — a `ShadowDepthWrapper` cache poisoned by `resetDrawCache`. Root-caused, fixed, and pinned as `4.5-0` (§3). It was never a graphics-load problem.
- **The splotches and the "struggling to load" (3, and half of 2)** are one pipeline failure with three compounding parts: the CDLOD selector converges with the whole world stuck at L5–L7 (kilometre-scale texels *by design of the budget loop*, not by loading lag), the land-cover splat is nearest-sampled and consumes only the primary id (so even resident pages render as hard-edged single-material blocks), and non-resident pages fall back to a per-node constant (solid squares up to a full page extent). Streaming that *is* genuinely slow — serialized behind a GPU readback, admission-starved by a meter that never learns real costs — makes every churn visible on top. Gate 4.5-A and Gate 4.5-B (§4).
- **The frame time (other half of 2)** is dominated by the **pre-existing, pinned vegetation draw-call debt** — `VEGETATION_FRAME_DEBT_RATIO[1] = 5.01`, ~9 ms modelled against a 1.8 ms row — which no item before Phase 6 owns. This plan does not attempt the structural fix (6-9's GPU scatter owns it; B-2's merge is measured-and-rejected). It takes the two cheap, §5.3-legal notches that exist (§4, Gate 4.5-C) and removes the startup hitch train.

## 1. Evidence

All numbers from the 2026-08-20 09:36 capture run (quality medium / mode balanced = tier 1), **pinned at `docs/evidence/phase-4-5-baseline-report-2026-08-20T0936.json`** because `tests/perf/artifacts/report.json` is overwritten by every run — and a second run four hours later on the same tree and the same commit reported `reference-viewport` at 18.5 fps with **117** hitches against this run's 20.3 fps and 6. Nothing changed but the host's thermal state. That spread is not noise to average away: it is the un-owned Gate B residual (no item makes the capture host's thermal state a controlled variable) and the reason 4.5-D1 insists on an idle machine. Treat any fps delta smaller than this spread as unmeasured:

- **Crash:** reproduced on load 1 of 4 in the pane; Babylon's own log names the failing material context (uniqueId 968, `samplers {}`, `textures {}`, missing `Light0..2`) with `foliageAtlas`/`cloudShadowSampler`/`reflectionSampler` unbound; instrumented capture pinned mesh `detail-tree-pine-v2-trunk-near-chunk-3:0`, material `detail-bark-pine`, CSM cascade pass, `materialDefines === null` at bind time. A validation guard fired **20 times during one load** — twenty independent would-be crashes per load, which is why "most often" is the observed rate. (Observation, not mechanism: the loads that survived in the pane were ocean menu scenes with no foliage in the cascade. Consistent with the chain, not evidence for it.)
- **Visual regression:** `perf:capture` **fails against the committed baseline** (blessed at Phase 3.5, `8a9292e`): `approach-500ft` SSIM 0.9083 vs the 0.985 floor, `canopy-1200ft` **0.4546**, `forest-500ft-sunbehind` 0.7046, `ground-2m-lowsun` 0.7449, `winter-noon` 0.9047. The captures show flat polygonal color patches in the mid-field and untextured ground under forest.
- **Converged coarseness, not lag:** every one of the 16 shots reports `residentTerrainPages` 24–25, `pendingTerrainPages` 0 — the harness streams up to 6,000 frames until stable, so 25 pages is the **fixed point**. Node reproduction of `selectTerrainNodes` with real page deviations: budget 240/threshold 3 converges at ~240 nodes all at L5–L7 with the node under the camera at L6 (4 km span, 128 m height texels, 256 m splat texels) at *both* 150 m and 3,000 m altitude. The unconstrained criterion wants **≥2,300 nodes** (independently reproduced with conservative subsampled deviations; ~6,500 / ~190 pages on the denser sampling of the first reproduction) — either way ≥10× every shipped budget, which is the point: **raising the budget cannot fix this.** A priority-queue simulation with the same 240 reaches L2 under the camera with horizon coverage intact (~21 pages).
- **Frame pacing:** vegetation-heavy shots run 20.3–28.9 fps (`reference-viewport` — the G-C shot — at **20.3**), 39–53 ms interval p95 against 4.5–5.4 ms CPU p95 and 10.2–15.0 ms GPU p95, `maxFrameMs` 298–971 with `hitchCount` 3–7. Roughly half of each frame is invisible to both timers (C3). The tier-1 vegetation row is pinned at 5.01× over budget; the shadow term alone (near band × 2 cascades) is 3.85 ms of the 9.0 ms model. **The tempting A/B — veg-light shots run 42–51 fps on "the same terrain" — is confounded and is not used as evidence here:** every veg-light shot in the 16 is a high-altitude or distant camera, and the set has no near-ground vegetation-free control. The causal draw→ms evidence is `2-12`'s ledger (Δgpu tracked Δdraws linearly at ~26 µs/draw, triangle deltas ~0), not this comparison.
- **Admission starvation:** executing `planComputeAdmissions` with the real tier-1 rows: **2 height pages per pump** at scale 1, **1** at governor GPU rung 1 (×0.6), **0 — forever —** at rung 2 (×0.35), because every client's per-dispatch estimate is seeded at its entire per-frame row and `observeDispatchCostMs` has zero call sites. R-11 never recovers a work level while GPU-bound, so a GPU-bound tier 1 reaches rung 2 in ~5 governor windows (~600 frames; one window spends the down-step whose no-op fires the resolution latch, then 2 hot windows per rung) and terrain streaming stops permanently — while the *lower-priority* occlusion client still admits 2 (a priority inversion).

## 2. Sequencing rule

**The `perf:capture` rebaseline (Phase 4 carried item 4) runs at the END of this phase, after Gate 4.5-A.** Running it first — the naive reading of the carried obligation — would commit the splotch regression as the new baseline and blind the harness to exactly the defect class it caught here. Gate order: 4.5-A (visuals) → 4.5-B (streaming) → 4.5-C (felt frame) → 4.5-D (close-out: flights, carried assertions, rebaseline, re-pins).

---

## 3. `4.5-0` — the load crash (IMPLEMENTED 2026-08-20)

**Mechanism (verified link-by-link in the pinned Babylon source, then reproduced live twice):** `ShadowDepthWrapper` records each submesh's forward effect via `onEffectCreatedObservable`. `resetDrawCache` on an already-rendered mesh destroys the forward draw wrapper without notifying the wrapper. On that submesh's FIRST depth render for a generator, `_makeEffect` copies the destroyed wrapper's `defines` — `undefined` → `null` — into permanently cached depth params (the heal fires only on effect *identity* change). `PBRBaseMaterial.bindForSubMesh` silently early-returns on null defines; the depth draw executes against an empty material context; `device.createBindGroup` throws the reported TypeError; `FlightGame.tsx:505` stops the renderer for good. The trigger: `WorldDetailRuntime.bindInstanceBuffers` resets a *growing* batch's cache (`WorldDetailRuntime.ts:1481`) inside the `world-page-visibility` pass, which runs before `scene.render` — and the CSM RTT renders before the main pass can heal. Introduced by `46bc24a`'s in-place mesh reuse (the old per-rebuild mesh churn fired the wrapper's dispose cleanup, which was accidentally load-bearing); made fatal-on-load by `4-8b` putting streaming foliage into the cascade path from frame 1. The old "bisected to the STALL" incident (`TerrainClipmapSystem.ts` §stepMaterialArrayBuild comment) was the same mechanism through a wider window; the comment now says so.

**What landed:**

- `src/render/webgpu/core/guardedShadowDepthWrapper.ts` — the one construction site for every `ShadowDepthWrapper`. The guard refuses to build depth params from a destroyed forward wrapper, taking the generator's standard not-ready skip. **The honest bound on that skip:** a camera-visible mesh heals on its next main-pass render (one frame without that caster); a mesh that never reaches the main pass — a culled foliage batch, or a `layerMask 0` terrain caster — has no heal path and stops casting until something renders it forward. Still strictly better than the alternative, which is a fatal stop rather than a missing shadow. Registered in `owners.ts` (owner: lighting).
  - **Two silent-degradation modes closed by adversarial review**, both of which would have left the guard green while it did nothing or too much: the internals probe now also checks `_makeEffect`'s **arity** (a reordered parameter keeps every name intact while making the guard read the wrong argument — a pure pass-through that restores the crash), and the guard requires the registration's pass id to be a **number** before using it (`_getDrawWrapper(undefined)` falls back to the engine's *current* pass, which during the shadow RTT is a pass where casters never have a wrapper — so an unrecognised registration shape would make the guard report not-ready forever and silently stop every wrapper-based shadow). An empty `remappedVariables` array is also now normalised away rather than merely warned about in a comment: `[]` is truthy, and Babylon renders it as a zero-argument `#include<...>()` that garbles the include.
- Both construction sites (`WorldDetailRuntime.ts`, `TerrainClipmapSystem.attachTerrainSurfacePlugin`) use the factory; the boundary test now **forbids constructing the raw class anywhere in src/**.
- The terrain **caster meshes no longer `resetDrawCache`** after the `3-1` material-array build. They never render in the main pass (layerMask 0), so the reset destroyed the defines the depth path reads while refreshing nothing it uses — leaving each caster one of two death branches: the crash, or (once the orphaned effect's sources were released) silently never casting again. The beauty-mesh reset stays — that one is the documented white-pages fix, and the depth pass does not consume the fragment texturing the recompile changes.
- `tests/gpu/shadow-depth-wrapper-reset-guard.test.ts` — deterministic reproduction (register → reset → first cast, with the heal held open by layerMask 0 and the forward effect kept alive by a shared-material mesh, both mirroring production). Two cases: a **non-vacuity control** (the raw wrapper must still die in the window; if Babylon fixes the orphaning upstream this fails, which is the signal to retire the guard) and the fix (guard fires — counted through a test seam — zero uncaptured errors, and the shadow *appears* afterwards: heal, not amputation). Harness hygiene, also from review: the warmup **polls for forward-effect readiness** instead of counting 20 frames (`_makeEffect` bails before it can poison anything while the effect is still compiling, so a slow adapter would have produced a false "retire the guard" signal); `endFrame` runs in a `finally` so the deliberately-crashed frame still closes its encoders; and each case gets its **own engine and device**, because uncaptured-error delivery and Babylon's deferred effect disposal both land after the crashing test's teardown.
- `ARCHITECTURE.md`: §1 owner row + decision-log row.

**Verification:** full Node suite (611) green including the new boundary case; full GPU suite (25 files/42 tests) green; typecheck/lint clean; six consecutive live loads clean with zero console errors, plus a flight start (pre-fix: 1 crash in 4 pane loads, and "most loads" in normal use). `approach-500ft` is pixel-identical pre/post fix (mean per-pixel difference 0.00 over 921,600 pixels) — the fix changes nothing about what renders.

**Residual, deliberately not closed here:** `setProfile` with a changed cascade count calls `rebuildCasterMeshes` after the one-and-only `whenReadyAsync` sweep, creating caster submeshes with no wrapper registration at all — they silently never cast (the guard makes this safe but not correct). Owned by `4.5-B4` below, the same "setProfile leaves collaborators stale" class.

---

## 4. Work order

### Gate 4.5-A — the terrain looks like terrain again (est. 5 d)

Closes the SSIM regression. Amends **one bullet of recorded deviation D17** deliberately. D17 is principally the level-9 root decision; "selection is breadth-first by level, nearest-first inside a level" is the third of its three smaller consequences, and **only that bullet is amended.** D17's other decisions stand untouched and A1 must preserve them: the level-9 roots (the root ring is the floor cost — at level 7 the 45 km far plane needs ~121 roots), the `subIndex` page-parity lane, and the budget-remainder counting. D17's stated rationale for breadth-first was real — depth-first quadrant starvation, "the ground behind the aircraft disappears" — so the amendment is not "D17 was wrong" but "a global error queue satisfies that rationale too, measured": the priority-queue simulation retains horizon coverage at ~21 pages while reaching L2 under the camera. The decision log records the amendment rather than silently contradicting it.

| Item | What | Detail |
|---|---|---|
| **4.5-A1** | **Distance-graded CDLOD selection.** Replace the per-level breadth-first split loop in `TerrainQuadtree.selectTerrainNodes` with a global max-screen-space-error priority queue: split the worst node regardless of level until the budget is spent. | Preserve the `finestResidentLevel` clamp and the never-split-unmeasured rule. **The neighbour-level clamp is mandatory, not complementary:** the analytic crack closure (morph to parent lattice) guarantees seam identity across ONE level of difference only, and a pure max-error queue makes >1-level adjacencies common — enforce max one level between edge-adjacent selected nodes. Expected converged state (simulated with real deviations, budget 240): ~L2 under the camera at 150 m, L4 at 3,000 m, horizon retained, ~21 pages — comfortably inside tier 1's 196 atlas slots. Deviations are crease-dominated (linear in texel size, 200–500 m at coarse levels), so re-tune `cdlodPixelThreshold` per tier against the new selector; consider a high-percentile deviation metric if max-of-second-difference over-splits crease pages. Verify: assertion 107 (level under camera ≤ L2 at 500 ft over the airport, Node, real deviations); assertion 108 (no adjacent selected nodes differ by >1 level, property test over camera sweeps); `page-thrash-turn` / `cdlod-transition` captures re-examined by eye before any rebaseline. Estimated 2.5 d — the selector is one owned function, but the seam rule and threshold re-tune carry the risk. |
| **4.5-A2** | **Filtered splat sampling.** Create the seven channel-family atlas textures (`TerrainPageAtlas.ts` channel loop) with `BILINEAR_SAMPLINGMODE`; keep the height atlas NEAREST (r32float is non-filterable without the optional feature, and it is `textureLoad`-addressed by design). | This is the documented 3-0 design finally taking effect: the ecotone-axis ordering exists so a filtered PRIMARY id lands between two materials that actually meet. **Do not filter the secondary id** — neighbouring texels' secondary ids are independent top-4 picks, not axis-adjacent; a filtered id lane sweeps through unrelated integers (the failure the shader's own comment documents). If minority cover is wanted later, fetch secondaries per-texel (`textureLoad`/gather, blend resulting colors by weight) — a separate item, not this one. Same pass: fix the latent `mix(idLo, idHi, blend)` on the season-bucket ids to take `idLo` per its own comment (currently masked because buckets differ only in snow). The bake already writes the full 4-texel gutter, so a 1-texel bilinear footprint cannot cross slots. Verify: assertion 109 (GPU capture — two adjacent splat texels with different primary ids produce an intermediate blended color between them; would have caught both halves of this defect). 1 d. |
| **4.5-A3** | **Continuous provisional fallback + the channel retry hole.** (a) Derive the provisional ecotone axis **per-vertex** in the CDLOD vertex path from the just-displaced height (the same altitude-walk formula `provisionalSplatFor` uses), so non-channel-resident nodes shade a continuous gradient at vertex spacing instead of one packed constant per node — regions up to a full page extent (`512·2^L` m) currently render a single material. Move the axis derivation wholly into the shader (constants via `TerrainSpineContract`) rather than keeping two derivation sites; keep the CPU lane only for the unmeasured-page grass guard. Accept the recorded caveat: height-non-resident nodes read h=0 → grass, so beaches lose their sand band *in the fallback only*. (b) Close the never-retry hole: `updateAtlasResidency` `continue`s on height-resident pages after a `touch()` that no-ops on a missing channel key, so one failed channel admission means that page's channel slot is **never requested again** until the height page itself is evicted — the fallback becomes permanent. Re-request channel slots for height-resident pages whose channel slot is missing. (c) Adjacent, same files, same capture to verify: the splat bake keys slots on `invariantSlotKey` and bakes once, so a season-bucket rollover leaves stale splat until eviction — re-bake (or re-key) on bucket change. Verify: assertion 110 (fallback axis varies across a node — GPU capture of a known-relief page with channels forced non-resident); assertion 111 (channel admission failure is retried within N pumps — Node, injectable residency). 1.5 d. |

### Gate 4.5-B — terrain streams at flight speed (est. 4.75 d)

The streaming half of "struggles to load". Everything here is either unowned by future plans or explicitly a minimal bridge that `5-4`'s page-generation DAG subsumes (noted per item; Phase 5 is months out and the defect is user-visible today).

| Item | What | Detail |
|---|---|---|
| **4.5-B1** | **Decouple dispatch from readback.** Publish height pages for DRAWING at dispatch-submit (the vertex shader needs only texels, written by that frame's dispatch); let bounds/deviation stats arrive a round-trip later — the CDLOD split is their only consumer and the never-split-unmeasured rule already tolerates late data. Split "texels resident" from "stats resident" in `TerrainAtlasResidency`; stop gating the next batch on `readbackPending`/`generationInFlight` (the epoch-token lifecycle already rejects stale completions). | Today's throughput is *admitted-batch-size per multi-frame readback round-trip* (~1 page/frame best case, worse at 24 fps), and a fresh spawn needs ~10 sequential generate→readback→split round-trips to descend from the L9 roots. **Measure before building:** instrument the actual round-trip and pages/second first — this item's mechanism is single-reader confidence, and if the readback is not the binding constraint the fix is B2's admission repricing alone. `5-4` restructures generation into a multi-frame DAG; this item deliberately does NOT build that. **Half of it is inherited, half of it must be retired at `5-4`:** removing the `readbackPending`/`generationInFlight` gate is permanent (the DAG never gates the next batch on a readback either), but **publishing texels at dispatch-submit is legal only while pages are final at dispatch — i.e. only in the analytic-kernel era.** `5-4`/D12's convergence rule is explicit that a slot is never sampled mid-erosion and that publish is the DAG's last stage. Write the fast path so it is deleted, not fought, when erosion lands: gate it on a named `pagesAreFinalAtDispatch` condition rather than scattering the assumption. 1.5 d. |
| **4.5-B2** | **Make the compute meter truthful.** (a) Feed real costs: read each terrain compute shader's `gpuTimeInFrame` perf counter after a batch resolves (the engine already enables GPU timing when timestamp-query is granted), **divide by the batch size** (the counter times the whole batched dispatch; the meter prices per page), and call `observeDispatchCostMs` — today it has zero call sites and every estimate sits at its whole per-frame row (~5–10× overpriced before scaling). Without timestamps, seed at a measured per-page constant, not the row. (b) **Floor of one:** `planComputeAdmissions` — inside `ComputeBudget`, the owner; not a pump-side bypass — always admits ≥1 dispatch for the highest-priority client with pending demand. The compute ladder's stated intent is that deferring a page bake by a frame is invisible; starving terrain to zero forever while the lower-priority occlusion client still admits two (the verified priority inversion) is not that. **Note for Phase 5:** the floor means the cap can be exceeded by one dispatch, so `5-4`'s unwritten assertion 105 ("caps hold on burst traces") must be authored floor-aware. The 4-0b invariant survives — the floor lives inside the owner, so everything is still admitted *through* `ComputeBudget`. (c) **One `beginFrame` per `TerrainClipmapSystem.update()`**: both pumps currently call it, each wiping the other's plan and spending a fresh cap — the 4-0b "one cap" invariant is broken in the owner's own call sites. Both pumps submit into one plan; price the splat bake as `splatCompute` (never submitted today) and the pyramid re-bake as a terrain dispatch. Land (a) before or with (c): with truthful sharing and today's seeds, terrain admissions would *drop* — verified by execution. Verify: assertion 112 (two clients submitted in one frame share one cap — the missing invariant test); assertion 113 (estimates converge: after N observed batches the terrain estimate is within 3× of observed per-page cost); assertion 114 (at computeBudgetScale 0.35 with pending height pages, ≥1 height page is admitted per pump). 1.5 d. |
| **4.5-B3** | **Stream in priority order; let turns evict.** Re-rank the pending `generating` set against the current corridor each pump before slicing (ranking function and observer already on hand), or cap `terrainPageRequestsPerUpdate` (default: Infinity) near the real drain rate so admission order stays fresh; make stuck-`generating` slots reclaimable after an epoch timeout (`evictionCandidates` currently considers only `resident`). Today a banked turn appends the newly urgent pages behind tens of stale requests and drains FIFO. Verify: assertion 115 (after a simulated 90° heading change, the next admitted batch is corridor-ranked, not FIFO). 1 d. |
| **4.5-B4** | **`setProfile` leaves collaborators stale.** (a) An atlas-reshaping quality switch (e.g. high→medium: 256→196 slots) disposes and recreates both atlases but leaves `pageGenerator`/`occlusionBake`/`splatBake` holding the disposed ones — `generate()` silently early-returns on `!atlas.hasTextures` forever, slots pile up un-evictable in `generating`, and **terrain streaming is permanently, silently dead for the session**. Dispose the old generator/bakes first (their `disposed` flag makes late readbacks inert), then reconstruct all three against the new atlases; the pyramid holds no atlas reference and survives. (b) Same class, from §3's residual: after `rebuildCasterMeshes` on a cascade-count change, new caster submeshes have no wrapper registration and never cast — re-run a readiness sweep (or force-compile) for rebuilt casters. Verify: assertion 116 (Node, injectable generator seam — the NullEngine suite structurally cannot see this: it never constructs the generator; a reshaped `setProfile` still brings a requested page to `resident`). 0.75 d. |

### Gate 4.5-C — the felt frame at tier 1 (est. 3.25 d)

What can move the G-C number *now* without re-litigating what Phase 6 owns. The vegetation draw-call debt's structural fix stays with `6-9` (gpu-scatter) and `6-11` (tiers v2); B-2's crown/trunk merge **stays rejected** — do not re-attempt it without solving the depth pre-fill loss, and gate any variant on measured adapter deltas (the model has already been wrong once).

| Item | What | Detail |
|---|---|---|
| **4.5-C1** | **Vegetation shadow-cast knob.** A profile data field (tier rule: data, not `profile.tier` branches) that registers detail prototypes with `castsShadows: false` at tier ≤1. Recovers **~3.85 ms modelled** (148 of 347 draws — the largest single term in the 9.0 ms row); trees keep the shadows they *receive* (horizon map, cloud shadows). **§5.3 legality, stated precisely:** shadow casting appears in neither §5.3's ordered-lever list nor its "not budget knobs at any tier" fidelity list, so the letter of the rule permits it; its headline ("reduce the number of plants before the fidelity of any plant") could be read to cover cast shadows, so the governing precedent is **D15**, which cut a tier-2 cascade specifically to reduce vegetation shadow draws — treating the shadow side as outside the ladder. C1 also only ever lowers a count row, so the ratchet is satisfied. **The `shadowCascades` 2→1 option is NOT taken here.** Tier 1's 2×1280 cascades are D15's measured decision and §6 lists it closed; changing it needs the same amend-and-log treatment A1 gives D17, on its own measurements. If C1+C2 miss the G-C bar, that is 4.5-D4's documented input to `6-11`, not licence to quietly take a closed decision. Re-pin `VEGETATION_DRAW_CEILING`/`DEBT_RATIO` per that file's contract. Verify on the adapter (B-2's lesson — the model has been wrong here before): before/after GPU p95 on `approach-500ft`/`forest-500ft-sunbehind`. 0.75 d. |
| **4.5-C2** | **Kill the startup hitch train.** (a) Pre-warm the four terrain compute pipelines behind the existing load screen with a 1×1 dummy dispatch each. Three of them inline the ~750-line kernel (page generation, pyramid, splat bake); the occlusion shader does not, and is pre-warmed for its own size. Babylon 9.21 has no async compute-pipeline path — it calls `createComputePipeline` synchronously on first dispatch — so these land in-frame during early flight unless pre-warmed. the ocean's `waitForComputeReady` idiom exists and `5-4`/D12 already mandates it for erosion — apply it to the Phase 4 shaders now. (b) Move the ten ~110 ms material-layer syntheses off the main thread: `synthesizeSurfaceMaterial` is pure CPU pixel math with no Babylon dependency — a worker + transferables deletes the ten-dropped-frames window at spawn while keeping the one-upload-at-the-end structure (the in-file comment's pacing constraints — no setTimeout chains — stay satisfied: the frame loop still drives consumption). The recorded C2-deferral (GPU synthesis) stays deferred; this is a thread move, not a pipeline change. Verify: `maxFrameMs` on the first 240 frames drops from ~1 s-class to <100 ms-class in the capture report's warmup. 1.5 d. |
| **4.5-C3** | **Per-pass GPU attribution (assertion 67, carried open through two phases, owned by nobody).** Cheap first step only: sum Babylon's per-pass `gpuTimeInFrame` counters (shadow generators, compute dispatches, main pass) into `RenderDiagnostics` and the capture report, labelled as uncorrelated aggregates. **B-0's rule stands:** no present-wait inference without a frame-correlatable timestamp source; this item makes the 39–53 ms-vs-15 ms gap *inspectable*, not attributed. Every tuning decision in this gate is currently made against a counter that under-reports the frame 2–4×. 1 d. |

### Gate 4.5-D — close-out (est. 2 d)

1. **Re-baseline `perf:capture`** on the idle reference machine (`npm run perf:capture:rebaseline`) — only now, with 4.5-A landed. Re-pin the two Phase 4 scenes' residency ceilings from what the fixed selector actually produces (they are design intents today). Record the host-pacing caveat (back-to-back runs degrade ~40%; the honest cross-machine counters remain drawCalls/batches/triangles).
2. **Fly the three named flights** (full descent, mountain cruise at low sun, season scrub across a bucket boundary) and commit the recordings as the carried human deliverables. They are cheap now and were cheap in Phase 4; carrying them a third phase makes them fiction.
3. **Write assertions 83b and 85** (fragment-stage `vPositionW`-equals-displaced-height readback beside `terrain-physics-parity`; level-N splat weights equal the box average of the four children within quantisation). Both were "cheap to add" in two consecutive plans; 85 in particular would have constrained this phase's splat work.
4. **Tier table re-measure** at the reference viewport with 4.5-C landed, committed to `docs/PERFORMANCE.md` — the G-C number, measured, not impressioned. If `reference-viewport` still misses ~30 fps after C1+C2, that is the *documented* input to `6-11`'s re-tiering, not a failure of this phase — but it must be a number.

---

## 5. What this phase deliberately does NOT do

| Not done | Why | Owner |
|---|---|---|
| Restructure page generation into the readiness/DAG lifecycle | `5-4`/D12 owns it. 4.5-B1 is a minimal bridge: its gate removal is inherited by the DAG, but its publish-at-dispatch fast path is analytic-era-only and **must be retired at `5-4`'s convergence rule** — B1 says how to write it so that retirement is a deletion | `5-4` |
| Any erosion, drainage, channel, bathymetry work | Whole of Phase 5 | `5-1`…`5-13` |
| The vegetation draw-call structural fix (merge/scatter/indirect) | B-2 measured-and-rejected; the remainder is GPU scatter | `6-9`, re-tiering `6-11` |
| Re-tune tier definitions wholesale | Tiers get re-measured and re-cut once, on numbers, after the structural work | `6-11` (4.5-D4 supplies its input) |
| Grass radius / cloud / water / MSAA knob turns at tier 1 | Real but small next to C1 (§7 ranks them); spending churn budget twice (now and at 6-11) buys ~1–2 ms | `6-11`; §7 documents the order |
| Device-loss recovery, renderer fatal-stop quarantine | Unowned by any plan (recorded gap). Fail-loud stays correct; the known crash class is closed at the root by `4.5-0`. A quarantine that skips "the offending mesh" trades a visible stop for silent corruption — rejected without better evidence | unowned, revisit at Phase 6 close |
| Present-wait attribution beyond aggregates | B-0's correlation rule; no frame-id source exists in the pinned Babylon | unowned (4.5-C3 is the honest fraction) |
| Making the capture host's thermal state a controlled variable | Recorded as an open Gate B residual and reconfirmed by this phase's own two runs (§1). 4.5-D1 mitigates by procedure (idle machine), which is not the same as owning it | unowned |
| Cross-device erosion determinism, R-5F | Explicitly unpromised by Phase 5 | R-5F |

## 6. Constraints carried into every item

- **D13–D16 are closed decisions.** Using `PHASE_4_EXECUTION_PLAN.md` §4's numbering, which is authoritative: D13 = the `P1` headroom re-measure, **D14** = tier-0 `channelAtlasSlots` 100, **D15** = Governor B rung 0 as two notches *and* tier 1's 2×1280 cascades, **D16** = parity re-pinned to 5 mm (not 1 mm). ⚠️ **The code comments disagree with the plan document** — `QualityProfile.ts` labels the channel-slot cut "D13" and `AdaptiveGovernor.ts` labels the rung deviation "D14", both one off. Cite the plan numbering in this phase and fix the comment labels in the 4.5-D stale-comment sweep; do not let a "D14" in a diff mean two different things.
- **D17's selection bullet — and only that bullet — is amended by 4.5-A1**, with measured justification recorded in the decision log rather than a silent contradiction. Its level-9 roots, parity lane and remainder counting stand.
- **The tier rule:** every knob this phase adds is a `WebGpuQualityProfile` data field. No subsystem branches on `profile.tier`.
- **The §5.3 vegetation trade-off order** is untouched: stems/ha and fidelity levers stay where the ratchet put them; C1 touches a lever §5.3 does not govern.
- **`finestResidentLevel` follows page-demand accounting, never a graphics knob** (the height authority warning in `QualityProfile.ts`).
- **Rebaseline discipline:** exactly one sanctioned rebaseline, at 4.5-D1, after the visual gates. Any SSIM churn before that is a defect, not drift.
- **B-2 stays rejected.** The model that priced the merge has been wrong on the adapter once; every C-gate change lands with adapter measurements, not model arithmetic.

## 7. The graphics-for-performance ranking (user question 4)

Tier 1 at the reference workload; "recovery" is frame-time reclaimed if removed or reduced. The first two rows are where the actual time is; most folk-wisdom targets are already free.

**How solid each row is.** Rows 1–2 rest on the repo's own pinned model (`VEGETATION_FRAME_DEBT_RATIO[1] = 5.01`, an arithmetic test, and `2-12`'s measured 26 µs/draw ledger) and were adversarially verified. **Rows 3–8 are single-reader estimates derived from budget rows and profile constants, not measurements** — they are ordered correctly with respect to each other and are the right list to work down, but no millisecond in them should be quoted as measured, and the ordering below row 2 could reshuffle once C3's attribution exists. Rows 9–10 (the do-not-touch and zero-recovery lists) are the confident part of the tail: they say where time is *not*.

| # | Feature | Cost on tier 1 | Recovery if cut | How |
|---|---|---|---|---|
| 1 | **Vegetation draws (trees/shrubs/understory)** | ~9.0 ms modelled (pinned 5.01× over its 1.8 ms row; 347 draws × a measured 26 µs). The veg-heavy-vs-veg-light GPU gap is ~8.8 ms but is altitude-confounded — see §1 | Full removal ~9 ms — but that deletes the forests; knobs barely move it (draws scale with chunks×meshes, and a chunk is 4 km) | Structural: `6-9`. Not this phase |
| 2 | **— of which: vegetation shadow casting** | **3.85 ms** (near band redrawn into 2 cascades; 43% of row) | **~3.85 ms** | **`4.5-C1` — the cheapest large win that exists** |
| 3 | **Grass/ground cover near the surface** | ~7 ms extra in ground-level shots vs airborne | Several ms at takeoff/landing, ~0 at cruise | Existing knob: `grassRadiusMeters` 150→90–110 (§5.3's designated first lever). Deferred to `6-11`; turn it early if C1+C2 miss the bar |
| 4 | **Volumetric clouds** | 2.2 ms row (under its allocation) | ~1.2–1.6 ms at tier-0 values; ~2.3 ms removal | Existing knobs (`cloudResolutionScale` 0.45→0.25 etc.) |
| 5 | **Terrain surface material (splat sampling, biplanar)** | ~2.6 ms row; 3-vs-1 samples measured ≈1.8 ms on cruise-horizon | ~0.5–1.0 ms | Existing fields: `heightBlendMaxMaterials` 3→2, `terrainTriplanarMode`→planar |
| 6 | **Water (FFT + raster)** | 1.6 ms row; computes every frame with no water in view | ~0.5 ms (skip-when-dry gate, easy new knob); ~1.6 near coast | `oceanCascades` 4→3, or visibility gate |
| 7 | **CSM, non-vegetation share** | 0.7 ms row (4-8b already took the big cut) | ~0.3–0.5 ms | `shadowMapSize` 1280→1024, or cascades 2→1 (combined with #2) |
| 8 | **MSAA 2×** | ~0.2–0.4 ms + 34 MiB | ~0.2–0.4 ms net (FXAA re-attaches) | `msaaSamples` 2→1 — rank last |
| 9 | **Terrain page/occlusion compute** | ~0 steady-state (amortised, governor sheds it first) | **~0 — cutting it reintroduces streaming pain for nothing** | Treat any proposal here as a red flag |
| 10 | **Zero-recovery list** | Planar reflections (retired), PCSS (never shipped), 3-axis triplanar & 4× MSAA (tier 2+), erosion row (unshipped), stars/scotopic by day (auto-off/copy-only), sky probe (~0.03 ms), wildlife (~0.26 ms), bloom/TAA (don't exist) | 0 | Do not spend effort here |

The strongest overall lever is none of these: it is render scale (the 1.5 Mpx cap / 0.86 renderScale, governor-stepped to a 0.75 floor) — worth remembering before trading any feature away.

## 8. Assertions added by this phase

Numbered 107+. Phase 4 added assertions 68–86 and is implemented, so the highest implemented number is 86 with **67, 83b and 85 carried open**; Phase 5 reserves 87–106 and Gate B uses the lettered 67a–67f. Verified: nothing in the repo uses 107–118 today.

| # | Assertion | Item |
|---|---|---|
| 107 ✅ | Selected level under the camera ≤ L2 at 500 ft over the airport (Node, real kernel deviations, tier-1 budget) — `render.webgpu-terrain-clipmap` | 4.5-A1 |
| 108 ✅ | No two edge-adjacent selected nodes differ by more than one level (property test, camera sweep) | 4.5-A1 |
| 109 ✅ | Two adjacent splat texels with different primary ids sample to an intermediate value through the ATLAS'S OWN sampler (`gpu/terrain-splat-filtering`) | 4.5-A2 |
| 110 ✅ | Provisional fallback varies across a single node on known relief — measured spread 143.8 derived against 1.9 with the axis forced, which is the old per-node constant's behaviour and the assertion's non-vacuity control | 4.5-A3 |
| 111 ✅ | A failed channel admission is re-requested within N pumps (Node, `computeFactory` seam) | 4.5-A3 |
| 112 ✅ | Two compute clients submitted in one frame share one cap, plus one `beginFrame` per `update()` in the owner's own call sites | 4.5-B2 |
| 113 ✅ | Dispatch-cost estimates converge to within 3× of observed per-page cost | 4.5-B2 |
| 114 ✅ | At `computeBudgetScale` 0.35 with pending height pages, ≥1 height page is admitted per pump — and the floor fires only for the highest-priority client that got nothing | 4.5-B2 |
| 115 ✅ | After a course change the admitted page is the CORRIDOR-ranked head of the pending set, ranked in the test from `world/streamingPriority` rather than from the clipmap's internals, with an explicit check that it differed from the queue's head | 4.5-B3 |
| 116 ✅ | A reshaping `setProfile` still brings a requested page to `resident`, in both directions | 4.5-B4 |
| 117 ✅ | Raw `ShadowDepthWrapper` construction is forbidden outside the guarded factory (`tests/architecture.boundaries.test.ts`) | 4.5-0 |
| 118a ✅ | Non-vacuity: the raw wrapper still dies in the reset-then-cast window (`tests/gpu/shadow-depth-wrapper-reset-guard.test.ts`) | 4.5-0 |
| 118b ✅ | The guarded wrapper skips that window and heals: guard fires, zero GPU errors, shadow appears | 4.5-0 |
| 83b ✅ | Fragment-stage readback: the half of a height ramp below sea level renders as SUBMERGED and the half above renders dry, calibrated against all-wet and all-dry references — undisplaced, `vPositionW.y` would be 0 for every fragment and both halves would read wet | 4.5-D3 |
| 85 ✅ | A page's dominant cover is one of its four children's on 99.2% of texels, and where it is not it is a NEIGHBOUR on the ecotone axis (worst step 2), never a jump across it. Stated as dominance rather than weight equality: the parent supersamples inside its own texel and re-selects a top-4 against a differently band-limited height page, so the vectors are not equal by construction and no quantisation tolerance would make them so | 4.5-D3 |

Three more landed that the plan did not number, because each is a property no
existing test could see:

| Test | What |
|---|---|
| `gpu/terrain-streaming-convergence` | A cold spawn driven through the WHOLE real chain on a real adapter — admission, dispatch, readback, and the selector's never-split-unmeasured rule feeding back into the next frame's page demand. Converges to 319 nodes at L2 within 100 frames. This is what caught §10.2. |
| `gpu/terrain-height-generate` (new case) | Three generation batches issued back to back without awaiting a readback; none may complete at an atomic identity. The direct regression test for the bounds-buffer ring. |
| `gpu/terrain-compute-cost` | Re-measures every client's per-dispatch GPU cost through `timestamp-query` and fails when a pinned seed drifts more than 4×. The seeds are load-bearing now that they are the meter's only honest input. |

## 9. Exit checklist

- [x] The ONE sanctioned post-`4.5-A` rebaseline is taken (`npm run perf:capture:rebaseline`, 2026-08-20 15:39, pinned at `docs/evidence/phase-4-5-rebaseline-2026-08-20T1539.json`). `approach-500ft`, `canopy-1200ft`, `forest-500ft-sunbehind`, `cruise-horizon` and `ground-2m-lowsun` reviewed by eye against the previous baselines: the mid-field polygonal colour patches are gone, the far mountains have relief again, and the near ground is textured. **`perf:capture` is NOT green** — see the unchecked item below.
- [x] Level under camera at the approach pose: **L2**, not L6 — assertion 107 in Node on real kernel deviations, and `gpu/terrain-streaming-convergence` on a real adapter through the whole streaming chain.
- [x] `reference-viewport` and the full 16-shot row measured and committed to `docs/PERFORMANCE.md`, with a same-host pre-change control beside it. Mean GPU p95 across the set 10.76 → 9.78 ms; across the ten vegetation-heavy shots 14.02 → 12.38 ms.
- [x] `VEGETATION_DRAW_CEILING` re-pinned 270/360/500/650 → 160/200/500/650 and `VEGETATION_FRAME_DEBT_RATIO` 5.57/5.01 → 3.28/2.87; residency ceilings re-pinned 196 → 88 from what the fixed selector produces; the D13/D14 comment labels corrected to the plan's numbering.
- [x] Terrain streaming survives a runtime quality switch in both directions (assertion 116, medium → high+ultra → medium, through the `computeFactory` seam).
- [ ] **`perf:capture` green.** It is not, and not because of a visual regression: `approach-500ft` measures 19.1 fps against a committed floor of 24 — and the pre-change control measures 20.9 on the same host, so the floor is unmet by BOTH trees. The floors were deliberately left where they are rather than relaxed to fit a hot laptop. Re-run on an idle reference machine; if `reference-viewport` still misses 30 fps there, that is `6-11`'s documented input.
- [ ] No load crash in 20 consecutive cold loads at an airport spawn. Mechanism-level ✅ (assertions 117/118a/118b, plus six clean live loads at `4.5-0`); the 20-load count is a human deliverable and has not been re-run since.
- [ ] The three named flights flown and committed. **Still not done** — carried a third time. They are recordings, not code, and nothing in this phase could produce them.

---

## 10. Implementation record (2026-08-20)

Everything in §4 landed. What follows is what the code does that this document
did not say, why, and the numbers that decided it. Read §10.3 before quoting
any figure in §1 or §7: the host's thermal state moved further during this
phase than any change in it did, and the only comparisons below that mean
anything are same-host, back-to-back.

### 10.1 Deviations from the plan, and the reasons

| Item | Deviation | Why |
|---|---|---|
| `4.5-A1` | **`cdlodPixelThreshold` is unchanged at every tier; `cdlodNodeBudget` moved instead** (160/240/320/448 → 224/320/448/640). | The plan asked to "re-tune `cdlodPixelThreshold` per tier against the new selector". Measured with real kernel deviations, the selector produces the IDENTICAL node set at thresholds of 3 and 6 pixels, because a kilometre-texel node at the horizon subtends far more than either: the node budget binds first at every shipped tier. The threshold still governs the un-budget-bound case (calm ocean, high cruise over flat ground) and was left alone; the budget is now the knob that decides how fine the ground gets, and it is a step function — 240 converges at L3 under the aircraft, 288-320 reaches L2. |
| `4.5-A1` | The 2:1 clamp is enforced as a **precondition on splitting**, not as a repair pass, and a closure that would need to split an unmeasured page is REFUSED rather than granted. | Both rules the plan carries forward stay intact that way — nothing below `finestResidentLevel` is selected and nothing unmeasured is split — and the invariant holds by construction, which is what makes assertion 108 a property rather than a spot check. The cost is that a seam near an unstreamed page stays one level coarser for a frame, which is strictly better than splitting on a guess. |
| `4.5-A1` | The plan's simulated "~21 pages" is **35-44 pages measured**, and L2 rather than L1. | The simulation did not carry the neighbour clamp, which is where the difference is. Still far inside every atlas (tier 1 holds 196 slots). |
| `4.5-A2` | The page path supplies **no secondary id at all** (`-1`), rather than fetching one per texel. | The plan defers per-texel minority cover to its own item; nothing reads the lane today, and returning `0` there would silently mean SAND. `-1` is the honest value and the one a later reader will notice. |
| `4.5-A3` | The CPU lane is **a single axis override**, not a packed (primary, secondary, weight) triple. | Once the walk is per vertex the only thing the CPU still knows that the shader does not is whether the height it sampled means anything. `packTerrainNodeSplat` is deleted rather than left as a second, unused derivation site. |
| `4.5-B1` | Publishing at dispatch needed **a ring of bounds buffers**, which the plan did not anticipate. | See §10.2 — it is the most important thing this phase found. |
| `4.5-B2` | The seeds are **higher** than the rows they replace at every client, not 5-10x lower. | The plan expected the row-seeded estimates to be over-priced. Measured, one height page costs ~1.9 ms of GPU against a 0.7 ms row: the estimates were UNDER-priced, and the floor of one is not a safety net but the terrain client's only admission path. Recorded in `COMPUTE_DISPATCH_SEED_COST_MS` and in §10.4 as an input to Phase 5/6. |
| `4.5-B2(c)` | The channel bake is submitted as **one paired admission to `occlusionCompute`** at the combined per-page cost, rather than as two independent client demands. | A channel slot's two dispatches are one unit of work — the slot is published only when both have written, because publishing between them puts material 0 at weight 0 (sand) on screen permanently. Submitting them separately let the higher-priority `splatCompute` half be admitted while the `occlusionCompute` half was not, and `min()` of the two is zero. `splatCompute` now carries the season re-bakes, which genuinely are independent. |
| `4.5-B3` | The re-ranking is real but **the backlog it re-ranks is two or three pages, not "tens"**. | Page demand cannot run ahead of measurement: the selector only splits pages whose deviation it already has, so requests and dispatches converge to the same rate. Assertion 115 is written against the achievable backlog and asserts the dispatched page is the corridor-ranked head, with an explicit non-vacuity check that it differed from the queue's head. |
| `4.5-C1` | Measured **48 draw calls** recovered at the reference viewport, against 148 modelled. | The model counts every presentation chunk a band's disc touches; the frustum drops most of them. The direction and the ranking are right, the magnitude is not — which is the same lesson B-2 recorded, applied to its own model. |
| `4.5-C2(a)` | The pre-warm dispatches **a real page**, not a 1×1 dummy. | Every shader gets valid job data (a zeroed job divides by a zero texel size in the occlusion march), the pyramid is made resident, and the coarsest root under the spawn is a page the quadtree needs first anyway. |
| `4.5-C2(b)` | `MaterialArraySynthesis.ts` was **split**, with the GPU boundary moved to `MaterialArrayUpload.ts`. | A worker that transitively imports Babylon's texture stack pays for a module graph it can never use. The split is along the line that file's own header already drew ("Class P except the single GPU boundary"), and it is what keeps the recipes worker-safe by construction rather than by luck. |
| `4.5-B1` (extra) | **L10 parent pages are no longer streamed.** | A node at the root level has `morphK = 0` by construction, so the L10 page it would morph into is generated at ~1.9 ms and given an atlas slot purely never to be sampled — four of them, measured, on every spawn. |

### 10.2 The finding this phase turned on

**Publishing texels at dispatch-submit is correct and it silently broke every
page's bounds.** `TerrainPageGenerator.generate()` awaits `dispatchWhenReady`
before issuing the bounds readback, so the `copyBufferToBuffer` that snapshots
the atomics is encoded a MICROTASK later — after `scene.render()` has returned,
i.e. into the NEXT frame's command encoder. The next frame's `generate()` has
by then already issued `boundsBuffer.update()` to re-seed the atomics for its
own batch, so the copy read the identities back: min `+Infinity`, max
`-Infinity`, deviation `0`.

A page then completed at ZERO deviation. The CDLOD selector reads zero error,
never splits, and the whole world converges at the root ring. Measured through
the real renderer: **27 nodes and 9 resident pages, unchanged for 900 frames**,
with 1.18 M → 0.30 M triangles in the capture. The Node suite was green. The
GPU suite was green. `perf:capture` reported it only as a lower SSIM, which is
exactly the "every automated test was green and the screen was black" pattern
`ARCHITECTURE.md` already records for the Phase 4 close.

Three things came out of it and all three are now permanent:

1. A **ring of bounds buffers** (`BOUNDS_BUFFER_RING`), with the pump deferring
   rather than reusing a buffer whose read has not landed.
2. `tests/gpu/terrain-height-generate.test.ts` issues three batches back to
   back without awaiting a readback and asserts none of them completes at an
   atomic identity.
3. `tests/gpu/terrain-streaming-convergence.test.ts` — a **cold spawn driven
   through the whole real chain on a real adapter**: admission, dispatch,
   readback, and the selector's never-split-unmeasured rule feeding back into
   the next frame's page demand. That feedback loop is the thing that can
   deadlock, and no Node test can see it because under NullEngine the system
   never constructs a generator. It converges to 319 nodes at L2 within 100
   frames.

### 10.3 The host, and what the numbers are worth

§1 warned that two runs on the same tree four hours apart reported
`reference-viewport` at 20.3 fps / 6 hitches and 18.5 fps / 117, and that any
fps delta smaller than that spread is unmeasured. That warning was an
understatement. Re-running the **pre-Phase-4.5 tree in a clean worktree on this
host, back to back with the new one**, reports 16.5 fps and 232 hitches against
the pinned 20.3 / 6 — the host, not the code, moved the number by 19%.

So the only honest comparison is same-host and back-to-back, and it is this:

| `reference-viewport` | pre-4.5 (HEAD) | Phase 4.5 |
|---|---|---|
| GPU p95 | 12.53 ms | **10.76 ms** |
| CPU p95 | 6.1 ms | **5.5 ms** |
| fps | 16.5 | 15.8 |
| interval p95 | 66.9 ms | 69.8 ms |
| hitch count | 232 | 238 |
| draw calls | 446 | **398** |
| triangles | 1.18 M | 1.74 M |
| resident pages | 24 | **38** |

GPU p95 down 14% and CPU p95 down 10% while drawing 47% more terrain triangles
and streaming 58% more pages. fps and interval are inside the host's own noise
in both directions and neither is evidence of anything on this machine.

**The G-C number is therefore not settled by this phase**, and saying otherwise
would be inventing a measurement. What is settled is that every change in Gate
C moved its own counter the right way, and that the frame is still dominated by
something neither the CPU nor the GPU timer sees — a ~10 ms GPU p95 against a
~70 ms interval. `4.5-C3`'s per-pass aggregates make that gap inspectable and
confirm it is not the shadow pass and not terrain compute; naming it needs the
frame-correlatable timestamp source `B-0` requires and no plan owns.

### 10.4 Findings recorded for later phases

- **A height page costs ~1.9 ms of GPU** (264² texels × 4× supersampling
  through the ~750-line kernel), against a 0.7 ms tier-1 `terrainCompute` row.
  Two consequences nothing here acts on: the compute rows in
  `PerformanceBudget.ts` are not reachable for this client at any tier, and the
  meter has no notion of amortising one dispatch across several frames — the
  `4.5-B2(b)` floor is what stands in for both. `6-10`/`6-11` own the
  re-measure.
- **Supersampling is 4× at every level above L0** and is the dominant term in
  that 1.9 ms. The analytic `filterWidthMeters` band-limit already runs; the
  supersample is on top of it. Dropping or grading it by level is a ~4× cut in
  the single most expensive compute client, and it is deliberately NOT taken
  here because it changes stored page heights and would need its own visual
  measurement. Phase 5 owns the page-generation DAG and should price it there.
- **Splat texel size is the remaining "splotch" at range.** Filtering fixed the
  hard block edges wherever the texel is small; a channel texel is
  `4·2^L` m, so at L7+ the filtered footprint is hundreds of metres and the
  boundaries are still visibly hard in the mid-field. That is a page-geometry
  question (`§5.2`), not a sampling one.
- **`splatIdHi` is now written and never read.** `4.5-A2` takes the ids from
  the low bucket alone, so one of the seven channel-family textures is baked
  and stored for nothing — a channel-atlas row and a share of the splat bake.
  Retiring it is a `WORLD_PAGE_GPU_CHANNELS` change with a memory-estimator
  row behind it, which is Phase 5's page-payload territory.
