import type { StructureInteriorVolume, StructureLayoutModel } from "../structureModel";

/**
 * The baked indoor light: how much daylight reaches a point inside a room
 * through its windows and doors, as a factor on the sky's ambient light (the
 * sun is off indoors). It is the room's daylight factor, direct through each
 * opening plus what the room's walls bounce round, scaled to what an eye
 * adapted indoors sees: about 0.15 in a far corner, 1 beside a window.
 *
 * The direct part is the form factor from a small patch at the point to each
 * opening (a rectangle, cut into 3 x 3 pieces): the share of the patch's
 * cosine-weighted hemisphere the opening fills. A window shows about as much
 * ground as sky and its glass keeps 80%, which the opening's `sky` weight
 * carries. The bounce part is the split-flux estimate: the light the
 * openings let in, spread over the room's whole surface and reflected with
 * the average reflectance.
 */

/** Indoor factor per unit daylight factor: the adapted eye's gain. */
export const STRUCTURE_INDOOR_GAIN = 9;
/** Least indoor factor (a closed attic corner still is not black). */
export const STRUCTURE_INDOOR_MIN = 0.06;
/** Average reflectance of a room's surfaces (light plaster, timber floors). */
const ROOM_REFLECTANCE = 0.45;
/** A window's sky weight: half its view is ground, and glass keeps 80%. */
export const WINDOW_SKY = 0.6 * 0.8;
/** An open outside door: half sky, no glass. */
export const DOOR_SKY = 0.6;

export interface LightOpening {
  /** Centre, building frame. */
  readonly x: number;
  readonly y: number;
  readonly z: number;
  /** Outward normal (towards the light), horizontal. */
  readonly nx: number;
  readonly nz: number;
  readonly width: number;
  readonly height: number;
  /** What one unit of form factor through it is worth (sky, glass; a neighbour room's light). */
  readonly sky: number;
}

/** The direct daylight factor at a point with normal n from the openings. */
export function directDaylight(
  px: number, py: number, pz: number, nx: number, ny: number, nz: number, openings: readonly LightOpening[],
): number {
  let total = 0;
  for (const o of openings) {
    // The opening's in-plane axes: across (horizontal) and up.
    const ax = -o.nz;
    const az = o.nx;
    // Fewer cells the farther away the opening is: its form factor is smooth there.
    const ox = o.x - px;
    const oy = o.y - py;
    const oz = o.z - pz;
    const size = Math.max(o.width, o.height);
    const far2 = (ox * ox + oy * oy + oz * oz) / (size * size);
    const cells = far2 > 4 ? 1 : far2 > 1.2 ? 2 : 3;
    const cellArea = (o.width * o.height) / (cells * cells);
    let sum = 0;
    for (let i = 0; i < cells; i += 1) {
      const a = ((i + 0.5) / cells - 0.5) * o.width;
      for (let j = 0; j < cells; j += 1) {
        const b = ((j + 0.5) / cells - 0.5) * o.height;
        const qx = o.x + ax * a;
        const qy = o.y + b;
        const qz = o.z + az * a;
        const dx = qx - px;
        const dy = qy - py;
        const dz = qz - pz;
        const d2 = dx * dx + dy * dy + dz * dz;
        if (d2 < 1e-6) continue;
        const d = Math.sqrt(d2);
        const cosP = (nx * dx + ny * dy + nz * dz) / d;
        // The light comes in through the opening: the point must be on its inside.
        const cosO = (o.nx * dx + o.nz * dz) / d;
        if (cosP <= 0 || cosO <= 0) continue;
        // Never more than the patch's whole hemisphere for one cell (very near a window).
        sum += Math.min(0.25, (cellArea * cosP * cosO) / (Math.PI * Math.max(d2, 0.09)));
      }
    }
    total += sum * o.sky;
  }
  return total;
}

/** The bounce part: the daylight let in, spread over the room's surface. */
export function bouncedDaylight(volume: StructureInteriorVolume, openings: readonly LightOpening[]): number {
  const w = volume.maxX - volume.minX;
  const h = volume.maxY - volume.minY;
  const d = volume.maxZ - volume.minZ;
  const surface = 2 * (w * d + w * h + d * h);
  let flux = 0;
  // Each opening lets in about half its area's worth of sky (a vertical opening sees half the sky dome).
  for (const o of openings) flux += 0.5 * o.width * o.height * o.sky;
  return (flux * ROOM_REFLECTANCE) / (surface * (1 - ROOM_REFLECTANCE));
}

/** Daylight factor to the indoor factor: gain, then a soft shoulder to 1. */
export function indoorFactor(daylight: number): number {
  const x = daylight * STRUCTURE_INDOOR_GAIN;
  const shaped = 1 - Math.exp(-1.6 * x);
  return Math.max(STRUCTURE_INDOOR_MIN, Math.min(1, shaped / (1 - Math.exp(-1.6))));
}

interface LitRoom {
  readonly volume: StructureInteriorVolume;
  readonly openings: LightOpening[];
  readonly bounce: number;
}

/**
 * A building's indoor light, from its layout: for a point and normal
 * (building frame), the indoor factor of the room the point faces into. The
 * mesh builder evaluates it per vertex; the kit evaluates it per room for
 * each part's own `indoor`.
 */
export interface StructureIndoorLight {
  at(px: number, py: number, pz: number, nx: number, ny: number, nz: number): number;
  /** A room's mean factor over its floor (the work plane, 0.8 m up, on a 0.9 m grid). */
  roomMean(volume: StructureInteriorVolume): number;
}

/** How far outside a room's box an opening may sit and still light it: the wall's thickness. */
const OPENING_REACH = 0.5;

/** Whether an opening (centre, horizontal normal) is in one of the volume's walls: within reach across, inside along. */
function near(volume: StructureInteriorVolume, x: number, y: number, z: number, nx: number, reach: number): boolean {
  const rx = Math.abs(nx) > 0.5 ? reach : 0.01;
  const rz = Math.abs(nx) > 0.5 ? 0.01 : reach;
  return x >= volume.minX - rx && x <= volume.maxX + rx
    && y >= volume.minY - 0.05 && y <= volume.maxY + 0.05
    && z >= volume.minZ - rz && z <= volume.maxZ + rz;
}

function inside(volume: StructureInteriorVolume, x: number, y: number, z: number, pad: number): boolean {
  return x >= volume.minX - pad && x <= volume.maxX + pad
    && y >= volume.minY - pad && y <= volume.maxY + pad
    && z >= volume.minZ - pad && z <= volume.maxZ + pad;
}

/** The openings that light a room: its windows and doors, the outside ones as sky, inside doors as their other room. */
function roomOpenings(volume: StructureInteriorVolume, layout: StructureLayoutModel): LightOpening[] {
  const out: LightOpening[] = [];
  for (const w of layout.windows) {
    if (!near(volume, w.x, w.y, w.z, w.nx, OPENING_REACH)) continue;
    out.push({ x: w.x, y: w.y, z: w.z, nx: w.nx, nz: w.nz, width: w.width, height: w.height, sky: WINDOW_SKY });
  }
  for (const p of layout.portals) {
    const cy = p.y + p.height * 0.5;
    if (!near(volume, p.x, cy, p.z, p.nx, OPENING_REACH)) continue;
    // Facing out of this room: flip the portal's way out when it points into the room.
    const ahead = inside(volume, p.x + p.nx * 0.4, cy, p.z + p.nz * 0.4, 0);
    const nx = ahead ? -p.nx : p.nx;
    const nz = ahead ? -p.nz : p.nz;
    out.push({ x: p.x, y: cy, z: p.z, nx, nz, width: p.width, height: p.height, sky: p.outside ? DOOR_SKY : DOOR_SKY * 0.25 });
  }
  return out;
}

export function structureIndoorLight(layout: StructureLayoutModel): StructureIndoorLight {
  const rooms: LitRoom[] = layout.volumes.map((volume) => {
    const openings = roomOpenings(volume, layout);
    return { volume, openings, bounce: bouncedDaylight(volume, openings) };
  });
  const lit = rooms.filter((r) => !r.volume.room.includes("stairwell"));
  let last: LitRoom | null = null;
  const roomFor = (px: number, py: number, pz: number, nx: number, ny: number, nz: number): LitRoom | null => {
    // The room the face looks into: a little way along its normal.
    const qx = px + nx * 0.15;
    const qy = py + ny * 0.15;
    const qz = pz + nz * 0.15;
    // Rooms do not overlap but for stairwells, which take their hall's light (they are not lit apart).
    if (last && inside(last.volume, qx, qy, qz, 0.02)) return last;
    let best: LitRoom | null = null;
    for (const room of lit) {
      if (inside(room.volume, qx, qy, qz, 0.02)) {
        best = room;
        break;
      }
    }
    if (!best) {
      for (const room of rooms) if (inside(room.volume, qx, qy, qz, 0.35)) return room;
    }
    last = best;
    return best;
  };
  const evaluate = (room: LitRoom, px: number, py: number, pz: number, nx: number, ny: number, nz: number) =>
    indoorFactor(directDaylight(px + nx * 0.02, py + ny * 0.02, pz + nz * 0.02, nx, ny, nz, room.openings) + room.bounce);
  const means = new Map<StructureInteriorVolume, number>();
  const roomMean = (volume: StructureInteriorVolume): number => {
    const cached = means.get(volume);
    if (cached !== undefined) return cached;
    const room = rooms.find((r) => r.volume === volume);
    if (!room) return STRUCTURE_INDOOR_MIN;
    const v = volume;
    const nx = Math.max(1, Math.round((v.maxX - v.minX) / 0.9));
    const nz = Math.max(1, Math.round((v.maxZ - v.minZ) / 0.9));
    const y = Math.min(v.maxY - 0.1, v.minY + 0.8);
    let sum = 0;
    for (let i = 0; i < nx; i += 1) {
      for (let k = 0; k < nz; k += 1) {
        const x = v.minX + ((i + 0.5) / nx) * (v.maxX - v.minX);
        const z = v.minZ + ((k + 0.5) / nz) * (v.maxZ - v.minZ);
        sum += evaluate(room, x, y, z, 0, 1, 0);
      }
    }
    const mean = sum / (nx * nz);
    means.set(volume, mean);
    return mean;
  };
  return {
    at(px, py, pz, nx, ny, nz) {
      const room = roomFor(px, py, pz, nx, ny, nz);
      return room ? evaluate(room, px, py, pz, nx, ny, nz) : STRUCTURE_INDOOR_MIN;
    },
    roomMean,
  };
}
