/**
 * A small CPU rasteriser for checking the bake by eye: orthographic views of
 * triangles, depth-buffered, lit by a key and a fill light, optionally
 * coloured per vertex. Not used by the game.
 */
import { deflateSync } from "node:zlib";

export interface PreviewMesh {
  readonly positions: ArrayLike<number>;
  readonly indices: ArrayLike<number>;
  /** RGB 0..1 per vertex; grey when absent. */
  readonly colors?: ArrayLike<number>;
  /** Smooth normals per vertex (else the faces' own). */
  readonly normals?: ArrayLike<number>;
  /** UVs per vertex, for the maps below. */
  readonly uvs?: ArrayLike<number>;
  /** An sRGB albedo map sampled with `uvs` (rows from V = 1), in place of `colors`. */
  readonly albedo?: PreviewMap;
  /** A tangent-space normal map (+X along U, +Y along V). */
  readonly normalMap?: PreviewMap;
}

export interface PreviewMap {
  readonly size: number;
  /** RGB bytes. */
  readonly data: Uint8Array;
}

export interface PreviewView {
  /** Yaw of the camera about +Y, radians: 0 looks at the figure's front (from +X). */
  readonly yaw: number;
  readonly pitch?: number;
  /** World-space box to frame: [minX, minY, minZ, maxX, maxY, maxZ]; the whole mesh when absent. */
  readonly frame?: readonly number[];
}

export function renderPreview(meshes: readonly PreviewMesh[], views: readonly PreviewView[], height: number): Buffer {
  const widthEach = Math.round(height * 0.6);
  const png = { width: widthEach * views.length, height, data: new Uint8Array(widthEach * views.length * height * 4) };
  for (let i = 0; i < png.data.length; i += 4) {
    png.data[i] = 46;
    png.data[i + 1] = 50;
    png.data[i + 2] = 56;
    png.data[i + 3] = 255;
  }
  views.forEach((view, vi) => drawView(png, vi * widthEach, widthEach, height, meshes, view));
  return encodePng(png.width, png.height, png.data);
}

/** An RGBA image as a PNG file (8-bit, no filtering). */
export function encodePng(width: number, height: number, rgba: Uint8Array): Buffer {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y += 1) raw.set(rgba.subarray(y * width * 4, (y + 1) * width * 4), y * (width * 4 + 1) + 1);
  const chunk = (type: string, data: Buffer) => {
    const out = Buffer.alloc(12 + data.length);
    out.writeUInt32BE(data.length, 0);
    out.write(type, 4, "latin1");
    data.copy(out, 8);
    out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
    return out;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function drawView(png: { width: number; data: Uint8Array }, x0: number, w: number, h: number, meshes: readonly PreviewMesh[], view: PreviewView): void {
  const cy = Math.cos(view.yaw);
  const sy = Math.sin(view.yaw);
  const pitch = view.pitch ?? 0;
  const cp = Math.cos(pitch);
  const sp = Math.sin(pitch);
  // Camera axes: looking along -forward; right and up on screen.
  const forward = [cy * cp, sp, sy * cp]; // from the figure toward the camera
  const right = [sy, 0, -cy];
  const up = [-cy * sp, cp, -sy * sp];
  const project = (x: number, y: number, z: number): [number, number, number] => [x * right[0]! + y * right[1]! + z * right[2]!, x * up[0]! + y * up[1]! + z * up[2]!, x * forward[0]! + y * forward[1]! + z * forward[2]!];
  let minU = Infinity;
  let maxU = -Infinity;
  let minV = Infinity;
  let maxV = -Infinity;
  const corners: number[][] = [];
  if (view.frame) {
    const f = view.frame;
    for (const x of [f[0]!, f[3]!]) for (const y of [f[1]!, f[4]!]) for (const z of [f[2]!, f[5]!]) corners.push([x, y, z]);
  } else {
    for (const m of meshes) for (let i = 0; i < m.positions.length; i += 3) corners.push([m.positions[i]!, m.positions[i + 1]!, m.positions[i + 2]!]);
  }
  for (const [x, y, z] of corners) {
    const [u, v] = project(x!, y!, z!);
    minU = Math.min(minU, u);
    maxU = Math.max(maxU, u);
    minV = Math.min(minV, v);
    maxV = Math.max(maxV, v);
  }
  const s = Math.min((w * 0.92) / (maxU - minU), (h * 0.95) / (maxV - minV));
  const cu = (minU + maxU) / 2;
  const cv = (minV + maxV) / 2;
  const depth = new Float32Array(w * h).fill(-Infinity);
  const light = norm([0.6, 0.7, 0.4]);
  const fill = norm([-0.5, 0.2, -0.6]);
  for (const mesh of meshes) {
    const { positions: p, indices } = mesh;
    for (let t = 0; t < indices.length; t += 3) {
      const ia = indices[t]!;
      const ib = indices[t + 1]!;
      const ic = indices[t + 2]!;
      const a = project(p[ia * 3]!, p[ia * 3 + 1]!, p[ia * 3 + 2]!);
      const b = project(p[ib * 3]!, p[ib * 3 + 1]!, p[ib * 3 + 2]!);
      const c = project(p[ic * 3]!, p[ic * 3 + 1]!, p[ic * 3 + 2]!);
      // World normal for lighting.
      const e1 = [p[ib * 3]! - p[ia * 3]!, p[ib * 3 + 1]! - p[ia * 3 + 1]!, p[ib * 3 + 2]! - p[ia * 3 + 2]!];
      const e2 = [p[ic * 3]! - p[ia * 3]!, p[ic * 3 + 1]! - p[ia * 3 + 1]!, p[ic * 3 + 2]! - p[ia * 3 + 2]!];
      const nrm = norm([e1[1]! * e2[2]! - e1[2]! * e2[1]!, e1[2]! * e2[0]! - e1[0]! * e2[2]!, e1[0]! * e2[1]! - e1[1]! * e2[0]!]);
      const facing = nrm[0]! * forward[0]! + nrm[1]! * forward[1]! + nrm[2]! * forward[2]!;
      const n2 = facing < 0 ? nrm.map((x) => -x) : nrm;
      const lit = 0.25 + 0.65 * Math.max(0, dot3(n2, light)) + 0.2 * Math.max(0, dot3(n2, fill));
      const flip = facing < 0 ? -1 : 1;
      const uv = mesh.uvs;
      let tan: number[] | null = null;
      let bit: number[] | null = null;
      if (uv && mesh.normalMap) {
        const du1 = uv[ib * 2]! - uv[ia * 2]!;
        const dv1 = uv[ib * 2 + 1]! - uv[ia * 2 + 1]!;
        const du2 = uv[ic * 2]! - uv[ia * 2]!;
        const dv2 = uv[ic * 2 + 1]! - uv[ia * 2 + 1]!;
        const r = 1 / (du1 * dv2 - du2 * dv1 || 1e-12);
        tan = [0, 1, 2].map((k) => (e1[k]! * dv2 - e2[k]! * dv1) * r);
        bit = [0, 1, 2].map((k) => (e2[k]! * du1 - e1[k]! * du2) * r);
      }
      const colorOf = (i: number): number[] => (mesh.colors ? [mesh.colors[i * 3]!, mesh.colors[i * 3 + 1]!, mesh.colors[i * 3 + 2]!] : [0.78, 0.76, 0.74]);
      const ca = colorOf(ia);
      const cb = colorOf(ib);
      const cc = colorOf(ic);
      const sx = (q: number[]) => (q[0]! - cu) * s + w / 2;
      const syy = (q: number[]) => h / 2 - (q[1]! - cv) * s;
      const ax = sx(a);
      const ay = syy(a);
      const bx = sx(b);
      const by = syy(b);
      const cx = sx(c);
      const cyy = syy(c);
      const area = (bx - ax) * (cyy - ay) - (cx - ax) * (by - ay);
      if (Math.abs(area) < 1e-9) continue;
      const xmin = Math.max(0, Math.floor(Math.min(ax, bx, cx)));
      const xmax = Math.min(w - 1, Math.ceil(Math.max(ax, bx, cx)));
      const ymin = Math.max(0, Math.floor(Math.min(ay, by, cyy)));
      const ymax = Math.min(h - 1, Math.ceil(Math.max(ay, by, cyy)));
      for (let py = ymin; py <= ymax; py += 1) {
        for (let px = xmin; px <= xmax; px += 1) {
          const qx = px + 0.5;
          const qy = py + 0.5;
          const w0 = ((bx - qx) * (cyy - qy) - (cx - qx) * (by - qy)) / area;
          const w1 = ((cx - qx) * (ay - qy) - (ax - qx) * (cyy - qy)) / area;
          const w2 = 1 - w0 - w1;
          if (w0 < 0 || w1 < 0 || w2 < 0) continue;
          const z = a[2] * w0 + b[2] * w1 + c[2] * w2;
          const di = py * w + px;
          if (z <= depth[di]!) continue;
          depth[di] = z;
          const o = (py * png.width + x0 + px) * 4;
          let shade = lit;
          let col = [0, 1, 2].map((k) => ca[k]! * w0 + cb[k]! * w1 + cc[k]! * w2);
          if (uv && (mesh.albedo || mesh.normalMap)) {
            const u = uv[ia * 2]! * w0 + uv[ib * 2]! * w1 + uv[ic * 2]! * w2;
            const v = uv[ia * 2 + 1]! * w0 + uv[ib * 2 + 1]! * w1 + uv[ic * 2 + 1]! * w2;
            if (mesh.albedo) col = sample(mesh.albedo, u, v).map((c) => Math.pow(c, 2.2));
            if (mesh.normalMap && tan && bit) {
              const vn = mesh.normals;
              let nn = vn ? norm([0, 1, 2].map((k) => vn[ia * 3 + k]! * w0 + vn[ib * 3 + k]! * w1 + vn[ic * 3 + k]! * w2)) : nrm;
              const tt = orth(tan, nn);
              const bb = orth(bit, nn);
              const m = sample(mesh.normalMap, u, v).map((c) => c * 2 - 1);
              nn = norm([0, 1, 2].map((k) => tt[k]! * m[0]! + bb[k]! * m[1]! + nn[k]! * m[2]!));
              const n3 = nn.map((x) => x * flip);
              shade = 0.25 + 0.65 * Math.max(0, dot3(n3, light)) + 0.2 * Math.max(0, dot3(n3, fill));
            }
          }
          for (let k = 0; k < 3; k += 1) {
            png.data[o + k] = Math.max(0, Math.min(255, Math.round(255 * Math.pow(col[k]! * shade, 1 / (mesh.albedo ? 2.2 : 1.4)))));
          }
        }
      }
    }
  }
}

const dot3 = (a: number[], b: number[]) => a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]!;
function norm(v: number[]): number[] {
  const l = Math.hypot(v[0]!, v[1]!, v[2]!) || 1;
  return [v[0]! / l, v[1]! / l, v[2]! / l];
}

function sample(map: PreviewMap, u: number, v: number): number[] {
  const x = Math.min(map.size - 1, Math.max(0, Math.floor(u * map.size)));
  const y = Math.min(map.size - 1, Math.max(0, Math.floor((1 - v) * map.size)));
  const i = (y * map.size + x) * 3;
  return [map.data[i]! / 255, map.data[i + 1]! / 255, map.data[i + 2]! / 255];
}
function orth(v: number[], n: number[]): number[] {
  const d = dot3(v, n);
  return norm([v[0]! - n[0]! * d, v[1]! - n[1]! * d, v[2]! - n[2]! * d]);
}
