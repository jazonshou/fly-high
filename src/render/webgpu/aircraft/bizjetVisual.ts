import { VertexBuffer } from "@babylonjs/core/Buffers/buffer";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import type { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh";
import type { Mesh } from "@babylonjs/core/Meshes/mesh";
import { VertexData } from "@babylonjs/core/Meshes/mesh.vertexData";
import type { Scene } from "@babylonjs/core/scene";
import {
  resolveAircraftAnimationPose,
  safeAircraftAnimationDelta,
} from "./animation";
import {
  applyCommonPose,
  configureCockpitLayers,
  configureCockpitOnlyParts,
  hingeAlong,
  yawHingeAlong,
  configureRoot,
  createGlowApplier,
  createLampApplier,
  node,
  setCockpitVisibility,
  type CommonRig,
} from "./airframeRig";
import { AircraftBuildContext, type LoftSection } from "./builders";
import {
  GLOBAL_FUSELAGE_SECTIONS,
  GLOBAL_HOUSE_SCHEME,
  GLOBAL_LIVERY_STATION_RANGE,
  GLOBAL_TAILCONE_SECTIONS,
  buildGlobalLiveryMips,
  createGlobalLiveryTexture,
  createSolidLiveryTexture,
} from "./bizjetLivery";
import { PANE_GRID, SkinCaster, paneGrid } from "./airlinerGlazing";
import {
  GLOBAL_FLIGHT_DECK_OUTLINES,
  GLOBAL_FLIGHT_DECK_REFERENCE,
  GLOBAL_PANE_DEPTH,
  GLOBAL_PANE_PROUD,
  globalCentrePostPane,
  globalGlazingPane,
} from "./bizjetGlazing";
import { globalSeatPlacement } from "./bizjetSeats";
import {
  CABIN_PANE_DEPTH,
  CABIN_PANE_PROUD,
  cabinPaneGrid,
  cabinWindowStations,
} from "./bizjetCabinWindows";
import { buildBizjetCockpit } from "./cockpit/bizjetCockpit";
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
 * Wing planform and section, written ONCE because every piece of the wing is
 * cut from it: the two fixed panels, both flap segments, the aileron, the
 * fixed tip trailing edge and the seating of the spoilers. That is not tidiness
 * — it is what makes a flap's upper surface literally BE the wing's upper
 * surface continued, so there is no step at the hinge to catch the light.
 *
 * The real aeroplane: 31.70 m span over the winglet tips, 116.5 m^2 of wing
 * (1,254 sq ft, Aviation Week's pilot report), aspect ratio 8.63, 35.3 degrees
 * of sweep at the quarter chord. The area is the number that matters most
 * here and the one the first draft of this file got wrong: it claimed 93 m^2
 * in a comment while the built triangles measured 84.6, because the trailing
 * edge was notched away wherever two control surfaces did not quite meet.
 * 116.5 m^2 at this span needs a 6.41 m chord at the root rib against the 5.25
 * it had — this wing is genuinely broad, and the slender one it replaces read
 * as a sailplane's.
 *
 * The leading edge is placed, not styled. It puts the quarter-chord of the
 * mean aerodynamic chord (4.56 m at station z = 5.69) within 2 cm of x = 0,
 * and x = 0 is the centre of gravity the sim's whole definition is written
 * about. A wing anywhere else has the aeroplane balancing on a point its own
 * lift does not pass through.
 *
 * DELIBERATE SHORTFALL, measured: this reaches 33.0 degrees at the quarter
 * chord, not the published 35.3. Getting the last 2.3 degrees means sweeping
 * the tip a further 0.4 m aft, and the tip cannot move: `BIZJET_WASH` in
 * `lighting/AircraftLighting.ts` sites the navigation and strobe lamps at
 * x = -6.1 and -6.2, and past about x = -6.0 of tip leading edge those lamps
 * fall off the front of the winglet. That table is another file's.
 */
const WING_ROOT_Z = 1.45;
const WING_KINK_Z = 6.3;
const WING_TIP_Z = 15;
const WING_CHORD_PLANE_Y = -0.9;
/** Leading edge at each of the three defining stations: 37 deg, then 36 deg. */
const WING_ROOT_LEADING_X = 4.34;
const WING_KINK_LEADING_X = 0.685;
const WING_TIP_LEADING_X = -5.7;
/** True trailing edge — where the flaps and ailerons END. */
const WING_ROOT_TRAILING_X = -2.072;
const WING_KINK_TRAILING_X = -3.463;
const WING_TIP_TRAILING_X = -6.92;
/**
 * Hinge line, at 72% of local chord — just behind the 67% rear spar the
 * Global Express flight manual gives for this wing family. One fraction for
 * the whole span, so every flap and aileron hinge lies on one unbroken line.
 */
const WING_HINGE_CHORD_FRACTION = 0.72;
/**
 * Section thickness, TAPERING root to tip rather than stepping at the kink.
 * Bombardier says only that the 7500's transonic wing is thinner than the
 * Global Express's 11%, so these are that statement made continuous.
 */
const WING_ROOT_THICKNESS = 0.108;
const WING_KINK_THICKNESS = 0.096;
const WING_TIP_THICKNESS = 0.083;
/** Cambered for M 0.85 cruise, which is what the sim's cl_zero 0.14 is. */
const WING_CAMBER = 0.004;
/**
 * 2.5 degrees, the Global Express figure. The wing had NONE — measured at
 * -0.05 degrees across the built triangles — which is most of why it read as
 * a plank bolted through the fuselage. Pivoted at the root rib so the
 * wing-body joint does not move and the fairing still covers it.
 */
const WING_DIHEDRAL = (2.5 * Math.PI) / 180;
/**
 * The cove between a fixed panel and the surface hinged behind it.
 *
 * 30 mm, and the number was walked down from 60 after looking at it. The two
 * mating faces are blunt and vertical and face AWAY from each other, so they
 * cannot z-fight however close they are — whichever one a viewer is on the
 * side of, the other is culled and the solid body between is in front of it.
 * The cost of a wide cove is different: it is a slot you can see daylight
 * through. At 60 mm the close three-quarter frame showed a line of sky along
 * the whole hinge. At 30 mm it is under a pixel at the chase camera's 38 m
 * and reads as the hairline it should. A real wing closes the last of it with
 * an upper-skin overhang the flap tucks under, which the shared airfoil
 * builder cannot cut — that residue is reported rather than faked.
 */
const CONTROL_SURFACE_COVE = 0.03;
/**
 * Fowler travel. The shared pose carries ONE flap number, in radians of hinge
 * rotation, and `SURFACE_TRAVEL.bizjet` makes 30 degrees of it full flap; the
 * translation is scaled off that same fraction so both segments and both
 * wings move as a single family however the pose is driven. 0.30 m aft is
 * about a quarter of the flap's own chord, which is the order a Fowler track
 * on this class of wing gives.
 */
const FULL_FLAP_RADIANS = (30 * Math.PI) / 180;
const FLAP_AFT_TRAVEL = 0.3;
const FLAP_DOWN_TRAVEL = 0.1;
/**
 * How far a flap's leading edge is tucked UNDER the fixed wing at rest.
 *
 * It was `CONTROL_SURFACE_COVE`, 3 cm, which is right for an aileron because
 * an aileron only rotates. A Fowler flap TRANSLATES: at 0.3 m of aft travel a
 * 3 cm overlap becomes a 27 cm hole, and at the take-off setting the panels
 * hung behind the wing with open sky between the trailing edge and the flap —
 * the remaining half of the "glitchy" report.
 *
 * So the overlap has to exceed the travel. 0.34 m leaves 4 cm still tucked
 * under at FULL flap, and about 19 cm at the take-off setting. At rest the
 * whole overlap is hidden: the flap is a 6% section conformed into a 10% wing,
 * so its surfaces sit inside the fixed wing's envelope rather than on it.
 */
const FLAP_LEADING_OVERLAP = FLAP_AFT_TRAVEL + 0.04;

/**
 * THE FLAP BREAK SEAL.
 *
 * `TRAILING_EDGE` tiles the span with 80 mm slots on purpose — that is the
 * gap a real closed-up wing shows between flap segments — but a slot that
 * narrow is still a hole, and swept 23 degrees it is a hole a chase camera
 * looks straight down. Measured by ray-casting the built mesh from sixty
 * chase-like eye points (3 ranges x 5 elevations x 4 azimuths), the ONLY
 * daylight left anywhere between fixed wing and flap is this one break at
 * z = 6.22..6.30: 118 mm of apparent width at flaps 0, 314 mm at take-off.
 * Nothing leaks along the chord at any station or any angle.
 *
 * So it is sealed rather than closed: a dark plate on the inner flap's tip,
 * wide enough to stand behind the gap at every deflection. The two segments
 * hinge about lines swept 22.7 and 26.2 degrees, so they diverge slightly as
 * they go down, and the plate carries enough overlap to cover that.
 */
const FLAP_SEAL_SPAN = 0.14;

/** The cabin tube's sections, shared with the livery (`bizjetLivery.ts`), which is solved on them. */
const FUSELAGE_SECTIONS: readonly LoftSection[] = GLOBAL_FUSELAGE_SECTIONS;

/**
 * THE SCHEME is the livery image's (`bizjetLivery.ts`), not vertex colour.
 *
 * It was vertex colour on the body lofts, fin, tailplane, winglets and
 * nacelles, painted as functions of body coordinates so a line crossed a mesh
 * join without stepping. That rule survives in the image, which is solved in
 * body coordinates too. What did not survive was the cost: the colour channel
 * held the body material at 16 of 16 fragment inputs live and 17 in a
 * reflection or fog pass, and it drew at the mesh's resolution, a rib gap
 * lengthwise. The skin now wears the image on UV1, which costs no input.
 */
const LIVERY_SCHEME = GLOBAL_HOUSE_SCHEME;

interface WingSection {
  readonly leadingX: number;
  readonly trailingX: number;
  readonly hingeX: number;
  readonly chord: number;
  readonly thicknessRatio: number;
}

/** Linear interpolation, kept local so the planform reads as arithmetic. */
function mix(from: number, to: number, amount: number): number {
  return from + (to - from) * amount;
}

/**
 * The wing at one span station. Inboard of the root rib it keeps the root
 * section: that stub lives inside the wing-body fairing, and extending it
 * rather than tapering it to the centreline is what makes the gross area come
 * out at the published figure.
 */
function wingSection(spanZ: number): WingSection {
  const z = Math.min(WING_TIP_Z, Math.abs(spanZ));
  const inboard = z <= WING_KINK_Z;
  const fraction = inboard
    ? Math.max(0, (z - WING_ROOT_Z) / (WING_KINK_Z - WING_ROOT_Z))
    : (z - WING_KINK_Z) / (WING_TIP_Z - WING_KINK_Z);
  const leadingX = inboard
    ? mix(WING_ROOT_LEADING_X, WING_KINK_LEADING_X, fraction)
    : mix(WING_KINK_LEADING_X, WING_TIP_LEADING_X, fraction);
  const trailingX = inboard
    ? mix(WING_ROOT_TRAILING_X, WING_KINK_TRAILING_X, fraction)
    : mix(WING_KINK_TRAILING_X, WING_TIP_TRAILING_X, fraction);
  const thicknessRatio = inboard
    ? mix(WING_ROOT_THICKNESS, WING_KINK_THICKNESS, fraction)
    : mix(WING_KINK_THICKNESS, WING_TIP_THICKNESS, fraction);
  const chord = leadingX - trailingX;
  return {
    leadingX,
    trailingX,
    chord,
    thicknessRatio,
    hingeX: leadingX - WING_HINGE_CHORD_FRACTION * chord,
  };
}

/** Closed-trailing-edge NACA four-digit half-thickness, as the builder's. */
function nacaHalfThickness(chordFraction: number, thicknessRatio: number): number {
  const x = Math.min(1, Math.max(0, chordFraction));
  return 5 * thicknessRatio * (
    0.2969 * Math.sqrt(x)
    - 0.126 * x
    - 0.3516 * x * x
    + 0.2843 * x * x * x
    - 0.1036 * x * x * x * x
  );
}

/**
 * The wing's own skin, in the wing frame — the one surface every piece is cut
 * from. `upper` picks which side; the result is height above the chord plane.
 */
function wingSurfaceY(spanZ: number, x: number, upper: boolean): number {
  const section = wingSection(spanZ);
  const chordT = Math.min(1, Math.max(0, (section.leadingX - x) / section.chord));
  const camber = 4 * WING_CAMBER * chordT * (1 - chordT) * section.chord;
  const half = nacaHalfThickness(chordT, section.thicknessRatio) * section.chord;
  return camber + (upper ? half : -half);
}

/**
 * How much of the wing's own section a tucked flap nose is allowed to fill.
 *
 * A Fowler flap has to be overlapped by the fixed wing at rest or its
 * translation opens a hole, and the overlapping part therefore has to fit
 * INSIDE the wing rather than coincide with it. Coincident is not a smaller
 * problem than a hole, it is the same z-fighting this whole pass removed:
 * 0.34 m of flap sharing a surface with 0.34 m of wing, the full 7.7 m of
 * flapped span, on both wings.
 *
 * So the tucked part is shrunk about the chord plane, tapering to 0.45 of
 * the section at the nose.
 *
 * The ramp starts at 1.0 EXACTLY on the fixed trailing edge, and that is a
 * correction to a first attempt that started it at 0.80 to guarantee
 * clearance. A step at the trailing edge sounds harmless because it sits
 * under the wing — but the flap's chordwise vertices do not land on the
 * hinge line, so the step got interpolated across the segment that straddles
 * it and surfaced as a measured 17 mm dip in the flap's upper contour just
 * AFT of the hinge, where it is in plain sight. A continuous ramp has no
 * step to smear. As the flap runs out this taper becomes the flap's own
 * nose, which is what an extended Fowler flap shows in its slot.
 */
const FLAP_TUCK_SCALE_AT_EDGE = 1;
const FLAP_TUCK_SCALE_AT_NOSE = 0.45;

interface WingConform {
  /**
   * Shrink whatever lies forward of the fixed wing's trailing edge so it
   * nests inside the wing instead of sharing its skin. Flaps only.
   */
  readonly tucked?: boolean;
  /** Added to the mesh's own coordinates to reach the wing frame. */
  readonly offsetX: number;
  readonly offsetZ: number;
  /** Span range the HOST fixed panel uses, so texture rows line up across it. */
  readonly panelRootZ: number;
  readonly panelTipZ: number;
}

/**
 * Re-cuts a panel the airfoil builder has already made so that its section is
 * the wing's own section over the wing's FULL chord, evaluated where the panel
 * actually sits.
 *
 * This is the load-bearing repair in this file. The builder always closes its
 * section to a point at its own trailing edge, so a fixed panel that stops at
 * the 72% hinge line was pinched to nothing there and the flap behind it
 * ballooned back out to 30 mm — a measured 9.2 mm step out of contour on the
 * upper surface and 5.9 mm on the lower, at every hinge, plus a waisted wing
 * that no amount of texture work could hide. Rewriting y from the shared
 * section law leaves the fixed panel blunt at the hinge, exactly as thick as
 * the surface behind it, and drops both steps to zero by construction.
 *
 * It also rewrites the UVs, because the builder gives every mesh its own
 * 0..1 tile: the fuselage stretched one tile over 26 m while a spoiler packed
 * one into 0.8 m, so panel lines were thirty times finer on the small parts
 * and nothing lined up across a seam. Chordwise u becomes the TRUE chord
 * fraction and spanwise v the host panel's own span fraction, so a line that
 * crosses from wing to flap carries straight on.
 */
function conformToWingSection(mesh: Mesh, conform: WingConform): void {
  const positions = mesh.getVerticesData(VertexBuffer.PositionKind);
  const uvs = mesh.getVerticesData(VertexBuffer.UVKind);
  const indices = mesh.getIndices();
  const metadata = mesh.metadata as { chordSegments?: number; spanSegments?: number } | null;
  if (!positions || !uvs || !indices || !metadata?.chordSegments || !metadata.spanSegments) {
    throw new Error(`${mesh.name} is not an airfoil panel this pass can re-cut`);
  }
  // The builder emits the whole top surface, then the whole bottom one.
  const surfaceSize = (metadata.spanSegments + 1) * (metadata.chordSegments + 1);
  const spanRange = conform.panelTipZ - conform.panelRootZ;
  for (let vertex = 0; vertex < positions.length / 3; vertex += 1) {
    const x = positions[vertex * 3]! + conform.offsetX;
    const z = Math.abs(positions[vertex * 3 + 2]! + conform.offsetZ);
    const section = wingSection(z);
    // Forward of the fixed wing's trailing edge a flap is UNDER the wing, and
    // has to be strictly inside it rather than on it.
    const tuck = conform.tucked && x > section.hingeX
      ? mix(
        FLAP_TUCK_SCALE_AT_EDGE,
        FLAP_TUCK_SCALE_AT_NOSE,
        Math.min(1, (x - section.hingeX) / FLAP_LEADING_OVERLAP),
      )
      : 1;
    positions[vertex * 3 + 1] = wingSurfaceY(z, x, vertex < surfaceSize) * tuck;
    uvs[vertex * 2] = Math.min(1, Math.max(0, (section.leadingX - x) / section.chord));
    uvs[vertex * 2 + 1] = (z - conform.panelRootZ) / spanRange;
  }
  mesh.setVerticesData(VertexBuffer.PositionKind, positions, false);
  mesh.setVerticesData(VertexBuffer.UVKind, uvs, false);
  const normals: number[] = [];
  VertexData.ComputeNormals(positions, indices, normals);
  mesh.setVerticesData(VertexBuffer.NormalKind, normals, false);
  mesh.refreshBoundingInfo();
}

export function createBizJet(scene: Scene): AircraftVisual {
  const build = new AircraftBuildContext(scene);
  const root = new TransformNode("bombardier-global-8000", scene);
  configureRoot(root, "bizjet");

  // ONE paint recipe now, not two, and its livery colour is its base colour.
  //
  // That equality is the fix for what Jason actually reported. The shared
  // paint synthesis draws its `livery-decal` feature as a diagonal band in UV
  // space — `fract(u - 0.37v + 0.18)` near 0.5 — and every mesh was handed its
  // own 0..1 tile, so that one band became a different stripe on every part:
  // a navy helix winding round the fuselage and the radome, a spanwise slash
  // across each wing panel that jumped at the kink and again at every flap
  // edge, and a gold diagonal across the fin. Those were the misaligned
  // lines. They could not be aligned, because no choice of UVs makes one
  // diagonal band land correctly on forty differently-shaped parts at once.
  // Setting the livery colour equal to the base colour removes the band and
  // costs nothing: `mix(value, livery, decal)` becomes the identity, and the
  // panel lines, rivets, seams, filler, soot and leading-edge wear all stay.
  //
  // The real livery is the skin's image, below, where it can be put exactly
  // where the aeroplane wears it.
  //
  // Dropping the second recipe also drops three synthesized textures and a
  // material: the navy-and-gold control surfaces it painted are not on this
  // aeroplane. A Global's flaps, ailerons, rudder and elevator are the same
  // white as the wing they fold into, which is also why the wing now reads as
  // one surface instead of a mosaic of striped rectangles.
  const bodyRecipe = {
    seed: 0x6108_0001,
    baseColor: 0xf2f4f3,
    liveryColor: 0xf2f4f3,
    roughness: 0.29,
    metallic: 0.16,
    sootStrength: 0.34,
    wearStrength: 0.4,
    // Turned down for the fuselage, which this recipe was stretched over when
    // it was chosen; the fuselage now has the skin's recipe below, and the
    // wings and tail keep this one unchanged.
    panelStrength: 0.45,
  } as const;
  const body = build.paintMaterial("bizjet-body", bodyRecipe);
  /*
   * THE SKIN: the fuselage (the nose included) and the tailcone, wearing the livery image on
   * UV1 (`bizjetLivery.ts` for what it draws and why it is an image).
   *
   * Its RELIEF is the body recipe with every feature that belongs to a panel
   * turned off -- the grid, seam and rivets, the soot, the filler and the
   * leading-edge wear. The 64-pixel tile is laid ONCE over the 33.5 m body
   * (u is the station), so each of those is a half-metre smear: four dark
   * rings, a 28 m soot streak down the port flank, two 3 m filler patches and
   * a bare-metal radome. What stays is the paint grain, the recipe's finish.
   * Sharing the body's maps (`repaintMaterial`) would keep every one of them
   * in the normal map and the ambient-occlusion channel under the new colour.
   */
  const skin = build.liveryPaintMaterial("bizjet-skin", {
    ...bodyRecipe,
    panelStrength: 0,
    sootStrength: 0,
    fillerStrength: 0,
    rivetStrength: 0,
    wearStrength: 0,
  }, createGlobalLiveryTexture(scene, buildGlobalLiveryMips(LIVERY_SCHEME)));
  /** The nacelles in the scheme's colour, or in the body's own paint when it names none. */
  const nacellePaint = LIVERY_SCHEME.nacelle
    ? build.repaintMaterial(
      "bizjet-nacelle-paint",
      body,
      createSolidLiveryTexture(scene, LIVERY_SCHEME.nacelle, "bizjet-nacelle-livery"),
    )
    : body;
  const dark = build.material("bizjet-dark", 0x101b22, {
    roughness: 0.26,
    metallic: 0.4,
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
  // The screens' bezels, and nothing else now that the round dials are gone.
  // A real bezel is dark grey, so by day this is a dark-grey rim with a faint lit
  // edge: the base colour is dark and the emissive is a quarter of what it was
  // (0.7 -> 0.175). It stays on the marking material's glow path
  // (`applyGlow(instrumentMarking, ...)`), which scales it up at night.
  const instrumentMarking = build.material("bizjet-instrument-marking", 0x2b3237, {
    roughness: 0.5,
    metallic: 0,
    emissive: 0x4ba8c6,
    emissiveIntensity: 0.175,
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

  // 33.5 m from nose tip to tailcone, in two lofts: the tube with its nose
  // (one surface, `GLOBAL_FUSELAGE_SECTIONS`) and the upswept tailcone. Outside diameter 2.69 m —
  // the Global Express section, carried over unchanged, and the widest cabin
  // in the class. The centreline is body y = 0, which puts the belly at -1.345
  // and, with the main wheels contacting at -2.7, gives the ground clearance
  // the real aeroplane has under its wing-body fairing.
  //
  // MEASURED SHORTFALL: 33.5 m against the published 33.88. The last 0.38 m
  // is not available here — `sim/aircraft.ts` pins the radome contact points
  // at x = 15 and the tailcone contact at x = -18.5, and those are the ends
  // of this loft chain. That file is not mine to change.
  //
  // 48 radial segments, up from 28: the livery band below is painted into
  // these vertices, so the section's own resolution is the width of the
  // stripe's edge. 48 also stops the tube facetting where the light grazes it.
  const fuselage = build.loft(
    "bizjet-fuselage",
    FUSELAGE_SECTIONS,
    48,
    skin,
    root,
  );
  // The nose DROOPS: the sim's two radome contact points straddle y = -0.15,
  // not y = 0. That is the real shape — the flight deck sits on top of a
  // radome whose axis falls away from the cabin centreline — and it is most of
  // what stops a business jet nose reading as a fighter's. It is the same loft
  // as the cabin (phase 3c): a separate radome met the fuselage's capped end
  // at 13.2, and the cap's faces shaded the fuselage's last ring as though it
  // faced half forward, a crease round the nose under the windshield.
  // Upswept, ending at (-18.5, +0.62) where the sim puts its tailcone contact
  // point. The upsweep is what gives a long aeroplane its rotation angle
  // without dragging the tail, and on this type it also carries the APU.
  const tailcone = build.loft("bizjet-tailcone", GLOBAL_TAILCONE_SECTIONS, 48, skin, root);
  // The wing-to-body fairing, which on this aeroplane houses the wing box, the
  // main gear bays and the centre tank and is wider than the fuselage itself.
  // Its underside at y = -1.80 is what the belly beacon is mounted on; without
  // it the beacon at -1.75 would float 0.4 m clear of the skin.
  //
  // Carried aft to x = -7.3 and out to 1.78 half-width with the broader wing:
  // the root chord now runs to x = -2.07 and the inboard flap starts at
  // |z| = 1.52, so the fairing has to reach past both or the wing root and the
  // flap root stand proud of the belly instead of growing out of it.
  build.loft(
    "bizjet-belly-fairing",
    [
      { x: -7.3, yRadius: 0.26, zRadius: 0.52, yOffset: -1.06 },
      { x: -5.4, yRadius: 0.6, zRadius: 1.35, yOffset: -1.18 },
      { x: -2.6, yRadius: 0.78, zRadius: 1.78, yOffset: -1.13 },
      { x: 0.4, yRadius: 0.8, zRadius: 1.78, yOffset: -1.08 },
      { x: 3, yRadius: 0.66, zRadius: 1.5, yOffset: -1.04 },
      { x: 5.1, yRadius: 0.32, zRadius: 0.88, yOffset: -1 },
    ],
    24,
    body,
    root,
  );

  // ONE station coordinate for the whole body, so the fuselage and the
  // tailcone stop being separate 0..1 tiles meeting at a visible
  // discontinuity. The loft builder normalises u over each mesh's
  // OWN length; re-normalising over the aeroplane's 33.5 m is what lets one
  // livery image run unbroken nose to tail: a feature drawn at one u is at one
  // station on all three lofts.
  const { minimumX: BODY_MIN_X, length: BODY_LENGTH } = GLOBAL_LIVERY_STATION_RANGE;
  for (const loft of [fuselage, tailcone]) {
    const positions = loft.getVerticesData(VertexBuffer.PositionKind)!;
    const uvs = loft.getVerticesData(VertexBuffer.UVKind)!;
    for (let vertex = 0; vertex < positions.length / 3; vertex += 1) {
      uvs[vertex * 2] = (positions[vertex * 3]! - BODY_MIN_X) / BODY_LENGTH;
    }
    loft.setVerticesData(VertexBuffer.UVKind, uvs, false);
  }


  /*
   * THE CABIN WINDOWS: fourteen a side, each pane cast onto the fuselage's own
   * triangles and built ONCE (`bizjetCabinWindows.ts` has the row, the outline
   * and why). The pane before this was a thin-instanced 12-sided oval, bowed
   * to the section by writing into a buffer the GPU never received: every
   * test read a bowed pane, and the GPU drew a flat one cut off at y 0.19 in
   * every frame. `render.aircraft-vertex-buffer-writes` now fails that write
   * on any airframe.
   *
   * Twenty-eight panes, merged into one mesh: one draw, as the thin instances
   * were. No shadow: 6 mm of glass proud of the skin has nothing to cast.
   */
  const cabinCaster = new SkinCaster([{
    positions: fuselage.getVerticesData(VertexBuffer.PositionKind)!,
    indices: fuselage.getIndices()!,
    normals: fuselage.getVerticesData(VertexBuffer.NormalKind)!,
  }]);
  const cabinPanes: Mesh[] = [];
  for (const side of [1, -1] as const) {
    cabinWindowStations().forEach((station, index) => {
      const grid = cabinPaneGrid(cabinCaster, station, side);
      const pane = build.skinPanel(
        `${side > 0 ? "starboard" : "port"}-bizjet-cabin-window-${index + 1}`,
        grid.points,
        grid.normals,
        CABIN_PANE_PROUD,
        CABIN_PANE_DEPTH,
        dark,
        root,
      );
      pane.metadata = { ...pane.metadata, castsShadow: false };
      cabinPanes.push(pane);
    });
  }
  build.mergeStatic("bizjet-cabin-windows", cabinPanes, root);

  const wingSurfaces: AbstractMesh[] = [];
  const flaps: TransformNode[] = [];
  const speedBrakes: TransformNode[] = [];
  const ailerons: TransformNode[] = [];
  /** Every flap hinge with the rest pose its Fowler travel departs from. */
  const flapTravel: { node: TransformNode; restX: number; restY: number }[] = [];

  /**
   * The trailing edge, spanwise. The old layout left 0.45 m and 0.40 m holes
   * between the flap segments and a 0.45 m hole inboard of the inner flap, and
   * because the fixed panels stop at the 72% hinge line those holes were
   * BITES OUT OF THE PLANFORM — up to 1.4 m deep. That is where the missing
   * eight square metres went, and in plan view the trailing edge read as a row
   * of loose rectangles. These four pieces tile the whole span from the root
   * rib to the tip with 80 mm slots, which is the flap-track gap a closed-up
   * wing actually shows.
   */
  const TRAILING_EDGE = [
    { name: "inner-flap", rootZ: 1.46, tipZ: 6.22, hinged: true },
    { name: "outer-flap", rootZ: 6.3, tipZ: 9.18, hinged: true },
    { name: "aileron", rootZ: 9.26, tipZ: 14.22, hinged: true },
    { name: "tip", rootZ: 14.3, tipZ: WING_TIP_Z, hinged: false },
  ] as const;

  /**
   * The winglet, derived rather than styled — and derived from a constraint
   * this file does not own.
   *
   * `BIZJET_WASH` sites the navigation lamp at (-6.1, 0.35, +/-15.6) and the
   * strobe at (-6.2, 0.4, +/-15.7), and `tests/lighting.aircraft-wash.test.ts`
   * holds those to the lamp meshes. Metal therefore has to BE at those two
   * points. Measured against the winglet it replaces, the nav lamp floated
   * 60 mm clear of the nearest surface and the strobe 39 mm; the blend below
   * passes through both.
   *
   * Two panels, because a blended winglet genuinely is two: a shallow blend
   * off the tip at 42 degrees to the wing plane, then the fin proper at 70.
   * The single 57-degree blade this replaces met the tip at a corner.
   *
   * The root starts 60 mm inboard of the wing tip with a chord entirely inside
   * the wing's tip section, so the blunt root cap is buried rather than
   * crossing the tip cap in the open.
   */
  const WINGLET_ROOT_Z = WING_TIP_Z - 0.06;
  const WINGLET_BLEND_REACH = 0.86;
  const WINGLET_BLEND_RISE = 0.7732;
  const WINGLET_UPPER_REACH = 0.1123;
  const WINGLET_UPPER_RISE = 0.3086;

  /** 35 mm: a panel line's worth of edge, not a step. */
  const SPOILER_THICKNESS = 0.035;

  // STARBOARD IS BODY +Z. Every side loop in this file runs [1, -1] and calls
  // +1 starboard, so the name and the sign cannot drift apart the way they did
  // on the two older airframes — where `side < 0 ? "starboard" : "port"` put
  // the starboard wing at -Z and the ailerons answered the wrong command for
  // months. `tests/render.webgpu-control-surface-sides.test.ts` measures this
  // in world space, but the loop should be right without the test.
  for (const side of [1, -1] as const) {
    const sideName = side > 0 ? "starboard" : "port";

    /**
     * THE DIHEDRAL NODE, and the reason the whole wing hangs off one.
     *
     * Everything below is built FLAT, in a frame whose chord plane is y = 0,
     * and this node tilts the lot. That keeps the section law, the flap
     * hinges and the spoiler seating as plane arithmetic — none of them has
     * to know the wing is not level — and it guarantees that the flaps,
     * spoilers, aileron, winglet and flap tracks cannot drift out of the
     * dihedral one at a time, which is what would happen if each piece
     * carried its own rotation.
     *
     * The nav and strobe lamps deliberately do NOT hang here: their body
     * coordinates are transcribed in another file's wash table, so they stay
     * parented to the root and the winglet is shaped to reach them.
     */
    const wing = node(`${sideName}-bizjet-wing`, root, scene);
    wing.position.y = WING_CHORD_PLANE_Y - WING_ROOT_Z * Math.sin(WING_DIHEDRAL);
    wing.rotation.x = -side * WING_DIHEDRAL;

    const rootStation = wingSection(WING_ROOT_Z);
    const kinkStation = wingSection(WING_KINK_Z);
    const tipStation = wingSection(WING_TIP_Z);

    // Fixed wing, in two panels split at the flap break. Each stops at the
    // hinge line and is then re-cut by `conformToWingSection`, which is what
    // leaves it BLUNT there — as thick as the flap behind it — instead of
    // pinched to the knife edge the builder's own section law produces.
    const inboardWing = build.airfoilWing(
      `${sideName}-bizjet-inboard-wing`,
      {
        rootLeadingX: rootStation.leadingX,
        rootTrailingX: rootStation.hingeX,
        tipLeadingX: kinkStation.leadingX,
        tipTrailingX: kinkStation.hingeX,
        rootZ: side * WING_ROOT_Z,
        tipZ: side * WING_KINK_Z,
        thicknessRatio: WING_ROOT_THICKNESS,
        camberRatio: WING_CAMBER,
        chordSegments: 18,
        spanSegments: 4,
      },
      body,
      wing,
    );
    conformToWingSection(inboardWing, {
      offsetX: 0,
      offsetZ: 0,
      panelRootZ: WING_ROOT_Z,
      panelTipZ: WING_KINK_Z,
    });
    const outboardWing = build.airfoilWing(
      `${sideName}-bizjet-outboard-wing`,
      {
        rootLeadingX: kinkStation.leadingX,
        rootTrailingX: kinkStation.hingeX,
        tipLeadingX: tipStation.leadingX,
        tipTrailingX: tipStation.hingeX,
        rootZ: side * WING_KINK_Z,
        tipZ: side * WING_TIP_Z,
        thicknessRatio: WING_KINK_THICKNESS,
        camberRatio: WING_CAMBER,
        chordSegments: 18,
        spanSegments: 6,
      },
      body,
      wing,
    );
    conformToWingSection(outboardWing, {
      offsetX: 0,
      offsetZ: 0,
      panelRootZ: WING_KINK_Z,
      panelTipZ: WING_TIP_Z,
    });
    wingSurfaces.push(inboardWing, outboardWing);

    // The trailing edge: two Fowler flap segments, the outboard aileron and
    // the fixed tip panel behind the aileron. Every one of them is cut from
    // `wingSection` over the wing's FULL chord, so at rest its upper surface
    // IS the wing's upper surface carried on past the hinge. The measured
    // step this replaces was 9.2 mm up and 5.9 mm down at every flap.
    for (const piece of TRAILING_EDGE) {
      const pieceRoot = wingSection(piece.rootZ);
      const pieceTip = wingSection(piece.tipZ);
      // A translating flap is tucked far enough UNDER the fixed wing that it
      // is still overlapped at full travel; a rotating aileron needs only the
      // cove behind it, and a fixed panel neither.
      //
      // The signs are opposite and that is the whole point: +X is the nose,
      // so a flap's leading edge goes FORWARD of the hinge line to get under
      // the wing, and an aileron's goes AFT of it to leave a gap. Getting
      // this backwards put a 334 mm slot across the full flap span at flaps
      // 0 — measured, and visible as daylight from every angle above.
      const isFlap = piece.hinged && piece.name !== "aileron";
      const leadingEdgeAt = (station: WingSection): number => (isFlap
        ? station.hingeX + FLAP_LEADING_OVERLAP
        : station.hingeX - CONTROL_SURFACE_COVE);
      // The node sits ON the panel's own leading edge, so the panel has no
      // metal forward of its hinge. With the leading edge tucked 0.34 m under
      // the wing, a node left back at the hinge line would have swung that
      // overhang UP through the wing's upper skin as the flap went down.
      const hingeX = piece.hinged ? leadingEdgeAt(pieceRoot) : 0;
      const hingeZ = piece.hinged ? side * piece.rootZ : 0;
      const hinge = piece.hinged
        ? node(`${sideName}-bizjet-${piece.name}`, wing, scene)
        : wing;
      if (piece.hinged) hinge.position.set(hingeX, 0, hingeZ);
      // Inboard of the kink a piece rides the inboard panel's texture rows;
      // outboard of it, the outboard panel's. Sharing the host's span range
      // is what carries a spanwise line unbroken from wing to flap.
      const insideKink = piece.tipZ <= WING_KINK_Z;
      const surface = build.airfoilWing(
        `${sideName}-bizjet-${piece.name}-surface`,
        {
          rootLeadingX: leadingEdgeAt(pieceRoot) - hingeX,
          rootTrailingX: pieceRoot.trailingX - hingeX,
          tipLeadingX: leadingEdgeAt(pieceTip) - hingeX,
          tipTrailingX: pieceTip.trailingX - hingeX,
          rootZ: side * piece.rootZ - hingeZ,
          tipZ: side * piece.tipZ - hingeZ,
          thicknessRatio: 0.06,
          camberRatio: 0.01,
          chordSegments: 10,
          spanSegments: 3,
        },
        body,
        hinge,
      );
      conformToWingSection(surface, {
        tucked: isFlap,
        offsetX: hingeX,
        offsetZ: hingeZ,
        panelRootZ: insideKink ? WING_ROOT_Z : WING_KINK_Z,
        panelTipZ: insideKink ? WING_KINK_Z : WING_TIP_Z,
      });
      wingSurfaces.push(surface);
      if (!piece.hinged) continue;
      // The hinge LINE, which the deflection axis is taken from: it
      // runs from this piece's root station to its tip station along the
      // wing's swept hinge line, and each flap lies wholly inboard or wholly
      // outboard of the kink, so within a piece that line is straight.
      const rootStationHinge = wingSection(piece.rootZ);
      const tipStationHinge = wingSection(piece.tipZ);
      const alongX = tipStationHinge.hingeX - rootStationHinge.hingeX;
      const alongZ = side * (piece.tipZ - piece.rootZ);
      if (piece.name === "aileron") {
        // The aileron surface keeps the bare name the world-space side test
        // reads, and STARBOARD LANDS AT INDEX 0 because this loop runs +1
        // first: `applyCommonPose` drives `ailerons[0]` with the starboard
        // deflection and nothing downstream checks the name.
        surface.name = `${sideName}-aileron-surface`;
        hinge.name = `${sideName}-aileron`;
        ailerons.push(hinge);
      } else {
        flaps.push(hinge);
        flapTravel.push({ node: hinge, restX: hingeX, restY: 0 });
        if (piece.name === "inner-flap") {
          // The seal for the flap break (see `FLAP_SEAL_SPAN`). It hangs on
          // the INNER flap and reaches 60 mm into the outer flap's root, so
          // the two segments can hinge about their own differently swept
          // lines without ever parting company across the gap.
          //
          // Built as 140 mm MORE FLAP rather than as a plate: same section
          // law, same conform, same tuck, so it cannot stand proud of the
          // skin at the nose the way a constant-depth box does — the flap is
          // squeezed to 0.45 of the section there and a box is not. It wears
          // the dark paint, because what should show through an 80 mm slot
          // is a shadow line.
          //
          // Only this break. The outer flap meets the AILERON at 9.18, and
          // that break took no daylight at any of the sixty eye points — it
          // is further outboard, less swept, and a fixed plate for a surface
          // that deflects both ways would be a worse artefact than the gap.
          const sealTipZ = piece.tipZ + FLAP_SEAL_SPAN;
          const sealTip = wingSection(sealTipZ);
          const seal = build.airfoilWing(
            `${sideName}-bizjet-flap-break-seal`,
            {
              rootLeadingX: leadingEdgeAt(pieceTip) - hingeX,
              rootTrailingX: pieceTip.trailingX - hingeX,
              tipLeadingX: leadingEdgeAt(sealTip) - hingeX,
              tipTrailingX: sealTip.trailingX - hingeX,
              rootZ: side * piece.tipZ - hingeZ,
              tipZ: side * sealTipZ - hingeZ,
              thicknessRatio: 0.06,
              camberRatio: 0.01,
              chordSegments: 10,
              spanSegments: 1,
            },
            dark,
            hinge,
          );
          conformToWingSection(seal, {
            tucked: true,
            offsetX: hingeX,
            offsetZ: hingeZ,
            panelRootZ: WING_ROOT_Z,
            panelTipZ: WING_KINK_Z,
          });
        }
      }
      // Now that the panel (and its seal) hang off the hinge, point the hinge
      // at the line it actually turns about. `hingeAlong` owns the rest-pose
      // cancellation, so nothing above needs to know this happened.
      hingeAlong(hinge, new Vector3(alongX, 0, alongZ), scene);
    }

    // Flap track canoes. Fowler tracks long enough to move the panel aft as
    // well as down will not fit inside a 10% section, so the aeroplane wears
    // them externally, and their tails protrude well past the trailing edge.
    //
    // Lofted, not boxed. As boxes their protruding tails read as two bricks
    // stuck on the trailing edge — which is what a ray-pick through the close
    // three-quarter frame identified them as. Seated off the section law, so
    // the forward end is buried in the lower skin and only the tail shows.
    for (const track of [{ z: 3.2, half: 1.25 }, { z: 7, half: 1.1 }]) {
      const station = wingSection(track.z);
      const centre = station.hingeX - track.half * 0.56;
      const belly = wingSurfaceY(track.z, station.hingeX, false) - 0.09;
      build.loft(
        `${sideName}-bizjet-flap-track-${track.z < 5 ? "inner" : "outer"}`,
        [
          { x: centre - track.half, yRadius: 0.04, zRadius: 0.04, yOffset: belly, zOffset: side * track.z },
          { x: centre - track.half * 0.45, yRadius: 0.15, zRadius: 0.17, yOffset: belly, zOffset: side * track.z },
          { x: centre + track.half * 0.25, yRadius: 0.19, zRadius: 0.2, yOffset: belly, zOffset: side * track.z },
          { x: centre + track.half, yRadius: 0.08, zRadius: 0.09, yOffset: belly, zOffset: side * track.z },
        ],
        10,
        body,
        wing,
      );
    }

    /**
     * SPOILERS: three multifunction panels and, innermost, the ground
     * spoiler — the four-a-side the type carries.
     *
     * They are BURIED, and that is the headline repair in this pass. Built as
     * flat 35 mm slabs at a guessed constant y, they measured between 5.4 mm
     * and 177 mm clear of the wing skin they are supposed to lie in: at the
     * inboard end, white plates visibly hovering over the wing with daylight
     * under them, and at the outboard end a 5.4 mm gap, which is inside the
     * depth buffer's own resolution past about 80 m and therefore a z-fight
     * in every chase shot.
     *
     * Each panel is now tilted to the skin's chordwise slope and then sunk
     * until its top face clears the curved skin everywhere, so at rest it is
     * inside the wing and cannot be seen or fought with at any range. It is
     * also disabled outright below a deflection of a couple of milliradians
     * (see `update`), which makes the at-rest case unconditional.
     */
    for (const spoiler of [
      { name: "ground-spoiler", z: 3.1, span: 1.5, chord: 1.15 },
      { name: "one-spoiler", z: 4.8, span: 1.45, chord: 1.05 },
      { name: "two-spoiler", z: 6.5, span: 1.5, chord: 0.95 },
      { name: "three-spoiler", z: 8.2, span: 1.5, chord: 0.85 },
    ]) {
      const station = wingSection(spoiler.z);
      // The panel's aft edge stops just ahead of the flap cove, and its
      // forward edge is its own chord ahead of that — on the SWEPT hinge
      // line, so it meets the surface behind it at every station.
      const aftX = station.hingeX - CONTROL_SURFACE_COVE * 0.5;
      const forwardX = aftX + spoiler.chord;
      const tilt = Math.atan(
        (wingSurfaceY(spoiler.z, forwardX, true) - wingSurfaceY(spoiler.z, aftX, true))
        / spoiler.chord,
      );
      // And the SPANWISE slope too. Fitting only the chordwise one left the
      // panel having to sink by the whole spanwise drop of the skin across
      // its 1.5 m — measured at 180 mm, three times the intended burial, so
      // a deployed panel rose out of a slot instead of out of the skin.
      const midX = forwardX - spoiler.chord * 0.5;
      const spanTilt = Math.asin(Math.min(0.5, Math.max(-0.5,
        (wingSurfaceY(side * spoiler.z + spoiler.span * 0.5, midX, true)
          - wingSurfaceY(side * spoiler.z - spoiler.span * 0.5, midX, true))
        / spoiler.span)));
      const halfThickness = SPOILER_THICKNESS * 0.5;
      // How far the flat top face would have to drop to clear the curved
      // skin at every sampled corner. Sampled rather than reasoned about,
      // because "it should be close enough" is what produced the 177 mm.
      let clearance = Number.POSITIVE_INFINITY;
      for (let step = 0; step <= 8; step += 1) {
        const fromCentre = spoiler.chord * (0.5 - step / 8);
        const localX = -spoiler.chord * 0.5
          + fromCentre * Math.cos(tilt) - halfThickness * Math.sin(tilt);
        const alongChord = fromCentre * Math.sin(tilt) + halfThickness * Math.cos(tilt);
        for (const edge of [-0.5, -0.25, 0, 0.25, 0.5]) {
          const spanOffset = edge * spoiler.span;
          clearance = Math.min(
            clearance,
            wingSurfaceY(side * spoiler.z + spanOffset, forwardX + localX, true)
            - (alongChord - spanOffset * Math.sin(spanTilt)),
          );
        }
      }
      // Deep enough to stay under the depth buffer's resolution out to a few
      // hundred metres, shallow enough never to punch out through the lower
      // skin of a section that is only so thick.
      const sectionThickness = wingSurfaceY(spoiler.z, forwardX - spoiler.chord * 0.5, true)
        - wingSurfaceY(spoiler.z, forwardX - spoiler.chord * 0.5, false);
      const burial = Math.min(0.055, Math.max(0.02, (sectionThickness - SPOILER_THICKNESS) * 0.4));
      const brake = node(`${sideName}-bizjet-${spoiler.name}`, wing, scene);
      brake.position.set(forwardX, clearance - burial, side * spoiler.z);
      const panel = build.box(
        `${brake.name}-surface`,
        spoiler.chord,
        SPOILER_THICKNESS,
        spoiler.span,
        body,
        brake,
      );
      // Hinged at its FORWARD edge, so the panel lies entirely aft of the
      // node and a negative pose angle lifts its trailing edge into the air.
      // The tilt lives on the child because the node's own z rotation is the
      // brake deflection the pose owns every frame.
      panel.position.x = -spoiler.chord * 0.5;
      panel.rotation.z = tilt;
      panel.rotation.x = -spanTilt;
      speedBrakes.push(brake);
    }

    // The winglet: shallow blend off the tip, then the fin proper.
    const blendSpan = Math.hypot(WINGLET_BLEND_REACH, WINGLET_BLEND_RISE);
    const blend = build.airfoilWing(
      `${sideName}-bizjet-winglet-blend`,
      {
        rootLeadingX: -5.74,
        rootTrailingX: -6.86,
        tipLeadingX: -5.93,
        tipTrailingX: -6.95,
        rootZ: 0,
        // Overshoots the junction by 80 mm so the upper panel swallows the
        // blend's tip cap instead of the two meeting edge-on and leaving a
        // wedge of daylight between them.
        tipZ: side * (blendSpan + 0.08),
        thicknessRatio: 0.085,
        chordSegments: 12,
        spanSegments: 3,
      },
      body,
      wing,
    );
    blend.position.set(0, 0, side * WINGLET_ROOT_Z);
    blend.rotation.x = -side * Math.atan2(WINGLET_BLEND_RISE, WINGLET_BLEND_REACH);
    const upperSpan = Math.hypot(WINGLET_UPPER_REACH, WINGLET_UPPER_RISE);
    const upper = build.airfoilWing(
      `${sideName}-bizjet-winglet`,
      {
        rootLeadingX: -5.9,
        rootTrailingX: -6.98,
        tipLeadingX: -6.2,
        tipTrailingX: -6.8,
        rootZ: 0,
        tipZ: side * upperSpan,
        // Marginally fatter than the blend it takes over from, so the blend's
        // 80 mm overshoot stays inside it rather than poking out the flanks.
        thicknessRatio: 0.092,
        chordSegments: 12,
        // 6 rather than 2, for the gold line along the top edge: at two
        // segments the rings are 0.16 m apart on a 0.33 m panel, so a stripe
        // would have covered half the winglet. 0.055 m spacing makes it a line.
        spanSegments: 6,
      },
      body,
      wing,
    );
    upper.position.set(
      0,
      WINGLET_BLEND_RISE,
      side * (WINGLET_ROOT_Z + WINGLET_BLEND_REACH),
    );
    upper.rotation.x = -side * Math.atan2(WINGLET_UPPER_RISE, WINGLET_UPPER_REACH);
    wingSurfaces.push(blend, upper);
    // THE WINGLET is in the body's paint. The navy scheme's navy and gold here,
    // and the house scheme's gold tip, are part images to come (livery stage
    // 2b): vertex colour cannot come back, it is the fragment input the
    // livery image freed.

    // Landing lights in the wing roots, which is where this type carries them.
    // Seated on the section law like everything else on this wing, so the lens
    // sits in the leading-edge skin instead of near it.
    const lampZ = 1.95;
    const lamp = build.cylinder(
      side > 0 ? "starboard-landing-light" : "port-landing-light",
      0.03,
      0.34,
      0.34,
      10,
      landingLamp,
      wing,
    );
    lamp.rotation.z = Math.PI / 2;
    lamp.position.set(3.8, wingSurfaceY(lampZ, 3.8, false) + 0.015, side * lampZ);
    lamp.metadata = { ...lamp.metadata, castsShadow: false };
  }

  // THE T-TAIL. After its length this is the most recognisable thing about the
  // aeroplane, and the tailplane belongs at the TOP of the fin — mounted on
  // the fuselage it would be a different type entirely.
  //
  // The fin is an AEROFOIL now, not the 0.45 m constant-thickness slab it was.
  // A slab has hard square edges the light catches as two bright lines down
  // the leading and trailing edges, and its eight shared vertices make every
  // normal the average of six faces, so the flat flanks shaded as though they
  // were curved. Built flat like a wing and stood up by a quarter turn about
  // body X: the builder spans in Z, and after the rotation local Z is height.
  //
  // 48 degrees of leading-edge sweep from the vertical, and a tip at y = 6.2
  // because `sim/aircraft.ts` puts its fin contact point there.
  //
  // MEASURED OVERAGE, reported rather than fixed: that contact point makes the
  // aeroplane 9.2 m from pavement to fin tip against a published 8.2 m. The
  // fin is a metre too tall and cannot be shortened from this file.
  const FIN_ROOT_Y = 0.78;
  /*
   * 5.16, not 6.2. The tailplane bullet sits 0.34 m above this on a T-tail, so
   * a 6.2 fin put the tallest metal at 6.54 and the aeroplane at 9.24 m on its
   * wheels against a published 8.2. Dropping both this and TAILPLANE_Y by the
   * same 1.04 m lands the bullet at 5.50 and the overall height on 8.20.
   * Measured off the built mesh, not off these constants.
   */
  const FIN_TIP_Y = 5.16;
  const RUDDER_HINGE_ROOT_X = -15.35;
  const RUDDER_HINGE_TIP_X = -15.95;
  const fin = build.airfoilWing(
    "bizjet-vertical-stabilizer",
    {
      rootLeadingX: -9.2,
      rootTrailingX: RUDDER_HINGE_ROOT_X,
      tipLeadingX: -14.8,
      tipTrailingX: RUDDER_HINGE_TIP_X,
      rootZ: 0,
      tipZ: FIN_TIP_Y - FIN_ROOT_Y,
      thicknessRatio: 0.085,
      chordSegments: 12,
      // 24, not 4: chosen for the old vertex-paint livery, which was only as
      // sharp as the mesh (a ring on the navy's boundary at a third, 0.18 m
      // spacing). The livery is no longer vertex paint; the tessellation is
      // kept so the fin's shape and lighting do not move with it.
      spanSegments: 24,
    },
    body,
    root,
  );
  fin.rotation.x = -Math.PI / 2;
  fin.position.y = FIN_ROOT_Y;
  wingSurfaces.push(fin);
  // THE FIN is in the body's paint: its markings, like the winglets', are
  // part images to come (livery stage 2b), not vertex colour.

  const rudder = node("rudder", root, scene);
  rudder.position.set(RUDDER_HINGE_ROOT_X, FIN_ROOT_Y, 0);
  // The rudder is an aerofoil too, and hinged on the fin's own swept trailing
  // edge rather than crossing it: its leading edge follows the same line the
  // fin stops on, one cove behind. `render.webgpu-control-surface-sides` reads
  // the aftmost vertex, and at 0.24 rad a 0.95 m panel still travels 0.23 m.
  const rudderSurface = build.airfoilWing(
    "rudder-surface",
    {
      rootLeadingX: -CONTROL_SURFACE_COVE,
      rootTrailingX: -1.05,
      tipLeadingX: RUDDER_HINGE_TIP_X - CONTROL_SURFACE_COVE - RUDDER_HINGE_ROOT_X,
      tipTrailingX: RUDDER_HINGE_TIP_X - 0.62 - RUDDER_HINGE_ROOT_X,
      rootZ: 0,
      tipZ: FIN_TIP_Y - FIN_ROOT_Y,
      thicknessRatio: 0.07,
      chordSegments: 8,
      spanSegments: 3,
    },
    body,
    rudder,
  );
  // Applied to the CHILD, because the node's own Y rotation is the rudder
  // deflection the pose owns every frame.
  rudderSurface.rotation.x = -Math.PI / 2;
  wingSurfaces.push(rudderSurface);
  // And the rudder turns about the fin's RAKED trailing edge, not about true
  // vertical. The hinge leans 0.60 m aft over the fin's 4.38 m of height,
  // which is 7.8 degrees; swung about vertical, a panel built on that line
  // scythes through the fin on one side and opens a wedge on the other.
  yawHingeAlong(
    rudder,
    new Vector3(RUDDER_HINGE_TIP_X - RUDDER_HINGE_ROOT_X, FIN_TIP_Y - FIN_ROOT_Y, 0),
    scene,
  );

  // Tailplane on top of the fin. 10.8 m span, not 9.0: the Global Express
  // carries a stabiliser 34% of its wingspan and the 7500's aft fuselage and
  // empennage are a larger new design, so 34% of 31.7 m is the defensible
  // figure and the 9.0 m this replaces made the tail look undersized from
  // every head-on bearing. 5 degrees of ANHEDRAL, which is the Global
  // Express's, and 34 degrees of sweep rather than 25.
  const TAILPLANE_Y = 5.16;  // With FIN_TIP_Y above; the T-tail rides the fin.
  const TAILPLANE_TIP_Z = 5.4;
  const TAILPLANE_ANHEDRAL = (5 * Math.PI) / 180;
  const ELEVATOR_HINGE_ROOT_X = -16.05;
  const ELEVATOR_HINGE_TIP_X = -17.55;
  for (const side of [1, -1] as const) {
    const tailplane = build.airfoilWing(
      side > 0 ? "starboard-bizjet-tailplane" : "port-bizjet-tailplane",
      {
        rootLeadingX: -14.2,
        rootTrailingX: ELEVATOR_HINGE_ROOT_X,
        tipLeadingX: -17.05,
        tipTrailingX: ELEVATOR_HINGE_TIP_X,
        rootZ: side * 0.32,
        tipZ: side * TAILPLANE_TIP_Z,
        thicknessRatio: 0.09,
        camberRatio: 0.002,
        chordSegments: 12,
        spanSegments: 4,
      },
      body,
      root,
    );
    tailplane.position.y = TAILPLANE_Y;
    // Anhedral: the tip drops, so the sign is the opposite of the wing's.
    tailplane.rotation.x = side * TAILPLANE_ANHEDRAL;
    wingSurfaces.push(tailplane);
    // The tailplane is in the body's paint; the navy scheme's gold leading
    // edge is a part image to come (livery stage 2b).
  }
  // The bullet fairing over the fin/tailplane junction, and it is not
  // decoration: the fin tip is barely 0.13 m thick and BOTH the tailplane and
  // the elevator start at |z| = 0.32, so without it there is a slot down each
  // side of the fin top, open from x -14.2 clear through to the elevator
  // trailing edge. You can see sky through the tail. Every real T-tail carries
  // this fairing for the same reason — it is where the stabiliser's centre
  // structure and its trim actuator live — so the fix is the aeroplane's own
  // part rather than a patch. Sized to overlap both roots rather than merely
  // meeting them, and stopping short of the elevator's travel.
  build.loft(
    "bizjet-tailplane-bullet",
    [
      { x: -17.75, yRadius: 0.1, zRadius: 0.1, yOffset: TAILPLANE_Y },
      { x: -16.8, yRadius: 0.3, zRadius: 0.38, yOffset: TAILPLANE_Y },
      { x: -15.1, yRadius: 0.34, zRadius: 0.4, yOffset: TAILPLANE_Y },
      { x: -13.9, yRadius: 0.12, zRadius: 0.16, yOffset: TAILPLANE_Y },
    ],
    18,
    body,
    root,
  );

  // ONE HINGE NODE PER HALF. The tailplane is swept 34 degrees, so the two
  // halves hinge on lines that are mirror images of each other and no single
  // axis matches both: with one shared node the elevator turned 17.2 degrees
  // off its own hinge line, which is the tailplane's own sweep showing up as
  // a panel wrung out along its span.
  const elevators: TransformNode[] = [];
  for (const side of [1, -1] as const) {
    const elevator = node(
      side > 0 ? "starboard-elevator-hinge" : "port-elevator-hinge",
      root,
      scene,
    );
    elevator.position.set(ELEVATOR_HINGE_ROOT_X, TAILPLANE_Y, 0);
    // The anhedral moves from the SURFACE on to the hinge node, so that
    // `hingeAlong` carries it into the hinge direction rather than having to
    // be told about it. Same rotation about the same origin, so the rest pose
    // is unchanged; `hingeAlong` preserves it either way.
    elevator.rotation.x = side * TAILPLANE_ANHEDRAL;
    const surface = build.airfoilWing(
      side > 0 ? "starboard-bizjet-elevator-surface" : "port-bizjet-elevator-surface",
      {
        rootLeadingX: -CONTROL_SURFACE_COVE,
        rootTrailingX: -0.92,
        tipLeadingX: ELEVATOR_HINGE_TIP_X - CONTROL_SURFACE_COVE - ELEVATOR_HINGE_ROOT_X,
        tipTrailingX: ELEVATOR_HINGE_TIP_X - 0.5 - ELEVATOR_HINGE_ROOT_X,
        rootZ: side * 0.32,
        tipZ: side * TAILPLANE_TIP_Z,
        thicknessRatio: 0.07,
        chordSegments: 8,
        spanSegments: 3,
      },
      body,
      elevator,
    );
    wingSurfaces.push(surface);
    hingeAlong(elevator, new Vector3(
      ELEVATOR_HINGE_TIP_X - ELEVATOR_HINGE_ROOT_X,
      0,
      side * (TAILPLANE_TIP_Z - 0.32),
    ), scene);
    elevators.push(elevator);
  }

  /*
   * THE FLIGHT DECK: the type's six panes -- a windshield either side of the
   * centre post, and a forward and an aft side pane a side -- cast onto the
   * nose's own triangles (`bizjetGlazing.ts` has the outline and where it was
   * read). The glass was one raked box across the nose and a thick slab each
   * side, sunk into the skin so that what showed was wherever they cut it:
   * no posts, no pillars, and a band two-thirds the type's length.
   *
   * The panes are the cabin windows' dark, not glass: the glass material is
   * 71 % see-through, and what is behind a pane laid on the skin is the white
   * skin, so it read as a pale tint where the type reads black with the sky in
   * it. It never mattered from the seat, where the panes are hidden (below).
   * Merged into one mesh; the post is its own. Both are hidden from the seat,
   * where the kit lines them from inside. No shadow: a centimetre of glass has
   * nothing to cast.
   */
  const flightDeckCaster = new SkinCaster([fuselage].map((mesh) => ({
    positions: mesh.getVerticesData(VertexBuffer.PositionKind)!,
    indices: mesh.getIndices()!,
    normals: mesh.getVerticesData(VertexBuffer.NormalKind)!,
  })));
  const flightDeckPanes: Mesh[] = [];
  for (const side of [1, -1] as const) {
    for (const outline of GLOBAL_FLIGHT_DECK_OUTLINES) {
      const grid = paneGrid(
        flightDeckCaster,
        globalGlazingPane(outline),
        side,
        PANE_GRID,
        GLOBAL_FLIGHT_DECK_REFERENCE,
      );
      const pane = build.skinPanel(
        `${side > 0 ? "starboard" : "port"}-bizjet-flight-deck-window-${outline.name}`,
        grid.points,
        grid.normals,
        GLOBAL_PANE_PROUD,
        GLOBAL_PANE_DEPTH,
        dark,
        root,
      );
      pane.metadata = { ...pane.metadata, castsShadow: false };
      flightDeckPanes.push(pane);
    }
  }
  const flightDeckGlass = build.mergeStatic("bizjet-flight-deck-glazing", flightDeckPanes, root);
  // The centre post, cast the same way over the windshields' stations, so it
  // lies on the skin between them the whole way up. It is the dark strut it
  // replaces, now on the skin: the strut stood 0.2 m clear of the crown.
  const post = paneGrid(flightDeckCaster, globalCentrePostPane(), 1, 2, GLOBAL_FLIGHT_DECK_REFERENCE);
  const centrePost = build.skinPanel(
    "bizjet-windscreen-center-post",
    post.points,
    post.normals,
    GLOBAL_PANE_PROUD,
    GLOBAL_PANE_DEPTH,
    dark,
    root,
  );
  centrePost.metadata = { ...centrePost.metadata, castsShadow: false };

  // THE CREW SEATS, placed from the pilots' eye (`bizjetSeats.ts`): the cushion
  // 0.80 m under it, the back to the shoulders, the headrest behind the head. They
  // were a tilted box with its top at about 0.60 at fixed coordinates, which a
  // seated eye at 0.55 would have had over it.
  const seating = globalSeatPlacement();
  for (const side of [1, -1] as const) {
    const name = side > 0 ? "bizjet-captain" : "bizjet-first-officer";
    for (const [part, box] of [["seat", seating.base], ["seat-back", seating.back], ["headrest", seating.headrest]] as const) {
      const mesh = build.box(`${name}-${part}`, box.length, box.height, box.width, interior, root);
      mesh.position.set(box.x, box.y, side * seating.z);
      mesh.metadata = { ...mesh.metadata, cockpitInterior: true, castsShadow: false };
    }
  }
  // The window frame's lining, the panel, its lip and the four flat screens are
  // COCKPIT-ONLY parts, built in `cockpit/bizjetCockpit.ts` from the pilot's
  // left-seat eye, the lining cast with the glass's own caster so its edges are
  // the panes'. `configureCockpitOnlyParts` makes them invisible until cockpit
  // view is entered and never a shadow caster.
  const cockpit = buildBizjetCockpit(build, root, {
    interior,
    instrumentFace,
    instrumentMarking,
  }, flightDeckCaster);
  const cockpitOnlyParts = cockpit.parts;
  configureCockpitOnlyParts(cockpitOnlyParts);
  // The displays redraw only while cockpit view is on: outside it every cockpit part
  // is invisible, and the visual already gets the whole state every frame.
  let cockpitViewOn = false;

  // THE ENGINES. Two GE Passport 20s on pylons off the REAR FUSELAGE, not
  // under the wing — this is a rear-engined aeroplane and hanging them under a
  // low wing would put the fan a foot off the runway.
  //
  // Resized to the published engine. The Passport's fan blisk is 1.32 m across
  // and the bare engine's maximum envelope is 1.38 m wide, which puts a
  // long-duct mixed-flow cowl at about 1.75 m of external diameter and 4.9 m
  // long. The nacelles here were 2.10 m across and 4.0 m long — a fifth too
  // fat and a fifth too short, which is most of why the tail end read as two
  // barrels rather than two engines. Centreline y = +0.75, z = +/-2.30, from
  // the roughly 4.6 m centreline separation the three-view scales to.
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
        { x: -14.05, yRadius: 0.55, zRadius: 0.55, yOffset: 0.75, zOffset: side * 2.3 },
        { x: -13.2, yRadius: 0.72, zRadius: 0.72, yOffset: 0.75, zOffset: side * 2.3 },
        { x: -12.1, yRadius: 0.85, zRadius: 0.85, yOffset: 0.75, zOffset: side * 2.3 },
        { x: -10.8, yRadius: 0.875, zRadius: 0.875, yOffset: 0.75, zOffset: side * 2.3 },
        { x: -9.9, yRadius: 0.86, zRadius: 0.86, yOffset: 0.75, zOffset: side * 2.3 },
        // Stops at -9.35, not -9.15. The loft caps its forward end with a
        // flat disc, the intake ring below caps ITS forward end with another,
        // and both face the same way: at 40 mm apart and 1.6 m across they
        // were inside the depth buffer's resolution from about 220 m, which
        // the two-centimetre dolly probe caught as a pair of flickering
        // blobs on the front of the engines. 240 mm of separation, and the
        // ring is wider here than the cap, so the cap is simply hidden.
        { x: -9.35, yRadius: 0.78, zRadius: 0.78, yOffset: 0.75, zOffset: side * 2.3 },
      ],
      28,
      nacellePaint,
      root,
    );
    // THE NACELLE in the scheme's colour (white, the body's paint, in the house
    // scheme). The intake ring in front of it is a separate mesh and keeps its
    // bright metal, which is what gives the engine its lip.
    // FLIPPED NORMALS, and the only mesh on this aeroplane that had them.
    // `verticalProfile` extrudes whatever outline it is handed and does not
    // reverse the winding, so the orientation is decided by the order of the
    // four points. The fin's outline ran clockwise in the x/y plane and was
    // right; this one ran counter-clockwise, so both pylons were built inside
    // out — back faces culled, the far wall drawn instead of the near one and
    // lit by normals pointing into the structure. Measured by ray-casting the
    // flank and reading the hit triangle's own normal: n.d = +1.0 against
    // every other mesh's -1.0. The points below are simply reversed.
    const pylon = build.verticalProfile(
      `${sideName}-bizjet-engine-pylon`,
      [
        { x: -10.2, y: 0.42 },
        { x: -12.4, y: 0.42 },
        { x: -12.8, y: 1.15 },
        { x: -9.8, y: 1.15 },
      ],
      1.2,
      body,
      root,
    );
    pylon.position.z = side * 1.72;
    // The intake, and it has to read as a HOLE. The real aeroplane's lip is
    // polished metal, and building it that way was a mistake worth recording:
    // `build.cylinder` closes its ends, so a metal inlet turns the intake
    // into a two-metre polished disc reflecting the sky — a pale blue lollipop
    // on the front of each engine, which is exactly the "verified by numbers,
    // wrong on screen" failure this pass is about. Dark wins; the polished
    // lip would need a ring primitive this builder does not have.
    //
    // Long and pushed AFT so its rear face is a half-metre inside the cowl.
    // It used to be a 0.26 m ring whose flat back sat 30 mm behind the
    // nacelle's own flat end cap — two parallel two-metre discs, 30 mm apart,
    // which is inside the depth buffer's resolution from about 200 m out.
    const inlet = build.cylinder(
      `${sideName}-bizjet-engine-inlet`, 0.62, 1.5, 1.72, 24, dark, root);
    inlet.rotation.z = Math.PI / 2;
    inlet.position.set(-9.42, 0.75, side * 2.3);
    // Long-duct mixed-flow: one common nozzle, no exposed core. Its forward
    // rim is deliberately WIDER than the cowl's last section (0.58 against
    // 0.55), so it caps the loft's flat white end disc rather than sitting
    // inside it and leaving a bright ring round the exhaust.
    const nozzle = build.cylinder(
      `${sideName}-bizjet-exhaust-nozzle`, 0.58, 0.8, 1.16, 22, hotMetal, root);
    nozzle.rotation.z = Math.PI / 2;
    nozzle.position.set(-14.3, 0.75, side * 2.3);
    // The exhaust is a HOLE. Without this the nozzle's own flat end cap is
    // what a chase camera sees: a polished metal disc reflecting the sky,
    // which reads as a lavender lollipop on the back of each engine in every
    // frame from behind. A dark cone receding into the duct reads as depth,
    // and being a cone it is parallel to nothing and cannot fight the rim.
    const core = build.cylinder(
      `${sideName}-bizjet-exhaust-core`, 0.5, 0.26, 0.76, 18, dark, root);
    core.rotation.z = Math.PI / 2;
    // 140 mm behind the nozzle's own aft rim, for the same depth-resolution
    // reason as the intake: two aft-facing discs 60 mm apart is a coin toss
    // at chase range.
    core.position.set(-14.48, 0.75, side * 2.3);

    // The rotating assembly. On a turbofan this is the fan and the spool
    // behind it, the same thing the sport jet exposes as its compressor: the
    // node spins about body X through its OWN origin, which is why each fan
    // gets a node at its own centreline rather than one node at the aircraft
    // centreline — that one would swing both fans around the fuselage.
    //
    // 1.32 m across, which is the Passport 20's published blisk diameter; the
    // 1.86 m fan this replaces was wider than the real engine's whole cowl.
    // Sited well down the duct, behind the dark intake ring and clear of it:
    // the fan face is another disc, and every disc on this engine has to be
    // far enough from the next one to beat the depth buffer at chase range.
    const spool = node(`${sideName}-bizjet-fan-spool`, root, scene);
    spool.position.set(-9.95, 0.75, side * 2.3);
    const fanFace = build.cylinder(`${spool.name}-fan`, 0.08, 1.2, 1.32, 18, hub, spool);
    fanFace.rotation.z = Math.PI / 2;
    const spinner = build.cylinder(`${spool.name}-spinner`, 0.34, 0.02, 0.3, 10, dark, spool);
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
  // These five stay parented to the ROOT rather than to the dihedral nodes,
  // deliberately: their body coordinates are transcribed in another file's
  // table, so moving them is not this file's call. The winglet is shaped to
  // reach them instead — its blend passes exactly through the nav point, where
  // measurement put that lamp 60 mm clear of the nearest metal before.
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
  // The landing lights are built with the wing, above: they belong to the
  // wing roots and have to carry the dihedral with everything else there.

  const rig: BizJetRig = {
    root,
    // The contract carries ONE rotating assembly and a twin has two. The
    // starboard spool is the one it names; both are driven from the same
    // simulation-time phase below, so they can never be seen out of step.
    propeller: fanSpools[0]!,
    // THE GLASS THE PILOT SITS BEHIND. The six flight-deck panes are opaque
    // from inside, as the glass boxes before them were (they drew as flat
    // opaque slabs). The radome used to be here too: a separate capped loft
    // whose rear cap faced the pilot as a black disc across the windscreen.
    // The nose is the fuselage's own loft now (phase 3c), with no cap inside it.
    //
    // The CENTRE POST is here too: it is cast onto the skin 12 mm proud and
    // 30 mm deep, and from the seat that is a slab end-on across the
    // windscreen. The kit lines it from inside on the same grid, as the 747's
    // does (`buildBizjetCockpit`).
    //
    // The fuselage is NOT here: the eye is inside the fuselage shell (0.34 m
    // of skin above it, 0.48 m to the port wall since phase 3c widened the
    // nose) and back-face culling hides the shell from inside, so it draws
    // nothing of itself. What replaces the hidden glass's framing is built as
    // cockpit-only parts: see `buildBizjetCockpit`.
    cockpitParts: [flightDeckGlass, centrePost],
    cockpitOnlyParts,
    wingSurfaces,
    // Starboard first, because the side loop runs +1 first and
    // `applyCommonPose` drives `ailerons[0]` with the starboard deflection.
    ailerons: [ailerons[0]!, ailerons[1]!],
    /** No flaperons: this airframe's flaps and ailerons are separate surfaces. */
    flaperons: [],
    elevators,
    rudder,
    noseSteer,
    flaps,
    mainWheels,
    noseWheel,
    landingGear,
    gearDoors,
    speedBrakes,
  };
  // NO part on the paint materials carries a colour channel. They all did --
  // a white one filled in here so a merge by material could not drop the
  // livery's -- and that channel was the body material's 16th fragment input
  // live and the 17th in a reflection or fog pass. The livery is an image now
  // (`bizjetLivery.ts`), and `render.bizjet-livery` fails if a colour channel
  // reaches any mesh the body or the skin paints.
  configureCockpitLayers(rig.cockpitParts);
  let disposed = false;
  return {
    kind: "bizjet",
    handedness: "right",
    group: root,
    root,
    propeller: rig.propeller,
    cockpitParts: rig.cockpitParts,
    cockpitOnlyParts: rig.cockpitOnlyParts ?? [],
    displaysLive: cockpit.displaysLive,
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
      if (cockpitViewOn) cockpit.update(state, delta);
      landingGear.setEnabled(pose.gearVisible);
      landingGear.scaling.set(pose.gearScale.x, pose.gearScale.y, pose.gearScale.z);
      landingGear.position.y = pose.gearOffsetY;
      rig.gearDoors.forEach((door, index) => {
        door.rotation.x = (index === 1 ? -1 : 1) * pose.gearDoorTravel;
      });
      // FOWLER TRAVEL. `applyCommonPose` has just set each flap's hinge
      // rotation, which is the whole of what the shared contract knows how to
      // do — and a flap that only rotates is a plain hinged flap. A Global's
      // flaps run aft on tracks as they go down, which is where most of the
      // area they add comes from, and at 30 degrees the difference is a
      // quarter of a metre of chord: the aeroplane visibly grows its wing.
      // The two segments share one fraction, so they move as one family.
      const flapFraction = pose.flap / FULL_FLAP_RADIANS;
      for (const track of flapTravel) {
        track.node.position.x = track.restX - FLAP_AFT_TRAVEL * flapFraction;
        track.node.position.y = track.restY - FLAP_DOWN_TRAVEL * flapFraction;
      }
      // The spoiler panels live INSIDE the wing at rest (see their seating).
      // Switching them off below a couple of milliradians makes that
      // unconditional rather than merely deep enough: at rest there is no
      // panel to z-fight with the skin at any distance, and because the
      // threshold is crossed while the panel is still buried, nothing pops.
      const braking = Math.abs(pose.speedBrake) > 0.002;
      for (const speedBrake of rig.speedBrakes) {
        speedBrake.setEnabled(braking);
        speedBrake.rotation.z = pose.speedBrake;
      }
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
      // on the way IN, the displays redraw on the first frame: their clock stopped when the pilot left
      if (enabled && !cockpitViewOn) cockpit.invalidateDisplays();
      cockpitViewOn = enabled;
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
