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
      "WorldPageChannelDescriptor",
      "WORLD_PAGE_GPU_CHANNELS",
      "WORLD_PAGE_GPU_FORMAT_BYTES",
    ],
    notes:
      "Every page-channel addition goes through one PR against this file. No page-channel type is declared anywhere else.",
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
    ],
    notes: "Terrain-material consumes atlases; it does not create them.",
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
    ],
  },
  {
    // 4-7: the coarse global height field the occlusion bake marches beyond a
    // page, so there is no shadow discontinuity at page edges.
    artifact: "global-height-pyramid",
    owner: "terrain-geometry",
    definitionSites: ["src/render/webgpu/terrain/GlobalHeightPyramid.ts"],
    consumers: ["terrain-geometry", "lighting"],
    ownedSymbols: ["GlobalHeightPyramid", "GLOBAL_HEIGHT_PYRAMID_WGSL"],
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
    definitionSites: ["src/render/webgpu/terrain/TerrainErosionCompute.ts"],
    consumers: ["terrain-geometry"],
    ownedSymbols: ["TerrainErosionCompute"],
    plannedBy: "5-1",
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
    ownedSymbols: ["densityField", "forestFraction"],
    notes: "Terrain-material reads it for the canopy splat channel; it does not reimplement it.",
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
    ],
    notes:
      "A second textual fresnelSchlick/sunSpecular/reflectedSky in a water "
      + "material is the drift 2-8a exists to prevent; 2-9 unified the sun "
      + "lobe, foam, crest SSS and environment-mip helpers here.",
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
    notes: "Pinned at 2,200 m until 5-8 raises it alongside the tectonic skeleton.",
  },
  {
    artifact: "channel-graph-extractor",
    owner: "water",
    definitionSites: ["src/render/webgpu/water/ChannelNetwork.ts"],
    consumers: ["water", "terrain-geometry"],
    ownedSymbols: ["ChannelNetwork"],
    plannedBy: "5-5",
    notes: "Previously unowned and on the critical path.",
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
      "landCoverSuitabilities",
      "landCoverHabitat",
      "landCoverSoftmaxTemperature",
      "LAND_COVER_SPLAT_BAKE_WGSL",
    ],
    notes:
      "Ten smooth suitability functions, softmaxed and top-4 renormalised, "
      + "replacing classifyBiome's threshold cascade. dayOfYear is in the "
      + "signature from the first line (seasonal-family rule).",
  },
  {
    // 4-6b (D12): densityField's WGSL half. ONE shared include consumed by
    // both the classifier and the vegetation path — not a copy.
    artifact: "vegetation-density-field-wgsl",
    owner: "vegetation",
    definitionSites: ["src/render/webgpu/detail/densityFieldWgsl.ts"],
    consumers: "any",
    ownedSymbols: ["VEGETATION_DENSITY_FIELD_WGSL"],
    notes: "Transliteration of densityField.ts; the TS remains the authority.",
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
