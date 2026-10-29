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
import "@babylonjs/core/Meshes/thinInstanceMesh";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import type { Scene } from "@babylonjs/core/scene";
import type { CarVisualState, FlightVisualState } from "@/src/game/types";
import { AIRFRAME_TRANSPARENCY_RENDERING_GROUP_ID } from "@/src/render/webgpu/core/RenderingGroups";
import type { AircraftLightState } from "@/src/render/webgpu/lighting/AircraftLighting";
import type { SurfaceVehicleKind } from "@/src/vehicles/kinds";
import { AircraftBuildContext, isAlphaBlendedAirframeMaterial } from "../aircraft/builders";
import { createGlowApplier } from "../aircraft/airframeRig";
import { BoatMeshData, type Surface } from "../boat/boatMeshData";
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
import { STEERING_WHEEL } from "./lc76Lines";

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
 */

function meshFrom(name: string, surfaces: { readonly single?: readonly Surface[]; readonly symmetric?: readonly Surface[] }, scene: Scene): Mesh {
  const data = new BoatMeshData();
  for (const surface of surfaces.symmetric ?? []) data.addSymmetric(surface);
  for (const surface of surfaces.single ?? []) data.add(surface);
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
  [176, 182, 188],
  [178, 184, 190],
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
  // A lit lamp fills its reflector bowl, fuller on main beam.
  set(CAR_LAMP_TEXELS.reflector, white, lamps.main > 0 ? 0.9 : lamps.dipped * 0.65);
  // The fog lamps have no switch of their own: dark.
  set(CAR_LAMP_TEXELS.fog, white, 0);
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
  // Glossy paint under a clear coat, as a new car's is: the atlas's red
  // channel says how much of it each finish wears (the paint all of it, the
  // plastics and rubber none), its green scales the coat's roughness.
  body.clearCoat.isEnabled = true;
  body.clearCoat.intensity = 1;
  body.clearCoat.roughness = 0.15;
  body.clearCoat.texture = atlas.metallicRoughness;
  body.clearCoat.useRoughnessFromMainTexture = true;

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
  const bodyMesh = finish(meshFrom(`${kind}-body`, { symmetric: surfaces.symmetric, single: [...surfaces.single, ...cabinSurfaces()] }, scene), body, root, true);
  meshes.push(bodyMesh);
  const glassMesh = finish(meshFrom(`${kind}-glass`, { single: surfaces.glass }, scene), glass, root, false);
  meshes.push(glassMesh);

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

  const setCockpitView = (enabled: boolean): void => {
    cockpit = enabled;
    glassMesh.setEnabled(!enabled);
    linkMesh.setEnabled(!enabled);
    coilMesh.setEnabled(!enabled);
    needleMesh.setEnabled(enabled);
  };

  return {
    kind,
    root,
    cockpitParts: [glassMesh, linkMesh, coilMesh],
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
    dispose(): void {
      for (const mesh of meshes) mesh.dispose(false, false);
      for (const node of [steeringWheel, wheelTilt, axles.front, axles.rear]) node.dispose(false, false);
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
