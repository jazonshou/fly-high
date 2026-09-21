import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import type { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh";
import type { PBRMaterial } from "@babylonjs/core/Materials/PBR/pbrMaterial";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import { aircraftSpec } from "@/src/aircraft/catalogue";
import type { FlightVisualState } from "@/src/game/types";
import type { AircraftBuildContext } from "../builders";
import { glareshieldMaterial, slab, strip } from "./cockpitPrimitives";
import { attitudeHorizonDegrees, pitchBarOffsetMetres } from "./instrumentMappings";

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
 *  - the pilot's LEFT screen is a PFD whose upper two-thirds is an attitude ball
 *    built from separate pieces under ONE pivot node, so a later step only has
 *    to rotate that node (see `BIZJET_PFD`).
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

// ---- the PFD's attitude display ------------------------------------------------

/**
 * THE ATTITUDE DISPLAY on the pilot's LEFT screen (the outboard one of the port
 * pair): a ball filling the upper two-thirds of the screen, made of a SKY half, a
 * GROUND half and a thin white PITCH BAR, all children of one pivot node at the
 * ball's centre. They are static now; a later step (I) rotates the pivot about
 * the viewing axis (body X) by minus the bank angle and slides the bar along the
 * pivot's own Y for pitch, and nothing else on the screens moves.
 *
 * IT IS ROUND on purpose. A rotating rectangle would poke out of the screen at
 * every bank angle but zero, and there is no clipping window here; a disc turned
 * about its own centre stays exactly where it was.
 */
export const BIZJET_PFD = Object.freeze({
  /** The pilot's left screen. */
  screen: "port-outboard",
  /** The attitude display is this fraction of the screen's height, from the top. */
  regionFraction: 2 / 3,
  /** The ball's radius is the region's half-height less this. */
  margin: 0.002,
  thickness: 0.002,
  /** The sky and ground plane stands this far in front of the screen's front. */
  offset: 0.0025,
  /** The pitch bar stands this far in front of that plane. */
  barOffset: 0.0015,
  barLength: 0.07,
  barHeight: 0.003,
  segments: 24,
  pivotName: "bizjet-pfd-attitude-pivot",
});

/** Radius of the attitude ball. */
export function bizjetPfdRadius(): number {
  return (BIZJET_SCREENS.height * BIZJET_PFD.regionFraction) / 2 - BIZJET_PFD.margin;
}

/** The ball's centre, which is the pivot's position: the middle of the screen's upper two-thirds. */
export function bizjetPfdCentre(): Vector3 {
  const screen = bizjetScreenPlacements().find((placement) => placement.name === BIZJET_PFD.screen);
  if (!screen) throw new Error(`no screen named ${BIZJET_PFD.screen}`);
  const regionHeight = BIZJET_SCREENS.height * BIZJET_PFD.regionFraction;
  return new Vector3(
    screenFrontX() - BIZJET_PFD.offset - BIZJET_PFD.thickness / 2,
    bizjetScreenTopY() - regionHeight / 2,
    screen.centre.z,
  );
}

/**
 * A half disc's outline, counter-clockwise with x across and y up. The upper
 * half runs from (r, 0) over the top to (-r, 0); the lower half from (-r, 0)
 * under the bottom to (r, 0). Both close along the diameter on y = 0.
 */
function halfDisc(radius: number, upper: boolean, segments: number): { x: number; y: number }[] {
  const points: { x: number; y: number }[] = [];
  for (let i = 0; i <= segments; i += 1) {
    const angle = (upper ? 0 : Math.PI) + (i / segments) * Math.PI;
    points.push({ x: radius * Math.cos(angle), y: radius * Math.sin(angle) });
  }
  return points;
}

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
 * caps) and the three attitude pieces that stay separate for a later step. There
 * is no pedestal: it would top out at -30 degrees between the
 * seats, below the frame at every azimuth it could be seen from.
 */
/** What `buildBizjetCockpit` hands back: the meshes, and the step that moves the attitude ball. */
export interface BizjetCockpit {
  /** Every mesh it made, unconfigured: the caller marks them cockpit-only. */
  readonly parts: readonly AbstractMesh[];
  /**
   * Turn the attitude ball to what `state` reads. The visual calls this from its
   * `update` ONLY while cockpit view is on.
   */
  update(state: FlightVisualState): void;
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
  parts.push(build.mergeStatic("bizjet-screens", screens, root));
  parts.push(build.mergeStatic("bizjet-screen-bezels", bezels, root));

  // THE ATTITUDE DISPLAY on the pilot's left screen: a sky half, a ground half
  // and a pitch bar, three separate meshes under one pivot node at the ball's
  // centre (see `BIZJET_PFD`). They are the exception to the merging above: a
  // later step turns the pivot, so they must stay separate from the screens.
  const pfd = BIZJET_PFD;
  const radius = bizjetPfdRadius();
  const sky = build.material("bizjet-pfd-sky", 0x6f93ad, {
    roughness: 0.6, metallic: 0, emissive: 0x6f93ad, emissiveIntensity: 0.35,
  });
  const ground = build.material("bizjet-pfd-ground", 0x7d5a3a, {
    roughness: 0.6, metallic: 0, emissive: 0x7d5a3a, emissiveIntensity: 0.3,
  });
  const white = build.material("bizjet-pfd-bar", 0xf4f7f8, {
    roughness: 0.5, metallic: 0, emissive: 0xffffff, emissiveIntensity: 0.6,
  });
  const pivot = new TransformNode(pfd.pivotName, build.scene);
  pivot.parent = root;
  pivot.position.copyFrom(bizjetPfdCentre());
  // `verticalProfile` extrudes an x-y outline along z; turned a quarter about y
  // the outline's x runs across the panel and its thickness runs fore and aft.
  for (const [name, material, upper] of [
    ["bizjet-pfd-sky", sky, true],
    ["bizjet-pfd-ground", ground, false],
  ] as const) {
    const half = build.verticalProfile(name, halfDisc(radius, upper, pfd.segments), pfd.thickness, material, pivot);
    half.rotation.y = Math.PI / 2;
    parts.push(half);
  }
  const bar = build.box(
    "bizjet-pfd-pitch-bar", pfd.thickness, pfd.barHeight, pfd.barLength, white, pivot,
  );
  const barFront = -(pfd.thickness / 2 + pfd.barOffset + pfd.thickness / 2);
  bar.position.set(barFront, 0, 0);
  parts.push(bar);

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

  // THE ATTITUDE BALL'S STEP: the pivot turns the sky, the ground and the bar
  // about the viewing axis, and the bar slides along the pivot's own up.
  //
  // The pivot's local X is body +X, which points AWAY from the pilot (the dials'
  // normals point toward him, which is the other way round), and a positive
  // rotation about an axis pointing away from the viewer is CLOCKWISE to him. So
  // the clockwise-as-seen angle `attitudeHorizonDegrees` (minus the bank) goes in
  // as it is. Held to the screen by `tests/render.cockpit-instruments.test.ts`,
  // which projects the ball's horizon and the real one through the same camera.
  return {
    parts,
    update(state) {
      pivot.rotation.x = (attitudeHorizonDegrees(state.bank) * Math.PI) / 180;
      bar.position.y = pitchBarOffsetMetres(state.pitch);
    },
  };
}
