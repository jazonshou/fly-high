/**
 * Wave G — ground-cover placement compute (WGSL).
 *
 * One dispatch per ring, one lane per lattice cell. Every lane writes its
 * record every frame — a live blade or a degenerate zero — so the renderer
 * needs no atomics, no counters and no indirect draws (the v1 "no
 * compaction" rung; the vertex stage collapses zero blades). Blade
 * parameters are pure functions of the world-anchored lattice cell, so the
 * field is stable under any camera motion and deterministic for the capture
 * harness.
 *
 * The height tile is the CPU-baked rendered-surface bake (consumer
 * authority); the attribute tile carries the classifier's harmonised ground
 * albedo in rgb and the grass density weight in a — the blade's base colour
 * IS the ground it stands on, which is what hides every fade line.
 */

export const GROUND_COVER_COMPUTE_WGSL = /* wgsl */ `
struct GroundCoverUniforms {
  // xy = lattice origin (world metres), z = lattice spacing, w = lattice edge cells.
  lattice: vec4f,
  // xy = tile origin (world metres), z = 1 / tile span, w = height texel size (m).
  tile: vec4f,
  // xyz = camera position (world metres), w = altitude gate scale [0, 1].
  camera: vec4f,
  // x = ring inner radius (gated, m), y = ring outer radius (gated, m),
  // z = ring width scale, w = floating-origin-relative output flag (unused).
  ring: vec4f,
  // xy = floating origin xz, z = blade base height (m), w = blade base width (m).
  origin: vec4f,
  // Frustum planes in WORLD space (a·p + d >= -r keeps).
  planes: array<vec4f, 6>,
};

@group(0) @binding(0) var<uniform> uniforms: GroundCoverUniforms;
struct GroundBlade {
  // xyz = origin-local root, w = blade height in metres (0 = dead lane).
  position: vec4f,
  // x = facing (2x16f), y = (bend, width) (2x16f),
  // z = albedo rgb + wind phase byte (4x8unorm), w = ground normal xz (2x16f).
  packed: vec4u,
};

@group(0) @binding(1) var<storage, read_write> blades: array<GroundBlade>;
@group(0) @binding(2) var groundHeightTile: texture_2d<f32>;
@group(0) @binding(3) var groundAttributeTile: texture_2d<f32>;

fn groundHash2(cell: vec2f, salt: f32) -> f32 {
  return fract(sin(dot(cell, vec2f(127.1, 311.7)) + salt * 74.7) * 43758.5453123);
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

@compute @workgroup_size(64)
fn placeGroundCover(@builtin(global_invocation_id) gid: vec3u) {
  let edge = u32(uniforms.lattice.w);
  let lane = gid.x;
  if (lane >= edge * edge) { return; }

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

  // Density from the attribute tile (a = grass weight after clearances).
  let attrEdge = f32(textureDimensions(groundAttributeTile).x);
  let attrTexel = vec2u(clamp(tileUv * attrEdge, vec2f(0.0), vec2f(attrEdge - 1.0)));
  let groundAttribute = textureLoad(groundAttributeTile, attrTexel, 0);
  alive = alive && groundHash2(worldCell, 6.0) < groundAttribute.a * uniforms.camera.w;

  var height = 0.0;
  var normal = vec3f(0.0, 1.0, 0.0);
  if (alive) {
    height = groundHeightAt(world);
    let step = uniforms.tile.w;
    let hx = groundHeightAt(world + vec2f(step, 0.0));
    let hz = groundHeightAt(world + vec2f(0.0, step));
    normal = normalize(vec3f(height - hx, step, height - hz));
    // No grass on steep ground (~25 degrees and beyond).
    alive = alive && normal.y > 0.9;
  }

  if (alive) {
    // Frustum: conservative sphere at the blade root.
    let bladeHeight = uniforms.origin.z
      * (0.65 + 0.7 * groundHash2(worldCell, 7.0))
      * (0.8 + 0.4 * groundHash2(clumpCell, 8.0));
    let centre = vec3f(world.x, height + bladeHeight * 0.5, world.y);
    for (var plane = 0u; plane < 6u; plane += 1u) {
      let p = uniforms.planes[plane];
      if (dot(p.xyz, centre) + p.w < -bladeHeight * 3.0) { alive = false; }
    }
    if (alive) {
      let clumpFacing = groundHash2(clumpCell, 9.0) * 6.2831853;
      let facing = clumpFacing + (groundHash2(worldCell, 10.0) - 0.5) * 2.4;
      let bend = 0.15 + 0.55 * groundHash2(worldCell, 11.0);
      let phase = groundHash2(worldCell, 12.0);
      let width = uniforms.origin.w * uniforms.ring.z
        * (0.8 + 0.4 * groundHash2(worldCell, 13.0));
      // Shrink-to-zero across the outer 15% of the gated ring: degenerate
      // triangles cost nothing and there is no dither pattern to swim.
      let rim = 1.0 - smoothstep(uniforms.ring.y * 0.85, uniforms.ring.y, radial);
      blades[lane].position = vec4f(
        world.x - uniforms.origin.x,
        height,
        world.y - uniforms.origin.y,
        bladeHeight * rim,
      );
      blades[lane].packed = vec4u(
        pack2x16float(vec2f(cos(facing), sin(facing))),
        pack2x16float(vec2f(bend, width * rim)),
        pack4x8unorm(vec4f(groundAttribute.rgb, phase)),
        pack2x16float(vec2f(normal.x, normal.z)),
      );
      return;
    }
  }
  blades[lane].position = vec4f(0.0);
  blades[lane].packed = vec4u(0u);
}
`;
