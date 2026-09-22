import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import type { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh";
import type { Mesh } from "@babylonjs/core/Meshes/mesh";
import type { PBRMaterial } from "@babylonjs/core/Materials/PBR/pbrMaterial";
import type { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import { aircraftSpec } from "@/src/aircraft/catalogue";
import type { FlightVisualState } from "@/src/game/types";
import type { AircraftBuildContext } from "../builders";
import { glareshieldMaterial, slab, strip } from "./cockpitPrimitives";
import {
  BIZJET_DISPLAYS,
  DISPLAY_UPDATE_HZ,
  createDisplayAtlas,
  displayAtlasHeight,
  displayAtlasWidth,
  displayMaterial,
  displaySlots,
  paintDisplays,
  remapScreenFaceToSlot,
} from "./displays/displayAtlas";
import { displayStateFromVisual, type DisplayAirframe } from "./displays/displayStateFromVisual";

/**
 * What a pilot in the Global's LEFT seat sees, built to angles.
 *
 * WHY THIS EXISTS. The flight deck was a pair of seat slabs and a panel board
 * with five round dials on it, and the cockpit camera hid the fuselage and the
 * radome, so what the pilot saw was the underside of nothing: no ceiling, no
 * posts, no walls, a panel that sat at the wrong height for the eye. The eye
 * itself was ABOVE the top of the windscreen (`catalogue.cockpitEye` was
 * (11.6, 1.05); the glass tops out at y 0.98), so the whole windscreen was under
 * the horizon.
 *
 * The eye is now (11.90, 0.78, -0.52), found by `scripts/global-eye-solve.mts`
 * against the four constraints the PM set: inside the glass's vertical span, the
 * glass's top edge reading +14 to +18 degrees straight ahead, the glass at least
 * 0.55 m away, and at least 0.15 m of skin above the head. It is a thin sliver
 * of feasible points (forward 11.85 to 11.95 at up 0.78) and this is its middle.
 *
 * WHAT IS HIDDEN AND WHAT IS NOT. The glass (`bizjet-windscreen` and the two
 * flight-deck windows) is excluded from the cockpit camera: it is built with
 * `transmission`, which draws as an opaque slab from inside. The fuselage, the
 * radome and the centre post are visible again: the eye is inside a closed shell
 * whose back faces are culled, so it draws nothing of itself, and the centre post
 * is what a windscreen's framing is. Everything below is COCKPIT-ONLY
 * (`CommonRig.cockpitOnlyParts`): invisible from any other camera and never a
 * shadow caster, so nothing in a chase or orbit frame can show a floating panel.
 *
 * THE TARGETS, as angles from the eye at the 75 degree lens:
 *  - the hood's top edge straight ahead reads -10 degrees (+-1);
 *  - four flat screens, each 0.22 wide by 0.15 tall, the pilot's pair centred on
 *    the eye's own z, their top edge 1.5 degrees below the hood's underside;
 *  - the left windscreen post's axis at azimuth -34 (+-1.5), raked like the glass;
 *  - an overhead from the glass's top edge aft to 0.3 m behind the eye;
 *  - the four screens draw the deck's real pages out of ONE atlas texture
 *    (`displays/`): a PFD outboard and a map inboard for each seat. The pilot's
 *    LEFT screen carried a 3D attitude ball until the pages went in.
 *
 * Body coordinates: +X nose, +Y up, +Z starboard, so the pilot's seat is at
 * negative Z.
 */

const DEG = Math.PI / 180;

export interface BizjetCockpitMaterials {
  /** Dark matte interior: the panel board, the overhead and the walls. (The hood has its own: `glareshieldMaterial`.) */
  readonly interior: PBRMaterial;
  /** The windscreen posts (the same as the centre post's). */
  readonly dark: PBRMaterial;
  readonly instrumentFace: PBRMaterial;
  /**
   * Bezels: a dark-grey rim with a faint lit edge by day. It carries the night
   * glow (`applyGlow(instrumentMarking, ...)`), so it must be the shared one.
   */
  readonly instrumentMarking: PBRMaterial;
}

function eye(): { forward: number; up: number; right: number } {
  return aircraftSpec("bizjet").cockpitEye;
}

// ---- the shell ---------------------------------------------------------------

interface Ring {
  readonly x: number;
  readonly yRadius: number;
  readonly zRadius: number;
  readonly yOffset: number;
}

/**
 * The fuselage loft's sections through the flight deck (`bizjetVisual.ts`,
 * `build.loft("bizjet-fuselage", ...)`). A loft has one ring per section and no
 * interpolation, so between two sections every ring vertex slides linearly, which
 * makes the cross-section an ellipse of linearly interpolated radii and offset at
 * EVERY station: half-width and crown height are closed forms. These numbers are
 * copies, held to the built mesh by `tests/render.cockpit-bizjet.test.ts`, so a
 * change to the fuselage fails there instead of leaving a stale table.
 */
export const BIZJET_SHELL_SECTIONS: readonly Ring[] = Object.freeze([
  Object.freeze({ x: 9.5, yRadius: 1.335, zRadius: 1.32, yOffset: 0 }),
  Object.freeze({ x: 11.6, yRadius: 1.25, zRadius: 1.19, yOffset: 0.06 }),
  Object.freeze({ x: 13.2, yRadius: 0.9, zRadius: 0.88, yOffset: -0.02 }),
]);

export function bizjetShellRing(x: number): Omit<Ring, "x"> {
  const sections = BIZJET_SHELL_SECTIONS;
  const first = sections[0]!;
  if (x <= first.x) return first;
  for (let i = 1; i < sections.length; i += 1) {
    const a = sections[i - 1]!;
    const b = sections[i]!;
    if (x <= b.x) {
      const t = (x - a.x) / (b.x - a.x);
      return {
        yRadius: a.yRadius + (b.yRadius - a.yRadius) * t,
        zRadius: a.zRadius + (b.zRadius - a.zRadius) * t,
        yOffset: a.yOffset + (b.yOffset - a.yOffset) * t,
      };
    }
  }
  return sections[sections.length - 1]!;
}

/** Distance from the centreline to the shell at station `x` and height `y`, or NaN if `y` is outside the ring. */
export function bizjetShellHalfWidth(x: number, y: number): number {
  const ring = bizjetShellRing(x);
  const u = (y - ring.yOffset) / ring.yRadius;
  return Math.abs(u) > 1 ? Number.NaN : ring.zRadius * Math.sqrt(1 - u * u);
}

/** Height of the shell's top skin at station `x` and lateral `z`, or NaN if the shell is not that wide there. */
export function bizjetShellTop(x: number, z: number): number {
  const ring = bizjetShellRing(x);
  const v = z / ring.zRadius;
  return Math.abs(v) > 1 ? Number.NaN : ring.yOffset + ring.yRadius * Math.sqrt(1 - v * v);
}

// ---- the glass ---------------------------------------------------------------

/**
 * The windscreen pane, as `bizjetVisual.ts` builds it: a thick slab centred at
 * (x, y), leaned back `rake` radians about Z. Held to the built mesh by the test.
 */
export const BIZJET_WINDSCREEN = Object.freeze({
  x: 12.72,
  y: 0.7,
  thickness: 0.16,
  height: 0.56,
  width: 1.44,
  rake: 0.6,
});

/**
 * The highest point of the pane the pilot can see: its top-FRONT corner. The
 * slab's top face leans toward the pilot, so from below and behind it is visible
 * and its far edge is the top of the opening.
 */
export function bizjetWindscreenTopFront(): { x: number; y: number } {
  const { x, y, thickness, height, rake } = BIZJET_WINDSCREEN;
  const c = Math.cos(rake);
  const s = Math.sin(rake);
  return { x: x + (thickness / 2) * c - (height / 2) * s, y: y + (thickness / 2) * s + (height / 2) * c };
}

/** Where the side windows' lower edge runs, and so where the sill is. */
export const BIZJET_SILL_Y = 0.52;

// ---- the panel and its hood ---------------------------------------------------

export const BIZJET_PANEL = Object.freeze({
  /** The pilot-facing face of the board. */
  faceX: 12.55,
  thickness: 0.08,
  /**
   * The shell is 0.796 out at the hood's height (y 0.65) at the face and 0.772 at
   * the board's front (0.765 measured off the built 48-gon), so 0.765 keeps the
   * hood's corners inside it. The outer bezels reach 0.7625.
   */
  halfWidth: 0.765,
  /** Below the frame at every azimuth, so nothing shows under it. */
  bottomY: 0.2,
  hoodThickness: 0.02,
  /** The hood stands this far aft of the face. */
  hoodOverhang: 0.1,
  /** The hood's top edge as the pilot sees it straight ahead. */
  hoodTopElevationDegrees: -10,
});

/** The height of the hood's top surface: solved so its far edge reads `hoodTopElevationDegrees` from the eye. */
export function bizjetHoodTopY(): number {
  const p = BIZJET_PANEL;
  const e = eye();
  return e.up + Math.tan(p.hoodTopElevationDegrees * DEG) * (p.faceX + p.thickness - e.forward);
}

/** Elevation, from the eye, of the hood's aft edge underside: the line below which the panel face is visible. */
export function bizjetHoodUndersideElevationDegrees(): number {
  const p = BIZJET_PANEL;
  const e = eye();
  return Math.atan2(bizjetHoodTopY() - p.hoodThickness - e.up, p.faceX - p.hoodOverhang - e.forward) / DEG;
}

// ---- the screens -------------------------------------------------------------

export const BIZJET_SCREENS = Object.freeze({
  width: 0.22,
  height: 0.15,
  bezel: 0.01,
  /** Centre to centre inside a pair. The bezels leave 5 mm between them. */
  pitch: 0.245,
  /** The screens' top edge reads this far below the hood's underside. */
  belowHoodDegrees: 1.5,
  bezelThickness: 0.007,
  screenThickness: 0.003,
});

/** The plane the screens' front stands in: 1 mm in front of the bezel's front face. */
function screenFrontX(): number {
  return BIZJET_PANEL.faceX - BIZJET_SCREENS.bezelThickness;
}

/** Height of the screens' top edge, solved from the hood's underside line. */
export function bizjetScreenTopY(): number {
  const e = eye();
  const elevation = (bizjetHoodUndersideElevationDegrees() - BIZJET_SCREENS.belowHoodDegrees) * DEG;
  return e.up + Math.tan(elevation) * (screenFrontX() - e.forward);
}

/** The four screens: the pilot's pair on the eye's own z, the other pair mirrored. */
export function bizjetScreenPlacements(): readonly { name: string; centre: Vector3 }[] {
  const s = BIZJET_SCREENS;
  const e = eye();
  const y = bizjetScreenTopY() - s.height / 2;
  const x = screenFrontX() + s.screenThickness / 2;
  const out: { name: string; centre: Vector3 }[] = [];
  for (const [seat, z] of [["port", e.right], ["starboard", -e.right]] as const) {
    // Outboard first: the outer screen is the one nearer the wall.
    const outboard = Math.sign(z);
    out.push({ name: `${seat}-outboard`, centre: new Vector3(x, y, z + outboard * (s.pitch / 2)) });
    out.push({ name: `${seat}-inboard`, centre: new Vector3(x, y, z - outboard * (s.pitch / 2)) });
  }
  return out;
}

// ---- what the pages need of this airframe -------------------------------------

/**
 * The airframe constants the pages cannot read off the flight state, from the model's own tables:
 * two engines, and 30 degrees of trailing-edge-down flap (`SURFACE_TRAVEL.bizjet.flap`, the same as
 * the 747's; the Cessna's is 40).
 */
export const BIZJET_DISPLAY_AIRFRAME: DisplayAirframe = Object.freeze({ engineCount: 2, fullFlapDegrees: 30 });

/**
 * THERE WAS A 3D ATTITUDE BALL ON THE PILOT'S LEFT SCREEN and it is gone: a sky half, a ground half
 * and a pitch bar under a pivot, 2.5 mm in front of the glass, built when these screens were flat
 * rectangles with nothing on them. The PFD page draws its own horizon now, so the ball was a second
 * attitude indicator standing on top of the first and hiding most of it -- the same thing the 747's
 * was, removed for the same measured reason. The Cessna keeps its ball, because that aeroplane's
 * instrument is MECHANICAL and so is its model.
 */

// ---- the posts ---------------------------------------------------------------

export const BIZJET_POST = Object.freeze({
  /**
   * The left post's axis, in the vertical plane through the eye at this azimuth.
   * It was -29 with radius 0.03, and in the frame it stood a sixth of the way in
   * and split the view: near its top it is only 0.32 m from the eye, so it has to
   * be thinner AND further out to read as a window frame.
   */
  azimuthDegrees: -34,
  radius: 0.02,
  /**
   * Clearance kept between the post's foot and the shell there. The strut's base
   * is 8% fatter than its top and the built fuselage is a 48-gon inscribed in the
   * ellipse the model uses, so 10 mm leaves the measured clearance about 5 mm.
   */
  footMargin: 0.01,
});

/** The overhead: a slab whose underside is at the glass's top edge (`bizjetOverheadUndersideY`). */
export const BIZJET_OVERHEAD = Object.freeze({
  thickness: 0.03,
  /** Out to the side windows' outer extent (0.978), so the ceiling runs over them. */
  halfWidth: 0.98,
  /** The slab's aft end, behind the eye. */
  behindEye: 0.3,
});

export function bizjetOverheadUndersideY(): number {
  return bizjetWindscreenTopFront().y;
}

/**
 * The two ends of a windscreen post. The LEFT post's axis lies in the vertical
 * plane through the eye at `BIZJET_POST.azimuthDegrees`, so it projects to one
 * vertical line on screen at that azimuth whatever its lean; it is raked like
 * the glass (in the x-y projection, top toward the pilot), stands on the sill
 * line, and is pushed as far forward as its foot can go while it stays inside
 * the shell there. Its top ends in the overhead. The right post is the mirror
 * image across the centreline.
 */
export function bizjetPostEndpoints(side: -1 | 1): { bottom: Vector3; top: Vector3 } {
  const e = eye();
  const azimuth = BIZJET_POST.azimuthDegrees * DEG;
  const dirX = Math.cos(azimuth);
  const dirZ = Math.sin(azimuth);
  const footY = BIZJET_SILL_Y - 0.01;
  const topY = bizjetOverheadUndersideY() + BIZJET_OVERHEAD.thickness / 2;
  const fits = (d: number): boolean => {
    const wall = bizjetShellHalfWidth(e.forward + d * dirX, footY);
    return Math.abs(e.right + d * dirZ) + BIZJET_POST.radius + BIZJET_POST.footMargin <= wall;
  };
  let near = 0.3;
  let far = 1.6;
  for (let i = 0; i < 60; i += 1) {
    const mid = (near + far) / 2;
    if (fits(mid)) near = mid;
    else far = mid;
  }
  // The top is nearer the eye by the glass's rake: tan(rake) of horizontal run in
  // X per metre of rise, which along the plane is that divided by cos(azimuth).
  const run = (Math.tan(BIZJET_WINDSCREEN.rake) * (topY - footY)) / dirX;
  const bottom = new Vector3(e.forward + near * dirX, footY, e.right + near * dirZ);
  const top = new Vector3(e.forward + (near - run) * dirX, topY, e.right + (near - run) * dirZ);
  if (side < 0) return { bottom, top };
  return { bottom: new Vector3(bottom.x, bottom.y, -bottom.z), top: new Vector3(top.x, top.y, -top.z) };
}

// ---- the side walls -----------------------------------------------------------

const WALL = Object.freeze({
  bottomY: -0.15,
  /** Inside the shell by this much. */
  inset: 0.015,
  thickness: 0.01,
  capWidth: 0.05,
  capThickness: 0.02,
});

/**
 * Build the cockpit. Returns every mesh it made, unconfigured: the caller marks
 * them cockpit-only (`configureCockpitOnlyParts`) and registers them, so the
 * rule is applied in one place.
 *
 * Eleven meshes: eight static (the panel, its hood, the screens, their bezels,
 * the two windscreen posts, the overhead, and the side walls with their sill
 * caps) and the three attitude pieces, which stay separate because the pivot turns them. There
 * is no pedestal: it would top out at -30 degrees between the
 * seats, below the frame at every azimuth it could be seen from.
 */
/** What `buildBizjetCockpit` hands back: the meshes, and the step that moves the attitude ball. */
export interface BizjetCockpit {
  /** Every mesh it made, unconfigured: the caller marks them cockpit-only. */
  readonly parts: readonly AbstractMesh[];
  /** True when the screens carry a live atlas: false under `NullEngine`, where there is no canvas. */
  readonly displaysLive: boolean;
  /**
   * Redraw the displays at `DISPLAY_UPDATE_HZ`. The visual calls this from its `update` ONLY while
   * cockpit view is on, and passes the frame's delta so the counter is the frame's own clock.
   */
  update(state: FlightVisualState, secondsSinceLastUpdate?: number): void;
}

export function buildBizjetCockpit(
  build: AircraftBuildContext,
  root: TransformNode,
  materials: BizjetCockpitMaterials,
): BizjetCockpit {
  const parts: AbstractMesh[] = [];
  const e = eye();
  const p = BIZJET_PANEL;

  // THE PANEL AND ITS HOOD, two meshes. The board runs from below the frame up to
  // the hood's underside; the hood is a plate on it, standing `hoodOverhang`
  // aft of the face and level with the board's front. Its top is what the pilot
  // reads as -10 degrees. The hood wears a material of its own (matte
  // near-black, no reflection): a glareshield must not reflect in the windscreen,
  // and on the interior material its top face was the brightest thing in the frame.
  const hoodTop = bizjetHoodTopY();
  const undersideY = hoodTop - p.hoodThickness;
  const board = build.box(
    "bizjet-instrument-panel", p.thickness, undersideY - p.bottomY, p.halfWidth * 2, materials.interior, root,
  );
  board.position.set(p.faceX + p.thickness / 2, (p.bottomY + undersideY) / 2, 0);
  const hoodLength = p.thickness + p.hoodOverhang;
  parts.push(board);
  const hood = build.box(
    "bizjet-glareshield", hoodLength, p.hoodThickness, p.halfWidth * 2,
    glareshieldMaterial(build, "bizjet-glareshield"), root,
  );
  hood.position.set(p.faceX - p.hoodOverhang + hoodLength / 2, hoodTop - p.hoodThickness / 2, 0);
  parts.push(hood);

  // THE SCREENS AND THEIR BEZELS: two meshes for eight boxes. A screen is a flat
  // glass display on the instrument-face material; its bezel is the marking
  // material, so the night glow that lights the old dials lights it too. The
  // bezel's back stands 1 mm inside the board so nothing is coincident, and the
  // screen stands 1 mm proud of the bezel.
  const s = BIZJET_SCREENS;
  const screens: AbstractMesh[] = [];
  const bezels: AbstractMesh[] = [];
  for (const { name, centre } of bizjetScreenPlacements()) {
    const screen = build.box(
      `bizjet-screen-${name}`, s.screenThickness, s.height, s.width, materials.instrumentFace, root,
    );
    screen.position.copyFrom(centre);
    screens.push(screen);
    const bezel = build.box(
      `bizjet-screen-bezel-${name}`, s.bezelThickness, s.height + s.bezel * 2, s.width + s.bezel * 2,
      materials.instrumentMarking, root,
    );
    bezel.position.set(p.faceX - s.bezelThickness / 2 + 0.001, centre.y, centre.z);
    bezels.push(bezel);
  }
  // EACH SCREEN'S PILOT-FACING FACE GETS ITS OWN SLOT of the display atlas, before the merge bakes
  // the vertex data. The boxes are built in `bizjetScreenPlacements()` order and the slots are in
  // the same order, so slot i belongs to screen i; `tests/render.cockpit-displays.test.ts` holds
  // that pairing by measuring the merged mesh's UVs against each screen's own z.
  const slots = displaySlots(BIZJET_DISPLAYS);
  const atlasWidth = displayAtlasWidth(BIZJET_DISPLAYS);
  const atlasHeight = displayAtlasHeight(BIZJET_DISPLAYS);
  for (const [index, screen] of screens.entries()) {
    remapScreenFaceToSlot(screen as Mesh, slots[index]!, atlasWidth, atlasHeight);
  }
  const screensMesh = build.mergeStatic("bizjet-screens", screens, root);
  parts.push(screensMesh);
  parts.push(build.mergeStatic("bizjet-screen-bezels", bezels, root));

  // THE DISPLAYS THEMSELVES, if this engine has a 2D canvas. Under NullEngine it does not, and the
  // screens keep the flat instrument-face material they were built with (see `displayAtlas.ts`).
  const atlas = createDisplayAtlas(build.scene, BIZJET_DISPLAYS);
  if (atlas !== null) {
    screensMesh.material = displayMaterial(build, "bizjet-display", atlas);
  }

  // THE WINDSCREEN POSTS, each in one vertical plane through the eye for the
  // left one; the right is its mirror (out of the player's frame, and built for
  // the perf rig's centreline eye).
  for (const side of [-1, 1] as const) {
    const { bottom, top } = bizjetPostEndpoints(side);
    parts.push(build.strutBetween(
      side < 0 ? "bizjet-windscreen-post-port" : "bizjet-windscreen-post-starboard",
      bottom, top, BIZJET_POST.radius, materials.dark, root,
    ));
  }

  // THE OVERHEAD. From the glass's top edge aft to 0.3 m behind the eye, so
  // everything above the opening reads as a ceiling and not as sky.
  //
  // IT POKES THROUGH THE SKIN. The windscreen is a flat 1.44 m pane and the nose
  // it sits in falls away sideways: at the pilot's z (-0.52) the crown is 0.879 m
  // high at x 12.63 against the glass's top edge at 0.976, so the slab's front
  // edge stands 0.10 m above the skin there (0.13 with its own thickness), and
  // its outer ends run past the shell altogether (the side windows are 0.98 out).
  // Nothing can see that: it is cockpit-only, and the cockpit camera culls the
  // shell from inside. The alternative, a ceiling that follows the crown, would
  // make the opening's top edge read about +11 degrees instead of +15. Measured
  // in `scripts/bizjet-cockpit-clearance.mts`.
  const frontX = bizjetWindscreenTopFront().x;
  const aftX = e.forward - BIZJET_OVERHEAD.behindEye;
  const overhead = build.box(
    "bizjet-overhead", frontX - aftX, BIZJET_OVERHEAD.thickness, BIZJET_OVERHEAD.halfWidth * 2, materials.interior, root,
  );
  overhead.position.set((aftX + frontX) / 2, bizjetOverheadUndersideY() + BIZJET_OVERHEAD.thickness / 2, 0);
  parts.push(overhead);

  // THE SIDE WALLS with their SILL CAPS, one mesh for both sides. The wall
  // stands just inside the shell from the floor line up to the side windows'
  // lower edge, from 0.3 m behind the eye to the panel; the cap makes the sill a
  // ledge and not a knife edge. A chord between the two ends lies inside the
  // shell because the shell is convex.
  const wallSources: AbstractMesh[] = [];
  const x0 = aftX;
  const x1 = p.faceX;
  const capTopY = BIZJET_SILL_Y;
  for (const side of [-1, 1] as const) {
    const sideName = side < 0 ? "port" : "starboard";
    const wall = (x: number) => side * (bizjetShellHalfWidth(x, BIZJET_SILL_Y) - WALL.inset);
    wallSources.push(slab(
      build, `bizjet-wall-${sideName}`, materials.interior, root,
      new Vector3(x0, WALL.bottomY, wall(x0)), new Vector3(x1, WALL.bottomY, wall(x1)),
      new Vector3(x0, capTopY - WALL.capThickness, wall(x0)), new Vector3(x1, capTopY - WALL.capThickness, wall(x1)),
      WALL.thickness,
    ));
    wallSources.push(strip(
      build, `bizjet-sill-${sideName}`, materials.interior, root,
      new Vector3(x0, capTopY - WALL.capThickness / 2, wall(x0) - side * (WALL.capWidth / 2)),
      new Vector3(x1, capTopY - WALL.capThickness / 2, wall(x1) - side * (WALL.capWidth / 2)),
      WALL.capWidth, WALL.capThickness,
    ));
  }
  parts.push(build.mergeStatic("bizjet-side-walls", wallSources, root));

  // THE DISPLAYS ARE REDRAWN ON A COUNTER, not every frame: `update` is only called while cockpit
  // view is on (the visual gates it), and 15 a second is as fast as a display needs to move. One
  // redraw of this four-slot atlas is cheaper than the 747's six-slot one, and both are measured in
  // the findings doc rather than assumed.
  let sinceDisplayDraw = Number.POSITIVE_INFINITY;
  return {
    parts,
    displaysLive: atlas !== null,
    update(state, secondsSinceLastUpdate = 0) {
      if (atlas === null) return;
      sinceDisplayDraw += Number.isFinite(secondsSinceLastUpdate) ? Math.max(0, secondsSinceLastUpdate) : 0;
      if (sinceDisplayDraw < 1 / DISPLAY_UPDATE_HZ) return;
      sinceDisplayDraw = 0;
      paintDisplays(atlas, displayStateFromVisual(state, BIZJET_DISPLAY_AIRFRAME));
    },
  };
}
