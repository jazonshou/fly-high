import type { SeaShelterEllipse } from "@/src/sim/water/types";
import type { MarinaSite } from "./marina";
import { mixSeed, unitFloatFromHash } from "./seed";
import type { WorldDefinition } from "./types";

/**
 * The home marina's layout kit: every part's place, built once from the site
 * and its seed. This is the airport pattern's one placement module (plan,
 * "Water infrastructure"): the meshes, the colliders, the vegetation
 * clearance, the earthworks and the start berth all read these records, so
 * no second copy can drift.
 *
 * MARINA-LOCAL FRAME. The origin is the site's waterline point. `out` runs
 * seaward along the site heading, `(sin h, cos h)`; `right` runs to the
 * starboard of someone facing the sea, `(-cos h, sin h)` (the sim's
 * starboard: forward x up, src/sim/types.ts). Heights are world Y.
 *
 *              open sea                    + out
 *        [breakwater, if exposed]            ^
 *    ||||  |||| ||||  ||||  ||||             |
 *    ====fuel====arm=================  mouth |
 *    ||||  ||||  |||| [pier] ||||            |
 *                     [pier]                 |
 *    slip ========== quay ==========         +------> right
 *     shed  car park   hut
 */

export const MARINA_LAYOUT = Object.freeze({
  /** Quay face along the waterline, |right| <= this. */
  quayHalfLength: 30,
  /** Quay deck and apron, metres above still water. */
  quayDeckHeight: 1.5,
  /** Apron depth behind the quay face. */
  apronDepth: 16,
  /** Fixed pier on piles. */
  pierWidth: 3,
  pierDeckHeight: 1.4,
  pierMinLength: 24,
  /** The pier ends this far past the first berth-depth water. */
  pierPastBerthWater: 2,
  pierPileSpacing: 4,
  pileRadius: 0.17,
  /** Pontoon guide piles stand this high above still water. */
  guidePileTop: 3,
  /** The gangway from the pier head down to the pontoon arm. */
  gangwayLength: 8,
  gangwayWidth: 1.2,
  /** Floating pontoon modules. */
  pontoonWidth: 2.4,
  pontoonModuleLength: 12,
  pontoonFreeboard: 0.5,
  pontoonDraft: 0.6,
  armModulesMin: 4,
  armModulesMax: 6,
  /** Finger berths off both sides of the arm. */
  fingerLength: 10,
  fingerWidth: 0.8,
  berthPitch: 4.5,
  /** The berth's design boat: the Runabout 21 and its gap to the arm. */
  boatLength: 6.55,
  boatBeam: 2.59,
  sternGap: 1,
  /** Moored runabouts: this share of the free berths, at most this many. */
  mooredShare: 0.45,
  mooredMax: 10,
  /** Slipway: 1:8, 6 m wide, toe 1.5 m below still water, top at the apron. */
  slipwayHalfWidth: 3,
  slipwayGrade: 1 / 8,
  slipwayToeDepth: 1.5,
  /** Its centre sits this far past the quay's end. */
  slipwayOffset: 6,
  /** The car park behind the apron. */
  carParkDepth: 34,
  carParkHalfWidth: 20,
  carParkMaxGrade: 0.06,
  /** Buildings. */
  hut: Object.freeze({ halfRight: 3, halfOut: 2, height: 3.2 }),
  shed: Object.freeze({ halfRight: 9, halfOut: 6, height: 6.5 }),
  /** The dredged basin keeps at least this much water everywhere inside it. */
  basinDepth: 3,
  basinMargin: 8,
  /** A breakwater is built only at this exposure or more (MarinaSite.exposure). */
  breakwaterExposure: 0.45,
  breakwaterCrestHeight: 2,
  breakwaterCrestHalfWidth: 2.5,
  breakwaterSideSlope: 1.5,
  /** The mound's crest line lies this far past the finger tips ... */
  breakwaterFairway: 24,
  /** ... and the fairway's centreline this far. */
  fairwayCentre: 7,
  /** The basin mouth's centre lies this far past the arm's mouth end ... */
  breakwaterMouthOffset: 12,
  /** ... and the breakwater's head this far short of it. */
  breakwaterLaneClearance: 22,
  /** Lamps. */
  pierLampSpacing: 12,
  quayLampSpacing: 15,
  armLampSpacing: 12,
  lampPostHeight: 4,
  bollardLightHeight: 1,
  /** Entrance beacons: one flash every this many seconds, red and green. */
  beaconPeriodSeconds: 4,
  beaconFlashSeconds: 0.5,
  beaconHeight: 4,
  /** Calm basin: displacement floor inside the ellipse, and the feather outside it. */
  shelterFloor: 0.12,
  shelterFeather: 60,
  /** The lane from the start berth reaches water this deep. */
  laneOpenWaterDepth: 4,
  laneMaxLength: 1_500,
});

export interface MarinaFrame {
  readonly originX: number;
  readonly originZ: number;
  readonly headingRadians: number;
  /** World components of `out` and `right`. */
  readonly outX: number;
  readonly outZ: number;
  readonly rightX: number;
  readonly rightZ: number;
}

export function createMarinaFrame(site: Pick<MarinaSite, "x" | "z" | "headingRadians">): MarinaFrame {
  const outX = Math.sin(site.headingRadians);
  const outZ = Math.cos(site.headingRadians);
  return Object.freeze({
    originX: site.x,
    originZ: site.z,
    headingRadians: site.headingRadians,
    outX,
    outZ,
    rightX: -outZ,
    rightZ: outX,
  });
}

export interface MarinaPoint {
  x: number;
  z: number;
}

export function marinaToWorld(frame: MarinaFrame, right: number, out: number, target: MarinaPoint = { x: 0, z: 0 }): MarinaPoint {
  target.x = frame.originX + frame.rightX * right + frame.outX * out;
  target.z = frame.originZ + frame.rightZ * right + frame.outZ * out;
  return target;
}

export function worldToMarina(frame: MarinaFrame, x: number, z: number): { right: number; out: number } {
  const dx = x - frame.originX;
  const dz = z - frame.originZ;
  return { right: dx * frame.rightX + dz * frame.rightZ, out: dx * frame.outX + dz * frame.outZ };
}

/** A world heading for a marina-local direction (`right`, `out`). */
export function marinaHeading(frame: MarinaFrame, right: number, out: number): number {
  return Math.atan2(frame.rightX * right + frame.outX * out, frame.rightZ * right + frame.outZ * out);
}

/**
 * An oriented box. Centre in marina-local metres and world Y; half extents
 * along `right`, `out` and up; `yaw` turns it within the marina frame
 * (positive from `out` toward `right`).
 */
export interface MarinaBox {
  readonly kind: MarinaBoxKind;
  readonly right: number;
  readonly out: number;
  readonly y: number;
  readonly halfRight: number;
  readonly halfOut: number;
  readonly halfHeight: number;
  readonly yaw: number;
}

export type MarinaBoxKind =
  | "quayWall"
  | "pierDeck"
  | "gangway"
  | "pontoon"
  | "finger"
  | "fuelPump"
  | "hut"
  | "hutRoof"
  | "shed"
  | "shedRoof"
  | "lifeRingStand";

/** Parts that float: pontoon modules and fingers ride the calmed sea. */
export const FLOATING_BOX_KINDS: ReadonlySet<MarinaBoxKind> = new Set(["pontoon", "finger"]);

/** A vertical cylinder: piles, posts, bollards, fenders. */
export interface MarinaPost {
  readonly kind: MarinaPostKind;
  readonly right: number;
  readonly out: number;
  readonly bottomY: number;
  readonly topY: number;
  readonly radius: number;
  /** Floating posts (fenders, pontoon bollards) move with their pontoon. */
  readonly floating: boolean;
}

export type MarinaPostKind = "pile" | "guidePile" | "lampPost" | "bollardLight" | "cleat" | "fender" | "beaconPost";

export interface MarinaLamp {
  readonly kind: "pier" | "quay" | "carPark" | "pontoon";
  readonly right: number;
  readonly out: number;
  /** World Y of the lamp head. */
  readonly y: number;
  readonly floating: boolean;
}

export interface MarinaBeacon {
  readonly color: "red" | "green";
  readonly right: number;
  readonly out: number;
  readonly y: number;
  readonly periodSeconds: number;
  readonly flashSeconds: number;
  /** Seconds into the period at which the flash starts. */
  readonly phaseSeconds: number;
}

/** Where a mooring line is made fast on the dock: marina-local, world Y at rest. */
export interface MarinaCleat {
  readonly right: number;
  readonly out: number;
  readonly y: number;
  readonly floating: boolean;
}

export interface MarinaBerth {
  readonly index: number;
  readonly side: "seaward" | "landward" | "fuel";
  /** The moored boat's centre, marina-local, and its bow's world heading. */
  readonly right: number;
  readonly out: number;
  readonly bowHeadingRadians: number;
  /** Clear length and width between the fingers. */
  readonly length: number;
  readonly width: number;
  /** Dock cleats, stern pair first (on the arm), then the bow pair (finger ends). */
  readonly cleats: readonly MarinaCleat[];
  readonly occupied: boolean;
  readonly start: boolean;
}

export interface MarinaBreakwater {
  /** Crest centreline ends, marina-local. */
  readonly rightA: number;
  readonly rightB: number;
  readonly out: number;
  readonly crestY: number;
  readonly crestHalfWidth: number;
  readonly sideSlope: number;
}

export interface MarinaSlipway {
  readonly right: number;
  readonly outTop: number;
  readonly outToe: number;
  readonly halfWidth: number;
  readonly topY: number;
  readonly toeY: number;
}

/** An axis-aligned marina-local rectangle. */
export interface MarinaRect {
  readonly rightMin: number;
  readonly rightMax: number;
  readonly outMin: number;
  readonly outMax: number;
}

export interface MarinaAnchor {
  readonly name: "marinaCarPark";
  readonly x: number;
  readonly z: number;
  /** World heading pointing inland, the way a road leaves the car park. */
  readonly headingRadians: number;
  readonly y: number;
}

export interface MarinaLayout {
  readonly site: MarinaSite;
  readonly frame: MarinaFrame;
  readonly seaLevel: number;
  readonly pier: { readonly right: number; readonly length: number };
  /** Arm centreline: `out`, and its `right` span (fuel module included). */
  readonly arm: { readonly out: number; readonly rightMin: number; readonly rightMax: number };
  /** +1 when the basin mouth is at the arm's +right end, -1 at its -right end. */
  readonly mouthSide: 1 | -1;
  readonly apron: MarinaRect;
  readonly carPark: MarinaRect & { readonly frontY: number; readonly backY: number };
  readonly basin: MarinaRect;
  readonly slipway: MarinaSlipway;
  readonly breakwater: MarinaBreakwater | null;
  readonly boxes: readonly MarinaBox[];
  readonly posts: readonly MarinaPost[];
  readonly lamps: readonly MarinaLamp[];
  readonly beacons: readonly MarinaBeacon[];
  readonly berths: readonly MarinaBerth[];
  readonly startBerth: MarinaBerth;
  /**
   * The start lane in world metres: the start berth, out past the finger tips
   * (along the fairway and through the mouth when there is a breakwater), to
   * water `laneOpenWaterDepth` deep.
   */
  readonly lane: readonly MarinaPoint[];
  readonly shelter: SeaShelterEllipse;
  readonly carParkAnchor: MarinaAnchor;
}

/** A stable per-marina hash for the layout's seeded choices. */
function marinaSeedHash(world: WorldDefinition, site: MarinaSite): number {
  return mixSeed(mixSeed(world.seedHash, 7_001), Math.round(site.x) ^ Math.imul(Math.round(site.z), 0x45d9f3b));
}

/** A seeded unit float for the layout's `index`th choice. */
function marinaChoice(seedHash: number, index: number): number {
  return unitFloatFromHash(mixSeed(seedHash, index));
}

/** The calm-basin ellipse over a rectangle. */
function shelterEllipse(frame: MarinaFrame, rect: MarinaRect): SeaShelterEllipse {
  const centreRight = (rect.rightMin + rect.rightMax) * 0.5;
  const centreOut = (rect.outMin + rect.outMax) * 0.5;
  const centre = marinaToWorld(frame, centreRight, centreOut);
  const halfRight = (rect.rightMax - rect.rightMin) * 0.5;
  const halfOut = (rect.outMax - rect.outMin) * 0.5;
  // An ellipse with radii sqrt(2) x the half extents passes through the
  // rectangle's corners, so the whole rectangle is at the floor.
  const alongRight = halfRight >= halfOut;
  return Object.freeze({
    centerX: centre.x,
    centerZ: centre.z,
    heading: alongRight ? marinaHeading(frame, 1, 0) : frame.headingRadians,
    radiusAlong: Math.SQRT2 * Math.max(halfRight, halfOut),
    radiusAcross: Math.SQRT2 * Math.min(halfRight, halfOut),
    floor: MARINA_LAYOUT.shelterFloor,
    feather: MARINA_LAYOUT.shelterFeather,
  });
}

/** Builds the layout. Pure; `homeMarina` memoises it. */
export function buildMarinaLayout(
  world: WorldDefinition,
  site: MarinaSite,
  groundBeforeEarthworks: (x: number, z: number) => number,
): MarinaLayout {
  const L = MARINA_LAYOUT;
  const frame = createMarinaFrame(site);
  const seed = marinaSeedHash(world, site);
  const sea = world.seaLevel;
  const ground = (right: number, out: number) => {
    const point = marinaToWorld(frame, right, out);
    return groundBeforeEarthworks(point.x, point.z);
  };

  // Seeded choices: arm length, where the pier joins it, which end the mouth
  // is at, which side the slipway is on.
  const modules = L.armModulesMin + Math.floor(marinaChoice(seed, 1) * (L.armModulesMax - L.armModulesMin + 1));
  const pierRight = Math.round((marinaChoice(seed, 2) * 2 - 1) * 8);
  const joinModule = 1 + Math.floor(marinaChoice(seed, 3) * (modules - 1));
  const mouthSide: 1 | -1 = marinaChoice(seed, 4) < 0.5 ? 1 : -1;
  const slipSide: 1 | -1 = marinaChoice(seed, 5) < 0.5 ? 1 : -1;

  const pierLength = Math.max(L.pierMinLength, site.berthDistanceMeters + L.pierPastBerthWater);
  const halfPontoon = L.pontoonWidth * 0.5;
  const armOut = pierLength + L.gangwayLength + halfPontoon;
  const fingerArmRightMin = pierRight - joinModule * L.pontoonModuleLength;
  const fingerArmRightMax = fingerArmRightMin + modules * L.pontoonModuleLength;
  // The fuel module extends the arm at the end away from the mouth.
  const armRightMin = mouthSide > 0 ? fingerArmRightMin - L.pontoonModuleLength : fingerArmRightMin;
  const armRightMax = mouthSide > 0 ? fingerArmRightMax : fingerArmRightMax + L.pontoonModuleLength;

  const pontoonY = sea + L.pontoonFreeboard;
  const pontoonHalfHeight = (L.pontoonFreeboard + L.pontoonDraft) * 0.5;
  const pontoonCentreY = sea + (L.pontoonFreeboard - L.pontoonDraft) * 0.5;
  const pierY = sea + L.pierDeckHeight;
  const quayY = sea + L.quayDeckHeight;
  const bedY = sea - L.basinDepth - 2;

  const boxes: MarinaBox[] = [];
  const posts: MarinaPost[] = [];
  const lamps: MarinaLamp[] = [];
  const box = (kind: MarinaBoxKind, right: number, out: number, y: number, halfRight: number, halfOut: number, halfHeight: number, yaw = 0) => {
    boxes.push(Object.freeze({ kind, right, out, y, halfRight, halfOut, halfHeight, yaw }));
  };
  const post = (kind: MarinaPostKind, right: number, out: number, bottomY: number, topY: number, radius: number, floating = false) => {
    posts.push(Object.freeze({ kind, right, out, bottomY, topY, radius, floating }));
  };

  // Quay wall: its face on the waterline, its top the apron.
  box("quayWall", 0, -0.3, (quayY + bedY) * 0.5, L.quayHalfLength, 0.3, (quayY - bedY) * 0.5);

  // Pier: deck and pile pairs.
  box("pierDeck", pierRight, pierLength * 0.5, pierY - 0.15, L.pierWidth * 0.5, pierLength * 0.5, 0.15);
  const pileAcross = L.pierWidth * 0.5 - 0.15;
  for (let out = L.pierPileSpacing; out <= pierLength + 1e-6; out += L.pierPileSpacing) {
    for (const side of [-1, 1]) post("pile", pierRight + side * pileAcross, out, bedY, pierY + 0.6, L.pileRadius);
  }
  // Gangway, sloping from the pier head to the pontoon deck.
  const gangwayDrop = pierY - pontoonY;
  box(
    "gangway", pierRight, pierLength + L.gangwayLength * 0.5, (pierY + pontoonY) * 0.5 - 0.05,
    L.gangwayWidth * 0.5, Math.hypot(L.gangwayLength, gangwayDrop) * 0.5, 0.05,
  );

  // Arm modules (the fuel module included) and their guide piles.
  for (let index = 0; armRightMin + index * L.pontoonModuleLength < armRightMax - 1e-6; index += 1) {
    const centre = armRightMin + (index + 0.5) * L.pontoonModuleLength;
    box("pontoon", centre, armOut, pontoonCentreY, L.pontoonModuleLength * 0.5, halfPontoon, pontoonHalfHeight);
    const pileSide = index % 2 === 0 ? 1 : -1;
    post("guidePile", centre, armOut + pileSide * (halfPontoon + 0.35), bedY, sea + L.guidePileTop, L.pileRadius + 0.05);
  }
  const fuelRight = mouthSide > 0 ? armRightMin + L.pontoonModuleLength * 0.5 : armRightMax - L.pontoonModuleLength * 0.5;
  box("fuelPump", fuelRight, armOut, pontoonY + 0.7, 0.35, 0.3, 0.7);

  // Fingers every berth pitch, both sides; berths between them.
  const fingerCount = Math.floor((fingerArmRightMax - fingerArmRightMin) / L.berthPitch) + 1;
  const fingerSpan = (fingerCount - 1) * L.berthPitch;
  const firstFinger = (fingerArmRightMin + fingerArmRightMax - fingerSpan) * 0.5;
  const fingerOut = halfPontoon + L.fingerLength * 0.5;
  const pierClear = L.pierWidth * 0.5 + 1;
  const berths: MarinaBerth[] = [];
  const berthInner = halfPontoon + L.sternGap + L.boatLength * 0.5;
  for (const side of ["seaward", "landward"] as const) {
    const sign = side === "seaward" ? 1 : -1;
    for (let index = 0; index < fingerCount; index += 1) {
      const right = firstFinger + index * L.berthPitch;
      // No landward finger where the gangway comes down.
      if (sign < 0 && Math.abs(right - pierRight) < pierClear + L.fingerWidth * 0.5) continue;
      box("finger", right, armOut + sign * fingerOut, pontoonCentreY, L.fingerWidth * 0.5, L.fingerLength * 0.5, pontoonHalfHeight);
      // A guide pile at every other finger tip.
      if (index % 2 === 0) {
        post("guidePile", right, armOut + sign * (halfPontoon + L.fingerLength + 0.4), bedY, sea + L.guidePileTop, L.pileRadius + 0.05);
      }
    }
    for (let index = 0; index + 1 < fingerCount; index += 1) {
      const right = firstFinger + (index + 0.5) * L.berthPitch;
      if (sign < 0 && Math.abs(right - pierRight) < pierClear + L.berthPitch * 0.5) continue;
      const out = armOut + sign * berthInner;
      const cleatY = pontoonY + 0.1;
      const halfGap = L.berthPitch * 0.5 - L.fingerWidth * 0.5;
      const cleats: MarinaCleat[] = [
        { right: right - 1.1, out: armOut + sign * halfPontoon, y: cleatY, floating: true },
        { right: right + 1.1, out: armOut + sign * halfPontoon, y: cleatY, floating: true },
        { right: right - L.berthPitch * 0.5, out: armOut + sign * (halfPontoon + L.fingerLength - 0.6), y: cleatY, floating: true },
        { right: right + L.berthPitch * 0.5, out: armOut + sign * (halfPontoon + L.fingerLength - 0.6), y: cleatY, floating: true },
      ];
      berths.push({
        index: berths.length,
        side,
        right,
        out,
        // Seaward berths lie bow out, landward ones bow in to the shore.
        bowHeadingRadians: sign > 0 ? frame.headingRadians : marinaHeading(frame, 0, -1),
        length: L.fingerLength + L.sternGap,
        width: 2 * halfGap,
        cleats: Object.freeze(cleats.map((cleat) => Object.freeze(cleat))),
        occupied: false,
        start: false,
      } as MarinaBerth);
    }
  }
  // The fuel berth: alongside the fuel module's seaward face.
  berths.push({
    index: berths.length,
    side: "fuel",
    right: fuelRight,
    out: armOut + halfPontoon + 0.4 + L.boatBeam * 0.5,
    bowHeadingRadians: marinaHeading(frame, mouthSide, 0),
    length: L.pontoonModuleLength,
    width: L.boatBeam + 1,
    cleats: Object.freeze([
      Object.freeze({ right: fuelRight - 4, out: armOut + halfPontoon, y: pontoonY + 0.1, floating: true }),
      Object.freeze({ right: fuelRight + 4, out: armOut + halfPontoon, y: pontoonY + 0.1, floating: true }),
    ]),
    occupied: false,
    start: false,
  } as MarinaBerth);

  // The start berth: the outermost (seaward) berth nearest the mouth.
  const seaward = berths.filter((berth) => berth.side === "seaward");
  const startIndex = seaward.reduce((best, berth) => (berth.right * mouthSide > best.right * mouthSide ? berth : best)).index;
  // Moored runabouts in a seeded share of the other berths, never next to the start.
  const startRight = berths[startIndex]!.right;
  let moored = 0;
  for (const berth of berths) {
    const mutable = berth as { occupied: boolean; start: boolean };
    if (berth.index === startIndex) {
      mutable.start = true;
      continue;
    }
    if (berth.side === "fuel") continue;
    if (berth.side === "seaward" && Math.abs(berth.right - startRight) < L.berthPitch * 1.5) continue;
    if (moored >= L.mooredMax) continue;
    if (marinaChoice(seed, 100 + berth.index) < L.mooredShare) {
      mutable.occupied = true;
      moored += 1;
    }
  }
  const frozenBerths = berths.map((berth) => Object.freeze(berth));

  // Cleats and fenders on the fingers of occupied and start berths.
  for (const berth of frozenBerths) {
    for (const cleat of berth.cleats) post("cleat", cleat.right, cleat.out, cleat.y - 0.1, cleat.y + 0.12, 0.08, true);
  }

  // Slipway beside the quay, top at the apron.
  const slipRight = slipSide * (L.quayHalfLength + L.slipwayOffset);
  const slipway: MarinaSlipway = Object.freeze({
    right: slipRight,
    outTop: -L.quayDeckHeight / L.slipwayGrade,
    outToe: L.slipwayToeDepth / L.slipwayGrade,
    halfWidth: L.slipwayHalfWidth,
    topY: quayY,
    toeY: sea - L.slipwayToeDepth,
  });

  // Apron spans the quay and the slipway's head.
  const apronRightLow = Math.min(-L.quayHalfLength, slipRight - L.slipwayHalfWidth - 2);
  const apronRightHigh = Math.max(L.quayHalfLength, slipRight + L.slipwayHalfWidth + 2);
  const apron: MarinaRect = Object.freeze({
    rightMin: apronRightLow,
    rightMax: apronRightHigh,
    outMin: -L.apronDepth,
    outMax: 0,
  });

  // Car park behind the apron, away from the slipway; the shed beside the slip.
  const carParkCentre = -slipSide * (L.quayHalfLength - L.carParkHalfWidth);
  const carParkBackOut = -L.apronDepth - L.carParkDepth;
  const backGround = ground(carParkCentre, carParkBackOut) - sea;
  const maxRise = L.carParkMaxGrade * L.carParkDepth;
  const backY = sea + Math.min(L.quayDeckHeight + maxRise, Math.max(L.quayDeckHeight, backGround));
  const carPark = Object.freeze({
    rightMin: carParkCentre - L.carParkHalfWidth,
    rightMax: carParkCentre + L.carParkHalfWidth,
    outMin: carParkBackOut,
    outMax: -L.apronDepth,
    frontY: quayY,
    backY,
  });
  const carParkY = (out: number) => quayY + (backY - quayY) * ((-L.apronDepth - out) / L.carParkDepth);

  const shedRight = slipSide * (L.quayHalfLength - L.shed.halfRight - 1);
  const shedOut = -L.apronDepth - L.shed.halfOut - 1;
  const shedBase = carParkY(shedOut);
  box("shed", shedRight, shedOut, shedBase + L.shed.height * 0.5, L.shed.halfRight, L.shed.halfOut, L.shed.height * 0.5);
  box("shedRoof", shedRight, shedOut, shedBase + L.shed.height + 0.9, L.shed.halfRight + 0.4, L.shed.halfOut + 0.5, 0.9);
  const hutRight = pierRight - slipSide * (L.pierWidth * 0.5 + L.hut.halfRight + 3);
  const hutOut = -L.hut.halfOut - 3;
  box("hut", hutRight, hutOut, quayY + L.hut.height * 0.5, L.hut.halfRight, L.hut.halfOut, L.hut.height * 0.5);
  box("hutRoof", hutRight, hutOut, quayY + L.hut.height + 0.5, L.hut.halfRight + 0.3, L.hut.halfOut + 0.3, 0.5);

  // Life rings: pier root and head, both quay ends, both arm ends.
  for (const [right, out, y] of [
    [pierRight + L.pierWidth * 0.5 + 0.4, 1.5, quayY],
    [pierRight - L.pierWidth * 0.5 - 0.4, pierLength - 1, pierY],
    [-L.quayHalfLength + 2, -1.2, quayY],
    [L.quayHalfLength - 2, -1.2, quayY],
    [armRightMin + 1, armOut, pontoonY],
    [armRightMax - 1, armOut, pontoonY],
  ] as const) {
    box("lifeRingStand", right, out, y + 0.6, 0.05, 0.05, 0.6);
  }

  // Lamps.
  for (let out = L.pierLampSpacing * 0.5, index = 0; out < pierLength; out += L.pierLampSpacing, index += 1) {
    const right = pierRight + (index % 2 === 0 ? 1 : -1) * (L.pierWidth * 0.5 - 0.1);
    post("lampPost", right, out, pierY, pierY + L.lampPostHeight, 0.06);
    lamps.push({ kind: "pier", right, out, y: pierY + L.lampPostHeight, floating: false });
  }
  for (let right = apron.rightMin + 4; right <= apron.rightMax - 4 + 1e-6; right += L.quayLampSpacing) {
    post("lampPost", right, -1.2, quayY, quayY + L.lampPostHeight, 0.06);
    lamps.push({ kind: "quay", right, out: -1.2, y: quayY + L.lampPostHeight, floating: false });
  }
  for (const right of [carPark.rightMin + 1, carPark.rightMax - 1]) {
    for (const out of [carPark.outMin + 1, carPark.outMax - 1]) {
      const y = carParkY(out);
      post("lampPost", right, out, y, y + L.lampPostHeight + 2, 0.08);
      lamps.push({ kind: "carPark", right, out, y: y + L.lampPostHeight + 2, floating: false });
    }
  }
  for (let right = armRightMin + L.armLampSpacing * 0.5; right < armRightMax; right += L.armLampSpacing) {
    post("bollardLight", right, armOut, pontoonY, pontoonY + L.bollardLightHeight, 0.1, true);
    lamps.push({ kind: "pontoon", right, out: armOut, y: pontoonY + L.bollardLightHeight, floating: true });
  }

  // Breakwater where the site is exposed: detached, parallel to the shore
  // and covering the whole arm, with the basin mouth past the arm's mouth end.
  // A fairway runs between the finger tips and the mound's toe.
  const berthOutMax = armOut + halfPontoon + L.fingerLength;
  const exposed = site.exposure >= L.breakwaterExposure;
  const mouthRight = mouthSide > 0 ? armRightMax + L.breakwaterMouthOffset : armRightMin - L.breakwaterMouthOffset;
  let breakwater: MarinaBreakwater | null = null;
  if (exposed) {
    const head = mouthRight - mouthSide * L.breakwaterLaneClearance;
    const tail = (mouthSide > 0 ? armRightMin : armRightMax) - mouthSide * 20;
    breakwater = Object.freeze({
      rightA: Math.min(head, tail),
      rightB: Math.max(head, tail),
      out: berthOutMax + L.breakwaterFairway,
      crestY: sea + L.breakwaterCrestHeight,
      crestHalfWidth: L.breakwaterCrestHalfWidth,
      sideSlope: L.breakwaterSideSlope,
    });
  }

  // Basin: the berth zone, the fairway and the mouth, dredged to depth.
  const basin: MarinaRect = Object.freeze({
    rightMin: Math.min(armRightMin, -L.quayHalfLength, exposed ? mouthRight : Infinity) - L.basinMargin,
    rightMax: Math.max(armRightMax, L.quayHalfLength, exposed ? mouthRight : -Infinity) + L.basinMargin,
    outMin: 0,
    outMax: breakwater ? breakwater.out : berthOutMax + L.basinMargin,
  });

  // Entrance beacons: IALA A, red to port entering (heading -out, so port is +right).
  const beacons: MarinaBeacon[] = [];
  const beaconPair = (rightA: number, rightB: number, out: number) => {
    const low = Math.min(rightA, rightB);
    const high = Math.max(rightA, rightB);
    for (const [right, color, phase] of [[low, "green", 0], [high, "red", L.beaconPeriodSeconds * 0.5]] as const) {
      post("beaconPost", right, out, bedY, sea + L.beaconHeight, 0.25);
      beacons.push(Object.freeze({
        color,
        right,
        out,
        y: sea + L.beaconHeight + 0.3,
        periodSeconds: L.beaconPeriodSeconds,
        flashSeconds: L.beaconFlashSeconds,
        phaseSeconds: phase,
      }));
    }
  };
  if (breakwater) {
    beaconPair(mouthRight - mouthSide * L.breakwaterLaneClearance, mouthRight + mouthSide * L.breakwaterLaneClearance, breakwater.out);
  } else {
    beaconPair(basin.rightMin + 2, basin.rightMax - 2, basin.outMax);
  }

  // The start lane: out of the start berth, along the fairway and through the
  // mouth when there is a breakwater, then straight out to open water.
  const start = frozenBerths[startIndex]!;
  const lane: MarinaPoint[] = [marinaToWorld(frame, start.right, start.out)];
  const laneRight = breakwater ? mouthRight : start.right;
  if (breakwater) {
    const fairwayOut = berthOutMax + L.fairwayCentre;
    lane.push(marinaToWorld(frame, start.right, fairwayOut), marinaToWorld(frame, mouthRight, fairwayOut));
  }
  const laneStart = breakwater ? breakwater.out + 30 : basin.outMax;
  let laneEnd = laneStart;
  for (let out = laneStart; out <= laneStart + L.laneMaxLength; out += 10) {
    laneEnd = out;
    if (sea - ground(laneRight, out) >= L.laneOpenWaterDepth) break;
  }
  lane.push(marinaToWorld(frame, laneRight, laneEnd));

  const shelterRect: MarinaRect = {
    rightMin: Math.min(basin.rightMin, slipRight - L.slipwayHalfWidth),
    rightMax: Math.max(basin.rightMax, slipRight + L.slipwayHalfWidth),
    outMin: 0,
    outMax: basin.outMax,
  };
  const anchorPoint = marinaToWorld(frame, carParkCentre, carParkBackOut);

  return Object.freeze({
    site,
    frame,
    seaLevel: sea,
    pier: Object.freeze({ right: pierRight, length: pierLength }),
    arm: Object.freeze({ out: armOut, rightMin: armRightMin, rightMax: armRightMax }),
    mouthSide,
    apron,
    carPark,
    basin,
    slipway,
    breakwater,
    boxes: Object.freeze(boxes),
    posts: Object.freeze(posts),
    lamps: Object.freeze(lamps.map((lamp) => Object.freeze(lamp))),
    beacons: Object.freeze(beacons),
    berths: Object.freeze(frozenBerths),
    startBerth: start,
    lane: Object.freeze(lane.map((point) => Object.freeze(point))),
    shelter: shelterEllipse(frame, shelterRect),
    carParkAnchor: Object.freeze({
      name: "marinaCarPark",
      x: anchorPoint.x,
      z: anchorPoint.z,
      headingRadians: marinaHeading(frame, 0, -1),
      y: backY,
    }),
  });
}
