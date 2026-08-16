import { Quaternion, Vector3 } from "@babylonjs/core/Maths/math.vector";
import type { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import type { Scene } from "@babylonjs/core/scene";
import type { AircraftKind } from "@/src/sim";
import {
  resolveAircraftAnimationPose,
  safeAircraftAnimationDelta,
} from "./animation";
import { AircraftBuildContext } from "./builders";
import type { AircraftVisual } from "./types";

interface CommonRig {
  readonly root: TransformNode;
  readonly propeller: TransformNode;
  readonly cockpitParts: readonly AbstractMesh[];
  readonly wingSurfaces: readonly AbstractMesh[];
  readonly ailerons: readonly [TransformNode, TransformNode];
  readonly elevator: TransformNode;
  readonly rudder: TransformNode;
  readonly noseSteer: TransformNode;
  readonly mainWheels: readonly TransformNode[];
  readonly noseWheel: TransformNode;
}

interface JetRig extends CommonRig {
  readonly landingGear: TransformNode;
  readonly gearDoors: readonly AbstractMesh[];
  readonly speedBrakes: readonly TransformNode[];
}

function node(name: string, parent: TransformNode, scene: Scene): TransformNode {
  const result = new TransformNode(name, scene);
  result.parent = parent;
  return result;
}

function assertRightHandedScene(scene: Scene): void {
  if (!scene.useRightHandedSystem) {
    throw new Error(
      "WebGPU aircraft require scene.useRightHandedSystem = true before construction.",
    );
  }
}

function configureRoot(root: TransformNode, kind: AircraftKind): void {
  root.rotationQuaternion = Quaternion.Identity();
  root.metadata = {
    aircraftVisual: true,
    aircraftKind: kind,
    handedness: "right",
    bodyAxes: { forward: "+x", up: "+y", port: "+z" },
  };
}

function createTrainer(scene: Scene): AircraftVisual {
  const build = new AircraftBuildContext(scene);
  const root = new TransformNode("aerolith-trainer", scene);
  configureRoot(root, "trainer");

  const body = build.material("trainer-body", 0xe8eee7);
  const accent = build.material("trainer-accent", 0xcfe95d, { roughness: 0.38 });
  const dark = build.material("trainer-dark", 0x142b32, {
    roughness: 0.25,
    metallic: 0.15,
  });
  const glass = build.material("trainer-glass", 0x163845, {
    roughness: 0.08,
    metallic: 0.2,
    alpha: 0.82,
  });
  const tire = build.material("trainer-tire", 0x07090a, {
    roughness: 1,
    metallic: 0,
  });
  const hub = build.material("trainer-hub", 0x718086, {
    roughness: 0.38,
    metallic: 0.62,
  });
  const panel = build.material("trainer-panel", 0xaab8ba, {
    roughness: 0.34,
    metallic: 0.32,
  });
  const interior = build.material("trainer-interior", 0x1b2528, {
    roughness: 0.82,
    metallic: 0,
  });
  const redLamp = build.material("trainer-port-lamp", 0xff493d, {
    emissive: 0xff2018,
    emissiveIntensity: 2,
  });
  const greenLamp = build.material("trainer-starboard-lamp", 0x5dffab, {
    emissive: 0x24ff83,
    emissiveIntensity: 2,
  });
  const landingLamp = build.material("trainer-landing-lamp", 0xfff1c2, {
    roughness: 0.16,
    emissive: 0xffd991,
    emissiveIntensity: 3.2,
  });

  const fuselage = build.cylinder("trainer-fuselage", 6.2, 1.08, 0.8, 14, body, root);
  fuselage.rotation.z = Math.PI / 2;
  fuselage.position.x = -0.1;
  const nose = build.cylinder("trainer-nose", 1.25, 0.32, 1.08, 14, accent, root);
  nose.rotation.z = -Math.PI / 2;
  nose.position.x = 3.55;
  const spinner = build.cylinder("trainer-spinner", 0.48, 0, 0.4, 12, dark, root);
  spinner.rotation.z = -Math.PI / 2;
  spinner.position.x = 4.35;

  const wingOutline = [
    { x: 1.28, z: 0.5 },
    { x: 0.72, z: 5.4 },
    { x: -0.52, z: 5.4 },
    { x: -0.78, z: 0.5 },
    { x: -0.78, z: -0.5 },
    { x: -0.52, z: -5.4 },
    { x: 0.72, z: -5.4 },
    { x: 1.28, z: -0.5 },
  ] as const;
  const wing = build.planform("tapered-main-wing", wingOutline, 0.15, body, root);
  wing.position.y = 0.28;
  const wingAccent = build.planform(
    "leading-edge-accent",
    [
      { x: 1.3, z: 0.51 },
      { x: 0.73, z: 5.41 },
      { x: 0.48, z: 5.41 },
      { x: 1.03, z: 0.51 },
      { x: 1.03, z: -0.51 },
      { x: 0.48, z: -5.41 },
      { x: 0.73, z: -5.41 },
      { x: 1.3, z: -0.51 },
    ],
    0.162,
    accent,
    root,
  );
  wingAccent.position.y = 0.28;

  const starboardAileron = node("starboard-aileron", root, scene);
  starboardAileron.position.set(-0.49, 0.28, -3.8);
  const starboardAileronSurface = build.box(
    "starboard-aileron-surface",
    0.38,
    0.075,
    2.55,
    accent,
    starboardAileron,
  );
  starboardAileronSurface.position.x = -0.19;
  const portAileron = node("port-aileron", root, scene);
  portAileron.position.set(-0.49, 0.28, 3.8);
  const portAileronSurface = build.box(
    "port-aileron-surface",
    0.38,
    0.075,
    2.55,
    accent,
    portAileron,
  );
  portAileronSurface.position.x = -0.19;

  const tailplane = build.box("trainer-tailplane", 1.22, 0.1, 3.9, body, root);
  tailplane.position.set(-2.86, 0.42, 0);
  const fin = build.verticalProfile(
    "trainer-vertical-stabilizer",
    [
      { x: 0.76, y: 0 },
      { x: -0.72, y: 0 },
      { x: -0.72, y: 1.55 },
    ],
    0.08,
    accent,
    root,
  );
  fin.position.set(-2.52, 0.2, 0);
  const elevator = node("elevator", root, scene);
  elevator.position.set(-3.27, 0.42, 0);
  const elevatorSurface = build.box(
    "elevator-surface",
    0.42,
    0.075,
    3.72,
    accent,
    elevator,
  );
  elevatorSurface.position.x = -0.21;
  const rudder = node("rudder", root, scene);
  rudder.position.set(-3.13, 1.02, 0);
  const rudderSurface = build.box("rudder-surface", 0.42, 1.05, 0.075, accent, rudder);
  rudderSurface.position.set(-0.2, 0.12, 0);

  const canopy = build.sphere("trainer-canopy", 1.16, 12, glass, root);
  canopy.metadata = { ...canopy.metadata, castsShadow: false };
  canopy.scaling.set(1.65, 0.82, 0.88);
  canopy.position.set(0.58, 0.58, 0);
  build.strutBetween(
    "windscreen-center-frame",
    new Vector3(0.92, 0.35, 0),
    new Vector3(0.82, 1.02, 0),
    0.026,
    dark,
    root,
  );
  for (const side of [-1, 1]) {
    const seat = build.box(
      side < 0 ? "starboard-seat" : "port-seat",
      0.42,
      0.62,
      0.36,
      interior,
      root,
    );
    seat.position.set(0.12, 0.37, side * 0.27);
    seat.rotation.z = -0.08;
    const headrest = build.box(
      side < 0 ? "starboard-headrest" : "port-headrest",
      0.2,
      0.26,
      0.3,
      interior,
      root,
    );
    headrest.position.set(-0.2, 0.72, side * 0.27);
  }

  const cowlingBand = build.cylinder("engine-cowling-band", 0.075, 1.09, 1.09, 14, panel, root);
  cowlingBand.rotation.z = Math.PI / 2;
  cowlingBand.position.x = 2.98;
  for (const side of [-1, 1]) {
    const exhaust = build.cylinder(
      side < 0 ? "starboard-exhaust" : "port-exhaust",
      0.54,
      0.11,
      0.14,
      8,
      dark,
      root,
    );
    exhaust.rotation.z = Math.PI / 2;
    exhaust.position.set(2.45, -0.38, side * 0.34);
    const fairing = build.sphere(
      side < 0 ? "starboard-wingtip-fairing" : "port-wingtip-fairing",
      0.23,
      8,
      accent,
      root,
    );
    fairing.scaling.set(2.4, 0.55, 0.7);
    fairing.position.set(0.08, 0.28, side * 5.43);
  }
  const pitot = build.cylinder("pitot-tube", 0.72, 0.024, 0.036, 6, panel, root);
  pitot.rotation.z = -Math.PI / 2;
  pitot.position.set(1.2, 0.18, 5.1);
  const registration = build.box(
    "fuselage-registration-stripe",
    0.035,
    0.24,
    1.62,
    accent,
    root,
  );
  registration.position.set(-1.72, 0.04, 0);
  const belly = build.box("trainer-belly-panel", 2.9, 0.045, 0.58, dark, root);
  belly.position.set(0.28, -0.51, 0);

  const propeller = node("trainer-propeller", root, scene);
  propeller.position.x = 4.25;
  const propHub = build.cylinder("trainer-propeller-hub", 0.28, 0.2, 0.2, 10, dark, propeller);
  propHub.rotation.z = Math.PI / 2;
  build.box("trainer-propeller-blade-a", 0.06, 2.6, 0.14, dark, propeller);
  const bladeB = build.box("trainer-propeller-blade-b", 0.06, 2.6, 0.14, dark, propeller);
  bladeB.rotation.x = Math.PI / 2;

  const mainWheels: TransformNode[] = [];
  for (const side of [-1, 1]) {
    build.strutBetween(
      side < 0 ? "starboard-main-strut" : "port-main-strut",
      new Vector3(-0.18, 0.03, side * 0.94),
      new Vector3(-0.3, -0.93, side * 1.52),
      0.052,
      dark,
      root,
    );
    build.strutBetween(
      side < 0 ? "starboard-main-brace" : "port-main-brace",
      new Vector3(0.24, -0.02, side * 1.12),
      new Vector3(-0.3, -0.91, side * 1.52),
      0.034,
      hub,
      root,
    );
    const wheel = node(side < 0 ? "starboard-main-wheel" : "port-main-wheel", root, scene);
    wheel.position.set(-0.3, -1.07, side * 1.52);
    build.torus(`${wheel.name}-tire`, 0.41, 0.13, 20, tire, wheel);
    const wheelHub = build.cylinder(`${wheel.name}-hub`, 0.19, 0.21, 0.21, 14, hub, wheel);
    wheelHub.rotation.x = Math.PI / 2;
    mainWheels.push(wheel);
  }
  build.strutBetween(
    "trainer-nose-strut",
    new Vector3(2.55, -0.17, 0),
    new Vector3(2.55, -0.82, 0),
    0.046,
    dark,
    root,
  );
  const noseSteer = node("nose-wheel-steering", root, scene);
  noseSteer.position.set(2.55, -0.95, 0);
  const noseWheel = node("nose-wheel", noseSteer, scene);
  build.torus("nose-wheel-tire", 0.31, 0.11, 18, tire, noseWheel);
  const noseHub = build.cylinder("nose-wheel-hub", 0.15, 0.15, 0.15, 12, hub, noseWheel);
  noseHub.rotation.x = Math.PI / 2;

  const portLight = build.sphere("port-navigation-light", 0.18, 8, redLamp, root);
  portLight.position.set(0.2, 0.3, 5.43);
  portLight.metadata = { ...portLight.metadata, castsShadow: false };
  const starboardLight = build.sphere("starboard-navigation-light", 0.18, 8, greenLamp, root);
  starboardLight.position.set(0.2, 0.3, -5.43);
  starboardLight.metadata = { ...starboardLight.metadata, castsShadow: false };
  const landingLight = build.cylinder("landing-light", 0.025, 0.24, 0.24, 10, landingLamp, root);
  landingLight.rotation.z = Math.PI / 2;
  landingLight.position.set(1.18, 0.22, 1.7);
  landingLight.metadata = { ...landingLight.metadata, castsShadow: false };

  const rig: CommonRig = {
    root,
    propeller,
    cockpitParts: [fuselage, canopy],
    wingSurfaces: [wing, wingAccent],
    ailerons: [starboardAileron, portAileron],
    elevator,
    rudder,
    noseSteer,
    mainWheels,
    noseWheel,
  };
  let disposed = false;
  return {
    kind: "trainer",
    handedness: "right",
    group: root,
    root,
    propeller,
    cockpitParts: rig.cockpitParts,
    meshes: build.meshes,
    update(state, deltaSeconds) {
      if (disposed) return;
      const delta = safeAircraftAnimationDelta(deltaSeconds);
      const pose = resolveAircraftAnimationPose("trainer", state);
      propeller.rotation.x += pose.rotorRadiansPerSecond * delta;
      const normalizedRpm = Math.min(1.2, Math.max(0, state.engineRpm / 2_600));
      propeller.setEnabled(
        normalizedRpm < 0.12 || Math.sin(propeller.rotation.x * 0.27) > -0.82,
      );
      applyCommonPose(rig, pose, delta);
    },
    setCockpitView(enabled) {
      if (disposed) return;
      setCockpitVisibility(rig, enabled);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      root.dispose(false, false);
      build.disposeMaterials();
    },
  };
}

function createJet(scene: Scene): AircraftVisual {
  const build = new AircraftBuildContext(scene);
  const root = new TransformNode("vesper-fast-jet", scene);
  configureRoot(root, "jet");

  const body = build.material("jet-body", 0xc9d2d2, { roughness: 0.34, metallic: 0.28 });
  const underside = build.material("jet-underside", 0x66777b, {
    roughness: 0.46,
    metallic: 0.2,
  });
  const accent = build.material("jet-accent", 0xe55b3f, {
    roughness: 0.38,
    metallic: 0.08,
  });
  const dark = build.material("jet-dark", 0x17242a, {
    roughness: 0.3,
    metallic: 0.48,
  });
  const glass = build.material("jet-glass", 0x163947, {
    roughness: 0.07,
    metallic: 0.22,
    alpha: 0.78,
  });
  const tire = build.material("jet-tire", 0x060809, { roughness: 1, metallic: 0 });
  const hub = build.material("jet-hub", 0x89979a, { roughness: 0.3, metallic: 0.72 });
  const hotMetal = build.material("jet-hot-metal", 0x4f5555, {
    roughness: 0.22,
    metallic: 0.88,
    emissive: 0x36150b,
    emissiveIntensity: 0.55,
  });
  const redLamp = build.material("jet-port-lamp", 0xff493d, {
    emissive: 0xff2018,
    emissiveIntensity: 2.4,
  });
  const greenLamp = build.material("jet-starboard-lamp", 0x5dffab, {
    emissive: 0x24ff83,
    emissiveIntensity: 2.4,
  });

  const fuselage = build.cylinder("jet-fuselage", 8.15, 1.28, 1, 18, body, root);
  fuselage.rotation.z = Math.PI / 2;
  fuselage.position.x = 0.05;
  const nose = build.cylinder("radar-nose", 1.75, 0, 1.26, 18, body, root);
  nose.rotation.z = -Math.PI / 2;
  nose.position.x = 4.98;
  const tailCone = build.cylinder("engine-tail-cone", 1.15, 0.64, 1, 16, underside, root);
  tailCone.rotation.z = Math.PI / 2;
  tailCone.position.x = -4.55;

  const wing = build.planform(
    "swept-main-wing",
    [
      { x: 1.65, z: 0.48 },
      { x: -0.2, z: 4.8 },
      { x: -1.28, z: 4.8 },
      { x: -0.72, z: 0.48 },
      { x: -0.72, z: -0.48 },
      { x: -1.28, z: -4.8 },
      { x: -0.2, z: -4.8 },
      { x: 1.65, z: -0.48 },
    ],
    0.18,
    body,
    root,
  );
  const wingChevron = build.planform(
    "wing-leading-edge-chevron",
    [
      { x: 1.67, z: 0.5 },
      { x: -0.19, z: 4.82 },
      { x: -0.43, z: 4.82 },
      { x: 1.35, z: 0.5 },
      { x: 1.35, z: -0.5 },
      { x: -0.43, z: -4.82 },
      { x: -0.19, z: -4.82 },
      { x: 1.67, z: -0.5 },
    ],
    0.192,
    accent,
    root,
  );

  const starboardAileron = node("starboard-aileron", root, scene);
  starboardAileron.position.set(-0.88, 0.05, -3.65);
  const starboardSurface = build.box(
    "starboard-aileron-surface",
    0.5,
    0.09,
    1.65,
    accent,
    starboardAileron,
  );
  starboardSurface.position.x = -0.22;
  const portAileron = node("port-aileron", root, scene);
  portAileron.position.set(-0.88, 0.05, 3.65);
  const portSurface = build.box("port-aileron-surface", 0.5, 0.09, 1.65, accent, portAileron);
  portSurface.position.x = -0.22;

  const tailplane = build.planform(
    "swept-tailplane",
    [
      { x: 0.72, z: 0.35 },
      { x: -0.08, z: 2.15 },
      { x: -0.72, z: 2.15 },
      { x: -0.55, z: 0.35 },
      { x: -0.55, z: -0.35 },
      { x: -0.72, z: -2.15 },
      { x: -0.08, z: -2.15 },
      { x: 0.72, z: -0.35 },
    ],
    0.12,
    body,
    root,
  );
  tailplane.position.set(-3.52, 0.43, 0);
  const elevator = node("elevator", root, scene);
  elevator.position.set(-4.05, 0.43, 0);
  const elevatorSurface = build.box("elevator-surface", 0.42, 0.08, 3.7, accent, elevator);
  elevatorSurface.position.x = -0.18;
  const fin = build.verticalProfile(
    "swept-vertical-stabilizer",
    [
      { x: 0.92, y: 0 },
      { x: -0.92, y: 0 },
      { x: -0.62, y: 2.2 },
    ],
    0.12,
    body,
    root,
  );
  fin.position.set(-3.5, 0.28, 0);
  const rudder = node("rudder", root, scene);
  rudder.position.set(-4.28, 1.25, 0);
  const rudderSurface = build.box("rudder-surface", 0.48, 1.3, 0.085, accent, rudder);
  rudderSurface.position.set(-0.2, 0.08, 0);

  const canopy = build.sphere("tandem-canopy", 1.24, 16, glass, root);
  canopy.metadata = { ...canopy.metadata, castsShadow: false };
  canopy.scaling.set(2.05, 0.83, 0.79);
  canopy.position.set(1.15, 0.68, 0);
  const canopyFrame = build.strutBetween(
    "canopy-center-frame",
    new Vector3(1.2, 0.32, 0),
    new Vector3(1.08, 1.16, 0),
    0.028,
    dark,
    root,
  );
  const belly = build.box("jet-belly-panel", 4.7, 0.06, 0.72, underside, root);
  belly.position.set(-0.25, -0.58, 0);
  for (const side of [-1, 1]) {
    const intake = build.cylinder(
      side < 0 ? "starboard-engine-intake" : "port-engine-intake",
      1.1,
      0.48,
      0.62,
      12,
      dark,
      root,
    );
    intake.rotation.z = Math.PI / 2;
    intake.scaling.y = 0.78;
    intake.position.set(0.28, -0.18, side * 0.6);
  }

  const propeller = node("jet-compressor", root, scene);
  propeller.position.x = -5.08;
  const nozzle = build.cylinder("jet-nozzle", 0.48, 0.62, 0.72, 18, hotMetal, propeller);
  nozzle.rotation.z = Math.PI / 2;
  const turbine = build.cylinder("jet-turbine", 0.025, 0.48, 0.48, 12, dark, propeller);
  turbine.rotation.z = Math.PI / 2;
  turbine.position.x = -0.25;

  const landingGear = node("retractable-landing-gear", root, scene);
  const mainWheels: TransformNode[] = [];
  for (const side of [-1, 1]) {
    build.strutBetween(
      side < 0 ? "starboard-main-strut" : "port-main-strut",
      new Vector3(-0.55, -0.18, side * 0.72),
      new Vector3(-0.72, -1.08, side * 1.72),
      0.058,
      hub,
      landingGear,
    );
    const wheel = node(side < 0 ? "starboard-main-wheel" : "port-main-wheel", landingGear, scene);
    wheel.position.set(-0.72, -1.16, side * 1.72);
    build.torus(`${wheel.name}-tire`, 0.48, 0.12, 20, tire, wheel);
    const wheelHub = build.cylinder(`${wheel.name}-hub`, 0.18, 0.24, 0.24, 14, hub, wheel);
    wheelHub.rotation.x = Math.PI / 2;
    mainWheels.push(wheel);
  }
  build.strutBetween(
    "jet-nose-strut",
    new Vector3(3.72, -0.3, 0),
    new Vector3(3.72, -1.02, 0),
    0.052,
    hub,
    landingGear,
  );
  const noseSteer = node("nose-wheel-steering", landingGear, scene);
  noseSteer.position.set(3.72, -1.08, 0);
  const noseWheel = node("nose-wheel", noseSteer, scene);
  build.torus("nose-wheel-tire", 0.38, 0.1, 18, tire, noseWheel);
  const noseHub = build.cylinder("nose-wheel-hub", 0.14, 0.18, 0.18, 12, hub, noseWheel);
  noseHub.rotation.x = Math.PI / 2;

  const gearDoorRoot = node("landing-gear-doors", root, scene);
  const gearDoors: AbstractMesh[] = [];
  for (const side of [-1, 1]) {
    const door = build.box(
      side < 0 ? "starboard-main-gear-door" : "port-main-gear-door",
      1.28,
      0.035,
      0.34,
      underside,
      gearDoorRoot,
    );
    door.position.set(-0.62, -0.6, side * 0.54);
    gearDoors.push(door);
  }
  const noseDoor = build.box("nose-gear-door", 1.22, 0.03, 0.3, underside, gearDoorRoot);
  noseDoor.position.set(3.26, -0.61, 0);
  gearDoors.push(noseDoor);

  const speedBrakes: TransformNode[] = [];
  for (const side of [-1, 1]) {
    const speedBrake = node(
      side < 0 ? "starboard-speed-brake" : "port-speed-brake",
      root,
      scene,
    );
    speedBrake.position.set(-0.42, 0.16, side * 1.28);
    const surface = build.box(
      `${speedBrake.name}-surface`,
      1.18,
      0.045,
      0.72,
      underside,
      speedBrake,
    );
    surface.position.x = -0.42;
    speedBrakes.push(speedBrake);
  }
  const portLight = build.sphere("port-navigation-light", 0.17, 8, redLamp, root);
  portLight.position.set(-0.2, 0.07, 4.82);
  portLight.metadata = { ...portLight.metadata, castsShadow: false };
  const starboardLight = build.sphere("starboard-navigation-light", 0.17, 8, greenLamp, root);
  starboardLight.position.set(-0.2, 0.07, -4.82);
  starboardLight.metadata = { ...starboardLight.metadata, castsShadow: false };

  const rig: JetRig = {
    root,
    propeller,
    cockpitParts: [fuselage, nose, canopy, canopyFrame],
    wingSurfaces: [wing, wingChevron],
    ailerons: [starboardAileron, portAileron],
    elevator,
    rudder,
    noseSteer,
    mainWheels,
    noseWheel,
    landingGear,
    gearDoors,
    speedBrakes,
  };
  let disposed = false;
  return {
    kind: "jet",
    handedness: "right",
    group: root,
    root,
    propeller,
    cockpitParts: rig.cockpitParts,
    meshes: build.meshes,
    update(state, deltaSeconds) {
      if (disposed) return;
      const delta = safeAircraftAnimationDelta(deltaSeconds);
      const pose = resolveAircraftAnimationPose("jet", state);
      propeller.rotation.x += pose.rotorRadiansPerSecond * delta;
      applyCommonPose(rig, pose, delta);
      landingGear.setEnabled(pose.gearVisible);
      landingGear.scaling.set(pose.gearScale.x, pose.gearScale.y, pose.gearScale.z);
      landingGear.position.y = pose.gearOffsetY;
      rig.gearDoors.forEach((door, index) => {
        door.rotation.x = (index === 1 ? -1 : 1) * pose.gearDoorTravel;
      });
      for (const speedBrake of rig.speedBrakes) speedBrake.rotation.z = pose.speedBrake;
    },
    setCockpitView(enabled) {
      if (disposed) return;
      setCockpitVisibility(rig, enabled);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      root.dispose(false, false);
      build.disposeMaterials();
    },
  };
}

function applyCommonPose(
  rig: CommonRig,
  pose: ReturnType<typeof resolveAircraftAnimationPose>,
  deltaSeconds: number,
): void {
  rig.ailerons[0].rotation.z = pose.starboardAileron;
  rig.ailerons[1].rotation.z = pose.portAileron;
  rig.elevator.rotation.z = pose.elevator;
  rig.rudder.rotation.y = pose.rudder;
  rig.noseSteer.rotation.y = pose.noseSteering;
  for (const wheel of rig.mainWheels) {
    wheel.rotation.z += pose.mainWheelRadiansPerSecond * deltaSeconds;
  }
  rig.noseWheel.rotation.z += pose.noseWheelRadiansPerSecond * deltaSeconds;
}

function setCockpitVisibility(rig: CommonRig, enabled: boolean): void {
  for (const part of rig.cockpitParts) part.isVisible = !enabled;
  // Wing roots are intentional cockpit reference geometry and stay visible.
  for (const wing of rig.wingSurfaces) wing.isVisible = true;
}

/**
 * Creates a procedural aircraft directly in the provided Babylon scene.
 * The scene must already be configured as right-handed.
 */
export function createAircraft(
  scene: Scene,
  kind: AircraftKind = "trainer",
): AircraftVisual {
  assertRightHandedScene(scene);
  return kind === "jet" ? createJet(scene) : createTrainer(scene);
}

/** Explicit WebGPU-era name for call sites migrating alongside the old module. */
export const createWebGpuAircraft = createAircraft;
