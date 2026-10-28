import { Constants } from "@babylonjs/core/Engines/constants";
import { BoundingInfo } from "@babylonjs/core/Culling/boundingInfo";
import type { PBRMaterial } from "@babylonjs/core/Materials/PBR/pbrMaterial";
import { RawTexture } from "@babylonjs/core/Materials/Textures/rawTexture";
import { Texture } from "@babylonjs/core/Materials/Textures/texture";
import type { Material } from "@babylonjs/core/Materials/material";
import { Color3 } from "@babylonjs/core/Maths/math.color";
import { Quaternion, Vector3 } from "@babylonjs/core/Maths/math.vector";
import type { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { SubMesh } from "@babylonjs/core/Meshes/subMesh";
import "@babylonjs/core/Meshes/thinInstanceMesh";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import type { Scene } from "@babylonjs/core/scene";
import type { CarVisualState, FlightVisualState } from "@/src/game/types";
import { AIRFRAME_TRANSPARENCY_RENDERING_GROUP_ID } from "@/src/render/webgpu/core/RenderingGroups";
import type { AircraftLightState } from "@/src/render/webgpu/lighting/AircraftLighting";
import type { SurfaceVehicleKind } from "@/src/vehicles/kinds";
import { AircraftBuildContext, isAlphaBlendedAirframeMaterial } from "../aircraft/builders";
import { createGlowApplier } from "../aircraft/airframeRig";
import { BoatMeshData, type Surface, type Vec3Tuple } from "../boat/boatMeshData";
import type { VehicleVisual } from "../vehicle/types";
import { createCarAtlasTextures } from "./carAtlas";
import { CAR_LAMP_TEXEL_COUNT, CAR_LAMP_TEXELS, carBodySurfaces, carLampSurfaces } from "./carBody";
import { CAR_DIALS, cabinSurfaces, needleSurfaces, STEERING_WHEEL_CENTRE, steeringWheelSurfaces, writeNeedleMatrices } from "./carCockpit";
import { carLampState, CAR_LAMPS_OFF, type CarLampState } from "./carLights";
import {
  axlePose,
  CAR_COILS,
  CAR_LINKS,
  CAR_WHEEL_INSTANCES,
  COIL,
  coilSurfaces,
  frontAxleSurfaces,
  linkSurfaces,
  rearAxleSurfaces,
  RUNNING_GEAR_BOUNDS,
  wheelSurfaces,
  writeLinkMatrices,
  writeWheelMatrices,
  type CarAxle,
} from "./carRunningGear";
import { FRONT_DOOR_HINGE, STEERING_WHEEL } from "./lc76Lines";

/**
 * The LandCruiser 76 GXL wagon, drawn: `createWebGpuCar(scene, kind)` returns
 * the renderer's `VehicleVisual` for the car.
 *
 * BODY FRAME. As every vehicle's: +X forward, +Y up, +Z right (the driver's
 * side, right-hand drive), origin at the centre of gravity the car sim
 * reports, 0.80 m above flat ground at kerb ride.
 *
 * DRAWS: nine outside, seven in the cockpit view.
 *   1. `landcruiser-body`: shell, glasshouse, bumpers, flares, mirrors,
 *      snorkel, underbody and the whole cabin with its dial faces (one atlas
 *      material, opaque, casts the car's shadow);
 *   2. `landcruiser-glass`: every window, tinted glass blended over the
 *      cabin and the scene (hidden from the cockpit: the driver looks through
 *      clean glass);
 *   3-4. `landcruiser-front-axle`, `landcruiser-rear-axle`: housings and
 *      differentials, on nodes that heave and roll (cast shadows);
 *   5. `landcruiser-wheels`: the four wheels and the spare, five thin
 *      instances of one tyre and steel wheel (cast shadows);
 *   6. `landcruiser-links`: dampers, radius arms, Panhard rod, leaf packs and
 *      propeller shafts, thin instances of one bar (hidden from the cockpit);
 *   7. `landcruiser-coils`: the front coil springs (hidden from the cockpit);
 *   8. `landcruiser-lamps`: every lens, emissive by a texel per lamp;
 *   9. `landcruiser-steering-wheel`;
 *   10. `landcruiser-needles`: the four gauge needles, cockpit view only.
 *
 * THE FRONT DOORS draw in the body's and the glass's meshes while shut, as
 * those meshes' last index runs. One that opens (`setDoors`) drops out of
 * them and draws on its hinge instead, `landcruiser-door-right` or `-left`
 * with its `-glass`: two more draws, only while a door stands open.
 */

function meshFrom(name: string, surfaces: { readonly single?: readonly Surface[]; readonly symmetric?: readonly Surface[] }, scene: Scene): Mesh {
  const data = new BoatMeshData();
  for (const surface of surfaces.symmetric ?? []) data.addSymmetric(surface);
  for (const surface of surfaces.single ?? []) data.add(surface);
  const mesh = new Mesh(name, scene);
  data.toVertexData().applyToMesh(mesh, false);
  return mesh;
}

/**
 * A mesh whose last two index runs are the right and the left front door's
 * parts, so the draw can leave out an open door's (`drawDoorsShut`): one
 * draw while both are shut, exactly the surfaces as listed.
 */
function meshWithDoors(
  name: string,
  surfaces: { readonly single?: readonly Surface[]; readonly symmetric?: readonly Surface[] },
  door: readonly Surface[],
  scene: Scene,
): { readonly mesh: Mesh; readonly runs: DoorRuns } {
  const data = new BoatMeshData();
  for (const surface of surfaces.symmetric ?? []) data.addSymmetric(surface);
  for (const surface of surfaces.single ?? []) data.add(surface);
  const rest = data.indices.length;
  for (const surface of door) data.add(surface);
  const right = data.indices.length - rest;
  for (const surface of door) data.add(surface.mirrored());
  const left = data.indices.length - rest - right;
  const mesh = new Mesh(name, scene);
  data.toVertexData().applyToMesh(mesh, false);
  return { mesh, runs: { rest, right, left } };
}

/** Index counts: everything but the doors, then the right door's, then the left's. */
interface DoorRuns {
  readonly rest: number;
  readonly right: number;
  readonly left: number;
}

/** Draws a door-split mesh with each door's run in or out: in while that door is shut. */
function drawDoorsShut(mesh: Mesh, runs: DoorRuns, rightShut: boolean, leftShut: boolean): void {
  const vertices = mesh.getTotalVertices();
  mesh.releaseSubMeshes();
  if (rightShut && leftShut) {
    new SubMesh(0, 0, vertices, 0, runs.rest + runs.right + runs.left, mesh);
  } else if (rightShut) {
    new SubMesh(0, 0, vertices, 0, runs.rest + runs.right, mesh);
  } else {
    new SubMesh(0, 0, vertices, 0, runs.rest, mesh);
    if (leftShut) new SubMesh(0, 0, vertices, runs.rest + runs.right, runs.left, mesh);
  }
}

/** One side's front door drawn on its own, about its hinge, while it is open. */
function doorMesh(name: string, surfaces: readonly Surface[], side: 1 | -1, hinge: Vec3Tuple, scene: Scene): Mesh {
  const data = new BoatMeshData();
  for (const surface of surfaces) data.add(side === 1 ? surface : surface.mirrored(), hinge);
  const mesh = new Mesh(name, scene);
  data.toVertexData().applyToMesh(mesh, false);
  return mesh;
}

function finish(mesh: Mesh, material: Material, parent: TransformNode, castsShadow: boolean): Mesh {
  mesh.material = material;
  if (isAlphaBlendedAirframeMaterial(material)) mesh.renderingGroupId = AIRFRAME_TRANSPARENCY_RENDERING_GROUP_ID;
  mesh.parent = parent;
  mesh.isPickable = false;
  mesh.receiveShadows = true;
  mesh.metadata = { ...(mesh.metadata as Record<string, unknown> | null), surfaceVehicleVisual: true, castsShadow };
  mesh.refreshBoundingInfo();
  return mesh;
}

/** Thin instances posed every frame, inside fixed bounds (their posed extent at any travel). */
function instanced(mesh: Mesh, count: number): Float32Array {
  const matrices = new Float32Array(count * 16);
  for (let index = 0; index < count; index += 1) matrices[index * 16] = matrices[index * 16 + 5] = matrices[index * 16 + 10] = matrices[index * 16 + 15] = 1;
  mesh.thinInstanceSetBuffer("matrix", matrices, 16, false);
  mesh.doNotSyncBoundingInfo = true;
  mesh.setBoundingInfo(new BoundingInfo(Vector3.FromArray(RUNNING_GEAR_BOUNDS.min), Vector3.FromArray(RUNNING_GEAR_BOUNDS.max)));
  return matrices;
}

/** The lenses' unlit colours, sRGB, by `CAR_LAMP_TEXELS`. */
const LENS_COLOURS: readonly (readonly [number, number, number])[] = [
  [222, 226, 230],
  [236, 238, 240],
  [150, 20, 18],
  [226, 226, 228],
  [205, 112, 22],
  [150, 20, 18],
  [0, 0, 0],
  [0, 0, 0],
];

/** The lamps' emissive texels for a lamp state: what each lens gives off. */
export function carLampTexels(lamps: CarLampState, out: Uint8Array<ArrayBuffer> = new Uint8Array(CAR_LAMP_TEXEL_COUNT * 4)): Uint8Array<ArrayBuffer> {
  const set = (texel: number, colour: readonly [number, number, number], level: number): void => {
    const l = Math.min(1, Math.max(0, level));
    out[texel * 4] = Math.round(colour[0] * l);
    out[texel * 4 + 1] = Math.round(colour[1] * l);
    out[texel * 4 + 2] = Math.round(colour[2] * l);
    out[texel * 4 + 3] = 255;
  };
  const white: readonly [number, number, number] = [255, 248, 236];
  const red: readonly [number, number, number] = [255, 22, 14];
  set(CAR_LAMP_TEXELS.headlamp, white, lamps.main > 0 ? 1 : lamps.dipped * 0.72);
  set(CAR_LAMP_TEXELS.dayRunning, [244, 248, 255], lamps.dayRunning);
  // The tail lamp is the stop lamp's dim filament.
  set(CAR_LAMP_TEXELS.tail, red, Math.max(lamps.tail * 0.3, lamps.brake));
  set(CAR_LAMP_TEXELS.reverse, white, lamps.reverse);
  set(CAR_LAMP_TEXELS.indicator, [255, 140, 20], 0);
  set(CAR_LAMP_TEXELS.highStop, red, lamps.brake);
  set(6, white, 0);
  set(7, white, 0);
  return out;
}

export interface CarVisual extends VehicleVisual {
  readonly axles: Readonly<Record<CarAxle, TransformNode>>;
  readonly steeringWheel: TransformNode;
  /** The lamp state drawn now, for tests. */
  lampState(): CarLampState;
}

export function createWebGpuCar(scene: Scene, kind: SurfaceVehicleKind): CarVisual {
  const build = new AircraftBuildContext(scene);
  const root = new TransformNode(`${kind}-root`, scene);
  root.rotationQuaternion = Quaternion.Identity();
  root.metadata = {
    surfaceVehicleVisual: true,
    vehicleKind: kind,
    handedness: "right",
    bodyAxes: { forward: "+x", up: "+y", starboard: "+z" },
  };

  const atlas = createCarAtlasTextures(scene);
  build.textures.push(atlas.albedo, atlas.metallicRoughness, atlas.emissive);
  const body = build.material(`${kind}-body`, 0xffffff, { roughness: 1, metallic: 1 });
  body.albedoTexture = atlas.albedo;
  body.metallicTexture = atlas.metallicRoughness;
  body.useAmbientOcclusionFromMetallicTextureRed = false;
  body.useRoughnessFromMetallicTextureAlpha = false;
  body.useRoughnessFromMetallicTextureGreen = true;
  body.useMetallnessFromMetallicTextureBlue = true;
  body.emissiveTexture = atlas.emissive;
  body.emissiveColor = Color3.White();
  // The gauges' markings by day; the glow law multiplies it at night.
  body.emissiveIntensity = 0.35;
  // Glossy paint under a clear coat, as a new car's is.
  body.clearCoat.isEnabled = true;
  body.clearCoat.intensity = 0.35;
  body.clearCoat.roughness = 0.08;

  // Tinted glass blended over the cabin and the scene; its depth pre-pass
  // keeps only the nearest pane, so a far window never doubles the tint.
  const glass = build.material(`${kind}-glass`, 0x1b272d, {
    roughness: 0.04,
    metallic: 0,
    alpha: 0.34,
    doubleSided: true,
    clearCoat: { intensity: 1, roughness: 0.02, indexOfRefraction: 1.5 },
  });

  const lensPixels = new Uint8Array(CAR_LAMP_TEXEL_COUNT * 4);
  for (const [texel, colour] of LENS_COLOURS.entries()) lensPixels.set([...colour, 255], texel * 4);
  const lensTexture = new RawTexture(lensPixels, CAR_LAMP_TEXEL_COUNT, 1, Constants.TEXTUREFORMAT_RGBA, scene, false, false, Texture.NEAREST_SAMPLINGMODE, Constants.TEXTURETYPE_UNSIGNED_BYTE, 0, true);
  lensTexture.name = `${kind}-lens-colours`;
  let drawnLamps: CarLampState = CAR_LAMPS_OFF;
  const lampPixels = carLampTexels(drawnLamps);
  const lampTexture = new RawTexture(lampPixels, CAR_LAMP_TEXEL_COUNT, 1, Constants.TEXTUREFORMAT_RGBA, scene, false, false, Texture.NEAREST_SAMPLINGMODE, Constants.TEXTURETYPE_UNSIGNED_BYTE, 0, true);
  lampTexture.name = `${kind}-lamp-emission`;
  build.textures.push(lensTexture, lampTexture);
  const lamp = build.material(`${kind}-lamps`, 0xffffff, { roughness: 0.12, metallic: 0, emissive: 0xffffff, emissiveIntensity: 3 });
  lamp.albedoTexture = lensTexture;
  lamp.emissiveTexture = lampTexture;

  const meshes: AbstractMesh[] = [];
  const surfaces = carBodySurfaces();
  const bodyBuilt = meshWithDoors(`${kind}-body`, { symmetric: surfaces.symmetric, single: [...surfaces.single, ...cabinSurfaces()] }, surfaces.door.body, scene);
  const bodyMesh = finish(bodyBuilt.mesh, body, root, true);
  meshes.push(bodyMesh);
  const glassBuilt = meshWithDoors(`${kind}-glass`, { single: surfaces.glass }, surfaces.door.glass, scene);
  const glassMesh = finish(glassBuilt.mesh, glass, root, false);
  meshes.push(glassMesh);

  // The front doors: drawn in the body until one opens, then on its hinge.
  const doors = ([1, -1] as const).map((side) => {
    const hinge: Vec3Tuple = [FRONT_DOOR_HINGE.x, 0, side * FRONT_DOOR_HINGE.z];
    const node = new TransformNode(`${kind}-door-${side === 1 ? "right" : "left"}-hinge`, scene);
    node.parent = root;
    node.position.set(hinge[0], hinge[1], hinge[2]);
    const name = `${kind}-door-${side === 1 ? "right" : "left"}`;
    const panel = finish(doorMesh(name, surfaces.door.body, side, hinge, scene), body, node, true);
    const pane = finish(doorMesh(`${name}-glass`, surfaces.door.glass, side, hinge, scene), glass, node, false);
    panel.setEnabled(false);
    pane.setEnabled(false);
    meshes.push(panel, pane);
    return { side, node, panel, pane, open: 0 };
  });

  const axles = {} as Record<CarAxle, TransformNode>;
  for (const axle of ["front", "rear"] as const) {
    const node = new TransformNode(`${kind}-${axle}-axle-node`, scene);
    node.parent = root;
    axles[axle] = node;
    const mesh = finish(meshFrom(`${kind}-${axle}-axle`, { single: axle === "front" ? frontAxleSurfaces() : rearAxleSurfaces() }, scene), body, node, true);
    meshes.push(mesh);
  }

  const wheelMesh = finish(meshFrom(`${kind}-wheels`, { single: wheelSurfaces() }, scene), body, root, true);
  const wheelMatrices = instanced(wheelMesh, CAR_WHEEL_INSTANCES);
  meshes.push(wheelMesh);
  const linkMesh = finish(meshFrom(`${kind}-links`, { single: linkSurfaces() }, scene), body, root, false);
  const linkMatrices = instanced(linkMesh, CAR_LINKS.length);
  meshes.push(linkMesh);
  const coilMesh = finish(meshFrom(`${kind}-coils`, { single: coilSurfaces() }, scene), body, root, false);
  const coilMatrices = instanced(coilMesh, CAR_COILS.length);
  meshes.push(coilMesh);

  const lampMesh = finish(meshFrom(`${kind}-lamps`, { single: carLampSurfaces() }, scene), lamp, root, false);
  meshes.push(lampMesh);

  // The wheel's node: at the hub, raked back by the column, then turned about its own axis.
  const wheelTilt = new TransformNode(`${kind}-steering-tilt`, scene);
  wheelTilt.parent = root;
  wheelTilt.position.set(STEERING_WHEEL_CENTRE[0], STEERING_WHEEL_CENTRE[1], STEERING_WHEEL_CENTRE[2]);
  wheelTilt.rotation.z = -STEERING_WHEEL.tiltRadians;
  const steeringWheel = new TransformNode(`${kind}-steering-wheel-node`, scene);
  steeringWheel.parent = wheelTilt;
  const steeringMesh = finish(meshFrom(`${kind}-steering-wheel`, { single: steeringWheelSurfaces() }, scene), body, steeringWheel, false);
  meshes.push(steeringMesh);

  const needleMesh = finish(meshFrom(`${kind}-needles`, { single: needleSurfaces() }, scene), body, root, false);
  const needleMatrices = new Float32Array(CAR_DIALS.length * 16);
  needleMesh.thinInstanceSetBuffer("matrix", needleMatrices, 16, false);
  needleMesh.doNotSyncBoundingInfo = true;
  needleMesh.setBoundingInfo(new BoundingInfo(new Vector3(0.3, STEERING_WHEEL_CENTRE[1] - 0.1, 0), new Vector3(0.5, STEERING_WHEEL_CENTRE[1] + 0.25, 0.7)));
  needleMesh.setEnabled(false);
  meshes.push(needleMesh);

  const applyGlow = createGlowApplier();
  let cockpit = false;

  const pose = (car: Readonly<CarVisualState> | null): void => {
    for (const axle of ["front", "rear"] as const) {
      const { position, roll } = axlePose(car, axle);
      axles[axle].position.set(position[0], position[1], position[2]);
      // Right end up is a negative turn about +x.
      axles[axle].rotation.x = -roll;
    }
    writeWheelMatrices(car, wheelMatrices);
    wheelMesh.thinInstanceBufferUpdated("matrix");
    if (!cockpit) {
      writeLinkMatrices(CAR_LINKS, car, linkMatrices);
      linkMesh.thinInstanceBufferUpdated("matrix");
      writeLinkMatrices(CAR_COILS, car, coilMatrices, COIL.restLength);
      coilMesh.thinInstanceBufferUpdated("matrix");
    }
    // Clockwise as the driver sees it is a positive turn about the column's axis, toward the dash.
    steeringWheel.rotation.x = car && Number.isFinite(car.steeringWheel) ? car.steeringWheel : 0;
  };
  pose(null);
  writeNeedleMatrices({ engineRpm: 0, speedKmh: 0, fuel: 0, temperature: 0 }, needleMatrices);
  needleMesh.thinInstanceBufferUpdated("matrix");

  const setDoors = (right: number, left: number): void => {
    let changed = false;
    for (const door of doors) {
      const target = door.side === 1 ? right : left;
      const open = Number.isFinite(target) ? Math.min(1, Math.max(0, target)) : 0;
      if (open === door.open) continue;
      if ((open > 0) !== (door.open > 0)) changed = true;
      door.open = open;
      // The trailing edge swings out: +Z for the right door, -Z for the left.
      door.node.rotation.y = door.side * open * FRONT_DOOR_HINGE.openRadians;
      door.panel.setEnabled(open > 0);
      door.pane.setEnabled(open > 0 && !cockpit);
    }
    if (!changed) return;
    const rightShut = doors[0]!.open === 0;
    const leftShut = doors[1]!.open === 0;
    drawDoorsShut(bodyMesh, bodyBuilt.runs, rightShut, leftShut);
    drawDoorsShut(glassMesh, glassBuilt.runs, rightShut, leftShut);
  };

  const setCockpitView = (enabled: boolean): void => {
    cockpit = enabled;
    glassMesh.setEnabled(!enabled);
    for (const door of doors) door.pane.setEnabled(door.open > 0 && !enabled);
    linkMesh.setEnabled(!enabled);
    coilMesh.setEnabled(!enabled);
    needleMesh.setEnabled(enabled);
  };

  return {
    kind,
    root,
    cockpitParts: [glassMesh, linkMesh, coilMesh, ...doors.map((door) => door.pane)],
    meshes,
    axles,
    steeringWheel,
    lampState: () => drawnLamps,
    update(state: FlightVisualState): void {
      const car = state.vehicle?.kind === "car" ? state.vehicle : null;
      pose(car);
      if (cockpit) {
        const engineRpm = Number.isFinite(state.engineRpm) ? Math.max(0, state.engineRpm) : 0;
        writeNeedleMatrices({
          engineRpm,
          speedKmh: car && Number.isFinite(car.speed) ? Math.abs(car.speed) * 3.6 : 0,
          // The payload carries no fuel state: the gauge reads a tank five-sixths full.
          fuel: 0.83,
          temperature: car?.engineRunning ? 0.5 : 0.12,
        }, needleMatrices);
        needleMesh.thinInstanceBufferUpdated("matrix");
      }
      const lamps = carLampState(car);
      if (!sameLamps(lamps, drawnLamps)) {
        drawnLamps = lamps;
        lampTexture.update(carLampTexels(lamps, lampPixels));
      }
    },
    setLightState(lights: AircraftLightState): void {
      // The car's lamps follow its own switches (`update`); only the panel glow is the scene's.
      applyGlow(body as PBRMaterial, lights.cockpitGlow);
    },
    setCockpitView,
    setDoors,
    dispose(): void {
      for (const mesh of meshes) mesh.dispose(false, false);
      for (const node of [steeringWheel, wheelTilt, axles.front, axles.rear, ...doors.map((door) => door.node)]) node.dispose(false, false);
      root.dispose(false, false);
      build.disposeMaterials();
    },
  };
}

function sameLamps(a: CarLampState, b: CarLampState): boolean {
  return a.dayRunning === b.dayRunning
    && a.dipped === b.dipped
    && a.main === b.main
    && a.tail === b.tail
    && a.brake === b.brake
    && a.reverse === b.reverse;
}
