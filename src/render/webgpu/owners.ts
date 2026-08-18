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
