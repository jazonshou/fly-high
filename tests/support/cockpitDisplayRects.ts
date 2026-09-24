import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { aircraftSpec } from "@/src/aircraft/catalogue";
import {
  AIRLINER_SCREENS,
  airlinerPanelFace,
  airlinerScreenPlacements,
} from "@/src/render/webgpu/aircraft/cockpit/airlinerCockpit";
import {
  BIZJET_SCREENS,
  bizjetPanelFace,
  bizjetScreenPlacements,
} from "@/src/render/webgpu/aircraft/cockpit/bizjetCockpit";
import { framedScreenFacets, type FramedScreenDesign } from "@/src/render/webgpu/aircraft/cockpit/cockpitPrimitives";
import { JET_MFD, jetMfdPlacements, jetPanelFace } from "@/src/render/webgpu/aircraft/cockpit/jetCockpit";
import { TRAINER_DIAL_DIAMETER, trainerDialPlacements } from "@/src/render/webgpu/aircraft/cockpit/trainerCockpit";
import type { Deck } from "./cockpitFootprints";

/**
 * Where each deck's screens, bezels and dials are on screen, from THE KITS' OWN
 * CONSTANTS: the placements and sizes each cockpit builder exports, projected from
 * the catalogue eye down the body axis through a horizontal-fixed lens.
 *
 * It needs no scene, so it can ask what any lens would show. It is held to the ray
 * grid (tests/support/cockpitFootprints.ts) by tests/render.cockpit-hybrid-lens.test.ts:
 * every display's top edge within 2 px of the first row the grid draws it on.
 */
export interface CockpitPart {
  readonly name: string;
  readonly kind: "screen" | "bezel" | "dial";
  /** Outline in the body frame (+X nose, +Y up, +Z starboard). */
  readonly outline: readonly Vector3[];
}

export interface ScreenRect {
  readonly x0: number;
  readonly y0: number;
  readonly x1: number;
  readonly y1: number;
}

const Z = new Vector3(0, 0, 1);
const Y = new Vector3(0, 1, 0);
const rectangle = (centre: Vector3, side: Vector3, up: Vector3, halfWidth: number, halfHeight: number) =>
  [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([a, b]) => centre.add(side.scale(a! * halfWidth)).add(up.scale(b! * halfHeight)));

/**
 * A leaned deck's screens and bezels (the Global's, the 747's and the F-16's panels): each screen recessed behind a
 * chamfered frame on the board's leaned face. Nothing is re-derived from constants: the face's own axes, each screen
 * plate's centre and each bezel's facets come from the builder's functions, so a panel move carries this with it.
 */
function framedScreens(
  s: FramedScreenDesign & { readonly screenThickness: number },
  face: { readonly up: { readonly x: number; readonly y: number }; readonly normal: { readonly x: number; readonly y: number } },
  placements: readonly { readonly name: string; readonly centre: Vector3; readonly faceCentre: Vector3 }[],
): CockpitPart[] {
  const parts: CockpitPart[] = [];
  const up = new Vector3(face.up.x, face.up.y, 0);
  const out = new Vector3(face.normal.x, face.normal.y, 0);
  for (const p of placements) {
    // The placement is the plate's centre; its front is half a thickness out along the face's normal.
    parts.push({ name: p.name, kind: "screen", outline: rectangle(p.centre.add(out.scale(s.screenThickness / 2)), Z, up, s.width / 2, s.height / 2) });
    // Every corner of the bezel's two solids. Its back stands 1 mm inside the board and its sides are square to
    // the face, so a corner behind the face is brought out onto it: the outline is the bezel as it stands proud.
    const { frame, rim } = framedScreenFacets(p.faceCentre, face, s);
    const outline = [...frame, ...rim].flatMap((quad) => quad.corners).map((corner) => {
      const depth = Vector3.Dot(corner.subtract(p.faceCentre), out);
      return depth < 0 ? corner.subtract(out.scale(depth)) : corner;
    });
    parts.push({ name: `${p.name} bezel`, kind: "bezel", outline });
  }
  return parts;
}

/** Every screen and its bezel (the dials, on the trainer), as its builder places it. */
export function cockpitParts(deck: Deck): CockpitPart[] {
  const parts: CockpitPart[] = [];
  if (deck === "jet") {
    // The F-16's MFDs, since its step 3, are the same kind on its leaned dash
    const names = new Map([["port", "port MFD"], ["port bezel", "port MFD bezel"], ["starboard", "starboard MFD"], ["starboard bezel", "starboard MFD bezel"]]);
    parts.push(...framedScreens(JET_MFD, jetPanelFace(), jetMfdPlacements()).map((part) => ({ ...part, name: names.get(part.name)! })));
  } else if (deck === "bizjet") {
    parts.push(...framedScreens(BIZJET_SCREENS, bizjetPanelFace(), bizjetScreenPlacements()));
  } else if (deck === "airliner") {
    // The 747's P1 panel is the Global's kind: leaned 17 degrees, each screen recessed behind a chamfered frame
    parts.push(...framedScreens(AIRLINER_SCREENS, airlinerPanelFace(), airlinerScreenPlacements()));
  } else {
    for (const d of trainerDialPlacements()) {
      const n = d.normal.normalize();
      const side = Vector3.Cross(Y, n).normalize();
      const up = Vector3.Cross(n, side).normalize();
      // The gauge is a disc 8 mm thick whose centre stands 5 mm off the panel along the dial's
      // normal (trainerCockpit.ts), so both rims, 1 and 9 mm off: from above the eye its side
      // shows over the front rim.
      const r = TRAINER_DIAL_DIAMETER / 2;
      const rim = (off: number) => Array.from({ length: 48 }, (_, i) =>
        d.centre.add(n.scale(off)).add(side.scale(r * Math.cos((i * Math.PI) / 24))).add(up.scale(r * Math.sin((i * Math.PI) / 24))));
      parts.push({ name: `${d.name} dial`, kind: "dial", outline: [...rim(0.009), ...rim(0.001)] });
    }
  }
  return parts;
}

/** A part's screen bounds on a `width` x `height` window through a horizontal-fixed lens of `horizontalFovDegrees`. */
export function projectPart(deck: Deck, part: CockpitPart, width: number, height: number, horizontalFovDegrees: number): ScreenRect {
  const e = aircraftSpec(deck).cockpitEye;
  const focal = width / 2 / Math.tan((horizontalFovDegrees * Math.PI) / 360);
  const points = part.outline.map((p) => {
    const d = p.subtract(new Vector3(e.forward, e.up, e.right));
    return { x: width / 2 + (d.z / d.x) * focal, y: height / 2 - (d.y / d.x) * focal };
  });
  return {
    x0: Math.min(...points.map((p) => p.x)),
    x1: Math.max(...points.map((p) => p.x)),
    y0: Math.min(...points.map((p) => p.y)),
    y1: Math.max(...points.map((p) => p.y)),
  };
}

/** The share of a rect's rows that the frame shows, 0 to 1. */
export function rowShareInFrame(rect: ScreenRect, height: number): number {
  return Math.max(0, Math.min(rect.y1, height) - Math.max(rect.y0, 0)) / (rect.y1 - rect.y0);
}

/** The share of a rect's area that the frame shows, 0 to 1. */
export function areaShareInFrame(rect: ScreenRect, width: number, height: number): number {
  const across = Math.max(0, Math.min(rect.x1, width) - Math.max(rect.x0, 0)) / (rect.x1 - rect.x0);
  return across * rowShareInFrame(rect, height);
}
