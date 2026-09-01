import { Quaternion, Vector3 } from "@babylonjs/core/Maths/math.vector";
import type { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh";
import type { PBRMaterial } from "@babylonjs/core/Materials/PBR/pbrMaterial";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import type { Scene } from "@babylonjs/core/scene";
import type { AircraftKind } from "@/src/sim";
import {
  resolveAircraftAnimationPose,
  resolvePropellerPresentation,
  safeAircraftAnimationDelta,
} from "./animation";
import { AircraftBuildContext } from "./builders";
import {
  AIRCRAFT_EXTERIOR_LAYER_MASK,
  aircraftCameraLayerMask,
  type AircraftVisual,
} from "./types";

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

interface TrainerPropellerRig {
  readonly bladeMaterial: PBRMaterial;
  readonly discMaterial: PBRMaterial;
  readonly blades: readonly AbstractMesh[];
  readonly disc: AbstractMesh;
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

function addInstrumentPanel(
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

function createTrainer(scene: Scene): AircraftVisual {
  const build = new AircraftBuildContext(scene);
  const root = new TransformNode("aerolith-trainer", scene);
  configureRoot(root, "trainer");

  const body = build.paintMaterial("trainer-body", {
    seed: 0x41a2_1701,
    baseColor: 0xe8eee7,
    liveryColor: 0xcfe95d,
    roughness: 0.43,
    metallic: 0.08,
    sootStrength: 0.92,
    wearStrength: 0.74,
  });
  const accent = build.paintMaterial("trainer-accent", {
    seed: 0x41a2_1702,
    baseColor: 0xcfe95d,
    liveryColor: 0x183941,
    roughness: 0.38,
    metallic: 0.06,
    sootStrength: 0.26,
    wearStrength: 0.68,
  });
  const dark = build.material("trainer-dark", 0x142b32, {
    roughness: 0.25,
    metallic: 0.15,
  });
  const glass = build.material("trainer-glass", 0x163845, {
    roughness: 0.045,
    metallic: 0,
    alpha: 0.34,
    doubleSided: true,
    clearCoat: { intensity: 1, roughness: 0.025, indexOfRefraction: 1.5 },
    transmission: {
      indexOfRefraction: 1.52,
      minimumThickness: 0.004,
      maximumThickness: 0.012,
      tintColor: 0xb7e5ed,
      tintColorAtDistance: 2.4,
    },
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

  const instrumentFace = build.material("trainer-instrument-face", 0x071014, {
    roughness: 0.72,
    metallic: 0.04,
  });
  const instrumentMarking = build.material("trainer-instrument-marking", 0xd5efe8, {
    roughness: 0.4,
    metallic: 0,
    emissive: 0x86b8a9,
    emissiveIntensity: 0.42,
  });

  const fuselage = build.loft(
    "trainer-fuselage",
    [
      { x: -3.42, yRadius: 0.18, zRadius: 0.22, yOffset: 0.08 },
      { x: -2.92, yRadius: 0.42, zRadius: 0.44, yOffset: 0.04 },
      { x: -1.75, yRadius: 0.56, zRadius: 0.57 },
      { x: -0.25, yRadius: 0.62, zRadius: 0.59, yOffset: 0.02 },
      { x: 1.25, yRadius: 0.65, zRadius: 0.61, yOffset: 0.03 },
      { x: 2.72, yRadius: 0.55, zRadius: 0.54 },
      { x: 3.25, yRadius: 0.46, zRadius: 0.45 },
    ],
    24,
    body,
    root,
  );
  build.loft(
    "trainer-nose",
    [
      { x: 3.2, yRadius: 0.46, zRadius: 0.45 },
      { x: 3.72, yRadius: 0.34, zRadius: 0.35 },
      { x: 4.18, yRadius: 0.16, zRadius: 0.17 },
    ],
    20,
    accent,
    root,
  );
  const spinner = build.cylinder("trainer-spinner", 0.48, 0, 0.4, 12, dark, root);
  spinner.rotation.z = -Math.PI / 2;
  spinner.position.x = 4.35;

  const wingSurfaces: AbstractMesh[] = [];
  for (const side of [-1, 1] as const) {
    const sideName = side < 0 ? "starboard" : "port";
    const forwardWing = build.airfoilWing(
      `${sideName}-main-wing-forward`,
      {
        rootLeadingX: 1.28,
        rootTrailingX: -0.27,
        tipLeadingX: 0.72,
        tipTrailingX: -0.12,
        rootZ: side * 0.52,
        tipZ: side * 5.4,
        thicknessRatio: 0.12,
        camberRatio: 0.018,
        chordSegments: 14,
        spanSegments: 3,
      },
      body,
      root,
    );
    forwardWing.position.y = 0.28;
    const flap = build.airfoilWing(
      `${sideName}-wing-flap`,
      {
        rootLeadingX: -0.33,
        rootTrailingX: -0.78,
        tipLeadingX: -0.26,
        tipTrailingX: -0.68,
        rootZ: side * 0.62,
        tipZ: side * 2.28,
        thicknessRatio: 0.09,
        camberRatio: 0.016,
        chordSegments: 8,
      },
      accent,
      root,
    );
    flap.position.y = 0.28;
    wingSurfaces.push(forwardWing, flap);
  }

  const starboardAileron = node("starboard-aileron", root, scene);
  starboardAileron.position.set(-0.29, 0.28, -2.4);
  const starboardAileronSurface = build.airfoilWing(
    "starboard-aileron-surface",
    {
      rootLeadingX: 0,
      rootTrailingX: -0.43,
      tipLeadingX: 0.16,
      tipTrailingX: -0.23,
      rootZ: 0,
      tipZ: -2.9,
      thicknessRatio: 0.085,
      camberRatio: 0.012,
      chordSegments: 8,
      spanSegments: 2,
    },
    accent,
    starboardAileron,
  );
  const portAileron = node("port-aileron", root, scene);
  portAileron.position.set(-0.29, 0.28, 2.4);
  const portAileronSurface = build.airfoilWing(
    "port-aileron-surface",
    {
      rootLeadingX: 0,
      rootTrailingX: -0.43,
      tipLeadingX: 0.16,
      tipTrailingX: -0.23,
      rootZ: 0,
      tipZ: 2.9,
      thicknessRatio: 0.085,
      camberRatio: 0.012,
      chordSegments: 8,
      spanSegments: 2,
    },
    accent,
    portAileron,
  );
  wingSurfaces.push(starboardAileronSurface, portAileronSurface);

  for (const side of [-1, 1] as const) {
    const tail = build.airfoilWing(
      side < 0 ? "starboard-trainer-tailplane" : "port-trainer-tailplane",
      {
        rootLeadingX: -2.22,
        rootTrailingX: -3.16,
        tipLeadingX: -2.42,
        tipTrailingX: -3.1,
        rootZ: side * 0.18,
        tipZ: side * 1.96,
        thicknessRatio: 0.09,
        camberRatio: 0.006,
        chordSegments: 10,
        spanSegments: 2,
      },
      body,
      root,
    );
    tail.position.y = 0.42;
    wingSurfaces.push(tail);
  }
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
  elevator.position.set(-3.22, 0.42, 0);
  for (const side of [-1, 1] as const) {
    wingSurfaces.push(build.airfoilWing(
      side < 0 ? "starboard-elevator-surface" : "port-elevator-surface",
      {
        rootLeadingX: 0,
        rootTrailingX: -0.42,
        tipLeadingX: 0.08,
        tipTrailingX: -0.33,
        rootZ: side * 0.18,
        tipZ: side * 1.86,
        thicknessRatio: 0.075,
        chordSegments: 7,
      },
      accent,
      elevator,
    ));
  }
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
  addInstrumentPanel(
    build,
    "trainer",
    root,
    1.62,
    0.55,
    0.94,
    interior,
    instrumentFace,
    instrumentMarking,
  );

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

  const propellerBladeMaterial = build.material("trainer-propeller-blades", 0x17252a, {
    roughness: 0.3,
    metallic: 0.18,
    alpha: 1,
    alphaBlend: true,
  });
  const propellerDiscMaterial = build.material("trainer-propeller-disc", 0x718086, {
    roughness: 0.62,
    metallic: 0.18,
    alpha: 0,
    alphaBlend: true,
    doubleSided: true,
  });
  const propeller = node("trainer-propeller", root, scene);
  propeller.position.x = 4.25;
  const propHub = build.cylinder("trainer-propeller-hub", 0.28, 0.2, 0.2, 10, dark, propeller);
  propHub.rotation.z = Math.PI / 2;
  const bladeA = build.box(
    "trainer-propeller-blade-a",
    0.06,
    2.6,
    0.14,
    propellerBladeMaterial,
    propeller,
  );
  const bladeB = build.box(
    "trainer-propeller-blade-b",
    0.06,
    2.6,
    0.14,
    propellerBladeMaterial,
    propeller,
  );
  bladeB.rotation.x = Math.PI / 2;
  const propellerDisc = build.radialBlurDisc(
    "trainer-propeller-disc",
    1.36,
    56,
    propellerDiscMaterial,
    propeller,
  );
  const propellerRig: TrainerPropellerRig = {
    bladeMaterial: propellerBladeMaterial,
    discMaterial: propellerDiscMaterial,
    blades: [bladeA, bladeB],
    disc: propellerDisc,
  };

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

  // `D-6`: PORT (red) sits at -Z and STARBOARD (green) at +Z, because
  // **starboard is body +Z**. Derived from the scene's own basis rather than
  // from `bodyAxes` below, which declares `port: "+z"` and is the thing that
  // is wrong: `FlightRenderer` maps body +X -> forward and +Y -> up into a
  // right-handed scene, and a camera looking along +X with up +Y reports
  // screen-right as +Z. Screen-right for a forward-looking camera IS the
  // pilot's right. `src/input/index.ts:38-40` independently observed the same
  // thing and inverts keyboard roll to compensate.
  //
  // These two lines were reversed, so every night flight showed red on the
  // right wing and green on the left -- the exact inversion an observer uses
  // to infer which way an aircraft is heading.
  //
  // The `bodyAxes` declaration is deliberately NOT corrected here: it is
  // consumed as a contract and migrating it belongs with physics, telemetry
  // and cameras together, per the note in `src/input/index.ts`. The roll
  // inversion there compensates for that contract, not for these lamps, and
  // must stay.
  const portLight = build.sphere("port-navigation-light", 0.18, 8, redLamp, root);
  portLight.position.set(0.2, 0.3, -5.43);
  portLight.metadata = { ...portLight.metadata, castsShadow: false };
  const starboardLight = build.sphere("starboard-navigation-light", 0.18, 8, greenLamp, root);
  starboardLight.position.set(0.2, 0.3, 5.43);
  starboardLight.metadata = { ...starboardLight.metadata, castsShadow: false };
  const landingLight = build.cylinder("landing-light", 0.025, 0.24, 0.24, 10, landingLamp, root);
  landingLight.rotation.z = Math.PI / 2;
  landingLight.position.set(1.18, 0.22, 1.7);
  landingLight.metadata = { ...landingLight.metadata, castsShadow: false };

  const rig: CommonRig = {
    root,
    propeller,
    // Only opaque exterior skin belongs on the cockpit-excluded layer. The
    // clearcoat/transmission canopy stays on ordinary world layers so the
    // windscreen remains visible from the pilot's camera.
    cockpitParts: [fuselage],
    wingSurfaces,
    ailerons: [starboardAileron, portAileron],
    elevator,
    rudder,
    noseSteer,
    mainWheels,
    noseWheel,
  };
  configureCockpitLayers(rig.cockpitParts);
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
      // Phase-anchored to simulation time, not accumulated per rendered
      // frame: at 10+ rad/s the prop is a blur either way, and anchoring
      // makes every frame a pure function of (state, frame sequence) — the
      // perf capture diffs identically-timed frames across runs.
      propeller.rotation.x = pose.rotorRadiansPerSecond * state.simulationTime;
      const presentation = resolvePropellerPresentation(pose.rotorRadiansPerSecond);
      propellerRig.bladeMaterial.alpha = presentation.bladeOpacity;
      propellerRig.discMaterial.alpha = presentation.discOpacity;
      // Both remain part of the rig at every phase. Opacity is the only
      // transition; setEnabled/isVisible never strobe with rotor angle.
      for (const blade of propellerRig.blades) blade.isVisible = true;
      propellerRig.disc.isVisible = true;
      applyCommonPose(rig, pose, delta);
    },
    setCockpitView(enabled) {
      if (disposed) return;
      setCockpitVisibility(rig, scene, enabled);
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

  const body = build.paintMaterial("jet-body", {
    seed: 0x7e57_2201,
    baseColor: 0xc9d2d2,
    liveryColor: 0xe55b3f,
    roughness: 0.34,
    metallic: 0.28,
    sootStrength: 0.7,
    wearStrength: 0.82,
  });
  const underside = build.paintMaterial("jet-underside", {
    seed: 0x7e57_2202,
    baseColor: 0x66777b,
    liveryColor: 0xb7c5c4,
    roughness: 0.46,
    metallic: 0.2,
    sootStrength: 0.94,
    wearStrength: 0.58,
  });
  const accent = build.paintMaterial("jet-accent", {
    seed: 0x7e57_2203,
    baseColor: 0xe55b3f,
    liveryColor: 0x263941,
    roughness: 0.38,
    metallic: 0.08,
    sootStrength: 0.3,
    wearStrength: 0.76,
  });
  const dark = build.material("jet-dark", 0x17242a, {
    roughness: 0.3,
    metallic: 0.48,
  });
  const glass = build.material("jet-glass", 0x163947, {
    roughness: 0.04,
    metallic: 0,
    alpha: 0.31,
    doubleSided: true,
    clearCoat: { intensity: 1, roughness: 0.02, indexOfRefraction: 1.5 },
    transmission: {
      indexOfRefraction: 1.52,
      minimumThickness: 0.004,
      maximumThickness: 0.011,
      tintColor: 0xaedee9,
      tintColorAtDistance: 2.8,
    },
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

  const interior = build.material("jet-interior", 0x182226, {
    roughness: 0.8,
    metallic: 0.02,
  });
  const instrumentFace = build.material("jet-instrument-face", 0x050a0d, {
    roughness: 0.7,
    metallic: 0.05,
  });
  const instrumentMarking = build.material("jet-instrument-marking", 0x91d8b8, {
    roughness: 0.34,
    metallic: 0,
    emissive: 0x49c18c,
    emissiveIntensity: 0.7,
  });

  const fuselage = build.loft(
    "jet-fuselage",
    [
      { x: -4.12, yRadius: 0.48, zRadius: 0.5 },
      { x: -3.2, yRadius: 0.58, zRadius: 0.59 },
      { x: -1.25, yRadius: 0.67, zRadius: 0.67, yOffset: 0.01 },
      { x: 1.15, yRadius: 0.72, zRadius: 0.69, yOffset: 0.04 },
      { x: 2.75, yRadius: 0.68, zRadius: 0.64, yOffset: 0.03 },
      { x: 4.2, yRadius: 0.54, zRadius: 0.55 },
    ],
    28,
    body,
    root,
  );
  const nose = build.loft(
    "radar-nose",
    [
      { x: 4.16, yRadius: 0.54, zRadius: 0.55 },
      { x: 4.82, yRadius: 0.4, zRadius: 0.42 },
      { x: 5.45, yRadius: 0.2, zRadius: 0.21 },
      { x: 5.82, yRadius: 0.035, zRadius: 0.035 },
    ],
    24,
    body,
    root,
  );
  build.loft(
    "engine-tail-cone",
    [
      { x: -5.22, yRadius: 0.31, zRadius: 0.32 },
      { x: -4.72, yRadius: 0.43, zRadius: 0.44 },
      { x: -4.08, yRadius: 0.5, zRadius: 0.51 },
    ],
    22,
    underside,
    root,
  );

  const wingSurfaces: AbstractMesh[] = [];
  for (const side of [-1, 1] as const) {
    const sideName = side < 0 ? "starboard" : "port";
    const forwardWing = build.airfoilWing(
      `${sideName}-swept-main-wing`,
      {
        rootLeadingX: 1.65,
        rootTrailingX: -0.58,
        tipLeadingX: -0.2,
        tipTrailingX: -0.86,
        rootZ: side * 0.5,
        tipZ: side * 4.8,
        thicknessRatio: 0.085,
        camberRatio: 0.002,
        chordSegments: 14,
        spanSegments: 4,
      },
      body,
      root,
    );
    const flap = build.airfoilWing(
      `${sideName}-jet-flap`,
      {
        rootLeadingX: -0.64,
        rootTrailingX: -0.75,
        tipLeadingX: -0.79,
        tipTrailingX: -1.02,
        rootZ: side * 0.61,
        tipZ: side * 2.65,
        thicknessRatio: 0.065,
        chordSegments: 7,
        spanSegments: 2,
      },
      underside,
      root,
    );
    wingSurfaces.push(forwardWing, flap);
  }

  const starboardAileron = node("starboard-aileron", root, scene);
  starboardAileron.position.set(-0.78, 0.02, -2.76);
  const starboardSurface = build.airfoilWing(
    "starboard-aileron-surface",
    {
      rootLeadingX: 0,
      rootTrailingX: -0.28,
      tipLeadingX: -0.1,
      tipTrailingX: -0.5,
      rootZ: 0,
      tipZ: -1.94,
      thicknessRatio: 0.06,
      chordSegments: 7,
      spanSegments: 2,
    },
    accent,
    starboardAileron,
  );
  const portAileron = node("port-aileron", root, scene);
  portAileron.position.set(-0.78, 0.02, 2.76);
  const portSurface = build.airfoilWing(
    "port-aileron-surface",
    {
      rootLeadingX: 0,
      rootTrailingX: -0.28,
      tipLeadingX: -0.1,
      tipTrailingX: -0.5,
      rootZ: 0,
      tipZ: 1.94,
      thicknessRatio: 0.06,
      chordSegments: 7,
      spanSegments: 2,
    },
    accent,
    portAileron,
  );
  wingSurfaces.push(starboardSurface, portSurface);

  for (const side of [-1, 1] as const) {
    const tail = build.airfoilWing(
      side < 0 ? "starboard-swept-tailplane" : "port-swept-tailplane",
      {
        rootLeadingX: -2.8,
        rootTrailingX: -3.91,
        tipLeadingX: -3.6,
        tipTrailingX: -4.05,
        rootZ: side * 0.35,
        tipZ: side * 2.15,
        thicknessRatio: 0.065,
        chordSegments: 10,
        spanSegments: 2,
      },
      body,
      root,
    );
    tail.position.y = 0.43;
    wingSurfaces.push(tail);
  }
  const elevator = node("elevator", root, scene);
  elevator.position.set(-3.96, 0.43, 0);
  for (const side of [-1, 1] as const) {
    wingSurfaces.push(build.airfoilWing(
      side < 0 ? "starboard-jet-elevator-surface" : "port-jet-elevator-surface",
      {
        rootLeadingX: 0,
        rootTrailingX: -0.4,
        tipLeadingX: -0.09,
        tipTrailingX: -0.36,
        rootZ: side * 0.35,
        tipZ: side * 1.96,
        thicknessRatio: 0.055,
        chordSegments: 7,
      },
      accent,
      elevator,
    ));
  }
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
  for (const [index, seatX] of [0.72, -0.25].entries()) {
    const seat = build.box(
      index === 0 ? "jet-front-seat" : "jet-rear-seat",
      0.52,
      0.66,
      0.5,
      interior,
      root,
    );
    seat.position.set(seatX, 0.36, 0);
    seat.rotation.z = -0.1;
    seat.metadata = { ...seat.metadata, cockpitInterior: true };
    const headrest = build.box(
      index === 0 ? "jet-front-headrest" : "jet-rear-headrest",
      0.22,
      0.28,
      0.38,
      interior,
      root,
    );
    headrest.position.set(seatX - 0.25, 0.74, 0);
    headrest.metadata = { ...headrest.metadata, cockpitInterior: true };
  }
  addInstrumentPanel(
    build,
    "jet",
    root,
    2.24,
    0.59,
    0.82,
    interior,
    instrumentFace,
    instrumentMarking,
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
  // `D-6`: same reversal as the trainer, same fix -- port (red) to -Z.
  const portLight = build.sphere("port-navigation-light", 0.17, 8, redLamp, root);
  portLight.position.set(-0.2, 0.07, -4.82);
  portLight.metadata = { ...portLight.metadata, castsShadow: false };
  const starboardLight = build.sphere("starboard-navigation-light", 0.17, 8, greenLamp, root);
  starboardLight.position.set(-0.2, 0.07, 4.82);
  starboardLight.metadata = { ...starboardLight.metadata, castsShadow: false };

  const rig: JetRig = {
    root,
    propeller,
    // Keep the transparent canopy visible in cockpit view; only opaque skin
    // and its obstructing centre frame use the cockpit-excluded layer.
    cockpitParts: [fuselage, nose, canopyFrame],
    wingSurfaces,
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
  configureCockpitLayers(rig.cockpitParts);
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
      // Phase-anchored to simulation time — see the trainer note.
      propeller.rotation.x = pose.rotorRadiansPerSecond * state.simulationTime;
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
      setCockpitVisibility(rig, scene, enabled);
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

function configureCockpitLayers(parts: readonly AbstractMesh[]): void {
  for (const part of parts) {
    part.layerMask = AIRCRAFT_EXTERIOR_LAYER_MASK;
    // Shadow generators use visibility/enabled state, not the active camera's
    // layer mask. Exterior skin therefore remains a caster in cockpit view.
    part.isVisible = true;
  }
}

function setCockpitVisibility(rig: CommonRig, scene: Scene, enabled: boolean): void {
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
export function createAircraft(
  scene: Scene,
  kind: AircraftKind = "trainer",
): AircraftVisual {
  assertRightHandedScene(scene);
  return kind === "jet" ? createJet(scene) : createTrainer(scene);
}

/** Explicit WebGPU-era name for call sites migrating alongside the old module. */
export const createWebGpuAircraft = createAircraft;
