import type { HydrologyWaterSource } from "./hydrologyWater";
import {
  createWaterSurfaceSample,
  type HullWaterSampler,
  type WaterSurfaceAuthority,
  type WaterSurfaceSample,
  type WaveFieldFocus,
} from "./types";

/** Metres above sea level at which a river's or lake's still surface starts to take over from the sea... */
export const MOUTH_LOW = 0.03;
/** ...and from which it answers alone. */
export const MOUTH_HIGH = 0.12;
/** Depth of the sea's surface over the bed, metres, under which the sea's share fades out. */
const MOUTH_SEA_DEPTH = 0.1;

/**
 * The one water authority with the sea and the lakes and rivers as its
 * sources (boats plan: one `WaterSurfaceAuthority`, the sea twin one of its
 * sources).
 *
 * The lakes and rivers answer first: where they hold no water the sea's own
 * answer is returned untouched, so a hull at sea pays one bin lookup a
 * sample. Where they do, the estuary rule (boats lead) decides: a river or
 * lake wins over the sea only where its still surface stands more than a
 * few centimetres above sea level. At or below that the sea answers, so
 * waves run into a river mouth. Between `MOUTH_LOW` and `MOUTH_HIGH` above
 * sea level the two surfaces blend, and the sea's share also fades out as
 * its surface comes down to the bed (at the shore, or in a trough), so the
 * surface is continuous along a river into the sea.
 *
 * As a `HullWaterSampler`, `setTime` goes to both sources and `setFocus` to
 * the sea only (a sea that takes no focus is simply not focused).
 */
export class WaterSurfaceComposite implements HullWaterSampler {
  private readonly inlandSample = createWaterSurfaceSample();
  private readonly focusable: HullWaterSampler | null;

  constructor(
    private readonly sea: WaterSurfaceAuthority,
    private readonly inland: HydrologyWaterSource,
    private readonly seaLevel: number,
  ) {
    this.focusable = "setFocus" in sea ? (sea as HullWaterSampler) : null;
  }

  setTime(time: number): void {
    this.sea.setTime(time);
    this.inland.setTime();
  }

  setFocus(focus: Readonly<WaveFieldFocus>): void {
    this.focusable?.setFocus(focus);
  }

  sample(x: number, z: number, out: WaterSurfaceSample): WaterSurfaceSample {
    const inland = this.inlandSample;
    if (!this.inland.sampleWet(x, z, inland)) return this.sea.sample(x, z, out);
    const above = inland.stillHeight - this.seaLevel;
    if (above >= MOUTH_HIGH) return copySample(inland, out);
    this.sea.sample(x, z, out);
    if (out.kind === "none") return copySample(inland, out);
    // The sea's share: all of it at or below MOUTH_LOW, none at MOUTH_HIGH,
    // and none where the sea's surface (waves and all) is down to the bed.
    const u = Math.min(1, Math.max(0, (above - MOUTH_LOW) / (MOUTH_HIGH - MOUTH_LOW)));
    const bed = inland.stillHeight - inland.depth;
    const seaDepth = Math.max(0, out.height - bed);
    const share = (1 - u * u * (3 - 2 * u)) * Math.min(1, seaDepth / MOUTH_SEA_DEPTH);
    if (share >= 1) return out;
    const keep = 1 - share;
    if (share < 0.5) out.kind = inland.kind;
    out.height = keep * inland.height + share * out.height;
    out.stillHeight = keep * inland.stillHeight + share * out.stillHeight;
    out.depth = keep * inland.depth + share * out.depth;
    out.velocity.x = keep * inland.velocity.x + share * out.velocity.x;
    out.velocity.y = keep * inland.velocity.y + share * out.velocity.y;
    out.velocity.z = keep * inland.velocity.z + share * out.velocity.z;
    const nx = keep * inland.normal.x + share * out.normal.x;
    const ny = keep * inland.normal.y + share * out.normal.y;
    const nz = keep * inland.normal.z + share * out.normal.z;
    const n = 1 / Math.sqrt(nx * nx + ny * ny + nz * nz);
    out.normal.x = nx * n;
    out.normal.y = ny * n;
    out.normal.z = nz * n;
    return out;
  }
}

function copySample(from: Readonly<WaterSurfaceSample>, out: WaterSurfaceSample): WaterSurfaceSample {
  out.kind = from.kind;
  out.height = from.height;
  out.stillHeight = from.stillHeight;
  out.depth = from.depth;
  out.velocity.x = from.velocity.x;
  out.velocity.y = from.velocity.y;
  out.velocity.z = from.velocity.z;
  out.normal.x = from.normal.x;
  out.normal.y = from.normal.y;
  out.normal.z = from.normal.z;
  return out;
}
