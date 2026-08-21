import { Layer } from "@babylonjs/core/Layers/layer";
import { RawTexture } from "@babylonjs/core/Materials/Textures/rawTexture";
import { Texture } from "@babylonjs/core/Materials/Textures/texture";
import type { Scene } from "@babylonjs/core/scene";
import { sampleTerrainEvolutionGeology } from "@/src/world/terrain";
import type { TerrainAtlasSlot, TerrainPageAtlas } from "./TerrainPageAtlas";
import {
  EVOLUTION_DOMAIN_TEXELS,
  EVOLUTION_TEXEL_METERS,
  TERRAIN_EVOLUTION_MACRO_LAYOUT,
  type TerrainDrainageTermination,
  type TerrainMacroEvolutionExport,
} from "./TerrainEvolutionContract";
import { terrainAtlasGridEdge } from "./TerrainSpineContract";

/**
 * The terrain debug overlay (`4-3`).
 *
 * `RENDERING_PLAN.md` mandates a false-colour debug overlay BEFORE the items
 * that consume it, because Phase 4 is the plan's biggest incrementality risk:
 * Gate 4A generates pages that nothing draws, so without this the only signal
 * that page generation works is a green test. It is also the reason this
 * artifact has an owner row — an unowned overlay becomes three overlays.
 *
 * One texel per ATLAS SLOT, drawn NEAREST into a corner of the screen. The
 * colour mapping is a pure function so it can be asserted in Node; the
 * `Layer` is the thin presenter.
 */

export const TERRAIN_DEBUG_OVERLAY_MODES = [
  "off",
  /** Lifecycle state: what the streamer is doing with each slot. */
  "residency",
  /** Page level: how coarse the resident set is around the aircraft. */
  "level",
  /** Height span: whether generated pages carry plausible relief. */
  "height",
  /** Phase 5 macro diagnostics. These are world fields, not slot summaries. */
  "flow-accumulation",
  "lake-mask",
  "base-levels",
  "fabric",
  "erodibility",
] as const;

export type TerrainDebugOverlayMode = (typeof TERRAIN_DEBUG_OVERLAY_MODES)[number];

/** Screen fraction, per axis, the slot grid occupies. */
const OVERLAY_SCREEN_FRACTION = 6;
/** A useful full-domain diagnostic without retaining a second 1024² image. */
export const TERRAIN_EVOLUTION_DEBUG_PREVIEW_EDGE = 128;

const EVOLUTION_DEBUG_MODES = new Set<TerrainDebugOverlayMode>([
  "flow-accumulation",
  "lake-mask",
  "base-levels",
  "fabric",
  "erodibility",
]);

export interface TerrainEvolutionDebugSource {
  readonly macro: Readonly<TerrainMacroEvolutionExport>;
  readonly seedHash: number;
}

interface TerrainEvolutionDebugCell {
  readonly maximumFlowAreaM2: number;
  readonly lakeCoverage: number;
  readonly baseLevelTermination: TerrainDrainageTermination | null;
  readonly fabricCos2: number;
  readonly fabricSin2: number;
  readonly erodibility: number;
}

export interface TerrainDebugSlotView {
  readonly state: string;
  readonly level: number;
  readonly minHeightMeters: number;
  readonly maxHeightMeters: number;
}

/** Pure colour map shared by the on-screen preview and its Node assertions. */
export function terrainEvolutionDebugColor(
  mode: TerrainDebugOverlayMode,
  cell: TerrainEvolutionDebugCell,
  maximumFlowAreaM2: number,
): readonly [number, number, number, number] {
  if (mode === "flow-accumulation") {
    const normalized = maximumFlowAreaM2 > 0
      ? Math.min(1, Math.log2(cell.maximumFlowAreaM2 + 1) / Math.log2(maximumFlowAreaM2 + 1))
      : 0;
    return [
      Math.round(18 + 237 * normalized),
      Math.round(28 + 185 * Math.sqrt(normalized)),
      Math.round(70 + 185 * (1 - normalized)),
      230,
    ];
  }
  if (mode === "lake-mask") {
    const coverage = Math.min(1, Math.max(0, cell.lakeCoverage));
    return [
      Math.round(15 + 20 * coverage),
      Math.round(25 + 165 * coverage),
      Math.round(35 + 220 * coverage),
      coverage > 0 ? 235 : 190,
    ];
  }
  if (mode === "base-levels") {
    switch (cell.baseLevelTermination) {
      case "sea": return [35, 125, 255, 245];
      case "rim": return [255, 145, 35, 245];
      case "lake": return [225, 55, 235, 245];
      default: return [18, 18, 22, 190];
    }
  }
  if (mode === "fabric") {
    // Double-angle encoding is shown directly. Opposite geological bearings
    // therefore have the same colour, just as the erosion input requires.
    return [
      Math.round((cell.fabricCos2 * 0.5 + 0.5) * 255),
      Math.round((cell.fabricSin2 * 0.5 + 0.5) * 255),
      150,
      230,
    ];
  }
  if (mode === "erodibility") {
    const normalized = Math.min(1, Math.max(0, (cell.erodibility - 0.32) / (1.45 - 0.32)));
    return [
      Math.round(45 + normalized * 210),
      Math.round(175 - normalized * 120),
      Math.round(45 + (1 - normalized) * 80),
      230,
    ];
  }
  return [0, 0, 0, 0];
}

/**
 * Downsample the canonical macro fields for the Phase-5 tuning overlay.
 * Flow uses a block maximum so narrow dendritic channels survive; lakes use
 * coverage; base-level outlets are block-preserving. Fabric and lithology are
 * sampled from the exact seeded field that page erosion consumes.
 */
export function buildTerrainEvolutionDebugPreview(
  mode: TerrainDebugOverlayMode,
  source: TerrainEvolutionDebugSource,
  edge = TERRAIN_EVOLUTION_DEBUG_PREVIEW_EDGE,
): Uint8Array {
  if (!EVOLUTION_DEBUG_MODES.has(mode)) {
    throw new RangeError(`${mode} is not a terrain-evolution debug mode`);
  }
  if (!Number.isSafeInteger(edge) || edge <= 0 || edge > EVOLUTION_DOMAIN_TEXELS) {
    throw new RangeError("Terrain-evolution debug preview edge is invalid");
  }
  if (EVOLUTION_DOMAIN_TEXELS % edge !== 0) {
    throw new RangeError("Terrain-evolution debug preview must divide the macro grid");
  }
  const macro = source.macro;
  const expected = EVOLUTION_DOMAIN_TEXELS * EVOLUTION_DOMAIN_TEXELS;
  if (
    macro.heightMeters.length !== expected
    || macro.flowAccumulationAreaM2.length !== expected
    || macro.lakeMask.length !== expected
  ) {
    throw new RangeError("Terrain-evolution debug source has invalid macro fields");
  }
  const pixels = new Uint8Array(edge * edge * 4);
  const block = EVOLUTION_DOMAIN_TEXELS / edge;
  let maximumFlow = 0;
  for (let index = 0; index < macro.flowAccumulationAreaM2.length; index += 1) {
    maximumFlow = Math.max(maximumFlow, macro.flowAccumulationAreaM2[index]!);
  }
  const baseLevels = mode === "base-levels" ? new Uint8Array(expected) : null;
  if (baseLevels) {
    for (const base of macro.drainageBaseLevels) {
      const index = base.outletTexel.z * EVOLUTION_DOMAIN_TEXELS + base.outletTexel.x;
      baseLevels[index] = base.termination === "sea" ? 1 : base.termination === "rim" ? 2 : 3;
    }
  }
  const geology = { fabricCos2: 1, fabricSin2: 0, erodibility: 1, reposeDegrees: 34 };
  for (let previewZ = 0; previewZ < edge; previewZ += 1) {
    for (let previewX = 0; previewX < edge; previewX += 1) {
      let blockMaximumFlow = 0;
      let wet = 0;
      let baseCode = 0;
      for (let localZ = 0; localZ < block; localZ += 1) {
        const macroZ = previewZ * block + localZ;
        const row = macroZ * EVOLUTION_DOMAIN_TEXELS;
        for (let localX = 0; localX < block; localX += 1) {
          const macroX = previewX * block + localX;
          const index = row + macroX;
          blockMaximumFlow = Math.max(blockMaximumFlow, macro.flowAccumulationAreaM2[index]!);
          wet += macro.lakeMask[index] === 0 ? 0 : 1;
          baseCode = Math.max(baseCode, baseLevels?.[index] ?? 0);
        }
      }
      const macroX = previewX * block + block * 0.5;
      const macroZ = previewZ * block + block * 0.5;
      const worldX = TERRAIN_EVOLUTION_MACRO_LAYOUT.minWorldX
        + macroX * EVOLUTION_TEXEL_METERS;
      const worldZ = TERRAIN_EVOLUTION_MACRO_LAYOUT.minWorldZ
        + macroZ * EVOLUTION_TEXEL_METERS;
      if (mode === "fabric" || mode === "erodibility") {
        sampleTerrainEvolutionGeology(
          source.seedHash,
          worldX,
          worldZ,
          block * EVOLUTION_TEXEL_METERS,
          geology,
        );
      }
      const termination = baseCode === 1
        ? "sea"
        : baseCode === 2
          ? "rim"
          : baseCode === 3
            ? "lake"
            : null;
      const colour = terrainEvolutionDebugColor(mode, {
        maximumFlowAreaM2: blockMaximumFlow,
        lakeCoverage: wet / (block * block),
        baseLevelTermination: termination,
        fabricCos2: geology.fabricCos2,
        fabricSin2: geology.fabricSin2,
        erodibility: geology.erodibility,
      }, maximumFlow);
      pixels.set(colour, (previewZ * edge + previewX) * 4);
    }
  }
  return pixels;
}

/** RGBA in [0, 255] for one slot. Alpha 0 means "draw nothing here". */
export function terrainDebugOverlayColor(
  mode: TerrainDebugOverlayMode,
  slot: TerrainDebugSlotView | null,
): readonly [number, number, number, number] {
  if (mode === "off") return [0, 0, 0, 0];
  if (!slot) return [16, 16, 20, 140];
  if (mode === "residency") {
    switch (slot.state) {
      case "resident": return [40, 210, 90, 220];
      case "generating": return [235, 190, 40, 220];
      case "queued": return [90, 130, 235, 220];
      case "failed": return [235, 60, 50, 220];
      default: return [90, 90, 100, 200];
    }
  }
  if (mode === "level") {
    // A distinct hue per level, cycling every six, so a ring structure reads
    // at a glance rather than needing a legend.
    const hues: readonly (readonly [number, number, number])[] = [
      [235, 70, 70], [235, 160, 60], [225, 225, 70],
      [80, 210, 110], [70, 160, 235], [170, 100, 230],
    ];
    const hue = hues[slot.level % hues.length]!;
    return [hue[0], hue[1], hue[2], 220];
  }
  // "height": relief span, clamped at 600 m so foothills are distinguishable.
  const span = Math.max(0, slot.maxHeightMeters - slot.minHeightMeters);
  const normalized = Math.min(1, span / 600);
  return [
    Math.round(30 + normalized * 225),
    Math.round(30 + (1 - normalized) * 120),
    Math.round(60 + (1 - normalized) * 120),
    220,
  ];
}

function viewOf(slot: TerrainAtlasSlot): TerrainDebugSlotView {
  return {
    state: slot.lifecycle.state,
    level: slot.address.level,
    minHeightMeters: slot.stats.minHeightMeters,
    maxHeightMeters: slot.stats.maxHeightMeters,
  };
}

export class TerrainDebugOverlay {
  private mode: TerrainDebugOverlayMode = "off";
  private layer: Layer | null = null;
  private texture: RawTexture | null = null;
  private pixels: Uint8Array;
  private readonly gridEdge: number;
  private readonly textureEdge: number;
  private presentedTextureEdge = 0;
  private evolutionSource: TerrainEvolutionDebugSource | null = null;
  private readonly evolutionPreviews = new Map<TerrainDebugOverlayMode, Uint8Array>();
  private disposed = false;

  constructor(private readonly scene: Scene, slotCount: number) {
    this.gridEdge = terrainAtlasGridEdge(slotCount);
    this.textureEdge = this.gridEdge * OVERLAY_SCREEN_FRACTION;
    this.pixels = new Uint8Array(this.textureEdge * this.textureEdge * 4);
  }

  get currentMode(): TerrainDebugOverlayMode {
    return this.mode;
  }

  /** Cycle to the next mode. Bound to a debug key by the renderer. */
  cycleMode(): TerrainDebugOverlayMode {
    const index = TERRAIN_DEBUG_OVERLAY_MODES.indexOf(this.mode);
    this.setMode(
      TERRAIN_DEBUG_OVERLAY_MODES[(index + 1) % TERRAIN_DEBUG_OVERLAY_MODES.length]!,
    );
    return this.mode;
  }

  setMode(mode: TerrainDebugOverlayMode): void {
    if (mode === this.mode) return;
    this.mode = mode;
    if (this.layer) this.layer.isEnabled = mode !== "off";
  }

  setEvolutionSource(source: TerrainEvolutionDebugSource | null): void {
    if (
      source
      && (!Number.isSafeInteger(source.seedHash)
        || source.macro.provenance.worldSeed.length === 0)
    ) {
      throw new RangeError("Terrain-evolution debug source is invalid");
    }
    if (source?.macro === this.evolutionSource?.macro && source?.seedHash === this.evolutionSource?.seedHash) {
      return;
    }
    this.evolutionSource = source;
    this.evolutionPreviews.clear();
  }

  /** Repaint from live residency. Cheap enough to call every frame; a no-op when off. */
  update(atlas: TerrainPageAtlas): void {
    if (this.disposed || this.mode === "off") return;
    if (EVOLUTION_DEBUG_MODES.has(this.mode)) {
      if (!this.evolutionSource) return;
      let preview = this.evolutionPreviews.get(this.mode);
      if (!preview) {
        preview = buildTerrainEvolutionDebugPreview(this.mode, this.evolutionSource);
        this.evolutionPreviews.set(this.mode, preview);
      }
      this.present(preview, TERRAIN_EVOLUTION_DEBUG_PREVIEW_EDGE);
      return;
    }
    const bySlot = new Map<number, TerrainAtlasSlot>();
    for (const slot of atlas.residency.entries) bySlot.set(slot.slotIndex, slot);
    this.pixels.fill(0);
    for (let index = 0; index < atlas.residency.slotCount; index += 1) {
      const slot = bySlot.get(index);
      const colour = terrainDebugOverlayColor(this.mode, slot ? viewOf(slot) : null);
      const column = index % this.gridEdge;
      const row = Math.floor(index / this.gridEdge);
      const offset = (row * this.textureEdge + column) * 4;
      this.pixels[offset] = colour[0];
      this.pixels[offset + 1] = colour[1];
      this.pixels[offset + 2] = colour[2];
      this.pixels[offset + 3] = colour[3];
    }
    this.present(this.pixels, this.textureEdge);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.layer?.dispose();
    this.texture?.dispose();
    this.layer = null;
    this.texture = null;
  }

  private present(pixels: Uint8Array, edge: number): void {
    // NullEngine cannot hold a raw texture the layer could sample, and the
    // overlay is a development instrument — never a startup dependency.
    const engineFlags = this.scene.getEngine() as { isWebGPU?: boolean; _gl?: unknown };
    if (!engineFlags.isWebGPU && !engineFlags._gl) return;
    if (this.texture && this.presentedTextureEdge !== edge) {
      this.layer?.dispose();
      this.texture.dispose();
      this.layer = null;
      this.texture = null;
    }
    if (!this.texture) {
      this.texture = RawTexture.CreateRGBATexture(
        pixels,
        edge,
        edge,
        this.scene,
        false,
        false,
        Texture.NEAREST_SAMPLINGMODE,
      );
      this.texture.name = "terrain-debug-overlay";
      this.texture.hasAlpha = true;
      this.texture.wrapU = Texture.CLAMP_ADDRESSMODE;
      this.texture.wrapV = Texture.CLAMP_ADDRESSMODE;
      this.presentedTextureEdge = edge;
      this.layer = new Layer("terrain-debug-overlay", null, this.scene, false);
      this.layer.texture = this.texture;
      this.layer.isEnabled = this.mode !== "off";
      return;
    }
    this.texture.update(pixels);
  }
}
