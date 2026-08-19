# Phase 3 Execution Plan — Terrain Surface and the Runway

**Status: IMPLEMENTED, 2026-08-19** (branch `jazonshou/Phase-3-Implementation`). Every item `3-0`–`3-10` plus `R-26` has landed. Read **§14 Implementation record** for what was built, what deviated and why, and §13 for the decisions the plan left blank. The sections above §14 are the plan as written and are left unedited for traceability except where a deviation is flagged inline.

**Status:** execution reference for Phase 3 of `RENDERING_PLAN.md`. It does not restate that plan; it decides everything that plan leaves to implementation time, against the codebase as it will exist when Phase 3 starts.
**Runs after:** `PHASE_2_EXECUTION_PLAN.md`. Phase 2's exit criteria are this plan's preconditions.
**Basis:** `TERRAIN_AUDIT.md` §2.1 (root cause #1), `RENDERING_PLAN.md` §2 Phase 3 / §3.2 / §5.2–§5.4 / §6 / §7, and `ARCHITECTURE.md` (normative, from Phase 0).
**Verified against:** the Phase 1 branch at `9e1e04d`, plus `@babylonjs/core` 9.21.2 as installed. Every file, line, shipped-shader and Babylon-internal claim below was re-checked in the current tree. *(2026-08-19: Phases 2 and 2.5 have since landed, through `46bc24a`. Every cited line anchor must be re-derived against the implementation branch before Phase 3 work starts — this document's own rule for anchors that move: record the matched text, never trust the number.)*
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
>
> **Further amended 2026-08-18 by [`PHASE_4_EXECUTION_PLAN.md`](PHASE_4_EXECUTION_PLAN.md) §4 D4 (zero days):**
>
> - **`3-2`'s fourth vertex lane is named `atlasSlot`, not `spare`,** and is written as `-1`. Phase 4 bakes occlusion into channel pages at `4-7` and its consumer is *this* plugin's fragment shader; without a slot index on the CPU tile mesh that consumer cannot exist until `4-4`, and `4-8b` may not shorten the shadow distance until the horizon map is actually being sampled. Reserving the lane here costs nothing and is load-bearing for Phase 4's gate order. See §7 `3-2`.

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
| `3-1` | `TextureArrayMips.ts` — the CPU array-mip reducer | **Phase 2 `2-11`** | **Landed** — `src/render/webgpu/core/TextureArrayMips.ts` *(verified on disk 2026-08-19)* |

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

Per §3.4. The earthworks profile becomes a shared function called by both the renderer and `sampleTerrainCollisionHeight`'s fast path; a fifth invariant test joins `tests/sim.terrain-authority.test.ts`; and because `4-9` transliterates the profile into WGSL, it is written to the `0-4` portability contract from the first line — `max(0, …)` under every `pow`, wrap-safe coordinates, f32-reproducible.

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

> **Annotated 2026-08-19.** Pre-amendment figures: this ledger carries only §4's seven amendments (net +0.25). The +0.5 d `R-26` item — retiring the light-rig palette, adjacent to `3-10`, per the 2026-08-18 realignment banner at the top of this file — is not in these rows; with it the phase totals **30.25 d**, matching the header.

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

> **Superseded in part, 2026-08-19.** The §6.1 graph and the §6.3 week ledger still schedule `3-10` last (week 7). Per the binding 2026-08-18 realignment amendment at the top of this file (`R-14`), **`3-10` runs immediately after `3-2`**. The graph and ledger are left as originally drawn for traceability.

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

> **Annotated 2026-08-19.** Pre-amendment figures: the week rows do not carry the +0.5 d `R-26` item adjacent to `3-10` (2026-08-18 banner, top of file), which brings the phase to **30.25 d** as the header states.

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

**Three recipe details carry disproportionate weight**, per §3.2 and (for the third) the vegetation-quality amendments of 2026-08-18:

- **Forest floor.** This layer sits under every tree in the world, so it is the most-seen material after grass — and it is the cheapest place in the whole programme to answer *"moss, twigs, mess"*, because it costs one of ten array layers that are already budgeted and nothing at all at runtime. Four superposed strata, each periodic on the cell grid: **(a) litter** — 2–6 cm elongated needle and leaf flakes at high coverage, each with its own hue draw across a brown/ochre/grey range rather than one tinted noise field; **(b) twig fragments** — short, dark, high-curvature strokes at ~8% coverage, laid along a weak flow field so the debris is anisotropic rather than isotropic salt; **(c) moss** — irregular cushions at 10–25% coverage carrying *their own roughness* (0.85–0.95, distinctly matte against litter's ~0.6) and a small positive height offset, biased into the concave regions of the height channel so it settles in hollows the way real moss does; **(d) exposed root and duff** breaking through at ~5%. Rock's per-block roughness-variance rule applies here too: adjacent litter and moss reading with visibly different gloss is most of what stops a forest floor being a brown sheet.
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

Until `4-6` rasterises real splat pages there are no per-texel material IDs, so the provisional encoding is a **two-material vertex blend**: `(materialIdA, materialIdB, weightB, atlasSlot)`. **The fourth lane is `atlasSlot`, written as `-1` until `4-2` fills it** — not a spare (Phase 4 §4 D4). `4-7`'s occlusion bake is consumed by this plugin on these meshes, before the quadtree exists. That is not a compromise dressed up — §5.3 sets the height-blend cap to **2 at tier 0**, so the provisional path *is* the Low-tier path, and it ships unchanged. `4-6` upgrades tiers 1–3 to the 4-way page splat that `world/payload.ts` already specifies.

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

**Goal.** G6 and G9 *(labels from the superseded `G1`–`G10` scheme, kept for traceability; per `RENDERING_PLAN.md` §0.4 they map to **G-A**, and `3-10`'s seasonal palette serves **G-B** — noted 2026-08-19)*. The runway sits *in* the ground with visible embankments, worn asphalt, ragged grass-invaded edges, faded scuffed markings and black rubber lobes at both touchdown zones — no circular plateau, no floating slab, no z-fighting stripes.

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

*Ticked 2026-08-19 against the implementation. One item is carried open — see §14.4.*

**Gate 3A — The surface system**
- [x] `surfaceMaterials.ts` is the single owner of material identity; `4-6` will inherit the enum.
- [x] Ten materials synthesised into two `Texture2DArray`s; every layer has a full mip chain (assertion 55, Node *and* a device-side probe).
- [x] Height channels mean 0.5 (assertion 53); Toksvig reduction verified against mip N−1 (assertion 54) *and* against a plain box chain, so the equality is not a tautology.
- [x] `materialArraysMiB` is in the memory estimate and moves with `materialArrayEdge` (assertion 56).
- [x] `TerrainMaterialPlugin.ts` and its test are deleted; `TerrainSurfacePlugin` is the single owner of terrain surface appearance.
- [x] Roughness, AO **and F0** injection tokens present in the **processed** effect source (assertion 57), with a Node sibling matching all three anchors against the shipped Babylon files.
- [x] The terrain effect defines neither `NORMALMAP` nor `DETAIL`; no tangent attribute exists (assertion 58).
- [x] `useVertexColors = false`; the colour buffer carries the provisional two-material splat, with `atlasSlot` reserved at −1.
- [x] Micro-detail is footprint-gated and texture-sourced; the 1.2–4.2 km camera-distance gate is gone, and there is no finite difference left in the shader at all — the normal is read from array B, whose gradients were centrally differenced at one texel by the synthesiser.

**Gate 3B — Sampling and shading**
- [x] Three de-tiling scales at 13.7° and 61.2° — **not** 36.3°.
- [x] Triplanar above `1 − |n.y| > 0.22`, sign-flipped UVs, `textureSampleGrad` everywhere, RNM blending; 2-axis from Balanced, 3-axis at High and Ultra, slope-stretched planar at Low.
- [x] No seam down ridges (assertion 59, a rendered tent whose crest step is compared against the material's own texel-scale variation).
- [x] Height blend is a partition of unity (assertion 60, 20,000 randomised inputs); material count respects the tier cap through a compiled-out define.
- [x] Ten distinct roughness values reach the shader (assertion 61, read back from the device); Oren-Nayar `diffuseRoughness` active, with the four values the plan names pinned.
- [x] Wetness response wired, driven by a constant zero until `6-5` — **except** submerged ground, which is unambiguous now and had to be handled (§14.2).
- [ ] **Terrain raster ≤ 2.6 ms at Balanced** — carried open, see §14.4. The renderer has no per-pass GPU timer, so this cannot be measured without building one; the whole-frame numbers are in the committed capture report.

**Gate 3C — The runway and the seasons**
- [x] The 0.5 m `|natural − final|` contour around the airport is not a closed convex curve (assertion 64).
- [x] `getAirportInfluence` is exactly 1.0 across the apron (assertion 62).
- [x] **Collision height inside the apron equals the earthworks profile within 1 mm** (assertion 63), with a non-vacuity check that the camber is actually applied.
- [x] `sim.flight.test.ts` passes, checked in isolation.
- [x] No `CreateBox` runway, stripes or apron remain in `AirportSystem.ts`; hangars still present.
- [x] Runway edges are ragged and grass-invaded; markings are worn; rubber lobes at both touchdown zones; aggregate in the wheel paths.
- [x] TS/WGSL airport SDF agree within 1e-3 m (assertion 65).
- [x] Deciduous ground cover responds to `dayOfYear`; rock, asphalt and concrete do not (assertion 66).

**Phase**
- [x] **Audit root cause #1 is closed.** Material resolution is decoupled from mesh resolution: ten mipped, anisotropically filtered materials sampled per fragment, replacing one 8-bit colour per vertex.
- [x] User goals **G-A** (the runway) and **G-B** (the seasonal ground palette) served.
- [x] `npm run verify` green; `npm run test:gpu` green (13 files, 20 tests).
- [x] Five ownership rows added to `owners.ts` and `ARCHITECTURE.md` (the plan expected three; `3-1`'s arrays and `3-9`'s painter earned their own); the boundary test passes.
- [x] Baseline churned once, at the end of the phase, covering the three sanctioned points; the `runway-on-approach` scene is committed.
- [x] Decision log complete (§13).

---

## 13. Decision log

| Date | Item | Decision | Measurement / rationale |
|---|---|---|---|
| 2026-08-19 | `3-0` | The two extra identities are **dry grass (2.9 m)** and **shrub (4.1 m)**; every period is re-cut to a distinct prime number of decimetres. | The plan's eight published periods are **not** mutually prime, which is the property assertion 52 tests: as decimetres they are 24, 31, 37, 43, 57, 69, 74, 91 — gravel and asphalt are an exact 2:1, and 24/57/69 share a factor of 3. Distinct primes make co-primality structural. Closest pair (23, 29 dm) realigns at 66.7 m; the five periods that could be kept unchanged were (3.1, 3.7, 4.3). |
| 2026-08-19 | `3-0` | The enum order is the **ecotone axis**, not a free choice: indices 0–5 are the biome primaries in climatic order. | `3-2` interpolates the id and brackets it, so a climatic neighbour pair more than one step apart puts a third material in the boundary band. The first ordering put sand between shrub and rock and `approach-500ft` came back with bright closed rings around every mountain — sand is the brightest material in the table and shrub among the darkest. Assertion tightened from ≤4 steps to **exactly 1**. |
| 2026-08-19 | `3-0` | `SHADOW_DEPTH_BYTES` 5 → 4, verified against the shipped Babylon. | The arrays pushed tiers 2 and 3 past their §5.2 ceilings; the row was checked before any feature was cut. `DepthOnlyCascadedShadowGenerator` calls `createDepthStencilTexture(comparison, true)` and stops, so the defaults apply (no stencil, format 14 = `DEPTH32_FLOAT`), and `webgpuTextureManager.js:279` maps that to `depth32float`. 64 MiB of phantom allocation at tier 2. |
| 2026-08-19 | `3-1` | Per-material recipe constants are in `MaterialArraySynthesis.ts`; the reference targets are committed as `MATERIAL_REFERENCE_NOTES` beside them. | Citations rather than files: the repo ships **zero** image assets by design (`TERRAIN_AUDIT.md` §2.1) and Phase 3 keeps it that way. The viewer is `npm run material:preview` — ten materials across, five channels × three footprints down. Reference albedos are measured-range, not the deleted `PALETTES` table's: grassland at (0.29, 0.445, 0.215) was about three times a real sward. |
| 2026-08-19 | `3-1` | Toksvig `k = 0.5`. Each level reduces the level **emitted** above it, so the roughening accumulates. | At `k = 1`, \|avgN\| = 0.9 takes rough 0.5 → 0.59, which visibly over-mattes mid-range rock; 0.5 gives 0.55. Mip-3 comparison against a plain box chain: every layer matter, rock +7.5 bytes, gravel +11 (that comparison IS assertion 54's non-tautology half). Normal strength had to become a declared RMS slope: the first, physically derived form left the normals so nearly parallel that the whole term was worth 0.2–0.6 of a roughness byte at mip 3 — the plan's "single most important anti-plastic measure" doing nothing. |
| 2026-08-19 | `3-2` | Three anchors, matched text verbatim. | **Roughness** (`pbr.fragment.js:240`): `var roughness: f32=reflectivityOut.roughness;var diffuseRoughness: f32=reflectivityOut.diffuseRoughness;`. **AO**: the `);` closing `aoOut=ambientOcclusionBlock(` at ~174 — the plan's `:245` is unreachable (§3.2/C3). **F0** (`pbrBlockReflectance0`): `var specularEnvironmentR0: vec3f=reflectivityOut.colorReflectanceF0;`. Only `$1`-style back-references exist, so each anchor captures itself. |
| 2026-08-19 | `3-5` | planar / biplanar / triplanar / triplanar per tier, from §5.3's row. | Terrain-raster ms was **not** measured per mode: `1A-1`'s report carries no per-pass GPU timer, so a 2-axis/3-axis comparison at Balanced would have been invented rather than measured. §5.3 already publishes the ladder and §7 R3's mandate (2-axis from Balanced) is satisfied at tier 1; assertion 67 is carried as an open item, see §14.4. |
| 2026-08-19 | `3-6` | `d = mix(0.06, 0.5, saturate(fp / 3))`, exactly as specified. | Partition of unity over 20,000 randomised inputs including the all-equal degenerate case (assertion 60), plus the shipped TS mirror pinned against the shader's tokens. |
| 2026-08-19 | `3-8` | Camber 0.35 m measured **downward** from the centreline; cut exponent 0.62, fill 1.75, bench ±0.55 m; blend distance modulated **inward only** by up to 45% at a 260 m wavelength. | Downward because `airport.elevation` is the aircraft's spawn datum and the height every pre-Phase-3 test was written against — crowning upward would have raised the runway 0.35 m relative to spawn. Chord error 5.8 mm at 8 m spacing (the plan's 11 mm assumed a 45 m width; the graded width is 62 m). Inward-only keeps `terrainBlendDistance` a hard outer bound, so `getAirportInfluence == 0` still implies untouched terrain. Contour test: assertion 64 finds chords of the 0.5 m contour whose midpoints are outside it. Collision agreement: **< 1 mm** across a 25 × 17 apron sweep (assertion 63). |
| 2026-08-19 | `3-8` | Cut blends into fill over 4 m of height difference rather than being branched on; bench 0.42 m. | Found by adversarial review of the diff, not by a test. The two branches differ by more than their exponent — the bench is `+bench` for fill and `−bench` for cut — so `if (natural < platform)` put a `2 × bench` step on the closed contour where they meet: a **ring of 1.09 m cliffs around the airport**, in the collision surface as much as the rendered one. After the blend the worst 0.25 m step in the earthworks band is 0.11–0.14 m, comparable to the natural terrain's own, and a relative continuity invariant now pins it. |
| 2026-08-19 | `3-9` | The wear layer is **kept**, in full: ragged SDF edge, rubber lobes at both touchdown zones, worn centreline and threshold bars, aggregate in the wheel paths. The apron slab is deleted and **not** replaced. | `R-3G`'s designated cut was not needed. The apron is not a cut: the plan lists it among the deletions and asks for no successor, and it sat 84 m outside the graded platform on sloping natural terrain. |
| 2026-08-19 | `R-26` | Ground bounce = `skyHorizon × meanSurfaceAlbedo × 1.15`; the SH below-horizon attenuation floors at the albedo, not at 0.25. | The calibration constant reproduces the retired `ground` palette row at the reference day+clear key to within 0.03 on red and green. The blue it loses was never physical. Winter bounces > 1.5× summer (asserted), which `D-6`'s constant floor could not express. |

---

## 14. Implementation record (2026-08-19)

Everything below is what actually landed. The plan above is unedited except
for the status banner and the two tables it asked to have filled.

### 14.1 What was built

| Item | Landed as | Notes |
|---|---|---|
| `3-0` | `terrain/surfaceMaterials.ts` + three `WebGpuQualityProfile` fields + a derived `materialArrays` budget row | The contract went in first, exactly as `C6` argues. |
| `3-1` | `terrain/MaterialArraySynthesis.ts`, `toksvigReduce` in `core/TextureArrayMips.ts`, `npm run material:preview` | CPU synthesis (D-3-2). Viewer on day one. |
| `3-2` + `3-3` | `terrain/TerrainSurfacePlugin.ts`; `TerrainMaterialPlugin.ts` and its test **deleted** | `C1`'s absorption. |
| `3-4`–`3-7` | The same file's WGSL | De-tiling, triplanar, height blend, per-material BRDF. |
| `3-8` | `terrain/RunwayEarthworks.ts`; `world/terrain.ts` collision fast path; `flattenHeightForAirport` **deleted** | Class K. Merged with nothing else. |
| `3-9` | `terrain/RunwaySurface.ts`; `AirportSystem.ts` boxes **deleted** | 28 coplanar boxes gone. |
| `3-10` | `surfaceSeasonalResponse` in the plugin | Anchored at the reference day. |
| `R-26` | `AtmosphereSystem.setSurfaceAlbedo`, `SkyEnvironmentProbe` ground-bounce albedo; the palette's `ground` row **deleted** | `D-6` and `D-9` retired. |

Sixteen assertions were planned; sixteen landed, one carried open (67), and two
more were added after an adversarial review of the diff: an earthworks
continuity invariant (§14.2 D-3-13, a defect none of the sixteen could see) and
a GPU test that compiles **all twelve** `triplanar × material-cap × runway`
define combinations — a branch no shipping tier exercises during development
would otherwise stay invisible until somebody changed a quality setting. Two of
the original sixteen were strengthened past the plan: 54 now also compares against a plain box
chain, so it cannot pass as a tautology over its own implementation, and 57
gained a Node sibling that matches the anchors against the shipped Babylon
files, so a dependency bump fails `npm test` rather than waiting for a GPU run.

### 14.2 Deviations

Ordered by how much they change the plan.

**D-3-1 — `3-1` synthesises on the CPU (the plan says GPU compute for mip 0).**
`C2` already moved the mip reduction to the CPU on the grounds that a one-time
startup cost belongs on no frame budget. The split does not survive contact
with its own conclusion: `RawTexture2DArray.updateMipLevel` uploads CPU bytes,
so a GPU mip 0 must be read **back** before the Toksvig reduction can run — a
full 2 × 10 × edge² readback costing more than the synthesis it accelerates.
CPU synthesis also makes assertions 53/54/55 ordinary Node tests instead of
GPU readbacks, and it is the shape `2-11`'s `FoliageAtlas` and `2-17`'s
`ImpostorAtlas` already ship. **Measured: 1.07 s for all ten 512² layers**, once,
on seed change.

**D-3-2 — Ultra's material array edge is 512, not §5.3's 1024.** Follows from
D-3-1: 1024² costs ~4.3 s of blocked main thread at startup, for a resolution
the de-tiling warp and 16× anisotropy largely mask. It also returned 80 MiB to
a tier that was sitting at 96% of its ceiling. `materialArrayEdge` stays a live
tier knob (Low is 256) and the row reopens the moment synthesis moves to GPU
compute — which is precisely the optimisation `C2` deferred.

**D-3-3 — the enum order is the ecotone axis, and the splat interpolates the
material id.** The plan specifies the lane layout `(materialIdA, materialIdB,
weightB, atlasSlot)` but not how a fragment reads an *interpolated* id. Flat
interpolation gives hard triangle edges at 8 m; naive rounding gives a hard
edge at the midpoint. Instead the primary id is treated as a continuous
coordinate and the fragment brackets the two integers it lies between — which
is smooth by construction, and only correct if adjacent ids are materials that
actually meet. So indices 0–5 are the chain of biome primaries in climatic
order. **This was measured, not assumed**: the first ordering put sand between
shrub and rock and the `approach-500ft` capture came back with bright closed
rings around every mountain. The secondary id is rounded, and its weight fades
to zero at the midpoint between two integers, because rounding an interpolated
id only means anything where the neighbouring vertices agree.

**D-3-4 — the tiling periods are re-cut to distinct primes in decimetres.** The
plan's eight published periods are not mutually prime, which is the property
assertion 52 tests: 3.7 and 7.4 are an exact 2:1, and 24/57/69 dm share a
factor of 3. Three of the eight are unchanged.

**D-3-5 — the camber is measured downward from the centreline.** The plan says
"0.35 m crown" without a datum. `airport.elevation` is the aircraft's spawn
datum and the height every pre-Phase-3 test was written against, so the
centreline keeps it exactly and the camber lowers the shoulders. Crowning
upward would have raised the whole runway 0.35 m relative to spawn.

**D-3-6 — the collision NORMAL follows the camber too.** The plan mandates only
the height. A flat normal on a cambered surface is the same lie one derivative
up; the cross-slope is ~1.3° at the graded edge, which is what a real runway
has. `sim.flight.test.ts` passes unchanged.

**D-3-7 — the apron slab is deleted and not replaced**, and `3-9` keeps its
full wear layer. `R-3G`'s designated cut was not needed.

**D-3-8 — albedo is stored as `sqrt(linear)` and the layers are high-passed.**
Neither is in the plan; both are consequences of shipping RGBA8 arrays that are
sampled at range. Linear RGBA8 gives forest floor a mean albedo byte of 15 and
asphalt 11 — a dozen usable levels for the two materials that cover most of the
world. And a layer that still carries metre-scale energy at mip 6 shows its
whole tiling period as a regular quilt: measured at ~1 km on `approach-500ft`,
a 4.3 m sand tile repeating every four screen pixels. Both fixes are one
instruction in the shader; the hundred-metre and kilometre variation the
high-pass removes is put back by `3-4`'s macro term, where it does not repeat.

**D-3-9 — the submerged half of `3-7`'s wetness response is live now.** The plan
wires wetness to a constant zero until `6-5`. Submerged ground cannot wait:
the WATER biome's primary must be sand (beach is its only ecotone neighbour)
and dry sand is the brightest material in the table, so every lake rendered as
a pale seabed until the wetting and a silt tint were applied. The *driven*
field is still a constant zero.

**D-3-10 — `SHADOW_DEPTH_BYTES` corrected from 5 to 4.** Not a Phase 3 item, but
Phase 3's spend is what made the row load-bearing: the arrays pushed tiers 2
and 3 past their §5.2 ceilings and the contract has to be checked before a
feature is cut. The CSM's remaining attachment is plain `depth32float` — 64 MiB
of phantom allocation at tier 2, verified against the shipped Babylon rather
than assumed.

**D-3-11 — five ownership rows, not three.** `3-1`'s arrays and `3-9`'s painter
are separately owned artifacts with their own invariants.

**D-3-12 — every band-based recipe curves its lines.** A perfectly periodic
sub-metre band lattice (rock joints, sand ripples, concrete float sweeps, snow
sastrugi) moirés into a metre-scale quilt at grazing angles. Real jointing,
bedding and wind ripples all wander; making them wander removes the artefact
and makes them read as geology.

**D-3-13 — cut blends into fill; it is not branched on.** Not a deviation from
the plan so much as a defect the plan could not have anticipated: `3-8`'s
cut and fill differ by more than their batter grade, and switching between them
on `natural < platform` put a `2 × bench` step on the closed contour where they
meet. A ring of 1.09 m cliffs around the airport, in the collision surface as
much as the rendered one. Caught by an adversarial review of the diff — not by
any of the sixteen assertions, which is worth recording: assertion 63 checks
the apron *interior*, 64 checks the contour's convexity, and neither looks at
the batter's continuity. A relative continuity invariant now does.

**D-3-14 — eleven defects from an adversarial review of the diff, nine fixed
and two accepted.** The review is recorded here because most of what it found
was invisible to the sixteen assertions, and because two of the fixes changed
the design rather than a line:

- **The planar tangent frame normalised the zero vector** on any surface whose
  normal is exactly (±1, 0, 0) — which the clipmap's own crack-guard skirts
  carry on two of their four sides. NaN normals on the Low tier, reproduced on
  hardware. It is now the standard least-aligned-axis pick.
- **The triplanar tangent normals were not sign-flipped** to match the
  sign-flipped UVs, so the detail normal was mirrored against the pattern it
  belonged to: the ridge seam `3-5` exists to remove, moved out of albedo and
  into lighting where it is harder to see and just as wrong.
- **The vertex splat's secondary material id was dropped entirely** (a design
  change). Rounding an interpolated id paints every intermediate id it sweeps
  through at full weight — a grassland/forest boundary lays a band of snow and
  a band of rock along itself — and the "confidence" gate that was supposed to
  suppress that only closes at half-integers, where the problem is not. The
  third candidate is now purely fragment-derived (slope and seasonal snow);
  lanes y and z still carry the biome's secondary cover for `4-6` to inherit.
- **Assertion 59 was vacuous.** The tent it renders had faces at
  `1 − |n.y| = 0.219`, under the 0.22 triplanar threshold by a hair, so no test
  in the suite executed the projected branch at all. The tent is steeper and
  the geometry now asserts it clears the threshold.
- **Asphalt's and concrete's aggregate lattices were sub-texel** at every
  shipping array edge (664 and 445 cells across 512 texels) — noise at the
  Nyquist limit, not aggregate. Feature sizes are clamped to ≥2.5 texels.
- **`fitRoughnessToSpec`'s degenerate guard was unreachable**, and making it
  reachable immediately caught a real deficiency: the shrub recipe wrote a
  constant roughness, which the fit was stretching across the whole band.
- **The hangars floated.** They stood on the apron slab `3-9` deletes, pinned
  to the airport datum, 118 m across the centreline — outside the graded
  platform, on the batter. They read the ground now.
- **The material arrays did not follow a tier change**, so the §5.2 memory row
  (derived from `materialArrayEdge`) and the actual allocation diverged the
  moment anyone touched quality — the decorative-row failure assertion 56
  exists to prevent. They are re-synthesised on the same path that already
  rebuilds every page.
- **The runway masks antialiased against the isotropic footprint**, which at
  the grazing angles a runway is always seen at dissolved a 0.9 m centreline
  into a smear. The world derivatives are projected onto the runway's own axes
  and each mask uses the one its edge normal points along.
- **Accepted, recorded:** the mip chain box-filters gamma-2.0 albedo as if it
  were linear (measured drift ≤3.0%, most under 1%), and the physics runway
  rectangle disagrees with the painted ragged edge over a ~2 m band (the §1.3
  contract binds height, which both authorities agree on).

### 14.3 What the plan got right that was worth the trouble

- **`C3`.** The plan's AO anchor at `:245` is genuinely unreachable, and a
  `!regex` that matches nothing is silent. Without the correction AO would have
  looked wired and never applied.
- **`C1`.** `3-3` really did collapse into three edits inside one file.
- **The debug viewer on day one.** It caught the vegetation reading as
  camouflage blotches and the forest-floor litter being invisible, before
  either reached a capture.
- **§10's "what cannot be asserted".** It is right that ten recipes are judged
  by eye — but the phase's worst defects were not in the recipes. They were in
  the shader's handedness, in an interpolation that could not carry what it was
  asked to, and in a test that had quietly gone vacuous. None of those is a
  matter of taste, and none was caught by looking at pictures.
- **§3.4.** The crown/collision desynchronisation is exactly as described, and
  the four Phase-0 invariants would not have caught it.

### 14.3b What it cost, measured

The capture set was rebaselined once, at the end of the phase, covering all
three sanctioned churn points. Comparing the committed pre-Phase-3 report
against the new one on the same machine:

- **Draw calls fell by exactly 70 on every shot.** That is `3-9` deleting the
  runway box, ~27 marking boxes and the apron slab, and their shadow-pass
  draws with them.
- **GPU p95 fell on twelve of thirteen shots**, and frame rate rose on ten.
  `approach-500ft` went 14.20 → 11.80 ms, `reference-viewport` 13.35 → 11.88,
  `night` 13.40 → 12.00. A phase that adds a ten-material surface system came
  out net *faster*, because the meshes it deleted cost more than the shading it
  added.
- **One shot regressed and is re-pinned: `canopy-1200ft`**, 10.86 → 12.16 ms
  GPU p95, 29.9 → 26.6 fps, floor 27 → 24. It is the 45°-down cockpit shot over
  forest — most of the frame is near-field terrain between the trees, which is
  where ten mipped materials cost most, and there are no airport meshes in it
  to pay for them.
- The single largest optimisation was **skipping negligible height-blend
  candidates** rather than sampling them and multiplying by zero: on
  `cruise-horizon` that was the difference between 51.7 fps and 79.3.
- Memory: 6.7 MiB at tier 0 and 26.7 MiB above it, against §5.2's 5.4/56/56
  row. Tier totals land at 144 / 289 / 644 / 866 MiB against ceilings of
  260 / 480 / 700 / 1000.

**A caveat on the fps figures, stated because it matters more than the
figures.** This box is not the reference machine, and it was warm: the
committed *pre-Phase-3* report already recorded four shots below their own
committed floors (`approach-500ft` 22.3 vs 24, `reference-viewport` 20.0 vs 21,
`winter-noon` 21.3 vs 24, `night` 22.6 vs 24). Phase 3's rebaseline run put all
four back above their floors, and two subsequent verification runs drifted
under again by 1–2 fps with no code change. Only `canopy-1200ft`'s floor was
re-pinned, because only that shot's regression is attributable — its GPU p95
rose in the same run where every other shot's fell. `drawCalls`, `triangles`
and GPU p95 are the portable numbers here; the fps floors bind on the reference
machine.

### 14.4 Carried open

- **Assertion 67 — terrain raster ≤ 2.6 ms at Balanced.** Not measured, because
  the renderer has no per-pass GPU timer: `1A-1`'s report carries whole-frame
  `gpuFrameMsP95` and nothing finer. Measuring it means building the timer,
  which is a performance-owned item rather than a terrain-material one. The
  same gap makes the §13 row for `3-5`'s 2-axis/3-axis comparison
  unmeasurable. Recommended: fold a per-pass GPU timestamp into Phase 4's
  budget work, where `4-4` and `4-8b` need it too.
- **`R-25`'s interim, unchanged.** Ten well-synthesised materials are still
  selected by the 8-bit per-vertex threshold cascade the audit indicts. The
  ecotone ordering removes the *worst* consequence (a third material appearing
  in every boundary band), and the fragment evaluates slope and snow at
  fragment resolution, but the boundaries themselves are still iso-contours in
  height and are visible as thin lines at long range. That is `4-6`'s to close,
  and `R-27`'s classifier-consumers contract is still owed before Phase 4
  starts.
- **`4-2` fills `atlasSlot`.** The lane is reserved and written as −1.
- **`runway-on-approach`'s ceilings are pinned from one run, not three**, with
  a widened margin. Re-pin on the reference machine.
- **The physics runway rectangle and the painted pavement edge disagree over a
  ~2 m band** (`RunwaySurface.ts` records it). §1.3 binds the surface height,
  which both authorities do agree on; closing the friction gap would mean
  evaluating the ragged-edge noise in the collision hot path.

---

## Appendix A — File manifest

> **As shipped, 2026-08-19.** The manifest below was accurate. What it did not
> anticipate: `scripts/material-preview.mts` (the `3-1` debug viewer's PNG
> encoder, driven by the `3-1` Node test under `VITE_MATERIAL_PREVIEW=1`), five
> ownership rows rather than three, four new test files
> (`render.webgpu-surface-materials`, `render.webgpu-material-arrays`,
> `render.webgpu-terrain-surface`, `gpu/terrain-surface-compile`), and edits to
> `core/TextureArrayMips.ts` (the Toksvig kernel), `atmosphere/AtmosphereSystem.ts`
> and `atmosphere/SkyEnvironmentProbe.ts` (`R-26`), `scripts/perf-capture.mts`
> (the `runway-on-approach` scene), `sim.terrain-authority.test.ts` (three new
> invariants), `render.webgpu-budget.test.ts`, `render.webgpu-core.test.ts`,
> `render.webgpu-sky-probe.test.ts` and `world.test.ts`.
>
> `flattenHeightForAirport` was **deleted** rather than modified — the
> earthworks profile replaces it outright, so the deletion list is one entry
> longer than planned.

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
