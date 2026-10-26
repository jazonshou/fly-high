import type { Quaternion, Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Vector4 } from "@babylonjs/core/Maths/math.vector";
import type { ShaderMaterial } from "@babylonjs/core/Materials/shaderMaterial";
import { HULL_LENGTH, RUNABOUT_21_CG, transomX } from "@/src/vehicles/boat/hullLines";
import { DRAWN_SECTION_KINDS, drawnHalfSection } from "./boatHull";

/**
 * The sea kept out of the hull.
 *
 * The drawn ocean is a displaced sheet with no idea a boat floats in it: a
 * crest that passes under the hull rises through the cockpit sole, and at the
 * helm the sea would stand inside the boat. The hull is opaque and depth
 * tested, so water OUTSIDE it is already hidden wherever the hull is in front;
 * what has to go is the water INSIDE the hull's volume, which nothing hides.
 * The ocean's fragment discards a pixel that lies inside the hull below the
 * sheer (`oceanHullClipped`), compiled in only for a session that has a boat
 * (`SpectralOceanSystem.setHullClip`); an aircraft session's ocean shader is
 * the one it always was.
 *
 * THE VOLUME. In the HULL frame (+x forward from the transom's bottom edge,
 * +y up from the keel baseline): each of 48 stations' sections reduced to
 * two straight runs (`buildTable` has why that lies inside the drawn skin),
 * interpolated between stations, and held
 * `OCEAN_HULL_CLIP_MARGIN_METERS` inside, so the clip never opens a hole
 * outside the hull; `tests/render.ocean-hull-clip.test.ts` measures both
 * that and that it reaches the water a crest lifts into the cockpit. Aft,
 * the volume ends on the transom's raked plane; up, at the sheer, so a
 * swamped boat still fills. The table is baked into the shader as constants:
 * the ocean fragment has no free sampler.
 *
 * THE POSE. Three rows of the affine map from render space (the frame the
 * ocean's `worldPosition` varying is in, after the floating origin) to the
 * hull frame, written every frame from the boat's root. With no boat on
 * screen the rows put every pixel kilometres off the hull.
 */

export const OCEAN_HULL_CLIP_DEFINE = "OCEAN_HULL_CLIP";
export const OCEAN_HULL_CLIP_UNIFORMS: readonly string[] = Object.freeze([
  "oceanHullClipRow0",
  "oceanHullClipRow1",
  "oceanHullClipRow2",
]);

/** Stations along the hull, transom to stem, in the table. */
export const OCEAN_HULL_CLIP_STATIONS = 48;
/** Floats per station: keel height; chine, reverse chine and sheer half-breadths and heights. */
export const OCEAN_HULL_CLIP_FLOATS_PER_STATION = 7;
/** How far inside the drawn skin the clip stays, metres. */
export const OCEAN_HULL_CLIP_MARGIN_METERS = 0.02;

const KEEL = DRAWN_SECTION_KINDS.indexOf("keel");
const CHINE = DRAWN_SECTION_KINDS.indexOf("chine");
const REVERSE_CHINE = DRAWN_SECTION_KINDS.indexOf("reverseChineOuter");
const SHEER = DRAWN_SECTION_KINDS.indexOf("sheer");

/**
 * Each station's section reduced to two straight runs: the bottom's deadrise
 * from the keel to the chine, and the topsides' flare from the reverse
 * chine's outer edge to the sheer, which is the skin above the chine. The
 * lifting strakes stand OUTSIDE the deadrise run (they step out and down from
 * the panel they sit on), so the reduced section lies inside the drawn one.
 */
function buildTable(): Float32Array {
  const table = new Float32Array(OCEAN_HULL_CLIP_STATIONS * OCEAN_HULL_CLIP_FLOATS_PER_STATION);
  for (let i = 0; i < OCEAN_HULL_CLIP_STATIONS; i += 1) {
    const section = drawnHalfSection((i / (OCEAN_HULL_CLIP_STATIONS - 1)) * HULL_LENGTH, []);
    table.set([
      section[KEEL]![1],
      section[CHINE]![0],
      section[CHINE]![1],
      section[REVERSE_CHINE]![0],
      section[REVERSE_CHINE]![1],
      section[SHEER]![0],
      section[SHEER]![1],
    ], i * OCEAN_HULL_CLIP_FLOATS_PER_STATION);
  }
  return table;
}

const TABLE = buildTable();
const TAN_TRANSOM_RAKE = transomX(1);

function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value));
}

/**
 * Whether the clip discards a point of the HULL frame: the CPU twin of the
 * WGSL `oceanHullClippedHull`, operation for operation, for the tests.
 */
export function oceanHullClippedAt(x: number, y: number, z: number): boolean {
  const u = clamp(x / HULL_LENGTH, 0, 1) * (OCEAN_HULL_CLIP_STATIONS - 1);
  const i0 = Math.min(Math.floor(u), OCEAN_HULL_CLIP_STATIONS - 2);
  const f = u - i0;
  const at = (k: number): number => {
    const a = TABLE[i0 * OCEAN_HULL_CLIP_FLOATS_PER_STATION + k]!;
    const b = TABLE[(i0 + 1) * OCEAN_HULL_CLIP_FLOATS_PER_STATION + k]!;
    return a + (b - a) * f;
  };
  const keelY = at(0);
  const chineZ = at(1);
  const chineY = at(2);
  const flareZ = at(3);
  const flareY = at(4);
  const sheerZ = at(5);
  const sheerY = at(6);
  const halfBreadth = y <= chineY
    ? (chineZ * (y - keelY)) / Math.max(chineY - keelY, 1e-4)
    : flareZ + ((sheerZ - flareZ) * (y - flareY)) / Math.max(sheerY - flareY, 1e-4);
  return x >= Math.max(0, y) * TAN_TRANSOM_RAKE + OCEAN_HULL_CLIP_MARGIN_METERS
    && x <= HULL_LENGTH
    && y >= keelY
    && y <= sheerY
    && Math.abs(z) < halfBreadth - OCEAN_HULL_CLIP_MARGIN_METERS;
}

function wgslArray(values: Float32Array): string {
  return `array<f32, ${values.length}>(${Array.from(values, (value) => value.toFixed(5)).join(", ")})`;
}

const N = OCEAN_HULL_CLIP_FLOATS_PER_STATION;

/**
 * The fragment's declarations: the pose rows, the table and the test. Spliced
 * into the ocean's fragment inside `#ifdef OCEAN_HULL_CLIP`, so without the
 * define none of it reaches the compiler.
 */
export const OCEAN_HULL_CLIP_WGSL = /* wgsl */ `
uniform oceanHullClipRow0: vec4f;
uniform oceanHullClipRow1: vec4f;
uniform oceanHullClipRow2: vec4f;
const OCEAN_HULL_SECTIONS = ${wgslArray(TABLE)};

fn oceanHullClippedHull(hull: vec3f) -> bool {
  let u = clamp(hull.x / ${HULL_LENGTH.toFixed(5)}, 0.0, 1.0) * ${(OCEAN_HULL_CLIP_STATIONS - 1).toFixed(1)};
  let i0 = min(u32(floor(u)), ${OCEAN_HULL_CLIP_STATIONS - 2}u);
  let f = u - f32(i0);
  let a = i0 * ${N}u;
  let b = a + ${N}u;
  let keelY = mix(OCEAN_HULL_SECTIONS[a], OCEAN_HULL_SECTIONS[b], f);
  let chineZ = mix(OCEAN_HULL_SECTIONS[a + 1u], OCEAN_HULL_SECTIONS[b + 1u], f);
  let chineY = mix(OCEAN_HULL_SECTIONS[a + 2u], OCEAN_HULL_SECTIONS[b + 2u], f);
  let flareZ = mix(OCEAN_HULL_SECTIONS[a + 3u], OCEAN_HULL_SECTIONS[b + 3u], f);
  let flareY = mix(OCEAN_HULL_SECTIONS[a + 4u], OCEAN_HULL_SECTIONS[b + 4u], f);
  let sheerZ = mix(OCEAN_HULL_SECTIONS[a + 5u], OCEAN_HULL_SECTIONS[b + 5u], f);
  let sheerY = mix(OCEAN_HULL_SECTIONS[a + 6u], OCEAN_HULL_SECTIONS[b + 6u], f);
  let bottom = chineZ * (hull.y - keelY) / max(chineY - keelY, 1e-4);
  let topsides = flareZ + (sheerZ - flareZ) * (hull.y - flareY) / max(sheerY - flareY, 1e-4);
  let halfBreadth = select(topsides, bottom, hull.y <= chineY);
  return hull.x >= max(hull.y, 0.0) * ${TAN_TRANSOM_RAKE.toFixed(6)} + ${OCEAN_HULL_CLIP_MARGIN_METERS.toFixed(3)}
    && hull.x <= ${HULL_LENGTH.toFixed(5)}
    && hull.y >= keelY
    && hull.y <= sheerY
    && abs(hull.z) < halfBreadth - ${OCEAN_HULL_CLIP_MARGIN_METERS.toFixed(3)};
}

fn oceanHullClipped(worldPosition: vec3f) -> bool {
  let point = vec4f(worldPosition, 1.0);
  return oceanHullClippedHull(vec3f(
    dot(uniforms.oceanHullClipRow0, point),
    dot(uniforms.oceanHullClipRow1, point),
    dot(uniforms.oceanHullClipRow2, point),
  ));
}
`;

/** Where the rows put every pixel when no boat is on screen: far off any hull. */
const NOWHERE_METERS = 1.0e6;

/**
 * The boat's pose as the ocean reads it. `SpectralOceanSystem.setHullClip`
 * attaches it to the ocean's material; the renderer writes the pose every
 * frame from the boat's root, or clears it while the boat is away.
 */
export class OceanHullClip {
  private material: ShaderMaterial | null = null;
  private readonly rows = [new Vector4(0, 0, 0, NOWHERE_METERS), new Vector4(), new Vector4()] as const;

  /** The ocean's material takes the rows from now on. */
  attach(material: ShaderMaterial): void {
    this.material = material;
    this.flush();
  }

  detach(): void {
    this.material = null;
  }

  /** The current rows, render space to hull frame. */
  get poseRows(): readonly Vector4[] {
    return this.rows;
  }

  /**
   * The boat's root this frame, in render space: the hull frame is the body
   * frame moved by the CG, hull = R^T (p - t) + CG.
   */
  setPose(position: Readonly<Vector3>, rotation: Readonly<Quaternion>): void {
    const { x, y, z, w } = rotation;
    // Columns of R (body to render space), which are the rows of R^T.
    const columns = [
      [1 - 2 * (y * y + z * z), 2 * (x * y + w * z), 2 * (x * z - w * y)],
      [2 * (x * y - w * z), 1 - 2 * (x * x + z * z), 2 * (y * z + w * x)],
      [2 * (x * z + w * y), 2 * (y * z - w * x), 1 - 2 * (x * x + y * y)],
    ] as const;
    const cg = [RUNABOUT_21_CG.x, RUNABOUT_21_CG.y, RUNABOUT_21_CG.z] as const;
    for (let row = 0; row < 3; row += 1) {
      const [cx, cy, cz] = columns[row]!;
      this.rows[row]!.set(cx, cy, cz, cg[row]! - (cx * position.x + cy * position.y + cz * position.z));
    }
    this.flush();
  }

  /** No boat on screen: nothing is clipped. */
  clearPose(): void {
    this.rows[0].set(0, 0, 0, NOWHERE_METERS);
    this.rows[1].set(0, 0, 0, 0);
    this.rows[2].set(0, 0, 0, 0);
    this.flush();
  }

  private flush(): void {
    const material = this.material;
    if (!material) return;
    for (let row = 0; row < 3; row += 1) material.setVector4(OCEAN_HULL_CLIP_UNIFORMS[row]!, this.rows[row]!);
  }
}
