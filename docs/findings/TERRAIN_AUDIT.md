# Why fly high's Terrain Doesn't Look Real

*(Banner added 2026-08-19.)* **Snapshot of working tree `58d5d15` (pre-overhaul evidence baseline). Present-tense claims describe that tree; remediation status lives in the phase execution plans.**

**A root-cause analysis.** All claims below were verified against the working tree at `58d5d15` and adversarially re-measured; where two measurements disagreed I give the range.

---

## 1. The core diagnosis

**You have spent your effort on two things that cannot produce realism, and both times you left the actual causes untouched.**

The first is the migration. Commit `5ef9a0f` "Switch to WebGPU" was not a graphics-API change — it was an *engine* change, three.js `^0.185.1` → `@babylonjs/core 9.21.2` (`package.json:21`). A graphics API is a submission mechanism. It determines how draw commands reach the driver; it has no opinion about what the pixels contain. Nothing in the WebGPU specification makes a mountain look like a mountain. Worse, that commit was a *budget reallocation away from terrain*: of 20,452 lines added, `webgpu/terrain/` got 844 (4.1%) while water + clouds + nature got 8,327 (41%), against the 4,234 lines the old build spent on terrain, forest, ground cover, bathymetry and LOD morphing alone. Your ocean and clouds are genuinely better than before. Your terrain lost its detail texture, its ambient occlusion, its screen-space reflections, its temporal accumulation, its MSAA, its ground cover, and its per-tier memory and pixel budgets — and got a three-octave value-noise tint in exchange. That is the mechanical reason "the graphics have not improved."

The second is the height function. `src/world/terrain.ts:31` defines `sampleNaturalTerrainHeight(seedHash, x, z)`, and every term in the sum at `terrain.ts:93-102` is a closure over `(x, z)` alone. `src/workers/terrain.worker.ts:29` calls it with no shared state; `src/world/tile.ts:151` evaluates it per vertex independently. This is not "terrain that needs more octaves." It is a contract — `h = f(x, z)` — and that contract structurally forbids the thing that makes real landscapes look real. **Every landform the eye recognises as terrain is the residue of a process that moved material from one place to another.** A V-notched headwater exists because water incised it. An alluvial fan exists because that material was deposited downstream. A talus cone exists because rock fell. A ridge is a drainage divide — it is defined by the two catchments on either side of it. None of these can be evaluated at a point, because all of them are statements about a *neighbourhood*. I verified the consequence empirically: 270 of 300 greedy downhill traces from land above 80 m terminate in a closed basin after a median of 360 m, and the field carries 8.5 undrained pits per km² at 50 m sampling (median 0.87 m deep, deepest 18.0 m; 3.4/km² at 90 m sampling with median 2.04 m and max 25.9 m). A real subaerial landscape has essentially zero interior pits — every point drains to the sea. Your "valleys" are literally the arithmetic complement of your "ridges": `terrain.ts:79` is `valleyCarve = land * foothillRegion * Math.pow(1 - ridges, 3.1) * (55 + mountainRegion * 105)`. And measurably, valley floors are as rough as the crests above them — 16.50 m vs 19.54 m of 20 m RMS curvature, a 1.18:1 ratio, where real terrain shows a several-fold contrast between angular crests and alluvium-smoothed floors.

**Critically, `terrain.ts`, `noise.ts` and `geology.ts` were essentially untouched by the migration.** `classifyBiome` and `PALETTES` are byte-identical across `5ef9a0f`. You changed the engine and the API; the terrain algorithm — the thing that decides what shape the world is — is the same code it was on WebGL2. That is why the switch produced zero improvement, and it will produce zero improvement on the next switch too.

There is a third finding that ties the two halves together and explains the specific complaint that lighting work never landed. **Your shading normals describe a surface your mesh does not have.** `terrain.ts:18` sets `TERRAIN_NORMAL_SAMPLE_DISTANCE = 2` and `sampleTerrainNormal` (`terrain.ts:133-139`) uses that 2 m central difference unconditionally, at every LOD, with no spacing parameter. Those normals are uploaded verbatim (`TerrainClipmapSystem.ts:546`, `applyToMesh(mesh, false)` at `:604` — Babylon never recomputes them). I measured the angle between the shading normal and the triangle it actually decorates: 7.3° mean at 8 m spacing, 20.8° at 32 m, and **24–35° mean at 128 m spacing depending on terrain block, with p90 above 56° and 3.4% of vertices exceeding 90°** — meaning the normal points *into* the surface and the vertex is lit as facing away from a sun its own triangle faces. No light rig can fix that. Every hour you have spent on sun angles, shadow tuning and atmosphere presets has been spent lighting a surface that is not the surface on screen.

---

## 2. Root causes, ranked

| # | Root cause | Key evidence | Severity | Effort to fix |
|---|---|---|---|---|
| 1 | No surface material system: zero textures anywhere | `TerrainClipmapSystem.ts:271-286`; no image assets in repo | Critical | Large |
| 2 | Height field is pointwise analytic → erosion structurally impossible | `terrain.ts:31, 93-102`; `tile.ts:151` | Critical | Large |
| 3 | Shading normals are a fixed 2 m difference at every LOD | `terrain.ts:18, 133-139` | Critical | **Small** |
| 4 | No band-limiting: coarse LODs are a *different* surface, not a filtered one | `tile.ts:151` | Critical | Medium |
| 5 | No aerial perspective; water/clouds get no haze at all | `AtmosphereSystem.ts:265-267`; `SpectralOceanSystem.ts:421` | Critical | Medium→Large |
| 6 | No indirect light: `environmentTexture` never set, no AO | `TerrainClipmapSystem.ts:278`; zero grep hits | High | Medium |
| 7 | No screen-space-error LOD, no geomorphing | `TerrainClipmapSystem.ts:231-235, 419` | High | Large |
| 8 | No geometric content below 43 m wavelength | `geology.ts:30-34` | High | Medium |
| 9 | No macro-geology: one global 35° fabric, isotropic blob provinces | `geology.ts:41-42`; `terrain.ts:52` | High | Large |
| 10 | CPU: 181 noise evals/vertex, one worker, one job in flight | `terrain.ts:296-298`; `TerrainGenerationClient.ts:48,125` | Critical (perf) | Medium |
| 11 | Dynamic-resolution controller responds to CPU-bound frames | `QualityProfile.ts:164-175`; `FlightRenderer.ts:909-937` | High (perf) | Medium |
| 12 | Camera runs 64° **vertical** FOV ≈ 96° horizontal | `FlightRenderer.ts:351` | Medium | **One line** |

---

### 1. There is no surface material system. Not a weak one — none.

`TerrainClipmapSystem.ts:271-286` is the entire terrain material:

```ts
this.material = new PBRMaterial("terrain-pbr", scene);
this.material.metallic = 0;
this.material.roughness = 0.93;
this.material.albedoColor = Color3.White();
this.material.environmentIntensity = 0.64;
this.material.directIntensity = 1.03;
this.material.specularIntensity = 0.22;
```

No `albedoTexture`, no `bumpTexture`, no `detailMap`, no `metallicTexture`. A repo-wide search for image assets (png/jpg/ktx/ktx2/hdr/env/dds/webp, `node_modules` pruned) returns **zero files**; there is no `public/` directory. `vertexData.uvs` is never assigned (`:600-603`) and no tangents are generated, so Babylon's `NORMALMAP` and `DETAIL` code paths are structurally unreachable.

All surface appearance therefore lives in an 8-bit per-vertex colour (`tile.ts:165-167`, `mesh.useVertexColors = true` at `:606`), chosen by a hard threshold cascade (`terrain.ts:217-226`) with no ecotone blend, no aspect term, no lapse-rate treeline. **Albedo resolution is welded to mesh resolution.** That means one material sample per 8 m near the aircraft and one per 128–2048 m past 5 km. I measured what that produces in mountainous terrain — the fraction of adjacent vertex pairs landing in *different* biomes:

| Vertex spacing | Biome flips between neighbours | Mean colour jump (of 765) |
|---|---|---|
| 8 m | 7.0% | 12.9 |
| 32 m | 25.0% | 36.7 |
| 128 m | 41.1% | 63.0 (max 477) |
| 512 m | 50.0% | 62.0 |

50% is the value you get from **independent random draws**. Past 5 km the terrain's material identity is a coin flip between neighbours, Gouraud-ramped over 128–2048 m and re-rolled every time a ring re-anchors.

**What you see:** at cruise, an airbrushed wash of eight hues with soft brightness lumps and kilometre-scale green/grey/white blotches that follow no treeline, snowline or aspect. On approach, worse: the highest-frequency albedo signal anywhere in the renderer is `terrainNoise(pos.xz * 0.14)` (`TerrainMaterialPlugin.ts:53`), a 7.1 m smooth value noise applied as ±8% brightness. Nothing gives the eye a scale reference below 7 m, so speed and height perception collapse on final approach — the single most damaging failure mode for a flight sim. A uniform `roughness = 0.93` × `specularIntensity = 0.22` means snow, wet sand, dry grass, forest canopy and bare rock share one BRDF; banking over a field changes nothing about how it looks.

**Why fundamental:** this is not a missing polish pass. Every real flight sim decouples *material* resolution from *mesh* resolution — MSFS/X-Plane drop to 100+ m per vertex while imagery stays at 1–5 m per texel with mipmaps. You have no mechanism to do that at all, so no amount of geometry work can fix it. And mipmapping is exactly the prefiltering that per-vertex point sampling cannot provide.

**This is a regression, not a plateau.** `git show 5ef9a0f^:src/render/TerrainRenderer.ts:201` shows `createTerrainDetailTexture(seed)`, and `:243-250` set `minFilter = LinearMipmapLinearFilter`, `anisotropy = 16`, `generateMipmaps = true`. The shader sampled it at four world scales (`/2048.0`, rotated by 36.3° then `/176.0`, `/28.0`, and true triplanar rock at `/74.0` blended by `pow(abs(N), vec3(6.0))`) with derivative-driven footprint fading. **It was a procedurally generated 256² `DataTexture`, not an art asset** — so "we have no textures to use" is not a valid objection to restoring it.

### 2. The height field is a pure pointwise function, which structurally forbids erosion

Covered in §1. The supporting detail: `ridgedFbm2D` (`noise.ts:82-89`) is `Σ (1 - |valueNoise|)²` with `amplitude *= 0.52; frequency *= 2.03` and **no Musgrave weighting term** — no `weight = clamp(signal * gain, 0, 1)` feeding the next octave — so high-frequency detail appears uniformly rather than concentrating near crests. `cragDetail` (`terrain.ts:73-78`) and `rockyKnolls` (`:68-72`) are two further uncorrelated ridged fields added pointwise. A repo-wide grep for `erosion|flowAccum|priorityFlood|streamPower` over `src/` returns nothing.

**What you see:** no drainage network, no dendritic ridge-and-valley organisation, no V-notched headwaters, no U-troughs, no alluvial fans, no talus cones, no floodplains. Ridge lines wander and dead-end instead of forming continuous divides. Every "valley" is a closed sock-shaped trough with no downstream end, with the same smooth cosine cross-section top to bottom and the same roughness as the crest above it. From the air it reads as crumpled cloth.

This is also the parent of the hydrology system's failure. `HydrologyGeneration.ts:317-400` traces rivers with a greedy 16-direction walker at 90 m steps — and it is working correctly. It is faithfully reporting that the field it was given has no drainage. Nothing writes back into height (`grep -rn 'hydrolog' src/world/ src/render/webgpu/terrain/` returns nothing), so rivers are flat blue ribbons pasted onto slopes with no channel beneath them, sometimes running across a hillside and ending in mid-air at a local pit.

### 3. Shading normals are a fixed 2 m finite difference at every LOD

Covered in §1. Two additional consequences worth naming. First, it corrupts biome classification: `terrain.ts:299` computes `const slope = saturate(1 - target.normal.y)` from that same 2 m normal, and `classifyBiome` branches on `slope > 0.48` and `slope > 0.28` (`:221, :224`) — so rock and scree colour at 40 km is assigned by 4 m-scale microslope rather than by the visible mountain face. Second, **there is no compensating normal map**: the only normal perturbation in the renderer is a triplanar value noise at `terrainAbsolutePosition * 0.72` (a 1.39 m cell, `TerrainMaterialPlugin.ts:86`), and it is gated off by `1.0 - smoothstep(1200.0, 4200.0, terrainCameraDistance)` (`:76`) — it switches off at exactly the distance where the vertex normals become worst.

**Why this is the highest-leverage item on the list:** the fix is small, and it pays three separate dividends at once. Computing normals by central difference over the tile's own already-generated height grid (with a one-vertex halo) makes the normal consistent with the rendered triangle, automatically band-limits it to the tile's Nyquist, and **eliminates the four extra full-kernel evaluations per vertex** — which I measured as 5.2× of all terrain generation cost. One change, 40.6 ms → ~8 ms per page, and distant lighting starts describing the shape you can see.

### 4. No band-limiting: coarse LODs render a *different* surface, not a filtered one

`tile.ts:151` is `const sample = needsFullSample ? sampleTerrain(world, x, z, sampleTarget) : null;` — one point evaluation of the full kernel per vertex, identical code path for an 8 m grid and a 2048 m grid. No box filter, no supersampling, no per-level octave clamp, no mip pyramid.

The kernel carries real amplitude well below the coarse Nyquist: `soilUndulation` at 43 m (`geology.ts:30-34`), `groundNoise` at 105 m × up to 14.7 m amplitude (`geology.ts:21`), `talusRidges` down to 59 m (`geology.ts:72-77`), `cragDetail`'s finest octave at 125 m × 360 m amplitude (`terrain.ts:61, 73-78`), `mountainHeight`'s finest at 150 m × 1,390 m (`terrain.ts:60-63`). I compared each coarse vertex against a 12×12 box average of its own cell — the correct band-limited value:

| Spacing | RMS error | Max error |
|---|---|---|
| 32 m | 3.05 m | 15.0 m |
| 64 m | 7.11 m | 34.3 m |
| 128 m | 16.10 m | 63.5 m |
| 256 m | 35.44 m | 269.0 m |
| 512 m | 60.23 m | 351.3 m |

**This is pure phase error, not smoothing.** The coarse mesh is not a blurred version of the fine one; it sits on an arbitrary phase of the 43–160 m noise and is therefore a genuinely different landscape. Refining the mesh can never make the far field converge to the near field while this holds.

**What you see:** distant terrain gains pseudo-random ±16–60 m jitter with no relation to the real landform, and it *re-rolls whenever a ring re-anchors* — read as shimmer and "swimming" of distant hills. Far ridgelines never settle into a stable silhouette. Against MSFS/X-Plane, where the horizon is rock-steady, this is one of the loudest "this is procedural" tells. It also blocks the geomorph fix in #7: `mix(fine, coarse, morph)` is meaningless until the two levels agree what the terrain is.

### 5. No aerial perspective — and water and clouds get no haze at all

The entire atmospheric term on terrain is three lines (`AtmosphereSystem.ts:265-267`):

```ts
this.scene.fogMode = Scene.FOGMODE_EXP2;
this.scene.fogDensity = weather === "cloudy" ? 0.00008 : weather === "breezy" ? 0.000045 : 0.000028;
this.scene.fogColor = Color3.Lerp(preset.horizon, new Color3(0.48, 0.52, 0.56), humidity * 0.32);
```

Babylon evaluates this as `exp(-(d·ρ)²)` on eye distance only, then gamma-decodes for PBR (`fogFragment.js`: `fog = toLinearSpace(fog)`). Recomputed transmittance at ρ = 2.8e-5:

| Distance | Terrain visibility |
|---|---|
| 5 km | 96% |
| 10 km | 84% |
| 20 km | 50% |
| 30 km | 21% |
| 40 km | 6.4% |
| 50 km | 1.2% |

Three independent defects follow. **(a) No height falloff.** Density is constant from sea level to the ceiling, so at 30,000 ft the ground 10 km directly below is 16% washed out by a sea-level-density haze that physically is not there. Real atmosphere has an ~8 km scale height; looking *down* is far clearer than looking sideways. That is the view you spend most of a flight in. **(b) No view-direction dependence.** One `Color3`. At the dawn preset it evaluates to roughly (0.87, 0.33, 0.19) orange, so distant terrain fades to orange even looking 180° away from the sun, where the sky behind it is the dark blue zenith (0.055, 0.13, 0.32). Terrain and sky fade to different colours at the horizon. **(c) The old build was 5× stronger** — `git show 5ef9a0f^:src/render/FlightRenderer.ts:484` is `new THREE.Fog(0x91a9ac, 2_900, 11_800)`, linear and saturating at 11.8 km. The migration made haze weaker at exactly the range where it carries scale.

**Water and clouds receive none of it.** `grep -n "FOG\|fogEnabled" node_modules/@babylonjs/core/Materials/shaderMaterial.js` returns nothing — Babylon's `ShaderMaterial` has no fog path whatsoever. The ocean is a `ShaderMaterial` (`SpectralOceanSystem.ts:832`) whose fragment shader ends at `:421` with `fragmentOutputs.color = vec4f(max(water, vec3f(0.0)), 1.0);`, with no distance term anywhere. Rivers/lakes are the same (`HydrologySystem.ts:539, :258`). Water is drawn to `OCEAN_PRESENTATION_RADIUS_METERS = 120_000` fully saturated while terrain at 120 km is 100% replaced by fog colour.

**What you see:** a 3000 m ridge 15–20 km out keeps half its contrast and all its hue, so it reads as a nearby hill — this is the primary reason your world has no sense of scale. Looking down from cruise, ground that should be crisp is milky. At any coastline past ~10 km, hazed pale-blue land sits directly against unhazed deep-blue water with a hard tear between them, and at 40–120 km the terrain is pure fog colour while the ocean still renders specular sun glitter.

### 6. No indirect lighting: `environmentTexture` is never set, and there is no AO of any kind

`grep -rn "environmentTexture|HDRCubeTexture|CubeTexture|createDefaultEnvironment|reflectionTexture" src/` returns **zero hits**. In Babylon, `_getReflectionTexture()` (`pbrBaseMaterial.pure.js:1844`) falls back to `scene.environmentTexture` → null → `REFLECTION = false`, and `pbrBlockFinalColorComposition` wraps both `finalIrradiance` and `finalRadianceScaled` in `#ifdef REFLECTION`. So `environmentIntensity = 0.64` (`TerrainClipmapSystem.ts:278`), `0.7` (`WorldDetailRuntime.ts:1105`) and `0.62` (`AirportSystem.ts:111`) are **dead uniforms** — I grepped every use of `vLightingIntensity.z` across Babylon's WGSL includes and it appears only inside REFLECTION/SHEEN/CLEARCOAT blocks, none of which are defined here.

The entire indirect budget is one unshadowed `HemisphericLight`. Computed against the values `setPreset()` actually applies for day+clear: ambient contributes 0.203 against direct 4.657 in the green channel — **4.4% of the light budget**, where clear midday diffuse-horizontal irradiance is 10–15% of the total. And `HemisphericLight` is not shadowed by the CSM, so on a shadowed or north-facing slope it is the *only* light, at 0.20 vs 4.66.

Ambient does track the preset and does vary with `normal.y` (`AtmosphereSystem.ts:262-264`; Babylon's hemispheric diffuse is `mix(groundColor, lightColor, dot(N,up)*0.5+0.5)`), so this is not "everything is lit by one lamp." What is precisely missing: **no azimuthal variation** (a north-facing and a south-facing slope at the same tilt receive bit-identical ambient, so the warm/cool split across a ridge at golden hour — one of the strongest cues in aerial photography — does not exist), **no specular probe at all**, and **no occlusion**. `pbrBlockAmbientOcclusion.js:18` returns `vec3f(1.,1.,1.)` unmodified; there is no SSAO, no GTAO, no baked cavity. `git show 5ef9a0f^:src/render/hybrid/HybridShaders.ts:205-252` contains a full 16-tap HBAO `ambientVisibility()` that the migration deleted.

**Sequencing note:** AO modulates the indirect term. Adding GTAO tomorrow, against a 4.4% ambient budget, would be nearly invisible. **Fix the IBL first, then the AO** — otherwise you will do the work and see nothing, which is exactly the pattern that has frustrated you already.

### 7. No screen-space-error LOD and no geomorphing

`TerrainClipmapSystem.ts:231-235`:

```ts
function tileResolution(profile: WebGpuQualityProfile, level: number): number {
  if (profile.tier === 0) return level === 0 ? 33 : 17;
  if (profile.tier === 1) return level < 2 ? 65 : 33;
  return level < 3 ? 65 : 33;
}
```

Resolution is a function of tier and level **only** — no camera distance, no altitude, no terrain-roughness term. Combined with `BASE_PAGE_EXTENT = 512` (`:79`), `RING_RADIUS = 2` (`:80`), `extent = BASE_PAGE_EXTENT * 2 ** level` (`:420`), `terrainRings: 8`:

| Level | Extent | Res | **Vertex spacing** | Outer half-span | Fog visibility at outer edge |
|---|---|---|---|---|---|
| 0 | 512 m | 65 | **8 m** | 1.28 km | 100% |
| 1 | 1,024 m | 65 | **16 m** | 2.56 km | 99% |
| 2 | 2,048 m | 65 | **32 m** | 5.12 km | 96% |
| 3 | 4,096 m | 33 | **128 m** ← 4× cliff | 10.24 km | 84% |
| 4 | 8,192 m | 33 | **256 m** | 20.48 km | 49% |
| 5 | 16,384 m | 33 | **512 m** | 40.96 km | 6% |
| 6 | 32,768 m | 33 | **1,024 m** | 81.92 km | ~0% |
| 7 | 65,536 m | 33 | **2,048 m** | 163.84 km | ~0% |

Two things fall out. **First, the 4× cliff at 5.12 km** — resolution halves while extent doubles, uniquely at the L2/L3 boundary. Measured bilinear cell-centre error against the true kernel: 11.3 m RMS / 122.8 m max in mixed terrain at 128 m, and **40.97 m RMS / 256.4 m max in a high-relief block**; 73.2 / 409.5 at 256 m. Against the correct pixel subtense (`camera.fov = 64°` is *vertical* by Babylon's default `FOVMODE_VERTICAL_FIXED`, so 1.035e-3 rad/px at 1080p), 24 m at 5 km subtends ~4.6 px and 161 m subtends ~31 px — 2–15× over the 1–3 px budget that CDLOD/chunked-LOD target. Fog does not rescue this band: 5–10 km is only 4–16% hazed.

**Second, there is no geomorphing at all.** I traced the whole path — `rebuildDesired` → `pumpDesiredRequests` → `requestPage` → `uploadPage`. Line 536 is `positions[positionOffset + 1] = tile.heights[vertex] ?? 0` and line 604 is `applyToMesh(mesh, false)`. No blend weight, no morph factor, no second per-vertex height, no updatable buffer. `grep -rniE "morph|geomorph|tessellat|displacement|vertexTexture|RawTexture|heightTexture"` over `webgpu/terrain/`, `TerrainGenerationClient.ts` and `src/world/` returns **nothing**. And because the anchor is quantized to the coarse extent (`:421`, `Math.floor(observer.x / extent)`), crossing one L2 boundary shifts an entire **2,048 m × 10,240 m strip** of hillside from 32 m to 128 m spacing in a single frame — an instantaneous jolt of 8.4 → 41.0 m RMS chord error, up to ~200 m, or ~8 px RMS and up to ~48 px of silhouette jump. At 80 m/s that is every 25 s; at 300 m/s every 7 s.

The 24 m skirts (`TERRAIN_SKIRT_DEPTH_METERS = 24`, `:85`) do not cover the resulting cracks. I measured the gap between the fine page's boundary vertices and the coarse page's edge chord: **28.1 m RMS / 192.4 m max at the L2/L3 4:1 rim** in mountains, 63.1 / 343.3 at L3/L4. The 2:1 rims (L1/L2: 6.3 m RMS) are comfortably covered — **the problem is concentrated entirely at the 65→33 resolution cliff.**

**Two corrections you need, because they will otherwise waste your time.** (a) The deleted `TerrainLodMorph.ts` was **not** geomorphing. Its signature is `applyTerrainBoundaryMorph(positions, sourceHeights, resolution, coarseStride, edges, fadeRows = 10)` — no distance parameter, no time parameter, no morph factor. It was seam stitching. Restoring it will not stop the popping. The old engine had no geomorphing either. (b) You cannot simply set `backFaceCulling = true`: `buildTerrainIndicesWithSkirt` (`:211-223`) emits the perimeter skirt loop with one winding, so half the walls would face inward and disappear. That is what the comment at `:282` is protecting. Skirts must go first.

### 8. There is no geometric content below 43 m wavelength

I traced every octave. The finest wavelength anywhere in the height kernel is **43 m**, at an amplitude of at most ~3.7 m: `soilUndulation = valueNoise2D(..., x / 43, z / 43)` (`geology.ts:30-34`). Next up: `talusRidges` finest octave at 59 m, `fine` at 74.5 m (`terrain.ts:49`), `groundNoise` at 105 m, `cragDetail` at 125 m, `mountainHeight` at 150 m.

Meanwhile L0 has 8 m vertex spacing — Nyquist 16 m. **The finest ring is ~2.7× oversampled per axis, roughly 7× more triangles than the height field's information content justifies.** The code even documents the gap it failed to close, at `geology.ts:25-29`: *"The render grid previously had no geometric energy between roughly 100 m geological noise and sub-metre shader normals."* One 43 m octave was added; the 8–43 m band was left empty.

**What you see:** at 200–2000 ft AGL — where the ground fills the screen and where a flight sim is judged — the terrain has no shape at all below 43 m. No gullies, terraces, drainage channels, field boundaries, rock outcrops or embankments, because none exist in the data. A smooth 43 m swell. That is the "giant plastic sheet" impression, and it is a *data* problem that no texture or shader can fix. It is also a distinct root cause from #1 and #4: perfect textures painted on a provably featureless surface still read as a painted plane.

### 9. No macro-geological causality: one global 35° fabric, isotropic blob provinces

`geology.ts:41-42`:

```ts
const rotatedX = x * 0.819 + z * 0.574;
const rotatedZ = -x * 0.574 + z * 0.819;
```

0.819 = cos(35°). This single hard-coded bearing feeds `fractureRidges` (390/980), `fractureVariation` (155/240), `ravineCarve` and `talusRidges` (120/280) — all with 2.5:1 to 4:1 axis ratios along one compass direction, **for the entire infinite world**. Gradient-orientation energy of `sampleGeologicalRelief` alone peaks at 30–40° with **23.6:1 anisotropy**, and it survives into the composed field: over mountainous land the full height field's gradients peak in the 30–50° band at 2.7:1 at *every* probe scale (2 m, 20 m, 100 m, 400 m).

**This is the world grain you are seeing, and it is 2–3× stronger than anything attributable to the noise lattice** — see §5 for why chasing the lattice is a dead end.

Meanwhile mountain provinces are `fbm2D(..., warpedX / 13_500, warpedZ / 13_500, ...)` (`terrain.ts:52`) — identical divisors on both axes, isotropic by construction. So you get isolated round 10–20 km lumps instead of linear 100–500 km cordilleras: no continental spine. And roughness is a pure function of the uplift mask rather than of process: 20 m RMS curvature by elevation band is strictly monotone across 0–1500 m (3.82 → 54.98 m), so a high valley floor is as rough as the crest above it.

The ocean is worse than it looks but for a different reason than you might guess: `continentalShelf = lerp(-105, 135, ...)` (`terrain.ts:46`) bottoms at −105 m and the only term surviving `land = 0` is `fine * 5`, so the measured global minimum over a 400 km scan is −109.5 m. **The entire ocean is a flat ~105 m shelf** — no slope, no canyons, no abyssal plain. (The coastline itself is fine: box-counting gives a fractal dimension of 1.12, within the range of real coasts.)

### 10–12. The performance triad — see §3.

---

## 3. Why performance regressed

Four measured causes, plus one feedback loop that converts all of them into blurrier pixels.

**(a) The terrain generator evaluates the height kernel five times per vertex.** `terrain.ts:296-298` calls `sampleTerrainHeight` once, then `sampleTerrainNormal`, which issues four *more* full kernel evaluations at ±2 m (`:134-137`). I instrumented `Math.imul` directly: **34 `valueNoise2D` calls per height sample, 181 per full `sampleTerrain`; 192.9 hash evaluations per height and 1,026 per vertex** (each `valueNoise2D` = 4 corners × `mixSeed` + 2 `avalanche` = 136 lattice hashes and 408 avalanche rounds per height). Measured on Apple Silicon, JIT-warmed:

| Page | Full | Heights only | Ratio |
|---|---|---|---|
| res 65 / 512 m | 40.6 ms | 7.7 ms | **5.3×** |
| res 33 | 10.3 ms | 2.0 ms | 5.2× |

Isolating further: `includeClimate:false` saves 0.4 ms, `includeColors:false` 0.5 ms, **normals-only is 39.8 of the 40.4 ms.** The four extra kernel calls for a normal that is wrong anyway (#3) are 79% of terrain generation cost. Separately, `includeClimate: true` (`TerrainClipmapSystem.ts:495`) computes and transfers moisture and biome arrays that no clipmap code path ever reads.

**(b) Generation is strictly serial on one core.** `TerrainGenerationClient.ts:48`: *"One-worker, one-in-flight terrain scheduler with a bounded priority queue."* `:125`: `if (this.disposed || this.activeRequestId !== null) return;`. At tier 2 the resident set is ~172 pages (67 at res 65, 105 at res 33) = **~3.9 s of wall clock on one core with seven idle**, and the browser is typically slower than Node, so 4–8 s is the honest range. `generateTerrainTile` is a pure function of `(seed, tileX, tileZ, size, resolution)` with no shared state — it is embarrassingly parallel, and nothing is exploiting that. Add: there is **no cache at any layer** (pages are disposed 90 frames after leaving the desired set, `:81, :372-378`), and rings 0–7 all cover the observer, so the same world region is regenerated from scratch eight times at eight spacings with zero data sharing. Flying a circle costs full price again.

**(c) Draw submission, not shading, dominates the frame.** Tier 2 holds **172 separate `Mesh` objects, 765,184 triangles and 20.71 MB of vertex/index buffers** (I reproduced this exactly by simulating `rebuildDesired`'s hollowing and the skirt index builder). A 65-res page is 4,481 verts × 40 B + 26,112 indices × 2 B ≈ **231 kB to describe 512 m × 512 m — 27× what an r16 height texture needs** (8,450 B). Every page is a fresh `new Mesh` + `new VertexData` + three fresh `Float32Array`s (`:528-530, :598-604`), disposed and reallocated as you fly. ~100 of those pages are re-submitted into 4 shadow cascades and again into the planar reflection.

And Babylon's WebGPU path makes it worse: `objectRenderer.js:713` gates the renderList dispatch only on `isEnabled() && isVisible && subMeshes` — **there is no `isInFrustum` test on that path at all** — and `objectRenderer.js:626` explicitly disables the per-frame render-list caching on WebGPU (`&& !this._engine.isWebGPU`), so the list is re-prepared **per cascade**. `renderTargetTexture.pure.js:759-763` loops layers calling `_renderToTarget(0, ..., layer)`. Nothing in `CascadedShadowGenerator` sets `getCustomRenderList` or frustum-tests per cascade.

**(d) Two silent budget deletions.** The shadow map is `CascadedShadowGenerator(4096, sun, true, camera)` with `numCascades = 4` (`AtmosphereSystem.ts:196-201`, `QualityProfile.ts:94-96`) = 256 MiB R32F colour + up to 256 MiB depth32. The deleted controller was `mapSizes` max 2,048 with 2–3 cascades ≈ 48 MiB — **a 7–11× regression.** And `filter = FILTER_PCF` (`:209`) means `shadowGenerator.js:1422` binds *only the depth texture* — **the 256 MiB colour attachment is allocated, cleared and written every frame and never sampled.** Separately, `FlightRenderer.ts:903-906` now does `Math.min(2, devicePixelRatio) * renderScale`, where the old build did `Math.min(devicePixelRatio, qualityPixelRatio(quality))`. On a Retina panel "low" renders **2.87× more pixels** than the old low preset. `qualityPixelRatio` still exists at `FlightRenderer.ts:119` and is dead code — one grep hit, its own definition.

**(e) The feedback loop that produces your exact symptom.** `worstFrameTimingPercentile95` (`QualityProfile.ts:164-175`) takes the **worst** of frame-interval, CPU and GPU p95 and feeds it to `nextDynamicRenderScale`, which drops `renderScale` by 0.04 per step down to a 0.62 floor. `applyRenderScale` then calls `setHardwareScalingLevel`, which changes **only the raster resolution**. Every dominant cost above is CPU-side: 3.1 ms/frame of main-thread detail-cell generation (`WorldDetailRuntime.ts:324-356`, measured 3.09 ms per 512 m cell against a 2 ms budget), ~840 un-culled shadow draws, per-frame render-list re-preparation, per-page mesh construction. **Lowering the pixel count does not reduce any of them.** So the controller enters a one-way ratchet: CPU p95 stays high, resolution walks to the floor, the image gets soft, the frame rate does not recover. That is, mechanically, "the graphics have not improved and performance has taken a hit" — in one function.

Finally: **there is zero GPU-side terrain work.** The only file in `src/render/` containing `ComputeShader` or `dispatch(` is `SpectralOceanSystem.ts`. The GPU idles while one JS thread grinds integer hashes.

---

## 4. The fundamental changes to make

### Tier 1 — highest realism per unit of effort. Do these first, in this order.

These are ordered so that each one is visible on its own. Do not reorder: several have hard dependencies noted below.

| # | Change | Files | Effort | What you will see |
|---|---|---|---|---|
| 1.1 | Derive normals from the tile's own height grid | `src/world/tile.ts`, `src/world/terrain.ts` | ~1 day | Distant terrain starts catching light along its actual ridges; page generation drops 40.6 → ~8 ms |
| 1.2 | Band-limit the kernel to the LOD spacing | `terrain.ts`, `geology.ts`, `noise.ts`, `tile.ts` | 2–3 days | The horizon stops crawling and shimmering; far ridgelines hold a stable silhouette |
| 1.3 | Worker pool + LRU page cache | `TerrainGenerationClient.ts` | 1–2 days | Terrain arrives with you instead of seconds behind; backtracking is free |
| 1.4 | Physical aerial perspective as a shared WGSL include | `TerrainMaterialPlugin.ts`, `SpectralOceanSystem.ts`, `HydrologySystem.ts`, cloud composite | 3–5 days | Distance reads as distance; mountains 20 km out finally look 20 km out; coastline tear disappears |
| 1.5 | Sky cube → `scene.environmentTexture` | `AtmosphereSystem.ts` | ~half a day | Shadowed slopes hold cool skylight instead of crushing to black; ridges split warm/cool at golden hour |
| 1.6 | Restore the detail texture pipeline | `TerrainMaterialPlugin.ts` | 2–3 days | Sub-metre grain returns; speed and height perception on approach come back |
| 1.7 | Fix render-scale governor + DPR cap + FOV | `QualityProfile.ts`, `FlightRenderer.ts` | ~1 day | The picture stops silently degrading; scale perception improves |

**1.1 — LOD-consistent normals.** Generate each tile with a one-vertex halo and central-difference the grid. Keep the 2 m analytic path only for `sampleTerrainCollision` (`terrain.ts:178`), which genuinely wants the fine gradient. This is the single best line-for-line change in the audit: it fixes a 21–35° shading error, band-limits the normal for free, and removes 79% of terrain generation cost.

**1.2 — Band-limiting.** Thread the vertex spacing into `sampleNaturalTerrainHeight` and `sampleGeologicalRelief` as a filter width; terminate the fBm octave loops when wavelength drops below ~2× spacing, fading the last octave with a smoothstep so the cutoff is continuous. **This makes coarse pages cheaper, not more expensive.** Apply the same clamp to the moisture and temperature fields feeding `classifyBiome`, or the albedo aliasing survives the fix. This is a prerequisite for geomorphing (Tier 2) — `mix(fine, coarse, morph)` is undefined until levels agree.

**1.3 — Parallelism.** Widen `activeRequestId: number | null` to a per-worker slot map, hold `navigator.hardwareConcurrency - 1` workers, keep the existing bounded priority queue as the dispatcher. Add an LRU cache keyed `(seed, level, tileX, tileZ)` sized to a few hundred MB. Also set `includeClimate: false` at `TerrainClipmapSystem.ts:495` — nothing reads it.

**1.4 — Aerial perspective.** Build it as a **shared WGSL include**, not a terrain-only material plugin — the repo already has this pattern (`CLOUD_SHADOW_RECEIVER_FUNCTION_WGSL`, `SUN_SHADOW_FRAGMENT_WGSL`). Minimum viable and fully analytic: integrate optical depth with an exponential height falloff (H ≈ 8000 m for Rayleigh, 1200 m for Mie) between camera altitude and fragment altitude, and make the in-scatter colour a function of `dot(viewDir, sunDirection)` using the **same** Rayleigh (3/16π)(1+cos²) and Henyey-Greenstein g≈0.76 phase functions already written in the sky shader at `AtmosphereSystem.ts:50-68` — then terrain haze and sky agree by construction. Set `mesh.applyFog = false` on terrain once the plugin owns it. Coefficients already exist, unused, at `EnvironmentState.ts:88-101`. Then drop `terrainRings` to 6 and `camera.maxZ` to ~45 km: L5–L7 are ≥94% fogged and are ~16% of all terrain triangles.

**1.5 — IBL.** Render the existing `aerolithPhysicalSky` WGSL (`AtmosphereSystem.ts:38-76`) into a 64px-face cube RTT once per `setPreset()`, run it through `CubeMapToSphericalPolynomialTools`, assign to `scene.environmentTexture`. One small block of code turns on `finalIrradiance` and `finalRadianceScaled` and makes three existing `environmentIntensity` constants live. Then **raise `specularIntensity` from 0.22 back to 1.0** on all three materials — that 0.22 was compensating for the missing IBL and will look wrong once IBL exists. Do AO *after* this, not before.

**1.6 — Detail texture.** Port `createTerrainDetailTexture` from `git show 5ef9a0f^:src/render/TerrainRenderer.ts:201` to a Babylon `RawTexture` built once at startup (256² RGBA, macro/detail/grain in R/G/B), `generateMipMaps = true`, `anisotropicFilteringLevel = 16`. **Blocking prerequisite:** the terrain has no UVs — derive them in the plugin from `terrainAbsolutePosition.xz` (cheaper than a per-page buffer). Sample at 3–4 world scales with `dpdx/dpdy` footprint-driven fades; the deleted shader's constants (7–64 m, 1.5–20 m, 15–96 m, 1.2–14 m) are already tuned and can be copied verbatim. While you are in there: replace `terrainCameraDistance` at `TerrainMaterialPlugin.ts:75` with a derivative footprint (`max(length(dpdx(pos.xz)), length(dpdy(pos.xz)))`) so the micro-detail ring stops sliding across the ground with the aircraft, shrink the finite-difference offset from 0.38 to ~0.05 cells so it is actually a gradient, and set `material.enableSpecularAntiAliasing = true` (zero grep hits today; the perturbation happens before `pbrBlockGeometryInfo`, so it works correctly).

**1.7 — Governor and camera.** Drive `nextDynamicRenderScale` from `gpuFrameDurations` *only*, requiring fresh timestamps (`enableGPUTimingMeasurements` is already on at `FlightRenderer.ts:342`); when GPU timing is unavailable, hold scale fixed. Route CPU p95 to a separate governor that reduces CPU work (detail-cell budget, shadow-caster count, reflection cadence, terrain request rate) and surface which governor fired in the HUD. Restore a per-tier DPR ceiling using the already-present `qualityPixelRatio` and add an absolute `maxRenderPixels` (the deleted `RenderProfile.ts:81-116` had 1.35M/2.3M/4.0M plus `memoryCapMiB: 42/68/108`). Set `camera.fovMode = FOVMODE_HORIZONTAL_FIXED` at ~60–65°, or drop to ~38–42° vertical — and change the base in `chaseCameraProfile` (`:139`) and the fallback (`:765`), not just the constructor. Make cockpit narrower than chase, not wider (`:771` is currently 72°). This also tightens the shadow cascades for free.

### Tier 2 — structural changes to terrain generation

**2.1 — Break the `h = f(x, z)` contract. Run landscape evolution.** This is the change that makes the terrain *look like terrain*. Keep the analytic kernel as a tectonic uplift input only, then in the worker:

1. Generate each tile with a 25–50% halo at 2× target resolution.
2. **Priority-flood depression filling** (Barnes et al.) — alone this removes the measured 8.5 pits/km².
3. **D∞ or MFD flow routing** for drainage area *A*.
4. **Implicit FastScape stream-power**, `dz/dt = U − K·A^0.5·S`, 30–80 O(N) iterations.
5. **Mass-conserving thermal/talus relaxation** at the angle of repose (~34° rock, ~25° scree).
6. Optional droplet erosion for fine texture.

Cache eroded tiles keyed `(seed, tileX, tileZ, level)`; have physics and collision sample the cached grid with bicubic interpolation, which also removes the analytic kernel from the physics hot path. Handle cross-tile seams with the halo plus deterministic seeding, or erode a coarse global pyramid and detail-erode the leaves.

*What you will see:* dendritic drainage networks, continuous ridge divides, V-notched headwaters, alluvial fans, talus cones, floodplains, and smooth-on-deposition / rough-on-incision slope contrast. This one change does more for realism than everything else on this list combined. It also fixes rivers for free: compute flow accumulation inside the erosion pass, **carve** the channel using hydraulic geometry (w ∝ Q^0.5, d ∝ Q^0.4), fill depressions to real lake surfaces during the priority flood, and **delete `traceDownhillPath`** — meanders, confluences and deltas then emerge from the flow network instead of a greedy walker.

**2.2 — Per-page material texture, replacing vertex colours.** Have the worker rasterize an RGBA8 splat-weight texture at a fixed 256² per page (independent of the 33/65 vertex grid) by supersampling a **continuous** classifier and averaging palette weights. Replace `classifyBiome`'s threshold cascade with softmaxed per-biome suitability weights over smooth functions of elevation-with-lapse-rate, aspect (`normal.xz` against sun and prevailing wind), slope measured *at the LOD's own spacing*, moisture, a flow-accumulation wetness index from 2.1, and a soil-depth proxy — with low-frequency jitter noise on the deciding variables so the treeline is a ragged fractal edge rather than an iso-contour. Then pack albedo + normal + roughness + AO per land-cover class into `Texture2DArray`s and blend by the splat weights, with height-blend (not linear lerp), true triplanar *texture* projection above slope 0.3, and stochastic/hex de-tiling on the macro layer.

**`src/render/webgpu/world/payload.ts` already specifies exactly this**, and it is dead code imported only by `tests/render.webgpu-world-page-contract.test.ts:23` and `tests/render.webgpu-world-streaming.test.ts:8`. It defines `QuantizedHeightPage { format: "r16uint-linear", ... }`, `QuantizedMaterialPage { format: "rgba8unorm-weights", materialIds, weights }`, `QuantizedSurfacePage`, a `gutter` documented as *"Samples stored outside every edge to make filtering and derivatives seam-safe"*, plus `WorldPageLifecycle` (epoch-based stale-result rejection) and `calculateWorldPageStreamingPriority` (flight-corridor scoring). **Your team specified the correct architecture and then shipped a parallel ad-hoc path with none of its properties.** Make the renderer consume it. The gutter is the load-bearing piece — it is what makes correctly filtered normals and crack-free bilinear sampling possible at page edges.

Also fold in: bake per-vertex or per-texel sky visibility in the worker (multi-direction horizon angles from the tile's own grid — the same ~16-azimuth integral that gives you terrain self-shadowing) and widen `colors` to `Uint8Array(vertexCount * 4)` at `tile.ts:115-118` so the free alpha at `TerrainClipmapSystem.ts:543` carries it.

**2.3 — Add the missing 8–43 m octaves.** A 20 m and a 10 m band in `sampleGeologicalRelief` with land/slope-masked amplitudes of ~1.2 m and ~0.4 m, plus a curvature mask so fine energy concentrates in drainage lines — uniform fine noise reads as sandpaper, not terrain. Gate the airport apron out via the existing `flattenHeightForAirport` path. **Verify numerically:** sample a 500 m transect at 1 m and FFT it; the spectrum should be flat-ish to the target wavelength, and today it falls off a cliff at 43 m. *Note the corollary:* if you do **not** add these octaves, drop L0/L1 to `resolution = 33` and reclaim ~75% of near-ring triangles at zero visible cost, because they are currently rendering a smooth 43 m swell at 5 samples per wavelength.

**2.4 — Screen-space-error LOD + geomorphing.** Replace the fixed resolution table with CDLOD (Strugar 2009) or chunked LOD (Ulrich 2002) over a quadtree: each node stores its measured max vertical deviation from its parent and splits when `error * pixelsPerMeterAtDistance(camera3DDistance) > τ`, τ ≈ 2 px. Keep a constant 65² or 129² grid per node — the quadtree, not a resolution table, supplies adaptivity. GSD then depends on camera distance *and* local roughness, so flat plains get cheap far LOD and the mountain filling the screen at 20 km refines on its own merit. **Add `y` to `TerrainObserver` (`TerrainClipmapSystem.ts:66-71`) — the system currently cannot see altitude at all**, which is why 28.4% of all triangles sit under the fuselage.

For geomorphing, the cheapest form given this codebase: have the worker emit a second Float32 attribute `coarseHeight` per vertex (the bilinear value on the parent grid, free during generation), add a per-mesh `morph` uniform, and do `position.y = mix(coarseHeight, height, morph)` in a vertex hook — note `TerrainMaterialPlugin.ts:233` currently returns `null` for anything but `shaderType === 'fragment'` and must be extended. **This fixes cracks analytically** (at morph=0 the fine edge *is* the coarse edge), which lets you delete `TERRAIN_SKIRT_DEPTH_METERS` entirely, which finally lets you set `backFaceCulling = true` (worth ~1.1–1.35×, not the 2× you might assume — back-facing triangles are only 27–34% of an airborne heightfield view). **Interim one-liner with real value:** make the resolution table hold a strict 2× GSD ratio (65 at every level, or 65/65/65/65/33/33…). This halves worst-case mesh error and eliminates the 4:1 T-junction — my measurements show 2:1 rims produce 6.3 m RMS gaps that the existing 24 m skirt already covers.

**2.5 — Real shadowing.** Split the problem instead of stretching one CSM over 120 km. Shorten the CSM to a ~1.5–2 km near field for aircraft, trees and buildings with 3–4 tight cascades; set `autoCalcShadowZBounds = true` and `autoCalcDepthBounds = true` so bias becomes tunable; switch to `FILTER_PCSS` with `lightSizeUV` from the sun's 0.00935 rad angular diameter. For terrain-vs-terrain shadowing at *all* distances, evaluate the baked horizon map from 2.2 analytically in the fragment shader — one fetch, no cascade seam, no bias, works to the horizon, and it removes essentially all terrain pages from the CSM render list. Also pass `usefullFloatFirst = false` to halve the (never-sampled, PCF-only) colour attachment, and note the far cascade is currently ~10 m/texel because `stabilizeCascades` fits the frustum-slice **bounding sphere** — 4096 texels over a ≥40.8 km diameter.

### Tier 3 — longer horizon

**3.1 — Move the heightfield onto the GPU.** Port `sampleNaturalTerrainHeight` + `sampleGeologicalRelief` to WGSL (~40 lines; they are pure functions of a uint32 seed and world x/z) and generate into an R32F storage texture with a compute shader. Then render a fixed, never-rebuilt clipmap grid — GPU geometry clipmaps (Asirvatham & Hoppe 2005) with toroidal addressing, or one shared grid instanced per CDLOD node — sampling that texture in the vertex shader. This collapses ~172 unique meshes into a handful of instanced draws, replaces 20.7 MB of vertex buffers with a few MB of height textures, eliminates the worker, the postMessage payload, all per-page mesh construction and the index rebuilds, and makes 4 m or 2 m L0 spacing affordable. Keep the CPU kernel only for the collision path.

**3.2 — Tectonic layer above the noise.** A low-resolution Lloyd-relaxed plate/craton partition at 200–500 km cells with per-plate motion vectors; derive uplift from convergent boundaries (linear orogens at 5:1–20:1 aspect), rifts and hotspot tracks. **Derive the structural fabric orientation per region from the local boundary direction** — this single change replaces the global 35° constant and is the highest-value item in this tier. Derive per-region lithology and feed it to the erodibility *K* in the stream-power law so soft rock erodes to rolling hills and hard rock to cliffs. Replace the ocean's single `lerp(-105, 135, ...)` with a shelf → slope → abyssal (−4000 m) profile. Let the eroded field cross sea level on its own so rias, cliffs and headlands fall out for free. **Only after this**, raise `MAX_TERRAIN_HEIGHT` from 2,200 m (measured global max in a 400 km scan: 1,878 m — the clamp is inert today) to 6,000–9,000 m and add glacial erosion above a snowline (cirques, arêtes, U-troughs, hanging valleys). Raising the ceiling before 2.1 lands would just produce taller crumpled foil.

**3.3 — TAA and a virtual/clipmap megatexture.** Halton(2,3) jitter over 8–16 frames, motion vectors, YCoCg neighbourhood-variance clamp — `VolumetricCloudSystem.ts:1030-1055` already implements this pattern for the cloud buffer and can be generalised. **Critical detail:** fold the floating-origin rebase (`FlightRenderer.ts:864-886`) into the previous-frame matrix or history breaks every 4 km; the hook already exists at `:884`. Then a virtual texture is the only thing that gives constant texel density at flight-sim view distances.

**3.4 — Unify radiometry.** Make `EnvironmentState.ts` (Rayleigh/Mie/ozone coefficients, 120,000 lux sun, 0.004675 rad sun radius — all dead code, referenced only by `tests/render.webgpu-nature.test.ts`) the single source of truth; delete `presetFor()`; publish one UBO via the existing `packEnvironmentUniforms()` and bind it from terrain, sky, cloud and water alike. The `/5.2` magic constant at `VolumetricCloudSystem.ts:874` then disappears. Also remove the double exposure — the sky gets `preset.exposure` (0.82–1.02) inside its own shader at `AtmosphereSystem.ts:73` *and* the camera's 1.08 in post, while terrain gets only 1.08 and is dimmed via `sun.intensity` instead, so at dawn sky and ground sit on two different curves. Do this as part of 1.4/1.5, not as a standalone refactor — it has no independent visual payoff.

**3.5 — Vegetation and ground cover.** Alpha-tested textured foliage cards with `subSurface.isTranslucencyEnabled` (today `createTreeCrown` at `WorldDetailRuntime.ts:1063-1092` builds 9-sided opaque cones and icospheres); a third octahedral-impostor LOD with dither cross-fade at both the LOD switch and the cull radius; and beyond impostor range, **fold vegetation into the terrain splat weights** so distant forest becomes darker, rougher, correctly-coloured *ground* rather than vanishing at a 2–8 km circle. That last one is what MSFS and X-Plane do and it is what makes the cutoff invisible — it requires 2.2's splat weights, so sequence it after. Restore instanced wind-animated ground cover inside ~500 m; the deleted `GroundCoverRenderer.ts:27-29` budgets (`radius: 740, cellSize: 7, grassLimit: 9_800, density: 0.27`) are a sane starting point. Also move detail-cell generation off the main thread — it is pure and deterministic, and currently costs 3.09 ms per cell against a 2 ms budget inside `update()`.

---

## 5. What NOT to do

**Do not add more noise octaves.** The composed spectrum was measured properly (40 Hann-windowed 8192-point transects, ensemble-averaged, then octave-band averaged) and it is a smooth monotone power law from 32 km down to 32 m with **no band gap anywhere**; β runs 1.27 → 4.08 monotonically, and in the 500 m–2 km band it sits at β = 2.3–2.6, which is exactly the realistic range. A variogram estimator agrees (RMS height difference rises smoothly, 6.9 m at 8 m lag to 281.1 m at 2048 m). Your problem is not missing spectral energy. It is that the energy has no **causal structure** — the terrain looks wrong for the same reason a room full of correctly-sized furniture arranged at random looks wrong. Adding octave nine cannot create a drainage network. (The one genuine spectral hole is the 8–43 m band, item 2.3 — that is a specific, bounded addition, not "more octaves.")

**Do not replace the noise basis to fix the world grain.** The value-noise lattice is a plausible suspect and it is the wrong one. Measured: single-octave `valueNoise2D` RMS directional derivative is 0.0343 / 0.0342 / 0.0342 / 0.0343 at 0°/22.5°/45°/90° — isotropic to 1.002:1. Gradient-orientation bias, the metric that *could* show grain, is 9.7:1 for a bare octave but collapses to 1.54:1 through `ridgedFbm2D` and **~1.3:1 in the composed field**, ~1.1:1 at 64 m. Local extrema are not lattice-pinned either: phase histograms of composed-field maxima against the 43 m, 74.5 m and 105 m lattices are flat (0.73–1.14 across bins). **The grain you correctly perceive comes from `geology.ts:41-42`'s hard-coded 35° rotation — 23.6:1 in the geology term, 2.7:1 surviving into composed mountain relief at every scale from 2 m to 400 m.** Rewriting the noise basis would cost days and remove none of it.

**Do not switch API or engine again.** Babylon is a capable host and the migration cost you a working detail texture, AO, SSR, temporal accumulation, MSAA and your budget system. WebGL2 → WebGPU → wgpu → anything else will change zero pixels. Concretely: `MaterialPluginBase` is nowhere near a ceiling — the claim that it "has no samplers" is refuted by this codebase's own `CloudShadowMaterialPlugin.ts:148, :179`, which binds a texture through a plugin **on this very terrain material**, and vertex participation is declined by choice at `TerrainMaterialPlugin.ts:233` (`if (shaderType !== "fragment") return null;`), not unavailable. Everything in Tiers 1–3 is implementable in Babylon today.

**Do not restore `TerrainLodMorph.ts` expecting it to stop the popping.** I read all 154 lines of `git show 5ef9a0f^:src/render/TerrainLodMorph.ts`. `applyTerrainBoundaryMorph(positions, sourceHeights, resolution, coarseStride, edges, fadeRows)` takes no distance and no time parameter and has no morph factor. It is a spatial T-junction crack fix, and its own doc says so. The old engine popped between LODs too. Geomorphing has never existed in this codebase.

**Do not add AO before IBL.** Ambient is 4.4% of the light budget (`0.203` vs `4.657` in the green channel at day+clear). Multiplying a 4.4% term by an occlusion factor is invisible. GTAO added tomorrow would produce no perceptible change, and you would reasonably conclude AO doesn't matter. Fix `scene.environmentTexture` first; *then* the missing AO becomes immediately obvious and worth fixing.

**Do not spend time on these micro-optimisations — I measured them and they are not the problem.**

- The `O(N²)` `refreshPageTopologies` (`:649-667`): the index builder is 0.022–0.080 ms per page, the coverage scan short-circuits (`:631`), and the whole thing is 1–2 orders of magnitude below the buffer churn.
- `syncDynamicShadowCasters` (`FlightRenderer.ts:848-862`): it diffs correctly and only calls add/remove on the set difference; steady-state cost is a ~170-entry Map, microseconds. The real cost is the *size* of the resulting render list, which is item 2.5.
- Wildlife thin-instance uploads: Babylon's `updateDirectly` uploads `instancesCount * 64` bytes, not the buffer capacity — ~45 kB/frame, not 1.31 MB.
- Hydrology generation: measured at 71–151 ms per region with 7k–14k samples. `MAX_HYDROLOGY_DIRECTIONAL_TRACE_SAMPLES = 300_000` is a precondition guard that *throws*, not a work budget.
- `backFaceCulling = false`: costs ~1.1–1.35×, not 2×, and cannot be flipped until skirts are gone.

**Do not assume the new build has no budgets.** It has cadences you may not have noticed and would be re-implementing: `resolvePlanarReflectionBudget` gives tier 2 `{480×270, updateEveryNFrames: 3}`, `resolveCloudShadowSchedule` cadences cloud shadows at 2–4 frames, and `addShadowCasters` distance-filters pages. What is genuinely missing is the *absolute* caps — pixel count, memory ceiling, DPR — which is item 1.7.

**Finally, fix the README, and pin it in CI.** `README.md:54` claims "There is no active prepass, TAA, bloom, or sharpening pipeline" (true) but `:56` claims "Eight total levels keep terrain beyond the 120 km view horizon on every quality tier… 80 m edge skirts" — both false (`terrainRings: 6/7/8` per tier; tier 0 reaches only 32.8–41 km; `TERRAIN_SKIRT_DEPTH_METERS = 24`). `README.md:60` and `docs/PERFORMANCE.md:41` claim "Rayleigh/Mie-style scattering" for a three-colour `mix()` at `AtmosphereSystem.ts:66`. **This is why the regressions went unnoticed:** reading your own documentation does not reveal that texturing, AO and ground cover were dropped. Extend `tests/render.webgpu-terrain-clipmap.test.ts` to assert skirt depth and per-tier ring coverage against `camera.maxZ`, and gate every future change on a fixed-seed screenshot pair at 500 ft AGL and 10 km slant range. Backend choice is not a quality lever; a screenshot is.
