# Browser performance strategy

Aerolith keeps memory and draw work bounded even though the coordinate space is effectively endless.

- Terrain uses fixed near- and far-LOD grids centered near the aircraft; chunks are reassigned instead of accumulated.
- Terrain sampling, normals, and biome colors are generated in a dedicated Worker. A bounded nearest-first queue allows one in-flight job, rejects stale generations after movement or quality changes, and transfers typed-array buffers without cloning.
- If Worker construction or messaging is unavailable, the same deterministic generator runs through a deferred one-job-at-a-time fallback so a restricted browser does not block a frame generating the whole world.
- The renderer applies a floating origin, so GPU-facing coordinates stay near zero during long flights while the simulation retains world coordinates.
- Broadleaf crowns, layered conifers, trunks, far-forest LODs, rocks, runway paint, runway lights, hangars, and cloud clusters use instancing. Scenery positions are keyed to fixed world cells, so changing terrain tiles or floating origins cannot make objects pop to unrelated locations. Materials and immutable index arrays are shared, and GPU attributes have safe per-geometry lifetimes.
- Near-field grass and herbs use two bounded instanced meshes. Their deterministic window is rebuilt only after snapped movement or terrain streaming changes; medium quality caps the added geometry at roughly 80k triangles and two draw calls. The procedural terrain detail texture uses mipmaps and anisotropic filtering so grazing-angle ground detail remains stable without high-resolution downloaded textures.
- An always-ready 1,536-triangle annular horizon mesh gives the scene smooth sampled relief while worker tiles stream. Its five 192-segment rings update only after 6.4 km of travel and bake distance haze into vertex colours.
- The coarse far grid uses a shader cutout beneath the exact near-grid bounds. This preserves normal depth testing and seamless boundary elevation without drawing overlapping terrain fragments or introducing a lowered LOD moat.
- The simulation runs in a separate Worker and never depends on render cadence. Its 60 Hz snapshots are interpolated by the renderer rather than extrapolated through physics state.
- Flight collision queries use a dedicated terrain sample containing only height, normal, runway state, and friction. Airborne steps first use a height-only query and skip all per-wheel normals when the gear cannot reach the surface; far-from-ground AGL also reuses one centre height. Runway samples bypass noise entirely because the airport platform is exactly flat. This keeps climate, biome, and color noise out of the 120 Hz physics loop.
- Device pixel ratio is capped by quality level. Sustained frame-time pressure lowers internal resolution; stable fast rendering raises it gradually.
- Quality presets change terrain resolution, far-LOD resolution, shadow-map size, cloud count, antialiasing, and pixel-ratio limits as one coherent budget. Medium/high use a single aircraft-following directional shadow map; low retains only the inexpensive ground-contact cue. Old terrain remains visible while a quality replacement streams in.
- Water is one opaque, depth-writing physical surface snapped to a coarse global grid. Its world-space Fresnel tint and derivative-faded wave normals require no planar-reflection render pass, preventing transparent-depth flicker and keeping reflection-like sky/sun response bounded to the ordinary scene pass.
- Terrain micro/macro variation comes from one 128×128 deterministic mipmapped data texture shared by all chunks. Shader derivatives fade sub-pixel grain and wave detail before they can shimmer in the distance.
- The diagnostics overlay exposes frame time, draw calls, triangle count, and active tiles for regression testing.

The WebGL renderer is capability-gated. Environments that block WebGL 2 receive a Canvas 2D compatibility renderer while retaining the same simulation, controls, HUD, settings, and audio. Canvas ridge profiles are resampled only after 350 m of travel or a 6° heading change, with a 350 ms minimum cadence; fixed-cell scenery samples use a bounded cache. This avoids running the full multi-octave terrain sampler hundreds of times per compatibility-renderer frame.

## Scenery budgets

At the medium preset the terrain grid is bounded at 49 near chunks and 9 coarse far chunks (roughly 54,000 terrain triangles before scenery). Vegetation is capped at 1,500 detailed trees split between two canopy archetypes, 2,650 low-poly distant trees, and 260 rocks. These render in five instanced calls; the caps decrease to 820 / 1,350 / 120 on low and increase to 2,200 / 4,200 / 420 on high. Worker-completion scenery rebuilds are batched to at most once per 180 ms during streaming.

For performance changes, test at a fixed URL seed and camera mode. Compare a minimum 30-second sample after terrain has settled; initial shader compilation and first audio unlock are not representative steady-state measurements.
