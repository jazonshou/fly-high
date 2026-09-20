// `thinInstanceSetBuffer`/`thinInstanceCount` are prototype extensions Babylon
// only installs with this side-effect import, exactly as the Global's cabin
// window line takes it. This airframe uses it twice, for the two pieces of
// genuinely repeated geometry it has: the fourteen convergent nozzle petals and
// the turbine blades behind them. Fourteen separate meshes for a ring of
// identical plates is not affordable and is not necessary.
import "@babylonjs/core/Meshes/thinInstanceMesh";
import { Matrix, Vector3 } from "@babylonjs/core/Maths/math.vector";
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
import { aircraftDefinition } from "@/src/sim";
import type { AircraftVisual } from "./types";

/**
 * The retractable parts, on the same contract the other three airframes use.
 *
 * The F-16's airbrake is four petals around the nozzle rather than the Global's
 * wing spoilers or a single fuselage plate, but "how far is the brake out" is
 * still one number, so it is still `pose.speedBrake`. The petals differ from
 * every other airframe's brake in one way: the upper pair and the lower pair
 * open in OPPOSITE senses about body Z, so the rig here keeps its own signed
 * list and hands `CommonRig` the bare nodes.
 */
interface JetRig extends CommonRig {
  readonly landingGear: TransformNode;
  readonly gearDoors: readonly AbstractMesh[];
  readonly speedBrakes: readonly TransformNode[];
}

/**
 * The wing, written once because eight parts are cut from it.
 *
 * The real aeroplane: 9.45 m of wing span (9.96 m measured over the wingtip
 * launcher rails, which is the figure `sim/aircraft.ts` carries and the figure
 * every published three-view quotes), 40 degrees of leading-edge sweep, a
 * 5.03 m centreline chord tapering to 1.14 m. Those two chords are not picked
 * for looks: they are the published root and tip chords, and they reproduce the
 * published 3.45 m mean aerodynamic chord to within 1.3% (this planform's MAC
 * is 3.49 m). The trailing edge then falls out of the arithmetic rather than
 * being chosen — 3.96 m of leading-edge sweepback minus 3.89 m of chord lost
 * leaves 0.07 m, so the trailing edge is swept less than one degree. That
 * near-perpendicular trailing edge under a 40-degree leading edge IS the
 * cropped delta, and drawing it swept would have made this a different wing.
 *
 * NOTE ON AREA. The geometric trapezoid here is 29.1 m^2 and the definition's
 * `wingArea` is 27.87 m^2 (the published 300 ft^2). The gap is real and is in
 * the source data: 300 ft^2 is a reference area, not the area you get by
 * multiplying the published chords by the published span. The chords are kept
 * because they are what makes the aeroplane look like an F-16 and what
 * reproduces its MAC; the sim keeps 27.87 because that is what its
 * coefficients were measured against. Changing either to agree with the other
 * would break the thing it was chosen for.
 *
 * WHERE THE WING SITS is the one number here that is derived rather than
 * transcribed. Putting the centreline leading edge at x = +2.79 places the CG —
 * body x = 0, which is what the whole simulation definition is written about —
 * at 35% of the mean aerodynamic chord (the MAC runs from x +1.23 at its
 * z = 1.86 station, and 0 is 1.23 m aft of that on a 3.49 m chord). That is
 * this aeroplane's real balance:
 * the F-16 is deliberately unstable, flown with the CG aft of a neutral point
 * that sits near 29% MAC, which is why it needs a flight control system to fly
 * at all and why `stabilityAugmentation` exists. A wing placed to put
 * quarter-MAC on the CG, which is what a conventional aeroplane wants, would
 * have sat 0.3 m further aft and quietly made this a stable airframe.
 */
const WING_TIP_Z = 4.72;
/** Where the panel starts. Inside the body: this wing is blended, not bolted on. */
const WING_ROOT_Z = 0.3;
/** Where the flaperons start — the fuselage side at the trailing edge. */
const FLAPERON_ROOT_Z = 1;
const WING_CHORD_PLANE_Y = -0.1;
const WING_ROOT_LEADING_X = 2.79;
const WING_ROOT_TRAILING_X = -2.24;
const WING_TIP_LEADING_X = -1.17;
const WING_TIP_TRAILING_X = -2.31;
/**
 * Hinge line at 78% of local chord — one fraction for the whole span, so the
 * inboard and outboard flaperon panels sit on a single unbroken line and the
 * fixed wing outboard of the root can be one panel instead of three.
 */
const WING_ROOT_HINGE_X = -1.13;
const WING_TIP_HINGE_X = -2.06;

/** 0 at the centreline, 1 at the tip. */
function spanFraction(z: number): number {
  return Math.abs(z) / WING_TIP_Z;
}

function mix(rootValue: number, tipValue: number, fraction: number): number {
  return rootValue + (tipValue - rootValue) * fraction;
}

function leadingEdgeAt(z: number): number {
  return mix(WING_ROOT_LEADING_X, WING_TIP_LEADING_X, spanFraction(z));
}

function trailingEdgeAt(z: number): number {
  return mix(WING_ROOT_TRAILING_X, WING_TIP_TRAILING_X, spanFraction(z));
}

function hingeLineAt(z: number): number {
  return mix(WING_ROOT_HINGE_X, WING_TIP_HINGE_X, spanFraction(z));
}

/**
 * The all-moving stabilator.
 *
 * The whole surface pivots — there is no fixed tailplane with an elevator
 * hinged to it, and building one would be the single most visible way to get
 * this aeroplane's tail wrong. The pivot is at 35% of the root chord, which is
 * where an all-moving surface's actuator goes: far enough aft that the
 * aerodynamic centre is close to the hinge and the actuator is not fighting the
 * whole pitching moment, far enough forward that it never goes over-centre.
 */
const STABILATOR_ROOT_LEADING_X = -2.9;
const STABILATOR_ROOT_TRAILING_X = -5.85;
const STABILATOR_TIP_LEADING_X = -4.86;
const STABILATOR_TIP_TRAILING_X = -5.86;
const STABILATOR_ROOT_Z = 0.45;
const STABILATOR_TIP_Z = 2.79;
const STABILATOR_PIVOT_X = -3.93;
/** Below the wing plane, as this aeroplane's tail plainly is from any angle. */
const STABILATOR_Y = -0.25;

/**
 * THE NOZZLE. The exit plane is x = -7.50 because that is where
 * `sim/aircraft.ts` puts its tailcone contact point, and that contact point is
 * what sets the aeroplane's tail-strike angle on rotation.
 *
 * Fourteen external flaps converging from 1.00 m to 0.76 m across. They are
 * fourteen SEPARATE plates rather than a faceted cone: on a real variable
 * nozzle you can see the seams between the flaps and the way they overlap as
 * they close, and a cone — however low its tessellation — reads as a smooth
 * bell. One plate, thin-instanced fourteen times, is one draw call either way.
 */
const NOZZLE_EXIT_X = -7.5;
const NOZZLE_PETAL_COUNT = 14;
const NOZZLE_PETAL_LENGTH = 0.95;
const NOZZLE_FRONT_RADIUS = 0.5;
const NOZZLE_EXIT_RADIUS = 0.38;
const NOZZLE_PETAL_THICKNESS = 0.04;

/** Eight turbine blades, seen dimly down the duct. */
const TURBINE_BLADE_COUNT = 8;

/**
 * How lit the reheat is, from the pilot's throttle.
 *
 * Zero below the gate and one at the stop, matching
 * `calculateEngineThrust`'s reheat ramp EXACTLY — that function divides the
 * throttle remaining above `engageThrottle` by the travel remaining, and so
 * does this. The gate itself is read off the flight model rather than written
 * down a second time here, for the reason `tests/ui.reheat-zone.test.ts` gives
 * about the HUD: a burner that lights somewhere other than where the thrust
 * arrives teaches the pilot a gate that does not exist.
 *
 * This is not in `AircraftAnimationPose` because the pose carries no throttle
 * and `animation.ts` is shared by four airframes; one aeroplane's afterburner
 * does not belong in the common actuator table until a second one has one.
 */
export function jetReheatFraction(throttle: number): number {
  const burner = aircraftDefinition("jet").afterburner;
  if (!burner) return 0;
  const gate = burner.engageThrottle;
  const travel = Math.max(1e-6, 1 - gate);
  const commanded = Number.isFinite(throttle) ? throttle : 0;
  return Math.min(1, Math.max(0, (commanded - gate) / travel));
}

export function createJet(scene: Scene): AircraftVisual {
  const build = new AircraftBuildContext(scene);
  // `f-16c-fighting-falcon` is the OLD airframe's name and this is no longer that
  // aeroplane. It is kept because `tests/render.webgpu-aircraft.test.ts` pins
  // it and that file is not this one's to change; it should be renamed with
  // that assertion. The same applies to `jet-bubble-canopy` (this aeroplane is
  // single-seat, with a one-piece bubble), to `port-/starboard-jet-inlet-cheek`
  // (there is ONE inlet, under the fuselage) and to `port-/starboard-swept-
  // tailplane` (there is no fixed tailplane; the stabilators are all-moving).
  // Each of those names is attached below to the nearest real part, and each
  // is flagged where it is used.
  const root = new TransformNode("f-16c-fighting-falcon", scene);
  configureRoot(root, "jet");

  // A two-tone air-superiority grey, which is what a Block 50 wears: a darker
  // grey over the spine and the wing upper surfaces, a lighter one underneath.
  // Three recipes rather than the Global's two, because on a fighter the
  // upper/lower split is the scheme — it is visible from every chase angle and
  // it is most of what stops a grey aeroplane reading as one flat grey shape.
  const body = build.paintMaterial("jet-body", {
    seed: 0x7e57_2201,
    baseColor: 0x8d959b,
    liveryColor: 0x59636b,
    roughness: 0.42,
    metallic: 0.14,
    sootStrength: 0.62,
    wearStrength: 0.7,
  });
  const underside = build.paintMaterial("jet-underside", {
    seed: 0x7e57_2202,
    baseColor: 0xa8b0b4,
    liveryColor: 0x8b9398,
    roughness: 0.48,
    metallic: 0.12,
    sootStrength: 0.86,
    wearStrength: 0.52,
  });
  const accent = build.paintMaterial("jet-accent", {
    seed: 0x7e57_2203,
    baseColor: 0x5b656c,
    liveryColor: 0xc2452f,
    roughness: 0.44,
    metallic: 0.1,
    sootStrength: 0.4,
    wearStrength: 0.68,
  });
  const dark = build.material("jet-dark", 0x1b2428, {
    roughness: 0.34,
    metallic: 0.4,
  });
  // The radome is a DIFFERENT dark from the inlet's. `dark` is a hole — the
  // intake mouth and the exhaust duct — and a nose painted with it renders as a
  // black needle stuck on the front. A real radome is dark grey glass-fibre
  // that still catches the sun, and the line where it meets the skin is one of
  // the few hard colour edges on the whole aeroplane.
  const radomeGrey = build.material("jet-radome", 0x39424a, {
    roughness: 0.55,
    metallic: 0.05,
  });
  // THE CANOPY GLASS, and it is the one material on this aeroplane that has to
  // be designed rather than copied. On the two small airframes the glass is a
  // windscreen seen edge-on; here it is a 4 m teardrop that is a third of the
  // silhouette, and when it fails to read the aeroplane looks like an OPEN
  // cockpit with the seat standing out in the airstream. That is exactly what
  // it did: in the orbit frames there was no bubble at all, and the seat and
  // headrest showed as two dark boxes on the spine against open sky.
  //
  // WHAT WAS WRONG WAS THE REFRACTION, not the alpha. The shared recipe turns
  // on `subSurface.isRefractionEnabled` with `linkRefractionWithTransparency`,
  // which hands the surface's whole appearance to the refraction path: alpha
  // stops being blend opacity and becomes a refraction weight, and with no
  // refraction texture bound in the flight scene the result samples the
  // environment and comes out indistinguishable from whatever is behind it.
  // It survived review because the GPU preview test builds a ReflectionProbe,
  // so there IS something to sample there and the canopy reads in that one
  // frame while vanishing in the game.
  //
  // So: no refraction. An ordinary alpha-blended PBR surface, which reads by
  // TINT plus REFLECTION rather than by opacity — which is also how real glass
  // reads. Alpha is deliberately moderate (0.46) because this is the one
  // surface the pilot looks THROUGH in cockpit view; the bubble is made to
  // read from outside by the clearcoat's grazing-angle Fresnel and a raised
  // environment intensity instead, so it holds up against bright sky and
  // against dark terrain, which opacity alone does not. The small emissive is
  // the floor that stops it disappearing entirely against unlit ground.
  const glass = build.material("jet-glass", 0x0e2a36, {
    roughness: 0.05,
    metallic: 0,
    alpha: 0.46,
    doubleSided: true,
    clearCoat: { intensity: 1, roughness: 0.025, indexOfRefraction: 1.6 },
    emissive: 0x0b1c26,
    emissiveIntensity: 0.55,
  });
  // Reflections are most of what makes a canopy an object, so this surface
  // takes the environment harder than the paint does.
  glass.environmentIntensity = 2.2;
  const tire = build.material("jet-tire", 0x060809, { roughness: 1, metallic: 0 });
  const hub = build.material("jet-hub", 0x89979a, { roughness: 0.3, metallic: 0.72 });
  // The nozzle flaps. Authored COLD — the emissive below is the heat-stained
  // titanium of a dry engine — and multiplied up by `update` when the reheat
  // lights, so the petals glow from the inside out instead of the plume simply
  // appearing in front of unchanged metal.
  const hotMetal = build.material("jet-hot-metal", 0x4f5555, {
    roughness: 0.24,
    metallic: 0.86,
    emissive: 0x3a160c,
    emissiveIntensity: 0.5,
  });
  // THE REHEAT PLUME, in two nested cones. Blue-white rather than orange: a
  // turbofan afterburner burns a long way past stoichiometric in a duct full of
  // bypass air, and what you see behind an F-16 at night is a pale blue column
  // with a near-white core and shock diamonds in it — orange is a piston
  // aeroplane's exhaust or a rocket's, not this. The core is hotter and less
  // transparent than the shroud, which is what gives the column a centre.
  const reheatShroud = build.material("jet-reheat-shroud", 0x74a8ff, {
    roughness: 1,
    metallic: 0,
    alpha: 0.3,
    emissive: 0x3d7dff,
    emissiveIntensity: 2.2,
  });
  const reheatCore = build.material("jet-reheat-core", 0xe4eeff, {
    roughness: 1,
    metallic: 0,
    alpha: 0.55,
    emissive: 0xcfe2ff,
    emissiveIntensity: 4,
  });

  // The same six lamps as the other three airframes; the split-angle nav
  // partition is a property of the lighting law rather than of one model.
  const jetApplyLamp = createLampApplier();
  const jetApplyGlow = createGlowApplier();
  const redLamp = build.material("jet-port-lamp", 0xff493d, {
    emissive: 0xff2018, emissiveIntensity: 2.4,
  });
  const greenLamp = build.material("jet-starboard-lamp", 0x5dffab, {
    emissive: 0x24ff83, emissiveIntensity: 2.4,
  });
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
  // A MID grey, not near-black. Seen through 46% tint, 0x18 reads as a hole in
  // the top of the fuselage rather than as a cockpit; the eye needs something
  // in there to resolve. Real fighter cockpits are dark grey, not black.
  const interior = build.material("jet-interior", 0x333d44, {
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

  // THE BLENDED BODY, which is the whole aeroplane. Four regimes down one loft,
  // and the section shape changes in every one of them:
  //
  //   RADOME/NOSE      slim, round, pointed.
  //   FOREBODY         an oval TALLER THAN WIDE (1.08 x 0.92 at the cockpit)
  //                    whose upper corners sharpen going aft — `squareness`
  //                    climbing 2.1 -> 2.3 -> 2.7 — until the corner becomes
  //                    the strake. A slim forebody is what leaves the canopy
  //                    standing proud; a fat one hides it.
  //   WING CARRY       a rounded rectangle CLEARLY WIDER THAN TALL: 1.94 m
  //                    across by 0.92 m deep, ratio 2.1, at squareness 3.2.
  //   ENGINE BAY       circular, and only here.
  //
  // THE TWO NUMBERS THAT KILL THE "PLATE ON A TUBE" LOOK. First the ratio: a
  // near-round section presents a VERTICAL wall at the wing plane, so a 0.19 m
  // wing leaving it can only ever be a plate meeting a cylinder. At 2.1 the
  // shoulder is already falling away at about 30 degrees by the time the wing
  // root reaches it, and the wing continues that line instead of interrupting
  // it. Second, `yOffset` is -0.10 through the whole carry-through, which is
  // WING_CHORD_PLANE_Y exactly: the section's widest line and the wing's chord
  // plane are the same line, so the wing grows out of the shoulder rather than
  // out of the middle of a flank. The first version of this file had the ratio
  // at 1.15 and the widest line 0.04 m off, and it rendered as a 1950s trainer.
  //
  // This loft does NOT reach the belly. Below the shoulder the aeroplane is the
  // inlet duct, which is a separate loft and a separate shape; trying to make
  // one section be both a wide flat wing carry AND a deep chin is what forces
  // the round tube.
  const fuselage = build.loft(
    "jet-fuselage",
    [
      { x: -6.55, yRadius: 0.5, zRadius: 0.5, yOffset: 0.02 },
      { x: -5.3, yRadius: 0.52, zRadius: 0.55, yOffset: -0.01 },
      { x: -4, yRadius: 0.53, zRadius: 0.68, yOffset: -0.05, squareness: 2.2 },
      { x: -2.6, yRadius: 0.5, zRadius: 0.86, yOffset: -0.08, squareness: 2.7 },
      { x: -1.2, yRadius: 0.47, zRadius: 0.96, yOffset: -0.1, squareness: 3.1 },
      { x: 0.4, yRadius: 0.46, zRadius: 0.97, yOffset: -0.1, squareness: 3.2 },
      { x: 1.5, yRadius: 0.46, zRadius: 0.74, yOffset: -0.08, squareness: 2.7 },
      { x: 2.4, yRadius: 0.46, zRadius: 0.54, yOffset: -0.04, squareness: 2.3 },
      { x: 3.4, yRadius: 0.4, zRadius: 0.45, yOffset: -0.05, squareness: 2.1 },
      { x: 4.4, yRadius: 0.35, zRadius: 0.38, yOffset: -0.09 },
      { x: 5.15, yRadius: 0.32, zRadius: 0.34, yOffset: -0.12 },
    ],
    24,
    body,
    root,
  );
  // The radome, in the dark material rather than the paint: on this type it is
  // a plainly different colour from the skin behind it and the line where they
  // meet is one of the few hard edges on the whole aeroplane.
  const radome = build.loft(
    "radar-nose",
    [
      { x: 5.1, yRadius: 0.33, zRadius: 0.35, yOffset: -0.12 },
      { x: 5.8, yRadius: 0.3, zRadius: 0.31, yOffset: -0.11 },
      { x: 6.4, yRadius: 0.21, zRadius: 0.22, yOffset: -0.1 },
      { x: 6.95, yRadius: 0.075, zRadius: 0.075, yOffset: -0.08 },
    ],
    20,
    radomeGrey,
    root,
  );
  // The air-data probe. The published 15.06 m overall length INCLUDES it, so
  // the airframe ends at x = 6.95 and the probe carries the last 0.55 m out to
  // the sim's radome contact point at x = 7.50. Treating the probe as part of
  // the radome instead would have made the aeroplane 0.65 m too long.
  build.strutBetween(
    "jet-air-data-probe",
    new Vector3(6.95, -0.08, 0),
    new Vector3(7.5, -0.05, 0),
    0.02,
    dark,
    root,
  );

  // THE INLET: ONE ventral duct under the forward fuselage, ahead of the wing.
  // Not two cheek intakes — this aeroplane has a single normal-shock inlet
  // hanging below a slim forward fuselage, and the gap between the slim body
  // and the big chin under it is the second thing after the wing blend that
  // says F-16 from a distance.
  //
  // It is also THE WHOLE UNDERSIDE. The duct does not stop behind the lip: it
  // runs aft to x = -3.00 and fairs into the tail, and it is what carries the
  // belly down to y = -0.92 at the sim's belly contact point. The fuselage loft
  // above owns the shoulder line and this one owns the keel, which is the only
  // way to get a wing carry-through that is twice as wide as it is deep AND a
  // chin 1.24 m below the wing plane out of two elliptical families.
  //
  // Its lowest point is y = -1.24 at x 2.10 to 2.80, which is the contact point
  // `sim/aircraft.ts` now carries at (2.6, -1.24, 0) — 0.32 m below the belly
  // point above it, and only 0.68 m off the ground with the gear down. That
  // famously low intake is a real feature of the aeroplane.
  //
  // Squareness 3.0 through the middle of it: the F-16's inlet is a
  // flat-bottomed, flat-sided rounded box, not a pipe, and a pipe under a flat
  // body reads as a drop tank.
  build.loft(
    "jet-ventral-inlet",
    [
      { x: -3, yRadius: 0.15, zRadius: 0.4, yOffset: -0.42, squareness: 2.4 },
      { x: -1.6, yRadius: 0.25, zRadius: 0.62, yOffset: -0.64, squareness: 2.8 },
      { x: -0.2, yRadius: 0.3, zRadius: 0.7, yOffset: -0.62, squareness: 3 },
      { x: 1, yRadius: 0.335, zRadius: 0.68, yOffset: -0.585, squareness: 3 },
      { x: 2.1, yRadius: 0.42, zRadius: 0.62, yOffset: -0.82, squareness: 3 },
      { x: 2.8, yRadius: 0.42, zRadius: 0.58, yOffset: -0.82, squareness: 2.8 },
      { x: 3.62, yRadius: 0.4, zRadius: 0.53, yOffset: -0.82, squareness: 2.4 },
    ],
    20,
    underside,
    root,
  );
  // The mouth: a wide, shallow "smiling" oval, dark so it reads as a hole
  // rather than as the cap the loft closes its forward section with. A quarter
  // turn about Z lays the cylinder's disc into the Y/Z plane, after which LOCAL
  // X is world Y — so scaling x is what flattens the oval into 0.92 m across by
  // 0.55 m deep rather than shortening the duct.
  const inletMouth = build.cylinder(
    "jet-inlet-lip", 0.22, 0.92, 0.96, 18, dark, root);
  inletMouth.rotation.z = Math.PI / 2;
  inletMouth.scaling.x = 0.52;
  inletMouth.position.set(3.6, -0.86, 0);
  // THE SPLITTER GAP. The F-16's inlet is held off the fuselage by a boundary
  // layer diverter, and the slot between the two is visible from every forward
  // angle — it is most of what tells you the chin is a separate duct rather
  // than a fat belly. A dark plate in the junction is all it takes to read.
  const splitter = build.box("jet-inlet-splitter", 0.62, 0.1, 0.88, dark, root);
  splitter.position.set(3.3, -0.45, 0);
  // `port-jet-inlet-cheek` / `starboard-jet-inlet-cheek` ARE NOT TWO INTAKES —
  // the previous version of this file made them big enough to be mistaken for
  // exactly that, which was the single worst thing in the rendered frame. They
  // are the diverter's two side walls, standing 0.13 m proud in the corner
  // between the duct's shoulder and the body, in the UNDERSIDE paint rather
  // than the dark material so that nothing down there but the one mouth is
  // black. The names are pinned by `tests/render.webgpu-aircraft.test.ts`.
  for (const side of [1, -1] as const) {
    const cheek = build.box(
      side > 0 ? "starboard-jet-inlet-cheek" : "port-jet-inlet-cheek",
      0.78,
      0.3,
      0.07,
      underside,
      root,
    );
    cheek.position.set(3.26, -0.56, side * 0.46);
  }

  const wingSurfaces: AbstractMesh[] = [];
  const flaps: TransformNode[] = [];

  // STARBOARD IS BODY +Z. Every side loop in this file runs [1, -1] and calls
  // +1 starboard, the discipline the Global adopted after the two older
  // airframes shipped ailerons on the wrong wings for months.
  for (const side of [1, -1] as const) {
    const sideName = side > 0 ? "starboard" : "port";

    // The fixed wing, in two spanwise panels split where the flaperons start.
    // Inboard of that there is no moving surface, so the panel runs all the way
    // to the true trailing edge; outboard of it the panel stops on the hinge
    // line and the flaperon fills the rest. Building the whole wing to the
    // hinge line instead would have left a 0.9 m deep notch in the wing root
    // where the body blend is supposed to be unbroken.
    //
    // 4% thick. That is the real section (NACA 64A-204) and it is startlingly
    // thin — 0.20 m at a 5.03 m root chord — which is what a wing designed to
    // go supersonic looks like and is visible head-on against the Global's 11%.
    const rootPanel = build.airfoilWing(
      `${sideName}-swept-main-wing`,
      {
        rootLeadingX: leadingEdgeAt(WING_ROOT_Z),
        rootTrailingX: trailingEdgeAt(WING_ROOT_Z),
        tipLeadingX: leadingEdgeAt(FLAPERON_ROOT_Z),
        tipTrailingX: trailingEdgeAt(FLAPERON_ROOT_Z),
        rootZ: side * WING_ROOT_Z,
        tipZ: side * FLAPERON_ROOT_Z,
        thicknessRatio: 0.04,
        camberRatio: 0.005,
        chordSegments: 12,
        spanSegments: 1,
      },
      body,
      root,
    );
    rootPanel.position.y = WING_CHORD_PLANE_Y;
    const outerPanel = build.airfoilWing(
      `${sideName}-swept-outer-wing`,
      {
        rootLeadingX: leadingEdgeAt(FLAPERON_ROOT_Z),
        rootTrailingX: hingeLineAt(FLAPERON_ROOT_Z),
        tipLeadingX: WING_TIP_LEADING_X,
        tipTrailingX: WING_TIP_HINGE_X,
        rootZ: side * FLAPERON_ROOT_Z,
        tipZ: side * WING_TIP_Z,
        thicknessRatio: 0.04,
        camberRatio: 0.005,
        chordSegments: 14,
        spanSegments: 4,
      },
      body,
      root,
    );
    outerPanel.position.y = WING_CHORD_PLANE_Y;
    wingSurfaces.push(rootPanel, outerPanel);

    // THE LEADING-EDGE ROOT EXTENSION. A thin sharp strake sweeping forward
    // from the wing leading edge along the UPPER BODY CORNER to x = +4.35, just
    // ahead of the windscreen — "to about the canopy", as the type is always
    // described. Built in the wing's own chord plane, which is also the body's
    // widest line, so the strake, the shoulder and the wing are one unbroken
    // edge from the cockpit to the tip.
    //
    // IT HAS TO STICK OUT. The first version ran its root at z = 0.40 against a
    // forebody 0.72 m wide, so the whole strake was buried inside the skin and
    // rendered as nothing at all. The root is now z = 0.28 where the body is
    // 0.45 wide at x 3.40, and the outer edge crosses the body surface at about
    // x 3.6 and is 0.35 m proud by x 2.40 — a hard 0.07 m thick chine against
    // a rounded body, which is what a strake is supposed to look like.
    //
    // The tip chord is 0.12 m rather than zero only because the airfoil builder
    // needs a positive chord at every station; geometrically this is a
    // triangle that dies on the wing leading edge at z = 1.00.
    const lerx = build.airfoilWing(
      `${sideName}-jet-leading-edge-extension`,
      {
        rootLeadingX: 4.35,
        rootTrailingX: leadingEdgeAt(0.28),
        tipLeadingX: 2.08,
        tipTrailingX: 1.96,
        rootZ: side * 0.28,
        tipZ: side * FLAPERON_ROOT_Z,
        thicknessRatio: 0.038,
        chordSegments: 12,
        spanSegments: 3,
      },
      body,
      root,
    );
    lerx.position.y = WING_CHORD_PLANE_Y;
    wingSurfaces.push(lerx);
  }

  // THE FLAPERONS. On the real aeroplane the whole trailing edge is ONE surface
  // a side doing both jobs — there is no separate aileron — and the flight
  // control system mixes roll and flap commands into it. The rig contract wants
  // a flap list and an aileron pair, so the span is cut in two: the inboard
  // segment is driven by `pose.flap` and the outboard one by the aileron
  // deflections. That is a faithful split of one surface's duties rather than
  // an invented pair of surfaces, and at 20 degrees of flap the two segments
  // are not visibly on different hinge lines because they are on the same one.
  const FLAP_ROOT_Z = 1.05;
  const FLAP_TIP_Z = 2.55;
  const AILERON_ROOT_Z = 2.65;
  const AILERON_TIP_Z = 4.25;
  const flapHingeRootX = hingeLineAt(FLAP_ROOT_Z);
  for (const side of [1, -1] as const) {
    const sideName = side > 0 ? "starboard" : "port";
    // The hinge node sits ON the hinge line at the panel's inboard end and the
    // panel is expressed relative to it, so `rotation.z` swings the trailing
    // edge down instead of sliding the whole panel through the wing.
    const hinge = node(`${sideName}-jet-flaperon`, root, scene);
    hinge.position.set(flapHingeRootX, WING_CHORD_PLANE_Y, side * FLAP_ROOT_Z);
    const surface = build.airfoilWing(
      `${sideName}-jet-flaperon-surface`,
      {
        rootLeadingX: 0,
        rootTrailingX: trailingEdgeAt(FLAP_ROOT_Z) - flapHingeRootX,
        tipLeadingX: hingeLineAt(FLAP_TIP_Z) - flapHingeRootX,
        tipTrailingX: trailingEdgeAt(FLAP_TIP_Z) - flapHingeRootX,
        rootZ: 0,
        tipZ: side * (FLAP_TIP_Z - FLAP_ROOT_Z),
        thicknessRatio: 0.055,
        camberRatio: 0.008,
        chordSegments: 8,
        spanSegments: 2,
      },
      accent,
      hinge,
    );
    flaps.push(hinge);
    wingSurfaces.push(surface);
  }

  // Ailerons — the outboard flaperon segment. STARBOARD FIRST in the tuple and
  // at POSITIVE Z: `applyCommonPose` drives `ailerons[0]` with the starboard
  // deflection and nothing downstream checks the name, which is exactly how the
  // old bug survived.
  const aileronHingeRootX = hingeLineAt(AILERON_ROOT_Z);
  const starboardAileron = node("starboard-aileron", root, scene);
  starboardAileron.position.set(aileronHingeRootX, WING_CHORD_PLANE_Y, AILERON_ROOT_Z);
  const portAileron = node("port-aileron", root, scene);
  portAileron.position.set(aileronHingeRootX, WING_CHORD_PLANE_Y, -AILERON_ROOT_Z);
  for (const side of [1, -1] as const) {
    wingSurfaces.push(build.airfoilWing(
      side > 0 ? "starboard-aileron-surface" : "port-aileron-surface",
      {
        rootLeadingX: 0,
        rootTrailingX: trailingEdgeAt(AILERON_ROOT_Z) - aileronHingeRootX,
        tipLeadingX: hingeLineAt(AILERON_TIP_Z) - aileronHingeRootX,
        tipTrailingX: trailingEdgeAt(AILERON_TIP_Z) - aileronHingeRootX,
        rootZ: 0,
        tipZ: side * (AILERON_TIP_Z - AILERON_ROOT_Z),
        thicknessRatio: 0.055,
        chordSegments: 8,
        spanSegments: 2,
      },
      accent,
      side > 0 ? starboardAileron : portAileron,
    ));
  }

  // Wingtip launcher rails. Not decoration: the published 9.96 m span is
  // measured OVER these, the wing itself spanning 9.44 m, and both the nav lamp
  // and the strobe in `JET_WASH` sit on them — z = 4.82 is this rail's
  // centreline and z = 4.98 is its outboard face. A bare rail with a light on
  // its nose is exactly how this aeroplane flies without missiles.
  const RAIL_Z = 4.83;
  const RAIL_Y = -0.04;
  for (const side of [1, -1] as const) {
    const rail = build.cylinder(
      side > 0 ? "starboard-wingtip-rail" : "port-wingtip-rail",
      3,
      0.24,
      0.3,
      10,
      body,
      root,
    );
    // A NEGATIVE quarter turn about Z puts the cylinder's narrow end at +X, so
    // the rail points forward rather than trailing its nose behind it.
    rail.rotation.z = -Math.PI / 2;
    rail.position.set(-1.7, RAIL_Y, side * RAIL_Z);
  }

  // THE STABILATORS. Parented to the pivot node, whole: the surface named
  // These are the STABILATORS: the whole surface pivots, so there is no
  // elevator hinged to a fixed tailplane. Named for what they are.
  // `tests/render.webgpu-control-surface-sides.test.ts` reads its aftmost
  // vertex, which is the only way to tell an all-moving surface from a fixed
  // one that happens to have a big elevator.
  const elevator = node("elevator", root, scene);
  elevator.position.set(STABILATOR_PIVOT_X, STABILATOR_Y, 0);
  for (const side of [1, -1] as const) {
    const stabilator = build.airfoilWing(
      side > 0 ? "starboard-jet-stabilator" : "port-jet-stabilator",
      {
        rootLeadingX: STABILATOR_ROOT_LEADING_X - STABILATOR_PIVOT_X,
        rootTrailingX: STABILATOR_ROOT_TRAILING_X - STABILATOR_PIVOT_X,
        tipLeadingX: STABILATOR_TIP_LEADING_X - STABILATOR_PIVOT_X,
        tipTrailingX: STABILATOR_TIP_TRAILING_X - STABILATOR_PIVOT_X,
        rootZ: side * STABILATOR_ROOT_Z,
        tipZ: side * STABILATOR_TIP_Z,
        thicknessRatio: 0.05,
        chordSegments: 10,
        spanSegments: 3,
      },
      accent,
      elevator,
    );
    // ANHEDRAL, about 7.5 degrees, which drops each tip 0.36 m. It is applied
    // to the SURFACE and not to the pivot node, because the node's rotation
    // about Z is the pitch command and the pose owns it every frame. A
    // mirrored pair of anhedral angles leaves the two trailing edges at equal
    // height, which is what `render.webgpu-control-surface-sides` checks when
    // it asserts the stabilator has not split.
    stabilator.rotation.x = side * 0.13;
    wingSurfaces.push(stabilator);
    // `port-/starboard-jet-stabilator-root-fairing` IS NOT A TAILPLANE. It is the fixed
    // fairing on the aft fuselage that the stabilator root pivots inside —
    // without it you would see the root rib swing clear of the skin. The name
    // is pinned by `tests/render.webgpu-aircraft.test.ts` and describes a part
    // this aeroplane does not have; it should become
    // `*-jet-stabilator-root-fairing` when that assertion is rewritten.
    const shroud = build.box(
      side > 0 ? "starboard-jet-stabilator-root-fairing" : "port-jet-stabilator-root-fairing",
      2.3,
      0.42,
      0.2,
      body,
      root,
    );
    shroud.position.set(-3.95, STABILATOR_Y, side * 0.56);
  }

  // THE FIN. One, large: 2.57 m of exposed height on a 4.94 m aeroplane, with a
  // leading edge swept 50 degrees. The tip leading edge lands on (-4.60, 3.02),
  // the sim's fin contact point, which is also what sets the aeroplane's
  // overall 4.88 m height with the wheels on the ground.
  //
  // A four-point trapezoid rather than a triangle, because this fin has a real
  // 1.50 m tip chord carrying the antenna fairing and the rudder runs the full
  // height of it. The profile builder fans from the first vertex, so the four
  // points are ordered to stay convex.
  const fin = build.verticalProfile(
    "swept-vertical-stabilizer",
    [
      { x: -1.95, y: 0.42 },
      { x: -5.45, y: 0.42 },
      { x: -5.9, y: 3.02 },
      { x: -4.6, y: 3.02 },
    ],
    0.22,
    body,
    root,
  );
  wingSurfaces.push(fin);
  const rudder = node("rudder", root, scene);
  rudder.position.set(-5.45, 0.52, 0);
  const rudderSurface = build.box("rudder-surface", 0.75, 2.35, 0.16, accent, rudder);
  rudderSurface.position.set(-0.4, 1.15, 0);
  // The hinge line leans 0.50 m aft over its 2.60 m; a box cannot be swept, so
  // the panel is tilted to sit on that line instead of crossing it. Applied to
  // the CHILD, because the node's own Y rotation is the deflection the pose
  // owns every frame.
  rudderSurface.rotation.z = Math.atan2(0.5, 2.6);

  // The two ventral strakes under the tail. They are not trim: on this airframe
  // they are what keeps directional stability at high angle of attack, where
  // the fin is in the wing's wake, and they are plainly visible in any view
  // from below or behind. Canted 29 degrees outboard — the rotation is about
  // the mesh's own origin at the centreline, so the strake swings out and the
  // root stays buried in the fuselage.
  for (const side of [1, -1] as const) {
    const strake = build.verticalProfile(
      side > 0 ? "starboard-ventral-strake" : "port-ventral-strake",
      [
        { x: -3.1, y: -0.36 },
        { x: -5.8, y: -0.22 },
        { x: -5.8, y: -1 },
        { x: -4.3, y: -1.08 },
      ],
      0.09,
      underside,
      root,
    );
    // Re-seated for the narrower aft body: at x -5.5 the fuselage is only
    // 0.32 m deep below its centreline, so a strake rooted at -0.55 — where
    // this one was — hung in clear air under the tail.
    strake.position.z = side * 0.26;
    strake.rotation.x = -side * 0.42;
  }

  // THE BUBBLE CANOPY, and NO FORWARD BOW FRAME. The one-piece blown canopy
  // with an unobstructed forward view is this aeroplane's other signature, and
  // the older airframes in this file all carry a centre frame that would be
  // exactly wrong here.
  //
  // IT HAS TO STAND PROUD, and that is as much about the body under it as about
  // the glass. The first version put a 0.44 m tall dome on a forebody 1.36 m
  // deep and 1.44 m wide, so there was nothing to stand proud OF and the canopy
  // rendered as a faint ridge with two dark boxes — the seat — showing through
  // it. The forebody is now 0.92 m deep and 1.08 m wide and the canopy is 1.60 m
  // tall at its crown station: 0.82 m of glass above a body top at y 0.42, on a
  // body it matches in width.
  //
  // A LOFT, NOT A SCALED SPHERE, and it wins on both axes. An ellipsoid is
  // symmetric fore and aft, so it can only give the windscreen the same rake as
  // the aft fairing; this aeroplane's canopy is a teardrop — 1.75 m from the
  // crown forward to the windscreen tip and 2.20 m from the crown aft onto the
  // spine, which is the asymmetry the sections below carry. It is also 976
  // triangles cheaper, because a 16-segment sphere spends 1,296 of them on a
  // shape whose lower half is inside the fuselage and never seen.
  //
  // TWO CONSTRAINTS HOLD THE SECTIONS. The crown at x 2.22 is 1.240 and the
  // catalogue's cockpit eye is measured against it: panel top 0.82, eye 0.94,
  // 0.30 m of headroom. And every section's BOTTOM must stay inside the skin —
  // this is glass, so a section reaching below the fuselage would hang a
  // transparent blister under the belly. The forebody's floor is about -0.47
  // here, which is what caps `yRadius` at 0.80 and fixes `yOffset` at 0.44.
  const canopy = build.loft(
    "jet-bubble-canopy",
    [
      { x: 0, yRadius: 0.16, zRadius: 0.2, yOffset: 0.48 },
      { x: 0.75, yRadius: 0.38, zRadius: 0.34, yOffset: 0.46 },
      { x: 1.35, yRadius: 0.56, zRadius: 0.42, yOffset: 0.45 },
      { x: 1.85, yRadius: 0.73, zRadius: 0.47, yOffset: 0.44 },
      { x: 2.22, yRadius: 0.8, zRadius: 0.49, yOffset: 0.44 },
      { x: 2.6, yRadius: 0.8, zRadius: 0.49, yOffset: 0.44 },
      { x: 3.05, yRadius: 0.7, zRadius: 0.45, yOffset: 0.43 },
      { x: 3.55, yRadius: 0.51, zRadius: 0.36, yOffset: 0.41 },
      { x: 3.95, yRadius: 0.22, zRadius: 0.22, yOffset: 0.37 },
      { x: 4.1, yRadius: 0.05, zRadius: 0.06, yOffset: 0.3 },
    ],
    16,
    glass,
    root,
  );
  canopy.metadata = { ...canopy.metadata, castsShadow: false };
  // The dorsal spine, which on this aeroplane is one continuous fairing from
  // the canopy's aft end to the fin: avionics bays forward, fin root fillet
  // aft. It carries, at (-1.6, 0.92), the anticollision beacon `JET_WASH`
  // expects to find there — its crown is 0.86 at that station so the 0.14 m
  // lamp sits on it. Without this the beacon would float half a metre above a
  // flat deck, and the fin's leading edge would spring out of nowhere.
  const dorsalSpine = build.loft(
    "jet-dorsal-spine",
    [
      { x: -3.6, yRadius: 0.13, zRadius: 0.3, yOffset: 0.3, squareness: 2.2 },
      { x: -2.6, yRadius: 0.24, zRadius: 0.4, yOffset: 0.46, squareness: 2.4 },
      { x: -1.6, yRadius: 0.29, zRadius: 0.46, yOffset: 0.57, squareness: 2.6 },
      { x: -0.6, yRadius: 0.29, zRadius: 0.48, yOffset: 0.55, squareness: 2.6 },
      { x: 0.3, yRadius: 0.27, zRadius: 0.46, yOffset: 0.5, squareness: 2.5 },
      { x: 0.95, yRadius: 0.21, zRadius: 0.38, yOffset: 0.4, squareness: 2.3 },
    ],
    16,
    body,
    root,
  );

  // ONE SEAT, ONE UPRIGHT. This aeroplane is single-seat and there must be
  // exactly one thing standing up behind the pilot. A separate headrest box
  // made a second upright, and with the glass failing to read the pair looked
  // like two objects bolted to the spine with sky between them — the headrest
  // is now the top of the seat back rather than a part of its own.
  //
  // Its top is y 0.845 at x 1.67, where the canopy crown is 1.11: enclosed by
  // 0.27 m, so it stays under the glass at every orbit angle rather than
  // piercing it. Reclined 15 degrees — the real ACES II sits at 30, but the
  // recline is measured from the seat BACK and a box tipped that far puts its
  // lower corner through the cockpit floor.
  const seatBack = build.box("jet-ejection-seat", 0.18, 0.88, 0.44, interior, root);
  seatBack.position.set(1.78, 0.42, 0);
  seatBack.rotation.z = 0.26;
  seatBack.metadata = { ...seatBack.metadata, cockpitInterior: true, castsShadow: false };
  const seatPan = build.box("jet-seat-pan", 0.52, 0.11, 0.44, interior, root);
  seatPan.position.set(2.12, 0.08, 0);
  seatPan.metadata = { ...seatPan.metadata, cockpitInterior: true, castsShadow: false };
  // THE TUB. Without it the cockpit opening is a dark void under the glass and
  // the eye reads a hole rather than an interior. It sits entirely below the
  // canopy sill and a long way below the pilot's eye, so it closes the opening
  // without appearing in the forward view.
  const tub = build.box("jet-cockpit-tub", 1.9, 0.5, 0.84, interior, root);
  tub.position.set(2.2, 0.05, 0);
  tub.metadata = { ...tub.metadata, cockpitInterior: true, castsShadow: false };
  // Panel centred at x 2.92 / y 0.55 and 0.54 m tall, so its top edge is
  // y 0.82. The catalogue's cockpit eye is measured against those two numbers.
  addInstrumentPanel(
    build,
    "jet",
    root,
    2.92,
    0.55,
    0.62,
    interior,
    instrumentFace,
    instrumentMarking,
  );

  // THE ENGINE. One F110, one nozzle, and the exit plane on the sim's tailcone
  // contact point at x = -7.50.
  //
  // The duct liner is a closed convergent cone in the dark material: it is what
  // you actually see when you look into a nozzle from behind, and it is also
  // what stops the sky showing through the gaps between the petals.
  const exhaustLiner = build.cylinder(
    "jet-exhaust-liner", 0.85, 0.72, 0.96, 12, dark, root);
  exhaustLiner.rotation.z = Math.PI / 2;
  exhaustLiner.position.set(-6.975, 0.02, 0);

  // The rotating assembly. On a fighter with a hot nozzle this is a dim thing
  // seen down a tube rather than the Global's fan face, but the contract has
  // one rotating assembly per airframe and a turbine that never turned would
  // be a stopped engine. Eight blades, thin-instanced: the rotation has to be
  // visible against SOMETHING, and an axisymmetric disc — which is what this
  // aeroplane's predecessor span — cannot show that it is turning at all.
  const propeller = node("jet-compressor", root, scene);
  propeller.position.set(-7.3, 0.02, 0);
  const turbineHub = build.cylinder("jet-turbine-hub", 0.06, 0.2, 0.2, 10, hub, propeller);
  turbineHub.rotation.z = Math.PI / 2;
  const turbineBlade = build.box("jet-turbine-blades", 0.05, 0.3, 0.05, hub, propeller);
  {
    const matrices = new Float32Array(TURBINE_BLADE_COUNT * 16);
    for (let index = 0; index < TURBINE_BLADE_COUNT; index += 1) {
      const angle = (index / TURBINE_BLADE_COUNT) * Math.PI * 2;
      const matrix = Matrix.RotationX(angle);
      matrix.setTranslation(new Vector3(0, Math.cos(angle) * 0.22, Math.sin(angle) * 0.22));
      matrix.copyToArray(matrices, index * 16);
    }
    turbineBlade.thinInstanceSetBuffer("matrix", matrices, 16, true);
    turbineBlade.thinInstanceRefreshBoundingInfo(true);
  }

  // The fourteen convergent petals. Each instance matrix is the ENTIRE
  // transform and the base mesh keeps an identity one, because thin instance
  // matrices multiply into the mesh's own world matrix and splitting a
  // rotation across both is how that arrangement becomes unreadable.
  //
  // Each petal is rotated about Z by the convergence half-angle first, then
  // swept around the nozzle axis by rotation about X, and only then translated
  // out to its radius. Composing it the other way round would sweep the petals
  // around the AIRCRAFT centreline rather than around the nozzle.
  const nozzlePetal = build.box(
    "jet-nozzle-petals",
    NOZZLE_PETAL_LENGTH,
    NOZZLE_PETAL_THICKNESS,
    0.2,
    hotMetal,
    root,
  );
  {
    const convergence = Math.atan2(
      NOZZLE_FRONT_RADIUS - NOZZLE_EXIT_RADIUS,
      NOZZLE_PETAL_LENGTH,
    );
    const centreX = NOZZLE_EXIT_X + NOZZLE_PETAL_LENGTH * 0.5;
    const radius = (NOZZLE_FRONT_RADIUS + NOZZLE_EXIT_RADIUS) * 0.5
      + NOZZLE_PETAL_THICKNESS * 0.5;
    const matrices = new Float32Array(NOZZLE_PETAL_COUNT * 16);
    for (let index = 0; index < NOZZLE_PETAL_COUNT; index += 1) {
      const angle = (index / NOZZLE_PETAL_COUNT) * Math.PI * 2;
      const matrix = Matrix.RotationZ(convergence).multiply(Matrix.RotationX(angle));
      matrix.setTranslation(new Vector3(
        centreX,
        0.02 + Math.cos(angle) * radius,
        Math.sin(angle) * radius,
      ));
      matrix.copyToArray(matrices, index * 16);
    }
    nozzlePetal.thinInstanceSetBuffer("matrix", matrices, 16, true);
    nozzlePetal.thinInstanceRefreshBoundingInfo(true);
  }

  // THE REHEAT. Two nested cones behind the exit plane on their own node, so
  // one scale grows the whole column as the burner comes up. Parked as a stub
  // at low reheat and stretched to 2.1 m at the stop — a plume that only
  // brightened, without lengthening, reads as a light rather than as fire.
  //
  // Both materials are alpha-blended, so `finishMesh` has already moved these
  // meshes behind the water in draw order; a plume drawn before the sea would
  // cut a hole in it with its depth pre-pass.
  const reheat = node("jet-reheat", root, scene);
  reheat.position.set(NOZZLE_EXIT_X, 0.02, 0);
  const reheatShroudMesh = build.cylinder(
    "jet-reheat-plume", 2.1, 0.22, 0.7, 12, reheatShroud, reheat);
  reheatShroudMesh.rotation.z = Math.PI / 2;
  reheatShroudMesh.position.x = -1.05;
  reheatShroudMesh.metadata = { ...reheatShroudMesh.metadata, castsShadow: false };
  const reheatCoreMesh = build.cylinder(
    "jet-reheat-core", 1.1, 0.1, 0.42, 10, reheatCore, reheat);
  reheatCoreMesh.rotation.z = Math.PI / 2;
  reheatCoreMesh.position.x = -0.55;
  reheatCoreMesh.metadata = { ...reheatCoreMesh.metadata, castsShadow: false };
  const reheatShroudAlpha = reheatShroud.alpha;
  const reheatCoreAlpha = reheatCore.alpha;
  reheat.setEnabled(false);

  // RETRACTABLE TRICYCLE GEAR, on a 2.36 m track under a 9.96 m span. Every
  // wheel contact matches `sim/aircraft.ts` exactly: mains at
  // (-0.62, -1.92, +/-1.18), nose at (3.18, -1.86, 0). The node positions are
  // those points RAISED BY THE TYRE'S OUTER RADIUS, because the sim's y is
  // where the rubber meets the pavement and the node is the axle. Babylon's
  // torus outer radius is diameter/2 + thickness/2, so the 0.50/0.15 main tyre
  // gives 0.325 and 0.325 - 1.92 = -1.595.
  const landingGear = node("retractable-landing-gear", root, scene);
  const mainWheels: TransformNode[] = [];
  for (const side of [1, -1] as const) {
    const sideName = side > 0 ? "starboard" : "port";
    build.strutBetween(
      `${sideName}-main-strut`,
      new Vector3(-0.55, -0.7, side * 0.55),
      new Vector3(-0.62, -1.595, side * 1.18),
      0.08,
      hub,
      landingGear,
    );
    const wheel = node(`${sideName}-main-wheel`, landingGear, scene);
    wheel.position.set(-0.62, -1.595, side * 1.18);
    build.torus(`${wheel.name}-tire`, 0.5, 0.15, 16, tire, wheel);
    const wheelHub = build.cylinder(`${wheel.name}-hub`, 0.17, 0.26, 0.26, 12, hub, wheel);
    wheelHub.rotation.x = Math.PI / 2;
    mainWheels.push(wheel);
  }
  // The nose leg is SHORT because the inlet above it is low: only 0.48 m of it
  // is outside the duct. That is the real aeroplane and it is why the nose tyre
  // looks tucked up under the chin.
  build.strutBetween(
    "jet-nose-strut",
    new Vector3(3.18, -1.15, 0),
    new Vector3(3.18, -1.63, 0),
    0.06,
    hub,
    landingGear,
  );
  const noseSteer = node("nose-wheel-steering", landingGear, scene);
  noseSteer.position.set(3.18, -1.63, 0);
  const noseWheel = node("nose-wheel", noseSteer, scene);
  build.torus("nose-wheel-tire", 0.34, 0.12, 14, tire, noseWheel);
  const noseHub = build.cylinder("nose-wheel-hub", 0.13, 0.18, 0.18, 10, hub, noseWheel);
  noseHub.rotation.x = Math.PI / 2;
  // The taxi/landing light is on the nose gear on this type, not in the wing
  // root, so it is parented to the gear and goes away with it.
  //
  // It is OFF THE CENTRELINE, at z = +0.17, because the real one is: it lives
  // on the nose gear door, to one side of the wheel. That makes it the only
  // unmirrored part of this airframe, and `scripts/aircraft-framing-probe.mts`
  // will report it as such — the same way it reports the trainer's pitot tube.
  // It is a lamp on a door, not a tilted aeroplane.
  const jetLandingLight = build.cylinder(
    "landing-light", 0.03, 0.2, 0.2, 10, landingLamp, landingGear);
  jetLandingLight.rotation.z = Math.PI / 2;
  jetLandingLight.position.set(3.26, -1.22, 0.16);
  jetLandingLight.metadata = { ...jetLandingLight.metadata, castsShadow: false };

  // Gear doors, pushed STARBOARD FIRST so the index-parity hinge sign in
  // `update` is right: the door at +Z needs a positive rotation about body X to
  // drop its outboard edge and the door at -Z needs a negative one.
  const gearDoorRoot = node("landing-gear-doors", root, scene);
  const gearDoors: AbstractMesh[] = [];
  for (const side of [1, -1] as const) {
    const door = build.box(
      side > 0 ? "starboard-main-gear-door" : "port-main-gear-door",
      1.5,
      0.05,
      0.36,
      underside,
      gearDoorRoot,
    );
    door.position.set(-0.7, -0.86, side * 0.34);
    gearDoors.push(door);
  }
  const noseDoor = build.box("nose-gear-door", 1.4, 0.04, 0.44, underside, gearDoorRoot);
  noseDoor.position.set(3.3, -1.2, 0);
  gearDoors.push(noseDoor);

  // THE AIRBRAKE: four petals around the nozzle, hinged at their forward edge,
  // upper pair opening up and lower pair opening down. `speedBrakeDrag` 0.19 —
  // the largest of any airframe here — is what those four panels standing out
  // into the jet efflux are worth.
  //
  // The signed list is local because `CommonRig.speedBrakes` is a bare node
  // array and one pose angle has to drive two opposite senses. `update` reads
  // this rather than the rig's copy. The UPPER petal on each side keeps the
  // plain `*-speed-brake` name and the pose's own sign, which is what
  // `tests/render.webgpu-aircraft.test.ts` measures.
  const speedBrakePanels: { node: TransformNode; sense: 1 | -1 }[] = [];
  for (const side of [1, -1] as const) {
    const sideName = side > 0 ? "starboard" : "port";
    for (const petal of [
      { name: `${sideName}-speed-brake`, y: 0.32, sense: 1 as const },
      { name: `${sideName}-lower-speed-brake`, y: -0.32, sense: -1 as const },
    ]) {
      const brake = node(petal.name, root, scene);
      brake.position.set(-5.7, petal.y, side * 0.38);
      const panel = build.box(`${brake.name}-surface`, 0.9, 0.05, 0.52, body, brake);
      // Hinged at its forward edge, so the panel lies entirely aft of the node
      // and a negative pose angle lifts the upper petal's trailing edge.
      panel.position.x = -0.45;
      speedBrakePanels.push({ node: brake, sense: petal.sense });
    }
  }

  // LAMPS. Every nav and strobe coordinate below is transcribed FROM the
  // committed `JET_WASH` table in `lighting/AircraftLighting.ts`, which
  // `tests/lighting.aircraft-wash.test.ts` compares against these meshes' own
  // positions — a lamp half a metre off its wash is a glow with no source.
  //
  // All five land on real structure of THIS aeroplane, which is not something
  // that had to be true: the table was written for the airframe this one
  // replaces. The two wingtip pairs sit on the launcher rails (nav on the rail
  // centreline at z 4.82, strobe on its outboard face at z 4.98 — the rails are
  // why the span over them is the published 9.96 m), and the beacon at
  // (-1.6, 0.92) sits on the dorsal spine. Nothing in the table needed moving.
  //
  // Port (red) at -Z and starboard (green) at +Z, because starboard is +Z.
  // Reversing these is the one lighting error an observer can read directly: it
  // inverts which way the aeroplane appears to be heading.
  const portLight = build.sphere("port-navigation-light", 0.15, 8, redLamp, root);
  portLight.position.set(-0.2, 0.07, -4.82);
  portLight.metadata = { ...portLight.metadata, castsShadow: false };
  const starboardLight = build.sphere("starboard-navigation-light", 0.15, 8, greenLamp, root);
  starboardLight.position.set(-0.2, 0.07, 4.82);
  starboardLight.metadata = { ...starboardLight.metadata, castsShadow: false };
  for (const side of [1, -1] as const) {
    const strobe = build.sphere(
      side > 0 ? "starboard-strobe-light" : "port-strobe-light", 0.11, 8, strobeLamp, root);
    strobe.position.set(-0.34, 0.09, side * 4.98);
    strobe.metadata = { ...strobe.metadata, castsShadow: false };
  }
  const beaconLight = build.sphere("anticollision-beacon", 0.14, 8, beaconLamp, root);
  beaconLight.position.set(-1.6, 0.92, 0);
  beaconLight.metadata = { ...beaconLight.metadata, castsShadow: false };
  // The white position light is on the fin trailing edge just above the rudder,
  // which is where this type carries it. No wash entry claims it, so unlike the
  // five above this one is placed by the geometry alone.
  const tailLight = build.sphere("tail-navigation-light", 0.12, 8, tailLamp, root);
  tailLight.position.set(-5.86, 2.88, 0);
  tailLight.metadata = { ...tailLight.metadata, castsShadow: false };

  const rig: JetRig = {
    root,
    propeller,
    // Only opaque skin that would block the pilot's view. The canopy stays on
    // ordinary world layers — a canopy the pilot cannot see through is worse
    // than no canopy, and on this aeroplane it is the whole point of the type.
    cockpitParts: [fuselage, radome, dorsalSpine],
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
    speedBrakes: speedBrakePanels.map((petal) => petal.node),
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
      // Phase-anchored to simulation time rather than accumulated per frame, so
      // an identically-timed frame is identical across capture runs.
      propeller.rotation.x = pose.rotorRadiansPerSecond * state.simulationTime;
      applyCommonPose(rig, pose, delta);
      landingGear.setEnabled(pose.gearVisible);
      landingGear.scaling.set(pose.gearScale.x, pose.gearScale.y, pose.gearScale.z);
      landingGear.position.y = pose.gearOffsetY;
      rig.gearDoors.forEach((door, index) => {
        door.rotation.x = (index === 1 ? -1 : 1) * pose.gearDoorTravel;
      });
      for (const petal of speedBrakePanels) {
        petal.node.rotation.z = petal.sense * pose.speedBrake;
      }

      // Reheat. Off below the gate, full at the stop, and the plume node is
      // DISABLED rather than merely dimmed when it is out: below 85% throttle
      // there is no flame, and a transparent cone sitting behind the nozzle at
      // zero intensity would still be a faint ghost in every frame.
      const burner = jetReheatFraction(state.throttle);
      reheat.setEnabled(burner > 0);
      if (burner > 0) {
        reheat.scaling.set(0.45 + 0.55 * burner, 0.7 + 0.3 * burner, 0.7 + 0.3 * burner);
        reheatShroud.alpha = reheatShroudAlpha * burner;
        reheatCore.alpha = reheatCoreAlpha * burner;
        jetApplyGlow(reheatShroud, burner);
        jetApplyGlow(reheatCore, burner);
      }
      // The nozzle metal heats with it, so the petals are lit from inside
      // rather than standing cold in front of a flame.
      jetApplyGlow(hotMetal, 1 + 3 * burner);
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
