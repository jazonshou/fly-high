import { describe, expect, it } from "vitest";
import { HANGAR_SITING } from "../src/render/webgpu/airfield/AirfieldSiting";
import { hangarSite, towerSite } from "../src/render/webgpu/airfield/AirfieldPlacement";
import { buildTowerGeometry } from "../src/render/webgpu/detail/towerGeometry";
import { FUEL_TANK_RADIUS_METERS, fuelTankPlacements } from "../src/render/webgpu/detail/AirfieldFurniture";
import { ColliderWorld, createColliderContact } from "../src/sim/colliders";
import {
  CAR_COLLIDER_MATERIAL,
  CarColliders,
  GUARDRAIL_DEPTH,
  guardrailColliders,
  regionColliders,
} from "../src/sim/ground/carColliders";
import { GroundVehicleSimulator } from "../src/sim/ground";
import { CRASH_IMPACT_SPEED } from "../src/sim/ground/groundVehicle";
import { rotateVectorInto } from "../src/sim/math";
import { sampleGroundHeight } from "../src/sim/terrainGrid";
import type { Vec3 } from "../src/sim/types";
import { CalmWaterSurface } from "../src/sim/water/calmWater";
import { LANDCRUISER_76 } from "../src/vehicles/landcruiser76";
import { runwayToWorld } from "../src/world/airport";
import { withAirports } from "../src/world/airportNetwork";
import type { InfrastructureRegion } from "../src/world/infrastructure";
import { homeMarina } from "../src/world/marina";
import { marinaToWorld } from "../src/world/marinaLayout";
import type { WorldDefinition } from "../src/world/types";
import { roadRegionInfrastructure } from "../src/world/roads/roadInfrastructure";
import { RoadNetwork, roadRegionOf } from "../src/world/roads/roadNetwork";
import { airportRoadHead } from "../src/world/roads/roadNodes";
import { createWorld } from "../src/world/world";
import { controls, FLAT, headingOf, speedOf, STEP } from "./support/carRig";

/**
 * The colliders a car meets (land plan, "What the car reads from the
 * world"): the airports' buildings and the marina's where they are drawn,
 * the roads' guardrails per streamed region, and the hull against them:
 * impacts and the guardrail redirect.
 */

const DEG = Math.PI / 180;
const WORLD = createWorld(20_260_310);
const ground = (x: number, z: number): number => sampleGroundHeight(WORLD, x, z);
const contact = createColliderContact();

function touches(colliders: ColliderWorld, point: Readonly<Vec3>, radius = 0.05): boolean {
  return colliders.deepestSphereContact(point, radius, contact) && contact.penetration > 0;
}

/** A runway-local point (along, across) of a hangar's node frame turned by its yaw, as `AirportSystem` turns the node. */
function hangarPoint(world: WorldDefinition, index: number, x: number, z: number, y: number): Vec3 {
  const airport = world.airport!;
  const site = hangarSite(airport, index, world.seedHash, ground);
  const c = Math.cos(site.yawRadians);
  const s = Math.sin(site.yawRadians);
  // Babylon's rotation.y: x' = x c + z s, z' = -x s + z c, with node x across and z along.
  const across = site.position[0] + x * c + z * s;
  const along = site.position[2] - x * s + z * c;
  const at = runwayToWorld(airport, along, across);
  return { x: at.x, y: airport.elevation + site.position[1] + y, z: at.z };
}

describe("car colliders: the airports and the marina", () => {
  const car = new CarColliders(WORLD, ground);
  const colliders = car.colliders;

  it("stands each hangar's walls where the renderer seats the hangar, turned by its yaw", () => {
    for (let index = 0; index < HANGAR_SITING.count; index += 1) {
      const site = hangarSite(WORLD.airport!, index, WORLD.seedHash, ground);
      const halfX = site.plan.widthMeters / 2;
      const halfZ = site.plan.depthMeters / 2;
      // A metre up the walls: just inside every wall touches, just outside none does.
      for (const [x, z] of [[halfX, 0], [-halfX, 0], [0, halfZ], [0, -halfZ]] as const) {
        const inward = 0.25;
        const nx = Math.sign(x);
        const nz = Math.sign(z);
        expect(touches(colliders, hangarPoint(WORLD, index, x - nx * inward, z - nz * inward, 1))).toBe(true);
        expect(contact.material).toBe(CAR_COLLIDER_MATERIAL.building);
        expect(touches(colliders, hangarPoint(WORLD, index, x + nx * 0.3, z + nz * 0.3, 1))).toBe(false);
      }
      // And up to the eaves.
      expect(touches(colliders, hangarPoint(WORLD, index, halfX - 0.25, 0, site.plan.eaveHeightMeters - 0.5))).toBe(true);
    }
  });

  it("puts the tower's base and the fuel tanks where they are drawn", () => {
    const airport = WORLD.airport!;
    const tower = towerSite(airport, buildTowerGeometry(), ground);
    const centre = runwayToWorld(airport, tower.position[2], tower.position[0]);
    const foot = airport.elevation + tower.position[1];
    const across = runwayToWorld(airport, tower.position[2], tower.position[0] + 1);
    const ux = across.x - centre.x;
    const uz = across.z - centre.z;
    expect(touches(colliders, { x: centre.x + ux * 6.5, y: foot + 1, z: centre.z + uz * 6.5 })).toBe(true);
    expect(touches(colliders, { x: centre.x + ux * 7.6, y: foot + 1, z: centre.z + uz * 7.6 })).toBe(false);

    for (const tank of fuelTankPlacements()) {
      const at = runwayToWorld(airport, tank.along, tank.across);
      const base = ground(at.x, at.z);
      const axle = base + FUEL_TANK_RADIUS_METERS * 1.6;
      const side = runwayToWorld(airport, tank.along, tank.across + FUEL_TANK_RADIUS_METERS - 0.1);
      const clear = runwayToWorld(airport, tank.along, tank.across + FUEL_TANK_RADIUS_METERS + 0.3);
      expect(touches(colliders, { x: side.x, y: axle, z: side.z })).toBe(true);
      expect(touches(colliders, { x: clear.x, y: axle, z: clear.z })).toBe(false);
    }
  });

  it("holds the marina's hut and shed", () => {
    const layout = homeMarina(WORLD);
    for (const kind of ["hut", "shed"] as const) {
      const box = layout.boxes.find((candidate) => candidate.kind === kind)!;
      const p = marinaToWorld(layout.frame, box.right, box.out);
      expect(touches(colliders, { x: p.x, y: box.y, z: p.z })).toBe(true);
    }
  });

  it("rebuilds the airports' buildings when the airport list changes, and only then", () => {
    const home = WORLD.airport!;
    const spawned = { ...home, centerX: home.centerX + 20_000 };
    const local = new CarColliders(WORLD, ground);
    const size = local.colliders.size;
    local.setAirports(WORLD);
    expect(local.colliders.size).toBe(size);
    const next = withAirports(WORLD, [...WORLD.airports, spawned]);
    local.setAirports(next);
    // Three hangars, the tower, two tanks and their four saddles.
    expect(local.colliders.size).toBe(size + 10);
    for (let index = 0; index < HANGAR_SITING.count; index += 1) {
      const centre = hangarPoint(WORLD, index, 0, 0, 0);
      const x = centre.x + 20_000;
      expect(touches(local.colliders, { x, y: ground(x, centre.z) + 1.5, z: centre.z })).toBe(true);
    }
    local.setAirports(WORLD);
    expect(local.colliders.size).toBe(size);
  });
});

describe("car colliders: guardrails", () => {
  /** A rail along a road's edge: a quarter circle of radius 40 m about the origin, the road inside it. */
  function curvedRail() {
    const points: number[] = [];
    // Clockwise seen from +y with x east and z north: from (0, 40) to (40, 0), so n = (dz, -dx) points to the centre.
    for (let i = 0; i <= 12; i += 1) {
      const angle = (i / 12) * (Math.PI / 2);
      points.push(40 * Math.sin(angle), 40 * Math.cos(angle));
    }
    return { points, heightMeters: 0.7 };
  }

  it("faces the road: n = (dz, -dx), with the box's depth behind the face", () => {
    const rail = curvedRail();
    const colliders = new ColliderWorld();
    for (const piece of guardrailColliders(rail, () => 0)) colliders.addStatic(piece.shape, { material: piece.material });
    // Mid-run and at bends (every 7.5 degrees).
    for (const angle of [10, 22.5, 33, 45, 51, 80]) {
      const a = angle * DEG;
      // The rail's line here, and the road's side (towards the centre).
      const on = { x: 40 * Math.sin(a), z: 40 * Math.cos(a) };
      const toRoad = { x: -Math.sin(a), z: -Math.cos(a) };
      const at = (offset: number, y = 0.4): Vec3 => ({ x: on.x + toRoad.x * offset, y, z: on.z + toRoad.z * offset });
      // On the road side, clear of it.
      expect(touches(colliders, at(0.2))).toBe(false);
      // Behind the face, pushed back towards the road, however deep within half the depth.
      for (const depth of [0.1, 0.5, 0.9]) {
        expect(touches(colliders, at(-depth))).toBe(true);
        expect(contact.normal.x * toRoad.x + contact.normal.z * toRoad.z).toBeGreaterThan(0.98);
        expect(contact.normal.y).toBeCloseTo(0, 6);
        expect(contact.material).toBe(CAR_COLLIDER_MATERIAL.guardrail);
        // Well over the beam too: the bumper is never pushed over its top.
        expect(touches(colliders, at(-depth, 1.6))).toBe(true);
        expect(contact.normal.y).toBeCloseTo(0, 6);
      }
      // Past the box's depth, nothing.
      expect(touches(colliders, at(-(GUARDRAIL_DEPTH + 0.2)))).toBe(false);
    }
  });

  it("follows a region's rails in and out of the car's world", () => {
    const local = new CarColliders(WORLD, ground);
    const size = local.colliders.size;
    const home = WORLD.airport!;
    const x = home.centerX + 3_000;
    const z = home.centerZ + 3_000;
    const region: InfrastructureRegion = {
      key: "roads:test:0:0",
      segments: [],
      rails: [{ points: [x, z, x, z + 40], heightMeters: 0.7 }],
    };
    const y = ground(x, z + 20) + 0.4;
    // The road is on +x: n = (dz, -dx) = (40, 0).
    local.applyRegions({ version: 1, reset: false, install: [region], remove: [] });
    expect(local.regionCount).toBe(1);
    expect(touches(local.colliders, { x: x - 0.3, y, z: z + 20 })).toBe(true);
    // Installing it again changes nothing.
    local.applyRegions({ version: 2, reset: false, install: [region], remove: [] });
    expect(local.colliders.size).toBe(size + 1);
    local.applyRegions({ version: 3, reset: false, install: [], remove: [region.key] });
    expect(local.regionCount).toBe(0);
    expect(local.colliders.size).toBe(size);
    expect(touches(local.colliders, { x: x - 0.3, y, z: z + 20 })).toBe(false);
    local.applyRegions({ version: 4, reset: false, install: [region], remove: [] });
    local.applyRegions({ version: 5, reset: true, install: [], remove: [] });
    expect(local.regionCount).toBe(0);
    expect(local.colliders.size).toBe(size);
  });
});

/** The hull's fixed probes (not the axles') in the world. */
function hullPoints(sim: GroundVehicleSimulator): Vec3[] {
  const out: Vec3[] = [];
  for (const part of LANDCRUISER_76.hull) {
    if ("axle" in part) continue;
    for (const probe of part.probes) {
      const p = rotateVectorInto({ x: 0, y: 0, z: 0 }, sim.state.orientation, probe);
      out.push({ x: sim.state.position.x + p.x, y: sim.state.position.y + p.y, z: sim.state.position.z + p.z });
    }
  }
  return out;
}

function onFlat(colliders: ColliderWorld, x: number, z: number, heading: number): GroundVehicleSimulator {
  const sim = new GroundVehicleSimulator(
    { position: { x, y: 0, z }, heading, moored: false, car: { gearbox: "automatic", manualClutch: false } },
    { ground: FLAT },
  );
  sim.setEnvironment({
    water: new CalmWaterSurface(-100, () => 0),
    wind: { x: 0, y: 0, z: 0 },
    bedHeight: () => 0,
    world: null,
    colliders,
    gravity: 9.80665,
  });
  return sim;
}

/** Hold `target` m/s on heading `heading` until `until` says stop, or `seconds` pass. */
function runUp(sim: GroundVehicleSimulator, target: number, heading: number, seconds: number, until: () => boolean): void {
  for (let i = 0; i < seconds / STEP && !until(); i += 1) {
    const error = target - speedOf(sim);
    const steer = Math.max(-1, Math.min(1, 3 * (headingOf(sim) - heading)));
    controls(sim, { steer, accelerator: Math.max(0, Math.min(1, 0.3 + 0.6 * error)), brake: error < -2 ? 0.3 : 0 });
    sim.step(STEP);
  }
}

describe("the car against buildings and rails", () => {
  /** A wall across the car's path at z = 40: a hangar's side. */
  function wall(): ColliderWorld {
    const colliders = new ColliderWorld();
    colliders.addStatic(
      { kind: "box", center: { x: 0, y: 5, z: 50 }, halfExtents: { x: 30, y: 6, z: 10 } },
      { material: CAR_COLLIDER_MATERIAL.building },
    );
    return colliders;
  }

  it("stops against a wall at walking pace and is wrecked by one above 12 m/s", () => {
    const slow = onFlat(wall(), 0, 0, 0);
    runUp(slow, 2, 0, 30, () => slow.state.position.z > 30);
    runUp(slow, 2, 0, 6, () => false);
    expect(slow.state.crashed).toBe(false);
    // Nose against the wall: the bumper's 2.16 m ahead of the origin, at z = 40.
    expect(slow.state.position.z).toBeGreaterThan(37.6);
    expect(slow.state.position.z).toBeLessThan(37.9);
    expect(Math.abs(speedOf(slow))).toBeLessThan(0.3);

    const fast = onFlat(wall(), 0, -200, 0);
    runUp(fast, 16, 0, 60, () => fast.state.position.z > 30);
    expect(speedOf(fast)).toBeGreaterThan(14);
    runUp(fast, 16, 0, 2, () => false);
    expect(fast.state.crashed).toBe(true);
    expect(fast.state.position.z).toBeLessThan(38.2);
  });

  /** A straight rail along +z at x = 0, the road on +x (n = (dz, -dx) = (1, 0) for points running +z). */
  function straightRail(): ColliderWorld {
    const colliders = new ColliderWorld();
    for (const piece of guardrailColliders({ points: [0, -300, 0, 600], heightMeters: 0.7 }, () => 0)) {
      colliders.addStatic(piece.shape, { material: piece.material });
    }
    return colliders;
  }

  /** Into the straight rail at `kmh` and `degrees` off it, then hands and feet off for 4 s. */
  function railHit(degrees: number, kmh: number) {
    const heading = -degrees * DEG;
    const sim = onFlat(straightRail(), 200 * Math.sin(degrees * DEG) + 3, -200, heading);
    const outermost = (): number => Math.min(...hullPoints(sim).map((p) => p.x));
    runUp(sim, kmh / 3.6, heading, 40, () => outermost() < 0.4);
    const impactSpeed = speedOf(sim);
    const rideHeight = sim.state.position.y;
    let deepest = 0;
    let highest = 0;
    let roll = 0;
    controls(sim, {});
    for (let i = 0; i < 4 / STEP; i += 1) {
      sim.step(STEP);
      deepest = Math.max(deepest, -outermost());
      highest = Math.max(highest, sim.state.position.y - rideHeight);
      const q = sim.state.orientation;
      // The body's right (+Z) axis's world y: sin of the roll.
      roll = Math.max(roll, Math.abs(2 * (q.y * q.z + q.w * q.x)));
    }
    return { sim, impactSpeed, deepest, highest, roll };
  }

  /** Redirected: running along the rail or a little away from it, on the road side, not launched, rolled or wrecked. */
  function expectRedirected({ sim, impactSpeed, highest, roll }: ReturnType<typeof railHit>, keeps: number): void {
    const v = sim.state.velocity;
    expect(headingOf(sim)).toBeGreaterThan(-6 * DEG);
    expect(headingOf(sim)).toBeLessThan(12 * DEG);
    expect(v.x).toBeGreaterThan(-1);
    expect(sim.state.position.x).toBeGreaterThan(0.5);
    expect(Math.hypot(v.x, v.z)).toBeGreaterThan(keeps * impactSpeed);
    expect(highest).toBeLessThan(0.25);
    expect(roll).toBeLessThan(Math.sin(15 * DEG));
    expect(sim.rolled).toBe(false);
    expect(sim.state.crashed).toBe(false);
  }

  it("redirects a car at 80 km/h and 20 degrees off a rail, without launching it or stopping it dead", () => {
    const hit = railHit(20, 80);
    expect(hit.impactSpeed).toBeGreaterThan(21.5);
    expect(hit.impactSpeed).toBeLessThan(23);
    expectRedirected(hit, 0.6);
    // The rail gave about half a metre.
    expect(hit.deepest).toBeGreaterThan(0.25);
    expect(hit.deepest).toBeLessThan(0.7);
  });

  it("redirects one at 100 km/h and 30 degrees too: it closes at 13.6 m/s, but under 12 by the beam's stop", () => {
    const hit = railHit(30, 100);
    expect(hit.impactSpeed * Math.sin(30 * DEG)).toBeGreaterThan(CRASH_IMPACT_SPEED + 1);
    expectRedirected(hit, 0.5);
    expect(hit.deepest).toBeGreaterThan(0.5);
    expect(hit.deepest).toBeLessThan(0.8);
  });

  it("redirects a car at 80 km/h and 20 degrees off a real road's rail, laid on flat ground, the same way", () => {
    // The longest rail the roads lay round the default world's home airport road (roadRails.ts), through the region's colliders.
    const world = createWorld();
    const network = new RoadNetwork(world);
    const head = airportRoadHead(world)!;
    let best: { region: InfrastructureRegion; points: readonly number[]; length: number } | null = null;
    for (let dx = -2; dx <= 2; dx += 1) {
      for (let dz = -2; dz <= 2; dz += 1) {
        const region = network.region("major", roadRegionOf(head.startX) + dx, roadRegionOf(head.startZ) + dz);
        const infrastructure = roadRegionInfrastructure(network, region);
        for (const rail of infrastructure.rails ?? []) {
          let length = 0;
          for (let i = 0; i + 3 < rail.points.length; i += 2) {
            length += Math.hypot(rail.points[i + 2]! - rail.points[i]!, rail.points[i + 3]! - rail.points[i + 1]!);
          }
          if (!best || length > best.length) best = { region: infrastructure, points: rail.points, length };
        }
      }
    }
    expect(best).not.toBeNull();
    const { region, points } = best!;
    expect(best!.length).toBeGreaterThan(45);
    const colliders = new ColliderWorld();
    for (const piece of regionColliders(region, () => 0)) colliders.addStatic(piece.shape, { material: piece.material });
    // The hit's frame: o on the rail 12 m from its start, t along it, n = (dz, -dx) to the road, as the straight rail's x.
    let along = 12;
    let i = 0;
    for (; i + 3 < points.length; i += 2) {
      const step = Math.hypot(points[i + 2]! - points[i]!, points[i + 3]! - points[i + 1]!);
      if (along <= step) break;
      along -= step;
    }
    const length = Math.hypot(points[i + 2]! - points[i]!, points[i + 3]! - points[i + 1]!);
    const t = { x: (points[i + 2]! - points[i]!) / length, z: (points[i + 3]! - points[i + 1]!) / length };
    const n = { x: t.z, z: -t.x };
    const o = { x: points[i]! + t.x * along, z: points[i + 1]! + t.z * along };
    const across = (p: { x: number; z: number }): number => (p.x - o.x) * n.x + (p.z - o.z) * n.z;
    const alongOf = (p: { x: number; z: number }): number => (p.x - o.x) * t.x + (p.z - o.z) * t.z;
    // A real rail ends: the car is judged while it is still beside it.
    const end = alongOf({ x: points[points.length - 2]!, z: points[points.length - 1]! });
    const railHeading = Math.atan2(t.x, t.z);
    const heading = railHeading - 20 * DEG;
    const sim = onFlat(colliders, o.x + 78 * n.x - 210 * t.x, o.z + 78 * n.z - 210 * t.z, heading);
    const outermost = (): number => Math.min(...hullPoints(sim).map(across));
    runUp(sim, 22.2, heading, 40, () => outermost() < 0.4);
    const impactSpeed = speedOf(sim);
    expect(impactSpeed).toBeGreaterThan(21.5);
    expect(impactSpeed).toBeLessThan(23);
    const rideHeight = sim.state.position.y;
    let deepest = 0;
    let highest = 0;
    let roll = 0;
    controls(sim, {});
    let seconds = 0;
    for (; seconds < 4 && alongOf(sim.state.position) < end - 3; seconds += STEP) {
      sim.step(STEP);
      deepest = Math.max(deepest, -outermost());
      highest = Math.max(highest, sim.state.position.y - rideHeight);
      const q = sim.state.orientation;
      roll = Math.max(roll, Math.abs(2 * (q.y * q.z + q.w * q.x)));
    }
    // Long enough for the hit to be over.
    expect(seconds).toBeGreaterThan(1.2);
    const exitHeading = headingOf(sim) - railHeading;
    const v = sim.state.velocity;
    expect(exitHeading).toBeGreaterThan(-6 * DEG);
    expect(exitHeading).toBeLessThan(12 * DEG);
    expect(v.x * n.x + v.z * n.z).toBeGreaterThan(-1);
    expect(across(sim.state.position)).toBeGreaterThan(0.5);
    expect(Math.hypot(v.x, v.z)).toBeGreaterThan(0.6 * impactSpeed);
    expect(highest).toBeLessThan(0.25);
    expect(roll).toBeLessThan(Math.sin(15 * DEG));
    expect(sim.rolled).toBe(false);
    expect(sim.state.crashed).toBe(false);
    expect(deepest).toBeGreaterThan(0.25);
    expect(deepest).toBeLessThan(0.7);
  });

  it("holds a car driven square into a rail at 100 km/h on the road side: wrecked, not through it, not thrown back", () => {
    const { sim, impactSpeed, deepest } = railHit(90, 100);
    expect(impactSpeed).toBeGreaterThan(26);
    expect(sim.state.crashed).toBe(true);
    // Short of half the collider's depth, where its back face would be nearest.
    expect(deepest).toBeLessThan(0.9 * (GUARDRAIL_DEPTH / 2));
    // At rest against it, the nose 2.16 m ahead of the origin.
    expect(sim.state.position.x).toBeGreaterThan(1.5);
    expect(sim.state.position.x).toBeLessThan(4);
    expect(Math.hypot(sim.state.velocity.x, sim.state.velocity.z)).toBeLessThan(0.5);
  });
});
