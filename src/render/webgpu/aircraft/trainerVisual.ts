import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import type { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh";
import type { PBRMaterial } from "@babylonjs/core/Materials/PBR/pbrMaterial";
import type { Scene } from "@babylonjs/core/scene";
import {
  resolveAircraftAnimationPose,
  resolvePropellerPresentation,
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

interface TrainerPropellerRig {
  readonly bladeMaterial: PBRMaterial;
  readonly discMaterial: PBRMaterial;
  readonly blades: readonly AbstractMesh[];
  readonly disc: AbstractMesh;
}

/**
 * The Cessna 150, to `LIGHT_TRAINER`'s dimensions.
 *
 * Span 10.17 m (tips at +/-5.085), length 7.34 m from the spinner at x = +4.02
 * to the rudder trailing edge at x = -3.32, constant-chord wing of 1.44 m for
 * 14.6 m^2. Everything that touches the ground is taken straight out of
 * `src/sim/aircraft.ts`: the mains put their contact patch at y = -1.22 and
 * the nosewheel at y = -1.06, so those two numbers, not the mesh, decide where
 * the wheel centres go.
 *
 * ONE PROPORTION IS NOT THE REAL AEROPLANE'S, and it is worth knowing which.
 * The simulator pins the wing chord plane at y = 0.28 (the wingtip contact
 * points live there, and a wingtip strike has to fire at the height the wing
 * actually is). On the real 150 the wing sits about 1.85 m above the ground;
 * here y = 0.28 is 1.50 m above it. The whole cabin therefore had to be built
 * 0.35 m shallower than scale so that it still passes UNDER the wing, which is
 * what makes a high-wing aeroplane read as one. The consequences are recorded
 * where they bite: the cabin greenhouse below, and the propeller's ground
 * clearance at the spinner.
 */
export function createTrainer(scene: Scene): AircraftVisual {
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
  /*
   * THE CABIN GLAZING KEEPS ITS DEPTH PRE-PASS, deliberately, and this is the
   * one airframe where the F-16's canopy fix does NOT transfer.
   *
   * Removing it does fix the exterior: at cinematic distance the cabin goes
   * from a bare shell with the interior showing through to properly glazed,
   * and that pair was captured. But it destroys the view from the cockpit —
   * the forward view drops from mountains and horizon in full daylight to a
   * near-black blue wash. A 150's cabin is a box of flat panes with the pilot
   * INSIDE it, so without the pre-pass its own surfaces sort against each
   * other from within and the far side draws over the world. The F-16 escapes
   * that because its bubble is a single convex shell around one seat.
   *
   * Two things were tried and neither worked: dropping the cockpit alpha to
   * 0.08, which did nothing because the fault is sorting rather than opacity;
   * and toggling `needDepthPrePass` in `setCockpitView`, which Babylon does
   * not honour at runtime — the pipeline decision is already baked.
   *
   * So the trade is a cosmetic loss outside against a functional loss inside,
   * and the cockpit wins. The exterior glazing loss is recorded in the
   * findings entry as a known defect with the fix that would work — excluding
   * the glass from the cockpit camera's layer — rather than fixed badly here.
   */
  /*
   * THE PRE-PASS FOLLOWS THE VIEW, and this is not the same fix as the F-16's.
   *
   * Turning it off unconditionally made the cabin visible from outside and
   * destroyed the view from inside: the forward view went from mountains and
   * horizon in full daylight to a near-black blue wash. Lowering the alpha did
   * not help, because the fault is not opacity — without the pre-pass the
   * wraparound cabin's own surfaces sort against each other from within, and
   * the far side of the canopy draws over the world.
   *
   * The F-16 escapes this with an alpha switch because its bubble is a single
   * convex shell around one seat. A 150's cabin is a box of flat panes with
   * the pilot inside it, so it needs the pre-pass while he is in there.
   *
   * Caught only because the cockpit frame was captured and opened. The
   * exterior fix looked complete and would have shipped a blind aeroplane.
   */
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
  // `7-8`: the tail, beacon and strobe lamps did not exist. The item's premise
  // ("the lamps already exist as emissive geometry") was stale for four of six
  // — and the white TAIL light is the one the 110/110/140 split-angle
  // partition depends on, so the pin could not be met without building it.
  const applyLamp = createLampApplier();
  const applyGlow = createGlowApplier();
  const tailLamp = build.material("trainer-tail-lamp", 0xfff6e8, {
    emissive: 0xfff2d8, emissiveIntensity: 2,
  });
  const beaconLamp = build.material("trainer-beacon-lamp", 0xff5a4a, {
    emissive: 0xff1c10, emissiveIntensity: 2.6,
  });
  const strobeLamp = build.material("trainer-strobe-lamp", 0xffffff, {
    emissive: 0xf2f8ff, emissiveIntensity: 3.2,
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

  // The whole shell in one loft, cowling included — the 150 has no visible
  // joint there, and a separate nose body was costing a draw to produce a seam
  // the real aeroplane does not have.
  //
  // `squareness` carries the type. A Continental O-200 lies on its side, so
  // the cowl is WIDER THAN IT IS DEEP and nearly rectangular in section
  // (zRadius > yRadius at x = 3.70, squareness 2.6); the cabin is a flat-sided
  // box with a flat deck (squareness 6, which is what lets the glass below sit
  // on it without mushrooming out over a rounded crown); the tailcone is a
  // plain ellipse.
  //
  // The cabin sections stop at y = 0.00. That is the WINDOW SILL, not the
  // roof: everything above it is the greenhouse, built separately in glass so
  // the wrap-around rear window is real geometry rather than a painted band.
  const fuselage = build.loft(
    "trainer-fuselage",
    [
      { x: -3.2, yRadius: 0.085, zRadius: 0.065, yOffset: 0.175 },
      { x: -1.9, yRadius: 0.215, zRadius: 0.185, yOffset: 0.03, squareness: 2.2 },
      { x: -0.7, yRadius: 0.44, zRadius: 0.33, yOffset: -0.23, squareness: 3.2 },
      { x: 0.3, yRadius: 0.39, zRadius: 0.505, yOffset: -0.39, squareness: 6 },
      { x: 1.6, yRadius: 0.39, zRadius: 0.505, yOffset: -0.39, squareness: 6 },
      { x: 2.42, yRadius: 0.28, zRadius: 0.45, yOffset: -0.34, squareness: 4.5 },
      { x: 3.7, yRadius: 0.17, zRadius: 0.29, yOffset: -0.17, squareness: 2.6 },
    ],
    24,
    body,
    root,
  );
  // Thrust line at y = -0.17, which is the middle of the nose bowl. With a
  // 1.62 m propeller the tip passes 0.24 m above the ground at rest; the real
  // 150 swings 1.75 m with 0.28 m of clearance, and the 0.13 m that had to
  // come off the diameter is the price of the squashed cabin above.
  const spinner = build.cylinder("trainer-spinner", 0.26, 0, 0.24, 12, dark, root);
  spinner.rotation.z = -Math.PI / 2;
  spinner.position.set(3.87, -0.17, 0);

  // The 150's greenhouse, and the reason it is a loft rather than a dome: the
  // "omni-vision" rear window introduced on the 150D wraps around the back of
  // the cabin, so the glass has to be a closed body that tapers into the rear
  // decking, not a canopy sitting on top. One mesh gives the windscreen (the
  // forward sections, which emerge where the shell's deck has dropped away),
  // the door windows (the sides, standing about 0.03 m proud of the sill) and
  // that rear window (the aft sections, which stand proud of a shell that has
  // already begun climbing towards the tailcone).
  const canopy = build.loft(
    "trainer-canopy",
    [
      { x: -0.7, yRadius: 0.12, zRadius: 0.205, yOffset: 0.055, squareness: 2.6 },
      { x: -0.3, yRadius: 0.2, zRadius: 0.415, yOffset: 0.01, squareness: 3.2 },
      { x: 0.26, yRadius: 0.22, zRadius: 0.44, squareness: 4 },
      { x: 1.6, yRadius: 0.22, zRadius: 0.44, squareness: 4 },
      { x: 2, yRadius: 0.2, zRadius: 0.415, yOffset: -0.01, squareness: 3.6 },
      { x: 2.24, yRadius: 0.105, zRadius: 0.345, yOffset: -0.06, squareness: 3 },
    ],
    18,
    glass,
    root,
  );
  canopy.metadata = { ...canopy.metadata, castsShadow: false };
  // The opaque roof skin between the windscreen and the rear window — the one
  // part of the greenhouse that is aluminium. It covers only the span over
  // which the glass crown is flat (x 0.24..1.62); forward and aft of that the
  // glass is meant to show, because that is where the windscreen and the rear
  // window are.
  const cabinRoof = build.planform(
    "trainer-cabin-roof",
    [
      { x: 1.62, z: 0.15 },
      { x: 1.44, z: 0.31 },
      { x: 0.42, z: 0.31 },
      { x: 0.24, z: 0.15 },
      { x: 0.24, z: -0.15 },
      { x: 0.42, z: -0.31 },
      { x: 1.44, z: -0.31 },
      { x: 1.62, z: -0.15 },
    ],
    0.05,
    body,
    root,
  );
  cabinRoof.position.y = 0.205;
  // Goes on the cockpit-excluded layer with the skin. It is 24 mm of metal,
  // but it sits on the centreline half a metre from the pilot's eye, so from
  // inside it is a black bar down the middle of the windscreen — which is
  // exactly what the cockpit layer mask exists to prevent. The jet's canopy
  // frame has always been handled this way.
  const windscreenFrame = build.strutBetween(
    "windscreen-center-frame",
    new Vector3(2.26, -0.02, 0),
    new Vector3(2, 0.21, 0),
    0.024,
    dark,
    root,
  );

  // The wing. Constant chord 1.44 m over the whole 10.17 m span, no taper and
  // no dihedral: the 150's planform is a rectangle, and the chord plane is
  // held flat at y = 0.28 because `LIGHT_TRAINER`'s wingtip contact points are
  // pinned to that height.
  //
  // The fixed structure only reaches x = -0.44. The last 0.38 m of chord is
  // the flap and aileron, which hinge at x = -0.46 and are built separately,
  // so the control gaps are real holes rather than paint.
  //
  // Both halves start at rootZ = 0 so they meet over the cabin as the real
  // one-piece wing does; the coincident root caps face into each other and are
  // never seen. Camber is held at 1.2% rather than the 2412's 2% only because
  // a 1.06 m chord makes the absolute section too shallow otherwise.
  const wingSurfaces: AbstractMesh[] = [];
  const flapHinges: TransformNode[] = [];
  for (const side of [-1, 1] as const) {
    const sideName = side < 0 ? "port" : "starboard";
    const forwardWing = build.airfoilWing(
      `${sideName}-main-wing-forward`,
      {
        rootLeadingX: 0.62,
        rootTrailingX: -0.44,
        tipLeadingX: 0.62,
        tipTrailingX: -0.44,
        rootZ: 0,
        tipZ: side * 5.085,
        thicknessRatio: 0.12,
        camberRatio: 0.012,
        chordSegments: 14,
        spanSegments: 3,
      },
      body,
      root,
    );
    forwardWing.position.y = 0.28;

    // The flaps ARTICULATE, which is the whole point of the type on approach:
    // 40 degrees of barn door, driven from `animation.ts`. The hinge node sits
    // on the hinge LINE — the panel's leading edge, at the wing chord plane —
    // and the panel is expressed relative to it, extending aft in -X. A
    // positive rotation about +Z therefore carries the trailing edge DOWN and
    // the panel swings about the hinge instead of scything through the wing.
    //
    // The hinge line is parallel to +Z (constant-chord wing), so siting the
    // node at the inboard end of it is enough; the outboard end rides the same
    // axis. Inboard end at the fuselage side, outboard end at z = +/-2.60,
    // which leaves the outer third of the semi-span to the aileron.
    const flapHinge = node(`${sideName}-flap-hinge`, root, scene);
    flapHinge.position.set(-0.46, 0.28, side * 0.48);
    const flap = build.airfoilWing(
      `${sideName}-wing-flap`,
      {
        rootLeadingX: 0,
        rootTrailingX: -0.36,
        tipLeadingX: 0,
        tipTrailingX: -0.36,
        rootZ: 0,
        tipZ: side * 2.12,
        thicknessRatio: 0.1,
        camberRatio: 0.02,
        chordSegments: 8,
        spanSegments: 2,
      },
      accent,
      flapHinge,
    );
    flapHinges.push(flapHinge);
    wingSurfaces.push(forwardWing, flap);
  }

  // D-6: starboard is body +Z. These two were built on each other's wings, so
  // `applyCommonPose` drove the port surface with the starboard deflection and
  // the aeroplane showed a left-roll aileron when the pilot rolled right. The
  // geometry is a mirror pair, so swapping the sides changes nothing at
  // neutral — only which surface answers which command.
  const starboardAileron = node("starboard-aileron", root, scene);
  starboardAileron.position.set(-0.46, 0.28, 2.78);
  const starboardAileronSurface = build.airfoilWing(
    "starboard-aileron-surface",
    {
      rootLeadingX: 0,
      rootTrailingX: -0.36,
      tipLeadingX: 0,
      tipTrailingX: -0.3,
      rootZ: 0,
      tipZ: 2.18,
      thicknessRatio: 0.085,
      camberRatio: 0.012,
      chordSegments: 8,
      spanSegments: 2,
    },
    accent,
    starboardAileron,
  );
  const portAileron = node("port-aileron", root, scene);
  portAileron.position.set(-0.46, 0.28, -2.78);
  const portAileronSurface = build.airfoilWing(
    "port-aileron-surface",
    {
      rootLeadingX: 0,
      rootTrailingX: -0.36,
      tipLeadingX: 0,
      tipTrailingX: -0.3,
      rootZ: 0,
      tipZ: -2.18,
      thicknessRatio: 0.085,
      camberRatio: 0.012,
      chordSegments: 8,
      spanSegments: 2,
    },
    accent,
    portAileron,
  );
  wingSurfaces.push(starboardAileronSurface, portAileronSurface);

  // The lift struts, which are the first thing anyone uses to name a Cessna at
  // a distance. A single streamlined tube each side, from the lower longeron
  // just below the door out to the front spar at z = +/-2.60 — 51% of the
  // semi-span, where the real one picks the wing up. 2.36 m long, which is the
  // type's figure; painted with the airframe rather than left bare.
  for (const side of [-1, 1] as const) {
    build.strutBetween(
      side < 0 ? "port-lift-strut" : "starboard-lift-strut",
      new Vector3(0.95, -0.62, side * 0.49),
      new Vector3(0.3, 0.22, side * 2.6),
      0.045,
      body,
      root,
    );
  }

  // Tailplane: 3.43 m span, mounted on top of the tailcone with a little
  // leading-edge sweep and a straight hinge line at x = -2.92.
  for (const side of [-1, 1] as const) {
    const tail = build.airfoilWing(
      side < 0 ? "port-trainer-tailplane" : "starboard-trainer-tailplane",
      {
        rootLeadingX: -2.24,
        rootTrailingX: -2.92,
        tipLeadingX: -2.46,
        tipTrailingX: -2.92,
        rootZ: side * 0.1,
        tipZ: side * 1.715,
        thicknessRatio: 0.09,
        camberRatio: 0.004,
        chordSegments: 10,
        spanSegments: 2,
      },
      body,
      root,
    );
    tail.position.y = 0.2;
    wingSurfaces.push(tail);
  }
  // The swept fin of the 1966-and-later 150. The straight-fin early cars look
  // like a different aeroplane, so the shape here is deliberate: one straight
  // leading edge raked back about 38 degrees running all the way down into a
  // long dorsal that buries itself in the tailcone around x = -1.6, and a
  // near-vertical hinge line. Tip at y = 1.36, which is 2.58 m above the
  // wheels — the type's published height to a centimetre.
  //
  // Wound clockwise in X/Y on purpose: `verticalProfile` does not reverse its
  // triangles, and Babylon's right-handed normal is the inverse of the
  // mathematical one, so a counter-clockwise outline builds the fin inside out.
  const fin = build.verticalProfile(
    "trainer-vertical-stabilizer",
    [
      { x: 0, y: 0 },
      { x: 0.06, y: 1.22 },
      { x: 0.48, y: 1.08 },
      { x: 1.42, y: 0 },
    ],
    0.09,
    accent,
    root,
  );
  fin.position.set(-2.92, 0.14, 0);
  const elevator = node("elevator", root, scene);
  elevator.position.set(-2.94, 0.2, 0);
  for (const side of [-1, 1] as const) {
    wingSurfaces.push(build.airfoilWing(
      side < 0 ? "port-elevator-surface" : "starboard-elevator-surface",
      {
        rootLeadingX: 0,
        rootTrailingX: -0.38,
        tipLeadingX: 0,
        tipTrailingX: -0.3,
        rootZ: side * 0.14,
        tipZ: side * 1.7,
        thicknessRatio: 0.075,
        chordSegments: 7,
      },
      accent,
      elevator,
    ));
  }
  const rudder = node("rudder", root, scene);
  rudder.position.set(-2.9, 0.72, 0);
  const rudderSurface = build.box("rudder-surface", 0.46, 1.16, 0.07, accent, rudder);
  rudderSurface.position.set(-0.23, 0, 0);

  // Two seats, side by side. There is no second row on a 150 and there never
  // was one here either — the "two rows" this file was said to build were the
  // port and starboard seats of the single row.
  for (const side of [-1, 1]) {
    const seat = build.box(
      side < 0 ? "port-seat" : "starboard-seat",
      0.4,
      0.46,
      0.4,
      interior,
      root,
    );
    seat.position.set(1.28, -0.42, side * 0.26);
    seat.rotation.z = -0.08;
    const headrest = build.box(
      side < 0 ? "port-headrest" : "starboard-headrest",
      0.18,
      0.24,
      0.34,
      interior,
      root,
    );
    headrest.position.set(1.02, -0.08, side * 0.26);
  }
  // Panel top level with the sill, so the glareshield line and the bottom of
  // the windscreen are the same line, as they are in the aeroplane.
  addInstrumentPanel(
    build,
    "trainer",
    root,
    2.1,
    -0.26,
    0.86,
    interior,
    instrumentFace,
    instrumentMarking,
  );

  // Cowl fittings. The band sits on the cowl/firewall seam and is squashed in
  // Y to follow a section that is 0.43 m wide and 0.27 m deep — a round ring
  // would stand off the flats by half its own width.
  const cowlingBand = build.cylinder("engine-cowling-band", 0.07, 0.87, 0.87, 14, panel, root);
  cowlingBand.rotation.z = Math.PI / 2;
  cowlingBand.scaling.x = 0.62;
  cowlingBand.position.set(2.56, -0.32, 0);
  for (const side of [-1, 1]) {
    // The O-200's exhaust leaves through the BOTTOM of the cowl, a short stack
    // each side just aft of the nose bowl. On the real aeroplane they are the
    // only thing that breaks the cowl's underside line.
    const exhaust = build.cylinder(
      side < 0 ? "port-exhaust" : "starboard-exhaust",
      0.4,
      0.09,
      0.11,
      8,
      dark,
      root,
    );
    exhaust.rotation.z = Math.PI / 2;
    exhaust.position.set(2.3, -0.66, side * 0.2);
    const fairing = build.sphere(
      side < 0 ? "port-wingtip-fairing" : "starboard-wingtip-fairing",
      0.24,
      8,
      accent,
      root,
    );
    fairing.scaling.set(5.2, 0.62, 0.9);
    fairing.position.set(0.06, 0.28, side * 5.04);
  }
  // Pitot under the PORT wing at 40% semi-span, where the 150 carries it, and
  // far enough forward of the leading edge to be in clean air.
  const pitot = build.cylinder("pitot-tube", 0.36, 0.022, 0.03, 6, panel, root);
  pitot.rotation.z = -Math.PI / 2;
  pitot.position.set(0.74, 0.15, -2.05);

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
  propeller.position.set(3.78, -0.17, 0);
  const propHub = build.cylinder("trainer-propeller-hub", 0.2, 0.15, 0.15, 10, dark, propeller);
  propHub.rotation.z = Math.PI / 2;
  // Two blades, fixed pitch, 1.62 m across: see the spinner note on why this
  // is short of the real 1.75 m.
  const bladeA = build.box(
    "trainer-propeller-blade-a",
    0.05,
    1.62,
    0.16,
    propellerBladeMaterial,
    propeller,
  );
  const bladeB = build.box(
    "trainer-propeller-blade-b",
    0.05,
    1.62,
    0.16,
    propellerBladeMaterial,
    propeller,
  );
  bladeB.rotation.x = Math.PI / 2;
  const propellerDisc = build.radialBlurDisc(
    "trainer-propeller-disc",
    0.81,
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

  // Fixed tricycle gear, sited from the physics rather than from the drawing.
  // `LIGHT_TRAINER` puts the main contact patches at y = -1.22 and the nose
  // patch at y = -1.06; with a 0.27 m main tyre and a 0.21 m nose tyre that
  // fixes the axles at y = -0.95 and y = -0.85 and leaves nothing to choose.
  //
  // The 150 has no drag brace — each main leg is one piece of sprung steel
  // that leaves the belly steeply and flattens out towards the wheel. The two
  // segments below are that bend; the names are the ones other modules look
  // the legs up by.
  const mainWheels: TransformNode[] = [];
  for (const side of [-1, 1]) {
    build.strutBetween(
      side < 0 ? "port-main-strut" : "starboard-main-strut",
      new Vector3(-0.26, -0.7, side * 0.24),
      new Vector3(-0.26, -0.9, side * 0.8),
      0.05,
      dark,
      root,
    );
    build.strutBetween(
      side < 0 ? "port-main-brace" : "starboard-main-brace",
      new Vector3(-0.26, -0.9, side * 0.8),
      new Vector3(-0.26, -0.955, side * 1.2),
      0.042,
      hub,
      root,
    );
    const wheel = node(side < 0 ? "port-main-wheel" : "starboard-main-wheel", root, scene);
    wheel.position.set(-0.26, -0.95, side * 1.2);
    build.torus(`${wheel.name}-tire`, 0.4, 0.14, 20, tire, wheel);
    const wheelHub = build.cylinder(`${wheel.name}-hub`, 0.17, 0.2, 0.2, 14, hub, wheel);
    wheelHub.rotation.x = Math.PI / 2;
    mainWheels.push(wheel);
  }
  build.strutBetween(
    "trainer-nose-strut",
    new Vector3(2.42, -0.44, 0),
    new Vector3(2.36, -0.84, 0),
    0.045,
    dark,
    root,
  );
  const noseSteer = node("nose-wheel-steering", root, scene);
  noseSteer.position.set(2.36, -0.85, 0);
  const noseWheel = node("nose-wheel", noseSteer, scene);
  build.torus("nose-wheel-tire", 0.3, 0.12, 18, tire, noseWheel);
  const noseHub = build.cylinder("nose-wheel-hub", 0.15, 0.15, 0.15, 12, hub, noseWheel);
  noseHub.rotation.x = Math.PI / 2;

  // `D-6`: PORT (red) sits at -Z and STARBOARD (green) at +Z, because
  // **starboard is body +Z**. Derived from the scene's own basis:
  // `FlightRenderer` maps body +X -> forward and +Y -> up into a
  // right-handed scene, and a camera looking along +X with up +Y reports
  // screen-right as +Z. Screen-right for a forward-looking camera IS the
  // pilot's right.
  //
  // These two lines were reversed, so every night flight showed red on the
  // right wing and green on the left -- the exact inversion an observer uses
  // to infer which way an aircraft is heading.
  //
  // The full body-axis contract was settled to match on 2026-09-01: the sim's
  // internal basis, `bodyAxes` above, and this placement now all agree that
  // +Z is starboard, and the keyboard roll inversion that compensated for the
  // old mismatch is deleted. `tests/sim.body-axis-contract.test.ts` pins the
  // chain in world space without consulting any of these declarations.
  //
  // They moved inboard with the span: the wing is 10.17 m now, not 10.86, so
  // the lamps sit at z = +/-5.05 on the leading-edge corner of the tip fairing
  // where the real ones are. `lighting/AircraftLighting.ts`'s TRAINER_WASH
  // transcribes these three coordinates and has to follow.
  const portLight = build.sphere("port-navigation-light", 0.15, 8, redLamp, root);
  portLight.position.set(0.55, 0.3, -5.05);
  portLight.metadata = { ...portLight.metadata, castsShadow: false };
  const starboardLight = build.sphere("starboard-navigation-light", 0.15, 8, greenLamp, root);
  starboardLight.position.set(0.55, 0.3, 5.05);
  starboardLight.metadata = { ...starboardLight.metadata, castsShadow: false };
  // In the nose bowl, low and to port, which is where a 150 carries it — not
  // out on the wing.
  const landingLight = build.cylinder("landing-light", 0.03, 0.2, 0.2, 10, landingLamp, root);
  landingLight.rotation.z = Math.PI / 2;
  landingLight.position.set(3.72, -0.22, -0.13);
  landingLight.metadata = { ...landingLight.metadata, castsShadow: false };

  // Built with `build.sphere`, i.e. Babylon's own `CreateSphere` — their
  // winding IS the convention the prototype winding guard reads its reference
  // FROM, so adding guard cases would compare a Babylon primitive against
  // itself. The 7D rule is aimed at hand-authored geometry; the tower's seven
  // parts are that, and these deliberately are not.
  const tailLight = build.sphere("tail-navigation-light", 0.12, 8, tailLamp, root);
  tailLight.position.set(-3.25, 0.06, 0);
  tailLight.metadata = { ...tailLight.metadata, castsShadow: false };
  // On the fin tip, which is where the 150's rotating beacon lives. It used to
  // float above the cabin roof, which was a fair place on the old four-seater
  // and is 1.1 m of open air on this one.
  const beaconLight = build.sphere("anticollision-beacon", 0.13, 8, beaconLamp, root);
  beaconLight.position.set(-2.8, 1.39, 0);
  beaconLight.metadata = { ...beaconLight.metadata, castsShadow: false };
  // Wingtip strobes, outboard of the nav lights rather than co-located: they
  // flash on a different timer and overlapping them would read as one lamp
  // changing colour.
  for (const side of [-1, 1]) {
    const strobe = build.sphere(
      side < 0 ? "port-strobe-light" : "starboard-strobe-light", 0.11, 8, strobeLamp, root);
    strobe.position.set(-0.34, 0.3, side * 5.16);
    strobe.metadata = { ...strobe.metadata, castsShadow: false };
  }

  const rig: CommonRig = {
    root,
    propeller,
    // Only opaque exterior skin belongs on the cockpit-excluded layer. The
    // clearcoat/transmission canopy stays on ordinary world layers so the
    // windscreen remains visible from the pilot's camera. The cabin roof is
    // opaque and directly overhead, so it joins the shell.
    cockpitParts: [fuselage, cabinRoof, windscreenFrame],
    wingSurfaces,
    ailerons: [starboardAileron, portAileron],
    elevators: [elevator],
    rudder,
    noseSteer,
    flaps: flapHinges,
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
