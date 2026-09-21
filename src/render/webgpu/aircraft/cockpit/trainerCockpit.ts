import { Quaternion, Vector3 } from "@babylonjs/core/Maths/math.vector";
import type { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh";
import type { PBRMaterial } from "@babylonjs/core/Materials/PBR/pbrMaterial";
import type { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import { aircraftSpec } from "@/src/aircraft/catalogue";
import type { AircraftBuildContext } from "../builders";
import { TRAINER_FUSELAGE_SECTIONS } from "../trainerShell";
import { slab, strip } from "./cockpitPrimitives";

/**
 * What a pilot in a Cessna 150's LEFT seat sees, built to angles.
 *
 * WHY THIS EXISTS. The 150's fuselage is a closed loft whose cabin-section top
 * skin IS the window sill (y about 0, sloping to -0.06 at the cowl), and the
 * pilot's eye is 0.12 m above it, so the pilot looks down onto the OUTSIDE of
 * that skin. The cockpit camera therefore hides the tube, and everything that
 * used to be visible only because it was inside it — the panel, the dials, the
 * cowl — has to be built on this side of it. Every part here is COCKPIT-ONLY
 * (`CommonRig.cockpitOnlyParts`): invisible from any other camera, never a
 * shadow caster, so nothing in a chase or orbit frame can show a floating
 * panel or z-fight a wall it sits just inside of.
 *
 * THE TARGETS, as angles from the eye (`catalogue.cockpitEye`) at the 75
 * degree lens, and what each number below was solved to:
 *  - the glareshield top straight ahead reads -8 to -11 degrees (built at -8.35,
 *    the PM having asked for it 5 mm lower than the first build's -8.0);
 *  - the main instrument row is centred -15 degrees, each dial at least 4.5
 *    degrees across, and the second row -21;
 *  - the left windscreen post's axis stands at azimuth -35, hugging the left
 *    edge of the frame (the D3 window is -37 to -31);
 *  - the cowl rises above the glareshield to about -4.7, as a Cessna's does.
 *
 * Body coordinates: +X nose, +Y up, +Z starboard, so the pilot's seat is at
 * negative Z. Shell numbers were MEASURED off the built meshes by
 * `scripts/cockpit-shell-clearance.mts`, and `tests/render.cockpit-trainer.test.ts`
 * holds every part to them: a loft interpolated between stations is easy to
 * transcribe wrongly.
 */

export interface TrainerCockpitMaterials {
  /** Dark matte interior: the panel, the hood, the door panels and sill caps. */
  readonly interior: PBRMaterial;
  /** The windscreen posts. */
  readonly dark: PBRMaterial;
  readonly instrumentFace: PBRMaterial;
  /** Needles. It carries the night glow (`applyGlow(instrumentMarking, ...)`), so it must be the shared one. */
  readonly instrumentMarking: PBRMaterial;
  /** The body paint with NO livery stripe: its livery colour equals its base colour. */
  readonly cowl: PBRMaterial;
}

/** The panel: a slab across the cabin, leaning forward at the top like the one it replaces. */
export const TRAINER_PANEL = Object.freeze({
  /** Slab centre, before the lean; the rear face's top edge is what is pinned. */
  x: 2.1,
  thickness: 0.1,
  height: 0.5,
  /** Rotation about +Z, radians; negative leans the top forward. */
  lean: -0.12,
  /**
   * Height of the panel's rear-top edge: the sill line (0), less the 5 mm the PM
   * asked the glareshield to come down. The dial centres are solved against the
   * panel's rear face, so they follow it and stay at -15 and -21 degrees.
   */
  topRearY: -0.005,
  /**
   * Half its width. It has to carry the dial row, whose left edge is at z -0.40
   * (`TRAINER_DIAL_ROWS`), with a few centimetres to spare. That is wider than
   * the tube's rounded shoulder (0.38 at x 2.07, y -0.1) and than the greenhouse
   * glass narrowing toward the nose (0.35 at x 2.18), and it does not matter: the
   * cockpit camera hides both, and nothing here is visible from any other
   * camera. The wall itself, below the shoulder, is 0.47 out.
   */
  halfWidth: 0.42,
  /** The hood: 0.02 thick, standing this far aft of the panel's rear face. */
  hoodThickness: 0.02,
  hoodOverhang: 0.08,
});

/** Real gauge size. The dials this replaces were 0.17 to 0.20 m across. */
export const TRAINER_DIAL_DIAMETER = 0.08;

/**
 * The dials, left to right, with the elevation from the eye at which each row
 * is centred. Names are the ones the builder has always used; the ORDER within a
 * row is the real one (airspeed left of the attitude indicator, altimeter to its
 * right), where the old layout mirrored it.
 */
export const TRAINER_DIAL_ROWS = Object.freeze([
  Object.freeze({
    elevationDegrees: -15,
    dials: Object.freeze([["airspeed", -0.36], ["attitude", -0.26], ["altimeter", -0.16]] as const),
  }),
  Object.freeze({
    elevationDegrees: -21,
    dials: Object.freeze([["vertical-speed", -0.31], ["engine", -0.21]] as const),
  }),
]);

/**
 * A needle: a bar 3 mm across and 32 mm long through the dial's centre, with a
 * round hub of 6 mm radius on it. The hub is merged into the needle's own mesh so
 * the mesh count does not grow, and it is a little thicker than the bar so it
 * stands proud of it.
 */
export const TRAINER_NEEDLE = Object.freeze({
  width: 0.003,
  length: 0.032,
  thickness: 0.006,
  hubRadius: 0.006,
  hubThickness: 0.008,
});

/** Static needle tilt, radians, by dial: what `addInstrumentPanel` gave them, `(index - 2) * 0.38` in its order. */
const NEEDLE_TILT: Readonly<Record<string, number>> = Object.freeze({
  airspeed: -0.76, attitude: -0.38, altimeter: 0, engine: 0.38, "vertical-speed": 0.76,
});

/**
 * The left windscreen post's AXIS lies in the vertical plane through the eye at
 * this azimuth (degrees, negative to port). A vertical plane through the eye
 * projects to a vertical LINE on screen, so the whole post reads at one column.
 * At -35 the post hugs the left edge of the frame (-37.5 at 16:9) and reads as a
 * window frame instead of a bar standing in the view; its own thickness spreads
 * it about 2.7 degrees either side of the axis (0.012 m at 0.276 m), so its outer
 * edge touches the frame edge.
 */
export const TRAINER_LEFT_POST_AZIMUTH_DEGREES = -35;
export const TRAINER_POST_RADIUS = 0.012;
const POST_RADIUS = TRAINER_POST_RADIUS;

/**
 * The cabin's inner half-widths, measured off the built meshes (metres from the
 * centreline): the tube's flat wall, and the greenhouse glass's base at the sill.
 * Piecewise linear in x between the stations measured.
 */
const WALL_HALF_WIDTH: readonly (readonly [number, number])[] = [
  [0.95, 0.5015], [1.62, 0.5005], [1.8, 0.488], [2, 0.4685], [2.05, 0.463],
];
const SILL_HALF_WIDTH: readonly (readonly [number, number])[] = [
  [0.95, 0.437], [1.4, 0.437], [1.62, 0.435], [1.8, 0.424], [2, 0.411], [2.05, 0.395],
];
function interpolate(table: readonly (readonly [number, number])[], x: number): number {
  const first = table[0]!;
  if (x <= first[0]) return first[1];
  for (let i = 1; i < table.length; i += 1) {
    const a = table[i - 1]!;
    const b = table[i]!;
    if (x <= b[0]) return a[1] + ((b[1] - a[1]) * (x - a[0])) / (b[0] - a[0]);
  }
  return table[table.length - 1]![1];
}

/** The door panels and sill caps: how far in from the wall, and how they run. */
const DOOR = Object.freeze({
  fromX: 0.95,
  toX: 2.05,
  /** The panel's mid-plane sits this far inside the measured wall (the outer face is 5 mm nearer it). */
  inset: 0.015,
  thickness: 0.01,
  bottomY: -0.6,
  /** Where the vertical wall panel ends and the panel begins to lean in toward the sill. */
  kneeY: -0.2,
  /** The sill cap: 0.04 wide, 0.02 thick, its outer edge just inside the glass's base. */
  capWidth: 0.04,
  capThickness: 0.02,
  capInset: 0.005,
});

/** Rotation about Z of the panel and everything mounted on it. */
function panelFrame() {
  const { x, thickness, height, lean, topRearY } = TRAINER_PANEL;
  const cos = Math.cos(lean);
  const sin = Math.sin(lean);
  // R(lean) applied to a local (lx, ly): (lx cos - ly sin, lx sin + ly cos).
  const local = (lx: number, ly: number) => new Vector3(lx * cos - ly * sin, lx * sin + ly * cos, 0);
  const rearTop = local(-thickness / 2, height / 2);
  const centre = new Vector3(x, topRearY - rearTop.y, 0);
  return {
    centre,
    /** A point on the rear (pilot-facing) face, and that face's normal (toward the pilot). */
    rearFacePoint: centre.add(local(-thickness / 2, 0)),
    rearFaceNormal: new Vector3(-cos, -sin, 0),
    local,
  };
}

/** Intersection of a ray from the eye, at `elevationDegrees` in the eye's own vertical plane, with the panel's rear face. */
function dialCentreOnPanel(elevationDegrees: number): Vector3 {
  const eye = aircraftSpec("trainer").cockpitEye;
  const { rearFacePoint, rearFaceNormal } = panelFrame();
  const el = (elevationDegrees * Math.PI) / 180;
  const direction = new Vector3(Math.cos(el), Math.sin(el), 0);
  const origin = new Vector3(eye.forward, eye.up, 0);
  const t = Vector3.Dot(rearFacePoint.subtract(origin), rearFaceNormal) / Vector3.Dot(direction, rearFaceNormal);
  return origin.add(direction.scale(t));
}

/** Where every dial's centre is, in body coordinates, and the direction its face looks (toward the pilot). */
export function trainerDialPlacements(): readonly { name: string; centre: Vector3; normal: Vector3 }[] {
  const { rearFaceNormal } = panelFrame();
  const out: { name: string; centre: Vector3; normal: Vector3 }[] = [];
  for (const row of TRAINER_DIAL_ROWS) {
    const onFace = dialCentreOnPanel(row.elevationDegrees);
    for (const [name, z] of row.dials) {
      out.push({ name, centre: new Vector3(onFace.x, onFace.y, z), normal: rearFaceNormal.clone() });
    }
  }
  return out;
}

/**
 * The two ends of a windscreen post, vertical, in the plane through the eye at
 * `TRAINER_LEFT_POST_AZIMUTH_DEGREES`.
 *
 * NOT raked to the roof's outboard corner, which was the first design: that
 * corner is 0.06 m ahead of the eye and 0.05 m to port, so a post ending there
 * swelled toward the top into a dark wedge across 22% of the frame. Standing the
 * post about 0.28 m away instead keeps it a bar of uniform width from bottom to
 * top. It runs from just below the sill to 0.27, which is above the top of the
 * frame at that azimuth (+19.5 degrees is 0.10 m over 0.28), because the roof
 * slab is narrower than the greenhouse (0.31 against 0.44) and there is nothing
 * up there for a post ending at the roof's height to meet: it would stop in
 * mid-air 15 degrees above the horizon.
 */
export function trainerPostEndpoints(side: -1 | 1): { bottom: Vector3; top: Vector3 } {
  const eye = aircraftSpec("trainer").cockpitEye;
  const slope = Math.tan((TRAINER_LEFT_POST_AZIMUTH_DEGREES * Math.PI) / 180); // dz / dx from the eye, port negative
  // Just inside the greenhouse's base: the post's outer surface 5 mm within it.
  const z = -(interpolate(SILL_HALF_WIDTH, 1.62) - POST_RADIUS - 0.005);
  const x = eye.forward + (z - eye.right) / slope;
  const bottom = new Vector3(x, -0.02, z);
  const top = new Vector3(x, 0.27, z);
  if (side < 0) return { bottom, top };
  // The starboard post is the mirror image across the centreline, not a second solve: nothing is asked of it.
  return { bottom: new Vector3(x, bottom.y, -z), top: new Vector3(x, top.y, -z) };
}

/**
 * Build the cockpit. Returns every mesh it made, unconfigured: the caller marks
 * them cockpit-only (`configureCockpitOnlyParts`) and registers them, so the
 * rule is applied in one place.
 *
 * Nine to ten meshes in three groups: the cowl stand-in (1), the panel with its
 * hood (1), the windscreen posts (2), the door panels with their sill caps (2),
 * and the dials and their needles (10, as before).
 */
export function buildTrainerCockpit(
  build: AircraftBuildContext,
  root: TransformNode,
  materials: TrainerCockpitMaterials,
): readonly AbstractMesh[] {
  const parts: AbstractMesh[] = [];

  // THE COWL STAND-IN. The real cowl is part of the fuselage loft, which the
  // cockpit camera cannot show. This lofts the SAME sections from the one
  // nearest the firewall (x 2.10) forward to the nose, so it lies exactly on the
  // shell it stands in for: the loft has one ring per section and no
  // interpolation, so a loft of the same two rings is the same ruled surface.
  const firewall = TRAINER_FUSELAGE_SECTIONS.reduce(
    (best, section, index) => (Math.abs(section.x - 2.1) < Math.abs(TRAINER_FUSELAGE_SECTIONS[best]!.x - 2.1) ? index : best),
    0,
  );
  parts.push(build.loft(
    "trainer-cowl-standin",
    TRAINER_FUSELAGE_SECTIONS.slice(firewall),
    24,
    materials.cowl,
    root,
  ));

  // THE PANEL AND ITS HOOD, one mesh. The hood is a thin plate on the panel's
  // top, standing 0.08 m aft of the rear face, leaning with it.
  const { centre, local } = panelFrame();
  const panel = TRAINER_PANEL;
  const board = build.box("trainer-panel-board", panel.thickness, panel.height, panel.halfWidth * 2, materials.interior, root);
  board.position.copyFrom(centre);
  board.rotation.z = panel.lean;
  const hoodLength = panel.thickness + panel.hoodOverhang;
  const hood = build.box("trainer-glareshield", hoodLength, panel.hoodThickness, panel.halfWidth * 2, materials.interior, root);
  // Its centre in the panel's own frame: half a hood length forward of its aft
  // edge, which is `hoodOverhang` aft of the rear face, and half its thickness
  // above the panel's top.
  hood.position.copyFrom(centre.add(local(-panel.thickness / 2 - panel.hoodOverhang + hoodLength / 2, panel.height / 2 + panel.hoodThickness / 2)));
  hood.rotation.z = panel.lean;
  parts.push(build.mergeStatic("trainer-instrument-panel", [board, hood], root));

  // THE DIALS. Real size, in front of the left seat, on the panel's rear face
  // and a millimetre proud of it. The face cylinder's axis is local Y; turning
  // it a quarter turn and then leaning it with the panel points it at the pilot.
  for (const placement of trainerDialPlacements()) {
    const { name, centre: at, normal } = placement;
    const face = build.cylinder(
      `trainer-${name}-gauge`, 0.008, TRAINER_DIAL_DIAMETER, TRAINER_DIAL_DIAMETER, 24, materials.instrumentFace, root,
    );
    face.rotation.z = Math.PI / 2 + TRAINER_PANEL.lean;
    face.position.copyFrom(at.add(normal.scale(0.005)));
    parts.push(face);
    // The needle stands 9.5 mm off the panel, in front of the face, static as
    // it always was. Its long axis is local Z; the tilt is about local X (the
    // dial's normal) and the lean of the panel is applied after it.
    const pivot = at.add(normal.scale(0.0095));
    const bar = build.box(
      `trainer-${name}-needle-bar`, TRAINER_NEEDLE.thickness, TRAINER_NEEDLE.width, TRAINER_NEEDLE.length,
      materials.instrumentMarking, root,
    );
    bar.position.copyFrom(pivot);
    bar.rotationQuaternion = Quaternion.RotationAxis(new Vector3(0, 0, 1), TRAINER_PANEL.lean)
      .multiply(Quaternion.RotationAxis(new Vector3(1, 0, 0), NEEDLE_TILT[name] ?? 0));
    // The hub is a disc on the same axis as the face, set the same way.
    const hub = build.cylinder(
      `trainer-${name}-needle-hub`, TRAINER_NEEDLE.hubThickness, TRAINER_NEEDLE.hubRadius * 2,
      TRAINER_NEEDLE.hubRadius * 2, 16, materials.instrumentMarking, root,
    );
    hub.rotation.z = Math.PI / 2 + TRAINER_PANEL.lean;
    hub.position.copyFrom(pivot);
    parts.push(build.mergeStatic(`trainer-${name}-needle`, [bar, hub], root));
  }

  // THE WINDSCREEN POSTS, sill to roof, each in one vertical plane through the
  // eye so the left one stands at one screen column.
  for (const side of [-1, 1] as const) {
    const { bottom, top } = trainerPostEndpoints(side);
    parts.push(build.strutBetween(
      side < 0 ? "trainer-windscreen-post-port" : "trainer-windscreen-post-starboard",
      bottom, top, POST_RADIUS, materials.dark, root,
    ));
  }

  // THE DOOR PANELS and their SILL CAPS, one mesh a side. Without them the
  // pilot would see the ground through the cabin's side: the tube's wall is
  // culled from inside and, with the tube hidden, there is no wall at all. The
  // lower panel stands just inside where the wall was; the upper one leans in
  // to the glass's base; the cap makes the sill a ledge and not a knife edge.
  for (const side of [-1, 1] as const) {
    const wall = (x: number) => side * (interpolate(WALL_HALF_WIDTH, x) - DOOR.inset);
    const sill = (x: number) => side * (interpolate(SILL_HALF_WIDTH, x) - DOOR.capInset);
    const { fromX: x0, toX: x1 } = DOOR;
    const sideName = side < 0 ? "port" : "starboard";
    const lower = slab(
      build, `trainer-door-${sideName}-lower`, materials.interior, root,
      new Vector3(x0, DOOR.bottomY, wall(x0)), new Vector3(x1, DOOR.bottomY, wall(x1)),
      new Vector3(x0, DOOR.kneeY, wall(x0)), new Vector3(x1, DOOR.kneeY, wall(x1)),
      DOOR.thickness,
    );
    const upper = slab(
      build, `trainer-door-${sideName}-upper`, materials.interior, root,
      new Vector3(x0, DOOR.kneeY, wall(x0)), new Vector3(x1, DOOR.kneeY, wall(x1)),
      new Vector3(x0, 0, sill(x0)), new Vector3(x1, 0, sill(x1)),
      DOOR.thickness,
    );
    const cap = strip(
      build, `trainer-sill-${sideName}`, materials.interior, root,
      new Vector3(x0, 0, sill(x0) - side * (DOOR.capWidth / 2)),
      new Vector3(x1, 0, sill(x1) - side * (DOOR.capWidth / 2)),
      DOOR.capWidth, DOOR.capThickness,
    );
    parts.push(build.mergeStatic(`trainer-door-${sideName}`, [lower, upper, cap], root));
  }
  return parts;
}
