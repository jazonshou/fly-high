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
    ],
    notes:
      "Every page-channel addition goes through one PR against this file. No page-channel type is declared anywhere else.",
  },
  {
    artifact: "terrain-page-atlas",
    owner: "terrain-geometry",
    definitionSites: ["src/render/webgpu/terrain/TerrainPageAtlas.ts"],
    consumers: ["terrain-geometry", "terrain-material"],
    ownedSymbols: ["TerrainPageAtlas"],
    plannedBy: "4-2",
    notes: "Terrain-material consumes atlases; it does not create them.",
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
    artifact: "runway-earthworks-profile",
    owner: "terrain-material",
    definitionSites: ["src/render/webgpu/terrain/RunwayEarthworks.ts"],
    consumers: ["terrain-material", "terrain-geometry"],
    ownedSymbols: ["RunwayEarthworks", "runwayEarthworksProfile"],
    plannedBy: "3-8",
    notes:
      "Terrain-geometry contributes the erosion exclusion mask only. The profile must keep getAirportInfluence exactly 1.0 inside the apron (tests/sim.terrain-authority.test.ts).",
  },
  {
    artifact: "vegetation-density-field",
    owner: "vegetation",
    definitionSites: ["src/render/webgpu/detail/densityField.ts"],
    consumers: ["vegetation", "terrain-material"],
    ownedSymbols: ["densityField"],
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
    consumers: ["performance", "vegetation", "terrain-material"],
    ownedSymbols: [
      "buildMipChain",
      "alphaDilate",
      "alphaCoverage",
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
    artifact: "surface-seasonal-palette",
    definitionSites: ["src/render/webgpu/terrain/TerrainSurfacePlugin.ts"],
    plannedBy: "3-10",
  },
  {
    artifact: "land-cover-classifier",
    definitionSites: ["src/render/webgpu/terrain/LandCoverClassifier.ts"],
    plannedBy: "4-6",
  },
];
