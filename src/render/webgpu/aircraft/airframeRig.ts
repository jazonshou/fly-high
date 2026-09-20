import { Quaternion } from "@babylonjs/core/Maths/math.vector";
import type { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh";
import type { PBRMaterial } from "@babylonjs/core/Materials/PBR/pbrMaterial";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import type { Scene } from "@babylonjs/core/scene";
import type { AircraftKind } from "@/src/sim";
import type { resolveAircraftAnimationPose } from "./animation";
import { AircraftBuildContext } from "./builders";
import { AIRCRAFT_EXTERIOR_LAYER_MASK, aircraftCameraLayerMask } from "./types";

/**
 * The parts every airframe in the game has, and the scaffolding that drives
 * them.
 *
 * Split out of `createAircraft.ts` when a third aeroplane arrived: one file
 * holding every builder meant two people reshaping two aeroplanes could not
 * work at once, and the shared contract was hard to see among 1,200 lines of
 * geometry. The per-airframe modules own their own shapes; this owns what they
 * must all agree on.
 */
export interface CommonRig {
  readonly root: TransformNode;
  readonly propeller: TransformNode;
  readonly cockpitParts: readonly AbstractMesh[];
  readonly wingSurfaces: readonly AbstractMesh[];
  readonly ailerons: readonly [TransformNode, TransformNode];
  readonly elevator: TransformNode;
  readonly rudder: TransformNode;
  readonly noseSteer: TransformNode;
  /** Every flap panel, hinged so a positive rotation.z drops its trailing edge. */
  readonly flaps: readonly TransformNode[];
  readonly mainWheels: readonly TransformNode[];
  readonly noseWheel: TransformNode;
}


export function node(name: string, parent: TransformNode, scene: Scene): TransformNode {
  const result = new TransformNode(name, scene);
  result.parent = parent;
  return result;
}

export function assertRightHandedScene(scene: Scene): void {
  if (!scene.useRightHandedSystem) {
    throw new Error(
      "WebGPU aircraft require scene.useRightHandedSystem = true before construction.",
    );
  }
}

export function configureRoot(root: TransformNode, kind: AircraftKind): void {
  root.rotationQuaternion = Quaternion.Identity();
  root.metadata = {
    aircraftVisual: true,
    aircraftKind: kind,
    handedness: "right",
    bodyAxes: { forward: "+x", up: "+y", starboard: "+z" },
  };
}

export function addInstrumentPanel(
  build: AircraftBuildContext,
  prefix: string,
  root: TransformNode,
  x: number,
  y: number,
  depth: number,
  panelMaterial: PBRMaterial,
  faceMaterial: PBRMaterial,
  markingMaterial: PBRMaterial,
): readonly AbstractMesh[] {
  const meshes: AbstractMesh[] = [];
  const panel = build.box(
    `${prefix}-instrument-panel`,
    0.1,
    0.54,
    depth,
    panelMaterial,
    root,
  );
  panel.position.set(x, y, 0);
  panel.rotation.z = -0.12;
  panel.metadata = { ...panel.metadata, cockpitInterior: true };
  meshes.push(panel);

  const gauges = [
    { name: "airspeed", y: 0.09, z: 0.22 },
    { name: "attitude", y: 0.09, z: -0.02 },
    { name: "altimeter", y: 0.09, z: -0.26 },
    { name: "engine", y: -0.13, z: 0.12 },
    { name: "vertical-speed", y: -0.13, z: -0.14 },
  ] as const;
  for (const [index, gauge] of gauges.entries()) {
    const face = build.cylinder(
      `${prefix}-${gauge.name}-gauge`,
      0.016,
      index === 1 ? 0.2 : 0.17,
      index === 1 ? 0.2 : 0.17,
      24,
      faceMaterial,
      root,
    );
    face.rotation.z = Math.PI / 2;
    face.position.set(x - 0.061, y + gauge.y, gauge.z * depth);
    face.metadata = { ...face.metadata, cockpitInterior: true, castsShadow: false };
    const needle = build.box(
      `${prefix}-${gauge.name}-needle`,
      0.013,
      0.012,
      index === 1 ? 0.072 : 0.06,
      markingMaterial,
      root,
    );
    needle.position.set(x - 0.073, y + gauge.y, gauge.z * depth + 0.018);
    needle.rotation.x = (index - 2) * 0.38;
    needle.metadata = { ...needle.metadata, cockpitInterior: true, castsShadow: false };
    meshes.push(face, needle);
  }
  return meshes;
}


export function applyCommonPose(
  rig: CommonRig,
  pose: ReturnType<typeof resolveAircraftAnimationPose>,
  deltaSeconds: number,
): void {
  rig.ailerons[0].rotation.z = pose.starboardAileron;
  rig.ailerons[1].rotation.z = pose.portAileron;
  rig.elevator.rotation.z = pose.elevator;
  rig.rudder.rotation.y = pose.rudder;
  rig.noseSteer.rotation.y = pose.noseSteering;
  for (const flap of rig.flaps) flap.rotation.z = pose.flap;
  for (const wheel of rig.mainWheels) {
    wheel.rotation.z += pose.mainWheelRadiansPerSecond * deltaSeconds;
  }
  rig.noseWheel.rotation.z += pose.noseWheelRadiansPerSecond * deltaSeconds;
}

export function configureCockpitLayers(parts: readonly AbstractMesh[]): void {
  for (const part of parts) {
    part.layerMask = AIRCRAFT_EXTERIOR_LAYER_MASK;
    // Shadow generators use visibility/enabled state, not the active camera's
    // layer mask. Exterior skin therefore remains a caster in cockpit view.
    part.isVisible = true;
  }
}

export function setCockpitVisibility(rig: CommonRig, scene: Scene, enabled: boolean): void {
  for (const part of rig.cockpitParts) {
    part.layerMask = AIRCRAFT_EXTERIOR_LAYER_MASK;
    part.isVisible = true;
  }
  const camera = scene.activeCamera;
  if (camera) camera.layerMask = aircraftCameraLayerMask(camera.layerMask, enabled);
  // Wing roots are intentional cockpit reference geometry and stay visible;
  // they use Babylon's ordinary multi-bit world mask rather than the isolated
  // exterior-skin bit.
  for (const wing of rig.wingSurfaces) wing.isVisible = true;
}

/**
 * Creates a procedural aircraft directly in the provided Babylon scene.
 * The scene must already be configured as right-handed.
 */
/**
 * `7-8`: apply a per-lamp emissive scale, remembering each material's authored
 * intensity as its full-brightness value.
 *
 * Scales `emissiveIntensity` rather than toggling `isVisible` or `setEnabled`:
 * a lamp that vanishes also stops occluding and stops contributing to bloom,
 * so a strobe wired that way pops the whole silhouette rather than flashing.
 * The propeller rig makes the same point about phase-dependent visibility and
 * it applies identically here.
 */
/**
 * `7-8`: the cockpit instrument glow, which legitimately EXCEEDS 1.
 *
 * Separate from `createLampApplier` because that one clamps to [0, 1] — right
 * for a lamp, which is either lit or not, and wrong here: the panel's authored
 * value is its DAYLIGHT brightness and night raises it above that. Sharing one
 * applier would have silently clamped the night case back to daylight, which
 * is the kind of thing that looks like the law being wrong.
 */
export function createGlowApplier(): (material: PBRMaterial, multiple: number) => void {
  const base = new WeakMap<PBRMaterial, number>();
  return (material, multiple) => {
    let authored = base.get(material);
    if (authored === undefined) {
      authored = material.emissiveIntensity;
      base.set(material, authored);
    }
    const safe = Number.isFinite(multiple) ? Math.max(0, multiple) : 1;
    material.emissiveIntensity = authored * safe;
  };
}

export function createLampApplier(): (material: PBRMaterial, scale: number) => void {
  const base = new WeakMap<PBRMaterial, number>();
  return (material, scale) => {
    let full = base.get(material);
    if (full === undefined) {
      full = material.emissiveIntensity;
      base.set(material, full);
    }
    material.emissiveIntensity = full * Math.min(1, Math.max(0, scale));
  };
}

