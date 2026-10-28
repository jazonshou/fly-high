import { describe, expect, it } from "vitest";
import { PERSON_SURFACE_COLLIDER_BASE, PERSON_SURFACE_WATER } from "../src/game/types";
import { SurfaceMaterial } from "../src/render/webgpu/terrain/surfaceMaterials";
import { ColliderWorld } from "../src/sim/colliders";
import {
  LandingKind,
  landingKind,
  runSlopeFactor,
  wadingSpeedCap,
  WALK_SLOPE_LIMIT_DEGREES,
  walkSlopeLimitTan,
} from "../src/sim/person/walkerLaws";
import { PERSON, toblerFactor } from "../src/vehicles/person";
import {
  environment,
  flat,
  groundSpeed,
  headingOf,
  payload,
  rampAlongX,
  River,
  run,
  slopeAlongX,
  STEP,
  Swell,
  walker,
} from "./support/walkerRig";

/**
 * The walker's controller (the walking plan, "Controller and physics" and
 * "Wading, swimming, diving"): speeds, turning, slopes per surface, steps
 * and stairs, jumps and landings, falls, moving decks, obstacles, wading,
 * floating, climbing out and diving, each against the spec's numbers.
 */

const H = PERSON.stature;
const DEG = Math.PI / 180;

describe("walker laws", () => {
  it("limit each surface's slope to its plan value", () => {
    expect(WALK_SLOPE_LIMIT_DEGREES[SurfaceMaterial.Grass]).toBe(35);
    expect(WALK_SLOPE_LIMIT_DEGREES[SurfaceMaterial.ForestFloor]).toBe(35);
    expect(WALK_SLOPE_LIMIT_DEGREES[SurfaceMaterial.Rock]).toBe(45);
    expect(WALK_SLOPE_LIMIT_DEGREES[SurfaceMaterial.Sand]).toBe(33);
    expect(WALK_SLOPE_LIMIT_DEGREES[SurfaceMaterial.Tephra]).toBe(33);
    expect(WALK_SLOPE_LIMIT_DEGREES[SurfaceMaterial.Snow]).toBe(30);
    expect(WALK_SLOPE_LIMIT_DEGREES).toHaveLength(Object.keys(SurfaceMaterial).length);
    expect(walkSlopeLimitTan(99)).toBeCloseTo(Math.tan(35 * DEG), 12);
  });

  it("soften Tobler's law for running", () => {
    expect(runSlopeFactor(0)).toBeCloseTo(1, 12);
    expect(runSlopeFactor(0.1)).toBeGreaterThan(toblerFactor(0.1));
    expect(runSlopeFactor(0.1)).toBeCloseTo(0.81, 2);
    expect(runSlopeFactor(-0.4)).toBeCloseTo(runSlopeFactor(0.3), 9);
  });

  it("slow a wader through the plan's knee, waist and chest speeds", () => {
    expect(wadingSpeedCap(0.1, false)).toBe(Infinity);
    expect(wadingSpeedCap(0.285, false)).toBeCloseTo(1.0, 9);
    expect(wadingSpeedCap(0.6, false)).toBeCloseTo(0.6, 9);
    expect(wadingSpeedCap(0.72, false)).toBeCloseTo(0.4, 9);
    expect(wadingSpeedCap(0.75, false)).toBeCloseTo(0.4, 9);
    // Monotonic: deeper is never faster.
    let last = Infinity;
    for (let f = 0.15; f <= 0.75; f += 0.01) {
      const cap = wadingSpeedCap(f, false);
      expect(cap).toBeLessThanOrEqual(last + 1e-12);
      last = cap;
    }
    expect(wadingSpeedCap(0.285, true)).toBeCloseTo(1.5, 9);
  });

  it("sort landings by the plan's speeds", () => {
    expect(landingKind(4.9)).toBe(LandingKind.normal);
    expect(landingKind(5)).toBe(LandingKind.hard);
    expect(landingKind(7.9)).toBe(LandingKind.hard);
    expect(landingKind(8)).toBe(LandingKind.roll);
    // Equal drops v^2 / 2g: 1.3 m and 3.3 m.
    expect((PERSON.landingHardSpeed ** 2) / (2 * 9.80665)).toBeCloseTo(1.3, 1);
    expect((PERSON.landingRollSpeed ** 2) / (2 * 9.80665)).toBeCloseTo(3.3, 1);
  });
});

describe("walker on the ground", () => {
  it("walks, runs, and takes a stick's speed between, never under 0.3 m/s", () => {
    const ground = flat(2);
    const env = environment(ground);
    const subject = walker({ x: 0, y: 2, z: 0 }, 0, ground);
    run(subject, env, 2, { moveZ: 1 });
    expect(groundSpeed(subject)).toBeCloseTo(PERSON.walkSpeed, 6);
    expect(payload(subject).mode).toBe("walk");
    expect(subject.state.position.y).toBe(2);
    run(subject, env, 2, { moveZ: 1, run: true });
    expect(groundSpeed(subject)).toBeCloseTo(PERSON.runSpeed, 6);
    expect(payload(subject).mode).toBe("run");
    expect(payload(subject).running).toBe(true);
    run(subject, env, 2, { moveZ: 0.5, run: true });
    expect(groundSpeed(subject)).toBeCloseTo(0.5 * PERSON.runSpeed, 6);
    run(subject, env, 2, { moveZ: 0.06 });
    expect(groundSpeed(subject)).toBeCloseTo(0.3, 6);
    run(subject, env, 2, {});
    expect(groundSpeed(subject)).toBe(0);
    expect(payload(subject).mode).toBe("stand");
  });

  it("turns to face the move at 540 deg/s walking and 270 running", () => {
    const ground = flat();
    const env = environment(ground);
    const subject = walker({ x: 0, y: 0, z: 0 }, 0, ground);
    // A quarter turn to +X: 1/6 s walking.
    run(subject, env, 10 * STEP, { moveX: 1 });
    expect(headingOf(subject) / DEG).toBeCloseTo(45, 6);
    run(subject, env, 0.2, { moveX: 1 });
    expect(headingOf(subject) / DEG).toBeCloseTo(90, 6);
    // Running back to -X turns at half the rate: 90 deg takes 1/3 s.
    run(subject, env, 20 * STEP, { moveZ: -1, run: true });
    expect(headingOf(subject) / DEG).toBeCloseTo(135, 6);
  });

  it("slows on climbs by Tobler's law and running's softer one", () => {
    const ground = slopeAlongX(Math.atan(0.1) / DEG);
    const env = environment(ground);
    const subject = walker({ x: 0, y: 0, z: 0 }, Math.PI / 2, ground, SurfaceMaterial.Grass);
    run(subject, env, 2, { moveX: 1 });
    expect(groundSpeed(subject)).toBeCloseTo(PERSON.walkSpeed * toblerFactor(0.1), 3);
    expect(payload(subject).slope).toBeCloseTo(0.1, 6);
    run(subject, env, 2, { moveX: 1, run: true });
    expect(groundSpeed(subject)).toBeCloseTo(PERSON.runSpeed * runSlopeFactor(0.1), 3);
    // Downhill at 5% is the fastest walk.
    run(subject, env, 2, { moveX: -1 });
    expect(payload(subject).slope).toBeCloseTo(-0.1, 6);
    expect(groundSpeed(subject)).toBeCloseTo(PERSON.walkSpeed * toblerFactor(-0.1), 3);
  });

  it("cannot climb grass steeper than 35 degrees, and climbs rock to 45", () => {
    for (const [material, degrees, climbs] of [
      [SurfaceMaterial.Grass, 34, true],
      [SurfaceMaterial.Grass, 37, false],
      [SurfaceMaterial.Rock, 44, true],
      [SurfaceMaterial.Rock, 47, false],
      [SurfaceMaterial.Snow, 32, false],
    ] as const) {
      const ground = slopeAlongX(degrees);
      const env = environment(ground);
      const subject = walker({ x: 0, y: 0, z: 0 }, Math.PI / 2, ground, material);
      run(subject, env, 4, { moveX: 1 });
      // Tobler's law leaves 0.05 m/s at 44 degrees.
      if (climbs) expect(subject.state.position.x, `${degrees} deg`).toBeGreaterThan(0.15);
      else expect(subject.state.position.x, `${degrees} deg`).toBeLessThan(0.02);
    }
  });

  it("stands on grass at 34 degrees, and slides down sand past 33 and snow past 30", () => {
    for (const [material, degrees, slides] of [
      [SurfaceMaterial.Grass, 34, false],
      [SurfaceMaterial.Sand, 32, false],
      [SurfaceMaterial.Sand, 36, true],
      [SurfaceMaterial.Snow, 33, true],
    ] as const) {
      const ground = slopeAlongX(degrees);
      const env = environment(ground);
      const subject = walker({ x: 0, y: 0, z: 0 }, 0, ground, material);
      run(subject, env, 3, {});
      if (slides) expect(subject.state.position.x, `${degrees} deg`).toBeLessThan(-0.3);
      else expect(subject.state.position.x, `${degrees} deg`).toBe(0);
      expect(payload(subject).grounded).toBe(true);
    }
  });

  it("steps up a 0.35 m ledge and not a 0.5 m one", () => {
    for (const [height, climbs] of [[0.35, true], [0.5, false]] as const) {
      const ground = flat();
      const world = new ColliderWorld();
      world.addStatic({ kind: "box", center: { x: 5, y: height / 2, z: 0 }, halfExtents: { x: 3, y: height / 2, z: 3 } }, { material: 102 });
      const env = environment(ground, { colliders: world });
      const subject = walker({ x: 0, y: 0, z: 0 }, Math.PI / 2, ground);
      run(subject, env, 3, { moveX: 1 });
      if (climbs) {
        expect(subject.state.position.x).toBeGreaterThan(2.5);
        expect(subject.state.position.y).toBeCloseTo(height, 6);
        expect(payload(subject).surface).toBe(PERSON_SURFACE_COLLIDER_BASE + 102);
      } else {
        expect(subject.state.position.x).toBeLessThan(2 - PERSON.capsuleRadius + 0.02);
        expect(subject.state.position.x).toBeGreaterThan(1.5);
        expect(subject.state.position.y).toBe(0);
      }
    }
  });

  it("climbs and descends stairs of 0.18 m risers without leaving the ground", () => {
    const ground = flat();
    const world = new ColliderWorld();
    const riser = 0.18;
    const tread = 0.28;
    for (let i = 0; i < 10; i += 1) {
      const top = riser * (i + 1);
      // Each step a solid block from the ground to its tread.
      world.addStatic({ kind: "box", center: { x: 2 + tread * (i + 0.5) + 2, y: top / 2, z: 0 }, halfExtents: { x: tread * 0.5 + 2, y: top / 2, z: 1 } });
    }
    const env = environment(ground, { colliders: world });
    const subject = walker({ x: 0, y: 0, z: 0 }, Math.PI / 2, ground);
    let airborne = 0;
    run(subject, env, 6, { moveX: 1 }, (s) => {
      if (!payload(s).grounded) airborne += 1;
    });
    expect(subject.state.position.y).toBeCloseTo(10 * riser, 6);
    expect(airborne).toBe(0);
    run(subject, env, 8, { moveX: -1 }, (s) => {
      if (!payload(s).grounded) airborne += 1;
    });
    expect(subject.state.position.y).toBe(0);
    expect(airborne).toBe(0);
  });

  it("is carried by a moving pontoon, standing still on it", () => {
    const ground = flat(-5);
    const world = new ColliderWorld();
    const pontoon = world.addKinematic({ kind: "box", center: { x: 0, y: -0.25, z: 0 }, halfExtents: { x: 6, y: 0.25, z: 2 } });
    const pose = { x: 0, y: 0, z: 0 };
    const identity = { x: 0, y: 0, z: 0, w: 1 };
    const velocity = { x: 0.3, y: 0, z: 0 };
    world.setKinematicPose(pontoon, pose, identity, velocity);
    const env = environment(ground, { colliders: world });
    const subject = walker({ x: 0, y: 0, z: 0 }, 0, ground);
    const heave = (time: number) => 0.2 * Math.sin(1.5 * time);
    run(subject, env, 6, {}, (s) => {
      const time = s.state.time;
      pose.x = 0.3 * time;
      pose.y = heave(time);
      velocity.y = 0.3 * Math.cos(1.5 * time);
      world.setKinematicPose(pontoon, pose, identity, velocity);
    });
    expect(subject.state.position.x).toBeCloseTo(0.3 * 6, 1);
    expect(subject.state.position.y).toBeCloseTo(heave(subject.state.time), 1);
    expect(payload(subject).grounded).toBe(true);
    expect(payload(subject).speed).toBeLessThan(0.01);
  });

  it("is held off walls and tree trunks in the near solids, and slides along them", () => {
    const ground = flat();
    const near = new ColliderWorld();
    near.addStatic({ kind: "capsule", a: { x: 3, y: 0, z: 0 }, b: { x: 3, y: 8, z: 0 }, radius: 0.25 });
    const env = environment(ground, { nearSolids: near });
    const subject = walker({ x: 0, y: 0, z: 0.05 }, Math.PI / 2, ground);
    let closest = Infinity;
    run(subject, env, 6, { moveX: 1 }, (s) => {
      closest = Math.min(closest, Math.hypot(s.state.position.x - 3, s.state.position.z));
    });
    expect(closest).toBeGreaterThan(0.25 + PERSON.capsuleRadius - 1e-6);
    // Round the trunk and on past it.
    expect(subject.state.position.x).toBeGreaterThan(4);
  });
});

describe("walker jumps and falls", () => {
  it("cannot jump again in the air", () => {
    const ground = flat();
    const env = environment(ground);
    const subject = walker({ x: 0, y: 0, z: 0 }, 0, ground);
    run(subject, env, STEP, { jumpPresses: 0 });
    let peak = 0;
    run(subject, env, 0.2, { jumpPresses: 1 }, (s) => {
      peak = Math.max(peak, s.state.position.y);
    });
    run(subject, env, 1, { jumpPresses: 2 }, (s) => {
      peak = Math.max(peak, s.state.position.y);
    });
    expect(peak).toBeLessThan(PERSON.jumpHeight + 0.02);
    expect(payload(subject).grounded).toBe(true);
  });

  it("lands softly from 1 m, crouches from 2 m and rolls from 4 m, and cannot move meanwhile", () => {
    // Walking off an edge the capsule's foot rolls round it, 0.09 m down, before it falls.
    for (const [drop, kind, lock] of [
      [1, "walk", 0],
      [2.2, "land", PERSON.landingHardSeconds],
      [4.5, "land", PERSON.landingRollSeconds],
    ] as const) {
      const ground = flat();
      const world = new ColliderWorld();
      world.addStatic({ kind: "box", center: { x: 0, y: drop / 2, z: 0 }, halfExtents: { x: 1, y: drop / 2, z: 1 } });
      const env = environment(ground, { colliders: world });
      const subject = walker({ x: 0, y: drop, z: 0 }, Math.PI / 2, ground);
      // Walk off the block's edge.
      let landedAt = -1;
      run(subject, env, 3, { moveX: 1 }, (s, i) => {
        if (landedAt < 0 && payload(s).landingAge === 0) landedAt = i;
      });
      const person = payload(subject);
      expect(person.landingSpeed).toBeLessThanOrEqual(Math.sqrt(2 * 9.80665 * drop));
      // The landing is taken up to 3 cm early and the edge rolls the body off ~9 cm late.
      expect(person.landingSpeed).toBeGreaterThan(Math.sqrt(2 * 9.80665 * (drop - 0.15)));
      expect(landedAt).toBeGreaterThan(0);
      if (lock === 0) {
        expect(person.mode).toBe(kind);
        continue;
      }
      // Replay to the landing and watch the lock.
      const again = walker({ x: 0, y: drop, z: 0 }, Math.PI / 2, ground);
      let held = 0;
      let x = 0;
      run(again, env, 3, { moveX: 1 }, (s, i) => {
        if (i <= landedAt) return;
        if (payload(s).mode === kind) {
          held += STEP;
          if (held === STEP) x = s.state.position.x;
        }
      });
      expect(held).toBeCloseTo(lock, 1);
      expect(again.state.position.x).toBeGreaterThan(x);
    }
  });

  it("does not tunnel through a thin deck falling at 50 m/s", () => {
    const ground = flat(-20);
    const world = new ColliderWorld();
    const drop = 50 ** 2 / (2 * 9.80665);
    // Walk off a tower onto a deck 0.1 m thick beside it.
    world.addStatic({ kind: "box", center: { x: 0, y: drop / 2, z: 0 }, halfExtents: { x: 1, y: drop / 2, z: 1 } });
    world.addStatic({ kind: "box", center: { x: 15, y: -0.05, z: 0 }, halfExtents: { x: 14, y: 0.05, z: 3 } });
    const env = environment(ground, { colliders: world });
    const subject = walker({ x: 0, y: drop, z: 0 }, Math.PI / 2, ground);
    let fastest = 0;
    run(subject, env, 1.5, { moveX: 1 });
    run(subject, env, 6, {}, (s) => {
      fastest = Math.max(fastest, -s.state.velocity.y);
    });
    expect(fastest).toBeGreaterThan(49);
    expect(subject.state.position.y).toBeCloseTo(0, 6);
    expect(payload(subject).grounded).toBe(true);
    expect(payload(subject).landingSpeed).toBeGreaterThan(49);
  });

  it("walks off a ledge into the air and lands on the terrain", () => {
    const ground = rampAlongX(0, 1000, 0, 0);
    const world = new ColliderWorld();
    world.addStatic({ kind: "box", center: { x: 0, y: 0.75, z: 0 }, halfExtents: { x: 1, y: 0.75, z: 1 } });
    const env = environment(ground, { colliders: world });
    const subject = walker({ x: 0, y: 1.5, z: 0 }, Math.PI / 2, ground);
    let flew = false;
    run(subject, env, 2, { moveX: 1 }, (s) => {
      if (payload(s).mode === "air") flew = true;
    });
    expect(flew).toBe(true);
    expect(subject.state.position.y).toBe(0);
    expect(payload(subject).grounded).toBe(true);
  });

  it("recovers to the newest safe spot when stuck", () => {
    const ground = flat();
    const env = environment(ground);
    const subject = walker({ x: 0, y: 0, z: 0 }, 0, ground);
    run(subject, env, 3, { moveZ: 1 });
    const safeZ = subject.state.position.z;
    subject.placeAt({ x: 50, y: 0, z: 50 }, 1);
    run(subject, env, STEP, {});
    subject.recover();
    run(subject, env, STEP, {});
    expect(subject.state.position.x).toBeCloseTo(50, 6);
    // Placing is a safe spot of its own; before it, the walk's.
    expect(safeZ).toBeGreaterThan(3);
  });
});

describe("walker in water", () => {
  it("wades slower the deeper, through the knee, waist and chest speeds", () => {
    for (const fraction of [0.285, 0.6, 0.72]) {
      const ground = flat(-fraction * H);
      const env = environment(ground, { seaLevel: 0 });
      const subject = walker({ x: 0, y: -fraction * H, z: 0 }, 0, ground);
      run(subject, env, 3, { moveZ: 1 });
      expect(groundSpeed(subject), `${fraction} H`).toBeCloseTo(wadingSpeedCap(fraction, false), 6);
      const person = payload(subject);
      expect(person.mode).toBe("wade");
      expect(person.waterDepth).toBeCloseTo(fraction * H, 6);
      expect(person.surface).toBe(PERSON_SURFACE_WATER);
    }
  });

  it("walks with splashes in ankle-deep water", () => {
    const ground = flat(-0.1);
    const env = environment(ground, { seaLevel: 0 });
    const subject = walker({ x: 0, y: -0.1, z: 0 }, 0, ground);
    run(subject, env, 2, { moveZ: 1 });
    expect(payload(subject).mode).toBe("walk");
    expect(groundSpeed(subject)).toBeCloseTo(PERSON.walkSpeed, 6);
    expect(payload(subject).surface).toBe(PERSON_SURFACE_WATER);
  });

  it("swims at 0.8 m/s, 1.3 crawling, the eye riding just over the swell", () => {
    const ground = flat(-6);
    const swell = new Swell(ground, 0, 0.4, 30);
    const env = environment(ground, { water: swell });
    const subject = walker({ x: 0, y: -6, z: 0 }, 0, ground);
    run(subject, env, 3, {});
    expect(payload(subject).mode).toBe("swim");
    let worst = 0;
    run(subject, env, 10, {}, (s) => {
      worst = Math.max(worst, Math.abs(payload(s).headDepth + 0.05));
    });
    expect(worst).toBeLessThan(0.1);
    // Swimming across the swell (along z), the stroke speed over the water.
    run(subject, env, 4, { moveZ: 1 });
    expect(payload(subject).speed).toBeCloseTo(PERSON.swimSpeed, 6);
    run(subject, env, 4, { moveZ: 1, run: true });
    expect(payload(subject).speed).toBeCloseTo(PERSON.swimFastSpeed, 6);
    expect(payload(subject).swimPitch).toBeCloseTo(0.05, 6);
  });

  it("drifts with a river's current", () => {
    const ground = flat(-4);
    const env = environment(ground, { water: new River(ground, 0, 0.5) });
    const subject = walker({ x: 0, y: -4, z: 0 }, 0, ground);
    run(subject, env, 10, {});
    expect(payload(subject).mode).toBe("swim");
    expect(subject.state.velocity.x).toBeCloseTo(0.5, 6);
    expect(payload(subject).speed).toBeCloseTo(0, 6);
  });

  it("swims up a 1:8 slipway into a wade and walks out", () => {
    const ground = rampAlongX(-2, 0, 1 / 8, 1);
    const env = environment(ground, { seaLevel: 0 });
    const subject = walker({ x: -3, y: -2, z: 0 }, Math.PI / 2, ground);
    const modes = new Set<string>();
    run(subject, env, 30, { moveX: 1 }, (s) => modes.add(payload(s).mode));
    expect(modes.has("swim")).toBe(true);
    expect(modes.has("wade")).toBe(true);
    expect(modes.has("mantle")).toBe(false);
    // The shore is dry from x = 16.
    expect(subject.state.position.x).toBeGreaterThan(18);
    expect(payload(subject).mode).toBe("walk");
  });

  it("climbs out onto a pontoon 0.4 m over the water, and not onto a quay 1 m over it", () => {
    for (const [freeboard, climbs] of [[0.4, true], [1.0, false]] as const) {
      const ground = flat(-5);
      const world = new ColliderWorld();
      world.addStatic({ kind: "box", center: { x: 3, y: freeboard - 1, z: 0 }, halfExtents: { x: 1.5, y: 1, z: 4 } }, { material: 103 });
      const env = environment(ground, { seaLevel: 0, colliders: world });
      const subject = walker({ x: 0, y: -5, z: 0 }, Math.PI / 2, ground);
      const modes = new Set<string>();
      run(subject, env, 3.5, { moveX: 1 }, (s) => modes.add(payload(s).mode));
      run(subject, env, 1, {}, (s) => modes.add(payload(s).mode));
      if (climbs) {
        expect(modes.has("mantle")).toBe(true);
        expect(payload(subject).grounded).toBe(true);
        expect(subject.state.position.y).toBeCloseTo(freeboard, 6);
        expect(subject.state.position.x).toBeGreaterThan(1.5);
      } else {
        expect(modes.has("mantle")).toBe(false);
        expect(payload(subject).mode).toBe("swim");
        expect(subject.state.position.x).toBeLessThan(1.5);
      }
    }
  });

  it("dives, drifts back up at 0.1 m/s, and swims where the camera points", () => {
    const ground = flat(-12);
    const env = environment(ground, { seaLevel: 0 });
    const subject = walker({ x: 0, y: -12, z: 0 }, 0, ground);
    run(subject, env, 3, {});
    run(subject, env, 3, { dive: true });
    expect(payload(subject).mode).toBe("dive");
    expect(subject.state.velocity.y).toBeCloseTo(-PERSON.diveSpeed, 6);
    expect(payload(subject).swimPitch).toBeCloseTo(-Math.PI / 2, 6);
    run(subject, env, 4, {});
    expect(subject.state.velocity.y).toBeCloseTo(PERSON.buoyantRise, 6);
    // Forward, looking 30 degrees down: along the look at the dive speed.
    run(subject, env, 4, { moveZ: 1, lookHeading: 0, lookPitch: -30 * DEG });
    expect(subject.state.velocity.z).toBeCloseTo(PERSON.diveSpeed * Math.cos(30 * DEG), 6);
    expect(subject.state.velocity.y).toBeCloseTo(-PERSON.diveSpeed * Math.sin(30 * DEG), 6);
    run(subject, env, 4, { moveZ: 1, run: true, lookHeading: 0, lookPitch: 0 });
    expect(payload(subject).speed).toBeCloseTo(PERSON.diveFastSpeed, 6);
    expect(payload(subject).headDepth).toBeGreaterThan(1);
    expect(payload(subject).submersion).toBe(1);
    // Rise brings it back to the surface.
    run(subject, env, 10, { rise: true });
    expect(payload(subject).mode).toBe("swim");
  });

  it("never ends below the bed, and meets piles under water", () => {
    const ground = slopeAlongX(-10);
    const world = new ColliderWorld();
    world.addStatic({ kind: "capsule", a: { x: 2, y: -20, z: 0 }, b: { x: 2, y: 2, z: 0 }, radius: 0.2 });
    const env = environment(ground, { seaLevel: 0, colliders: world });
    const subject = walker({ x: -20, y: ground.height(-20, 0), z: 0 }, Math.PI / 2, ground);
    run(subject, env, 2, {});
    let lowest = Infinity;
    let closest = Infinity;
    run(subject, env, 30, { dive: true, moveX: 1, lookHeading: Math.PI / 2 }, (s) => {
      const eye = s.state.position.y + PERSON.eyeHeight;
      lowest = Math.min(lowest, eye - ground.height(s.state.position.x, s.state.position.z));
      closest = Math.min(closest, Math.hypot(s.state.position.x - 2, s.state.position.z));
    });
    expect(lowest).toBeGreaterThan(PERSON.capsuleRadius - 1e-6);
    expect(closest).toBeGreaterThan(0.2 + PERSON.capsuleRadius - 1e-3);
  });

  it("plunges into deep water from a pier and comes back up to swim", () => {
    const ground = flat(-6);
    const world = new ColliderWorld();
    world.addStatic({ kind: "box", center: { x: 0, y: 1, z: 0 }, halfExtents: { x: 1, y: 2, z: 2 } });
    const env = environment(ground, { seaLevel: 0, colliders: world });
    const subject = walker({ x: 0, y: 3, z: 0 }, Math.PI / 2, ground);
    const modes: string[] = [];
    run(subject, env, 12, { moveX: 1 }, (s) => {
      const mode = payload(s).mode;
      if (modes[modes.length - 1] !== mode) modes.push(mode);
    });
    expect(modes).toContain("air");
    expect(payload(subject).mode).toBe("swim");
    expect(payload(subject).headDepth).toBeCloseTo(-0.05, 1);
  });
});
