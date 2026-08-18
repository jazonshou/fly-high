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
| Volumetric cloud shader modules — raymarch, temporal resolve, shadow | clouds | `src/render/webgpu/nature/CloudShaders.ts` | live (`2-0`) |
| Atmosphere GPU resources — transmittance LUT texture, sky-ambient LUT, blue noise, scene depth | lighting | `src/render/webgpu/atmosphere/AtmosphereGpuResources.ts` | live (`2-0a`) |
| Sky environment probe / IBL | lighting | `src/render/webgpu/atmosphere/SkyEnvironmentProbe.ts` | planned `1C-6` |
| Quality tiers + governors | performance | `src/render/webgpu/core/QualityProfile.ts` (+ `AdaptiveGovernor.ts` `1A-6b`, `PerformanceBudget.ts` `1A-2`) | live |
| Runway earthworks profile | terrain-material | `src/render/webgpu/terrain/RunwayEarthworks.ts` | planned `3-8` |
| Vegetation density function | vegetation | `src/render/webgpu/detail/densityField.ts` | planned `1B-7` |
| `MAX_TERRAIN_HEIGHT` (2,200 m until `5-8`) | terrain-geometry | `src/world/terrain.ts` | live |
| Channel-graph extractor | water | `src/render/webgpu/water/ChannelNetwork.ts` | planned `5-5` |
| Shared water shading helpers — fresnel, GGX assemblies, reflected sky | water | `src/render/webgpu/water/WaterShaders.ts` | live (`2-8a`) |
| `detail.worker.ts` | vegetation | `src/workers/detail.worker.ts` | planned `1B-10` |
| Aircraft form and materials | aircraft | `src/render/webgpu/aircraft/` | planned Gate `A-1`/`A-2` |
| Land-cover classification — the one authority for terrain splat, vegetation species and wildlife habitat | terrain-material | `src/render/webgpu/terrain/LandCoverClassifier.ts` | planned `4-6` |

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

**Amended 2026-08-18 (`PRE_PHASE_4_REALIGNMENT.md` §4, `R-13`).** The rule has a
hole: the check is *syntactic*, and the one file that most needs the clock is not
in the family. `src/world/terrain.ts` carries `classifyBiome` — which decides snow
today at `temperature < 0.2 || height > seaLevel + 1_520` — and §5 makes it the
source `4-1` transliterates into WGSL, so `4-6`'s seasonal classifier would be
transliterated from a kernel with no clock: exactly the retrofit this rule exists
to prevent. Add `seasonalTemperatureOffsetK(dayOfYear, latitudeDegrees)` as a pure
kernel function, thread it into `sampleTerrainTemperature`/`classifyBiome`, and add
`src/world/terrain.ts` to `SEASONAL_FIELD_FAMILY` in the same commit. Also
unowned: `snowCoverage`, `surfaceWetness` and `precipitation` are declared and
GPU-packed but hardcoded to 0 by `EnvironmentDirector`, and no item owns them.

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
| `2Z` | The evaluation surface (PRE_PHASE_4_REALIGNMENT §3) shipped before any Phase 2 pixel work. | Capture pinned at renderScale 1.0 (no letterbox), rAF-paced measurement, per-shot committed fps/hitch/max-frame ceilings, temporal-stability floors on a banked-turn motion scene, per-shot clocks (winter noon, night), the reference-viewport shot where the tier-1 cap binds, and the five §10.2 Phase-2 scenes. `gpuFrameMsP95` reads real values (R-4 was a sampling-window artefact; diagnostics now aggregate a rolling 600-frame ring the governor never consumes). Tier-1 MSAA 4×→2× (~34 MiB; alpha-tested foliage gets no MSAA benefit). One sanctioned rebaseline. |
| `2Z` | One allowlisted capture error signature. | Babylon 9.21.2's WebGPU backend gives each submesh its own material context but a shared material's textures bind only on the first submesh per frame; the remaining submeshes log `cloudShadowSampler … not found` exactly once when a fresh pipeline+context pair first draws, then heal. Verified pixel-free (all SSIMs hold). The receiver plugin now binds through `hardBindForSubMesh` with an always-bound 1×1 fallback and is enabled from construction (no mid-flight define churn); the residual burst is the allowlisted signature. Revisit at any Babylon bump. |
| `R-11` | Work ladder split into CPU-cost and GPU-cost levers. | GPU-bound windows never recover any lever; when Governor A is latched resolution-insensitive or floored (the reference-machine default state, R-6), the GPU ladder (reflection/cloud-shadow cadence, shadow-caster distance, vegetation distance) is the actuator. Pinned by two synthetic-trace tests. |
| `R-13` | Season is an ANCHORED deviation from the tuned midsummer world, and snow is appearance, not classification. | All seasonal kernels are exact zeros/ones at `TERRAIN_REFERENCE_DAY_OF_YEAR` (171), so the shipped look is bit-identical at the default clock (pinned). The snow blanket migrates in the baked colours; `classifyBiome`/`sampleTerrainTemperature` stay climatic — threading the offset into them would flip FOREST↔GRASSLAND with the calendar, which `2-18`'s own rule (species mix stays climatic) forbids, and would delete forests under winter SNOW. Seasonal humidity rides D-5's turbidity term; `EnvironmentDirector` fills `snowCoverage` from the same kernel; `surfaceWetness` stays 0 until a precipitation model owns it (recorded decision — nothing renders precipitation in Phases 2–5; the `2-1` weather bake carries the channel for that future consumer). Terrain pages re-bake per anchored ~15-day season bucket. |
| `2-0a` | The "sky-view LUT" is an (elevation × sun-relative azimuth) ambient table; the multiple-scattering LUT stays CPU-only. | The adopted march consumes ambient by (view elevation, sun-relative azimuth); a full Hillaire sky-view LUT would duplicate the sky dome's closed form for no additional consumer. The transmittance LUT upload is a verbatim rgba16float copy of the tested CPU bake (D-4's first GPU consumer), sampled with the exact `transmittanceLutUv` parameterisation (pinned by test). The MS LUT has no shader consumer, and uploading an unread texture is the dead-code habit this programme corrects. Blue noise is generated at startup (void-and-cluster, deterministic — the repo ships no binary assets). Scene depth is a `DepthRenderer` storing camera-space Z (clear 0 = sky); the cloud march reads last frame's map (the depth pass renders with the scene, after the dispatch) — one frame of clip latency, invisible at cloud distances. |
| `2-1` | Volumes baked on the GPU; the curl volume is not baked. | 128³ rgba8 perlin-worley base + 32³ rgba8 erosion detail on period-wrapped lattices (assertion 37 proves bit-exact tileability on-adapter; the check uses 1/256-grid coordinates because `u + 1` of an arbitrary f32 is itself unrepresentable). No shader consumes curl, so it arrives with its consumer. Precipitation is baked as a weather channel with NO renderer (R-16's open question, decided out loud: the channel completes the weather contract for a future wetness pass; nothing reads it in Phases 2–5). Cloud volume memory is a live `DYNAMIC_ALLOCATIONS` input (~9.1 MiB). |
| `2-3` | Anti-tiling via an ENDLESS weather field, not a toroidal clipmap. | The weather map is a camera-following 512² window (re-snapped on a size/8 grid, one cheap re-bake per ~12 km flown) onto a field of unwrapped world-cell hashes — it cannot repeat, ever, which is strictly stronger than the plan's toroidal clipmap of a repeating texture. The wind offset stays unwrapped (wrapping would teleport the pattern) and the window follows the advected position. Dual-scale base sampling (second fetch at an incommensurate 3.7× scale) breaks the base volume's own repeat period. The toroidal-addressing helper the plan wanted for `5-10` arrives with `5-10`. |
| `2-5` | Empty-space skipping + DISTANCE-ADAPTIVE strides shipped; the coverage prepass deferred. | The march long-strides (2× the coarse step) through zero density and steps back one stride on re-entry. All strides (fine, coarse, skip, start jitter) grow linearly with ray distance — ×2 at `stepDoublingDistanceMeters` (default 4 km, packed in `camera_up.w`) — and the sun-march step count decays on the same curve (floor 2); `cloudLighting` returns ambient-only when sun energy is negligible. Measured need, not speculation: the first 2A rebaseline put sky-heavy shots at 20–32 ms GPU p95 (slant-10km +24.9 ms vs pre-cloud) because horizon-grazing rays spent the whole 96-step budget at near-field stride inside the 5.7 km slab, 8 light fetches per sample — night paid the full light march for zero sun radiance. A per-thread density-sample counter lands in an atomic storage buffer, read back every 60 frames into `statistics.densitySamplesPerFrame` (assertion 39's number). The low-resolution coverage prepass stays deferred — skipping plus distance growth covers the measured cases. |
| `2-7` | Shadow footprint 24 km at 512² (47 m/texel). | The adopted shadow compute already WAS the sun-space tangent-plane footprint marching from the surface toward the sun — the `1/sunDirection.y` degeneracy does not exist in it. The receiver contract (`CloudShadowProjection` + inverse-sun reference-plane projection) is unchanged: with world-aligned tangent axes and a 24 km footprint the tangent-plane sagitta is ~45 mm, far below a texel. R-19 held — no transmittance multiply was added. |
| `2-8a` | Water shading extracted; the byte gate is a WGSL text hash, not a capture diff. | `WaterShaders.ts` owns fresnel, both GGX assemblies (the ocean's combined lobe and the hydrology's split pair stay separate exports — different BRDF assemblies, unified by `2-9`, not by the extraction) and a `reflectedSky` generator whose genuinely divergent constants (horizon falloff 2.5/2.3, overcast palettes, sun disc 3200×16 / 1800×11) are named `WaterReflectedSkyParameters` at the two call sites. Assertion 41 is implemented as a pinned SHA-256 of the composed ocean WGSL — the shared blocks recompose the pre-extraction text character for character, so the rendered output is identical by construction; two captures of a temporally-jittered volumetric sky are never byte-equal, a text-identical shader is (recorded deviation from the plan's capture-diff). Hydrology's text canonicalises (parameter renames only — `cosine`→`cosTheta`, `horizonAmount`→`horizon`, `solarGlare`→`sun`), which is output-neutral. Deliberate shading changes re-pin the hash in the same commit — drift stays impossible, change stays explicit. |
| `2-0` | `CloudShaders.ts` adopted wholesale; raymarch converted to compute; ray basis everywhere; R-19 honoured. | All three modules run through Babylon `ComputeShader` (the ocean's pattern) — the raymarch writes two rgba16float storage textures instead of an MRT fragment pass, so no MRT plumbing needs to exist. The adopted motion-vector path (`previous_view_projection`) was deliberately NOT adopted: it is the 1A-4 stale-matrix bug class, and the temporal resolve reprojects from the previous ray basis + absolute camera delta instead (CloudReprojection's invariant, ported into the compute). No `shadow × transmittance` term was added anywhere (R-19/D-7 — haze-through-shadow stays structural). The shadow map stores rgba16float (r32float is not filterable and every receiver filters). The config is truthful: profile/schedule tiers enter through `resolveVolumetricCloudConfig` overrides and assertion 35 proves every field reaches a uniform block. Assertion 36 compiles and dispatches all three modules on a real adapter. |
