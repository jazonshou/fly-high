/**
 * Where the face's and hands' features are on the finished figure, for the
 * texture bake to paint them in the right places: the eyes from the fitted
 * eyeballs (`buildEyes`), the mouth and nose from the body, the fingertips and palms from
 * the fitted skeleton, the toes from the boots.
 */
import { SIDES } from "../../src/render/webgpu/person/skeleton";
import type { FittedBody } from "./body.mts";
import { hairlineAt, OUTFIT } from "./clothes.mts";
import { cross, dot, normalize, scale, sub, type V3 } from "./math.mts";
import type { Part } from "./parts.mts";
import type { EyeFit } from "./eyes.mts";
import type { Landmarks } from "./textures.mts";

export function findLandmarks(body: FittedBody, eyes: readonly EyeFit[], boots: Part): Landmarks {
  const eyeMarks = eyes.map((e) => ({ center: e.center, axes: e.axes, forward: [1, 0, 0] as V3 }));

  // The nose's tip: the body's most forward point on the midline between the eyes and the mouth.
  const mouthJoint = body.joint("oris05____head");
  let noseTip: V3 = [0, 0, 0];
  for (const f of body.faces) {
    if (f.group !== "body") continue;
    for (const v of f.vertices) {
      const p: V3 = [body.positions[v * 3]!, body.positions[v * 3 + 1]!, body.positions[v * 3 + 2]!];
      if (Math.abs(p[2]) < 0.006 && p[1] > mouthJoint[1] + 0.005 && p[1] < eyeMarks[0]!.center[1] && p[0] > noseTip[0]) noseTip = p;
    }
  }
  // The lips' parting: the midline's front outline (the most forward point in each millimetre of height) is
  // furthest back between the two lips; looked for between the lower lip's joint and the upper's.
  const lower = body.joint("oris01____tail");
  const upper = body.joint("oris05____tail");
  const outline = new Map<number, V3>();
  for (const f of body.faces) {
    if (f.group !== "body") continue;
    for (const v of f.vertices) {
      const p: V3 = [body.positions[v * 3]!, body.positions[v * 3 + 1]!, body.positions[v * 3 + 2]!];
      if (Math.abs(p[2]) > 0.003 || p[1] < lower[1] - 0.004 || p[1] > upper[1]) continue;
      const bin = Math.floor(p[1] * 1000);
      if (p[0] > (outline.get(bin)?.[0] ?? -Infinity)) outline.set(bin, p);
    }
  }
  let parting: V3 = mouthJoint;
  for (const p of outline.values()) if (p[0] < parting[0] || parting === mouthJoint) parting = p;
  const fingertips: { tip: V3; dorsal: V3 }[] = [];
  const palms: V3[] = [];
  for (const side of SIDES) {
    const L = side.sign < 0 ? "L" : "R";
    const j = (name: string, end: "head" | "tail" = "head") => body.joint(`${name}.${L}____${end}`);
    const wrist = j("wrist");
    const axis = normalize(sub(j("finger3-1"), wrist));
    const acrossToIndex = normalize(sub(j("finger2-1"), j("finger5-1")));
    let normal = normalize(cross(axis, acrossToIndex));
    if (dot(normal, [0, 0, -side.sign]) < 0) normal = scale(normal, -1);
    palms.push(normal);
    for (let n = 1; n <= 5; n += 1) {
      const tip = j(`finger${n}-3`, "tail");
      const dir = normalize(sub(tip, j(`finger${n}-3`)));
      // The nail faces away from the palm; the thumb's turns out toward the index's side.
      const away: V3 = n === 1 ? normalize([acrossToIndex[0] - normal[0], acrossToIndex[1] - normal[1], acrossToIndex[2] - normal[2]]) : scale(normal, -1);
      fingertips.push({ tip, dorsal: normalize(sub(away, scale(dir, dot(away, dir)))) });
    }
  }

  const toes = SIDES.map((side) => {
    let x = -Infinity;
    let z = 0;
    let count = 0;
    for (let v = 0; v < boots.positions.length / 3; v += 1) {
      if (Math.sign(boots.positions[v * 3 + 2]!) !== side.sign) continue;
      x = Math.max(x, boots.positions[v * 3]!);
      z += boots.positions[v * 3 + 2]!;
      count += 1;
    }
    z /= count;
    // The front's outline down the middle, from the instep to the top: seen from the side, the furthest point
    // of the middle's vertices in each direction out from a point inside the boot behind the instep.
    const inside: [number, number] = [x - 0.17, 0.04];
    const reach = new Map<number, [number, number, number]>();
    for (let v = 0; v < boots.positions.length / 3; v += 1) {
      if (Math.abs(boots.positions[v * 3 + 2]! - z) > 0.006) continue;
      const dx = boots.positions[v * 3]! - inside[0];
      const dy = boots.positions[v * 3 + 1]! - inside[1];
      const degrees = Math.round((Math.atan2(dy, dx) * 180) / Math.PI / 3) * 3;
      if (degrees < 12 || degrees > 96) continue;
      const r = Math.hypot(dx, dy);
      if (r > (reach.get(degrees)?.[2] ?? 0)) reach.set(degrees, [boots.positions[v * 3]!, boots.positions[v * 3 + 1]!, r]);
    }
    const outline = [...reach.entries()].sort((a, b) => a[0] - b[0]).map(([, [ox, oy]]) => [ox, oy] as [number, number]);
    // Smoothed, so the distance along it runs evenly over the surface (the furthest vertices step about).
    for (let pass = 0; pass < 6; pass += 1) {
      const previous = outline.map((q) => [...q] as [number, number]);
      for (let k = 1; k + 1 < outline.length; k += 1)
        for (let a = 0; a < 2; a += 1) outline[k]![a] = (previous[k - 1]![a]! + 2 * previous[k]![a]! + previous[k + 1]![a]!) / 4;
    }
    // From where the lacing starts, back over the instep, to the top.
    const start = outline.findIndex(([ox]) => ox < x - 0.095);
    return { x, z, lacing: outline.slice(Math.max(0, start - 1)) };
  });

  // The collar's top at the front: the neckline there (1.435) and the collar's height over it.
  const collarTop = 1.47125 - 0.0175 - 0.01875 + OUTFIT.collarHeight + 0.006;
  return { eyes: eyeMarks, mouth: [parting[0], parting[1], 0], mouthHalfWidth: 0.024, noseTip, hair: hairlineAt(body), fingertips, palms, collarTop, toes };
}
