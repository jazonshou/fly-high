/**
 * The architectural owner manifest (0-1).
 *
 * RENDERING_PLAN.md §1.4 resolved twelve ownership disputes; this file is
 * that table as data, and tests/architecture.boundaries.test.ts is the
 * enforcement. The audit's sharpest finding was institutional: the correct
 * architecture was specified and a parallel ad-hoc path shipped with none of
 * its properties, because nothing failed when the decision was ignored.
 * Adding a second definition of an owned artifact now fails `npm test` with a
 * message naming the owner.
 *
 * ARCHITECTURE.md is the human-readable form of this manifest.
 */

export type SubsystemName =
  | "terrain-geometry"
  | "terrain-material"
  | "lighting"
  | "performance"
  | "vegetation"
  | "water"
  | "clouds"
  | "aircraft"
  | "world"
  | "simulation";

export interface ArchitecturalOwner {
  /** Stable artifact identifier, e.g. "aerial-perspective-include". */
  readonly artifact: string;
  readonly owner: SubsystemName;
  /** Repo-relative paths (exact, no glob expansion) — normally exactly one. */
  readonly definitionSites: readonly string[];
  readonly consumers: "any" | readonly SubsystemName[];
  /**
   * Exported symbols that may be declared only at the definition sites.
   * The boundary test fails, naming this row, when a declaration of one of
   * these appears anywhere else under src/.
   */
  readonly ownedSymbols?: readonly string[];
  /** The plan item that creates the definition site; absent means it exists. */
  readonly plannedBy?: string;
  readonly notes?: string;
}

export const ARCHITECTURAL_OWNERS: readonly ArchitecturalOwner[] = [
  {
    // Gate A: form, finish and cockpit presentation are one aircraft-owned
    // subsystem. Consumers register its meshes/materials; they do not build a
    // parallel aircraft or reimplement its visibility/propeller contracts.
    artifact: "aircraft-form-and-materials",
    owner: "aircraft",
    definitionSites: [
      "src/render/webgpu/aircraft/builders.ts",
      "src/render/webgpu/aircraft/materialSynthesis.ts",
      "src/render/webgpu/aircraft/animation.ts",
      "src/render/webgpu/aircraft/types.ts",
      "src/render/webgpu/aircraft/createAircraft.ts",
    ],
    consumers: "any",
    ownedSymbols: [
      "AircraftBuildContext",
      "synthesizeAircraftSurface",
      "createAircraftSurfaceTextures",
      "AIRCRAFT_PAINT_FEATURES",
      "resolvePropellerPresentation",
      "AIRCRAFT_EXTERIOR_LAYER_MASK",
      "aircraftCameraLayerMask",
      "createAircraft",
      "createWebGpuAircraft",
    ],
    notes:
      "Gate A owns loft/airfoil form, deterministic finish synthesis, cockpit layers and propeller presentation under src/render/webgpu/aircraft/.",
  },
  {
    artifact: "world-page-payload-schema",
    owner: "terrain-geometry",
    definitionSites: ["src/render/webgpu/world/payload.ts"],
    consumers: "any",
    ownedSymbols: [
      "WorldPagePayload",
      "WorldPageLayout",
      "QuantizedHeightPage",
      "QuantizedMaterialPage",
      "QuantizedSurfacePage",
      "QuantizedHydrologyPage",
      "WORLD_PAGE_SURFACE_CHANNELS",
      "WORLD_PAGE_HYDROLOGY_CHANNELS",
      "WorldPageChannelDescriptor",
      "WORLD_PAGE_GPU_CHANNELS",
      "WORLD_PAGE_GPU_FORMAT_BYTES",
      "decodeWorldPageFlowAccum",
      "encodeWorldPageFlowAccum",
    ],
    notes:
      "Every page-channel addition goes through one PR against this file. No page-channel type is declared anywhere else.",
  },
  {
    // 5-0/5-1: the macro authority, collision ladder and every export shape
    // land before any evolution producer or water consumer.
    artifact: "terrain-evolution-contract",
    owner: "terrain-geometry",
    definitionSites: ["src/render/webgpu/terrain/TerrainEvolutionContract.ts"],
    consumers: "any",
    ownedSymbols: [
      "TERRAIN_EVOLUTION_CONTRACT_VERSION",
      "EVOLUTION_DOMAIN_TEXELS",
      "EVOLUTION_TEXEL_METERS",
      "TERRAIN_EVOLUTION_MACRO_LAYOUT",
      "TERRAIN_HEIGHT_AUTHORITY_LADDER",
      "TerrainMacroEvolutionExport",
      "TerrainEvolutionPageExport",
      "TerrainChannelGraphExport",
      "TerrainLakeExport",
      "TERRAIN_HYDRAULIC_GEOMETRY_LAW",
      "terrainHydraulicGeometry",
      "MINIMUM_MESHED_LAKE_AREA_M2",
    ],
    notes:
      "World-anchored 1024² × 512 m macro domain; same-device deterministic exports; "
      + "hydraulic geometry is exported once and never re-derived by renderers.",
  },
  {
    // 4-0: eleven Phase 4 consumers agree about slot geometry, atlas sizing,
    // the season key, the node record and the parity criterion because this
    // file says so once, before any of them exists.
    artifact: "terrain-spine-contract",
    owner: "terrain-geometry",
    definitionSites: ["src/render/webgpu/terrain/TerrainSpineContract.ts"],
    consumers: "any",
    ownedSymbols: [
      "TerrainSlotKey",
      "SEASON_BUCKETS",
      "SEASON_BUCKETS_RESIDENT",
      "seasonBucket",
      "seasonBucketBlend",
      "terrainTexelSizeMeters",
      "terrainAtlasEdgeTexels",
      "terrainSlotOrigin",
      "TERRAIN_HEIGHT_SLOT_EDGE",
      "TERRAIN_CHANNEL_SLOT_EDGE",
      "TERRAIN_NODE_GRID_RESOLUTION",
      "TERRAIN_NODES_PER_SLOT_EDGE",
      "TERRAIN_SUPERSAMPLE_OFFSETS",
      "TERRAIN_HEIGHT_PARITY_CRITERIA",
      "TERRAIN_SUPPORTED_WORLD_RADIUS_METERS",
      "TERRAIN_HEIGHT_PYRAMID_EDGE",
    ],
    notes:
      "Imports page geometry from world/ and names its own symbols "
      + "TerrainSlot*/TERRAIN_* — a WorldPage* declaration here fails the "
      + "boundary test by name.",
  },
  {
    // 4-0b: 6-10 pulled forward. Three amortised compute producers with hard
    // millisecond caps documented as "enforced by their schedulers", and no
    // scheduler — FrameGraphPass.cadence is an integer frame divisor and
    // nothing else. A second admission policy is that gap reopening.
    artifact: "amortised-compute-meter",
    owner: "performance",
    definitionSites: ["src/render/webgpu/core/ComputeBudget.ts"],
    consumers: "any",
    ownedSymbols: [
      "ComputeBudget",
      "COMPUTE_BUDGET_CLIENTS",
      "ComputeBudgetClient",
    ],
    notes: "One per-frame millisecond meter; every GPU compute producer admits through it.",
  },
  {
    // 4-1: the WGSL height kernel had NO owner row, which is exactly how a
    // second definition of the height kernel would appear — the institutional
    // failure the audit found, in the artifact the phase creates.
    artifact: "terrain-height-kernel-wgsl",
    owner: "terrain-geometry",
    definitionSites: ["src/render/webgpu/terrain/TerrainKernel.ts"],
    consumers: ["terrain-geometry", "terrain-material"],
    ownedSymbols: [
      "TERRAIN_KERNEL_WGSL",
      "TERRAIN_KERNEL_SCALAR_WGSL",
      "TERRAIN_KERNEL_CONSTANTS",
      "TERRAIN_KERNEL_LATTICES",
      "buildTerrainKernelPageUniform",
      "TERRAIN_KERNEL_FORBIDDEN_BUILTINS",
    ],
    notes:
      "A transliteration of src/world/{seed,noise,geology,terrain}.ts, not a "
      + "second kernel. Every expectation constant is INJECTED from the TS "
      + "source; retyping one is how coarse-page mean height moves by metres.",
  },
  {
    artifact: "terrain-page-atlas",
    owner: "terrain-geometry",
    definitionSites: ["src/render/webgpu/terrain/TerrainPageAtlas.ts"],
    consumers: ["terrain-geometry", "terrain-material"],
    ownedSymbols: [
      "TerrainPageAtlas",
      "TerrainAtlasResidency",
      "terrainPageGenerationWgsl",
      "TERRAIN_CHANNEL_TEXTURES",
      "TERRAIN_CHANNEL_TEXTURE_COUNT",
      "TERRAIN_CHANNEL_BYTES_PER_TEXEL",
      "TerrainHydrologyAtlasTextures",
      "TerrainAuxPagePublication",
      "TerrainAuxPagePublisher",
    ],
    notes:
      "Terrain-material consumes atlases; it does not create them. Phase-5 aux uploads use four heterogeneous resources and publish only after the complete channel slot becomes resident, and 6-6's aux publication carries both CPU-consumed ecology channels (signed shore distance and soil depth) with their decode scales.",
  },
  {
    // 4-3: the false-colour overlay RENDERING_PLAN.md mandates before the
    // items that consume it. Unowned, it becomes three overlays.
    artifact: "terrain-debug-overlay",
    owner: "terrain-geometry",
    definitionSites: ["src/render/webgpu/terrain/TerrainDebugOverlay.ts"],
    consumers: ["terrain-geometry", "performance"],
    ownedSymbols: [
      "TerrainDebugOverlay",
      "TERRAIN_DEBUG_OVERLAY_MODES",
      "terrainDebugOverlayColor",
      "TERRAIN_EVOLUTION_DEBUG_PREVIEW_EDGE",
      "buildTerrainEvolutionDebugPreview",
      "terrainEvolutionDebugColor",
    ],
  },
  {
    // 6-11: the horizon operator itself — the march that turns a height field
    // into a packed 8-azimuth horizon, and the lookup that turns that packing
    // plus a sun direction into a visibility scalar.
    //
    // It exists as its own artifact because 6-8 declined the vegetation
    // horizon-shadow term rather than let a second answer to "is this point in
    // terrain shadow" into the tree, and named the condition: extract the
    // operator so both consumers run one of it. Two producers compose the
    // march (the page bake and the global pyramid, with different height
    // sources through one composition hole) and two consumers compose the
    // lookup (terrain surface, far impostors). `consumers: "any"` for the
    // reason the density field's WGSL half has it — a shader-side consumer is
    // what this exists for.
    artifact: "horizon-field-operator",
    owner: "terrain-geometry",
    definitionSites: ["src/render/webgpu/terrain/HorizonField.ts"],
    consumers: "any",
    ownedSymbols: [
      "HORIZON_FIELD_MARCH_WGSL",
      "HORIZON_FIELD_LOOKUP_WGSL",
      "HORIZON_FIELD_AZIMUTHS_MARCHED",
      "HORIZON_FIELD_AZIMUTHS_STORED",
      "HORIZON_FIELD_MARCH_STEPS",
    ],
  },
  {
    // 4-7: the coarse global height field the occlusion bake marches beyond a
    // page, so there is no shadow discontinuity at page edges.
    // 6-11 added the global horizon layers, baked by the shared operator.
    artifact: "global-height-pyramid",
    owner: "terrain-geometry",
    definitionSites: ["src/render/webgpu/terrain/GlobalHeightPyramid.ts"],
    consumers: ["terrain-geometry", "lighting", "vegetation"],
    ownedSymbols: [
      "GlobalHeightPyramid",
      "GLOBAL_HEIGHT_PYRAMID_WGSL",
      "GLOBAL_HORIZON_PYRAMID_WGSL",
    ],
  },
  {
    // 4-7: ONE bake, one owner, one format. Four subsystem designs baked
    // this four ways at three resolutions before the audit.
    artifact: "page-occlusion-bake",
    owner: "terrain-geometry",
    definitionSites: ["src/render/webgpu/terrain/PageOcclusionBake.ts"],
    consumers: "any",
    ownedSymbols: [
      "PageOcclusionBake",
      "PAGE_OCCLUSION_WGSL",
      "PAGE_OCCLUSION_AZIMUTHS",
    ],
  },
  {
    // 4-5: the quadtree, the node record writer and the caster meshes.
    artifact: "cdlod-quadtree",
    owner: "terrain-geometry",
    definitionSites: ["src/render/webgpu/terrain/TerrainQuadtree.ts"],
    consumers: ["terrain-geometry"],
    ownedSymbols: [
      "selectTerrainNodes",
      "terrainNodeMorphK",
      "terrainScreenSpaceError",
      "writeTerrainNodeBuffers",
      "packTerrainNodeSplat",
      "buildTerrainNodeGrid",
    ],
  },
  {
    artifact: "page-geometry-one-number",
    owner: "terrain-geometry",
    definitionSites: ["src/render/webgpu/world/pageGeometry.ts"],
    consumers: "any",
    ownedSymbols: [
      "WORLD_PAGE_BASE_EXTENT_METERS",
      "WORLD_PAGE_GUTTER",
      "WORLD_PAGE_HEIGHT_CORE",
      "WORLD_PAGE_CHANNEL_CORE",
      "WORLD_PAGE_LAYOUT",
    ],
    notes: "512 m base extent · gutter 4 · height core 256 · channel core 128. No 132², no 260², no 66².",
  },
  {
    artifact: "terrain-erosion-compute",
    owner: "terrain-geometry",
    definitionSites: [
      "src/render/webgpu/terrain/TerrainErosionCompute.ts",
      "src/render/webgpu/terrain/TerrainPageErosion.ts",
      "src/render/webgpu/terrain/TerrainPageErosionClient.ts",
      "src/render/webgpu/terrain/TerrainPageErosionGpu.ts",
      "src/workers/terrainErosionProtocol.ts",
      "src/workers/terrainErosion.worker.ts",
    ],
    consumers: ["terrain-geometry"],
    ownedSymbols: [
      "TerrainErosionCompute",
      "TerrainPageErosionClient",
      "TerrainPageErosionGpu",
      "generateTerrainErodedPage",
      "isTerrainErosionWorkerEvent",
    ],
    notes:
      "W-1d: TerrainPageErosionGpu is the producer, a multi-frame GPU DAG amortised under "
      + "ComputeBudget.erosionCompute; the CPU worker path remains the no-device fallback, the "
      + "ensureHydrology recovery path and the tolerance oracle. Still ONE page in flight, still "
      + "behind the same client boundary. The order-dependent MFD stays CPU and round-trips "
      + "through the worker's erode-stage-* protocol mid-DAG.",
  },
  {
    artifact: "terrain-macro-evolution",
    owner: "terrain-geometry",
    definitionSites: [
      "src/render/webgpu/terrain/TerrainMacroEvolution.ts",
      "src/render/webgpu/terrain/TerrainMacroEvolutionClient.ts",
      "src/render/webgpu/terrain/TerrainEvolutionRuntime.ts",
      "src/workers/terrainMacroEvolutionProtocol.ts",
      "src/workers/terrainMacroEvolutionRuntime.ts",
      "src/workers/terrainMacroEvolution.worker.ts",
    ],
    consumers: ["terrain-geometry", "water", "simulation"],
    ownedSymbols: [
      "TerrainMacroEvolution",
      "TerrainMacroEvolutionClient",
      "TerrainEvolutionRuntime",
      "terrainMacroGridFromEvolution",
      "sampleTerrainMacroEvolutionInputs",
      "sampleTerrainMacroUplift",
      "isTerrainMacroEvolutionWorkerEvent",
    ],
    notes:
      "Eager CPU-worker reference producer plus the runtime orchestration boundary. "
      + "The canonical export remains tier-invariant and is not regenerated by consumers.",
  },
  {
    artifact: "terrain-page-hydrology",
    owner: "terrain-geometry",
    definitionSites: ["src/render/webgpu/terrain/TerrainPageHydrology.ts"],
    consumers: ["terrain-geometry", "terrain-material", "water"],
    ownedSymbols: [
      "TerrainPageHydrologyResult",
      "TerrainPageHydrologyUpload",
      "buildTerrainPageHydrology",
      "aggregateTerrainPageHydrologyChildren",
      "terrainPageHydrologyTransferables",
      "terrainTopographicWetnessIndex",
      "terrainTopographicWetnessToUnit",
      "terrainSoilDepthMeters",
      "buildTerrainMacroLakeField",
      "sampleTerrainMacroLakeField",
    ],
    notes:
      "The sole producer of quantized flow, lake-depth, soil-depth and signed-shore-distance page fields; products are built before erosion scratch disposal and transferred together. 6-6 discharged half of register row C-9: soil depth now drives 2-15 clutter density and the forest-floor splat's litter term, and shore distance gained its species/appearance consumers beside the live riparian density law. Lake depth is 6-5's by the recorded split and is the one channel still without a named consumer (asserted by tests/render.webgpu-terrain-page-hydrology.test.ts).",
  },
  {
    artifact: "simulation-terrain-readback",
    owner: "simulation",
    definitionSites: ["src/workers/terrainAuthority.ts"],
    consumers: ["simulation", "terrain-geometry"],
    ownedSymbols: [
      "TerrainAuthority",
      "TerrainMacroGrid",
      "TerrainPagePublication",
      "TERRAIN_READBACK_RING_CAPACITY",
    ],
    notes:
      "Worker-side L0 Catmull-Rom ring and macro fallback; canonical counters remain in TerrainEvolutionContract.ts.",
  },
  {
    artifact: "terrain-consumer-authority-adapter",
    owner: "terrain-geometry",
    definitionSites: ["src/render/webgpu/terrain/TerrainConsumerAuthority.ts"],
    consumers: ["terrain-geometry", "vegetation"],
    ownedSymbols: [
      "TerrainConsumerAuthority",
      "TerrainConsumerHeightAuthority",
      "TerrainConsumerTerrainSample",
      "TerrainConsumerSample",
      "terrainConsumerSampleFromAuthority",
    ],
    notes:
      "Adapts the canonical L0 -> macro -> analytic ladder to rich terrain samples so detail and wildlife do not keep sampling analytic height in eroded worlds.",
  },
  {
    artifact: "aerial-perspective-include",
    owner: "lighting",
    definitionSites: ["src/render/webgpu/atmosphere/AerialPerspective.ts"],
    consumers: "any",
    ownedSymbols: ["AERIAL_PERSPECTIVE_WGSL", "aerialPerspective"],
    notes: "Water, clouds, vegetation, aircraft, airport all consume. Nobody re-derives.",
  },
  {
    // 7-1: the sun's RIGHT ASCENSION, the moon's position/phase/illuminance,
    // and the Julian date the environment clock maps to. EnvironmentDirector
    // keeps owning the sun's rendered DIRECTION — this adds the equatorial
    // quantities that direction cannot express, and the two solar models are
    // held to agreement by test rather than by hope.
    artifact: "celestial-ephemeris",
    owner: "lighting",
    definitionSites: ["src/render/webgpu/atmosphere/Ephemeris.ts"],
    consumers: ["lighting"],
    ownedSymbols: [
      "julianDayForClock",
      "daysSinceJ2000",
      "solarApparentPosition",
      "moonState",
      "moonApparentMagnitude",
      "moonIlluminanceLux",
      "MOONLIGHT_TINT",
      "EPHEMERIS_REFERENCE_JULIAN_DAY",
    ],
    notes:
      "The clock carries no year, so the reference epoch is a NAMED constant "
      + "with a test — moon phase is a deterministic function of dayOfYear "
      + "and a pinned capture clock produces a pinned moon.",
  },
  {
    // 7-3: every star the renderer draws, the frame that puts it in the sky
    // and the photometry that decides how bright it is. The 1C-10
    // placeholder hashed view directions inside the sky fragment; a second
    // star anywhere is that returning.
    artifact: "star-catalogue",
    owner: "lighting",
    definitionSites: ["src/render/webgpu/atmosphere/StarCatalogue.ts"],
    consumers: ["lighting"],
    ownedSymbols: [
      "BRIGHT_STARS",
      "brightStars",
      "generateBackgroundStars",
      "localSiderealTimeHours",
      "equatorialToWorldRows",
      "starIlluminanceLux",
      "relativeAirMass",
      "colorForColorIndex",
      "GALACTIC_POLE_EQUATORIAL",
      "GALACTIC_CENTER_EQUATORIAL",
    ],
    notes:
      "The sidereal matrix is shared: the star field, the sky's Milky Way "
      + "band and the moon's world direction all ride equatorialToWorldRows, "
      + "so they cannot drift apart.",
  },
  {
    artifact: "star-field-renderer",
    owner: "lighting",
    definitionSites: ["src/render/webgpu/atmosphere/StarField.ts"],
    consumers: ["lighting"],
    ownedSymbols: [
      "StarFieldSystem",
      "buildStarFieldGeometry",
      "starVisibilityForSunElevation",
    ],
  },
  {
    // 7-2: the rod/cone blend, the Purkinje shift, the desaturation and the
    // acuity loss. A post-process, never a lighting change — moonlight is
    // warm and the blue is the viewer's rods.
    artifact: "scotopic-vision",
    owner: "lighting",
    definitionSites: ["src/render/webgpu/atmosphere/ScotopicVision.ts"],
    consumers: ["lighting"],
    ownedSymbols: [
      "ScotopicVisionPass",
      "rodFractionForAdaptedLuminance",
      "SCOTOPIC_WEIGHTS",
      "SCOTOPIC_TINT",
    ],
  },
  {
    artifact: "sky-environment-probe",
    owner: "lighting",
    definitionSites: ["src/render/webgpu/atmosphere/SkyEnvironmentProbe.ts"],
    consumers: "any",
    ownedSymbols: ["SkyEnvironmentProbe"],
  },
  {
    artifact: "quality-tiers-and-governors",
    owner: "performance",
    definitionSites: [
      "src/render/webgpu/core/QualityProfile.ts",
      "src/render/webgpu/core/AdaptiveGovernor.ts",
      "src/render/webgpu/core/PerformanceBudget.ts",
    ],
    consumers: "any",
    ownedSymbols: ["WebGpuQualityProfile", "resolveWebGpuQualityProfile"],
    notes:
      "AdaptiveGovernor arrives at 1A-6b, PerformanceBudget at 1A-2. Subsystems contribute rows of data, not tier tables — see the grandfathered-tier-reads allowlist in the boundary test.",
  },
  {
    // 3-0: ten material identities and their physical constants, landed as a
    // tiny reviewable commit before the seven-day synthesis item because SEVEN
    // later consumers depend on it — 3-1 synthesis, 3-2 bindings, 3-6 height
    // blend, 3-7 BRDF, 3-9 runway materials, 3-10 seasonal palette, and 4-6's
    // classifier. An enum with seven consumers that is invented halfway
    // through an eight-day item gets invented seven times.
    artifact: "surface-material-contract",
    owner: "terrain-material",
    definitionSites: ["src/render/webgpu/terrain/surfaceMaterials.ts"],
    consumers: "any",
    ownedSymbols: [
      "SurfaceMaterial",
      "SURFACE_MATERIALS",
      "SURFACE_MATERIAL_COUNT",
      "SURFACE_MATERIAL_ARRAY_COUNT",
      "SURFACE_MATERIALS_BY_BIOME",
      "SURFACE_ALBEDO_STORAGE_GAMMA",
      "meanSurfaceAlbedo",
      "landCoverShare",
    ],
    notes:
      "4-6 INHERITS this enum rather than defining its own — that is the whole "
      + "point of landing it in Phase 3. Lighting consumes meanSurfaceAlbedo "
      + "for the R-26 ground bounce.",
  },
  {
    // 3-1: the ten synthesised land-cover materials. Every texel is a pure
    // function of (seed, edge) and every noise primitive is periodic on the
    // texture's own cell grid.
    artifact: "terrain-material-arrays",
    owner: "terrain-material",
    definitionSites: [
      "src/render/webgpu/terrain/MaterialArraySynthesis.ts",
      // `4.5-C2b` split the GPU boundary out so the recipes can be imported
      // by a worker; both halves are the same owned artifact.
      "src/render/webgpu/terrain/MaterialArrayUpload.ts",
    ],
    consumers: ["terrain-material"],
    ownedSymbols: [
      "synthesizeSurfaceMaterial",
      "synthesizeSurfaceMaterialLayers",
      "planSurfaceMaterialArrays",
      "createSurfaceMaterialArrays",
      "composeSurfaceMaterialContactSheet",
      "TOKSVIG_ROUGHNESS_GAIN",
    ],
    notes:
      "The repo ships zero image assets by design; a second synthesiser, or an "
      + "imported texture, is the audit's root cause #1 reopening from the "
      + "other side.",
  },
  {
    // 3-2 (C1): TerrainMaterialPlugin is DELETED, not neighboured. Both
    // plugins wrote surfaceAlbedo and normalW with composition decided by an
    // undocumented priority number.
    artifact: "terrain-surface-plugin",
    owner: "terrain-material",
    definitionSites: ["src/render/webgpu/terrain/TerrainSurfacePlugin.ts"],
    consumers: ["terrain-material"],
    ownedSymbols: [
      "TerrainSurfacePlugin",
      "surfaceSeasonalResponse",
      "meanSeasonalSurfaceAlbedo",
      "heightBlendWeights",
      "TERRAIN_SURFACE_INJECTION_ANCHORS",
      "TERRAIN_SURFACE_INJECTION_TOKENS",
    ],
    notes:
      "The single owner of terrain surface appearance: albedo, normal, "
      + "roughness, AO and micro-detail. A second plugin writing surfaceAlbedo "
      + "on this material is the split C1 closed.",
  },
  {
    // 3-9: the runway PAINTED into the terrain surface by the analytic airport
    // SDF — not a mesh, not a splat weight, not a decal. That is what decouples
    // it from Phase 4 and what deletes the 28 coplanar boxes' z-fighting.
    artifact: "runway-surface-painter",
    owner: "terrain-material",
    definitionSites: ["src/render/webgpu/terrain/RunwaySurface.ts"],
    consumers: ["terrain-material"],
    ownedSymbols: [
      "RUNWAY_SURFACE_WGSL",
      "RUNWAY_SDF_WGSL",
      "RUNWAY_SURFACE_UNIFORMS",
      "runwayMarkingProfile",
      "resolveRunwaySurfaceBinding",
    ],
    notes:
      "The WGSL SDF is a transliteration of roundedRectangleSignedDistance "
      + "(src/world/airport.ts), held to it by assertion 65. A second SDF is "
      + "the drift that gave water two sun discs.",
  },
  {
    artifact: "runway-earthworks-profile",
    owner: "terrain-material",
    definitionSites: ["src/render/webgpu/terrain/RunwayEarthworks.ts"],
    // 3-8 is Class K: it changes the physics authority, so simulation and
    // world consume it too — the collision fast path in src/world/terrain.ts
    // evaluates exactly this profile.
    consumers: "any",
    ownedSymbols: [
      "runwayEarthworksProfile",
      "runwayEarthworksHeightLocal",
      "runwayCrownHeight",
      "runwayPlatformHeight",
      "runwayPlatformSignedDistance",
      "runwayPlatformHalfLength",
      "runwayPlatformHalfWidth",
    ],
    notes:
      "Terrain-geometry contributes the erosion exclusion mask only. The profile must keep getAirportInfluence exactly 1.0 inside the apron (tests/sim.terrain-authority.test.ts), and collision must agree with the rendered surface to within 1 mm (assertion 63).",
  },
  {
    artifact: "vegetation-density-field",
    owner: "vegetation",
    definitionSites: ["src/render/webgpu/detail/densityField.ts"],
    consumers: ["vegetation", "terrain-material"],
    ownedSymbols: [
      "densityField",
      "forestFraction",
      "riparianVegetationFactors",
      "soilLitterFactor",
      "canopyClosure",
      "canopyHandoff",
      "canopyRenderedShare",
      "canopyGrassCover",
    ],
    notes:
      "Terrain-material reads it for the canopy splat channel; it does not "
      + "reimplement it. 6-6 added two shared ecology laws here for the same "
      + "reason: the riparian corridor's shape and the soil-depth -> litter "
      + "mapping are read by terrain (through this one sanctioned entry point) "
      + "as well as by vegetation, and neither may acquire a second answer. "
      + "6-8 adds the canopy laws on the same terms: closure, the grass-cover "
      + "complement, the rendered/terrain split of that closure at a range, "
      + "and the canopy's measured appearance. The far-band cull window "
      + "(DETAIL_FAR_CULL_FADE_METERS) lives here too, because the terrain "
      + "ramp and the impostor dither have to fade over ONE window.",
  },
  {
    // 2-0: the second instance of the payload.ts institutional failure,
    // closed. The WGSL modules live here; clouds/VolumetricCloudSystem.ts is
    // the runtime that consumes them (the nature/=shader-library,
    // system-directory=runtime arrangement the ocean already uses).
    artifact: "volumetric-cloud-shader-modules",
    owner: "clouds",
    definitionSites: ["src/render/webgpu/nature/CloudShaders.ts"],
    consumers: ["clouds"],
    ownedSymbols: [
      "CLOUD_RAYMARCH_WGSL",
      "CLOUD_TEMPORAL_RESOLVE_WGSL",
      "CLOUD_SHADOW_WGSL",
      "CLOUD_SHADER_MODULES",
    ],
    notes:
      "No inline cloud WGSL outside this file and the composite shell. A second "
      + "raymarch/temporal/shadow definition fails the boundary test.",
  },
  {
    // 2-8a: the §3.6 drift closed. One definition of fresnel/GGX/reflectedSky
    // for every water surface; the genuinely divergent constants are named
    // WaterReflectedSkyParameters at the two call sites.
    artifact: "water-shared-shading",
    owner: "water",
    definitionSites: ["src/render/webgpu/water/WaterShaders.ts"],
    consumers: ["water"],
    ownedSymbols: [
      "WATER_SHADING_CONSTANTS_WGSL",
      "WATER_FRESNEL_SCHLICK_WGSL",
      "WATER_SUN_SPECULAR_WGSL",
      "WATER_FOAM_WGSL",
      "WATER_CREST_SSS_WGSL",
      "WATER_ENVIRONMENT_MIP_WGSL",
      "waterReflectedSkyWgsl",
      "fallbackWaterEnvironmentCube",
      // 6-1: composed into the INLAND fragment only (every input is
      // channel-graph hydraulics), but defined here with the rest of the water
      // shader library so a second copy cannot appear beside HydrologySystem's
      // material — the same rule, applied to a block only one surface uses.
      "WATER_CHANNEL_FLOW_WGSL",
      "waterChannelGradePayload",
      "waterLakeFetchPayload",
      "waterLakeEffectiveFetchMeters",
      "waterStandingWave",
      "waterLakeChop",
      "waterFlowPhase",
      "waterFlowSpeedGain",
      "waterFlowCycleSeconds",
    ],
    notes:
      "A second textual fresnelSchlick/sunSpecular/reflectedSky in a water "
      + "material is the drift 2-8a exists to prevent; 2-9 unified the sun "
      + "lobe, foam, crest SSS and environment-mip helpers here. 6-1 added the "
      + "channel-flow block and its TypeScript parity oracle: the payload "
      + "encoders are the single authority for what HydrologySystem writes "
      + "into waterData.w and what the shader decodes from it.",
  },
  {
    // 2-11: the CPU array-mip reducer (Babylon mips only layer 0 of a
    // Texture2DArray — verified at webgpuTextureManager.js:716). Phase 3's
    // 3-1 reuses it with a Toksvig reducer for the terrain material arrays.
    artifact: "texture-array-mips",
    owner: "performance",
    definitionSites: ["src/render/webgpu/core/TextureArrayMips.ts"],
    consumers: ["performance", "vegetation", "terrain-material", "aircraft"],
    ownedSymbols: [
      "buildMipChain",
      "alphaDilate",
      "alphaCoverage",
      "toksvigReduce",
      "planMippedTextureArray",
      "uploadMippedTextureArrayPlan",
      "createMippedTextureArray",
    ],
  },
  {
    // 2-11: every card layer — trees, shrubs, grass, ground cover, litter —
    // comes from this one atlas; the layer-index map lives here and
    // prototypeGeometry aliases it.
    artifact: "foliage-atlas",
    owner: "vegetation",
    definitionSites: ["src/render/webgpu/detail/FoliageAtlas.ts"],
    consumers: ["vegetation"],
    ownedSymbols: [
      "FOLIAGE_LAYERS",
      "FOLIAGE_ATLAS_EDGE",
      "FOLIAGE_ALPHA_TEST_THRESHOLD",
      "synthesizeFoliageLayers",
      "planFoliageAtlas",
      "createFoliageAtlas",
    ],
  },
  {
    // 2-11b: stand identity is a continuous field at the stem's own world
    // position — never a lattice. 2-12's tint centres and 2-13a's seasonal
    // appearance read the same field.
    artifact: "stand-field",
    owner: "vegetation",
    definitionSites: ["src/render/webgpu/detail/standField.ts"],
    consumers: ["vegetation"],
    ownedSymbols: [
      "sampleStandField",
      "STAND_FIELD_MINIMUM_WAVELENGTH_METERS",
    ],
    notes:
      "A per-block appearance constant anywhere in generation is the 32 m "
      + "lattice returning; the appearance-spectrum test's ANOVA control "
      + "exists to catch exactly that.",
  },
  {
    // 6-7: the talus/scree placement law. 2-15 owns how a rock is DRAWN;
    // this owns where one rests, how many rest there and how big a block is.
    artifact: "talus-placement-law",
    owner: "vegetation",
    definitionSites: ["src/render/webgpu/detail/talusField.ts"],
    consumers: ["vegetation"],
    ownedSymbols: [
      "talusPlacement",
      "talusRestWeight",
      "talusFailureFraction",
      "talusBlockiness",
      "talusReposeSteepness",
      "TalusSupplyProbe",
      "TALUS_NO_SUPPLY",
    ],
    notes:
      "Class P and season-INVARIANT by design: the permanent-snow burial term "
      + "keys on the world's reference snowline offset, never on the "
      + "descending seasonal one, so this file is deliberately not a member of "
      + "SEASONAL_FIELD_FAMILY. Lithology enters through exactly one owned "
      + "number — sampleTerrainEvolutionGeology's reposeDegrees — and soil "
      + "depth through TerrainPageHydrology's terrainSoilDepthMeters, whose "
      + "analytic fallback is that same law at zero curvature and zero "
      + "contributing area rather than a second soil model.",
  },
  {
    // 2-11a: the ONE instance record every detail batch uploads and the ONE
    // decoder that turns it into a world transform.
    artifact: "detail-instance-format",
    owner: "vegetation",
    definitionSites: [
      "src/render/webgpu/detail/instanceFormat.ts",
      "src/render/webgpu/detail/DetailInstanceMaterialPlugin.ts",
    ],
    consumers: ["vegetation", "performance"],
    ownedSymbols: [
      "DETAIL_INSTANCE_STRIDE_BYTES",
      "DETAIL_INSTANCE_ATTRIBUTES",
      "DetailInstanceWriter",
      "DetailInstanceBounds",
      "DetailInstanceMaterialPlugin",
    ],
    notes:
      "A second instance layout or a matrix-based batch path is the 96-byte "
      + "format returning; 2-12..2-17 extend the RECORD, never fork it.",
  },
  {
    // Wave T: the tree skeleton generator — ONE skeleton per (species,
    // variant, seed) feeds every mesh detail level and the leaf-card shell.
    artifact: "tree-skeleton-generator",
    owner: "vegetation",
    definitionSites: ["src/render/webgpu/detail/treeSkeleton.ts"],
    consumers: ["vegetation"],
    ownedSymbols: ["buildTreeSkeleton", "estimateSkeletonTriangles"],
    notes:
      "All tree RNG lives here in one named stream; meshing consumes zero "
      + "RNG so near and mid silhouettes agree by construction.",
  },
  {
    // Wave G: the ground-cover blade law — ring densities, lattice sizing
    // and the altitude gate; the compute system and the budget test read it.
    artifact: "ground-cover-law",
    owner: "vegetation",
    definitionSites: ["src/render/webgpu/detail/groundCoverLaw.ts"],
    consumers: ["vegetation", "performance"],
    ownedSymbols: [
      "GROUND_COVER_LAWS",
      "estimateGroundCoverVertexLoad",
      "GROUND_COVER_ARCHETYPE_SHAPES",
      "groundCoverHandoffRadiusMeters",
      "groundCoverDrawCount",
    ],
    notes:
      "A second blades-per-square-metre constant outside this file is the "
      + "R-21 failure class applied to grass. 6-9 added the archetype shape "
      + "table (read by BOTH the placement compute and the blade material "
      + "plugin), the card-path handoff radius, and the conservative "
      + "draw-count ratchet the GPU cull reads back into.",
  },
  {
    // Wave G: the per-frame compute blade system, its WGSL and its material
    // plugin — placement is a pure function of world position.
    artifact: "ground-cover-blades",
    owner: "vegetation",
    definitionSites: [
      "src/render/webgpu/detail/GroundCoverSystem.ts",
      "src/render/webgpu/detail/groundCoverWgsl.ts",
      "src/render/webgpu/detail/GroundCoverMaterialPlugin.ts",
      "src/render/webgpu/detail/indirectDrawCapability.ts",
    ],
    consumers: ["vegetation"],
    notes:
      "Cover stands on the consumer authority's rendered surface and wears "
      + "the classifier's harmonised ground albedo; no streaming state "
      + "exists anywhere in the path. 6-9 generalised it beyond grass (the "
      + "composed archetype law places fern, heather and reed inside the "
      + "handoff radius, and the card path keeps them outside it), admitted "
      + "it through ComputeBudget as groundCoverCompute, gave the governor "
      + "its gate rung, and added the compaction cull: lanes claim slots "
      + "through a workgroup-reduced atomic, the count returns through a "
      + "readback ring (the DEFAULT path), and the GPU-written indirect "
      + "count is an opt-in optimisation over Babylon private state behind "
      + "one loud assertion (RENDERING_PLAN §7 R4).",
  },
  {
    // R-21: the rendered-density law — 2-12/2-14/2-17 and the runtime
    // thinning all read these bands; nothing re-derives a density ceiling.
    artifact: "rendered-density-law",
    owner: "vegetation",
    definitionSites: ["src/render/webgpu/detail/renderedDensity.ts"],
    consumers: ["vegetation", "performance"],
    ownedSymbols: [
      "RENDERED_DENSITY_LAWS",
      "renderedShareAtDistance",
      "estimateRenderedWoodyLoad",
      "WOODY_TRIANGLE_BUDGETS",
    ],
    notes:
      "A second stems/ha constant or falloff curve outside this file is the "
      + "R-21 re-derivation failure returning.",
  },
  {
    artifact: "max-terrain-height",
    owner: "terrain-geometry",
    definitionSites: ["src/world/terrain.ts"],
    consumers: "any",
    ownedSymbols: ["MAX_TERRAIN_HEIGHT"],
    notes: "Phase-5 activation raised the world bound to 4,500 m.",
  },
  {
    artifact: "channel-graph-extractor",
    owner: "water",
    definitionSites: ["src/render/webgpu/water/ChannelNetwork.ts"],
    consumers: ["water", "terrain-geometry"],
    ownedSymbols: ["ChannelNetwork", "channelGraphToHydrologyGeometry"],
    notes:
      "Extracts one deterministic graph from the canonical macro export; eroded hydrology consumes the exported geometry rather than retracing terrain.",
  },
  {
    artifact: "water-bathymetry-clipmap",
    owner: "water",
    definitionSites: ["src/render/webgpu/water/BathymetryClipmap.ts"],
    consumers: ["water"],
    ownedSymbols: [
      "BathymetryClipmap",
      "BATHYMETRY_LEVELS",
      "sampleBathymetryTerrainAuthority",
      "toroidalBathymetryTexel",
    ],
    notes:
      "Two toroidal R16F levels. Eroded mode samples the canonical macro authority with its cell-centred 16-texel rim blend, then overlays RESIDENT eroded L0 pages inside the update dispatch (W-6, feathered at macro-facing page borders); `sampleBathymetryTerrainAuthority` stays the documented macro floor. Analytic mode remains bit-compatible via the empty-table sentinel.",
  },
  {
    // 4-6/4-6b (R-27): the SOLE authority for what the ground is made of,
    // which trees stand on it and which animals live in them. Before this,
    // classifyBiome's threshold cascade, chooseTreeSpecies and the wildlife
    // habitat rules were three independent answers to one question.
    artifact: "land-cover-classification",
    owner: "terrain-material",
    definitionSites: ["src/render/webgpu/terrain/LandCoverClassifier.ts"],
    consumers: "any",
    ownedSymbols: [
      "classifyLandCover",
      "LandCoverWeights",
      "LAND_COVER_CLASSIFIER_WGSL",
      "landCoverWetness",
      "landCoverSuitabilities",
      "landCoverHabitat",
      "landCoverSoftmaxTemperature",
      "LAND_COVER_SPLAT_BAKE_WGSL",
    ],
    notes:
      "Ten smooth suitability functions, softmaxed and top-4 renormalised, "
      + "replacing classifyBiome's threshold cascade. dayOfYear is in the "
      + "signature from the first line (seasonal-family rule). Phase-5 flow accumulation supplies the live TWI wetness input when resident, and 6-6 adds the soil-depth litter term on the forest floor through the same optional-input-plus-zero-sentinel shape.",
  },
  {
    // 4-6b (D12): densityField's WGSL half. ONE shared include consumed by
    // both the classifier and the vegetation path — not a copy.
    artifact: "vegetation-density-field-wgsl",
    owner: "vegetation",
    definitionSites: ["src/render/webgpu/detail/densityFieldWgsl.ts"],
    consumers: "any",
    ownedSymbols: [
      "VEGETATION_DENSITY_FIELD_WGSL",
      "VEGETATION_GROUND_COVER_LAW_WGSL",
      "VEGETATION_CANOPY_HANDOFF_WGSL",
      "VEGETATION_DENSITY_KERNEL_LATTICES",
    ],
    notes:
      "Transliteration of densityField.ts; the TS remains the authority. 6-8 "
      + "made it the first LIVE composer (the terrain page splat bake) and "
      + "added the lattice table it always said the caller would append, plus "
      + "the canopy-handoff half the terrain material composes. 6-9 split out "
      + "the ground-cover half (archetype mix, closure, grass cover) as its "
      + "own export because it needs no lattice and no page uniform: the "
      + "per-frame ground-cover placement compute composes THAT and the "
      + "terrain kernel's three scalar helpers, so the field and the splat "
      + "bake read one archetype law rather than two.",
  },
  {
    // 4-4: renamed from `terrainQueue.ts`/`BoundedTerrainQueue`. It is the
    // vegetation worker's queue and always was; the owner row exists so the
    // next reader of `RENDERING_PLAN.md:340`'s deletion list cannot mistake
    // it for a terrain file again.
    artifact: "bounded-priority-queue",
    owner: "vegetation",
    definitionSites: ["src/workers/boundedPriorityQueue.ts"],
    consumers: "any",
    ownedSymbols: ["BoundedPriorityQueue"],
  },
  {
    artifact: "detail-worker",
    owner: "vegetation",
    definitionSites: ["src/workers/detail.worker.ts"],
    consumers: ["vegetation"],
  },
  // ——— Phase 0 contracts, enforced with the same machinery ———
  {
    artifact: "environment-clock",
    owner: "world",
    definitionSites: ["src/world/environmentClock.ts"],
    consumers: "any",
    ownedSymbols: ["EnvironmentClock", "createEnvironmentClock", "solarDeclinationRadians"],
    notes: "The two continuous scalars replacing the time-of-day preset enum (§1.6).",
  },
  {
    artifact: "simulation-terrain-authority",
    owner: "simulation",
    definitionSites: ["src/sim/terrainGrid.ts"],
    consumers: ["simulation"],
    ownedSymbols: ["sampleGroundHeight", "sampleGroundContact"],
    notes:
      "Every physics terrain query routes through this module (§1.3). The boundary test forbids direct collision-kernel imports elsewhere.",
  },
  {
    artifact: "terrain-collision-mirror",
    owner: "terrain-geometry",
    definitionSites: ["src/render/webgpu/terrain/TerrainCollisionMirror.ts"],
    consumers: ["terrain-geometry", "simulation"],
    ownedSymbols: ["TerrainCollisionMirror", "NullTerrainCollisionMirror"],
    notes: "Render half of the §1.3 contract; 5-2 implements the readback.",
  },
  {
    artifact: "shared-receiver-registry",
    owner: "lighting",
    definitionSites: ["src/render/webgpu/core/SharedReceiverRegistry.ts"],
    consumers: "any",
    ownedSymbols: ["SharedReceiverRegistry"],
    notes:
      "The one implementation of shared-resource receiver plumbing (0-7). 1C-4 and 1C-6 subclass it; nobody hand-rolls a fourth copy.",
  },
  {
    // 4.5-0: resetDrawCache on a rendered mesh orphans the wrapper's
    // per-submesh defines registration; an unguarded wrapper then poisons its
    // depth-params cache with defines=null and the CSM pass dies in
    // createBindGroup. Every wrapper goes through the one guarded factory so
    // a new construction site cannot reopen the crash.
    artifact: "guarded-shadow-depth-wrapper",
    owner: "lighting",
    definitionSites: ["src/render/webgpu/core/guardedShadowDepthWrapper.ts"],
    consumers: "any",
    ownedSymbols: ["createGuardedShadowDepthWrapper"],
    notes:
      "The one ShadowDepthWrapper construction site. Constructing the Babylon class directly anywhere in src/ reintroduces the orphaned-defines fatal stop; the boundary test forbids it.",
  },
  {
    // 4.5-C2b: the ten ~110 ms layer syntheses moved off the main thread. The
    // worker exists only because `MaterialArraySynthesis.ts` has no Babylon
    // value import — that separation is the artifact, and a second synthesis
    // path (or a Babylon import creeping back into the recipes) breaks it.
    artifact: "terrain-material-synthesis-worker",
    owner: "terrain-material",
    definitionSites: [
      "src/workers/materialSynthesis.worker.ts",
      "src/workers/materialSynthesisProtocol.ts",
      "src/render/webgpu/terrain/MaterialSynthesisClient.ts",
    ],
    consumers: ["terrain-material"],
    ownedSymbols: ["MaterialSynthesisClient", "isMaterialSynthesisEvent"],
    notes:
      "Off-thread terrain material synthesis (4.5-C2b). The client falls back to the in-frame path wherever no Worker exists, which is what the Node suite and every headless tool run.",
  },
];

/**
 * The seasonal field family (§1.6): every one of these takes the environment
 * clock (or dayOfYear) in its input signature from the moment it is first
 * written — never as a retrofit. The boundary test checks each member's
 * source for the reference as the files come into existence.
 */
export interface SeasonalFieldFamilyMember {
  readonly artifact: string;
  readonly definitionSites: readonly string[];
  readonly plannedBy?: string;
}

export const SEASONAL_FIELD_FAMILY: readonly SeasonalFieldFamilyMember[] = [
  {
    artifact: "vegetation-density-field",
    definitionSites: ["src/render/webgpu/detail/densityField.ts"],
  },
  {
    // R-13: the climate kernel that decides snow is itself seasonal now —
    // `seasonalTemperatureOffsetK` and the anchored snow blanket live here,
    // and `4-1` transliterates this file, so the clock must be in its
    // signatures from the first commit (ARCHITECTURE.md §4).
    artifact: "terrain-climate-kernel",
    definitionSites: ["src/world/terrain.ts"],
  },
  {
    artifact: "vegetation-appearance-field",
    definitionSites: ["src/render/webgpu/detail/appearanceField.ts"],
    plannedBy: "2-18",
  },
  {
    // 3-10: surfaceSeasonalResponse(spec, dayOfYear, latitudeDegrees), anchored
    // at the reference day so the tuned midsummer world is unchanged.
    artifact: "surface-seasonal-palette",
    definitionSites: ["src/render/webgpu/terrain/TerrainSurfacePlugin.ts"],
  },
  {
    artifact: "land-cover-classifier",
    definitionSites: ["src/render/webgpu/terrain/LandCoverClassifier.ts"],
    plannedBy: "4-6",
  },
];
