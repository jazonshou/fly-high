import { VertexBuffer } from "@babylonjs/core/Buffers/buffer";
import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import type { PBRMaterial } from "@babylonjs/core/Materials/PBR/pbrMaterial";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import type { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh";
import type { Mesh } from "@babylonjs/core/Meshes/mesh";
import { Scene } from "@babylonjs/core/scene";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { INITIAL_VISUAL_STATE, type BoatVisualState, type FlightVisualState } from "../src/game/types";
import type { AircraftLightState } from "../src/render/webgpu/lighting/AircraftLighting";
import { DIAL_SWEEP, dialNeedleAngle } from "../src/render/webgpu/boat/boatAtlas";
import * as deck from "../src/render/webgpu/boat/boatDeck";
import { depthSounderText } from "../src/render/webgpu/boat/boatHelm";
import { DRAWN_SECTION_POINTS, drawnHalfSection, hullHalfBreadthAt, hullStations } from "../src/render/webgpu/boat/boatHull";
import { BOAT_SIDELIGHT_ARC_DEGREES } from "../src/render/webgpu/boat/boatLights";
import type { Surface } from "../src/render/webgpu/boat/boatMeshData";
import { createWebGpuBoat, PROPELLER_DISC_RPM, RUNABOUT_21_LAMPS, type BoatVisual } from "../src/render/webgpu/boat/createBoat";
import { HULL_LENGTH, hullHalfSection, RUNABOUT_21_CG, type HullSectionPoint } from "../src/vehicles/boat/hullLines";

/**
 * The Runabout 21 as BUILT (src/render/webgpu/boat/createBoat.ts): the drawn
 * hull is the physics thread's lines, nothing inside the boat shows through
 * its skin, the draw budget holds, and the moving parts move the right way.
 */

let engine: NullEngine;
let scene: Scene;
let boat: BoatVisual;

const boatState = (overrides: Partial<BoatVisualState> = {}): BoatVisualState => ({
  kind: "boat",
  speedThroughWater: 0,
  gear: "neutral",
  lever: 0,
  steerAngle: 0,
  trim: 0,
  trimAngle: 0,
  tabPort: 0,
  tabStarboard: 0,
  depthUnderKeel: 3.4,
  propellerImmersion: 1,
  moored: true,
  ventilating: false,
  capsized: false,
  planing: 0,
  wettedLength: 6,
  transomImmersion: 0.42,
  sprayRoots: [],
  sprayRootCount: 0,
  ...overrides,
});

const visualState = (engineRpm: number, vehicle: BoatVisualState): FlightVisualState => ({ ...INITIAL_VISUAL_STATE, engineRpm, vehicle });

const lights = (overrides: Partial<AircraftLightState> = {}): AircraftLightState => ({
  beacon: 0,
  strobe: 0,
  portNav: 0,
  starboardNav: 0,
  tailNav: 0,
  landing: 0,
  cockpitGlow: 1,
  ...overrides,
});

const meshNamed = (suffix: string): Mesh => boat.meshes.find((mesh) => mesh.name === `speedboat-${suffix}`) as Mesh;

const worldPoint = (node: AbstractMesh | { computeWorldMatrix(force: boolean): unknown; getAbsolutePosition(): Vector3 }): Vector3 => {
  node.computeWorldMatrix(true);
  return node.getAbsolutePosition().clone();
};

beforeAll(() => {
  engine = new NullEngine();
  scene = new Scene(engine);
  scene.useRightHandedSystem = true;
  boat = createWebGpuBoat(scene, "speedboat");
});

afterAll(() => {
  scene?.dispose();
  engine?.dispose();
});

describe("the drawn hull is the physics thread's lines", () => {
  it("draws every point hullHalfSection has, and collapses only features the lines leave out", () => {
    const lines: HullSectionPoint[] = [];
    for (const x of hullStations()) {
      const drawn = drawnHalfSection(x, []);
      expect(drawn).toHaveLength(DRAWN_SECTION_POINTS);
      hullHalfSection(x, lines);
      for (const point of lines) {
        const match = drawn.some(([z, y]) => Math.abs(z - point.z) < 1e-9 && Math.abs(y - point.y) < 1e-9);
        expect(match, `${point.kind} at x=${x.toFixed(3)}`).toBe(true);
      }
      // A drawn point the lines do not have must sit on a neighbour: a zero-width strake or reverse chine.
      for (let index = 1; index < drawn.length; index += 1) {
        const [z, y] = drawn[index]!;
        const inLines = lines.some((point) => Math.abs(z - point.z) < 1e-9 && Math.abs(y - point.y) < 1e-9);
        if (inLines) continue;
        const [pz, py] = drawn[index - 1]!;
        const [nz, ny] = drawn[Math.min(drawn.length - 1, index + 1)]!;
        const onNeighbour = (Math.abs(z - pz) < 1e-9 && Math.abs(y - py) < 1e-9) || (Math.abs(z - nz) < 1e-9 && Math.abs(y - ny) < 1e-9);
        expect(onNeighbour, `extra point ${index} at x=${x.toFixed(3)}`).toBe(true);
      }
    }
  });

  it("keeps every deck, seat, console and fitting vertex inside the hull's skin", () => {
    const groups: Record<string, Surface[]> = {
      cockpit: deck.cockpitSurfaces(),
      foredeck: deck.foredeckSurfaces(),
      foredeckFace: [deck.foredeckFaceSurface()],
      aftDeck: deck.aftDeckSurfaces(),
      motorWell: deck.motorWellSurfaces(),
      seats: deck.seatSurfaces(),
      consoleStarboard: deck.consoleSurfaces("starboard"),
      consolePort: deck.consoleSurfaces("port"),
      cleats: deck.allCleatSurfaces(),
      fittings: deck.fittingSurfaces(),
    };
    for (const [name, surfaces] of Object.entries(groups)) {
      let worst = 0;
      for (const surface of surfaces) {
        const positions = surface.positions;
        for (let at = 0; at < positions.length; at += 3) {
          const x = positions[at]!;
          const y = positions[at + 1]!;
          // The transom's rake and the stem's rounding are their own surfaces; below the sheer only.
          if (x < 0.25 || x > 6.5) continue;
          if (y > drawnHalfSection(x, [])[DRAWN_SECTION_POINTS - 1]![1]) continue;
          worst = Math.max(worst, Math.abs(positions[at + 2]!) - hullHalfBreadthAt(x, y));
        }
      }
      expect(worst, name).toBeLessThan(1e-3);
    }
  });
});

describe("the built boat", () => {
  it("stays inside six draws, with finite geometry in the body frame", () => {
    boat.update(visualState(700, boatState()), 1 / 60);
    const drawn = boat.meshes.filter((mesh) => mesh.isEnabled() && mesh.isVisible);
    expect(drawn.length).toBeLessThanOrEqual(6);
    expect(boat.meshes.every((mesh) => mesh.metadata?.surfaceVehicleVisual === true)).toBe(true);
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    for (const mesh of boat.meshes as Mesh[]) {
      const positions = mesh.getVerticesData(VertexBuffer.PositionKind)!;
      const normals = mesh.getVerticesData(VertexBuffer.NormalKind)!;
      expect(positions.every(Number.isFinite), mesh.name).toBe(true);
      expect(normals.every(Number.isFinite), mesh.name).toBe(true);
      if (mesh.name !== "speedboat-body") continue;
      for (let at = 0; at < positions.length; at += 3) {
        minX = Math.min(minX, positions[at]!);
        maxX = Math.max(maxX, positions[at]!);
        minY = Math.min(minY, positions[at + 1]!);
      }
    }
    // Transom to stem, and the keel 0.56 m below the origin, as the lines.
    expect(minX).toBeCloseTo(-RUNABOUT_21_CG.x, 1);
    expect(maxX).toBeCloseTo(HULL_LENGTH - RUNABOUT_21_CG.x, 1);
    expect(minY).toBeCloseTo(-RUNABOUT_21_CG.y, 2);
  });

  it("swaps the propeller's blades for its blur disc above the disc rpm, in gear only", () => {
    const blades = meshNamed("propeller");
    const disc = meshNamed("propeller-disc");
    boat.update(visualState(700, boatState({ gear: "forward" })), 1 / 60);
    expect([blades.isEnabled(false), disc.isEnabled(false)]).toEqual([true, false]);
    boat.update(visualState(4_800, boatState({ gear: "forward" })), 1 / 60);
    expect(4_800 / 1.85).toBeGreaterThan(PROPELLER_DISC_RPM);
    expect([blades.isEnabled(false), disc.isEnabled(false)]).toEqual([false, true]);
    boat.update(visualState(4_800, boatState({ gear: "neutral" })), 1 / 60);
    expect([blades.isEnabled(false), disc.isEnabled(false)]).toEqual([true, false]);
  });

  it("turns the propeller clockwise seen from astern going ahead", () => {
    boat.update(visualState(700, boatState({ gear: "neutral" })), 1 / 60);
    const before = boat.propeller.rotation.x;
    boat.update(visualState(1_200, boatState({ gear: "forward" })), 1 / 120);
    const ahead = boat.propeller.rotation.x - before;
    boat.update(visualState(1_200, boatState({ gear: "reverse" })), 1 / 120);
    const astern = boat.propeller.rotation.x - before - ahead;
    expect(ahead).toBeGreaterThan(0);
    expect(astern).toBeLessThan(0);
  });

  it("tilts the lower unit aft and up with trim, and swings the propeller to starboard to turn the bow to starboard", () => {
    boat.update(visualState(700, boatState()), 1 / 60);
    const rest = worldPoint(boat.propeller);
    boat.update(visualState(700, boatState({ trimAngle: 0.15 })), 1 / 60);
    const trimmed = worldPoint(boat.propeller);
    expect(trimmed.x).toBeLessThan(rest.x);
    expect(trimmed.y).toBeGreaterThan(rest.y);
    boat.update(visualState(700, boatState({ steerAngle: 0.3 })), 1 / 60);
    const steered = worldPoint(boat.propeller);
    expect(steered.z).toBeGreaterThan(rest.z + 0.05);
    boat.update(visualState(700, boatState()), 1 / 60);
  });

  it("uploads the helm only when it moved, and lights the depth sounder's segments", () => {
    const pose = { steerAngle: 0.1, lever: 0.5, engineRpm: 3_000, speedMetersPerSecond: 10, trim: 0.4, depthMeters: 3.4 };
    expect(boat.helm.pose(pose)).toBe(true);
    expect(boat.helm.pose(pose)).toBe(false);
    const collapsed = (): number => {
      // A dark segment's vertices all sit on one point: count vertex runs that repeat their predecessor.
      let repeats = 0;
      const positions = boat.helm.positions;
      for (let at = 3; at < positions.length; at += 3) {
        if (positions[at] === positions[at - 3] && positions[at + 1] === positions[at - 2] && positions[at + 2] === positions[at - 1]) repeats += 1;
      }
      return repeats;
    };
    boat.helm.pose({ ...pose, depthMeters: 27.1 }); // "88.9" ft: every segment of the first two digits lit
    const bright = collapsed();
    boat.helm.pose({ ...pose, depthMeters: Number.NaN }); // "---": only the three g segments
    expect(collapsed()).toBeGreaterThan(bright);
  });

  it("puts the sidelights' lenses across their own 112.5 degrees, red to port and green to starboard", () => {
    const lamps = meshNamed("lamps");
    const positions = lamps.getVerticesData(VertexBuffer.PositionKind)!;
    const uvs = lamps.getVerticesData(VertexBuffer.UVKind)!;
    const centreX = RUNABOUT_21_LAMPS.port[0] - 0.02;
    const arc = BOAT_SIDELIGHT_ARC_DEGREES + 1e-6;
    let red = 0;
    let green = 0;
    for (let vertex = 0; vertex < positions.length / 3; vertex += 1) {
      const u = uvs[vertex * 2]!;
      if (u > 0.5) continue;
      const bearing = Math.atan2(positions[vertex * 3 + 2]!, positions[vertex * 3]! - centreX) * (180 / Math.PI);
      if (u < 0.25) {
        red += 1;
        expect(bearing).toBeGreaterThanOrEqual(-arc);
        expect(bearing).toBeLessThanOrEqual(1e-6);
      } else {
        green += 1;
        expect(bearing).toBeGreaterThanOrEqual(-1e-6);
        expect(bearing).toBeLessThanOrEqual(arc);
      }
    }
    expect(red).toBeGreaterThan(0);
    expect(green).toBe(red);
  });

  it("lights the lamps and the dash with the lighting law's states", () => {
    const lamp = meshNamed("lamps").material as PBRMaterial;
    const body = meshNamed("body").material as PBRMaterial;
    boat.setLightState(lights());
    expect(lamp.emissiveIntensity).toBe(0);
    const day = body.emissiveIntensity;
    boat.setLightState(lights({ portNav: 1, starboardNav: 1, tailNav: 1, cockpitGlow: 3.2 }));
    expect(lamp.emissiveIntensity).toBeGreaterThan(0);
    expect(body.emissiveIntensity).toBeCloseTo(day * 3.2, 6);
    boat.setLightState(lights());
  });
});

describe("the helm's instruments", () => {
  it("reads the depth sounder in feet and tenths, dashes when it has no echo", () => {
    expect(depthSounderText(3.4)).toBe("112");
    expect(depthSounderText(0.2)).toBe(" 07");
    expect(depthSounderText(100)).toBe("999");
    expect(depthSounderText(Number.NaN)).toBe("---");
    expect(depthSounderText(-1)).toBe("---");
  });

  it("sweeps each needle across its dial's printed scale", () => {
    for (const dial of Object.keys(DIAL_SWEEP) as (keyof typeof DIAL_SWEEP)[]) {
      const sweep = DIAL_SWEEP[dial];
      expect(dialNeedleAngle(dial, sweep.minimum)).toBeCloseTo(sweep.startDegrees * (Math.PI / 180), 9);
      expect(dialNeedleAngle(dial, sweep.maximum)).toBeCloseTo(sweep.endDegrees * (Math.PI / 180), 9);
      expect(dialNeedleAngle(dial, sweep.maximum * 2)).toBeCloseTo(sweep.endDegrees * (Math.PI / 180), 9);
    }
  });
});

describe("disposal", () => {
  it("leaves nothing of the boat in the scene", () => {
    const local = new Scene(engine);
    const meshes = local.meshes.length;
    const materials = local.materials.length;
    // The environment BRDF lookup is the scene's, made by its first PBR material and kept.
    const owned = (): number => local.textures.filter((texture) => !texture.name.includes("EnvironmentBRDF")).length;
    const textures = owned();
    const transforms = local.transformNodes.length;
    const visual = createWebGpuBoat(local, "speedboat");
    expect(local.meshes.length).toBeGreaterThan(meshes);
    visual.dispose();
    expect(local.meshes.length).toBe(meshes);
    expect(local.materials.length).toBe(materials);
    expect(owned()).toBe(textures);
    expect(local.transformNodes.length).toBe(transforms);
    local.dispose();
  });
});

