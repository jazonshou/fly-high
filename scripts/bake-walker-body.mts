/**
 * Bakes the walker's realistic body: `npx tsx scripts/bake-walker-body.mts`.
 *
 *   --sources DIR   where MakeHuman's files are cached (node_modules/.cache/walker-body)
 *   --out DIR       where the game's files go (src/render/webgpu/person/assets)
 *   --preview DIR   also write PNG previews of each stage there
 *   --maps DIR      also write the full-size maps there as PNG
 *
 * See `scripts/walkerBody/` for the stages and `docs/WALKER_FIGURE.md` for
 * the sources and their licence.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { BIND_POSITIONS, BONE_NAMES } from "../src/render/webgpu/person/skeleton";
import { PROPORTIONS } from "../src/render/webgpu/person/figureProportions";
import { buildBody } from "./walkerBody/body.mts";
import { fetchSources } from "./walkerBody/sources.mts";
import { renderPreview, type PreviewMesh } from "./walkerBody/preview.mts";
import { buildGarments } from "./walkerBody/clothes.mts";
import { swatchCursor } from "./walkerBody/swatches.mts";
import { exportParts, type Part } from "./walkerBody/parts.mts";
import { buildBoots } from "./walkerBody/boots.mts";
import { buildEyes } from "./walkerBody/eyes.mts";
import { MeshoptSimplifier } from "meshoptimizer";
import sharp from "sharp";
import { findLandmarks } from "./walkerBody/landmarks.mts";
import { occlusionTracer } from "./walkerBody/ao.mts";
import { bakeTextures, halve, type BakedMaps } from "./walkerBody/textures.mts";
import { buildLods, encodeWalkerBody } from "./walkerBody/asset.mts";
import { WALKER_TEXTURE_SIZES } from "../src/render/webgpu/person/walkerBody";

const { values } = parseArgs({
  options: {
    sources: { type: "string", default: "node_modules/.cache/walker-body" },
    out: { type: "string", default: "src/render/webgpu/person/assets" },
    preview: { type: "string" },
    maps: { type: "string" },
  },
});

const read = await fetchSources(values.sources!);
const body = buildBody(read);

const report: string[] = [];
const near = (name: string, bone: number) => {
  const j = body.joint(name);
  const b = [BIND_POSITIONS[bone * 3]!, BIND_POSITIONS[bone * 3 + 1]!, BIND_POSITIONS[bone * 3 + 2]!];
  report.push(`${BONE_NAMES[bone]!.padEnd(10)} ${name.padEnd(26)} off ${(Math.hypot(j[0] - b[0]!, j[1] - b[1]!, j[2] - b[2]!) * 1000).toFixed(1)} mm  (${j.map((x) => x.toFixed(3)).join(", ")})`);
};
const pairs: [string, string][] = [
  ["upperleg01.L____head", "thighL"],
  ["lowerleg01.L____head", "shinL"],
  ["foot.L____head", "footL"],
  ["upperarm01.L____head", "upperArmL"],
  ["lowerarm01.L____head", "forearmL"],
  ["wrist.L____head", "handL"],
  ["finger3-1.L____head", "fingersL"],
  ["neck01____head", "neck"],
  ["head____head", "head"],
];
for (const [name, bone] of pairs) near(name, BONE_NAMES.indexOf(bone));
{
  // Landmarks against the walker's measured proportions.
  const groupMean = (group: string, positions: Float64Array) => {
    const seen = new Set<number>();
    for (const f of body.faces) if (f.group === group) for (const v of f.vertices) seen.add(v);
    let y = 0;
    let x = 0;
    for (const v of seen) {
      x += positions[v * 3]!;
      y += positions[v * 3 + 1]!;
    }
    return [x / seen.size, y / seen.size];
  };
  let top = -Infinity;
  for (const f of body.faces) if (f.group === "body") for (const v of f.vertices) top = Math.max(top, body.positions[v * 3 + 1]!);
  const eye = groupMean("helper-l-eye", body.positions);
  const H = PROPORTIONS.stature;
  report.push(`top ${top.toFixed(3)} (stature ${H}); eye y ${eye[1]!.toFixed(3)} = ${(eye[1]! / H).toFixed(3)} H (Drillis 0.936), x ${eye[0]!.toFixed(3)}`);
}
report.push(`palm twists (deg) ${body.fit.palmTwists.map((t) => ((t * 180) / Math.PI).toFixed(1)).join(", ")}; thumb base offsets (mm) ${body.fit.thumbOffsets.map((t) => (t * 1000).toFixed(1)).join(", ")}`);
report.push(`finger fans (deg, before->after): ${body.hands.fans.join("; ")}`);
const swatches = swatchCursor();
const garments = buildGarments(body, swatches);
report.push(...garments.report);
await MeshoptSimplifier.ready;
const boots = buildBoots(body);
report.push(...boots.report);
const eyes = buildEyes(body, read);
const parts: Part[] = [garments.skin, eyes.part, boots.part, garments.trousers, garments.jacket, garments.hair];
const mesh = exportParts(parts);
report.push(`exported: ${mesh.positions.length / 3} vertices, ${mesh.indices.length / 3} triangles`);
const marks = findLandmarks(body, eyes.fits, boots.part);
const fmt = (v: readonly number[]) => v.map((x) => x.toFixed(3)).join(", ");
report.push(`landmarks: eyes ${marks.eyes.map((e) => fmt(e.center)).join(" / ")}; mouth ${fmt(marks.mouth)}; nose ${fmt(marks.noseTip)}; toes ${marks.toes.map((t) => `${t.x.toFixed(3)}, ${t.z.toFixed(3)}`).join(" / ")}`);
console.log(report.join("\n"));
let clock = performance.now();
const lap = (what: string) => {
  const now = performance.now();
  console.log(`${what}: ${((now - clock) / 1000).toFixed(1)} s`);
  clock = now;
};
const lods = buildLods(mesh);
console.log(`levels of detail: ${lods.map((lod) => `${lod.indices.length / 3} triangles (error ${(lod.error * 100).toFixed(2)}%)`).join(", ")}`);
mkdirSync(values.out!, { recursive: true });
writeFileSync(join(values.out!, "walker-body.bin"), encodeWalkerBody(mesh, lods));
lap("levels of detail");
const size = WALKER_TEXTURE_SIZES[0];
const maps = bakeTextures(mesh, parts.map((p) => p.kind), occlusionTracer(mesh.positions, mesh.indices, 32), marks, size);
lap(`maps at ${size}`);
// The tiers' sizes, each the one above halved; JPEG, the data maps without chroma subsampling (it would bleed their channels into each other).
let tier: BakedMaps = maps;
for (const tierSize of WALKER_TEXTURE_SIZES) {
  while (tier.size > tierSize) tier = halve(tier);
  const jpeg = (rgb: Uint8Array, quality: number, chromaSubsampling: "4:2:0" | "4:4:4") =>
    sharp(Buffer.from(rgb), { raw: { width: tier.size, height: tier.size, channels: 3 } }).jpeg({ quality, chromaSubsampling, mozjpeg: true });
  await jpeg(tier.albedo, 90, "4:2:0").toFile(join(values.out!, `walker-albedo-${tierSize}.jpg`));
  await jpeg(tier.normal, 94, "4:4:4").toFile(join(values.out!, `walker-normal-${tierSize}.jpg`));
  await jpeg(tier.orm, 92, "4:4:4").toFile(join(values.out!, `walker-orm-${tierSize}.jpg`));
}
lap(`files in ${values.out}`);
const png = (rgb: Uint8Array, s: number) => sharp(Buffer.from(rgb), { raw: { width: s, height: s, channels: 3 } }).png();
if (values.maps) {
  mkdirSync(values.maps, { recursive: true });
  const write = async (m: BakedMaps) => {
    await png(m.albedo, m.size).toFile(join(values.maps!, `albedo-${m.size}.png`));
    await png(m.normal, m.size).toFile(join(values.maps!, `normal-${m.size}.png`));
    await png(m.orm, m.size).toFile(join(values.maps!, `orm-${m.size}.png`));
  };
  await write(maps);
  console.log(`maps in ${values.maps}`);
}

if (values.preview) {
  mkdirSync(values.preview, { recursive: true });
  const triangles = (positions: ArrayLike<number>, groups: (g: string) => boolean): PreviewMesh => {
    const indices: number[] = [];
    for (const f of body.faces) {
      if (!groups(f.group)) continue;
      for (let k = 1; k + 1 < f.vertices.length; k += 1) indices.push(f.vertices[0]!, f.vertices[k]!, f.vertices[k + 1]!);
    }
    return { positions, indices };
  };
  const views = [{ yaw: 0 }, { yaw: Math.PI / 2 }, { yaw: Math.PI / 4 }, { yaw: Math.PI }];
  writeFileSync(join(values.preview, "body-unfitted.png"), renderPreview([triangles(body.unfitted, (g) => g === "body")], views, 900));
  writeFileSync(join(values.preview, "body-fitted.png"), renderPreview([triangles(body.positions, (g) => g === "body")], views, 900));
  writeFileSync(join(values.preview, "helpers-fitted.png"), renderPreview([triangles(body.positions, (g) => g === "helper-tights" || g === "helper-hair")], views, 900));
  const all = triangles(body.positions, (g) => g === "body");
  const hand = (sign: number) => {
    const w = body.joint(sign < 0 ? "wrist.L____head" : "wrist.R____head");
    return [w[0] - 0.08, w[1] - 0.2, w[2] - 0.08, w[0] + 0.08, w[1] + 0.02, w[2] + 0.08];
  };
  const head = body.joint("head____head");
  const headBox = [head[0] - 0.14, head[1] - 0.14, -0.12, head[0] + 0.14, head[1] + 0.18, 0.12];
  writeFileSync(join(values.preview, "closeups.png"), renderPreview([all], [{ yaw: 0, frame: headBox }, { yaw: Math.PI / 2, frame: headBox }, { yaw: 0.6, frame: headBox }, { yaw: -Math.PI / 2, frame: hand(-1) }, { yaw: Math.PI / 2, frame: hand(1) }, { yaw: 0, frame: hand(1) }], 700));
  const KIND_COLORS: Record<string, number[]> = { skin: [0.85, 0.62, 0.5], jacket: [0.36, 0.4, 0.33], trousers: [0.62, 0.56, 0.45], boots: [0.4, 0.27, 0.18], hair: [0.2, 0.15, 0.11], eyes: [0.9, 0.9, 0.9] };
  const colors = new Float32Array(mesh.positions.length);
  for (let v = 0; v < mesh.positions.length / 3; v += 1) colors.set(KIND_COLORS[parts[mesh.partOf[v]!]!.kind]!, v * 3);
  const dressed: PreviewMesh = { positions: mesh.positions, indices: mesh.indices, colors };
  writeFileSync(join(values.preview, "dressed.png"), renderPreview([dressed], views, 900));
  const closeViews = [{ yaw: 0, frame: headBox }, { yaw: Math.PI / 2, frame: headBox }, { yaw: 2.4, frame: headBox }, { yaw: 0.5, frame: [-0.15, 1.3, -0.25, 0.2, 1.6, 0.25] }, { yaw: 1.2, frame: [-0.2, 0, 0, 0.3, 0.6, 0.25] }, { yaw: -0.4, pitch: -0.5, frame: [-0.2, 0.0, -0.35, 0.2, 0.9, 0.35] }];
  writeFileSync(join(values.preview, "dressed-closeups.png"), renderPreview([dressed], closeViews, 700));
  const textured: PreviewMesh = { positions: mesh.positions, indices: mesh.indices, normals: mesh.normals, uvs: mesh.uvs, albedo: { size, data: maps.albedo }, normalMap: { size, data: maps.normal } };
  writeFileSync(join(values.preview, "textured.png"), renderPreview([textured], views, 1400));
  writeFileSync(join(values.preview, "textured-closeups.png"), renderPreview([textured], closeViews, 1000));
  const face = [head[0] - 0.02, head[1] - 0.1, -0.08, head[0] + 0.14, head[1] + 0.06, 0.08];
  writeFileSync(join(values.preview, "textured-face.png"), renderPreview([textured], [{ yaw: 0, frame: face }, { yaw: 0.7, frame: face }, { yaw: Math.PI / 2, frame: face }], 1200));
  const lodViews = [{ yaw: 0.5 }];
  writeFileSync(join(values.preview, "lods.png"), renderPreview(lods.map((lod, level) => ({ ...textured, indices: lod.indices, positions: Float32Array.from(mesh.positions, (x, i) => (i % 3 === 2 ? x + (level - 1.5) * 0.7 : x)) })), lodViews.map((v) => ({ ...v, frame: [-0.3, 0, -1.4, 0.3, 1.8, 1.4] })), 1000));
  const flat: PreviewMesh = { positions: mesh.positions, indices: mesh.indices, normals: mesh.normals, uvs: mesh.uvs, normalMap: { size, data: maps.normal } };
  writeFileSync(join(values.preview, "normals-only.png"), renderPreview([flat], closeViews, 1000));
  console.log(`previews in ${values.preview}`);
}
