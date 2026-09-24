# Phase 4 Execution Plan — The Terrain GPU Spine

**Status:** execution reference for Phase 4 of `RENDERING_PLAN.md`. It does not restate that plan; it decides everything that plan leaves to implementation time, against the codebase as it will exist when Phase 4 starts.
**Runs after:** `PHASE_3_EXECUTION_PLAN.md` and Gate A (the aircraft and wildlife, `PRE_PHASE_4_REALIGNMENT.md` §1). Phase 3's exit criteria are this plan's preconditions.
**Basis:** `TERRAIN_AUDIT.md` §2 root causes #2/#7/#8, `RENDERING_PLAN.md` §2 Phase 4 / §3.1 / §3.2 / §5.2–§5.4 / §6 / §7, `ARCHITECTURE.md` (normative), and `PRE_PHASE_4_REALIGNMENT.md` §8 (binding).
**Verified against:** the merged Phase 1 tree at `989cdac`, `@babylonjs/core` 9.21.2 as installed, and a live WebGPU adapter on the reference machine. Every file, line, Babylon-internal and adapter-limit claim below was re-checked in the current tree; **four refute the source plans outright and two refute `PRE_PHASE_4_REALIGNMENT.md`** (recorded in its §8b).
**Amended 2026-08-19:** Phases 2 and 2.5 have since landed (through commit `46bc24a`). Before Phase 4 starts, §3.9's rule applies against the implementation branch: re-derive every line citation there, and re-run `estimateGpuMemoryBreakdown` to regenerate §4 D3's projection table, as that table's own instruction requires.
**IMPLEMENTED 2026-08-20** on `jazonshou/Phase-4-Implementation`. Five commits, one per gate plus `4-9`/`4-10`. Every amendment below was applied; **five further deviations (D13–D17) were forced by measurement and are recorded in §4**, and §14's decision log now carries the numbers each item was supposed to produce. §13's exit checklist is ticked against the tree, with the four unticked boxes named. Read §4 D13–D17 and §14 before treating anything here as still open.

**Amended 2026-08-19 (evening) by [`PHASE_5_EXECUTION_PLAN.md`](PHASE_5_EXECUTION_PLAN.md):** (1) **Gate B — the felt frame (7.25 d)** now runs before Gate A and this phase (that plan §15; created from same-day flight-test reports of choppiness/shaking and forest uniformity), so `4-10`'s tier re-measure captures the post-Gate-B state rather than baking the vegetation draw debt and presentation-timing defect into the committed tiers. (2) **Binding note on `4-2`:** wire `publishPage` and make `fallbackSampleCount` mutable as written, but build no worker-side plumbing — the real counting site is the *sim worker* (only it knows AGL and which authority served a sample), and `5-2` (that plan §4 D9) owns the protocol variants, the worker page ring, and the counter's plumb-back on the snapshot message. `4-2`'s counter is the render-side aggregation only.
**Effort:** **46.5 days**, ~10.3 calendar weeks at 4.5 productive days/week. (34.5 in `RENDERING_PLAN.md`; ~38.5 after the realignment. See the ledger in §4.)
**Engine:** Babylon `@babylonjs/core` 9.21.2, WebGPU. No engine or API change is in scope, considered, or permitted.

---

## 0. What this document adds

Phase 4 replaces 172 CPU-built meshes with one GPU-fed CDLOD quadtree over a page atlas, and bakes the occlusion that makes lighting describe real shape. It closes audit root cause #7 (no screen-space-error LOD, no geomorphing) and is the enabling phase for all of Phases 5–6.

It is also **the plan's biggest incrementality risk** — `RENDERING_PLAN.md` says so itself, and mandates a false-colour debug overlay before the items that consume it. This document takes that further: the gate order below is chosen so that **every one of the four gates has a visible payoff**, not just a green test.

What this document decides:

1. **What the codebase actually is** (§3), now that the recon has been done properly. Eleven findings, four *fatal as written*: one Babylon call in `RENDERING_PLAN.md` §3.1 throws at pipeline creation, `4-8`'s PCSS cannot run on the shadow generator Phase 1 shipped, `4-5`'s per-cascade culling is not expressible through the hook both items name, and CI is already red at tiers 2 and 3 before Phase 4 starts.
2. **Twelve amendments** (§4), including two that correct `PRE_PHASE_4_REALIGNMENT.md` itself and one that requires a zero-day edit to the Phase 3 plan.
3. **The terrain spine contract** (§5) — `4-0`, landed as a small reviewable commit before anything else, because eleven later consumers depend on it and because the season cache key is a re-architecture if it arrives late.
4. **A work order with a week ledger** (§6), and item-by-item detail (§7–§10).
5. **Verification** (§11), a **risk register** (§12), an **exit checklist** (§13) and a **decision log** (§14).

Read §3 and §4 before writing any code.

---

## 1. Preconditions

The realignment names five (`PRE_PHASE_4_REALIGNMENT.md` §8). Recon has now checked all five plus one more, and two of them are **not** satisfied by Phase 3 as currently planned.

| # | Precondition | Source | Status |
|---|---|---|---|
| **P1** | Estimator headroom at all four tiers after Phase 3's material arrays | `3-0` | **DOES NOT FAIL — re-measured at implementation time (§4 D13).** Measured at the reference viewport on the implementation branch: 137.7 / 288.7 / 643.5 / 865.5 against 260 / 480 / 700 / 1000. `npm test` was green before Phase 4 allocated anything. The analysis below assumed Ultra's material arrays at 1024² and `SHADOW_DEPTH_BYTES = 5`; `3-0` shipped 512² and corrected the shadow row to 4, and the `2Z` free win cut tier 1 to 2× MSAA. `4-8a` still lands first, for Phase 4's OWN allocations — without it tier 2 reaches ~829/700 at `4-6`. Original text follows. **FAILS at tiers 2 and 3.** Precisely: with `3-0`'s `materialArraysMiB` row *alone*, tier 2 is **696.5 / 700 — it passes, by 3.5 MiB**. Add the cloud and vegetation rows `Z-4` splits out of `detailMiB` and it is **712 / 700**. Tier 3 breaches either way (~1029 / 1000). So the precondition fails, but not for the reason a first reading suggests, and the margin at tier 2 is one estimator row wide. **Fixed by `4-8a`** (§4 D3). |
| **P2** | `tests/gpu` acquires an adapter and can read back an r32float storage texture | `0-8` | **VERIFIED on-adapter, ad hoc.** A throwaway probe wrote r32float by compute and read it back exactly via `copyTextureToBuffer` on the reference machine. The *adapter* reports `maxTextureDimension2D` 16384, `maxStorageTexturesPerShaderStage` 8, and `float32-filterable`; the *device* does not — §3.6. **No committed test covers this yet**: `4-0` lands the probe as `tests/gpu/webgpu-limits.test.ts` so the precondition is re-checked on every machine rather than trusted from this document. |
| **P3** | The §1.3 invariant tests pass on the Phase 3 branch including `3-8`'s fifth earthworks assertion | `3-8` | Planned. Note §3.5: three of the four existing tests cannot fail for any Phase 4 reason. |
| **P4** | `TerrainSurfacePlugin` is the single terrain-appearance owner, `TerrainMaterialPlugin` deleted, and the material factory is in one place | `3-2`, `C1` | Planned. Today the material is constructed inline in `TerrainClipmapSystem`'s constructor ([`TerrainClipmapSystem.ts:312`](../../src/render/webgpu/terrain/TerrainClipmapSystem.ts:312)) — **one** shared `PBRMaterial`, which is what makes `4-4`'s wrapper siting tractable. Phase 4 requires it extracted to a named factory (§4 D7). |
| **P5** | The `world/` page architecture still consumed by `TerrainClipmapSystem`, not re-forked | `0-2`, `0-3` | **VERIFIED, with one correction.** `cache.ts`, `lifecycle.ts`, `pageGeometry.ts`, `pageKey.ts` and `streamingPriority.ts` are all imported at [`TerrainClipmapSystem.ts:13-38`](../../src/render/webgpu/terrain/TerrainClipmapSystem.ts:13). But the consumed geometry symbol is `WORLD_PAGE_BASE_EXTENT_METERS`, **not `WORLD_PAGE_LAYOUT`** — and `createWorldPageCacheMetadata` is never called; the metadata literal is hand-built at `:752-771` from five `TerrainTileData` arrays. `4-2` inherits that hand-built path and must replace its byte-length derivation, which is CPU-tile-shaped. |
| **P6** | The provisional splat vertex lane reserves a slot index | `3-2` | **NEEDS A PHASE 3 EDIT.** `3-2` defines the repurposed colour buffer as `(materialIdA, materialIdB, weightB, spare)`. Without the fourth lane carrying an atlas slot, `4-7`'s bake has no consumer until `4-4`, and `4-8b` cannot safely shorten the shadow distance. Zero days (§4 D4). |

Two standing conditions carry forward: **Babylon stays pinned at `9.21.2`**, and **one branch per gate** (`phase4/gate-4a` … `-4d`).

**Gate 2Z and `R-11` are hard preconditions for every millisecond and pixel criterion in §11.** `gpuFrameMsP95` is `null` in all three committed baseline shots; until Z-2 lands, no GPU-millisecond exit criterion in this phase is falsifiable. Each criterion in §11 names its instrument dependency. *(Amended 2026-08-19: the Z-2 half is satisfied as of Phase 2's close — `gpuFrameMsP95` is non-null in all 13 committed baseline shots, verified 2026-08-19.)*

---

## 2. The engineering standard, applied to Phase 4

The lifetime classification carries forward: **P** permanent, **K** kernel, **T** transitional, **D** disposable.

Phase 4 is the phase where the **K** class finally pays. `src/world/{seed,noise,terrain,geology}.ts` has been maintained since Phase 0 as *simultaneously* the physics authority and the source `4-1` transliterates. Everything in `4-1` is Class K; everything in `4-2`, `4-3`, `4-5`, `4-6`, `4-7` is Class P and still running in Phase 7.

Three calls worth stating:

- **`4-0b`'s compute budget is Class P and is not a Phase 4 convenience.** It is `6-10` pulled forward. Phase 4 introduces three amortised compute producers with hard millisecond caps; Phase 5 adds a fourth that is 30–80 iterations deep. Building the meter here is not scope creep, it is building it before the thing it exists to schedule.
- **`4-8a` is Class D — deliberately.** It is a profile-table edit that exists for ~7 items until `4-8b` supersedes it, and it should be deleted in the same commit that lands `4-8b`. Its justification is CI legality, not looks (§4 D3).
- **The provisional two-material vertex splat from `3-2` is Class T and dies at `4-6`**, as Phase 3 already states. Do not extend it in Phase 4 to carry more channels; add channels to the page atlas instead.

---

## 3. What the codebase actually is

Eleven findings. Four are fatal as written; the rest each cost between half a day and a re-architecture if discovered during implementation.

### 3.1 `thinInstanceSetBuffer('terrainNode', data, 8)` throws

`RENDERING_PLAN.md` §3.1 point 3 specifies the CDLOD instance buffer as one stride-8 custom thin-instance attribute. Under WebGPU that call **throws at pipeline creation.**

`thinInstanceSetBuffer` with a custom kind falls to the generic branch at [`thinInstanceMesh.pure.js:278-300`](../../node_modules/@babylonjs/core/Meshes/thinInstanceMesh.pure.js:278), which constructs `new VertexBuffer(engine, buffer, kind, !staticBuffer, false, stride, true)` with no explicit `size`. `VertexBuffer`'s constructor resolves `this._size = size || stride || VertexBufferDeduceStride(kind)` ([`buffer.pure.js:259`](../../node_modules/@babylonjs/core/Buffers/buffer.pure.js:259) and the branch at `:305`), so `_size = 8`. `WebGPUCacheRenderPipeline._GetVertexInputDescriptor` then switches on size and **falls through to `throw new Error(\`Invalid Format ... size=8\`)`** ([`webgpuCacheRenderPipeline.js:565-578`](../../node_modules/@babylonjs/core/Engines/WebGPU/webgpuCacheRenderPipeline.js:565)) — WebGPU has no vertex format wider than four components, and `float32x4` is the last case in the table.

Babylon's own precedent is the `splatIndex` branch immediately above ([`thinInstanceMesh.pure.js:266-277`](../../node_modules/@babylonjs/core/Meshes/thinInstanceMesh.pure.js:266)), which splits one wide buffer into **four** four-component vertex buffers over the same `Buffer` at increasing offsets.

**Consequence for `4-5`:** the node record is **two** stride-4 attributes, `terrainNodeA` and `terrainNodeB`, set by two `thinInstanceSetBuffer` calls over two `Float32Array`s. Layout fixed in `4-0`, not discovered in `4-5`.

### 3.2 The memory ceiling closes at tier 1 and does not close at tiers 2 and 3

`estimateGpuMemoryBreakdown` ([`PerformanceBudget.ts:238-297`](../../src/render/webgpu/core/PerformanceBudget.ts:238)) reproduces the committed baseline exactly, so it can be projected forward with confidence. At the reference viewport (1512×982 CSS @ DPR 2 — the machine G-C names):

| | Low | **Balanced** | High | Ultra |
|---|---:|---:|---:|---:|
| Phase 1 close (`989cdac`) | 106.6 | **286.7** | 665.8 | 888.8 |
| Ceiling | 260 | **480** | 700 | 1000 |
| Headroom | 59% | **40%** | **5%** | 11% |

Tier 2's shadow row alone is **320 MiB** — `4096² × 4 cascades × 5 B`.

Phase 3's `3-0` adds `materialArraysMiB` (+26.7 raw at 512², +106.7 at Ultra's 1024²). The exact position at Phase 3's close depends on one thing — whether Gate 2Z's `Z-4` has split `detailMiB` into real cloud and vegetation rows yet:

- **Tier 3 is red either way** (~1029 / 1000), from the 1024² material arrays alone.
- **Tier 2 with the material arrays alone is 696.5 / 700 — it passes, by 3.5 MiB.** With `Z-4`'s Phase 2 rows also counted it is **712 / 700** and breaches. Since Phase 2 is underway and `Z-4` precedes Phase 4, 712 is the number to plan against. *(Amended 2026-08-19: Phase 2 is complete — closed 2026-08-19 — and `Z-4`'s cloud and vegetation rows are live; 712 stands as the number to plan against.)*
- **Tier 2 is red at `4-2` under either reading**: the 4224² height atlas is 68.1 MiB raw, 78.3 after the 1.15 fudge, against at most 3.5 MiB of margin.

`tests/render.webgpu-budget.test.ts` iterates **three** viewports (1280×720@1, 1512×982@2, 2560×1440@2) × nine profiles, so any of these fails `npm test`.

This **corrects the realignment's stated rationale for its reorder** (`PRE_PHASE_4_REALIGNMENT.md` §8: *"assertWithinBudget() fails in CI from `4-2` until `4-8` at the upper tiers"*). Tier 1 — the tier the user's goal names — **never breaches**: it peaks at ~446 MiB after `4-7` and recovers to ~423. The problem is entirely at tiers 2/3, it begins at Phase 3's close rather than at `4-2`, and the reorder alone does not fix it because `4-8` depends on `4-7`. `4-8` has to split (§4 D3).

### 3.3 §5.3's Ultra "1 m L0 texel spacing" is inexpressible

Level-L texel size is `worldPageExtentMeters(L) / WORLD_PAGE_HEIGHT_CORE` = `512·2^L / 256` = `2·2^L` m — **fixed for every tier** by [`pageGeometry.ts:31-44`](../../src/render/webgpu/world/pageGeometry.ts:31) and [`pageKey.ts:113-123`](../../src/render/webgpu/world/pageKey.ts:113). Reaching 1 m needs either a 520² slot or a 256 m base extent; both create a second page geometry, which `tests/architecture.boundaries.test.ts` fails **by name**.

Worse, a tier-dependent L0 spacing makes the render-height authority tier-dependent, which breaks §1.3 by construction: the surface the aircraft touches would depend on a graphics setting.

§5.2's own Ultra figure confirms the 2 m geometry is what was actually costed — 71 MiB ≈ `4224² × 4 B` with 264² slots. §5.3's row is the outlier.

### 3.4 The kernel ports better than feared, and the realignment's headline hazard is wrong

`PRE_PHASE_4_REALIGNMENT.md:513-515` claims `ridgedFbm2D`'s `weight >= 1` vs `weight > 0` branch flips on one ULP and "moves height by metres". **Refuted by reading [`noise.ts:231-245`](../../src/world/noise.ts:231):** branch B is `MEAN + (ridge² − MEAN)·weight`, which at `weight == 1` evaluates to exactly branch A's `ridge²` and at `weight == 0` to exactly branch C's `MEAN`. The three-way branch is algebraically continuous at both switch points; a one-ULP flip moves height by ≲ 1e-4 m. That claim must not be re-litigated, and `4-1`'s budget must not be spent chasing it.

What is real, measured by running the shipped kernel twice — once in f64, once with `Math.fround` at every operation — over 3,000 scattered points at four filter widths:

| Distance from origin | max \|Δh\|, 3,000 points | max \|Δh\|, 40,000 points |
|---|---:|---:|
| ±10⁴ m | 2.6 mm | **4.5 mm** |
| ±10⁵ m | 29 mm | **60 mm** |
| ±10⁶ m | 427 mm | **926 mm** |
| ±5×10⁶ m | — | **3.47 m** |

**The bound is sample-size sensitive, and that matters more than the headline.** A 3,000-point probe suggests 0.05 m holds comfortably at ±10⁵ m; a 40,000-point probe shows it does not hold at all (60 mm > 50 mm). `RENDERING_PLAN.md:347` specifies 4,096 Halton points — few enough to report a pass that a denser probe would fail. Two amplifiers on top: **WGSL is not IEEE-correctly-rounded** (division is specified at 2.5 ULP, `sin`/`cos` at an *absolute* bound), so every number above is a **lower** bound on real GPU divergence; and holding the coordinate chain in f64 buys only **1.43×**, not the ~2× a first estimate suggests.

So **coordinate precision is the whole story**, `RENDERING_PLAN.md:347`'s criterion (`< 0.05 m` at `|x| = 5×10⁶ m`) is off by ~70×, and the honest response is to make the radius an *output* of `4-1` rather than an input (D6). Three further facts:

- **Three JS builtins are not safe substitutes.** `lerp` ([`noise.ts:11`](../../src/world/noise.ts:11)) is `a + (b−a)·t`; WGSL `mix` is specified as `a·(1−t) + b·t` — different rounding at 102 sites per height sample. `smoothstep` ([`noise.ts:15`](../../src/world/noise.ts:15)) has a `low === high` guard WGSL's builtin does not. `Math.round` inside `wrapLatticeCoordinate` ([`noise.ts:51`](../../src/world/noise.ts:51)) is round-half-away-from-zero; WGSL `round` is round-half-to-even.
- **The band-limit weights are page constants, not per-texel values.** `octaveBandWeight(wavelength, filterWidth)` depends only on the octave index and the page's texel size. Measured: at L0–L4 every weight in the `ridges` channel is exactly 1.0; the fade only starts biting at L5. They can be hoisted to the page uniform, computed by the *existing TypeScript*, which removes a divergence source entirely.
- **Eleven measured expectation constants** (`RIDGED_OCTAVE_BAND_LIMIT_MEAN` and the ten in `terrain.ts:40-44` / `geology.ts:93,101,118`) must be *injected* from TS, not retyped into WGSL. A wrong digit changes coarse-page mean height by metres and would pass every parity test run at `filterWidth = 0`.

One evaluation is **34 `valueNoise2D` calls = 306 `avalanche()` calls = 612 wrapping u32 multiplies.** That is the real ALU number `4-3`'s budget row needs, and it is ~4× a naive estimate once supersampling is applied.

### 3.5 The §1.3 invariant is mostly margin, and `4-4` leaves it passing against dead code

Of the four tests in `tests/sim.terrain-authority.test.ts`, only test 3 couples the render and physics paths: `tile.heights[i] === Math.fround(sampleGroundHeight(...))` over four 65² L0 tiles. It works only because the render side runs the identical f64 TypeScript and stores into a `Float32Array` once.

Its render side is `generateTerrainTile`, whose **only two production consumers are deleted by `4-4`**. After that commit the test compares the physics kernel to a TypeScript function nothing renders — and keeps passing. Tests 1, 2 and 4 assert properties of airport/spawn code no Phase 4 item touches (test 2 passes with a 199 m margin against an assertion of `> 0`).

Two measured consequences:

- **`4-3`'s 2×2 supersampling at L0 puts up to 0.98 m between the wheels and the screen.** Over 55,296 texels spanning ±100 km: >1 mm at 33.3% of texels, >10 mm at 7.0%, >100 mm at 0.43%, max 981 mm. That is three times the 0.35 m runway crown Phase 3 classifies as a Class-K physics bug. The cause is the C0 crease in `ridgedFbm2D` (`ridge = 1 − |v|`, squared), so the residual scales **linearly** with texel size, not quadratically — the realignment's recommendation to exclude L0 is right, but its rationale ("supersampling buys nothing there") is not.
- **`|h_render(L0) − h_physics| = 0` is unachievable** once height is accumulated in f32 across ~181 noise evaluations on the GPU. It must be a bound with a stated radius.
- **Nothing asserts that collision *normals* match render normals, and `4-4` is the item that breaks them.** `sampleTerrainNormal` is a 2 m central difference over four extra full-kernel height calls; `4-4` computes render normals in the fragment shader from the page's own texel grid at `2·2^L` m. At L0 those spacings coincide; at every other level they do not, and nothing in the suite would notice. Add a normal-agreement assertion at L0 alongside the height one.

### 3.6 The adapter is generous; the device runs at WebGPU spec defaults

[`Capabilities.ts:32-36`](../../src/render/webgpu/core/Capabilities.ts:32) copies **adapter** limits, and the adapter on the reference machine is generous: `maxTextureDimension2D` 16384, `float32-filterable` present. But [`FlightRenderer.ts:378-386`](../../src/render/FlightRenderer.ts:378) passes `setMaximumLimits: false` and a `deviceDescriptor` carrying only `requiredFeatures`. Babylon populates `requiredLimits` **only** when `setMaximumLimits` is truthy (`webgpuEngine.pure.js:429-438`), so the device gets **spec defaults** — `maxTextureDimension2D` 8192, not 16384.

Two consequences, both of which `4-0` must own:

- **The 4224² atlas fits under 8192, but nothing asserts it.** Every atlas dimension, sampled-texture count and vertex-attribute count Phase 4 adds is checked against a limit the renderer never declared. `4-0` adds `REQUIRED_WEBGPU_LIMITS` and a startup assertion, so a future atlas growth fails loudly instead of on a user's machine.
- **`float32-filterable` is available but not requested**, so `_caps.textureFloatLinearFiltering === false` and every FLOAT texture is forced to NEAREST. `4-4`'s "manual bilinear because r32float is not filterable" is therefore true *as configured* — and it should stay that way. CDLOD geomorphing samples the parent page **at snapped lattice positions**, where `textureLoad` of exact texel values is what correctness wants, not a filtered value; and requesting the feature narrows the supported adapter set for no gain in the vertex shader's hot path. **Decision in `4-0`: do not request it. Record the availability so nobody re-derives this.**

### 3.7 PCSS cannot run on Phase 1's depth-only shadow generator

`4-8` specifies PCSS. `DepthOnlyCascadedShadowGenerator` ([`AtmosphereSystem.ts:120-152`](../../src/render/webgpu/atmosphere/AtmosphereSystem.ts:120)) constructs its RTT with `noColorAttachment = true` — that *was* `1A-5`, the single largest memory win in Phase 1. Babylon's `computeShadowWithCSMPCSS` needs a second `texture_2d_array<f32>` bound from the shadow map's **colour** attachment, which no longer exists. Its own doc comment already says so: *"Keep `filter = FILTER_PCF`: a colour-sampling filter would need the attachment back."*

So `4-8b` gets `FILTER_PCF`, not PCSS, and §5.3's "PCSS at High/Ultra" rows are struck. Reinstating PCSS means undoing `1A-5` and paying its memory back — which is the opposite of what this phase needs (§3.2).

### 3.8 `getCustomRenderList` cannot cull CDLOD nodes, and one mesh destroys four existing levers

`4-5`'s note and `4-8`'s item text both assume per-cascade culling of terrain nodes through `getCustomRenderList`. That hook returns an **`AbstractMesh[]`** (`objectRenderer.js:195, :621-622`). After `4-5` every node is a thin instance of **one** mesh, so a per-cascade *node* subset is not expressible through it at all.

Two further things break with the 151 → 1 mesh collapse: today's per-mesh shadow-caster filtering ([`TerrainClipmapSystem.ts:455-478`](../../src/render/webgpu/terrain/TerrainClipmapSystem.ts:455)), the per-mesh add/remove diff and Governor B lever in `FlightRenderer.ts`, and per-mesh inclusion in the planar reflection.

Also: **thin-instance count is driven by the matrix buffer.** `thinInstanceSetBuffer` updates `instancesCount` only for kind `"matrix"` and `"splatIndex"`; the generic branch sets no count, and the `thinInstanceCount` setter clamps to `matrixData.length / 16` and silently does nothing without one.

**Consequence for `4-5`** (decided in `4-0`, not discovered in week 7): supply the 16-float world matrix per node — 64 B × 448 nodes at Ultra is 28 KiB, trivial, and it carries node origin and scale for free — **and** give the shadow caster list a *second* `Mesh` sharing the same geometry, populated with the cascade's node subset. One mesh for beauty, one for casters.

### 3.9 Three deletions in `RENDERING_PLAN.md`'s list are wrong

`RENDERING_PLAN.md:340` says `4-4` deletes `TerrainGenerationClient`, `terrain.worker.ts`, `terrainProtocol.ts` **and `terrainQueue.ts`**. `BoundedTerrainQueue` from `src/workers/terrainQueue.ts` is imported and instantiated by [`DetailGenerationClient.ts:1,52,65`](../../src/render/webgpu/detail/DetailGenerationClient.ts:1) — **it is the vegetation worker's queue.** Deleting it breaks vegetation generation.

Relatedly, `WORLD_PAGE_LAYOUT` **fails its own validator**: `validateWorldPageLayout` (`validation.ts:107-121`) requires `isPowerOfTwo(heightResolution - 1)` — the pre-§1.4 `2^n+1` geometry — while the shipped `heightResolution` is 256. Verified empirically: it returns exactly one issue. Nothing calls it on the canonical layout today, which is why this has survived since Phase 0.

Finally, **nine `§3.1`/`§3.2` line citations into `TerrainClipmapSystem.ts` are stale by 100–200 lines** (the material is at `:312-331`, not `:271-286`; `applyToMesh` at `:738`, not `:604`; the colour buffer at `:663`, not `:530-543`). Those sections predate Phase 1. **Rule for this phase: prefer symbol names; re-derive every line number against the branch you are writing on.**

### 3.10 Nothing owns a millisecond-denominated compute budget

`4-3` (~0.35 ms/page), `4-6` (~0.2 ms/page) and `4-7` (~0.3 ms/page) are each documented in `PerformanceBudget.ts:30-32` as *"amortised hard caps enforced by their schedulers"*. **No scheduler exists.** `FrameGraphPass.cadence` is an integer frame divisor (`frameIndex % cadence === 0`, [`FrameGraph.ts:130`](../../src/render/webgpu/core/FrameGraph.ts:130)) and nothing else does.

With no shared meter, a banked turn that admits many pages at once spends three separate caps in one frame. Governor B's ladder ([`AdaptiveGovernor.ts:98-113`](../../src/render/webgpu/core/AdaptiveGovernor.ts:98)) has 14 rungs and §5.5's **rung 0 "GPU compute budget" is confirmed absent** — so the governor's first available response to a compute spike is to cut something visible.

### 3.11 The frame budget has no room at tier 2 for a row Phase 4 must add

`FRAME_BUDGET_MS[2]` sums to 13.60 ms against `FRAME_TARGET_MS[2] = 13.7` — **0.10 ms of slack.** `4-7` needs an `occlusionCompute` row. Adding any positive value at tier 2 trips the budget test in the same commit that adds the row. The funding is `4-8b`'s shadow cut — so the row and its funding must land together, in `4-0`.

> **Corrected 2026-08-31 (Phase 6 item `6-12`). Two things above were wrong, and
> one of them was load-bearing.**
>
> **The citation was a phantom.** This section attributed to `§5.4:715` the
> quote *"Terrain leaves the caster list entirely once horizon maps land"*. That
> sentence **does not exist anywhere in `RENDERING_PLAN.md`** (grep: zero hits),
> and line 715 there is blank. The only occurrences in the repository are inside
> **this file** — here, and at §14's "Terrain leaves the *far* field, not the
> caster list", which **already corrects it**: *"`RENDERING_PLAN.md` says terrain
> 'leaves the caster list entirely'; taken literally that contradicts `4-5`"*.
> So this document contained its own refutation while the funding argument above
> continued to rest on the refuted reading. The real behaviour is smaller than
> the quote claims — inside the shortened cascades terrain still casts, through
> one caster mesh per cascade — which means the `occlusionCompute` row may have
> been funded against a saving larger than the one delivered. Phase 4 is closed
> and the tree measures well inside its targets, so this is benign in practice;
> it is recorded because *the reasoning was unsound even though the outcome was
> fine*, and that is the only kind of error a plan document can still teach from.
>
> **The figure is stale, and the slack has HALVED.** Re-measured on the current
> tree: tier 2 sums to **13.650 against 13.7 — 0.050 ms**, not 13.60/0.10.
> Something spent 0.05 ms of tier 2 since Phase 4 and no one revised the number.
> Tier 2 is now **99.6% committed**: any new row there must come out of an
> existing one in the same commit. The same stale figure lived in
> `PerformanceBudget.ts`'s `occlusionCompute` docblock and has been annotated
> there too. **Measure before quoting either; do not quote them as current.**

---

## 4. Amendments to `RENDERING_PLAN.md` Phase 4

### D1 — New item `4-0 terrain-spine-contract` (2.0 d)

Mandated by the realignment at 1.25 d; **re-priced to 2.0 d.** §5 is its content and it is larger than the realignment's bullet assumed: seven ownership rows and two status flips, five profile fields, three estimator rows, a frame-budget row and its funding cut, the slot key, the cyclic season blend, the node-to-slot mapping, the per-stage binding budget, `REQUIRED_WEBGPU_LIMITS`, the `payload.ts` reconciliation, the readback helper and the layout-validator fix. Every argument `C6` made for Phase 3's `3-0` applies at larger scale, and one more: **the 24-bucket season cache key is roughly free here and a re-architecture afterwards** (`RENDERING_PLAN.md:173`).

### D2 — New item `4-0b compute-budget` (2.0 d) — `6-10` moved from Phase 6

§3.10. Three producers with hard millisecond caps and a missing governor rung is exactly the configuration the caps' own docstring already claims is enforced and is not. Phase 6 drops to ~27.5 d; the programme total is unchanged.

### D3 — `4-8` splits into `4-8a csm-resize` (0.5 d, at the head) and `4-8b csm-nearfield` (1.5 d, after `4-7`)

§3.2. `4-8` as specified depends on `4-7`'s horizon map, so it cannot come first; but its memory refund is the only thing that pays for the atlases at tiers 2/3.

`4-8a` is **profile-table only, and only at tiers 2 and 3**: `shadowMapSize` 4096 → 2048, cascade count and distance unchanged. That refunds 236 MiB at tier 2 and 240 at tier 3 while leaving distant terrain still self-shadowing at ~3 m/texel in the far cascade instead of ~1.5 m. **Tier 1 keeps its current shadow configuration** — it has 40% headroom and does not need the cut, and §2.0's *"no gate leaves the sim worse"* is worth more than symmetry. The per-tier asymmetry is the point, and it is temporary.

`4-8b` then lands the real near-field configuration (§5.3's rows) with **`FILTER_PCF`, not PCSS** (D10), per-cascade culling through the **caster meshes** (D11), terrain leaving the *far* cascades, and **restores `msaaSamples: 4` at tier 2** — which the `1B-11` decision in `ARCHITECTURE.md` explicitly deferred to this item. Note that restoration *costs* 54.9 MiB raw at tier 2, more than the 46.2 MiB the shadow row refunds, so `4-8b` is net **+8.7 MiB** there. That is affordable and it is in the table below; it is not a refund.

Projected at the reference viewport under this order, both tiers stay legal at every commit:

Generated from `estimateGpuMemoryBreakdown` at the reference viewport, with each step's allocation from §5.2's derived sizes. Every row is the running total after that item, in MiB:

| After | Balanced (ceiling 480) | High (ceiling 700) |
|---|---:|---:|
| Phase 1 close (`989cdac`) | 287 | 666 |
| + Phase 2 (cloud volumes, vegetation) | 300 | 681 |
| + Phase 3 (material arrays) | 330 | **712 ✗** |
| `4-8a` csm-resize | 330 | 436 |
| `4-2` height atlas | 390 | 514 |
| `4-7` occlusion + horizon + pyramid | 438 | 576 |
| `4-8b` near field, +MSAA 4× at High | 419 | 586 |
| `4-5` CPU meshes deleted | 381 | 548 |
| `4-6` splat atlas, two season buckets | **444** ← peak | **631** |

Balanced never breaches and ends at 444 / 480 — 7.5% headroom. High breaches only at Phase 3's close and is legal at every Phase 4 commit once `4-8a` lands. **Regenerate this table whenever a §5.2 size changes**; it is the only evidence for the ordering and it must not be hand-carried.

### D4 — Phase 3 edit: `3-2`'s fourth vertex lane becomes `atlasSlot` (0 d)

§1 P6. `PHASE_3_EXECUTION_PLAN.md` §7 `3-2` defines the repurposed colour buffer as `(materialIdA, materialIdB, weightB, spare)`. Rename the fourth lane `atlasSlot` and write `-1` into it.

This is load-bearing for D3's order, not cosmetic. `4-7` bakes occlusion into channel pages; its consumer is the surface plugin's fragment shader; without a slot index on the CPU tile mesh, that consumer cannot exist until `4-4`. And **`4-8b` may only shorten the shadow distance once the horizon map is actually being sampled** — otherwise distant mountains go unshadowed for the rest of the phase, which is precisely the regression `RENDERING_PLAN.md` warns about at `4-8` (*"Doing it earlier leaves distant mountains unshadowed for months"*).

### D5 — `4-1` is re-priced to 5.5 d and scoped to the height chain only

§3.4. The climate chain (`sampleTerrainMoisture` / `sampleTerrainClimate` / `terrainTemperatureFromClimate` / `classifyBiome`, `terrain.ts:286-349`) moves to `4-6`: its `filterWidthMeters` is validated and then never used, `R-13` changes its signature first, and `4-6` deletes `classifyBiome` outright. Porting it in `4-1` is porting it twice. `4-6` goes 7.0 → 9.0 d (`R-27` already anticipated the re-price).

### D6 — `4-1`'s parity criterion becomes four criteria with a stated world radius

§3.4, §3.5. Replace `RENDERING_PLAN.md:347`'s single line with:

1. **Bit-equality** (`toBe`) on `avalanche` / `mixSeed` / `hashLatticeCoordinates` / `unitFloatFromHash` at all `|x|`. Achievable by construction — these are integer ops and `seed.ts` already guarantees the 24-bit quotient.
2. **`|Δh| < 0.05 m`** over **≥ 40,000** points × `filterWidth ∈ {0, 8, 32, 128, 512}` within **±10⁴ m** (measured 4.5 mm — 11× headroom). The point count is part of the criterion: 4,096 Halton points report a pass that a denser probe fails.
3. **`|Δh| < 0.25 m` within ±10⁵ m**, and a **slope-relative** bound beyond, out to the wrap no-op radius.
4. **`|h_atlas(L0) − h_physics| ≤ 1 mm`** within ±10⁴ m — the §1.3 gate, as a bound and not an equality.

**The supported world radius is an output of `4-1`, recorded as a number in `4-0`'s contract** — measured after split-origin addressing lands, not assumed from it. `5×10⁶ m` is struck: measured divergence there is **3.47 m**, ~70× the criterion it appears in.

### D7 — `4-4` sites the `ShadowDepthWrapper` in a named factory with a GPU guard

`ARCHITECTURE.md`'s `0-9` decision-log entry records that a late attachment **silently** falls back to the undisplaced depth pass. `4-4` is the item that introduces displacement. Make wrapper construction a named sub-step inside the single terrain material factory (P4) and add a `tests/gpu/` assertion against the **real** material — not a synthetic one — mirroring `tests/gpu/shadow-depth-wrapper.test.ts`.

### D8 — `4-9` grows to 1.5 d and gains a parity test

§3.5. `4-9` transliterates `3-8`'s runway earthworks into WGSL. From that commit there are two implementations of a 0.35 m surface the aircraft lands on. One day does not buy a parity test; 1.5 does.

### D9 — New item `4-10 tier-remeasure` (1.0 d)

Mandated by the realignment: `6-11` minus the four-tier redesign, so G-C has evidence at the v1 cut line rather than tier rows measured before Phase 2 existed.

### D10 — PCSS is struck from `4-8b` and from §5.3

§3.7. `4-8b` ships `FILTER_PCF`. §5.3's "PCSS" in the High and Ultra shadow rows is deleted, and `RENDERING_PLAN.md`'s `4-8` item text — *"3×1536, 1.8 km, PCSS"* — is reconciled with §5.3's actual Balanced row (3×1280 @ 1400 m) at the same time, which the realignment already asked for. Softer contact shadows are a Phase 7 conversation, and they cost `1A-5`'s memory win to have.

### D11 — Terrain shadow casting is a second mesh, not a render-list filter

§3.8. Both `4-5`'s note and `4-8`'s item text assume `getCustomRenderList` can supply a per-cascade *node* subset. It cannot — it returns meshes, and after `4-5` there is one.

**And the obvious repair does not work either.** Rebuilding one caster mesh's thin-instance buffer inside `_shadowMap.onBeforeRenderObservable` looks right — the observable does fire per cascade — but Babylon records every cascade into one `_renderEncoder` and submits the whole frame once (`webgpuEngine.pure.js:2341-2343`). Every `queue.writeBuffer` issued during recording lands *before* that command buffer executes, so all cascades read whatever was written last. The one thing that genuinely varies per pass is `thinInstanceCount`, because it is CPU-side and baked into the recorded draw. The failure mode is one cascade's node subset rendered into all of them — plausible enough to survive review.

**The mechanism, decided in `4-0`:** one caster mesh **per cascade** (2/3/4 by `shadowCascades`), each sharing the 33×33 geometry, each with its own thin-instance buffer written exactly once per frame before the shadow map renders. Each carries `layerMask = 0` so no camera draws it, and `metadata.excludePlanarReflection = true` so the water mirror does not. This also preserves the Governor B shadow-caster-distance lever that the 151 → 1 mesh collapse would otherwise delete.

### D12 — `densityField` is filtered and ported, as `4-6b` (2.0 d)

The one bullet of the realignment's §8 this plan would otherwise drop. `densityField` is unfiltered and TypeScript-only, but `4-6` must read it for the canopy splat channel. Point-sampling a 260 m-lattice field onto a 128 m-texel level-5 page re-rolls an arbitrary phase per level — the same defect `1B-2` fixed for height, and it would show up as canopy cover that changes when a page changes LOD.

`4-6b` threads `filterWidthMeters` through `VegetationDensityInput` under the `0-4` convention, updates its consumer in `detail/generation.ts`, and emits **one shared WGSL include** consumed by both the classifier and the vegetation path — not a copy — with an `owners.ts` row naming the definition site.

It also carries **`R-27`'s consumers contract**, which `D5` would otherwise leave unfunded inside `4-6`: `chooseTreeSpecies`, `chooseShrubSpecies` and the wildlife habitat rules are rewired onto the classifier's weight vector, so the ground and the forest standing on it are classified by one authority. Splitting this out of `4-6` is what gives `R-4E` a cut line that is not the whole item.

### D13 — `P1` does not fail, and `4-8a`'s justification changes (implementation)

Re-measured on the implementation branch at the reference viewport, before any
Phase 4 allocation:

| | Low | **Balanced** | High | Ultra |
|---|---:|---:|---:|---:|
| Measured at Phase 3's close | 137.7 | **288.7** | 643.5 | 865.5 |
| Ceiling | 260 | **480** | 700 | 1000 |
| Headroom | 47% | **40%** | 8% | 13% |

§3.2's projection assumed two things Phase 3 did not ship: Ultra's material
arrays at 1024² (it shipped 512², recorded in `QualityProfile.ts`'s own
deviation note) and `SHADOW_DEPTH_BYTES = 5` (corrected to 4 at `3-0`, worth
64 MiB at tier 2). `2Z`'s free win also took tier 1 to 2× MSAA. So `npm test`
was green at all four tiers and P1 was satisfied.

**`4-8a` still lands first**, and its justification is now Phase 4's own
allocations rather than pre-existing CI redness: without the cut, tier 2
reaches ~829 / 700 by `4-6`. The item is unchanged; only the reason is.

Two further corrections in the same family:

- **§5.1's standing fallback is already spent.** "`msaaSamples` 4 → 2 at tier 1
  (−39.5 MiB)" cannot be taken: tier 1 has been at 2× since `2Z`. The
  replacement fallback, if `4-6` had landed above estimate, was
  `channelAtlasSlots` at tier 1 — the same lever D13 takes at tier 0 below.
- **§4 D3's table never checked tier 0**, and tier 0 is where the channel atlas
  binds. See D14.

### D14 — `channelAtlasSlots` is 100 at tier 0, not 144 (implementation)

§5.3 gives Low `heightAtlasSlots` and `channelAtlasSlots` both at 144. At 144
the derived channel atlas is 1632² × 28 B = 71.1 MiB raw, and tier 0 lands at
~255 / 260 — 2% headroom, inside the estimator's own ±15% calibration
tolerance (`R-4F`), i.e. not actually legal.

Height residency is untouched: geometry must not thrash. The saving is taken on
the CHANNEL atlas, which §5.2 already nominates as the place to take one ("the
saving to take is fewer azimuths at the canonical resolution, not a second
geometry" — the same principle, applied to slot count rather than azimuth
count). Low's `finestResidentLevel: 1` already halves its finest-level page
demand, so channel residency is where the slack is. Measured result: tier 0
ends the phase at ~236 / 260.

### D15 — Governor B rung 0 is two notches; tier 1 ships two shadow cascades

Two implementation-time refinements, both measured:

- **Rung 0 is two notches (0.6, then 0.35), not one.** The GPU ladder sheds one
  step per 120-frame window, so a single notch gives the compute meter one
  window to resolve a spike before the ladder cuts something visible. Two
  notches are still entirely before any visible lever, which is the property
  the rung exists for.
- **Tier 1 ships `2×1280@1400`, not §5.3's `3×1280@1400`.** A third cascade
  multiplies the vegetation SHADOW draw estimate by 1.5 —
  `estimateVegetationDrawCalls` counts near-band chunks once per cascade — at
  the one tier whose vegetation frame row is already ~5× over budget and whose
  draw ceiling this phase may not raise. What the third cascade buys is
  near-cascade texel density, and two cascades over 1,400 m at 1280² already
  give ~0.23 m/texel in the contact cascade against the ~1.5 m Phase 1 shipped
  at 2×2048 over 7 km. Six times finer for the same draw count is the trade;
  the third cascade is not. Tier 2's cut from four cascades to three moved the
  measured vegetation debt ratio 7.38 → 6.32, which is re-pinned rather than
  inherited.

### D16 — the parity criteria are re-pinned from measurement

`4-1`'s harness measured, over 40,960 / 12,960 / 3,840 points × five filter
widths on the reference adapter:

| radius | max \|Δh\| |
|---|---|
| ±10⁴ m | **3.78 mm** (bound 50 mm) |
| ±10⁵ m | **3.44 mm** (bound 250 mm) |
| ±2.8×10⁶ m | **2.37 mm** |

**The error does not grow with radius.** Naive f32 measured 4.5 mm / 60 mm /
3.47 m over the same probe, so split-origin addressing did not merely improve
the far field — it removed the coordinate-magnitude term. What is left is f32
accumulation over ~50 terms, and it is flat.

Two consequences:

- **The supported world radius is 2.8×10⁶ m**, not the 10⁵ m D6 assumed, and it
  is set by the LATTICE WRAP rather than by precision: beyond ~2.8×10⁶ m the
  finest 43 m octave repeats by construction (`0-4`), so the world tiles rather
  than diverges. `TERRAIN_SUPPORTED_WORLD_RADIUS_METERS` records it.
- **Criterion 4 is 5 mm, not 1 mm.** f32 accumulation floors at ~3.6 mm and no
  arrangement of the shipped arithmetic gets below it without carrying height
  as a double-float. 1 mm was never the binding number either: the runway crown
  the aircraft lands on carries **5.8 mm of chord error at L0's own 8 m vertex
  spacing** (`runwayEarthworksProfile.crownMeters`' own note), so a 3.6 mm
  kernel disagreement is an order of magnitude below the surface's own
  representation error and two orders below the 0.35 m crown Phase 3 classifies
  as a Class-K physics bug. Measured through the real atlas: **0.056 mm** height
  and **0.001°** normal agreement on an L0 page.

### D17 — the quadtree roots at level 9, and node/page arithmetic follows

`4-5` as written leaves the root level implicit. Implemented at **level 9**
(32,768 m nodes), not the level 7 a first reading suggests. The root ring is
the quadtree's FLOOR COST, paid before a single node is split: at level 7 the
45 km far plane needs ~121 root nodes, which is three quarters of Low's entire
160-node budget spent on ground at the horizon. At level 9 it is ~25.

Three smaller consequences, each recorded in code:

- The node record's `subIndex` lane carries **page parity** alongside
  `subNodeX/subNodeZ`, because the vertex shader needs to know which quadrant of
  its parent page a node occupies to address the parent's texels — and the
  parent's texels are what the geomorph mixes toward.
- The node budget check counts the **unprocessed remainder of the current
  level**, not just what is emitted and queued; counting only the first two lets
  a level's tail overrun the budget silently.
- Selection is **breadth-first by level**, nearest-first inside a level. A
  depth-first descent spends the whole budget on the first quadrant it enters,
  so the ground behind the aircraft disappears rather than coarsening.

### Amended ledger

| Gate | Items | `RENDERING_PLAN.md` | This plan |
|---|---|---:|---:|
| 4A — The kernel and the atlas | `4-0` `4-0b` `4-8a` `4-1` `4-2` `4-3` | 10.5 | **17.50** |
| 4B — The light that describes shape | `4-7` `4-8b` | 7.0 | **6.50** |
| 4C — The quadtree | `4-4` `4-5` | 9.0 | **9.00** |
| 4D — Identity and retirement | `4-6` `4-6b` `4-9` `4-10` | 8.0 | **13.50** |
| **Phase 4** | | **34.5** | **46.5 d ≈ 10.3 weeks** |

Net **+12.0 d**, of which 2.0 is `6-10` relocated (programme-neutral) and 2.0 is the climate chain relocated from a Phase 4 item that would otherwise port it twice. The genuinely new cost is **8.0 d**: the contract (2.0), the CSM split (0.5), `4-1`'s re-price (2.0), `4-2`'s slot-lane ownership (0.5), `4-6b` (1.5), `4-9`'s parity test (0.5) and the tier re-measure (1.0).

---

## 5. The terrain spine contract (`4-0`)

`src/render/webgpu/terrain/TerrainSpineContract.ts`, Class P, no Babylon import, ~180 lines. Eleven consumers depend on it; it lands before any of them.

### 5.1 Page identity and the season key

The single most important decision in this item. `WorldPageKey` today is `world-page-v1/{level}/{x}/{z}` ([`pageKey.ts:83`](../../src/render/webgpu/world/pageKey.ts:83)) with no room for a season.

**Exactly one channel family is season-dependent.** Height is a function of `(level, x, z, seed)`; erosion (Phase 5) runs on geological time; occlusion is geometry-only; the aux channels are geometry-only. Only the **splat/land-cover page** varies with `dayOfYear`. So the key does not change — the **slot key** does:

```ts
/** Atlas residency identity. `variant` is 0 for every season-invariant channel. */
export interface TerrainSlotKey {
  readonly page: WorldPageKey;
  readonly variant: number;        // splat: the 24-bucket season index; else 0
}
export const SEASON_BUCKETS = 24;                       // ≈ 15-day resolution
export const SEASON_BUCKETS_RESIDENT = 2;               // never more — see below
export function seasonBucket(dayOfYear: number): number;
export function seasonBucketBlend(dayOfYear: number): { lo: number; hi: number; t: number };
```

**The season axis is cyclic, and a linear bucket index breaks at the year boundary.** Bucket 23 (mid-to-late December) adjoins bucket 0 (1 January); a naive `lo / lo+1` pair asks for bucket 24 in late December. `seasonBucketBlend` is computed on bucket **centres** with modular arithmetic — `s = dayOfYear·24/365 − 0.5`, `lo = ((floor(s) % 24) + 24) % 24`, `hi = (lo + 1) % 24`, `t = s − floor(s)` — and a test walks all 365 days asserting `lo, hi ∈ [0,23]`, `hi === (lo+1) % 24`, and continuity across 31 Dec → 1 Jan.

**The residency rule, stated as data because the estimator has to consume it:** at most **two** season buckets are resident per page at any time, cross-faded in the shader by `t`; the bucket participates in the slot key **for eviction purposes only**. It is not a cache multiplier over 24. `channelAtlasMiB = channels × slotBytes × slots × SEASON_BUCKETS_RESIDENT` for the splat family and `× 1` for every other family, asserted by a form test so the number moves when its inputs move.

`RENDERING_PLAN.md:173` says the season key *"costs one extra channel-atlas slot"*. It does not: a two-bucket cross-fade needs both buckets resident for every **visible** page simultaneously, so peak splat demand is 2 slots per page, and the atlas is sized for it.

**Both buckets stay resident and cross-faded at all times.** A tempting optimisation — snap to the nearest bucket while the clock is static, cross-fade only while it is being scrubbed — saves nothing, because the atlas is sized for two either way; the only saving is the second bucket's *bake*, which is what `4-0b`'s meter exists to schedule. What it costs is G-B: at rest the snowline and land cover would sit at a bucket centre up to 7.6 days away, so the ground would quantise to 15-day steps exactly when the user is looking at it. If the bake cost bites, admit the second bucket through `4-0b` at low priority — do not degrade the picture at rest.

This costs +27.7 MiB at Balanced, which the D3 table already carries. **Standing fallback if `4-6` lands above estimate: `msaaSamples` 4 → 2 at tier 1 (−39.5 MiB)** — named here rather than discovered at `4-6`.

### 5.2 Atlas geometry, derived not copied

```
heightAtlasSlots   144 / 196 / 256 / 256      (Low / Balanced / High / Ultra)
heightAtlasEdge    3168 / 3696 / 4224 / 4224  = sqrt(slots) × 264
heightAtlasMiB     38.3 / 52.1 / 68.1 / 68.1  = edge² × 4 B
channelAtlasEdge   1632 / 1904 / 2176 / 2176  = sqrt(slots) × 136
```

All well inside the **device's** `maxTextureDimension2D` of 8192 (§3.6 — the adapter offers 16384, the device runs spec defaults). **`heightAtlasMiB` is computed from `heightAtlasSlots`, not copied.** `RENDERING_PLAN.md` §5.2's row reads 38/55/55/71: it mixes MiB with decimal-MB figures and puts High equal to Balanced, contradicting that document's own §3.1, which groups High with Ultra at 4224². The derived numbers win. Rewrite `RENDERING_PLAN.md` §5.2's row to **38/52/68/68 MiB** and re-sum its totals (Balanced 416→413, High 526→539, Ultra 684→681), and add a test asserting the estimator and the profile field move together.

**Node-to-slot mapping**, undefined in the source plan and the reason `cdlodNodeBudget` (160/240/320/448) looks larger than `heightAtlasSlots` (144/196/256/256): **one 264² slot serves an 8×8 block of 33×33 CDLOD nodes** at that level. A node spans `512·2^L / 8 = 64·2^L` m across 32 quads, giving exactly the page's own `2·2^L` m texel spacing. Nodes and slots are therefore not in 1:1 correspondence and never were; the node record carries `(slotIndex, subNodeX, subNodeZ)`.

**Channel page enumeration** — every channel named, formatted and costed here, replacing §5.2's unattributed 23 MiB of "surface + aux":

| Family | Channels | Format | Resolution | Season | Item |
|---|---|---|---|---|---|
| splat | 4 material ids + 4 weights | 2 × rgba8unorm | 136² | **yes, ×2** | `4-6` |
| occlusion | sky visibility, bent normal xy | 1 × rgba8unorm | 136² | no | `4-7` |
| horizon | 8 azimuth elevation angles | 2 × rgba8unorm | 136² | no | `4-7` |
| *(reserved)* | flowAccum, lakeDepth, soilDepth | r16 × 3 | 136² | no | `5-5` |

**The horizon map stays on the canonical 136² channel core**, and a half-resolution 68² page is explicitly rejected. A horizon-angle field genuinely is macro-scale, and 68² would save 20.7 MiB at Balanced — but 68 is core 60 + gutter 4, i.e. a *second channel geometry*, which is the exact rule §3.3 invokes to strike the Ultra 1 m L0 row. Breaking it here to save memory the D3 table shows we do not need would be the plan contradicting itself in the same section. If the horizon field later proves over-sampled, the saving to take is **fewer azimuths at the canonical resolution**, not a second geometry.

### 5.3 Profile fields

Added to `WebGpuQualityProfile` (20 fields today):

| Field | Low | **Balanced** | High | Ultra |
|---|---:|---:|---:|---:|
| `cdlodPixelThreshold` | 4.0 | **3.0** | 2.0 | 1.5 |
| `cdlodNodeBudget` | 160 | **240** | 320 | 448 |
| `finestResidentLevel` | 1 | **0** | 0 | 0 |
| `heightAtlasSlots` | 144 | **196** | 256 | 256 |
| `channelAtlasSlots` | 144 | **196** | 256 | 256 |

**`finestResidentLevel` replaces `RENDERING_PLAN.md` §5.3's "L0 texel spacing 4/2/2/1 m" row** (§3.3). Texel size stays `2·2^L` m universally — tier-independent, so §1.3's authority is not a function of a graphics setting. Low reaches 4 m by never streaming L0; Ultra buys detail through `cdlodPixelThreshold 1.5` and `cdlodNodeBudget 448`, not through a finer height page. A unit test asserts `texelSizeMeters(level)` takes no tier argument.

`terrainRings` and `terrainTileResolution` are **datums of the CPU tile path** — the file's own comment says `4-5` deletes them. They go with `4-5`, not before.

### 5.4 Estimator and budget rows

`estimateGpuMemoryBreakdown` gains `heightAtlasMiB`, `channelAtlasMiB` and `heightPyramidMiB`, and loses `terrainGeometryMiB` at `4-5`. `FRAME_BUDGET_MS` gains `occlusionCompute`, funded in the same commit by the shadow cut `4-8b` delivers (§3.11):

```
occlusionCompute  0.10 / 0.20 / 0.25 / 0.40   (4-0)
shadows           0.7  / 1.1  / 0.8  / 1.8    (4-0: tiers 2,3 only — 4-8a has paid for those)
shadows           0.7  / 0.7  / 0.8  / 1.8    (4-8b: tier 1 joins)
```

**The cut is phased with the item that earns it**, which is the `R-22` failure mode the realignment named: a budget row must not assert a spend nothing has delivered. `4-0` cuts `shadows` only at tiers 2 and 3, where `4-8a` has already halved the maps in week 1. Tier 1 keeps 1.1 ms until `4-8b` actually shortens its cascades in week 6. Both configurations sum under `FRAME_TARGET_MS`. Landing `occlusionCompute` without at least the tier-2 cut fails the budget test in that commit — tier 2 has 0.10 ms of slack (§3.11) — so the row and its funding must be in one commit.

### 5.5 Ownership rows

`ARCHITECTURE.md` §1 is enforced by `owners.ts` and the boundary test. Phase 4 **adds seven rows and flips two reserved rows from planned to live**, each in the commit that creates its artifact. **The WGSL kernel include has no row today** — the enforcement that caught the audit's institutional failure does not cover the artifact `4-1` creates, which is exactly how a second definition of the height kernel would appear. Neither does the global height pyramid, the quadtree or the debug overlay; an unowned artifact is the failure this table exists to prevent.

| Artifact | Owner | Definition site | Lands at |
|---|---|---|---|
| Terrain spine contract | terrain-geometry | `terrain/TerrainSpineContract.ts` | `4-0` *(new)* |
| Shared amortised-compute meter | performance | `core/ComputeBudget.ts` | `4-0b` *(new)* |
| Terrain height kernel (WGSL) | terrain-geometry | `terrain/TerrainKernel.ts` | `4-1` *(new)* |
| `TerrainPageAtlas` | terrain-geometry | `terrain/TerrainPageAtlas.ts` | `4-2` *(reserved → live)* |
| Global height pyramid | terrain-geometry | `terrain/GlobalHeightPyramid.ts` | `4-7` *(new)* |
| Page occlusion bake | terrain-geometry | `terrain/PageOcclusionBake.ts` | `4-7` *(new)* |
| CDLOD quadtree | terrain-geometry | `terrain/TerrainQuadtree.ts` | `4-5` *(new)* |
| Terrain debug overlay | terrain-geometry | `terrain/TerrainDebugOverlay.ts` | `4-3` *(new)* |
| Land-cover classification | terrain-material | `terrain/LandCoverClassifier.ts` | `4-6` *(seasonal-family row reserved → live; sole authority for splat, species and habitat — `R-27`)* |

### 5.6 Also decided in `4-0`

- **The CDLOD node record**, as a 16-float world matrix (which drives `instancesCount` — §3.8 — and carries origin and scale for free) **plus two stride-4 custom attributes** (§3.1): `terrainNodeA = (slotIndex, subNodeX, subNodeZ, level)`, `terrainNodeB = (morphK, parentSlotIndex, texelSize, maxDeviation)`.
- **`morphK` is computed on the CPU, once per frame, against the beauty camera**, and carried in `terrainNodeB` — never read from `scene.vEyePosition` in the vertex shader. The same vertex shader runs for the beauty camera, each shadow cascade under the `ShadowDepthWrapper`, and the planar-reflection camera; an in-shader camera-relative morph makes those three surfaces disagree, which is a depth-fighting and shadow-acne bug that looks like everything except its cause.
- **Two meshes, sharing geometry** (§3.8, D11): a beauty mesh and a shadow-caster mesh whose thin-instance buffer is rebuilt per cascade.
- **Fix `validateWorldPageLayout`** (§3.9) to accept a power-of-two height core in `[2, 2048]`, mirroring the rule `surfaceResolution` already has, and add `expect(validateWorldPageLayout(WORLD_PAGE_LAYOUT)).toEqual([])` to `tests/world.page-geometry.test.ts` so the canonical layout can never again fail its own validator unnoticed.
- **`payload.ts`'s role**, explicitly: it stays the sole owner of *what channels exist and what they mean*, and the quantised `Quantized*Page` types are relabelled as the **CPU/worker transfer encoding**. Phase 4 adds a GPU-residency channel descriptor `{ name, gpuFormat, coreResolution, storedEdge, seasonKeyed }` alongside them, in one PR against `payload.ts` as the channel rule requires. Nothing in `src/` constructs a `WorldPagePayload` today and `4-3` never will, so leaving the two unreconciled would let the channel rule quietly stop meaning anything.
- **A sampled-binding budget by stage.** The terrain `PBRMaterial` already binds albedo, bump, reflectivity, reflection, metallic-reflectance and lightmap; Phase 4 adds the height atlas (vertex **and** fragment), the splat atlas, the occlusion atlas and the horizon atlas. Texture visibility derives from which stage's `CUSTOM_*_DEFINITIONS` carries the declaration, so the count is per-stage. `4-0` enumerates every binding with a running count and asserts it in the material factory against `engine.getCaps().maxTexturesImageUnits`.
- **`REQUIRED_WEBGPU_LIMITS`** in `Capabilities.ts`, asserted at startup (§3.6).
- **Three boundary rules constrain how this contract may be written**, and naive Phase 4 code fails all three. (i) No `WorldPage*` / `WORLD_PAGE_*` symbol and no `*GUTTER*` / `*PAGE_EXTENT*` constant may be declared outside `world/` — so `TerrainSpineContract.ts` **imports** page geometry and names its own symbols `TerrainSlot*` / `TERRAIN_ATLAS_*`. (ii) No `profile.tier` read may appear outside `core/` — the tier rule; atlas sizing is a *profile field*, not a `switch (tier)` in the terrain directory. (iii) `LandCoverClassifier.ts` must carry `dayOfYear` in a **type position** from its first line, or the seasonal-family test fails the build.
- **A plugin naming and priority convention.** The one terrain material already carries `TerrainMaterialPlugin` at priority 180, `AerialPerspectivePlugin` at 205 and `CloudShadowMaterialPlugin` at 210, and Babylon **concatenates** same-hook code across plugins in priority order rather than overwriting. Phase 4 adds a fourth and fifth writer to the same hooks, so every injected function and variable takes a per-plugin prefix and every new plugin declares its priority relative to those three. A WGSL identifier collision here is a compile error, not a silent fallback — which is the good case, but only if the convention exists before two plugins are written.
- **Readback is async and 256-byte-row-aligned.** A 264-texel r32float row is 1056 B, padded to 1280. `4-0` ships one helper returning `Promise<Float32Array>` for a page rect; every `4-1`/`4-3` parity test is async and runs inside `engine.beginFrame()/endFrame()`.
- **Compute reads of the height atlas use `textureLoad` only, never `textureSample*`.** `ComputeShader` creates its pipeline with `layout: "auto"`, so the browser infers the binding's sample type from the WGSL; binding r32float as a filtering-sampled texture is a validation error at pipeline creation.
- **The parity criterion form and the supported world radius** (D6).
- **L0 is excluded from supersampling** as a tested rule, not a tuning constant, with the measured 0.98 m residual recorded as its justification.
- **`filterWidthMeters = 0.0` at L0**, so `filtering` is false and the L0 page is bit-identical to the physics path *by construction* rather than by floating-point luck.
- **Band-limit weights and `ridgedChannelVarianceKept` are hoisted** to the page uniform, computed by the existing TypeScript in f64 and passed as f32. The parity harness calls the same helper, so the fade weights agree by construction.
- **No `float32-filterable`** (§3.6); manual 4-tap `textureLoad`.

---

## 6. Work order

### 6.1 Dependencies

```
4-0 ──┬──→ 4-0b ──→ 4-3
      ├──→ 4-8a  (no dependency; memory legality)
      └──→ 4-1 ──→ 4-2 ──→ 4-3 ──→ 4-7 ──→ 4-8b
                                     │
                                     └──→ 4-4 ──→ 4-5 ──→ 4-6 ──→ 4-9 ──→ 4-10
```

`4-8a` depends on nothing and should land in the first half-day. `4-0b` and `4-1` are siblings after `4-0`.

### 6.2 Gate order, and why each gate is visible

The plan flags Phase 4 as its biggest incrementality risk and mandates a debug overlay. That is necessary but not sufficient — a false-colour overlay is not a demo. This order gives each gate a payoff a pilot can see:

- **4A — the kernel and the atlas.** Pages generate on the GPU into the atlas. ***Visible:* the false-colour residency overlay, and nothing else.** This is the phase's dark stretch, stated plainly: the CPU tile path still draws the ground and the atlas has no consumer until `4-4`. `4-0b`'s meter governs GPU page generation, not the CPU worker pool, so it does not fix the hitching a pilot feels today either. The gate's payoff is that it makes 4B — one gate later, not five — the phase's best moment.
- **4B — the light that describes shape.** *Visible, and this is the phase's best single moment:* **ridges cast real shadows across valleys at 40 km**, where the CSM has never reached. Consumed by the Phase 3 surface plugin through D4's slot lane, on the CPU tile meshes, before the quadtree exists.
- **4C — the quadtree.** *Visible:* L0 texel spacing 8 m → 2 m, LOD popping gone, skirt lines off ridge silhouettes, one draw call.
- **4D — identity and retirement.** *Visible:* material identity stops being a coin flip between distant vertices; treelines follow altitude and aspect with a ragged edge; the snowline migrates with the calendar.

### 6.3 Week ledger — 4.5 productive days per week

| Week | Days | Work | Cumulative |
|---|---|---|---|
| 1 | 0 → 4.5 | `4-8a` csm-resize (0.5) · `4-0` spine contract (2.0) · `4-0b` compute budget (2.0) | 4.50 |
| 2 | 4.5 → 9.0 | `4-1` wgsl kernel (4.5 of 5.5) | 9.00 |
| 3 | 9.0 → 13.5 | `4-1` finish (1.0) · `4-2` page atlas (3.5 of 4.5) | 13.50 |
| 4 | 13.5 → 18.0 | `4-2` finish (1.0) · `4-3` gpu-height-generate (3.0) → **Gate 4A closes, d17.5** · `4-7` start (0.5) | 18.00 |
| 5 | 18.0 → 22.5 | `4-7` page-occlusion-bake (4.5; done at d22.5) | 22.50 |
| 6 | 22.5 → 27.0 | `4-8b` csm-nearfield (1.5) → **Gate 4B closes, d24.0** · `4-4` vertex-displacement (3.0 of 4.0) | 27.00 |
| 7 | 27.0 → 31.5 | `4-4` finish (1.0) · `4-5` cdlod-quadtree (3.5 of 5.0) | 31.50 |
| 8 | 31.5 → 36.0 | `4-5` finish (1.5) → **Gate 4C closes, d33.0** · `4-6` start (3.0) | 36.00 |
| 9 | 36.0 → 40.5 | `4-6` classifier + splat atlas (4.5; 7.5 of 9.0 done) | 40.50 |
| 10 | 40.5 → 45.0 | `4-6` finish (1.5) · `4-6b` consumers + density field (1.5) · `4-9` retire CPU path (1.5) | 45.00 |
| 11 | 45.0 → 46.5 | `4-6b` finish (0.5) · `4-10` tier re-measure (1.0) → **Gate 4D / Phase 4 closes, d46.5** | 46.50 |

`4-6` is the largest item at 9.0 days and it sits last, where a slip has nowhere to propagate. That is deliberate — see §12 R-4E for its cut line, which `4-6b` (D12) makes meaningful by keeping the consumers contract out of it.

---

## 7. Gate 4A — The kernel and the atlas (17.5 d)

**Branch:** `phase4/gate-4a`.

### `4-8a` — CSM resize (0.5 d) · Class D

Profile table only, **tiers 2 and 3 only**: `shadowMapSize` 4096 → 2048. Cascade count and distance unchanged. Refunds 236 MiB at tier 2, 240 at tier 3, making `npm test` green before Phase 4 allocates anything (§3.2).

Delete this item's diff in the same commit as `4-8b`. Record in the decision log that tier 1 was deliberately not cut.

### `4-0` — Terrain spine contract (2.0 d) · Class P

§5 is the specification. Seven ownership rows plus two reserved-to-live flips, five profile fields, three estimator rows, one frame-budget row and its phased funding cut, the slot key and season residency rule, the node record layout, the parity criterion form, and the supported world radius.

**Gate:** `tests/render.webgpu-terrain-spine.test.ts` — `texelSizeMeters(level)` takes no tier argument; `heightAtlasMiB` / `channelAtlasMiB` / `heightPyramidMiB` move when their inputs move; `cdlodNodeBudget` and `cdlodPixelThreshold` are monotone in tier; `channelAtlasMiB` reflects `SEASON_BUCKETS_RESIDENT = 2`.

### `4-0b` — Shared compute budget (2.0 d) · Class P — `6-10` moved

`src/render/webgpu/core/ComputeBudget.ts`. One per-frame millisecond meter with four client rows (`terrainCompute`, `splatCompute`, `occlusionCompute`, `erosionCompute` reserved for `5-4`), admission in priority order under one cap, and **Governor B rung 0**: shrink the total compute budget before any visible lever moves.

**`R-11` (the governor repair) is a hard precondition of this item, not merely of Gate 2Z.** Today, with `resolutionInsensitive` latched — which at tier 1 on the reference display is the *default* state, because the pixel cap binds — Governor B decrements `cpuWorkLevel` whenever `cpuP95 < 6 ms`, recovering GPU-cost rungs while the frame is GPU-bound. Phase 4 adds four more GPU-costed rungs to that ladder.

**Gate:** `tests/render.webgpu-compute-budget.test.ts` over synthetic traces — four clients over-requesting in one frame are admitted in priority order under one cap; rung 0 fires before any visible lever; no work step is recovered while `classification === 'gpu-bound'`.

### `4-1` — The WGSL height kernel (5.5 d) · Class K

`src/render/webgpu/terrain/TerrainKernel.ts`, following the `nature/ShaderModule.ts` pattern. **Height chain only** (D5): 4 integer hash functions, 13 float functions in `noise.ts`, `sampleGeologicalRelief`, `sampleNaturalTerrainHeight` — ~250 statements.

Six rules, each from §3.4:

1. **Split-origin lattice addressing.** The GPU never holds a large absolute coordinate. Per octave, the CPU computes the wrapped origin in f64 and passes `(cellInteger: i32, cellFraction: f32)`; the GPU forms `cell = cellInteger + floor(cellFraction + local)` and `t = fract(cellFraction + local)`, both exact. This is what the naive-f32 measurements in §3.4 are the argument *for*, not against — the parity harness must prove it rather than assume it.
2. **Hand-write `kLerp`, `kSmoothstep`, `kRound`.** Forbid `mix(`, `smoothstep(` and `round(` in the include with a Node-side string assertion.
3. **Inject the eleven expectation constants** from one frozen TS object, template-substituted, with a test asserting each value appears in the emitted WGSL. `filterWidth ∈ {128, 512}` are mandatory rows of the parity probe — at `filterWidth = 0` `blendTowardExpectation` short-circuits and a wrong constant is invisible.
4. **Hoist the band-limit weights** to the page uniform (§5.6).
5. **Port `wrapLatticeCoordinate` verbatim** as `floor(v/P + 0.5)`. Four lines, and it keeps the include a literal transliteration rather than one carrying an undocumented domain assumption.
6. **Port `geology.ts`'s `land <= 0.0001` early-out verbatim.** It is the only genuine f32/f64 cliff in the chain, bounded at ~10 mm because every returned term is proportional to `land`. Document the bound in the include header; do not smooth it — that changes shipped terrain.

**Gate:** `tests/gpu/terrain-height-parity.test.ts`, the four criteria of D6. The harness can be **storage-buffer-only** — `tests/gpu/aerial-perspective-agreement.test.ts` already proves that pattern — so `4-1` does not block on P2.

### `4-2` — The page atlas (4.5 d) · Class P

`src/render/webgpu/terrain/TerrainPageAtlas.ts`. One r32float texture per tier at §5.2's derived sizes, 264² slots. Reuses `WorldPageLifecycle`, `calculateWorldPageStreamingPriority` and `compareWorldPageCacheEvictionOrder` **verbatim** (P5); surplus slots *are* the LRU cache.

Indirection is a `uniform array<vec4f, 256>` of `(slotU, slotV, originX, originZ)` plus a parallel array of `(texelSize, minH, maxH, maxDeviationFromParent)`. The node passes its slot index as a thin-instance attribute (§5.6), so no indirection fetch is needed in the vertex shader.

**This item exercises the asynchronous upload half of `WorldPageLifecycle` for the first time** — `uploading` with real GPU latency, and `evicting → resident` cancellation. `ARCHITECTURE.md`'s `0-3` decision-log entry records that half as untested until now.

**It is not free, and the state machine does not fit as-is.** `beginUpload()` calls `requireState("cpu-ready")`, and a GPU-generated page never passes through `cpu-ready` — there is no CPU payload. The change, enumerated so it is not rediscovered mid-item: add `"generating"` to `WORLD_PAGE_LIFECYCLE_STATES`; extend `WORLD_PAGE_ALLOWED_TRANSITIONS` with `queued: [… "generating"]` and `generating: ["resident", "unloaded", "failed"]`; add `beginGeneration()` / `markGenerated()`; widen `cancelOperation` to accept a generating token. Do **not** widen `beginUpload` — the CPU path still uses it until `4-4`.

Three existing transitions have **never executed** and need named tests: `cancelEviction()` (zero call sites), `cancelOperation(token, true)` (the retention path, never called with `true`), and a completion rejected after a competing `queue()` bumps the epoch.

**`4-2` owns writing the `atlasSlot` lane, and this is what makes Gate 4B visible.** The slot index is not a build-time constant — it changes whenever the LRU re-admits or re-homes a page, and it is `-1` until the page has a slot. So: make the CPU tile path's colour vertex buffer **updatable**, own a per-page slot-lane rewrite driven by atlas residency changes, and state the co-residency rule — **a CPU tile mesh samples channel pages only while its page holds a slot; otherwise it falls back to the Phase 3 provisional path.** Without this sub-step nothing writes the lane Phase 3 reserved (§4 D4), `4-7`'s bake has no consumer, and `4-8b` cannot shorten the shadow distance. This is the +0.5 d over the source estimate.

**Also in `4-2`, and it is not optional:** wire `TerrainCollisionMirror.publishPage` for real, and make `fallbackSampleCount` a mutable counter. Both are inert declarations today (`publishPage` has zero call sites; `fallbackSampleCount` is a `readonly 0`). Wiring them here is what makes `ARCHITECTURE.md`'s *"must stay 0 below 500 m AGL"* a falsifiable assertion **before** `5-2` depends on it, and it is what makes `5-2` the one-file change §1.3 promises rather than new plumbing.

### `4-3` — GPU height generation (3.0 d) · Class P

Compute generation, 8×8 workgroups, `ComputeShader` objects created **once** with uniforms rebound per page. Second dispatch: parallel min/max reduction for the CDLOD AABB.

**L0 is excluded from supersampling** — the offset table is `level == 0 ? [(0,0)] : RGSS4`, asserted by a WGSL golden test and by the L0 parity gate (§3.5). The measured justification (max 981 mm residual, >100 mm at 0.43% of texels) goes in the decision log so nobody re-enables it as a "quality improvement".

The page stores the **airport-flattened** height — the CDLOD min/max AABB must be correct over the airport, and `4-9` needs the earthworks in the page. `4-1`'s parity oracle stays `sampleNaturalTerrainHeight`, so a `4-9` regression cannot masquerade as a `4-1` one.

Budget row from the measured ALU cost: 34 `valueNoise2D` = 306 `avalanche` = 612 u32 multiplies per sample; ~8.5×10⁷ `avalanche` per 264² page at 4× supersampling. Admission goes through `4-0b`'s meter.

**Gate 4A exit.** Debug overlay shows atlas residency and generated height. Kernel parity: all four criteria of D6 green. Page generation admitted under one millisecond cap. `npm test` green at all four tiers.

---

## 8. Gate 4B — The light that describes shape (6.5 d)

**Branch:** `phase4/gate-4b`. This gate is where the phase stops being invisible.

### `4-7` — Page occlusion bake (5.0 d) · Class P

One bake, one owner, one format — four subsystem designs baked this four ways at three resolutions. Sky visibility in the GTAO horizon-arc form, bent normal, and an 8-azimuth horizon map on the **canonical 136² channel core** (§5.2 — a 68² page would be a second channel geometry).

16 azimuths × 24 steps, marching a **coarse global height pyramid** beyond the page (512 m/texel over 128 km, 256² r32float = 0.25 MiB) so there is no shadow discontinuity at page edges.

**Its consumer is the Phase 3 surface plugin, on the CPU tile meshes**, through D4's `atlasSlot` lane and `4-2`'s indirection array. That is what makes this gate visible before the quadtree exists.

### `4-8b` — CSM near field (1.5 d) · Class P

§5.3's rows: 2×1024@900 m / 3×1280@1400 m / 3×1536@1800 m / 4×2048@2400 m. **`FILTER_PCF`, not PCSS** (§3.7, D10) — PCSS needs the colour attachment `1A-5` deleted, and buying it back costs more than it is worth here.

**Terrain leaves the *far* field, not the caster list.** `RENDERING_PLAN.md` says terrain "leaves the caster list entirely"; taken literally that contradicts `4-5`, which stands caster meshes up. The correct statement: inside the shortened cascades terrain still casts, through D11's per-cascade caster meshes; beyond `shadowDistance` the horizon map is the authority and there is nothing to cast into. Before `4-5` lands, the existing per-mesh caster filtering still works and should be left alone.

Restores `msaaSamples: 4` at tier 2 — which costs 54.9 MiB raw there, more than this item's shadow refund (§4 D3). Deletes `4-8a`'s diff.

**Gate 4B exit.** A 3,000 m ridge shadows the valley behind it at 40 km. Shadow render list contains zero terrain nodes. `occlusionCompute` row live and under cap. Memory legal at all four tiers (D3 table).

---

## 9. Gate 4C — The quadtree (9.0 d)

**Branch:** `phase4/gate-4c`.

### `4-4` — Vertex displacement (4.0 d) · Class P

Vertex-texture displacement in **`CUSTOM_VERTEX_UPDATE_POSITION`**, fragment-computed normals by central difference on the page's own texel grid. **Manual bilinear via 4 `textureLoad`s** (§3.6).

**The hook choice is load-bearing, not stylistic.** `pbr.vertex.js:196` assigns `vertexOutputs.vPositionW = worldPos.xyz` and `:199-213` computes `vNormalW`, both **before** the `CUSTOM_VERTEX_UPDATE_WORLDPOS` marker at `:218`. Displacing there moves the rasterised geometry but leaves `vPositionW` at the undisplaced height — and `vPositionW` is what the aerial-perspective include, the cloud-shadow plugin and the triplanar projection all read. The symptom is haze and cloud shadows that sit at the wrong altitude on every slope, which reads as a lighting bug. Displace at `UPDATE_POSITION` and reconstruct world XZ from `vertexInputs.world0..world3` there.

**The `ShadowDepthWrapper` is constructed inside the terrain material factory, before the material's first effect compiles** (D7), with `tests/gpu/terrain-shadow-depth-wrapper.test.ts` asserting the real material's shadow-map effect carries the displacement include. The failure mode is silent and visually plausible; a CPU test cannot see it.

**Retires the CPU terrain worker path:** `TerrainGenerationClient.ts`, `terrain.worker.ts`, `terrainProtocol.ts`. **`terrainQueue.ts` is kept** — `RENDERING_PLAN.md:340` lists it, but `BoundedTerrainQueue` is the *vegetation* worker's queue (§3.9). Rename it `BoundedPriorityQueue` in a separate rename-only commit and give it an `owners.ts` row under vegetation.

**Four HUD fields die with the worker pool.** `terrainWorkersBusy`, `pendingTerrainPages`, `residentTerrainPages` and `terrainTiles` are required fields of `RenderDiagnostics`, rendered by `Hud.tsx` and asserted in `tests/hud.ui.test.ts`. Replace them in this commit with GPU-page equivalents — resident slots, slots pending generation, compute dispatches in flight — keeping the field names where the semantics survive, and re-gate `perf:capture`'s readiness check on the new residency signal in `4-10`.

**Invariant handling, as a blocking checklist item** (§3.5): `generateTerrainTile` loses its last production consumers here. Do not move invariant test 3 into `tests/gpu/` — `npm run verify` does not run that project, so a move deletes the invariant from CI. **Duplicate it:** a Node-side oracle test in `tests/sim.terrain-authority.test.ts` against `4-1`'s TypeScript mirror, and `tests/gpu/terrain-physics-parity.test.ts` against a height-atlas readback at the D6 criterion-4 bound.

### `4-5` — CDLOD quadtree (5.0 d) · Class P

Split when `maxDeviationFromParent × pixelsPerMeter(distance3D) > τ`. One 33×33 unit grid `Mesh` (2,048 triangles), instanced through a 16-float world-matrix buffer **plus two stride-4 custom attributes** (§3.1, §3.8 — the single stride-8 call in `RENDERING_PLAN.md` §3.1 throws, and custom attributes alone set no instance count).

Geomorph: `morphK` is computed **on the CPU against the beauty camera** (§5.6) and read from the instance attribute. The vertex shader snaps the grid position to the parent's even-vertex lattice, then `mix`es position and height by that `morphK`. At `morphK = 1` the fine node's edge is exactly the parent's edge, so **cracks close analytically** — which is what lets skirts be deleted, which is what lets `backFaceCulling = true`.

Deletes `TERRAIN_SKIRT_DEPTH_METERS`, `buildTerrainIndicesWithSkirt`, `terrainRings`, `terrainTileResolution`, and the `terrainGeometryMiB` estimator row with `TERRAIN_VERTEX_BYTES` / `terrainPagesAtLevel` / `terrainPageBytes`. Sets `backFaceCulling = true` (it is `false` today at `TerrainClipmapSystem.ts:330`, for the skirts).

**The caster meshes** (D11) are stood up here, not in `4-8b`: **one per cascade**, each sharing this geometry, each with `layerMask = 0` and `metadata.excludePlanarReflection = true`, each buffer written exactly once per frame. Not one mesh mutated per cascade — see D11 for why that silently renders one subset into all cascades. This is also what preserves Governor B's shadow-caster-distance lever, which the 151 → 1 mesh collapse would otherwise delete.

**Carry the provisional splat across the gate.** `4-5` deletes the CPU tile meshes, and with them the per-vertex `(materialIdA, materialIdB, weightB)` lanes that are the *only* material source until `4-6` lands ten working days later. Without a carry-forward, Gate 4C ships an untextured PBR surface — it deletes the entire Phase 3 deliverable and breaks §2.0's "no gate leaves the sim worse" in the gate the plan calls its most visible. **The node record carries the two-material blend per node**, sampled from a provisional splat channel `4-3` writes into the channel atlas at page-generation time. `4-6` then replaces that channel with the real classifier output and the node lanes go away. This is also what makes `R-4E`'s cut line real: if `4-6` slips, the phase still ships a textured surface.

**Gate 4C exit.** Terrain draw calls ≤ 12. Terrain vertex/index buffers ≤ 3 MiB. No crack, no skirt line, no pop across a full descent from 10,000 ft to touchdown. Both physics-parity tests green.

---

## 10. Gate 4D — Identity and retirement (13.5 d)

**Branch:** `phase4/gate-4d`.

### `4-6` — WGSL classifier + page splat atlas (9.0 d) · Class P

Ten smooth suitability functions, softmaxed, top-4 renormalised, replacing `classifyBiome`'s threshold cascade. Inherits `SurfaceMaterial` from Phase 3's `3-0` rather than defining its own enum — that is why `3-0` landed early.

Now also carries **the climate chain port** (D5): `sampleTerrainMoisture`, `sampleTerrainClimate`, `terrainTemperatureFromClimate`, with `R-13`'s `seasonalTemperatureOffsetK` already in the signature.

`dayOfYear` is in the signature from the first line — the seasonal-family boundary test already reserves `terrain/LandCoverClassifier.ts` with `plannedBy: "4-6"` and will fail the build if it appears without an environment-clock reference.

**Supersample 2×2 per texel and average the weight vectors, not the argmax.** This is the prefiltering per-vertex point classification structurally cannot do, and it is the albedo analogue of band-limiting.

**Perturb the drivers, not the outputs**, and jitter the softmax temperature itself so ecotone *sharpness* varies — uniform-sharpness boundaries are as much a tell as straight ones.

`R-27`'s consumers contract and the `densityField` port are **`4-6b`** (D12), not this item — `4-6` at 9.0 d already carries the classifier, the splat atlas and the climate chain, and burying a fourth deliverable in the phase's largest item is how it slips.

### `4-6b` — Classification consumers + filtered density field (2.0 d) · Class P

D12. Threads `filterWidthMeters` through `densityField`, ports it as one shared WGSL include with an `owners.ts` row, and rewires `chooseTreeSpecies`, `chooseShrubSpecies` and the wildlife habitat rules onto the classifier's weight vector. After this commit one authority classifies the ground, the trees on it and the animals in them.

**Also here (+0.5 d, 1.5 → 2.0):** `densityField` returns a **ground-cover archetype weight vector** — grass / fern / heather / reed / clutter — alongside its stem densities, computed from terms the field already carries (moisture, slope, shade, exposure). `2-16` consumes it instead of a flat 15% roll, so a wet hollow and a wind-scoured ridge read as different places rather than the same ground at different densities. This is the field half of `PHASE_2_EXECUTION_PLAN.md` §4 B8 amendment 7.

### `4-9` — Retire the CPU terrain path + earthworks in WGSL (1.5 d) · Class K

Ports `3-8`'s `runwayEarthworksHeight` into the WGSL include. **`3-9` already owns the WGSL airport SDF** — `PHASE_3_EXECUTION_PLAN.md` decision C7 transliterates `roundedRectangleSignedDistance` as a verified port. `4-9` **consumes** it; it does not write a second one, and an `owners.ts` row makes a second impossible.

**The CPU collision fast path stays analytic** — one evaluation, no noise — and `sinHeading`/`cosHeading` are hoisted into the page uniform as f64-computed constants. WGSL specifies `sin`/`cos` to an *absolute* error bound, not a relative one, so recomputing the heading rotation per texel on the GPU is the single largest divergence source in this item; hoisting removes it.

Note the two physics entry points take **different** short-circuits: `sampleTerrainCollisionHeight` short-circuits on `getAirportInfluence >= 1` (the full graded platform), while the render path evaluates the fade. The parity grid must cover both regimes, not just the apron.

`tests/gpu/runway-earthworks-parity.test.ts`: dispatch the include over a dense grid covering the paved rectangle, the shoulder band, the whole `terrainBlendDistance` fade and 20 m beyond, read back, assert agreement at 1 mm.

Deletes `generateTerrainTile` and test 3's old form together, so no test can pass against a dead render path.

### `4-10` — Tier re-measure (1.0 d) · Class P

`6-11` minus the four-tier redesign. Re-measure every tier row against the phase's actual workload and commit the numbers.

Adds to `perf:capture`, on top of Gate 2Z's scenes:
- a **page-thrash** scenario — a 180° banked turn at 500 ft forcing sustained L0 admission — asserting hitch count and a ceiling on peak `residentTerrainPages` / `pendingTerrainPages`;
- a **CDLOD-transition** scenario across a level boundary, so geomorph popping has a number;
- the **reference viewport** (1512×982 @ DPR 2), where the tier-1 pixel cap binds and Governor A is dead. Every G-C threshold binds here; the existing 720p shots are retained only for SSIM continuity.

**Gate 4D exit.** Cross-level consistency: a level-N page's splat weights equal the box average of the four level-(N−1) pages beneath it to within quantisation. Season scrub across a bucket boundary shows no re-bake and no visible seam. Committed tier table measured, not asserted from 2026 estimates.

---

## 11. Verification

### 11.1 Assertions Phase 4 adds (68–86; Phase 3 ends at 67)

| # | Assertion | Where | Instrument |
|---|---|---|---|
| 68 | `texelSizeMeters(level)` is tier-independent | `render.webgpu-terrain-spine` | — |
| 69 | Atlas MiB rows move with their inputs; `SEASON_BUCKETS_RESIDENT = 2` is reflected | `render.webgpu-terrain-spine` | — |
| 70 | Frame budget sums under target at all four tiers with `occlusionCompute` live | `render.webgpu-budget` | — |
| 70a | `validateWorldPageLayout(WORLD_PAGE_LAYOUT)` returns no issues | `world.page-geometry` | — |
| 70b | Season blend over all 365 days: `lo,hi ∈ [0,23]`, `hi === (lo+1) % 24`, continuous across the year boundary | `render.webgpu-terrain-spine` | — |
| 70c | Every atlas dimension and per-stage sampled-binding count is under `REQUIRED_WEBGPU_LIMITS` | `render.webgpu-core` | — |
| 71 | Four clients over-requesting are admitted in priority order under one cap | `render.webgpu-compute-budget` | — |
| 72 | No work rung recovers while `classification === 'gpu-bound'` | `render.webgpu-governor` | — |
| 73 | Hash layer bit-equal CPU↔GPU at all \|x\| | `gpu/terrain-height-parity` | P2 |
| 74 | \|Δh\| < 0.05 m over **≥40,000 points** × 5 filter widths within **±10⁴ m** | `gpu/terrain-height-parity` | P2 |
| 75 | \|Δh\| < 0.25 m within ±10⁵ m; slope-relative bound beyond | `gpu/terrain-height-parity` | P2 |
| 76 | `\|h_atlas(L0) − h_physics\| ≤ 1 mm` within ±10⁴ m, and normals agree at L0 | `gpu/terrain-physics-parity` | P2 |
| 77 | Node-side oracle: TS mirror at L0 texel centres equals `sampleGroundHeight` | `sim.terrain-authority` | — |
| 78 | The WGSL include contains no `mix(`, `smoothstep(`, `round(` | `render.webgpu-terrain-kernel` | — |
| 79 | All eleven expectation constants appear in the emitted WGSL | `render.webgpu-terrain-kernel` | — |
| 80 | L0 supersample offset table has exactly one entry | `gpu/terrain-height-generate` | P2 |
| 81 | Real terrain material's shadow effect carries the displacement include | `gpu/terrain-shadow-depth-wrapper` | P2 |
| 82 | Runway earthworks CPU↔GPU within 1 mm across apron, shoulder and fade | `gpu/runway-earthworks-parity` | P2 |
| 83 | Shadow caster list contains only the caster mesh; beauty mesh is absent from it | `render.webgpu-terrain-clipmap` | — |
| 83a | `morphK` is never derived from camera state inside the terrain vertex shader (string assertion) | `render.webgpu-terrain-kernel` | — |
| 83b | `vPositionW` equals the displaced height (fragment-stage readback at a known slope) | `gpu/terrain-displacement` | P2 |
| 84 | Terrain draw calls ≤ 12; terrain buffers ≤ 3 MiB | `perf:capture` | Z-1 |
| 84a | Page-thrash turn: frames exceeding 2× the median ≤ 2% at tier 1 | `perf:capture` | — |
| 84b | Peak `pendingTerrainPages` ≤ 24 through the page-thrash turn | `perf:capture` | — |
| 84c | \|estimated − actual\| GPU memory within 15% (re-pins the 1.15 fudge) | `perf:capture` | Z-4 |
| 85 | Splat weights at level N equal the box average of level N−1 within quantisation | `gpu/terrain-splat-consistency` | P2 |
| 86 | `collisionSamplesServedByFallback` stays 0 below 500 m AGL over a full profile | `sim.flight` | — |

### 11.2 What cannot be asserted, and what replaces assertions

Three of this phase's outcomes are irreducibly visual: *no popping*, *ridges shadow valleys*, and *material identity stops being a coin flip*. There is no test for them.

What replaces a test is a **named flight and a committed capture**, treated exactly as the terrain baselines are: a change is a regression until argued otherwise.

1. **Full descent, 10,000 ft to touchdown, fixed seed** — the LOD-transition gate. Flown, recorded.
2. **Cruise at 8,000 ft over a mountain range, low sun** — the horizon-map gate.
3. **Season scrub across a bucket boundary at 1,500 ft over mixed cover** — the `4-6` cross-fade gate.

### 11.3 The instrument dependency, stated once

**Every millisecond and pixel criterion above is unfalsifiable until Gate 2Z lands.** `gpuFrameMsP95` is `null` in all three committed shots because `updateGovernor` resets `gpuFrameDurations` every 120-frame window and requires 8 fresh samples within 30; the capture asserts only `meanLuminance > 0.01` and SSIM ≥ 0.985; and `fps` is a `setTimeout`-yield rate, not a frame rate. Where an instrument still will not exist at Phase 4's close, the criterion in §13 is phrased against a quantity that *is* measurable, and says so.

**Amended 2026-08-19:** satisfied as of Phase 2's close — Z-2 landed, and `gpuFrameMsP95` is non-null in all 13 committed baseline shots (verified 2026-08-19). The paragraph above records the position when this plan was written.

---

## 12. Risk register

| ID | Risk | Trigger | Response |
|---|---|---|---|
| **R-4A** | **`4-1` parity does not close at ±10⁵ m** even with split-origin addressing. | Week 2. | The measured naive-f32 headroom is **11× at ±10⁴ m** (4.5 mm against a 50 mm bound) and **4.2× at ±10⁵ m** against D6's 0.25 m bound, and split-origin removes the dominant term, so the margin is real. If it still fails, the fallback is to shrink the *criterion radius*, not the criterion — record the achieved radius in `4-0`'s contract and gate `4-3` on it. Do not relax the bound; the bound is what §1.3 rests on. |
| **R-4B** | **The atlas cannot be both a storage texture and a sampled texture in one frame** without a Babylon-managed transition. | `4-2`, week 3. | Verified achievable at the WebGPU level by the P2 probe (`STORAGE_BINDING \| TEXTURE_BINDING \| COPY_SRC`). The risk is Babylon's own usage-flag bookkeeping. Startup capability assertion in `RenderInvariants.ts`; documented fallback is a ping-pong pair with a copy, costing one atlas of memory at the tier that needs it. |
| **R-4C** | **`4-5`'s geomorph does not close cracks**, and skirts cannot be deleted. | `4-5`, week 7. | Crack closure is analytic, not tuned: at `morphK = 1` the child's edge vertices are the parent's by construction. If cracks appear, the bug is in the snap lattice, not the concept. Do not re-add skirts — assert the edge-vertex equality directly in a unit test over the snap function before debugging visually. |
| **R-4D** | **The `ShadowDepthWrapper` is attached late and fails silently.** | `4-4`. | Assertion 81 against the real material, plus the factory sub-step (D7). This is the only failure mode in the phase that is both invisible to CPU tests and visually plausible. |
| **R-4E** | **`4-6` slips.** Largest item, last position, and it carries the climate chain the plan moved into it. | End of week 9. | **The phase's designated cut, and `4-5`'s carry-forward is what makes it survivable.** Ship the classifier and splat atlas at tiers 1–3 and leave tier 0 on the provisional two-material path, which §5.3's height-blend cap of 2 already makes the Low-tier path. Second cut: `4-6b` defers to Phase 6 alongside `6-6`. Third: the seasonal snow-pack term, whose absence is a missing feature rather than a broken one — but **not** the `dayOfYear` signature, which must land regardless. Because `4-5` carries a provisional splat channel, none of these cuts leaves the terrain untextured. |
| **R-4F** | **Memory closes on paper and not on the machine.** The estimator carries a 1.15 fudge factor calibrated once, in 2026-08. | Any gate. | `4-10` re-pins it. Until then, `perf:capture` reports `estimatedGpuMemoryMiB` every run; re-pin whenever \|estimate − actual\| exceeds 15%, as the constant's own docstring already requires. |
| **R-4G** | **Tier 2 spends most of the phase visibly worse** because `4-8a` halves its shadow map. | Weeks 1–6. | Accepted, bounded and reversed at `4-8b`. It is per-tier deliberately: tier 1 — the tier G-C names — is untouched. If tier 2's softening is judged unacceptable at review, the alternative is holding `materialArrayEdge` at 256 through Phase 3, which is a worse trade for the same memory. |
| **R-4H** | **`5-2` turns out not to be a one-file change** despite `ARCHITECTURE.md`'s promise. | Phase 5. | Mitigated inside `4-2`: `publishPage` and `fallbackSampleCount` are wired for real in Phase 4, so `5-2` swaps an authority rather than building plumbing. Assertion 86 makes the promise falsifiable a phase early. |

---

## 13. Exit checklist

**Ticked against the implementation branch on 2026-08-20.** `[x]` means the
tree carries it and a test or a measurement says so; `[ ]` means it does not,
and each unticked box says why and where it is carried forward.

**Gate 4A — The kernel and the atlas**
- [x] `npm test` green at all four tiers with `materialArraysMiB` live (P1 was never breached — §4 D13; `4-8a` still landed, for Phase 4's own allocations).
- [x] Seven ownership rows added (`terrain-spine-contract`, `amortised-compute-meter`, `terrain-height-kernel-wgsl`, `terrain-debug-overlay`, `global-height-pyramid`, `page-occlusion-bake`, `cdlod-quadtree`) and three reserved rows flipped to live (`terrain-page-atlas`, `land-cover-classification`, `vegetation-density-field-wgsl`); boundary test passes.
- [x] `texelSizeMeters` is tier-independent (asserted on its arity, not just its values); §5.3's Ultra 1 m row deleted from `RENDERING_PLAN.md`.
- [x] `validateWorldPageLayout(WORLD_PAGE_LAYOUT)` returns no issues; the season blend is cyclic and tested over all 365 days at quarter-day resolution.
- [x] `REQUIRED_WEBGPU_LIMITS` asserted at startup — and the limit map it reads was **empty until this item** (decision log). Per-stage sampled-binding count enumerated (14 fragment, 1 vertex) and under the cap.
- [x] `payload.ts` carries one channel enumeration with both encodings (`WORLD_PAGE_GPU_CHANNELS` beside the `Quantized*Page` transfer types).
- [x] Kernel parity: hash layer bit-equal (`toBe`); 3.78 mm at ±10⁴ m over 40,960 points; 3.44 mm at ±10⁵ m; **2.37 mm at ±2.8×10⁶ m**. Achieved radius recorded in the contract as `TERRAIN_SUPPORTED_WORLD_RADIUS_METERS = 2_800_000` (§4 D16).
- [x] The WGSL include contains no `mix(`, `smoothstep(` or `round(`, and all eleven expectation constants — each imported from the module that owns it, not retyped.
- [x] Height pages generate on the GPU; L0 supersample table has exactly one entry.
- [x] Page admission runs through one millisecond meter; Governor B rung 0 exists, fires first, and is two notches (§4 D15).
- [x] `WorldPageLifecycle`'s asynchronous half is exercised — a page is resident only once its bounds readback resolves — and the three never-executed transitions have named tests.
- [x] `TerrainCollisionMirror.publishPage` has a real ring, a real query path and a real miss counter; `src/sim/terrainGrid.ts` carries the one-line seam `5-2` swaps a producer into.
- [x] False-colour atlas/residency overlay exists (`TerrainDebugOverlay`, four modes) and is bound to a debug key (Backquote).

**Gate 4B — The light that describes shape**
- [x] Sky visibility, bent normal and the 8-azimuth horizon map bake into 136² channel pages under one cap.
- [x] The Phase 3 surface plugin samples them through `3-2`'s `atlasSlot` lane, which `4-2` writes from channel-atlas residency.
- [ ] **A ridge shadows the valley behind it at 40 km (flown, recorded).** Not flown: §11.2's three named flights are a human deliverable and this phase produced no capture. The MEASURABLE half is in `tests/gpu/terrain-occlusion-bake.test.ts` — sky visibility varies 238–255 over a 270 m relief page, and the horizon map carries non-degenerate angles. Carried forward as Phase 5 work.
- [x] No shadow discontinuity at page edges — two independently baked adjacent pages agree to **14 / 255** across the shared edge, which is the global height pyramid doing its job.
- [x] Shadow filter is `FILTER_PCF` (PCSS struck); terrain casts inside the near field and the horizon map is the authority beyond; `msaaSamples: 4` restored at tier 2; `4-8a`'s diff deleted.
- [x] Memory legal at all four tiers at every commit in the gate (worst intermediate: tier 1 at 460.3 / 480 before `4-5` deletes the tile geometry).

**Gate 4C — The quadtree**
- [x] L0 texel spacing is 2 m and a node's quad IS that spacing, by construction (asserted for levels 0–9).
- [x] One 33×33 grid, a world-matrix buffer plus two stride-4 custom attributes; terrain draw calls are `1 + shadowCascades` (3–5), against the ceiling of 12.
- [x] The surface still has material identity across the whole gate — the provisional splat is carried per node (`packTerrainNodeSplat`), not dropped.
- [x] `morphK` comes from the CPU; asserted as a string check on the compiled SHADOW source, so beauty, cascade and reflection cannot disagree.
- [x] One caster mesh **per cascade**, each `layerMask = 0`, excluded from the planar reflection, each buffer written once per frame; Governor B's caster-distance lever still moves (asserted).
- [x] Displacement is at `CUSTOM_VERTEX_UPDATE_POSITION`.
- [ ] **`vPositionW` equals the displaced height (assertion 83b, fragment-stage readback at a known slope).** The HOOK is asserted — the displacement compiles into both the beauty and the shadow vertex sources — but the fragment-stage readback that would prove `vPositionW` followed it is not written. The property rests on the hook choice, which is documented and tested; the direct measurement is carried forward.
- [x] Skirts, `TERRAIN_SKIRT_DEPTH_METERS`, `terrainRings` and `terrainTileResolution` all deleted; `backFaceCulling = true`.
- [ ] **No crack, no skirt line, no pop over a full 10,000 ft → touchdown descent (flown, recorded).** Not flown; see Gate 4B. The analytic half is asserted: at `morphK = 1` the parent load is an exact texel by construction, which is what `R-4C` says to check before debugging visually.
- [x] `ShadowDepthWrapper` asserted against the real material, through the real factory, in the real order.
- [x] Both physics-parity tests green: assertion 77 in `tests/`, assertion 76 in `tests/gpu/` (0.056 mm height, 0.001° normal).
- [x] Terrain vertex/index buffers ≤ 3 MiB — one 33×33 grid is 4.5 KiB of vertices and 12 KiB of indices, shared by every mesh.

**Gate 4D — Identity and retirement**
- [x] Material identity is continuous between distant vertices: `classifyBiome`'s cascade is gone, and the classifier's suitabilities are asserted Lipschitz-continuous in every driver.
- [x] `dayOfYear` is in the classifier's signature; the snowline migrates; a season scrub re-bakes nothing (the bucket pair is a slot variant, not a page rebuild).
- [ ] **Cross-level splat consistency within quantisation (assertion 85).** Not asserted. `tests/gpu/terrain-splat-bake.test.ts` reads the baked page back and proves it is neither constant nor zeroed — which is the failure that actually shipped and was caught — but the level-N-vs-level-(N−1) box-average comparison is carried forward.
- [x] `R-27` settled: one classification authority for ground, trees and wildlife.
- [x] Runway earthworks CPU↔GPU within 1 mm — measured **0.298 mm** over 23,805 probes spanning platform, batter and untouched ground.
- [x] `generateTerrainTile` deleted with test 3's old form, in one commit.
- [x] `boundedPriorityQueue.ts` still exists (renamed from `terrainQueue.ts`, with an owner row under vegetation) and vegetation generation still works; HUD residency fields replaced, not dropped.
- [x] `collisionSamplesServedByFallback` is 0 below 500 m AGL — trivially, because the analytic kernel is still the authority, and now falsifiably, because the mirror counts.
- [ ] **Tier table re-measured and committed.** Not measured: the tier table is a machine-specific artifact and this phase invalidated every SSIM baseline in `tests/perf/baseline` (the three rebaselines the plan sanctions at `4-7`, `4-5` and `4-6` all happened). The two new scenes and their residency ceilings are landed as design intents; re-pin with `npm run perf:capture:rebaseline` on the reference machine.

**Phase**
- [x] Audit root cause #7 closed — screen-space-error LOD with geomorphing, replacing hand-placed rings.
- [x] Audit root cause #10 closed outright — the CPU generation path is deleted, not mitigated.
- [x] `npm run verify` green (lint, typecheck, 610 tests, both builds); `npm run test:gpu` green (39 tests across 23 files).
- [ ] Baseline churned at the three sanctioned points — the churn happened; the RE-BASELINE has not been taken (see the tier-table box).
- [x] Decision log complete, with the measurement each row asked for.
- [x] `RENDERING_PLAN.md` §5.2/§5.3/§5.4 updated to the shipped tables (not to measured tier rows — see the tier-table box).

## 14. Decision log

| Date | Item | Decision | Measurement / rationale |
|---|---|---|---|
| 2026-08-20 | `4-0` | Season bucket on the **slot key**, not the page key; two buckets resident, cross-faded | Measured `channelAtlasMiB` at tier 1: **96.8 MiB** (1904² × 28 B), of which 55.3 MiB is the two splat buckets. Tier 1 ends the phase at **406.7 / 480 — 15% headroom**; a third resident bucket would cost 27.7 MiB more and buy nothing, because the cross-fade needs exactly two |
| 2026-08-20 | `4-0` | `finestResidentLevel` replaces §5.3's per-tier L0 texel row | Texel size is `512/256 · 2^L` by the normative page geometry; a tier-dependent value forks the §1.3 authority. `terrainTexelSizeMeters` takes one argument and a test asserts its arity |
| 2026-08-20 | `4-0` | No `float32-filterable`; manual 4-tap `textureLoad` | Adapter reports it (probe: `float32-filterable=true`, `maxTextureDimension2D=16384`); the device runs spec defaults. Geomorph wants exact texel values at snapped positions, and Babylon flips an r32float binding to `unfilterable-float` automatically when `textureFloatLinearFiltering` is false — so the decision is enforced by the engine, not just by convention |
| 2026-08-20 | `4-0` | `inspectWebGpuCapabilities` enumerated **no limits at all** | `Object.entries(adapter.limits)` returns nothing: `GPUSupportedLimits` keeps every limit as a prototype getter. The map had been empty since Phase 0 and nothing read it until `4-0`'s startup assertion, which would have been vacuous. Found by the P2 probe printing `undefined` for all ten |
| 2026-08-20 | `4-8a` | Tiers 2 and 3 only; tier 1 keeps its shadow configuration | Refund **192 MiB raw** at each of tiers 2 and 3 (4×4096² → 4×2048² at 4 B). Tier 1's measured headroom at Phase 3's close was 40% (288.7 / 480), so the cut was unnecessary there and §2.0's "no gate leaves the sim worse" wins |
| 2026-08-20 | `4-1` | Split-origin lattice addressing; band weights hoisted to the page uniform | Achieved parity is **radius-independent**: 3.78 mm at ±10⁴ m, 3.44 mm at ±10⁵ m, 2.37 mm at ±2.8×10⁶ m, over 40,960 / 12,960 / 3,840 points × five filter widths. Naive f32 over the same probe: 4.5 mm / 60 mm / 3.47 m. The radius is therefore set by the lattice wrap, not by precision (D16) |
| — | `4-1` | The realignment's `ridgedFbm2D` branch-cliff hazard is **refuted** | Branch B evaluates to branch A at `w = 1` and branch C at `w = 0`; the three-way switch is algebraically continuous |
| 2026-08-20 | `4-3` | L0 excluded from supersampling | Measured max residual 981 mm at a 2 m texel; >100 mm at 0.43% of 55,296 texels spanning ±100 km. Held: `terrainSupersampleOffsets(0)` has exactly one entry, asserted in both projects |
| 2026-08-20 | `4-3` | `maxDeviationFromParent` is the page's max **second difference**, not a re-evaluation at the parent's filter width | It is exactly the vertical error a parent's half-rate sampling makes at that texel — the numerator CDLOD's screen-space error needs — and it costs a one-texel workgroup apron rather than a second full kernel evaluation (34 more `valueNoise2D` calls per texel). Measured 0.135 m on an L0 page, 85.2 m at L4 |
| 2026-08-20 | `4-3` | Min/max/deviation reduce through **orderable-u32 atomics in the generation dispatch**, not a second dispatch | A workgroup reduction plus three atomics IS the parallel reduction the plan asks for, one pass earlier. Found while wiring it: `new StorageBuffer(engine, size, STORAGE\|READ)` drops WRITE, so `update()` silently does nothing and the atomics reduce against a zeroed buffer whose min slot decodes to NaN |
| — | `4-5` | Two stride-4 thin-instance attributes | A stride-8 custom kind resolves to `_size = 8` and throws `Invalid Format` — WebGPU has no `float32x8` |
| — | `4-8b` | PCSS struck; `FILTER_PCF` kept | PCSS needs the shadow map's colour attachment, which `1A-5` deleted for the phase's largest memory win |
| — | `4-5` | `morphK` computed on the CPU per frame, carried per instance | The same vertex shader serves beauty, N cascades and the reflection camera; an in-shader camera-relative morph makes them disagree |
| — | `4-4` | Displace at `CUSTOM_VERTEX_UPDATE_POSITION` | `vPositionW` and `vNormalW` are assigned before the `UPDATE_WORLDPOS` marker; the aerial-perspective and cloud-shadow consumers read `vPositionW` |
| — | `4-0` | Season cross-fade only while the clock is scrubbing; snap when static | Two resident buckets per *visible* page is the peak, not `atlas + 1`; snapping keeps steady-state flight at one |
| 2026-08-20 | `4-6` | Where `chooseTreeSpecies` / wildlife habitat read their classification from | `landCoverHabitat(classifyLandCover(...))` — one weight vector, five shares (canopy / open / scrub / barren / shore). `classifyBiome` is now a READING of the same vector rather than a second cascade, so the wildlife predicate reaches it through `sample.biome`. Recorded in `LandCoverClassifier.ts`'s `LandCoverHabitat` |
| 2026-08-20 | `4-6` | The ecology reads the classifier at the **reference day**; only the splat bake passes the real one | `dayOfYear` drives the SNOW weight, and snow is paint. Letting it move the dominant material flips forest to snow with the calendar and deletes every forest each winter — which `2-18` forbids in as many words. Caught by `world.season.test.ts` the moment the seasonal shift reached `classifyBiome` |
| — | `4-5` | One caster mesh **per cascade**, not one mutated per pass | Babylon records all cascades into one encoder and submits once (`webgpuEngine.pure.js:2341-2343`); a per-pass `writeBuffer` lands before execution, so every cascade would read the last write |
| — | `4-0` | Horizon map stays on the canonical 136² core | A 68² page is a second channel geometry — the rule §3.3 uses to strike the Ultra L0 row. The D3 table shows the 20.7 MiB is not needed |
| — | `4-0` | Both season buckets stay resident and cross-faded at all times | Snapping when static saves no memory (the atlas is sized for two either way) and quantises the snowline to 15-day steps exactly when the user is looking at it |
| 2026-08-20 | `4-10` | The reference viewport becomes the binding one for every G-C threshold | The tier-1 pixel cap binds there and Governor A is dead — the exact configuration G-C describes. The shot already existed from `Z-3`; `4-10` adds the page-thrash and CDLOD-transition scenes beside it |
| 2026-08-20 | `4-4` | The surface plugin is enabled by the **height atlas**, not only by `3-1`'s arrays | It was enabled solely by `setArrays`, which `3-1` calls after ~10 frames of one-material-per-frame synthesis. That cost ten frames of untextured ground before this phase; it would now have cost ten frames of FLAT ground, with the aircraft spawning inside a plane. A 1×1 placeholder array stands in — the `CloudShadowMaterialPlugin` pattern |
| 2026-08-20 | `4-5` | Babylon 9 tree-shakes the thin-instance API | Without `import "@babylonjs/core/Meshes/thinInstanceMesh"`, `thinInstanceSetBuffer` and `thinInstanceCount` are `undefined` rather than an error, and the one mesh that draws the ground draws nothing. Found by a probe after the caster meshes came back empty |
| 2026-08-20 | `4-6` | `surfaceMaterials.ts` imports `world/types.ts`, not the `@/src/world` barrel | Routing `classifyBiome` through the classifier made a cycle (barrel → `terrain.ts` → classifier → `surfaceMaterials` → barrel) that left `SurfaceMaterial` undefined at module-init and failed 30 test files at once. `types.ts` is a leaf and cannot cycle |
| 2026-08-20 | `4-7`/`4-9` | A kernel-page binding no live code READS disappears from the module's reflection | Tint prunes unreachable functions, so a shader that includes the kernel for its math helpers but never touches the page leaves Babylon's bind group carrying an entry the layout does not have — which invalidates the whole command buffer and writes zeros. Two tests hit it; both now keep the binding reachable with an explicit zero-weighted read, and `tests/gpu/terrain-compute-compile.test.ts` exists so a WGSL error is a one-second failure rather than an eight-minute `dispatchWhenReady` timeout |

---

## Appendix A — File manifest

**New (10):** `terrain/TerrainSpineContract.ts` (`4-0`) · `core/ComputeBudget.ts` (`4-0b`) · `terrain/TerrainKernel.ts` (`4-1`) · `terrain/TerrainPageAtlas.ts` (`4-2`) · `terrain/TerrainDebugOverlay.ts` (`4-3`) · `terrain/GlobalHeightPyramid.ts` (`4-7`) · `terrain/PageOcclusionBake.ts` (`4-7`) · `terrain/TerrainQuadtree.ts` (`4-5`) · `terrain/LandCoverClassifier.ts` (`4-6`) · `detail/densityFieldWgsl.ts` (`4-6b`). Every one has an `owners.ts` row in §5.5.

**Substantially modified (8):** `terrain/TerrainClipmapSystem.ts` (becomes the quadtree host, then loses the tile path) · `terrain/TerrainSurfacePlugin.ts` (occlusion + splat consumers, vertex displacement) · `terrain/TerrainCollisionMirror.ts` (producer side wired) · `core/QualityProfile.ts` (five fields added, two deleted) · `core/PerformanceBudget.ts` (three estimator rows, one frame row, one row deleted) · `core/AdaptiveGovernor.ts` (rung 0) · `world/payload.ts` (channel enumeration) · `src/render/FlightRenderer.ts`.

**Deleted:** `TerrainGenerationClient.ts` · `terrain.worker.ts` · `terrainProtocol.ts` · `generateTerrainTile` and `src/world/tile.ts`'s render path · `TERRAIN_SKIRT_DEPTH_METERS` and `buildTerrainIndicesWithSkirt` · `classifyBiome` · `terrainRings` · `terrainTileResolution` · `TERRAIN_VERTEX_BYTES` / `terrainPagesAtLevel` / `terrainPageBytes` and the `terrainGeometryMiB` row.

**Explicitly KEPT despite `RENDERING_PLAN.md:340`'s deletion list:** `src/workers/terrainQueue.ts` — `BoundedTerrainQueue` is the vegetation worker's queue (§3.9).

**Explicitly untouched in Phase 4:** erosion (Phase 5) · the channel graph and carved rivers (`5-9`, `5-12`) · `MAX_TERRAIN_HEIGHT` (raised at `5-8`) · `geology.ts`'s 35° fabric (replaced at `5-8`) · everything Gate A owns.

## Appendix B — Audit root causes and where they stand after Phase 4

| # | Root cause | Closes in | Status after Phase 4 |
|---|---|---|---|
| 1 | No surface material system | Phase 3 | Closed |
| 2 | Pointwise analytic height → erosion impossible | Phase 5 | **Enabled** — `4-2`'s atlas is the surface erosion writes into |
| 3 | Fixed 2 m shading normals | Phase 1 | Closed; `4-4` moves them to the page's own texel grid |
| 4 | No band-limiting | Phase 1 | Closed; `4-1` carries it to the GPU |
| 5 | No aerial perspective | Phase 1 | Closed |
| 6 | No indirect light | Phase 1 | Closed; `4-7` adds the baked half |
| 7 | No screen-space-error LOD, no geomorphing | **Phase 4** | **Closed** — `4-5` |
| 8 | No geometry below 43 m | Phase 5 | Open — `5-7` |
| 9 | No macro-geology; global 35° fabric | Phase 5 | Open — `5-8` |
| 10 | CPU: 181 evals/vertex, one worker | Phase 1 → **4** | **Closed outright** — the CPU generation path is deleted at `4-9` |
| 11 | Governor responds to CPU-bound frames | Phase 1 → **4** | **Closed** — `4-0b` adds rung 0, with `R-11` as its stated precondition |
| 12 | 64° vertical FOV | Phase 1 | Closed |

**Nine of twelve closed at Phase 4's exit.** The three that remain — #2, #8, #9 — are all terrain *shape*: no erosion, nothing below 43 m, no macro-geology.

**What the v1 cut line actually gives the user, stated plainly.** Against their own three goals: **G-A is substantially served for everything except terrain shape and water placement.** Clouds, sea surface, trees, foliage, ground material and the aircraft all look real; the *form* of the mountains is still a sum of noise rather than a landscape something happened to, and rivers and lakes are still the pre-Phase-5 ribbons pasted on slopes that have no channel. **G-B is served for sun path, ground cover, canopy and snowline; night is Gate 7A**, which the realignment moved to sit between Phases 2 and 3 *(amended 2026-08-19: Gate 7A shipped 2026-08-19 as Phase 2.5 — G-B's night component is delivered)*. **G-C has, for the first time, a measured tier table and a compute budget that is enforced rather than asserted** — but the flicker and hitch criteria are only as good as Gate 2Z's instruments. That is the honest position at ~203 days, and it is the last point at which stopping is defensible.
