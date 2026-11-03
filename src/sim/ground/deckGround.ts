import { SurfaceMaterial } from "@/src/render/webgpu/terrain/surfaceMaterials";
import { homeMarina } from "@/src/world/marina";
import { MARINA_EARTHWORKS } from "@/src/world/marinaEarthworks";
import {
  MARINA_LAYOUT,
  marinaBoxOrientation,
  marinaToWorld,
  type MarinaBoxKind,
  type MarinaLayout,
} from "@/src/world/marinaLayout";
import type { WorldDefinition } from "@/src/world/types";
import { rotateVectorInto } from "../math";
import type { Vec3 } from "../types";
import { describeSurface, type CarSurface } from "./surface";
import { TERRAIN_LATTICE_METERS, type GroundField, type GroundPoint } from "./terrainPatch";

/**
 * The home marina's hard surfaces as the car's ground: the pier deck, the
 * gangway and the quay wall's coping for the tyres, and the front of the
 * quay apron for the tyres and the hull.
 *
 * THE DECKS. The terrain under them is the dredged bed and the quay cut
 * (`marinaEarthworks.ts`: the apron's front drops to the bed inside the
 * wall), so without them a tyre falls through the pier and into the cut
 * behind the quay face. Each deck is the top face of its marina box, read
 * from `homeMarina(world).boxes`: the records the hull collides with
 * (`addMarinaColliders`) and the renderer draws, so the deck a tyre rolls on
 * is the box the bumper meets. Inside a top face's plan the face is the
 * ground, its plane's height and gradient; its edges are steps, which the
 * tyre contact climbs and rolls off as it does any ledge (`wheelContact.ts`).
 * The decks are the tyres' ground alone: the hull meets them as colliders.
 *
 * A deck is ground only from above: a tyre whose centre is under a deck's
 * top (a wheel in the basin beside the quay wall, or under the pier) does not
 * see it, and the hull meets it as the collider it is. `viewY` is that
 * centre's height, set by the caller before each tyre's contact search.
 *
 * THE APRON'S FRONT. The quay cut is a 4.5 m face in 0.7 m, far sharper
 * than the height authority's 2 m lattice can hold: its Catmull-Rom rings
 * over the apron behind the wall, with humps of half a metre and holes of
 * more within 2.5 m of the coping, none of them drawn. The apron is level at
 * the quay deck by construction (the earthworks' quay apron), so the car
 * reads it so: along each quay wall, from the cut's top back as far as the
 * spline's 4 x 4 patch reaches (two lattice cells on a diagonal), the ground
 * is the quay deck's height. That strip is not a collider, so it is the
 * hull's ground too (`hullGround`).
 *
 * Only the static decks: the pontoons and fingers float (the boat's
 * kinematic colliders), the buildings are colliders alone, and posts and
 * bollards are not ground.
 */

/** The marina boxes whose top faces are ground. */
export const DECK_BOX_KINDS: ReadonlySet<MarinaBoxKind> = new Set<MarinaBoxKind>(["pierDeck", "gangway", "quayWall"]);

/** What a deck is made of, for the tyre's surface. */
export const DeckMaterial = Object.freeze({ timber: 0, concrete: 1 });

/** How far behind the quay cut's top a node of the cut still reaches the spline: two lattice cells on a diagonal, m. */
export const APRON_FRONT_METERS = 2 * TERRAIN_LATTICE_METERS * Math.SQRT2;

/**
 * Dry planed decking: a judgement, not a measurement. Rubber on dry timber
 * grips about four fifths as well as on the asphalt the tyre curves are
 * fitted to, rolls a little harder, and the plank joints add a fine
 * roughness (m RMS, as `surface.ts`'s ISO 8608 values).
 */
const TIMBER: readonly [number, number, number] = [0.8, 0.014, 0.002];

// One deck's record: its top face's centre and unit normal, its box-local x
// and z axes in the world, and its half extents along them. The materials
// are their own integer array, so `materialAt` returns a small integer.
const CX = 0;
const CY = 1;
const CZ = 2;
const NX = 3;
const NY = 4;
const NZ = 5;
const AX = 6;
const AZ = 9;
const HALF_X = 12;
const HALF_Z = 13;
const STRIDE = 14;

// One apron strip's record, in the marina frame: its right and out extents.
const RIGHT_MIN = 0;
const RIGHT_MAX = 1;
const OUT_MIN = 2;
const OUT_MAX = 3;
const STRIP_STRIDE = 4;

/** Two heights this close are the same face: a contact's ground copied from a deck's evaluation is that deck's exactly. */
const SAME_FACE = 1e-6;

/** The apron's front at the quay deck's height over the terrain: the hull's ground, and the tyres' under the decks. */
class ApronGround implements GroundField {
  strips = new Float64Array(0);
  count = 0;
  height = 0;
  // The marina frame.
  originX = 0;
  originZ = 0;
  rightX = 0;
  rightZ = 0;
  outX = 0;
  outZ = 0;
  minX = Infinity;
  maxX = -Infinity;
  minZ = Infinity;
  maxZ = -Infinity;

  constructor(private readonly base: GroundField) {}

  evaluate(at: GroundPoint): void {
    this.base.evaluate(at);
    const x = at.x;
    const z = at.z;
    if (!(x >= this.minX && x <= this.maxX && z >= this.minZ && z <= this.maxZ)) return;
    const dx = x - this.originX;
    const dz = z - this.originZ;
    const right = dx * this.rightX + dz * this.rightZ;
    const out = dx * this.outX + dz * this.outZ;
    const s = this.strips;
    for (let o = 0; o < this.count * STRIP_STRIDE; o += STRIP_STRIDE) {
      if (right < s[o + RIGHT_MIN]! || right > s[o + RIGHT_MAX]! || out < s[o + OUT_MIN]! || out > s[o + OUT_MAX]!) continue;
      at.height = this.height;
      at.dhdx = 0;
      at.dhdz = 0;
      return;
    }
  }
}

export class DeckGround implements GroundField {
  /** The height of the centre of the tyre being asked about: decks above it are not ground. */
  viewY = Infinity;
  /** The hull's ground: the terrain with the apron's front at its level, and no decks. */
  readonly hullGround: GroundField;
  private readonly apron: ApronGround;
  private decks = new Float64Array(0);
  private materials = new Int8Array(0);
  private count = 0;
  private world: WorldDefinition | null = null;
  private layoutValue: MarinaLayout | null = null;
  // The decks' plan in the world, so a point away from the marina costs one test.
  private minX = Infinity;
  private maxX = -Infinity;
  private minZ = Infinity;
  private maxZ = -Infinity;

  constructor(base: GroundField) {
    this.apron = new ApronGround(base);
    this.hullGround = this.apron;
  }

  /** The layout the decks were read from, null without a world. */
  get layout(): MarinaLayout | null {
    return this.layoutValue;
  }

  /** How many decks there are (for tests). */
  get deckCount(): number {
    return this.count;
  }

  /** Read the decks of `world`'s home marina, when the world changes. */
  setWorld(world: WorldDefinition | null): void {
    if (world === this.world) return;
    this.world = world;
    this.setLayout(world ? homeMarina(world) : null);
  }

  setLayout(layout: MarinaLayout | null): void {
    this.layoutValue = layout;
    this.minX = Infinity;
    this.maxX = -Infinity;
    this.minZ = Infinity;
    this.maxZ = -Infinity;
    const boxes = layout ? layout.boxes.filter((box) => DECK_BOX_KINDS.has(box.kind)) : [];
    this.count = boxes.length;
    this.decks = new Float64Array(boxes.length * STRIDE);
    this.materials = new Int8Array(boxes.length);
    const n: Vec3 = { x: 0, y: 0, z: 0 };
    const ax: Vec3 = { x: 0, y: 0, z: 0 };
    const az: Vec3 = { x: 0, y: 0, z: 0 };
    boxes.forEach((box, index) => {
      const q = marinaBoxOrientation(layout!.frame, box);
      rotateVectorInto(n, q, { x: 0, y: 1, z: 0 });
      rotateVectorInto(ax, q, { x: 1, y: 0, z: 0 });
      rotateVectorInto(az, q, { x: 0, y: 0, z: 1 });
      const p = marinaToWorld(layout!.frame, box.right, box.out);
      const o = index * STRIDE;
      const d = this.decks;
      d[o + CX] = p.x + n.x * box.halfHeight;
      d[o + CY] = box.y + n.y * box.halfHeight;
      d[o + CZ] = p.z + n.z * box.halfHeight;
      d[o + NX] = n.x;
      d[o + NY] = n.y;
      d[o + NZ] = n.z;
      d[o + AX] = ax.x;
      d[o + AX + 1] = ax.y;
      d[o + AX + 2] = ax.z;
      d[o + AZ] = az.x;
      d[o + AZ + 1] = az.y;
      d[o + AZ + 2] = az.z;
      d[o + HALF_X] = box.halfRight;
      d[o + HALF_Z] = box.halfOut;
      this.materials[index] = box.kind === "quayWall" ? DeckMaterial.concrete : DeckMaterial.timber;
      for (const sx of [-1, 1]) {
        for (const sz of [-1, 1]) {
          const x = d[o + CX]! + sx * box.halfRight * ax.x + sz * box.halfOut * az.x;
          const z = d[o + CZ]! + sx * box.halfRight * ax.z + sz * box.halfOut * az.z;
          this.minX = Math.min(this.minX, x);
          this.maxX = Math.max(this.maxX, x);
          this.minZ = Math.min(this.minZ, z);
          this.maxZ = Math.max(this.maxZ, z);
        }
      }
    });
    this.setApron(layout);
  }

  /** The apron's front behind each quay wall, which lies along the marina's right axis. */
  private setApron(layout: MarinaLayout | null): void {
    const apron = this.apron;
    const walls = layout ? layout.boxes.filter((box) => box.kind === "quayWall") : [];
    apron.count = walls.length;
    apron.strips = new Float64Array(walls.length * STRIP_STRIDE);
    apron.minX = Infinity;
    apron.maxX = -Infinity;
    apron.minZ = Infinity;
    apron.maxZ = -Infinity;
    if (!layout) return;
    const frame = layout.frame;
    apron.height = layout.seaLevel + MARINA_LAYOUT.quayDeckHeight;
    apron.originX = frame.originX;
    apron.originZ = frame.originZ;
    apron.rightX = frame.rightX;
    apron.rightZ = frame.rightZ;
    apron.outX = frame.outX;
    apron.outZ = frame.outZ;
    const top = MARINA_EARTHWORKS.quayFrontOut;
    walls.forEach((wall, index) => {
      const o = index * STRIP_STRIDE;
      apron.strips[o + RIGHT_MIN] = wall.right - wall.halfRight;
      apron.strips[o + RIGHT_MAX] = wall.right + wall.halfRight;
      apron.strips[o + OUT_MIN] = top - APRON_FRONT_METERS;
      apron.strips[o + OUT_MAX] = top;
      for (const right of [wall.right - wall.halfRight, wall.right + wall.halfRight]) {
        for (const out of [top - APRON_FRONT_METERS, top]) {
          const p = marinaToWorld(frame, right, out);
          apron.minX = Math.min(apron.minX, p.x);
          apron.maxX = Math.max(apron.maxX, p.x);
          apron.minZ = Math.min(apron.minZ, p.z);
          apron.maxZ = Math.max(apron.maxZ, p.z);
        }
      }
    });
  }

  /** The ground under the decks, then the highest deck seen from `viewY`, which is the ground in its plan. */
  evaluate(at: GroundPoint): void {
    this.apron.evaluate(at);
    const x = at.x;
    const z = at.z;
    if (!(x >= this.minX && x <= this.maxX && z >= this.minZ && z <= this.maxZ)) return;
    const d = this.decks;
    let best = -1;
    let bestHeight = -Infinity;
    for (let o = 0; o < this.count * STRIDE; o += STRIDE) {
      const dx = x - d[o + CX]!;
      const dz = z - d[o + CZ]!;
      // The top plane's height over (x, z).
      const height = d[o + CY]! - (d[o + NX]! * dx + d[o + NZ]! * dz) / d[o + NY]!;
      if (!(height > bestHeight) || !(this.viewY > height)) continue;
      const dy = height - d[o + CY]!;
      const lx = dx * d[o + AX]! + dy * d[o + AX + 1]! + dz * d[o + AX + 2]!;
      const lz = dx * d[o + AZ]! + dy * d[o + AZ + 1]! + dz * d[o + AZ + 2]!;
      if (Math.abs(lx) > d[o + HALF_X]! || Math.abs(lz) > d[o + HALF_Z]!) continue;
      best = o;
      bestHeight = height;
    }
    if (best < 0) return;
    at.height = bestHeight;
    at.dhdx = -d[best + NX]! / d[best + NY]!;
    at.dhdz = -d[best + NZ]! / d[best + NY]!;
  }

  /**
   * The material of the deck a contact's ground `at` lies on (`DeckMaterial`),
   * or -1 where it is the ground under the decks.
   */
  materialAt(at: Readonly<GroundPoint>): number {
    const x = at.x;
    const z = at.z;
    if (!(x >= this.minX && x <= this.maxX && z >= this.minZ && z <= this.maxZ)) return -1;
    const d = this.decks;
    for (let index = 0; index < this.count; index += 1) {
      const o = index * STRIDE;
      const dx = x - d[o + CX]!;
      const dz = z - d[o + CZ]!;
      const height = d[o + CY]! - (d[o + NX]! * dx + d[o + NZ]! * dz) / d[o + NY]!;
      if (Math.abs(height - at.height) > SAME_FACE) continue;
      const dy = height - d[o + CY]!;
      const lx = dx * d[o + AX]! + dy * d[o + AX + 1]! + dz * d[o + AX + 2]!;
      const lz = dx * d[o + AZ]! + dy * d[o + AZ + 1]! + dz * d[o + AZ + 2]!;
      if (Math.abs(lx) > d[o + HALF_X]! || Math.abs(lz) > d[o + HALF_Z]!) continue;
      return this.materials[index]!;
    }
    return -1;
  }
}

/** A deck's surface for the tyre: the quay's concrete, or the pier's and gangway's timber. */
export function describeDeck(material: number, out: CarSurface): CarSurface {
  describeSurface(SurfaceMaterial.Concrete, 0, out);
  if (material === DeckMaterial.timber) {
    out.friction = TIMBER[0];
    out.rollingResistance = TIMBER[1];
    out.roughness = TIMBER[2];
  }
  return out;
}
