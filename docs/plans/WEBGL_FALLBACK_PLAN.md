# WebGL2 fallback — planning document

> **Status: PLAN ONLY. Nothing here is implemented, and nothing here changes the
> shipped runtime contract.** `docs/PERFORMANCE.md` still says "no WebGL fallback
> and no Canvas fallback", and that stays true until a phase below is approved
> and lands. Written 2026-09-29 on `jazonshou/perf-low-tier`. Jason asked for
> this doc to exist so the fallback is sized before anyone builds it.

## 1. Scope

**Goal.** A browser without usable WebGPU gets a flyable game, not the startup
error it gets today (`FlightGame.tsx` shows "This browser could not create a
hardware WebGPU device").

**Target fidelity: "Lite", about tier 0.** The fallback does not try to match
the WebGPU renderer pixel for pixel. It keeps the flight model, the world, the
airframes and cockpits, terrain, water and trees. It gives up the effects that
exist only because WebGPU has compute shaders: the FFT ocean, volumetric clouds,
the GPU grass blades and the horizon-occlusion bakes.

**Non-goals.**
- Pixel parity with any WebGPU tier.
- A Canvas2D path.
- Eroded worlds (`?world=eroded`), which are shelved anyway.
- Supporting software GL (SwiftShader), for the same reason the WebGPU path
  refuses software adapters.

## 2. Who lacks WebGPU (late 2026), and what they have instead

| Population | WebGPU | WebGL2 |
| --- | --- | --- |
| Chrome/Edge on Windows, macOS, ChromeOS | yes (since 2023) | yes |
| Chrome on Android 12+ (Qualcomm/ARM GPUs) | yes (since Chrome 121) | yes |
| Safari 26 on macOS/iOS/iPadOS (Sept 2025+) | yes | yes |
| Firefox on Windows (141+) and Apple-Silicon macOS 26 (145+) | yes | yes |
| **Linux**: Chrome partial (Intel Gen12+ first), Firefox none | **mostly no** | yes |
| **Firefox on Android** | behind a flag | yes |
| **Safari/iOS before 26**, Firefox on Intel Macs | no | yes |
| Blocklisted GPUs/drivers, enterprise policy, VMs/remote desktop | no, or a software adapter the game rejects | usually yes (hardware), sometimes software |

WebGL2 is close to universal. The audience a fallback wins is mostly Linux
desktops, older Apple OS versions, and machines with blocklisted drivers.

## 3. What ties the renderer to WebGPU today (inventory)

This comes from a read-only sweep of `src/` and `tests/` on 2026-09-29. Line
numbers are at `6426cd2`. There are roughly 14k lines of WGSL in total.

### 3.1 Engine, device and adapter

- **Adapter probe.** `core/Capabilities.ts:197-228` (`inspectWebGpuCapabilities`)
  refuses in three cases: no `navigator.gpu`, a null adapter, or
  `isFallbackAdapter`. It also checks limits (`REQUIRED_WEBGPU_LIMITS`,
  lines 21-87). **This is already the right detection point**, and it never
  touches the canvas.
- **Engine creation.** `FlightRenderer.create()` (787-900) creates a
  `WebGPUEngine` with explicit features. It also sets `useReverseDepthBuffer`,
  installs `GpuUncapturedErrorGuard` on `engine._device`, and runs
  `assertStartupInvariants`.
- **Device loss** is terminal: `FlightRenderer` 759-763, then `FlightGame.tsx:548`.
- **Diagnostics.** `renderingFallbackReason` is always `null` today
  (FlightRenderer 2235). The `renderBackend` type is the literal `"webgpu"`
  (`game/types.ts`).

### 3.2 Compute: every system, and what already exists without it

| # | System | WebGPU work | Existing non-compute path |
| --- | --- | --- | --- |
| 1 | Ocean FFT (`SpectralOceanSystem.ts`, `OceanShaders.ts` ~380 WGSL) | per-frame Stockham IFFT per cascade, displacement/slope/foam | **none** (only the CPU swell for shore run-up) |
| 2 | Volumetric clouds (`VolumetricCloudSystem.ts`, `CloudShaders.ts` ~740 WGSL) | per-frame ray march, temporal resolve, shadow map | **yes: `supportComputeShaders` false leaves clouds off** and a 1×1 shadow stand-in (345, 355-366) |
| 3 | Cloud noise bake (`CloudVolumeBake.ts` ~225 WGSL) | 3D volumes once, weather map on change | none (the CPU fills were deleted) |
| 4 | Terrain height pages (`TerrainPageAtlas.ts` + `TerrainKernel.ts` ~440 WGSL) | r32float storage atlas, streamed under budget | **yes: the CPU reference `src/world/terrain.ts`** (the WGSL is a transliteration of it) **and an upload path** (`uploadErodedPage`, 1499-1530) |
| 5 | Occlusion/horizon + splat bakes (`PageOcclusionBake.ts`, `LandCoverClassifier`, `densityField`) | rgba8 targets, streamed | CPU twins for the classifier and the density field; **none for the horizon march** |
| 6 | Global height pyramid (`GlobalHeightPyramid.ts`) | 256² r32f + horizon layers, per 512 m of travel | none |
| 7-8 | Page and macro erosion | eroded worlds only | CPU worker path; out of scope |
| 9 | Bathymetry clipmap (`BathymetryClipmap.ts` ~185 WGSL) | 2 × 1024² on recenter | heights come from `terrain.ts`, so a CPU bake is direct |
| 10 | Ground-cover blades (`GroundCoverSystem.ts`, `groundCoverWgsl.ts` ~284) | per-frame scatter into a storage buffer used as instanced vertices | **yes: `gpuActive` false builds grass cards** (`WorldDetailRuntime.ts:897-899`) |

### 3.3 WGSL-only materials

These carry no GLSL twin. Each plugin returns `null` or WGSL for GLSL from
`getCustomCode`.

- **TerrainSurfacePlugin** (~2,400 WGSL lines plus composed modules). Its vertex
  stage does `textureLoad` on the r32f height atlas.
- **AerialPerspectiveMaterialPlugin** (~700 WGSL). It is attached to **every**
  PBR material through `AerialPerspectiveRegistry`. On GLSL it would silently do
  nothing, and the whole scene would lose its haze.
- **DetailInstanceMaterialPlugin** (~1,070 lines; `texture_2d_array` foliage and
  impostor atlases).
- **GroundCoverMaterialPlugin** (~115 lines).
- **ShaderMaterials and post-processes:**
  - Ocean and hydrology water (~1,670 lines plus ~1,900 shared in `WaterShaders.ts`)
  - Sky (~140) and stars (~76)
  - Cloud composite (~68)
  - Light points (~140)
  - Scotopic (~150)
  - Bloom (~60)
  - Sky-ambient procedural texture (~26)
  - Receiver includes (~180)
- **The one existing GLSL twin** is `CloudShadowMaterialPlugin`
  (`CLOUD_SHADOW_PBR_FRAGMENT_GLSL`). A test requires the two languages to match.

**Already backend-neutral:** the aircraft, cockpits, airfield and wildlife.
They use stock PBR plus CPU-authored `RawTexture`s (for example the cockpit
display atlas).

### 3.4 WebGPU-only resource features

- **Storage buffers.** `StorageBuffer` is used in 7 files. WebGL2 has none, so
  every consumer must read a texture or vertex attributes instead.
- **Storage textures** (r32float, rgba16f/32f, 3D).
- **Sub-rect uploads** through `WebGPUEngine.updateTextureData` casts.
- **Readbacks:**
  - `StorageBuffer.read`
  - `readPixels` for the L0 collision page (`TerrainPageAtlas.ts:1681`), which
    is synchronous on WebGL and would stall the frame
  - raw `mapAsync` in `DeferredPassTiming.ts`
- **Timestamp queries:** `DeferredPassTiming.ts`, `GpuTimingPolicy.ts` and
  `ComputeBudget`'s GPU-ms feedback.
- **Indirect draws:** an opt-in for ground cover only (off by default).
- **Reverse-Z:** `useReverseDepthBuffer = true` with a 0.08 m near plane and a
  45 km far plane.

### 3.5 Seams that already exist

- **`FlightRenderingSystem`** (`src/render/types.ts:20`). This is the only
  surface `FlightGame` sees. A second renderer implements this interface, and
  nothing above it changes.
- **Pure CPU modules a Lite renderer can reuse unchanged:**
  - `core/FrameGraph.ts` (WebGPU in name only)
  - `core/AdaptiveGovernor.ts`
  - `cameraPresentation.ts`
  - `TerrainQuadtree.ts` (CDLOD selection)
  - the quality profile resolver
  - the world generators
  - the whole simulation
- **Terrain producer seam** (`TerrainClipmapSystem.ts:92-193`): injectable page,
  channel, splat and pyramid producers, plus a compute factory.
- **Capability gates already in the code:**
  - `supportComputeShaders`: clouds, ground cover, detail.
  - `isWebGPU || _gl`: `WaterShaders`, `WorldDetailRuntime`, `TerrainDebugOverlay`.
  - `isWebGPU` only, so these would need widening: `TerrainPageAtlas`,
    `GlobalHeightPyramid`, `BathymetryClipmap`.
- **`SharedReceiverRegistry`**: each plugin's `getCustomCode(shaderLanguage)` is
  the per-language hook.

### 3.6 Tests and docs that assert WebGPU-only

These must be amended, not deleted, when the fallback lands:

- **`tests/render.webgpu-only.test.ts`** forbids `getContext("webgl|webgl2")`,
  `three`, `WebGLRenderer` and `CanvasFlightRenderer`. It should become "WebGL
  only under `src/render/lite/**`".
- **`tests/settings.ui.test.ts:21`**: the settings markup must not contain
  "WebGL".
- **`render.webgpu-terrain-surface.test.ts:187-190`**: the terrain's GLSL
  custom code must be `null`.
- **"No GLSL" checks** in the hydrology, planar-reflection and nature tests.
- **All 77 GPU tests** run WebGPU by construction (`vitest.gpu.config.ts`).
- **Docs:**
  - `docs/PERFORMANCE.md:12-13`
  - `docs/status/PROJECT_OVERVIEW.md:18`
  - `docs/plans/RESOLUTION_PLAN.md:577-579`
  - `docs/findings/TERRAIN_AUDIT.md:312`

## 4. Architecture options

### Option A: one renderer, per-system backend branches

`FlightRenderer` creates either engine, and each system grows a WebGL2 variant
behind `engine.isWebGPU`.

- **For:** one orchestration path, and no duplicate frame loop.
- **Against:** `FlightRenderer.ts` is 3,450 lines. It is guarded by startup
  invariants, pinned capture baselines, draw-call ceilings and per-tier
  delivery floors. Threading a second backend through it puts every WebGPU pin
  at risk for a path most players never run. Every system file would also carry
  two shader languages.

### Option B (recommended): a separate `LiteFlightRenderer` that shares the neutral parts

- **Where it lives:** a new `src/render/lite/` that implements
  `FlightRenderingSystem`.
- **Loading:** `FlightGame` picks it only after detection fails, and pulls it in
  through a dynamic `import()`. WebGPU players then never download the WebGL
  engine code.
- **What it reuses:**
  - the neutral modules listed in §3.5
  - the aircraft, cockpit, airfield and wildlife visuals (stock PBR)
  - `WorldDetailRuntime`'s CPU generation, with a GLSL detail plugin
  - the terrain CDLOD, with a CPU page producer
- **What it re-implements, and only in GLSL:** sky, aerial perspective,
  terrain surface, water and detail.
- **For:** the WebGPU path's pins never move. The Lite path gets its own
  baselines, and it can be deleted wholesale if the audience goes away.
- **Against:** some orchestration is duplicated (floating origin,
  presentation, the post chain). This is reduced by extracting the pure parts
  first.

### Shader strategy

| Option | Verdict |
| --- | --- |
| Hand-written GLSL twins for a *reduced* Lite feature set | **Recommended.** The Lite set is small: sky, haze, terrain (2 materials, planar), water (Gerstner), foliage, stars, lights. The cloud-shadow plugin already shows how a twin works. |
| Build-time WGSL→GLSL (naga or tint via SPIR-V) | Poor fit. The repo's WGSL is Babylon's *dialect*: preprocessor includes, `uniform`/`varying` sugar, and plugin injection points inside Babylon's own PBR shader. It is not standalone WGSL, so a transpiler would first need Babylon's processed output, and then the bindings would need to be re-mapped for GL. |
| Rewrite as Node Material (NME), which targets both languages | Too big. Every plugin is custom WGSL injected into PBR, and a rewrite would also move the WebGPU pins. |
| One-time LLM-assisted translation of the full shaders | Useful as a *starting point* for the twins. Full parity is not the goal, though, and each twin needs its own test. |

### Replacing compute, per system

| System | Lite replacement | Visual loss |
| --- | --- | --- |
| Terrain height pages | The CPU reference (`world/terrain.ts`) runs in a worker and uploads R32F pages through the existing upload path. The vertex shader uses `texelFetch` (WebGL2 supports vertex texture fetch and NEAREST R32F). Lite streams from finest level 1, like tier 0. | Slower streaming; the same shape |
| Channel/splat bakes | The CPU twins that already exist (`classifyLandCover`, `densityField.ts`), run in the worker. | none expected |
| Horizon/occlusion bake and height pyramid | A coarse CPU horizon on the pyramid, or none. Terrain beyond the shadow cascade goes unshadowed. | distant terrain self-shadow |
| Bathymetry | A CPU bake from `terrain.ts` at 256², in the worker. | shallower water gradient detail |
| Ocean FFT | A vertex-shader Gerstner sum (8-12 waves) plus scrolling normal maps. Fragment-shader FFT on float render targets is possible but not needed at Lite fidelity. | no Jacobian foam, simpler chop |
| Volumetric clouds | Off (the existing path). Add a 2D cloud layer in the sky shader for `cloudy` weather, and no cloud shadows (the existing 1×1 stand-in). | no volumetric clouds |
| Ground-cover blades | The existing grass-card fallback. | sparser near grass |
| Bloom, scotopic | Bloom off (it is off at tier 0 already). Scotopic becomes a simple GLSL port or a colour grade. | night vision nuance |

## 5. Detection and selection flow

```
inspectWebGpuCapabilities()          (adapter probe; never touches the canvas)
  supported ─► WebGPU renderer (today's path, unchanged)
  refused, or WebGPUEngine.CreateAsync fails/times out:
     reason := the probe's reason / the creation error
     WebGL2 probe on a SCRATCH canvas:
        getContext("webgl2", { failIfMajorPerformanceCaveat: true })
     ok  ─► await import("src/render/lite") ─► LiteFlightRenderer on a FRESH canvas
     no  ─► today's startup error, now naming both reasons
```

- **A canvas holds one context type for life.** If the WebGPU path already
  called `getContext("webgpu")` on the game canvas before failing, the fallback
  must *replace the canvas element*. Reusing it returns `null`.
- **Never two engines in one page** (see the Babylon traps recorded 2026-09-23:
  module-level GPU-timing state leaks between engines). Dispose the failed
  WebGPU engine completely before creating the WebGL one, or better, never
  construct it when the probe already refused.
- **`failIfMajorPerformanceCaveat: true`** keeps software GL out, matching the
  WebGPU path's refusal of fallback adapters.
- **Visibility and testing hooks:**
  - `?renderer=webgl` forces Lite on a WebGPU machine, for testing and for users
    whose WebGPU driver misbehaves.
  - `renderingFallbackReason` carries the reason into diagnostics.
  - `renderBackend` widens to `"webgpu" | "webgl2"`.
- **Settings.** Lite has one quality level, so the Graphics/Rendering selectors
  either hide or map onto Lite sub-levels. Jason decides (open question 2).
- **Mid-session WebGPU device loss** stays terminal. The reload *could* offer
  Lite, but that is a later decision.

## 6. The Lite quality contract (proposed)

These are starting values to measure against, not promises.

| Budget | Lite |
| --- | --- |
| Pixel cap / DPR ceiling | 1.0 Mpx / 1 |
| Anti-aliasing | FXAA (no MSAA) |
| Sun shadows | 1 cascade, 1,024², 600 m, or off on weak devices |
| Terrain finest level / CDLOD node budget | 1 / 192 |
| Materials blended | 2, planar projection, no ground patchwork |
| Vegetation radius / density | 1.5 km / 0.35 |
| Active animals | 8 |
| Ocean | Gerstner, 1 near ring set |
| Clouds | 2D layer only |
| Frame target | 30 fps on a WebGL2-class integrated GPU |
| Draw-call ceiling | below tier 0's (WebGL2 submission costs more CPU per draw than WebGPU; see §8) |

The Lite path gets its own capture shots, baselines and draw-call ceilings in a
separate baseline directory, so no WebGPU pin moves when Lite changes.

## 7. Testing plan

- **Unit and architecture tests:**
  - Amend `render.webgpu-only.test.ts` so WebGL is allowed only under
    `src/render/lite/**`.
  - Give every GLSL twin an `owners.ts` row and a twin-parity test, modelled on
    the cloud-shadow one.
- **Browser tests:**
  - Add a `vitest.webgl.config.ts`: Playwright Chromium launched with WebGPU
    disabled (`--disable-features=WebGPU`), so detection is exercised for real.
  - Also run Lite on WebGPU hardware through `?renderer=webgl`.
  - **One engine per test file**, as the GPU suite already requires.
- **Capture rig:** a second shot list for Lite, with frames and draw counts
  pinned the same way as the WebGPU list. The hosted macOS CI runner has WebGL2
  through ANGLE-Metal, so it can gate Lite. (It lacks WebGPU timestamp queries,
  which Lite does not need anyway.)
- **Front-door probe:** `scripts/throttle-probe.mts` (from the low-tier
  performance work) already drives the real game under a CPU throttle. Lite
  needs the same bar.

## 8. Risks

1. **Depth precision.**
   - Babylon's `useReverseDepthBuffer` on WebGL only flips the depth compare
     (`abstractEngine` sets the depth function to `GREATER` or `LEQUAL`).
   - This Babylon build has **no `EXT_clip_control` support**, so GL's [-1, 1]
     clip range remains, and reversed-Z buys nothing.
   - At 0.08 m near and 45 km far, a standard 24-bit depth buffer will z-fight
     at range.
   - Candidates:
     - logarithmic depth (Babylon's `useLogarithmicDepth`; each custom GLSL
       shader must include the log-depth chunks)
     - a larger near plane outside the cockpit
     - a two-pass near/far split
   - **This needs a spike first; it decides the rest.**
2. **CPU cost of WebGL draw submission.** Each WebGL draw is several GL calls
   through ANGLE. Babylon's WebGL2 path typically spends more main-thread time
   per draw than its WebGPU path. The machines that lack WebGPU are also the
   weaker ones. So **the Lite draw budget sits on the same axis as the
   4×-CPU-throttle work** (`LOW_TIER_PERFORMANCE_PLAN.md`), and Lite should
   inherit whatever that work learns about draw counts and per-frame main-thread
   cost.
3. **Varyings and uniform limits.**
   - WebGL2 guarantees 15 varying vectors, against WebGPU's 16 inter-stage
     slots. The terrain and detail plugins were already fitted into the 16-slot
     budget (see the 16-input finding).
   - UBOs are ≥ 16 KB.
   - Vertex texture units: ≥ 16.
4. **Float textures.**
   - Rendering to float needs `EXT_color_buffer_float` (near-universal on
     desktop).
   - Linear filtering of 32-bit float needs `OES_texture_float_linear`, which
     is not universal on mobile. Use NEAREST with manual bilinear, or 16F.
5. **Synchronous readbacks.** Nothing in Lite may call `readPixels` per frame.
   Collision already has a CPU source: the simulation worker samples the analytic
   terrain itself.
6. **Shader compile hitches.** WebGL compiles are synchronous unless
   `KHR_parallel_shader_compile` is present. Babylon uses it when available
   (`thinEngine`). Pre-warm the Lite materials behind the load screen.
7. **Bundle size.** The WebGL engine and GLSL shader store must sit behind a
   dynamic import, so the WebGPU download does not grow.
8. **Tree-shaken Babylon traps** (recorded 2026-09-2x): `DynamicTexture` is
   unusable in this build, a constructor throw can leave half-built objects, and
   a new dependency makes the next dev load return 504s. The Lite imports need
   the same care.

## 9. Phasing and rough effort

These are engineer-days for one engineer. They are estimates, not
measurements.

| Phase | Content | Effort |
| --- | --- | --- |
| L0 | Detection refactor, canvas replacement, `?renderer=webgl`, reasons in diagnostics, better error copy. No renderer yet; Lite shows "coming soon". | 1 |
| L1 | Depth-precision spike (risk 1): log depth vs near-plane split, on WebGL2 via ANGLE-Metal. | 1-2 |
| L2 | Lite skeleton: engine, shared presentation/floating origin/frame graph, sky and aerial perspective in GLSL, the aircraft and cockpit (stock PBR), airfield, 1-cascade CSM, ACES + FXAA. | 4-6 |
| L3 | Terrain: CPU page producer in a worker, R32F upload, GLSL terrain surface (reduced), CDLOD reuse, CPU splat/channel bakes. | 6-9 |
| L4 | Water: Gerstner ocean, flat lakes and rivers, CPU bathymetry. | 3-5 |
| L5 | Detail: GLSL detail plugin (reduced), grass cards, wildlife. | 3-5 |
| L6 | Night and weather: stars, light points, 2D cloud layer. | 2-3 |
| L7 | Tests, Lite capture list and baselines, draw ceilings, docs (§3.6 amendments). | 3-5 |
| **Total** | | **~23-36** |

L0 alone is worth doing early. It turns a dead end into a clear message, and it
builds the seam every later phase needs.

## 10. Open questions for Jason

1. **Is the audience worth ~5-7 weeks?** The main groups are Linux desktops,
   pre-26 Apple OS versions, Firefox on Android and blocklisted GPUs. An
   alternative is L0 only: a clear "use Chrome, Edge or Safari 26" page.
2. **Settings under Lite.** Should Lite expose the Graphics/Rendering selectors
   (mapped to Lite sub-levels), or show one fixed quality with a "Lite
   renderer" badge?
3. **Visual floor.** Is "no volumetric clouds, Gerstner ocean, sparser grass"
   acceptable for the fallback?
4. **Forced Lite on WebGPU machines.** Should Lite also be offered where WebGPU
   exists but performs badly (old integrated GPUs)? This would reuse the
   `?renderer=webgl` path, but it needs its own acceptance bar.
