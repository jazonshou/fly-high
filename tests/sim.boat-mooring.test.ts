import { describe, expect, it } from "vitest";
import { ColliderWorld } from "@/src/sim/colliders";
import { rotateVectorInto, quaternionFromFlightAngles } from "@/src/sim/math";
import { RigidBody } from "@/src/sim/rigidBody";
import type { Vec3 } from "@/src/sim/types";
import {
  addMarinaColliders,
  MARINA_COLLIDER_MATERIAL,
  createMarinaPontoonPose,
  marinaPontoonPose,
  poseMarinaPontoons,
} from "@/src/sim/marina/colliders";
import { MarinaContactLoad } from "@/src/sim/marina/contact";
import {
  Mooring,
  MOORING,
  RUNABOUT_21_CG_ABOVE_WATER,
  RUNABOUT_21_CLEATS_BODY,
  type MooringLoadContext,
} from "@/src/sim/marina/mooring";
import { createWaterSurfaceSample, type WaterSurfaceAuthority, type WaterSurfaceSample } from "@/src/sim/water/types";
import type { BoatControlState } from "@/src/game/types";
import { createWorld } from "@/src/world";
import { homeMarina, marinaStartPose } from "@/src/world/marina";
import { MARINA_LAYOUT, marinaToWorld, type MarinaLayout } from "@/src/world/marinaLayout";

/**
 * A stand-in hull for the marina's loads until the Runabout's own simulator is
 * wired: the design boat's mass and inertia on a RigidBody, linear
 * hydrostatic springs in heave, roll and pitch, quadratic water drag in the
 * plane, and windage. Its job is to carry the mooring and contact loads the
 * way the real hull will (through the same load context), not to be a boat.
 */
const MASS = 1_800;
const G = 9.81;
const RHO_WATER = 1_025;
const RHO_AIR = 1.225;

class StandInHull implements MooringLoadContext {
  readonly body: RigidBody;
  time = 0;
  dt = 1 / 240;
  wind: Vec3 = { x: 0, y: 0, z: 0 };
  private readonly loads: { apply(context: MooringLoadContext): void }[] = [];
  private readonly scratch: Vec3 = { x: 0, y: 0, z: 0 };
  private readonly scratch2: Vec3 = { x: 0, y: 0, z: 0 };

  constructor(readonly stillWaterY: number, x: number, z: number, heading: number) {
    this.body = new RigidBody({
      mass: MASS,
      inertia: { xx: 1_900, yy: 6_400, zz: 6_000 },
      position: { x, y: stillWaterY + RUNABOUT_21_CG_ABOVE_WATER, z },
      orientation: quaternionFromFlightAngles(heading, 0, 0),
    });
  }

  get position() { return this.body.position; }
  get orientation() { return this.body.orientation; }
  get velocity() { return this.body.velocity; }
  get angularVelocity() { return this.body.angularVelocity; }

  addLoad(load: { apply(context: MooringLoadContext): void }): void {
    this.loads.push(load);
  }

  cleatWorld(index: number, out: Vec3): Vec3 {
    return this.body.bodyToWorldPoint(RUNABOUT_21_CLEATS_BODY[index]!, out);
  }

  cleatVelocity(index: number, out: Vec3): Vec3 {
    this.cleatWorld(index, this.scratch2);
    return this.body.pointVelocity(this.scratch2, out);
  }

  pointVelocity(worldPoint: Readonly<Vec3>, out: Vec3): Vec3 {
    return this.body.pointVelocity(worldPoint as Vec3, out);
  }

  addForceAtWorldPoint(force: Readonly<Vec3>, point: Readonly<Vec3>): void {
    this.body.addForceAtWorldPoint(force as Vec3, point as Vec3);
  }

  heading(): number {
    const forward = rotateVectorInto(this.scratch, this.body.orientation, { x: 1, y: 0, z: 0 });
    return Math.atan2(forward.x, forward.z);
  }

  /** One 240 Hz substep: hydrostatics, drag, wind, then the external loads. */
  substep(): void {
    const body = this.body;
    const v = body.velocity;
    const rest = this.stillWaterY + RUNABOUT_21_CG_ABOVE_WATER;
    // Heave: weight against a linear waterplane spring, damped.
    const heaveK = RHO_WATER * G * 10.5;
    body.addForce({ x: 0, y: -heaveK * (body.position.y - rest) - 8_000 * v.y, z: 0 });
    // Roll and pitch: restoring torques from the body's up vector, damped.
    const up = rotateVectorInto(this.scratch, body.orientation, { x: 0, y: 1, z: 0 });
    const w = body.angularVelocity;
    const forward = rotateVectorInto({ x: 0, y: 0, z: 0 }, body.orientation, { x: 1, y: 0, z: 0 });
    const starboard = rotateVectorInto({ x: 0, y: 0, z: 0 }, body.orientation, { x: 0, y: 0, z: 1 });
    const rollAngle = Math.asin(Math.max(-1, Math.min(1, up.x * starboard.x + up.y * starboard.y + up.z * starboard.z))) * -1;
    const pitchAngle = Math.asin(Math.max(-1, Math.min(1, forward.y)));
    body.addTorqueBody({ x: -MASS * G * 1.2 * Math.sin(-rollAngle) - 6_000 * w.x, y: -4_000 * w.y, z: -MASS * G * 8 * Math.sin(pitchAngle) - 20_000 * w.z });
    // Water drag in the body plane: surge and sway, quadratic plus a little linear.
    const surge = v.x * forward.x + v.z * forward.z;
    const sway = v.x * starboard.x + v.z * starboard.z;
    const fSurge = -(300 * surge + 0.5 * RHO_WATER * 1 * 1 * surge * Math.abs(surge));
    const fSway = -(800 * sway + 0.5 * RHO_WATER * 1 * 2.4 * sway * Math.abs(sway));
    body.addForce({ x: forward.x * fSurge + starboard.x * fSway, y: 0, z: forward.z * fSurge + starboard.z * fSway });
    // Windage on the projected area, at the topsides' centre.
    const rx = this.wind.x - v.x;
    const rz = this.wind.z - v.z;
    const speed = Math.hypot(rx, rz);
    if (speed > 0) {
      const along = Math.abs((rx * forward.x + rz * forward.z) / speed);
      const across = Math.abs((rx * starboard.x + rz * starboard.z) / speed);
      const area = along * 3.4 + across * 7.2;
      const magnitude = 0.5 * RHO_AIR * 1.0 * area * speed * speed;
      const point = body.bodyToWorldPoint({ x: 0.4, y: 0.6, z: 0 }, { x: 0, y: 0, z: 0 });
      body.addForceAtWorldPoint({ x: (rx / speed) * magnitude, y: 0, z: (rz / speed) * magnitude }, point);
    }
    for (const load of this.loads) load.apply(this);
    body.step(this.dt);
    this.time += this.dt;
  }
}

/** Still water everywhere, or a long swell scaled by a calm-basin floor. */
class TestSea implements WaterSurfaceAuthority {
  time = 0;
  constructor(private readonly seaLevel: number, private readonly amplitude = 0, private readonly period = 6) {}
  setTime(time: number): void {
    this.time = time;
  }
  sample(x: number, z: number, out: WaterSurfaceSample): WaterSurfaceSample {
    const k = (4 * Math.PI * Math.PI) / (G * this.period * this.period);
    const omega = (2 * Math.PI) / this.period;
    const phase = k * (x + 0.3 * z) - omega * this.time;
    out.kind = "sea";
    out.stillHeight = this.seaLevel;
    out.height = this.seaLevel + this.amplitude * Math.cos(phase);
    out.velocity.x = 0;
    out.velocity.y = this.amplitude * omega * Math.sin(phase);
    out.velocity.z = 0;
    const slope = -this.amplitude * k * Math.sin(phase);
    const length = Math.hypot(slope, 1, 0.3 * slope);
    out.normal.x = -slope / length;
    out.normal.y = 1 / length;
    out.normal.z = (-0.3 * slope) / length;
    out.depth = 5;
    return out;
  }
}

const CALM: BoatControlState = { lever: 0, steer: 0, trim: 0, tabs: 0, moorPresses: 0 };

function moored(layout: MarinaLayout, wind: Vec3) {
  const w = createWorld("open-skies");
  const pose = marinaStartPose(w);
  const colliders = new ColliderWorld();
  const marina = addMarinaColliders(colliders, layout);
  const hull = new StandInHull(pose.stillWaterY, pose.x, pose.z, pose.headingRadians);
  hull.wind = wind;
  const mooring = new Mooring(layout, colliders, marina);
  mooring.makeFast(layout.startBerth, pose.headingRadians, (index, out) => hull.cleatWorld(index, out));
  hull.addLoad(mooring);
  const contact = new MarinaContactLoad(colliders);
  hull.addLoad(contact);
  return { hull, mooring, contact, pose, colliders, marina };
}

describe("home marina mooring", () => {
  const layout = homeMarina(createWorld("open-skies"));

  it("starts moored with no line force and no contact", () => {
    const { hull, mooring, contact, pose } = moored(layout, { x: 0, y: 0, z: 0 });
    expect(mooring.state).toBe("moored");
    for (const stretch of mooring.lineStretches((i, out) => hull.cleatWorld(i, out))) expect(Math.abs(stretch)).toBeLessThan(1e-9);
    let peak = 0;
    for (let step = 0; step < 240 * 5; step += 1) {
      hull.substep();
      peak = Math.max(peak, Math.hypot(hull.body.linearAcceleration.x, hull.body.linearAcceleration.z));
      expect(contact.touching, `contact at ${hull.time.toFixed(2)} s`).toBe(0);
    }
    expect(peak).toBeLessThan(1e-6);
    expect(Math.hypot(hull.position.x - pose.x, hull.position.z - pose.z)).toBeLessThan(1e-6);
  });

  it("holds the boat within 0.5 m in an 11 m/s wind from any direction", () => {
    for (let index = 0; index < 8; index += 1) {
      const angle = (index / 8) * Math.PI * 2;
      const { hull, contact, pose } = moored(layout, { x: Math.sin(angle) * 11, y: 0, z: Math.cos(angle) * 11 });
      let worst = 0;
      for (let step = 0; step < 240 * 60; step += 1) {
        hull.substep();
        worst = Math.max(worst, Math.hypot(hull.position.x - pose.x, hull.position.z - pose.z));
      }
      expect(worst, `wind from ${(angle * 180 / Math.PI).toFixed(0)} deg`).toBeLessThan(0.5);
      expect(contact.crashed).toBe(false);
    }
  });

  it("makes fast within 1.5 m below 0.6 m/s, and casts off on M or into gear", () => {
    const w = createWorld("open-skies");
    const pose = marinaStartPose(w);
    const mooring = new Mooring(layout);
    const berth = layout.startBerth;
    const centre = marinaToWorld(layout.frame, berth.right, berth.out);
    const hull = new StandInHull(pose.stillWaterY, centre.x + 1.2, centre.z, pose.headingRadians);
    const cleats = (i: number, out: Vec3) => hull.cleatWorld(i, out);
    const still = { x: 0, y: 0, z: 0 };
    // The first update only latches the press counter.
    mooring.update(CALM, false, hull.position, still, pose.headingRadians, cleats);
    expect(mooring.state).toBe("free");
    mooring.update({ ...CALM, moorPresses: 1 }, false, hull.position, { x: 0.7, y: 0, z: 0 }, pose.headingRadians, cleats);
    expect(mooring.state, "too fast").toBe("free");
    mooring.update({ ...CALM, moorPresses: 2 }, false, hull.position, still, pose.headingRadians, cleats);
    expect(mooring.state).toBe("moored");
    expect(mooring.berth).toBe(berth);
    mooring.update({ ...CALM, moorPresses: 3 }, false, hull.position, still, pose.headingRadians, cleats);
    expect(mooring.state, "M casts off").toBe("free");
    mooring.update({ ...CALM, moorPresses: 4 }, false, hull.position, still, pose.headingRadians, cleats);
    expect(mooring.state).toBe("moored");
    mooring.update({ ...CALM, moorPresses: 4, lever: 0.3 }, false, hull.position, still, pose.headingRadians, cleats);
    expect(mooring.state, "into gear casts off").toBe("free");
    // Out of range: nothing to make fast to.
    const far = { x: centre.x + 2, y: 0, z: centre.z };
    mooring.update({ ...CALM, moorPresses: 5 }, false, far, still, pose.headingRadians, cleats);
    expect(mooring.state).toBe("free");
  });

  it("moors on its own in Scenic, but not straight back into the berth it just left", () => {
    const w = createWorld("open-skies");
    const pose = marinaStartPose(w);
    const mooring = new Mooring(layout);
    const berth = layout.startBerth;
    const centre = marinaToWorld(layout.frame, berth.right, berth.out);
    const hull = new StandInHull(pose.stillWaterY, centre.x, centre.z, pose.headingRadians);
    const cleats = (i: number, out: Vec3) => hull.cleatWorld(i, out);
    const still = { x: 0, y: 0, z: 0 };
    mooring.update(CALM, true, hull.position, still, pose.headingRadians, cleats);
    expect(mooring.state).toBe("moored");
    mooring.update({ ...CALM, lever: 0.2 }, true, hull.position, still, pose.headingRadians, cleats);
    expect(mooring.state).toBe("free");
    // Back in neutral but still in the berth: stays free until it has left.
    mooring.update(CALM, true, hull.position, still, pose.headingRadians, cleats);
    expect(mooring.state).toBe("free");
    const away = { x: centre.x + Math.sin(pose.headingRadians) * 6, y: 0, z: centre.z + Math.cos(pose.headingRadians) * 6 };
    mooring.update(CALM, true, away, still, pose.headingRadians, cleats);
    mooring.update(CALM, true, hull.position, still, pose.headingRadians, cleats);
    expect(mooring.state).toBe("moored");
  });

  it("hauls a boat made fast off its mark back onto it without a jolt", () => {
    const w = createWorld("open-skies");
    const pose = marinaStartPose(w);
    const colliders = new ColliderWorld();
    const marina = addMarinaColliders(colliders, layout);
    const berth = layout.startBerth;
    const centre = marinaToWorld(layout.frame, berth.right, berth.out);
    const starboardX = -Math.cos(pose.headingRadians);
    const starboardZ = Math.sin(pose.headingRadians);
    const hull = new StandInHull(pose.stillWaterY, centre.x + starboardX * 0.3, centre.z + starboardZ * 0.3, pose.headingRadians);
    const mooring = new Mooring(layout, colliders, marina);
    mooring.makeFast(berth, pose.headingRadians, (i, out) => hull.cleatWorld(i, out));
    hull.addLoad(mooring);
    let peak = 0;
    for (let step = 0; step < 240 * 30; step += 1) {
      hull.substep();
      peak = Math.max(peak, Math.hypot(hull.body.linearAcceleration.x, hull.body.linearAcceleration.z));
    }
    expect(Math.hypot(hull.position.x - centre.x, hull.position.z - centre.z)).toBeLessThan(0.1);
    expect(peak, "haul-in acceleration").toBeLessThan(0.5);
  });

  it("parts a line pulled past its breaking load", () => {
    const { hull, mooring } = moored(layout, { x: 0, y: 0, z: 0 });
    const forwardX = Math.sin(hull.heading());
    const forwardZ = Math.cos(hull.heading());
    // Far past any outboard's bollard pull: a push only a collision gives.
    for (let step = 0; step < 240 * 20 && mooring.state === "moored"; step += 1) {
      hull.body.addForce({ x: forwardX * 150_000, y: 0, z: forwardZ * 150_000 });
      hull.substep();
    }
    expect(mooring.state).toBe("free");
    expect(mooring.parted).toBe(true);
  });
});

describe("home marina structures", () => {
  const layout = homeMarina(createWorld("open-skies"));

  /** A lone timber pile of the marina's size, hit beam-on with the hull's side 5 cm off it. */
  function ram(speed: number) {
    const colliders = new ColliderWorld();
    const pile = layout.posts.find((post) => post.kind === "pile")!;
    colliders.addStatic(
      { kind: "capsule", a: { x: 0, y: pile.bottomY, z: 0 }, b: { x: 0, y: pile.topY, z: 0 }, radius: pile.radius },
      { material: MARINA_COLLIDER_MATERIAL.timber },
    );
    const touchingDistance = MARINA_LAYOUT.boatBeam / 2 + pile.radius;
    // Heading 0 points the bow along +Z, so starboard is -X: the starboard side meets the pile.
    const hull = new StandInHull(layout.seaLevel, touchingDistance + 0.05, 0, 0);
    hull.body.velocity.x = -speed;
    const contact = new MarinaContactLoad(colliders);
    hull.addLoad(contact);
    let touched = false;
    let closest = Infinity;
    for (let step = 0; step < 240 * 6; step += 1) {
      hull.substep();
      if (contact.touching > 0) touched = true;
      closest = Math.min(closest, hull.position.x);
    }
    return { contact, touched, along: -hull.velocity.x, squeeze: touchingDistance - closest };
  }

  it("crashes on a fast hit on a pile and fends off a slow one", () => {
    const fast = ram(4);
    expect(fast.touched).toBe(true);
    expect(fast.contact.crashed).toBe(true);
    const slow = ram(0.8);
    expect(slow.touched).toBe(true);
    expect(slow.contact.crashed).toBe(false);
    // Fended off: the pile dents the strake by centimetres, and the boat is no longer driving into it.
    expect(slow.squeeze).toBeLessThan(0.08);
    expect(slow.along).toBeLessThan(0.05);
  });

  it("rides the pontoons on the sea as kinematic colliders", () => {
    const colliders = new ColliderWorld();
    const marina = addMarinaColliders(colliders, layout);
    const sea = new TestSea(layout.seaLevel, 0.3, 6);
    const sample = createWaterSurfaceSample();
    const pose = createMarinaPontoonPose();
    const centre: Vec3 = { x: 0, y: 0, z: 0 };
    for (const time of [0, 1.3, 2.9]) {
      sea.setTime(time);
      poseMarinaPontoons(colliders, marina, sea);
      for (const pontoon of marina.pontoons) {
        colliders.localToWorld(pontoon.handle, { x: 0, y: 0, z: 0 }, centre);
        sea.sample(pontoon.x, pontoon.z, sample);
        expect(centre.y).toBeCloseTo(sample.height + pontoon.restOffset, 9);
        // The renderer's pose function gives the same answer.
        marinaPontoonPose(pontoon.x, pontoon.z, pontoon.restOffset, pontoon.yaw, sample, pose);
        expect(pose.position.y).toBe(centre.y);
      }
    }
    expect(marina.pontoons.length).toBe(layout.boxes.filter((box) => box.kind === "pontoon" || box.kind === "finger").length);
  });

  it("builds a static collider for every pile, post, deck, wall and building", () => {
    const colliders = new ColliderWorld();
    const marina = addMarinaColliders(colliders, layout);
    const piles = layout.posts.filter((post) => ["pile", "guidePile", "beaconPost", "lampPost"].includes(post.kind)).length;
    const boxes = layout.boxes.filter((box) => !["pontoon", "finger", "lifeRingStand", "fuelPump"].includes(box.kind)).length;
    expect(marina.staticHandles.length).toBe(piles + boxes);
    expect(colliders.size).toBe(piles + boxes + marina.pontoons.length);
    expect(MOORING.makeFastRadius).toBe(1.5);
  });
});
