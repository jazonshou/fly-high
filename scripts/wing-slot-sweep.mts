/**
 * Daylight between a wing and its control surfaces, over a SWEEP of
 * chase-like eye points rather than one frame's camera.
 *
 * Parallel rays at a fixed span station are the wrong instrument for a swept
 * trailing edge: a camera behind the fuselage looks ALONG the slot, so a sight
 * line enters at one span station and leaves at another. These are perspective
 * rays from 3 ranges x 5 elevations x 4 azimuths, classified by FIRST hit, and
 * each image column is scanned for a run of sky with wing structure on both
 * sides -- daylight between the aeroplane's own surfaces, not around it.
 *
 * Three things it learned the hard way, each of which had produced a confident
 * wrong answer first:
 *
 *  - It reports EVERY leaking span station, not the worst. Quoting only the
 *    maximum let the F-16's 314 mm flap-break gap hide a second hole at its
 *    wing tip, so "fixed" would have meant "the biggest one is gone".
 *  - The bracket is any two pieces of wing STRUCTURE. Requiring one fixed wing
 *    and one moving surface missed a hole between two flap panels; requiring
 *    only "aeroplane on both sides" fires on any concave silhouette, such as
 *    the gap between a wing and the tailplane behind it.
 *  - It REFUSES TO REPORT if it classified no rays as fixed wing or none as a
 *    moving surface. Classification is by mesh NAME, so a rename -- or a merge
 *    of static meshes -- turns every reading into a silent CLOSED, which looks
 *    exactly like success.
 *
 * A null result here is worth nothing without its control: re-run with the fix
 * removed and satisfy yourself that the same sweep reports the hole.
 *
 *   KIND=jet RANGES=24,38 AILERON=1 npx tsx scripts/wing-slot-sweep.mts
 */
import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import { Scene } from "@babylonjs/core/scene";
import { Ray } from "@babylonjs/core/Culling/ray";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { createAircraft } from "@/src/render/webgpu/aircraft/createAircraft";
import { INITIAL_VISUAL_STATE } from "@/src/game/types";

const engine = new NullEngine();
const scene = new Scene(engine);
scene.useRightHandedSystem = true;
const KIND = (process.env.KIND ?? "bizjet") as "trainer" | "jet" | "bizjet" | "airliner";
const visual = createAircraft(scene, KIND);

function kind(name: string | undefined): string {
  if (!name) return "sky";
  if (/break-seal/.test(name)) return "seal";
  if (/-(flap|flaperon|aileron)-surface$/.test(name)) return "flap";
  if (/wing$/.test(name) && !/flap|aileron|flaperon/.test(name)) return "wing";
  return "other";
}

const GRID = 110;
const TARGET = new Vector3(-2.2, -1.0, 4.6);

function worst(fraction: number) {
  const roll = Number(process.env.AILERON ?? 0);
  visual.update?.({
    ...INITIAL_VISUAL_STATE, flaps: fraction, aileron: roll, gear: 1, onGround: true,
  } as never, 0.016);
  if (process.env.NO_COVE) {
    for (const m of scene.meshes) if (/break-seal/.test(m.name)) m.setEnabled(false);
  }
  scene.meshes.forEach((m) => m.computeWorldMatrix(true));

  let worstPx = 0, worstAt = "", worstZ: number[] = [];
  // The instrument's own exposure column: how many rays landed on each kind of
  // surface. Zero of either means the classifier has lost the aeroplane and
  // every CLOSED below is void rather than clean.
  const seen = { wing: 0, flap: 0, seal: 0, other: 0, sky: 0 };
  // EVERY leaking span station, not just the worst one. Reporting only the
  // maximum let the F-16's flap-break gap (314 mm) hide a second hole at its
  // wing tip, and "fixed" would have meant "the biggest one is gone".
  const bands = new Map<string, number>();
  for (const range of (process.env.RANGES ?? "12,24,38").split(",").map(Number)) {
    for (const elevationDeg of [4, 8, 12, 18, 25]) {
      for (const azimuthDeg of [0, 10, 20, 30]) {
        const theta = (elevationDeg * Math.PI) / 180;
        const phi = (azimuthDeg * Math.PI) / 180;
        const eye = new Vector3(
          -range * Math.cos(theta) * Math.cos(phi),
          range * Math.sin(theta),
          range * Math.cos(theta) * Math.sin(phi),
        );
        const forward = TARGET.subtract(eye).normalize();
        const right = Vector3.Cross(forward, new Vector3(0, 1, 0)).normalize();
        const up = Vector3.Cross(right, forward).normalize();
        const half = range * 0.09;
        const cols: string[][] = [];
        const zs: number[][] = [];
        for (let c = 0; c < GRID; c += 1) {
          const u = (c / (GRID - 1) - 0.5) * 2 * half;
          const col: string[] = []; const cz: number[] = [];
          for (let r = 0; r < GRID; r += 1) {
            const v = (0.5 - r / (GRID - 1)) * 2 * half;
            const dir = TARGET.add(right.scale(u)).add(up.scale(v)).subtract(eye).normalize();
            const hit = scene.pickWithRay(new Ray(eye, dir, range * 3), (m) => m.isEnabled() && m.isVisible);
            const hitKind = kind(hit?.pickedMesh?.name);
            seen[hitKind as keyof typeof seen] += 1;
            col.push(hitKind);
            cz.push(hit?.pickedPoint?.z ?? NaN);
          }
          cols.push(col); zs.push(cz);
        }
        const pxMetres = ((2 * half) / GRID);
        for (let c = 0; c < GRID; c += 1) {
          const col = cols[c]!;
          for (let i = 0; i < col.length; i += 1) {
            if (col[i] !== "sky") continue;
            let j = i; while (j < col.length && col[j] === "sky") j += 1;
            // Daylight bracketed by WING STRUCTURE on both sides, whichever
            // pieces they are. Requiring one wing and one flap missed a hole
            // between two flap panels, which is exactly the kind the swept
            // flap break opens; requiring only "aeroplane on both sides" would
            // fire on any concave silhouette, such as the gap between a wing
            // and the tailplane behind it.
            const above = i > 0 ? col[i - 1]! : "sky";
            const below = j < col.length ? col[j]! : "sky";
            const structural = (part: string) => part === "wing" || part === "flap" || part === "seal";
            if (structural(above) && structural(below)) {
              const mm = (j - i) * pxMetres * 1000;
              const station = (Math.round((zs[c]![i - 1]! + zs[c]![j]!) * 2) / 4).toFixed(1);
              bands.set(station, Math.max(bands.get(station) ?? 0, mm));
              if (mm > worstPx) {
                worstPx = mm;
                worstAt = `range ${range} m, elev ${elevationDeg} deg, azim ${azimuthDeg} deg`;
                worstZ = [zs[c]![i - 1]!, zs[c]![j]!];
              }
            }
            i = j;
          }
        }
      }
    }
  }
  if (seen.wing === 0 || seen.flap === 0) {
    throw new Error(
      `VOID, not closed: the sweep classified ${seen.wing} rays as fixed wing and `
      + `${seen.flap} as a moving surface on the ${KIND}. Its classifier matches mesh `
      + "NAMES, so a rename or a static-mesh merge silently turns every reading into "
      + `CLOSED. Rays by class: ${JSON.stringify(seen)}.`,
    );
  }
  return { worstPx, worstAt, worstZ, bands, seen };
}

console.log(`### ${KIND}, aileron ${process.env.AILERON ?? 0}${process.env.NO_COVE ? " [CONTROL: seal removed]" : ""} ###`);
for (const [label, f] of [["flaps 0", 0], ["take-off", 0.5], ["full flap", 1]] as const) {
  const w = worst(f);
  console.log(
    w.worstPx === 0
      ? `  ${label.padEnd(10)} CLOSED   (exposure: ${w.seen.wing} wing rays, ${w.seen.flap} surface rays)`
      : `  ${label.padEnd(10)} ${[...w.bands.entries()].sort((a, b) => b[1] - a[1])
          .map(([z, mm]) => `z=${z}: ${mm.toFixed(0)} mm`).join("   ")}   (worst at ${w.worstAt})`,
  );
}
