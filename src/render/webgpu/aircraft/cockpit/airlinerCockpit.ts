import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import type { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh";
import type { Mesh } from "@babylonjs/core/Meshes/mesh";
import { VertexData } from "@babylonjs/core/Meshes/mesh.vertexData";
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
  type SkinCaster,
} from "../airlinerGlazing";
import type { AircraftBuildContext } from "../builders";
import {
  facetMesh,
  framedScreenFacets,
  framedScreenStack,
  glareshieldMaterial,
  roundedDeckSection,
  solidPlate,
  type RoundedDeckSection,
} from "./cockpitPrimitives";
import {
  AIRLINER_CLOCK_FACE,
  AIRLINER_DISPLAYS,
  createDisplayAtlas,
  displayAtlasHeight,
  displayAtlasWidth,
  displayMaterial,
  displayRedrawClock,
  displaySlots,
  paintDisplays,
  remapScreenFaceToSlot,
  uploadDisplayAtlas,
  type DisplayAtlas,
} from "./displays/displayAtlas";
import { drawClockFace } from "./displays/displayPages";
import { displayStateFromVisual, type DisplayAirframe } from "./displays/displayStateFromVisual";

/**
 * What a pilot in the 747-8's LEFT seat sees, built to the glass as it is built.
 *
 * THE GLASS IS CAST, AND SO IS THE FRAME ROUND IT. The flight-deck panes are windows of sky
 * specified by azimuth and elevation from a reference R on the centreline and cast onto the
 * nose's own triangles (`airlinerGlazing.ts`, docs/findings/AIRLINER_NOSE_GLAZING.md). The shell
 * and the glazing are hidden from the cockpit camera, so everything that frames the view is
 * built here as COCKPIT-ONLY parts (`CommonRig.cockpitOnlyParts`), invisible from any other camera
 * and never a shadow caster. The frame between, above and below the panes is the same cast: ONE
 * welded surface over R's sky that is not glass (`airlinerWindowFrame`), laid on the same skin from
 * the same reference, each pane's opening rolled into it (S1). Its openings therefore ARE the panes'
 * edges, by construction and at every point of them, rather than plates placed against copied
 * corners: the No.1 / No.2 pillar is the frame between azimuths 24 and 26, the crown starts at
 * No.1's +12, and a re-loft of the nose moves the frame with the glass. The centre post is framed
 * the same way: the plane engineer's post (+-`CENTRE_POST_HALF_AZIMUTH`, filling the gap between the
 * No.1 panes) is the glass's own 0.10 m slab, and against a 2 cm frame it stood 4.8 cm into the
 * cabin with its end and side faces showing, so it is hidden from the cockpit camera with the shell
 * and the glass, and the frame covers its place, one tone with the pillars.
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
  /**
   * The bezels' chamfered rims (P1b; the frames have their own dark material): `bezelRimMaterial`, which carries the
   * night glow (`bezelRimEmissive`, in the visual's `setLightState`), so it must be the visual's own.
   */
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
  /**
   * Back from vertical, top AWAY from the pilot, about the face's top edge at the cove's foot (P1a). The screens' share
   * of the frame is this deck's binding constraint, and it does not bind the lean: a smaller deck edge raised the
   * screens more than any lean lowers them (39.1% at the aimed 24 degrees against K3's 37.8%). So the lean is the most
   * upright that faces the pilot as the Global's does: the face's normal 7.3 degrees off the eye from the PFD's centre
   * (the bound is 8).
   */
  leanDegrees: 17,
});

/** The glareshield's aft face: the deck's nearest plane to the pilot, where the lip reads its deck line. */
export function airlinerPanelFaceX(): number {
  return eye().forward + AIRLINER_PANEL.faceAheadOfEye;
}

/**
 * THE GLARESHIELD. Its deck line is the K3 rule's: the LOWEST line along z that keeps the sill -- the strip between the
 * lip and the bottom of the view over No.1 -- no more than 1 degree tall anywhere along No.1. The bottom of the view is
 * the sill lining's own top edge (its rim's outer edge, 0.008 out of the skin; the glass is not drawn), which reads
 * -17.41 at No.1's inboard end (az +8.0) and -18.66 at its outboard end (az -11.8), and a line along z reads shallower
 * off axis, so the sill is 0.99 degree at the inboard end and the lip stands 0.45 degree over the window at the outboard
 * end. Solved against the BUILT lining and held to it by `tests/render.cockpit-airliner.test.ts`.
 *
 * Its section is a ROUNDED DECK (P1a, `roundedDeckSection`, the Global's): a round on the deck line's sight line at a
 * vertex, so the silhouette is the deck line exactly; a 45 degree cove under it to the leaned panel's face; a hood
 * falling forward faster than the sight line, so nothing of it shows. On this deck the band from the lip to the frame's
 * bottom is only 4.78 degrees, and the screens' share of it binds, so the round, the drop and the cove are the least that
 * reads (a lit line over a dark hairline, 0.54 degree in all, where K3's flush lip face was 1.20).
 *
 * Being a line along z, the silhouette is ONE row of the picture across the whole frame, and it is the deck's top: the
 * value `catalogue.cockpitDeckLineDegrees` records and the 2D HUD keeps above.
 */
export const AIRLINER_GLARESHIELD = Object.freeze({
  lipElevationDegrees: -18.57,
  radius: 0.005,
  drop: 0,
  cove: 0.003,
  /** Faster than the 18.57 degree sight line over the round. */
  hoodFallDegrees: 21,
  /** The shell is wide here (1.44 m where the board stands, against the deck's 1.3): no taper. */
  hoodDepth: 0.1,
  roundSegments: 8,
});

/** The deck line's height at the aft face: it reads `lipElevationDegrees` straight ahead (the round's silhouette is on it). */
export function airlinerLipY(): number {
  const e = eye();
  return e.up + Math.tan(AIRLINER_GLARESHIELD.lipElevationDegrees * DEG) * (airlinerPanelFaceX() - e.forward);
}

/** The glareshield's section in body x and y (`roundedDeckSection`). */
export function airlinerGlareshieldSection(): RoundedDeckSection {
  return roundedDeckSection(eye(), airlinerPanelFaceX(), -AIRLINER_GLARESHIELD.lipElevationDegrees, AIRLINER_GLARESHIELD, "the 747");
}

/**
 * The panel's face, leaned back by `leanDegrees` about its top edge at the cove's foot: that edge, the unit vector UP the
 * face, and the face's unit normal toward the pilot (aft and up), in body x and y.
 */
export function airlinerPanelFace(): { top: { x: number; y: number }; up: { x: number; y: number }; normal: { x: number; y: number }; bottomY: number } {
  const lean = AIRLINER_PANEL.leanDegrees * DEG;
  return {
    top: airlinerGlareshieldSection().faceTop,
    up: { x: Math.sin(lean), y: Math.cos(lean) },
    normal: { x: -Math.cos(lean), y: Math.sin(lean) },
    bottomY: AIRLINER_PANEL.bottomY,
  };
}

// ---- the deck's wrap: the board and the glareshield turn aft to the side walls (S4) ---------------------

/**
 * THE DECK WRAPS (S4). Outboard of the PFD the board ran on flat to the frame's edge, a grey slab 29 degrees wide with
 * nothing on it (4.02% of the frame, P0), and past both edges of the frame to the shell. The type's panel turns
 * toward the pilot at its ends, into the side consoles under the side windows. So here the whole DECK, the board
 * and the glareshield over it, is swept along one plan path (`airlinerDeckPath`): straight across between the pilots,
 * then at each end a turn aft of `radius` (at the face's top edge) through `turnDegrees`, and a run aft along the side
 * past the edge of any lens. The two turn together: a board turned alone would open the glareshield's underside to the
 * eye, and through it the nose beyond.
 *
 * The turn starts `startAzimuthDegrees` outboard of each pilot's straight ahead, read at the face's top edge. The deck
 * line is the lip straight ahead, where the deck is straight; turned, the lip comes toward the pilot and reads lower,
 * so the deck line (the HUD's instrument: the deck's highest row anywhere) does not move.
 */
export const AIRLINER_DECK_WRAP = Object.freeze({
  startAzimuthDegrees: 15,
  radius: 0.25,
  turnDegrees: 90,
  /** Aft along the side after the turn: its end at az -67 from the seat, out of any lens. */
  aftRun: 0.4,
  /** Chords round each turn, shaded as the turn. */
  segments: 9,
});

/** A station of the deck's plan path: where the section's reference (the face's top edge) is, and where its forward points. */
export interface DeckStation {
  readonly x: number;
  readonly z: number;
  /** The section's +x (forward, away from the pilot) in plan: +x across the middle, outboard at the side. */
  readonly forward: { readonly x: number; readonly z: number };
}

/** The deck's plan path, from the port run's aft end round the port turn, across, and round to the starboard run's aft end. */
export function airlinerDeckPath(): readonly DeckStation[] {
  const w = AIRLINER_DECK_WRAP;
  const e = eye();
  const x0 = airlinerPanelFace().top.x;
  const start = Math.abs(e.right) + (x0 - e.forward) * Math.tan(w.startAzimuthDegrees * DEG);
  const turn = w.turnDegrees * DEG;
  const side = (s: 1 | -1): DeckStation[] => {
    const out: DeckStation[] = [];
    for (let k = 0; k <= w.segments; k += 1) {
      const t = (turn * k) / w.segments;
      out.push({ x: x0 - w.radius + w.radius * Math.cos(t), z: s * (start + w.radius * Math.sin(t)), forward: { x: Math.cos(t), z: s * Math.sin(t) } });
    }
    const end = out.at(-1)!;
    out.push({ x: end.x - Math.sin(turn) * w.aftRun, z: end.z + s * Math.cos(turn) * w.aftRun, forward: end.forward });
    return out;
  };
  return [...side(-1).reverse(), ...side(1)];
}

/**
 * A section in body x and y (as the deck stands across the middle) swept along the deck's plan path. The walls are
 * shaded as the path turns (each station's normals are the section's, turned with it) and, across the section, flat
 * but for its ROUNDS (radial normals, `smoothRoundNormals`' rule). A flat cap at each end. Wound as `solidPlate` winds
 * (a drawn face's cross product points INTO the solid).
 */
function sweptDeck(
  build: AircraftBuildContext,
  name: string,
  points: readonly { readonly x: number; readonly y: number }[],
  rounds: readonly { readonly first: number; readonly last: number; readonly centre: { readonly x: number; readonly y: number } }[],
  material: PBRMaterial,
  parent: TransformNode,
): Mesh {
  const path = airlinerDeckPath();
  const x0 = airlinerPanelFace().top.x;
  const n = points.length;
  const middle = { x: points.reduce((sum, q) => sum + q.x, 0) / n, y: points.reduce((sum, q) => sum + q.y, 0) / n };
  const place = (st: DeckStation, q: { x: number; y: number }) => new Vector3(st.x + (q.x - x0) * st.forward.x, q.y, st.z + (q.x - x0) * st.forward.z);
  const turned = (st: DeckStation, d: { x: number; y: number }) => new Vector3(d.x * st.forward.x, d.y, d.x * st.forward.z).normalize();
  const positions: number[] = [];
  const normals: number[] = [];
  const indices: number[] = [];
  const vertex = (at: Vector3, normal: Vector3) => {
    positions.push(at.x, at.y, at.z);
    normals.push(normal.x, normal.y, normal.z);
    return positions.length / 3 - 1;
  };
  const at = (v: number) => new Vector3(positions[v * 3]!, positions[v * 3 + 1]!, positions[v * 3 + 2]!);
  const triangle = (a: number, b: number, c: number, outward: Vector3) => {
    const cross = Vector3.Cross(at(b).subtract(at(a)), at(c).subtract(at(a)));
    if (cross.length() < 1e-14) return;
    if (Vector3.Dot(cross, outward) > 0) indices.push(a, c, b);
    else indices.push(a, b, c);
  };
  for (let j = 0; j < n; j += 1) {
    const k = (j + 1) % n;
    const [pj, pk] = [points[j]!, points[k]!];
    let out = { x: pk.y - pj.y, y: -(pk.x - pj.x) };
    if (out.x * (pj.x - middle.x) + out.y * (pj.y - middle.y) < 0) out = { x: -out.x, y: -out.y };
    const round = rounds.find((r) => k === j + 1 && j >= r.first && k <= r.last);
    const shading = (st: DeckStation, q: { x: number; y: number }) => turned(st, round ? { x: q.x - round.centre.x, y: q.y - round.centre.y } : out);
    const rows = path.map((st) => [vertex(place(st, pj), shading(st, pj)), vertex(place(st, pk), shading(st, pk))] as const);
    for (let i = 0; i + 1 < path.length; i += 1) {
      const outward = turned(path[i]!, out).add(turned(path[i + 1]!, out));
      const [a, b] = rows[i]!;
      const [d, c] = rows[i + 1]!;
      triangle(a, b, c, outward);
      triangle(a, c, d, outward);
    }
  }
  for (const [end, toward] of [[0, 1], [path.length - 1, path.length - 2]] as const) {
    const outward = place(path[end]!, middle).subtract(place(path[toward]!, middle)).normalize();
    const cap = points.map((q) => vertex(place(path[end]!, q), outward));
    for (let m = 1; m + 1 < n; m += 1) triangle(cap[0]!, cap[m]!, cap[m + 1]!, outward);
  }
  return dataMesh(build, name, { positions, normals, indices }, material, parent);
}

/** The board's section in body x and y, as it stands across the middle: its face leaned back from the cove's foot, and its back. */
export function airlinerBoardSection(): readonly { readonly x: number; readonly y: number }[] {
  const face = airlinerPanelFace();
  const length = (face.top.y - face.bottomY) / Math.cos(AIRLINER_PANEL.leanDegrees * DEG);
  const t = AIRLINER_PANEL.thickness;
  const top = face.top;
  const foot = { x: top.x - length * face.up.x, y: top.y - length * face.up.y };
  const back = (q: { x: number; y: number }) => ({ x: q.x - t * face.normal.x, y: q.y - t * face.normal.y });
  return [top, foot, back(foot), back(top)];
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
  /**
   * The top row's top edge reads this far below the cove's foot (the lowest edge of the deck the pilot sees): the
   * least at which the bezels' top rims, 10 mm over their screens, clear the cove (at 0.5 they stood 0.14 degree into
   * it). The top row keeps 37.9% of its screens in the frame (K3's 37.8).
   */
  belowDeckEdgeDegrees: 0.65,
  /** Between the upper EICAS's bezel and the lower one's. */
  rowGap: 0.005,
  /** The bezel's frame (P1b, `framedScreenFacets`): its front this far out of the board, its back 1 mm inside it. */
  bezelThickness: 0.007,
  /** The chamfer round the frame's outer edge, 45 degrees; the dark gap round the screen; the screen's face this far
   * behind the frame's front; the screen a thin plate, its sides in the well. */
  chamfer: 0.004,
  gap: 0.002,
  recess: 0.003,
  screenThickness: 0.0005,
  /** The well's floor behind the gap, straddling the board's face. */
  wellThickness: 0.001,
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

/**
 * The six screens on the leaned face, in `SCREEN_LAYOUT`'s order: `centre` is the screen plate's, and `faceCentre` the
 * same point on the board's face, where the bezel's frame and the well are laid out from (`framedScreenFacets`). The
 * screen plate is turned back by the lean about z, its face `recess` behind its frame's front; the top row's face top
 * edge reads `belowDeckEdgeDegrees` under the cove's foot, and the lower EICAS stands a row down the face.
 */
export function airlinerScreenPlacements(): readonly { name: string; centre: Vector3; faceCentre: Vector3 }[] {
  const s = AIRLINER_SCREENS;
  const stack = framedScreenStack(s);
  const e = eye();
  const seat = Math.abs(e.right);
  const face = airlinerPanelFace();
  const along = (h: number, out: number) => ({ x: face.top.x + h * face.up.x + out * face.normal.x, y: face.top.y + h * face.up.y + out * face.normal.y });
  // a line along z reads one row wherever it is: the row is the slope (y - eye.y) / (x - eye.x)
  const slope = Math.tan(Math.atan2(face.top.y - e.up, face.top.x - e.forward) - s.belowDeckEdgeDegrees * DEG);
  const front = along(0, stack.screenFront);
  const h = (slope * (front.x - e.forward) - (front.y - e.up)) / (face.up.y - slope * face.up.x);
  const rowDrop = s.height + s.bezel * 2 + s.rowGap;
  return SCREEN_LAYOUT.map(({ name, z, row }) => {
    const middle = h - s.height / 2 - row * rowDrop;
    const screen = along(middle, (stack.screenFront + stack.screenBack) / 2);
    const onFace = along(middle, 0);
    const at = z(seat, s.pitch);
    return { name, centre: new Vector3(screen.x, screen.y, at), faceCentre: new Vector3(onFace.x, onFace.y, at) };
  });
}

// ---- the clock (S4) ---------------------------------------------------------------------------

/**
 * THE CLOCK, on the captain's side where the deck turns aft (S4), as the type's is: a round dial of the screens' family,
 * its frame on the bezels' dark grey, its 45 degree chamfered rim on the marking (the night glow), a dark well behind
 * the gap, and its face a static page (`drawClockFace`, no needles) drawn once into a texture of its own.
 *
 * It is `azimuthDegrees` outboard of straight ahead, read at the face's top edge, on the deck's turn, and its bezel's
 * top is level with the screens' bezels' down the face. The turn is concave to the pilot, so a flat dial on it would
 * have the board stand through its sides: the dial stands `sag` (the turn's depth across it) further out, and its frame
 * reaches back that much further into the board, so nothing shows behind it.
 */
export const AIRLINER_CLOCK = Object.freeze({
  azimuthDegrees: 17,
  /** The face's diameter: the type's 3 1/4 inch instrument. */
  diameter: 0.083,
  /** Chords round the dial, shaded round. */
  segments: 48,
});

/** Where the clock stands: its centre on the board's face, the face's directions there, and the turn's depth across it. */
export function airlinerClockPlacement(): { centre: Vector3; across: Vector3; up: Vector3; out: Vector3; sag: number; turnDegrees: number } {
  const w = AIRLINER_DECK_WRAP;
  const e = eye();
  const face = airlinerPanelFace();
  const x0 = face.top.x;
  const start = Math.abs(e.right) + (x0 - e.forward) * Math.tan(w.startAzimuthDegrees * DEG);
  const pointAt = (t: number) => ({ x: x0 - w.radius + w.radius * Math.cos(t), z: -(start + w.radius * Math.sin(t)) });
  const azimuth = (t: number) => Math.atan2(pointAt(t).z - e.right, pointAt(t).x - e.forward) / DEG;
  const target = -AIRLINER_CLOCK.azimuthDegrees;
  let [lo, hi] = [0, w.turnDegrees * DEG];
  if (!(azimuth(lo) > target && azimuth(hi) < target)) throw new RangeError("747 cockpit clock: its azimuth is not on the deck's turn");
  for (let k = 0; k < 60; k += 1) {
    const mid = (lo + hi) / 2;
    if (azimuth(mid) > target) lo = mid;
    else hi = mid;
  }
  const t = (lo + hi) / 2;
  const forward = { x: Math.cos(t), z: -Math.sin(t) };
  const turned = (d: { x: number; y: number }) => new Vector3(d.x * forward.x, d.y, d.x * forward.z).normalize();
  const up = turned(face.up);
  const out = turned(face.normal);
  const across = Vector3.Cross(up, out).normalize();
  // down the face, its bezel's top level with the screens' bezels' tops
  const s = AIRLINER_SCREENS;
  const pfd = airlinerScreenPlacements()[0]!.faceCentre;
  const pfdDown = (pfd.x - face.top.x) * face.up.x + (pfd.y - face.top.y) * face.up.y;
  const edge = AIRLINER_CLOCK.diameter / 2 + s.bezel;
  const along = pfdDown + s.height / 2 + s.bezel - edge;
  const onFace = { x: face.top.x + along * face.up.x, y: face.top.y + along * face.up.y };
  const p = pointAt(t);
  const centre = new Vector3(p.x + (onFace.x - x0) * forward.x, onFace.y, p.z + (onFace.x - x0) * forward.z);
  const radiusHere = w.radius + (onFace.x - x0);
  return { centre, across, up, out, sag: radiusHere - Math.sqrt(radiusHere * radiusHere - edge * edge), turnDegrees: t / DEG };
}

type PieceData = { positions: number[]; normals: number[]; uvs: number[]; indices: number[] };

/**
 * The clock's four closed solids (each closed on its own, so wherever a ray meets one first it meets a face the GPU
 * draws), their round walls shaded round: the FRAME (a ring from the gap out to the chamfer's shoulder, its front toward
 * the pilot), the RIM (the chamfer, out to the bezel's edge), the WELL (a dark disc behind the gap) and the FACE (the
 * page's disc, recessed as the screens are, UV'd to its texture: +u to the pilot's right, world up to the smaller v).
 */
export function airlinerClockPieces(): { frame: PieceData; rim: PieceData; well: PieceData; face: PieceData } {
  const c = AIRLINER_CLOCK;
  const s = AIRLINER_SCREENS;
  const at0 = airlinerClockPlacement();
  const stack = framedScreenStack(s);
  const radius = c.diameter / 2;
  const [open, edge] = [radius + s.gap, radius + s.bezel];
  const shoulder = edge - s.chamfer;
  const lift = at0.sag;
  const [front, foot, back] = [stack.bezelFront + lift, stack.chamferFoot + lift, stack.bezelBack];
  const [faceFront, faceBack] = [stack.screenFront + lift, stack.screenBack + lift];
  const [wellFront, wellBack] = [faceBack, faceBack - s.wellThickness];
  const n = c.segments;
  const dir = (k: number) => at0.across.scale(Math.cos((2 * Math.PI * k) / n)).add(at0.up.scale(Math.sin((2 * Math.PI * k) / n)));
  const at = (r: number, offset: number, k: number) => at0.centre.add(dir(k).scale(r)).add(at0.out.scale(offset));
  const piece = (): PieceData => ({ positions: [], normals: [], uvs: [], indices: [] });
  const vertex = (data: PieceData, p: Vector3, normal: Vector3, uv: readonly [number, number] = [0, 0]) => {
    data.positions.push(p.x, p.y, p.z);
    data.normals.push(normal.x, normal.y, normal.z);
    data.uvs.push(uv[0], uv[1]);
    return data.positions.length / 3 - 1;
  };
  const point = (data: PieceData, v: number) => new Vector3(data.positions[v * 3]!, data.positions[v * 3 + 1]!, data.positions[v * 3 + 2]!);
  const triangle = (data: PieceData, a: number, b: number, d: number, outward: Vector3) => {
    const cross = Vector3.Cross(point(data, b).subtract(point(data, a)), point(data, d).subtract(point(data, a)));
    if (Vector3.Dot(cross, outward) > 0) data.indices.push(a, d, b);
    else data.indices.push(a, b, d);
  };
  /** A band round the dial from (r1, o1) to (r2, o2), its normal at each chord's corner `normal(k)`. */
  const band = (data: PieceData, r1: number, o1: number, r2: number, o2: number, normal: (k: number) => Vector3) => {
    const rows = Array.from({ length: n + 1 }, (_, k) => [vertex(data, at(r1, o1, k), normal(k)), vertex(data, at(r2, o2, k), normal(k))] as const);
    for (let k = 0; k < n; k += 1) {
      const outward = normal(k).add(normal(k + 1));
      triangle(data, rows[k]![0], rows[k]![1], rows[k + 1]![1], outward);
      triangle(data, rows[k]![0], rows[k + 1]![1], rows[k + 1]![0], outward);
    }
  };
  /** A flat disc facing `facing` times out of the face; the face's front carries the page's UVs. */
  const disc = (data: PieceData, r: number, offset: number, facing: 1 | -1, mapped = false) => {
    const normal = at0.out.scale(facing);
    const uv = (k: number): [number, number] => (mapped ? [0.5 + 0.5 * Math.cos((2 * Math.PI * k) / n), 0.5 - 0.5 * Math.sin((2 * Math.PI * k) / n)] : [0, 0]);
    const middle = vertex(data, at0.centre.add(at0.out.scale(offset)), normal, mapped ? [0.5, 0.5] : [0, 0]);
    const ring = Array.from({ length: n + 1 }, (_, k) => vertex(data, at(r, offset, k), normal, uv(k)));
    for (let k = 0; k < n; k += 1) triangle(data, middle, ring[k]!, ring[k + 1]!, normal);
  };
  const outward = () => at0.out;
  const inward = () => at0.out.scale(-1);
  const radial = (k: number) => dir(k).normalize();
  const radialIn = (k: number) => dir(k).normalize().scale(-1);
  const frame = piece();
  band(frame, open, front, shoulder, front, outward);
  band(frame, shoulder, front, shoulder, back, radial);
  band(frame, shoulder, back, open, back, inward);
  band(frame, open, back, open, front, radialIn);
  const rim = piece();
  // the chamfer runs as far across the face as it falls toward it: its normal halfway between the radial and the face's
  band(rim, shoulder, front, edge, foot, (k) => radial(k).add(at0.out).normalize());
  band(rim, edge, foot, edge, back, radial);
  band(rim, edge, back, shoulder, back, inward);
  band(rim, shoulder, back, shoulder, front, radialIn);
  const well = piece();
  disc(well, open, wellFront, 1);
  disc(well, open, wellBack, -1);
  band(well, open, wellFront, open, wellBack, radial);
  const faceData = piece();
  disc(faceData, radius, faceFront, 1, true);
  disc(faceData, radius, faceBack, -1);
  band(faceData, radius, faceFront, radius, faceBack, radial);
  return { frame, rim, well, face: faceData };
}

/**
 * The bezel FRAMES' own material (P1b), the 747's alone: dark neutral grey with the board's finish and NO emissive,
 * lighter than the board by albedo alone (the design's 1.3 to 1.6 times its luma; the Global's frames read 1.46 live).
 * The chamfered RIM round each frame is on the shared marking material, which carries the night glow.
 */
export const AIRLINER_BEZEL_ALBEDO = 0x2c3034;
function airlinerBezelMaterial(build: AircraftBuildContext): PBRMaterial {
  return build.material("airliner-bezel", AIRLINER_BEZEL_ALBEDO, { roughness: 0.82, metallic: 0.02 });
}

// ---- the frame: one welded surface cast on the skin round the glass, its openings rolled ----------

/**
 * How far below and above the glass the frame runs, in R's elevation (past the frame's edges from the eye, with
 * room), how far outboard (R's azimuth, past No.3's outboard edge, so every pane has frame all round it), the widest
 * step between its grid lines (`airlinerLiningLines`), and how far it stands out of the skin and in from it.
 *
 * THE DEPTH IS THE FRAME'S LOOK. The lining was the glass's own slab, 0.04 out and 0.06 in, and from the eye that
 * 0.10 m of depth showed as a second, lit face down the side of every pillar: half the No.1 / No.2 pillar's
 * apparent width (1.9 of 3.8 degrees) was side face, and the pillars read thick and two-toned where they are 6.5 cm
 * across. At 0.02 m the side is 0.4 degrees and the pillar reads 2.3, nearly all face (K3,
 * docs/findings/COCKPIT_VIEW_2026_09_20.md). The window the pilot sees is the frame's own opening: its face stands
 * `depth` in from the skin and its return rolls out to a seal `proud` out of it, so the sill's return, not the
 * hidden glass's outer face, is the bottom of the view, and the lip is solved against that.
 */
export const AIRLINER_LINING = Object.freeze({ bottom: -30, top: 40, outboard: 78, maxStepDegrees: 5, proud: 0.008, depth: 0.012 });

export interface LiningStrip {
  readonly name: string;
  /** R's azimuths, outboard positive on each side. A CENTRE strip runs from the starboard value to the port one. */
  readonly azimuth: readonly [number, number];
  readonly elevation: readonly [number, number];
  /** Built once across the centreline, or once a side (mirrored). */
  readonly centre: boolean;
}

/**
 * The frame's REGIONS, named: every rectangle of R's sky round the glass that is not glass, READ from
 * `FLIGHT_DECK_PANES` and `CENTRE_POST_HALF_AZIMUTH`: the sill under each pane and the crown over it, the pillar
 * between neighbours (as tall as the taller of the two), the centre post between the No.1 panes, and the strip
 * outboard of No.3. Together with the panes they tile R's view from `AIRLINER_LINING.bottom` to `.top` and out to
 * `.outboard`. The frame is ONE surface (`airlinerWindowFrame`); these name its parts for whoever measures one.
 */
export function airlinerLiningStrips(): readonly LiningStrip[] {
  const [one, two, three] = [FLIGHT_DECK_PANES[0]!, FLIGHT_DECK_PANES[1]!, FLIGHT_DECK_PANES[2]!];
  const { bottom, top, outboard } = AIRLINER_LINING;
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
    { name: "sill-three", azimuth: [three.azimuth[0], outboard], elevation: [bottom, three.elevation[0]], centre: false },
    { name: "crown-three", azimuth: [three.azimuth[0], outboard], elevation: [three.elevation[1], top], centre: false },
    { name: "outboard", azimuth: [three.azimuth[1], outboard], elevation: three.elevation, centre: false },
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
 * THE FRAME'S ONE GRID, in R's angles: the panes' own edges and the post's, with lines added between them no more than
 * `maxStepDegrees` apart, and nothing between the post's two edges. Azimuths are SIGNED here, starboard positive: the
 * port lines are the starboard ones mirrored, and a mirrored sightline is the same ray to the last bit.
 */
export function airlinerLiningLines(): { azimuth: readonly number[]; elevation: readonly number[] } {
  const [one, two, three] = [FLIGHT_DECK_PANES[0]!, FLIGHT_DECK_PANES[1]!, FLIGHT_DECK_PANES[2]!];
  const unique = (values: readonly number[]) => [...new Set(values)].sort((a, b) => a - b);
  const port = subdivided(unique([CENTRE_POST_HALF_AZIMUTH, ...[one, two, three].flatMap((pane) => [...pane.azimuth]), AIRLINER_LINING.outboard]));
  const breaks = [AIRLINER_LINING.bottom, AIRLINER_LINING.top, ...[one, two, three].flatMap((pane) => [...pane.elevation])];
  return {
    azimuth: [...port.map((a) => -a).reverse(), ...port],
    elevation: subdivided(unique(breaks)),
  };
}

/**
 * THE OPENINGS ARE ROLLED (S1). Every edge of every pane's opening was the 2 cm frame cut square: from the seat, 109
 * edges sharper than 45 degrees ran round the glass (the P0 survey), and the pillars read as bars sawn off a plank.
 * Now the frame's face stops `returnRadius` short of each opening and ROLLS into it: a quarter round from the face
 * (tangent to it) to the opening's wall (tangent to that), which runs on out to the rim, `AIRLINER_LINING.proud` out
 * of the skin. The last `seal` of that profile, the glass's side of it, is the window's SEAL, on the glareshield's
 * matte (`airliner-window-seals`): a dark line round the glass, as the type's rubber reads.
 *
 * CARVED, NOT ADDED: the profile lies inside the old square one, so its rim is the pane's edge, at the same cast point.
 * What the carve takes is the corner the eye saw, and on a member's near side that corner WAS its edge from the seat:
 * rolled, the No.1 / No.2 pillar read 2.04 to 2.16 degrees where it read 2.23 to 2.38 square, and the post 3.53 to 3.58
 * where it read 3.66 to 3.69. So at the pillars and the post the seal LAPS the glass by `lap`, as a real seal does: the
 * members read as wide as they did. The sills and the crowns do not lap, so the deck line's sill rule and the panes'
 * tops are where they were.
 *
 * `cornerRadiusDegrees` rounds each pane's opening's corners in R's angles (S2), a radius a pane; at 0 they are square
 * and their returns meet in a mitre. A pane pays for its rounds in glass, and the smallest pays most for the same
 * radius: at 3 degrees No.1, No.2 and No.3 lost 1.15, 1.10 and 2.05% of their openings. Each is held to about 1%: 2.8,
 * 2.8 and 2.0 degrees (the radius for exactly 1% is 2.80, 2.87 and 2.09).
 */
export const AIRLINER_FRAME = Object.freeze({
  returnRadius: 0.015,
  /** Along the profile from the rim inward: the return's last millimetre and the wall's five. */
  seal: 0.006,
  /** The seal's thickness behind its face: a closed solid, so no ray meets the back of a sheet. */
  sealBack: 0.001,
  returnSegments: 6,
  /** How far the frame laps the glass at every opening's two sides (the pillars' and the post's edges), not at its top and bottom. */
  lap: 0.003,
  cornerRadiusDegrees: Object.freeze({ one: 2.8, two: 2.8, three: 2 }) as Readonly<Record<string, number>>,
  cornerSegments: 6,
});

/** A point of the return's profile: `u` along the frame's face, away from the opening; `n` out of the skin. */
export interface FrameProfilePoint {
  readonly u: number;
  readonly n: number;
  /** The shading normal's angle in the profile: 0 faces the cabin (the face's own), 90 degrees faces the opening. */
  readonly theta: number;
}

/**
 * The profile, from the face to the rim: the RETURN's points (on the interior material, the first one the face's own
 * edge) and the SEAL's closed section (its face first: the return's last point, the wall's foot, the rim; then its
 * back, `sealBack` into the frame).
 */
export function airlinerFrameProfile(): { readonly ret: readonly FrameProfilePoint[]; readonly seal: readonly FrameProfilePoint[] } {
  const { returnRadius: r, seal, sealBack, returnSegments } = AIRLINER_FRAME;
  const { proud, depth } = AIRLINER_LINING;
  const wall = proud + depth - r;
  if (!(wall >= 0) || !(seal >= wall) || !(seal - wall < (Math.PI / 2) * r)) {
    throw new RangeError("747 cockpit frame: the return must fit the lining and the seal must cover its wall and end on its arc");
  }
  const sealFrom = Math.PI / 2 - (seal - wall) / r;
  const arc = (theta: number): FrameProfilePoint => ({ u: r * (1 - Math.sin(theta)), n: -depth + r * (1 - Math.cos(theta)), theta });
  const ret = Array.from({ length: returnSegments + 1 }, (_, k) => arc((sealFrom * k) / returnSegments));
  const last = ret.at(-1)!;
  return {
    ret,
    seal: [last, arc(Math.PI / 2), { u: 0, n: proud, theta: Math.PI / 2 }, { u: sealBack, n: proud, theta: Math.PI / 2 }, { u: sealBack, n: last.n, theta: Math.PI / 2 }],
  };
}

interface Angles { readonly a: number; readonly e: number }

/** One station of an opening's loop: where the return's section is laid. */
export interface FrameStation {
  /** In R's angles (azimuth signed, starboard positive), grown off the opening by about the return's own width: where the face's hole passes. */
  readonly at: Angles;
  /** The point of the opening it is laid from, on the pane's edge (or its rounded corner). */
  readonly opening: Angles;
  /** That point cast on the skin, and the skin's normal there (outward). */
  readonly point: Vector3;
  readonly normal: Vector3;
  /**
   * The section's `u`, per metre of it: from the opening point to the skin `returnRadius` away across the edge, away from
   * the glass (a mitre's to the grown corner, so longer), so the face's edge (`u` = `returnRadius`) is ON the skin.
   */
  readonly offset: Vector3;
  /** The wall's direction away from the glass, in the skin's plane, on the loop's run INTO and OUT OF the station (equal but at a mitre). */
  readonly before: Vector3;
  readonly after: Vector3;
  /** The grid line it lies on, if any. */
  readonly line: { readonly family: "a" | "e"; readonly value: number } | null;
}

/** A pane's opening: its stations, counterclockwise in R's angles as the pilot looks out. */
export interface FrameLoop {
  readonly name: string;
  readonly stations: readonly FrameStation[];
}

export interface WindowFrame {
  /** The face and the returns: ONE welded surface, face triangles first. */
  readonly frame: { readonly positions: number[]; readonly normals: number[]; readonly indices: number[] };
  readonly faceTriangles: number;
  /** The seals: a closed thin solid round each opening. */
  readonly seals: { readonly positions: number[]; readonly normals: number[]; readonly indices: number[] };
  readonly loops: readonly FrameLoop[];
}

/** A pane's opening in signed azimuth (starboard positive) and elevation. */
interface Opening { readonly name: string; readonly a0: number; readonly a1: number; readonly e0: number; readonly e1: number; readonly rho: number }

function frameOpenings(): Opening[] {
  const out: Opening[] = [];
  for (const pane of FLIGHT_DECK_PANES) {
    for (const side of [-1, 1] as const) {
      const [p, q] = pane.azimuth;
      const rho = AIRLINER_FRAME.cornerRadiusDegrees[pane.name];
      if (rho === undefined) throw new RangeError(`747 cockpit frame: no corner radius for pane ${pane.name}`);
      out.push({ name: `${side < 0 ? "port" : "starboard"}-${pane.name}`, a0: side < 0 ? -q : p, a1: side < 0 ? -p : q, e0: pane.elevation[0], e1: pane.elevation[1], rho });
    }
  }
  return out;
}

/**
 * THE WINDOW FRAME, built on the skin from R's grid (`airlinerLiningLines`): one welded surface where the lining was
 * fifteen strips meeting at doubled rims, so there is no seam between its parts to show.
 *
 * Each pane's opening is a LOOP of stations: its edges' crossings of the grid lines, its corners (a mitre, or the
 * samples of a round), each cast on the skin. The face is the grid with a hole round each opening, grown by the
 * return's width: a grid cell the hole cuts is re-cut along the loop (the stations it crosses are the cell's corners
 * there) and triangulated, so the face's edge and the return's first ring are the same vertices. The return is the
 * profile swept round the loop; the seal is swept after it, a closed section of its own.
 */
export function airlinerWindowFrame(skin: SkinCaster): WindowFrame {
  const { returnRadius: r, cornerSegments } = AIRLINER_FRAME;
  const { depth } = AIRLINER_LINING;
  const lines = airlinerLiningLines();
  const A = lines.azimuth;
  const E = lines.elevation;
  const casts = new Map<string, { point: Vector3; normal: Vector3 }>();
  const cast = (a: number, e: number) => {
    const key = `${a}|${e}`;
    let hit = casts.get(key);
    if (!hit) {
      const got = skin.exit(FLIGHT_DECK_REFERENCE, sightline(Math.abs(a), e, a < 0 ? -1 : 1));
      if (!got) throw new RangeError(`747 cockpit frame: no skin at az ${a.toFixed(2)}, el ${e.toFixed(2)}`);
      hit = { point: new Vector3(got.point.x, got.point.y, got.point.z), normal: new Vector3(got.normal.x, got.normal.y, got.normal.z) };
      casts.set(key, hit);
    }
    return hit;
  };
  const reference = new Vector3(FLIGHT_DECK_REFERENCE.x, FLIGHT_DECK_REFERENCE.y, FLIGHT_DECK_REFERENCE.z);
  /**
   * How far to step R's angles from an opening point along `out` to reach the skin `returnRadius` away. Not r over the
   * distance: R sees the sills and the crowns at a slant, and that step landed 20 to 26 mm down them. Solved instead, the
   * step scaled by the chord it reached, three times over (to a hundredth of a millimetre).
   */
  const stepFor = (o: Angles, out: Angles): number => {
    const here = cast(o.a, o.e).point;
    let step = (r / Vector3.Distance(here, reference)) * (180 / Math.PI);
    for (let k = 0; k < 3; k += 1) step *= r / Vector3.Distance(cast(o.a + out.a * step, o.e + out.e * step).point, here);
    return step;
  };
  /**
   * The skin `returnRadius` from an opening point across each of `outs` (one, or a mitre's two): CAST, so the face's edge
   * lies on the skin as the rest of the face does. Offset in the skin's plane instead, it floated up to 8 mm off it across
   * the nose's own facet creases (33 degrees under the No.1 / No.2 pillar), and the pillar's face folded 53 degrees.
   */
  const grown = (o: Angles, outs: readonly Angles[]): Vector3 => {
    let [a, e] = [o.a, o.e];
    for (const out of outs) {
      const step = stepFor(o, out);
      a += out.a * step;
      e += out.e * step;
    }
    return cast(a, e).point;
  };
  /** The part of a vector in the skin's plane at `normal`, unit. */
  const inPlane = (v: Vector3, normal: Vector3) => v.subtract(normal.scale(Vector3.Dot(v, normal))).normalize();
  const onLine = (at: Angles): FrameStation["line"] => {
    const onA = A.find((v) => Math.abs(v - at.a) < 1e-9);
    const onE = E.find((v) => Math.abs(v - at.e) < 1e-9);
    if (onA !== undefined && onE !== undefined) throw new RangeError(`747 cockpit frame: an opening's loop passes through a grid vertex (${at.a}, ${at.e})`);
    if (onA !== undefined) return { family: "a", value: onA };
    if (onE !== undefined) return { family: "e", value: onE };
    return null;
  };

  // ---- THE LOOPS -------------------------------------------------------------------------------
  // each pane's opening, its sides lapped by `lap` at the pane's distance from R
  const openings = frameOpenings().map((o) => {
    const lap = (AIRLINER_FRAME.lap / Vector3.Distance(cast((o.a0 + o.a1) / 2, (o.e0 + o.e1) / 2).point, reference)) * (180 / Math.PI);
    return { ...o, a0: o.a0 + lap, a1: o.a1 - lap };
  });
  /** How far each opening's hole is grown in R's angles: the return's width at the pane's distance from R. */
  const grows = openings.map((o) => (r / Vector3.Distance(cast((o.a0 + o.a1) / 2, (o.e0 + o.e1) / 2).point, reference)) * (180 / Math.PI));
  const insideGrown = (o: Opening, g: number, a: number, e: number): boolean => {
    const { rho } = o;
    if (rho === 0) return a > o.a0 - g && a < o.a1 + g && e > o.e0 - g && e < o.e1 + g;
    const dx = Math.max(o.a0 + rho - a, 0, a - (o.a1 - rho));
    const dy = Math.max(o.e0 + rho - e, 0, e - (o.e1 - rho));
    return Math.hypot(dx, dy) < rho + g;
  };
  interface Raw { at: Angles; opening: Angles; out: Angles; mitre?: { outIn: Angles; outOut: Angles } }
  const loops: FrameLoop[] = openings.map((o, index) => {
    const g = grows[index]!;
    const { rho } = o;
    const raws: Raw[] = [];
    // the four edges, counterclockwise from the bottom, and the corner each ends in
    const edges = [
      { t: { a: 1, e: 0 }, out: { a: 0, e: -1 }, corner: { a: o.a1, e: o.e0 } },
      { t: { a: 0, e: 1 }, out: { a: 1, e: 0 }, corner: { a: o.a1, e: o.e1 } },
      { t: { a: -1, e: 0 }, out: { a: 0, e: 1 }, corner: { a: o.a0, e: o.e1 } },
      { t: { a: 0, e: -1 }, out: { a: -1, e: 0 }, corner: { a: o.a0, e: o.e0 } },
    ] as const;
    edges.forEach((edge, k) => {
      const next = edges[(k + 1) % 4]!;
      const horizontal = edge.t.e === 0;
      // the straight run: from its start to its end, as a coordinate along the edge
      const fixed = horizontal ? (edge.out.e < 0 ? o.e0 : o.e1) : (edge.out.a > 0 ? o.a1 : o.a0);
      const [lo, hi] = horizontal ? [o.a0 + rho, o.a1 - rho] : [o.e0 + rho, o.e1 - rho];
      const forward = (horizontal ? edge.t.a : edge.t.e) > 0;
      // square (rho 0), the grown edge runs on to its mitres, `g` past the opening's corners, and crosses any line there
      const along = (horizontal ? A : E).filter((v) => (rho === 0 ? v >= lo - g && v <= hi + g : v > lo + 1e-9 && v < hi - 1e-9));
      const run = rho === 0 ? along : [forward ? lo : hi, ...along];
      const ordered = forward ? [...run].sort((x, y) => x - y) : [...run].sort((x, y) => y - x);
      for (const v of ordered) {
        const on = Math.min(hi, Math.max(lo, v));
        const opening = horizontal ? { a: on, e: fixed } : { a: fixed, e: on };
        const at = horizontal ? { a: v, e: fixed + edge.out.e * g } : { a: fixed + edge.out.a * g, e: v };
        raws.push({ at, opening, out: edge.out });
      }
      if (rho === 0) {
        // the corner: a mitre, its offset meeting both walls
        raws.push({
          at: { a: edge.corner.a + (edge.out.a + next.out.a) * g, e: edge.corner.e + (edge.out.e + next.out.e) * g },
          opening: edge.corner, out: edge.out,
          mitre: { outIn: edge.out, outOut: next.out },
        });
        return;
      }
      // the corner: a round about its centre, from this edge's end to the next edge's start
      const centre = { a: edge.corner.a - (edge.out.a + next.out.a) * rho, e: edge.corner.e - (edge.out.e + next.out.e) * rho };
      const from = Math.atan2(edge.out.e, edge.out.a);
      let to = Math.atan2(next.out.e, next.out.a);
      if (to < from) to += 2 * Math.PI;
      const grown = rho + g;
      const phis = Array.from({ length: cornerSegments }, (_, s) => from + ((to - from) * s) / cornerSegments);
      for (const L of A) {
        const dx = L - centre.a;
        if (Math.abs(dx) >= grown) continue;
        for (const sign of [-1, 1]) phis.push(Math.atan2(sign * Math.sqrt(grown * grown - dx * dx), dx));
      }
      for (const L of E) {
        const dy = L - centre.e;
        if (Math.abs(dy) >= grown) continue;
        for (const sign of [-1, 1]) phis.push(Math.atan2(dy, sign * Math.sqrt(grown * grown - dy * dy)));
      }
      const inRange = phis
        .map((phi) => (phi < from - 1e-12 ? phi + 2 * Math.PI : phi))
        .filter((phi) => phi >= from - 1e-12 && phi < to - 1e-9)
        .sort((x, y) => x - y)
        .filter((phi, i, all) => i === 0 || phi - all[i - 1]! > 1e-9);
      for (const phi of inRange) {
        const c = Math.cos(phi);
        const s = Math.sin(phi);
        raws.push({
          at: { a: centre.a + grown * c, e: centre.e + grown * s },
          opening: { a: centre.a + rho * c, e: centre.e + rho * s },
          out: { a: c, e: s },
        });
      }
    });
    const stations = raws.map((raw): FrameStation => {
      const { point, normal } = cast(raw.opening.a, raw.opening.e);
      const toward = (...outs: Angles[]) => grown(raw.opening, outs).subtract(point);
      if (raw.mitre) {
        const { outIn, outOut } = raw.mitre;
        const offset = toward(outIn, outOut).scale(1 / r);
        return { at: raw.at, opening: raw.opening, point, normal, offset, before: inPlane(toward(outIn), normal), after: inPlane(toward(outOut), normal), line: onLine(raw.at) };
      }
      const offset = toward(raw.out).scale(1 / r);
      const wall = inPlane(offset, normal);
      return { at: raw.at, opening: raw.opening, point, normal, offset, before: wall, after: wall, line: onLine(raw.at) };
    });
    let area = 0;
    stations.forEach((s, i) => {
      const n = stations[(i + 1) % stations.length]!;
      area += s.at.a * n.at.e - n.at.a * s.at.e;
    });
    if (!(area > 0)) throw new RangeError(`747 cockpit frame: ${o.name}'s loop is not counterclockwise`);
    return { name: o.name, stations };
  });

  // ---- THE FACE --------------------------------------------------------------------------------
  const positions: number[] = [];
  const normals: number[] = [];
  const indices: number[] = [];
  const vertexOf = new Map<string, number>();
  const addVertex = (p: Vector3, n: Vector3): number => {
    positions.push(p.x, p.y, p.z);
    normals.push(n.x, n.y, n.z);
    return positions.length / 3 - 1;
  };
  /** A station's face vertex: the return's first point, the face's own edge. */
  const faceEdge = (s: FrameStation): Vector3 => s.point.add(s.offset.scale(r)).subtract(s.normal.scale(depth));
  type Corner = { kind: "grid"; i: number; j: number } | { kind: "station"; loop: number; k: number };
  const keyOf = (c: Corner) => (c.kind === "grid" ? `g${c.i},${c.j}` : `s${c.loop},${c.k}`);
  const angleOf = (c: Corner): Angles => (c.kind === "grid" ? { a: A[c.i]!, e: E[c.j]! } : loops[c.loop]!.stations[c.k]!.at);
  const vertex = (c: Corner): number => {
    const key = keyOf(c);
    let v = vertexOf.get(key);
    if (v === undefined) {
      if (c.kind === "grid") {
        const hit = cast(A[c.i]!, E[c.j]!);
        v = addVertex(hit.point.subtract(hit.normal.scale(depth)), hit.normal.scale(-1));
      } else {
        const s = loops[c.loop]!.stations[c.k]!;
        v = addVertex(faceEdge(s), s.normal.scale(-1));
      }
      vertexOf.set(key, v);
    }
    return v;
  };
  const insideAny = (at: Angles) => openings.findIndex((o, index) => insideGrown(o, grows[index]!, at.a, at.e));
  /** A triangle of the face or the return, wound so its cross product points INTO the solid: against `outward`. */
  const triangle = (list: number[], data: { positions: number[] }, i0: number, i1: number, i2: number, outward: Vector3) => {
    const p = (i: number) => new Vector3(data.positions[i * 3]!, data.positions[i * 3 + 1]!, data.positions[i * 3 + 2]!);
    const cross = Vector3.Cross(p(i1).subtract(p(i0)), p(i2).subtract(p(i0)));
    if (cross.length() < 1e-14) {
      // a strip between two stations laid from the same corner closes to a point where u is 0 (the wall's own corner
      // line): that half of the quad is no triangle, and is left out. Any other sliver is a fault.
      const [a, b, c] = [p(i0), p(i1), p(i2)];
      if (Vector3.Distance(a, b) < 1e-12 || Vector3.Distance(b, c) < 1e-12 || Vector3.Distance(c, a) < 1e-12) return;
      throw new RangeError("747 cockpit frame: a degenerate triangle");
    }
    if (Vector3.Dot(cross, outward) > 0) list.push(i0, i2, i1);
    else list.push(i0, i1, i2);
  };
  const faceTriangle = (a: number, b: number, c: number) => {
    const n = new Vector3(normals[a * 3]! + normals[b * 3]! + normals[c * 3]!, normals[a * 3 + 1]! + normals[b * 3 + 1]! + normals[c * 3 + 1]!, normals[a * 3 + 2]! + normals[b * 3 + 2]! + normals[c * 3 + 2]!);
    triangle(indices, { positions }, a, b, c, n);
  };
  // which stations lie on which grid line
  const onGrid = new Map<string, { loop: number; k: number }[]>();
  loops.forEach((loop, l) => loop.stations.forEach((s, k) => {
    if (!s.line) return;
    const key = `${s.line.family}${s.line.value}`;
    onGrid.set(key, [...(onGrid.get(key) ?? []), { loop: l, k }]);
  }));
  for (let i = 0; i + 1 < A.length; i += 1) {
    for (let j = 0; j + 1 < E.length; j += 1) {
      // the cell's boundary, counterclockwise, with the loops' crossings of it in order
      const ring: Corner[] = [];
      const sides: [Corner, "a" | "e", number, number, number, boolean][] = [
        [{ kind: "grid", i, j }, "e", E[j]!, A[i]!, A[i + 1]!, true],
        [{ kind: "grid", i: i + 1, j }, "a", A[i + 1]!, E[j]!, E[j + 1]!, true],
        [{ kind: "grid", i: i + 1, j: j + 1 }, "e", E[j + 1]!, A[i]!, A[i + 1]!, false],
        [{ kind: "grid", i, j: j + 1 }, "a", A[i]!, E[j]!, E[j + 1]!, false],
      ];
      let crossings = 0;
      for (const [corner, family, value, lo, hi, ascending] of sides) {
        ring.push(corner);
        const coordinate = (c: { loop: number; k: number }) => (family === "e" ? loops[c.loop]!.stations[c.k]!.at.a : loops[c.loop]!.stations[c.k]!.at.e);
        const on = (onGrid.get(`${family}${value}`) ?? []).filter((c) => coordinate(c) > lo && coordinate(c) < hi);
        on.sort((x, y) => (ascending ? coordinate(x) - coordinate(y) : coordinate(y) - coordinate(x)));
        for (const c of on) ring.push({ kind: "station", ...c });
        crossings += on.length;
      }
      if (crossings === 0) {
        const middle = { a: (A[i]! + A[i + 1]!) / 2, e: (E[j]! + E[j + 1]!) / 2 };
        if (insideAny(middle) >= 0) continue;
        const [c0, c1, c2, c3] = ring.map(vertex) as [number, number, number, number];
        faceTriangle(c0, c1, c3);
        faceTriangle(c1, c2, c3);
        continue;
      }
      // cut along each loop that crosses it: in at one crossing, round the loop backwards (clockwise) to the other
      const polygon: Corner[] = [];
      for (let n = 0; n < ring.length; n += 1) {
        const c = ring[n]!;
        if (c.kind === "grid") {
          if (insideAny(angleOf(c)) < 0) polygon.push(c);
          continue;
        }
        polygon.push(c);
        const next = angleOf(ring[(n + 1) % ring.length]!);
        const here = angleOf(c);
        const loop = loops[c.loop]!;
        if (!insideGrown(openings[c.loop]!, grows[c.loop]!, (here.a + next.a) / 2, (here.e + next.e) / 2)) continue;
        const exit = ring.slice(n + 1).concat(ring.slice(0, n)).find((x) => x.kind === "station" && x.loop === c.loop) as Corner & { kind: "station" } | undefined;
        if (!exit) throw new RangeError(`747 cockpit frame: the cell (${i}, ${j}) is entered by ${loop.name}'s loop and never left`);
        const count = loop.stations.length;
        for (let k = (c.k - 1 + count) % count; k !== exit.k; k = (k - 1 + count) % count) polygon.push({ kind: "station", loop: c.loop, k });
      }
      for (const [x, y, z] of earClip(polygon.map(angleOf))) faceTriangle(vertex(polygon[x]!), vertex(polygon[y]!), vertex(polygon[z]!));
    }
  }
  const faceTriangles = indices.length / 3;

  // ---- THE RETURNS AND THE SEALS -----------------------------------------------------------------
  const profile = airlinerFrameProfile();
  const sealPositions: number[] = [];
  const sealNormals: number[] = [];
  const sealIndices: number[] = [];
  const sealVertex = (p: Vector3, n: Vector3) => {
    sealPositions.push(p.x, p.y, p.z);
    sealNormals.push(n.x, n.y, n.z);
    return sealPositions.length / 3 - 1;
  };
  const place = (s: FrameStation, q: { u: number; n: number }) => s.point.add(s.offset.scale(q.u)).add(s.normal.scale(q.n));
  const shade = (s: FrameStation, wall: Vector3, theta: number) => wall.scale(-Math.sin(theta)).subtract(s.normal.scale(Math.cos(theta)));
  loops.forEach((loop, l) => {
    const count = loop.stations.length;
    // each station's ring of the return, on its arriving side and its leaving side (one ring but at a mitre); the first
    // point is the face's own vertex
    const rings = loop.stations.map((s, k) => {
      const make = (wall: Vector3) => profile.ret.map((q, m) => (m === 0 ? vertex({ kind: "station", loop: l, k }) : addVertex(place(s, q), shade(s, wall, q.theta))));
      const before = make(s.before);
      return { before, after: s.before === s.after ? before : make(s.after) };
    });
    for (let k = 0; k < count; k += 1) {
      const from = rings[k]!.after;
      const to = rings[(k + 1) % count]!.before;
      for (let m = 0; m + 1 < profile.ret.length; m += 1) {
        const out = (v: number) => new Vector3(normals[v * 3]!, normals[v * 3 + 1]!, normals[v * 3 + 2]!);
        const outward = out(from[m]!).add(out(from[m + 1]!)).add(out(to[m]!)).add(out(to[m + 1]!));
        triangle(indices, { positions }, from[m]!, from[m + 1]!, to[m + 1]!, outward);
        triangle(indices, { positions }, from[m]!, to[m + 1]!, to[m]!, outward);
      }
    }
    // the seal: its section's five sides, each a strip round the loop; the face (the return's last millimetre and the
    // wall) shaded as the return, the rest flat
    const sides = profile.seal.map((q, m) => [q, profile.seal[(m + 1) % profile.seal.length]!] as const);
    const sealRing = (s: FrameStation, wall: Vector3) => sides.map(([p, q], m) => {
      const flat = [wall.scale(-1), s.normal, wall, s.normal.scale(-1)][m - 1];
      const normalAt = (x: FrameProfilePoint) => (m === 0 ? shade(s, wall, x.theta) : flat!);
      return [sealVertex(place(s, p), normalAt(p)), sealVertex(place(s, q), normalAt(q))] as const;
    });
    const sealRings = loop.stations.map((s) => {
      const before = sealRing(s, s.before);
      return { before, after: s.before === s.after ? before : sealRing(s, s.after) };
    });
    for (let k = 0; k < count; k += 1) {
      const from = sealRings[k]!.after;
      const to = sealRings[(k + 1) % count]!.before;
      from.forEach(([p0, q0], m) => {
        const [p1, q1] = to[m]!;
        const n = (v: number) => new Vector3(sealNormals[v * 3]!, sealNormals[v * 3 + 1]!, sealNormals[v * 3 + 2]!);
        const outward = n(p0).add(n(q0)).add(n(p1)).add(n(q1));
        triangle(sealIndices, { positions: sealPositions }, p0, q0, q1, outward);
        triangle(sealIndices, { positions: sealPositions }, p0, q1, p1, outward);
      });
    }
  });
  return {
    frame: { positions, normals, indices },
    faceTriangles,
    seals: { positions: sealPositions, normals: sealNormals, indices: sealIndices },
    loops,
  };
}

/**
 * A simple polygon's triangles by ear clipping, in its own plane: the polygon counterclockwise, the triangles as index
 * triples into it. An ear is a strictly convex corner whose triangle holds no other corner, on its edges included, so a
 * corner lying on a diagonal is never skipped over (it is a vertex a neighbouring cell shares).
 */
function earClip(points: readonly Angles[]): [number, number, number][] {
  const left = points.map((_, i) => i);
  const out: [number, number, number][] = [];
  const cross = (o: Angles, p: Angles, q: Angles) => (p.a - o.a) * (q.e - o.e) - (p.e - o.e) * (q.a - o.a);
  const within = (x: Angles, a: Angles, b: Angles, c: Angles) => cross(a, b, x) >= -1e-12 && cross(b, c, x) >= -1e-12 && cross(c, a, x) >= -1e-12;
  while (left.length > 3) {
    let clipped = false;
    for (let n = 0; n < left.length; n += 1) {
      const [i, j, k] = [left[(n - 1 + left.length) % left.length]!, left[n]!, left[(n + 1) % left.length]!];
      const [a, b, c] = [points[i]!, points[j]!, points[k]!];
      if (cross(a, b, c) <= 1e-12) continue;
      if (left.some((m) => m !== i && m !== j && m !== k && within(points[m]!, a, b, c))) continue;
      out.push([i, j, k]);
      left.splice(n, 1);
      clipped = true;
      break;
    }
    if (!clipped) throw new RangeError("747 cockpit frame: a cell's polygon has no ear (it is not simple, or not counterclockwise)");
  }
  if (cross(points[left[0]!]!, points[left[1]!]!, points[left[2]!]!) <= 1e-12) throw new RangeError("747 cockpit frame: a cell's last triangle has no area");
  out.push([left[0]!, left[1]!, left[2]!]);
  return out;
}

/** A mesh from raw vertex data, made as a `solidPlate` so the builder owns, parents and registers it (as `facetMesh` does). */
function dataMesh(
  build: AircraftBuildContext,
  name: string,
  data: { readonly positions: number[]; readonly normals: number[]; readonly indices: number[]; readonly uvs?: number[] },
  material: PBRMaterial,
  parent: TransformNode,
): Mesh {
  const mesh = solidPlate(build, name, [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 0, y: 1 }], 1, material, parent);
  const vertexData = new VertexData();
  vertexData.positions = data.positions;
  vertexData.normals = data.normals;
  vertexData.uvs = data.uvs ?? new Array<number>((data.positions.length / 3) * 2).fill(0);
  vertexData.indices = data.indices;
  vertexData.applyToMesh(mesh, false);
  mesh.refreshBoundingInfo();
  return mesh;
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
 * SEVEN meshes, all static: the board and the window frame on the interior material; the glareshield's rounded deck
 * on the glareshield's matte; the window seals round the glass on the same matte; the six screens; their six bezel
 * frames; the frames' chamfered rims, on the marking (the night glow); the wells behind the gaps round the screens.
 */
export function buildAirlinerCockpit(
  build: AircraftBuildContext,
  root: TransformNode,
  materials: AirlinerCockpitMaterials,
  skin: SkinCaster,
): AirlinerCockpit {
  const parts: AbstractMesh[] = [];
  const p = AIRLINER_PANEL;

  // THE WINDOW FRAME, one welded surface cast on the skin round the glass, its openings rolled (`airlinerWindowFrame`);
  // the seals at the glass line on the glareshield's matte, the same material as the deck's (one draw state, no new one).
  const glare = glareshieldMaterial(build, "airliner-glareshield");
  const windowFrame = airlinerWindowFrame(skin);
  const frame = dataMesh(build, "airliner-window-frame", windowFrame.frame, materials.interior, root);
  parts.push(dataMesh(build, "airliner-window-seals", windowFrame.seals, glare, root));

  // THE GLARESHIELD, a rounded deck (`airlinerGlareshieldSection`) on a material of its own (matte near-black, no
  // reflection): a glareshield must not reflect in the windscreen. It is the whole deck line, so it is the mesh named for
  // it. Swept with the board along the deck's plan path (S4: across, and round aft to each side), its round shaded round.
  const section = airlinerGlareshieldSection();
  const roundFrom = section.outline.length - section.round.length;
  parts.push(sweptDeck(build, "airliner-glareshield", section.outline, [{ first: roundFrom, last: section.outline.length - 1, centre: section.centre }], glare, root));

  // THE PANEL BOARD, its face leaned back from its top edge at the cove's foot down past the frame's bottom, swept along
  // the same path: across between the pilots, and round aft to each side.
  const face = airlinerPanelFace();
  const lean = p.leanDegrees * DEG;
  const board = sweptDeck(build, "airliner-instrument-panel", airlinerBoardSection(), [], materials.interior, root);

  // THE SCREENS, THEIR BEZELS AND THEIR WELLS: four meshes, turned back with the face. A screen is a thin glass plate
  // RECESSED behind its bezel's front; the bezel a frame round it on its own dark material, its chamfered rim on the
  // marking (the night glow's); behind the gap between them, a well on the instrument-face material, dark.
  const s = AIRLINER_SCREENS;
  const bezelMaterial = airlinerBezelMaterial(build);
  const screens: AbstractMesh[] = [];
  const frames: AbstractMesh[] = [];
  const rims: AbstractMesh[] = [];
  const wells: AbstractMesh[] = [];
  for (const { name, centre, faceCentre } of airlinerScreenPlacements()) {
    const screen = build.box(
      `airliner-screen-${name}`, s.screenThickness, s.height, s.width, materials.instrumentFace, root,
    );
    screen.position.copyFrom(centre);
    screen.rotation.z = -lean;
    screens.push(screen);
    const facets = framedScreenFacets(faceCentre, face, s);
    frames.push(facetMesh(build, `airliner-screen-bezel-${name}`, facets.frame, bezelMaterial, root));
    rims.push(facetMesh(build, `airliner-screen-bezel-rim-${name}`, facets.rim, materials.instrumentMarking, root));
    const well = build.box(`airliner-screen-well-${name}`, s.wellThickness, s.height + s.gap * 2, s.width + s.gap * 2, materials.instrumentFace, root);
    well.position.copyFrom(faceCentre);
    well.rotation.z = -lean;
    wells.push(well);
  }
  // EACH SCREEN'S PILOT-FACING FACE GETS ITS OWN SLOT of the display atlas, before the merge bakes
  // the vertex data. The boxes are built in `SCREEN_LAYOUT` order and the slots are in the same order, so
  // slot i belongs to screen i; `tests/render.cockpit-displays.test.ts` holds that pairing by
  // measuring the merged mesh's UVs against each screen's own place.
  // THE CLOCK (S4): its frame, rim and well with the screens' own (one draw each, as they are), its face a mesh of its own
  const clock = airlinerClockPieces();
  frames.push(dataMesh(build, "airliner-clock-bezel", clock.frame, bezelMaterial, root));
  rims.push(dataMesh(build, "airliner-clock-bezel-rim", clock.rim, materials.instrumentMarking, root));
  wells.push(dataMesh(build, "airliner-clock-well", clock.well, materials.instrumentFace, root));
  const clockFace = dataMesh(build, "airliner-clock", clock.face, materials.instrumentFace, root);
  parts.push(clockFace);
  const clockAtlas = createDisplayAtlas(build, AIRLINER_CLOCK_FACE);
  if (clockAtlas !== null) {
    // drawn once: the page does not move with the flight
    drawClockFace(clockAtlas.context, clockAtlas.width, clockAtlas.height);
    uploadDisplayAtlas(clockAtlas);
    clockFace.material = displayMaterial(build, "airliner-clock-face", clockAtlas);
  }

  const slots = displaySlots(AIRLINER_DISPLAYS);
  const atlasWidth = displayAtlasWidth(AIRLINER_DISPLAYS);
  const atlasHeight = displayAtlasHeight(AIRLINER_DISPLAYS);
  for (const [index, screen] of screens.entries()) {
    remapScreenFaceToSlot(screen as Mesh, slots[index]!, atlasWidth, atlasHeight);
  }
  const screensMesh = build.mergeStatic("airliner-screens", screens, root);
  parts.push(screensMesh);
  parts.push(build.mergeStatic("airliner-screen-bezels", frames, root));
  parts.push(build.mergeStatic("airliner-screen-bezel-rims", rims, root));
  parts.push(build.mergeStatic("airliner-screen-wells", wells, root));

  // THE DISPLAYS THEMSELVES, if this engine has a 2D canvas. Under NullEngine it does not, and the
  // screens keep the flat instrument-face material they were built with (see `displayAtlas.ts`).
  const atlas = createDisplayAtlas(build, AIRLINER_DISPLAYS);
  if (atlas !== null) {
    screensMesh.material = displayMaterial(build, "airliner-display", atlas);
  }

  // THE BOARD AND THE WINDOW FRAME, one mesh on the flight deck's interior material (the seats'). The sills are
  // frame too, not the glareshield's: the lighter surround round the glass, over the dark hood.
  parts.push(build.mergeStatic("airliner-cockpit-interior", [board, frame], root));

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
