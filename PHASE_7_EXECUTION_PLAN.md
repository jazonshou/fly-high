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
| **Q2 Memory** | **SUPERSEDED 2026-08-31 late (D-13): memory is not the binding axis at all, and Gate 7B needs no trade for TWO independent reasons.** (i) 7B's own allocations total **under 0.1 MiB** — tile mask ~16 KB at the shipped 64×64 tiles, ~200 light points at 32 B ≈ 6.4 KB, an IES profile is 180 floats; and (ii) `SWE III`'s QR-1 measurement found **draw calls bind, the frame budget is mis-modelled, and memory is not an axis**. Either reason alone discharges the trade, so a reader who finds a hole in one still has the other. **The remaining consumer is 7-11's material arrays at ~2.67 MiB per layer** — a 7D question, priced there. *(Prior scoping, retained for provenance:)* **The vegetation atlases fund Phase 7 — but they fund 7D, not the lighting engine. Re-scoped 2026-08-31, D-10.** Measured: the lighting engine is **not** a memory consumer. The clustered tile-mask buffer at the shipped 64×64 tiles is ~16 KB, ~200 light points at 32 B is ~6.4 KB, and an IES profile is 180 floats — **under 0.1 MiB for all of 7B**. The consumer is **7D**: at tier 1's `materialArrayEdge: 512`, the existing 2 arrays × 10 layers already cost **26.67 MiB**, and each additional material layer 7-11 needs costs **~2.67 MiB**. So the trade is aimed at 7-11's hangar/tower materials and 7D's geometry, and **7B can proceed with no memory trade at all**. |
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
| E-1 | **6-11 closed** — four-tier × three-viewport sweep archived; QR-1 settled with a decision-log row (`vegetationCastsShadows` still carries 4.5-C1's `false/false/true/true` at [QualityProfile.ts:312,399,468,519](src/render/webgpu/core/QualityProfile.ts) and `grep QR-1 ARCHITECTURE.md` is empty); cold-start deadlines instrumented — **LANDED in `1e526f9`** as `tests/perf/cold-start.test.ts` (158 lines), and it honours the timeout-OR-error requirement rather than only the easy half: it captures both `console.error` and Babylon's `Logger.Error`, asserts empty, **and** races a timeout whose rejection message records that the guarded class produces no console error at all. What remains for E-1 is the sweep, QR-1 and memory truth; 6-11.4 memory reconciliation done; **and 6-11 item 4** — `TERRAIN_SAMPLED_BINDINGS` derived from `effect.fragmentSourceCode` and pinned against that derivation, added 2026-08-31 after this plan's recon found the list stale in both directions (see 7-0-d). **But nothing runs the cold-start test**: `tests/perf/**` is excluded from both `npm test` and `npm run verify` ([vitest.config.ts:15](vitest.config.ts)), `.github/workflows/` holds only `ci.yml` and `gpu-tests.yml`, and `grep -rn cold-start package.json .github/workflows/*.yml` is empty. This row is therefore unmet for a **wiring** reason rather than a construction one — a smaller job than originally priced, but not a discharged one. **A correct instrument nobody invokes is the same defect as a wrong one**, and this phase has now hit that shape three times: the sampler list nothing compared against a shader, Gate W's suite that never rendered its own product, and this | tier table asserted from profile data in CI; **the cold-start test actually invoked by a workflow or an npm script**, not merely present; the sampler list derived, not hand-maintained | `SWE III` (was `flight-simulator-d7`) |
| E-2 | **6-12 — SUBSTANTIALLY CLOSED in `6216a80`, one survivor. Re-checked against the tree 2026-08-31 late, not against the commit message.** `tests/perf/baseline/report.json` is **deleted** (the decide-once resolved to delete, which was the right call — the harness never read it and a committed fossil is how the 17-shot number kept being quoted). `docs/PERFORMANCE.md`'s two surviving "seventeen" mentions at `:513` and `:591` are **legitimate historical quotation**, not stale claims — they describe what a past promotion asserted. **The one genuine survivor was [vitest.perf.config.ts:9](vitest.perf.config.ts), whose docblock restated a canonical shot count as a word rather than pointing at `PERF_CAPTURE_SHOTS` — a live description of current behaviour that had gone stale. FIXED, and the `docs-truth` guard that now derives the count from the list caught a second instance in this very file on its first run.** It sits in a file 6-12's recorded list never named, which is exactly how a documentation pass that works the list rather than the tree leaves something behind. *(Original row, retained for what it verified:)* documentation truth. Its recorded list is itself incomplete: `docs/PERFORMANCE.md:36,47-49,105-113` still describe erosion as CPU-only after Gate W shipped the GPU producer, and `RENDERING_PLAN.md` §5.3 is the staler of the two documents (msaa Balanced published 4 / shipped 1; CDLOD node budget published 160/240/320/448 / shipped 224/320/448/640; ocean published 3@128,4@256,5@256,6@256 / shipped 128/3,128/4,256/5,256/5). `ARCHITECTURE.md:67` still carries a duplicate LandCoverClassifier row marked "planned 4-6", `:98-99` still asserts the default eroded world renders completed pages, `:308` still says impostors neither cast nor receive shadows | doc-truth tests fail `npm test` on drift | `flight-simulator-d7` |
| E-3 | **R1+R2+R3 — PROMOTED, verified 2026-08-31 late.** The baseline moved in `6216a80` (PNG mtimes Aug 31 11:57, previously Aug 28), 24 PNGs tracked, `report.json` removed. **This row is dischargeable.** *(Original row, retained for what it verified:)* promoted as one reviewed pass. The committed baseline has not moved since 2026-08-28 (`6a46742`); the post-D-19 candidate exists on disk only. `tests/perf/baseline/report.json` is still a 17-shot fossil against 24 tracked PNGs and nothing reads it — 6-12 owes a decide-once on recommit-or-delete | `tests/perf/baseline/` mtimes move; 24 shots in the promoted report | `flight-simulator-d7` |
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
bake shares the existing `occlusionCompute` row rather than finding tier 2's 0.05 ms wall (a **modelled** wall — see §2.3(g)).
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
3. **Every item that adds cost to the daylight path carries a same-host A/B pin — and the
   pin reports its own noise floor, not just its delta.** *(Amended 2026-08-31, before any
   Phase 7 item used it; see D-9.)*
   The old rule was "reference-host capture before/after, wall-fps delta ≤ 2% on the
   affected shots". **A ≤2% gate is meaningless without knowing the spread of the arm it
   is measured on**, and on this host that spread has been measured at **62%**: d7's
   horizon-shadow pin took four captures, and on `reference-viewport` the *same tree* read
   **74.0 → 115.1 → 120.1 wall fps**, so one AFTER scored −4.27% against BEFORE (a fail)
   while another AFTER on the identical tree scored −0.08% (a pass). The shape — a rising
   asymptote, not a random walk — says this is **warm-up, not thermal drift**.
   The protocol, therefore:
   (a) **Discard the first capture of a session**, or warm until consecutive runs agree
       within the threshold you intend to gate at. The first run of a session is not a
       measurement of the tree.
   (b) **At least two captures per arm, interleaved** — `A B A B`, not a three-arm
       bracket — so every tree yields a *within-tree spread* as well as a between-tree
       delta.
   (c) **The gate is two-part.** The delta must be **larger than the measured within-tree
       spread** to be *believed at all*, and **≤2%** to *pass*. These are different
       questions and a single number cannot answer both.
   (d) **If a shot's within-tree spread exceeds 2%, that shot cannot gate at 2%.** Either
       quiet the host until it can, or state that shot's gate in terms of its measured
       floor and say so in the landing note. Do not pass a shot by out-waiting its noise.
   (e) **Every A/B landing note reports the within-tree spread beside the delta.** A pin
       without a spread is not a pin.
   (f) **The two-part gate extends to the memory row, whose noise floor has never been
       characterised either.** `inventoryGpuMemoryMiB` never queries the driver — it is
       `width × height × depth × bytesPerTexel × mipFactor` over `scene.textures`, plus
       geometry, plus `inventoriedGpuBufferBytes()` — so it is arithmetically exact but it
       **enumerates whatever terrain pages and detail chunks are resident at the instant of
       measurement**. The total is therefore *not a pure function of the tree*: it has a
       within-tree spread exactly as wall fps does. That matters at this headroom —
       **2.7 MiB is plausibly one terrain page's geometry** — so a small measured memory
       delta is indistinguishable from streaming state until the spread is known.
       `SWE III` is measuring it on the next cold block; until then, treat any memory
       delta under the unmeasured floor as unproven rather than zero.
   (g) **Every number this plan quotes from a budget table says whether an instrument
       produced it.** Three members of one family were quoted confidently tonight by people
       being careful: the memory *estimate* under-reporting by 111–119 MiB, the sampler
       comment saying 14 against a derived 10, and **tier 2's "0.050 ms of slack" — which
       is model-derived, not measured.** It is summed from the declared `FRAME_BUDGET_MS`
       table, and that table's vegetation row rests on `VEGETATION_DRAW_COST_MS = 0.026`,
       whose own docblock at
       [renderedDensity.ts:390-393](src/render/webgpu/detail/renderedDensity.ts) calls it a
       "**draw-submission-only model**" and says outright that "tier 0/1 being below one
       means submissions fit, not vegetation". It under-prices the measured caster cost by
       **~3.3×**. So the 0.05 ms is not a wall anyone has stood at. It is retained as a
       planning figure with **"modelled, not measured"** attached at every site, and any
       Phase 7 budget row that claims to fit inside it owes a measurement at its item close. Clustered lighting is *not* cost-dark: the container adds a
   `vViewDepth` inter-stage varying on **every** PBR material, a `textureLoad`-read
   `lightDataTexture` (a sampled-texture slot, **not** a sampler) and a fragment-stage
   `tileMaskBuffer` to every PBR material whether or not a light is on.
4. **Memory is measured against the enforced inventoried assert.** `PERF_CAPTURE_INVENTORIED_MEMORY_CEILING_MIB = 495`
   is asserted hard on **every host including CI**, outside the delivery row. Every
   `new StorageBuffer(` site must also call `registerGpuBufferBytes` — a source scan whose
   allowlist is `[]` and is asserted `toHaveLength(0)`
   ([tests/render.gpu-buffer-inventory-policy.test.ts:28-79](tests/render.gpu-buffer-inventory-policy.test.ts)).
   **Per Q2, Phase 7's allocations are funded from the vegetation atlases — but see D-10:
   the funding mechanism stated at planning was a category error and is corrected here.**
   `foliageAtlasMiB: 6` and `impostorAtlasMiB: 9.33` are **inputs to the estimate model
   only** ([PerformanceBudget.ts:334,339](src/render/webgpu/core/PerformanceBudget.ts));
   `grep -rn foliageAtlasMiB src --include="*.ts"` outside that file returns **nothing**, so
   no allocator reads them. Editing those numbers moves the estimate and frees **zero real
   bytes**. The real levers are the allocations themselves — `FOLIAGE_ATLAS_EDGE = 256`
   ([FoliageAtlas.ts:33](src/render/webgpu/detail/FoliageAtlas.ts)) and its 18 layers, and
   the impostor set's 7 species × 2 season buckets × 2 arrays × 64² tiles — and the row is
   then updated **to match the measurement**, which is what a row is for. **A fidelity trade
   is a visible loss of fidelity; if nothing looks worse, nothing was freed.**
   No 7B/7C/7D item lands before its real allocation is funded and measured against the
   inventoried delta at item close.
   **And the pin ratchets down.** `PERF_CAPTURE_INVENTORIED_MEMORY_CEILING_MIB` exists to
   catch growth: if Phase 7 frees 15 MiB and the pin stays at 495, it stops catching
   anything for the rest of the project. **Re-pin it from each promoting capture; never
   loosen it.** The one sanctioned rise is 6-11.4's reconciliation moving it *with* a
   recorded fidelity trade — d7 will message the landed numbers when measured, and Phase 7's
   trade is re-sized against them rather than against the 495/492.3 pair quoted here.
   **Two accounting paths feed one enforced number.** `inventoryGpuMemoryMiB` walks
   `scene.textures` and mesh geometry *and then adds* `inventoriedGpuBufferBytes()`
   ([FlightRenderer.ts](src/render/FlightRenderer.ts) (`private inventoryGpuMemoryMiB()`)). So a `RawTexture` that
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
   **~200 light points must be one instanced draw — and per D-13 this is load-bearing for
   the GATE, not merely for the shot.** With draws established as the binding axis, that
   single instanced draw is what makes Gate 7B fit at all; it is not a tidiness target that
   could be relaxed to 3 or 4 draws under schedule pressure.
   **And the risk framing of this phase inverts.** The plan was written with 7B as the hard
   part and 7D as the long tail. On a draw-bound axis that is backwards: **7B is one
   instanced draw plus a container; 7D is buildings** — hangars, a tower, furniture, signage,
   each a mesh, against `runway-on-approach`'s 169 and the appended night shots' ceilings.
   **7D is the risky half of Phase 7.** Nothing in the ledger moves — the work is the same
   work — but review attention, the adversarial pass, and any schedule slack should be
   pointed at 7D rather than at the lighting engine.
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
   scan applies to every new WGSL string.
   **Write the owner-row notes AROUND the banned tokens — these guards match text, not
   code.** Verified: `collectSourceFiles` stores `withoutImportClauses(...)`
   ([architecture.boundaries.test.ts:31-47](tests/architecture.boundaries.test.ts)), which
   strips comments and imports but **not string literals**, and both guards then test that
   string — assertion 117 against `/\bnew\s+ShadowDepthWrapper\b/u` (`:131`) and the tier
   rule against a bare `/\.tier\b/u` (`:155`). `owners.ts` is almost entirely string data,
   so **a manifest note that explains a prohibition trips the prohibition**: a row saying
   *"never construct a raw `new ShadowDepthWrapper`"* fails the build, and so does one
   containing the literal token `.tier`. This is not hypothetical — it cost the Phase 7
   lead two build failures, both in documentation rather than code.
   So: say **"the guarded factory"**, not the raw class name; say **"a profile data field,
   not a per-tier read"**, never the dotted token. As stated, §2.8's instruction to add an
   owner row and its instruction to avoid those constructs **collide inside the same file**
   if followed literally, and this paragraph is the resolution. **Note the terrain→detail import rule**: a
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
  ([FlightRenderer.ts](src/render/FlightRenderer.ts) (find `new ScotopicVisionPass` and the two post-processes that follow it)). D-0 and D-4.
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
  and `scene.environmentTexture`, **with the 4-cascade CSM attached** — CSM spends
  inter-stage slots itself (`vPositionFromLight{X}_0..3`, `vDepthMetric{X}_0..3`), so a
  spike without it measures a configuration that does not ship. Measure (a) inter-stage
  variable count, (b) fragment-stage storage buffers, (c) **sampled-texture count —
  NOT sampler count** (see below), (d) whether the pipeline compiles at all.
  **(c) was specified wrongly in the first draft and would have produced a false pass.**
  `getClusteredLight` reads `lightDataTexture{X}` through **`textureLoad`**
  ([clusteredLightingFunctions.js](node_modules/@babylonjs/core/ShadersWGSL/ShadersInclude/clusteredLightingFunctions.js)
  — verified: zero occurrences of `Sampler` in that include), and a `texture_2d<f32>` read
  that way declares **no sampler at all**. So measuring samplers returns "no change", which
  reads as "it fits". The load is on **`maxSampledTexturesPerShaderStage`**. The project
  already draws exactly this distinction at
  [TerrainSpineContract.ts:545-549](src/render/webgpu/terrain/TerrainSpineContract.ts), which
  is why that list records an empty vertex sampler set.
  **Prediction P1 — PREDICTED 14, DERIVED 10. Falsified, and the falsification is the
  point.** 6-11 item 4 landed: `TERRAIN_SAMPLED_BINDINGS.fragment` is now derived from
  `effect.fragmentSourceCode` and asserted `toEqual` across two shipping permutations by
  `tests/gpu/terrain-sampler-budget.test.ts`. Verified in tree — it holds **ten** entries
  (`environmentBrdfSampler`, `shadowTexture`, `terrainSurfaceAlbedo`,
  `terrainSurfaceNormal`, `terrainOcclusionAtlas`, `terrainHorizonAtlasA`,
  `terrainHorizonAtlasB`, `terrainSplatId`, `terrainSplatWeightLo`,
  `terrainSplatWeightHi`), and `TERRAIN_HYDROLOGY_ADDS_SAMPLED_BINDINGS = 0`, so the widest
  shipping permutation is the same set. **Terrain is 10/16 sampled.**
  **7-0-d HAS NOW RUN, and it corrects P1's own follow-up (2026-09-01).** I wrote
  "10 → 11 with the container". **Sampled textures stayed at 10.** The container's +1 landed
  in *total* texture bindings, because `lightDataTexture{X}` is `textureLoad`-only. Both
  numbers were right and two metrics were conflated — mine as much as anyone's, since I
  wrote the sentence.
  **The consequence outlives this item: `TERRAIN_SAMPLED_BINDINGS` is the WRONG list for
  auditing `maxSampledTexturesPerShaderStage`**, which counts texture bindings regardless of
  sampler pairing. The list is correct for its stated purpose — the *sampler* budget — and
  6-6 added shore distance without moving it precisely because of that exclusion. **Anyone
  checking the adapter limit against it will under-count.** That is a live trap: the list is
  now derived and trustworthy, which makes it more likely to be reached for, not less.
  **Measured on the adapter:** terrain with the container **and** the 4-cascade CSM sits at
  **14 of 16 inter-stage — two slots free**; the container adds **one sampled-texture
  binding, one fragment storage buffer, and zero samplers**. **Binding counts are properties
  of the compiled permutation and are tier-independent, so 7-4b's buildability does not move
  with the tier-2 cliff** — only the millisecond budgeting does. *(Carried from the
  `Principle Engineer`'s 7-0-d run.)*
  **The scoping implication that briefly stood here is withdrawn.** It said the crunch might
  decide whether IES rides a texture or is authored analytically for every fixture. There is
  no crunch. **7-5's IES is not texture-budget-constrained**, and if every fixture is ever
  authored analytically it must be for a fidelity or authoring reason — deciding it on a
  phantom budget would have bought real work for nothing.
  **P1 is retained, re-pointed at 10, and the derivation requirement is retained with it:**
  the prediction guards the *mechanism*, not the value. The old count was wrong **in both
  directions** — it listed six PBR samplers the material never declares and omitted
  `environmentBrdfSampler` and the CSM `shadowTexture`, so the *set* was wrong, not merely
  the total, and "stale by four" understates it. Note also that
  [Capabilities.ts](src/render/webgpu/core/Capabilities.ts) (`maxSampledTexturesPerShaderStage`'s comment)'s comment **still says 14**
  and is now itself the stale artifact (routed to 6-12).
  *Recorded for whoever writes the next prediction:* **a falsified prediction did its job.**
  P1 was wrong and cost nothing, because what made it safe was refusing to trust a comment
  and requiring derivation. A prediction earns its keep by being **checkable**, not by being
  right — and P1 caught a wrong scoping decision inside an hour of it being written. This mirrors `1A-7`/`R-20`'s precedent. **If the container does not fit, 7-4 changes
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
  **Tier 2 has 0.05 ms of MODELLED slack** (13.65 against a 13.7 ms target — summed from the declared table, never measured; §2.3(g)) and assertion 20 is a
  hard `toBeLessThanOrEqual` — so the row must be funded by cutting an existing row in the
  same commit.
  **AMENDED 2026-09-01 (D-14): add the row, fund it by rebalancing INSIDE the model, and
  do not cut shipped fidelity for it.** The mechanical obligation stands — assertion 20 is
  a **model-internal consistency check** and a lighting row that breaks the declared sum
  should fail the build. **What is void is the reasoning on top of it:** that 0.05 ms is
  real headroom and that cutting a row is a real trade. Measured tier 2 is **23.7–60.4 ms**
  against the model's 13.65, an under-prediction of **1.74–4.42×**, so the model does not
  describe the machine. Cutting a shipped feature to free 0.05 ms inside it **spends
  something real and buys nothing — and the loss is permanent while the gain was never
  available.**
  **The line a future reader needs: any cut booked here is bookkeeping until the model is
  reconciled.** Without it, someone finds a fidelity reduction in the log in a month,
  assumes it bought frame time, and defends it.
  **Tiers 2 and 3 are recorded as UNFUNDED pending `SWE III`'s cliff work** — the same
  treatment bloom now carries in 7-5, so the two are consistent.
  *This is the Q2 mistake in a different currency, by the opposite mechanism.* There the
  number was **accurate and inert** — a faithful description nothing consulted. Here it is
  **read and enforced and does not describe the machine.** Same outcome from opposite
  causes: a real cost paid against a figure that cannot deliver the benefit. **A figure
  being enforced is not evidence that it describes anything.**
  **Price against measured admission, not the declared table.** `c41f52a` pins which
  `ComputeBudget` reservations are no-ops: the reservation pass admits whole-or-nothing
  while `spentHere + costMs <= ceilingMs`, so it protects a client **only if one dispatch
  fits inside its own ceiling** — and `occlusionCompute` starves at tier 2, where the
  reservation pass is effectively a no-op for every client that matters. Anything Phase 7
  puts on that row **inherits the starvation**. So a declared row is not a delivered
  dispatch: any 7B or 7D compute must state its measured admission rate at its item close,
  and the floor-of-one is the only guarantee available. **The memory trade is NOT booked here — per D-10 it moved off Gate 7B's
  critical path entirely**, because 7B's own allocations total under 0.1 MiB. 7-0-b
  therefore books only the frame-budget row, and carries the trade forward as a costed
  *menu* for **7-11 to execute at 7D**, sized against 6-11.4's landed numbers when
  `SWE III` measures them (Risk 7). All 24 + 4 shots run `worldEvolution: "analytic"` per
  Q5; no eroded night shot is appended in this phase.
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
σ passed from [FlightRenderer.ts](src/render/FlightRenderer.ts) (`adaptedLuminanceCdM2: snapshot.sceneKeyLuminanceCdM2`)). At the `night`
shot σ ≈ 4.21 cd/m² while physical adapted luminance is 8.0e-5, so `rodFraction = 1` and
the rod image fully replaces the scene. With `displayGain = 0.16 / 4.698026 = 0.0340569`,
scene-linear **0.01 / 1 / 1000** land at **0.032211 / 0.034037 / 0.034057** — five decades
of input producing a **5.7% output spread, a ratio of 1.0573 : 1**. Every light point would
render at the same brightness. The pass also takes four extra taps on a rotated cross at up
to 3 texels and evaluates the response on the **blurred** value.
*(These figures are derived from the shipping constants, not transcribed. An earlier draft
printed 0.1449 / 0.1598 / 0.1600 — a ratio of 1.1042, which implies σ ≈ 7.65 and is
inconsistent with the shipping formula. It **understated** the defect. Corrected here, and
see the pins below: **7-4a's tests derive their expectations from the shipping constants,
never from figures printed in this plan.** An illustrative number in prose becoming an
asserted number in a test is the `Capabilities.ts` sampler comment one layer up.)*

> **DO NOT "FIX" THIS BY PASSING ADAPTED LUMINANCE INTO σ.** The sentence above names the
> scene key in contrast to the physical adapted luminance, and the obvious reading — *swap
> the uniform* — makes the defect **strictly worse**. Swept against the shipping formula:
> σ = 4.21 (shipped) → 1.0573 : 1; σ = 1.0 → 1.0136 : 1; σ = 0.05 → 1.0007 : 1;
> **σ = 8.0e-5 (physically correct) → 1.0000 : 1, a perfectly flat uniform grey field.**
> Compression *worsens* as σ falls, because the Naka–Rushton response saturates toward 1 for
> any `nits ≫ σ`. **The shipped scene-key choice is not the bug — it is the only reason any
> range survives at all**, and the code says so deliberately at
> [FlightRenderer.ts](src/render/FlightRenderer.ts) (the `sceneKeyLuminanceCdM2` hand-off, commented "σ is the SCENE's key") ("σ is the SCENE's key, not the
> physical adapted luminance"). The fix is the pre-exposure **and** the highlight-preserving
> term, per Q4. This warning is written negatively on purpose: a plan that only describes a
> defect leaves its most obvious remedy available and wrong — and this particular wrong fix
> produces a result that *looks like it did something* while passing all 24 gates.

**The mechanism, stated so Q4's two deliverables have target numbers rather than a
direction.** The rod response is **not rangeless** — it has about **three usable decades**,
and they sit entirely *below* where any light source lives. Verified against the shipping
constants (`response = nits / (nits + σ)`, σ = 4.21, `SCENE_UNIT_TO_NITS = 7345.61`):

| scene-linear | nits | response |
|---|---|---|
| 1e-5 | 0.07 | 1.71% |
| 1e-4 | 0.73 | 14.86% |
| **5.731e-4** | **4.21** | **50.00% — half-saturation** |
| 1e-2 | 73.46 | 94.58% |
| **5.7e-2** | 418.70 | **99.00% — the curve has spent its output** |
| 1 | 7,345.61 | 99.94% |

So the usable band is roughly **1e-5 … 1e-2 scene units**, half-saturating at **5.731e-4**,
and **above ~5.7e-2 the curve has spent 99% of its range**. A runway edge light, a landing
light and the moon all sit above that, which is why they render as the same pixel — not
because the curve has no range, but because **its range is in the wrong part of the
domain**. That is the target: **7-4a's pre-exposure must place artificial sources inside the
usable band, or the highlight-preserving term must extend the curve above it — and either
way the number to hit is the half-saturation point, not a feel.**
What lands: a scene pre-exposure so the fp16 beauty target carries the range; a
highlight-preserving term so sources above σ survive the rod response; and an emissive-aware
path so the rod blur does not smear point sources. **This reopens pinned constants** —
`MAX_EXPOSURE = 4.698` and the assertion that it binds exactly at midnight
([tests/render.webgpu-atmosphere-luts.test.ts:141-144](tests/render.webgpu-atmosphere-luts.test.ts)),
`MOON_PEAK_LIGHT_INTENSITY = 0.055` and `STAR_ZERO_MAGNITUDE_SCENE_VALUE = 0.5`. Fix the
source docstring while there: it claims ~4.66 against a pinned 4.698.
*Pins:* the exposure ladder re-derived, not re-chosen, with its new derivation in the
docblock; **an output-ratio pin, not a "monotonicity" pin** — the earlier wording ("N
scene-linear decades map to N distinguishable output decades") is unmeasurable as written,
since *distinguishable* is undefined and today's code would pass it at N = 1. Pin **the
ratio itself**: the output ratio across a 10⁵ : 1 scene-linear sweep at the night clock must
exceed a stated floor, with today's measured **1.0573 : 1 recorded as the pre-fix
baseline** — which gives R7-1 a number that must have moved rather than a property to argue
about. Expectations derive from the shipping constants at test time. Also: the rod blur
proved not to smear a one-pixel source, and a guard that σ is **not** wired to the physical
adapted luminance, so the wrong fix fails loudly rather than silently greying the frame.
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
  ([Capabilities.ts](src/render/webgpu/core/Capabilities.ts) (`REQUIRED_WEBGPU_LIMITS`)). Declare and probe it.
- **`vViewDepth` is gated on `CLUSTLIGHT_BATCH > 0`, NOT on whether a material has a
  clustered light** ([pbrFragmentExtraDeclaration.js:19-21](node_modules/@babylonjs/core/ShadersWGSL/ShadersInclude/pbrFragmentExtraDeclaration.js)),
  so it lands on **every PBR material in the scene** — including the detail material, which
  E-5 leaves at 12 varyings in a project that has already hit 17 and had to disable impostor
  shadow receiving to get under the limit. 7-0-d measures this before anything is built.
- **Receiver-side cost, stated exactly.** Per container in light slot `{X}` a receiving
  material gets `var lightDataTexture{X}: texture_2d<f32>` and
  `var<storage,read> tileMaskBuffer{X}: array<u32>`
  ([lightUboDeclaration.js:36](node_modules/@babylonjs/core/ShadersWGSL/ShadersInclude/lightUboDeclaration.js))
  plus `vViewDepth`. That is the whole of it — **one sampled texture, one storage buffer,
  one varying, zero samplers.**
- **The storage-buffer question splits in two, and only half of it is open.**
  `maxStorageBuffersPerShaderStage: 8` **is** declared
  ([Capabilities.ts](src/render/webgpu/core/Capabilities.ts) (`maxStorageBuffersPerShaderStage`)); the newer
  *per-stage-split* limit is not. Separately `maxUniformBuffersPerShaderStage` is genuinely
  absent, and that one bites: `GetSupportedSimultaneousLights` returns the requested count
  **untouched** when the cap reads null (`materialHelper.functions.js:447-456`), so on an
  engine that does not report it **the clamp silently does not happen**.
- **The surviving risk is inter-stage, and the limit guarding it is undeclared.**
  With the sampled-texture crunch dissolved (P1: 10/16 → 11/16, five free), the pressure
  relocates entirely to varyings — and **`maxInterStageShaderVariables` appears nowhere**:
  verified, zero hits across `src/` and `tests/`, so it is absent from
  `REQUIRED_WEBGPU_LIMITS` and from the spine contract alike. The one limit that guards the
  one risk that survived is the one limit nobody probes. It joins
  `maxUniformBuffersPerShaderStage` and the per-stage-split storage limit on 7-0-d's
  declare-and-probe list.
- **And there is a cliff behind it: CSM costs NINE inter-stage variables per shadow light**,
  not one — `vPositionFromLight{X}_0..3` (4) + `vDepthMetric{X}_0..3` (4) +
  `vPositionFromCamera{X}` (1)
  ([lightUboDeclaration.js:40](node_modules/@babylonjs/core/ShadersWGSL/ShadersInclude/lightUboDeclaration.js)).
  That is almost certainly why impostor shadow receiving was disabled to get under the
  limit. **Consequence for 7-4b and for 7-9's night shadow policy: `vViewDepth`'s +1 is the
  cheap part.** The expensive interaction is clustered lighting *against* CSM on a material
  already at 12, and anything that re-enables shadow receiving on a material spends **9**.
- **The per-slot UBO is 264 B and wants checking against the size cap, not the count.**
  Slices default to `DefaultDepthSlices = 16` alongside the 64×64 tiles
  ([clusteredLightContainer.pure.js:184-185](node_modules/@babylonjs/core/Lights/Clustered/clusteredLightContainer.pure.js)),
  and `vSliceData: vec2f` + `vSliceRanges: array<vec4f, CLUSTLIGHT_SLICES>` is **66 floats /
  264 B per light slot**.
- **The terrain plugin attenuates the light *sum*.** `TerrainSurfacePlugin`'s
  BEFORE_FINALCOLORCOMPOSITION hook does `finalDiffuse *= terrainHorizonShadow *
  terrainCanopyDirect` where `finalDiffuse = diffuseBase` — the accumulator every light
  writes into ([TerrainSurfacePlugin.ts:2783-2797](src/render/webgpu/terrain/TerrainSurfacePlugin.ts)).
  A runway edge light would be dimmed by *sun* occlusion. **7-4b must split the attenuation
  so it applies to the sun/moon contribution only** — there is no existing hook between the
  light loop and final composition, so this is real shader surgery across the five
  `MaterialPluginBase` subclasses (terrain 180, detail 190, ground cover 195, aerial 205,
  cloud shadow 210).
  **The two materials are NOT equivalent, and the plan previously treated them as though
  they were.** Terrain multiplies an accumulator it did not contribute to. The detail plugin
  **adds its own hand-rolled key-light term into `finalDiffuse` first** and only then
  attenuates — verified: `finalDiffuse += surfaceAlbedo * uniforms.detailKeyLightColor.rgb`
  at [DetailInstanceMaterialPlugin.ts:1056 and :1106](src/render/webgpu/detail/DetailInstanceMaterialPlugin.ts),
  with `finalDiffuse *= impostorSunShadow` at `:1089`. So on detail the job is **not** "route
  the accumulator two ways" — it is that **plus reconciling a bespoke key-light path with
  the clustered one**, which is a design question (does the hand-rolled term become a
  clustered light, stay separate and get attenuated separately, or get retired?) rather than
  a plumbing one. Price the detail half accordingly; it is the harder of the two.
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
- **Bloom LANDED in `285eb2b`** (D-4 recorded it as absent; it is not any more). It sits
  between the scotopic pass and ACES, which required renegotiating MSAA and first-pass
  ownership with `ScotopicVisionPass` at slot 0
  ([FlightRenderer.ts](src/render/FlightRenderer.ts) (find `new ScotopicVisionPass` and the two post-processes that follow it)). Gated to tier 1;
  **tier 2+ recorded as unfunded** pending the cliff, because the `post` row it would
  have used was funded against tier 2's 0.05 ms of **modelled** slack (§2.3(g)) and that
  model under-predicts the machine by 1.74–4.42×.
- **Bloom costs four draw calls on EVERY tier-1 shot, and pixels on only some of them.**
  `BloomPass` constructs four `PostProcess` instances — bright, blur-h, blur-v, composite —
  and attaches them to the camera chain. **There is no content gating anywhere:** the
  threshold is applied per pixel *inside* the bright shader, so **it decides what glows,
  never whether the pass runs**. Measured across three full captures at `285eb2b`:
  **30 of 30 shots at exactly +4 draws, byte-identical across all three runs.**
  `high-10000ft-down` pays the same four draws as every other shot and has no bright
  source to spend them on.
  **This is a property, not a complaint** — an unconditional post-process chain is a
  normal design and the alternative (a per-frame content test) buys little. It is written
  down because *"bloom is cheap"* is the sentence someone will reach for when the draw
  budget next gets tight, and it is **true of pixels and false of draws**.
- **Its cost is a declared raise, not an absorbed margin.** Every affected ceiling moved by
  exactly four through `DRAW_CALL_RAISES` in `scripts/deliveryFloors.mts`
  (`dd53dfd`), which asserts the raise is uniform, still needed, and matched per shot. The
  reason that mechanism exists is worth one line: `PREVIOUS_DRAW_CALL_CEILINGS` had been
  left holding **pre-tightening** values carrying 6–10 draws of undocumented margin, so
  bloom's +4 initially passed the ratchet with slack to spare — the guard was comparing
  against a baseline that no longer shipped, and `mountain-close` had **two draws left**
  before that stopped. A hand-edited ceiling was refused by the same guard hours earlier;
  the margin would have let the identical growth through unrecorded.
  **Provenance.** The +4 is measured: three full `perf:capture:candidate` runs at
  `285eb2b`, same host, back-to-back, `sweep=false` on all three, all 30 shots
  byte-identical across the three — and it was a **pre-registered prediction with a
  stated falsifier** (any shot whose delta was not exactly 4) written before the runs
  finished. The falsifier did not fire. "No content gating" is read from `BloomPass.ts`,
  not inferred from the A/B; the tier gating is read from `QualityProfile.ts`; the
  1.74–4.42x model error is **carried**, not re-derived.
  **What this does not say:** nothing about bloom's **millisecond** cost, which is a
  different question from its draw count and is not measured here; nothing about tiers 2
  and 3, where bloom is off; and *"pixels on only some shots"* is an argument from the
  shader's structure plus `high-10000ft-down` having no bright source — **the per-shot
  pixel effect was not measured.**
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
  only on the centreline. Off-centreline fixtures sit `runwayCrownHeight(airport, across)`
  **below** it. Place every one of them through `runwayPlatformHeight(airport, across)`.
- **Budget 0.105 m for edge lights, not 0.35 m.** The camber is quadratic in
  `across / runwayPlatformHalfWidth` — **31 m** (`runwayWidth/2 + shoulderWidth`,
  [RunwayEarthworks.ts:122-124,162-170](src/render/webgpu/terrain/RunwayEarthworks.ts)) —
  **not** in the paved half-width of 17 m, so the paved edge takes only **(17/31)² = 30.1%**
  of it. Against `DEFAULT_AIRPORT`: centreline **0.000 m**, TDZ bar at 10.5 m **0.040 m**,
  PAPI at a 15 m offset **0.082 m**, paved edge **0.105 m**, edge + 3 m margin **0.146 m**,
  graded platform edge **0.350 m**. **The full 0.35 m occurs only at the graded platform
  edge, where no runway edge light goes.** An earlier draft of this bullet said "up to the
  full 0.35 m camber" — **3.3× too large for the fixtures it names**, and over-provisioning
  is what later gets cut as unnecessary along with the part that was necessary.
- **What the error costs the PAPI pin.** A vertical siting error `d` perturbs the elevation
  angle by about `d/R` at horizontal range `R`, so it consumes the whole 0.1° budget at
  `R = d / tan(0.1°)`: **47 m** for the PAPI's own 0.082 m, **60 m** at 0.105 m, **201 m** at
  0.35 m. **So an uncorrected fixture breaks the 0.1° pin only inside ~47 m of range** — the
  swept fixture's minimum range decides whether this is a correctness concern or a placement
  one.
  *(Camber and angle figures re-derived here against `runwayCrownHeight` and
  `DEFAULT_AIRPORT`; they reproduce `SWE II 2`'s to the digit. **Scope:** this is the camber
  term only — it says nothing about whether `runwayToWorld`'s y is otherwise right, and
  nothing about longitudinal grade. The **15 m PAPI offset is a conventional siting figure,
  not something the tree specifies.**)*
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
  (in [FlightRenderer.ts](src/render/FlightRenderer.ts) — find the three call sites by
  symbol, **not by line**: `atmosphere.addShadowCaster(mesh, false)` over
  `airport.shadowCasters`, then `cloudShadowReceivers.registerMeshes(...)` and
  `aerialReceivers.registerMeshes(...)`, both taking `airport.root.getChildMeshes(false)`)
  and `shadowCasters` is
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
  ([FlightRenderer.ts](src/render/FlightRenderer.ts) (the single `sampleWind(` call, forwarding to `detail.setWind`)). Sample at the sock.
- **Validate on a crosswind seed — and the earlier claim here was overstated.** The mechanism
  is real: the runway's preferred heading and the prevailing wind are the *same* expression,
  `unitFloatFromHash(mixSeed(h, 301)) * 2π`, and the site scorer adds a 4× wind-axis penalty
  (`preferredHeadingForRegion` at [airportSite.ts:963](src/world/airportSite.ts), `windPenalty`
  at `:992`, wind at [world.ts:150-152](src/world/world.ts)). **But the two-seed split makes
  the correlation partial, not structural:** `preferredHeadingForRegion` is called with
  **`sourceHash`** (`airportSite.ts:1024`) while the wind uses **`seedHash`**, which the
  guaranteed-airport search *replaces* (`world.ts:135,145`). Verified here.
  **Measured runway-to-wind axis difference across 12 seeds** (0° = along the runway, 90° =
  pure crosswind), every one with `seedHash ≠ sourceSeedHash`: `sock-1` **2.7°**, `sock-3`
  13.6, `sock-4` 19.2, `1s9phln` 25.9, `phase1-baseline` 29.8, `sock-7` 33.9, `sock-5` 36.1,
  `sock-2` 39.9, `clustered-spike` 53.4, `hangar-b` 66.7, `sock-6` 83.9, `hangar-a` **85.9°**.
  **5 of 12 within 30°, 3 beyond 60°.** So *"the sock points along the runway by
  construction"* is **true of `sock-1` and false of `hangar-a`** — the previous wording
  asserted it generally and was wrong. *(Measured by `SWE II 2`; mechanism and seed split
  re-verified here.)*
- **Two test-design consequences, and the second is the one that bites.**
  (a) A windsock test written against `1s9phln` or `phase1-baseline` is **nearly blind**; one
  written against `hangar-a` is a real test. But because the alignment is **seed-dependent
  rather than structural**, nothing stops a later change to seeding, the footprint or the
  region catalogue from quietly turning `hangar-a` into a 5° seed — at which point the test
  still passes and has *silently become the blind case*. **So the test must assert its own
  premise**: a separate named assertion that its chosen seed really is a crosswind seed
  (axis difference above a stated threshold), whose failure message says *"the validation
  seed has stopped being valid"* rather than *"the sock is wrong"*.
  (b) **Pointing correctly is not the same as being driven by a per-object sample.**
  Asserting the angle passes even if the sock reads the *aircraft's* wind. The assertion that
  actually tests the trap is that the sock responds to a wind sampled **at the sock** which
  **differs** from the wind at the aircraft.
  *Implementation note:* **`createWorld` takes the seed positionally.** Write
  `createWorld("hangar-a")`, not `createWorld({ seed: "hangar-a" })`.
  **This is guidance, not a hazard — an earlier draft framed it as one and that was wrong,
  retracted here rather than quietly dropped.** The object form **cannot compile**:
  `WorldSeed = string | number` ([types.ts:2](src/world/types.ts)), so it is a `TS2345`, and
  `npm run typecheck` runs in CI on every PR ([ci.yml:49](.github/workflows/ci.yml)). Zero of
  ~125 call sites use it, and the untyped entry point reads `searchParams.get("seed")`, which
  is `string | null`. **Verified here.**
  *Why the retraction is worth reading rather than skipping:* the measurement behind the
  original claim was real — an object seed does collide — but it was produced by a probe that
  used an `as any` cast, **and that cast was the only thing that made the path reachable.**
  The guard preventing the bug was disabled in order to observe the bug, and the bug was then
  reported as live. **Before reporting what a probe found, state what a probe would find if
  the defect were already prevented, and check that the probe did not disable that prevention
  in order to run.**
  *The one detail worth keeping, because the mechanism is nastier than the reach:*
  `hashSeed` loops over `text.length` from the FNV offset basis `0x811c_9dc5`
  ([seed.ts:38-42](src/world/seed.ts)), so a value with no `length` returns the basis
  **untouched** — colliding not merely with other malformed seeds but with the hash of the
  **empty string**, which is itself a legal seed someone might choose deliberately. A
  `TypeError` in `normalizeSeed` now names that collision for the callers types do not bind:
  an `as any`, a `.mts` script, a trusted worker payload.

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

**Winding is an ordering constraint on 7D, not an intention.** **Every new mesh 7D
introduces — hangar panels, roof profiles, door tracks, tower cab and gallery, railings,
mast, fence, windsock, signage — is added to
`tests/render.webgpu-prototype-winding.test.ts` in the commit that creates it**, not in a
cleanup pass afterwards. On 2026-08-31 six emission sites were found wound opposite to
Babylon's convention — cards, shrubs, the dense crown, both rock paths, moss cushion and
grass — so those surfaces received **no direct sunlight at all**, and one of them was a
surface nobody had listed. It survived a whole phase for a reason worth stating exactly:
**an existing test was asserting the inverted convention as correct** — a green test pinning
the defect. Fixed in `bbf3d27` and `ed5b703`. 7D is the largest block of new hand-authored
geometry in the programme's remaining life, and it is being written by sessions that will
not be flying it.

**Gate 7D exit criteria.** No `CreateBox` primitive remains in `AirportSystem.ts` (the
criterion is measured against that file, so one surviving call fails it). Hangars are
visually distinct from one another under the same seed. The windsock tracks the simulated
wind vector at its own position. The tower reads as a tower across **1-2 km** (Jason, 2026-09-01, re-scoped from
3 NM). At 3 NM and 0.069 deg/px a 46 m tower is **6.9 px** -- reaching the ~20 px a
shape needs would take a tower near 135 m beside a small runway, so the old
criterion was unmeetable by building better, only by building wrong. At the new
range this tower is 38.5 px at 1 km and 19.3 px at 2 km, and needed no change.

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

## 10a. Carried latent defects — filed 2026-08-31, **none of them Jason's line**

Found while investigating Jason's four visual reports and **investigated and
excluded from them**. His primary defect was inverted crown winding, fixed in
`bbf3d27`. These four are separate, pre-existing, and unscheduled. They are
filed here rather than in a register of their own because a register nobody
reads is the `report.json` failure this project just deleted — Phase 7 is the
next work to touch vegetation and impostor lighting, so this is where they will
be met.

**Provenance is marked per row, because it varies.** "Re-derived" means this
plan's author verified the numbers against the tree; "reported" means they are
carried on another session's measurement and still need independent checking.

| # | Defect | Evidence | Provenance |
|---|---|---|---|
| **L-1** | **The far-band shadow fade collides with the card band edge.** `detailSunShadow()` ends with `smoothstep(maxZ * 0.82, maxZ, viewDepth)`, lifting the far band's shadow term to fully lit, while the geometry bands use Babylon's receiver with a **hard stop** at `shadowMaxZ` and no fade. So the far band stops receiving shadow across the same ring where it is still drawn as cards. | Fade start = `0.82 × shadowDistance` = **738 / 1,148 / 1,476 / 1,968 m**; cards end = `mid.outerRadiusMeters + DETAIL_MEMBERSHIP_SLACK_METERS` (96) = **736 / 1,196 / 1,596 / 2,096 m**. Ground-level overlap **−2 / +48 / +120 / +128 m** — open at three of four tiers. Pinned by `tests/detail-shadow-band-seam.test.ts`, which re-derives the 0.82 **from the shader source** so a retune cannot move it silently. | **Re-derived.** Originally raised by the `Principle Engineer` session; every figure independently recomputed here. |
| **L-2** | **`barkMaterial` is missing its intensity overrides.** `WorldDetailRuntime.ts:3247` takes neither the `environmentIntensity 0.62` nor the `specularIntensity 0.4` its three siblings take (`crownMaterial`, `opaqueCrownMaterial`, `impostorMaterial`), so it keeps `createMaterial`'s 1.0/1.0. Trunks are ambient-brighter than the canopy around them and step at the impostor handoff, where the bake folds the trunk into a sprite that *is* shaded at 0.62. | `opaqueCrownMaterial`'s own comment at `:3244-3246` records that **this exact miss already shipped once**. Verified: the three siblings set both fields at `:3211,:3217`, `:3242,:3246`, `:3401,:3402`; `barkMaterial` appears at neither, and `createMaterial` sets `1` for both at `:3597,:3599`. | **Re-derived** for the code fact — bark provably takes the defaults. The visual consequence (trunks brighter than the canopy, stepping at the handoff) is argued from the intensities, **not measured in a frame**. |
| **L-3** | **A horizon-shadowed impostor renders sky-blue, not dark green.** The `6-11` horizon term multiplies **direct diffuse and specular only**, leaving ambient/irradiance untouched — correct for terrain, where ground albedo still shows under ambient, but for a vegetation sprite the shadowed state becomes **pure sky ambient**. | Impostor band only (`DETAIL_HORIZON_SHADOW` compiles with `DETAIL_IMPOSTOR`), and only past `shadowDistance` where the CSM has faded out. **Latent, not observed** — correctly excluded from Jason's line by polarity: it only ever darkens, and his far band was lighter. | **Reported.** |
| **L-4** | **Far/mid luminance ratio 0.510 at low, deeply back-lit sun** (elevation 15°, azimuth 180°) — the far band at half the mid band's brightness. | This is the condition the impostor bake's own docstring warns about. **Opposite in direction to Jason's report**, so it must not be folded into it: his far band was too bright, this one is too dark. | **Reported** — carried on the PM's measurement. **Not verified here and I could not verify it in Node**; it needs a render at that sun angle. Treat the 0.510 as unconfirmed until someone re-derives it. |

**One property L-1, L-3 and L-4 share, and it is the reason they are worth
filing rather than fixing opportunistically: no committed capture shot can see
any of them.** L-1's ring sits at 1,148–1,196 m at tier 1 while `canopy-1200ft`
— the shot with the most canopy — reaches only 678 m of ground range; L-3 needs
a horizon-shadowed impostor past `shadowDistance`; L-4 needs a low back-lit sun
no shot carries. **The regression suite is blind to all three**, and L-1 is
worst at tiers 2 and Ultra, which have `vegetationCastsShadows: true` and which
nobody flies. Whoever fixes one should append a shot that can see it, or the fix
is unverifiable and the defect can return unnoticed.

**Fix direction for L-1, recorded because the obvious repair does not work:**
the `0.82` cannot be corrected by moving it — the fraction that would close the
gap differs per tier and rises with altitude (the fade is keyed on **view
depth** while the band edges are **horizontal range**, so climbing opens the
window rather than closing it). Re-key the fade to horizontal range, the metric
the band edges already use. And do **not** simply delete the fade: wave R added
it to stop the cascade boundary drawing its own line on the forest, and removing
it reinstates that artifact.

---

## 10b. Carried structural item — the ratchet is only as sound as the quietest set it has seen

**Filed 2026-09-01 by `SWE II 2` at the PM's request, during the R4 floor
re-pin. Not a defect with a reproduction — a property of the mechanism that
nobody has looked at, and it will not surface as a red test.**

`ratchetedFloorsFrom` keeps the **stricter** of (previous pin, fresh
derivation), field by field. That is right, and it is load-bearing: a raw
re-derivation from the 2026-09-01 runs would have loosened a majority of the
shots carrying a predecessor, which is how a regression gets laundered into a
baseline. **But min-ratcheting is not symmetric in what it remembers.** One
unusually quiet run set permanently imprints its tightness, because no later set
can ever relax it, and nothing records that the ceiling came from a lucky night.

**The measurement that exposed it**, taken with one tool across the three
retained candidate sets on the same host:

| set | fps median spread | p95 median spread | shots with p95 spread ≥ 1.0 ms |
|---|---|---|---|
| 2026-09-01 (`3053b8f`, the R4 pinning runs) | 0.120 | 0.500 | 8 of 30 |
| 2026-08-31 evening | 0.114 | 0.200 | 1 of 27 |
| 2026-08-28 | 0.312 | 0.300 | 5 of 21 |

**Near-identical fps stability, 2.5× the tail spread.** The consequence for the
gate: `cruise-horizon`'s committed `maxFrameIntervalMsP95` of 11.4 ms leaves
1.00 ms above the 2026-09-01 measured max while that shot varies 1.10 ms
run-to-run — a ceiling tighter than the shot's own noise, which will redden on a
capture that regressed nothing. It is carried as a **named exemption** in
`tests/delivery-floors.test.ts` (`P95_HEADROOM_EXEMPT`) with a guard asserting
every exempt shot still fails the check, so the entry cannot outlive its reason.

**What is NOT claimed:** that 11.4 came from a tail-quiet set. The 2026-08-30
pinning runs are **not retained** under `tests/perf/artifacts/`, so the
mechanism is demonstrated and this particular instance is not. Verifying it
needs those runs or a re-pin from a set whose tail is measured.

**The generalisation, which is the reason to file it:** the "quiet host" check
that clears a set for pinning (`drift-check`) reads `wallClockFps` — **a mean
over ~1800 frames**. Delivery floors include three tail order statistics
(`maxFrameIntervalMsP95`, `p999FrameMs`, `hitchCount`). **A verdict computed on
the mean does not certify the tail**, and the table above is the counter-example.
Every p95/p999 ceiling in the tree was pinned under a verdict of that kind.

**Work this implies, unscheduled:**
1. Make the quiet-host check report per-field spread for the fields actually
   being pinned, not fps alone. The five shots in `TAIL_DEFERRED_SHOTS` are
   waiting on exactly this.
2. Decide whether a floor should carry the **tail spread of the set it came
   from**, so a later reader can tell a tight ceiling from a lucky one. Today a
   floor records its value and its provenance runs, but nothing about how noisy
   those runs were.
3. Retain the runs a floor was pinned from, or the provenance is unfalsifiable —
   as it is for the 2026-08-30 pins right now.
4. Revisit `SAMPLE_SPREAD_TOLERANCE_FPS = 0.5`. Two shots have come within 4% of
   it (`canopy-1200ft` 0.486, `grove-meadow-2m` 0.480). **It must not be widened
   to make a pin fit**; the open question is whether 0.5 is the right number at
   all, and it is an fps tolerance being used on sets whose tails differ 2.5×.

---

## 11. Deviation log

- **D-PROV (2026-09-01, PM):** **`2bfe84a` and `ddc5a63` each carry more than one owner's
  work, because I batched landings with `git add -A`.** `git log -- <file>` is therefore NOT a
  reliable answer to "who wrote this and why" for the files below, and a reader chasing a
  guard's origin will land on a commit whose subject is about something else.

  - **`2bfe84a`** ("Detail the hangar…") carries, besides 7-10's detail pass:
    `tests/gpu/shadow-caster-draw-cost.test.ts` and `scripts/decompose-draw-calls.sh`
    (7-9's, pinning the measured 2.00 draws per casting mesh), and
    `tests/lighting.obstruction-lighting.test.ts` (7-14's vent-clearance guard and its
    negative control — **built against the MESH precisely because the change had been
    described in terms of a field that module does not read**, which is the whole reason
    that guard exists and is exactly what its commit subject hides).
  - **`ddc5a63`** ("Wire the parametric hangars…") carries 7-4b's
    `clusteredLighting.setFloatingOrigin` call — **and separating that call from its
    implementation, which landed in `82c4182`, left `ddc5a63` unable to run.** Bisect fails
    there confusingly.

  **Not repaired: rewriting landed history would invalidate seven sessions' worktrees,
  patches, banked captures and pre-registered baselines to fix an attribution.** Recorded
  instead. `git add -A` is not used for landings from here; files are staged by owner.

  The general shape, which is the evening's own lesson one level up: **a record that is
  well-formed, internally consistent, and answers a different question than the one a reader
  will ask of it.**

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
  ScotopicVision → ACES → FXAA ([FlightRenderer.ts](src/render/FlightRenderer.ts) (find `new ScotopicVisionPass` and the two post-processes that follow it)).
  7-5 prices a new post-process, its MSAA/first-pass renegotiation with the scotopic pass at
  slot 0, and a `post` budget row against tier 2's 0.05 ms of **modelled** slack (§2.3(g)).
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

- **D-9 (2026-08-31, the same-host A/B protocol is amended before any Phase 7 item uses
  it — §2.3):** the plan inherited "same-host A/Bs run **B→A→B**" as a standing house rule
  and restated it without checking it against a measurement. It does not do what a ≤2% gate
  needs. **Measured:** d7's horizon-shadow pin ran four captures — AFTER₁ → BEFORE →
  AFTER₂ → AFTER₃ — and on `reference-viewport` the *same tree* read **74.0 → 115.1 →
  120.1 wall fps**. AFTER₂ scored **−4.27%** against BEFORE (a fail against the 2% gate)
  while AFTER₃, on the identical tree, scored **−0.08%** (a pass). A within-tree spread of
  ~62% cannot gate a 2% delta.
  *The diagnosis:* a three-arm bracket — `B→A→B` or the `A→B→A` amendment being discussed —
  defends against **monotonic drift** by straddling the experiment with the control. But the
  rising-asymptote shape (74 → 115 → 120) is **warm-up, not drift**, and neither ordering
  measures the noise floor *of the arm the delta is claimed on*. Both answer "did the host
  move between trees?" and neither answers "how much does this tree vary against itself?"
  Those are different questions and one number cannot answer both.
  *The fix, in §2.3:* discard the first capture of a session; at least two captures per arm,
  interleaved `A B A B`; a two-part gate where the delta must exceed the measured
  within-tree spread to be *believed* and be ≤2% to *pass*; a shot whose spread exceeds 2%
  may not gate at 2%; and every landing note reports the spread beside the delta.
  *Why this belongs in a deviation log rather than a quiet edit:* the ordering rule was
  itself a hand-specified instrument that had never been checked against the thing it
  models — the identical shape as the sampler list, Gate W's blind suite, and the
  unwired cold-start test. It was caught only because d7 happened to take a **third**
  capture nobody's protocol asked for. Six Phase 7 items were about to be pinned to it.

- **D-10 (2026-08-31, Q2's funding mechanism was a category error; the trade is re-aimed):**
  raised by the `Principle Engineer` session via the PM, verified independently here before
  amending.
  *The error:* Q2 said Phase 7's allocations are funded "by cutting `impostorAtlasMiB` 9.33
  and `foliageAtlasMiB` 6.0". **Those are inputs to the estimate model, not allocations.**
  `grep -rn "foliageAtlasMiB\|impostorAtlasMiB" src --include="*.ts"` returns hits **only**
  in `core/PerformanceBudget.ts` — no allocator reads either. Editing them moves the
  estimate and frees zero real bytes; the real levers are `FOLIAGE_ATLAS_EDGE = 256` with
  its 18 layers, and the impostor set's 7 species × 2 season buckets × 2 arrays. I had
  been assured these rows were "real textures walked by the inventory, so cutting them
  frees real inventoried bytes" — the *textures* are indeed walked, but the *rows* are
  reporting, and I did not separate the two before writing the trade.
  *The larger correction, which improves the plan:* the lighting engine is **not** a memory
  consumer. Tile mask ~16 KB at the shipped 64×64 tiles, ~200 light points at 32 B ≈ 6.4 KB,
  an IES profile 180 floats — **< 0.1 MiB for all of Gate 7B**. The consumer is **7D**: at
  tier 1's `materialArrayEdge: 512` the existing 2 × 10 layers cost **26.67 MiB** and each
  layer 7-11 adds costs **~2.67 MiB**. So the trade was aimed at the wrong gate. It now
  funds 7-11 and 7D's geometry, and **7B proceeds with no memory trade at all** — which also
  removes 7-0-b's funding step from Gate 7B's critical path.
  *The rule this yields, stated so it is checkable — and note it is NOT "the constants were
  wrong":* both were **exact**. Traced to their allocators and evaluated against
  `inventoryGpuMemoryMiB`'s own formula: impostor = 2 arrays × 256² × (7 species × 2 season
  buckets) × 4 B × 4/3 = **9.333 MiB** against `impostorAtlasMiB: 9.33`; foliage = 256² × 18
  layers × 4 B × 4/3 = **6.000 MiB** against `foliageAtlasMiB: 6`. Both arrays are scene
  textures, so had anyone actually shrunk an atlas the inventory would have moved by exactly
  the advertised amount. **That is what makes this trap dangerous rather than sloppy:** a
  reader who checks the obvious way — *"is 9.33 right for that atlas?"* — gets **yes**, and
  walks away more confident than we were, having verified the wrong property. The row is a
  faithful description and an inert lever at the same time.
  So the rule is about **readership, not accuracy**: **these rows are *reports*, not
  *controls*.** `FOLIAGE_ATLAS_EDGE` is a control — an allocator reads it.
  `foliageAtlasMiB` is a report — only a sum reads it. Q2 instructed us to change a report
  and expect a control's effect. **The check is one grep for who *reads* the constant, never
  whether it is correct.** And downstream of it: **a fidelity trade is a visible loss of
  fidelity — if nothing looks worse, nothing was freed.** Note the shape: this is the fourth instrument
  in this phase that models something and was trusted instead of the thing it models
  (the sampler list, Gate W's suite, the A/B ordering rule, now the allocation rows), and
  the third that I restated into this plan without checking. The check is cheap — one grep
  for who reads the constant — and it is now the standing habit for any number this plan
  quotes from a budget table.

- **D-11 (2026-08-31, ruling on where Phase 7's artifacts live — asked by the
  `Principle Engineer` session before entrenching it, which was the right call because
  `owners.ts` paths are normative):**
  **Ruling: yes to a new `src/render/webgpu/lighting/`, with a stated split, plus a second
  new directory the question did not ask about.**
  - **`lighting/` holds discrete emitters and their delivery** — the clustered container,
    light points, light volumetrics, airfield lighting, aircraft lighting.
  - **`atmosphere/` keeps the sky and what it does to light in transit** — the aerial
    include, ephemeris, star catalogue and field, scotopic vision, sky probe. These stay
    where they are; **do not move them**, since moving files to match a name is churn
    against a capture-gated tree for no measured gain.
  - **`airfield/` (also new) holds 7D's structures** — the parametric hangar, tower,
    materials, interior and furniture, and `AirportSystem.ts` moves there from `detail/`,
    where it has no owner row today at all. Structures are not lighting and should not be
    filed as such.
  *Why the owner/directory mismatch is fine:* `owner: "lighting"` **already** spans
  directories — `shared-receiver-registry` and `guarded-shadow-depth-wrapper` are
  lighting-owned and live in `core/`. Owner is a responsibility, path is a location, and
  this codebase has never conflated them. A `lighting/` directory that fails to contain
  every lighting-owned artifact is therefore normal, not a defect.
  *The hazard that makes this worth a ruling rather than a guess, verified:*
  [tests/architecture.boundaries.test.ts:67,81](tests/architecture.boundaries.test.ts)
  filters `definitionSites` to those that exist and only fails when *none* exist **and the
  row is not marked planned** — so **a `planned` row whose path never materialises is
  exempt forever, silently.** Accordingly: **every Phase 7 owner row's path must
  materialise in the same commit as its item.** A row may be `planned` only between its
  gate opening and that item landing, never across a gate boundary. If Phase 7 ends with a
  `planned` row still pointing at a non-existent path, that is a defect to be closed, not a
  placeholder to be inherited — and 6-12's doc-truth pass is the natural place to assert it.
  *Complied with the same day:* the six 7B/7C/7D rows were already written when this ruling
  landed and were **held rather than entrenched** (their gates are not open), with only
  `airport-system` landed — an artifact that exists today, was genuinely unowned, and is the
  one row §2.8 names that is not a forward declaration. `owner: "world"`, 8/8 boundary tests
  green. Recorded because holding a written row against one's own item is the behaviour this
  rule needs and cannot itself enforce.
  *Also verified while there:* `ARCHITECTURAL_OWNERS` is consumed by
  `tests/architecture.boundaries.test.ts` **and nothing else** in `src/` or `tests/` — so a
  manifest change is a one-file change and does not stray into 6-12's `ARCHITECTURE.md`
  territory. Worth knowing before anyone plans a two-file edit that isn't one.

- **D-12 (2026-08-31 late, Gate 7-0 opens; the Phase 6 blocker cleared and it retires a
  risk this plan was carrying):** Jason's four shipping-world visual defects — near trees
  near-black against far trees bright yellow-green, a grey band across near trees, a blue
  band across far trees, terrain splotches — were **inverted triangle winding**, not a
  tone-response fault. Six emission sites (cards, shrubs, dense crown, both rock paths, moss
  cushion, grass) were wound opposite to Babylon's convention and therefore received **no
  direct sunlight at all**. Fixed in `bbf3d27` and `ed5b703`.
  *Why this matters to Phase 7 specifically:* I had flagged that those defects would move
  exactly the shots **R7-1** was reserved to move, confounding the pre-exposure change with
  the defect fixes in one baseline. **That attribution risk is retired** — the seam was
  geometric, it landed before Gate 7-0 opened, and 7-4a now starts from a clean tree. R7-1
  keeps its solitary-rebaseline discipline for its own sake, not to disentangle these.
  *The transferable finding, which is the reason the winding rule in §7 is an ordering
  constraint:* it survived a whole phase because **an existing test was asserting the
  inverted convention as correct** — a green test pinning the defect, which is the strongest
  form of the day's pattern. Not an instrument that failed to look, but one actively
  defending the fault. One of the six surfaces was not on anyone's list at all.
  *Also opened here:* Gate 7-0 is live with `Principle Engineer (Phase 7 Lead)` implementing
  and this session remaining author-of-record. §10a's four latent defects (L-1…L-4) were
  filed by another session against this plan with **per-row provenance** — re-derived /
  argued / reported / reported-and-unverified. **Those statuses are load-bearing and must
  not be flattened**: L-4's 0.510 ratio in particular is explicitly unverified and carried
  on one measurement.

- **D-13 (2026-08-31 late, the binding axis is draws — Q2 superseded and the phase's risk
  framing inverts):** `SWE III`'s QR-1 measurement establishes that **draw calls bind, the
  frame budget is mis-modelled, and memory is not an axis at all**. Three consequences, each
  correcting something this plan asserted.
  *(a) Q2's funding argument is void, twice over.* Gate 7B needs no memory trade because its
  allocations total under 0.1 MiB **and** because memory is not the constraint. Stated as
  two independent reasons deliberately: a reader who finds a hole in one still has the
  other. Left as written, the next person to open §2.4 would have re-derived the same wrong
  constraint and started cutting vegetation fidelity to pay for lighting that was never
  memory-bound — **the decorative-list failure in a plan document rather than a source
  file**, sitting exactly where someone would act on it.
  *(b) The risky half of Phase 7 inverts.* 7B is one instanced draw plus a container; 7D is
  buildings. §2.5 now says so, and 7-5's single instanced draw is restated as load-bearing
  for the **gate** rather than for the shot.
  *(c) Tier 2's "0.050 ms of slack" is modelled, not measured*, and I had quoted it as a
  wall at four sites. It sums the declared `FRAME_BUDGET_MS` table, whose vegetation row
  rests on `VEGETATION_DRAW_COST_MS = 0.026` — a constant whose own docblock calls it a
  "draw-submission-only model" and which under-prices the measured caster cost by **~3.3×**.
  All four sites now carry "modelled, not measured", and §2.3(g) makes it general: **a
  number in a plan says whether an instrument produced it.**
  *Provenance note:* raised by the `Principle Engineer` session, which included a correction
  to a figure **it had given me itself** earlier in the evening. Verified here against
  `renderedDensity.ts:390-393` rather than accepted — which is the same discipline, applied
  to the message that was teaching it.

- **D-14 (2026-09-01, 7-0-b's funding mechanism is void; the obligation is not):** the
  tier-2 sweep measured **23.7–60.4 ms p95 at 1280×720** against the declared table's
  **13.65**, an under-prediction of **1.74–4.42×**. **The 720p population is deliberate and
  is the stronger form of the claim:** it is the *lightest* configuration, so a deficit
  there cannot be dismissed as a resolution choice. Across all three viewports the range is
  23.7–**83.2** ms and the factor **1.74–6.10×** — a bigger number and a weaker argument.
  **The claim that needs no caveat at all, and the one to quote if only one survives:
  0 of 21 shot-configurations meet 13.7 ms.** No ranking, no ratio, no bound — nothing an
  order statistic can be attacked on.
  **Every worst-case figure here IS an order statistic, and the worst shot's identity
  wanders across tier-2 viewports:** `forest-500ft-sunbehind` owns the worst at **720p**
  (−46.7) *and* at **1080p** (−65.9); `motion-banked-turn` takes it only at **1440p**
  (−69.5, p95 83.2). Two of the three rows are forest and the third is not. Tier 3's worst is
  stable at forest across all three; **tier 2's is not** — which is why these are quoted with
  their population and their owner rather than as a bare range.
  **Do not mix populations:** −10.0 ms (`water-3m`, 720p) is the best case in *both*, which
  is exactly why a mixed range reconciles at one end and hides its own seam. All figures are
  p95 and all are exactly subtractable from 13.7 **inside one population**. 7-0-b required a new `post`/`lighting` row to be
  funded by cutting an existing row in the same commit, on the premise that tier 2's
  0.05 ms of slack was headroom worth trading for.
  *What survives:* **assertion 20 is a model-internal consistency check**, so the declared
  rows must still sum to ≤ target and a lighting row that breaks the sum must still fail
  the build. Adding a row is still work.
  *What is void:* the premise that 0.05 ms is real headroom and that cutting a row is a
  real trade. **Fund by rebalancing inside the model; do not cut shipped fidelity.** A cut
  made here spends something real to buy something that was never available, and the loss
  outlives the model that motivated it. **Any cut booked here is bookkeeping until the model
  is reconciled** — recorded so that a fidelity reduction found in the log a month from now
  is not mistaken for a purchase and defended.
  *Tiers 2 and 3 are unfunded pending `SWE III`'s cliff work*, matching bloom's treatment
  in 7-5.
  *The pattern, from the `Principle Engineer`:* **this is D-10's mistake in a different
  currency and by the opposite mechanism.** In Q2 the number was **accurate and inert** — a
  faithful description that no allocator consulted. Here it is **read and enforced and does
  not describe the machine.** Same outcome — a real cost paid against a figure that cannot
  deliver the benefit — from opposite causes. **A figure being enforced is not evidence that
  it describes anything**, which is the half of D-10 that D-10 did not say.

- **D-15 (2026-09-01, D-6 is settled ahead of 7-8 and the defect was bigger than D-6
  said):** the body-axis contract is migrated end to end — **body +Z is starboard**, matching
  the arithmetic (fwd × up = starboard), the rendered mesh, and 7cacc44's lamps; the sim's
  internal basis, `bodyAxes` metadata and the keyboard mapping now agree and every boundary
  compensation is deleted. Measured before the fix with a probe whose built-in null (pitch,
  chirality-invariant) validated the instrument: pilot roll +1 read **bank +76.7°** while the
  starboard wingtip pointed **up** (world y +0.972 — a hard left bank on screen), and pilot
  yaw +1 swung the nose **screen-left** while the compass climbed "right". D-6 knew about
  the keyboard inversion and the metadata; it did not know that **rudder (E/Q), mouse
  flight and gamepad roll were all shipped visually reversed with no compensation at all**,
  or that the HUD attitude ball contradicted the out-the-window horizon. All are fixed by
  the one settlement; the same probe now shows identical dynamics magnitudes with only the
  chirality inverted. 7-8's blocker is discharged: `port-navigation-light` at −Z /
  `starboard-navigation-light` at +Z now agree with the declarations around them, and the
  input module's compensation note is deleted rather than migrated. Contract pinned in
  world space by `tests/sim.body-axis-contract.test.ts` (reads no declaration); the old
  A/D compatibility test — a green test whose subject was the workaround, the exact D-12
  shape — is replaced; four convention pins in `sim.rebuild` / `sim.stability-augmentation`
  / `services` / `render.webgpu-aircraft` legitimately flipped and each is annotated in
  place, none silently. **Held for Jason (via the PM): the compass question.** The world's
  sky is a self-consistent mirror of Earth (measured: morning sun toward +X, which heading
  calls east), so after the settlement a compass agreeing with the sky disagrees with the
  turns — pilot-right turns currently decrease the displayed heading. Option (a) flips the
  heading definition in its three sites (zero pixels move; compass agrees with turns; sun
  rises at compass-west); option (c) de-mirrors the sky itself (every baseline moves;
  future phase). The scenic ground heading-hold carries an interim sign annotated to
  revert under (a). Normative row in `ARCHITECTURE.md`'s decision log, same date.

*(Further deviations land here with evidence, plus a normative row in `ARCHITECTURE.md`'s
decision log, per house rule.)*

---

- **D-16 (2026-09-01, 7-6 light volumetrics is CUT — no emitter, not too expensive):**
  **7-6 has nothing cone-shaped to draw, and its declared dependency does not supply one.**
  Measured by executing the shipping constructor: `new AirfieldLightingSystem(DEFAULT_AIRPORT)`
  yields **402 fixtures, every one carrying `beamCosineCutoff = 0`** — a 90° half-angle,
  which is a hemisphere, not a cone
  ([AirfieldLighting.ts](src/render/webgpu/lighting/AirfieldLighting.ts)). 7-6 names two
  emitter sources and both are absent: **landing lights** are a `landing-light` *mesh* with
  an emissive material and no direction, intensity or cutoff
  ([createAircraft.ts](src/render/webgpu/aircraft/createAircraft.ts)), their emitter data
  belonging to `AircraftLightingSystem` (`plannedBy: "7-8"`, does not exist); and **floods**
  were re-scoped away by **D-0**, with hangar and tower faces belonging to
  `airfield-structures` (`plannedBy: "7-10"`, also absent). So 7-6 sits in Gate 7B while
  every source it draws from is 7-8, 7-10, or cut.

  **The reason is recorded as "no emitter until 7-8" and NOT "too expensive", and the
  distinction is the point.** A missing input is not a cost overrun, and no budget makes an
  emitter appear. If 7-8 lands and someone wants light shafts later, the cost question was
  never the obstacle and the feasibility work here stays valid — this is a cut, not a
  deferral, and recording the wrong one would waste the work twice.

  **The declared dependent has no content behind it.** `7-9 ← 7-6` is declared in §Sequencing,
  but the word *volumetrics* does not appear anywhere in 7-9's body. A future reader would
  otherwise inherit a broken dependency where there is none. **7-6 −3.0 d.**

  *Three corrections this investigation produced, all of which outlive the cut:*

  1. **The inter-stage budget was wrong in every particular and had been relayed to four
     sessions.** The device limit is **16**, not the adapter's reported 28 — `setMaximumLimits:
     false` means the device takes the spec default, so the adapter's number was never the
     budget. **Terrain is 15 of 16** (14 `@location` plus `@builtin(front_facing)`), **16 of
     16 with a `ClusteredLightContainer` — zero free** — and the widest shipping detail/foliage
     permutation is likewise **16 of 16, zero free**. So "two free slots that 7-6 competes for"
     was false twice over: there are not two free, and it would not have competed for them.
     The budget is **per-pipeline per-entry-point**, confirmed by creating two pipelines of 15
     user locations back-to-back on one device, both succeeding. **This lands hardest on 7-4b,
     whose spike measured 14 and whose number moved once the builtin was counted.**
  2. **7-6's own cut trigger had no instrument.** `SubsystemBudgetMs`
     ([PerformanceBudget.ts](src/render/webgpu/core/PerformanceBudget.ts)) has twelve rows and
     **no `lighting` row**, so "cut this first if the budget bites" could never have fired. The
     declared tier sums are modelled with zero samples, and assertion 20 checks only that the
     declared constants sum under target — it consumes no measurement. **This is a note on the
     trigger mechanism, not on 7-6.**
  3. **The draw-call ratchet has a sanctioned raise path**, so a feature that genuinely costs
     draws is not blocked: `DRAW_CALL_RAISES` in [deliveryFloors.mts](scripts/deliveryFloors.mts)
     carries `uniform` and `per-shot` forms, the latter existing "so the first legitimately
     non-uniform feature does not meet a guard it cannot satisfy". Bloom's +4 is already
     declared there.

## 12. Exit criteria and goal certification

**Gate 7B.** 200+ light points and 16 clustered illuminating lights hold the tier frame
budget; no light-count-dependent shader recompilation during flight; scene-linear decades
remain distinguishable through the night post chain.
**Gate 7C.** A full night circuit is flyable on Balanced within budget; PAPI indication
matches the geometric glideslope to within **0.1°**; nav-light colours correctly identify
another aircraft's heading on the settled body-axis contract.
**Gate 7D.** No `CreateBox` primitive remains in `AirportSystem.ts`; hangars are visually
distinct from one another under the same seed; the windsock tracks the simulated wind vector
at its own position; the tower reads as a tower across **1-2 km** (re-scoped from 3 NM by Jason,
2026-09-01: 6.9 px at 3 NM is unmeetable without a ~135 m tower).
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
