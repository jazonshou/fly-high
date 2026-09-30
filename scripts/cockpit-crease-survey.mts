/**
 * What a pilot SEES of a cockpit's shapes, from the seat: every visible crease sharper than a threshold, every seam
 * where one part meets another on a continuous surface, every silhouette, every edge against the glass, and every flat
 * slab, per part, in pixels of a window of the size asked. Headless (NullEngine), CPU only; any airframe.
 *
 *   npx tsx scripts/cockpit-crease-survey.mts <outDir> [trainer,jet,bizjet,airliner] [--size 1920x1080]
 *       [--frame <kind>=<png>] [--designed <regex>] [--crease 45]
 *
 * HOW. The camera is the renderer's cockpit camera: the catalogue eye, down the body axis, horizontal-fixed at the lens
 * the renderer resolves for the window's aspect (as `tests/support/cockpitFootprints.ts` builds it). Every pixel's ray
 * takes the first surface the GPU DRAWS (enabled, visible, on the camera's layers, opaque, and not a culled back face:
 * a drawn face's cross product points along the ray, the rule `tests/render.cockpit-drawn-faces.test.ts` measured), and
 * records its point, its OUTWARD face normal, its mesh and, inside a merged mesh, the part it came from (the merge's
 * sources are recorded here by triangle count; `mergeStatic` keeps only their names). Then each pair of neighbouring
 * pixels is one of:
 *  - a CREASE: the surface is continuous (the two points are within three pixel footprints of each other, allowing for
 *    the surface's slant) and the two normals are more than `--crease` degrees apart;
 *  - a SEAM: continuous, the part changes, the normals within `--crease`;
 *  - an OCCLUSION: the depth jumps (a silhouette over something behind it);
 *  - an edge AGAINST THE GLASS: one side is a part, the other nothing of the aircraft.
 * Creases and seams are grouped per part PAIR into connected features (a majority label would hide a second crease
 * running into the first). A FLAT SLAB is a connected region of one part whose face normals agree to about 2 degrees.
 * `--designed` names pairs (a regex on "partA / partB") that are designed edges, a bezel's chamfer say, so they are
 * reported apart. With `--frame`, the picture of the same window (same eye, same lens: `scripts/cockpit-frames.mts`)
 * gives each part and slab its mean luma and each crease the tone step across it.
 *
 * Writes <outDir>/<kind>-survey.txt (the table), <kind>-survey.json and <kind>-survey.png (parts in grey, creases red,
 * seams yellow, occlusions blue, glass edges cyan). A 1920 x 1080 window is about two million rays: minutes per deck.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { crc32, deflateSync, inflateSync } from "node:zlib";
import { VertexBuffer } from "@babylonjs/core/Buffers/buffer";
import { Camera } from "@babylonjs/core/Cameras/camera";
import { UniversalCamera } from "@babylonjs/core/Cameras/universalCamera";
import type { PickingInfo } from "@babylonjs/core/Collisions/pickingInfo";
// Picking's side effect: `scene.createPickingRay` and `multiPickWithRay` exist only once this module is loaded.
import "@babylonjs/core/Culling/ray";
import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import type { PBRMaterial } from "@babylonjs/core/Materials/PBR/pbrMaterial";
import { Matrix, Vector3 } from "@babylonjs/core/Maths/math.vector";
import type { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { Scene } from "@babylonjs/core/scene";
import { aircraftSpec } from "@/src/aircraft/catalogue";
import { cockpitHorizontalFieldOfViewForAspect } from "@/src/render/cameraPresentation";
import { createWebGpuAircraft } from "@/src/render/webgpu/aircraft";
import type { AircraftKind } from "@/src/sim";

const DEG = 180 / Math.PI;
const KINDS: readonly AircraftKind[] = ["trainer", "jet", "bizjet", "airliner"];

interface Options {
  outDir: string;
  kinds: AircraftKind[];
  width: number;
  height: number;
  frames: Map<string, string>;
  designed: RegExp | null;
  creaseDegrees: number;
}

function parseArgs(argv: readonly string[]): Options {
  const positional: string[] = [];
  const frames = new Map<string, string>();
  let width = 1920;
  let height = 1080;
  let designed: RegExp | null = null;
  let creaseDegrees = 45;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    const value = () => {
      const next = argv[i + 1];
      if (next === undefined) throw new Error(`${arg} needs a value`);
      i += 1;
      return next;
    };
    if (arg === "--size") {
      const match = /^(\d+)x(\d+)$/.exec(value());
      if (!match) throw new Error("--size is WIDTHxHEIGHT");
      width = Number(match[1]);
      height = Number(match[2]);
    } else if (arg === "--frame") {
      const [kind, path] = value().split("=");
      if (!kind || !path) throw new Error("--frame is <kind>=<png>");
      frames.set(kind, path);
    } else if (arg === "--designed") {
      designed = new RegExp(value());
    } else if (arg === "--crease") {
      creaseDegrees = Number(value());
    } else {
      positional.push(arg);
    }
  }
  const [outDir, kindList] = positional;
  if (!outDir) throw new Error("usage: cockpit-crease-survey.mts <outDir> [kinds] [--size WxH] [--frame kind=png] [--designed regex] [--crease deg]");
  const kinds = (kindList ?? KINDS.join(",")).split(",").map((kind) => {
    if (!(KINDS as readonly string[]).includes(kind)) throw new Error(`unknown kind ${kind}`);
    return kind as AircraftKind;
  });
  return { outDir, kinds, width, height, frames, designed, creaseDegrees };
}

// ---- the merge's sources, by triangle count ------------------------------------------------------------------

/**
 * `mergeStatic` records only the names it folded (`metadata.mergedFrom`), and `Mesh.MergeMeshes` concatenates its
 * sources' indices in order, so each source's triangle count, taken as it is merged, turns a merged mesh's face index
 * back into its part. Wrapped for this script's process only.
 */
const mergeRanges = new WeakMap<Mesh, { name: string; firstFace: number }[]>();
const originalMerge = Mesh.MergeMeshes.bind(Mesh);
Mesh.MergeMeshes = ((meshes: Mesh[], ...rest: unknown[]) => {
  const ranges: { name: string; firstFace: number }[] = [];
  let face = 0;
  for (const mesh of meshes) {
    ranges.push({ name: mesh.name, firstFace: face });
    face += mesh.getTotalIndices() / 3;
  }
  const merged = (originalMerge as (...args: unknown[]) => Mesh | null)(meshes, ...rest);
  if (merged) mergeRanges.set(merged, ranges);
  return merged;
}) as typeof Mesh.MergeMeshes;

function partOf(mesh: AbstractMesh, faceId: number): string {
  const ranges = mesh instanceof Mesh ? mergeRanges.get(mesh) : undefined;
  if (!ranges) return mesh.name;
  let name = ranges[0]!.name;
  for (const range of ranges) if (range.firstFace <= faceId) name = range.name;
  return name;
}

// ---- the view ------------------------------------------------------------------------------------------------

interface Grid {
  readonly width: number;
  readonly height: number;
  readonly focal: number;
  readonly eye: Vector3;
  /** Per pixel: 0 for nothing of the aircraft, else 1 + an index into `parts`. */
  readonly label: Uint16Array;
  readonly parts: string[];
  readonly point: Float64Array;
  readonly normal: Float32Array;
}

function survey(kind: AircraftKind, width: number, height: number): Grid {
  const engine = new NullEngine({ renderWidth: width, renderHeight: height, textureSize: 256, deterministicLockstep: false, lockstepMaxSteps: 1 });
  const scene = new Scene(engine);
  scene.useRightHandedSystem = true;
  const spec = aircraftSpec(kind).cockpitEye;
  const eye = new Vector3(spec.forward, spec.up, spec.right);
  const camera = new UniversalCamera("crease-survey-camera", eye.clone(), scene);
  camera.fovMode = Camera.FOVMODE_HORIZONTAL_FIXED;
  const lens = cockpitHorizontalFieldOfViewForAspect(null, width / height);
  camera.fov = lens / DEG;
  camera.minZ = 0.08;
  camera.setTarget(eye.add(new Vector3(1, 0, 0)));
  scene.activeCamera = camera;
  const aircraft = createWebGpuAircraft(scene, kind);
  aircraft.root.computeWorldMatrix(true);
  for (const mesh of scene.meshes) mesh.computeWorldMatrix(true);
  aircraft.setCockpitView(true);

  const drawn = (mesh: AbstractMesh) => {
    const material = mesh.material as PBRMaterial | null;
    return mesh.isEnabled() && mesh.isVisible && (mesh.layerMask & camera.layerMask) !== 0
      && !(material?.needAlphaBlendingForMesh(mesh) ?? false);
  };
  const world = new Map<AbstractMesh, Float64Array>();
  const corners = (mesh: AbstractMesh, faceId: number): Vector3[] => {
    let positions = world.get(mesh);
    if (!positions) {
      const local = mesh.getVerticesData(VertexBuffer.PositionKind)!;
      const matrix = mesh.getWorldMatrix();
      positions = new Float64Array(local.length);
      for (let i = 0; i + 2 < local.length; i += 3) {
        const v = Vector3.TransformCoordinates(new Vector3(local[i]!, local[i + 1]!, local[i + 2]!), matrix);
        positions[i] = v.x;
        positions[i + 1] = v.y;
        positions[i + 2] = v.z;
      }
      world.set(mesh, positions);
    }
    const indices = mesh.getIndices()!;
    return [0, 1, 2].map((k) => {
      const i = indices[faceId * 3 + k]! * 3;
      return new Vector3(positions![i]!, positions![i + 1]!, positions![i + 2]!);
    });
  };
  const parts: string[] = [];
  const partIndex = new Map<string, number>();
  const label = new Uint16Array(width * height);
  const point = new Float64Array(width * height * 3);
  const normal = new Float32Array(width * height * 3);
  const started = Date.now();
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const ray = scene.createPickingRay(x + 0.5, y + 0.5, Matrix.Identity(), camera);
      const hits = (scene.multiPickWithRay(ray, drawn) ?? []).filter((h: PickingInfo) => h.hit && h.pickedMesh).sort((a, b) => a.distance - b.distance);
      for (const hit of hits) {
        const mesh = hit.pickedMesh!;
        const [p0, p1, p2] = corners(mesh, hit.faceId);
        const cross = Vector3.Cross(p1!.subtract(p0!), p2!.subtract(p0!));
        const twoSided = (mesh.material as PBRMaterial | null)?.backFaceCulling === false;
        if (!twoSided && Vector3.Dot(cross, ray.direction) <= 0) continue;
        const name = `${mesh.name}|${partOf(mesh, hit.faceId)}`;
        let index = partIndex.get(name);
        if (index === undefined) {
          index = parts.length;
          parts.push(name);
          partIndex.set(name, index);
        }
        const k = y * width + x;
        label[k] = index + 1;
        const at = hit.pickedPoint!;
        point.set([at.x, at.y, at.z], k * 3);
        // A drawn face's cross product points INTO the solid: the outward normal is its negative. A two-sided face
        // is turned to face the eye.
        const outward = cross.normalize().scale(-1);
        if (twoSided && Vector3.Dot(outward, ray.direction) > 0) outward.scaleInPlace(-1);
        normal.set([outward.x, outward.y, outward.z], k * 3);
        break;
      }
    }
    if (y % Math.max(1, Math.round(height / 10)) === 0) console.log(`  ${kind}: row ${y} of ${height}, ${((Date.now() - started) / 1000).toFixed(0)} s`);
  }
  aircraft.dispose();
  scene.dispose();
  engine.dispose();
  return { width, height, focal: width / 2 / Math.tan(lens / 2 / DEG), eye, label, parts, point, normal };
}

// ---- PNG, just enough ----------------------------------------------------------------------------------------

/** An 8-bit, non-interlaced RGB or RGBA PNG (what Playwright writes), as RGB. */
function readPng(path: string): { width: number; height: number; rgb: Uint8Array } {
  const file = readFileSync(path);
  if (file.readUInt32BE(0) !== 0x89504e47) throw new Error(`${path} is not a PNG`);
  let offset = 8;
  let width = 0;
  let height = 0;
  let channels = 0;
  const data: Buffer[] = [];
  while (offset < file.length) {
    const length = file.readUInt32BE(offset);
    const type = file.toString("latin1", offset + 4, offset + 8);
    const body = file.subarray(offset + 8, offset + 8 + length);
    if (type === "IHDR") {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      const [depth, colour, , , interlace] = [body[8], body[9], body[10], body[11], body[12]];
      if (depth !== 8 || interlace !== 0 || (colour !== 2 && colour !== 6)) throw new Error(`${path}: only 8-bit non-interlaced RGB/RGBA`);
      channels = colour === 6 ? 4 : 3;
    } else if (type === "IDAT") {
      data.push(body);
    }
    offset += 12 + length;
  }
  const raw = inflateSync(Buffer.concat(data));
  const stride = width * channels;
  const pixels = new Uint8Array(height * stride);
  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)]!;
    const row = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let i = 0; i < stride; i += 1) {
      const left = i >= channels ? pixels[y * stride + i - channels]! : 0;
      const up = y > 0 ? pixels[(y - 1) * stride + i]! : 0;
      const upLeft = y > 0 && i >= channels ? pixels[(y - 1) * stride + i - channels]! : 0;
      let predictor = 0;
      if (filter === 1) predictor = left;
      else if (filter === 2) predictor = up;
      else if (filter === 3) predictor = (left + up) >> 1;
      else if (filter === 4) {
        const p = left + up - upLeft;
        const pa = Math.abs(p - left);
        const pb = Math.abs(p - up);
        const pc = Math.abs(p - upLeft);
        predictor = pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft;
      }
      pixels[y * stride + i] = (row[i]! + predictor) & 0xff;
    }
  }
  const rgb = new Uint8Array(width * height * 3);
  for (let k = 0; k < width * height; k += 1) {
    rgb[k * 3] = pixels[k * channels]!;
    rgb[k * 3 + 1] = pixels[k * channels + 1]!;
    rgb[k * 3 + 2] = pixels[k * channels + 2]!;
  }
  return { width, height, rgb };
}

function writePng(path: string, width: number, height: number, rgb: Uint8Array): void {
  const chunk = (type: string, body: Buffer) => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(body.length, 0);
    head.write(type, 4, "latin1");
    const tail = Buffer.alloc(4);
    tail.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), body])) >>> 0, 0);
    return Buffer.concat([head, body, tail]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  const raw = Buffer.alloc(height * (width * 3 + 1));
  for (let y = 0; y < height; y += 1) Buffer.from(rgb.subarray(y * width * 3, (y + 1) * width * 3)).copy(raw, y * (width * 3 + 1) + 1);
  writeFileSync(path, Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0)),
  ]));
}

// ---- the analysis --------------------------------------------------------------------------------------------

interface Feature {
  readonly kind: "crease" | "seam";
  readonly pair: string;
  readonly designed: boolean;
  readonly px: number;
  readonly meanAngle: number;
  readonly toneStep: number | null;
  readonly az: readonly [number, number];
  readonly el: readonly [number, number];
  readonly cols: readonly [number, number];
  readonly rows: readonly [number, number];
}

/** Connected components (8-neighbour) of the pixels in `members`, by union-find. */
function components(width: number, members: readonly number[]): number[][] {
  const at = new Map<number, number>();
  members.forEach((k, i) => at.set(k, i));
  const parent = members.map((_, i) => i);
  const find = (i: number): number => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]!]!;
      i = parent[i]!;
    }
    return i;
  };
  members.forEach((k, i) => {
    const x = k % width;
    for (const [dx, dy] of [[1, 0], [0, 1], [1, 1], [-1, 1]] as const) {
      if (x + dx < 0 || x + dx >= width) continue;
      const j = at.get(k + dy * width + dx);
      if (j !== undefined) {
        const a = find(i);
        const b = find(j);
        if (a !== b) parent[b] = a;
      }
    }
  });
  const groups = new Map<number, number[]>();
  members.forEach((k, i) => {
    const root = find(i);
    (groups.get(root) ?? groups.set(root, []).get(root)!).push(k);
  });
  return [...groups.values()];
}

function analyse(kind: AircraftKind, grid: Grid, options: Options, frame: { rgb: Uint8Array } | null) {
  const { width, height, focal, eye, label, parts, point, normal } = grid;
  const n = width * height;
  const luma = frame ? Float64Array.from({ length: n }, (_, k) => 0.2126 * frame.rgb[k * 3]! + 0.7152 * frame.rgb[k * 3 + 1]! + 0.0722 * frame.rgb[k * 3 + 2]!) : null;
  const partName = (k: number) => {
    const full = parts[label[k]! - 1]!;
    return full.split("|")[1]!;
  };
  const distance = new Float64Array(n);
  const facing = new Float64Array(n);
  for (let k = 0; k < n; k += 1) {
    if (!label[k]) continue;
    const dx = point[k * 3]! - eye.x;
    const dy = point[k * 3 + 1]! - eye.y;
    const dz = point[k * 3 + 2]! - eye.z;
    const d = Math.hypot(dx, dy, dz);
    distance[k] = d;
    facing[k] = Math.abs((dx * normal[k * 3]! + dy * normal[k * 3 + 1]! + dz * normal[k * 3 + 2]!) / d);
  }
  const angles = (x: number, y: number) => [
    Math.atan((x + 0.5 - width / 2) / focal) * DEG,
    -Math.atan((y + 0.5 - height / 2) / focal) * DEG,
  ] as const;
  const creasePixels = new Map<string, { pixels: number[]; angle: number[]; tone: number[] }>();
  const seamPixels = new Map<string, { pixels: number[]; tone: number[] }>();
  const occlusion = new Map<string, number>();
  const glass = new Map<string, number>();
  const overlay = new Uint8Array(n * 3);
  const mark = (k: number, r: number, g: number, b: number) => overlay.set([r, g, b], k * 3);
  for (let k = 0; k < n; k += 1) {
    const grey = label[k] ? 70 + ((label[k]! * 47) % 150) : 0;
    overlay.set([grey, grey, grey], k * 3);
  }
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const a = y * width + x;
      for (const [dx, dy] of [[1, 0], [0, 1]] as const) {
        if (x + dx >= width || y + dy >= height) continue;
        const b = a + dy * width + dx;
        const ga = label[a]! > 0;
        const gb = label[b]! > 0;
        if (!ga && !gb) continue;
        if (ga !== gb) {
          const key = `${partName(ga ? a : b)} | glass`;
          glass.set(key, (glass.get(key) ?? 0) + 1);
          mark(ga ? a : b, 0, 220, 230);
          continue;
        }
        const gap = Math.hypot(point[a * 3]! - point[b * 3]!, point[a * 3 + 1]! - point[b * 3 + 1]!, point[a * 3 + 2]! - point[b * 3 + 2]!);
        const footprint = distance[a]! / focal / Math.max(Math.min(facing[a]!, facing[b]!), 0.15);
        const pa = partName(a);
        const pb = partName(b);
        if (!(gap < 3 * footprint + 1e-4)) {
          const [near, far] = distance[a]! < distance[b]! ? [pa, pb] : [pb, pa];
          const key = `${near} over ${far}`;
          occlusion.set(key, (occlusion.get(key) ?? 0) + 1);
          mark(distance[a]! < distance[b]! ? a : b, 40, 90, 255);
          continue;
        }
        const cos = normal[a * 3]! * normal[b * 3]! + normal[a * 3 + 1]! * normal[b * 3 + 1]! + normal[a * 3 + 2]! * normal[b * 3 + 2]!;
        const angle = Math.acos(Math.max(-1, Math.min(1, cos))) * DEG;
        const pair = [pa, pb].sort().join(" / ");
        const tone = luma ? Math.abs(luma[a]! - luma[b]!) : 0;
        if (angle > options.creaseDegrees + 0.5) {
          const entry = creasePixels.get(pair) ?? creasePixels.set(pair, { pixels: [], angle: [], tone: [] }).get(pair)!;
          entry.pixels.push(a);
          entry.angle.push(angle);
          entry.tone.push(tone);
          mark(a, 255, 40, 40);
        } else if (pa !== pb) {
          const entry = seamPixels.get(pair) ?? seamPixels.set(pair, { pixels: [], tone: [] }).get(pair)!;
          entry.pixels.push(a);
          entry.tone.push(tone);
          mark(a, 255, 220, 0);
        }
      }
    }
  }
  const features: Feature[] = [];
  const minimum = Math.max(4, Math.round(6 * Math.sqrt(n / (1600 * 900))));
  const collect = (kindOfEdge: "crease" | "seam", table: Map<string, { pixels: number[]; angle?: number[]; tone: number[] }>) => {
    for (const [pair, entry] of table) {
      const index = new Map<number, number>();
      entry.pixels.forEach((k, i) => index.set(k, i));
      const unique = [...new Set(entry.pixels)];
      for (const group of components(width, unique)) {
        if (group.length < minimum) continue;
        const xs = group.map((k) => k % width);
        const ys = group.map((k) => Math.floor(k / width));
        const at = group.map((k) => index.get(k)!);
        const x0 = Math.min(...xs);
        const x1 = Math.max(...xs);
        const y0 = Math.min(...ys);
        const y1 = Math.max(...ys);
        const [az0, el0] = angles(x0, y1);
        const [az1, el1] = angles(x1, y0);
        features.push({
          kind: kindOfEdge,
          pair,
          designed: options.designed?.test(pair) ?? false,
          px: group.length,
          meanAngle: entry.angle ? at.reduce((s, i) => s + entry.angle![i]!, 0) / at.length : 0,
          toneStep: luma ? at.reduce((s, i) => s + entry.tone[i]!, 0) / at.length : null,
          az: [az0, az1],
          el: [el0, el1],
          cols: [x0, x1],
          rows: [y0, y1],
        });
      }
    }
  };
  collect("crease", creasePixels);
  collect("seam", seamPixels);
  features.sort((a, b) => b.px - a.px);

  // Parts: area and tone. Slabs: one part, face normals within about 2 degrees, connected.
  const partStats = new Map<string, { px: number; sum: number; sum2: number }>();
  const bucket = new Map<string, number[]>();
  for (let k = 0; k < n; k += 1) {
    if (!label[k]) continue;
    const p = partName(k);
    const stat = partStats.get(p) ?? partStats.set(p, { px: 0, sum: 0, sum2: 0 }).get(p)!;
    stat.px += 1;
    if (luma) {
      stat.sum += luma[k]!;
      stat.sum2 += luma[k]! ** 2;
    }
    const key = `${p}#${Math.round(normal[k * 3]! * 30)},${Math.round(normal[k * 3 + 1]! * 30)},${Math.round(normal[k * 3 + 2]! * 30)}`;
    (bucket.get(key) ?? bucket.set(key, []).get(key)!).push(k);
  }
  const slabMinimum = Math.round(n / 1000);
  const slabs: { part: string; px: number; share: number; normal: number[]; luma: number | null; az: number[]; el: number[] }[] = [];
  for (const [key, members] of bucket) {
    if (members.length < slabMinimum) continue;
    for (const group of components(width, members)) {
      if (group.length < slabMinimum) continue;
      const xs = group.map((k) => k % width);
      const ys = group.map((k) => Math.floor(k / width));
      const mean = [0, 1, 2].map((c) => group.reduce((s, k) => s + normal[k * 3 + c]!, 0) / group.length);
      const [az0, el0] = angles(Math.min(...xs), Math.max(...ys));
      const [az1, el1] = angles(Math.max(...xs), Math.min(...ys));
      slabs.push({
        part: key.split("#")[0]!, px: group.length, share: group.length / n, normal: mean,
        luma: luma ? group.reduce((s, k) => s + luma[k]!, 0) / group.length : null, az: [az0, az1], el: [el0, el1],
      });
    }
  }
  slabs.sort((a, b) => b.px - a.px);
  return { features, occlusion, glass, partStats, slabs, overlay };
}

// ---- the report ----------------------------------------------------------------------------------------------

const options = parseArgs(process.argv.slice(2));
mkdirSync(options.outDir, { recursive: true });
for (const kind of options.kinds) {
  console.log(`${kind}: ${options.width} x ${options.height}, lens ${cockpitHorizontalFieldOfViewForAspect(null, options.width / options.height).toFixed(3)} degrees`);
  const grid = survey(kind, options.width, options.height);
  const framePath = options.frames.get(kind);
  const frame = framePath ? readPng(framePath) : null;
  if (frame && (frame.width !== grid.width || frame.height !== grid.height)) {
    throw new Error(`${framePath} is ${frame.width} x ${frame.height}, the survey ${grid.width} x ${grid.height}`);
  }
  const result = analyse(kind, grid, options, frame);
  const f1 = (v: number) => v.toFixed(1);
  const lines: string[] = [];
  const total = grid.width * grid.height;
  lines.push(`${kind} from the seat: eye (${grid.eye.x}, ${grid.eye.y}, ${grid.eye.z}), ${grid.width} x ${grid.height}, focal ${f1(grid.focal)} px${frame ? `, tone from ${framePath}` : ""}`);
  lines.push(`crease > ${options.creaseDegrees} deg; designed pairs: ${options.designed ?? "none named"}`);
  lines.push("", "PARTS (px, share of the frame" + (frame ? ", mean luma8, sd" : "") + ")");
  for (const [part, stat] of [...result.partStats].sort((a, b) => b[1].px - a[1].px)) {
    const mean = stat.sum / stat.px;
    lines.push(`  ${part.padEnd(44)} ${String(stat.px).padStart(8)} ${f1((100 * stat.px) / total).padStart(5)}%` + (frame ? `  ${f1(mean).padStart(6)} ${f1(Math.sqrt(Math.max(0, stat.sum2 / stat.px - mean * mean))).padStart(5)}` : ""));
  }
  for (const [title, which, designed] of [["CREASES, not designed", "crease", false], ["CREASES, designed", "crease", true], ["SEAMS", "seam", false], ["SEAMS, designed", "seam", true]] as const) {
    const list = result.features.filter((f) => f.kind === which && f.designed === designed);
    lines.push("", `${title}: ${list.length} features, ${list.reduce((s, f) => s + f.px, 0)} px`);
    for (const f of list) {
      lines.push(`  ${f.pair.padEnd(64)} ${String(f.px).padStart(6)} px` + (which === "crease" ? `  ${f1(f.meanAngle).padStart(5)} deg` : "")
        + (f.toneStep !== null ? `  tone step ${f1(f.toneStep).padStart(5)}` : "")
        + `  az ${f1(f.az[0])}..${f1(f.az[1])}  el ${f1(f.el[0])}..${f1(f.el[1])}  (cols ${f.cols.join("-")}, rows ${f.rows.join("-")})`);
    }
  }
  lines.push("", "OCCLUSION EDGES (near over far, px)");
  for (const [key, px] of [...result.occlusion].sort((a, b) => b[1] - a[1])) lines.push(`  ${key.padEnd(80)} ${String(px).padStart(6)}`);
  lines.push("", "EDGES AGAINST THE GLASS (px)");
  for (const [key, px] of [...result.glass].sort((a, b) => b[1] - a[1])) lines.push(`  ${key.padEnd(80)} ${String(px).padStart(6)}`);
  lines.push("", `FLAT SLABS (one part, one plane to ~2 deg, >= ${Math.round(total / 1000)} px)`);
  for (const s of result.slabs) {
    lines.push(`  ${s.part.padEnd(44)} ${String(s.px).padStart(8)} ${f1(100 * s.share).padStart(5)}%  normal (${s.normal.map((v) => v.toFixed(2)).join(", ")})`
      + (s.luma !== null ? `  luma ${f1(s.luma)}` : "") + `  az ${f1(s.az[0]!)}..${f1(s.az[1]!)}  el ${f1(s.el[0]!)}..${f1(s.el[1]!)}`);
  }
  const text = `${lines.join("\n")}\n`;
  writeFileSync(`${options.outDir}/${kind}-survey.txt`, text);
  writeFileSync(`${options.outDir}/${kind}-survey.json`, `${JSON.stringify({
    kind, width: grid.width, height: grid.height, eye: grid.eye.asArray(), creaseDegrees: options.creaseDegrees,
    features: result.features, occlusion: Object.fromEntries(result.occlusion), glass: Object.fromEntries(result.glass),
    parts: Object.fromEntries([...result.partStats].map(([p, s]) => [p, { px: s.px, luma: frame ? s.sum / s.px : null }])), slabs: result.slabs,
  }, null, 1)}\n`);
  writePng(`${options.outDir}/${kind}-survey.png`, grid.width, grid.height, result.overlay);
  console.log(text);
}
