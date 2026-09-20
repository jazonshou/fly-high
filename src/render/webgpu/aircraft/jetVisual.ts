import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import type { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh";
import type { Scene } from "@babylonjs/core/scene";
import {
  resolveAircraftAnimationPose,
  safeAircraftAnimationDelta,
} from "./animation";
import {
  applyCommonPose,
  configureCockpitLayers,
  configureRoot,
  createGlowApplier,
  createLampApplier,
  node,
  setCockpitVisibility,
  addInstrumentPanel,
  type CommonRig,
} from "./airframeRig";
import { AircraftBuildContext } from "./builders";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import type { AircraftVisual } from "./types";

interface JetRig extends CommonRig {
  readonly landingGear: TransformNode;
  readonly gearDoors: readonly AbstractMesh[];
  readonly speedBrakes: readonly TransformNode[];
}


export function createJet(scene: Scene): AircraftVisual {
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

  // `7-8`: the same four lamps, on BOTH airframes rather than only the one the
  // capture set flies — a half-lit jet is a latent inconsistency that surfaces
  // the first time someone switches aircraft, and the split-angle partition is
  // a property of the law, not of one model.
  const jetApplyLamp = createLampApplier();
  const jetApplyGlow = createGlowApplier();
  const tailLamp = build.material("jet-tail-lamp", 0xfff6e8, {
    emissive: 0xfff2d8, emissiveIntensity: 2.4,
  });
  const beaconLamp = build.material("jet-beacon-lamp", 0xff5a4a, {
    emissive: 0xff1c10, emissiveIntensity: 3,
  });
  const strobeLamp = build.material("jet-strobe-lamp", 0xffffff, {
    emissive: 0xf2f8ff, emissiveIntensity: 3.6,
  });
  const landingLamp = build.material("jet-landing-lamp", 0xfff1c2, {
    emissive: 0xffe6a8, emissiveIntensity: 2.6,
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
  // Flap panels hang off their own hinge nodes so `applyCommonPose` can drop
  // them. The node sits ON the hinge line — the panel's inboard leading edge —
  // and the panel's geometry is expressed relative to it, so a rotation swings
  // the trailing edge down instead of sweeping the whole panel through the
  // wing. The geometry is unchanged at zero deflection.
  const flaps: TransformNode[] = [];
  for (const side of [-1, 1] as const) {
    // D-6: starboard is body +Z, and every z below is `side * <positive>`, so
    // side < 0 IS the port wing. This mapping was inverted throughout the
    // file, which named the wings, flaps, tailplanes, elevators, intakes,
    // struts, wheels, gear doors and speed brakes after the opposite side. No
    // pixel moves — the airframe is a mirror pair — but every one of those
    // names lied, and the aileron bug that shipped for months was this same
    // inversion in the one place where a name was also wired to a control.
    const sideName = side < 0 ? "port" : "starboard";
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
    const flapHinge = node(`${sideName}-jet-flap-hinge`, root, scene);
    flapHinge.position.set(-0.64, 0, side * 0.61);
    const flap = build.airfoilWing(
      `${sideName}-jet-flap`,
      {
        rootLeadingX: 0,
        rootTrailingX: -0.11,
        tipLeadingX: -0.15,
        tipTrailingX: -0.38,
        rootZ: 0,
        tipZ: side * 2.04,
        thicknessRatio: 0.065,
        chordSegments: 7,
        spanSegments: 2,
      },
      underside,
      flapHinge,
    );
    flaps.push(flapHinge);
    wingSurfaces.push(forwardWing, flap);
  }

  // Same side swap as the trainer's; see the note there.
  const starboardAileron = node("starboard-aileron", root, scene);
  starboardAileron.position.set(-0.78, 0.02, 2.76);
  const starboardSurface = build.airfoilWing(
    "starboard-aileron-surface",
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
    starboardAileron,
  );
  const portAileron = node("port-aileron", root, scene);
  portAileron.position.set(-0.78, 0.02, -2.76);
  const portSurface = build.airfoilWing(
    "port-aileron-surface",
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
    portAileron,
  );
  wingSurfaces.push(starboardSurface, portSurface);

  for (const side of [-1, 1] as const) {
    const tail = build.airfoilWing(
      side < 0 ? "port-swept-tailplane" : "starboard-swept-tailplane",
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
      side < 0 ? "port-jet-elevator-surface" : "starboard-jet-elevator-surface",
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
      side < 0 ? "port-engine-intake" : "starboard-engine-intake",
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
      side < 0 ? "port-main-strut" : "starboard-main-strut",
      new Vector3(-0.55, -0.18, side * 0.72),
      new Vector3(-0.72, -1.08, side * 1.72),
      0.058,
      hub,
      landingGear,
    );
    const wheel = node(side < 0 ? "port-main-wheel" : "starboard-main-wheel", landingGear, scene);
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
      side < 0 ? "port-main-gear-door" : "starboard-main-gear-door",
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
      side < 0 ? "port-speed-brake" : "starboard-speed-brake",
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
  const tailLight = build.sphere("tail-navigation-light", 0.13, 8, tailLamp, root);
  tailLight.position.set(-5.42, 1.18, 0);
  tailLight.metadata = { ...tailLight.metadata, castsShadow: false };
  const beaconLight = build.sphere("anticollision-beacon", 0.14, 8, beaconLamp, root);
  beaconLight.position.set(-1.6, 0.92, 0);
  beaconLight.metadata = { ...beaconLight.metadata, castsShadow: false };
  for (const side of [-1, 1]) {
    const strobe = build.sphere(
      side < 0 ? "port-strobe-light" : "starboard-strobe-light", 0.11, 8, strobeLamp, root);
    strobe.position.set(-0.34, 0.09, side * 4.98);
    strobe.metadata = { ...strobe.metadata, castsShadow: false };
  }
  const jetLandingLight = build.cylinder(
    "landing-light", 0.022, 0.2, 0.2, 10, landingLamp, root);
  jetLandingLight.rotation.z = Math.PI / 2;
  jetLandingLight.position.set(3.4, -0.62, 0);
  jetLandingLight.metadata = { ...jetLandingLight.metadata, castsShadow: false };
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
    flaps,
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
    setLightState(lights) {
      if (disposed) return;
      jetApplyLamp(redLamp, lights.portNav);
      jetApplyLamp(greenLamp, lights.starboardNav);
      jetApplyLamp(tailLamp, lights.tailNav);
      jetApplyLamp(beaconLamp, lights.beacon);
      jetApplyLamp(strobeLamp, lights.strobe);
      jetApplyLamp(landingLamp, lights.landing);
      jetApplyGlow(instrumentMarking, lights.cockpitGlow);

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

