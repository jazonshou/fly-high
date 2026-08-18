# Phase 3 Execution Plan — Terrain Surface and the Runway

**Status:** execution reference for Phase 3 of `RENDERING_PLAN.md`. It does not restate that plan; it decides everything that plan leaves to implementation time, against the codebase as it will exist when Phase 3 starts.
**Runs after:** `PHASE_2_EXECUTION_PLAN.md`. Phase 2's exit criteria are this plan's preconditions.
**Basis:** `TERRAIN_AUDIT.md` §2.1 (root cause #1), `RENDERING_PLAN.md` §2 Phase 3 / §3.2 / §5.2–§5.4 / §6 / §7, and `ARCHITECTURE.md` (normative, from Phase 0).
**Verified against:** the Phase 1 branch at `9e1e04d`, plus `@babylonjs/core` 9.21.2 as installed. Every file, line, shipped-shader and Babylon-internal claim below was re-checked in the current tree.
**Effort:** **30.25 days** (was 29.75), ~6.7 calendar weeks at 4.5 productive days/week. (29.5 in `RENDERING_PLAN.md`; +0.25 net at §4, +0.5 at `R-26`.)
**Engine:** Babylon `@babylonjs/core` 9.21.2, WebGPU. No engine or API change is in scope, considered, or permitted.

> **Amended 2026-08-18 by [`PRE_PHASE_4_REALIGNMENT.md`](PRE_PHASE_4_REALIGNMENT.md) §7, which is binding over this file where they differ.** In brief:
>
> - **`3-10` moves to immediately after `3-2`.** It needs only the arrays and the plugin; leaving it last makes the user's second-ranked goal the first thing sacrificed to a slip in `3-9`. Zero days. `R-14`.
> - **New: retire the light-rig palette (+0.5 d), adjacent to `3-10`.** Deviations `D-6` (SH below-horizon floor 0.25) and `D-9` (the palette surviving for the light rig) are ground-bounce fakes tuned against a ground colour this phase replaces; once real albedo exists they double-count, and G-B's seasonal ground albedo fights a hardcoded floor. `R-26`.
> - **`3-2`'s provisional splat path is fed by the classifier the audit indicts.** Between this phase closing and `4-6`, ten well-synthesised materials are selected by the 8-bit per-vertex threshold cascade that puts 41–50% of adjacent vertex pairs in different biomes past 5 km. State it as a known interim; the boundary quality is `4-6`'s to close. `R-25`.
> - **Decide the classifier-consumers contract before Phase 4 starts.** `chooseTreeSpecies`, `chooseShrubSpecies` and the wildlife habitat rules all read `classifyBiome`; after `4-6` the ground and the forest on it would be classified by two disagreeing authorities. `R-27`.
> - **The seasonal snowline is a kernel change, not a palette change** — `seasonalTemperatureOffsetK` threaded into `sampleTerrainTemperature`/`classifyBiome`, landed in Phase 2 so this phase inherits it free. `R-13`.
> - **Gate A (12.75 d) runs immediately after this phase** — the aircraft and the wildlife, which have no appearance work anywhere in the programme, built on `3-1`'s synthesis pipeline. `R-1`.

---

## 0. What this document adds

Phase 3 closes the audit's **first and largest root cause**: *there is no surface material system. Not a weak one — none.* Everything the terrain looks like today comes from an 8-bit per-vertex colour chosen by a threshold cascade, which past 5 km flips between neighbours 41–50% of the time — the value you get from independent random draws.

This document decides how that gets fixed, in the order the work is actually done:

1. **What the codebase actually is** (§3), now that Phase 1 has landed. The terrain material has grown a plugin stack, the budget contract has a hole in it, and two of the plan's Babylon anchors are wrong — one of them unreachable for this material.
2. **Seven amendments** (§4). One adds an item, one deletes work the plan schedules, and two correct anchors that would each cost half a day of confusion.
3. **The surface contract** (§5) — ten material identities and their constants, landed as a tiny reviewable commit before the seven-day synthesis item, because seven later consumers depend on it.
4. **A work order with a week ledger** (§6), and item-by-item detail (§7–§9).
5. **Verification** (§10), a **risk register** (§11), and an **exit checklist** (§12).

Read §3 and §4 before writing any code.

---

## 1. Preconditions

Phase 2's exit criteria are this plan's preconditions. Phase 3 depends on six things specifically, five of which already exist on the Phase 1 branch and one of which Phase 2 builds:

| Needed by | Precondition | From | Status |
|---|---|---|---|
| `3-7` | `scene.environmentTexture` non-null, `REFLECTION` defined, `specularIntensity = 1`, `environmentIntensity = 1` | `1C-6` | **Landed** — verified at `TerrainClipmapSystem.ts:321,323` |
| `3-2` | The aerial-perspective plugin owns `CUSTOM_FRAGMENT_BEFORE_FRAGCOLOR` on the terrain material and must keep it | `1C-4` | **Landed** — `AerialPerspectiveMaterialPlugin`, priority 205 |
| `3-10` | `EnvironmentClock` is a live rendering input; `presetFor()` deleted | `1C-1`, `1C-9` | **Landed** — `nature/EnvironmentDirector.ts` |
| `3-1`, all | `PerformanceBudget.assertWithinBudget` fails CI on overspend; `perf:capture` baselines committed | `1A-2`, `1A-1` | **Landed** — `tests/perf/baseline/` |
| `3-2`, `3-8` | Band-limited kernel with `filterWidthMeters` threaded; grid normals | `1B-1`, `1B-2` | **Landed** |
| `3-1` | `TextureArrayMips.ts` — the CPU array-mip reducer | **Phase 2 `2-11`** | Planned |

Two standing conditions carry forward: **Babylon stays pinned at `9.21.2`** — Phase 3 injects code by regex into its shipped WGSL, which is minified and unversioned — and **one branch per gate** (`phase3/gate-3a`, `-3b`, `-3c`).

---

## 2. The engineering standard, applied to Phase 3

The lifetime classification carries forward: **P** permanent, **K** kernel, **T** transitional, **D** disposable.

Phase 3 is almost entirely **Class P**. The material arrays, the surface plugin, the sampling stack and the runway surface are all still running in Phase 7; nothing here is rebuilt by a later phase. Two exceptions, and they pull in opposite directions:

- **`3-2`'s provisional splat path is Class T.** It exists only until `4-6` rasterises real splat pages. Give it the minimum that makes the phase shippable (§7 `3-2`), and do not generalise it.
- **`3-8` is Class K, and that is the sharp edge of this phase.** The runway earthworks modifies terrain *height*, which is the physics authority until `5-2`. It is the only Phase 3 item that can break the flight model, and §3.4 shows it does so in a way the plan does not anticipate.

**The two tuning knobs for this phase are the height-blend transition depth `d` and the de-tiling warp amount.** Everything else — the ten materials' BRDF constants, the tiling periods, the triplanar threshold, the Toksvig term — is fixed in the contract (§5) and pinned by a test. Ten hand-tuned material recipes are the largest unfalsifiable surface in the programme, and §11 R-3A is about exactly that.

---

## 3. What the codebase actually is

Five findings. The fourth is the one that can break the aircraft.

### 3.1 The terrain material is now a plugin stack, and Phase 3 would make it four deep

Phase 1 did not touch `TerrainMaterialPlugin.ts` — it is unchanged since before Phase 0. But it added neighbours. The terrain `PBRMaterial` now carries three plugins:

| Plugin | Priority | Hook | Writes |
|---|---|---|---|
| `TerrainMaterialPlugin` | 180 | `CUSTOM_FRAGMENT_BEFORE_LIGHTS` | `surfaceAlbedo`, `normalW` |
| `CloudShadowMaterialPlugin` | — | `CUSTOM_FRAGMENT_BEFORE_FINALCOLORCOMPOSITION` | final colour |
| `AerialPerspectiveMaterialPlugin` | 205 | `CUSTOM_FRAGMENT_BEFORE_FRAGCOLOR` | final colour |

`3-2` adds a fourth that writes `surfaceAlbedo` and `normalW` — the same two variables `TerrainMaterialPlugin` writes — with composition order decided by an implicit priority number and nothing documenting the dependency.

**Design change: absorb, do not add.** `TerrainSurfacePlugin` supersedes `TerrainMaterialPlugin` and owns the whole of terrain surface appearance: albedo, normal, roughness, AO, micro-detail. Rationale:

- Both plugins answer the same question. Splitting the answer across two files whose composition depends on an undocumented priority is precisely the class of fragility this programme keeps finding.
- **`3-3 microdetail-fix` is entirely about `TerrainMaterialPlugin`'s three defects.** If the surface plugin owns micro-detail, `3-3` is a sub-step inside one file rather than a negotiation between two.
- §3.2 already has the surface plugin doing "footprint from `dpdx/dpdy`" and "texture-sourced detail" — that *is* the micro-detail path. Two owners of it is a duplication waiting to drift.
- `ARCHITECTURE.md`'s single-owner machinery wants one row per artifact. "Terrain surface appearance" should be one file.

`TerrainMaterialPlugin.ts` and `tests/render.webgpu-terrain-material.test.ts` are deleted; the useful assertions migrate.

**The three defects `3-3` inherits**, all verified present in the current file:

1. `let terrainMicroWeight = 1.0 - smoothstep(1200.0, 4200.0, terrainCameraDistance);` — micro-detail switches **off** at exactly the distance where the audit measures vertex normals to be worst.
2. `terrainTangent * 0.38` — a **forward** difference at a fixed 0.38 world metres against a noise field at `* 0.72` (a 1.39 m cell). That is 0.27 of a cell, one-sided: it is not measuring a gradient.
3. A dead GLSL branch, ~90 lines. The renderer is WebGPU-only; it has never executed.

### 3.2 The plan's roughness anchor is right and its AO anchor is unreachable

`RENDERING_PLAN.md` §3.2 says to inject roughness and AO by `!regex` against `pbr.fragment.js:240` and `:245`. Reading the shipped WGSL in the installed 9.21.2:

**Line 240 — correct, and as gnarly as promised:**

```wgsl
var microSurface: f32=reflectivityOut.microSurface;var roughness: f32=reflectivityOut.roughness;var diffuseRoughness: f32=reflectivityOut.diffuseRoughness;
```

Three declarations, one line, minified, no spaces around `=`. Anchor tightly. Note `diffuseRoughness` sitting right there — that is `3-7`'s Oren-Nayar term, and `BASE_DIFFUSE_ROUGHNESS` is confirmed supported in `Materials/PBR/pbrBaseMaterial.pure.js`.

**Line 245 — wrong. It is unreachable for this material:**

```wgsl
#if defined(METALLICWORKFLOW) && defined(REFLECTIVITY) && defined(AOSTOREINMETALMAPRED)
aoOut.ambientOcclusionColor=reflectivityOut.ambientOcclusionColor;
#endif
```

The terrain material binds no reflectivity texture, so `REFLECTIVITY` is never defined and that line never enters the compiled shader. An injection anchored there matches nothing, and — because a `!regex` replacement that matches nothing is silent — **AO would appear to be wired and simply never apply.**

**The reachable anchor is the `ambientOcclusionBlock` call**, unguarded at lines 165–175:

```wgsl
#define CUSTOM_FRAGMENT_BEFORE_LIGHTS
var aoOut: ambientOcclusionOutParams;
#ifdef AMBIENT
var ambientOcclusionColorMap: vec3f=TEXRD(...);
#endif
aoOut=ambientOcclusionBlock(
#ifdef AMBIENT
ambientOcclusionColorMap,
uniforms.vAmbientInfos
#endif
);
```

Inject after the `);` that closes it. This also confirms the plan's other claim from the opposite direction: `CUSTOM_FRAGMENT_BEFORE_LIGHTS` is emitted at line 164, one line *before* `aoOut` is declared — so the standard hook genuinely cannot set AO, and regex injection is not a preference.

### 3.3 The budget contract has a hole exactly where Phase 3 spends

`PerformanceBudget.ts` estimates memory as `framebuffersMiB + shadowsMiB + oceanMiB + cloudsMiB + terrainGeometryMiB + detailMiB + miscMiB`. **There is no material-array row.** §5.2 budgets the two `Texture2DArray`s at 5.4 / 56 / 56 / 114 MiB across the four tiers — at Balanced that is over a tenth of the 480 MiB ceiling, invisible to the contract Phase 1 built to catch precisely this.

`WebGpuQualityProfile` likewise has no material fields. §5.3 needs three — `materialArrayEdge` (256/512/512/1024), the triplanar mode, and the height-blend material cap (2/3/4/4) — and `ARCHITECTURE.md`'s **tier rule** forbids the alternative: *"Subsystems contribute data fields to `WebGpuQualityProfile`; they do not branch on `profile.tier` with their own constant tables."*

Both go in `3-0` (§5), before anything reads them.

Worth doing the arithmetic now, because it changes a Phase 2 decision. Two arrays × 10 layers × 512² × 4 B = 20.97 MiB; with a full mip chain, ×1.333 ≈ **28 MiB at Balanced** — comfortably under §5.2's 56 MiB row. That headroom is what `3-10` and Phase 2's `2-18` are competing for, and `assertWithinBudget()` is the arbiter rather than the table.

### 3.4 `3-8`'s runway crown breaks the collision fast path

This is the finding that matters most, and the plan does not contain it.

`3-8 runway-earthworks` specifies a **0.35 m crown** — a runway is cambered so water sheds. But the physics fast path is:

```ts
// src/world/terrain.ts
if (world.airport && getAirportInfluence(world.airport, x, z) >= 1) {
  return world.airport.elevation;
}
```

and `sampleTerrainCollision` returns before any height sampling on the runway branch. **Inside the apron, collision returns a flat plane at `airport.elevation`.** Add a crown to the rendered surface and the two disagree by up to 0.35 m across the runway — the aircraft touches down on a surface that is not the one on screen, worst at the edges where a crosswind landing puts you.

That is a direct violation of `ARCHITECTURE.md` §3: *"The surface the aircraft touches and the surface on screen are produced by the same authority."* And Phase 0's invariant test **would not catch it**, because that test asserts `getAirportInfluence == 1.0` across the apron — which stays true. The influence is fine; the height behind it is what changes.

**Design change, three parts:**

1. The earthworks profile is a named function, `runwayEarthworksHeight(airport, x, z)`, in `src/render/webgpu/terrain/RunwayEarthworks.ts` — the file `ARCHITECTURE.md` already reserves for `3-8`.
2. **The collision fast path calls it.** `sampleTerrainCollisionHeight`'s short-circuit returns `airport.elevation + runwayEarthworksHeight(...)`, not the bare elevation. The fast path stays fast — it is still one analytic evaluation with no noise — but it is no longer a lie.
3. **A fifth invariant test joins the four in `tests/sim.terrain-authority.test.ts`:** collision height inside the apron equals the rendered earthworks profile to within 1 mm.

**And the geometry works out**, which is worth checking before committing to painting the runway rather than meshing it (§3.5). A crowned runway is a shallow parabola: `y'' = −8c/w² = −8(0.35)/45² = −1.38 × 10⁻³ m⁻¹`. Chord error over a span `h` is `|y''|h²/8` — **11 mm at 8 m vertex spacing, 44 mm at 16 m.** The coarse terrain mesh represents the crown to well inside landing-gear tolerance, so no special tessellation is needed under the airport. That was not obvious and it removes an item the plan might otherwise have needed.

### 3.5 Terrain needs UVs but does not need tangents

§3.2 lists a "blocking prerequisite: the terrain has no UVs" and §3.5 separately notes that generated tangents "do not exist anywhere in this codebase, and without which Babylon's `NORMALMAP` path is unreachable." It is easy to read those together and generate tangents for terrain. **Don't.**

The surface plugin writes `normalW` directly — as `TerrainMaterialPlugin` already does — and never enters Babylon's `NORMALMAP` path at all. The tangent frame it needs is the one implied by the planar XZ projection of its own UVs, which is analytic and free: `T = (1,0,0)`, `B = (0,0,1)` in world space, flipped per plane in the triplanar branch. A vertex tangent attribute would be memory and bandwidth spent on a code path that is never compiled.

Tangents remain a genuine prerequisite for Phase 2's `2-12` card trees, which *do* use `NORMALMAP`. Different subsystem, different answer.

---

## 4. Amendments to `RENDERING_PLAN.md` Phase 3

Seven. Net **+0.25 days**.

### C1 — `TerrainSurfacePlugin` absorbs `TerrainMaterialPlugin`; `3-3` becomes a sub-step

Per §3.1. One owner for terrain surface appearance, one file, one ownership row. `3-3`'s three fixes become work inside it rather than a cross-plugin negotiation.
**Cost:** `3-2` 4.0 → 4.25 (absorption, deletion, test migration); `3-3` 1.0 → 0.75. **Net 0.0.**

### C2 — `3-1`'s mip reduction is CPU, and the GPU per-layer loop leaves Phase 3

`RENDERING_PLAN.md` §7 R6 flags that Babylon mips only layer 0 of a 2D array. Verified precisely: `Engines/WebGPU/webgpuTextureManager.js:716` signs `generateMipmaps(gpuOrHdwTexture, mipLevelCount, faceIndex = 0, commandEncoder)` and builds its render pass with `baseArrayLayer: faceIndex`, while `Engines/thinWebGPUEngine.js:90` and `:93` both pass a hardcoded `0`. (The plan cites `webgpuTextureHelper.js` — the file is `webgpuTextureManager.js` in 9.21.2.)

R6 already says to implement the CPU path first. Go further: **make it the only path in Phase 3.** The reduction is a one-time startup cost (§6 row 10: ~3 ms, once, on seed change) that appears on no frame budget. Spending days on a GPU optimisation for that, against a known-broken Babylon path, is the definition of the quick fix that costs more than it saves.

`3-1` reuses `TextureArrayMips.ts` — the module Phase 2 `2-11` builds for the same limitation with a coverage-preserving reducer — supplying a **Toksvig** reducer instead. GPU synthesis of mip 0 is unaffected and stays.
**Cost:** `3-1` 8.0 → 7.0. **Net −1.0.**

### C3 — Correct the AO injection anchor

Per §3.2. The plan's `:245` sits inside `#if defined(METALLICWORKFLOW) && defined(REFLECTIVITY) && defined(AOSTOREINMETALMAPRED)` and never compiles for this material; a `!regex` that matches nothing fails silently, so AO would look wired and never apply. Anchor instead on the `);` closing `aoOut=ambientOcclusionBlock(` at ~175. The roughness anchor at `:240` is correct as written.
**Cost 0.0** — and roughly half a day of confusion avoided.

### C4 — No tangent generation for terrain

Per §3.5. Build the tangent frame analytically from the planar XZ projection. **Cost 0.0**, prevents wasted work and a per-vertex attribute.

### C5 — `3-8` is a Class K change to the physics authority, and the crown must reach collision

Per §3.4. The earthworks profile becomes a shared function called by both the renderer and `sampleTerrainCollisionHeft`'s fast path; a fifth invariant test joins `tests/sim.terrain-authority.test.ts`; and because `4-9` transliterates the profile into WGSL, it is written to the `0-4` portability contract from the first line — `max(0, …)` under every `pow`, wrap-safe coordinates, f32-reproducible.

**Merge discipline:** `3-8` does not share a commit with any rendering change, mirroring R-0E's rule for `sim.flight.test.ts`.
**Cost:** `3-8` 2.5 → 3.0. **Net +0.5.**

### C6 — New item `3-0 surface-contract` (0.75 d)

Per §3.3 and §5. Ten material identities, their tiling periods and BRDF constants, the two array layouts, three `WebGpuQualityProfile` fields, the `materialArraysMiB` budget row, and the ownership rows — landed as one small reviewable commit **before** the seven-day synthesis item.

**Why it earns its own item.** The material ID list has seven consumers: `3-1` synthesis, `3-2` plugin bindings, `3-6` height blend, `3-7` per-material BRDF, `3-9` runway materials, `3-10` seasonal palette, and Phase 4's `4-6` classifier. An enum with seven consumers that is invented halfway through an eight-day item gets invented seven times. This is the same "separate the contract from the behaviour" move that made `0-4` work.
**Cost:** **+0.75.**

### C7 — `3-9` writes the airport SDF as a verified transliteration

`roundedRectangleSignedDistance` already exists at `src/world/airport.ts:57` and `3-9` needs it in WGSL. Rather than a second implementation, transliterate it under the `0-4` contract and add a TS/WGSL agreement test — the same pattern `1C-4` used for the aerial-perspective mirror, and the same defence against the drift that gave the ocean and hydrology two different sun discs.
**Cost 0.0** — inside `3-9`'s 5.0.

### Amended ledger

| Gate | Items | `RENDERING_PLAN.md` | This plan |
|---|---|---|---|
| 3A — The surface system | `3-0` `3-1` `3-2` `3-3` | 13.0 | **12.75** |
| 3B — Sampling and shading | `3-4` `3-5` `3-6` `3-7` | 7.0 | **7.00** |
| 3C — The runway and the seasons | `3-8` `3-9` `3-10` | 9.5 | **10.00** |
| **Phase 3** | | **29.5** | **29.75 d ≈ 6.6 weeks** |

---

## 5. The surface contract (`3-0`)

`src/render/webgpu/terrain/surfaceMaterials.ts`, Class P, no Babylon import, ~120 lines.

```ts
export const enum SurfaceMaterial {           // index into both texture arrays
  Grass = 0, DryGrass, ForestFloor, Shrub, Sand,
  Gravel, Rock, Snow, Asphalt, Concrete,      // 10 total
}

export interface SurfaceMaterialSpec {
  readonly id: SurfaceMaterial;
  readonly tilingPeriodMeters: number;   // pairwise co-prime — see below
  readonly roughness: readonly [number, number];  // min, max before variance
  readonly diffuseRoughness: number;     // Oren-Nayar, 3-7
  readonly f0: number;
  readonly seasonal: boolean;            // 3-10; rock and asphalt are false
  readonly triplanar: boolean;           // rock and gravel project triplanar
}
export const SURFACE_MATERIALS: readonly SurfaceMaterialSpec[];
```

**Tiling periods.** §3.2 fixes eight — grass 2.4, forest floor 3.1, scree/gravel 3.7, sand 4.3, rock 5.7, snow 6.9, asphalt 7.4, concrete 9.1 m — so that no two layers repeat in phase. Dry grass and shrub are chosen at `3-0` under the same constraint, and the constraint becomes assertion 52 rather than a comment.

**Array layouts**, fixed here and consumed by `3-1` and `3-2`:

| Array | R | G | B | A |
|---|---|---|---|---|
| A — albedo/height | albedo.r (linear) | albedo.g | albedo.b | surface height |
| B — normal/material | normal.x | normal.y | roughness | cavity AO |

Ten layers each, `materialArrayEdge` per tier, full mip chain from `TextureArrayMips`.

**Alignment with the page contract, checked.** `world/payload.ts` declares `WORLD_PAGE_MATERIAL_CHANNELS = 4` and `QuantizedMaterialPage { materialIds: Uint16Array, weights: Uint8Array }`. Ten materials with a top-4 splat fits exactly, and §5.3's height-blend cap of 2/3/4/4 sits inside it. `4-6` inherits this enum rather than defining its own — that is the whole point of landing it now.

**Also in `3-0`:** `materialArrayEdge`, `triplanarMode` and `heightBlendMaxMaterials` on `WebGpuQualityProfile`; `materialArraysMiB` in `estimateGpuMemory`; and three ownership rows.

| Artifact | Owner | Definition site | Lands at |
|---|---|---|---|
| Surface material contract | terrain-material | `terrain/surfaceMaterials.ts` | `3-0` |
| Terrain surface plugin | terrain-material | `terrain/TerrainSurfacePlugin.ts` | `3-2` |
| Runway earthworks profile | terrain-material | `terrain/RunwayEarthworks.ts` | `3-8` *(row already reserved)* |

---

## 6. Work order

### 6.1 Dependencies

```
3-0 ──→ 3-1 ──→ 3-2 ──→ 3-3
                 │
                 ├──→ 3-4
                 ├──→ 3-5 (also needs 3-1)
                 └──→ 3-6 ──→ 3-7 (hard gate: 1C-6, landed)
                              │
3-8 (independent) ──→ 3-9 ────┤
                              └──→ 3-10 (also needs 1C-9, landed)
```

`3-8` depends on nothing inside Phase 3 and can be pulled forward from anywhere — useful, because it is the item most likely to surface a physics problem and the one whose failure is most expensive to discover late. **If Gate 3A slips, run `3-8` in the gap rather than idling.**

### 6.2 Gate order

**3A the surface system → 3B sampling and shading → 3C the runway.** The reason is that 3B is meaningless without arrays to sample and a plugin to sample them from, and 3C's runway surface is drawn *by* the surface plugin — `3-9` paints into the same shader that `3-2` builds. Doing the runway first would mean building it twice.

### 6.3 Week ledger — 4.5 productive days per week

| Week | Days | Work | Cumulative |
|---|---|---|---|
| 1 | 0 → 4.5 | `3-0` surface contract (0.75) · `3-1` material synthesis (3.75 of 7.0) | 4.50 |
| 2 | 4.5 → 9.0 | `3-1` finish (3.25) · `3-2` surface plugin (1.25 of 4.25) | 9.00 |
| 3 | 9.0 → 13.5 | `3-2` finish (3.0) · `3-3` micro-detail (0.75) → **Gate 3A closes, d12.75** · `3-4` de-tiling (0.75 of 1.5) | 13.50 |
| 4 | 13.5 → 18.0 | `3-4` finish · `3-5` triplanar (2.5) · `3-6` height blend (1.0) · `3-7` start | 18.00 |
| 5 | 18.0 → 22.5 | `3-7` per-material BRDF finish → **Gate 3B closes, d19.75** · `3-8` runway earthworks (2.75 of 3.0) | 22.50 |
| 6 | 22.5 → 27.0 | `3-8` finish · `3-9` runway surface (4.25 of 5.0) | 27.00 |
| 7 | 27.0 → 29.75 | `3-9` finish (0.75) · `3-10` seasonal palette (2.0) → **Gate 3C / Phase 3 closes, d29.75** | 29.75 |

---

## 7. Gate 3A — The surface system (12.75 d)

**Goal.** Close audit root cause #1. The terrain stops being an airbrushed wash of eight hues; grass, rock, scree, sand and snow acquire real sub-metre structure.

---

### `3-0` — Surface contract (0.75 d) · Class P

§5. Ten material identities and constants, two array layouts, three profile fields, one budget row, three ownership rows. One reviewable commit, no behaviour.

---

### `3-1` — Material array synthesis (7.0 d) · Class P

**Ten procedurally synthesised land-cover materials into two `Texture2DArray`s.** GPU compute for mip 0, following the `SpectralOceanSystem` pattern (`createCompute`, explicit `bindingsMapping`, `fastMode = true` after a compile barrier); CPU reduction for the mip chain (C2).

**The debug viewer is built on day one, not last.** `RENDERING_PLAN.md` says so explicitly and it is the difference between tuning ten recipes against reference photographs and tuning them by flying around hoping. Budget half a day of the seven for it.

**Every noise primitive must be periodic on the texture's cell grid** — wrap cell indices modulo the octave frequency, exactly as the deleted `periodicNoise01` did and exactly as Phase 2's `2-1` cloud volumes require. A material that does not tile is worse than no material.

**Two recipe details carry disproportionate weight**, per §3.2:

- **Rock.** Two directional fracture families as half-plane bands at ±dip with per-block random phase — this is what makes rock read as bedding and jointing rather than crumple — plus roughness 0.45–0.72 **with ±0.08 variance per block**. Adjacent blocks having visibly different gloss is by itself most of the difference between rock and plastic.
- **The mip reducer.** Average the normal *vector*, renormalise, and fold the lost length back into roughness with a Toksvig term: `rough' = sqrt(rough² + k·(1 − |avgN|))`. Five lines, and the single most important anti-plastic measure at distance — without it, distant terrain gets a false sharp highlight from a normal map that has been averaged into flatness.

**Normalise every material's height channel to mean 0.5** in synthesis, or `3-6`'s height blend has one layer permanently dominating. Assertion 53.

**Memory:** 28 MiB at Balanced by the arithmetic in §3.3, against §5.2's 56 MiB row. Add `materialArraysMiB` (from `3-0`) and check it.

---

### `3-2` — Terrain surface plugin (4.25 d) · Class P

`src/render/webgpu/terrain/TerrainSurfacePlugin.ts`, superseding `TerrainMaterialPlugin.ts` (C1).

**Construction.** `enable = false` at construction, as `CloudShadowMaterialPlugin` does, so a shader is never compiled with unbound samplers.

**Injection.** Roughness by `!regex` against the minified triple-declaration at `pbr.fragment.js:240`; AO after the `);` closing `aoOut=ambientOcclusionBlock(` at ~175 (C3, §3.2). Albedo and normal from `CUSTOM_FRAGMENT_BEFORE_LIGHTS`, which is where `TerrainMaterialPlugin` already writes them. **The compile-time assertion test (57) is the only thing that will catch a Babylon bump silently reverting roughness to 0.93** — write it in the same commit.

**Bindings.** A texture needed in both stages must be declared in **both** `CUSTOM_VERTEX_DEFINITIONS` and `CUSTOM_FRAGMENT_DEFINITIONS` — `getSamplers` has no `shaderType` parameter, so visibility is derived from where the declaration is emitted.

**UVs, not tangents** (C4). Derive UVs in the plugin from `terrainAbsolutePosition.xz` — the variable `TerrainMaterialPlugin` already constructs from `vPositionW` plus `terrainWorldOrigin` — and build the tangent frame analytically.

**Shadows.** The plugin participates in the vertex stage only to pass the splat attribute through. It does **not** displace, so the depth pass is unaffected and **no `ShadowDepthWrapper` is needed in Phase 3**. `4-4` adds displacement and must add the wrapper then, per the `0-9` incantation in `ARCHITECTURE.md`. Stating this prevents someone attaching a wrapper prematurely and prevents someone forgetting it later.

**The provisional splat path, and what it actually is.** `TerrainClipmapSystem.ts:663` allocates `new Float32Array(vertexCount * 4)` and assigns it as `vertexData.colors` at `:736`, with `useVertexColors = true` at `:740`. Repurpose the buffer and set `useVertexColors = false`.

Until `4-6` rasterises real splat pages there are no per-texel material IDs, so the provisional encoding is a **two-material vertex blend**: `(materialIdA, materialIdB, weightB, spare)`. That is not a compromise dressed up — §5.3 sets the height-blend cap to **2 at tier 0**, so the provisional path *is* the Low-tier path, and it ships unchanged. `4-6` upgrades tiers 1–3 to the 4-way page splat that `world/payload.ts` already specifies.

**Delete** `TerrainMaterialPlugin.ts`, its test, and the dead GLSL branch.

---

### `3-3` — Micro-detail fix (0.75 d) · Class P, inside `TerrainSurfacePlugin`

The three defects from §3.1:

1. **Delete the distance gate.** `1.0 - smoothstep(1200.0, 4200.0, terrainCameraDistance)` switches micro-detail off exactly where it is most needed. Replace with a **derivative footprint**, `max(length(dpdx(pos.xz)), length(dpdy(pos.xz)))`, so the detail ring stops sliding across the ground with the aircraft.
2. **Fix the gradient.** The 0.38 world-metre forward difference becomes a **central** difference at ≤ 0.05 of a cell.
3. **Source the detail from the texture arrays** rather than `terrainTriplanarNoise`, now that arrays exist.

Also set `material.enableSpecularAntiAliasing = true` if `1B-11` did not, and confirm `anisotropicFilteringLevel = 16` on the array samplers. The Toksvig term from `3-1` and specular AA are complementary: one fixes the normal map's lost variance, the other fixes the geometric normal's.

---

## 8. Gate 3B — Sampling and shading (7.0 d)

**Goal.** Make ten good materials look like one surface. Cliffs get rock structure that follows the surface instead of a stretched top-down smear; material boundaries look like one surface sitting on another rather than a soft gradient.

---

### `3-4` — De-tiling scales (1.5 d) · Class P

Three decorrelated rotated world scales — macro ~2048 m, patch ~176 m at **13.7°**, micro ~28 m at **61.2°** — with UV warping `uv_{n+1} += (rgb_n.rg − 0.5) · warpAmount`, footprint-faded with the deleted build's tuned bands (7–64 m, 1.5–20 m, 15–96 m, 1.2–14 m).

**Use 13.7° and 61.2°, not the deleted build's 36.3°.** That angle is within 1.3° of the 35° geological fabric the audit measures at **23.6:1 anisotropy** in the geology term and 2.7:1 in the composed field. Aligning the de-tiling rotation with the artefact reinforces the exact thing `5-8` exists to remove.

The warp amount is one of this phase's two tuning knobs.

---

### `3-5` — Triplanar texture projection (2.5 d) · Class P

True triplanar **texture** projection above `1 − |n.y| > 0.22`. Four details, each of which produces a specific visible artefact if skipped:

- **Sign-flipped per-plane UVs.** Untreated, this produces a visible reflection seam down every ridge.
- **`textureSampleGrad` with explicit gradients.** Implicit derivatives under branchy blend weights produce hard mip bands across slopes. *(This is the third `textureSampleGrad` requirement in the programme — Phase 2 `2-8`'s ocean cascades and `2-0`'s cloud weather map are the others. Treat it as a house rule: any sample under a branch or a wrap gets explicit gradients.)*
- **RNM normal blending in world space.** Never lerp tangent-space normals.
- **2-axis fast path mandatory from Balanced up** (§7 R3), not a High-only optimisation. Tier 0 uses a slope-stretched planar projection and no triplanar at all — that is the `triplanarMode` field from `3-0`.

---

### `3-6` — Height blend (1.0 d) · Class P

N-way height blending: `k_i = h_i + w_i`, `b_i = max(k_i − (max k − d), 0)`, normalised. Transition depth `d = mix(0.06, 0.5, saturate(fp/3))` widens with the footprint so the blend does not alias at distance. `d` is the phase's other tuning knob.

Material count capped by `heightBlendMaxMaterials` (2/3/4/4) from `3-0`. Depends on `3-1` having normalised the height channels to mean 0.5.

**Assertion 60:** the blend weights sum to 1 within 1e-4 for randomised inputs. A height blend that quietly loses energy darkens the whole terrain and is very hard to see.

---

### `3-7` — Per-material BRDF (2.0 d) · Class P · **hard gate on IBL**

Per-material roughness and F0 from `3-0`, plus **Oren-Nayar diffuse roughness** — snow 0.7, sand 0.55, grass 0.4, rock 0.35 — which gives the retroreflective brightening that makes those surfaces read correctly at low sun, for near-zero cost.

Babylon 9 supports this natively: `diffuseRoughness` is declared on the same minified line 240 the roughness injection already anchors on, and `BASE_DIFFUSE_ROUGHNESS` is present in `Materials/PBR/pbrBaseMaterial.pure.js`. Verified.

Plus a **wetness response** — `roughness = mix(r, r·0.35 + 0.02, wet)`, `albedo *= mix(1.0, 0.62, wet)` — wired but driven by a constant zero until `6-5` supplies the field from the water side. Two instructions now, versus threading a new input through a finished shader later.

**The gate is real:** this item multiplies material response into the indirect term, and the indirect term only exists because `1C-6` landed. It has, so `3-7` is unblocked — but do not reorder it before `3-6`, because per-material BRDF without height blending applies one material's response to a blended albedo.

---

## 9. Gate 3C — The runway and the seasons (10.0 d)

**Goal.** G6 and G9. The runway sits *in* the ground with visible embankments, worn asphalt, ragged grass-invaded edges, faded scuffed markings and black rubber lobes at both touchdown zones — no circular plateau, no floating slab, no z-fighting stripes.

---

### `3-8` — Runway earthworks (3.0 d) · **Class K**

**This item changes the physics authority. Treat it accordingly** (§3.4, C5).

Three-zone cut/fill profile, 0.35 m crown, noise-modulated blend distance, median site elevation — replacing today's `flattenHeightForAirport`, which produces the circular plateau the exit criterion tests for.

**Four hard requirements:**

1. **`getAirportInfluence` stays exactly 1.0 inside the apron.** `terrain.ts:118-125` and `sampleTerrainCollision`'s runway branch both key on it, and `ARCHITECTURE.md` §3 pins it.
2. **The collision fast path calls `runwayEarthworksHeight`.** Without this the crown exists only on screen and the aircraft lands on a plane 0.35 m away from it (§3.4).
3. **Written to the `0-4` portability contract** — `max(0, …)` under every `pow`, wrap-safe coordinates, f32-reproducible — because `4-9` transliterates it into WGSL.
4. **Merged alone.** No rendering change shares this commit.

**Gate:** all five invariant tests in `tests/sim.terrain-authority.test.ts`, plus `sim.flight.test.ts` checked in isolation.

**Exit criterion, from the plan and worth keeping verbatim:** a top-down `|natural − final|` debug render in which the 0.5 m contour around the airport is **not a closed convex curve**. A convex contour means the profile is still a disc.

---

### `3-9` — Runway surface (5.0 d) · Class P

Asphalt, concrete and paint layers driven by the **analytic airport SDF evaluated in the fragment shader** — not by splat weights. That is what decouples this item from Phase 4 and lets it ship here.

`roundedRectangleSignedDistance` already exists at `src/world/airport.ts:57`. Transliterate it into WGSL under the `0-4` contract with a TS/WGSL agreement test (C7), rather than writing a second implementation that will drift the way the ocean's and hydrology's sun discs did.

Content: ragged SDF-driven edge where grass invades the asphalt, black rubber skid lobes at both touchdown zones, worn and faded centreline and threshold markings, aggregate showing through in the wheel paths.

**Deletes `AirportSystem.ts:23-70`** — the 0.16 m runway box at `y = 0.08`, the ~9 centreline stripes and ~18 threshold stripes floating at `y = 0.175`, and the apron slab. That stack of 28 coplanar boxes is the z-fighting the exit criterion names. **Hangars stay** (`RENDERING_PLAN.md` §1.5) — they are the only scale reference on final approach and Phase 7 `7-10` replaces them properly.

**No special tessellation is needed under the airport** (§3.4): the crown's chord error is 11 mm at 8 m vertex spacing.

---

### `3-10` — Seasonal palette (2.0 d) · Class P

A `dayOfYear`-driven tint and roughness curve per material, sampled in `TerrainSurfacePlugin` — **not new texture arrays.** The arrays stay season-independent and only their weighting changes; that is what keeps the §5.2 memory row flat while `2-18` is competing for the same headroom.

Grass and shrub ride spring-green → summer → autumn-gold → dormant-brown; spring adds wetness darkening. **Rock, asphalt and concrete are season-invariant** — the `seasonal` flag in `3-0`'s spec.

Per `ARCHITECTURE.md` §4's threading rule, `dayOfYear` is in the response function's signature from the first line, and the boundary test checks this file for an environment-clock reference as it comes into existence.

---

## 10. Verification

Phase 0 contributed 18 assertions, Phase 1 sixteen, Phase 2 seventeen. Phase 3 adds sixteen.

| # | Assertion | By | Guards against |
|---|---|---|---|
| 52 | Material tiling periods are pairwise co-prime | `3-0` | Two layers repeating in phase |
| 53 | Every material's height channel has mean 0.5 ± 0.02 | `3-1` | One layer dominating the height blend |
| 54 | Mip N equals the Toksvig-corrected reduction of N−1 | `3-1` | A false sharp highlight at distance |
| 55 | **All 10 layers of both arrays have a complete mip chain** | `3-1` | Babylon mipping only layer 0 (§3.2, verified) |
| 56 | `materialArraysMiB` moves when `materialArrayEdge` changes | `3-0` | A decorative budget row |
| 57 | Processed effect source contains the roughness **and AO** injection tokens | `3-2` | A Babylon bump silently reverting roughness to 0.93 — and a `!regex` that matches nothing |
| 58 | The terrain effect defines neither `NORMALMAP` nor `DETAIL` | `3-2` | Someone adding tangents for a path that is never compiled |
| 59 | Triplanar normal is continuous across a ridge (GPU) | `3-5` | The per-plane sign-flip seam |
| 60 | Height-blend weights sum to 1 within 1e-4 | `3-6` | Silent energy loss darkening the terrain |
| 61 | All ten materials' roughness values reach the shader distinctly | `3-7` | The uniform-0.93 failure returning by another route |
| 62 | `getAirportInfluence == 1.0` across the apron | `3-8` | *(Phase 0 test — now load-bearing rather than trivial)* |
| 63 | **Collision height in the apron equals the earthworks profile within 1 mm** | `3-8` | §3.4 — landing on a surface that is not on screen |
| 64 | The 0.5 m `\|natural − final\|` contour is not a closed convex curve | `3-8` | The circular plateau |
| 65 | TS/WGSL airport SDF agreement within 1e-3 m | `3-9` | The drift that gave water two sun discs |
| 66 | Every seasonal response function takes `dayOfYear` | `3-10` | The `ARCHITECTURE.md` §4 threading rule |
| 67 | Terrain raster ≤ 2.6 ms at Balanced, incl. surface, de-tile and triplanar | Gate 3B | §5.4's row — already in `FRAME_BUDGET_MS` |

### What cannot be asserted

Ten material recipes are judged by eye. There is no test for "rock looks like rock." What replaces one:

- **The debug viewer, built on day one of `3-1`** — ten materials side by side, lit by the live environment, at three footprints.
- **Reference photographs** committed alongside the recipes, so a later tuning session knows what the target was.
- **The three `perf:capture` scenes** already committed by `1A-1`, plus one new **runway-on-approach** scene added in `3-9`. Baseline churn is sanctioned at three points in this phase: `3-2` (the surface appears), `3-5` (triplanar changes every slope) and `3-9` (the runway is rebuilt). Any other change is a regression until argued otherwise.

---

## 11. Risk register

| ID | Risk | Trigger | Response |
|---|---|---|---|
| **R-3A** | **`3-1` is seven days of unfalsifiable tuning.** Ten recipes judged by eye is the largest such surface in the programme. | Week 1–2. | Debug viewer on day one, non-negotiable. Reference photographs committed. Fix physical constants (roughness ranges, F0) in `3-0` so only *appearance* is tuned. The Toksvig assertion (54) is objective and catches the failure that actually matters at distance. |
| **R-3B** | **Regex injection breaks on a Babylon bump.** The anchors are minified, unversioned shipped WGSL. | A dependency update. | Assertion 57 in the same commit as the injection; `@babylonjs/core` stays pinned. A `!regex` that matches nothing is silent — that is why the assertion checks the *processed effect source*, not the plugin's output. |
| **R-3C** | **Array mips (§3.2).** Only layer 0 gets a chain via Babylon's generator. | `3-1`. | Verified and already routed around: CPU reduction through `TextureArrayMips` from Phase 2 `2-11`, guarded by assertion 55. |
| **R-3D** | **`3-8` breaks the flight model.** It changes the physics authority, and the crown desynchronises collision from the rendered surface. | `3-8`, week 5–6. | §3.4's three-part fix, assertion 63, the five-test invariant suite, and a commit that contains nothing else. **This is the one Phase 3 risk that can make the sim unflyable rather than merely ugly.** |
| **R-3E** | **Budget overshoot at `3-5`.** Terrain raster must hold 2.6 ms at Balanced *including* surface, de-tiling and triplanar. | Assertion 67 fails. | The §7 R3 cut ladder, in order: 2-axis triplanar (already mandatory from Balanced), material arrays 256² at Balanced (−14 MiB, and it is a memory not a time lever), then drop the micro de-tiling scale. Do **not** reach for the distance gate `3-3` just deleted. |
| **R-3F** | **Plugin hook contention.** Four plugins writing shared shader variables in implicit priority order. | Compile failure or a silently wrong composition. | C1 absorbs two of them into one. For the rest, assertion 57 checks the processed source, and function names in `CUSTOM_FRAGMENT_DEFINITIONS` carry a per-plugin prefix so a collision is a compile error rather than a shadowed function. |
| **R-3G** | **`3-9` slips.** Second-largest item, and its quality is judged in the one place the sim is judged hardest. | End of week 6. | **The phase's designated cut:** ship asphalt, centreline and threshold from the SDF and defer skid lobes, aggregate wear and the ragged grass edge (−1.5 d). The floating boxes are still gone and the runway still sits in the ground, which is the structural win. Second cut: `3-10` (−2.0), a missing feature rather than a broken one. |

---

## 12. Exit checklist

**Gate 3A — The surface system**
- [ ] `surfaceMaterials.ts` is the single owner of material identity; `4-6` will inherit the enum.
- [ ] Ten materials synthesised into two `Texture2DArray`s; every layer has a full mip chain.
- [ ] Height channels mean 0.5; Toksvig reduction verified against mip N−1.
- [ ] `materialArraysMiB` is in the memory estimate and moves with `materialArrayEdge`.
- [ ] `TerrainMaterialPlugin.ts` is deleted; `TerrainSurfacePlugin` is the single owner of terrain surface appearance.
- [ ] Roughness and AO injection tokens present in the **processed** effect source.
- [ ] The terrain effect defines neither `NORMALMAP` nor `DETAIL`; no tangent attribute exists.
- [ ] `useVertexColors = false`; the colour buffer carries the provisional two-material splat.
- [ ] Micro-detail is footprint-gated, centrally differenced, and texture-sourced; the 1200–4200 m distance gate is gone.

**Gate 3B — Sampling and shading**
- [ ] Three de-tiling scales at 13.7° and 61.2° — **not** 36.3°.
- [ ] Triplanar above `1 − |n.y| > 0.22`, sign-flipped UVs, `textureSampleGrad`, RNM blending; 2-axis from Balanced.
- [ ] No seam down ridges (GPU assertion).
- [ ] Height blend is a partition of unity; material count respects the tier cap.
- [ ] Ten distinct roughness values reach the shader; Oren-Nayar `diffuseRoughness` active.
- [ ] Wetness response wired, driven by a constant zero until `6-5`.
- [ ] Terrain raster ≤ 2.6 ms at Balanced.

**Gate 3C — The runway and the seasons**
- [ ] The 0.5 m `|natural − final|` contour around the airport is not a closed convex curve.
- [ ] `getAirportInfluence` is exactly 1.0 across the apron.
- [ ] **Collision height inside the apron equals the earthworks profile within 1 mm.**
- [ ] `sim.flight.test.ts` passes, checked in isolation from any rendering change.
- [ ] No `CreateBox` runway, stripes or apron remain in `AirportSystem.ts`; hangars still present.
- [ ] Runway edges are ragged and grass-invaded; markings are worn; skid lobes at both touchdown zones.
- [ ] TS/WGSL airport SDF agree within 1e-3 m.
- [ ] Deciduous ground cover responds to `dayOfYear`; rock, asphalt and concrete do not.

**Phase**
- [ ] **Audit root cause #1 is closed.** Material resolution is decoupled from mesh resolution.
- [ ] User goals **G6** (runway) and **G9** (nothing looks like plastic) served.
- [ ] `npm run verify` green; `npm run test:gpu` green.
- [ ] Three ownership rows added to `ARCHITECTURE.md`; the boundary test passes.
- [ ] Baseline churned at no more than the three sanctioned points (`3-2`, `3-5`, `3-9`); the runway-approach scene is committed.
- [ ] Decision log complete.

---

## 13. Decision log

| Date | Item | Decision | Measurement / rationale |
|---|---|---|---|
| — | `3-0` | The two material identities beyond §3.2's eight, and their tiling periods | *record the co-primality check* |
| — | `3-1` | Per-material recipe constants | *record the reference photographs used* |
| — | `3-1` | Toksvig `k` | *record the value and the mip-N comparison* |
| — | `3-2` | Final regex anchors for roughness and AO | *record the matched text verbatim — it is minified and will change* |
| — | `3-5` | Triplanar mode per tier | *record the terrain-raster ms for 2-axis vs 3-axis at Balanced* |
| — | `3-6` | Transition depth `d` range | *record the value* |
| — | `3-8` | Earthworks zone widths and crown | *record the contour test output and the collision agreement* |
| — | `3-9` | Cut or keep the wear layer | *record against the week-6 date* |

---

## Appendix A — File manifest

**New (5)**
`terrain/surfaceMaterials.ts` · `terrain/TerrainSurfacePlugin.ts` · `terrain/MaterialArraySynthesis.ts` · `terrain/RunwayEarthworks.ts` · `terrain/RunwaySurface.ts`

**Substantially modified (7)**
`terrain/TerrainClipmapSystem.ts` (material bindings, splat buffer, `useVertexColors = false`) · `core/QualityProfile.ts` (three material fields) · `core/PerformanceBudget.ts` (`materialArraysMiB`) · `world/airport.ts` (earthworks profile, SDF export) · `world/terrain.ts` (collision fast path calls the earthworks) · `detail/AirportSystem.ts` (runway, stripes and apron deleted; hangars kept) · `render/webgpu/owners.ts` + `ARCHITECTURE.md` (three rows)

**Deleted**
`terrain/TerrainMaterialPlugin.ts` and its test (absorbed) · its dead GLSL branch · `AirportSystem.ts:23-70` — one runway box, ~27 marking boxes, one apron slab

**Explicitly untouched in Phase 3**
The page atlas, CDLOD and vertex displacement (Phase 4) · the land-cover classifier and splat page rasterisation (`4-6`) · baked occlusion (`4-7`) · erosion and lithology-driven erodibility (Phase 5) · terrain wetness *source* (`6-5`) · hangars (Phase 7)

## Appendix B — Where Phase 3 sits against the audit

| Audit finding | Phase 3's contribution |
|---|---|
| §2.1 **root cause #1** — no surface material system, not a weak one, none | **Closed.** Ten materials, two arrays, decoupled from mesh resolution |
| Albedo resolution welded to mesh resolution; 41–50% biome flips past 5 km | Structurally fixed here; fully closed when `4-6` rasterises splat pages |
| Uniform `roughness = 0.93` × `specularIntensity = 0.22` — one BRDF for every surface | Closed by `3-7` (the `specularIntensity` half closed in `1C-6`) |
| Micro-detail gated off at 1200–4200 m, exactly where normals are worst | Closed by `3-3` |
| "The highest-frequency albedo signal is a 7.1 m smooth value noise" | Closed by `3-1` + `3-4` |
| Runway as a floating slab with z-fighting stripes | Closed by `3-8` + `3-9` |
| §2.9 the global 35° fabric | *Not* Phase 3 — but `3-4` avoids reinforcing it by rotating at 13.7°/61.2° |
