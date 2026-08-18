# fly high — Architecture Reference

**Status: normative.** This file is the live architectural contract, enforced by
[`src/render/webgpu/owners.ts`](src/render/webgpu/owners.ts) and
[`tests/architecture.boundaries.test.ts`](tests/architecture.boundaries.test.ts):
adding a second definition of an owned artifact fails `npm test` with a message
naming the owner. `RENDERING_PLAN.md` stays the programme plan; `TERRAIN_AUDIT.md`
stays the evidence; this file is what the code must satisfy *today*.

---

## 1. Single owners

Every artifact below has exactly one owner and one definition site. Consumers
import; they do not re-derive. Rows marked *planned* name the plan item that
creates the file — the ownership decision is already binding.

| Artifact | Owner | Definition site | Status |
|---|---|---|---|
| World-page payload schema — every page channel | terrain-geometry | `src/render/webgpu/world/payload.ts` | live |
| Page geometry — one number | terrain-geometry | `src/render/webgpu/world/pageGeometry.ts` | live |
| `TerrainPageAtlas` | terrain-geometry | `src/render/webgpu/terrain/TerrainPageAtlas.ts` | planned `4-2` |
| `TerrainErosionCompute` | terrain-geometry | `src/render/webgpu/terrain/TerrainErosionCompute.ts` | planned `5-1` |
| Aerial-perspective WGSL include | lighting | `src/render/webgpu/atmosphere/AerialPerspective.ts` | planned `1C-4` |
| Sky environment probe / IBL | lighting | `src/render/webgpu/atmosphere/SkyEnvironmentProbe.ts` | planned `1C-6` |
| Quality tiers + governors | performance | `src/render/webgpu/core/QualityProfile.ts` (+ `AdaptiveGovernor.ts` `1A-6b`, `PerformanceBudget.ts` `1A-2`) | live |
| Runway earthworks profile | terrain-material | `src/render/webgpu/terrain/RunwayEarthworks.ts` | planned `3-8` |
| Vegetation density function | vegetation | `src/render/webgpu/detail/densityField.ts` | planned `1B-7` |
| `MAX_TERRAIN_HEIGHT` (2,200 m until `5-8`) | terrain-geometry | `src/world/terrain.ts` | live |
| Channel-graph extractor | water | `src/render/webgpu/water/ChannelNetwork.ts` | planned `5-5` |
| `detail.worker.ts` | vegetation | `src/workers/detail.worker.ts` | planned `1B-10` |

Phase 0 added four more contracts under the same enforcement: the environment
clock (`src/world/environmentClock.ts`), the simulation terrain authority
(`src/sim/terrainGrid.ts`), the terrain collision mirror
(`src/render/webgpu/terrain/TerrainCollisionMirror.ts`), and the shared
receiver registry (`src/render/webgpu/core/SharedReceiverRegistry.ts`).

**The channel rule.** Every addition of a page channel goes through one PR
against `payload.ts`. No page-channel type is declared anywhere else.

**The tier rule.** Subsystems contribute *data fields* to
`WebGpuQualityProfile`; they do not branch on `profile.tier` with their own
constant tables. Three pre-Phase-0 readers are grandfathered in the boundary
test; the list only shrinks.

## 2. Page geometry — one number

- Base page extent: **512 m** (level `n` extent = `512 · 2ⁿ`)
- Gutter: **4 samples**, every page kind, extending *outside* the page
- Height core: **256** (stored edge 264)
- Every other channel core: **128** (stored edge 136)
- Core sample `(row, column)` lives at stored index
  `(row + gutter) · storedEdge + (column + gutter)`; the world coordinate of
  core sample `i` is `pageOrigin + i · texelSize`.

No 132², no 260², no 66². The same addressing convention serves Phase 1's tile
halo (`gutter = 1`) and Phase 4's atlas (`gutter = 4`).

## 3. The physics/render consistency invariant (§1.3)

**The surface the aircraft touches and the surface on screen are produced by
the same authority.** Until `5-2` that authority is
`sampleNaturalTerrainHeight` — by construction; afterwards it is the eroded
readback grid — by parity tests.

- Every physics terrain query routes through `src/sim/terrainGrid.ts`. The
  boundary test forbids direct collision-kernel imports anywhere else, so
  `5-2` changes exactly one file.
- `src/render/webgpu/terrain/TerrainCollisionMirror.ts` is the render half;
  `RenderDiagnostics.collisionSamplesServedByFallback` (HUD row exists) must
  stay 0 below 500 m AGL.
- The four invariant tests live in `tests/sim.terrain-authority.test.ts`:
  runway influence exactly 1.0 across the apron; ground clearance never
  negative over a real-terrain profile; render-path heights equal physics-path
  heights at L0 (exact at f32 storage precision); the crash-recovery ring
  fully served by the active authority. **They pass trivially today. They must
  keep passing at every gate to Phase 5.**

## 4. Season and time of day (§1.6)

The rendering inputs are two continuous scalars — `EnvironmentClock
{ dayOfYear, solarTimeHours }` (`src/world/environmentClock.ts`) plus
`WorldDefinition.latitudeDegrees` (default 45°N). `TimeOfDayPreset` survives
only as a UI label; after `1C-1` the renderer never branches on it.

**The threading rule:** `dayOfYear` is part of every seasonal field function's
signature *from the moment it is first written* — the vegetation density field
(`1B-7`), the appearance field (`2-18`), the surface palette (`3-10`), the
land-cover classifier (`4-6`). The boundary test checks each of these files
for an environment-clock reference as it comes into existence.

## 5. Kernel portability (0-4)

`src/world/{seed,noise,terrain,geology}.ts` is simultaneously the physics
authority (until `5-2`) and the source `4-1` transliterates into WGSL:

- `unitFloatFromHash` returns a **24-bit** quotient — exactly representable in
  f32 on both sides.
- Every noise lattice is periodic with `NOISE_LATTICE_WRAP_PERIOD_CELLS`
  (2¹⁷ cells); coordinates are wrap-reduced in f64 before any floor. The wrap
  is an exact no-op within ±65,536 cells of the origin (≥ 2.8×10⁶ m at the
  finest octave).
- `pow` bases are explicitly `max(0, …)` so `4-1` is a transliteration.
- `filterWidthMeters` is a **required positional parameter** of
  `sampleNaturalTerrainHeight`, `sampleGeologicalRelief`,
  `sampleTerrainMoisture`, `sampleTerrainTemperature` — a behavioural no-op
  (`0` everywhere) until `1B-2` lands band-limiting. Collision keeps `0`
  forever.

## 6. Test environments (0-8)

Two Vitest projects: `vitest.config.ts` (Node — every pure assertion, runs in
seconds, part of `npm run verify`) and `vitest.gpu.config.ts`
(`npm run test:gpu` — headless Chromium via Playwright with
`--enable-unsafe-webgpu --use-angle=metal`, full-Chromium `channel:
"chromium"`; the headless shell has no GPU). GPU tests live in `tests/gpu/`
and are excluded from the Node project. Run `test:gpu` explicitly and at every
gate boundary.

---

## Decision log

| Item | Decision | Detail |
|---|---|---|
| `0-9` | **Premise validated** — plugin vertex displacement + `ShadowDepthWrapper` compose on WebGPU/WGSL. Terrain stays a `PBRMaterial` with plugins; no `ShaderMaterial` re-plan. | Working incantation, verbatim: attach every vertex-participating plugin to the `PBRMaterial`, then `material.shadowDepthWrapper = new ShadowDepthWrapper(material, scene)` **before the material's first effect compiles** (the wrapper only learns about base-material effects through `onEffectCreatedObservable`; attached later it silently falls back to the undisplaced default depth pass). No `remappedVariables` needed. Proven in `tests/gpu/shadow-depth-wrapper.test.ts`: without the wrapper the shadow ignores a 25 m plugin displacement; with it, the shadow tracks within measurement noise, composed with `CloudShadowMaterialPlugin` on the same material. |
| `0-8` | Vitest browser mode + Playwright (not the manual shader-check page). | Chromium (full, new-headless) acquires a WebGPU adapter and Babylon `ComputeShader` compiles, dispatches and reads back in ~2 s. Provider: `@vitest/browser-playwright`. Harness gotcha worth its own line: manual `scene.render()` must be wrapped in `engine.beginFrame()/endFrame()` or nothing is submitted, and canvas snapshots must be taken synchronously with the submit. |
| `0-3` | Streaming options: module defaults + `levelPenaltyMeters: 400`. | The module default of 0 assumes explicit parent biasing, which the CPU tile path does not do; 400 m/level preserves the deleted `distance + level·400` fine-first ordering at equal corridor cost. Observed change: ahead-of-aircraft pages now rank before behind pages at equal distance (pinned in `tests/render.webgpu-terrain-clipmap.test.ts`); a ring-count-only profile change no longer regenerates identical pages (the deleted generation counter used to re-request everything). |
| `0-3` | Lifecycle states exercised by the CPU path: `unloaded → queued → loading → cpu-ready → uploading → resident` (synchronous upload) and `resident → evicting → unloaded`; failure path `loading → failed → queued`. | The asynchronous upload half (`uploading` with real GPU latency, `evicting → resident` cancellation) is untested until `4-2`. |
| `0-6` | `timeOfDay` label → clock migration: `dawn → (171, 5.5)`, `day → (171, 12.5)`, `golden → (171, 19)`. | All three sit on the same midsummer day at the default 45°N — the presets were three times of one pleasant flying day. Exported as `TIME_OF_DAY_PRESET_CLOCKS`; `1C-9`'s preset buttons write these same pairs. |
| `0-4` | Golden values re-verified rather than re-baselined. | The 24-bit truncation moves every lattice value by < 1.2×10⁻⁷ (≲ 0.2 mm of terrain), and the domain wrap is an exact no-op inside ±2.8×10⁶ m. Every world threshold test, the 384-seed airport audit, and `sim.flight.test.ts` pass unchanged — the latter checked in isolation from any rendering change, per R-0E. |
| `1A-4` step 3 | Double-blend hypothesis **refuted by measurement**; culling enabled anyway. | `tests/gpu/cloud-shell-culling.test.ts`: a premultiplied 0.5-alpha camera-centered BACKSIDE shell reads identically to the idempotent alpha-1 control — one blend per pixel, cull on or off (geometrically, a ray from the shell's center crosses the surface once; the second hemisphere is clipped behind the camera). `backFaceCulling = true` is therefore visually a no-op today, kept as protection if the shell ever de-centers; Babylon's render-target winding flip and frontFace inversion cancel, so BACKSIDE stays correct. No `densityMultiplier`/extinction re-tune needed. |
| `1A-6a` | Per-tier pixel caps: 1.0 / 1.5 / 2.4 Mpx; DPR ceilings 1 / 1.5 / 2. | Default tier renders ≤ 1.5 Mpx on the reference 1512×982 @ DPR 2 viewport (was 5.94 Mpx). Ultra's 4.0 Mpx row arrives with the four-tier table at `1A-6b`. |
| `1A-5` | Depth-only CSM via `noColorAttachment` override, not `useRedTextureType: false`. | The plan's premise was stale: Babylon 9.21.2's CSM already defaults `useRedTextureType = true` (R16F), so the saving left was the never-sampled colour attachment itself. `DepthOnlyCascadedShadowGenerator` overrides `_createTargetRenderTexture` to drop it; PCF keeps sampling the depth texture (proven on-adapter in `tests/gpu/depth-only-csm.test.ts`). |
| `1B-3` | Ladder: constant resolution 65 at tiers 1–3 (33 at tier 0). | Constant per-tier resolution keeps every adjacent-level ground-sample ratio exactly 2:1, killing the audit's 4:1 L2/L3 T-junction. Terrain page generation p95 measured 7.2–7.5 ms against the 9 ms budget (M-series, `perf:capture` report). |
| `1B-11` | MSAA via `toneMap.samples` (the first post-process owns the offscreen beauty target), not `DefaultRenderingPipeline`. | The tone-map post-process already forces the offscreen target, so its `samples` property is the exact place MSAA lives; a full pipeline import would drag unrelated passes. FXAA detaches whenever MSAA > 1 — running both softens the image. Tier 2 runs 2× (not 4×): the 700 MiB budget assertion caught a 734 MiB estimate with 4× alongside the full-distance 4096² CSM; `4-8`'s near-field maps buy 4× back. |
| `1B-9` | Domain-warp noise deleted from the scatter; stems interpolate density bilinearly. | The warp's own lattice re-introduced a 37 m spectral line — the exact artefact class `1B-9` exists to kill. Blue-noise scatter is a global 32 m block lattice, stratified full-cell jitter (exact zero line spectrum), O(n) rank thinning over a spatial hash, per-subcell seed streams for cross-page determinism. |
| `1B-7`/`1B-9` | Ecological density is authored; the renderer thins by rendered share. | The ecological field's closed-forest density is unrenderable as instances (measured ~39 M triangles, ~190 ms CPU per page set). Selection-keyed rendered-share thinning (near budget 40 + 30·vegetationDensity stems/ha, (1000/d)² distance falloff, floor 0.04) keeps the field's statistics testable while the renderer draws a budgeted sample. |
| `1B-13` | fp16 FFT with per-axis 1/N normalisation on the last stage of each axis. | Normalising once at the end overflows half floats mid-transform; splitting 1/N per axis keeps every intermediate in fp16 range. Cascade-energy parity vs fp32 asserted per cascade on the measured most-energetic cascade (a fixed "largest" cascade is nearly empty at low wind). |
| `1C-2` | One exposure: `1.08 × (E_ref/E)^0.12`, `REFERENCE_EV100 = 15.27`. | The reference key anchors at the old day preset's sun height (sin 0.82), so day+clear is preserved exactly and any look change is a detected bug. Adaptation is deliberately weak (k = 0.12) — dawn stays dim; the clamp [0.3, 2.6] is `1C-10`'s twilight floor. Assertion 29 greps `src/` so no shader multiplies a private exposure again. |
| `1C-3` | Transmittance/multiple-scattering LUTs are CPU-baked (256×64 and 32×32), not GPU passes. | The bake is microseconds at these sizes, runs in Node for tests, and the CPU-side model must exist anyway as the TS mirror for exposure, IBL and the agreement tests. The GPU never samples the transmittance LUT in Phase 1 — see the `1C-4` sun-transmittance decision. |
| `1C-4` | Turbidity expressed once: `mieTurbidityMultiplier = 1 + humidity·26` (clear = 12.7×). | Textbook Mie coefficients leave ~44% transmittance at 45 km — real mountains stay visible — failing the plan's own ≥95%-opacity exit criterion. With the multiplier, clear-weather luminance transmittance at the 45 km far plane measures ≈4.6% (τ_green ≈ 3.1) while a 10 km ridge keeps ≥40% — haze, not soup. Pinned in `tests/render.webgpu-aerial-perspective.test.ts`. |
| `1C-4` | Sun transmittance rides as a per-frame uniform (camera altitude), not a per-fragment LUT fetch. | One fewer sampler in every consumer (PBR plugin UBO, three ShaderMaterials, the sky), exact TS/WGSL agreement by construction, and the error — sun transmittance varying along the path — is second-order at ≤45 km path lengths. Assertion 31 measures TS vs GPU agreement within 1% over 100 probes × 2 atmospheres on a real adapter. |
| `1C-4` | `terrainRings` 6/7/8/8 → 6/7/7/7, not the plan's one-per-tier cut. | Guaranteed worst-case clipmap coverage is `512·2^rings` m (the observer can sit at the edge of the outermost level's centre page). Only level 7 (131 km) sits wholly beyond the 45 km far plane; cutting lower tiers would end terrain *inside* it. Tier 0 stops at 32.8 km behind ≈89% haze opacity — pinned as a decision, not drift. |
| `1C-4` | Haze ambient carries the palette's `skyHorizon` colour at 0.9 strength. | Single scattering alone leaves the horizon several times too dim (real horizon brightness is mostly multiple scattering, measured ≈0.1 vs the sky's ≈0.7 radiance); tying the ambient to the sky's own horizon colour makes terrain fade into the sky it actually meets. `1C-5` then makes sky and haze the same integral, so the agreement stops being an input convention. |
| `1C-6` | Probe re-renders all six faces once per environment change (or >500 m altitude drift), not one face per frame. | The sun is static between clock scrubs; a six-draw 128 px pass over a ~100-ALU sky shader costs less than being six frames stale after a scrub. Diffuse SH is CPU-baked from the TS mirror (16 px cube, sub-millisecond) with a below-horizon ground-bounce attenuation (floor 0.25) so the bright horizon haze does not light undersides more than tops; validated against the πL identity. |
| `1C-8` | Shadow-through-haze is structural, not a tuned term. | Every consumer applies aerial perspective multiplicatively after shadowing (`color·T + inScatter`), so a shadow's contribution fades with the fragment's own transmittance and the haze in-scatter is correctly unshadowed. No `strength × transmittance` uniform exists to drift. |
