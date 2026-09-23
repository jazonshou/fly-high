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
  PANE_DEPTH,
  PANE_PROUD,
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
 * re-loft of the nose moves the frame with the glass. The one piece of the frame that is not the
 * kit's is the centre post, the plane engineer's cast strip over R's +-1 degree, which the cockpit
 * camera now draws (`airlinerVisual.ts`); the kit lines the gap between it and each No.1 pane.
 *
 * THE EYE, (29.85, 2.93, -0.50), was chosen on a grid of candidate eyes against the built glass
 * (the K0 table in docs/findings/COCKPIT_VIEW_2026_09_20.md): 0.50 m off the centreline, as the
 * type's seat spacing puts the captain; straight ahead in the middle third of the port No.1
 * pane's azimuth span (No.1 reads -8.8..+11.6 at the horizon); the centre post at +13.1..+14.8;
 * No.1's opening 30.4 degrees; the glass 1.90 m ahead. It keeps the old eye's HEIGHT: the pilot's
 * eye height is the constant when the seat moves inboard, and the crown there is higher.
 *
 * THE TARGETS, as angles from the eye at the 75 degree lens (16:9, so the frame's bottom reads
 * -23.35 straight ahead):
 *  - the glareshield's lip reads -18.04 straight ahead, the LOWEST line that leaves no more than 1
 *    degree of sill between itself and No.1's bottom edge anywhere along that edge. It stands
 *    FLUSH with the panel's face, and the screens hang 0.25 degrees under it, so 43.5% of each
 *    screen in the top row is in the frame;
 *  - above the lip the sill lining carries the glareshield on to each pane's bottom edge, so no
 *    band of the hidden nose shows between them; the deck's top straight ahead is therefore No.1's
 *    bottom edge, which is what `catalogue.cockpitDeckLineDegrees` records;
 *  - the screens are the type's layout: each pilot's PFD straight ahead of them and their ND
 *    inboard of it, the upper EICAS on the centreline and the lower one under it.
 *
 * Body coordinates: +X nose, +Y up, +Z starboard, so the pilot's seat is at negative Z.
 */

const DEG = Math.PI / 180;

export interface AirlinerCockpitMaterials {
  /**
   * Dark matte interior: the panel board, the crown lining, the pillars and the gaps by the post, which are one
   * structure and one draw state. (The glareshield and the sill lining have the glareshield's own:
   * `glareshieldMaterial`.) A material with no ambient light reads (0, 0, 0) on any face the sun misses: a hole in
   * the picture beside a lit ceiling. This one is the flight deck's own, the seats' material.
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
   * top row of screens was 36.8% in the frame, at 0.85 it is 43.5%: the lip and the frame's bottom are angles, so
   * the band between them is the same number of degrees at any distance, and a screen further away is fewer
   * degrees tall, so more of it fits in that band.
   */
  faceAheadOfEye: 0.85,
  /**
   * The board stands this deep behind its face. No deeper: its top edge's far corner must stay under the sight
   * line over the lip, which falls 0.3257 m a metre (tan 18.04), and the lip is 0.02 above the board's top.
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
 * LOWEST such line that keeps the sill -- the strip between the lip and No.1's bottom edge as the pilot sees it --
 * no more than 1 degree tall anywhere along that edge: No.1's outer bottom edge reads -16.88 at its inboard end
 * (az +7.9) and -18.10 at its outboard end (az -12.2), and a line along z reads shallower off axis, so the sill
 * is 1.00 degree at the inboard end and the lip stands 0.44 degree over the glass at the outboard end. Solved
 * against the cast edge, held to the BUILT glass by `tests/render.cockpit-airliner.test.ts`.
 *
 * Its section is a WEDGE, not a box: the aft face 0.02 tall, the top falling away forward over `depth` steeper
 * than the sight line over the lip (21.8 degrees against 18.04), so from the eye nothing of the glareshield or the
 * board behind it shows above the lip, and the lip is the line the pilot reads. A box's far top corner would stand
 * 1.6 cm over that sight line and become the edge instead.
 */
export const AIRLINER_GLARESHIELD = Object.freeze({
  lipElevationDegrees: -18.04,
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
 * The plane engineer's centre post is cast over R's azimuth +-`POST_HALF_AZIMUTH` and No.1's elevations
 * (`airlinerVisual.ts`); the gap between it and each No.1 pane's inboard edge (2.5) is lined here. A copy, held
 * to the built post by the test.
 */
export const AIRLINER_POST_HALF_AZIMUTH = 1;

/** How far below and above the glass the lining runs, in R's elevation: past the frame's edges from the eye with room. */
export const AIRLINER_LINING = Object.freeze({ bottom: -30, top: 40, maxStepDegrees: 5 });

export interface LiningStrip {
  readonly name: string;
  /** R's azimuths, outboard positive on each side. A CENTRE strip runs from the starboard value to the port one. */
  readonly azimuth: readonly [number, number];
  readonly elevation: readonly [number, number];
  /** Built once across the centreline, or once a side (mirrored). */
  readonly centre: boolean;
  /** The sills carry the glareshield on to the glass; the rest is the interior. */
  readonly on: "glareshield" | "interior";
}

/**
 * Every rectangle of R's sky round the glass that is not glass and not the centre post, READ from
 * `FLIGHT_DECK_PANES`: the sill under each pane and the crown over it, the pillar between neighbours (as tall as
 * the taller of the two), and the gap either side of the post. Together with the panes and the post they tile R's
 * view from `AIRLINER_LINING.bottom` to `.top` and out to No.3's outboard edge, which is behind the frame's edge.
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
    { name: "sill-centre", azimuth: [-oneTwo.azimuth[1], oneTwo.azimuth[1]], elevation: [bottom, one.elevation[0]], centre: true, on: "glareshield" },
    { name: "crown-centre", azimuth: [-oneTwo.azimuth[1], oneTwo.azimuth[1]], elevation: [one.elevation[1], top], centre: true, on: "interior" },
    { name: "post-gap", azimuth: [AIRLINER_POST_HALF_AZIMUTH, one.azimuth[0]], elevation: one.elevation, centre: false, on: "interior" },
    { name: "pillar-one-two", azimuth: oneTwo.azimuth, elevation: oneTwo.elevation, centre: false, on: "interior" },
    { name: "sill-two", azimuth: [two.azimuth[0], three.azimuth[0]], elevation: [bottom, two.elevation[0]], centre: false, on: "glareshield" },
    { name: "crown-two", azimuth: [two.azimuth[0], three.azimuth[0]], elevation: [two.elevation[1], top], centre: false, on: "interior" },
    { name: "pillar-two-three", azimuth: twoThree.azimuth, elevation: twoThree.elevation, centre: false, on: "interior" },
    { name: "sill-three", azimuth: three.azimuth, elevation: [bottom, three.elevation[0]], centre: false, on: "glareshield" },
    { name: "crown-three", azimuth: three.azimuth, elevation: [three.elevation[1], top], centre: false, on: "interior" },
  ];
}

/** A strip's grid on the skin, cast from R as the panes are: rows bottom to top, columns in the strip's azimuth order. */
function liningGrid(skin: SkinCaster, strip: LiningStrip, side: 1 | -1): { points: Point3[][]; normals: Point3[][] } {
  const steps = (span: number) => Math.max(1, Math.ceil(Math.abs(span) / AIRLINER_LINING.maxStepDegrees));
  const rows = steps(strip.elevation[1] - strip.elevation[0]) + 1;
  const columns = steps(strip.azimuth[1] - strip.azimuth[0]) + 1;
  const points: Point3[][] = [];
  const normals: Point3[][] = [];
  for (let row = 0; row < rows; row += 1) {
    const elevation = strip.elevation[0] + ((strip.elevation[1] - strip.elevation[0]) * row) / (rows - 1);
    const pointRow: Point3[] = [];
    const normalRow: Point3[] = [];
    for (let column = 0; column < columns; column += 1) {
      const azimuth = strip.azimuth[0] + ((strip.azimuth[1] - strip.azimuth[0]) * column) / (columns - 1);
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
 * FOUR meshes, all static: the board and the interior lining (crowns, pillars, the gaps by the post) on the
 * interior material; the glareshield's lip and the sill lining on the glareshield's; the six screens; their six
 * bezels.
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
  const glare = glareshieldMaterial(build, "airliner-glareshield");
  const lining: Record<LiningStrip["on"], AbstractMesh[]> = { glareshield: [], interior: [] };
  for (const strip of airlinerLiningStrips()) {
    const sides: readonly (readonly [string, 1 | -1])[] = strip.centre ? [["", -1]] : [["port-", -1], ["starboard-", 1]];
    for (const [prefix, side] of sides) {
      const grid = liningGrid(skin, strip, side);
      lining[strip.on].push(build.skinPanel(
        `${prefix}airliner-lining-${strip.name}`,
        grid.points,
        grid.normals,
        PANE_PROUD,
        PANE_DEPTH,
        strip.on === "glareshield" ? glare : materials.interior,
        root,
      ));
    }
  }

  // THE GLARESHIELD'S LIP: the wedge, extruded along z (`verticalProfile` extrudes its x-y outline along z), with
  // the sill lining in one mesh on the glareshield's material.
  const lip = solidPlate(
    build,
    "airliner-glareshield-lip",
    [
      { x: faceX, y: lipY },
      { x: faceX, y: undersideY },
      { x: faceX + g.depth, y: undersideY },
    ],
    p.halfWidth * 2,
    glare,
    root,
  );
  parts.push(build.mergeStatic("airliner-glareshield", [lip, ...lining.glareshield], root));

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

  // THE BOARD AND THE INTERIOR LINING, one mesh on the flight deck's interior material (the seats'). Not the
  // glareshield's for the crown and the pillars: they are the ceiling and the window frame, lit by the cabin.
  parts.push(build.mergeStatic("airliner-cockpit-interior", [board, ...lining.interior], root));

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
