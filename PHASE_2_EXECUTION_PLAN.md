# Phase 2 Execution Plan — Sky, Sea Surface and Living Ground

**Status:** execution reference for Phase 2 of `RENDERING_PLAN.md`. It does not restate that plan; it decides everything that plan leaves to implementation time, against the codebase as it will actually exist when Phase 2 starts.
**Runs after:** `PHASE_1_EXECUTION_PLAN.md`. Phase 1's exit criteria are this plan's preconditions.
**Basis:** `TERRAIN_AUDIT.md`, `RENDERING_PLAN.md` §2 Phase 2 / §3.3 / §3.4 / §3.5 / §5.2–§5.4 / §6 / §7, and `ARCHITECTURE.md` (normative, from Phase 0).
**Verified against:** working tree at `7b6f076` (Phase 0 merged). Every file, line, and dead-code claim below was re-checked in the current tree.
**Effort:** **48.0 days** (was 44.0), ~10.7 calendar weeks at 4.5 productive days/week. (43.0 in `RENDERING_PLAN.md`; +1.0 net at §4, +4.0 at the amendments below.)
**Engine:** Babylon `@babylonjs/core` 9.21.2, WebGPU. No engine or API change is in scope, considered, or permitted.

> **Amended 2026-08-18 by [`PRE_PHASE_4_REALIGNMENT.md`](PRE_PHASE_4_REALIGNMENT.md) §6, which is binding over this file where they differ.** Read it before starting Gate 2A. In brief:
>
> - **Do not start pixel work against the current baselines.** The screenshot gate compares images that are 20.5% pure black at a governor-chosen resolution, and nothing in the repository asserts a performance number. **Gate 2Z (4.0 d) runs first.** §3 there.
> - **`2-0`'s preconditions are false** — the adopted cloud shader needs a sky-view LUT, GPU LUT uploads, scene depth, blue noise and MRT, none of which exist in `src/`. New `2-0a` (+1.75 d). `R-18`.
> - **`2-0` step 4 and `2-7` must drop the `shadow × transmittance` multiply** — deviation `D-7` deliberately did not implement it and applying it here double-fades distant shadows. `R-19`.
> - **`2-11a` cannot be built through `thinInstance*`.** 0.5 d GPU spike first, re-price to 2.5 d. `R-20`.
> - **`2-18` splits into `2-13a` (after `2-13`) and `2-17a`** so season stops being the last item and the designated second cut. `R-14`.
> - **`assertWithinBudget()` cannot see anything Gate 2C allocates** — §10.3 and §0's claims about what CI enforces are wrong until `Z-4`. `R-22`.
> - **`D-2` is not retired by this plan** and its rendered-share ceiling must be budgeted at the head of Gate 2C, not discovered at week 10. `R-21`.
> - Gate **7A** (night, 7.5 d) now runs immediately after this phase, before Phase 3. `R-17`.

---

## 0. What this document adds

Phase 2 is the first phase whose work is almost entirely *visible*. It has no measurement scaffolding to build and no architectural premise to validate — Phases 0 and 1 did that. What it has instead is three independent subsystem chains and one problem the source plan does not know about.

1. **What the codebase actually is** (§3). Reading `nature/`, `water/` and `detail/` closely turns up a second instance of the exact institutional failure Phase 0 was built to stop, plus three design defects that make specific Phase 2 items unbuildable as written. This section is the substance of the plan and it is where most of the thinking went.
2. **Seven amendments** (§4), each with a rationale and a cost. Two add items the source plan does not have; five re-cost items whose difficulty the source plan misjudged in either direction.
3. **The ownership rows Phase 2 must add to `ARCHITECTURE.md`** (§5) so that the parallel-path failure cannot recur in the subsystems this phase touches.
4. **A serial work order with a week ledger** (§6), and item-by-item execution detail (§7–§9).
5. **Verification** (§10), a **risk register with triggers** (§11), and an **exit checklist** (§12).

Read §3 and §4 before writing any code.

---

## 1. Preconditions

Phase 1's exit criteria are this plan's preconditions. Phase 2 depends on five of them specifically, and every one is already scheduled:

| Needed by | Precondition | From |
|---|---|---|
| `2-0`, `2-4` | The atmosphere LUTs exist and are bindable: transmittance 256×64 and multiple-scattering / sky-view 32×32, plus their TypeScript mirror | `1C-3` |
| `2-0`, `2-7` | Clouds already consume the aerial-perspective include, and exposure is a single relative-EV100 curve | `1C-8`, `1C-2` |
| `2-9` | `scene.environmentTexture` is non-null; `REFLECTION` is defined; `specularIntensity` is 1.0 | `1C-6` |
| `2-12`, `2-11a` | The `ShadowDepthWrapper` incantation, recorded verbatim in `ARCHITECTURE.md` | `0-9` |
| `2-15`, `2-16` | Scatter is a continuous density field with the spectral regression test passing | `1B-7`, `1B-8`, `1B-9` |
| all | `PerformanceBudget.ts` asserts per-subsystem frame and memory budgets in CI; `perf:capture` has a committed baseline | `1A-1`, `1A-2` |

Two standing conditions carry forward: **Babylon stays pinned at `9.21.2`** (Phase 2 leans on private mip-generation internals — §11 R-2C), and **one branch per gate** (`phase2/gate-2a`, `-2b`, `-2c`), so the screenshot baseline rebases at three known points.

**A note on ordering that matters.** Every Phase 0 and Phase 1 dependency is satisfied before Phase 2 opens, so the three subsystem chains are genuinely independent and their order is a choice. §6.1 explains the one it makes and why.

---

## 2. The engineering standard, applied to Phase 2

The lifetime classification from Phase 1 §2 carries forward unchanged: **P** permanent, **K** kernel, **T** transitional (deleted in a later phase), **D** disposable. What changes is the distribution. Phase 1 was mostly Class P infrastructure with a Class T terrain path. Phase 2 is the opposite — almost everything it builds is Class P, because clouds, water shading and vegetation are not rebuilt by any later phase.

Three consequences worth stating before the work starts:

- **Cloud and vegetation code written in Phase 2 is the code that ships.** There is no Phase 4 equivalent waiting to delete it. `2-17`'s impostor pipeline is still running in Phase 7. That justifies a higher standard than Phase 1's terrain tile path got.
- **The two exceptions are explicitly transitional and must stay thin.** `2-10` retires the planar reflection but the plan keeps `acceptsInlandPlanarReflection` and its hysteresis "if the lake path survives" — that path is rebuilt at `5-12`, so do not invest in it. And the vegetation LOD radii are re-derived at `6-8` when canopy closure becomes a terrain splat channel, so tune them once and move on.
- **Phase 2 is where "not plastic" is won or lost.** The audit's user-facing complaints about clouds and vegetation are aesthetic, and aesthetics are tuned, not proved. The discipline that replaces proof is: *fix the physical constants from the literature first, expose exactly two tuning knobs per subsystem, and pin everything else with a test.* Each gate below names its two knobs.

---

## 3. What the codebase actually is

Four findings. The first is the important one.

### 3.1 `nature/CloudShaders.ts` is a second `payload.ts`

`src/render/webgpu/nature/CloudShaders.ts` is **596 lines of complete, structurally correct volumetric cloud code** — and it is imported by exactly one file, `nature/index.ts`, which is itself imported by **nothing**. A repo-wide search for consumers of the `nature/` barrel returns zero hits.

Meanwhile `clouds/VolumetricCloudSystem.ts` imports precisely one symbol from `nature/` — `DEFAULT_VOLUMETRIC_CLOUD_CONFIG` — and hand-rolls its own WGSL inline.

This is the same failure the audit named about `world/payload.ts`, and it is the reason Phase 0 exists:

> **Your team specified the correct architecture and then shipped a parallel ad-hoc path with none of its properties.**

**What the dead shader already has** (all verified by reading it):

| Capability | Dead `CloudShaders.ts` | Live `VolumetricCloudSystem.ts` |
|---|---|---|
| Density source | `texture_3d<f32>` base + detail volume fetches | Analytic — **64 `hash31` calls per density sample** (8 for base undulation, 24 + 24 for two `baseFbm`, 8 for erosion) |
| Weather | A sampled weather texture: coverage / cloud-type / precipitation channels | A third `baseFbm` used as a scalar threshold; no type, no precipitation |
| Vertical profile | Per-type stratus / cumulus / storm profiles blended by `cloud_type` | One hardcoded `smoothstep(0,0.12) · (1−smoothstep(0.62,1))` |
| Layer intersection | `cloudRaySphere` against planet-centred shells | Flat slabs — `(altitude − camera.y) / direction.y` |
| Phase function | Dual-lobe HG driven by `params.phase_precipitation.xyz` — i.e. by config | Hardcoded `0.72·hg(θ,0.72) + 0.28·hg(θ,−0.22)` |
| Multiple scattering | 3 octaves with `order_transmittance = sqrt(...)` decay | None. Config's `multipleScatteringFactor` is unread |
| Ambient | `sampleSkyAmbient` from a sky-view LUT × `atmosphere_transmittance` | `segmentWeight · (1.02 + point.y / 11000)` — a linear altitude ramp times a hardcoded `Color3(0.18, 0.27, 0.42)` |
| Step length | Density-adaptive: `mix(maxStep, minStep, saturate(density·3))` | Uniform across the whole interval |
| Jitter | Blue-noise texture | `hash31(fragCoord, frameIndex)` |
| Scene occlusion | Depth-buffer bound, ray clipped to scene distance | None |
| Output | 2 MRTs: premultiplied radiance + transmittance, and distance + **motion vectors** + history confidence | 1 RT packing direct/ambient coefficients, opacity, distance |
| Shadow pass | A `@compute @workgroup_size(8,8,1)` module with its own vertical profile | A fragment pass reusing the analytic density |
| Declarative metadata | `NatureShaderModule` descriptors with binding kinds, view dimensions and workgroup sizes | None |

**What it does not have**, and therefore what stays genuine Phase 2 work: nothing writes `base_noise_texture`, `detail_noise_texture` or `weather_texture` — there is no bake. There is no anti-tiling, no empty-space skipping, no coverage prepass, no wind shear, and its multiple-scattering octaves decay energy but not extinction or phase.

**The consequence for the plan is structural, not cosmetic.** `RENDERING_PLAN.md` schedules `2-1`, `2-2`, `2-4` and `2-5` as five separate features added to the shader that exists. But four of those five features *already exist in the file next door*, written against the LUT architecture Phase 1 builds. Adding them one at a time to the analytic shader means writing them twice and deleting the better copy. §4 B1 replaces that with a single adoption commit.

**And a second-order point:** there is no ownership row for cloud shaders in `ARCHITECTURE.md`, which is why Phase 0's boundary test did not catch this. §5 fixes that.

### 3.2 The cloud config is a lie

`nature/CloudConfig.ts` declares and *validates* `forwardPhaseG`, `backwardPhaseG`, `backwardPhaseBlend`, `multipleScatteringFactor`, `powderStrength`, `ambientStrength`, `minimumStepMeters` and `maximumStepMeters`. The live shader hardcodes the phase constants, ignores multiple scattering and ambient strength entirely, and derives one uniform step from `raySteps`.

So the config asserts ranges on numbers that do not reach the GPU. A tier table that lies is worse than no tier table, because it makes tuning sessions unfalsifiable — you change a value, nothing happens, and you conclude the effect does not matter. This is the same failure mode the audit describes for `environmentIntensity` being a dead uniform, and the same one the plan warns about for AO-before-IBL.

**Fix, and it is cheap:** after `2-0`, every field of `VolumetricCloudConfig` is bound to a uniform the shader reads, and a Node test asserts that every declared field name appears in the shader's uniform packing. That test is ~20 lines and it makes the whole cloud tier table trustworthy.

### 3.3 The ocean stores normalised normals and divides them back into slopes

`SpectralOceanSystem.ts` writes an `rgba16float` `normalFoam` texture per cascade holding `(n.x, n.y, n.z, foam)`. The fragment shader then recovers slope with:

```wgsl
slopeSum += sample.xz / max(sample.y, 0.08) * weight;
```

Three problems, and all three are exactly what `2-8` exists to fix:

1. **The round trip is lossy and the clamp is a real clamp.** `max(n.y, 0.08)` caps recoverable slope at 12.5 — steep crest faces are silently flattened.
2. **Normalised normals do not average linearly, so a box-filtered mip of this texture is wrong.** Averaging unit vectors shortens them, and the shortening is then divided into the slope, so a mipped normal reads as a *steeper* surface, not a flatter one. This is the mechanism behind the audit's "distant sea boils".
3. **Slope is the quantity the Toksvig/LEAN variance term needs.** `2-8` wants `roughness' = f(var(slope))`; deriving variance from renormalised normals requires undoing the normalisation first.

**Design change:** store slope directly. `RG = (∂h/∂x, ∂h/∂z)`, `B = foam`, `A = Jacobian` (which `6-4`'s caustics and `2-9`'s foam both want, and which the evolution shader already computes — the storage texture is named `displacement_jacobian` in the compute bindings). Same format, same size, one fewer shader line at the sampling site, and box-filtered mips become *correct* rather than merely cheaper.

Today's five-cascade sampling is an unrolled `if (uniforms.cascadeCount > N.5)` chain with hardcoded weights `0.62 / 0.82 / 0.74 / 0.52 / 0.36`. Those weights are a hand-tuned band-blend; after `2-8` they become a Nyquist-driven per-vertex fade and the chain collapses.

### 3.4 A `fract()` inside `textureSample` will produce a seam grid the moment mips exist

```wgsl
fn sampleNormalFoam(worldXZ: vec2f, patchLength: f32, source: texture_2d<f32>, s: sampler) -> vec4f {
  return textureSample(source, s, fract(worldXZ / patchLength));
}
```

`textureSample` selects a mip level from the *implicit screen-space derivative of the coordinate it is handed*. Across the `fract` wrap that derivative jumps by a full texture width, so the hardware picks the coarsest mip for the pixels straddling every patch boundary.

Today the cascades carry no mips, so the artefact is invisible. **The moment `2-8` adds them, the ocean gains a visible grid of blurred lines at every 64 m, 256 m, 1024 m, 4096 m and 16384 m boundary** — five nested grids, all animated with the camera.

This is the kind of defect that costs a day of confusion because it appears *as a consequence of the fix*, and the natural instinct is to blame the mip chain. **Specify the answer up front:** compute the derivative from the unwrapped coordinate and sample with `textureSampleGrad`.

```wgsl
let uv = worldXZ / patchLength;
return textureSampleGrad(source, s, fract(uv), dpdx(uv), dpdy(uv));
```

`2-8` carries a GPU test that samples a horizontal span crossing a patch boundary and asserts the selected LOD is continuous.

### 3.5 The vegetation instance format is 96 bytes and cannot express what Phase 2 needs

`WorldDetailRuntime.uploadBatch` uploads three thin-instance buffers per batch: `matrix` (16 floats), `color` (4 floats), `instanceWind` (4 floats) — **96 bytes per instance**, built by `Float32Array.from(batch.matrices)` from a plain JS `number[]`.

Three separate Phase 2 items collide with this:

- **`2-16` explicitly calls for "32 B compact instances."** At 96 B, 400,000 instances are 38.4 MB — the entire §5.2 vegetation budget at Balanced is **28 MiB** including the foliage and impostor atlases. The current format does not fit, and no amount of tuning makes it fit.
- **`2-15` needs full orientation.** `DetailRockPlacement` and `DetailTreePlacement` carry `yawRadians` only. Rocks "aligned ~60% toward the terrain normal" cannot be expressed.
- **`2-14` and `2-17` need a per-instance fade scalar.** There is nowhere to put it.

`RENDERING_PLAN.md` notices half of this — `2-15`'s note says "do the full-rotation instance matrix in the same commit as the compact instance format so the layout changes once" — but schedules it at `2-15`, which is *after* `2-12` builds card trees against the old layout. The layout would change twice.

**Design change:** a dedicated `2-11a` item, landing between the atlas and the trees, that replaces Babylon's built-in `matrix` attribute with a compact custom attribute set and builds the world matrix in the vertex shader. Concretely, 32 bytes:

**One correction to the obvious layout, made 2026-08-18.** A single uniform `scale` would silently *delete* variance that already ships: the runtime instances trees with a non-uniform `(crownRadius, crownHeight, crownRadius)` scale, so crown slenderness and trunk thickness vary per tree today. Splitting the field into `heightScale` and a `radialScale` byte — taken from one of the two reserved bytes, so the record stays exactly 32 — preserves it at zero memory cost. Losing it would have made every tree of a variant a uniformly-scaled copy, which is precisely the "little variance" the user reported.

| Offset | Field | Type | Purpose |
|---|---|---|---|
| 0 | `position` | 3 × f32 | cell-local metres |
| 12 | `orientation` | 4 × snorm16 | full rotation quaternion (`2-15`) |
| 20 | `heightScale` | f16 | vertical scale |
| 22 | `fade` | unorm8 | LOD crossfade / cull fade (`2-14`, `2-17`) |
| 23 | `variant` | u8 | crown/rock variant index |
| 24 | `tint` | 4 × unorm8 | per-instance colour |
| 28 | `windPhase`, `windResponse` | 2 × unorm8 | absorbs `instanceWind` (`2-13`) |
| 30 | `radialScale` | unorm8 | crown/trunk radius as a fraction of height, decoded over [0.50, 1.60] |
| 31 | `spare` | u8 | reserved |

**This is feasible on this stack and the risk is already retired.** The codebase already ships a custom thin-instance attribute (`instanceWind`) consumed by a `MaterialPluginBase` (`DetailWindMaterialPlugin`), and Phase 0 `0-9` proved that plugin vertex participation composes with `ShadowDepthWrapper` — with the incantation recorded verbatim in `ARCHITECTURE.md`. Building the matrix in the vertex shader is the same mechanism, one step further.

**One cost that must be named:** with no CPU-side `matrix` buffer, Babylon's `thinInstanceRefreshBoundingInfo` cannot compute bounds, so frustum culling and shadow-caster registration lose their input. The answer is to compute the AABB in the generator, which already knows every position and radius, and call `mesh.setBoundingInfo` directly. That is *cheaper* than today — the current path walks all 400k matrices on every upload and then applies a `scale(1.01)` fudge for wind.

### 3.6 Two smaller findings

**Only two LOD tiers exist.** `DetailLod = "near" | "mid"`, and a `ResidentCell` holds exactly one. `2-14`'s crossfade requires a cell to render *two* LODs simultaneously for the duration of a fade, and `2-17` adds a third tier. Both the type and the resident model change — priced into `2-14` in §4 B5.

**Ocean and inland water have already drifted, exactly as the plan says.** `fresnelSchlick`, `distributionGgx`, `geometrySchlickGgx` and `reflectedSky` are duplicated between `SpectralOceanSystem.ts` and `HydrologySystem.ts`, and the copies disagree: the sun disc is `pow(·, 3200)` in one and `pow(·, 1800)` in the other; the specular gain is `× 2.6` versus `× 4.0`; foam is `(0.69, 0.75, 0.73)` versus `(0.78, 0.84, 0.82)`. Same sun, same water, two answers.

---

## 4. Amendments to `RENDERING_PLAN.md` Phase 2

Seven. Net **+1.0 day**.

### B1 — New item `2-0 cloud-shader-adoption` (2.5 d), and four cloud items shrink

**Change.** Before any cloud feature work, adopt `nature/CloudShaders.ts` as the live cloud shader in one structural commit, and delete the inline WGSL in `VolumetricCloudSystem.ts`. This is Phase 0 `0-3` applied to the second instance of the same problem.

**What adoption delivers on day one** (§3.1): volume-fetch density, the weather-map contract with type and precipitation channels, per-type vertical profiles, sphere-based layer intersection, config-driven dual-lobe HG, three-octave multiple scattering, sky-view-LUT ambient, atmosphere transmittance, blue-noise jitter, density-adaptive step length, scene-depth occlusion, and a two-MRT output carrying motion vectors.

**What it does not deliver**, and therefore what the feature items still own: the noise bake (`2-1`), the weather-map generator and wind shear (`2-2`), anti-tiling (`2-3`), extinction- and phase-decaying MS octaves (`2-4`), empty-space skipping and the coverage prepass (`2-5`), the pixel cap (`2-6`), and the sun-space shadow footprint (`2-7`).

**Adoption is not a straight copy.** Budget within the 2.5 days for: binding the volumes to a temporary procedural stand-in so the shader runs before `2-1` exists; re-applying `1C-8`'s three Phase 1 changes to the adopted shader (aerial-perspective consumption, removal of the private exposure normaliser, transmittance-coupled shadow strength — see the note below); wiring the two-MRT output through the existing temporal-resolve and composite passes; and deleting `nature/index.ts`, which has no importers.

**On the cross-phase cost.** `1C-8` (1.5 d) modifies the shader that `2-0` replaces. Moving `1C-8` into Phase 2 would avoid the rework, but it would leave clouds unhazed for all of Phase 1 — breaking that phase's demo state ("distance reads as distance") in the most visible part of the frame. The judgement is to keep `1C-8` in Phase 1 and pay ~0.25 d re-applying its substance here. That cost is real, it is priced, and it is the cheaper of the two options.

**Cost:** `2-0` +2.5; `2-2` 2.5 → 1.5; `2-4` 2.0 → 1.5; `2-5` 2.0 → 1.5; `2-7` 2.5 → 2.0. **Net 0.0** — the adoption pays for itself out of the items it de-risks, and Gate 2A stays at 13.5 days.

### B2 — `2-8` stores slope, not normals, and mandates `textureSampleGrad`

**Change.** Two specifications added to `2-8`, both from §3.3 and §3.4: the cascade output becomes `RG = slope, B = foam, A = Jacobian`, and every cascade sample uses `textureSampleGrad` with derivatives taken from the unwrapped coordinate.

**Why it must be specified rather than discovered.** Storing slope is what makes a box-filtered mip *correct*; without it, `2-8` ships mips that make distant water look rougher instead of smoother, which is the opposite of the item's entire purpose. And the `fract` derivative trap surfaces only after the mips land, disguised as a mip-chain bug.

**Cost:** 0.0. Both are within `2-8`'s existing 4.0 days; they are the difference between the item working and not.

### B3 — `2-8a water-shader-extraction` (0.75 d) moves out of `2-9` and lands *first*

**Change.** `RENDERING_PLAN.md` folds the `WaterShaders.ts` extraction into `2-9`. Pull it out and run it before `2-8`.

**Why.** `2-8` rewrites the ocean fragment shader's sampling and roughness path. Extracting the shared helpers afterwards means the extraction has to reconcile a freshly-diverged copy; extracting first means `2-8` edits one shared file and hydrology inherits the improvement. The extraction is also mechanically verifiable in a way the rest of `2-9` is not: the ocean's output must be **byte-identical** before and after, which the screenshot harness can assert directly.

The divergent constants (§3.6) become named parameters with the difference made explicit and deliberate — not two literals that drifted.

**Cost:** `2-9` 3.0 → 2.25, `2-8a` +0.75. **Net 0.0.**

### B4 — New item `2-11a instance-format` (1.5 d), and three items shrink

**Change.** Per §3.5, land the compact 32-byte instance format and vertex-shader matrix construction as its own item between `2-11` and `2-12`, rather than as a side effect of `2-15`.

**Why.** `2-12`, `2-14`, `2-15`, `2-16` and `2-17` all write instance data. Changing the layout at `2-15` means `2-12`'s card trees ship against the 96-byte format and are then rewritten. Landing it before the first consumer means the layout changes once, which is what `2-15`'s own note asks for — just at the right point in the order.

**Cost:** `2-11a` +1.5; `2-15` 2.0 → 1.5; `2-16` 2.5 → 2.0. **Net +0.5.**

### B5 — `2-14` grows to 2.0 d for the two-LOD resident model

**Change.** `2-14` must also change `DetailLod` to three tiers and let a resident cell hold two LODs during a fade (§3.6).

**Why.** A dither crossfade between LODs is not a shader change alone — both meshes must be resident and drawn for the fade window. Today `ResidentCell` carries a single `lod` and switching disposes the outgoing batch. The source plan prices `2-14` as a shader item.

**Cost:** `2-14` 1.5 → 2.0. **Net +0.5.**

### B6 — Five ownership rows are added to `ARCHITECTURE.md` as their items land

**Change.** Phase 2 creates or promotes five artifacts that Phase 3 and beyond will be tempted to fork. Each gets a row and therefore a single-definition-site test (§5).

**Why.** Phase 0's boundary test did not catch the `CloudShaders.ts` duplication because there was no cloud row. The machinery works; it just was not pointed at this subsystem. **Cost: 0.0** — folded into the item that creates each artifact.

### B7 — Gate ordering is water-before-vegetation, deliberately

**Change.** Run Gate 2B (water surface) before Gate 2C (living ground), rather than in the plan's item-number order.

**Why.** `2-10 retire-planar-reflection` frees 0.5–1.0 ms of amortised frame time. Gate 2C's alpha-tested foliage, grass and impostors are the largest new per-frame cost in the phase and they defeat TBDR hidden-surface removal. Doing water first means the budget those draws need is already on the table when `assertWithinBudget()` starts failing. **Cost: 0.0.**

### B8 — Vegetation quality: nine amendments from flight testing (2026-08-18)

The user flew the sim and reported *"a whole forest of trees made of relatively primitive shapes with little detail — leaves, branches, variance in size, depth in color, variance in color, variance in distinguishable features"*, the same of the ground layer — *"leaves/grass blades, overgrown areas, moss, twigs, mess"* — and a suspicion: *"we might be currently prioritizing quantity over quality. I'm okay with having fewer trees/forests if it means that the trees we do get actually look like real foliage/plants."*

Auditing the vegetation chain against that complaint found the leaves genuinely answered and size variance already better than the complaint implies, and seven things missing. **`RENDERING_PLAN.md` §5.3 now carries the vegetation trade-off rule** that makes the user's offer binding: count is a budget knob, per-plant fidelity is not.

| # | Amendment | Item | Days |
|---|---|---|---|
| 1 | The atlas serves every card, not just trees — grass, fern, heather, reed, shrub and litter layers | `2-11` | +0.5 |
| 2 | `scale` splits into `heightScale` + `radialScale`; a uniform scale would have *deleted* variance that ships today | `2-11a` | 0 |
| 3 | Stand identity from a continuous field, killing the 32 m species/age lattice; plus an appearance-domain spectral test | `2-11b` new | +1.25 |
| 4 | Trunks are specified and rendered; tint distribution given hue variance; baked crown occlusion; 4–5 variants for common species; character modifiers | `2-12` | +2.0 |
| 5 | Shrubs become cards — the word "shrub" appeared zero times in this document | `2-12b` new | +1.0 |
| 6 | Ground clutter: logs, stumps, branch litter, moss cushions on the rock instancing path | `2-15` | +0.75 |
| 7 | Ground-cover archetypes are habitat-driven, not a flat 15% roll | `2-16` | 0 |
| 8 | Per-instance impostor silhouette variety; and the impostor atlas budget, which does not currently close | `2-17` | +0.5 |
| 9 | Two capture scenes — one at 2 m eye height, one at 1,200 ft — plus measurable variety criteria on the Gate 2C checklist | `2-0`, §10.2, §12 | +0.5 |

Phase 3's `3-1` gains a **forest-floor recipe** in the same pass (0 days — it was already one of ten layers, with no recipe written); Phase 4's `4-6b` gains ground-cover archetype weights; Phase 6's `6-6` gains named ground-layer consumers and a glade floor that actually opens.

### Amended ledger

| Gate | `RENDERING_PLAN.md` | Amendments | This plan |
|---|---|---|---|
| 2A — Clouds | 13.5 | +2.5 `2-0`, −2.5 across `2-2`/`2-4`/`2-5`/`2-7`; +0.5 `2-0` for the two vegetation capture scenes (§10.2) | **14.0** |
| 2B — Water surface | 8.5 | +0.75 `2-8a`, −0.75 `2-9` | **8.5** |
| 2C — Living ground | 21.0 | +1.5 `2-11a`, +0.5 `2-14`, −1.0 across `2-15`/`2-16`; **vegetation-quality amendments 2026-08-18: +0.5 `2-11`, +1.25 `2-11b`, +2.0 `2-12`, +1.0 `2-12b`, +0.75 `2-15`, +0.5 `2-17`** | **28.0** |
| **Phase 2** | **43.0** | **+7.5** | **50.5 d ≈ 11.2 weeks** |

---

## 5. Ownership rows Phase 2 adds

`ARCHITECTURE.md` §1 is enforced by `src/render/webgpu/owners.ts` and `tests/architecture.boundaries.test.ts`: a second definition of an owned artifact fails `npm test` with a message naming the owner. Phase 2 adds five rows, each in the commit that creates its artifact.

| Artifact | Owner | Definition site | Lands at |
|---|---|---|---|
| Volumetric cloud shader modules | clouds | `src/render/webgpu/nature/CloudShaders.ts` | `2-0` |
| Cloud noise + weather bake | clouds | `src/render/webgpu/clouds/CloudVolumeBake.ts` | `2-1` |
| Shared water shading helpers | water | `src/render/webgpu/water/WaterShaders.ts` | `2-8a` |
| Detail instance format | vegetation | `src/render/webgpu/detail/instanceFormat.ts` | `2-11a` |
| Foliage and impostor atlases | vegetation | `src/render/webgpu/detail/FoliageAtlas.ts` | `2-11`, extended `2-17` |
| CPU array-mip reduction | performance | `src/render/webgpu/core/TextureArrayMips.ts` | `2-11`, reused by `3-1` |

**On where the cloud shader lives.** After adoption the WGSL modules stay in `nature/CloudShaders.ts` and `clouds/VolumetricCloudSystem.ts` consumes them. That is not a preference — it mirrors the arrangement that already works in this codebase, where `water/SpectralOceanSystem.ts` consumes `nature/OceanShaders.ts` and `nature/OceanConfig.ts`. `nature/` is the shader library; the system directories are the runtimes. Consistency with the working pattern beats relocating files.

**On `nature/index.ts`.** The barrel has zero importers. After `2-0` and `2-8a`, every module beneath it is live. Delete the barrel rather than leaving an unreferenced re-export surface — dead-but-compiling code is the habit this whole programme is correcting.

---

## 6. Work order

### 6.1 Gate order and dependencies

All Phase 0/1 dependencies are satisfied at Phase 2 start, so the three chains are independent. The order is **2A clouds → 2B water → 2C living ground**, for three reasons: clouds fill the upper hemisphere and give the largest visible delta per day; water's `2-10` frees the frame budget that vegetation immediately consumes (B7); and 2C is the longest chain and the most likely to overrun, so it sits last where an overrun eats phase slack instead of blocking two other subsystems.

```
Gate 2A   2-0 ──→ 2-1 ──→ 2-2 ─┬─→ 2-3 ─┐
                               └─→ 2-4 ─┴─→ 2-5 ──→ 2-6
          2-7 (independent; needs 1C-4, done in Phase 1)

Gate 2B   2-8a ──→ 2-8 ──→ 2-9 ──→ 2-10

Gate 2C   2-11 ──→ 2-11a ──→ 2-12 ─┬─→ 2-13 ──→ 2-16
                                   └─→ 2-14 ──→ 2-17 ──→ 2-18
          2-15 (needs 2-11a only)
```

**Slack, for when something blocks.** `2-3` and `2-4` are siblings; `2-13` and `2-14` are siblings; `2-15` needs only the instance format and can be pulled forward from anywhere in Gate 2C. `2-7` needs nothing inside Phase 2 and can move to any point in Gate 2A. Everything else is a hard chain.

### 6.2 Week ledger — 4.5 productive days per week

| Week | Days | Work | Cumulative |
|---|---|---|---|
| 1 | 0 → 4.5 | `2-0` cloud-shader adoption (3.0, incl. the two vegetation capture scenes) · `2-1` noise + weather bake (1.5 of 2.0) | 4.5 |
| 2 | 4.5 → 9.0 | `2-1` finish (0.5) · `2-2` shape + wind shear (1.5) · `2-3` anti-tiling (1.5) · `2-4` lighting (1.0 of 1.5) | 9.0 |
| 3 | 9.0 → 13.5 | `2-4` finish (0.5) · `2-5` adaptive march (1.5) · `2-6` cloud pixel cap (1.0) · `2-7` shadow rework (1.5 of 2.0) | 13.5 |
| 4 | 13.5 → 18.0 | `2-7` finish (0.5) → **Gate 2A closes, d14.0** · `2-8a` water-shader extraction (0.75) · `2-8` slope + mips (3.25 of 4.0) | 18.0 |
| 5 | 18.0 → 22.5 | `2-8` finish (0.75) · `2-9` sun + foam (2.25) · `2-10` retire planar reflection (1.5) → **Gate 2B closes, d22.5** | 22.5 |
| 6 | 22.5 → 27.0 | `2-11` foliage atlas (2.5) · `2-11a` instance format (1.5) · `2-11b` stand field + spectrum (0.5 of 1.25) | 27.0 |
| 7 | 27.0 → 31.5 | `2-11b` finish (0.75) · `2-12` card trees (3.75 of 6.0) | 31.5 |
| 8 | 31.5 → 36.0 | `2-12` finish (2.25) · `2-12b` card shrubs (1.0) · `2-13` wind three-band (1.0) · `2-14` start (0.25) | 36.0 |
| 9 | 36.0 → 40.5 | `2-14` LOD crossfade finish (1.75) · `2-15` rocks and ground clutter (2.25) · `2-16` start (0.5) | 40.5 |
| 10 | 40.5 → 45.0 | `2-16` grass and ground cover finish (1.5) · `2-17` octahedral impostors (3.0 of 6.5) | 45.0 |
| 11 | 45.0 → 49.5 | `2-17` finish (3.5) · `2-18` seasonal foliage (1.0 of 2.0) | 49.5 |
| 12 | 49.5 → 50.5 | `2-18` finish (1.0) → **Gate 2C / Phase 2 closes, d50.5** | 50.5 |

`2-17` is the single largest item in the phase at 6.5 days and it sits at the end, where a slip has nowhere to propagate. That is deliberate — see §11 R-2G for its cut line, which after the 2026-08-18 amendments must name the count reduction that pays for it rather than absorbing the cost in fidelity.

---

## 7. Gate 2A — Clouds (13.5 d)

**Goal.** G3. Cumulus with flat bases, cauliflower tops and ragged translucent edges; genuinely varied sizes and opacities; no repeat over a 200 km leg; interior depth, a real silver lining, and shaded sides that hold blue skylight. Individual cloud shadows with recognisable shapes sweeping the ground.

**The two tuning knobs for this gate are `densityMultiplier` and `extinctionPerMeter`.** Every other constant comes from the literature and is pinned by a test. The plan is explicit that this subsystem is easy to over-tune into milk.

---

### `2-0` — Cloud shader adoption (2.5 d) · Class P

**Intent.** Make `nature/CloudShaders.ts` the live cloud shader and delete the parallel path. §3.1 and §4 B1.

**Steps.**

1. **Bind the volumes to a stand-in.** The adopted shader requires `base_noise_texture` and `detail_noise_texture` as `texture_3d<f32>`, and `2-1` does not exist yet. Create both as small procedurally-filled 3D textures written once from the CPU (`RawTexture3D`), so the shader compiles and runs from the first commit. `2-1` replaces the fill with a GPU bake and nothing else changes. **This ordering is what makes the adoption a single reviewable commit** rather than a two-week branch.
2. **Bind the weather texture** the same way — a CPU-filled `rgba8` stand-in with plausible coverage/type channels; `2-2` replaces it with the generator.
3. **Wire the two-MRT output** through the existing temporal-resolve and composite passes. The adopted raymarch emits premultiplied radiance + transmittance in target 0 and distance + motion + confidence in target 1; the current temporal pass expects one RGBA. The adopted `CLOUD_TEMPORAL_RESOLVE_WGSL` compute module already consumes the new layout — prefer it over adapting the old fragment pass.
4. **Re-apply `1C-8`'s three changes** to the adopted shader: consumption of the aerial-perspective include, removal of any private exposure normaliser, and shadow strength multiplied by the fragment's transmittance.
5. **Bind every config field** (§3.2) and add the Node test asserting that each declared `VolumetricCloudConfig` key reaches a uniform.
6. **Delete** the inline `CLOUD_RUNTIME_DENSITY_WGSL`, `CLOUD_INTEGRATION_FRAGMENT_WGSL`, `CLOUD_RUNTIME_SHADOW_FRAGMENT_WGSL` and `nature/index.ts`. Add the ownership row.

**Two things that will bite.** The adopted shader uses `cloudRaySphere` against planet-centred shells while the live system uses flat slabs and a 118 km camera-centred composite shell — check the shell radius still encloses the sphere intersection at the new `camera.maxZ` of 45 km. And `sampleCloudWeather` applies `fract()` to a world-space UV, which carries the same derivative trap as §3.4; it is harmless at mip 0 but must be `textureSampleGrad` if the weather texture ever gains mips.

**Done when.** The screenshot pair renders through the adopted shader with no inline cloud WGSL remaining; `npm run test:gpu` compiles all three `CLOUD_SHADER_MODULES`; the config-binding test passes; the boundary test names `clouds` as the owner.

---

### `2-1` — Noise and weather bake (2.0 d) · Class P

**Intent.** Replace 64 hash calls per density sample with one or two texture fetches — the budget that pays for everything else in this gate.

Bake once at startup on the GPU, following the `SpectralOceanSystem` compute pattern (`createCompute`, explicit `bindingsMapping`, 3D storage textures, `fastMode = true` after a compile barrier): a **tileable Perlin-Worley base volume** (128³, r8unorm), a **detail volume** (32³, r8unorm) and a **curl volume** (32³, rgba8unorm). `RENDERING_PLAN.md` §6 rows 14–16 and §7's platform note confirm 3D storage textures are WebGPU core and Babylon's WGSL processor maps 3D texture functions — ship them as 3D, not as a `texture_storage_2d_array` workaround.

**Tileability is the whole point and it is easy to get wrong.** Every noise primitive must wrap on the volume's own cell grid — wrap cell indices modulo the octave frequency, exactly as Phase 3's material synthesis will need for its periodic noise. A volume that does not tile produces a visible seam every 128 texels of world space, which is worse than the analytic field it replaces. **Test:** sample the volume at `u` and `u + 1.0` for 4,096 random coordinates and assert bit-equality.

**Also here:** the weather-map generator that `2-0` stubbed. Coverage, cloud type and precipitation as three channels of one `rgba8` texture, driven by the environment state's weather scalars.

---

### `2-2` — Shape and wind shear (1.5 d) · Class P

Coverage-driven remap, per-type vertical profiles and detail erosion arrive with `2-0`; what remains is tuning them against the real baked volumes and adding **wind shear** — a horizontal offset applied to the sample position proportional to height fraction, so cumulus lean downwind instead of standing as vertical pillars. Three lines, and one of the strongest cheap cues that the sky is a fluid.

`RENDERING_PLAN.md` cuts the separate cirrus ray-march slab; wind shear is what survives of it.

---

### `2-3` — Anti-tiling (1.5 d) · Class P

A toroidal weather clipmap plus dual-scale shape sampling, so a 200 km straight leg never shows the same cloud group twice. The toroidal update is the same pattern `5-10`'s bathymetry clipmap will use — write it so that the addressing helper is reusable.

**Exit gate is visual and must be flown**, not asserted: a 200 km straight leg at cruise with no recognisable repeat.

---

### `2-4` — Lighting (1.5 d) · Class P

The adopted shader brings dual-lobe HG, powder and three-octave multiple scattering. Two corrections remain:

- **The MS octaves must decay extinction and phase, not only energy.** The adopted loop decays `order_weight` and takes `sqrt` of transmittance per order, which is the energy half only. Wojciech Jarosz's / Schneider's formulation decays all three per octave (`a^n`, `b^n`, `c^n`). Without the extinction decay the octaves brighten the cloud uniformly instead of filling shadowed interiors, which reads as milk.
- **Powder should be directional.** It is a backscatter approximation and must fall off as the view aligns with the sun.

**Fix the constants from the literature first, then tune only the two knobs.** Pin the phase function with a Node test: the dual-lobe HG integrated over the sphere must equal 1 within 1%.

---

### `2-5` — Adaptive march (1.5 d) · Class P

Density-adaptive step length arrives with `2-0`. What remains is the expensive half: **empty-space skipping** — on a zero-density sample, advance by the long step and keep advancing until density reappears, then step back one and resume fine — and a **low-resolution coverage prepass** that establishes per-tile entry and exit distances so the fine march never traverses empty sky.

Target: 2–4× fewer density samples at equal quality, measured by a counter in the numeric report, not by impression.

---

### `2-6` — Cloud pixel cap (1.0 d) · Class P

`resolveCloudRenderSize` scales the cloud target off the live back-buffer size, so it inherits whatever the main resolution is. Add an **absolute** cloud pixel cap per tier (§5.3: 0.35 / 0.70 / 1.00 / 1.60 M) clamped alongside the existing scale, and register the cloud pass rows in `PerformanceBudget.ts`.

This is the same argument as `1A-6a`: a multiply is not a cap.

---

### `2-7` — Cloud shadow rework (2.0 d) · Class P

**Today is worse than the audit describes.** The shadow pass marches from `nearDistance = (baseAltitude − surface.y) / sunDirection.y`. At the guard value `sunDirection.y = 0.001` that is 1.5 × 10⁶ m, and the marched span `(top − base)/sunDirection.y` is 5.7 × 10⁶ m over 20 steps — 285 km per step. The map is 512² over `shadowWorldSizeMeters: 90_000`, i.e. **176 m/texel**, and each texel runs 20 analytic density samples at 64 hash calls each: **≈ 335 million hash evaluations per update, every two frames.**

Replace with a **sun-space orthographic footprint**: 512² over 24 km = 47 m/texel (3.7× sharper), and a **single-altitude coverage approximation** instead of a vertical march. Per `RENDERING_PLAN.md` that is 0.26 M density evaluations per update against 3.7 M for a naive march — *cheaper than today while 7.5× sharper*, and the `1/sunDirection.y` degeneracy disappears because the footprint is built in sun space rather than projected through it.

Shadow strength multiplies the fragment's aerial-perspective transmittance (from `1C-4`), so distant terrain is not double-darkened by shadows it should be too hazy to show.

**Watch the contract:** `CloudShadowProjection` carries `sunDirectionY` to consumers via `CloudShadowReceiverRegistry` — which Phase 0 rebuilt on `SharedReceiverRegistry`. Changing the projection basis changes that struct; update the registry's projection type in the same commit, and let the existing `tests/render.webgpu-cloud-shadow-receivers.test.ts` catch consumers that were not updated.

---

## 8. Gate 2B — Water surface (8.5 d)

**Goal.** The surface half of G2. The distant sea stops boiling and becomes smooth, matte and correctly hazed; sun glitter concentrates into one coherent moving path; wave crests glow translucent teal when backlit.

**The two tuning knobs for this gate are `foamThreshold` and the wave-crest SSS intensity.** Everything else — the BRDF, the sun's solid angle, the absorption coefficients — is physical and pinned.

---

### `2-8a` — Water shader extraction (0.75 d) · Class P

Extract `fresnelSchlick`, `distributionGgx`, `geometrySchlickGgx`, the GGX assembly and `reflectedSky` into `src/render/webgpu/water/WaterShaders.ts`, consumed by both `SpectralOceanSystem` and `HydrologySystem`. Add the ownership row so the drift in §3.6 cannot recur.

**The divergent constants become named, explicit parameters** rather than two literals: the sun-disc exponent, the specular gain and the foam albedo are passed in, and the ocean/hydrology difference — if any survives `2-9` — is a value at the call site with a comment, not an accident.

**Verification is unusually strong for a refactor:** the ocean's rendered output must be **byte-identical** before and after. Run `perf:capture` on both sides of the commit and diff. If it is not identical, the extraction changed something and the diff says what.

---

### `2-8` — Ocean slope and mips (4.0 d) · Class P

**Four changes, in order.**

1. **Store slope, not normals** (§3.3). The cascade output becomes `RG = (∂h/∂x, ∂h/∂z)`, `B = foam`, `A = Jacobian`. Delete the `sample.xz / max(sample.y, 0.08)` recovery and its 12.5 slope clamp at the sampling site.
2. **Mip the cascades.** With slopes stored, a plain box filter is correct. Per `RENDERING_PLAN.md` §7 R6, storage textures can only be written at mip 0 — `webgpuHardwareTexture.js` always creates the write view with `mipLevelCount = 1`, and `ComputeShader.setStorageTexture` takes no mip index — so a compute mip-reduce kernel is not expressible. Call `engine._textureHelper.generateMipmaps(...)` directly. **Private API: add a startup capability assertion in `RenderInvariants.ts` so a Babylon bump fails loudly.** Verify the texture carries `RENDER_ATTACHMENT` usage; `rgbaStorage` currently passes `generateMipMaps = false` and a STORAGE-only texture cannot be mipmapped by Babylon's render-based generator. **Fallback:** a chain of `ProceduralTexture` passes into a mipped RTT.
3. **`textureSampleGrad` everywhere** (§3.4), with derivatives from the unwrapped coordinate. GPU test: sample a span crossing a patch boundary; assert the selected LOD is continuous.
4. **Toksvig/LEAN variance → roughness.** Track slope variance through the mip reduction and fold the lost detail back into roughness. This is what replaces today's `smoothstep(1200, 36000, cameraDistance) * 0.075` ad-hoc distance term, and it is the actual mechanism that stops the distant sea boiling: the sub-pixel wave detail becomes roughness instead of aliasing.

Per-vertex cascade fade below Nyquist replaces the hardcoded `0.62 / 0.82 / 0.74 / 0.52 / 0.36` blend weights.

**Demo state for this item alone:** *"Now it looks like the ocean."*

---

### `2-9` — Sun and foam (2.25 d) · Class P

One **solid-angle-correct GGX lobe** via Karis's representative-point method: `alpha' = clamp(alpha + sunAngularRadius / (2 · distanceToHorizon), alpha, 1)`, energy renormalised by `(alpha/alpha')²`. This deletes `pow(·, 3200)`, `pow(·, 1800)`, `× 2.6` and `× 4.0` — four magic numbers replaced by one physical quantity, the sun's 0.004675 rad angular radius, which `EnvironmentState` already carries and `1C-1` made live.

**Lit textured foam** with an advected Worley break-up mask, replacing the flat `mix(water, vec3f(0.69, 0.75, 0.73), foam)` — foam is a Lambertian surface and must respond to the sun.

**Wave-crest subsurface scattering** driven by the summed displacement's `y`, which the vertex shader already computes and currently discards. This is what makes crests glow translucent teal when backlit and it is the cheapest large win in the gate.

Environment reflections come from the shared IBL probe (`1C-6`), with `roughnessToMip` calibrated so α = 0.075 lands at mip 0 and α = 0.34 at mip 2 — water roughness never exceeds ~0.34, so a box mip chain suffices and no GGX convolution is needed.

---

### `2-10` — Retire the planar reflection (1.5 d) · Class T

`resolvePlanarReflectionBudget` gives tier 2 a 480×270 target on a 3-frame cadence. With the IBL probe live and water roughness capped at 0.34, the sky environment cube covers ≥ 80% of every water reflection. Retire the system: −0.5 to −1.0 ms/frame amortised, and one fewer camera that `1C-4`'s aerial perspective has to serve.

**Keep `acceptsInlandPlanarReflection` and the lake hysteresis logic** — `RENDERING_PLAN.md` is explicit that it is correct and non-obvious. Treat it as Class T: preserve it, do not improve it, and expect `5-12` to rebuild the lake path around it.

Retire Governor B's planar-reflection cadence rung (`1A-6b` lever 3) in the same commit and reconcile the budget contract, or the governor will be pulling a lever attached to nothing.

---

## 9. Gate 2C — Living ground (22.0 d)

**Goal.** G4. Trees have leaves; silhouettes break up against the sky; backlit crowns glow. Grass returns. Rocks have varied silhouettes and sit tilted into the slope. Forest extends to the horizon.

**The two tuning knobs for this gate are the alpha-test threshold and the grass density ramp constant.** Species mixes, crown geometry and LOD radii are structural.

---

### `2-11` — Foliage texture atlas (2.5 d) · Class P

Procedurally synthesised leaf, needle and bark textures into one atlas.

**The layer list is everything that gets drawn as a card, not just trees** (+0.5 d over the source estimate). `2-16` adds ferns, heather and reeds and `2-12b` adds shrubs; if the atlas ships with only leaf/needle/bark, those arrive as untextured geometry, which is the exact plastic failure this item exists to prevent. Layers: broadleaf (three leaf shapes), needle (two), bark (three species groups), **grass blade, fern frond, heather, reed, hazel leaf, juniper scale, sage leaf**, and one **litter/twig** layer for `2-15`'s clutter. Every one gets the same alpha dilation and coverage preservation as the tree layers. Two techniques are non-negotiable and both are the usual reason procedural foliage fails:

- **Alpha dilation.** Push colour outward into the transparent region before mipping. Without it, filtered texels blend toward the transparent border colour and every leaf gains a dark halo at range.
- **Castano coverage preservation.** Rescale each mip's alpha so its coverage at the alpha-test threshold matches mip 0. Without it, foliage evaporates with distance — the canopy thins to nothing and the tree becomes a bare skeleton.

**Test:** mip-N alpha coverage within 3% of mip-0, at the shipping alpha-test threshold, for every atlas layer.

**Babylon mips only layer 0 of a `Texture2DArray`, and this is verified, not suspected.** `Engines/WebGPU/webgpuTextureManager.js:716` signs `generateMipmaps(gpuOrHdwTexture, mipLevelCount, faceIndex = 0, commandEncoder)` and builds its render pass with `baseArrayLayer: faceIndex`; `Engines/thinWebGPUEngine.js:90` and `:93` both call it with a hardcoded `0`. So `engine._generateMipmaps` on an array texture leaves layers 1..N with a single level, and every foliage layer but the first samples at full resolution forever.

That is not a problem for this item, because **coverage preservation is not a box filter** — rescaling alpha per level to hold coverage at the alpha-test threshold has to be computed, not blitted, so the reduction is CPU work regardless. Build it as a reusable module rather than inline:

- **`src/render/webgpu/core/TextureArrayMips.ts`**, owner *performance*, added to `ARCHITECTURE.md` — a CPU array-mip reducer that walks every layer, applies a caller-supplied reduction kernel per level, and uploads with `RawTexture2DArray.updateMipLevel(data, level)`.
- `2-11` supplies the **coverage-preserving** reducer. **Phase 3 `3-1` reuses the same module** with a **Toksvig** reducer for the terrain material arrays, which have exactly the same limitation and exactly the same shape.

Sequencing this here rather than in Phase 3 costs nothing — the module is ~60 lines and `2-11` needs it first — and it means the terrain material arrays inherit a path that has already run against ten layers.

---

### `2-11a` — Compact instance format (1.5 d) · Class P

Per §3.5 and §4 B4. Replace the 96-byte `matrix` + `color` + `instanceWind` triple with the 32-byte layout, and build the world matrix in the vertex shader inside a `DetailInstanceMaterialPlugin` that absorbs `DetailWindMaterialPlugin`.

**Four things this commit must get right.**

1. **Follow the `0-9` incantation exactly.** Attach every vertex-participating plugin to the `PBRMaterial`, *then* assign `material.shadowDepthWrapper = new ShadowDepthWrapper(material, scene)` **before the material's first effect compiles** — the wrapper learns about base-material effects through `onEffectCreatedObservable` and silently falls back to the undisplaced depth pass if attached later. No `remappedVariables`. This is recorded verbatim in `ARCHITECTURE.md` and proven in `tests/gpu/shadow-depth-wrapper.test.ts`.
2. **Compute bounds in the generator.** With no CPU-side matrix buffer, `thinInstanceRefreshBoundingInfo` has no input. The generator already knows every position and radius; emit an AABB with the batch and call `mesh.setBoundingInfo` directly. This is strictly cheaper than today's walk over 400k matrices plus a `scale(1.01)` wind fudge — the wind extent becomes an explicit term.
3. **Build into a pooled buffer.** Today `uploadBatch` calls `Float32Array.from(batch.matrices)` on a JS `number[]`. Write the packed bytes into a pooled `ArrayBuffer` during generation and upload it directly.
4. **Delete the dead GLSL branch** in `DetailWindMaterialPlugin`. The renderer is WebGPU-only; the GLSL path has never executed.

**Memory result to check against `assertWithinBudget()`:** 400,000 instances fall from 38.4 MB to 12.8 MB, inside the §5.2 Balanced vegetation row of 28 MiB with room for the atlases.

---

### `2-11b` — Stand field and appearance spectrum (1.25 d) · Class P

Two halves of one problem: **every anti-repetition guard in the programme is positional, and the appearance domain — which `2-12` is about to make visible — is both untested and currently laid out on a hard lattice.**

**The stand lattice.** `generation.ts` draws one `{ standAge, dominantChoice }` per 32 m scatter block and selects species from it, so species identity, stand age and tree height all change on a 32 m grid. Assertion 27's spectral test collects only `{x, z}`, so it structurally cannot see this — and it is invisible today because every tree is a cone. It will not be invisible after `2-12`. Derive stand identity — dominant species mix, stand age, and the tint centre `2-12` needs — from a low-frequency fbm evaluated at **the stem's own world position**, with no block lattice, exactly as `RENDERING_PLAN.md` §3.5 already requires of density: *"Clumping expressed as a field has no centre and no radius, therefore nothing circular to see."*

**The appearance spectrum test.** Reuse `render.webgpu-detail-scatter.test.ts`'s existing machinery unchanged, but run the 3–200 m sweep over four *attribute* channels rather than position: species index, stand age, height, and tint hue. Same acceptance: no peak above 1.15× the local radial mean outside DC and the intended ecological bands, and a 16-bin phase histogram within [0.92, 1.08]. Today's generator would correctly fail it at 32 m.

---

### `2-12` — Card trees (6.0 d) · Class P

Species-specific branch skeletons carrying 40–60 alpha-tested foliage quads, hemispherically distributed and tilted outward so the crown reads as volume from every angle.

**Five deliverables were added on 2026-08-18 after flight testing.** The user reported a forest of primitive shapes with "little detail — leaves, branches, variance in size, depth in color, variance in color, variance in distinguishable features". Leaves and size variance were already answered; the other four were not, and three of the five fixes below cost nothing in memory or frame time. Together they take this item from 4.0 to 6.0 days. Per §5.3's vegetation trade-off rule, they are funded by count, not by each other.

**1. The trunk is rendered geometry, and it is specified here.** Nothing in the source plan says the branch skeleton is *drawn* — it is described only as a carrier for foliage quads — so today's shared `CreateCylinder({ tessellation: 7 })` prototype, with one hardcoded trunk colour for all seven species, would survive this gate by omission. It does not. Trunks are swept generalised cylinders (8 sides near, 5 mid, 4–6 rings) with a per-species radius profile `r(t) = r0·(1−t)^k`, a root flare `r(0)·(1 + f·exp(−t/0.06))`, one primary fork above 0.55 h for the broadleaf species, and a per-instance lean of 2–8° carried by the `orientation` quaternion the format already has. Bark comes from the `2-11` atlas through this item's generated tangents, and the trunk takes its tint from the same per-instance bytes as the crown. **A trunk prototype exists at the `mid` tier as well as `near`** — today mid-LOD trees are floating crowns. Keep the trunk as its own batch so bark stays back-face-culled while foliage stays two-sided: zero new draw calls.

**2. Tint distribution, not just tint storage.** `2-11a` allocates four bytes for per-instance colour and no item says what goes in them; today's generator multiplies all three channels by one scalar, which is pure brightness jitter with **zero hue variance** — a forest of one green at different exposures. Per-instance tint is sampled in a perceptual space: within a species, hue σ ≈ 6–9° (broadleaf wider than conifer), saturation σ ≈ 0.10 relative, value σ ≈ 0.12. The mean is **stand-correlated** — drawn from the continuous stand field `2-11b` introduces — with an individual residual on top, so neighbouring stands differ as well as neighbouring trees, and the result is not confetti. Correlate value weakly with the individual's age so young stems read lighter.

**3. Baked crown occlusion — this is what "depth in color" means.** The programme's only occlusion item is `4-7` and it is scoped to terrain, so a card crown under `1C-6`'s full-strength IBL is uniformly lit and reads as a flat green blob. At prototype-build time, compute a per-vertex sky-visibility scalar for every foliage quad and trunk vertex — a 16-direction cosine-weighted hemisphere test against the crown's own quad set, once per variant on the CPU, microseconds — and fold it into the vertex colour. Interior leaves go dark, sunlit tips stay bright, and the crown gains the interior depth the complaint names. ~67 KB of vertex data across every prototype.

**4. Four to five crown variants for the three commonest species, three for the rest.** Three per species is 21 distinct trees for a whole forest, and the ceiling was never a budget — the `variant` byte holds 256 and a variant is ~1.2 MiB of geometry across the whole set. Make the variant count a `WebGpuQualityProfile` field per `ARCHITECTURE.md`'s tier rule rather than a constant; Low keeps three.

**5. Character modifiers, from the spare bits of the `variant` byte.** Only 3–5 of the byte's 256 values index geometry. The high three bits select a per-instance modifier applied in the vertex shader against the same prototype: intact; lean 6–12°; broken/dead top; a thinned crown; a double leader. No new prototypes, no new memory — real stands are not all intact symmetric specimens, and this is the cheapest variance in the item.

**Generated tangents**, which do not exist anywhere in this codebase today and without which Babylon's `NORMALMAP` path is structurally unreachable.

**`subSurface.isTranslucencyEnabled` at intensity ~0.8.** `RENDERING_PLAN.md` §3.5 is unambiguous that backlit foliage glowing instead of crushing to black is the strongest single not-plastic cue for vegetation.

**Alpha test, not alpha blend. No stochastic alpha** — there is no TAA to resolve it.

**Two performance facts to design around, both from §7 R11.** Alpha test defeats TBDR hidden-surface removal, so foliage goes in a separate render group *after* opaque terrain. And alpha-to-coverage is off, so foliage gets **no** MSAA benefit — the silhouette quality comes from the atlas and the coverage-preserved mips, not from `1B-11`.

This replaces `createTreeCrown`'s 9-sided opaque cones and icospheres.

---

### `2-12b` — Card shrubs (1.0 d) · Class P

**The word "shrub" appeared zero times in this document before 2026-08-18.** Juniper, hazel and sage are placed by the density field, drawn by the runtime as flat-shaded icospheres, and have no appearance item anywhere in the programme. After `2-12` they would sit next to card trees as smooth blobs — the contrast makes them *more* visible, not less, and they are the understory layer the user's "foliage" complaint is largely about.

Shrubs are card geometry too: 12–18 alpha-tested foliage quads on a short multi-stem skeleton, drawn from the `2-11` atlas layers this amendment adds (hazel broadleaf, juniper scale, sage small-leaf grey), with the same tint distribution, baked occlusion and translucency as `2-12`. Two variants per species. They ride the same instance format and the same batches; no new draw calls.

---

### `2-13` — Three-band wind (1.0 d) · Class P

Three superposed frequency bands — trunk sway, branch flex, leaf flutter — driven by the instance's `windPhase` and `windResponse` bytes and the shared wind field in `src/world/wind.ts`. The existing single-band plugin becomes the middle band.

---

### `2-14` — LOD crossfade (2.0 d) · Class P + T

Bayer dither plus a per-instance hash, applied at **every LOD switch and at the cull radius**. Per §3.6 and §4 B5 this also changes the resident model:

- `DetailLod` becomes three tiers (`near`, `mid`, `impostor`).
- A `ResidentCell` holds two LODs for the duration of a fade, with the outgoing batch disposed only when the fade completes.
- The `fade` byte in the instance format drives the dither threshold.

**Pin the dither to output resolution.** Governor A's floor is 0.75 after `1A-6b`, so the pattern will not crawl — but the dither must be evaluated against the render target, not the CSS viewport, or a governor step makes it swim.

---

### `2-15` — Procedural rocks and ground clutter (2.25 d) · Class P

Displaced icospheres with **per-lithology flat versus smooth normals** — `RENDERING_PLAN.md` §3.5 notes the shading-model difference reads as lithology more strongly than colour does. Instances aligned ~60% toward the terrain normal, using the quaternion the instance format now carries, and sunk by `radius · (0.12 + 0.25 · hash)` so they sit *in* the ground rather than on it.

**Ground clutter rides the same path (+0.75 d).** Searching the whole plan set for *log, stump, deadfall, fallen, twig, branch-as-debris, root plate* returns nothing: the programme puts no three-dimensional debris on the ground anywhere, which is half of the user's "twigs, mess". Four archetypes, same instanced path, same 32-byte format, same sinking and terrain-normal alignment:

- **Fallen log** — tapered displaced cylinder, ~60 tris, laid flat by the orientation quaternion, moss-weighted on its upper surface.
- **Stump** — short flared cylinder with a splintered top, ~40 tris.
- **Branch litter** — two or three crossed alpha-tested cards from `2-11`'s litter/twig layer, ~8 tris.
- **Moss cushion** — a low displaced dome, ~24 tris, that also sits on rocks.

Density comes from the ecology channels (`6-6`) once they exist and from canopy closure and soil depth before then — clutter belongs under trees and in hollows, not scattered evenly. Budget ~2,000 clutter instances at Balanced (~80 k triangles) against §5.4's vegetation row, funded per §5.3's trade-off rule from stems/ha, not from any fidelity row.

---

### `2-16` — Grass and ground cover (2.0 d) · Class P

Grass as **patches, not blades**: 12–16 crossed tapered blades, ~48 triangles, covering ~2.5 m². A `1/d` density ramp so *screen-space* blade density is roughly constant rather than exploding at the camera. Plus ferns, heather and reeds at ~15% of the budget so the ground is not one uniform green fuzz.

**The archetype mix is habitat-driven, not a flat roll.** A share alone gives the ground layer variable *amount* but uniform *character* — the same 15% sprinkle everywhere. Archetype weights come from the terms the density field already carries: reeds gated on high moisture and near-zero slope, heather on low fertility and exposure, fern on shade and shelter, grass elsewhere. This is what makes a wet hollow and a wind-scoured ridge read as different places rather than the same ground at different densities, and it is the ground-layer half of "overgrown areas".

This closes what the audit calls the single most damaging failure mode: **no scale reference below 7 m on approach**, which collapses speed and height perception on final — the one thing a flight simulator is judged on.

**Grass radius is the first tier knob**, per §5.3 (90 / 150 / 220 / 320 m), because grass is the largest single triangle consumer in the renderer. Exit budget: ≤ 0.9 M triangles at Balanced.

---

### `2-17` — Octahedral impostors (6.0 d) · Class P

Hemi-octahedral 4×4 bake per species with a **three-view barycentric blend**. `RENDERING_PLAN.md` corrected this item from 3 days to 6 for exactly one reason, and it is the reason the item is hard: **view snapping is what makes cheap impostors flicker when the aircraft banks.** A nearest-view impostor is a two-day item that looks wrong in the manoeuvre a flight simulator performs most.

Bake albedo, normal and depth per view. The impostor tier plugs into the third LOD slot that `2-14` created and fades in through the same dither.

**Per-instance silhouette variety, at zero atlas cost (+0.5 d, 6.0 → 6.5).** The bake is per *species*, not per variant — so beyond the card radius, which is where 90% of a forest is seen, `2-12`'s variants disappear and every tree of a species is a clone again. Baking per variant is not affordable (see the budget note below), so the variety comes from the instance instead: the `variant` byte selects a small octahedral view-phase offset and a horizontal mirror of the sampled view, and the billboard quad is scaled anisotropically from `heightScale`/`radialScale` within ±15%.

**Budget note, and it does not currently close.** A 4×4 hemi-octahedral bake over 7 species at 128² with albedo + normal + depth is ~12.2 MiB; `2-18`'s two season buckets double it to ~24.5 MiB, against roughly 15.8 MiB of atlas headroom once `2-11a`'s 12.2 MiB of instances come out of the 28 MiB Balanced vegetation row. Settle it here rather than discovering it at `2-18`: reduce tile resolution before anything else (impostor texels per view is the one fidelity row §5.3's trade-off rule permits cutting, and only at Low — so at Balanced the alternative is fewer species baked with the rest falling back to card LOD, or a smaller impostor radius). Record the measurement in the decision log.

**Exit criteria:** impostor and LOD1 average colour match within a few percent across a full sun sweep — otherwise the LOD transition reads as a brightness pop even when the geometry match is good. And no two impostors of the same species within one screen share both silhouette aspect and view phase.

---

### `2-18` — Seasonal foliage (2.0 d) · Class P

A deciduous leaf-out / leaf-fall curve driving crown tint and alpha; conifers hold. Winter adds slope-weighted snow on canopy and rock. **Species mix stays climatic and does not change with season** — that is a `4-6` classifier concern, not an appearance concern.

Per `ARCHITECTURE.md` §4's threading rule, `dayOfYear` is part of the appearance field's signature from the first line, and the boundary test checks for the environment-clock reference.

**One open decision, to be settled by measurement.** `RENDERING_PLAN.md` asks for the impostor atlas baked per season bucket — 4 buckets × the existing atlas — and flags that the added slots must be checked against the §5.2 ceiling. With `2-11a`'s compact instances there is room, but 4× the impostor atlas is the largest single texture allocation in the vegetation budget. **Recommendation: bake 2 buckets (leafed and bare) and cross-fade between them, and only go to 4 if `assertWithinBudget()` shows headroom at High.** Record the measurement in the decision log.

---

## 10. Verification

### 10.1 Assertions Phase 2 adds

Phase 0 contributed 18 and Phase 1 sixteen more. Phase 2 adds:

| # | Assertion | By | Guards against |
|---|---|---|---|
| 35 | Every `VolumetricCloudConfig` field reaches a shader uniform | `2-0` | §3.2 — a tier table that lies |
| 36 | All three `CLOUD_SHADER_MODULES` compile (GPU) | `2-0` | A Babylon bump silently breaking clouds |
| 37 | Noise volumes are bit-exactly tileable at `u` and `u + 1` | `2-1` | A seam every 128 texels of world space |
| 38 | Dual-lobe HG integrates to 1 over the sphere within 1% | `2-4` | Phase-function energy drift during tuning |
| 39 | Density samples per frame ≤ 40% of the `2-4` baseline | `2-5` | The adaptive march not actually adapting |
| 40 | Cloud target ≤ `maxCloudPixels[tier]` at three viewports | `2-6` | The `1A-6a` failure repeating in the cloud pass |
| 41 | Ocean output byte-identical across the `2-8a` extraction | `2-8a` | A refactor that silently changes shading |
| 42 | Cascade mip N equals the box average of mip N−1 | `2-8` | Storing normals instead of slopes |
| 43 | Selected LOD is continuous across a patch boundary (GPU) | `2-8` | §3.4 — the `fract` seam grid |
| 44 | Mip-generation capability assertion at startup | `2-8` | A Babylon bump breaking the private mip path |
| 45 | Foliage mip-N alpha coverage within 3% of mip-0 | `2-11` | Distant foliage evaporating |
| 45b | Every atlas array layer has a complete mip chain | `2-11` | Babylon mipping only layer 0 (verified, `webgpuTextureManager.js:716`) |
| 46 | Packed instance round-trips through the 32-byte layout | `2-11a` | Silent precision loss in orientation or tint |
| 47 | Instance bytes × instance cap ≤ the §5.2 vegetation row | `2-11a` | Blowing the memory budget with instances alone |
| 48 | Plugin-displaced foliage casts a matching shadow (GPU) | `2-12` | The `0-9` incantation being applied wrongly |
| 49 | Grass triangles ≤ 0.9 M at Balanced | `2-16` | The largest triangle consumer going unbounded |
| 50 | Impostor and LOD1 mean colour within a few % across a sun sweep | `2-17` | A brightness pop at the LOD transition |
| 51 | Every seasonal appearance field takes `dayOfYear` | `2-18` | The `ARCHITECTURE.md` §4 threading rule |

### 10.2 What cannot be asserted, and what replaces assertions

Three of this phase's exit criteria are irreducibly visual: no repeated cloud group over a 200 km leg, cumulus reading as cumulus, and forest reading as forest. There is no test for these.

What replaces a test is a **named flight and a committed screenshot**. Add five fixed captures to `perf:capture` in `2-0` (+0.5 d for the last two, which were added 2026-08-18), and treat them exactly as the terrain baselines are treated: a change is a regression until argued otherwise.

1. **Cruise, sun at 30° off-axis** — cloud shape, silver lining, shadowed sides.
2. **500 ft AGL over closed forest, sun behind** — foliage translucency, grass scale reference, LOD transition band.
3. **Coastline at 10 km slant, low sun** — sun glitter path, foam, aerial perspective across the water/land boundary.
4. **On the ground at the airfield boundary, camera at 2 m, low sun raking across** — grass blade separation, ground-cover archetype mix, clutter bedding, forest-floor litter and moss at 1–5 m, trunk and bark at the range a pilot sees them on rollout. **This is the only capture in the programme taken from the height a person stands at**, and it is the one that would have caught what flight testing caught.
5. **Forest canopy at 1,200 ft, 45° down, mid-morning** — the 1–3 km band where a forest reads as a textured surface rather than individuals, and where clumping, clearings, edge profile and species patchwork either exist or do not.

The 200 km anti-tiling gate is flown, not captured, and its outcome is recorded in the decision log.

### 10.3 Budget rows

Phase 2's three subsystems have rows in `PerformanceBudget.ts` from `1A-2`, so overspend fails `npm test`. Targets at Balanced from §5.4: **clouds 2.2 ms** (phase exit criterion ≤ 2.5), **water 1.6 ms** (ocean pass ≤ 1.8), **vegetation 1.8 ms**. Memory from §5.2: clouds 16 MiB, vegetation 28 MiB.

`2-10` returns 0.5–1.0 ms to the pool before Gate 2C spends it (§4 B7). If the budget still fails at `2-16` or `2-17`, the first knob is grass radius and the second is impostor radius — in that order, per §5.3's tier rules.

---

## 11. Risk register

| ID | Risk | Trigger | Response |
|---|---|---|---|
| **R-2A** | **`2-0` adoption surfaces bugs in never-run code.** 596 lines of `CloudShaders.ts` have only ever been type-checked. | Week 1. | This is the mirror of Phase 0 R-0D, and the same answer applies: it is a benefit, and it is why adoption is scheduled first. Unlike Phase 0, a screenshot baseline now exists, so regressions are visible immediately. Keep the inline shader behind a flag for exactly one commit; delete it once the capture pair passes. If adoption overruns by more than a day, ship the volume-fetch density path alone (the `2-1` payer) and defer the MRT/temporal rework to `2-5`. |
| **R-2B** | **Cloud lighting over-tunes into milk.** `RENDERING_PLAN.md` warns about this explicitly. | Any tuning session in `2-2`/`2-4`. | Fix all phase and MS constants from the literature *first*; expose exactly two knobs (`densityMultiplier`, `extinctionPerMeter`); pin the phase function with assertion 38. If the sky looks flat, the cause is the missing extinction decay in the MS octaves, not the knobs. |
| **R-2C** | **`2-8`'s mip generation depends on Babylon private state.** `engine._textureHelper.generateMipmaps` is not public API, and the storage textures must carry `RENDER_ATTACHMENT` usage. | `2-8`, week 4. | Startup capability assertion in `RenderInvariants.ts` so a Babylon bump fails loudly rather than silently un-mipping the ocean. Documented fallback: a chain of `ProceduralTexture` passes into a mipped RTT. Keep `@babylonjs/core` pinned. |
| **R-2D** | **The `fract` seam grid appears as a consequence of the mip fix** and is misdiagnosed as a mip-chain bug. | `2-8`, immediately after mips land. | Specified up front (§3.4) and guarded by assertion 43. If a grid appears anyway, check the *weather* texture sampler in the cloud shader, which has the same pattern. |
| **R-2E** | **Alpha-tested foliage blows the frame budget.** It defeats TBDR hidden-surface removal and gets no MSAA benefit. | `2-12` or `2-16`, budget assertion fails. | Separate render group after opaque terrain, mandatory. Then grass radius, then impostor radius. Do not reach for alpha blending — it needs sorting this renderer does not do. |
| **R-2F** | **The compact instance format breaks culling or shadow bounds.** | `2-11a`, instances vanish at frustum edges or shadows are missing. | Generator-computed AABB with an explicit wind-extent term (§9 `2-11a` point 2). The `0-9` GPU test is the guard for the shadow half; extend it to a thin-instanced mesh in the same commit. |
| **R-2G** | **`2-17` slips.** It is the largest item in the phase at 6.0 days, it is last, and view-blend correctness is the hard part. | End of week 9 with impostors flickering under bank. | **The phase's designated cut, and it must name the count reduction that pays for it.** Ship LOD1 cards only, **and reduce the vegetation radius and rendered stems/ha in the same commit** so the LOD1 triangle total stays inside §5.4's vegetation row — per §5.3's vegetation trade-off rule, the count moves and the card does not. (Shipping cards to the full 4.5 km radius as originally written is ~84,000 trees at card fidelity, which does not fit and would be paid for in fidelity by whoever executed it.) Record the resulting radius and stems/ha in the decision log. `6-8`'s canopy handoff drops the impostor radius to ~2.5 km anyway, which makes the deferred version cheaper to build. Second cut: `2-18` (2.0 d), whose absence is a missing feature rather than a broken one. |
| **R-2H** | **`2-10` leaves inland water with no reflection source.** | `2-10`, lakes go flat. | The IBL probe from `1C-6` is the replacement and must be verified on the hydrology material *before* the planar system is removed, not after. Keep `acceptsInlandPlanarReflection` and the hysteresis regardless — `5-12` needs them. |
| **R-2I** | **`1C-8`'s Phase 1 cloud work is partly redone at `2-0`.** | Known and accepted. | ~0.25 d, priced into `2-0`. The alternative — moving `1C-8` into Phase 2 — leaves clouds unhazed through all of Phase 1 and breaks that phase's demo state in the most visible part of the frame. |

---

## 12. Exit checklist

**Gate 2A — Clouds**
- [ ] No inline cloud WGSL remains in `VolumetricCloudSystem.ts`; `nature/CloudShaders.ts` is the single owner and `nature/index.ts` is deleted.
- [ ] Every `VolumetricCloudConfig` field reaches a shader uniform.
- [ ] Noise volumes are baked on the GPU at startup and are bit-exactly tileable.
- [ ] Cumulus have flat bases and cauliflower tops; stratus reads as a sheet; type varies across the weather map.
- [ ] A 200 km straight leg at cruise shows no recognisable repeat (flown, recorded).
- [ ] Cloud interiors hold blue skylight; a silver lining appears at the sun-facing edge.
- [ ] Density samples per frame ≤ 40% of the pre-`2-5` baseline.
- [ ] Cloud target respects the per-tier absolute pixel cap.
- [ ] Cloud shadows are 47 m/texel and stay correct at sun elevations below 5°.
- [ ] Cloud pass ≤ 2.5 ms at Balanced, measured by `perf:capture`.

**Gate 2B — Water surface**
- [ ] Ocean output byte-identical across the `2-8a` extraction.
- [ ] `WaterShaders.ts` is the single owner; ocean and hydrology share one BRDF and one sun disc.
- [ ] Cascades store slope; mip N equals the box average of mip N−1.
- [ ] No seam grid at any patch boundary; LOD selection is continuous.
- [ ] The distant sea is smooth and matte; roughness comes from slope variance, not a distance smoothstep.
- [ ] Sun glitter is one coherent path from a solid-angle-correct lobe; no `pow(·, 3200)` or `pow(·, 1800)` remains.
- [ ] Wave crests glow translucent when backlit.
- [ ] The planar reflection system is retired and Governor B's cadence rung with it.
- [ ] Ocean pass ≤ 1.8 ms at Balanced.

**Gate 2C — Living ground**
- [ ] Foliage mip-N alpha coverage within 3% of mip-0 at the shipping threshold.
- [ ] Instances are 32 bytes; the world matrix is built in the vertex shader; bounds come from the generator.
- [ ] Plugin-displaced foliage casts a matching shadow (GPU test).
- [ ] Trees have leaves, generated tangents and rendered trunks with taper, flare and lean; backlit crowns glow; crown interiors are darker than sunlit tips.
- [ ] **Silhouette variety:** across 200 randomly sampled near-LOD trees against sky, no two share both a variant index and a crown width-to-height ratio within 5%.
- [ ] **Colour variety:** per-species hue standard deviation ≥ 4°; neighbouring stands differ in mean hue, not only individuals.
- [ ] **Canopy closure:** over a 2 km × 2 km closed-forest window the rendered instance set reaches ≥ 0.55 mean crown cover, and glades genuinely open rather than thinning.
- [ ] Shrubs are cards, not icospheres, and use the same tint and occlusion treatment as trees.
- [ ] Ground clutter — logs, stumps, branch litter, moss — is present, bedded into the ground, and denser under canopy than in the open.
- [ ] Attribute spectra (species, stand age, height, tint hue) show no peak at 32 m or any other constant period.
- [ ] **Flown:** a 40 km straight leg at 1,500 ft over continuous forest shows no recognisable repeat in canopy pattern, species patchwork or crown colour (recorded in the decision log).
- [ ] Wind moves trunk, branch and leaf on three bands.
- [ ] LOD switches and the cull radius both crossfade; no pop, no crawling dither.
- [ ] Rocks are tilted into the slope, sunk, and shaded flat or smooth by lithology.
- [ ] Grass is present, non-grass ground cover is ≥ 12% of ground-cover instances, screen-space density is roughly constant, ≤ 0.9 M triangles at Balanced.
- [ ] Impostors do not flicker under a full 60° bank; impostor and LOD1 mean colour match across a sun sweep.
- [ ] Deciduous foliage responds to `dayOfYear`; conifers hold; winter snow is slope-weighted.
- [ ] Vegetation pass ≤ 1.8 ms and ≤ 28 MiB at Balanced.

**Phase**
- [ ] User goals **G3** (clouds) and **G4** (vegetation) served; the surface half of **G2** served.
- [ ] `npm run verify` green; `npm run test:gpu` green.
- [ ] Five ownership rows added to `ARCHITECTURE.md`; the boundary test passes.
- [ ] Five new `perf:capture` scenes committed, including the 2 m eye-height and 1,200 ft canopy views; baseline churned at no more than the four sanctioned points (§10.2 plus `2-8`, `2-12`, `2-17`).
- [ ] Decision log complete.

---

## 13. Decision log

| Date | Item | Decision | Measurement / rationale |
|---|---|---|---|
| 2026-08-18 | `2-0` | Adopted wholesale; raymarch converted from the MRT fragment pass to a compute pass writing two rgba16float storage textures. No module was unusable. The adopted `previous_view_projection` motion-vector path was rejected (1A-4 stale-matrix class) — temporal resolve reprojects from the previous ray basis + absolute camera delta. | Assertion 36 compiles/dispatches all three modules on-adapter; assertion 35 proves every config field reaches a uniform block. |
| 2026-08-18 | `2-1` | 128³ rgba8 base (R perlin-worley shape, GBA worley 8/16/32) + 32³ rgba8 erosion, baked on the GPU at startup behind the `whenReadyAsync` gate; weather 512² camera-following window. | Assertion 37: bit-exact tileability on-adapter (1/256-grid coordinates — `u+1` of an arbitrary f32 is itself unrepresentable). Startup bake is three one-off dispatches gated before the first raymarch. |
| 2026-08-18 | `2-4` | MS octaves decay energy, extinction AND phase per order: a = `multipleScatteringFactor` 0.55, b = c = 0.5 (Jarosz/Schneider literature constants, pinned by comment). Knobs stay `densityMultiplier`/`extinctionPerMeter`. Powder is backscatter-gated. | Assertion 38 (HG integral ≈ 1 over the sphere); night ambient path verified by the night capture shot. |
| 2026-08-18 | `2-5` | Empty-space skip + distance-adaptive strides (`stepDoublingDistanceMeters` 4 km) + exact slab-entry start for below-base cameras + ambient-only lighting when sun energy < 1e-3. Coverage prepass stays deferred. | First 2A rebaseline measured the need: slant-10km 32.5 ms GPU p95 (pre-cloud 7.7), night 20.2, ground-2m 23.7. Distance strides + night early-out: slant → 24.8, night → 11.0. Slab-entry start closes the rest (below-base sky rays paid skip strides through provably-empty air). Density-sample counter reads back into `statistics.densitySamplesPerFrame` (assertion 39). |
| 2026-08-18 | `2-8` | Private path, one level up from the plan's candidate: `engine._generateMipmaps(internalTexture)` rather than `_textureHelper.generateMipmaps` — it defaults to the engine's `_renderEncoder`, so the blit records into the same command encoder as the derivation's compute pass, after it (no stale-mip frame), and it closes any open render pass first. Capability assertion: `oceanMipGenerationAvailable` in `RenderInvariants`, probed via `resolveOceanMipGenerator` at renderer startup. No `ProceduralTexture` fallback shipped — the GPU gate proves the path on-adapter. | `tests/gpu/ocean-slope-mips.test.ts`: box-filtered mips verified on the exact texture shape (rgba16float STORAGE RawTexture, mip storage, RENDER_ATTACHMENT force-added by Babylon for renderable 2D formats), plus grad-LOD continuity across the wrap seam with a negative control (fract-side derivatives must break at the seam). |
| — | `2-11a` | Final 32-byte layout, and the orientation quantisation error | *record max angular error from the snorm16 quaternion* |
| — | `2-17` | Three-view barycentric blend, or the deferred cut | *record the flicker test under a 60° bank* |
| — | `2-18` | Season buckets: 2 with cross-fade, or 4 | *record the `assertWithinBudget()` headroom at High* |

### 13.1 Deviations recorded during implementation

Each of these is also carried in `ARCHITECTURE.md`'s decision log with full rationale; this list is the plan-side index.

- **`2-0` (structural):** the raymarch is a compute pass, not the plan's MRT fragment pass — Babylon's compute path binds storage textures directly and no MRT plumbing needs to exist. Scene depth arrives as camera-space Z from a `DepthRenderer` (one frame of clip latency, invisible at cloud distances).
- **`2-3` (stronger than planned):** anti-tiling ships as an endless unwrapped world-cell weather field under a camera-following 512² window, not a toroidal clipmap of a repeating texture — it cannot repeat at any distance. The toroidal-addressing helper the plan earmarked for `5-10` arrives with `5-10`.
- **`2-5` (scope added under the item's own mandate):** distance-adaptive stride growth, exact slab-entry trace start and the night ambient early-out were added when the first sanctioned rebaseline measured sky-heavy shots at 20–32 ms GPU p95. The coverage prepass stays deferred.
- **`2-8a` (verification upgraded):** assertion 41 is a pinned SHA-256 of the composed ocean WGSL rather than a capture diff — two captures of a temporally-jittered volumetric sky are never byte-equal; a text-identical shader is, and it is deterministic. Deliberate shading changes re-pin the hash in the same commit.
- **Gate 2Z (measurement honesty):** one Babylon error signature is allowlisted in the capture gate — the first-frame `cloudShadowSampler … not found in the material context` burst from Babylon 9.21.2's per-submesh WebGPU material contexts on shared materials. The plugin binds a fallback via `hardBindForSubMesh` + `registerForExtraEvents`; the residual burst is SSIM-verified pixel-free. Hitch ceilings sit 2.5–3× above observed headless medians (rAF pacing noise); the resize-path shot runs a 0.975 SSIM threshold against 0.985 elsewhere.
- **Gate 2A re-pin (floors + fps metric):** the per-shot `minFps`/`hitchCount` set was re-pinned at the sanctioned 2A rebaseline from three clean quiet-machine runs (rule documented above `PERF_CAPTURE_SHOTS`), and `minFps` now gates a trimmed sustained rate (`sustainedFpsFromFrameIntervals`, slowest 5% of intervals dropped) instead of a wall-clock mean. Measured cause: identical builds scored 31.1 vs 26.0 on slant-10km because ~1.5 s of sparse stalls inside the 8 s window double-counted into the sustained gate — sparse spikes are what `maxFrameMs`/`p999`/`hitchCount` own. The trimmed metric still fails the one real 2A regression shape (uniformly slow frames trim to the same failing rate — unit-pinned in `tests/perf-capture-metrics.test.ts`). The hitch threshold moved from 2× to 3× the frame target in the same re-pin: a typical Phase-2 headless frame sits near 2× the target, so the 2× threshold counted scheduler jitter around the boundary (57–232 "hitches" per 240 frames on identical builds) instead of stalls. The Z-2 hitch ceilings stay numerically unchanged and therefore hold as loose upper bounds; the next sanctioned rebaseline (2-8) tightens them against 3× data.
- **`R-13` (narrower than a literal reading):** `classifyBiome`/`sampleTerrainTemperature` stay climatic; season enters as an anchored appearance deviation (snow palette, snowline descent, humidity) that is bit-identical at the reference day. Threading the seasonal offset into classification would flip FOREST↔GRASSLAND with the calendar, which `2-18`'s own species rule forbids.
- **Gate 2B close (one added rebaseline):** the gate's sanctioned rebaseline sits at `2-8`, but `2-9`/`2-10` deliberately changed water pixels afterwards (the Karis lobe, lit foam, probe reflections, the retired mirror) — a capture that cannot pass SSIM against pre-`2-9` water gates nothing. One additional rebaseline runs at the gate close so Gate 2C starts from gates that describe the shipped water. The worst-frame/p999 spike ceilings moved 1000 → 1500 ms at the same close: the diagnostic ring deliberately includes each shot's teleport/re-stream stall (`max == p999` single-outlier structure on every shot), and the clean-run family now spans 250–1084 ms — the round 1000 no longer clears it, while 1500 still catches order-of-magnitude pathology and the hitch/fps gates own everything sustained. A cautionary measurement note recorded with it: one hot run (captured minutes after a ~1M-token agent workflow) showed a fleet-uniform −8 fps / +4–8 ms GPU regression including water-free shots — thermal throttling, not the diff; captures on the M-series reference machine need a cool, idle box.
- **`2-9` (three calls made):** the 2-8a sun-disc divergence (3200×16 vs 1800×11) is resolved by DELETION — the analytic `reflectedSky` is fallback-only sky colour and the sun's reflection is solely the shared Karis lobe. The IBL hookup the item assumes is explicit: raw `ShaderMaterial`s never see `scene.environmentTexture` (the R-2H risk), so the renderer binds the probe RTT to both water materials directly, with a 1×1 fallback cube keeping WebGPU materials ready pre-probe. R-24 is implemented as the realignment words it (a maximum terrain grade above which **no ribbon is emitted** — downstream-run truncation or full cull, behavior-pinned) rather than the surface-profile clamp a looser reading suggests, and `maximumRivers` drops 10 → 7.

---

## Appendix A — File manifest

**New (7)**
`src/render/webgpu/clouds/CloudVolumeBake.ts` · `src/render/webgpu/clouds/CloudWeatherMap.ts` · `src/render/webgpu/water/WaterShaders.ts` · `src/render/webgpu/detail/instanceFormat.ts` · `src/render/webgpu/detail/DetailInstanceMaterialPlugin.ts` · `src/render/webgpu/detail/FoliageAtlas.ts` · `src/render/webgpu/detail/ImpostorAtlas.ts`

**Promoted from dead to live (1)**
`src/render/webgpu/nature/CloudShaders.ts` — 596 lines, previously imported only by an unimported barrel

**Substantially modified (8)**
`clouds/VolumetricCloudSystem.ts` (inline WGSL deleted, adopted modules wired, MRT path, shadow rework) · `clouds/CloudShadowReceiver.ts` (projection basis) · `nature/CloudConfig.ts` (every field bound) · `water/SpectralOceanSystem.ts` (slope storage, mips, `textureSampleGrad`, shared helpers) · `water/HydrologySystem.ts` (shared helpers, constants reconciled) · `detail/WorldDetailRuntime.ts` (instance format, three LOD tiers, two-LOD residency, card trees, grass, rocks, impostors) · `detail/types.ts` (orientation, LOD tiers, fade) · `detail/DetailWindMaterialPlugin.ts` (absorbed into the instance plugin; GLSL branch deleted)

**Deleted**
`nature/index.ts` (zero importers) · `CLOUD_RUNTIME_DENSITY_WGSL`, `CLOUD_INTEGRATION_FRAGMENT_WGSL`, `CLOUD_RUNTIME_SHADOW_FRAGMENT_WGSL` (inline, superseded) · `PlanarWaterReflectionSystem` render path (`acceptsInlandPlanarReflection` and hysteresis retained) · `createTreeCrown`'s cone/icosphere prototypes · the `DetailWindMaterialPlugin` GLSL branch

**Explicitly untouched in Phase 2**
Terrain geometry, LOD and material (Phases 3–5) · bathymetry, river geometry and water depth optics (Phase 5) · `world/payload.ts` and the page atlas (Phase 4) · the canopy/terrain splat handoff (`6-8`) · night lighting and the airfield (Phase 7)

## Appendix B — Where Phase 2 sits against the audit

| Audit finding | Phase 2's contribution |
|---|---|
| §3.4 clouds — analytic density, no weather map, no vertical profile, no MS | Closed by `2-0` … `2-5` |
| §2.5 water and clouds receive no aerial perspective | Closed in Phase 1 (`1C-4`, `1C-7`, `1C-8`); Phase 2 preserves it through the shader adoption |
| §3.3 distant sea boils; sun glitter is a sparkle field | Closed by `2-8`, `2-9` |
| §3.5 vegetation is opaque cones; no ground cover; 176 m lattice | Placement closed in Phase 1 (`1B-7` … `1B-9`); appearance closed by `2-11` … `2-18` |
| §1 "no scale reference below 7 m on approach" | Closed by `2-16` |
| The institutional finding — a specified architecture shipped alongside an ad-hoc path | **Second instance found and closed** (`2-0`), and the ownership rows that would have caught it are added (§5) |
