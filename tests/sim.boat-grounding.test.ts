import { describe, expect, it } from "vitest";
import { BoatSimulator, type BoatContactMaterial, type BoatEnvironment } from "../src/sim/boat";
import { ColliderWorld } from "../src/sim/colliders";
import { NEUTRAL_BOAT_CONTROLS } from "../src/sim/surface";
import type { BoatControlState } from "../src/game/types";
import { CalmWaterSurface } from "../src/sim/water";

/**
 * The hull against the bed and the world's colliders: a slow beaching runs up
 * and stops, a fast one is a wreck, and a collider's material sets how hard a
 * knock it takes.
 */

const STEP = 1 / 120;
const KNOT = 0.514444;

function environment(bedHeight: (x: number, z: number) => number, extra: Partial<BoatEnvironment> = {}): BoatEnvironment {
  return {
    water: new CalmWaterSurface(0, bedHeight),
    wind: { x: 0, y: 0, z: 0 },
    bedHeight,
    gravity: 9.80665,
    ...extra,
  };
}

function controls(boat: Partial<BoatControlState> = {}) {
  return { assist: "pilot" as const, boat: { ...NEUTRAL_BOAT_CONTROLS, ...boat } };
}

function run(boat: BoatSimulator, seconds: number, each?: () => void): void {
  for (let t = 0; t < seconds; t += STEP) {
    boat.step(STEP);
    each?.();
  }
}

/** Deep water to x = 40 m, then a 1:12 sand beach rising east. */
const beach = (x: number) => (x < 40 ? -6 : Math.min(2, -6 + (x - 40) / 12));

describe("boat grounding", () => {
  it("runs up a beach at idle in gear and stops on it, whole", () => {
    const boat = new BoatSimulator({ position: { x: 0, y: 0, z: 0 }, heading: Math.PI / 2, moored: false, speed: 2.5 * KNOT, gear: "forward" });
    boat.setEnvironment(environment(beach));
    boat.setControls(controls({ lever: 0.1 }));
    let grounded = false;
    run(boat, 90, () => {
      grounded ||= boat.snapshot().onGround;
    });
    const snapshot = boat.snapshot();
    expect(grounded).toBe(true);
    expect(snapshot.crashed).toBe(false);
    // Aground on the sand where the keel meets it, not driven up the beach.
    expect(snapshot.position.x).toBeGreaterThan(95);
    expect(snapshot.position.x).toBeLessThan(115);
    expect(Math.hypot(snapshot.velocity.x, snapshot.velocity.z)).toBeLessThan(0.3);
  });

  it("is a wreck when it hits the same beach on the plane", () => {
    const boat = new BoatSimulator({ position: { x: -100, y: 0, z: 0 }, heading: Math.PI / 2, moored: false, speed: 35 * KNOT, gear: "forward", rpm: 5_000 });
    boat.setEnvironment(environment(beach));
    boat.setControls(controls({ lever: 1 }));
    run(boat, 20);
    expect(boat.snapshot().crashed).toBe(true);
  });

  const fendered: BoatContactMaterial = { crashSpeed: 4, stiffness: 1.5e5, damping: 9e3, friction: 0.15 };

  function ramPile(speed: number, material?: BoatContactMaterial) {
    const colliders = new ColliderWorld();
    colliders.addStatic(
      { kind: "capsule", a: { x: 6, y: -4, z: 0 }, b: { x: 6, y: 3, z: 0 }, radius: 0.15 },
      { material: 7 },
    );
    const boat = new BoatSimulator({ position: { x: 0, y: 0, z: 0 }, heading: Math.PI / 2, moored: false, speed });
    boat.setEnvironment(
      environment(() => -8, { colliders, contactMaterials: material ? new Map([[7, material]]) : null }),
    );
    boat.setControls(controls());
    // The stem starts 1.5 m short of the pile; the furthest the CG gets is how far the hull gave.
    let furthest = -Infinity;
    run(boat, 12, () => {
      furthest = Math.max(furthest, boat.snapshot().position.x);
    });
    return { boat: boat.snapshot(), furthest };
  }

  it("fends off a pile at a walk and is wrecked by one at a run", () => {
    const slow = ramPile(0.8);
    expect(slow.boat.crashed).toBe(false);
    expect(Math.abs(slow.boat.velocity.x)).toBeLessThan(0.1);
    expect(ramPile(3.5).boat.crashed).toBe(true);
  });

  it("takes a harder knock on a material that gives, and still stops at it", () => {
    const slow = ramPile(0.8, fendered);
    const fast = ramPile(3.5, fendered);
    expect(fast.boat.crashed).toBe(false);
    // Stopped at the pile, within the fender's give of where a slow touch rests.
    expect(fast.furthest).toBeLessThan(slow.furthest + 0.4);
    expect(Math.abs(fast.boat.velocity.x)).toBeLessThan(0.3);
    expect(ramPile(5, fendered).boat.crashed).toBe(true);
  });
});
