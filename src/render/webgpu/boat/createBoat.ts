import { Constants } from "@babylonjs/core/Engines/constants";
import type { PBRMaterial } from "@babylonjs/core/Materials/PBR/pbrMaterial";
import { RawTexture } from "@babylonjs/core/Materials/Textures/rawTexture";
import { Texture } from "@babylonjs/core/Materials/Textures/texture";
import type { Material } from "@babylonjs/core/Materials/material";
import { Color3 } from "@babylonjs/core/Maths/math.color";
import { Quaternion, Vector3 } from "@babylonjs/core/Maths/math.vector";
import type { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { VertexBuffer } from "@babylonjs/core/Buffers/buffer";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import type { Scene } from "@babylonjs/core/scene";
import type { FlightVisualState } from "@/src/game/types";
import { AIRFRAME_TRANSPARENCY_RENDERING_GROUP_ID } from "@/src/render/webgpu/core/RenderingGroups";
import type { AircraftLightState } from "@/src/render/webgpu/lighting/AircraftLighting";
import { RUNABOUT_21_CG, RUNABOUT_21_OUTBOARD } from "@/src/vehicles/boat/hullLines";
import type { SurfaceVehicleKind } from "@/src/vehicles/kinds";
import { AircraftBuildContext, isAlphaBlendedAirframeMaterial } from "../aircraft/builders";
import { createGlowApplier, createLampApplier } from "../aircraft/airframeRig";
import type { VehicleVisual } from "../vehicle/types";
import { createBoatAtlasTextures } from "./boatAtlas";
import {
  aftDeckSurfaces,
  allCleatSurfaces,
  BOW_LANTERN,
  cockpitSurfaces,
  consoleSurfaces,
  fittingSurfaces,
  foredeckFaceSurface,
  foredeckSurfaces,
  motorWellSurfaces,
  seatSurfaces,
  STERN_POLE,
  windscreenFrameSurfaces,
  windscreenGlassSurface,
} from "./boatDeck";
import { BoatHelmRig, NEUTRAL_HELM_POSE } from "./boatHelm";
import { hullSkinSurfaces, rubRailSurfaces, transomSurface } from "./boatHull";
import { BOAT_SIDELIGHT_ARC_DEGREES, boatWashLights, type BoatLampPlacement, type BoatWashLight } from "./boatLights";
import { BoatMeshData, Surface, type Vec3Tuple } from "./boatMeshData";
import { outboardSurfaces, PROPELLER, propellerSurfaces } from "./boatOutboard";

/**
 * The Runabout 21, drawn: `createWebGpuBoat(scene, kind)` returns the
 * renderer's `VehicleVisual` for a boat.
 *
 * BODY FRAME. As the aircraft's: +X bow, +Y up, +Z starboard, origin at the
 * centre of gravity of the physics thread's lines (`RUNABOUT_21_CG`, 1.95 m
 * forward of the transom and 0.56 m above the keel), which is the point the
 * boat sim reports its pose for. At rest that puts the keel 0.56 m and the
 * still waterline about 0.16 m below the origin.
 *
 * DRAWS: at most six, in every view.
 *   1. `boat-body`: hull, deck, seats, consoles, windscreen frame, fittings
 *      (one atlas material, opaque, casts the boat's shadow);
 *   2. `boat-glass`: the windscreen, smoked acrylic blended over what is
 *      behind it (not the aircraft glazing's refraction, see `glass`);
 *   3. `boat-outboard`: cowl, leg, plate, gearcase, skeg (tilts with trim,
 *      turns with steer);
 *   4. `boat-propeller` OR `boat-propeller-disc`: three helical blades below
 *      `PROPELLER_DISC_RPM`, the blur disc above it;
 *   5. `boat-helm`: wheel, lever, needles and depth digits, posed on the CPU;
 *   6. `boat-lamps`: the navigation lights' lenses, emissive.
 */

/** Propeller rpm above which the blades are drawn as their blur disc. */
export const PROPELLER_DISC_RPM = 900;

/** Hull frame to body frame. */
const CG: Vec3Tuple = [RUNABOUT_21_CG.x, RUNABOUT_21_CG.y, RUNABOUT_21_CG.z];

function toBody(point: { readonly x: number; readonly y: number; readonly z: number }): Vector3 {
  return new Vector3(point.x - CG[0], point.y - CG[1], point.z - CG[2]);
}

/** Where the lamps are, body frame: the bi-colour lantern's two lenses and the all-round light. */
export const RUNABOUT_21_LAMPS: BoatLampPlacement = Object.freeze({
  port: Object.freeze([BOW_LANTERN.x + 0.02 - CG[0], BOW_LANTERN.y - CG[1], -0.02]) as readonly [number, number, number],
  starboard: Object.freeze([BOW_LANTERN.x + 0.02 - CG[0], BOW_LANTERN.y - CG[1], 0.02]) as readonly [number, number, number],
  allRound: Object.freeze([STERN_POLE.x - CG[0], STERN_POLE.topY - CG[1], STERN_POLE.z]) as readonly [number, number, number],
});

const RUNABOUT_21_WASHES = boatWashLights(RUNABOUT_21_LAMPS);

/** The spill of a surface vehicle's own sidelights, for the renderer's clustered slots. */
export function surfaceVehicleWashLights(kind: SurfaceVehicleKind): readonly BoatWashLight[] {
  switch (kind) {
    case "speedboat":
      return RUNABOUT_21_WASHES;
  }
}

/** Lamp lens texels in the lamp material's 4 x 1 texture: red, green, white. */
const LAMP_TEXELS = Object.freeze({ red: 0, green: 1, white: 2 });

function lampUv(texel: number): readonly [number, number] {
  return [(texel + 0.5) / 4, 0.5];
}

/** The lantern's lenses: each a vertical cylinder segment across its own 112.5 degrees, and the white globe. */
function lampSurfaces(): Surface[] {
  const surfaces: Surface[] = [];
  const lantern = BOW_LANTERN;
  for (const [texel, sign] of [[LAMP_TEXELS.red, -1], [LAMP_TEXELS.green, 1]] as const) {
    const lens = new Surface();
    const uv = lampUv(texel);
    const steps = 10;
    const rows: Vec3Tuple[][] = [];
    for (let k = 0; k <= steps; k += 1) {
      // Bearing from the bow, positive to starboard: (cos, 0, sin).
      const azimuth = ((sign * k) / steps) * BOAT_SIDELIGHT_ARC_DEGREES * (Math.PI / 180);
      const x = lantern.x + Math.cos(azimuth) * lantern.radius;
      const z = Math.sin(azimuth) * lantern.radius;
      rows.push([[x, lantern.y - lantern.height / 2, z], [x, lantern.y + lantern.height / 2, z]]);
    }
    lens.grid(rows, () => uv);
    // Starboard sweeps +z from ahead with the girth up: (+z) x (+y) = -x at
    // the bow, inward; the port lens sweeps the other way and shows outward.
    surfaces.push(sign > 0 ? lens.flipped() : lens);
  }
  const globe = new Surface();
  const uv = lampUv(LAMP_TEXELS.white);
  const rows: Vec3Tuple[][] = [];
  for (let i = 0; i <= 6; i += 1) {
    const polar = (i / 6) * Math.PI;
    const ring: Vec3Tuple[] = [];
    for (let j = 0; j <= 12; j += 1) {
      const azimuth = (j / 12) * Math.PI * 2;
      ring.push([
        STERN_POLE.x + Math.sin(polar) * Math.cos(azimuth) * 0.028,
        STERN_POLE.topY + Math.cos(polar) * 0.034,
        STERN_POLE.z - Math.sin(polar) * Math.sin(azimuth) * 0.028,
      ]);
    }
    rows.push(ring);
  }
  globe.grid(rows, () => uv);
  surfaces.push(globe);
  return surfaces;
}

/** Every static opaque part, body frame. */
export function buildBoatBodyData(): BoatMeshData {
  const data = new BoatMeshData();
  for (const surface of hullSkinSurfaces()) data.addSymmetric(surface, CG);
  for (const surface of rubRailSurfaces()) data.addSymmetric(surface, CG);
  data.add(transomSurface(), CG);
  for (const surface of cockpitSurfaces()) data.addSymmetric(surface, CG);
  for (const surface of foredeckSurfaces()) data.addSymmetric(surface, CG);
  data.addSymmetric(foredeckFaceSurface(), CG);
  for (const surface of aftDeckSurfaces()) data.addSymmetric(surface, CG);
  for (const surface of motorWellSurfaces()) data.addSymmetric(surface, CG);
  for (const surface of seatSurfaces()) data.addSymmetric(surface, CG);
  for (const surface of consoleSurfaces("starboard")) data.add(surface, CG);
  for (const surface of consoleSurfaces("port")) data.add(surface, CG);
  for (const surface of windscreenFrameSurfaces()) data.add(surface, CG);
  for (const surface of allCleatSurfaces()) data.add(surface, CG);
  for (const surface of fittingSurfaces()) data.add(surface, CG);
  return data;
}

export function buildBoatOutboardData(): BoatMeshData {
  const data = new BoatMeshData();
  const steer = RUNABOUT_21_OUTBOARD.steerAxisPoint;
  for (const surface of outboardSurfaces()) data.add(surface, [steer.x, steer.y, steer.z]);
  return data;
}

export function buildBoatPropellerData(): BoatMeshData {
  const data = new BoatMeshData();
  for (const surface of propellerSurfaces()) data.add(surface);
  return data;
}

function meshFrom(name: string, data: BoatMeshData, scene: Scene, material: Material, parent: TransformNode, castsShadow: boolean, updatable = false): Mesh {
  const mesh = new Mesh(name, scene);
  data.toVertexData().applyToMesh(mesh, updatable);
  return finish(mesh, material, parent, castsShadow);
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

export interface BoatVisual extends VehicleVisual {
  /** The CPU-posed helm, for tests. */
  readonly helm: BoatHelmRig;
  /** The tilt and steer nodes the outboard hangs from, for tests. */
  readonly outboardTilt: TransformNode;
  readonly outboardSteer: TransformNode;
  readonly propeller: TransformNode;
}

export function createWebGpuBoat(scene: Scene, kind: SurfaceVehicleKind): BoatVisual {
  const build = new AircraftBuildContext(scene);
  const root = new TransformNode(`${kind}-root`, scene);
  root.rotationQuaternion = Quaternion.Identity();
  root.metadata = {
    surfaceVehicleVisual: true,
    vehicleKind: kind,
    handedness: "right",
    bodyAxes: { forward: "+x", up: "+y", starboard: "+z" },
  };

  const atlas = createBoatAtlasTextures(scene);
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
  // The dash markings' daylight brightness; the glow law multiplies it at night.
  body.emissiveIntensity = 0.35;

  // Smoked acrylic, blended over the scene behind it. Not the aircraft
  // glazing's refraction: that refracts the sky probe, not the scene, and the
  // helm looks DOWN through the screen at the foredeck, where the probe's
  // lower half drew the glass an opaque navy.
  const glass = build.material(`${kind}-glass`, 0x163845, {
    roughness: 0.045,
    metallic: 0,
    alpha: 0.26,
    doubleSided: true,
    clearCoat: { intensity: 1, roughness: 0.025, indexOfRefraction: 1.5 },
  });
  // One curved sheet, so nothing of it sorts against itself: no pre-pass,
  // as the trainer's cabin glazing (see its note).
  glass.needDepthPrePass = false;

  const disc = build.material(`${kind}-propeller-disc`, 0x9aa0a6, {
    roughness: 0.4,
    metallic: 0.6,
    alpha: 0,
    alphaBlend: true,
    doubleSided: true,
  });

  const lampPixels = new Uint8Array([
    255, 40, 30, 255,
    40, 255, 120, 255,
    255, 248, 236, 255,
    0, 0, 0, 255,
  ]);
  const lampTexture = new RawTexture(lampPixels, 4, 1, Constants.TEXTUREFORMAT_RGBA, scene, false, false, Texture.NEAREST_SAMPLINGMODE, Constants.TEXTURETYPE_UNSIGNED_BYTE, 0, true);
  lampTexture.name = `${kind}-lamp-colours`;
  build.textures.push(lampTexture);
  const lamp = build.material(`${kind}-lamps`, 0x9a9a9a, { roughness: 0.15, metallic: 0, emissive: 0xffffff, emissiveIntensity: 2.4 });
  lamp.albedoTexture = lampTexture;
  lamp.emissiveTexture = lampTexture;

  const meshes: AbstractMesh[] = [];
  const bodyMesh = meshFrom(`${kind}-body`, buildBoatBodyData(), scene, body, root, true);
  meshes.push(bodyMesh);

  const glassData = new BoatMeshData();
  glassData.add(windscreenGlassSurface(), CG);
  const glassMesh = meshFrom(`${kind}-glass`, glassData, scene, glass, root, false);
  meshes.push(glassMesh);

  // Tilt about the pivot, then steer about the swivel axis, which tilts with it.
  const outboardTilt = new TransformNode(`${kind}-outboard-tilt`, scene);
  outboardTilt.parent = root;
  outboardTilt.position.copyFrom(toBody(RUNABOUT_21_OUTBOARD.tiltPivot));
  const outboardSteer = new TransformNode(`${kind}-outboard-steer`, scene);
  outboardSteer.parent = outboardTilt;
  outboardSteer.position.copyFrom(toBody(RUNABOUT_21_OUTBOARD.steerAxisPoint).subtract(toBody(RUNABOUT_21_OUTBOARD.tiltPivot)));
  const outboardMesh = meshFrom(`${kind}-outboard`, buildBoatOutboardData(), scene, body, outboardSteer, true);
  meshes.push(outboardMesh);

  const propeller = new TransformNode(`${kind}-propeller`, scene);
  propeller.parent = outboardSteer;
  propeller.position.copyFrom(toBody(RUNABOUT_21_OUTBOARD.propellerHub).subtract(toBody(RUNABOUT_21_OUTBOARD.steerAxisPoint)));
  const bladesMesh = meshFrom(`${kind}-propeller`, buildBoatPropellerData(), scene, body, propeller, false);
  meshes.push(bladesMesh);
  const discMesh = build.radialBlurDisc(`${kind}-propeller-disc`, PROPELLER.radius + 0.004, 32, disc, propeller);
  discMesh.metadata = { ...(discMesh.metadata as Record<string, unknown> | null), castsShadow: false, surfaceVehicleVisual: true };
  discMesh.setEnabled(false);
  meshes.push(discMesh);

  const helm = new BoatHelmRig(CG);
  helm.pose(NEUTRAL_HELM_POSE);
  const helmMesh = new Mesh(`${kind}-helm`, scene);
  helm.toVertexData().applyToMesh(helmMesh, true);
  finish(helmMesh, body, root, false);
  // The wheel turns in place, so its rest bounds hold; pad them for the lever's sweep.
  const helmBounds = helmMesh.getBoundingInfo();
  helmBounds.reConstruct(helmBounds.minimum.subtract(new Vector3(0.15, 0.15, 0.15)), helmBounds.maximum.add(new Vector3(0.15, 0.15, 0.15)));
  meshes.push(helmMesh);

  const lampData = new BoatMeshData();
  for (const surface of lampSurfaces()) lampData.add(surface, CG);
  const lampMesh = meshFrom(`${kind}-lamps`, lampData, scene, lamp, root, false);
  meshes.push(lampMesh);

  const applyLamp = createLampApplier();
  const applyGlow = createGlowApplier();
  let spin = 0;

  return {
    kind,
    root,
    cockpitParts: [],
    meshes,
    helm,
    outboardTilt,
    outboardSteer,
    propeller,
    update(state: FlightVisualState, deltaSeconds: number): void {
      const boat = state.vehicle?.kind === "boat" ? state.vehicle : null;
      const dt = Number.isFinite(deltaSeconds) ? Math.max(0, Math.min(deltaSeconds, 0.25)) : 0;
      // Trim OUT swings the lower unit aft and up: -trimAngle about +z.
      outboardTilt.rotation.z = -(boat && Number.isFinite(boat.trimAngle) ? boat.trimAngle : 0);
      // Positive steer points the thrust to port, swinging the bow to starboard: +angle about +y.
      outboardSteer.rotation.y = boat && Number.isFinite(boat.steerAngle) ? boat.steerAngle : 0;
      const engineRpm = Number.isFinite(state.engineRpm) ? Math.max(0, state.engineRpm) : 0;
      const direction = boat?.gear === "forward" ? 1 : boat?.gear === "reverse" ? -1 : 0;
      const propellerRpm = (engineRpm / PROPELLER.gearRatio) * direction;
      // A right-hand propeller: clockwise seen from astern going ahead, +x rotation.
      spin = (spin + (propellerRpm / 60) * Math.PI * 2 * dt) % (Math.PI * 2);
      propeller.rotation.x = spin;
      const blurred = Math.abs(propellerRpm) > PROPELLER_DISC_RPM;
      if (bladesMesh.isEnabled(false) === blurred) bladesMesh.setEnabled(!blurred);
      if (discMesh.isEnabled(false) !== blurred) discMesh.setEnabled(blurred);
      disc.alpha = blurred ? Math.min(0.55, 0.3 + Math.abs(propellerRpm) / 8_000) : 0;
      if (helm.pose(boat
        ? {
          steerAngle: boat.steerAngle,
          lever: boat.lever,
          engineRpm,
          speedMetersPerSecond: boat.speedThroughWater,
          trim: boat.trim,
          depthMeters: boat.depthUnderKeel,
        }
        : NEUTRAL_HELM_POSE)) {
        helmMesh.updateVerticesData(VertexBuffer.PositionKind, helm.positions, false, false);
        helmMesh.updateVerticesData(VertexBuffer.NormalKind, helm.normals, false, false);
      }
    },
    setLightState(lights: AircraftLightState): void {
      // One lamp material: each lens's arc is its geometry (the lantern's
      // screen hides the other colour), so the material carries the on-state.
      applyLamp(lamp as PBRMaterial, Math.max(lights.portNav, lights.starboardNav, lights.tailNav));
      applyGlow(body as PBRMaterial, lights.cockpitGlow);
    },
    setCockpitView(): void {
      // An open boat: nothing of it hides the helm's view, and the helm is
      // drawn in every view, so there is nothing to switch.
    },
    dispose(): void {
      for (const mesh of meshes) mesh.dispose(false, false);
      for (const node of [propeller, outboardSteer, outboardTilt]) node.dispose(false, false);
      root.dispose(false, false);
      build.disposeMaterials();
    },
  };
}
