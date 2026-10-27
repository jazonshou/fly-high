import { describe, expect, it } from "vitest";
import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import { Frustum } from "@babylonjs/core/Maths/math.frustum";
import { Matrix, Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Scene } from "@babylonjs/core/scene";
import { FreeCamera } from "@babylonjs/core/Cameras/freeCamera";
import { resolveWebGpuQualityProfile } from "../src/render/webgpu/core/QualityProfile";
import type { ShaderMaterial } from "@babylonjs/core/Materials/shaderMaterial";
import { WATER_RENDERING_GROUP_ID } from "../src/render/webgpu/core/RenderingGroups";
import { LIGHT_POINT_ALPHA_INDEX, LightPointSystem } from "../src/render/webgpu/lighting/LightPoints";
import { MarinaSystem } from "../src/render/webgpu/marina/MarinaSystem";
import {
  buildMarinaSilhouette,
  buildMooredRunaboutGeometry,
  MARINA_VISUAL,
  marinaBeaconLit,
  marinaBoatInstances,
  marinaBoxInstances,
  marinaLampColours,
  marinaLamps,
  marinaLevelOfDetail,
  marinaPostInstances,
} from "../src/render/webgpu/marina/marinaVisual";
import { ColliderWorld } from "../src/sim/colliders";
import { addMarinaColliders } from "../src/sim/marina/colliders";
import type { Vec3 } from "../src/sim/types";
import { RUNABOUT_21_REST_WATERLINE } from "../src/vehicles/boat/hullLines";
import { createWorld } from "../src/world";
import { homeMarina } from "../src/world/marina";
import { FLOATING_BOX_KINDS, MARINA_MOORED_BOAT_BOX, marinaToWorld, type MarinaLayout } from "../src/world/marinaLayout";

/**
 * The home marina as drawn (src/render/webgpu/marina/): every drawn part is
 * where the layout and the colliders put it, the draw budget holds on every
 * tier (at most 10, and none beyond 4 km), the lamps ride the airfield's one
 * light draw, and the beacons flash green and red every 4 s.
 */

const TIER_PROFILES = ([["low", "balanced"], ["medium", "balanced"], ["high", "balanced"], ["high", "ultra"]] as const)
  .map(([quality, mode]) => resolveWebGpuQualityProfile(quality, mode));

/** A breakwater-less marina and one behind a breakwater (the GPU parity test's pair). */
const LAYOUTS: readonly MarinaLayout[] = [homeMarina(createWorld("open-skies")), homeMarina(createWorld(2_871_296_461))];

function instancePoint(matrices: Float32Array, index: number, layout: MarinaLayout, local: Vec3): Vec3 {
  const matrix = Matrix.FromArray(matrices, index * 16);
  const p = Vector3.TransformCoordinates(new Vector3(local.x, local.y, local.z), matrix);
  return { x: p.x + layout.site.x, y: p.y, z: p.z + layout.site.z };
}

function expectNear(actual: Vec3, expected: Vec3, label: string, tolerance = 1e-3): void {
  expect(Math.hypot(actual.x - expected.x, actual.y - expected.y, actual.z - expected.z), label).toBeLessThan(tolerance);
}

describe("marina parts as drawn", () => {
  it("draws every box where its collider stands, corner for corner", () => {
    for (const layout of LAYOUTS) {
      const colliders = new ColliderWorld();
      const marina = addMarinaColliders(colliders, layout);
      const instances = marinaBoxInstances(layout);
      const rings = layout.boxes.filter((box) => box.kind === "lifeRingStand").length;
      expect(instances.count).toBe(layout.boxes.length + rings);
      let staticIndex = layout.posts.filter((post) => ["pile", "guidePile", "beaconPost", "lampPost"].includes(post.kind)).length;
      let pontoonIndex = 0;
      let drawn = 0;
      for (const box of layout.boxes) {
        const index = drawn;
        drawn += box.kind === "lifeRingStand" ? 2 : 1;
        if (box.kind === "lifeRingStand" || box.kind === "fuelPump") continue;
        const handle = FLOATING_BOX_KINDS.has(box.kind) ? marina.pontoons[pontoonIndex++]!.handle : marina.staticHandles[staticIndex++]!;
        for (const corner of [[1, 1, 1], [-1, 1, -1], [1, -1, -1], [-1, -1, 1]] as const) {
          const expected = colliders.localToWorld(handle, {
            x: corner[0] * box.halfRight, y: corner[1] * box.halfHeight, z: corner[2] * box.halfOut,
          }, { x: 0, y: 0, z: 0 });
          const actual = instancePoint(instances.matrices, index, layout, { x: corner[0] * 0.5, y: corner[1] * 0.5, z: corner[2] * 0.5 });
          expectNear(actual, expected, `${box.kind} at ${box.right},${box.out}`);
        }
      }
    }
  });

  it("draws every post on its own axis, foot to top", () => {
    const layout = LAYOUTS[0]!;
    const instances = marinaPostInstances(layout);
    expect(instances.count).toBe(layout.posts.length);
    layout.posts.forEach((post, index) => {
      const p = marinaToWorld(layout.frame, post.right, post.out);
      expectNear(instancePoint(instances.matrices, index, layout, { x: 0, y: -0.5, z: 0 }), { x: p.x, y: post.bottomY, z: p.z }, `${post.kind} foot`);
      expectNear(instancePoint(instances.matrices, index, layout, { x: 1, y: 0.5, z: 0 }), { x: p.x + post.radius, y: post.topY, z: p.z }, `${post.kind} top`);
    });
    // Beacon towers wear their light's colour.
    const beaconPosts = layout.posts.map((post, index) => ({ post, index })).filter(({ post }) => post.kind === "beaconPost");
    expect(beaconPosts.length).toBe(layout.beacons.length);
    for (const { post, index } of beaconPosts) {
      const beacon = layout.beacons.find((candidate) => candidate.right === post.right && candidate.out === post.out)!;
      const red = instances.colors[index * 4]!;
      const green = instances.colors[index * 4 + 1]!;
      expect(beacon.color === "red" ? red > green : green > red).toBe(true);
    }
  });

  it("moors a runabout at every occupied berth, bow on its heading, floating at its rest waterline", () => {
    for (const layout of LAYOUTS) {
      const instances = marinaBoatInstances(layout);
      const occupied = layout.berths.filter((berth) => berth.occupied);
      expect(instances.count).toBe(occupied.length);
      expect(occupied.some((berth) => berth.start)).toBe(false);
      occupied.forEach((berth, index) => {
        const p = marinaToWorld(layout.frame, berth.right, berth.out);
        const centre = instancePoint(instances.matrices, index, layout, { x: 0, y: 0, z: 0 });
        expectNear(centre, { x: p.x, y: layout.seaLevel + RUNABOUT_21_REST_WATERLINE.cgAboveWater, z: p.z }, `berth ${berth.index}`);
        const bow = instancePoint(instances.matrices, index, layout, { x: 1, y: 0, z: 0 });
        const heading = Math.atan2(bow.x - centre.x, bow.z - centre.z);
        expect(Math.cos(heading - berth.bowHeadingRadians)).toBeCloseTo(1, 6);
      });
    }
  });

  it("puts a collider in every moored runabout, bow to transom and beam to beam", () => {
    for (const layout of LAYOUTS) {
      const colliders = new ColliderWorld();
      const marina = addMarinaColliders(colliders, layout);
      const instances = marinaBoatInstances(layout);
      const staticPosts = layout.posts.filter((post) => ["pile", "guidePile", "beaconPost", "lampPost"].includes(post.kind)).length;
      const staticBoxes = layout.boxes.filter((box) => box.kind !== "lifeRingStand" && box.kind !== "fuelPump" && !FLOATING_BOX_KINDS.has(box.kind)).length;
      const occupied = layout.berths.filter((berth) => berth.occupied);
      expect(marina.staticHandles.length).toBe(staticPosts + staticBoxes + occupied.length);
      occupied.forEach((berth, index) => {
        const handle = marina.staticHandles[staticPosts + staticBoxes + index]!;
        const zero = { x: 0, y: 0, z: 0 };
        const centre = colliders.localToWorld(handle, zero, { x: 0, y: 0, z: 0 });
        const axis = (local: Vec3) => {
          const p = colliders.localToWorld(handle, local, { x: 0, y: 0, z: 0 });
          return { x: p.x - centre.x, y: p.y - centre.y, z: p.z - centre.z };
        };
        const axes = [axis({ x: 1, y: 0, z: 0 }), axis({ x: 0, y: 1, z: 0 }), axis({ x: 0, y: 0, z: 1 })];
        const halves = [MARINA_MOORED_BOAT_BOX.beam / 2, (MARINA_MOORED_BOAT_BOX.bottomBelowWater + MARINA_MOORED_BOAT_BOX.topAboveWater) / 2, MARINA_MOORED_BOAT_BOX.length / 2];
        // Body frame, from the CG: near the bow, near the transom, and each side at the CG.
        for (const body of [{ x: 4.3, y: 0, z: 0 }, { x: -1.65, y: 0, z: 0 }, { x: 0, y: 0, z: 1.15 }, { x: 0, y: 0, z: -1.15 }, { x: 1, y: -0.5, z: 0 }]) {
          const p = instancePoint(instances.matrices, index, layout, body);
          axes.forEach((u, k) => {
            const along = (p.x - centre.x) * u.x + (p.y - centre.y) * u.y + (p.z - centre.z) * u.z;
            expect(Math.abs(along), `berth ${berth.index}, body ${body.x},${body.y},${body.z}, axis ${k}`).toBeLessThanOrEqual(halves[k]! + 1e-6);
          });
        }
      });
    }
  });

  it("keeps the moored runabout and the silhouette light", () => {
    const boat = buildMooredRunaboutGeometry();
    // About two-thirds of the drawn boat's 10,186 vertices: the hull skin and
    // rub rail at a third of the stations, the deck, seats and outboard as
    // drawn, because the dock start sees its neighbours from a few metres.
    expect(boat.positions.length / 3).toBeLessThan(7_000);
    expect(boat.positions.length / 3).toBeGreaterThan(2_000);
    expect(boat.colors.length / 4).toBe(boat.positions.length / 3);
    for (const layout of LAYOUTS) {
      const silhouette = buildMarinaSilhouette(layout);
      expect(silhouette.positions.length / 3).toBeLessThan(4_000);
      expect(silhouette.indices.length % 3).toBe(0);
    }
  });
});

describe("marina level of detail", () => {
  it("switches at 1.5 km and 4 km, with a band against flicker", () => {
    const V = MARINA_VISUAL;
    expect(V.detailMeters).toBe(1_500);
    expect(V.cullMeters).toBe(4_000);
    expect(marinaLevelOfDetail(100, null)).toBe("detail");
    expect(marinaLevelOfDetail(1_499, null)).toBe("detail");
    expect(marinaLevelOfDetail(1_501, null)).toBe("silhouette");
    expect(marinaLevelOfDetail(3_999, null)).toBe("silhouette");
    expect(marinaLevelOfDetail(4_001, null)).toBe("culled");
    // Inside the band, the current level holds.
    expect(marinaLevelOfDetail(1_520, "detail")).toBe("detail");
    expect(marinaLevelOfDetail(1_480, "silhouette")).toBe("silhouette");
    expect(marinaLevelOfDetail(3_980, "culled")).toBe("culled");
    expect(marinaLevelOfDetail(4_020, "silhouette")).toBe("silhouette");
    // Past the band, it switches.
    expect(marinaLevelOfDetail(V.detailMeters - V.hysteresisMeters + 1, "silhouette")).toBe("silhouette");
    expect(marinaLevelOfDetail(V.detailMeters - V.hysteresisMeters - 1, "silhouette")).toBe("detail");
    expect(marinaLevelOfDetail(V.detailMeters + V.hysteresisMeters + 1, "detail")).toBe("silhouette");
    expect(marinaLevelOfDetail(V.cullMeters - V.hysteresisMeters - 1, "culled")).toBe("silhouette");
    expect(marinaLevelOfDetail(V.cullMeters + V.hysteresisMeters + 1, "silhouette")).toBe("culled");
  });
});

describe("marina lamps", () => {
  const layout = LAYOUTS[0]!;
  const lamps = marinaLamps(layout);

  it("lights every lamp steady and flashes each beacon for 0.5 s in 4 s, green and red out of step", () => {
    expect(lamps.fixtures.length).toBe(layout.lamps.length + layout.beacons.length);
    expect(layout.beacons.map((beacon) => beacon.color).sort()).toEqual(["green", "red"]);
    for (const beacon of layout.beacons) {
      let lit = 0;
      for (let t = 0; t < 40; t += 0.01) if (marinaBeaconLit(beacon, t)) lit += 1;
      // 10 periods of 4 s, 0.5 s lit in each: 500 of 4,000 samples.
      expect(Math.abs(lit - 500)).toBeLessThanOrEqual(10);
    }
    const [green, red] = ["green", "red"].map((colour) => layout.beacons.find((beacon) => beacon.color === colour)!);
    for (let t = 0; t < 8; t += 0.05) expect(marinaBeaconLit(green!, t) && marinaBeaconLit(red!, t)).toBe(false);
  });

  it("reports a colour change only on a flash edge or a cull", () => {
    const colours: (readonly [number, number, number])[] = [];
    expect(marinaLampColours(layout, lamps, 0, true, colours)).toBe(true);
    expect(colours.length).toBe(lamps.fixtures.length);
    let changes = 0;
    for (let t = 0; t < 8; t += 1 / 60) if (marinaLampColours(layout, lamps, t, true, colours)) changes += 1;
    // Two beacons, two edges a flash, two flashes each in 8 s.
    expect(changes).toBeLessThanOrEqual(8);
    expect(changes).toBeGreaterThanOrEqual(6);
    expect(marinaLampColours(layout, lamps, 8, false, colours)).toBe(true);
    expect(colours.every((colour) => colour[0] === 0 && colour[1] === 0 && colour[2] === 0)).toBe(true);
    expect(marinaLampColours(layout, lamps, 9, false, colours)).toBe(false);
  });
});

function rig(castsShadows: boolean) {
  const engine = new NullEngine();
  const scene = new Scene(engine);
  scene.activeCamera = new FreeCamera("probe", new Vector3(0, 5, -20), scene);
  const layout = LAYOUTS[0]!;
  const marina = new MarinaSystem(scene, layout, { castsShadows });
  return { engine, scene, layout, marina, dispose: () => { marina.dispose(); scene.dispose(); engine.dispose(); } };
}

describe("MarinaSystem", () => {
  it("holds the draw budget on every tier: 10 at most near, 1 at range, 0 beyond 4 km", () => {
    for (const profile of TIER_PROFILES) {
      const { marina, layout, dispose } = rig(profile.marinaCastsShadows);
      try {
        const at = (distance: number) => marina.update(layout.site.x + distance, layout.seaLevel, layout.site.z, 0);
        // The first frame draws everything once, for the pipelines.
        at(10_000);
        expect(marina.statistics.enabledMeshes).toBe(marina.meshes.length);
        at(200);
        const casters = marina.statistics.shadowCasters;
        const near = marina.statistics.enabledMeshes;
        expect(near).toBeLessThanOrEqual(3);
        expect(near + casters * profile.shadowCascades, `tier ${profile.tier}`).toBeLessThanOrEqual(10);
        at(2_500);
        expect(marina.statistics.enabledMeshes).toBe(1);
        expect(marina.statistics.shadowCasters).toBe(0);
        at(4_500);
        expect(marina.statistics.enabledMeshes).toBe(0);
        expect(marina.statistics.level).toBe("culled");
        expect(casters).toBe(profile.marinaCastsShadows ? 3 : 0);
      } finally {
        dispose();
      }
    }
  });

  it("casts only while it and its shadows' reach are in view, and hands the renderer nothing otherwise", () => {
    const { scene, marina, layout, dispose } = rig(true);
    try {
      const camera = scene.activeCamera as FreeCamera;
      const planesLooking = (target: Vector3) => {
        camera.setTarget(target);
        return Frustum.GetPlanes(camera.getViewMatrix(true).multiply(camera.getProjectionMatrix(true)));
      };
      const site = new Vector3(layout.site.x, layout.seaLevel, layout.site.z);
      camera.position.set(site.x + 900, layout.seaLevel + 20, site.z);
      const collected = () => {
        const meshes: string[] = [];
        marina.addShadowCasters((mesh) => meshes.push(mesh.name));
        return meshes.sort();
      };
      // The warm-up frame casts, wherever the camera looks, for the pipelines.
      marina.update(camera.position.x, camera.position.y, camera.position.z, 0, planesLooking(site.add(new Vector3(2_000, 0, 0))));
      expect(collected()).toEqual(["marina-boats", "marina-boxes", "marina-posts"]);
      marina.update(camera.position.x, camera.position.y, camera.position.z, 0, planesLooking(site));
      expect(collected()).toEqual(["marina-boats", "marina-boxes", "marina-posts"]);
      // Looking away, 900 m off: in detail range, drawn by nothing, cast by nothing.
      marina.update(camera.position.x, camera.position.y, camera.position.z, 0.1, planesLooking(site.add(new Vector3(2_000, 0, 0))));
      expect(marina.statistics.level).toBe("detail");
      expect(collected()).toEqual([]);
      // Turned so the marina sits just off the edge of the view: its shadows
      // could still fall in it, so it casts.
      marina.update(camera.position.x, camera.position.y, camera.position.z, 0.2, planesLooking(site.add(new Vector3(0, 0, -700))));
      expect(collected()).toEqual(["marina-boats", "marina-boxes", "marina-posts"]);
    } finally {
      dispose();
    }
  });

  it("puts its lamps in the airfield's light draw and builds no light mesh of its own", () => {
    const { scene, marina, layout, dispose } = rig(true);
    try {
      expect(scene.meshes.map((mesh) => mesh.name).sort()).toEqual(
        ["marina-boats", "marina-boxes", "marina-posts", "marina-silhouette"],
      );
      const airfield = 7;
      const placeholders = Array.from({ length: airfield }, () => marina.lampFixtures[0]!);
      const lights = new LightPointSystem(scene, [...placeholders, ...marina.lampFixtures], 1);
      lights.setColorRange(airfield, marina.lampColours);
      expect(() => lights.setColorRange(airfield + 1, marina.lampColours)).toThrow(RangeError);
      expect(marina.lampFixtures.length).toBe(layout.lamps.length + layout.beacons.length);
      lights.dispose();
    } finally {
      dispose();
    }
  });

  it("draws the lamps after the water, so a beacon seen against the sea keeps its light", () => {
    const { scene, marina, dispose } = rig(false);
    try {
      const lights = new LightPointSystem(scene, marina.lampFixtures, 1);
      const mesh = scene.getMeshByName("light-points")!;
      // The light points write no depth: drawn before the water, the sea
      // passed the depth test behind every beacon and painted over it.
      expect((mesh.material as ShaderMaterial).disableDepthWrite).toBe(true);
      expect(mesh.renderingGroupId).toBe(WATER_RENDERING_GROUP_ID);
      expect(mesh.alphaIndex).toBe(LIGHT_POINT_ALPHA_INDEX);
      // After the ocean (0), inland water (1) and the wake (1.5); before the
      // steam (2) and spray (2.5), which stand in front of a lamp.
      expect(LIGHT_POINT_ALPHA_INDEX).toBeGreaterThan(1.5);
      expect(LIGHT_POINT_ALPHA_INDEX).toBeLessThan(2);
      lights.dispose();
    } finally {
      dispose();
    }
  });

  it("rides the floating origin", () => {
    const { marina, layout, dispose } = rig(false);
    try {
      marina.setFloatingOrigin(4_096, -8_192);
      expect(marina.root.position.x).toBe(layout.site.x - 4_096);
      expect(marina.root.position.z).toBe(layout.site.z + 8_192);
    } finally {
      dispose();
    }
  });
});
