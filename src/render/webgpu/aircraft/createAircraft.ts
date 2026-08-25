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
  const root = new TransformNode("f22-raptor", scene);
  configureRoot(root, "jet");

  // Fix-pack A1: the sport-jet form is replaced by an F-22 Raptor — chined
  // superellipse fuselage, clipped-diamond wing, all-moving stabilators,
  // twin 28°-canted fins, twin rectangular nozzles, single-seat bubble
  // canopy, air-superiority grey. Geometry conforms to the flight model's
  // authoritative dimensions (18.92 m airframe, 13.56 m span, gear at
  // mains {−0.85, −2.05, ±1.63} / nose {5.19, −2.0}).
  // Satin air-superiority grey. Soot/wear are kept LOW: the 64² paint
  // features stretch over a 19 m airframe, and at the old strengths the
  // panel grid read as a quilt across the big diamond wing.
  const body = build.paintMaterial("jet-body", {
    seed: 0x7e57_2201,
    panelStrength: 0.4,
    baseColor: 0x8f959d,
    liveryColor: 0x878d95,
    roughness: 0.46,
    metallic: 0.3,
    sootStrength: 0.12,
    wearStrength: 0.2,
  });
  const underside = build.paintMaterial("jet-underside", {
    seed: 0x7e57_2202,
    panelStrength: 0.4,
    baseColor: 0x9aa0a6,
    liveryColor: 0x9298a0,
    roughness: 0.48,
    metallic: 0.26,
    sootStrength: 0.2,
    wearStrength: 0.18,
  });
  const accent = build.paintMaterial("jet-accent", {
    seed: 0x7e57_2203,
    panelStrength: 0.4,
    baseColor: 0x82888f,
    liveryColor: 0x7a8087,
    roughness: 0.46,
    metallic: 0.28,
    sootStrength: 0.12,
    wearStrength: 0.22,
  });
  // The 64² paint maps stretch ~5× further on this airframe than on the
  // trainer; at the shared 0.42 bump level the panel creases read as a
  // quilt across the diamond wing. Soften the normal contribution only —
  // the albedo panel lines stay as subtle real panels.
  for (const paint of [body, underside, accent]) {
    if (paint.bumpTexture) paint.bumpTexture.level = 0.16;
  }
  const dark = build.material("jet-dark", 0x1a2126, {
    roughness: 0.32,
    metallic: 0.44,
  });
  const glass = build.material("jet-glass", 0x4a3f24, {
    roughness: 0.04,
    metallic: 0,
    alpha: 0.34,
    doubleSided: true,
    clearCoat: { intensity: 1, roughness: 0.02, indexOfRefraction: 1.5 },
    transmission: {
      indexOfRefraction: 1.52,
      minimumThickness: 0.004,
      maximumThickness: 0.011,
      // The Raptor's canopy carries a gold indium-tin-oxide coating.
      tintColor: 0xd9c47e,
      tintColorAtDistance: 2.8,
    },
  });
  const tire = build.material("jet-tire", 0x060809, { roughness: 1, metallic: 0 });
  const hub = build.material("jet-hub", 0x89979a, { roughness: 0.3, metallic: 0.72 });
  const hotMetal = build.material("jet-hot-metal", 0x33383c, {
    roughness: 0.3,
    metallic: 0.85,
    emissive: 0x180b05,
    emissiveIntensity: 0.35,
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
      { x: -8.8, yRadius: 0.42, zRadius: 1.05, yOffset: 0.1, squareness: 3.4 },
      { x: -6.5, yRadius: 0.62, zRadius: 1.55, yOffset: 0.08, squareness: 3.5 },
      { x: -3.5, yRadius: 0.8, zRadius: 1.9, yOffset: 0.02, squareness: 3.6 },
      { x: 0, yRadius: 0.88, zRadius: 1.85, squareness: 3.5 },
      { x: 2.6, yRadius: 0.85, zRadius: 1.45, yOffset: 0.05, squareness: 3.2 },
      { x: 4.6, yRadius: 0.72, zRadius: 1.05, yOffset: 0.18, squareness: 2.9 },
      { x: 6.2, yRadius: 0.55, zRadius: 0.72, yOffset: 0.3, squareness: 2.7 },
    ],
    30,
    body,
    root,
  );
  const nose = build.loft(
    "radar-nose",
    [
      { x: 6.15, yRadius: 0.55, zRadius: 0.7, yOffset: 0.3, squareness: 2.6 },
      { x: 7.6, yRadius: 0.42, zRadius: 0.5, yOffset: 0.28, squareness: 2.3 },
      { x: 8.9, yRadius: 0.24, zRadius: 0.27, yOffset: 0.2 },
      { x: 9.55, yRadius: 0.05, zRadius: 0.05, yOffset: 0.12 },
    ],
    24,
    body,
    root,
  );
  // Chined LERX strakes carrying the forebody edge into the wing root. The
  // planform builder assumes one outline orientation, so the starboard side
  // reverses the point order instead of mirroring it inside-out.
  for (const side of [-1, 1] as const) {
    const outline = [
      { x: 6.6, z: side * 0.72 },
      { x: 2.5, z: side * 1.85 },
      { x: 2.5, z: side * 0.95 },
    ];
    if (side < 0) outline.reverse();
    const strake = build.planform(
      side < 0 ? "starboard-chine-strake" : "port-chine-strake",
      outline,
      0.09,
      body,
      root,
    );
    strake.position.y = 0.28;
  }

  const wingSurfaces: AbstractMesh[] = [];
  for (const side of [-1, 1] as const) {
    const sideName = side < 0 ? "starboard" : "port";
    // Clipped diamond: 42° leading-edge sweep, 17° forward-swept trailing
    // edge, thin fighter section.
    const forwardWing = build.airfoilWing(
      `${sideName}-swept-main-wing`,
      {
        rootLeadingX: 2.4,
        rootTrailingX: -4.1,
        tipLeadingX: -2.25,
        tipTrailingX: -3.05,
        rootZ: side * 1.6,
        tipZ: side * 6.78,
        thicknessRatio: 0.05,
        camberRatio: 0.001,
        chordSegments: 14,
        spanSegments: 4,
      },
      body,
      root,
    );
    forwardWing.position.y = -0.12;
    const flap = build.airfoilWing(
      `${sideName}-jet-flap`,
      {
        rootLeadingX: -3.95,
        rootTrailingX: -4.35,
        tipLeadingX: -3.6,
        tipTrailingX: -3.95,
        rootZ: side * 1.7,
        tipZ: side * 3.9,
        thicknessRatio: 0.045,
        chordSegments: 7,
        spanSegments: 2,
      },
      underside,
      root,
    );
    flap.position.y = -0.12;
    wingSurfaces.push(forwardWing, flap);
  }

  const starboardAileron = node("starboard-aileron", root, scene);
  starboardAileron.position.set(-3.56, -0.12, -4.35);
  const starboardSurface = build.airfoilWing(
    "starboard-aileron-surface",
    {
      rootLeadingX: 0,
      rootTrailingX: -0.55,
      tipLeadingX: 0.28,
      tipTrailingX: -0.3,
      rootZ: 0,
      tipZ: -2.05,
      thicknessRatio: 0.045,
      chordSegments: 7,
      spanSegments: 2,
    },
    accent,
    starboardAileron,
  );
  const portAileron = node("port-aileron", root, scene);
  portAileron.position.set(-3.56, -0.12, 4.35);
  const portSurface = build.airfoilWing(
    "port-aileron-surface",
    {
      rootLeadingX: 0,
      rootTrailingX: -0.55,
      tipLeadingX: 0.28,
      tipTrailingX: -0.3,
      rootZ: 0,
      tipZ: 2.05,
      thicknessRatio: 0.045,
      chordSegments: 7,
      spanSegments: 2,
    },
    accent,
    portAileron,
  );
  wingSurfaces.push(starboardSurface, portSurface);

  // All-moving stabilators: the whole tailplane hangs off the elevator node,
  // as on the real aircraft, instead of a fixed plane with hinged surfaces.
  const elevator = node("elevator", root, scene);
  elevator.position.set(-6.2, 0.1, 0);
  for (const side of [-1, 1] as const) {
    const tail = build.airfoilWing(
      side < 0 ? "starboard-swept-tailplane" : "port-swept-tailplane",
      {
        rootLeadingX: 1.6,
        rootTrailingX: -1.5,
        tipLeadingX: -0.7,
        tipTrailingX: -2.1,
        rootZ: side * 1.35,
        tipZ: side * 3.45,
        thicknessRatio: 0.045,
        chordSegments: 10,
        spanSegments: 2,
      },
      accent,
      elevator,
    );
    wingSurfaces.push(tail);
  }
  // Twin vertical stabilizers, canted 28° outboard.
  const finCant = (28 * Math.PI) / 180;
  for (const side of [-1, 1] as const) {
    const fin = build.verticalProfile(
      side < 0 ? "starboard-vertical-stabilizer" : "port-vertical-stabilizer",
      [
        { x: 1.55, y: 0 },
        { x: -1.35, y: 0 },
        { x: -1.05, y: 2.45 },
        { x: 0.15, y: 2.45 },
      ],
      0.09,
      body,
      root,
    );
    fin.position.set(-6, 0.62, side * 1.35);
    fin.rotation.x = side * finCant;
  }
  // The rig's `rudder` node is the CONTRACT carrier applyCommonPose deflects;
  // each surface hangs on its own hinge AT its fin's trailing edge (a parent
  // rotation 1.75 m off-axis is a lever arm, not a hinge — the surfaces slid
  // off the fins under yaw). The jet's update() mirrors the carrier's
  // deflection onto both hinges every frame.
  const rudder = node("rudder", root, scene);
  rudder.position.set(-7.15, 1.4, 0);
  const rudderHinges: TransformNode[] = [];
  for (const side of [-1, 1] as const) {
    const hinge = node(
      side < 0 ? "starboard-rudder-hinge" : "port-rudder-hinge",
      root,
      scene,
    );
    hinge.position.set(-7.43, 1.52, side * (1.35 + 0.85 * Math.sin(finCant)));
    hinge.rotation.x = side * finCant;
    const rudderSurface = build.box(
      side < 0 ? "starboard-rudder-surface" : "rudder-surface",
      0.52,
      1.35,
      0.07,
      accent,
      hinge,
    );
    rudderSurface.position.set(-0.1, 0, 0);
    rudderHinges.push(hinge);
  }

  // Single-seat frameless bubble canopy with the gold coating.
  const canopy = build.sphere("bubble-canopy", 1.24, 16, glass, root);
  canopy.metadata = { ...canopy.metadata, castsShadow: false };
  canopy.scaling.set(2.35, 0.92, 0.82);
  canopy.position.set(4.5, 0.92, 0);
  const canopyFrame = build.strutBetween(
    "canopy-bow-frame",
    new Vector3(5.75, 0.72, 0),
    new Vector3(5.6, 1.28, 0),
    0.03,
    dark,
    root,
  );
  const seat = build.box("jet-front-seat", 0.54, 0.7, 0.52, interior, root);
  seat.position.set(4.25, 0.55, 0);
  seat.rotation.z = -0.16;
  seat.metadata = { ...seat.metadata, cockpitInterior: true };
  const headrest = build.box("jet-front-headrest", 0.24, 0.3, 0.4, interior, root);
  headrest.position.set(3.98, 0.98, 0);
  headrest.metadata = { ...headrest.metadata, cockpitInterior: true };
  addInstrumentPanel(
    build,
    "jet",
    root,
    5.15,
    0.72,
    0.78,
    interior,
    instrumentFace,
    instrumentMarking,
  );
  const belly = build.box("jet-belly-panel", 6.4, 0.06, 1.35, underside, root);
  belly.position.set(-0.4, -0.87, 0);
  // Canted parallelogram cheek intakes feeding the widely-spaced engines.
  for (const side of [-1, 1]) {
    const intake = build.box(
      side < 0 ? "starboard-engine-intake" : "port-engine-intake",
      2,
      1.05,
      0.6,
      dark,
      root,
    );
    intake.position.set(3.1, -0.12, side * 1.62);
    intake.rotation.x = side * -0.28;
    intake.rotation.y = side * 0.06;
  }

  const propeller = node("jet-compressor", root, scene);
  propeller.position.x = -8.55;
  // Twin rectangular F119 nozzles.
  for (const side of [-1, 1]) {
    const nozzle = build.box(
      side < 0 ? "starboard-jet-nozzle" : "jet-nozzle",
      0.95,
      0.55,
      0.8,
      hotMetal,
      root,
    );
    nozzle.position.set(-8.95, 0.05, side * 0.58);
    // Static turbine faces deep in each nozzle. Deliberately NOT parented to
    // the spinning compressor node: a child offset 0.58 m off that node's X
    // axis would ORBIT the centreline instead of spinning in place, and the
    // face is invisible motion behind the nozzle box anyway.
    const turbine = build.cylinder(
      side < 0 ? "starboard-jet-turbine" : "jet-turbine",
      0.025,
      0.46,
      0.46,
      12,
      dark,
      root,
    );
    turbine.rotation.z = Math.PI / 2;
    turbine.position.set(-8.49, 0.05, side * 0.58);
  }

  const landingGear = node("retractable-landing-gear", root, scene);
  const mainWheels: TransformNode[] = [];
  for (const side of [-1, 1]) {
    build.strutBetween(
      side < 0 ? "starboard-main-strut" : "port-main-strut",
      new Vector3(-0.85, -0.5, side * 1.05),
      new Vector3(-0.85, -1.52, side * 1.63),
      0.075,
      hub,
      landingGear,
    );
    const wheel = node(side < 0 ? "starboard-main-wheel" : "port-main-wheel", landingGear, scene);
    wheel.position.set(-0.85, -1.55, side * 1.63);
    build.torus(`${wheel.name}-tire`, 0.78, 0.2, 20, tire, wheel);
    const wheelHub = build.cylinder(`${wheel.name}-hub`, 0.24, 0.36, 0.36, 14, hub, wheel);
    wheelHub.rotation.x = Math.PI / 2;
    mainWheels.push(wheel);
  }
  build.strutBetween(
    "jet-nose-strut",
    new Vector3(5.19, -0.55, 0),
    new Vector3(5.19, -1.58, 0),
    0.062,
    hub,
    landingGear,
  );
  const noseSteer = node("nose-wheel-steering", landingGear, scene);
  noseSteer.position.set(5.19, -1.61, 0);
  const noseWheel = node("nose-wheel", noseSteer, scene);
  build.torus("nose-wheel-tire", 0.62, 0.16, 18, tire, noseWheel);
  const noseHub = build.cylinder("nose-wheel-hub", 0.2, 0.28, 0.28, 12, hub, noseWheel);
  noseHub.rotation.x = Math.PI / 2;

  const gearDoorRoot = node("landing-gear-doors", root, scene);
  const gearDoors: AbstractMesh[] = [];
  for (const side of [-1, 1]) {
    const door = build.box(
      side < 0 ? "starboard-main-gear-door" : "port-main-gear-door",
      1.7,
      0.035,
      0.52,
      underside,
      gearDoorRoot,
    );
    door.position.set(-0.85, -0.88, side * 0.95);
    gearDoors.push(door);
  }
  const noseDoor = build.box("nose-gear-door", 1.55, 0.03, 0.44, underside, gearDoorRoot);
  noseDoor.position.set(4.65, -0.86, 0);
  gearDoors.push(noseDoor);

  const speedBrakes: TransformNode[] = [];
  for (const side of [-1, 1]) {
    const speedBrake = node(
      side < 0 ? "starboard-speed-brake" : "port-speed-brake",
      root,
      scene,
    );
    speedBrake.position.set(-1.6, 0.82, side * 1.15);
    const surface = build.box(
      `${speedBrake.name}-surface`,
      1.35,
      0.045,
      0.85,
      underside,
      speedBrake,
    );
    surface.position.x = -0.5;
    speedBrakes.push(speedBrake);
  }
  const portLight = build.sphere("port-navigation-light", 0.17, 8, redLamp, root);
  portLight.position.set(-2.35, -0.06, 6.72);
  portLight.metadata = { ...portLight.metadata, castsShadow: false };
  const starboardLight = build.sphere("starboard-navigation-light", 0.17, 8, greenLamp, root);
  starboardLight.position.set(-2.35, -0.06, -6.72);
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
      // Mirror the contract node's deflection onto the two real fin hinges.
      for (const hinge of rudderHinges) hinge.rotation.y = pose.rudder;
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
