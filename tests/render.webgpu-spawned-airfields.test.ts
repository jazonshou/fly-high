import { FreeCamera } from "@babylonjs/core/Cameras/freeCamera";
import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import type { Mesh } from "@babylonjs/core/Meshes/mesh";
import { Scene } from "@babylonjs/core/scene";
import { describe, expect, it } from "vitest";
import {
  SPAWNED_AIRFIELD_FRAME_BUDGET_MS,
  SPAWNED_FLOODS_PER_FIELD,
  SpawnedAirfieldManager,
  spawnedFloodReserve,
  type SpawnedFloodSink,
} from "../src/render/webgpu/airfield/SpawnedAirfields";
import {
  analyticTerrainOf,
  LiveAirportGround,
  withSpawnedAirportGround,
} from "../src/render/webgpu/airfield/SpawnedAirportGround";
import { resolveWebGpuQualityProfile, type SpawnedAirfieldTier } from "../src/render/webgpu/core/QualityProfile";
import { AirportSystem } from "../src/render/webgpu/detail/AirportSystem";
import { AirfieldLightingSystem } from "../src/render/webgpu/lighting/AirfieldLighting";
import { LightPointSystem } from "../src/render/webgpu/lighting/LightPoints";
import {
  HANGAR_FLOOD_INTENSITY,
  hangarFaceFloodlights,
} from "../src/render/webgpu/lighting/ObstructionLighting";
import {
  createWorld,
  findSpawnedAirport,
  getAirportInfluence,
  sampleTerrain,
  withAirports,
  type AirportDefinition,
  type TerrainSample,
  type WorldDefinition,
} from "../src/world";

/**
 * An airport spawned in flight gets the home field's airfield — and spawning
 * it must not cost a frame, a material or a pipeline.
 *
 * These pin the manager's contract in Node: nothing is built inside
 * `setAirports`; the build runs in slices under the frame budget; every mesh
 * draws with one of the HOME field's materials (no material, texture or effect
 * is created); the merged meshes are, triangle for triangle, the structures the
 * home builder would have put there; retiring a field — even mid-build — leaves
 * nothing behind; and the tier row bounds what is built and lit.
 */

const HIGH = resolveWebGpuQualityProfile("high", "balanced").spawnedAirfields;
const MEDIUM = resolveWebGpuQualityProfile("medium", "balanced").spawnedAirfields;
const LOW = resolveWebGpuQualityProfile("low", "balanced").spawnedAirfields;

/** A spawn search run to completion from `from`, heading east. */
function spawnFrom(world: WorldDefinition, x: number, z: number): Readonly<AirportDefinition> {
  for (let attempt = 0; ; attempt += 1) {
    const result = findSpawnedAirport(world, x, z, Math.PI / 2, attempt);
    if (result === "exhausted") throw new Error("no spawn site");
    if (result) return result;
  }
}

interface Rig {
  readonly scene: Scene;
  readonly world: WorldDefinition;
  readonly next: WorldDefinition;
  readonly spawned: Readonly<AirportDefinition>;
  readonly home: AirportSystem;
  readonly lightPoints: LightPointSystem;
  readonly floods: FakeFloods;
  readonly ground: (x: number, z: number) => number;
  readonly manager: SpawnedAirfieldManager;
  dispose(): void;
}

class FakeFloods implements SpawnedFloodSink {
  readonly positions = new Map<string, readonly [number, number, number]>();
  readonly intensities = new Map<string, number>();
  setPosition(name: string, x: number, y: number, z: number): boolean {
    this.positions.set(name, [x, y, z]);
    return true;
  }
  setIntensity(name: string, intensity: number): boolean {
    this.intensities.set(name, intensity);
    return true;
  }
}

function rig(tier: SpawnedAirfieldTier = HIGH, seed = "alpha"): Rig {
  const engine = new NullEngine();
  const scene = new Scene(engine);
  scene.activeCamera = new FreeCamera("probe", new Vector3(0, 5, -20), scene);
  const world = createWorld(seed);
  const homeAirport = world.airport!;
  const spawned = spawnFrom(world, homeAirport.centerX + 15_000, homeAirport.centerZ);
  const next = withAirports(world, [...world.airports, spawned]);
  const ground = (x: number, z: number): number => sampleTerrain(next, x, z).height;
  const home = new AirportSystem(scene, homeAirport, (x, z) => sampleTerrain(world, x, z).height, world.seedHash);
  const homeLighting = new AirfieldLightingSystem(homeAirport, []);
  const lightPoints = new LightPointSystem(scene, homeLighting.fixtures, 1);
  const floods = new FakeFloods();
  const reserve = spawnedFloodReserve(13);
  const manager = new SpawnedAirfieldManager({
    scene,
    world,
    materials: home.materials,
    seedHash: world.seedHash,
    groundHeight: ground,
    lamps: lightPoints,
    floods,
    floodSlots: reserve.map((slot) => slot.map((light) => light.name)),
    tier,
  });
  return {
    scene, world, next, spawned, home, lightPoints, floods, ground, manager,
    dispose: () => { manager.dispose(); home.dispose(); lightPoints.dispose(); scene.dispose(); engine.dispose(); },
  };
}

/** Frames until the manager is idle; returns per-frame `update` wall times. */
function settle(host: Rig, x: number, z: number, maxFrames = 20_000): number[] {
  const frames: number[] = [];
  for (let frame = 0; frame < maxFrames; frame += 1) {
    const started = performance.now();
    host.manager.update(x, 300, z);
    frames.push(performance.now() - started);
    if (frame > 2 && host.manager.statistics.pendingJobs === 0) return frames;
  }
  throw new Error("spawned airfield never settled");
}

const spawnedMeshes = (scene: Scene): Mesh[] =>
  scene.meshes.filter((mesh) => mesh.name.startsWith("airport-spawned-")) as Mesh[];

describe("an airport spawned in flight gets the home field's airfield", () => {
  it("builds nothing inside setAirports, then builds in budgeted slices on the home field's materials", () => {
    const host = rig();
    try {
      const materials = host.scene.materials.length;
      const textures = host.scene.textures.length;
      const meshes = host.scene.meshes.length;
      const homeMaterials = new Set([
        host.home.materials.metal, host.home.materials.concrete, host.home.materials.glass,
        host.home.materials.steel, host.home.materials.accent,
      ]);

      const started = performance.now();
      host.manager.setAirports(host.next.airports);
      const setAirportsMs = performance.now() - started;
      expect(host.scene.meshes.length, "setAirports built meshes synchronously").toBe(meshes);
      expect(host.manager.statistics.pendingJobs).toBeGreaterThan(0);

      const frames = settle(host, host.spawned.centerX + 1_000, host.spawned.centerZ);
      const built = spawnedMeshes(host.scene);
      const stats = host.manager.statistics;
      const sorted = [...frames].sort((a, b) => a - b);
      console.log(
        `spawn: setAirports ${setAirportsMs.toFixed(2)} ms; ${frames.length} frames to build; `
        + `update p50 ${sorted[Math.floor(sorted.length * 0.5)]!.toFixed(2)} ms, `
        + `p95 ${sorted[Math.floor(sorted.length * 0.95)]!.toFixed(2)} ms, `
        + `max ${sorted[sorted.length - 1]!.toFixed(2)} ms (budget ${SPAWNED_AIRFIELD_FRAME_BUDGET_MS} ms); `
        + `${built.length} meshes, `
        + `${built.reduce((n, m) => n + m.getTotalVertices(), 0)} vertices, `
        + `${built.reduce((n, m) => n + m.getTotalIndices() / 3, 0)} triangles; `
        + `${stats.spawnedLamps} lamps`,
      );

      expect(stats.structureFields).toBe(1);
      // Seven merged draws: concrete, metal, glass, steel, furniture, fence, sock.
      expect(built).toHaveLength(7);
      expect(stats.structureMeshes).toBe(7);
      for (const mesh of built) {
        expect(homeMaterials.has(mesh.material as never), `${mesh.name} has its own material`).toBe(true);
        // Distance-culled like the home field's hangars.
        expect(mesh.getLODLevels().map((level) => [level.distanceOrScreenCoverage, level.mesh]))
          .toEqual([[HIGH.structureCullMeters, null]]);
      }
      // No material, no texture, no effect was created to spawn it.
      expect(host.scene.materials.length).toBe(materials);
      expect(host.scene.textures.length).toBe(textures);
      // Every ground query was answered from the pre-sampled cache.
      expect(stats.groundCacheMisses).toBe(0);
      // Lamps rode the home light-point draw: still one light-point mesh.
      expect(host.scene.meshes.filter((mesh) => mesh.name === "light-points")).toHaveLength(1);
      expect(host.lightPoints.extraFixtureCount).toBe(stats.spawnedLamps);
      expect(stats.spawnedLamps).toBeGreaterThan(new AirfieldLightingSystem(host.spawned).fixtures.length);
    } finally {
      host.dispose();
    }
  });

  it("merges exactly the structures the home builder would put there, triangle for triangle", () => {
    const host = rig();
    try {
      host.manager.setAirports(host.next.airports);
      settle(host, host.spawned.centerX, host.spawned.centerZ);
      const reference = new AirportSystem(host.scene, host.spawned, host.ground, host.world.seedHash);
      // Both rebased onto the field, so float32 matrices hold sub-millimetre
      // precision and a real misplacement is not hidden in rounding.
      reference.setFloatingOrigin(host.spawned.centerX, host.spawned.centerZ);
      host.manager.setFloatingOrigin(host.spawned.centerX, host.spawned.centerZ);

      // World-space triangle corners per material.
      const corners = (meshes: readonly Mesh[]): Map<string, Float64Array> => {
        const out = new Map<string, number[]>();
        for (const mesh of meshes) {
          mesh.computeWorldMatrix(true);
          const matrix = mesh.getWorldMatrix();
          const positions = mesh.getVerticesData("position")!;
          const indices = mesh.getIndices()!;
          const key = mesh.material!.name;
          const list = out.get(key) ?? [];
          const point = new Vector3();
          for (const index of indices) {
            Vector3.TransformCoordinatesFromFloatsToRef(
              positions[index * 3]!, positions[index * 3 + 1]!, positions[index * 3 + 2]!, matrix, point,
            );
            list.push(point.x, point.y, point.z);
          }
          out.set(key, list);
        }
        return new Map([...out].map(([key, list]) => [key, Float64Array.from(list)]));
      };
      /** How many corners of `from` have no corner of `to` within `tolerance` metres. */
      const unmatched = (from: Float64Array, to: Float64Array, tolerance: number): number => {
        const cell = 0.05;
        const grid = new Map<string, number[]>();
        const key = (x: number, y: number, z: number) =>
          `${Math.floor(x / cell)},${Math.floor(y / cell)},${Math.floor(z / cell)}`;
        for (let index = 0; index < to.length; index += 3) {
          const k = key(to[index]!, to[index + 1]!, to[index + 2]!);
          const list = grid.get(k) ?? [];
          list.push(index);
          grid.set(k, list);
        }
        let missing = 0;
        for (let index = 0; index < from.length; index += 3) {
          const x = from[index]!; const y = from[index + 1]!; const z = from[index + 2]!;
          let found = false;
          for (let dx = -1; dx <= 1 && !found; dx += 1) {
            for (let dy = -1; dy <= 1 && !found; dy += 1) {
              for (let dz = -1; dz <= 1 && !found; dz += 1) {
                const list = grid.get(key(x + dx * cell, y + dy * cell, z + dz * cell));
                if (!list) continue;
                found = list.some((other) => Math.hypot(
                  to[other]! - x, to[other + 1]! - y, to[other + 2]! - z,
                ) <= tolerance);
              }
            }
          }
          if (!found) missing += 1;
        }
        return missing;
      };
      const expected = corners(reference.root.getChildMeshes(false) as Mesh[]);
      const actual = corners(spawnedMeshes(host.scene));
      expect([...actual.keys()].sort()).toEqual([...expected.keys()].sort());
      for (const [material, list] of expected) {
        const mine = actual.get(material)!;
        expect(mine.length, `${material} triangle corners`).toBe(list.length);
        expect(unmatched(mine, list, 0.002), `${material}: spawned corners the home builder has not`).toBe(0);
        expect(unmatched(list, mine, 0.002), `${material}: home-builder corners the spawn lacks`).toBe(0);
      }
      reference.dispose();
    } finally {
      host.dispose();
    }
  });

  it("retires a field — built or half-built — and leaves nothing behind but the home field", () => {
    const host = rig();
    try {
      const baseline = host.scene.meshes.length;
      const nodes = host.scene.transformNodes.length;
      // Half-built: a few frames in, then retired.
      host.manager.setAirports(host.next.airports);
      for (let frame = 0; frame < 400 && spawnedMeshes(host.scene).length === 0; frame += 1) {
        host.manager.update(host.spawned.centerX, 300, host.spawned.centerZ);
      }
      expect(spawnedMeshes(host.scene).length).toBeGreaterThan(0);
      expect(host.manager.statistics.pendingJobs).toBeGreaterThan(0);
      host.manager.setAirports(host.world.airports);
      expect(host.scene.meshes.length).toBe(baseline);
      expect(host.scene.transformNodes.length).toBe(nodes);
      // Left: only the lamp re-pack that drops its lamps, and a frame runs it.
      host.manager.update(host.spawned.centerX, 300, host.spawned.centerZ);
      expect(host.manager.statistics.pendingJobs).toBe(0);
      expect(host.lightPoints.extraFixtureCount).toBe(0);

      // Fully built, then retired.
      host.manager.setAirports(host.next.airports);
      settle(host, host.spawned.centerX, host.spawned.centerZ);
      expect(spawnedMeshes(host.scene)).toHaveLength(7);
      host.manager.setAirports(host.world.airports);
      host.manager.update(host.spawned.centerX, 300, host.spawned.centerZ);
      expect(host.scene.meshes.length).toBe(baseline);
      expect(host.lightPoints.extraFixtureCount).toBe(0);
      // The shared materials survive: the home field still draws with them.
      for (const material of [host.home.materials.metal, host.home.materials.concrete]) {
        expect(host.scene.materials).toContain(material);
      }
      // Every flood slot is dark and parked again.
      for (const [name, intensity] of host.floods.intensities) {
        expect(intensity, name).toBe(0);
        expect(host.floods.positions.get(name)?.[1] ?? -1e6, name).toBeLessThan(-1e5);
      }
    } finally {
      host.dispose();
    }
  });

  it("lights the field's hangar floods from the reserve, by the daylight law", () => {
    const host = rig();
    try {
      host.manager.setAirports(host.next.airports);
      host.manager.setDaylightAttenuation(0.5);
      settle(host, host.spawned.centerX, host.spawned.centerZ);
      host.manager.update(host.spawned.centerX, 300, host.spawned.centerZ);
      const reference = new AirportSystem(host.scene, host.spawned, host.ground, host.world.seedHash);
      const expected = reference.hangarAttachments.flatMap((mounts, index) =>
        hangarFaceFloodlights(host.spawned, mounts, index));
      reference.dispose();
      expect(expected).toHaveLength(SPAWNED_FLOODS_PER_FIELD);
      const slot = [...host.floods.positions.keys()].filter((name) => name.startsWith("spawned-hangar-flood-0-"));
      expect(slot).toHaveLength(SPAWNED_FLOODS_PER_FIELD);
      for (let index = 0; index < SPAWNED_FLOODS_PER_FIELD; index += 1) {
        const at = host.floods.positions.get(`spawned-hangar-flood-0-${index}`)!;
        expect(at[0]).toBeCloseTo(expected[index]!.position[0], 6);
        expect(at[1]).toBeCloseTo(expected[index]!.position[1], 6);
        expect(at[2]).toBeCloseTo(expected[index]!.position[2], 6);
        expect(host.floods.intensities.get(`spawned-hangar-flood-0-${index}`)).toBe(HANGAR_FLOOD_INTENSITY * 0.5);
      }
      // Only one field exists, so the other slots stay dark.
      expect(host.floods.intensities.get("spawned-hangar-flood-1-0")).toBe(0);
    } finally {
      host.dispose();
    }
  });

  it("reserves floods inside one clustered batch, in whole fields", () => {
    // 13 = the home field's 6 floods + 2 cast pools + 5 wash lights.
    expect(spawnedFloodReserve(13).map((slot) => slot.length)).toEqual([6, 6, 6]);
    expect(13 + spawnedFloodReserve(13).flat().length).toBeLessThanOrEqual(32);
    expect(spawnedFloodReserve(27)).toEqual([]);
    expect(spawnedFloodReserve(0)).toHaveLength(3);
  });

  it("builds nothing at low, only the nearest field at medium, and catches up when raised", () => {
    const low = rig(LOW);
    try {
      const lampVertices = low.scene.getMeshByName("light-points")!.getTotalVertices();
      low.manager.setAirports(low.next.airports);
      settle(low, low.spawned.centerX, low.spawned.centerZ);
      // Low pays nothing: no mesh, no lamp, no lit flood.
      expect(spawnedMeshes(low.scene)).toHaveLength(0);
      expect(low.manager.statistics.structureFields).toBe(0);
      expect(low.lightPoints.extraFixtureCount).toBe(0);
      expect(low.scene.getMeshByName("light-points")!.getTotalVertices()).toBe(lampVertices);
      expect([...low.floods.intensities.values()].every((value) => value === 0)).toBe(true);

      // Raised to medium in flight: the field it already knows is lit and built.
      low.manager.setTier(MEDIUM);
      settle(low, low.spawned.centerX, low.spawned.centerZ);
      expect(low.manager.statistics.structureFields).toBe(1);
      expect(spawnedMeshes(low.scene)).toHaveLength(7);
      expect(low.lightPoints.extraFixtureCount).toBe(low.manager.statistics.spawnedLamps);
      expect(low.manager.statistics.spawnedLamps)
        .toBeGreaterThan(new AirfieldLightingSystem(low.spawned).fixtures.length);

      // And dropped back: its meshes are released and its lamps leave the draw.
      low.manager.setTier(LOW);
      settle(low, low.spawned.centerX, low.spawned.centerZ);
      expect(spawnedMeshes(low.scene)).toHaveLength(0);
      expect(low.lightPoints.extraFixtureCount).toBe(0);
      expect(low.scene.getMeshByName("light-points")!.getTotalVertices()).toBe(lampVertices);
    } finally {
      low.dispose();
    }

    const medium = rig(MEDIUM);
    try {
      // Two fields 5 km apart, the camera between them: the spawn search never
      // places one that close to the last, so the second is placed by hand.
      const second = { ...medium.spawned, centerX: medium.spawned.centerX + 5_000 };
      medium.manager.setAirports([...medium.next.airports, second]);
      const midX = (medium.spawned.centerX + second.centerX) / 2;
      const midZ = (medium.spawned.centerZ + second.centerZ) / 2;
      settle(medium, midX, midZ);
      expect(medium.manager.statistics.fields).toBe(2);
      expect(medium.manager.statistics.structureFields).toBeLessThanOrEqual(1);
      // Out of the build radius: nothing built, nothing kept.
      settle(medium, medium.spawned.centerX + 60_000, medium.spawned.centerZ + 60_000);
      expect(medium.manager.statistics.structureFields).toBe(0);
      expect(spawnedMeshes(medium.scene)).toHaveLength(0);
    } finally {
      medium.dispose();
    }
  });

  it("casts only where the tier casts, and only near the camera", () => {
    for (const [tier, casts] of [[HIGH, true], [MEDIUM, false]] as const) {
      const host = rig(tier);
      try {
        host.manager.setAirports(host.next.airports);
        settle(host, host.spawned.centerX, host.spawned.centerZ);
        host.manager.update(host.spawned.centerX, 300, host.spawned.centerZ);
        const near: Mesh[] = [];
        host.manager.addShadowCasters((mesh) => near.push(mesh));
        // Six casters: everything but the fence.
        expect(near.length).toBe(casts ? 6 : 0);
        expect(near.some((mesh) => mesh.name.endsWith("-fence"))).toBe(false);
      } finally {
        host.dispose();
      }
    }
  });
});

describe("the ground under a spawned airport", () => {
  it("is the consumer's own sampler until an airport spawns, then graded inside its influence only", () => {
    const world = createWorld("alpha");
    const home = world.airport!;
    const spawned = spawnFrom(world, home.centerX + 15_000, home.centerZ);
    const next = withAirports(world, [...world.airports, spawned]);
    const stale = (x: number, z: number): TerrainSample => sampleTerrain(world, x, z);
    expect(withSpawnedAirportGround([], stale, stale)).toBe(stale);

    const live = new LiveAirportGround<TerrainSample>(stale, analyticTerrainOf);
    live.setWorld(world);
    const inside = { x: spawned.centerX, z: spawned.centerZ };
    expect(live.sample(inside.x, inside.z)).toEqual(stale(inside.x, inside.z));
    live.setWorld(next);
    expect(getAirportInfluence(spawned, inside.x, inside.z)).toBeGreaterThan(0);
    expect(live.sample(inside.x, inside.z)).toEqual(sampleTerrain(next, inside.x, inside.z));
    expect(live.sample(inside.x, inside.z).isRunway).toBe(true);
    // Outside every spawned influence: the consumer's answer, untouched.
    for (const [x, z] of [[home.centerX, home.centerZ], [spawned.centerX + 5_000, spawned.centerZ]] as const) {
      expect(live.sample(x, z)).toEqual(stale(x, z));
    }
  });
});
