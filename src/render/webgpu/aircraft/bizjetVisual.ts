// `thinInstanceSetBuffer`/`thinInstanceCount` are prototype extensions Babylon
// only installs with this side-effect import, exactly as the terrain clipmap
// and the wildlife system take it. The cabin window line is the one place an
// aircraft needs it: seventeen ovals a side is a real feature of this type and
// thirty separate meshes for it is not affordable.
import "@babylonjs/core/Meshes/thinInstanceMesh";
import { Matrix, Quaternion, Vector3 } from "@babylonjs/core/Maths/math.vector";
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

/**
 * The retractable parts, on the same contract the sport jet's rig uses: the
 * gear collapses by scaling one node, the doors swing on the door travel and
 * the brake panels take a single angle. The Global's brake panels are wing
 * spoilers rather than the jet's fuselage airbrake, but they are driven from
 * the identical pose field, because "how far is the brake out" is one number
 * whatever the metal doing it looks like.
 */
interface BizJetRig extends CommonRig {
  readonly landingGear: TransformNode;
  readonly gearDoors: readonly AbstractMesh[];
  readonly speedBrakes: readonly TransformNode[];
}

/**
 * Wing planform, written once because six different parts are cut from it.
 *
 * The real aeroplane: 31.7 m span, 94 m^2, 35 degrees of leading-edge sweep.
 * Taper follows from the published 3.4 m mean aerodynamic chord — for a
 * straight-tapered wing of this span and area, MAC 3.4 pins the taper ratio at
 * 0.21 and the centreline chord at about 4.9 m. This wing is kinked instead,
 * as the aeroplane's is: a less swept inboard trailing edge out to the flap
 * break, then a sharply swept outboard panel. Keeping the kink chord at 3.06 m
 * rather than the straight-taper value is what holds the area at 93 m^2; a
 * smaller kink chord looks plausible and quietly loses fifteen square metres.
 *
 * The centreline leading edge at x = +5.15 is not a styling choice. It puts
 * the quarter-chord of the mean aerodynamic chord — station z = 6.2, chord
 * 3.10 — within 4 cm of x = 0, and x = 0 is the centre of gravity the sim's
 * whole definition is written about. A wing anywhere else would have the
 * aeroplane balancing on a point its own lift does not pass through.
 */
const WING_ROOT_Z = 1.45;
const WING_KINK_Z = 6.3;
const WING_TIP_Z = 15;
const WING_CHORD_PLANE_Y = -0.9;
/** Leading edge at each of the three defining stations. */
const WING_ROOT_LEADING_X = 4.14;
const WING_KINK_LEADING_X = 0.74;
const WING_TIP_LEADING_X = -5.35;
/** True trailing edge — where the flaps and ailerons END. */
const WING_ROOT_TRAILING_X = -1.11;
const WING_KINK_TRAILING_X = -2.32;
const WING_TIP_TRAILING_X = -6.5;
/**
 * Hinge line, at 72% of local chord. One fraction for the whole span so the
 * flap and aileron hinges form a single unbroken line, which is what lets the
 * fixed wing be two panels instead of six.
 */
const WING_ROOT_HINGE_X = 0.36;
const WING_KINK_HINGE_X = -1.46;
const WING_TIP_HINGE_X = -6.18;

/** Linear interpolation along the inboard or outboard panel. */
function alongPanel(rootValue: number, tipValue: number, fraction: number): number {
  return rootValue + (tipValue - rootValue) * fraction;
}

/** Where a station sits along the inboard panel, 0 at the root rib. */
function inboardFraction(z: number): number {
  return (Math.abs(z) - WING_ROOT_Z) / (WING_KINK_Z - WING_ROOT_Z);
}

/** Where a station sits along the outboard panel, 0 at the kink. */
function outboardFraction(z: number): number {
  return (Math.abs(z) - WING_KINK_Z) / (WING_TIP_Z - WING_KINK_Z);
}

/**
 * The cabin window line. The Global's seventeen-a-side window run is most of
 * why the silhouette reads as an airliner-derived business jet rather than as
 * a large fighter, and it is also the single most repetitive thing on the
 * aeroplane — one 12-sided oval, thin-instanced thirty times, one draw call.
 *
 * Fifteen a side rather than seventeen: the two forward-most are behind the
 * flight deck bulkhead on the real aeroplane and would sit on fuselage that is
 * already tapering here.
 */
const CABIN_WINDOW_COUNT = 15;
const CABIN_WINDOW_FORWARD_X = 8.8;
const CABIN_WINDOW_PITCH = 1.06;
/** Seated eye height, a little above the fuselage centreline. */
const CABIN_WINDOW_Y = 0.3;
/** Fuselage half-width at that height, so the pane sits in the skin. */
const CABIN_WINDOW_Z = 1.32;
/**
 * 0.40 m across by 0.58 m tall. Bombardier sells these as the largest windows
 * in the class and they are visibly taller than they are wide, which a round
 * porthole would throw away.
 */
const CABIN_WINDOW_WIDTH = 0.4;
const CABIN_WINDOW_HEIGHT_RATIO = 1.45;

export function createBizJet(scene: Scene): AircraftVisual {
  const build = new AircraftBuildContext(scene);
  const root = new TransformNode("bombardier-global-8000", scene);
  configureRoot(root, "bizjet");

  // Two paint recipes, not the sport jet's three. This airframe carries three
  // times the painted area and each recipe costs three synthesized textures;
  // a corporate scheme is a white shell with a coloured empennage and control
  // surfaces, so a separate underside recipe would buy a distinction nobody
  // can see from any angle the camera actually flies.
  const body = build.paintMaterial("bizjet-body", {
    seed: 0x6108_0001,
    baseColor: 0xf2f4f3,
    liveryColor: 0x1d3f5e,
    roughness: 0.29,
    metallic: 0.16,
    sootStrength: 0.34,
    wearStrength: 0.4,
    // The 64-pixel maps stretch over a 33 m fuselage. At full strength the
    // panel grid would read as quilting rather than as skin.
    panelStrength: 0.45,
  });
  const accent = build.paintMaterial("bizjet-accent", {
    seed: 0x6108_0002,
    baseColor: 0x1d3f5e,
    liveryColor: 0xc9a227,
    roughness: 0.33,
    metallic: 0.12,
    sootStrength: 0.42,
    wearStrength: 0.55,
    panelStrength: 0.6,
  });
  const dark = build.material("bizjet-dark", 0x101b22, {
    roughness: 0.26,
    metallic: 0.4,
  });
  const glass = build.material("bizjet-glass", 0x14323f, {
    roughness: 0.04,
    metallic: 0,
    alpha: 0.29,
    doubleSided: true,
    clearCoat: { intensity: 1, roughness: 0.02, indexOfRefraction: 1.5 },
    transmission: {
      indexOfRefraction: 1.52,
      minimumThickness: 0.005,
      maximumThickness: 0.014,
      tintColor: 0xa9dae6,
      tintColorAtDistance: 3.2,
    },
  });
  const tire = build.material("bizjet-tire", 0x06080a, { roughness: 1, metallic: 0 });
  const hub = build.material("bizjet-hub", 0x8b9498, { roughness: 0.32, metallic: 0.74 });
  const hotMetal = build.material("bizjet-hot-metal", 0x4b5153, {
    roughness: 0.24,
    metallic: 0.9,
    emissive: 0x2c1109,
    emissiveIntensity: 0.4,
  });
  const interior = build.material("bizjet-interior", 0x1a2328, {
    roughness: 0.82,
    metallic: 0.02,
  });
  const instrumentFace = build.material("bizjet-instrument-face", 0x050a0d, {
    roughness: 0.7,
    metallic: 0.05,
  });
  const instrumentMarking = build.material("bizjet-instrument-marking", 0x9fd9e8, {
    roughness: 0.34,
    metallic: 0,
    emissive: 0x4ba8c6,
    emissiveIntensity: 0.7,
  });

  // Same six lamps and the same two appliers as the other two airframes. The
  // split-angle nav partition is a property of the lighting law, so a third
  // aeroplane that shipped with four of the six would be the same latent
  // inconsistency `7-8` found on the jet.
  const applyLamp = createLampApplier();
  const applyGlow = createGlowApplier();
  const redLamp = build.material("bizjet-port-lamp", 0xff493d, {
    emissive: 0xff2018, emissiveIntensity: 2.4,
  });
  const greenLamp = build.material("bizjet-starboard-lamp", 0x5dffab, {
    emissive: 0x24ff83, emissiveIntensity: 2.4,
  });
  const tailLamp = build.material("bizjet-tail-lamp", 0xfff6e8, {
    emissive: 0xfff2d8, emissiveIntensity: 2.4,
  });
  const beaconLamp = build.material("bizjet-beacon-lamp", 0xff5a4a, {
    emissive: 0xff1c10, emissiveIntensity: 3,
  });
  const strobeLamp = build.material("bizjet-strobe-lamp", 0xffffff, {
    emissive: 0xf2f8ff, emissiveIntensity: 3.6,
  });
  const landingLamp = build.material("bizjet-landing-lamp", 0xfff1c2, {
    emissive: 0xffe6a8, emissiveIntensity: 2.6,
  });

  // 33.88 m from radome to tailcone, in three lofts: the constant-section tube,
  // the upswept tailcone and the drooped radome. Outside diameter 2.72 m — this
  // is the widest cabin in the class and the tube has to look it next to the
  // 1.4 m sport jet. The centreline is body y = 0, which puts the belly at
  // -1.36 and, with the main wheels contacting at -2.7, gives the 0.9 m of
  // ground clearance the real aeroplane has under its wing-body fairing.
  const fuselage = build.loft(
    "bizjet-fuselage",
    [
      { x: -13.1, yRadius: 1.01, zRadius: 0.97, yOffset: 0.27 },
      { x: -10.5, yRadius: 1.24, zRadius: 1.2, yOffset: 0.12 },
      { x: -8, yRadius: 1.35, zRadius: 1.34, yOffset: 0.03 },
      { x: -2, yRadius: 1.36, zRadius: 1.35 },
      { x: 4.5, yRadius: 1.36, zRadius: 1.35 },
      { x: 9.5, yRadius: 1.35, zRadius: 1.33 },
      { x: 11.6, yRadius: 1.26, zRadius: 1.2, yOffset: 0.06 },
      { x: 13.2, yRadius: 0.9, zRadius: 0.88, yOffset: -0.02 },
    ],
    28,
    body,
    root,
  );
  // The nose DROOPS: the sim's two radome contact points straddle y = -0.15,
  // not y = 0. That is the real shape — the flight deck sits on top of a
  // radome whose axis falls away from the cabin centreline — and it is most of
  // what stops a business jet nose reading as a fighter's.
  const radome = build.loft(
    "bizjet-radome",
    [
      { x: 13.1, yRadius: 0.9, zRadius: 0.88, yOffset: -0.02 },
      { x: 14.1, yRadius: 0.62, zRadius: 0.62, yOffset: -0.12 },
      { x: 14.7, yRadius: 0.34, zRadius: 0.34, yOffset: -0.15 },
      { x: 15, yRadius: 0.1, zRadius: 0.1, yOffset: -0.15 },
    ],
    24,
    body,
    root,
  );
  // Upswept, ending at (-18.5, +0.62) where the sim puts its tailcone contact
  // point. The upsweep is what gives a long aeroplane its rotation angle
  // without dragging the tail, and on this type it also carries the APU.
  build.loft(
    "bizjet-tailcone",
    [
      { x: -18.5, yRadius: 0.14, zRadius: 0.12, yOffset: 0.62 },
      { x: -17.2, yRadius: 0.42, zRadius: 0.36, yOffset: 0.58 },
      { x: -15.4, yRadius: 0.7, zRadius: 0.64, yOffset: 0.48 },
      { x: -12.9, yRadius: 1.03, zRadius: 0.99, yOffset: 0.25 },
    ],
    22,
    body,
    root,
  );
  // The wing-to-body fairing, which on this aeroplane houses the wing box, the
  // main gear bays and the centre tank and is wider than the fuselage itself.
  // Its underside at y = -1.80 is what the belly beacon is mounted on; without
  // it the beacon at -1.75 would float 0.4 m clear of the skin.
  build.loft(
    "bizjet-belly-fairing",
    [
      { x: -6.2, yRadius: 0.3, zRadius: 0.6, yOffset: -1.1 },
      { x: -4.6, yRadius: 0.62, zRadius: 1.32, yOffset: -1.2 },
      { x: -1.2, yRadius: 0.75, zRadius: 1.6, yOffset: -1.08 },
      { x: 1.8, yRadius: 0.7, zRadius: 1.52, yOffset: -1.05 },
      { x: 4.6, yRadius: 0.34, zRadius: 0.95, yOffset: -1 },
    ],
    20,
    body,
    root,
  );

  // One 12-sided oval, thin-instanced down both sides. The instance matrix is
  // the ENTIRE transform — the base mesh keeps an identity one — because thin
  // instance matrices multiply into the mesh's own world matrix and splitting
  // the rotation across both is how that arrangement becomes unreadable.
  const cabinWindow = build.cylinder(
    "bizjet-cabin-window-line",
    0.07,
    CABIN_WINDOW_WIDTH,
    CABIN_WINDOW_WIDTH,
    12,
    dark,
    root,
  );
  {
    // Babylon's cylinder runs along local +Y with its disc in local X/Z.
    // Scaling local Z stretches the disc into the tall oval, and a quarter
    // turn about X then lays the oval into the fuselage side: local Z becomes
    // world -Y (the 0.58 m height) and the cylinder's own axis becomes world
    // Z, i.e. the 0.07 m pane thickness through the skin.
    const paneRotation = Quaternion.RotationYawPitchRoll(0, Math.PI / 2, 0);
    const paneScale = new Vector3(1, 1, CABIN_WINDOW_HEIGHT_RATIO);
    const matrices = new Float32Array(CABIN_WINDOW_COUNT * 2 * 16);
    let offset = 0;
    for (const side of [1, -1] as const) {
      for (let index = 0; index < CABIN_WINDOW_COUNT; index += 1) {
        Matrix.Compose(
          paneScale,
          paneRotation,
          new Vector3(
            CABIN_WINDOW_FORWARD_X - index * CABIN_WINDOW_PITCH,
            CABIN_WINDOW_Y,
            side * CABIN_WINDOW_Z,
          ),
        ).copyToArray(matrices, offset);
        offset += 16;
      }
    }
    cabinWindow.thinInstanceSetBuffer("matrix", matrices, 16, true);
    cabinWindow.thinInstanceRefreshBoundingInfo(true);
  }

  const wingSurfaces: AbstractMesh[] = [];
  const flaps: TransformNode[] = [];
  const speedBrakes: TransformNode[] = [];

  // STARBOARD IS BODY +Z. Every side loop in this file runs [1, -1] and calls
  // +1 starboard, so the name and the sign cannot drift apart the way they did
  // on the two older airframes — where `side < 0 ? "starboard" : "port"` put
  // the starboard wing at -Z and the ailerons answered the wrong command for
  // months. `tests/render.webgpu-control-surface-sides.test.ts` measures this
  // in world space, but the loop should be right without the test.
  for (const side of [1, -1] as const) {
    const sideName = side > 0 ? "starboard" : "port";

    // Fixed wing, in two panels split at the flap break. Thickness 11% inboard
    // and 9.5% outboard is a supercritical section's, matching the sim's
    // cl_zero of 0.14 — cambered for M 0.9 cruise, not for lift at approach.
    const inboardWing = build.airfoilWing(
      `${sideName}-bizjet-inboard-wing`,
      {
        rootLeadingX: WING_ROOT_LEADING_X,
        rootTrailingX: WING_ROOT_HINGE_X,
        tipLeadingX: WING_KINK_LEADING_X,
        tipTrailingX: WING_KINK_HINGE_X,
        rootZ: side * WING_ROOT_Z,
        tipZ: side * WING_KINK_Z,
        thicknessRatio: 0.11,
        camberRatio: 0.004,
        chordSegments: 14,
        spanSegments: 3,
      },
      body,
      root,
    );
    inboardWing.position.y = WING_CHORD_PLANE_Y;
    const outboardWing = build.airfoilWing(
      `${sideName}-bizjet-outboard-wing`,
      {
        rootLeadingX: WING_KINK_LEADING_X,
        rootTrailingX: WING_KINK_HINGE_X,
        tipLeadingX: WING_TIP_LEADING_X,
        tipTrailingX: WING_TIP_HINGE_X,
        rootZ: side * WING_KINK_Z,
        tipZ: side * WING_TIP_Z,
        thicknessRatio: 0.095,
        camberRatio: 0.004,
        chordSegments: 14,
        spanSegments: 4,
      },
      body,
      root,
    );
    outboardWing.position.y = WING_CHORD_PLANE_Y;
    wingSurfaces.push(inboardWing, outboardWing);

    // The winglet. Built flat, in the wing's own plane, then rotated about
    // body X so it turns up and slightly outboard: 1.30 m of rise over 0.85 m
    // of outboard reach, which lands its tip at (y +0.40, z +/-15.85) — the
    // outermost airframe contact point in `sim/aircraft.ts`, and the first
    // thing to touch in a wing-low landing. The rotation is derived rather
    // than eyeballed so the tip hits that point exactly: the winglet is built
    // hypotenuse-long and the angle is atan2 of the two legs.
    const wingletRise = 1.3;
    const wingletReach = 0.85;
    const wingletSpan = Math.hypot(wingletRise, wingletReach);
    const winglet = build.airfoilWing(
      `${sideName}-bizjet-winglet`,
      {
        rootLeadingX: WING_TIP_LEADING_X,
        rootTrailingX: WING_TIP_TRAILING_X,
        tipLeadingX: -5.95,
        tipTrailingX: -6.6,
        rootZ: 0,
        tipZ: side * wingletSpan,
        thicknessRatio: 0.085,
        chordSegments: 10,
        spanSegments: 2,
      },
      accent,
      root,
    );
    winglet.position.set(0, WING_CHORD_PLANE_Y, side * WING_TIP_Z);
    winglet.rotation.x = -side * Math.atan2(wingletRise, wingletReach);
    wingSurfaces.push(winglet);
  }

  // Fowler flaps, in two panels a side as the aeroplane has them: one inboard
  // of the kink, one between the kink and the aileron. The sim leans on these
  // hard — flapLift 0.95 is what brings a 40-tonne aeroplane's approach speed
  // inside a 1,320 m runway — so they are built as real panels on real hinges
  // rather than painted on.
  //
  // Each hinge node sits ON the hinge line at the panel's inboard end and the
  // panel is parented to it in local coordinates, so `rotation.z` is a hinge
  // rotation and not a translation of the whole panel. The hinge line is
  // swept and body Z is not exactly along it; `applyCommonPose` drives every
  // flap about body Z, which is the contract, and at 30 degrees the error
  // across a 4 m panel is smaller than the panel's own thickness.
  // The inner panel is cut from the inboard wing and the outer one from the
  // outboard wing, so each reads its hinge and trailing edge off a different
  // pair of stations; that is the only thing `insideKink` selects.
  const flapPanels = [
    { name: "inner", rootZ: 1.9, tipZ: 6.1, insideKink: true },
    { name: "outer", rootZ: 6.55, tipZ: 8.95, insideKink: false },
  ];
  for (const side of [1, -1] as const) {
    const sideName = side > 0 ? "starboard" : "port";
    for (const flap of flapPanels) {
      const fraction = (z: number) => (flap.insideKink
        ? inboardFraction(z)
        : outboardFraction(z));
      const hingeAt = (z: number) => (flap.insideKink
        ? alongPanel(WING_ROOT_HINGE_X, WING_KINK_HINGE_X, fraction(z))
        : alongPanel(WING_KINK_HINGE_X, WING_TIP_HINGE_X, fraction(z)));
      const trailingAt = (z: number) => (flap.insideKink
        ? alongPanel(WING_ROOT_TRAILING_X, WING_KINK_TRAILING_X, fraction(z))
        : alongPanel(WING_KINK_TRAILING_X, WING_TIP_TRAILING_X, fraction(z)));
      const hingeX = hingeAt(flap.rootZ);
      const hinge = node(`${sideName}-bizjet-${flap.name}-flap`, root, scene);
      hinge.position.set(hingeX, WING_CHORD_PLANE_Y, side * flap.rootZ);
      const surface = build.airfoilWing(
        `${sideName}-bizjet-${flap.name}-flap-surface`,
        {
          rootLeadingX: 0,
          rootTrailingX: trailingAt(flap.rootZ) - hingeX,
          tipLeadingX: hingeAt(flap.tipZ) - hingeX,
          tipTrailingX: trailingAt(flap.tipZ) - hingeX,
          rootZ: 0,
          tipZ: side * (flap.tipZ - flap.rootZ),
          thicknessRatio: 0.075,
          camberRatio: 0.012,
          chordSegments: 8,
          spanSegments: 2,
        },
        accent,
        hinge,
      );
      flaps.push(hinge);
      wingSurfaces.push(surface);
    }

    // Flap track canoes. Four fairings under the wing is not decoration on
    // this type — Fowler tracks long enough to move the panel aft as well as
    // down will not fit inside a 10% section, so the aeroplane wears them
    // externally and they are visible from every angle the chase camera uses.
    for (const track of [{ z: 3, x: -0.95, length: 2.3 }, { z: 5.6, x: -1.85, length: 2 }]) {
      const fairing = build.box(
        `${sideName}-bizjet-flap-track-${track.z < 4 ? "inner" : "outer"}`,
        track.length,
        0.32,
        0.36,
        body,
        root,
      );
      fairing.position.set(track.x, -1.15, side * track.z);
    }

    // Spoilers, on the UPPER surface just ahead of the flap hinge. This
    // aeroplane has no fuselage airbrake — `speedBrakeDrag` 0.09 against the
    // sport jet's 0.16 is exactly that difference — so the brake the pilot
    // commands is these panels lifting off the wing.
    //
    // WING-COLOURED AND FLUSH, which the first version was not. Built in the
    // accent paint and standing 0.05 m proud, they read as gold-and-navy
    // hazard decals stuck to the wing rather than as panels in it — Jason
    // spotted it immediately. On the real aeroplane they are the wing's own
    // skin: at rest you see a panel line, nothing more. Four a side now
    // rather than two, which is what a Global carries, and each one sits on
    // the SWEPT hinge line rather than at a fixed x, so its aft edge meets the
    // flap it lives in front of at every station instead of only at one.
    for (const spoiler of [
      { name: "one", z: 3.2, span: 1.3, chord: 1.0, surfaceY: -0.703 },
      { name: "two", z: 4.7, span: 1.3, chord: 0.95, surfaceY: -0.735 },
      { name: "three", z: 6.3, span: 1.5, chord: 0.85, surfaceY: -0.768 },
      { name: "four", z: 8, span: 1.6, chord: 0.75, surfaceY: -0.803 },
    ]) {
      const hingeLineX = spoiler.z <= WING_KINK_Z
        ? alongPanel(WING_ROOT_HINGE_X, WING_KINK_HINGE_X, inboardFraction(spoiler.z))
        : alongPanel(WING_KINK_HINGE_X, WING_TIP_HINGE_X, outboardFraction(spoiler.z));
      const brake = node(`${sideName}-bizjet-${spoiler.name}-spoiler`, root, scene);
      // The node is the panel's FORWARD edge and its hinge, so it sits one
      // chord ahead of the flap hinge line and the panel reaches back to it.
      brake.position.set(hingeLineX + spoiler.chord, spoiler.surfaceY, side * spoiler.z);
      const panel = build.box(
        `${brake.name}-surface`,
        spoiler.chord,
        // 35 mm: thick enough to catch a highlight along its edge, thin enough
        // to be a panel line rather than a step.
        0.035,
        spoiler.span,
        body,
        brake,
      );
      // Hinged at its forward edge, so the panel lies entirely aft of the
      // node and a negative pose angle lifts its trailing edge into the air.
      panel.position.x = -spoiler.chord * 0.5;
      speedBrakes.push(brake);
    }
  }

  // Ailerons, outboard of the flaps on the same hinge line. STARBOARD FIRST in
  // the tuple and at POSITIVE Z; `applyCommonPose` drives `ailerons[0]` with
  // the starboard deflection and nothing downstream checks the name.
  const aileronRootZ = 9.35;
  const aileronTipZ = 14.1;
  const aileronHingeRoot = alongPanel(
    WING_KINK_HINGE_X, WING_TIP_HINGE_X, outboardFraction(aileronRootZ));
  const aileronHingeTip = alongPanel(
    WING_KINK_HINGE_X, WING_TIP_HINGE_X, outboardFraction(aileronTipZ));
  const aileronTrailingRoot = alongPanel(
    WING_KINK_TRAILING_X, WING_TIP_TRAILING_X, outboardFraction(aileronRootZ));
  const aileronTrailingTip = alongPanel(
    WING_KINK_TRAILING_X, WING_TIP_TRAILING_X, outboardFraction(aileronTipZ));
  const starboardAileron = node("starboard-aileron", root, scene);
  starboardAileron.position.set(aileronHingeRoot, WING_CHORD_PLANE_Y, aileronRootZ);
  const portAileron = node("port-aileron", root, scene);
  portAileron.position.set(aileronHingeRoot, WING_CHORD_PLANE_Y, -aileronRootZ);
  for (const side of [1, -1] as const) {
    wingSurfaces.push(build.airfoilWing(
      side > 0 ? "starboard-aileron-surface" : "port-aileron-surface",
      {
        rootLeadingX: 0,
        rootTrailingX: aileronTrailingRoot - aileronHingeRoot,
        tipLeadingX: aileronHingeTip - aileronHingeRoot,
        tipTrailingX: aileronTrailingTip - aileronHingeRoot,
        rootZ: 0,
        tipZ: side * (aileronTipZ - aileronRootZ),
        thicknessRatio: 0.07,
        chordSegments: 8,
        spanSegments: 3,
      },
      accent,
      side > 0 ? starboardAileron : portAileron,
    ));
  }

  // THE T-TAIL. After its length this is the most recognisable thing about the
  // aeroplane, and the tailplane belongs at the TOP of the fin — mounted on
  // the fuselage it would be a different type entirely.
  //
  // The fin is a four-point trapezoid rather than the triangles the two small
  // airframes use, because a T-tail fin has a real tip chord to carry the
  // tailplane on. The profile builder fans its outline from the first vertex,
  // so the four points are ordered to stay convex. Leading edge sweep is 48
  // degrees, tip at (-16.1, +6.2), matching the sim's fin contact point.
  const fin = build.verticalProfile(
    "bizjet-vertical-stabilizer",
    [
      { x: -9.2, y: 0.85 },
      { x: -15.9, y: 0.85 },
      { x: -16.3, y: 6.2 },
      { x: -14.8, y: 6.2 },
    ],
    0.45,
    body,
    root,
  );
  wingSurfaces.push(fin);
  const rudder = node("rudder", root, scene);
  rudder.position.set(-15.95, 0.95, 0);
  // 0.26 m thick against the fin's 0.45: the section tapers aft, and a rudder
  // as thick as its own swing would make "which way did the trailing edge go"
  // ambiguous — `render.webgpu-control-surface-sides` reads the aftmost vertex
  // and at 0.24 rad the panel only travels 0.36 m.
  const rudderSurface = build.box("rudder-surface", 1.25, 5.2, 0.26, accent, rudder);
  rudderSurface.position.set(-0.68, 2.62, 0);
  // The hinge line leans 0.40 m aft over its 5.35 m; a box cannot be swept, so
  // the panel is tilted to sit on that line instead of crossing it. Applied to
  // the CHILD, because the node's own Y rotation is the rudder deflection the
  // pose owns every frame.
  rudderSurface.rotation.z = Math.atan2(0.4, 5.35);

  // Tailplane at y = +6.2, on top of the fin. 9 m span, 25 degrees of sweep —
  // less than the fin's, as T-tails generally are, because the tailplane is
  // out of the fuselage's flow field and does not need it.
  const TAILPLANE_Y = 6.2;
  const ELEVATOR_HINGE_X = -16.28;
  for (const side of [1, -1] as const) {
    const tailplane = build.airfoilWing(
      side > 0 ? "starboard-bizjet-tailplane" : "port-bizjet-tailplane",
      {
        rootLeadingX: -14.6,
        rootTrailingX: ELEVATOR_HINGE_X,
        tipLeadingX: -16.56,
        tipTrailingX: -17.33,
        rootZ: side * 0.32,
        tipZ: side * 4.5,
        thicknessRatio: 0.09,
        chordSegments: 10,
        spanSegments: 3,
      },
      body,
      root,
    );
    tailplane.position.y = TAILPLANE_Y;
    wingSurfaces.push(tailplane);
  }
  // The bullet fairing over the fin/tailplane junction, and it is not
  // decoration: the fin is 0.45 m thick (z +/-0.225) and BOTH the tailplane
  // and the elevator start at |z| = 0.32, so without it there is a 9.5 cm slot
  // down each side of the fin top, open from x -14.6 clear through to the
  // elevator trailing edge. You can see sky through the tail. Every real
  // T-tail carries this fairing for the same reason — it is where the
  // stabiliser's centre structure and its trim actuator live — so the fix is
  // the aeroplane's own part rather than a patch. Sized to 0.39 m half-width
  // so it overlaps both roots rather than merely meeting them, and stopping
  // short of the elevator's travel.
  build.loft(
    "bizjet-tailplane-bullet",
    [
      { x: -17.45, yRadius: 0.1, zRadius: 0.1, yOffset: TAILPLANE_Y },
      { x: -16.6, yRadius: 0.3, zRadius: 0.38, yOffset: TAILPLANE_Y },
      { x: -15.3, yRadius: 0.33, zRadius: 0.39, yOffset: TAILPLANE_Y },
      { x: -14.25, yRadius: 0.12, zRadius: 0.16, yOffset: TAILPLANE_Y },
    ],
    16,
    body,
    root,
  );

  const elevator = node("elevator", root, scene);
  elevator.position.set(ELEVATOR_HINGE_X, TAILPLANE_Y, 0);
  for (const side of [1, -1] as const) {
    wingSurfaces.push(build.airfoilWing(
      side > 0 ? "starboard-bizjet-elevator-surface" : "port-bizjet-elevator-surface",
      {
        rootLeadingX: 0,
        rootTrailingX: -0.72,
        tipLeadingX: -1.05,
        tipTrailingX: -1.38,
        rootZ: side * 0.32,
        tipZ: side * 4.5,
        thicknessRatio: 0.07,
        chordSegments: 8,
        spanSegments: 2,
      },
      accent,
      elevator,
    ));
  }

  // FLIGHT DECK. Well forward and high, on top of the drooped radome. The
  // glass goes through `build.material`'s alpha path, which is what moves
  // these meshes into the airframe-transparency rendering group: drawn before
  // the water their depth pre-pass cuts a hole in the sea behind them, and
  // that is a defect this renderer has shipped before.
  const windscreen = build.box("bizjet-windscreen", 0.12, 0.66, 1.6, glass, root);
  windscreen.position.set(12.85, 0.88, 0);
  windscreen.rotation.z = 0.52;
  windscreen.metadata = { ...windscreen.metadata, castsShadow: false };
  for (const side of [1, -1] as const) {
    const sideWindow = build.box(
      side > 0 ? "starboard-bizjet-flight-deck-window" : "port-bizjet-flight-deck-window",
      1.8,
      0.52,
      0.08,
      glass,
      root,
    );
    sideWindow.position.set(11.8, 0.78, side * 0.99);
    // Laid on to the fuselage flank: the pane's normal is its local Z, and a
    // half-radian turn about X points it outboard and up, along the skin.
    sideWindow.rotation.x = -side * 0.5;
    sideWindow.metadata = { ...sideWindow.metadata, castsShadow: false };
  }
  const windscreenFrame = build.strutBetween(
    "bizjet-windscreen-center-post",
    new Vector3(13.05, 0.52, 0),
    new Vector3(12.2, 1.3, 0),
    0.055,
    dark,
    root,
  );

  for (const side of [1, -1] as const) {
    const seat = build.box(
      side > 0 ? "bizjet-captain-seat" : "bizjet-first-officer-seat",
      0.56,
      0.72,
      0.52,
      interior,
      root,
    );
    seat.position.set(11.72, 0.24, side * 0.52);
    seat.rotation.z = -0.09;
    seat.metadata = { ...seat.metadata, cockpitInterior: true, castsShadow: false };
    const headrest = build.box(
      side > 0 ? "bizjet-captain-headrest" : "bizjet-first-officer-headrest",
      0.24,
      0.3,
      0.4,
      interior,
      root,
    );
    headrest.position.set(11.44, 0.68, side * 0.52);
    headrest.metadata = { ...headrest.metadata, cockpitInterior: true, castsShadow: false };
  }
  addInstrumentPanel(
    build,
    "bizjet",
    root,
    12.55,
    0.62,
    1.3,
    interior,
    instrumentFace,
    instrumentMarking,
  );

  // THE ENGINES. Two on pylons off the REAR FUSELAGE, not under the wing —
  // this is a rear-engined aeroplane and hanging them under a low wing would
  // put a 2.1 m fan 20 cm off the runway. Nacelle centreline y = +0.75,
  // z = +/-2.40, running x -13.4 to -9.4: a 4 m, 2.1 m diameter cowl, which is
  // what a pair of GE Passports making 168 kN between them need to breathe.
  //
  // The pylon is short because the tailcone has already narrowed to about
  // 0.8 m half-width by the engine station. On the real aeroplane it is barely
  // longer than the cowl is thick.
  const fanSpools: TransformNode[] = [];
  for (const side of [1, -1] as const) {
    const sideName = side > 0 ? "starboard" : "port";
    build.loft(
      `${sideName}-bizjet-nacelle`,
      [
        { x: -13.4, yRadius: 0.62, zRadius: 0.62, yOffset: 0.75, zOffset: side * 2.4 },
        { x: -12.6, yRadius: 0.84, zRadius: 0.84, yOffset: 0.75, zOffset: side * 2.4 },
        { x: -11.4, yRadius: 1.02, zRadius: 1.02, yOffset: 0.75, zOffset: side * 2.4 },
        { x: -10.2, yRadius: 1.05, zRadius: 1.05, yOffset: 0.75, zOffset: side * 2.4 },
        { x: -9.4, yRadius: 0.98, zRadius: 0.98, yOffset: 0.75, zOffset: side * 2.4 },
      ],
      24,
      body,
      root,
    );
    const pylon = build.verticalProfile(
      `${sideName}-bizjet-engine-pylon`,
      [
        { x: -9.8, y: 1.15 },
        { x: -12.8, y: 1.15 },
        { x: -12.4, y: 0.42 },
        { x: -10.2, y: 0.42 },
      ],
      1.3,
      body,
      root,
    );
    pylon.position.z = side * 1.75;
    // The inlet lip, dark so the intake reads as a hole rather than as the
    // white cap the loft closes its forward section with.
    const inlet = build.cylinder(
      `${sideName}-bizjet-engine-inlet`, 0.26, 2, 2.04, 20, dark, root);
    inlet.rotation.z = Math.PI / 2;
    inlet.position.set(-9.3, 0.75, side * 2.4);
    const nozzle = build.cylinder(
      `${sideName}-bizjet-exhaust-nozzle`, 0.55, 0.85, 1.05, 18, hotMetal, root);
    nozzle.rotation.z = Math.PI / 2;
    nozzle.position.set(-13.68, 0.75, side * 2.4);

    // The rotating assembly. On a turbofan this is the fan and the spool
    // behind it, the same thing the sport jet exposes as its compressor: the
    // node spins about body X through its OWN origin, which is why each fan
    // gets a node at its own centreline rather than one node at the aircraft
    // centreline — that one would swing both fans around the fuselage.
    const spool = node(`${sideName}-bizjet-fan-spool`, root, scene);
    spool.position.set(-9.34, 0.75, side * 2.4);
    const fanFace = build.cylinder(`${spool.name}-fan`, 0.08, 1.7, 1.86, 16, hub, spool);
    fanFace.rotation.z = Math.PI / 2;
    const spinner = build.cylinder(`${spool.name}-spinner`, 0.42, 0.02, 0.34, 10, dark, spool);
    // Point FORWARD: the negative quarter turn puts the cylinder's zero-radius
    // end at +X. Centred on the fan face so the cone stands through it and its
    // tip stops level with the inlet lip rather than out in the airstream.
    spinner.rotation.z = -Math.PI / 2;
    fanSpools.push(spool);
  }

  // RETRACTABLE TRICYCLE GEAR. Every wheel contact matches `sim/aircraft.ts`
  // exactly: mains at (-1.9, -2.7, +/-2.14), nose at (12.0, -2.7, 0). The node
  // positions here are those points RAISED BY THE TYRE'S OUTER RADIUS, because
  // the sim's y is where the rubber meets the pavement and the node is the
  // axle. Babylon's torus outer radius is diameter/2 + thickness/2, so the
  // 0.86/0.26 main tyre gives 0.56 and 0.56 - 2.70 = -2.14.
  const landingGear = node("bizjet-retractable-landing-gear", root, scene);
  const mainWheels: TransformNode[] = [];
  for (const side of [1, -1] as const) {
    const sideName = side > 0 ? "starboard" : "port";
    build.strutBetween(
      `${sideName}-bizjet-main-strut`,
      new Vector3(-1.55, -1.15, side * 2.05),
      new Vector3(-1.9, -2.14, side * 2.14),
      0.14,
      hub,
      landingGear,
    );
    build.strutBetween(
      `${sideName}-bizjet-main-side-brace`,
      new Vector3(-1.6, -1.3, side * 1.15),
      new Vector3(-1.88, -2, side * 2.1),
      0.09,
      hub,
      landingGear,
    );
    const wheel = node(side > 0 ? "starboard-main-wheel" : "port-main-wheel", landingGear, scene);
    wheel.position.set(-1.9, -2.14, side * 2.14);
    // Two wheels per leg. Forty tonnes on two main tyres would be a tyre
    // pressure no runway accepts, and the twin bogie is plainly visible.
    for (const pair of [1, -1] as const) {
      build.torus(
        `${wheel.name}-tire-${pair > 0 ? "outer" : "inner"}`,
        0.86,
        0.26,
        18,
        tire,
        wheel,
      ).position.z = pair * 0.3;
    }
    const axle = build.cylinder(`${wheel.name}-axle`, 0.74, 0.42, 0.42, 12, hub, wheel);
    axle.rotation.x = Math.PI / 2;
    mainWheels.push(wheel);
  }
  build.strutBetween(
    "bizjet-nose-strut",
    new Vector3(12, -1.3, 0),
    new Vector3(12, -2.28, 0),
    0.11,
    hub,
    landingGear,
  );
  const noseSteer = node("nose-wheel-steering", landingGear, scene);
  noseSteer.position.set(12, -2.28, 0);
  const noseWheel = node("bizjet-nose-wheel", noseSteer, scene);
  build.torus("nose-wheel-tire", 0.64, 0.2, 16, tire, noseWheel);
  const noseHub = build.cylinder("bizjet-nose-wheel-hub", 0.32, 0.3, 0.3, 12, hub, noseWheel);
  noseHub.rotation.x = Math.PI / 2;

  // Gear doors, pushed STARBOARD FIRST so the index-parity hinge sign in
  // `update` is right: the door at +Z needs a positive rotation about body X
  // to drop its outboard edge and the door at -Z needs a negative one.
  const gearDoorRoot = node("bizjet-landing-gear-doors", root, scene);
  const gearDoors: AbstractMesh[] = [];
  for (const side of [1, -1] as const) {
    const door = build.box(
      side > 0 ? "starboard-bizjet-main-gear-door" : "port-bizjet-main-gear-door",
      2.4,
      0.06,
      0.62,
      body,
      gearDoorRoot,
    );
    door.position.set(-1.75, -1.8, side * 1.55);
    gearDoors.push(door);
  }
  const noseDoor = build.box("bizjet-nose-gear-door", 2.1, 0.05, 0.55, body, gearDoorRoot);
  noseDoor.position.set(11.85, -1.22, 0);
  gearDoors.push(noseDoor);

  // LAMPS. The nav and strobe coordinates are transcribed FROM the committed
  // `BIZJET_WASH` table in `lighting/AircraftLighting.ts`, which the wash test
  // compares against these meshes' own positions — a lamp half a metre off its
  // wash is a glow with no source.
  //
  // Port (red) at -Z and starboard (green) at +Z, because starboard is +Z.
  // Reversing these is the one lighting error an observer can read directly:
  // it inverts which way the aeroplane appears to be heading.
  // Moved aft with the wash table to where the winglet actually is: a 31.7 m
  // span at 35 degrees of leading-edge sweep puts the tip 11.1 m behind the
  // root, and the first draft of both this placement and the table guessed
  // x = -1, which floated the lamps 4.5 m ahead of the metal.
  const portLight = build.sphere("port-navigation-light", 0.2, 8, redLamp, root);
  portLight.position.set(-6.1, 0.35, -15.6);
  portLight.metadata = { ...portLight.metadata, castsShadow: false };
  const starboardLight = build.sphere("starboard-navigation-light", 0.2, 8, greenLamp, root);
  starboardLight.position.set(-6.1, 0.35, 15.6);
  starboardLight.metadata = { ...starboardLight.metadata, castsShadow: false };
  for (const side of [1, -1] as const) {
    const strobe = build.sphere(
      side > 0 ? "starboard-strobe-light" : "port-strobe-light", 0.14, 8, strobeLamp, root);
    strobe.position.set(-6.2, 0.4, side * 15.7);
    strobe.metadata = { ...strobe.metadata, castsShadow: false };
  }
  const beaconLight = build.sphere("anticollision-beacon", 0.18, 8, beaconLamp, root);
  beaconLight.position.set(0, -1.75, 0);
  beaconLight.metadata = { ...beaconLight.metadata, castsShadow: false };
  const tailLight = build.sphere("tail-navigation-light", 0.16, 8, tailLamp, root);
  tailLight.position.set(-18.3, 0.62, 0);
  tailLight.metadata = { ...tailLight.metadata, castsShadow: false };
  // Landing lights in the wing roots, which is where this type carries them —
  // not on the gear leg like the two small aeroplanes.
  for (const side of [1, -1] as const) {
    const lamp = build.cylinder(
      side > 0 ? "starboard-landing-light" : "port-landing-light",
      0.03, 0.34, 0.34, 10, landingLamp, root);
    lamp.rotation.z = Math.PI / 2;
    lamp.position.set(3.75, -0.95, side * 1.95);
    lamp.metadata = { ...lamp.metadata, castsShadow: false };
  }

  const rig: BizJetRig = {
    root,
    // The contract carries ONE rotating assembly and a twin has two. The
    // starboard spool is the one it names; both are driven from the same
    // simulation-time phase below, so they can never be seen out of step.
    propeller: fanSpools[0]!,
    // Only opaque skin that would block the pilot's view. The flight deck
    // glass stays on ordinary world layers — a windscreen the pilot cannot see
    // through is worse than no windscreen.
    cockpitParts: [fuselage, radome, windscreenFrame],
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
    kind: "bizjet",
    handedness: "right",
    group: root,
    root,
    propeller: rig.propeller,
    cockpitParts: rig.cockpitParts,
    meshes: build.meshes,
    update(state, deltaSeconds) {
      if (disposed) return;
      const delta = safeAircraftAnimationDelta(deltaSeconds);
      const pose = resolveAircraftAnimationPose("bizjet", state);
      // Phase-anchored to simulation time rather than accumulated per frame,
      // so an identically-timed frame is identical across capture runs.
      const spin = pose.rotorRadiansPerSecond * state.simulationTime;
      for (const spool of fanSpools) spool.rotation.x = spin;
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
      applyLamp(redLamp, lights.portNav);
      applyLamp(greenLamp, lights.starboardNav);
      applyLamp(tailLamp, lights.tailNav);
      applyLamp(beaconLamp, lights.beacon);
      applyLamp(strobeLamp, lights.strobe);
      applyLamp(landingLamp, lights.landing);
      applyGlow(instrumentMarking, lights.cockpitGlow);
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
