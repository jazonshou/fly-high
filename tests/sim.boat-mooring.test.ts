import { describe, expect, it } from "vitest";
import type { BoatControlState } from "@/src/game/types";
import { BoatSimulator } from "@/src/sim/boat";
import { ColliderWorld, type ColliderContact } from "@/src/sim/colliders";
import {
  addMarinaColliders,
  createMarinaPontoonPose,
  MARINA_COLLIDER_MATERIAL,
  MARINA_CONTACT_MATERIALS,
  marinaPontoonPose,
  poseMarinaPontoons,
  type MarinaColliders,
} from "@/src/sim/marina/colliders";
import { MarinaHarbour } from "@/src/sim/marina/harbour";
import { Mooring, MOORING } from "@/src/sim/marina/mooring";
import { NEUTRAL_BOAT_CONTROLS, type SurfaceVehicleEnvironment } from "@/src/sim/surface";
import type { Vec3 } from "@/src/sim/types";
import { CalmWaterSurface } from "@/src/sim/water";
import { createWaterSurfaceSample, type WaterSurfaceAuthority, type WaterSurfaceSample } from "@/src/sim/water/types";
import { createWorld, sampleTerrainHeight, type WorldDefinition } from "@/src/world";
import { homeMarina, marinaStartPose } from "@/src/world/marina";
import { MARINA_MOORED_BOAT_BOX, marinaToWorld, type MarinaLayout } from "@/src/world/marinaLayout";

/**
 * The home marina's lines and structures with the Runabout's own simulator:
 * the dock start on 40 worlds (no jolt, no contact), the lines holding in a
 * gale, making fast and casting off, and the boat's hull probes against the
 * marina's colliders (a fast hit on a pile wrecks it, a slow one fends off).
 */

const STEP = 1 / 120;
const G = 9.80665;

/** Counts every collider contact the boat's probes find, by material. */
class CountingColliders extends ColliderWorld {
  touches = 0;
  readonly byMaterial = new Map<number, number>();
  override contactSphere(handle: number, center: Vec3, radius: number, out: ColliderContact): boolean {
    const hit = super.contactSphere(handle, center, radius, out);
    if (hit && out.penetration > 0) {
      this.touches += 1;
      this.byMaterial.set(out.material, (this.byMaterial.get(out.material) ?? 0) + 1);
    }
    return hit;
  }
}

/** A long swell, for the pontoons. */
class Swell implements WaterSurfaceAuthority {
  private time = 0;
  constructor(private readonly seaLevel: number, private readonly amplitude: number, private readonly period: number) {}
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

interface Dock {
  readonly world: WorldDefinition;
  readonly layout: MarinaLayout;
  readonly sim: BoatSimulator;
  readonly harbour: MarinaHarbour;
  readonly mooring: Mooring;
  readonly colliders: CountingColliders;
  readonly marina: MarinaColliders;
  readonly water: WaterSurfaceAuthority;
  controls: BoatControlState;
  scenic: boolean;
  cleatWorld(index: number, out: Vec3): Vec3;
  heading(): number;
  /** One fixed step, in the worker's order (`stepSurface`). */
  step(): void;
}

/** A boat at the dock start, moored through the worker's own wiring (`MarinaHarbour`). */
function dockStart(world: WorldDefinition, wind: Vec3 = { x: 0, y: 0, z: 0 }): Dock {
  const layout = homeMarina(world);
  const pose = marinaStartPose(world);
  const colliders = new CountingColliders();
  const bedHeight = (x: number, z: number) => sampleTerrainHeight(world, x, z);
  const water: WaterSurfaceAuthority = new CalmWaterSurface(layout.seaLevel, bedHeight);
  const sim = new BoatSimulator({ position: { x: pose.x, y: pose.stillWaterY, z: pose.z }, heading: pose.headingRadians, moored: true });
  const environment: SurfaceVehicleEnvironment = { water, wind, bedHeight, gravity: G };
  const harbour = new MarinaHarbour(world, sim, colliders);
  harbour.makeFastAtStart(world);
  const cleatWorld = (index: number, out: Vec3) => sim.body.bodyToWorldPoint(sim.cleatsBody[index]! as Vec3, out);
  const forward: Vec3 = { x: 0, y: 0, z: 0 };
  const heading = () => {
    sim.body.bodyToWorldPoint({ x: 1, y: 0, z: 0 }, forward);
    return Math.atan2(forward.x - sim.body.position.x, forward.z - sim.body.position.z);
  };
  const dock: Dock = {
    world, layout, sim, harbour, mooring: harbour.mooring, colliders, marina: harbour.marina, water,
    controls: { ...NEUTRAL_BOAT_CONTROLS },
    scenic: false,
    cleatWorld,
    heading,
    step() {
      water.setTime(sim.state.time);
      sim.setControls({ assist: dock.scenic ? "scenic" : "pilot", boat: dock.controls });
      sim.setEnvironment(environment);
      harbour.beforeStep(dock.controls, dock.scenic, environment);
      sim.step(STEP);
      harbour.afterStep();
    },
  };
  return dock;
}

/** The plan probe's seed sequence (tests/world.marina-site.test.ts). */
function seeds(count: number): (string | number)[] {
  const out: (string | number)[] = ["open-skies"];
  let state = 0x51a7e;
  while (out.length < count) {
    state = (Math.imul(state ^ (state >>> 15), 0x2c1b3c6d) + 0x9e3779b9) >>> 0;
    out.push(state);
  }
  return out;
}

/** The dock start's worlds, in four groups of ten: each group is about 25 s of stepping on its own. */
const DOCK_START_SEEDS = seeds(40);
const DOCK_START_GROUP = 10;

describe("the dock start", () => {
  for (let first = 0; first < DOCK_START_SEEDS.length; first += DOCK_START_GROUP) {
    const group = DOCK_START_SEEDS.slice(first, first + DOCK_START_GROUP);
    it(`settles with no jolt and no contact for 5 s (worlds ${first + 1}-${first + group.length} of ${DOCK_START_SEEDS.length})`, { timeout: 240_000 }, () => {
      dockStartChecks(group);
    });
  }
});

function dockStartChecks(group: readonly (string | number)[]): void {
  for (const seed of group) {
    const dock = dockStart(createWorld(seed));
    const start = { x: dock.sim.state.position.x, z: dock.sim.state.position.z };
    let peak = 0;
    let previous = { x: 0, z: 0 };
    for (let step = 0; step < 120 * 5; step += 1) {
      dock.step();
      const v = dock.sim.state.velocity;
      if (step > 0) peak = Math.max(peak, Math.hypot(v.x - previous.x, v.z - previous.z) / STEP);
      previous = { x: v.x, z: v.z };
    }
    const label = String(seed);
    expect(dock.colliders.touches, `${label}: contact`).toBe(0);
    expect(dock.sim.state.crashed, label).toBe(false);
    expect(dock.mooring.state, label).toBe("moored");
    expect(dock.sim.snapshot().payload.moored, label).toBe(true);
    expect(peak, `${label}: horizontal acceleration`).toBeLessThan(0.05);
    expect(Math.hypot(dock.sim.state.position.x - start.x, dock.sim.state.position.z - start.z), label).toBeLessThan(0.05);
  }
}

describe("home marina mooring", () => {
  const world = createWorld("open-skies");
  const layout = homeMarina(world);

  it("holds the boat within 0.5 m in an 11 m/s wind from any side, touching nothing hard", { timeout: 300_000 }, () => {
    for (let index = 0; index < 8; index += 1) {
      const angle = (index / 8) * Math.PI * 2;
      const dock = dockStart(world, { x: Math.sin(angle) * 11, y: 0, z: Math.cos(angle) * 11 });
      const mark = marinaToWorld(layout.frame, layout.startBerth.right, layout.startBerth.out);
      let worst = 0;
      for (let step = 0; step < 120 * 30; step += 1) {
        dock.step();
        worst = Math.max(worst, Math.hypot(dock.sim.state.position.x - mark.x, dock.sim.state.position.z - mark.z));
      }
      const label = `wind from ${((angle * 180) / Math.PI).toFixed(0)} deg`;
      expect(worst, label).toBeLessThan(0.5);
      expect(dock.mooring.state, label).toBe("moored");
      expect(dock.sim.state.crashed, label).toBe(false);
    }
  });

  it("makes fast within 1.5 m below 0.6 m/s, and casts off on M or into gear", () => {
    const mooring = new Mooring(layout);
    const berth = layout.startBerth;
    const centre = marinaToWorld(layout.frame, berth.right, berth.out);
    const at = { x: centre.x + 1.2, y: 0, z: centre.z };
    const heading = berth.bowHeadingRadians;
    const cleats = (_index: number, out: Vec3) => {
      out.x = at.x;
      out.y = 0.7;
      out.z = at.z;
      return out;
    };
    const still = { x: 0, y: 0, z: 0 };
    const press = (presses: number, extra: Partial<BoatControlState> = {}, position: Vec3 = at, velocity: Vec3 = still) =>
      mooring.update({ ...NEUTRAL_BOAT_CONTROLS, moorPresses: presses, ...extra }, false, position, velocity, heading, cleats);
    // The first update only latches the press counter.
    press(0);
    expect(mooring.state).toBe("free");
    press(1, {}, at, { x: 0.7, y: 0, z: 0 });
    expect(mooring.state, "too fast").toBe("free");
    press(2);
    expect(mooring.state).toBe("moored");
    expect(mooring.berth).toBe(berth);
    press(3);
    expect(mooring.state, "M casts off").toBe("free");
    press(4);
    expect(mooring.state).toBe("moored");
    // Inside the shift detent it stays fast; into gear it casts off.
    press(4, { lever: 0.04 });
    expect(mooring.state, "lever inside the detent").toBe("moored");
    press(4, { lever: 0.3 });
    expect(mooring.state, "into gear casts off").toBe("free");
    press(5, {}, { x: centre.x + 2, y: 0, z: centre.z });
    expect(mooring.state, "out of range").toBe("free");
  });

  it("moors on its own in Scenic, but not straight back into the berth it just left", () => {
    const mooring = new Mooring(layout);
    const berth = layout.startBerth;
    const centre = marinaToWorld(layout.frame, berth.right, berth.out);
    const here = { x: centre.x, y: 0, z: centre.z };
    const heading = berth.bowHeadingRadians;
    const cleats = (_index: number, out: Vec3) => Object.assign(out, here);
    const still = { x: 0, y: 0, z: 0 };
    mooring.update(NEUTRAL_BOAT_CONTROLS, true, here, still, heading, cleats);
    expect(mooring.state).toBe("moored");
    mooring.update({ ...NEUTRAL_BOAT_CONTROLS, lever: 0.2 }, true, here, still, heading, cleats);
    expect(mooring.state).toBe("free");
    // Back in neutral but still in the berth: stays free until it has left.
    mooring.update(NEUTRAL_BOAT_CONTROLS, true, here, still, heading, cleats);
    expect(mooring.state).toBe("free");
    const away = { x: centre.x + Math.sin(heading) * 6, y: 0, z: centre.z + Math.cos(heading) * 6 };
    mooring.update(NEUTRAL_BOAT_CONTROLS, true, away, still, heading, cleats);
    mooring.update(NEUTRAL_BOAT_CONTROLS, true, here, still, heading, cleats);
    expect(mooring.state).toBe("moored");
  });

  it("casts off and gets under way when the lever goes into gear", () => {
    const dock = dockStart(world);
    for (let step = 0; step < 120; step += 1) dock.step();
    dock.controls = { ...NEUTRAL_BOAT_CONTROLS, lever: 0.4 };
    for (let step = 0; step < 120 * 4; step += 1) dock.step();
    expect(dock.mooring.state).toBe("free");
    expect(dock.sim.snapshot().payload.moored).toBe(false);
    const berth = marinaToWorld(layout.frame, layout.startBerth.right, layout.startBerth.out);
    // Out along the lane, bow first, and clear of every structure.
    const forward = { x: Math.sin(layout.startBerth.bowHeadingRadians), z: Math.cos(layout.startBerth.bowHeadingRadians) };
    const made = (dock.sim.state.position.x - berth.x) * forward.x + (dock.sim.state.position.z - berth.z) * forward.z;
    expect(made).toBeGreaterThan(3);
    expect(dock.sim.state.crashed).toBe(false);
  });

  it("parts a line pulled past its breaking load", () => {
    const dock = dockStart(world);
    const forward = { x: Math.sin(layout.startBerth.bowHeadingRadians), z: Math.cos(layout.startBerth.bowHeadingRadians) };
    // Far past any outboard's bollard pull: a push only a collision gives.
    const push = {
      apply(context: { addForceAtWorldPoint(force: Vec3, point: Vec3): void; position: Readonly<Vec3> }) {
        context.addForceAtWorldPoint({ x: forward.x * 150_000, y: 0, z: forward.z * 150_000 }, context.position as Vec3);
      },
    };
    dock.sim.addExternalLoad(push);
    for (let step = 0; step < 120 * 10 && dock.mooring.state === "moored"; step += 1) dock.step();
    expect(dock.mooring.state).toBe("free");
    expect(dock.mooring.parted).toBe(true);
  });
});

describe("home marina structures", () => {
  const world = createWorld("open-skies");
  const layout = homeMarina(world);

  /**
   * The boat's starboard side driven beam-on at `speed` into one lone marina
   * part, under the marina's contact law: a timber pile of the marina's size,
   * or a pontoon module's fendered side.
   */
  function ram(speed: number, target: "pile" | "pontoon" | "moored boat") {
    const colliders = new CountingColliders();
    if (target === "moored boat") {
      // A moored runabout's box, lying alongside with its side at x = 0.
      const B = MARINA_MOORED_BOAT_BOX;
      colliders.addStatic(
        { kind: "box", center: { x: 0, y: 0, z: 0 }, halfExtents: { x: B.beam / 2, y: (B.bottomBelowWater + B.topAboveWater) / 2, z: B.length / 2 } },
        { material: MARINA_COLLIDER_MATERIAL.hull, position: { x: -B.beam / 2, y: (B.topAboveWater - B.bottomBelowWater) / 2, z: 0 } },
      );
    } else if (target === "pile") {
      const pile = layout.posts.find((post) => post.kind === "pile")!;
      colliders.addStatic(
        { kind: "capsule", a: { x: 0, y: -4, z: 0 }, b: { x: 0, y: 3, z: 0 }, radius: pile.radius },
        { material: MARINA_COLLIDER_MATERIAL.timber },
      );
    } else {
      // A module's 2.4 m width across x, its 12 m length along z, freeboard 0.5 m.
      colliders.addStatic(
        { kind: "box", center: { x: 0, y: 0, z: 0 }, halfExtents: { x: 1.2, y: 0.55, z: 6 } },
        { material: MARINA_COLLIDER_MATERIAL.pontoon, position: { x: -1.2, y: -0.05, z: 0 } },
      );
    }
    // Heading 0 points the bow along +Z, so starboard is -X: the starboard side meets the target.
    const sim = new BoatSimulator({ position: { x: 1.6, y: 0, z: 0.5 }, heading: 0, moored: false });
    sim.setEnvironment({
      water: new CalmWaterSurface(0, () => -10),
      wind: { x: 0, y: 0, z: 0 },
      bedHeight: () => -10,
      gravity: G,
      colliders,
      contactMaterials: MARINA_CONTACT_MATERIALS,
    });
    sim.setControls({ assist: "pilot", boat: { ...NEUTRAL_BOAT_CONTROLS } });
    sim.body.velocity.x = -speed;
    let touched = 0;
    for (let step = 0; step < 120 * 4; step += 1) {
      const before = colliders.touches;
      sim.step(STEP);
      if (colliders.touches > before) touched += 1;
    }
    return { crashed: sim.state.crashed, touched, along: -sim.body.velocity.x };
  }

  it("wrecks the boat on a fast hit on a pile and fends off a slow one", () => {
    const fast = ram(4, "pile");
    expect(fast.touched).toBeGreaterThan(0);
    expect(fast.crashed).toBe(true);
    const slow = ram(0.8, "pile");
    expect(slow.touched).toBeGreaterThan(0);
    expect(slow.crashed).toBe(false);
    // Fended off: no longer driving into the pile.
    expect(slow.along).toBeLessThan(0.05);
  });

  it("takes a harder knock on a fendered pontoon than on a bare pile", () => {
    // 3 m/s: past a pile's 2.5 m/s, inside a pontoon's 4 m/s.
    expect(ram(3, "pile").crashed).toBe(true);
    const knock = ram(3, "pontoon");
    expect(knock.touched).toBeGreaterThan(0);
    expect(knock.crashed).toBe(false);
    expect(knock.along).toBeLessThan(0.05);
    expect(ram(5, "pontoon").crashed).toBe(true);
  });

  it("wrecks the boat ramming a moored one and fends off a nudge", () => {
    const fast = ram(4, "moored boat");
    expect(fast.touched).toBeGreaterThan(0);
    expect(fast.crashed).toBe(true);
    const slow = ram(1.5, "moored boat");
    expect(slow.touched).toBeGreaterThan(0);
    expect(slow.crashed).toBe(false);
    expect(slow.along).toBeLessThan(0.05);
  });

  it("rides the pontoons on the sea as kinematic colliders", () => {
    const colliders = new ColliderWorld();
    const marina = addMarinaColliders(colliders, layout);
    const sea = new Swell(layout.seaLevel, 0.3, 6);
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

  it("builds a static collider for every pile, post, deck, wall, building and moored boat", () => {
    const colliders = new ColliderWorld();
    const marina = addMarinaColliders(colliders, layout);
    const piles = layout.posts.filter((post) => ["pile", "guidePile", "beaconPost", "lampPost"].includes(post.kind)).length;
    const boxes = layout.boxes.filter((box) => !["pontoon", "finger", "lifeRingStand", "fuelPump"].includes(box.kind)).length;
    const moored = layout.berths.filter((berth) => berth.occupied).length;
    expect(moored).toBeGreaterThan(0);
    expect(marina.staticHandles.length).toBe(piles + boxes + moored);
    expect(colliders.size).toBe(piles + boxes + moored + marina.pontoons.length);
    expect(MOORING.makeFastRadius).toBe(1.5);
  });
});
