/**
 * The walker's realistic body: the skinned meshes and texture maps baked by
 * `scripts/bake-walker-body.mts` from MakeHuman's CC0 base mesh (see
 * `docs/WALKER_FIGURE.md`), and how the renderer reads them.
 *
 * FILES, in `./assets/`:
 *  - `walker-body.bin`: every level of detail's triangles over one shared,
 *    quantised vertex list (below);
 *  - `walker-{albedo,normal,orm}-{2048,1024,512}.jpg`: the atlas's maps at
 *    each tier's size. Albedo is sRGB; the normal map is tangent space, +X
 *    along U and +Y along the bake's V (up the image), so the material reads
 *    it with its Y inverted (`FIGURE_NORMAL_MAP_Y_DOWN`); ORM is R ambient
 *    occlusion, G roughness, B metallic.
 *
 * `walker-body.bin`, little-endian, every section 4-byte aligned:
 *  - header, u32 x 4: magic `WALKER_BODY_MAGIC`, version, LOD count, vertex count;
 *  - f32 x 6: the vertices' box, min then max (positions are quantised over it);
 *  - u32 per LOD: its index count;
 *  - per vertex, in arrays: position u16 x 3 (over the box), normal i16 x 3
 *    (unit, x 32767), UV u16 x 2 (x 65535, V down the image as Babylon reads
 *    a raw texture's rows), four bones u8 x 4, four weights u8 x 4 (summing to
 *    255);
 *  - per LOD: its indices, u16, into the shared vertices.
 *
 * FRAME. The root's: +X forward, +Y up, +Z right, feet on y = 0. Faces wind
 * the repo's way: `cross(p1 - p0, p2 - p0)` points into the solid.
 */

export const WALKER_BODY_MAGIC = 0x31424b57; // "WKB1"
export const WALKER_BODY_VERSION = 1;

/** The texture sizes the bake writes; each tier reads one (`personFigureTextureSize`). */
export const WALKER_TEXTURE_SIZES = Object.freeze([2048, 1024, 512] as const);
export type WalkerTextureSize = (typeof WALKER_TEXTURE_SIZES)[number];

/** The normal map's +Y runs up the image, against V as the mesh's UVs run it: the material inverts it. */
export const FIGURE_NORMAL_MAP_Y_DOWN = true;

export interface FigureGeometry {
  readonly positions: Float32Array;
  readonly normals: Float32Array;
  readonly uvs: Float32Array;
  readonly indices: Uint32Array;
  /** Four bone indices and four weights per vertex (weights sum to 1). */
  readonly matricesIndices: Float32Array;
  readonly matricesWeights: Float32Array;
}

export interface WalkerBodyMaps {
  readonly size: number;
  /** RGBA, rows from the image's top (V = 0 as the mesh's UVs run). */
  readonly albedo: Uint8Array;
  readonly normal: Uint8Array;
  readonly orm: Uint8Array;
}

export interface WalkerBodyAsset {
  /** Finest first. */
  readonly lods: readonly FigureGeometry[];
  /** Absent where images cannot be decoded (Node, in the unit tests): the figure then wears flat neutral maps. */
  readonly maps: WalkerBodyMaps | null;
}

/** Reads `walker-body.bin`. */
export function decodeWalkerBody(buffer: ArrayBuffer): FigureGeometry[] {
  const view = new DataView(buffer);
  if (view.getUint32(0, true) !== WALKER_BODY_MAGIC) throw new Error("walker-body.bin: not a walker body");
  const version = view.getUint32(4, true);
  if (version !== WALKER_BODY_VERSION) throw new Error(`walker-body.bin: version ${version}, expected ${WALKER_BODY_VERSION}`);
  const lodCount = view.getUint32(8, true);
  const vertexCount = view.getUint32(12, true);
  const lo = [view.getFloat32(16, true), view.getFloat32(20, true), view.getFloat32(24, true)];
  const hi = [view.getFloat32(28, true), view.getFloat32(32, true), view.getFloat32(36, true)];
  let offset = 40;
  const indexCounts: number[] = [];
  for (let lod = 0; lod < lodCount; lod += 1) {
    indexCounts.push(view.getUint32(offset, true));
    offset += 4;
  }
  const take = <T>(make: (start: number, length: number) => T, bytes: number, length: number): T => {
    const array = make(offset, length);
    offset += Math.ceil((bytes * length) / 4) * 4;
    return array;
  };
  const positions = take((s, n) => new Uint16Array(buffer, s, n), 2, vertexCount * 3);
  const normals = take((s, n) => new Int16Array(buffer, s, n), 2, vertexCount * 3);
  const uvs = take((s, n) => new Uint16Array(buffer, s, n), 2, vertexCount * 2);
  const bones = take((s, n) => new Uint8Array(buffer, s, n), 1, vertexCount * 4);
  const weights = take((s, n) => new Uint8Array(buffer, s, n), 1, vertexCount * 4);
  const lods: FigureGeometry[] = [];
  for (let lod = 0; lod < lodCount; lod += 1) {
    const source = take((s, n) => new Uint16Array(buffer, s, n), 2, indexCounts[lod]!);
    // This level's own vertices: the shared ones its triangles use, in first-use order.
    const remap = new Int32Array(vertexCount).fill(-1);
    const used: number[] = [];
    const indices = new Uint32Array(source.length);
    for (let i = 0; i < source.length; i += 1) {
      const v = source[i]!;
      if (remap[v]! < 0) {
        remap[v] = used.length;
        used.push(v);
      }
      indices[i] = remap[v]!;
    }
    const n = used.length;
    const geometry = {
      positions: new Float32Array(n * 3),
      normals: new Float32Array(n * 3),
      uvs: new Float32Array(n * 2),
      indices,
      matricesIndices: new Float32Array(n * 4),
      matricesWeights: new Float32Array(n * 4),
    };
    used.forEach((v, i) => {
      let length = 0;
      for (let a = 0; a < 3; a += 1) {
        geometry.positions[i * 3 + a] = lo[a]! + (positions[v * 3 + a]! / 65535) * (hi[a]! - lo[a]!);
        const component = normals[v * 3 + a]! / 32767;
        geometry.normals[i * 3 + a] = component;
        length += component * component;
      }
      length = Math.sqrt(length) || 1;
      for (let a = 0; a < 3; a += 1) geometry.normals[i * 3 + a]! /= length;
      geometry.uvs[i * 2] = uvs[v * 2]! / 65535;
      geometry.uvs[i * 2 + 1] = uvs[v * 2 + 1]! / 65535;
      let total = 0;
      for (let k = 0; k < 4; k += 1) total += weights[v * 4 + k]!;
      for (let k = 0; k < 4; k += 1) {
        geometry.matricesIndices[i * 4 + k] = bones[v * 4 + k]!;
        geometry.matricesWeights[i * 4 + k] = total > 0 ? weights[v * 4 + k]! / total : k === 0 ? 1 : 0;
      }
    });
    lods.push(geometry);
  }
  return lods;
}

const ASSET_URLS = {
  body: new URL("./assets/walker-body.bin", import.meta.url),
  maps: {
    2048: {
      albedo: new URL("./assets/walker-albedo-2048.jpg", import.meta.url),
      normal: new URL("./assets/walker-normal-2048.jpg", import.meta.url),
      orm: new URL("./assets/walker-orm-2048.jpg", import.meta.url),
    },
    1024: {
      albedo: new URL("./assets/walker-albedo-1024.jpg", import.meta.url),
      normal: new URL("./assets/walker-normal-1024.jpg", import.meta.url),
      orm: new URL("./assets/walker-orm-1024.jpg", import.meta.url),
    },
    512: {
      albedo: new URL("./assets/walker-albedo-512.jpg", import.meta.url),
      normal: new URL("./assets/walker-normal-512.jpg", import.meta.url),
      orm: new URL("./assets/walker-orm-512.jpg", import.meta.url),
    },
  },
} as const;

/** The asset's bytes: fetched in a browser, read from disk under Node (the unit tests import the module from its file). */
async function readAsset(url: URL): Promise<ArrayBuffer> {
  if (url.protocol === "file:") {
    // Kept out of the bundle's graph: only Node takes this branch.
    const fsModule = "node:fs/promises";
    const { readFile } = (await import(/* @vite-ignore */ fsModule)) as typeof import("node:fs/promises");
    const bytes = await readFile(url);
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  }
  const response = await fetch(url);
  if (!response.ok) throw new Error(`walker body: ${url.pathname} answered ${response.status}`);
  return response.arrayBuffer();
}

/** A JPEG's RGBA pixels, or null where the platform cannot decode images. */
async function decodeImage(bytes: ArrayBuffer, size: number): Promise<Uint8Array | null> {
  if (typeof createImageBitmap !== "function" || typeof OffscreenCanvas !== "function") return null;
  // As stored: no colour management, no premultiplying (the maps are data as much as colour).
  const bitmap = await createImageBitmap(new Blob([bytes], { type: "image/jpeg" }), { colorSpaceConversion: "none", premultiplyAlpha: "none" });
  if (bitmap.width !== size || bitmap.height !== size) throw new Error(`walker body: a map is ${bitmap.width} x ${bitmap.height}, expected ${size}`);
  const canvas = new OffscreenCanvas(size, size);
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) return null;
  context.drawImage(bitmap, 0, 0);
  bitmap.close();
  return new Uint8Array(context.getImageData(0, 0, size, size).data.buffer);
}

let bodyPromise: Promise<FigureGeometry[]> | null = null;
const mapPromises = new Map<number, Promise<WalkerBodyMaps | null>>();

/**
 * The body at a tier's texture size, read once per page and shared by every
 * figure built after (each builds its own GPU buffers and textures from it).
 */
export async function loadWalkerBody(textureSize: WalkerTextureSize): Promise<WalkerBodyAsset> {
  bodyPromise ??= readAsset(ASSET_URLS.body).then(decodeWalkerBody);
  let maps = mapPromises.get(textureSize);
  if (!maps) {
    const urls = ASSET_URLS.maps[textureSize];
    maps = Promise.all([readAsset(urls.albedo), readAsset(urls.normal), readAsset(urls.orm)])
      .then((files) => Promise.all(files.map((bytes) => decodeImage(bytes, textureSize))))
      .then(([albedo, normal, orm]) => (albedo && normal && orm ? { size: textureSize, albedo, normal, orm } : null));
    mapPromises.set(textureSize, maps);
  }
  const [lods, decoded] = await Promise.all([bodyPromise, maps]);
  return { lods, maps: decoded };
}

/**
 * Mip chains for the three maps, level 0 the maps as loaded: albedo averaged
 * in linear light; normals averaged as vectors and renormalised, and the
 * spread they lose turned into roughness on the ORM's G (Toksvig), so a
 * distant jacket's folds do not leave a false sharp highlight; occlusion and
 * metal averaged.
 */
export function buildFigureMipChains(maps: WalkerBodyMaps, levels: number): { albedo: Uint8Array[]; normal: Uint8Array[]; orm: Uint8Array[] } {
  const albedo = [maps.albedo];
  const normal = [maps.normal];
  const orm = [maps.orm];
  // Per texel of the current level, its normal's unnormalised length (1 at level 0).
  let lengths = new Float32Array(maps.size * maps.size).fill(1);
  let size = maps.size;
  for (let level = 1; level < levels && size > 1; level += 1) {
    const half = size >> 1;
    const a = albedo[level - 1]!;
    const n = normal[level - 1]!;
    const o = orm[level - 1]!;
    const nextA = new Uint8Array(half * half * 4);
    const nextN = new Uint8Array(half * half * 4);
    const nextO = new Uint8Array(half * half * 4);
    const nextLengths = new Float32Array(half * half);
    for (let y = 0; y < half; y += 1) {
      for (let x = 0; x < half; x += 1) {
        const dst = y * half + x;
        const sources = [(2 * y) * size + 2 * x, (2 * y) * size + 2 * x + 1, (2 * y + 1) * size + 2 * x, (2 * y + 1) * size + 2 * x + 1];
        let nx = 0;
        let ny = 0;
        let nz = 0;
        for (const s of sources) {
          // Each source normal carries the length it kept from the levels above.
          const l = lengths[s]!;
          nx += ((n[s * 4]! / 255) * 2 - 1) * l;
          ny += ((n[s * 4 + 1]! / 255) * 2 - 1) * l;
          nz += ((n[s * 4 + 2]! / 255) * 2 - 1) * l;
        }
        const length = Math.hypot(nx, ny, nz) / 4;
        const inv = length > 0 ? 1 / (length * 4) : 0;
        nextN[dst * 4] = Math.round((nx * inv * 0.5 + 0.5) * 255);
        nextN[dst * 4 + 1] = Math.round((ny * inv * 0.5 + 0.5) * 255);
        nextN[dst * 4 + 2] = Math.round(((length > 0 ? nz * inv : 1) * 0.5 + 0.5) * 255);
        nextN[dst * 4 + 3] = 255;
        nextLengths[dst] = Math.max(1e-3, length);
        for (let k = 0; k < 3; k += 1) {
          let linear = 0;
          let data = 0;
          for (const s of sources) {
            linear += SRGB_TO_LINEAR[a[s * 4 + k]!]!;
            data += o[s * 4 + k]!;
          }
          nextA[dst * 4 + k] = linearToSrgbByte(linear / 4);
          nextO[dst * 4 + k] = Math.round(data / 4);
        }
        nextA[dst * 4 + 3] = 255;
        nextO[dst * 4 + 3] = 255;
        // Toksvig: the shortened mean normal widens the lobe, roughness^2 grows by (1 - |n|) / |n|.
        const roughness = nextO[dst * 4 + 1]! / 255;
        const spread = (1 - nextLengths[dst]!) / nextLengths[dst]!;
        nextO[dst * 4 + 1] = Math.round(Math.min(1, Math.sqrt(roughness * roughness + spread)) * 255);
      }
    }
    albedo.push(nextA);
    normal.push(nextN);
    orm.push(nextO);
    lengths = nextLengths;
    size = half;
  }
  return { albedo, normal, orm };
}

const SRGB_TO_LINEAR = Float32Array.from({ length: 256 }, (_, c) => {
  const s = c / 255;
  return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
});

function linearToSrgbByte(l: number): number {
  const s = l <= 0.0031308 ? l * 12.92 : 1.055 * l ** (1 / 2.4) - 0.055;
  return Math.max(0, Math.min(255, Math.round(s * 255)));
}
