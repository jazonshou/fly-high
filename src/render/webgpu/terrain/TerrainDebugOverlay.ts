import { Layer } from "@babylonjs/core/Layers/layer";
import { RawTexture } from "@babylonjs/core/Materials/Textures/rawTexture";
import { Texture } from "@babylonjs/core/Materials/Textures/texture";
import type { Scene } from "@babylonjs/core/scene";
import type { TerrainAtlasSlot, TerrainPageAtlas } from "./TerrainPageAtlas";
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
] as const;

export type TerrainDebugOverlayMode = (typeof TERRAIN_DEBUG_OVERLAY_MODES)[number];

/** Screen fraction, per axis, the slot grid occupies. */
const OVERLAY_SCREEN_FRACTION = 6;

export interface TerrainDebugSlotView {
  readonly state: string;
  readonly level: number;
  readonly minHeightMeters: number;
  readonly maxHeightMeters: number;
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

  /** Repaint from live residency. Cheap enough to call every frame; a no-op when off. */
  update(atlas: TerrainPageAtlas): void {
    if (this.disposed || this.mode === "off") return;
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
    this.present();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.layer?.dispose();
    this.texture?.dispose();
    this.layer = null;
    this.texture = null;
  }

  private present(): void {
    // NullEngine cannot hold a raw texture the layer could sample, and the
    // overlay is a development instrument — never a startup dependency.
    const engineFlags = this.scene.getEngine() as { isWebGPU?: boolean; _gl?: unknown };
    if (!engineFlags.isWebGPU && !engineFlags._gl) return;
    if (!this.texture) {
      this.texture = RawTexture.CreateRGBATexture(
        this.pixels,
        this.textureEdge,
        this.textureEdge,
        this.scene,
        false,
        false,
        Texture.NEAREST_SAMPLINGMODE,
      );
      this.texture.name = "terrain-debug-overlay";
      this.texture.hasAlpha = true;
      this.texture.wrapU = Texture.CLAMP_ADDRESSMODE;
      this.texture.wrapV = Texture.CLAMP_ADDRESSMODE;
      this.layer = new Layer("terrain-debug-overlay", null, this.scene, false);
      this.layer.texture = this.texture;
      this.layer.isEnabled = this.mode !== "off";
      return;
    }
    this.texture.update(this.pixels);
  }
}
