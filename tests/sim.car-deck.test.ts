import { describe, expect, it } from "vitest";
import { createColliderContact, type ColliderWorld } from "../src/sim/colliders";
import { GroundVehicleSimulator } from "../src/sim/ground";
import { CarColliders } from "../src/sim/ground/carColliders";
import { APRON_FRONT_METERS, DECK_BOX_KINDS, DeckGround } from "../src/sim/ground/deckGround";
import { createGroundPoint, TerrainLatticeCache, type GroundField } from "../src/sim/ground/terrainPatch";
import { rotateVectorInto } from "../src/sim/math";
import { sampleGroundHeight } from "../src/sim/terrainGrid";
import type { Vec3 } from "../src/sim/types";
import { CalmWaterSurface } from "../src/sim/water/calmWater";
import { homeMarina } from "../src/world/marina";
import { MARINA_EARTHWORKS } from "../src/world/marinaEarthworks";
import {
  MARINA_LAYOUT,
  marinaBoxOrientation,
  marinaHeading,
  marinaToWorld,
  worldToMarina,
  type MarinaBox,
} from "../src/world/marinaLayout";
import { createWorld } from "../src/world/world";
import { controls, headingOf, speedOf, STEP } from "./support/carRig";

/**
 * The car on the home marina's decks (land plan, "What it rolls on"): the
 * tyres roll on the pier deck, the gangway and the quay wall's coping, the
 * top faces of the boxes the hull collides with. The ground under them is
 * the dredged bed and the quay cut behind the face, so without the decks a
 * tyre falls through the pier and into the cut.
 */

const WORLD = createWorld();
const LAYOUT = homeMarina(WORLD);
const SEA = WORLD.seaLevel;
const PIER_TOP = SEA + MARINA_LAYOUT.pierDeckHeight;
const COPING_TOP = SEA + MARINA_LAYOUT.quayDeckHeight + MARINA_LAYOUT.quayCopingHeight;
const QUAY_TOP = SEA + MARINA_LAYOUT.quayDeckHeight;
const PIER_RIGHT = LAYOUT.pier.right;
const PIER_LENGTH = LAYOUT.pier.length;
const OUT_HEADING = marinaHeading(LAYOUT.frame, 0, 1);

const bare = (x: number, z: number): number => sampleGroundHeight(WORLD, x, z);
const BARE: GroundField = {
  evaluate(at) {
    at.height = bare(at.x, at.z);
    at.dhdx = 0;
    at.dhdz = 0;
  },
};
const COLLIDERS = new CarColliders(WORLD, bare);

/** A point of a marina box in the world, from box-local metres (x along -right, y up, z along out). */
function boxPoint(box: MarinaBox, x: number, y: number, z: number): Vec3 {
  const local = rotateVectorInto({ x: 0, y: 0, z: 0 }, marinaBoxOrientation(LAYOUT.frame, box), { x, y, z });
  const p = marinaToWorld(LAYOUT.frame, box.right, box.out);
  return { x: p.x + local.x, y: box.y + local.y, z: p.z + local.z };
}

const contact = createColliderContact();
function touches(colliders: ColliderWorld, point: Readonly<Vec3>, radius: number): boolean {
  return colliders.deepestSphereContact(point, radius, contact) && contact.penetration > 0;
}

describe("the marina's decks as the tyres' ground", () => {
  const decks = new DeckGround(BARE);
  decks.setWorld(WORLD);
  const at = createGroundPoint();
  const deckBoxes = LAYOUT.boxes.filter((box) => DECK_BOX_KINDS.has(box.kind));

  it("are the top faces of the boxes the hull collides with", () => {
    expect(decks.layout).toBe(LAYOUT);
    expect(deckBoxes.map((box) => box.kind).sort()).toEqual(["gangway", "pierDeck", "quayWall"]);
    expect(decks.deckCount).toBe(deckBoxes.length);
    decks.viewY = Infinity;
    for (const box of deckBoxes) {
      for (const across of [-0.5, 0, 0.5]) {
        for (const along of [-0.8, -0.3, 0.2, 0.7]) {
          const top = boxPoint(box, across * box.halfRight, box.halfHeight, along * box.halfOut);
          at.x = top.x;
          at.z = top.z;
          decks.evaluate(at);
          expect(at.height, `${box.kind} ${across} ${along}`).toBeCloseTo(top.y, 9);
          // The collider's own top: a 5 cm ball 4 cm off it is in it by 1 cm, 6 cm off it is clear.
          const near = boxPoint(box, across * box.halfRight, box.halfHeight + 0.04, along * box.halfOut);
          expect(touches(COLLIDERS.colliders, near, 0.05)).toBe(true);
          expect(contact.penetration).toBeCloseTo(0.01, 9);
          expect(contact.normal.y).toBeCloseTo(Math.cos(box.pitch), 9);
          expect(touches(COLLIDERS.colliders, boxPoint(box, across * box.halfRight, box.halfHeight + 0.06, along * box.halfOut), 0.05)).toBe(false);
        }
      }
      // A hand past either side, the terrain.
      for (const side of [-1, 1]) {
        const past = boxPoint(box, side * (box.halfRight + 0.1), box.halfHeight, 0);
        at.x = past.x;
        at.z = past.z;
        decks.evaluate(at);
        expect(at.height).toBe(bare(past.x, past.z));
      }
    }
    // The gangway's slope is its own, down from the pier head to the pontoons.
    const gangway = deckBoxes.find((box) => box.kind === "gangway")!;
    const upper = boxPoint(gangway, 0, gangway.halfHeight, -0.5 * gangway.halfOut);
    at.x = upper.x;
    at.z = upper.z;
    decks.evaluate(at);
    const outward = marinaToWorld(LAYOUT.frame, 0, 1);
    const origin = marinaToWorld(LAYOUT.frame, 0, 0);
    const fall = -(at.dhdx * (outward.x - origin.x) + at.dhdz * (outward.z - origin.z));
    expect(fall).toBeCloseTo(Math.tan(gangway.pitch), 9);
  });

  it("are ground only from above: not to a wheel under the pier or in the basin by the quay", () => {
    const pier = marinaToWorld(LAYOUT.frame, PIER_RIGHT, PIER_LENGTH * 0.5);
    at.x = pier.x;
    at.z = pier.z;
    decks.viewY = Infinity;
    decks.evaluate(at);
    expect(at.height).toBeCloseTo(PIER_TOP, 9);
    // The bed is metres under it: a wheel down there does not meet the deck.
    expect(bare(pier.x, pier.z)).toBeLessThan(PIER_TOP - 3);
    decks.viewY = PIER_TOP - 0.01;
    decks.evaluate(at);
    expect(at.height).toBe(bare(pier.x, pier.z));

    const coping = marinaToWorld(LAYOUT.frame, PIER_RIGHT + 10, -0.3);
    at.x = coping.x;
    at.z = coping.z;
    decks.viewY = COPING_TOP + 0.39;
    decks.evaluate(at);
    expect(at.height).toBeCloseTo(COPING_TOP, 9);
    decks.viewY = SEA - 2;
    decks.evaluate(at);
    expect(at.height).toBe(bare(coping.x, coping.z));
  });

  it("hold the apron level behind the quay wall, where the height authority's spline rings off the quay cut", () => {
    // The car's own read of the authority: its 2 m lattice nodes and their Catmull-Rom.
    const lattice = new TerrainLatticeCache(bare);
    const field = new DeckGround(lattice);
    field.setWorld(WORLD);
    const wall = LAYOUT.boxes.find((box) => box.kind === "quayWall")!;
    const strip = { from: MARINA_EARTHWORKS.quayFrontOut - APRON_FRONT_METERS, to: MARINA_EARTHWORKS.quayFrontOut };
    let worstSpline = 0;
    let worstBeyond = 0;
    for (let right = wall.right - wall.halfRight + 0.5; right < wall.right + wall.halfRight; right += 0.37) {
      for (let step = 0; step <= 90; step += 1) {
        // Not on the strip's own edge.
        const out = strip.from - 3.05 + step * 0.1;
        if (out > strip.to) break;
        const p = marinaToWorld(LAYOUT.frame, right, out);
        at.x = p.x;
        at.z = p.z;
        lattice.evaluate(at);
        const spline = at.height;
        field.hullGround.evaluate(at);
        if (out >= strip.from) {
          // The strip: the quay deck's level, for the hull and, under the decks, the tyres.
          expect(at.height).toBe(QUAY_TOP);
          expect(at.dhdx).toBe(0);
          expect(at.dhdz).toBe(0);
          worstSpline = Math.max(worstSpline, Math.abs(spline - QUAY_TOP));
        } else {
          // Beyond it the authority answers, and is the apron's level within a few centimetres
          // (away from the apron's ends, where the shore round it comes in).
          expect(at.height).toBe(spline);
          if (Math.abs(right - wall.right) < wall.halfRight - 3) worstBeyond = Math.max(worstBeyond, Math.abs(spline - QUAY_TOP));
        }
      }
    }
    // What the strip hides: humps and holes of half a metre and more.
    expect(worstSpline).toBeGreaterThan(0.5);
    expect(worstBeyond).toBeLessThan(0.04);
    // The decks still stand over it, seen from above; the hull's ground has none.
    const coping = marinaToWorld(LAYOUT.frame, wall.right, -0.3);
    at.x = coping.x;
    at.z = coping.z;
    field.viewY = Infinity;
    field.evaluate(at);
    expect(at.height).toBeCloseTo(COPING_TOP, 9);
    field.hullGround.evaluate(at);
    const hull = at.height;
    lattice.evaluate(at);
    expect(hull).toBe(at.height);
    expect(hull).toBeLessThan(COPING_TOP - 0.5);
  });
});

describe("the car on the marina's decks", () => {
  function onTheApron(right: number, out: number): GroundVehicleSimulator {
    const p = marinaToWorld(LAYOUT.frame, right, out);
    const sim = new GroundVehicleSimulator({
      position: { x: p.x, y: 0, z: p.z },
      heading: OUT_HEADING,
      moored: false,
      car: { gearbox: "automatic", manualClutch: false },
    });
    sim.setEnvironment({
      water: new CalmWaterSurface(SEA, bare),
      wind: { x: 0, y: 0, z: 0 },
      bedHeight: bare,
      world: WORLD,
      colliders: COLLIDERS.colliders,
      gravity: 9.80665,
    });
    return sim;
  }

  /** Marina-local (right, out) of a wheel's contact. */
  function wheelAt(sim: GroundVehicleSimulator, wheel: number): { right: number; out: number; y: number } {
    const p = sim.wheelContactPoint(wheel);
    return { ...worldToMarina(LAYOUT.frame, p.x, p.z), y: p.y };
  }

  /** Hold `target` m/s straight out from the quay, along marina right `right`, until `until` says stop. */
  function creep(sim: GroundVehicleSimulator, right: number, target: number, seconds: number, until: () => boolean, each: () => void): void {
    // The contacts are found on the first step.
    for (let i = 0; i < seconds / STEP && (i === 0 || !until()); i += 1) {
      const error = target - speedOf(sim);
      const at = worldToMarina(LAYOUT.frame, sim.state.position.x, sim.state.position.z);
      // Steer back onto the line: the heading error, and the offset from the line over 5 m.
      const offLine = Math.atan2(at.right - right, 5);
      const steer = Math.max(-1, Math.min(1, 3 * (headingOf(sim) - OUT_HEADING) - 3 * offLine));
      controls(sim, { steer, accelerator: Math.max(0, Math.min(1, 0.25 + 0.5 * error)), brake: error < -1 ? 0.3 : 0 });
      sim.step(STEP);
      each();
    }
  }

  /** Every wheel's contact that lies in a deck's plan lies on that deck's top. */
  function expectOnTheDecks(sim: GroundVehicleSimulator, seen: { coping: number; pier: number }): void {
    for (let w = 0; w < 4; w += 1) {
      const wheel = wheelAt(sim, w);
      if (wheel.out >= -MARINA_LAYOUT.quayWallThickness && wheel.out <= 0) {
        expect(wheel.y).toBeCloseTo(COPING_TOP, 9);
        seen.coping += 1;
      } else if (wheel.out > 0 && wheel.out <= PIER_LENGTH && Math.abs(wheel.right - PIER_RIGHT) <= MARINA_LAYOUT.pierWidth * 0.5) {
        expect(wheel.y).toBeCloseTo(PIER_TOP, 9);
        seen.pier += 1;
      }
    }
  }

  it("drives off the apron over the coping and out along the pier deck", () => {
    const sim = onTheApron(PIER_RIGHT, -10);
    const seen = { coping: 0, pier: 0 };
    let lowest = Infinity;
    creep(sim, PIER_RIGHT, 2, 20, () => wheelAt(sim, 2).out > 8 && wheelAt(sim, 3).out > 8, () => {
      expectOnTheDecks(sim, seen);
      for (let w = 0; w < 4; w += 1) lowest = Math.min(lowest, wheelAt(sim, w).y);
      expect(sim.visualState().wadingDepth).toBe(0);
    });
    // All four crossed the coping and reached the deck.
    expect(seen.coping).toBeGreaterThan(4 * 40);
    expect(seen.pier).toBeGreaterThan(4 * 40);
    expect(wheelAt(sim, 2).out).toBeGreaterThan(8);
    controls(sim, { brake: 1 });
    for (let i = 0; i < 2 / STEP; i += 1) sim.step(STEP);
    expect(Math.abs(speedOf(sim))).toBeLessThan(0.05);
    // No tyre ever went below the pier deck: none dropped into the quay cut or through the pier.
    expect(lowest).toBeGreaterThan(PIER_TOP - 1e-6);
    for (let w = 0; w < 4; w += 1) {
      const wheel = wheelAt(sim, w);
      expect(wheel.out).toBeGreaterThan(1);
      expect(wheel.out).toBeLessThan(PIER_LENGTH - 1);
      expect(Math.abs(wheel.right - PIER_RIGHT)).toBeLessThan(MARINA_LAYOUT.pierWidth * 0.5);
      expect(wheel.y).toBeCloseTo(PIER_TOP, 9);
      expect(sim.wheelLoad[w]).toBeGreaterThan(4_000);
      // Timber decking.
      expect(sim.wheelSurface[w]!.friction).toBe(0.8);
    }
    expect(sim.state.crashed).toBe(false);
    expect(sim.visualState().wadingDepth).toBe(0);
  });

  /** A lane straight out across the apron to the quay wall with no building or post within 2.5 m of it. */
  function clearLane(): number {
    const wall = LAYOUT.boxes.find((box) => box.kind === "quayWall")!;
    const blocked = (right: number) =>
      LAYOUT.boxes.some((box) => !DECK_BOX_KINDS.has(box.kind) && box.out - box.halfOut < 0 && box.out + box.halfOut > -14
        && Math.abs(box.right - right) < box.halfRight + 2.5)
      || LAYOUT.posts.some((post) => !post.floating && post.out < 0 && post.out > -14 && Math.abs(post.right - right) < 2.5)
      || Math.abs(right - PIER_RIGHT) < MARINA_LAYOUT.pierWidth * 0.5 + 2.5;
    for (let right = wall.right - wall.halfRight + 3; right < wall.right + wall.halfRight - 3; right += 0.5) {
      if (!blocked(right)) return right;
    }
    throw new Error("no clear lane to the quay");
  }

  it("drives up to the coping's edge and stands there, its front tyres on the coping over the quay cut", () => {
    const right = clearLane();
    const sim = onTheApron(right, -10);
    const seen = { coping: 0, pier: 0 };
    creep(sim, right, 1, 20, () => wheelAt(sim, 0).out > -0.5 && wheelAt(sim, 1).out > -0.5, () => expectOnTheDecks(sim, seen));
    controls(sim, { brake: 1 });
    for (let i = 0; i < 3 / STEP; i += 1) {
      sim.step(STEP);
      expectOnTheDecks(sim, seen);
    }
    expect(Math.abs(speedOf(sim))).toBeLessThan(0.02);
    let frontLoad = 0;
    for (const w of [0, 1]) {
      const wheel = wheelAt(sim, w);
      expect(wheel.out).toBeGreaterThan(-0.6);
      expect(wheel.out).toBeLessThan(0);
      expect(wheel.y).toBeCloseTo(COPING_TOP, 9);
      // The terrain alone is the quay cut there, half a metre and more down.
      const p = sim.wheelContactPoint(w);
      expect(bare(p.x, p.z)).toBeLessThan(COPING_TOP - 0.5);
      expect(sim.wheelSurface[w]!.friction).toBe(1);
      frontLoad += sim.wheelLoad[w]!;
    }
    // The rear tyres on the apron, the front ones carrying their share.
    for (const w of [2, 3]) expect(wheelAt(sim, w).y).toBeCloseTo(SEA + MARINA_LAYOUT.quayDeckHeight, 3);
    const total = frontLoad + sim.wheelLoad[2]! + sim.wheelLoad[3]!;
    expect(frontLoad / total).toBeGreaterThan(0.45);
    expect(sim.state.crashed).toBe(false);
    expect(sim.visualState().wadingDepth).toBe(0);
  });
});
