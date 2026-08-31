import { TERRAIN_KERNEL_SCALAR_WGSL } from "../terrain/TerrainKernel";
import { VEGETATION_GROUND_COVER_LAW_WGSL } from "./densityFieldWgsl";
import {
  GROUND_COVER_ARCHETYPE_SHAPES,
  GROUND_COVER_FIELD_ARCHETYPES,
} from "./groundCoverLaw";

/**
 * Wave G — ground-cover placement compute (WGSL), generalised by `6-9`.
 *
 * One dispatch per ring, one lane per lattice cell. Blade parameters are pure
 * functions of the world-anchored lattice cell, so the field is stable under
 * any camera motion and deterministic for the capture harness.
 *
 * The height tile is the CPU-baked rendered-surface bake (consumer
 * authority); the attribute tile carries the classifier's harmonised ground
 * albedo in rgb and the grass density weight in a — the blade's base colour
 * IS the ground it stands on, which is what hides every fade line. `6-9` adds
 * a DRIVER tile (moisture, canopy shade, riparian band, ground-cover
 * coverage) so the field can evaluate the shipped archetype law per lane and
 * place ferns, heather and reeds as well as grass.
 *
 * **Two changes `6-9` makes to the v1 contract, both deliberate:**
 *
 * 1. *The archetype law is COMPOSED, not restated.* The kernel pulls in
 *    `VEGETATION_GROUND_COVER_LAW_WGSL` — the same text the splat bake reads
 *    through `VEGETATION_DENSITY_FIELD_WGSL` — plus the three scalar helpers
 *    the terrain kernel owns. It composes neither the lattice table nor the
 *    hash layer, because the archetype mix is a pure function of five driver
 *    scalars and paying for eleven noise lattices at ~100 k invocations per
 *    frame would be the wrong trade by two orders of magnitude.
 *
 * 2. *Lanes COMPACT.* Wave G's v1 rung wrote every lane every frame (a blade
 *    or a degenerate zero) and drew the whole lattice, which is honest but
 *    spends a vertex fetch and a kill on every dead lane — and most lanes are
 *    dead, because a square lattice covers an annulus and the density gate
 *    kills most of what is left. Survivors now claim a slot through a
 *    workgroup-reduced `atomicAdd` and the draw takes a conservative count
 *    read back through `GROUND_COVER_COUNTER_RING`. Three properties make
 *    that safe:
 *    - the compaction predicate is STABLE (cover, slope, radius, gate) and
 *      excludes the frustum, which still collapses per blade in the vertex
 *      stage exactly as before — so the count moves slowly enough that a
 *      two-frame-old count plus margin never truncates;
 *    - the slots past the drawn count hold LAST frame's records, which are
 *      real blades on real ground rather than garbage;
 *    - with no count yet the draw takes the whole lattice, which is wave G's
 *      shipped behaviour. The cull degrades, it does not break.
 */

function wgslNumber(value: number): string {
  if (!Number.isFinite(value)) throw new RangeError("WGSL constants must be finite");
  return Number.isInteger(value) ? `${value}.0` : String(value);
}

/**
 * The per-archetype shape table, injected so TS stays the single authority.
 *
 * Emitted as an if-chain rather than a `const array` indexed by the code:
 * dynamic indexing of a module-scope constant array is the kind of construct
 * that compiles on one backend and fails validation on another, and this
 * shader has exactly four rows.
 */
function archetypeShapeTableWgsl(): string {
  const branches = GROUND_COVER_FIELD_ARCHETYPES.map((name, code) => {
    const shape = GROUND_COVER_ARCHETYPE_SHAPES[name];
    const literal = `GroundArchetypeShape(`
      + `${wgslNumber(shape.heightScale)}, ${wgslNumber(shape.widthScale)}, `
      + `${wgslNumber(shape.bendBias)}, ${wgslNumber(shape.densityScale)})`;
    return code === GROUND_COVER_FIELD_ARCHETYPES.length - 1
      ? `  // ${name}\n  return ${literal};`
      : `  // ${name}\n  if (code == ${code}u) { return ${literal}; }`;
  });
  return `fn groundArchetypeShape(code: u32) -> GroundArchetypeShape {\n`
    + `${branches.join("\n")}\n}`;
}

export const GROUND_COVER_COMPUTE_WGSL = /* wgsl */ `
struct GroundCoverUniforms {
  // xy = lattice origin (world metres), z = lattice spacing, w = lattice edge cells.
  lattice: vec4f,
  // xy = tile origin (world metres), z = 1 / tile span, w = height texel size (m).
  tile: vec4f,
  // xyz = camera position (world metres), w = altitude gate scale [0, 1].
  camera: vec4f,
  // x = ring inner radius (gated, m), y = ring outer radius (gated, m),
  // z = ring width scale, w = ring blade segment count (unused by placement).
  ring: vec4f,
  // xy = floating origin xz, z = blade base height (m), w = blade base width (m).
  origin: vec4f,
  // 6-9 cull/law block: x = counter slot index, y = lane capacity,
  // z = sea level (m), w = unused.
  cover: vec4f,
  // Frustum planes in WORLD space (a·p + d >= -r keeps).
  planes: array<vec4f, 6>,
};

@group(0) @binding(0) var<uniform> uniforms: GroundCoverUniforms;
struct GroundBlade {
  // xyz = origin-local root, w = blade height in metres (0 = dead lane).
  position: vec4f,
  // x = facing (2x16f), y = (bend, width) (2x16f),
  // z = albedo rgb + archetype/phase byte (4x8unorm), w = ground normal xz (2x16f).
  packed: vec4u,
};

@group(0) @binding(1) var<storage, read_write> blades: array<GroundBlade>;
@group(0) @binding(2) var groundHeightTile: texture_2d<f32>;
@group(0) @binding(3) var groundAttributeTile: texture_2d<f32>;
// 6-9: r = moisture, g = canopy shade, b = riparian band, a = ground-cover
// coverage (the CARD path's own law, so the two representations agree about
// how much floor a stand carries).
@group(0) @binding(4) var groundDriverTile: texture_2d<f32>;
// 6-9: one atomic per ring per frame slot; the CPU resets this frame's slot
// before the dispatches and reads an older one back.
@group(0) @binding(5) var<storage, read_write> groundCounters: array<atomic<u32>>;

${TERRAIN_KERNEL_SCALAR_WGSL}
${VEGETATION_GROUND_COVER_LAW_WGSL}

struct GroundArchetypeShape {
  heightScale: f32,
  widthScale: f32,
  bendBias: f32,
  // Share of the lattice this archetype occupies where it wins the mix. A
  // frond is not a blade: one every ~0.4 m reads as fern, one every 0.18 m
  // reads as a triangle bill.
  densityScale: f32,
};

${archetypeShapeTableWgsl()}

// Integer hash, NOT the sin-fract idiom: cells here are WORLD-anchored ids
// that reach ~1e5 a few kilometres out, where sin's f32 argument reduction
// and fract-of-1e11 collapse to banded near-constants — the field rendered
// as perfect lattice ROWS with uniform density and height (seen in the
// first grove-forest-2m capture). The airport neighbourhood masked it: its
// small cell ids kept the sin hash healthy at every earlier test site.
fn groundHash2(cell: vec2f, salt: f32) -> f32 {
  var h = (u32(i32(cell.x)) * 0x27d4eb2du)
    ^ (u32(i32(cell.y)) * 0x165667b1u)
    ^ (u32(i32(salt * 8.0)) * 0x9e3779b9u);
  h = h ^ (h >> 15u);
  h = h * 0x2c1b3c6du;
  h = h ^ (h >> 12u);
  h = h * 0x297a2d39u;
  h = h ^ (h >> 15u);
  return f32(h) * 2.3283064365386963e-10;
}

fn groundHeightAt(world: vec2f) -> f32 {
  let uv = (world - uniforms.tile.xy) * uniforms.tile.z;
  let edge = f32(textureDimensions(groundHeightTile).x);
  let texel = clamp(uv * edge - 0.5, vec2f(0.0), vec2f(edge - 1.001));
  let base = vec2u(floor(texel));
  let f = texel - floor(texel);
  let h00 = textureLoad(groundHeightTile, base, 0).r;
  let h10 = textureLoad(groundHeightTile, min(base + vec2u(1u, 0u), vec2u(u32(edge) - 1u)), 0).r;
  let h01 = textureLoad(groundHeightTile, min(base + vec2u(0u, 1u), vec2u(u32(edge) - 1u)), 0).r;
  let h11 = textureLoad(groundHeightTile, min(base + vec2u(1u, 1u), vec2u(u32(edge) - 1u)), 0).r;
  return mix(mix(h00, h10, f.x), mix(h01, h11, f.x), f.y);
}

/**
 * The archetype this cell grows, or 4 for "none of ours".
 *
 * The mix is normalised over FIVE lanes and only four of them are ribbons.
 * A draw that lands in the clutter tail therefore yields no blade at all,
 * which is what makes the handoff share-preserving: clutter keeps its cards
 * and its share of the ground instead of being renormalised away.
 */
fn groundArchetypeFor(mix5: VegetationGroundCoverMix, pick: f32) -> u32 {
  var cumulative = mix5.grass;
  if (pick < cumulative) { return 0u; }
  cumulative = cumulative + mix5.fern;
  if (pick < cumulative) { return 1u; }
  cumulative = cumulative + mix5.heather;
  if (pick < cumulative) { return 2u; }
  cumulative = cumulative + mix5.reed;
  if (pick < cumulative) { return 3u; }
  return 4u;
}

// Workgroup compaction: one global atomic per workgroup instead of one per
// live lane. 64 lanes contending on a workgroup atomic is an order of
// magnitude cheaper than 64 lanes contending on a device-scope one, and the
// whole ring reduces to (lanes / 64) global increments.
var<workgroup> groundLiveInWorkgroup: atomic<u32>;
var<workgroup> groundWorkgroupBase: u32;

@compute @workgroup_size(64)
fn placeGroundCover(
  @builtin(global_invocation_id) gid: vec3u,
  @builtin(local_invocation_index) lid: u32,
) {
  if (lid == 0u) { atomicStore(&groundLiveInWorkgroup, 0u); }
  // Every barrier below sits in UNIFORM control flow: out-of-range lanes fall
  // through the body with placed == false rather than returning early,
  // because a return before a workgroupBarrier is undefined behaviour in
  // the last (partial) workgroup.
  workgroupBarrier();

  let edge = u32(uniforms.lattice.w);
  let capacity = u32(uniforms.cover.y);
  let lane = gid.x;
  var placed = false;
  var record: GroundBlade;
  record.position = vec4f(0.0);
  record.packed = vec4u(0u);

  if (lane < edge * edge) {
    let cell = vec2f(f32(lane % edge), f32(lane / edge));
    // The lattice origin is snapped to a whole-spacing grid, so this base is a
    // WORLD-anchored cell id: every per-blade hash keys on it and the field
    // never reshuffles as the camera drags the lattice window.
    let worldCell = floor((uniforms.lattice.xy + cell * uniforms.lattice.z + vec2f(0.01))
      / uniforms.lattice.z);
    var world = uniforms.lattice.xy + (cell + vec2f(
      0.06 + 0.88 * groundHash2(worldCell, 1.0),
      0.06 + 0.88 * groundHash2(worldCell, 2.0),
    )) * uniforms.lattice.z;

    // Clumping: pull toward the containing 0.9 m clump centre so blades form
    // tufts with bare ground between — a meadow, not white noise.
    let clumpCell = floor(world / 0.9);
    let clumpCentre = (clumpCell + vec2f(
      groundHash2(clumpCell, 3.0),
      groundHash2(clumpCell, 4.0),
    )) * 0.9;
    let clumpPull = 0.25 + 0.4 * groundHash2(clumpCell, 5.0);
    world = mix(world, clumpCentre, clumpPull * 0.6);

    let radial = distance(world, uniforms.camera.xz);
    var alive = radial >= uniforms.ring.x && radial < uniforms.ring.y;

    // Tile coverage.
    let tileUv = (world - uniforms.tile.xy) * uniforms.tile.z;
    alive = alive && all(tileUv >= vec2f(0.0)) && all(tileUv < vec2f(1.0));

    let attrEdge = f32(textureDimensions(groundAttributeTile).x);
    let attrTexel = vec2u(clamp(tileUv * attrEdge, vec2f(0.0), vec2f(attrEdge - 1.0)));
    let groundAttribute = textureLoad(groundAttributeTile, attrTexel, 0);
    let drivers = textureLoad(groundDriverTile, attrTexel, 0);

    var height = 0.0;
    var normal = vec3f(0.0, 1.0, 0.0);
    if (alive) {
      height = groundHeightAt(world);
      let step = uniforms.tile.w;
      let hx = groundHeightAt(world + vec2f(step, 0.0));
      let hz = groundHeightAt(world + vec2f(0.0, step));
      normal = normalize(vec3f(height - hx, step, height - hz));
      // No ground cover on steep ground (~25 degrees and beyond).
      alive = alive && normal.y > 0.9;
    }

    // 6-9: WHICH plant, from the shipped archetype law on tile-supplied
    // drivers. slope is saturate(1 - normalY), the same quantity
    // TerrainSample publishes and densityField consumes.
    let slope = kSaturate(1.0 - normal.y);
    let mix5 = vegetationGroundCoverWeights(
      drivers.r,
      slope,
      drivers.g,
      height - uniforms.cover.z,
      drivers.b,
    );
    let archetype = groundArchetypeFor(mix5, groundHash2(worldCell, 20.0));
    alive = alive && archetype < 4u;
    let shape = groundArchetypeShape(min(archetype, 3u));

    // Grass keeps the classifier's own grass weight — byte-identical to wave
    // G's density — while the other three take the CARD path's ground-cover
    // coverage, which is what a closed stand's fern floor actually needs and
    // what the retiring fern/heather/reed cards were drawn against.
    var coverage = groundAttribute.a;
    if (archetype != 0u) { coverage = drivers.a; }
    alive = alive
      && groundHash2(worldCell, 6.0) < coverage * shape.densityScale * uniforms.camera.w;

    if (alive) {
      placed = true;
      let clumpFacing = groundHash2(clumpCell, 9.0) * 6.2831853;
      let facing = clumpFacing + (groundHash2(worldCell, 10.0) - 0.5) * 2.4;
      let bend = kSaturate(0.15 + 0.55 * groundHash2(worldCell, 11.0) + shape.bendBias);
      // Six bits of wind phase; the top two carry the archetype. The record
      // stayed 32 bytes on purpose — the lattice is the memory budget and a
      // 50% wider record would have cost more than the archetypes are worth.
      let phase6 = floor(groundHash2(worldCell, 12.0) * 63.0);
      let archetypePhase = (f32(archetype) * 64.0 + phase6) / 255.0;
      let bladeHeight = uniforms.origin.z
        * shape.heightScale
        * (0.65 + 0.7 * groundHash2(worldCell, 7.0))
        * (0.8 + 0.4 * groundHash2(clumpCell, 8.0));
      let width = uniforms.origin.w * uniforms.ring.z * shape.widthScale
        * (0.8 + 0.4 * groundHash2(worldCell, 13.0));
      // Shrink-to-zero across the outer 15% of the gated ring: degenerate
      // triangles cost nothing and there is no dither pattern to swim.
      let rim = 1.0 - kSmoothstep(uniforms.ring.y * 0.85, uniforms.ring.y, radial);

      // The frustum test is NOT part of the compaction predicate: it changes
      // fast (a turn re-rolls it wholesale) and the drawn count is a
      // two-frame-old number. It stays exactly what it was in wave G — a
      // shrink to a degenerate record, collapsed by the vertex kill — so the
      // count the readback carries depends only on slow-moving ground.
      var visible = 1.0;
      let centre = vec3f(world.x, height + bladeHeight * 0.5, world.y);
      for (var plane = 0u; plane < 6u; plane += 1u) {
        let p = uniforms.planes[plane];
        if (dot(p.xyz, centre) + p.w < -bladeHeight * 3.0) { visible = 0.0; }
      }

      record.position = vec4f(
        world.x - uniforms.origin.x,
        height,
        world.y - uniforms.origin.y,
        bladeHeight * rim * visible,
      );
      record.packed = vec4u(
        pack2x16float(vec2f(cos(facing), sin(facing))),
        pack2x16float(vec2f(bend, width * rim * visible)),
        pack4x8unorm(vec4f(groundAttribute.rgb, archetypePhase)),
        pack2x16float(vec2f(normal.x, normal.z)),
      );
    }
  }

  var slot = 0u;
  if (placed) { slot = atomicAdd(&groundLiveInWorkgroup, 1u); }
  workgroupBarrier();
  if (lid == 0u) {
    groundWorkgroupBase = atomicAdd(
      &groundCounters[u32(uniforms.cover.x)],
      atomicLoad(&groundLiveInWorkgroup),
    );
  }
  workgroupBarrier();
  if (placed) {
    let index = groundWorkgroupBase + slot;
    if (index < capacity) { blades[index] = record; }
  }
}
`;

/**
 * `6-9` / §7 R4 — the OPTIONAL indirect publish, one workgroup of one lane.
 *
 * Runs after a ring's placement dispatch in the same encoder, so the count it
 * reads is this frame's. It writes the whole five-word indexed-indirect
 * record rather than only the instance count, which is what removes any need
 * to reset the buffer from the CPU: Babylon's own `setIndirectData` seeds it
 * once and then early-returns forever, because the mesh's
 * `forcedInstanceCount` is pinned.
 *
 * This is the optimisation, not the default. The shipped path takes the count
 * through the readback ring; this removes its two-frame latency and its
 * safety margin, and it is reached only behind
 * `assertIndirectInstanceCountSupported`.
 */
export const GROUND_COVER_INDIRECT_PUBLISH_WGSL = /* wgsl */ `
struct GroundIndirectParams {
  // x = counter slot index, y = lane capacity, z = index count, w = unused.
  publish: vec4u,
};

@group(0) @binding(0) var<uniform> params: GroundIndirectParams;
@group(0) @binding(1) var<storage, read_write> groundCounters: array<atomic<u32>>;
@group(0) @binding(2) var<storage, read_write> groundIndirect: array<u32>;

@compute @workgroup_size(1)
fn publishGroundCoverIndirect() {
  let live = min(atomicLoad(&groundCounters[params.publish.x]), params.publish.y);
  groundIndirect[0] = params.publish.z;
  groundIndirect[1] = live;
  groundIndirect[2] = 0u;
  groundIndirect[3] = 0u;
  groundIndirect[4] = 0u;
}
`;
