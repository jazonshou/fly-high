import type { WaterBedPoint, WaterSurfaceAuthority, WaterSurfaceSample } from "./types";

/**
 * How far above sea level a bed known to the caller must stand for `isDry`
 * to answer without reading the bed itself, metres: more than a car's
 * cached lattice can stand off the terrain authority, whose pages land
 * under it for up to a second before its nodes are read again.
 */
export const CALM_DRY_MARGIN = 1;

/**
 * Still water at sea level wherever the bed lies below it.
 *
 * The shared base's water authority: correct for any surface vehicle that
 * does not need waves (a car fording, a moored hull in a dead calm), and the
 * fallback a wave sampler is tested against. `bedHeight` is the worker's
 * terrain height authority, so the bed here is the bed the hull grounds on.
 */
export class CalmWaterSurface implements WaterSurfaceAuthority {
  constructor(
    private readonly seaLevel: number,
    private readonly bedHeight: (x: number, z: number) => number,
  ) {}

  setTime(): void {}

  /** Dry for certain where the caller's bed stands a margin above sea level: no bed read. */
  isDry(at: Readonly<WaterBedPoint>): boolean {
    return at.height > this.seaLevel + CALM_DRY_MARGIN;
  }

  sample(x: number, z: number, out: WaterSurfaceSample): WaterSurfaceSample {
    const bed = this.bedHeight(x, z);
    const depth = this.seaLevel - bed;
    out.velocity.x = 0;
    out.velocity.y = 0;
    out.velocity.z = 0;
    out.normal.x = 0;
    out.normal.y = 1;
    out.normal.z = 0;
    if (Number.isFinite(depth) && depth > 0) {
      out.kind = "sea";
      out.height = this.seaLevel;
      out.stillHeight = this.seaLevel;
      out.depth = depth;
    } else {
      out.kind = "none";
      out.height = Number.isFinite(bed) ? bed : this.seaLevel;
      out.stillHeight = this.seaLevel;
      out.depth = 0;
    }
    return out;
  }
}
