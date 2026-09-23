import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import type { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh";
import type { Mesh } from "@babylonjs/core/Meshes/mesh";
import type { PBRMaterial } from "@babylonjs/core/Materials/PBR/pbrMaterial";
import type { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import { aircraftSpec } from "@/src/aircraft/catalogue";
import type { FlightVisualState } from "@/src/game/types";
import {
  FLIGHT_DECK_PANES,
  FLIGHT_DECK_REFERENCE,
  CENTRE_POST_HALF_AZIMUTH,
  sightline,
  type FlightDeckPane,
  type Point3,
  type SkinCaster,
} from "../airlinerGlazing";
import type { AircraftBuildContext } from "../builders";
import { glareshieldMaterial, solidPlate } from "./cockpitPrimitives";
import {
  AIRLINER_DISPLAYS,
  createDisplayAtlas,
  displayAtlasHeight,
  displayAtlasWidth,
  displayMaterial,
  displayRedrawClock,
  displaySlots,
  paintDisplays,
  remapScreenFaceToSlot,
  type DisplayAtlas,
} from "./displays/displayAtlas";
import { displayStateFromVisual, type DisplayAirframe } from "./displays/displayStateFromVisual";

/**
 * What a pilot in the 747-8's LEFT seat sees, built to the glass as it is built.
 *
 * THE GLASS IS CAST, AND SO IS THE FRAME ROUND IT. The flight-deck panes are windows of sky
 * specified by azimuth and elevation from a reference R on the centreline and cast onto the
 * nose's own triangles (`airlinerGlazing.ts`, docs/findings/AIRLINER_NOSE_GLAZING.md). The shell
 * and the glazing are hidden from the cockpit camera, so everything that frames the view is
 * built here as COCKPIT-ONLY parts (`CommonRig.cockpitOnlyParts`), invisible from any other camera
 * and never a shadow caster. The frame between, above and below the panes is the same cast: a
 * LINING, one `skinPanel` per rectangle of R's sky that is not glass, laid on the same skin from the
 * same reference at the panes' own depth. Its edges therefore ARE the panes' edges, by construction
 * and at every point of them, rather than plates placed against copied corners: the No.1 / No.2
 * pillar is the strip between azimuths 24 and 26, the crown lining starts at No.1's +12, and a
 * re-loft of the nose moves the frame with the glass. The centre post is lined the same way: the
 * plane engineer's post (+-`CENTRE_POST_HALF_AZIMUTH`, filling the gap between the No.1 panes) is
 * the glass's own 0.10 m slab, and against a 2 cm lining it stood 4.8 cm into the cabin with its
 * end and side faces showing, so it is hidden from the cockpit camera with the shell and the glass,
 * and the kit's lining covers its place, one tone with the pillars.
 *
 * THE EYE, (29.85, 2.93, -0.50), was chosen on a grid of candidate eyes against the built glass
 * (the K0 table in docs/findings/COCKPIT_VIEW_2026_09_20.md): 0.50 m off the centreline, as the
 * type's seat spacing puts the captain; straight ahead in the middle third of the port No.1
 * pane's azimuth span (No.1 reads -8.8..+11.6 at the horizon, against the glass as the eye was chosen);
 * No.1's opening 30.4 degrees; the glass 1.90 m ahead. It keeps the old eye's HEIGHT: the pilot's
 * eye height is the constant when the seat moves inboard, and the crown there is higher.
 *
 * THE TARGETS, as angles from the eye at the 75 degree lens (16:9, so the frame's bottom reads
 * -23.35 straight ahead):
 *  - the glareshield's lip reads -18.57 straight ahead, the LOWEST line that leaves no more than 1
 *    degree of sill between itself and the bottom of the view over No.1 (the sill's own top edge)
 *    anywhere along it. It stands FLUSH with the panel's face, and the screens hang 0.25 degrees
 *    under it, so 37.8% of each screen in the top row is in the frame;
 *  - above the lip the SILL, the bottom of the window frame, runs on to each pane's bottom edge, so
 *    no band of the hidden nose shows between them. It is frame, not deck: on the interior material
 *    with the crown and the pillars, a lighter window surround over a dark hood, as the type has it.
 *    The deck proper is the lip alone, one straight row across the frame, and that row is what
 *    `catalogue.cockpitDeckLineDegrees` records (the 2D HUD keeps above it);
 *  - the screens are the type's layout: each pilot's PFD straight ahead of them and their ND
 *    inboard of it, the upper EICAS on the centreline and the lower one under it.
 *
 * Body coordinates: +X nose, +Y up, +Z starboard, so the pilot's seat is at negative Z.
 */

const DEG = Math.PI / 180;

export interface AirlinerCockpitMaterials {
  /**
   * Dark matte interior: the panel board and the whole window frame (sills, crowns, pillars and the gaps by the
   * post), which are one structure and one draw state. (The glareshield's lip has its own: `glareshieldMaterial`.)
   * A material with no ambient light reads (0, 0, 0) on any face the sun misses: a hole in the picture beside a lit
   * ceiling. This one is the flight deck's own, the seats' material.
   */
  readonly interior: PBRMaterial;
  readonly instrumentFace: PBRMaterial;
  /** Bezels. It carries the night glow (`applyGlow(instrumentMarking, ...)`), so it must be the shared one. */
  readonly instrumentMarking: PBRMaterial;
}

function eye(): { forward: number; up: number; right: number } {
  return aircraftSpec("airliner").cockpitEye;
}

// ---- the seats -----------------------------------------------------------------

/**
 * The seats stand 0.05 m aft of the pilot's eye in x (seat centre `forward - 0.05`)
 * and their highest corner 0.15 m below it, as the Global's do, and the headrests
 * keep their old place relative to the seat. Both pairs are symmetric about the
 * centreline, each under its pilot's eye (`airlinerSeatPlacement().z`); the pilot's
 * is the PORT one, which is the mesh NAMED first-officer.
 */
export const AIRLINER_SEAT = Object.freeze({
  behindEye: 0.05,
  topBelowEye: 0.15,
  length: 0.62,
  height: 0.8,
  width: 0.58,
  /** Rotation about Z, radians; the seat leans back, its rear-top corner the highest. */
  tilt: -0.07,
  headrestBehindSeat: 0.42,
  headrestAboveSeat: 0.48,
  headrestLength: 0.24,
  headrestHeight: 0.4,
  headrestWidth: 0.46,
});

/** Where the seat and its headrest go, in body x and y, and each seat's distance from the centreline: the eye's. */
export function airlinerSeatPlacement(): { seatX: number; seatY: number; headrestX: number; headrestY: number; z: number } {
  const e = eye();
  const s = AIRLINER_SEAT;
  // the highest corner of a box tilted about Z is its rear-top one
  const rise = (s.height / 2) * Math.cos(s.tilt) + (s.length / 2) * Math.sin(-s.tilt);
  const seatX = e.forward - s.behindEye;
  const seatY = e.up - s.topBelowEye - rise;
  return { seatX, seatY, headrestX: seatX - s.headrestBehindSeat, headrestY: seatY + s.headrestAboveSeat, z: Math.abs(e.right) };
}

// ---- the panel and its glareshield ------------------------------------------------

export const AIRLINER_PANEL = Object.freeze({
  /**
   * The pilot-facing face of the board is this far ahead of the eye: the top of the type's range. At 0.75 the
   * top row of screens would be 31.7% in the frame, at 0.85 it is 37.8%: the lip and the frame's bottom are angles,
   * so the band between them is the same number of degrees at any distance, and a screen further away is fewer
   * degrees tall, so more of it fits in that band.
   */
  faceAheadOfEye: 0.85,
  /**
   * The board stands this deep behind its face. No deeper: its top edge's far corner must stay under the sight
   * line over the lip, which falls 0.3359 m a metre (tan 18.57), and the lip is 0.02 above the board's top.
   */
  thickness: 0.05,
  /**
   * Half its width. The shell's OUTER half-width where the board stands (x 30.70..30.75, y 2.2..2.65) is 1.44 m
   * or more, measured as the last crossing of a ray from the centreline; the frame needs 1.152 on the pilot's
   * side at the face (tan 37.5 x 0.85, from z -0.50).
   */
  halfWidth: 1.3,
  /** Below the frame at every azimuth: the frame's bottom crosses the face's plane at y 2.566. */
  bottomY: 2.2,
});

export function airlinerPanelFaceX(): number {
  return eye().forward + AIRLINER_PANEL.faceAheadOfEye;
}

/**
 * THE GLARESHIELD: a lip along the top of the panel's face, flush with it, and nothing aft of it.
 *
 * Its top edge is a line along z at the face's x, and it reads `lipElevationDegrees` straight ahead. That is the
 * LOWEST such line that keeps the sill -- the strip between the lip and the bottom of the view over No.1 -- no
 * more than 1 degree tall anywhere along No.1. The bottom of the view is the sill lining's own top edge (its rim's
 * outer edge, 0.008 out of the skin; the glass is not drawn), which reads -17.41 at No.1's inboard end (az +8.0)
 * and -18.66 at its outboard end (az -11.8), and a line along z reads shallower off axis, so the sill is 0.99
 * degree at the inboard end and the lip stands 0.45 degree over the window at the outboard end. Solved against
 * the BUILT lining and held to it by `tests/render.cockpit-airliner.test.ts`. (With the lining the glass's own
 * 0.10 m slab, its top edge stood 0.04 out, read 0.5 degree higher, and the lip was -18.04.)
 *
 * Its section is a WEDGE, not a box: the aft face 0.02 tall, the top falling away forward over `depth` steeper
 * than the sight line over the lip (21.8 degrees against 18.57), so from the eye nothing of the glareshield or the
 * board behind it shows above the lip, and the lip is the line the pilot reads. A box's far top corner would stand
 * 1.7 cm over that sight line and become the edge instead.
 *
 * Being a line along z, the lip is ONE row of the picture across the whole frame, and it is the deck's top: the
 * value `catalogue.cockpitDeckLineDegrees` records and the 2D HUD keeps above.
 */
export const AIRLINER_GLARESHIELD = Object.freeze({
  lipElevationDegrees: -18.57,
  thickness: 0.02,
  depth: AIRLINER_PANEL.thickness,
});

/** The height of the lip: its edge at the face reads `lipElevationDegrees` straight ahead. */
export function airlinerLipY(): number {
  const e = eye();
  return e.up + Math.tan(AIRLINER_GLARESHIELD.lipElevationDegrees * DEG) * (airlinerPanelFaceX() - e.forward);
}

// ---- the screens -------------------------------------------------------------------

/** What the displays need that the flight state does not carry: four engines, 30 degrees of flap (`animation.ts`'s own table). */
export const AIRLINER_DISPLAY_AIRFRAME: DisplayAirframe = Object.freeze({ engineCount: 4, fullFlapDegrees: 30 });

export const AIRLINER_SCREENS = Object.freeze({
  width: 0.22,
  height: 0.15,
  bezel: 0.01,
  /** Centre to centre of neighbours across a row. The bezels leave 5 mm between them. */
  pitch: 0.245,
  /** The top row's top edge reads this far below the glareshield's underside at the face. */
  belowGlareshieldDegrees: 0.25,
  /** Between the upper EICAS's bezel and the lower one's. */
  rowGap: 0.005,
  bezelThickness: 0.007,
  screenThickness: 0.003,
});

/**
 * The type's layout, in the SLOT order of `AIRLINER_DISPLAYS`: each pilot's PFD straight ahead of their own eye,
 * their ND one pitch inboard, the two EICAS on the centreline, upper over lower. The names are the slot table's, which the
 * atlas digest pins: "port-eicas" is the UPPER EICAS and "starboard-eicas" the LOWER, the pair that stood side by
 * side about the old seats at +-0.72.
 *
 * `z` takes the seat's distance from the centreline (the pilot's eye's) and the pitch; `row` 1 is the lower EICAS's.
 */
const SCREEN_LAYOUT: readonly { readonly name: string; readonly z: (seat: number, pitch: number) => number; readonly row: 0 | 1 }[] = [
  { name: "port-pfd", z: (seat) => -seat, row: 0 },
  { name: "port-nd", z: (seat, pitch) => -seat + pitch, row: 0 },
  { name: "port-eicas", z: () => 0, row: 0 },
  { name: "starboard-eicas", z: () => 0, row: 1 },
  { name: "starboard-nd", z: (seat, pitch) => seat - pitch, row: 0 },
  { name: "starboard-pfd", z: (seat) => seat, row: 0 },
];

/** The plane the screens' front stands in: 1 mm in front of the bezel's front face. */
function screenFrontX(): number {
  return airlinerPanelFaceX() - AIRLINER_SCREENS.bezelThickness;
}

/** Height of the top row's top edge, solved from the glareshield's underside at the face. */
export function airlinerScreenTopY(): number {
  const e = eye();
  const underside = Math.atan2(airlinerLipY() - AIRLINER_GLARESHIELD.thickness - e.up, airlinerPanelFaceX() - e.forward);
  return e.up + Math.tan(underside - AIRLINER_SCREENS.belowGlareshieldDegrees * DEG) * (screenFrontX() - e.forward);
}

export function airlinerScreenPlacements(): readonly { name: string; centre: Vector3 }[] {
  const s = AIRLINER_SCREENS;
  const seat = Math.abs(eye().right);
  const topRow = airlinerScreenTopY() - s.height / 2;
  const rowDrop = s.height + s.bezel * 2 + s.rowGap;
  const x = screenFrontX() + s.screenThickness / 2;
  return SCREEN_LAYOUT.map(({ name, z, row }) => ({ name, centre: new Vector3(x, topRow - row * rowDrop, z(seat, s.pitch)) }));
}

// ---- the frame: the lining cast on the skin round the glass ----------------------------------

/**
 * How far below and above the glass the lining runs, in R's elevation (past the frame's edges from the eye, with
 * room), the widest step between its grid lines (`airlinerLiningLines`), and how far it stands out of the skin and
 * in from it.
 *
 * THE DEPTH IS THE FRAME'S LOOK. The lining was the glass's own slab, 0.04 out and 0.06 in, and from the eye that
 * 0.10 m of depth showed as a second, lit face down the side of every pillar: half the No.1 / No.2 pillar's
 * apparent width (1.9 of 3.8 degrees) was side face, and the pillars read thick and two-toned where they are 6.5 cm
 * across. At 0.02 m the side is 0.4 degrees and the pillar reads 2.3, nearly all face (K3,
 * docs/findings/COCKPIT_VIEW_2026_09_20.md). The window the pilot sees is then the lining's own opening: its rim
 * stands 0.008 out of the skin, so the sill's top edge, not the hidden glass's outer face, is the bottom of the
 * view, and the lip is solved against that.
 */
export const AIRLINER_LINING = Object.freeze({ bottom: -30, top: 40, maxStepDegrees: 5, proud: 0.008, depth: 0.012 });

export interface LiningStrip {
  readonly name: string;
  /** R's azimuths, outboard positive on each side. A CENTRE strip runs from the starboard value to the port one. */
  readonly azimuth: readonly [number, number];
  readonly elevation: readonly [number, number];
  /** Built once across the centreline, or once a side (mirrored). */
  readonly centre: boolean;
}

/**
 * Every rectangle of R's sky round the glass that is not glass, READ from `FLIGHT_DECK_PANES` and
 * `CENTRE_POST_HALF_AZIMUTH`: the sill under each pane and the crown over it, the pillar between neighbours (as tall
 * as the taller of the two), and the centre post between the No.1 panes. Together with the panes they tile R's view
 * from `AIRLINER_LINING.bottom` to `.top` and out to No.3's outboard edge, which is behind the frame's edge.
 */
export function airlinerLiningStrips(): readonly LiningStrip[] {
  const [one, two, three] = [FLIGHT_DECK_PANES[0]!, FLIGHT_DECK_PANES[1]!, FLIGHT_DECK_PANES[2]!];
  const { bottom, top } = AIRLINER_LINING;
  const pillar = (inner: FlightDeckPane, outer: FlightDeckPane) => ({
    azimuth: [inner.azimuth[1], outer.azimuth[0]] as const,
    elevation: [Math.min(inner.elevation[0], outer.elevation[0]), Math.max(inner.elevation[1], outer.elevation[1])] as const,
  });
  const oneTwo = pillar(one, two);
  const twoThree = pillar(two, three);
  return [
    { name: "sill-centre", azimuth: [-oneTwo.azimuth[1], oneTwo.azimuth[1]], elevation: [bottom, one.elevation[0]], centre: true },
    { name: "crown-centre", azimuth: [-oneTwo.azimuth[1], oneTwo.azimuth[1]], elevation: [one.elevation[1], top], centre: true },
    { name: "post", azimuth: [-CENTRE_POST_HALF_AZIMUTH, CENTRE_POST_HALF_AZIMUTH], elevation: one.elevation, centre: true },
    { name: "pillar-one-two", azimuth: oneTwo.azimuth, elevation: oneTwo.elevation, centre: false },
    { name: "sill-two", azimuth: [two.azimuth[0], three.azimuth[0]], elevation: [bottom, two.elevation[0]], centre: false },
    { name: "crown-two", azimuth: [two.azimuth[0], three.azimuth[0]], elevation: [two.elevation[1], top], centre: false },
    { name: "pillar-two-three", azimuth: twoThree.azimuth, elevation: twoThree.elevation, centre: false },
    { name: "sill-three", azimuth: three.azimuth, elevation: [bottom, three.elevation[0]], centre: false },
    { name: "crown-three", azimuth: three.azimuth, elevation: [three.elevation[1], top], centre: false },
  ];
}

/** Breakpoints with lines added between each pair, evenly, no more than `maxStepDegrees` apart. */
function subdivided(breaks: readonly number[]): number[] {
  const out: number[] = [];
  for (let i = 0; i + 1 < breaks.length; i += 1) {
    const a = breaks[i]!;
    const b = breaks[i + 1]!;
    const pieces = Math.max(1, Math.ceil((b - a) / AIRLINER_LINING.maxStepDegrees));
    for (let k = 0; k < pieces; k += 1) out.push(k === 0 ? a : a + ((b - a) * k) / pieces);
  }
  out.push(breaks.at(-1)!);
  return out;
}

/**
 * THE LINING'S ONE GRID. Two strips that meet must meet at the SAME cast points. A strip sampled on rows of its own
 * shares only its corners with its neighbour, and between them each edge is its own chord across the curved skin, so
 * the two edges part by a fraction of a millimetre and the hidden sky shows through the frame as a bright hairline:
 * it did, in K2's first live frame, along the crown's seams. So every strip takes its rows and columns from these
 * lines: the panes' own edges and the post's, with lines added between them no more than `maxStepDegrees` apart, and
 * nothing between the post's two edges, so the post's top and foot are single chords in the crown and the sill too.
 * Azimuths are outboard positive; across the centreline the port lines are mirrored, and a mirrored sightline is the
 * same ray to the last bit.
 */
export function airlinerLiningLines(): { azimuth: readonly number[]; elevation: readonly number[] } {
  const [one, two, three] = [FLIGHT_DECK_PANES[0]!, FLIGHT_DECK_PANES[1]!, FLIGHT_DECK_PANES[2]!];
  const unique = (values: readonly number[]) => [...new Set(values)].sort((a, b) => a - b);
  const port = subdivided(unique([CENTRE_POST_HALF_AZIMUTH, one.azimuth[0], one.azimuth[1], two.azimuth[0], two.azimuth[1], three.azimuth[0], three.azimuth[1]]));
  const breaks = [AIRLINER_LINING.bottom, AIRLINER_LINING.top, ...[one, two, three].flatMap((pane) => [...pane.elevation])];
  return {
    azimuth: [...port.map((a) => -a).reverse(), ...port],
    elevation: subdivided(unique(breaks)),
  };
}

/** A strip's grid on the skin, cast from R as the panes are, on the lining's lines: rows bottom to top, columns in azimuth order. */
function liningGrid(skin: SkinCaster, strip: LiningStrip, side: 1 | -1): { points: Point3[][]; normals: Point3[][] } {
  const lines = airlinerLiningLines();
  const within = (values: readonly number[], [from, to]: readonly [number, number]) => values.filter((v) => v >= from - 1e-9 && v <= to + 1e-9);
  const columns = within(lines.azimuth, strip.azimuth);
  const rows = within(lines.elevation, strip.elevation);
  for (const [what, got, range] of [["azimuth", columns, strip.azimuth], ["elevation", rows, strip.elevation]] as const) {
    if (got.length < 2 || got[0] !== range[0] || got.at(-1) !== range[1]) {
      throw new RangeError(`747 cockpit lining ${strip.name}: its ${what} range ${range.join("..")} is not on the lining's lines`);
    }
  }
  const points: Point3[][] = [];
  const normals: Point3[][] = [];
  for (const elevation of rows) {
    const pointRow: Point3[] = [];
    const normalRow: Point3[] = [];
    for (const azimuth of columns) {
      const hit = skin.exit(FLIGHT_DECK_REFERENCE, sightline(azimuth, elevation, side));
      if (!hit) throw new RangeError(`747 cockpit lining ${strip.name}: no skin at az ${azimuth.toFixed(2)}, el ${elevation.toFixed(2)}`);
      pointRow.push(hit.point);
      normalRow.push(hit.normal);
    }
    points.push(pointRow);
    normals.push(normalRow);
  }
  return { points, normals };
}

// ---- the builder ------------------------------------------------------------------------------

/** What `buildAirlinerCockpit` hands back: the meshes, and the step that redraws the displays. */
export interface AirlinerCockpit {
  /** Every mesh it made, unconfigured: the caller marks them cockpit-only. */
  readonly parts: readonly AbstractMesh[];
  /**
   * Whether the six screens are drawing. False wherever there is no 2D canvas -- every Node test
   * under `NullEngine` -- where they keep their flat material instead. Exposed so a test asserts the
   * headless path deliberately rather than passing because nothing was drawn.
   */
  readonly displaysLive: boolean;
  /**
   * The next `update` redraws the displays whatever its delta: the visual calls this on ENTERING
   * cockpit view, so the first frame back is not the picture from when the pilot last left.
   */
  invalidateDisplays(): void;
  /**
   * Redraw the displays at `DISPLAY_UPDATE_HZ` from what `state` reads.
   * The visual calls this from its `update` ONLY while cockpit view is on, and passes the frame's
   * own delta so the redraw rate is wall-clock rather than frame-rate.
   */
  update(state: FlightVisualState, secondsSinceLastUpdate?: number): void;
}

/**
 * Build the cockpit. Returns every mesh it made, unconfigured: the caller marks
 * them cockpit-only (`configureCockpitOnlyParts`) and registers them, so the rule
 * is applied in one place. `skin` is the caster the glazing was cast with.
 *
 * FOUR meshes, all static: the board and the window frame's lining on the interior material; the glareshield's lip
 * on the glareshield's, alone; the six screens; their six bezels.
 */
export function buildAirlinerCockpit(
  build: AircraftBuildContext,
  root: TransformNode,
  materials: AirlinerCockpitMaterials,
  skin: SkinCaster,
): AirlinerCockpit {
  const parts: AbstractMesh[] = [];
  const p = AIRLINER_PANEL;
  const g = AIRLINER_GLARESHIELD;
  const faceX = airlinerPanelFaceX();
  const lipY = airlinerLipY();
  const undersideY = lipY - g.thickness;

  // THE LINING: one skin panel per strip (a side, or once across the centreline), at the panes' own proud and
  // depth, so its rim at a pane's edge is that pane's edge, inner face and outer alike.
  const lining: AbstractMesh[] = [];
  for (const strip of airlinerLiningStrips()) {
    const sides: readonly (readonly [string, 1 | -1])[] = strip.centre ? [["", -1]] : [["port-", -1], ["starboard-", 1]];
    for (const [prefix, side] of sides) {
      const grid = liningGrid(skin, strip, side);
      lining.push(build.skinPanel(
        `${prefix}airliner-lining-${strip.name}`,
        grid.points,
        grid.normals,
        AIRLINER_LINING.proud,
        AIRLINER_LINING.depth,
        materials.interior,
        root,
      ));
    }
  }

  // THE GLARESHIELD: the lip alone, the wedge extruded along z (`verticalProfile` extrudes its x-y outline along z),
  // on a material of its own (matte near-black, no reflection): a glareshield must not reflect in the windscreen.
  // It is the whole deck line, so it is the mesh named for it.
  const lip = solidPlate(
    build,
    "airliner-glareshield",
    [
      { x: faceX, y: lipY },
      { x: faceX, y: undersideY },
      { x: faceX + g.depth, y: undersideY },
    ],
    p.halfWidth * 2,
    glareshieldMaterial(build, "airliner-glareshield"),
    root,
  );
  parts.push(lip);

  // THE PANEL BOARD, from below the frame up to the glareshield's underside.
  const board = build.box("airliner-instrument-panel", p.thickness, undersideY - p.bottomY, p.halfWidth * 2, materials.interior, root);
  board.position.set(faceX + p.thickness / 2, (p.bottomY + undersideY) / 2, 0);

  // THE SCREENS AND THEIR BEZELS: two meshes for twelve boxes. The bezel's back
  // stands 1 mm inside the board so nothing is coincident.
  const s = AIRLINER_SCREENS;
  const screens: AbstractMesh[] = [];
  const bezels: AbstractMesh[] = [];
  for (const { name, centre } of airlinerScreenPlacements()) {
    const screen = build.box(
      `airliner-screen-${name}`, s.screenThickness, s.height, s.width, materials.instrumentFace, root,
    );
    screen.position.copyFrom(centre);
    screens.push(screen);
    const bezel = build.box(
      `airliner-screen-bezel-${name}`, s.bezelThickness, s.height + s.bezel * 2, s.width + s.bezel * 2,
      materials.instrumentMarking, root,
    );
    bezel.position.set(faceX - s.bezelThickness / 2 + 0.001, centre.y, centre.z);
    bezels.push(bezel);
  }
  // EACH SCREEN'S PILOT-FACING FACE GETS ITS OWN SLOT of the display atlas, before the merge bakes
  // the vertex data. The boxes are built in `SCREEN_LAYOUT` order and the slots are in the same order, so
  // slot i belongs to screen i; `tests/render.cockpit-displays.test.ts` holds that pairing by
  // measuring the merged mesh's UVs against each screen's own place.
  const slots = displaySlots(AIRLINER_DISPLAYS);
  const atlasWidth = displayAtlasWidth(AIRLINER_DISPLAYS);
  const atlasHeight = displayAtlasHeight(AIRLINER_DISPLAYS);
  for (const [index, screen] of screens.entries()) {
    remapScreenFaceToSlot(screen as Mesh, slots[index]!, atlasWidth, atlasHeight);
  }
  const screensMesh = build.mergeStatic("airliner-screens", screens, root);
  parts.push(screensMesh);
  parts.push(build.mergeStatic("airliner-screen-bezels", bezels, root));

  // THE DISPLAYS THEMSELVES, if this engine has a 2D canvas. Under NullEngine it does not, and the
  // screens keep the flat instrument-face material they were built with (see `displayAtlas.ts`).
  const atlas = createDisplayAtlas(build, AIRLINER_DISPLAYS);
  if (atlas !== null) {
    screensMesh.material = displayMaterial(build, "airliner-display", atlas);
  }

  // THE BOARD AND THE WINDOW FRAME, one mesh on the flight deck's interior material (the seats'). The sills are
  // frame too, not the glareshield's: the lighter surround round the glass, over the dark hood.
  parts.push(build.mergeStatic("airliner-cockpit-interior", [board, ...lining], root));

  // THE DISPLAYS ARE REDRAWN ON THE SHARED CLOCK (`displayRedrawClock`), not every frame: `update`
  // is only called while cockpit view is on (the visual gates it), 15 a second is as fast as a
  // display needs to move, and the visual invalidates it on entry. Before that invalidate existed,
  // every return to the cockpit after the first showed the pages from when the pilot last left for
  // up to three frames behind an instant camera cut: the counter stopped where it was on the way out.
  //
  // WHAT ONE REDRAW COSTS, measured in the live app on this machine (M2 Pro, WebGPU, 60 samples,
  // one update per animation frame, the texture proven live and bound each time): 0.3 ms to draw
  // the six pages, 2.0 ms for `getImageData`, 1.0 ms for `RawTexture.update`; 3.3 ms median, 3.5 ms
  // at p90, so about 50 ms a second at 15 Hz. The readback is the biggest part and exists only
  // because the bytes have to reach the GPU through a `RawTexture`: this engine build has neither
  // `createDynamicTexture` nor `updateDynamicTexture` (both measured undefined), so the canvas
  // cannot be handed to the texture directly. Both are on the register.
  const redraw = displayRedrawClock();
  return {
    parts,
    displaysLive: atlas !== null,
    invalidateDisplays() {
      redraw.invalidate();
    },
    update(state, secondsSinceLastUpdate = 0) {
      if (atlas === null) return;
      if (!redraw.tick(secondsSinceLastUpdate)) return;
      drawDisplays(atlas, displayStateFromVisual(state, AIRLINER_DISPLAY_AIRFRAME));
    },
  };
}

/** The painter: the four page kinds across the six slots, then the upload. */
function drawDisplays(atlas: DisplayAtlas, state: ReturnType<typeof displayStateFromVisual>): void {
  paintDisplays(atlas, state);
}
