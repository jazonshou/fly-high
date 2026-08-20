import { MaterialPluginBase } from "@babylonjs/core/Materials/materialPluginBase";
import type { MaterialDefines } from "@babylonjs/core/Materials/materialDefines";
import type { PBRMaterial } from "@babylonjs/core/Materials/PBR/pbrMaterial";
import { Constants } from "@babylonjs/core/Engines/constants";
import { RawTexture2DArray } from "@babylonjs/core/Materials/Textures/rawTexture2DArray";
import { Texture } from "@babylonjs/core/Materials/Textures/texture";
import type { Scene } from "@babylonjs/core/scene";
import { ShaderLanguage } from "@babylonjs/core/Materials/shaderLanguage";
import { TERRAIN_NODE_GRID_RESOLUTION } from "./TerrainSpineContract";
import type { BaseTexture } from "@babylonjs/core/Materials/Textures/baseTexture";
import type { UniformBuffer } from "@babylonjs/core/Materials/uniformBuffer";
import type { TerrainTriplanarMode } from "@/src/render/webgpu/core/QualityProfile";
import type { AirportDefinition } from "@/src/world/types";
import {
  seasonalSnowlineDescentMeters,
  seasonalWinterFraction,
  TERRAIN_REFERENCE_DAY_OF_YEAR,
  TERRAIN_REFERENCE_SNOWLINE_OFFSET_METERS,
} from "@/src/world";
import {
  resolveRunwaySurfaceBinding,
  RUNWAY_SURFACE_UNIFORMS,
  RUNWAY_SURFACE_WGSL,
} from "./RunwaySurface";
import {
  landCoverShare,
  meanSurfaceAlbedo,
  SURFACE_MATERIAL_COUNT,
  SURFACE_MATERIALS,
  SurfaceMaterial,
  type SurfaceMaterialSpec,
} from "./surfaceMaterials";

/**
 * 3-2 — the terrain surface plugin (owner: terrain-material).
 *
 * INVARIANT THIS FILE OWNS: terrain surface appearance — albedo, normal,
 * roughness, ambient occlusion and micro-detail — has exactly one owner.
 *
 * `C1`: this SUPERSEDES `TerrainMaterialPlugin`, which is deleted rather than
 * neighboured. Both plugins answered the same question and both wrote
 * `surfaceAlbedo` and `normalW`; splitting the answer across two files whose
 * composition depended on an undocumented priority number is precisely the
 * class of fragility this programme keeps finding. `3-3`'s three fixes are
 * therefore sub-steps inside this file, not a negotiation between two.
 *
 * What is here, by plan item:
 *
 *   `3-2`  the plugin, the array bindings, the regex injections, the
 *          provisional vertex splat, UVs without tangents
 *   `3-3`  micro-detail: footprint gating, real gradients, texture-sourced
 *   `3-4`  three decorrelated rotated de-tiling scales with UV warping
 *   `3-5`  triplanar texture projection, sign-flipped UVs, RNM blending
 *   `3-6`  N-way height blending with a footprint-widened transition depth
 *   `3-7`  per-material roughness, F0 and Oren-Nayar diffuse roughness, plus
 *          the wetness response wired to a constant zero until `6-5`
 *   `3-10` the `dayOfYear`-driven seasonal tint and roughness curve
 *
 * WebGPU-only by design: the renderer never compiles GLSL, and the ~90-line
 * dead GLSL branch the superseded plugin carried is deleted with it.
 *
 * NO TANGENT ATTRIBUTE (`C4`). This plugin writes `normalW` directly and
 * never enters Babylon's `NORMALMAP` path, so the tangent frame it needs is
 * the analytic one implied by its own planar XZ projection — free, and
 * flipped per plane in the triplanar branch. A vertex tangent would be memory
 * and bandwidth spent on a code path that is never compiled (assertion 58).
 *
 * NO SHADOW DEPTH WRAPPER. The vertex stage passes the splat lane through and
 * does not displace, so the depth pass is unaffected. `4-4` adds displacement
 * and must add the wrapper then, per the `0-9` incantation in
 * ARCHITECTURE.md. Stated here so nobody attaches one prematurely and nobody
 * forgets it later.
 */

/** The material id lane's upper bound, as a WGSL literal. */
const LAST_MATERIAL_INDEX = SURFACE_MATERIAL_COUNT - 1;

/**
 * `3-4`'s de-tiling rotations: 13.7° for the patch scale and 61.2° for the
 * micro scale.
 *
 * NOT the deleted build's 36.3°. That angle is within 1.3° of the 35°
 * geological fabric the audit measures at 23.6:1 anisotropy in the geology
 * term, and aligning the de-tiling rotation with the artefact reinforces the
 * exact thing `5-8` exists to remove.
 */
export const DETILE_PATCH_DEGREES = 13.7;
export const DETILE_MICRO_DEGREES = 61.2;

/** World wavelengths of the three decorrelated de-tiling scales, metres. */
export const DETILE_MACRO_METERS = 2_048;
export const DETILE_PATCH_METERS = 176;
export const DETILE_MICRO_METERS = 28;

/**
 * The phase's first tuning knob. At 1.6 the three scales warp the material UV
 * by up to ~58 m, decorrelating every tiling period in the 3-0 table
 * (2.3–8.9 m) many times over; the worst local stretch is the micro scale's,
 * at ~16%, which is below where a warp starts reading as a smear.
 *
 * Tuned against the `approach-500ft` capture: at 1.0 the far ground still
 * carried a visible repeat.
 */
export const DEFAULT_DETILE_WARP = 1.6;

/**
 * The phase's second tuning knob: `3-6`'s height-blend transition depth,
 * `d = mix(0.06, 0.5, saturate(fp / 3))`. It widens with the footprint so the
 * blend does not alias at distance.
 */
export const HEIGHT_BLEND_DEPTH_NEAR = 0.06;
export const HEIGHT_BLEND_DEPTH_FAR = 0.5;

/**
 * Maximum footprint anisotropy the surface sampler will ask for, matched to
 * the arrays' `anisotropicFilteringLevel`. See `terrainSurfaceLimitAnisotropy`.
 */
export const DEFAULT_ANISOTROPY_LIMIT = 12;

/** `3-5`: triplanar engages above this slope (`1 − |n.y|`). */
export const TRIPLANAR_SLOPE_THRESHOLD = 0.22;

// ---------------------------------------------------------------------------
// 3-10 — the seasonal palette.
//
// Per ARCHITECTURE.md §4's threading rule, `dayOfYear` is in the response
// function's signature from the first line, never as a retrofit; the boundary
// test checks this file for it as it comes into existence.
//
// A tint and roughness curve sampled per material — NOT new texture arrays.
// The arrays stay season-independent and only their weighting changes, which
// is what keeps the §5.2 memory row flat while `2-18` competes for the same
// headroom.
// ---------------------------------------------------------------------------

export interface SurfaceSeasonalResponse {
  /** Multiplicative tint on the material's albedo. */
  readonly tint: readonly [number, number, number];
  /** Added to the material's sampled roughness. */
  readonly roughnessDelta: number;
}

const NEUTRAL_RESPONSE: SurfaceSeasonalResponse = Object.freeze({
  tint: Object.freeze([1, 1, 1]) as readonly [number, number, number],
  roughnessDelta: 0,
});

/** Season anchors: day of year in the northern hemisphere, tint, roughness delta. */
const SEASON_ANCHORS: readonly {
  readonly day: number;
  readonly tint: readonly [number, number, number];
  readonly roughnessDelta: number;
}[] = Object.freeze([
  // Spring flush: fresh chlorophyll, and wet ground — the darkening and the
  // gloss both belong to the same fortnight.
  { day: 110, tint: [0.78, 0.98, 0.7], roughnessDelta: -0.07 },
  { day: 199, tint: [1, 1, 1], roughnessDelta: 0 },
  { day: 290, tint: [1.38, 1.02, 0.6], roughnessDelta: 0.03 },
  { day: 15, tint: [1.12, 0.92, 0.7], roughnessDelta: 0.05 },
]);

function seasonWeights(dayOfYear: number, latitudeDegrees: number): number[] {
  // Southern hemisphere: the same curve, half a year out of phase.
  const shifted = latitudeDegrees >= 0 ? dayOfYear : dayOfYear + 365 / 2;
  const weights: number[] = [];
  let total = 0;
  for (const anchor of SEASON_ANCHORS) {
    let delta = (((shifted - anchor.day) % 365) + 365) % 365;
    if (delta > 365 / 2) delta -= 365;
    // A raised cosine over ±½ year, sharpened so an anchor dominates its own
    // season instead of every anchor contributing everywhere.
    const lobe = Math.max(0, Math.cos((delta / 365) * Math.PI * 2)) ** 3;
    weights.push(lobe);
    total += lobe;
  }
  if (total <= 1e-6) return SEASON_ANCHORS.map((_, index) => (index === 1 ? 1 : 0));
  return weights.map((weight) => weight / total);
}

function blendedSeason(dayOfYear: number, latitudeDegrees: number): SurfaceSeasonalResponse {
  const weights = seasonWeights(dayOfYear, latitudeDegrees);
  let r = 0;
  let g = 0;
  let b = 0;
  let roughnessDelta = 0;
  SEASON_ANCHORS.forEach((anchor, index) => {
    const weight = weights[index] ?? 0;
    r += anchor.tint[0] * weight;
    g += anchor.tint[1] * weight;
    b += anchor.tint[2] * weight;
    roughnessDelta += anchor.roughnessDelta * weight;
  });
  return { tint: [r, g, b], roughnessDelta };
}

/**
 * The per-material seasonal response.
 *
 * ANCHORED at `TERRAIN_REFERENCE_DAY_OF_YEAR`, exactly as `R-13`'s kernel
 * terms are: the raw curve is divided by its own value at the reference day,
 * so at the midsummer default clock the response is precisely (1, 1, 1) and 0
 * and the tuned shipped world is bit-identical. Winter, spring and autumn are
 * expressed as deviations from that tuned state rather than as a new one.
 *
 * Rock, asphalt and concrete are season-invariant — the `seasonal` flag in
 * the `3-0` contract, not a list repeated here.
 */
export function surfaceSeasonalResponse(
  spec: SurfaceMaterialSpec,
  dayOfYear: number,
  latitudeDegrees: number,
): SurfaceSeasonalResponse {
  if (!spec.seasonal) return NEUTRAL_RESPONSE;
  const current = blendedSeason(dayOfYear, latitudeDegrees);
  const reference = blendedSeason(TERRAIN_REFERENCE_DAY_OF_YEAR, latitudeDegrees);
  // Dry grass has already made the autumn move; it rides a damped curve so it
  // does not double-count into orange.
  const damping = spec.id === SurfaceMaterial.DryGrass ? 0.45
    : spec.id === SurfaceMaterial.ForestFloor ? 0.6
      : 1;
  const tint: [number, number, number] = [0, 0, 0];
  for (let channel = 0; channel < 3; channel += 1) {
    const ratio = current.tint[channel]! / Math.max(1e-4, reference.tint[channel]!);
    tint[channel] = 1 + (ratio - 1) * damping;
  }
  return {
    tint,
    roughnessDelta: (current.roughnessDelta - reference.roughnessDelta) * damping,
  };
}

/**
 * `R-26`: the scene-scale mean surface albedo the light rig's ground bounce is
 * derived from, with the seasonal tint applied. This is the number that
 * retires deviation `D-6`'s hardcoded 0.25 SH floor and `D-9`'s surviving
 * light-rig palette row — both ground-bounce fakes tuned against a ground
 * colour this phase replaces.
 */
export function meanSeasonalSurfaceAlbedo(
  dayOfYear: number,
  latitudeDegrees: number,
): readonly [number, number, number] {
  const winter = seasonalWinterFraction(dayOfYear, latitudeDegrees);
  const base = meanSurfaceAlbedo(winter);
  // The winter fraction already moved snow's share of the cover; the tint
  // moves the colour of what is left — weighted by the SAME land-cover shares
  // the albedo is. Averaging the tint over all ten materials unweighted lets
  // the six season-invariant ones (rock, gravel, sand, snow and the two paved)
  // halve the swing that four seasonal covers are trying to express.
  const shares = landCoverShare(winter);
  let r = 0;
  let g = 0;
  let b = 0;
  let total = 0;
  SURFACE_MATERIALS.forEach((spec, index) => {
    const share = shares[index] ?? 0;
    const response = surfaceSeasonalResponse(spec, dayOfYear, latitudeDegrees);
    r += response.tint[0] * share;
    g += response.tint[1] * share;
    b += response.tint[2] * share;
    total += share;
  });
  const scale = total > 0 ? [r / total, g / total, b / total] : [1, 1, 1];
  return [
    Math.min(1, base[0] * scale[0]!),
    Math.min(1, base[1] * scale[1]!),
    Math.min(1, base[2] * scale[2]!),
  ];
}

/**
 * `3-6`'s height blend, as a TS mirror of the WGSL.
 *
 * `k_i = h_i + w_i`; `b_i = max(k_i − (max k − d), 0)`; normalise. Assertion 60
 * checks this is a partition of unity for randomised inputs — a blend that
 * quietly loses energy darkens the whole terrain and is very hard to see by
 * eye, which is exactly why it is asserted rather than reviewed.
 *
 * The shader implements the same three lines inline (a `vec3f` version and a
 * `vec2f` version under the tier's material cap) rather than calling a shared
 * WGSL function, so this mirror is the falsifiable statement of the property
 * and the shader's tokens are pinned against it by test.
 */
export function heightBlendWeights(keys: readonly number[], depth: number): number[] {
  if (keys.length === 0) return [];
  const threshold = Math.max(...keys) - depth;
  const raw = keys.map((key) => Math.max(key - threshold, 0));
  const sum = Math.max(raw.reduce((total, value) => total + value, 0), 1e-5);
  return raw.map((value) => value / sum);
}

/** The snowline altitude the shader blankets above, metres above sea level. */
export function seasonalSnowlineMeters(
  seaLevelMeters: number,
  dayOfYear: number,
  latitudeDegrees: number,
): number {
  return seaLevelMeters + TERRAIN_REFERENCE_SNOWLINE_OFFSET_METERS
    - seasonalSnowlineDescentMeters(dayOfYear, latitudeDegrees);
}

// ---------------------------------------------------------------------------
// The shader. WGSL only.
// ---------------------------------------------------------------------------

const PATCH_COS = Math.cos((DETILE_PATCH_DEGREES * Math.PI) / 180).toFixed(6);
const PATCH_SIN = Math.sin((DETILE_PATCH_DEGREES * Math.PI) / 180).toFixed(6);
const MICRO_COS = Math.cos((DETILE_MICRO_DEGREES * Math.PI) / 180).toFixed(6);
const MICRO_SIN = Math.sin((DETILE_MICRO_DEGREES * Math.PI) / 180).toFixed(6);

export const TERRAIN_SURFACE_VERTEX_WGSL = Object.freeze({
  CUSTOM_VERTEX_DEFINITIONS: /* wgsl */ `
#ifdef TERRAIN_SURFACE_CDLOD
// 4-5's node record. TWO stride-4 attributes, never one stride-8: a custom
// kind resolves to _size = 8 inside VertexBuffer and
// WebGPUCacheRenderPipeline throws "Invalid Format ... size=8", because
// WebGPU has no vertex format wider than four components.
//   A = (slotIndex, subNodeX + subNodeZ*8, level, splatPacked)
//   B = (morphK, parentSlotIndex, texelSize, maxDeviation)
attribute terrainNodeA: vec4f;
attribute terrainNodeB: vec4f;
// 4-4: vertex-texture displacement. Sampled with textureLoad ONLY — r32float
// is unfilterable (float32-filterable is available and deliberately not
// requested), and the geomorph wants exact texel values at snapped lattice
// positions anyway.
var terrainHeightAtlas: texture_2d<f32>;

/** Bilinear height from the atlas, as four textureLoads. */
fn terrainSampleHeight(slot: f32, texelX: f32, texelZ: f32) -> f32 {
  if (slot < 0.0) { return 0.0; }
  let grid = uniforms.terrainHeightAtlasShape.w;
  let row = floor(slot / grid);
  let slotOrigin = vec2f(slot - row * grid, row) * uniforms.terrainHeightAtlasShape.y
    + vec2f(uniforms.terrainHeightAtlasShape.z);
  let base = floor(vec2f(texelX, texelZ));
  let fraction = vec2f(texelX, texelZ) - base;
  let corner = vec2i(slotOrigin + base);
  let h00 = textureLoad(terrainHeightAtlas, corner, 0).r;
  let h10 = textureLoad(terrainHeightAtlas, corner + vec2i(1, 0), 0).r;
  let h01 = textureLoad(terrainHeightAtlas, corner + vec2i(0, 1), 0).r;
  let h11 = textureLoad(terrainHeightAtlas, corner + vec2i(1, 1), 0).r;
  let top = h00 + (h10 - h00) * fraction.x;
  let bottom = h01 + (h11 - h01) * fraction.x;
  return top + (bottom - top) * fraction.y;
}
#else
// 3-2's provisional splat rides the colour attribute the clipmap already
// allocated. useVertexColors is false on those meshes, so VERTEXCOLOR is
// never defined and this lane is the plugin's alone:
//   x = primary material id, y = secondary material id, z = secondary weight,
//   w = atlasSlot, written as -1 until 4-2 fills it.
// The ids are CONTINUOUS along the SurfaceMaterial axis and the fragment
// brackets them; see the contract's note on why that order is load-bearing.
attribute color: vec4f;
#endif
varying terrainSplat: vec4f;
// 4-7: the vertex's position INSIDE its page, in metres. The page meshes are
// built page-local and positioned by their world matrix, so this is free —
// and it is what lets the fragment address the channel atlas without a
// per-mesh uniform on a material every page shares.
varying terrainPageLocal: vec2f;
`,
  /**
   * `4-4`: displacement at `CUSTOM_VERTEX_UPDATE_POSITION`, and the hook
   * choice is load-bearing rather than stylistic.
   *
   * `pbr.vertex` assigns `vPositionW = worldPos.xyz` and computes `vNormalW`
   * BEFORE the `CUSTOM_VERTEX_UPDATE_WORLDPOS` marker. Displacing there moves
   * the rasterised geometry but leaves `vPositionW` at the undisplaced height
   * — and `vPositionW` is what the aerial-perspective include, the
   * cloud-shadow plugin and the triplanar projection all read. The symptom is
   * haze and cloud shadows sitting at the wrong altitude on every slope, which
   * reads as a lighting bug and is not one.
   */
  CUSTOM_VERTEX_UPDATE_POSITION: /* wgsl */ `
#ifdef TERRAIN_SURFACE_CDLOD
{
  let nodeA = vertexInputs.terrainNodeA;
  let nodeB = vertexInputs.terrainNodeB;
  let quads = ${TERRAIN_NODE_GRID_RESOLUTION - 1}.0;
  // The geomorph, in the node's OWN grid coordinates. At morphK = 1 every odd
  // vertex has collapsed onto the previous even one, which is exactly the
  // parent's lattice — so the two edges are the same curve and cracks close
  // ANALYTICALLY. That is what lets skirts be deleted, which is what lets
  // backFaceCulling be true.
  let gridPosition = positionUpdated.xz * quads;
  let evenLattice = floor(gridPosition * 0.5) * 2.0;
  let morphed = (gridPosition + (evenLattice - gridPosition) * nodeB.x) / quads;
  positionUpdated.x = morphed.x;
  positionUpdated.z = morphed.y;

  // One 264-texel slot serves an 8x8 block of nodes, and a node spans 32
  // quads, so a node vertex lands on a page texel exactly: no rounding, no
  // half-texel convention to get wrong.
  let parityZ = floor(nodeA.y * 0.0078125);
  let afterZ = nodeA.y - parityZ * 128.0;
  let parityX = floor(afterZ * 0.015625);
  let subIndex = afterZ - parityX * 64.0;
  let subZ = floor(subIndex * 0.125);
  let subX = subIndex - subZ * 8.0;

  let nodeTexel = (vec2f(subX, subZ) + morphed) * quads;
  let fine = terrainSampleHeight(nodeA.x, nodeTexel.x, nodeTexel.y);
  // The parent page is one level coarser — half the texel density — and this
  // node sits in one quadrant of its parent page's 8x8 node block. At
  // morphK = 1 morphed*quads is even, so morphed*16 is an integer and
  // this load is an EXACT parent texel: the child's edge is the parent's, by
  // construction rather than by tuning.
  let parentTexel = vec2f(parityX, parityZ) * 128.0
    + vec2f(subX, subZ) * 16.0
    + morphed * (quads * 0.5);
  let coarse = terrainSampleHeight(nodeB.y, parentTexel.x, parentTexel.y);
  positionUpdated.y = fine + (coarse - fine) * nodeB.x;
}
#endif
`,
  CUSTOM_VERTEX_MAIN_END: /* wgsl */ `
#ifdef TERRAIN_SURFACE_CDLOD
// 4-5's carry-forward: the provisional two-material blend, packed into one
// lane. Without it the gate the plan calls its most visible would ship an
// untextured PBR surface for the ten working days until 4-6 lands.
{
  let packed = vertexInputs.terrainNodeA.w;
  let primary = floor(packed / 1600.0);
  let secondary = floor((packed - primary * 1600.0) / 100.0);
  let weight = (packed - primary * 1600.0 - secondary * 100.0) * 0.01;
  vertexOutputs.terrainSplat = vec4f(primary, secondary, weight, vertexInputs.terrainNodeA.x);
  let subIndexOut = vertexInputs.terrainNodeA.y
    - floor(vertexInputs.terrainNodeA.y * 0.015625) * 64.0;
  let subZOut = floor(subIndexOut * 0.125);
  let subXOut = subIndexOut - subZOut * 8.0;
  // Page-local in [0, 1]: eight nodes span a page on each axis.
  vertexOutputs.terrainPageLocal = (vec2f(subXOut, subZOut)
    + vec2f(positionUpdated.x, positionUpdated.z)) * 0.125;
}
#else
vertexOutputs.terrainSplat = vertexInputs.color;
vertexOutputs.terrainPageLocal = vertexInputs.position.xz;
#endif
`,
});

const FRAGMENT_DEFINITIONS = /* wgsl */ `
varying terrainSplat: vec4f;
varying terrainPageLocal: vec2f;
var terrainSurfaceAlbedoSampler: sampler;
var terrainSurfaceAlbedo: texture_2d_array<f32>;
var terrainSurfaceNormalSampler: sampler;
var terrainSurfaceNormal: texture_2d_array<f32>;

struct TerrainSurfaceLayer {
  albedo: vec3f,
  height: f32,
  normal: vec3f,
  roughness: f32,
  cavity: f32,
  f0: f32,
  diffuseRoughness: f32,
};

fn terrainSurfaceHash(point: vec2f) -> f32 {
  var value = fract(vec3f(point.x, point.y, point.x) * 0.1031);
  value += dot(value, value.yzx + vec3f(33.33));
  return fract((value.x + value.y) * value.z);
}

fn terrainSurfaceValue(point: vec2f) -> f32 {
  let cell = floor(point);
  let local = fract(point);
  let blend = local * local * (vec2f(3.0) - 2.0 * local);
  return mix(
    mix(terrainSurfaceHash(cell), terrainSurfaceHash(cell + vec2f(1.0, 0.0)), blend.x),
    mix(terrainSurfaceHash(cell + vec2f(0.0, 1.0)), terrainSurfaceHash(cell + vec2f(1.0)), blend.x),
    blend.y,
  );
}

fn terrainSurfaceValue2(point: vec2f) -> vec2f {
  return vec2f(terrainSurfaceValue(point), terrainSurfaceValue(point + vec2f(37.7, 19.3)));
}

// 3-4 — three decorrelated rotated world scales, each warping the next, each
// faded by the derivative footprint so a scale finer than the pixel stops
// contributing instead of aliasing. Rotations are 13.7 deg and 61.2 deg,
// deliberately NOT the deleted build's 36.3 deg (see the TS constant).
fn terrainSurfaceDetileWarp(worldXz: vec2f, footprint: f32) -> vec2f {
  let amount = uniforms.terrainSurfaceTuning.x;
  if (amount <= 0.0) {
    return vec2f(0.0);
  }
  let macroWeight = 1.0 - smoothstep(15.0, 96.0, footprint);
  let patchWeight = 1.0 - smoothstep(7.0, 64.0, footprint);
  let microWeight = 1.0 - smoothstep(1.5, 20.0, footprint);
  var warp = vec2f(0.0);
  warp += (terrainSurfaceValue2(worldXz * ${(1 / DETILE_MACRO_METERS).toFixed(9)}) - vec2f(0.5))
    * (${DETILE_MACRO_METERS.toFixed(1)} * 0.012 * amount * macroWeight);
  let patchRotation = mat2x2f(${PATCH_COS}, ${PATCH_SIN}, -${PATCH_SIN}, ${PATCH_COS});
  let patchPoint = patchRotation * (worldXz + warp);
  warp += (terrainSurfaceValue2(patchPoint * ${(1 / DETILE_PATCH_METERS).toFixed(9)}) - vec2f(0.5))
    * (${DETILE_PATCH_METERS.toFixed(1)} * 0.05 * amount * patchWeight);
  let microRotation = mat2x2f(${MICRO_COS}, ${MICRO_SIN}, -${MICRO_SIN}, ${MICRO_COS});
  let microPoint = microRotation * (worldXz + warp);
  warp += (terrainSurfaceValue2(microPoint * ${(1 / DETILE_MICRO_METERS).toFixed(9)}) - vec2f(0.5))
    * (${DETILE_MICRO_METERS.toFixed(1)} * 0.10 * amount * microWeight);
  return warp;
}

// The stored pair is the hemisphere projection; z is reconstructed exactly the
// way the CPU Toksvig reducer reconstructs it, so both agree on what "this
// normal" means.
fn terrainSurfaceDecodeNormal(encoded: vec2f) -> vec3f {
  let xy = encoded * 2.0 - vec2f(1.0);
  return vec3f(xy, sqrt(max(0.0, 1.0 - dot(xy, xy))));
}

// Array A stores sqrt(linear albedo) — see SURFACE_ALBEDO_STORAGE_GAMMA. This
// multiply is the pair of the CPU encode.
fn terrainSurfaceDecodeAlbedo(stored: vec3f) -> vec3f {
  return stored * stored;
}

// Reoriented normal mapping. The first argument is the surface normal
// expressed in the projection plane's tangent space (unnormalised — the
// construction does not need it to be); the second is the sampled
// tangent-space normal.
fn terrainSurfaceRnm(base: vec3f, detail: vec3f) -> vec3f {
  let t = base + vec3f(0.0, 0.0, 1.0);
  let u = detail * vec3f(-1.0, -1.0, 1.0);
  return t * (dot(t, u) / max(t.z, 1e-4)) - u;
}

// A tangent orthogonal to the surface normal, chosen from whichever world
// axis that normal is least aligned with.
//
// The obvious normalize(vec3f(1,0,0) - normal * normal.x) is DEGENERATE for
// a normal of (±1, 0, 0) — it normalises the zero vector — and the terrain
// clipmap's crack-guard skirts carry exactly that normal on two of their four
// sides. Every skirt fragment on a non-projected material would have come out
// NaN.
fn terrainSurfaceTangent(normal: vec3f) -> vec3f {
  let axis = select(vec3f(1.0, 0.0, 0.0), vec3f(0.0, 0.0, 1.0), abs(normal.x) > 0.7);
  return normalize(axis - normal * dot(axis, normal));
}

/**
 * Clamp the sampling footprint's ANISOTROPY.
 *
 * Terrain is seen at grazing angles almost all the time — that is what flying
 * is — and a kilometre out the footprint's major axis is a hundred times its
 * minor. The arrays' 16x anisotropicFilteringLevel caps how many taps the
 * hardware will spend on that, and everything past the sixteenth tap is simply
 * not filtered: the result is a regular directional herringbone across the
 * whole ground plane, which is exactly what the first approach-500ft capture
 * after this plugin landed showed, over land and lake alike.
 *
 * Inflating the minor axis until the ratio is within what the sampler will
 * actually spend pushes the chosen mip coarse enough to cover the major axis.
 * It costs sharpness in the minor direction — which is the direction the eye
 * has no resolution in at a grazing angle anyway — and it costs nothing in
 * bandwidth, because the coarser mip is the cheaper fetch.
 */
fn terrainSurfaceLimitAnisotropy(ddx: vec2f, ddy: vec2f) -> mat2x2f {
  let lengthX = max(length(ddx), 1e-8);
  let lengthY = max(length(ddy), 1e-8);
  let major = max(lengthX, lengthY);
  let minimumMinor = major / ${DEFAULT_ANISOTROPY_LIMIT.toFixed(1)};
  let scaleX = max(1.0, minimumMinor / lengthX);
  let scaleY = max(1.0, minimumMinor / lengthY);
  return mat2x2f(ddx * scaleX, ddy * scaleY);
}

// Every sample in this file uses EXPLICIT gradients. House rule since 2-8:
// any sample under a branch or a wrap gets textureSampleGrad, because
// implicit derivatives under branchy blend weights produce hard mip bands
// across slopes.
fn terrainSurfaceFetchAlbedo(layer: i32, uv: vec2f, ddx: vec2f, ddy: vec2f) -> vec4f {
  let limited = terrainSurfaceLimitAnisotropy(ddx, ddy);
  return textureSampleGrad(
    terrainSurfaceAlbedo, terrainSurfaceAlbedoSampler, uv, layer, limited[0], limited[1]);
}

fn terrainSurfaceFetchNormal(layer: i32, uv: vec2f, ddx: vec2f, ddy: vec2f) -> vec4f {
  let limited = terrainSurfaceLimitAnisotropy(ddx, ddy);
  return textureSampleGrad(
    terrainSurfaceNormal, terrainSurfaceNormalSampler, uv, layer, limited[0], limited[1]);
}

fn terrainSurfaceSample(
  materialIndex: i32,
  position: vec3f,
  geometricNormal: vec3f,
  worldDdx: vec3f,
  worldDdy: vec3f,
  detailWeight: f32,
) -> TerrainSurfaceLayer {
  let row = uniforms.terrainMaterialTiling[materialIndex];
  let inversePeriod = row.x;
  let season = uniforms.terrainMaterialSeason[materialIndex];

  var albedoTexel = vec4f(0.5);
  var normalTexel = vec4f(0.5);
  var worldNormal = geometricNormal;

  let slope = 1.0 - clamp(abs(geometricNormal.y), 0.0, 1.0);
  // 3-5: triplanar engages above 1 - |n.y| > 0.22, and only for the materials
  // the 3-0 contract projects (rock and gravel). Everything else is a planar
  // XZ projection, which is what the ground actually is.
#ifdef TERRAIN_SURFACE_PLANAR_ONLY
  // §5.3's Low row: no triplanar at all.
  let projected = false;
#else
  let projected = row.y > 0.5 && slope > ${TRIPLANAR_SLOPE_THRESHOLD.toFixed(2)};
#endif

  if (projected) {
    var weights = pow(abs(geometricNormal), vec3f(4.0));
    weights = weights / max(weights.x + weights.y + weights.z, 1e-4);
#ifndef TERRAIN_SURFACE_TRIPLANAR
    // 2-axis fast path: mandatory from Balanced up (§7 R3), not a High-only
    // optimisation. Drop the weakest plane and renormalise.
    let weakest = min(weights.x, min(weights.y, weights.z));
    if (weights.x <= weakest) {
      weights.x = 0.0;
    } else if (weights.y <= weakest) {
      weights.y = 0.0;
    } else {
      weights.z = 0.0;
    }
    weights = weights / max(weights.x + weights.y + weights.z, 1e-4);
#endif
    // Sign-flipped per-plane UVs. Untreated, the projection mirrors across
    // each axis and produces a visible reflection seam down every ridge.
    let signs = sign(geometricNormal + vec3f(1e-6));
    let uvX = vec2f(position.z * signs.x, position.y) * inversePeriod;
    let uvY = vec2f(position.x * signs.y, position.z) * inversePeriod;
    let uvZ = vec2f(-position.x * signs.z, position.y) * inversePeriod;
    let ddxX = vec2f(worldDdx.z * signs.x, worldDdx.y) * inversePeriod;
    let ddyX = vec2f(worldDdy.z * signs.x, worldDdy.y) * inversePeriod;
    let ddxY = vec2f(worldDdx.x * signs.y, worldDdx.z) * inversePeriod;
    let ddyY = vec2f(worldDdy.x * signs.y, worldDdy.z) * inversePeriod;
    let ddxZ = vec2f(-worldDdx.x * signs.z, worldDdx.y) * inversePeriod;
    let ddyZ = vec2f(-worldDdy.x * signs.z, worldDdy.y) * inversePeriod;

    let absNormal = abs(geometricNormal);
    var albedoSum = vec4f(0.0);
    var normalSum = vec4f(0.0);
    var blended = vec3f(0.0);
    // The tangent normal's U axis is flipped by the SAME sign the UV was, or
    // the detail is mirrored against the pattern it belongs to; the blended
    // result's own plane axis is flipped again to put it back in world space.
    // Omitting either half is a normal pointing the wrong way on one side of
    // every ridge — the seam the sign-flipped UVs exist to prevent, moved out
    // of albedo and into lighting where it is harder to see and just as wrong.
    if (weights.x > 0.001) {
      let a = terrainSurfaceFetchAlbedo(materialIndex, uvX, ddxX, ddyX);
      let b = terrainSurfaceFetchNormal(materialIndex, uvX, ddxX, ddyX);
      albedoSum += a * weights.x;
      normalSum += b * weights.x;
      let sampled = terrainSurfaceDecodeNormal(b.xy);
      let tangentNormal = terrainSurfaceRnm(
        vec3f(geometricNormal.zy, absNormal.x),
        vec3f(sampled.x * signs.x * detailWeight, sampled.y * detailWeight, sampled.z),
      );
      blended += vec3f(tangentNormal.z * signs.x, tangentNormal.y, tangentNormal.x) * weights.x;
    }
    if (weights.y > 0.001) {
      let a = terrainSurfaceFetchAlbedo(materialIndex, uvY, ddxY, ddyY);
      let b = terrainSurfaceFetchNormal(materialIndex, uvY, ddxY, ddyY);
      albedoSum += a * weights.y;
      normalSum += b * weights.y;
      let sampled = terrainSurfaceDecodeNormal(b.xy);
      let tangentNormal = terrainSurfaceRnm(
        vec3f(geometricNormal.xz, absNormal.y),
        vec3f(sampled.x * signs.y * detailWeight, sampled.y * detailWeight, sampled.z),
      );
      blended += vec3f(tangentNormal.x, tangentNormal.z * signs.y, tangentNormal.y) * weights.y;
    }
    if (weights.z > 0.001) {
      let a = terrainSurfaceFetchAlbedo(materialIndex, uvZ, ddxZ, ddyZ);
      let b = terrainSurfaceFetchNormal(materialIndex, uvZ, ddxZ, ddyZ);
      albedoSum += a * weights.z;
      normalSum += b * weights.z;
      let sampled = terrainSurfaceDecodeNormal(b.xy);
      let tangentNormal = terrainSurfaceRnm(
        vec3f(geometricNormal.xy, absNormal.z),
        vec3f(sampled.x * -signs.z * detailWeight, sampled.y * detailWeight, sampled.z),
      );
      blended += vec3f(tangentNormal.x, tangentNormal.y, tangentNormal.z * signs.z) * weights.z;
    }
    albedoTexel = albedoSum;
    normalTexel = normalSum;
    worldNormal = normalize(blended);
  } else {
#ifdef TERRAIN_SURFACE_PLANAR_ONLY
    // Tier 0: no triplanar at all. A slope-stretched planar projection is the
    // cheap approximation — shorten the period as the face tilts so a cliff is
    // not an infinitely smeared top-down sample.
    let stretch = 1.0 / clamp(abs(geometricNormal.y), 0.35, 1.0);
#else
    let stretch = 1.0;
#endif
    let uv = position.xz * (inversePeriod * stretch);
    let ddx = worldDdx.xz * (inversePeriod * stretch);
    let ddy = worldDdy.xz * (inversePeriod * stretch);
    albedoTexel = terrainSurfaceFetchAlbedo(materialIndex, uv, ddx, ddy);
    normalTexel = terrainSurfaceFetchNormal(materialIndex, uv, ddx, ddy);
    // C4: the tangent frame is the one implied by the planar XZ projection —
    // analytic and free. No vertex tangent attribute exists.
    let tangentNormal = terrainSurfaceDecodeNormal(normalTexel.xy);
    let tangent = terrainSurfaceTangent(geometricNormal);
    let bitangent = cross(tangent, geometricNormal);
    let rise = 1.0 / max(tangentNormal.z, 0.15);
    worldNormal = normalize(
      geometricNormal
      + tangent * (tangentNormal.x * rise * detailWeight)
      + bitangent * (tangentNormal.y * rise * detailWeight)
    );
  }

  var layer: TerrainSurfaceLayer;
  layer.albedo = terrainSurfaceDecodeAlbedo(albedoTexel.rgb) * season.rgb;
  layer.height = albedoTexel.a;
  layer.normal = worldNormal;
  layer.roughness = clamp(normalTexel.b + season.a, 0.02, 1.0);
  layer.cavity = normalTexel.a;
  layer.f0 = row.z;
  layer.diffuseRoughness = row.w;
  return layer;
}

// ---------------------------------------------------------------------------
// 4-7's channel pages, consumed on the CPU TILE MESHES.
//
// This is what makes Gate 4B visible one gate before the quadtree exists: the
// occlusion bake writes into channel pages, and their consumer is THIS
// fragment shader, addressed through 3-2's reserved atlasSlot lane. The
// whole block compiles out when no channel atlas is bound.
// ---------------------------------------------------------------------------
#ifdef TERRAIN_SURFACE_PAGE_CHANNELS
var terrainOcclusionAtlasSampler: sampler;
var terrainOcclusionAtlas: texture_2d<f32>;
var terrainHorizonAtlasASampler: sampler;
var terrainHorizonAtlasA: texture_2d<f32>;
var terrainHorizonAtlasBSampler: sampler;
var terrainHorizonAtlasB: texture_2d<f32>;

/**
 * Atlas UV for this fragment's page, or w = 0 when the page holds no channel
 * slot — the CO-RESIDENCY RULE: a mesh samples channel pages only while its
 * page is resident, and otherwise falls back to the Phase 3 provisional path.
 *
 * The lane packs slotIndex * 32 + level, because the fragment needs the
 * page EXTENT to normalise its local position and a shared material cannot
 * carry a per-mesh uniform.
 */
fn terrainSurfacePageUv(lane: f32, pageLocal: vec2f) -> vec3f {
  if (lane < 0.0) { return vec3f(0.0, 0.0, 0.0); }
  let slot = floor(lane * ${1 / 32});
  let level = lane - slot * 32.0;
  let extent = uniforms.terrainPageAtlasGrid.y * exp2(level);
  let grid = uniforms.terrainPageAtlasGrid.x;
  let row = floor(slot / grid);
  let slotOrigin = vec2f(slot - row * grid, row) * uniforms.terrainPageAtlas.y;
  let core = uniforms.terrainPageAtlas.z;
  let inPage = clamp(pageLocal / extent, vec2f(0.0), vec2f(1.0));
  let texel = slotOrigin + vec2f(uniforms.terrainPageAtlas.w) + inPage * core;
  return vec3f(texel / uniforms.terrainPageAtlas.x, 1.0);
}

/**
 * Sun visibility from the 8-azimuth horizon map.
 *
 * The stored value is sin(horizonElevation) and the sun direction is a unit
 * vector toward the sun, so sunDirection.y is sin(sunElevation) and the
 * comparison is one subtraction — no trigonometry per fragment. The soft band
 * is ~1.1 degrees, which is close enough to the sun's real angular diameter
 * that the terminator does not read as a hard line.
 */
fn terrainSurfaceHorizonShadow(uv: vec3f, sunDirection: vec3f) -> f32 {
  if (uv.z <= 0.0 || sunDirection.y <= 0.0) { return 1.0; }
  let horizontal = max(1e-5, length(sunDirection.xz));
  // The bake marches azimuth s with direction angle (s + 0.5) * pi/4, so the
  // lookup index is the angle in those units minus the half-step.
  let angle = atan2(sunDirection.z / horizontal, sunDirection.x / horizontal);
  let index = angle * ${(4 / Math.PI).toFixed(9)} - 0.5;
  let wrapped = index - floor(index * 0.125) * 8.0;
  let low = floor(wrapped);
  let blend = wrapped - low;
  let packedA = textureSampleLevel(terrainHorizonAtlasA, terrainHorizonAtlasASampler, uv.xy, 0.0);
  let packedB = textureSampleLevel(terrainHorizonAtlasB, terrainHorizonAtlasBSampler, uv.xy, 0.0);
  var slots = array<f32, 8>(
    packedA.x, packedA.y, packedA.z, packedA.w,
    packedB.x, packedB.y, packedB.z, packedB.w,
  );
  let lowIndex = u32(low);
  let highIndex = u32(low + 1.0) % 8u;
  let horizonSin = mix(slots[lowIndex], slots[highIndex], blend);
  let band = uniforms.terrainPageAtlasGrid.w;
  return smoothstep(horizonSin - band, horizonSin + band, sunDirection.y);
}
#endif
`;

const FRAGMENT_BEFORE_LIGHTS = /* wgsl */ `
let terrainAbsolutePosition = vec3f(
  fragmentInputs.vPositionW.x + uniforms.terrainWorldOrigin.x,
  fragmentInputs.vPositionW.y,
  fragmentInputs.vPositionW.z + uniforms.terrainWorldOrigin.y,
);
// Derivatives are taken ONCE, in uniform control flow, before any branch —
// every sample below is textureSampleGrad against these.
let terrainWorldDdx = dpdx(terrainAbsolutePosition);
let terrainWorldDdy = dpdy(terrainAbsolutePosition);
// 3-3 defect 1: the footprint, not a camera-distance gate. The superseded
// plugin faded micro-detail out over a fixed 1.2-4.2 km band of CAMERA
// DISTANCE, which switched it OFF at exactly the range where the audit
// measures vertex normals to be worst and slid the detail ring across the
// ground with the aircraft. A derivative footprint stays attached to the
// surface.
let terrainFootprint = max(length(terrainWorldDdx.xz), length(terrainWorldDdy.xz));
let terrainDetailWeight = 1.0 - smoothstep(1.2, 14.0, terrainFootprint);

let terrainGeometricNormal = normalize(normalW);
let terrainSlope = 1.0 - clamp(abs(terrainGeometricNormal.y), 0.0, 1.0);

// 3-4: one warped position feeds every projection, so the de-tiling cannot
// disagree between planes.
let terrainWarp = terrainSurfaceDetileWarp(terrainAbsolutePosition.xz, terrainFootprint);
// The macro and patch scales also carry the world-scale brightness variation
// the layers themselves no longer do: 3-1 high-passes each material so its
// tiling period cannot show at range, which leaves the hundred-metre and
// kilometre structure to be put back HERE, where it does not repeat. The
// figures are the deleted build's — a camera-stable macro wash it had and the
// audit was right to want back.
let terrainMacroVariation = mix(
  0.84,
  1.18,
  terrainSurfaceValue(terrainAbsolutePosition.xz * ${(1 / DETILE_MACRO_METERS).toFixed(9)}
    + vec2f(11.3, 5.9)),
) * mix(
  0.93,
  1.09,
  terrainSurfaceValue(terrainAbsolutePosition.xz * ${(1 / DETILE_PATCH_METERS).toFixed(9)}
    + vec2f(3.1, 27.5)),
);
let terrainSamplePosition = vec3f(
  terrainAbsolutePosition.x + terrainWarp.x,
  terrainAbsolutePosition.y,
  terrainAbsolutePosition.z + terrainWarp.y,
);

// The provisional splat (Class T until 4-6). The primary id is a CONTINUOUS
// coordinate on the SurfaceMaterial axis: interpolating it across a triangle
// and bracketing the two integers it lies between gives a smooth material
// gradient, where flat-interpolating an id would give hard triangle edges at
// 8 m and rounding it alone would give a hard edge at the midpoint. The axis
// is ordered so bracketed neighbours are materials that plausibly grade into
// one another; 4-6 replaces the whole scheme with real splat pages.
let terrainAxis = clamp(fragmentInputs.terrainSplat.x, 0.0, ${LAST_MATERIAL_INDEX}.0);
let terrainLowerId = floor(terrainAxis);
let terrainUpperId = min(terrainLowerId + 1.0, ${LAST_MATERIAL_INDEX}.0);
let terrainAxisFraction = terrainAxis - terrainLowerId;

// The third candidate is FRAGMENT-DERIVED ONLY.
//
// The splat's lanes y and z carry the biome's secondary cover and its weight,
// written per vertex and reserved for 4-6 — but this shader does not read
// them, because a secondary id cannot survive interpolation. Bracketing it
// would blend two materials that never meet (the secondaries of climatic
// neighbours are not adjacent on the ecotone axis, and cannot all be made so
// without implausible companions), and ROUNDING it paints every intermediate
// id at full weight: a grassland/forest boundary lays a band of snow and a
// band of rock along itself, because 6 sweeps to 3 through 5 and 4. A
// "confidence" gate fading the weight at half-integers does not help — the
// intermediate ids are hit AT the integers, where such a gate is wide open.
//
// So the third candidate is whichever of the fragment's own slope and the
// seasonal snow blanket is stronger. Both are evaluated HERE rather than per
// vertex, which is the one place this provisional path is strictly better than
// the classifier feeding it: a cliff gets rock at fragment resolution instead
// of at 8 m. 4-6's page splat restores real minority cover.
let terrainSlopeRock = smoothstep(0.30, 0.66, terrainSlope);

#ifdef TERRAIN_SURFACE_PAGE_CHANNELS
let terrainPageUv = terrainSurfacePageUv(
  fragmentInputs.terrainSplat.w,
  fragmentInputs.terrainPageLocal,
);
// textureSampleLevel, not textureSample: the house rule since 2-8 is that no
// sample under a branch or a wrap takes implicit derivatives, and the channel
// atlas carries no mip chain — level 0 is the only correct level, and mip
// selection across atlas slots would bleed neighbouring pages into each other.
let terrainOcclusionTexel = textureSampleLevel(
  terrainOcclusionAtlas, terrainOcclusionAtlasSampler, terrainPageUv.xy, 0.0);
// r is baked sky visibility; a fully unbaked page reads 0, so the fallback
// keeps it at 1 rather than plunging the ground into darkness.
let terrainSkyVisibility = mix(1.0, terrainOcclusionTexel.r, terrainPageUv.z);
let terrainHorizonShadow = terrainSurfaceHorizonShadow(
  terrainPageUv, uniforms.terrainSunDirection.xyz);
#else
let terrainSkyVisibility = 1.0;
let terrainHorizonShadow = 1.0;
#endif

// 3-10's SEASONAL snow blanket. Two properties, both learned the hard way from
// the first capture after this plugin landed:
//
//  - It is ZERO at the reference day. The land-cover classifier already puts
//    Snow above the reference snowline, so a fragment blanket at the same
//    altitude only double-counts; what the classifier cannot express is the
//    snowline DESCENDING through the winter, and that is all this term does.
//    Anchored the way R-13 anchors every seasonal term.
//  - Its driver is PERTURBED, not its output. An unperturbed elevation band is
//    an iso-contour, and iso-contours on a mountain are closed white rings —
//    which is exactly what the first capture showed. RENDERING_PLAN.md §3.2
//    states the rule for 4-6's classifier ("perturb the drivers, not the
//    outputs"); it applies just as much to one band.
let terrainSnowline = uniforms.terrainSurfaceTuning.w;
let terrainSnowDescent = max(0.0, uniforms.terrainSurfaceWetness.z - terrainSnowline);
var terrainSnowCover = 0.0;
if (terrainSnowDescent > 1.0) {
  let terrainSnowDriver = terrainAbsolutePosition.y
    + (terrainSurfaceValue(terrainAbsolutePosition.xz * (1.0 / 430.0)) - 0.5) * 78.0
    + (terrainSurfaceValue(terrainAbsolutePosition.xz * (1.0 / 95.0)) - 0.5) * 19.0;
  let terrainSnowBand = smoothstep(terrainSnowline - 120.0, terrainSnowline + 120.0,
    terrainSnowDriver);
  // Steep faces shed snow — the 2-18 slope-weighting rule, applied to the
  // ground the same way it is applied to canopy and rock.
  let terrainSnowShed = 1.0 - clamp((terrainSlope - 0.5) * 1.7, 0.0, 1.0);
  // Fade the blanket in with the descent itself, so the first cold week does
  // not switch a hillside white.
  terrainSnowCover = terrainSnowBand * terrainSnowShed
    * clamp(terrainSnowDescent / 90.0, 0.0, 1.0);
}
var terrainThirdId = ${SurfaceMaterial.Rock}.0;
var terrainThirdWeight = terrainSlopeRock;
if (terrainSnowCover > terrainThirdWeight) {
  terrainThirdId = ${SurfaceMaterial.Snow}.0;
  terrainThirdWeight = terrainSnowCover;
}

// 3-6: N-way height blend. k_i = h_i + w_i; b_i = max(k_i - (max k - d), 0),
// normalised. The transition depth d widens with the footprint so the blend
// does not alias at distance.
let terrainBlendDepth = mix(
  ${HEIGHT_BLEND_DEPTH_NEAR.toFixed(2)},
  ${HEIGHT_BLEND_DEPTH_FAR.toFixed(2)},
  clamp(terrainFootprint / 3.0, 0.0, 1.0),
);

#ifdef TERRAIN_SURFACE_THREE_MATERIALS
let terrainWeight0 = (1.0 - terrainAxisFraction) * (1.0 - terrainThirdWeight);
let terrainWeight1 = terrainAxisFraction * (1.0 - terrainThirdWeight);
// A candidate whose weight is negligible is SKIPPED, not sampled and
// multiplied by zero. Most of the ground sits well inside one biome with the
// axis fraction at an end and no slope or snow override, so the common
// fragment fetches one material rather than three — measured as the
// difference between 51.7 and 57+ fps on the cruise-horizon capture, where
// distant terrain fills the frame. Legal under non-uniform control flow
// precisely because every sample carries explicit gradients.
let terrainActive0 = terrainWeight0 > 0.004;
let terrainActive1 = terrainWeight1 > 0.004;
let terrainActive2 = terrainThirdWeight > 0.004;
var terrainLayer0: TerrainSurfaceLayer;
var terrainLayer1: TerrainSurfaceLayer;
var terrainLayer2: TerrainSurfaceLayer;
var terrainKey0 = -1.0e9;
var terrainKey1 = -1.0e9;
var terrainKey2 = -1.0e9;
if (terrainActive0) {
  terrainLayer0 = terrainSurfaceSample(
    i32(terrainLowerId), terrainSamplePosition, terrainGeometricNormal,
    terrainWorldDdx, terrainWorldDdy, terrainDetailWeight);
  terrainKey0 = terrainLayer0.height + terrainWeight0;
}
if (terrainActive1) {
  terrainLayer1 = terrainSurfaceSample(
    i32(terrainUpperId), terrainSamplePosition, terrainGeometricNormal,
    terrainWorldDdx, terrainWorldDdy, terrainDetailWeight);
  terrainKey1 = terrainLayer1.height + terrainWeight1;
}
if (terrainActive2) {
  terrainLayer2 = terrainSurfaceSample(
    i32(terrainThirdId + 0.5), terrainSamplePosition, terrainGeometricNormal,
    terrainWorldDdx, terrainWorldDdy, terrainDetailWeight);
  terrainKey2 = terrainLayer2.height + terrainThirdWeight;
}
let terrainKeyMax = max(terrainKey0, max(terrainKey1, terrainKey2)) - terrainBlendDepth;
// A skipped candidate's key is far below the threshold, so its blend weight is
// exactly zero and the partition of unity is unaffected. At least one is
// always active: the three weights sum to 1.
var terrainBlend0 = max(terrainKey0 - terrainKeyMax, 0.0);
var terrainBlend1 = max(terrainKey1 - terrainKeyMax, 0.0);
var terrainBlend2 = max(terrainKey2 - terrainKeyMax, 0.0);
let terrainBlendSum = max(terrainBlend0 + terrainBlend1 + terrainBlend2, 1e-5);
terrainBlend0 = terrainBlend0 / terrainBlendSum;
terrainBlend1 = terrainBlend1 / terrainBlendSum;
terrainBlend2 = terrainBlend2 / terrainBlendSum;
var terrainAlbedo = terrainLayer0.albedo * terrainBlend0
  + terrainLayer1.albedo * terrainBlend1
  + terrainLayer2.albedo * terrainBlend2;
var terrainNormal = terrainLayer0.normal * terrainBlend0
  + terrainLayer1.normal * terrainBlend1
  + terrainLayer2.normal * terrainBlend2;
var terrainRoughness = terrainLayer0.roughness * terrainBlend0
  + terrainLayer1.roughness * terrainBlend1
  + terrainLayer2.roughness * terrainBlend2;
var terrainCavity = terrainLayer0.cavity * terrainBlend0
  + terrainLayer1.cavity * terrainBlend1
  + terrainLayer2.cavity * terrainBlend2;
var terrainF0 = terrainLayer0.f0 * terrainBlend0
  + terrainLayer1.f0 * terrainBlend1
  + terrainLayer2.f0 * terrainBlend2;
var terrainDiffuseRoughness = terrainLayer0.diffuseRoughness * terrainBlend0
  + terrainLayer1.diffuseRoughness * terrainBlend1
  + terrainLayer2.diffuseRoughness * terrainBlend2;
#else
// Tier 0's cap is two materials (§5.3), so the axis is rounded to its nearest
// integer instead of bracketed and only the strongest override survives. This
// is the Low-tier path and it ships unchanged past 4-6.
let terrainPrimaryId = floor(terrainAxis + 0.5);
let terrainWeight0 = 1.0 - terrainThirdWeight;
var terrainLayer0: TerrainSurfaceLayer;
var terrainLayer2: TerrainSurfaceLayer;
var terrainKey0 = -1.0e9;
var terrainKey2 = -1.0e9;
if (terrainWeight0 > 0.004) {
  terrainLayer0 = terrainSurfaceSample(
    i32(terrainPrimaryId), terrainSamplePosition, terrainGeometricNormal,
    terrainWorldDdx, terrainWorldDdy, terrainDetailWeight);
  terrainKey0 = terrainLayer0.height + terrainWeight0;
}
if (terrainThirdWeight > 0.004) {
  terrainLayer2 = terrainSurfaceSample(
    i32(terrainThirdId + 0.5), terrainSamplePosition, terrainGeometricNormal,
    terrainWorldDdx, terrainWorldDdy, terrainDetailWeight);
  terrainKey2 = terrainLayer2.height + terrainThirdWeight;
}
let terrainKeyMax = max(terrainKey0, terrainKey2) - terrainBlendDepth;
var terrainBlend0 = max(terrainKey0 - terrainKeyMax, 0.0);
var terrainBlend2 = max(terrainKey2 - terrainKeyMax, 0.0);
let terrainBlendSum = max(terrainBlend0 + terrainBlend2, 1e-5);
terrainBlend0 = terrainBlend0 / terrainBlendSum;
terrainBlend2 = terrainBlend2 / terrainBlendSum;
var terrainAlbedo = terrainLayer0.albedo * terrainBlend0 + terrainLayer2.albedo * terrainBlend2;
var terrainNormal = terrainLayer0.normal * terrainBlend0 + terrainLayer2.normal * terrainBlend2;
var terrainRoughness = terrainLayer0.roughness * terrainBlend0
  + terrainLayer2.roughness * terrainBlend2;
var terrainCavity = terrainLayer0.cavity * terrainBlend0 + terrainLayer2.cavity * terrainBlend2;
var terrainF0 = terrainLayer0.f0 * terrainBlend0 + terrainLayer2.f0 * terrainBlend2;
var terrainDiffuseRoughness = terrainLayer0.diffuseRoughness * terrainBlend0
  + terrainLayer2.diffuseRoughness * terrainBlend2;
#endif

#ifdef TERRAIN_SURFACE_RUNWAY
// 3-9 paints asphalt, concrete and markings from the analytic airport SDF,
// over the top of whatever the splat says the ground is.
terrainRunwaySurface(
  terrainAbsolutePosition, terrainGeometricNormal,
  terrainWorldDdx, terrainWorldDdy, terrainDetailWeight,
  &terrainAlbedo, &terrainNormal, &terrainRoughness, &terrainCavity,
  &terrainF0, &terrainDiffuseRoughness,
);
#endif

// 3-4's macro wash goes on BEFORE the runway is painted: paint is a constant
// colour, and a kilometre-scale brightness ramp across a marking reads as a
// stain rather than as weather.
terrainAlbedo *= terrainMacroVariation;

// 3-7's wetness response. The driven field is a constant zero until 6-5
// supplies it from the water side — two instructions today against threading a
// new input through a finished shader later — but SUBMERGED ground is the one
// case that is unambiguous now, and it has to be handled here or the seabed
// shows through the water as dry land.
//
// It showed through, in fact: the first capture after this plugin landed
// turned every lake grey, because the WATER biome's primary is sand (it has to
// be — beach is its only neighbour on the ecotone axis) and dry sand is the
// brightest material in the table at 0.42. Wet it, then silt it, and the
// composite lands near the 0.08 the old water palette used.
let terrainSeaLevel = uniforms.terrainSurfaceWetness.y;
let terrainSubmerged = clamp((terrainSeaLevel - terrainAbsolutePosition.y) * 0.5 + 0.5, 0.0, 1.0);
let terrainWetness = max(clamp(uniforms.terrainSurfaceWetness.x, 0.0, 1.0), terrainSubmerged);
terrainRoughness = mix(terrainRoughness, terrainRoughness * 0.35 + 0.02, terrainWetness);
terrainAlbedo *= mix(1.0, 0.62, terrainWetness);
// Silt, biofilm and the water column's own absorption on top of the wetting:
// a lake bed is not a beach, and red goes first.
terrainAlbedo = mix(terrainAlbedo, terrainAlbedo * vec3f(0.26, 0.40, 0.44), terrainSubmerged);

surfaceAlbedo = terrainAlbedo;
normalW = normalize(terrainNormal);
// Consumed by the regex injections below, which land after this hook: AO at
// the ambientOcclusionBlock call and roughness/F0 at their declarations.
var terrainSurfaceRoughness = clamp(terrainRoughness, 0.02, 1.0);
var terrainSurfaceCavity = clamp(terrainCavity, 0.0, 1.0);
var terrainSurfaceF0 = clamp(terrainF0, 0.0, 1.0);
var terrainSurfaceDiffuseRoughness = clamp(terrainDiffuseRoughness, 0.0, 1.0);
`;

/**
 * The regex injection anchors (`C3`, §3.2).
 *
 * Roughness and AO cannot be set from any standard hook —
 * `CUSTOM_FRAGMENT_BEFORE_LIGHTS` is emitted at `pbr.fragment.js:164`, one
 * line BEFORE `aoOut` is even declared — so the `!regex` form is not a
 * preference. The matched text is recorded verbatim in the decision log
 * because it is minified, unversioned, shipped WGSL and it WILL change on a
 * Babylon bump.
 *
 * The plan's AO anchor at `:245` is corrected here: that line sits inside
 * `#if defined(METALLICWORKFLOW) && defined(REFLECTIVITY) &&
 * defined(AOSTOREINMETALMAPRED)` and the terrain material binds no
 * reflectivity texture, so it never enters the compiled shader — and a
 * `!regex` that matches nothing is SILENT, which would have left AO looking
 * wired and never applying. The reachable anchor is the unguarded
 * `ambientOcclusionBlock` call.
 *
 * Only `$1`-style numeric back-references are supported
 * (`materialPluginManager.pure.js` `ReplaceRegExpSubstitutions`), so every
 * anchor captures itself and the injected code re-emits it.
 */
export const TERRAIN_SURFACE_INJECTION_ANCHORS = Object.freeze({
  ambientOcclusion: String.raw`!(aoOut=ambientOcclusionBlock\([\s\S]*?\);)`,
  roughness: String.raw`!(var roughness: f32=reflectivityOut\.roughness;var diffuseRoughness: f32=reflectivityOut\.diffuseRoughness;)`,
  reflectance: String.raw`!(var specularEnvironmentR0: vec3f=reflectivityOut\.colorReflectanceF0;)`,
});

/** The tokens assertion 57 looks for in the PROCESSED effect source. */
export const TERRAIN_SURFACE_INJECTION_TOKENS = Object.freeze([
  "aoOut.ambientOcclusionColor *= vec3f(terrainSurfaceCavity * terrainSkyVisibility);",
  "roughness = terrainSurfaceRoughness;",
  "diffuseRoughness = terrainSurfaceDiffuseRoughness;",
  "specularEnvironmentR0 = vec3f(terrainSurfaceF0);",
]);

const FRAGMENT_WGSL = Object.freeze({
  // 3-9's painter consumes terrainSurfaceSample and the helpers above, so it
  // is appended rather than emitted at its own injection point. The whole
  // block is compiled out when the world has no airport.
  CUSTOM_FRAGMENT_DEFINITIONS: `${FRAGMENT_DEFINITIONS}
#ifdef TERRAIN_SURFACE_RUNWAY
${RUNWAY_SURFACE_WGSL}
#endif
`,
  CUSTOM_FRAGMENT_BEFORE_LIGHTS: FRAGMENT_BEFORE_LIGHTS,
  // 4-7: the horizon map shadows DIRECT light only, at the same hook the
  // cloud-shadow receiver uses (priority 210). Babylon concatenates same-hook
  // code across plugins in priority order, so both multiply and neither
  // overwrites — which is exactly why every identifier here carries the
  // `terrain`/`terrainSurface` prefix the §5.6 convention requires.
  //
  // This is Gate 4B's payoff: a 3,000 m ridge shadows the valley behind it at
  // 40 km, where the cascaded shadow map has never reached.
  CUSTOM_FRAGMENT_BEFORE_FINALCOLORCOMPOSITION: /* wgsl */ `
#ifndef UNLIT
finalDiffuse *= terrainHorizonShadow;
#ifdef SPECULARTERM
finalSpecularScaled *= terrainHorizonShadow;
#endif
#endif
`,
  [TERRAIN_SURFACE_INJECTION_ANCHORS.ambientOcclusion]: /* wgsl */ `$1
// 4-7: the baked sky visibility rides the same anchor as 3-1's cavity map.
// Both are ambient-only occlusion, and the ONE thing that must not happen is
// applying either to direct sunlight — that is the horizon map's job below,
// and doubling them would darken slopes twice for the same reason.
aoOut.ambientOcclusionColor *= vec3f(terrainSurfaceCavity * terrainSkyVisibility);
`,
  [TERRAIN_SURFACE_INJECTION_ANCHORS.roughness]: /* wgsl */ `$1
roughness = terrainSurfaceRoughness;
diffuseRoughness = terrainSurfaceDiffuseRoughness;
`,
  [TERRAIN_SURFACE_INJECTION_ANCHORS.reflectance]: /* wgsl */ `$1
specularEnvironmentR0 = vec3f(terrainSurfaceF0);
reflectanceF0 = terrainSurfaceF0;
`,
});

/**
 * The one owner of terrain surface appearance.
 *
 * Priority 180 — the slot `TerrainMaterialPlugin` held, which keeps this
 * plugin's writes to `surfaceAlbedo`/`normalW` ahead of the cloud-shadow
 * receiver (210) and the aerial-perspective receiver (205), both of which
 * operate on the final colour. `R-3F`: every function this file defines
 * carries a `terrainSurface` prefix, so a collision with another plugin's
 * `CUSTOM_FRAGMENT_DEFINITIONS` is a compile error rather than a shadowed
 * function.
 */
export class TerrainSurfacePlugin extends MaterialPluginBase {
  private originX = 0;
  private originZ = 0;
  private albedoHeightArray: BaseTexture | null = null;
  private normalMaterialArray: BaseTexture | null = null;
  private triplanarMode: TerrainTriplanarMode = "biplanar";
  private heightBlendMaxMaterials = 3;
  private runwayEnabled = false;
  private runwayFrame: readonly [number, number, number, number] = [0, 0, 0, 1];
  private runwayShape: readonly [number, number, number, number] = [0, 0, 0, 0];
  private detileWarp = DEFAULT_DETILE_WARP;
  private wetness = 0;
  private snowlineMeters = TERRAIN_REFERENCE_SNOWLINE_OFFSET_METERS;
  private referenceSnowlineMeters = TERRAIN_REFERENCE_SNOWLINE_OFFSET_METERS;
  private seaLevelMeters = 0;
  private readonly tiling = new Float32Array(SURFACE_MATERIAL_COUNT * 4);
  private readonly season = new Float32Array(SURFACE_MATERIAL_COUNT * 4);
  private placeholderArray: RawTexture2DArray | null = null;
  private occlusionAtlas: BaseTexture | null = null;
  private horizonAtlasA: BaseTexture | null = null;
  private horizonAtlasB: BaseTexture | null = null;
  private pageAtlasShape: readonly [number, number, number, number] = [1, 1, 1, 0];
  private pageAtlasGrid: readonly [number, number, number, number] = [1, 512, 1, 0.02];
  private sunDirection: readonly [number, number, number] = [0, 1, 0];
  private heightAtlasTexture: BaseTexture | null = null;
  private heightAtlasShape: readonly [number, number, number, number] = [1, 1, 0, 1];
  private cdlodEnabled = false;

  constructor(material: PBRMaterial) {
    super(
      material,
      "terrain-surface",
      180,
      {
        TERRAIN_SURFACE_TRIPLANAR: false,
        TERRAIN_SURFACE_PLANAR_ONLY: false,
        TERRAIN_SURFACE_THREE_MATERIALS: false,
        TERRAIN_SURFACE_RUNWAY: false,
        TERRAIN_SURFACE_PAGE_CHANNELS: false,
        TERRAIN_SURFACE_CDLOD: false,
      },
      true,
      // enable = false at construction, as CloudShadowMaterialPlugin does, so
      // a shader is never compiled with unbound array samplers. setArrays()
      // turns it on once the textures exist.
      false,
    );
    this.doNotSerialize = true;
    // Must precede any _enable call, or hardBindForSubMesh never registers
    // and the first terrain draw dies in createBindGroup.
    this.registerForExtraEvents = true;
    // The BRDF rows never change at runtime: 3-0 fixes them.
    SURFACE_MATERIALS.forEach((spec, index) => {
      this.tiling[index * 4] = 1 / spec.tilingPeriodMeters;
      this.tiling[index * 4 + 1] = spec.triplanar ? 1 : 0;
      this.tiling[index * 4 + 2] = spec.f0;
      this.tiling[index * 4 + 3] = spec.diffuseRoughness;
      this.season[index * 4] = 1;
      this.season[index * 4 + 1] = 1;
      this.season[index * 4 + 2] = 1;
      this.season[index * 4 + 3] = 0;
    });
  }

  override getClassName(): string {
    return "TerrainSurfacePlugin";
  }

  override isCompatible(): boolean {
    return true;
  }

  setWorldOrigin(x: number, z: number): void {
    this.originX = Number.isFinite(x) ? x : 0;
    this.originZ = Number.isFinite(z) ? z : 0;
  }

  /** `3-1`'s two arrays. Enabling here is what keeps the samplers bound. */
  setArrays(albedoHeight: BaseTexture, normalMaterial: BaseTexture): void {
    this.albedoHeightArray = albedoHeight;
    this.normalMaterialArray = normalMaterial;
    this._enable(true);
    this.markAllDefinesAsDirty();
  }

  /**
   * 1x1 stand-ins for the material arrays, so the plugin can be enabled for
   * its GEOMETRY before its appearance exists.
   *
   * `3-1` builds the real arrays one material per frame from the frame loop —
   * about ten frames — and before `4-4` that only cost ten frames of untextured
   * ground. It now also gates vertex displacement, and ten frames of FLAT
   * ground is a different thing entirely: the aircraft would spawn inside a
   * plane. Binding a placeholder is the same trick `CloudShadowMaterialPlugin`
   * uses for its projection texture, for the same reason: an enabled plugin
   * with an unbound sampler dies in `createBindGroup`.
   */
  private fallbackArray(scene: Scene): BaseTexture {
    if (!this.placeholderArray) {
      const texels = new Uint8Array(SURFACE_MATERIAL_COUNT * 4);
      texels.fill(128);
      this.placeholderArray = new RawTexture2DArray(
        texels,
        1,
        1,
        SURFACE_MATERIAL_COUNT,
        Constants.TEXTUREFORMAT_RGBA,
        scene,
        false,
        false,
        Texture.NEAREST_SAMPLINGMODE,
        Constants.TEXTURETYPE_UNSIGNED_BYTE,
      );
      this.placeholderArray.name = "terrain-surface-placeholder";
    }
    return this.placeholderArray;
  }

  get hasArrays(): boolean {
    return this.albedoHeightArray !== null && this.normalMaterialArray !== null;
  }

  /** §5.3's two shader-shaping rows. A datum read, never a tier branch. */
  setSamplingProfile(mode: TerrainTriplanarMode, heightBlendMaxMaterials: number): void {
    const capped = Math.max(2, Math.min(4, Math.round(heightBlendMaxMaterials)));
    if (mode === this.triplanarMode && capped === this.heightBlendMaxMaterials) return;
    this.triplanarMode = mode;
    this.heightBlendMaxMaterials = capped;
    this.markAllDefinesAsDirty();
  }

  /**
   * `3-9`: switch on the airport SDF layers. Passing null compiles them out
   * entirely, so a world without an airport pays nothing.
   */
  setRunway(airport: Readonly<AirportDefinition> | null): void {
    const enabled = airport !== null;
    if (airport) {
      const binding = resolveRunwaySurfaceBinding(airport);
      this.runwayFrame = binding.frame;
      this.runwayShape = binding.shape;
    }
    if (enabled === this.runwayEnabled) return;
    this.runwayEnabled = enabled;
    this.markAllDefinesAsDirty();
  }

  /** The phase's first tuning knob (`3-4`). */
  setDetileWarp(amount: number): void {
    this.detileWarp = Number.isFinite(amount) ? Math.max(0, amount) : DEFAULT_DETILE_WARP;
  }

  /** `3-7`'s wetness input; `6-5` supplies the field. */
  setWetness(value: number): void {
    this.wetness = Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;
  }

  /**
   * `3-10`. Anchored at the reference day, so the default clock leaves every
   * tint at exactly 1 and the tuned world unchanged.
   */
  setSeason(dayOfYear: number, latitudeDegrees: number, seaLevelMeters: number): void {
    const day = Number.isFinite(dayOfYear) ? dayOfYear : TERRAIN_REFERENCE_DAY_OF_YEAR;
    const latitude = Number.isFinite(latitudeDegrees) ? latitudeDegrees : 45;
    for (const spec of SURFACE_MATERIALS) {
      const response = surfaceSeasonalResponse(spec, day, latitude);
      this.season[spec.id * 4] = response.tint[0];
      this.season[spec.id * 4 + 1] = response.tint[1];
      this.season[spec.id * 4 + 2] = response.tint[2];
      this.season[spec.id * 4 + 3] = response.roughnessDelta;
    }
    this.seaLevelMeters = Number.isFinite(seaLevelMeters) ? seaLevelMeters : 0;
    this.snowlineMeters = seasonalSnowlineMeters(seaLevelMeters, day, latitude);
    this.referenceSnowlineMeters = seasonalSnowlineMeters(
      seaLevelMeters,
      TERRAIN_REFERENCE_DAY_OF_YEAR,
      latitude,
    );
  }

  /**
   * `4-7`: bind the channel pages and describe the atlas geometry.
   *
   * `gridEdge` and `slotEdge` come from the atlas, not from a constant here:
   * the slot budget is a profile datum, so a tier change reshapes the atlas
   * and the shader's addressing has to follow it in the same frame.
   */
  setChannelAtlas(
    occlusion: BaseTexture | null,
    horizonA: BaseTexture | null,
    horizonB: BaseTexture | null,
    shape: {
      readonly atlasEdge: number;
      readonly slotEdge: number;
      readonly core: number;
      readonly gutter: number;
      readonly gridEdge: number;
      readonly basePageExtentMeters: number;
    },
  ): void {
    const enabled = occlusion !== null && horizonA !== null && horizonB !== null;
    this.occlusionAtlas = occlusion;
    this.horizonAtlasA = horizonA;
    this.horizonAtlasB = horizonB;
    this.pageAtlasShape = [shape.atlasEdge, shape.slotEdge, shape.core, shape.gutter];
    this.pageAtlasGrid = [
      shape.gridEdge,
      shape.basePageExtentMeters,
      1,
      this.pageAtlasGrid[3],
    ];
    if (enabled === (this.occlusionAtlas !== null && this.horizonAtlasA !== null)) {
      this.markAllDefinesAsDirty();
    }
  }

  /**
   * `4-4`/`4-5`: bind the height atlas and switch the vertex path to the CDLOD
   * node record.
   *
   * Passing null restores the CPU tile path, which is what the Node suite and
   * NullEngine run — the whole displacement path compiles out rather than
   * binding an unbound sampler.
   */
  setHeightAtlas(
    texture: BaseTexture | null,
    shape: {
      readonly atlasEdge: number;
      readonly slotEdge: number;
      readonly gutter: number;
      readonly gridEdge: number;
    },
  ): void {
    const enabled = texture !== null;
    this.heightAtlasTexture = texture;
    this.heightAtlasShape = [shape.atlasEdge, shape.slotEdge, shape.gutter, shape.gridEdge];
    if (enabled === this.cdlodEnabled) return;
    this.cdlodEnabled = enabled;
    // The plugin has to be ON for the vertex path, whether or not `3-1`'s
    // arrays have finished building.
    if (enabled) this._enable(true);
    this.markAllDefinesAsDirty();
  }

  get isCdlod(): boolean {
    return this.cdlodEnabled;
  }

  /**
   * The direction TOWARD the sun, in world space (Babylon's directional light
   * points the other way). Only the horizon shadow reads it.
   */
  setSunDirection(x: number, y: number, z: number): void {
    const length = Math.hypot(x, y, z);
    this.sunDirection = length > 1e-6 ? [x / length, y / length, z / length] : [0, 1, 0];
  }

  override prepareDefines(defines: MaterialDefines): void {
    defines["TERRAIN_SURFACE_TRIPLANAR"] = this.triplanarMode === "triplanar";
    defines["TERRAIN_SURFACE_PLANAR_ONLY"] = this.triplanarMode === "planar";
    // Phase 3's provisional splat offers at most three candidates; 4-6's page
    // splat spends the rest of the tier's cap.
    defines["TERRAIN_SURFACE_THREE_MATERIALS"] = this.heightBlendMaxMaterials >= 3;
    defines["TERRAIN_SURFACE_RUNWAY"] = this.runwayEnabled;
    defines["TERRAIN_SURFACE_CDLOD"] = this.cdlodEnabled;
    defines["TERRAIN_SURFACE_PAGE_CHANNELS"] =
      this.occlusionAtlas !== null && this.horizonAtlasA !== null && this.horizonAtlasB !== null;
  }

  override getSamplers(samplers: string[]): void {
    for (const name of [
      "terrainSurfaceAlbedo",
      "terrainSurfaceNormal",
      "terrainOcclusionAtlas",
      "terrainHorizonAtlasA",
      "terrainHorizonAtlasB",
      "terrainHeightAtlas",
    ]) {
      if (!samplers.includes(name)) samplers.push(name);
    }
  }

  override getAttributes(attributes: string[]): void {
    if (this.cdlodEnabled) {
      // 4-5: the node record replaces the per-vertex splat lane. Declaring
      // `color` here as well would ask Babylon for a buffer the one shared
      // grid does not have.
      for (const name of ["terrainNodeA", "terrainNodeB"]) {
        if (!attributes.includes(name)) attributes.push(name);
      }
      return;
    }
    // The splat lane. useVertexColors is false on the terrain meshes, so
    // Babylon never defines VERTEXCOLOR and this attribute is the plugin's.
    if (!attributes.includes("color")) attributes.push("color");
  }

  override hardBindForSubMesh(uniformBuffer: UniformBuffer): void {
    const scene = this._material.getScene();
    uniformBuffer.setTexture(
      "terrainSurfaceAlbedo",
      this.albedoHeightArray ?? this.fallbackArray(scene),
    );
    uniformBuffer.setTexture(
      "terrainSurfaceNormal",
      this.normalMaterialArray ?? this.fallbackArray(scene),
    );
    if (this.occlusionAtlas) {
      uniformBuffer.setTexture("terrainOcclusionAtlas", this.occlusionAtlas);
    }
    if (this.horizonAtlasA) {
      uniformBuffer.setTexture("terrainHorizonAtlasA", this.horizonAtlasA);
    }
    if (this.horizonAtlasB) {
      uniformBuffer.setTexture("terrainHorizonAtlasB", this.horizonAtlasB);
    }
    if (this.heightAtlasTexture) {
      // r32float: Babylon flips the binding to `unfilterable-float` and its
      // sampler to `non-filtering` automatically, because
      // `textureFloatLinearFiltering` is false — which is why the shader may
      // only ever `textureLoad` it.
      uniformBuffer.setTexture("terrainHeightAtlas", this.heightAtlasTexture);
    }
  }

  override getUniforms(): {
    ubo: Array<{ name: string; size: number; type: string; arraySize?: number }>;
  } {
    return {
      ubo: [
        { name: "terrainWorldOrigin", size: 2, type: "vec2" },
        { name: "terrainSurfaceTuning", size: 4, type: "vec4" },
        { name: "terrainSurfaceWetness", size: 4, type: "vec4" },
        // 4-7: (atlasEdge, slotEdge, core, gutter) and
        // (gridEdge, basePageExtent, occlusionStrength, horizonSoftness).
        { name: "terrainPageAtlas", size: 4, type: "vec4" },
        { name: "terrainPageAtlasGrid", size: 4, type: "vec4" },
        { name: "terrainSunDirection", size: 4, type: "vec4" },
        // 4-4: (atlasEdge, slotEdge, gutter, gridEdge) for the height atlas.
        { name: "terrainHeightAtlasShape", size: 4, type: "vec4" },
        {
          name: "terrainMaterialTiling",
          size: 4,
          type: "vec4",
          arraySize: SURFACE_MATERIAL_COUNT,
        },
        {
          name: "terrainMaterialSeason",
          size: 4,
          type: "vec4",
          arraySize: SURFACE_MATERIAL_COUNT,
        },
        // 3-9's airport frame and shape. Declared unconditionally: Babylon
        // collects the UBO layout once, and a define-dependent layout would
        // change the buffer's size behind the bind group.
        ...RUNWAY_SURFACE_UNIFORMS.map((entry) => ({ ...entry })),
      ],
    };
  }

  override bindForSubMesh(uniformBuffer: UniformBuffer): void {
    uniformBuffer.updateFloat2("terrainWorldOrigin", this.originX, this.originZ);
    uniformBuffer.updateFloat4(
      "terrainSurfaceTuning",
      this.detileWarp,
      HEIGHT_BLEND_DEPTH_NEAR,
      HEIGHT_BLEND_DEPTH_FAR,
      this.snowlineMeters,
    );
    uniformBuffer.updateFloat4(
      "terrainSurfaceWetness",
      this.wetness,
      // y: sea level, so the submerged half of the wetness response can exist
      // before 6-5 supplies the driven field.
      this.seaLevelMeters,
      // z: the REFERENCE snowline, so the shader can tell how far the current
      // one has descended and contribute nothing at the reference day.
      this.referenceSnowlineMeters,
      0,
    );
    uniformBuffer.updateFloatArray("terrainMaterialTiling", this.tiling);
    uniformBuffer.updateFloatArray("terrainMaterialSeason", this.season);
    uniformBuffer.updateFloat4("terrainPageAtlas", ...this.pageAtlasShape);
    uniformBuffer.updateFloat4("terrainPageAtlasGrid", ...this.pageAtlasGrid);
    uniformBuffer.updateFloat4("terrainSunDirection", ...this.sunDirection, 1);
    uniformBuffer.updateFloat4("terrainHeightAtlasShape", ...this.heightAtlasShape);
    uniformBuffer.updateFloat4("terrainRunwayFrame", ...this.runwayFrame);
    uniformBuffer.updateFloat4("terrainRunwayShape", ...this.runwayShape);
  }

  override getCustomCode(
    shaderType: string,
    shaderLanguage = ShaderLanguage.GLSL,
  ): { [pointName: string]: string } | null {
    // WebGPU-only by design; the renderer never compiles GLSL.
    if (shaderLanguage !== ShaderLanguage.WGSL) return null;
    if (shaderType === "vertex") return { ...TERRAIN_SURFACE_VERTEX_WGSL };
    if (shaderType === "fragment") return { ...FRAGMENT_WGSL };
    return null;
  }
}
