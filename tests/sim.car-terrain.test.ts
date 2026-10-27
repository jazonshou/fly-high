import { afterEach, describe, expect, it } from "vitest";
import type { CarControlState } from "../src/game/types";
import { densityField, sandCoverGroundFactor, sandCoverTreeFactor } from "../src/render/webgpu/detail/densityField";
import { classifyLandCover, landCoverFarDesertWeights, type LandCoverInput } from "../src/render/webgpu/terrain/LandCoverClassifier";
import { SURFACE_MATERIAL_COUNT, SurfaceMaterial } from "../src/render/webgpu/terrain/surfaceMaterials";
import { GroundVehicleSimulator } from "../src/sim/ground";
import { roughnessProfile, type RoughnessPoint } from "../src/sim/ground/roughness";
import {
  createCarSurface,
  describeSurface,
  landCoverInputOf,
  SoilModel,
  soilModelOf,
  SurfaceCache,
  type CarSurface,
} from "../src/sim/ground/surface";
import type { GroundField, GroundPoint } from "../src/sim/ground/terrainPatch";
import { sampleGroundContact } from "../src/sim/terrainGrid";
import { CLIMATE_PROVINCE_NAMES } from "../src/world/climateProvince";
import { clearInfrastructureRegions, installInfrastructureRegions, sampleInfrastructureSurface, infrastructureIndex } from "../src/world/infrastructure";
import { INFRASTRUCTURE_PROFILE } from "../src/world/infrastructureProfiles";
import { isPointOnRunway, worldAirportAt } from "../src/world/airport";
import { sampleTerrain } from "../src/world/terrain";
import { createWorld } from "../src/world/world";
import type { TerrainCollisionSample, WorldDefinition } from "../src/world/types";
import { controls, groundOf, slopeAhead, speedOf, STEP } from "./support/carRig";

/**
 * The car off the tarmac (land plan, "Physics tests"): what each surface
 * does to the tyres, sand and air-down, the steep climb, the cross-axle
 * ditch, the underbody, and the worker's surfaces against the splat bake's.
 */

afterEach(() => {
  clearInfrastructureRegions();
});

type Material = (typeof SurfaceMaterial)[keyof typeof SurfaceMaterial];

/** The car on `ground`, every tyre on `material`. */
function carOn(ground: GroundField, material: Material, wetness = 0): GroundVehicleSimulator {
  return new GroundVehicleSimulator(
    { position: { x: 0, y: 0, z: 0 }, heading: 0, moored: false, car: { gearbox: "automatic", manualClutch: false } },
    { ground, surface: (_at, out) => { describeSurface(material, wetness, out); } },
  );
}

function hold(sim: GroundVehicleSimulator, seconds: number, input: Partial<CarControlState>): void {
  controls(sim, input);
  const steps = Math.round(seconds / STEP);
  for (let i = 0; i < steps; i += 1) sim.step(STEP);
}

/**
 * A driver crawling at `target` m/s: some throttle for the speed lost, and
 * more the longer the car is held back, up to the floor. Off-road driving is
 * steady throttle at walking pace, not a run at the obstacle.
 */
function crawl(sim: GroundVehicleSimulator, seconds: number, target: number, input: Partial<CarControlState>, each?: () => void): void {
  let lean = 0;
  const steps = Math.round(seconds / STEP);
  for (let i = 0; i < steps; i += 1) {
    const error = target - speedOf(sim);
    lean = Math.max(0, Math.min(1, lean + 0.15 * error * STEP));
    controls(sim, { ...input, accelerator: Math.max(0, Math.min(1, 0.1 + 0.4 * error + lean)) });
    sim.step(STEP);
    each?.();
  }
}

describe("car surfaces", () => {
  it("grips by surface: friction and rolling resistance on hard ground, a soil on soft", () => {
    const s = createCarSurface();
    expect(describeSurface(SurfaceMaterial.Asphalt, 0, s)).toMatchObject({ soft: false, friction: 1, roughness: 0, soilModel: SoilModel.Hard });
    const gravel = { ...describeSurface(SurfaceMaterial.Gravel, 0, s) };
    expect(gravel.soft).toBe(false);
    expect(gravel.friction).toBeLessThan(0.7);
    expect(gravel.roughness).toBeGreaterThan(0);
    expect(describeSurface(SurfaceMaterial.Sand, 0, s)).toMatchObject({ soft: true, soilModel: SoilModel.DrySand });
    expect(describeSurface(SurfaceMaterial.Snow, 0, s).soilModel).toBe(SoilModel.Snow);
    expect(describeSurface(SurfaceMaterial.Tephra, 0, s).soilModel).toBe(SoilModel.Tephra);
    for (const material of [SurfaceMaterial.Grass, SurfaceMaterial.DryGrass, SurfaceMaterial.ForestFloor, SurfaceMaterial.Shrub]) {
      expect(soilModelOf(material)).toBe(SoilModel.SandyLoam);
    }
    // Wet loam is mud: it blends to the clayey soil, softer and with less friction angle.
    const loam = { ...describeSurface(SurfaceMaterial.Grass, 0.3, s) };
    const mud: CarSurface = { ...describeSurface(SurfaceMaterial.Grass, 1, s) };
    expect(loam.wetness).toBe(0);
    expect(mud.wetness).toBe(1);
    expect(mud.soilModel).toBe(SoilModel.ClayeySoil);
    expect(mud.tanFriction).toBeLessThan(loam.tanFriction);
    expect(mud.maxSinkage).toBeGreaterThan(loam.maxSinkage);
  });

  it("reads a road's paint where it is, and the classifier elsewhere, cached and forgotten when the roads change", () => {
    const world = createWorld("open-skies");
    const airport = world.airport!;
    const ground = worldGround(world);
    const cache = new SurfaceCache();
    const out = createCarSurface();
    const at: GroundPoint = { x: airport.centerX, z: airport.centerZ, height: 0, dhdx: 0, dhdz: 0 };
    cache.beginStep(world);
    expect(isPointOnRunway(worldAirportAt(world, at.x, at.z)!, at.x, at.z)).toBe(true);
    expect(cache.lookup(world, ground, at, out)).toBe(true);
    expect(out.material).toBe(SurfaceMaterial.Asphalt);
    expect(cache.classified).toBe(0);

    // Open country 3 km out: one classification per 4 m cell, at most one a step.
    at.x = airport.centerX + 3_000;
    at.z = airport.centerZ + 3_000;
    at.height = sampleTerrain(world, at.x, at.z).height;
    expect(cache.lookup(world, ground, at, out)).toBe(true);
    const natural = out.material;
    at.x += 4;
    expect(cache.lookup(world, ground, at, out)).toBe(false);
    expect(cache.classified).toBe(1);
    expect(cache.beginStep(world)).toBe(false);
    expect(cache.lookup(world, ground, at, out)).toBe(true);
    at.x -= 4;
    expect(cache.lookup(world, ground, at, out)).toBe(true);
    expect(out.material).toBe(natural);
    expect(cache.classified).toBe(2);

    // A gravel road streamed in over the point wins, and the cache starts again.
    installInfrastructureRegions(world, [{
      key: "test-road",
      segments: [{
        profile: INFRASTRUCTURE_PROFILE.platform,
        mode: "set",
        priority: 5,
        key: 1,
        ax: at.x - 20,
        az: at.z,
        bx: at.x + 20,
        bz: at.z,
        halfWidth: 4,
        reach: 20,
        params: [at.height, 2],
        surface: "gravel",
      }],
    }]);
    expect(sampleInfrastructureSurface(infrastructureIndex(world), at.x, at.z, { surface: null, coverage: 0 }).surface).toBe("gravel");
    expect(cache.beginStep(world)).toBe(true);
    expect(cache.lookup(world, ground, at, out)).toBe(true);
    expect(out.material).toBe(SurfaceMaterial.Gravel);
    at.z += 30;
    expect(cache.lookup(world, ground, at, out)).toBe(true);
    expect(cache.classified).toBe(3);
  });

  it("roughens the ground by a fixed profile: deterministic, unit RMS, the same under every car", () => {
    const point: RoughnessPoint = { x: 0, z: 0, height: 0 };
    let sum = 0;
    let squares = 0;
    const n = 20_000;
    for (let i = 0; i < n; i += 1) {
      point.x = (i % 200) * 0.37 - 30;
      point.z = Math.floor(i / 200) * 0.41 - 20;
      roughnessProfile(point);
      sum += point.height;
      squares += point.height * point.height;
    }
    const mean = sum / n;
    expect(Math.abs(mean)).toBeLessThan(0.1);
    expect(Math.sqrt(squares / n - mean * mean)).toBeGreaterThan(0.85);
    expect(Math.sqrt(squares / n - mean * mean)).toBeLessThan(1.15);
    point.x = 12.5;
    point.z = -3.25;
    roughnessProfile(point);
    const first = point.height;
    roughnessProfile(point);
    expect(point.height).toBe(first);
    // Two tyres an axle apart meet different bumps.
    point.x += 1.5;
    roughnessProfile(point);
    expect(point.height).not.toBe(first);
  });
});

describe("car soft ground", () => {
  /** Stopped on a 5 degree dune face at `bar`, then 15 s of 2H at a firm pedal: how far it gets. */
  function duneFace(bar: number): { travelled: number; rut: number } {
    const sim = carOn(slopeAhead(5), SurfaceMaterial.Sand);
    const preset = bar < 2 ? "sand" : "road";
    hold(sim, 0.1, { handbrake: 1, tyrePressure: preset });
    // Airing down takes the deflator its time; the car must be stopped for it.
    hold(sim, 40, { handbrake: 1, tyrePressure: preset });
    expect(sim.tyrePressureBar).toBeCloseTo(bar, 6);
    const start = sim.state.position.z;
    let rut = 0;
    controls(sim, { accelerator: 0.6, tyrePressure: preset });
    for (let i = 0; i < 15 / STEP; i += 1) {
      sim.step(STEP);
      rut = Math.max(rut, sim.wheelRut[2]!, sim.wheelRut[3]!);
    }
    return { travelled: sim.state.position.z - start, rut };
  }

  it("bogs from a stop on a 5 degree dune face at 2.4 bar, and drives out at 1.2 bar", () => {
    const road = duneFace(2.4);
    const sand = duneFace(1.2);
    // At road pressure the rear tyres dig in.
    expect(road.travelled).toBeLessThan(3);
    expect(road.rut).toBeGreaterThan(0.05);
    // Aired down, the longer flat floats the car out.
    expect(sand.travelled).toBeGreaterThan(30);
  });

  it("reports each tyre's sinkage, material and wetness for the tracks and the spray", () => {
    const sim = carOn(groundOf((out) => {
      out.height = 0;
      out.dhdx = 0;
      out.dhdz = 0;
    }), SurfaceMaterial.Grass, 0.8);
    hold(sim, 3, { accelerator: 0.3 });
    const state = sim.visualState();
    for (let w = 0; w < 4; w += 1) {
      expect(state.wheelSurface[w]).toBe(SurfaceMaterial.Grass);
      expect(state.wheelSinkage[w]).toBeGreaterThan(0.005);
      expect(state.wheelSinkage[w]).toBeLessThan(0.15);
      // 0.8 wet loam is most of the way to mud.
      expect(state.wheelWetness[w]).toBeGreaterThan(0.7);
    }
  });

  it("climbs a 30 degree slope from a standstill in 4L, and fails on loose ground in 2H", () => {
    function climb(material: Material, rangePresses: number): number {
      const sim = carOn(slopeAhead(30), material);
      hold(sim, 0.1, { handbrake: 1 });
      hold(sim, 1.5, { handbrake: 1, rangePresses });
      const start = sim.state.position.z;
      hold(sim, 15, { accelerator: 0.6, rangePresses });
      return sim.state.position.z - start;
    }
    expect(climb(SurfaceMaterial.Rock, 2)).toBeGreaterThan(20);
    expect(climb(SurfaceMaterial.Asphalt, 2)).toBeGreaterThan(20);
    // Gravel in 2H: the rear tyres alone cannot hold the car, which slides back down.
    expect(climb(SurfaceMaterial.Gravel, 0)).toBeLessThan(0);
  });
});

/**
 * A cosine ditch `depth` deep and `2 half` wide whose centre line crosses
 * the car's path at `angle` degrees off square, centred on z = `at`.
 */
function ditch(depth: number, half: number, angle: number, at: number): GroundField {
  const a = (angle * Math.PI) / 180;
  const nx = Math.sin(a);
  const nz = Math.cos(a);
  return groundOf((out) => {
    const d = nx * out.x + nz * (out.z - at);
    out.height = 0;
    out.dhdx = 0;
    out.dhdz = 0;
    if (Math.abs(d) >= half) return;
    const phase = (Math.PI * d) / half;
    out.height = -0.5 * depth * (1 + Math.cos(phase));
    const slope = -0.5 * depth * Math.sin(phase) * (Math.PI / half);
    out.dhdx = slope * nx;
    out.dhdz = slope * nz;
  });
}

/**
 * A berm between the wheel tracks: flat on top out to 0.3 m either side of
 * the centre line, a cosine shoulder to 0.55 m (the rear tyres' inner edges
 * are at 0.61), rising to `height` over z = 4..7 m and running on.
 */
function berm(height: number): GroundField {
  return groundOf((out) => {
    out.height = 0;
    out.dhdx = 0;
    out.dhdz = 0;
    const x = out.x;
    const z = out.z;
    if (Math.abs(x) >= 0.55 || z <= 4) return;
    const s = Math.max(0, Math.abs(x) - 0.3) / 0.25;
    const across = 0.5 * (1 + Math.cos(Math.PI * s));
    const dAcross = -0.5 * Math.sin(Math.PI * s) * (Math.PI / 0.25) * Math.sign(x);
    let along = 1;
    let dAlong = 0;
    if (z < 7) {
      const u = (z - 4) / 3;
      along = u * u * (3 - 2 * u);
      dAlong = (6 * u * (1 - u)) / 3;
    }
    out.height = height * across * along;
    out.dhdx = height * dAcross * along;
    out.dhdz = height * across * dAlong;
  });
}

describe("car articulation and underbody", () => {
  /**
   * Into a 0.7 m ditch at 45 degrees in 4L at a crawl: the far front wheel
   * climbs out while the near rear one drops in, so one wheel of each axle,
   * diagonally, goes light. Returns when the car was clear of it (or -1),
   * how long it stood still on the way, the fastest any wheel spun, and
   * whether traction control ever worked.
   */
  function crossDitch(
    tractionControl: boolean,
    lockPresses: number,
  ): { clearedAt: number; position: number; stalled: number; spin: number; tcWorked: boolean; locks: string } {
    const sim = carOn(ditch(0.7, 2, 45, 8), SurfaceMaterial.Rock);
    sim.tractionControl = tractionControl;
    hold(sim, 0.1, { handbrake: 1 });
    hold(sim, 1, { handbrake: 1, rangePresses: 2, lockPresses });
    let t = 0;
    let clearedAt = -1;
    let tcWorked = false;
    let stalled = 0;
    let spin = 0;
    crawl(sim, 40, 0.5, { rangePresses: 2, lockPresses }, () => {
      t += STEP;
      if (sim.tractionControlActive) tcWorked = true;
      if (clearedAt < 0 && t > 2 && Math.abs(speedOf(sim)) < 0.1) stalled += STEP;
      if (clearedAt < 0) for (let w = 1; w <= 4; w += 1) spin = Math.max(spin, Math.abs(sim.driveline.omega[w]!));
      if (clearedAt < 0 && sim.state.position.z > 17) clearedAt = t;
    });
    return { clearedAt, position: sim.state.position.z, stalled, spin, tcWorked, locks: sim.transmission.locks };
  }

  it("crosses a cross-axle ditch on traction control slowly, on the rear locker, and not at all on open diffs", () => {
    const open = crossDitch(false, 0);
    const tc = crossDitch(true, 0);
    const locker = crossDitch(true, 1);
    // Open diffs send the torque to the light wheels, which spin: stuck in the ditch.
    expect(open.clearedAt).toBe(-1);
    expect(open.position).toBeLessThan(9);
    expect(open.spin).toBeGreaterThan(15);
    // Traction control lets the light wheels spin up and brakes them until the loaded ones pull.
    expect(tc.tcWorked).toBe(true);
    expect(tc.clearedAt).toBeGreaterThan(0);
    // The rear locker drives both rear wheels as one, with less spin and less standing;
    // traction control stands down while it is in.
    expect(locker.locks).toBe("rear");
    expect(locker.tcWorked).toBe(false);
    expect(locker.clearedAt).toBeGreaterThan(0);
    expect(locker.spin).toBeLessThan(tc.spin * 0.75);
    expect(locker.stalled).toBeLessThan(tc.stalled);
  });

  /** Along a berm between the tracks in 4L at a crawl: the worst scrape, how far it got, and the lightest wheel load at the end. */
  function overBerm(height: number): { scrape: number; position: number; lightest: number } {
    const sim = carOn(berm(height), SurfaceMaterial.Rock);
    hold(sim, 0.1, { handbrake: 1 });
    hold(sim, 1, { handbrake: 1, rangePresses: 2 });
    let scrape = 0;
    crawl(sim, 30, 0.8, { rangePresses: 2 }, () => {
      scrape = Math.max(scrape, sim.visualState().scrape);
    });
    return { scrape, position: sim.state.position.z, lightest: Math.min(...sim.wheelLoad) };
  }

  it("clears a low berm, scrapes its diffs over a taller one and high-centres on a taller still", () => {
    // Under the diff housings (0.29 m): clean.
    const low = overBerm(0.25);
    expect(low.scrape).toBe(0);
    expect(low.position).toBeGreaterThan(20);
    // A little over them: the housings ride the berm, dragging, and the car goes on.
    const scraping = overBerm(0.32);
    expect(scraping.scrape).toBeGreaterThan(0.05);
    expect(scraping.position).toBeGreaterThan(20);
    // Well over: the axles hang off their diffs, the tyres lose the ground and the car stops on it.
    const beached = overBerm(0.42);
    expect(beached.scrape).toBeGreaterThan(0.05);
    expect(beached.position).toBeLessThan(10);
    expect(beached.lightest).toBeLessThan(200);
  });
});

/** The world's own ground, exact (the worker reads it through its 2 m lattice). */
function worldGround(world: WorldDefinition): GroundField {
  const contact: TerrainCollisionSample = { height: 0, normal: { x: 0, y: 1, z: 0 }, isRunway: false, friction: 1 };
  return {
    evaluate(at) {
      sampleGroundContact(world, at.x, at.z, contact);
      at.height = contact.height;
      at.dhdx = -contact.normal.x / contact.normal.y;
      at.dhdz = -contact.normal.z / contact.normal.y;
    },
  };
}

/** An LCG for repeatable sample points. */
function points(seed: number, count: number, radius: number): Array<[number, number]> {
  let state = seed >>> 0;
  const next = (): number => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
  return Array.from({ length: count }, () => [(next() * 2 - 1) * radius, (next() * 2 - 1) * radius]);
}

/**
 * What the L0 splat bake paints at the 4 m texel holding (x, z), restated
 * from PageSplatBake's WGSL as far as the CPU can follow it: the texel
 * centre's canopy closure and grass cover from `densityField` with the
 * bake's drivers (airport clearance, the province raw, no shore term),
 * thinned on sand and shared by four classifier taps a quarter texel out
 * (one canopy under 60 m texels), their weights averaged, then the far-desert
 * share. The bake's erosion and soil-depth channels have no CPU twin.
 */
function bakedMaterial(world: WorldDefinition, x: number, z: number): number {
  const texel = 4;
  const cx = (Math.floor(x / texel) + 0.5) * texel;
  const cz = (Math.floor(z / texel) + 0.5) * texel;
  const centre = sampleTerrain(world, cx, cz);
  const field = densityField(world.sourceSeedHash, {
    filterWidthMeters: 0,
    x: cx,
    z: cz,
    heightMeters: centre.height,
    seaLevelMeters: world.seaLevel,
    slope: centre.slope,
    moisture: centre.moisture,
    normalX: centre.normal.x,
    normalZ: centre.normal.z,
    airportInfluence: centre.airportInfluence,
    temperatureOffset: centre.temperatureOffset,
    dryness: centre.dryness,
    dayOfYear: 171,
  });
  const canopyClosure = field.canopyClosure * sandCoverTreeFactor(centre.sandCover);
  const grassCover = field.grassCover * sandCoverGroundFactor(centre.sandCover);
  let accumulated = new Array<number>(SURFACE_MATERIAL_COUNT).fill(0);
  for (let tap = 0; tap < 4; tap += 1) {
    const tx = cx + ((tap & 1) === 1 ? 1 : -1) * texel * 0.25;
    const tz = cz + ((tap & 2) === 2 ? 1 : -1) * texel * 0.25;
    const sample = sampleTerrain(world, tx, tz);
    const input: LandCoverInput = {
      ...landCoverInputOf(world, sample),
      canopyClosure,
      grassCover,
      // The bake samples the sand cover once per texel.
      sandCover: centre.sandCover,
    };
    const weights = classifyLandCover(input);
    weights.ids.forEach((id, slot) => {
      accumulated[id] = accumulated[id]! + (weights.weights[slot] ?? 0) * 0.25;
    });
  }
  accumulated = landCoverFarDesertWeights(accumulated, centre.dryness, texel, centre.sandCover);
  let best = 0;
  for (let id = 1; id < SURFACE_MATERIAL_COUNT; id += 1) if (accumulated[id]! > accumulated[best]!) best = id;
  return best;
}

describe("car surface parity", () => {
  it("maps the worker's material to the splat bake's soil model at least 98% of the time, in every province", () => {
    const contact: TerrainCollisionSample = { height: 0, normal: { x: 0, y: 1, z: 0 }, isRunway: false, friction: 1 };
    const at: GroundPoint = { x: 0, z: 0, height: 0, dhdx: 0, dhdz: 0 };
    const out = createCarSurface();
    const report: string[] = [];
    let worst = 1;
    for (const province of CLIMATE_PROVINCE_NAMES) {
      const world = createWorld("open-skies", { climateProvince: province });
      const airport = world.airport!;
      const cache = new SurfaceCache();
      const ground = worldGround(world);
      let compared = 0;
      let agreed = 0;
      for (const [dx, dz] of points(0x5eed, 400, 15_000)) {
        const x = airport.centerX + dx;
        const z = airport.centerZ + dz;
        sampleGroundContact(world, x, z, contact);
        if (contact.height < world.seaLevel + 5 || contact.isRunway) continue;
        if (sampleInfrastructureSurface(infrastructureIndex(world), x, z, { surface: null, coverage: 0 }).coverage > 0) continue;
        at.x = x;
        at.z = z;
        at.height = contact.height;
        at.dhdx = -contact.normal.x / contact.normal.y;
        at.dhdz = -contact.normal.z / contact.normal.y;
        cache.beginStep(world);
        expect(cache.lookup(world, ground, at, out)).toBe(true);
        compared += 1;
        const baked = bakedMaterial(world, x, z);
        if (soilModelOf(out.material) === soilModelOf(baked)) agreed += 1;
      }
      expect(compared).toBeGreaterThan(200);
      worst = Math.min(worst, agreed / compared);
      report.push(`${province} ${agreed}/${compared}`);
    }
    expect(worst, report.join(", ")).toBeGreaterThanOrEqual(0.98);
  });
});
