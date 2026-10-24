import { Buffer } from "@babylonjs/core/Buffers/buffer";
import { Constants } from "@babylonjs/core/Engines/constants";
import { ShaderStore } from "@babylonjs/core/Engines/shaderStore";
import { Material } from "@babylonjs/core/Materials/material";
import { ShaderLanguage } from "@babylonjs/core/Materials/shaderLanguage";
import { ShaderMaterial } from "@babylonjs/core/Materials/shaderMaterial";
import type { BaseTexture } from "@babylonjs/core/Materials/Textures/baseTexture";
import { RawTexture } from "@babylonjs/core/Materials/Textures/rawTexture";
import { Texture } from "@babylonjs/core/Materials/Textures/texture";
import { Vector2, Vector3, Vector4 } from "@babylonjs/core/Maths/math.vector";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { VertexData } from "@babylonjs/core/Meshes/mesh.vertexData";
import type { Scene } from "@babylonjs/core/scene";
import {
  AERIAL_PERSPECTIVE_UNIFORMS,
  AERIAL_PERSPECTIVE_WGSL,
  applyAerialPerspectiveToShaderMaterial,
  type AerialPerspectiveBinding,
} from "@/src/render/webgpu/atmosphere/AerialPerspective";
import {
  keepOpaqueDepthForRenderingGroup,
  WATER_RENDERING_GROUP_ID,
} from "@/src/render/webgpu/core/RenderingGroups";
import { DEFAULT_VOLUMETRIC_CLOUD_CONFIG } from "@/src/render/webgpu/nature/CloudConfig";
import { hashLatticeCoordinates, mixSeed, unitFloatFromHash } from "@/src/world/seed";
import type { WorldDefinition } from "@/src/world/types";
import { volcanicVentsInBounds, type VolcanicVent } from "@/src/world/volcanism";

/**
 * Volcanic phase 5: steam wisps over vents, crater floors and steaming ground.
 *
 * ONE INSTANCED DRAW of camera-facing sprites, and none at all when no vent is
 * near. The temperate core has no vents, so there the mesh is DISABLED rather
 * than drawing zero instances: a disabled mesh is never submitted, so the core
 * baselines gain no draw call.
 *
 * WHERE THE WORK IS. Every wisp is a closed-form function of its own record
 * and the simulation clock, evaluated in the vertex shader: rise, downwind
 * drift, crosswind wobble, growth and fade. The CPU writes the records once
 * per vent re-query (a 2 km camera cell change) and the per-frame update is a
 * cell check, a range check over at most `STEAM_MAX_VENTS` vents and a clock
 * write — no instance traffic and no allocation.
 *
 * LIGHTING IS THE CLOUDS' MODEL, NOT A NEW ONE. Steam is the same participating
 * medium as cloud, so a wisp is lit by `cloudLighting`'s terms with its
 * constants read from `DEFAULT_VOLUMETRIC_CLOUD_CONFIG`: the two-lobe
 * Henyey-Greenstein phase, three multiple-scattering octaves (energy a^n,
 * phase g * 0.5^n) and the sky ambient at `ambientStrength`. The sun and sky
 * come from the shared aerial include (`aerialSunRadiance` through
 * `aerialSunTransmittanceAt`, and `skyRadiance`), which is what the cloud LUTs
 * are baked from, and the wisp is hazed by `aerialPerspective` exactly as the
 * cloud composite hazes its march. What is left out is the light march (a
 * wisp is optically thin, so its sun transmittance is 1) and with it the
 * powder term, which is a function of the marched density.
 *
 * SOFT EDGES, TWICE. Against terrain the fragment fades with the gap to the
 * scene depth the atmosphere already renders for the cloud march
 * (`AtmosphereGpuResources.sceneDepth`, camera-space Z, 0 = sky). That map
 * holds terrain only, so over water the wisp also fades with its own height
 * above its vent's base, which sits at `max(ground, sea level)`.
 *
 * DRAW ORDER. Group 1 (water) at alphaIndex 2: after the opaque world and the
 * cloud composite (group 0, which would otherwise cover steam in sky pixels),
 * and after the ocean (0) and inland water (1), which would otherwise paint
 * over steam rising from a crater lake. Depth is tested against the opaque
 * world through `keepOpaqueDepthForRenderingGroup`, and never written.
 */

/** A vent steams when its centre is within this horizontal reach of the camera, plus its radius. */
export const STEAM_VENT_RANGE_METERS = 15_000;
/** Wisps fade out between this horizontal distance and `STEAM_VENT_RANGE_METERS`. */
export const STEAM_RANGE_FADE_START_METERS = 13_500;
/** The vent query re-runs only when the camera crosses a cell of this edge. */
export const STEAM_QUERY_CELL_METERS = 2_000;
/**
 * Extra reach on the query box for vents whose centre lies just outside the
 * range but whose radius reaches into it (`volcanicVentsInBounds` selects by
 * centre).
 */
export const STEAM_VENT_RADIUS_MARGIN_METERS = 1_000;
/** Instance capacity. At least every tier's `volcanicSteamMaxWisps` (pinned by test). */
export const STEAM_INSTANCE_CAPACITY = 256;
/** Vents kept per query, nearest first. */
export const STEAM_MAX_VENTS = 48;
/** The most wisps one vent emits, at strength 1 and a radius of 150 m or more. */
export const STEAM_MAX_WISPS_PER_VENT = 24;
/**
 * Ground-height samples per frame while a re-query is being built. A terrain
 * sample is tens of microseconds, so this keeps a rebuild well inside the
 * 2 ms main-thread rule; the old wisps stay live until the new set is complete.
 */
export const STEAM_HEIGHT_SAMPLES_PER_FRAME = 8;
/** Floats per wisp record: three vec4 attributes. */
export const STEAM_FLOATS_PER_WISP = 12;
/**
 * The animation clock wraps at this period. Every wisp's cycle count over it is
 * an integer, so the wrap is seamless, and the clock stays small enough for
 * f32 in the shader however long the flight.
 */
export const STEAM_CYCLE_PERIOD_SECONDS = 960;
/** Volcanism's seed channels are 240-259; steam takes the last, mixed with each vent's own seed. */
export const STEAM_SEED_CHANNEL = 259;

const STEAM_SHADER_NAME = "volcanicSteam";
const STEAM_QUERY_REACH_METERS = STEAM_VENT_RANGE_METERS
  + STEAM_QUERY_CELL_METERS * Math.SQRT1_2
  + STEAM_VENT_RADIUS_MARGIN_METERS;
/** Below this the vertex collapses the sprite, so an invisible wisp rasterises nothing. */
const STEAM_MIN_VISIBLE_ALPHA = 0.002;

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

/** Vent strength as the effect reads it: non-finite or negative is no steam. */
function ventStrength(vent: VolcanicVent): number {
  return Number.isFinite(vent.strength) ? clamp01(vent.strength) : 0;
}

/**
 * Wisps a vent emits. Strength scales the count linearly and a larger steaming
 * area adds wisps up to `STEAM_MAX_WISPS_PER_VENT`; strength 0 emits nothing.
 */
export function steamWispCount(vent: VolcanicVent): number {
  const strength = ventStrength(vent);
  if (strength <= 0) return 0;
  const area = Math.min(1, Math.max(0, vent.radiusMeters) / 150);
  return Math.max(1, Math.round(strength * (6 + 18 * area)));
}

/** The wind's flow direction (towards), north = +Z, east = +X, as `src/world/wind.ts` resolves it. */
export function steamWindFlow(world: Pick<WorldDefinition, "prevailingWindRadians">): {
  x: number;
  z: number;
} {
  return {
    x: Math.sin(world.prevailingWindRadians),
    z: Math.cos(world.prevailingWindRadians),
  };
}

/** One uniform draw in [0, 1) per (vent stream, wisp, lane). */
function wispUnit(stream: number, wisp: number, lane: number): number {
  return unitFloatFromHash(hashLatticeCoordinates(stream, wisp, lane));
}

/**
 * Write `count` wisp records for one vent into `out` at float `offset`.
 *
 * The record (three vec4 attributes, `STEAM_FLOATS_PER_WISP` floats):
 *   A: base x, base y (absolute), base z, size m — x and z relative to the anchor
 *   B: cycles per period (integer), phase, opacity, rise m
 *   C: noise seed, spin rad, wobble m, drift scale
 *
 * Every value is a function of the vent and the wisp's index only, so a vent
 * looks the same whatever else is in range, and its first N wisps are the same
 * wisps whatever N the instance cap leaves it. Wind speed shortens the rise:
 * a stronger wind bends the plume over instead of letting it climb.
 */
export function writeSteamWisps(
  vent: VolcanicVent,
  groundY: number,
  anchorX: number,
  anchorZ: number,
  windSpeed: number,
  count: number,
  out: Float32Array,
  offset: number,
): void {
  const strength = ventStrength(vent);
  const radius = Math.max(1, Number.isFinite(vent.radiusMeters) ? vent.radiusMeters : 1);
  const area = Math.min(1, radius / 150);
  const baseSize = Math.min(60, Math.max(5, radius * 0.45)) * (0.55 + 0.45 * strength);
  const baseLifetime = 12 + 10 * strength;
  const baseOpacity = 0.18 + 0.32 * strength;
  const baseRise = (40 + 320 * strength) * (0.6 + 0.4 * area)
    / (1 + Math.max(0, windSpeed) / 14);
  const stream = mixSeed(vent.seed >>> 0, STEAM_SEED_CHANNEL);
  for (let wisp = 0; wisp < count; wisp += 1) {
    // Uniform over a disc of 0.75 r: steam rises from the whole floor.
    const reach = 0.75 * radius * Math.sqrt(wispUnit(stream, wisp, 0));
    const bearing = 2 * Math.PI * wispUnit(stream, wisp, 1);
    const size = baseSize * (0.7 + 0.6 * wispUnit(stream, wisp, 2));
    const lifetime = baseLifetime * (0.75 + 0.5 * wispUnit(stream, wisp, 3));
    const cycles = Math.max(1, Math.round(STEAM_CYCLE_PERIOD_SECONDS / lifetime));
    const at = offset + wisp * STEAM_FLOATS_PER_WISP;
    out[at] = vent.x + reach * Math.sin(bearing) - anchorX;
    out[at + 1] = groundY;
    out[at + 2] = vent.z + reach * Math.cos(bearing) - anchorZ;
    out[at + 3] = size;
    out[at + 4] = cycles;
    out[at + 5] = wispUnit(stream, wisp, 4);
    out[at + 6] = Math.min(0.9, baseOpacity * (0.75 + 0.5 * wispUnit(stream, wisp, 5)));
    out[at + 7] = baseRise * (0.8 + 0.4 * wispUnit(stream, wisp, 6));
    out[at + 8] = wispUnit(stream, wisp, 7);
    out[at + 9] = (wispUnit(stream, wisp, 8) - 0.5) * 3;
    out[at + 10] = size * (0.3 + 0.5 * wispUnit(stream, wisp, 9));
    out[at + 11] = 0.8 + 0.4 * wispUnit(stream, wisp, 10);
  }
}

/** A wisp's state at one clock reading, from the CPU twin of the vertex law. */
export interface SteamWispSample {
  /** Centre relative to the anchor; y absolute. */
  x: number;
  y: number;
  z: number;
  age: number;
  sizeMeters: number;
  /** Opacity before the range and near-camera fades. */
  alpha: number;
}

export function createSteamWispSample(): SteamWispSample {
  return { x: 0, y: 0, z: 0, age: 0, sizeMeters: 0, alpha: 0 };
}

function smoothstep(edge0: number, edge1: number, value: number): number {
  const t = clamp01((value - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
}

/**
 * The vertex shader's position and fade law, line for line, for tests and
 * reasoning. The WGSL below is the authority; this mirrors its expression.
 */
export function sampleSteamWisp(
  records: Float32Array,
  wisp: number,
  clockSeconds: number,
  flowX: number,
  flowZ: number,
  windSpeed: number,
  out: SteamWispSample,
): SteamWispSample {
  const at = wisp * STEAM_FLOATS_PER_WISP;
  const cycles = Math.max(records[at + 4]!, 1);
  const raw = (steamClock(clockSeconds) * cycles) / STEAM_CYCLE_PERIOD_SECONDS + records[at + 5]!;
  const age = raw - Math.floor(raw);
  const lifetime = STEAM_CYCLE_PERIOD_SECONDS / cycles;
  const rise = records[at + 7]! * age * (2 - age);
  const travel = windSpeed * lifetime * age * records[at + 11]! * (0.35 + 0.65 * age);
  const wobble = records[at + 10]! * age * Math.sin(2 * Math.PI * (2 * age + records[at + 8]!));
  // Crosswind is the flow turned a quarter clockwise: (flowZ, -flowX).
  out.x = records[at]! + flowX * travel + flowZ * wobble;
  out.y = records[at + 1]! + rise;
  out.z = records[at + 2]! + flowZ * travel - flowX * wobble;
  out.age = age;
  out.sizeMeters = records[at + 3]! * (0.45 + 1.35 * age);
  out.alpha = records[at + 6]! * smoothstep(0, 0.12, age) * (1 - smoothstep(0.45, 1, age));
  return out;
}

/** The shader clock: simulation time wrapped to the cycle period, never negative. */
export function steamClock(simulationTimeSeconds: number): number {
  if (!Number.isFinite(simulationTimeSeconds)) return 0;
  const wrapped = simulationTimeSeconds % STEAM_CYCLE_PERIOD_SECONDS;
  return wrapped < 0 ? wrapped + STEAM_CYCLE_PERIOD_SECONDS : wrapped;
}

function wgslFloat(value: number): string {
  return Number.isInteger(value) ? `${value}.0` : `${value}`;
}

const CLOUD = DEFAULT_VOLUMETRIC_CLOUD_CONFIG;

export const VOLCANIC_STEAM_VERTEX_WGSL = /* wgsl */ `
// position must be declared: Babylon builds VertexInputs from these lines.
attribute position: vec3f;
attribute steamA: vec4f;
attribute steamB: vec4f;
attribute steamC: vec4f;

varying steamCorner: vec2f;
varying steamSpun: vec2f;
varying steamColor: vec3f;
// x alpha, y view depth m, z soft-fade length m, w height above the vent base m
varying steamFade: vec4f;
// x noise seed, y age
varying steamNoise: vec2f;

uniform view: mat4x4f;
uniform projection: mat4x4f;
uniform cameraPosition: vec3f;
// Anchor minus floating origin; the records' x and z are relative to it.
uniform steamAnchor: vec3f;
// xy wind flow (towards, unit), z wind speed m/s, w clock s (wrapped)
uniform steamWind: vec4f;
// x range fade start m, y range end m
uniform steamRange: vec4f;

${AERIAL_PERSPECTIVE_WGSL}

const STEAM_PERIOD: f32 = ${wgslFloat(STEAM_CYCLE_PERIOD_SECONDS)};
const STEAM_TAU: f32 = 6.28318530718;
// The cloud model's constants, from DEFAULT_VOLUMETRIC_CLOUD_CONFIG.
const STEAM_FORWARD_G: f32 = ${wgslFloat(CLOUD.forwardPhaseG)};
const STEAM_BACKWARD_G: f32 = ${wgslFloat(CLOUD.backwardPhaseG)};
const STEAM_BACKWARD_BLEND: f32 = ${wgslFloat(CLOUD.backwardPhaseBlend)};
const STEAM_MULTIPLE_SCATTERING: f32 = ${wgslFloat(CLOUD.multipleScatteringFactor)};
const STEAM_AMBIENT_STRENGTH: f32 = ${wgslFloat(CLOUD.ambientStrength)};

// cloudLighting's phase: forward and backward lobes, mixed, at an octave's g scale.
fn steamPhase(mu: f32, gScale: f32) -> f32 {
  return mix(
    aerialMiePhase(mu, STEAM_FORWARD_G * gScale),
    aerialMiePhase(mu, STEAM_BACKWARD_G * gScale),
    STEAM_BACKWARD_BLEND,
  );
}

@vertex
fn main(input: VertexInputs) -> FragmentInputs {
  let recordA = vertexInputs.steamA;
  let recordB = vertexInputs.steamB;
  let recordC = vertexInputs.steamC;

  // sampleSteamWisp is this block's CPU twin; change both or neither.
  let cycles = max(recordB.x, 1.0);
  let age = fract(uniforms.steamWind.w * cycles / STEAM_PERIOD + recordB.y);
  let lifetime = STEAM_PERIOD / cycles;
  let flow = uniforms.steamWind.xy;
  let rise = recordB.w * age * (2.0 - age);
  let travel = uniforms.steamWind.z * lifetime * age * recordC.w * (0.35 + 0.65 * age);
  let wobble = recordC.z * age * sin(STEAM_TAU * (2.0 * age + recordC.x));
  let drift = flow * travel + vec2f(flow.y, -flow.x) * wobble;
  let centre = uniforms.steamAnchor
    + vec3f(recordA.x + drift.x, recordA.y + rise, recordA.z + drift.y);
  let size = recordA.w * (0.45 + 1.35 * age);

  let toCentre = centre - uniforms.cameraPosition;
  let distanceMeters = max(length(toCentre), 0.001);
  let rangeFade = 1.0 - smoothstep(uniforms.steamRange.x, uniforms.steamRange.y, length(toCentre.xz));
  // A wisp the camera is about to fly through fades out before it fills the
  // screen: overdraw is the one way this effect could get expensive.
  let nearFade = smoothstep(size * 0.6, size * 2.0, distanceMeters);
  let lifeFade = smoothstep(0.0, 0.12, age) * (1.0 - smoothstep(0.45, 1.0, age));
  let alpha = recordB.z * lifeFade * rangeFade * nearFade;

  // Camera-facing: the corner is added in view space. World up seen from
  // the camera is the view matrix's second column; its xy is where "up"
  // points on screen, shrinking to nothing when looking straight down. A
  // young wisp is a jet, stretched along it; it rounds into a puff as it
  // ages. Projecting world up rather than taking screen y keeps the
  // stretch vertical through a banked turn.
  let corner = vertexInputs.position.xy;
  let upOnScreen = uniforms.view[1].xy;
  let upLength = length(upOnScreen);
  let upAxis = select(vec2f(0.0, 1.0), upOnScreen / max(upLength, 1e-4), upLength > 1e-4);
  let stretch = 0.6 * (1.0 - age) * upLength;
  let square = corner * size;
  let offset = square + upAxis * (dot(square, upAxis) * stretch);
  let viewCentre = uniforms.view * vec4f(centre, 1.0);
  var clip = uniforms.projection * (viewCentre + vec4f(offset, 0.0, 0.0));
  // Every corner of an invisible wisp lands on one point: zero area, no fragments.
  clip = select(clip, vec4f(0.0, 0.0, 2.0, 1.0), alpha < ${STEAM_MIN_VISIBLE_ALPHA});

  // The world height of this corner: the world y of the camera's right and
  // up axes are the same column's x and y, so it is the offset dotted with it.
  let cornerHeight = dot(offset, upOnScreen);

  let spin = recordC.y * age;
  let spinCos = cos(spin);
  let spinSin = sin(spin);

  // Lighting: cloudLighting with an optically thin sample (no light march).
  let rayDirection = toCentre / distanceMeters;
  let sunDirection = normalize(uniforms.aerialSunDirection);
  let mu = dot(rayDirection, sunDirection);
  let sunAtWisp = uniforms.aerialSunRadiance
    * aerialSunTransmittanceAt(centre.y, sunDirection.y);
  var phase = steamPhase(mu, 1.0);
  var orderEnergy = STEAM_MULTIPLE_SCATTERING;
  var orderScale = 0.5;
  for (var order = 0u; order < 3u; order += 1u) {
    phase += orderEnergy * steamPhase(mu, orderScale);
    orderEnergy *= STEAM_MULTIPLE_SCATTERING;
    orderScale *= 0.5;
  }
  let radiance = sunAtWisp * phase + skyRadiance(rayDirection) * STEAM_AMBIENT_STRENGTH;
  let haze = aerialPerspective(centre.y, distanceMeters, mu);

  vertexOutputs.position = clip;
  vertexOutputs.steamCorner = corner;
  vertexOutputs.steamSpun = vec2f(
    corner.x * spinCos - corner.y * spinSin,
    corner.x * spinSin + corner.y * spinCos,
  );
  vertexOutputs.steamColor = radiance * haze.transmittance + haze.inScatter;
  vertexOutputs.steamFade = vec4f(
    alpha,
    abs(viewCentre.z),
    max(size * 0.35, 1.0),
    centre.y + cornerHeight - recordA.y,
  );
  vertexOutputs.steamNoise = vec2f(recordC.x, age);
}
`;

export const VOLCANIC_STEAM_FRAGMENT_WGSL = /* wgsl */ `
varying steamCorner: vec2f;
varying steamSpun: vec2f;
varying steamColor: vec3f;
varying steamFade: vec4f;
varying steamNoise: vec2f;

// 1 / render size: fragment position to scene-depth UV (the cloud composite's
// convention, correct because the beauty pass renders offscreen).
uniform steamInvViewport: vec2f;
// Camera-space Z in metres, terrain only, 0 = sky (AtmosphereGpuResources).
var steamSceneDepth: texture_2d<f32>;

fn steamHash(cell: vec2i) -> f32 {
  var h = (bitcast<u32>(cell.x) * 0x8da6b343u) ^ (bitcast<u32>(cell.y) * 0xd8163841u);
  h = (h ^ (h >> 16u)) * 0x7feb352du;
  h = (h ^ (h >> 15u)) * 0x846ca68bu;
  h = h ^ (h >> 16u);
  return f32(h >> 8u) * (1.0 / 16777216.0);
}

fn steamValueNoise(p: vec2f) -> f32 {
  let cell = floor(p);
  let f = p - cell;
  let w = f * f * (vec2f(3.0) - 2.0 * f);
  let i = vec2i(cell);
  let bottom = mix(steamHash(i), steamHash(i + vec2i(1, 0)), w.x);
  let top = mix(steamHash(i + vec2i(0, 1)), steamHash(i + vec2i(1, 1)), w.x);
  return mix(bottom, top, w.y);
}

@fragment
fn main(input: FragmentInputs) -> FragmentOutputs {
  let radiusSquared = dot(fragmentInputs.steamCorner, fragmentInputs.steamCorner);
  if (radiusSquared >= 1.0) { discard; }

  // Three octaves of warped value noise, turning with the wisp and scrolling
  // with its age, so a puff boils as it climbs rather than sliding as a
  // stamp. The noise is THRESHOLDED against a level that rises towards the
  // rim instead of scaling a disc: the core keeps all but the thinnest noise
  // and the rim only its peaks, which breaks the disc into ragged wisps.
  let seed = fragmentInputs.steamNoise.x;
  let age = fragmentInputs.steamNoise.y;
  let p = fragmentInputs.steamSpun * vec2f(2.4, 1.5) + vec2f(seed * 37.0, seed * 11.0 - age * 1.2);
  let warp = vec2f(steamValueNoise(p * 0.8 + vec2f(3.1, 0.0)), steamValueNoise(p * 0.8 + vec2f(0.0, 7.7)));
  let q = p + (warp - vec2f(0.5)) * 1.3;
  let noise = 0.5 * steamValueNoise(q)
    + 0.3 * steamValueNoise(q * 2.07 + vec2f(5.2, 1.3))
    + 0.2 * steamValueNoise(q * 4.13 + vec2f(1.7, 9.2));
  // fbm of three octaves clusters around 0.5; stretch it before thresholding.
  let contrast = clamp((noise - 0.5) * 2.4 + 0.5, 0.0, 1.0);
  let threshold = 0.2 + 0.7 * radiusSquared;
  let density = smoothstep(threshold, threshold + 0.35, contrast) * (1.0 - radiusSquared);

  // Soft against terrain: fade with the gap between the wisp and the ground
  // behind it. A zero depth is sky, where nothing is behind the wisp.
  let uv = fragmentInputs.position.xy * uniforms.steamInvViewport;
  let depthSize = vec2i(textureDimensions(steamSceneDepth, 0));
  let texel = clamp(vec2i(uv * vec2f(depthSize)), vec2i(0), depthSize - vec2i(1));
  let sceneDepth = abs(textureLoad(steamSceneDepth, texel, 0).r);
  let softness = fragmentInputs.steamFade.z;
  let terrainFade = select(
    clamp((sceneDepth - fragmentInputs.steamFade.y) / softness, 0.0, 1.0),
    1.0,
    sceneDepth <= 0.0,
  );
  // And soft against the vent's base, which the terrain-only depth cannot
  // supply over water.
  let groundFade = clamp(fragmentInputs.steamFade.w / softness, 0.0, 1.0);

  let alpha = fragmentInputs.steamFade.x * density * terrainFade * groundFade;
  if (alpha < ${STEAM_MIN_VISIBLE_ALPHA}) { discard; }
  // Premultiplied, as the cloud composite blends.
  fragmentOutputs.color = vec4f(max(fragmentInputs.steamColor, vec3f(0.0)) * alpha, alpha);
}
`;

/** Construction options. */
export interface VolcanicSteamOptions {
  /** `WebGpuQualityProfile.volcanicSteamMaxWisps`. 0 builds no mesh at all. */
  readonly maxWisps: number;
  /** Ground height under a vent. Sampled once per vent per re-query, time-sliced. */
  readonly groundHeight: (x: number, z: number) => number;
  /** The vent source. Defaults to `volcanicVentsInBounds`; tests inject vents here. */
  readonly queryVents?: SteamVentQuery;
  /** The scene depth to soften against; null leaves the terrain fade off. */
  readonly sceneDepth?: BaseTexture | null;
  /** Override of `STEAM_HEIGHT_SAMPLES_PER_FRAME`. */
  readonly heightSamplesPerFrame?: number;
}

export type SteamVentQuery = (
  world: WorldDefinition,
  minX: number,
  minZ: number,
  maxX: number,
  maxZ: number,
  out: VolcanicVent[],
) => VolcanicVent[];

/** Vents selected by one query, nearest first, in fixed typed arrays. */
interface SteamVentSet {
  count: number;
  anchorX: number;
  anchorZ: number;
  readonly x: Float64Array;
  readonly z: Float64Array;
  readonly radius: Float64Array;
  readonly strength: Float64Array;
  readonly seed: Float64Array;
  readonly height: Float64Array;
  readonly distanceSquared: Float64Array;
}

function createVentSet(): SteamVentSet {
  return {
    count: 0,
    anchorX: 0,
    anchorZ: 0,
    x: new Float64Array(STEAM_MAX_VENTS),
    z: new Float64Array(STEAM_MAX_VENTS),
    radius: new Float64Array(STEAM_MAX_VENTS),
    strength: new Float64Array(STEAM_MAX_VENTS),
    seed: new Float64Array(STEAM_MAX_VENTS),
    height: new Float64Array(STEAM_MAX_VENTS),
    distanceSquared: new Float64Array(STEAM_MAX_VENTS),
  };
}

interface SteamGpu {
  readonly mesh: Mesh;
  readonly material: ShaderMaterial;
  readonly buffer: Buffer;
  readonly defaultDepth: RawTexture;
}

/** The mutable shape behind the readonly `VolcanicVent`, for the scratch vent. */
type MutableVent = { -readonly [K in keyof VolcanicVent]: VolcanicVent[K] };

/**
 * The system. One mesh, one material, one instanced draw, or nothing.
 */
export class VolcanicSteamSystem {
  private readonly scene: Scene;
  private readonly world: WorldDefinition;
  private readonly groundHeight: (x: number, z: number) => number;
  private readonly queryVents: SteamVentQuery;
  private readonly heightSamplesPerFrame: number;
  private readonly flowX: number;
  private readonly flowZ: number;
  private readonly windSpeed: number;
  private maxWisps = 0;
  private gpu: SteamGpu | null = null;
  private sceneDepth: BaseTexture | null;
  private binding: AerialPerspectiveBinding | null = null;
  private live = createVentSet();
  private pending = createVentSet();
  /** The query's `out`, reused across queries. */
  private readonly queryOut: VolcanicVent[] = [];
  private readonly scratchVent: MutableVent = { x: 0, z: 0, radiusMeters: 0, strength: 0, seed: 0 };
  private instances: Float32Array | null = null;
  private liveWisps = 0;
  private cellX = Number.NaN;
  private cellZ = Number.NaN;
  private rebuildRequested = true;
  private building = false;
  private heightCursor = 0;
  private originX = 0;
  private originZ = 0;
  /**
   * One frame of drawing right after the mesh is built, with a collapsed,
   * transparent instance. `scene.whenReadyAsync` compiles the effect, but
   * WebGPU creates the render pipeline on the first draw; this is that draw,
   * behind the load screen instead of on the first vent to come into range.
   */
  private primePending = false;
  private queries = 0;
  private readonly anchorUniform = new Vector3();
  private readonly windUniform = new Vector4();
  private readonly rangeUniform = new Vector4(
    STEAM_RANGE_FADE_START_METERS,
    STEAM_VENT_RANGE_METERS,
    0,
    0,
  );
  private readonly viewportUniform = new Vector2(1, 1);
  private readonly aerialVectors3 = new Map<string, Vector3>();
  private readonly aerialVectors4 = new Map<string, Vector4>();
  private readonly setAerialVector3 = (name: string, x: number, y: number, z: number): void => {
    let vector = this.aerialVectors3.get(name);
    if (!vector) {
      vector = new Vector3();
      this.aerialVectors3.set(name, vector);
    }
    vector.set(x, y, z);
    this.gpu?.material.setVector3(name, vector);
  };
  private readonly setAerialVector4 = (
    name: string,
    x: number,
    y: number,
    z: number,
    w: number,
  ): void => {
    let vector = this.aerialVectors4.get(name);
    if (!vector) {
      vector = new Vector4();
      this.aerialVectors4.set(name, vector);
    }
    vector.set(x, y, z, w);
    this.gpu?.material.setVector4(name, vector);
  };

  constructor(scene: Scene, world: WorldDefinition, options: VolcanicSteamOptions) {
    this.scene = scene;
    this.world = world;
    this.groundHeight = options.groundHeight;
    this.queryVents = options.queryVents ?? volcanicVentsInBounds;
    this.heightSamplesPerFrame = Math.max(
      1,
      Math.floor(options.heightSamplesPerFrame ?? STEAM_HEIGHT_SAMPLES_PER_FRAME),
    );
    this.sceneDepth = options.sceneDepth ?? null;
    const flow = steamWindFlow(world);
    this.flowX = flow.x;
    this.flowZ = flow.z;
    this.windSpeed = Number.isFinite(world.prevailingWindSpeed)
      ? Math.max(0, world.prevailingWindSpeed)
      : 0;
    this.windUniform.set(this.flowX, this.flowZ, this.windSpeed, 0);
    this.setMaxWisps(options.maxWisps);
  }

  /** Whether the mesh will be submitted this frame. */
  get drawing(): boolean {
    return this.gpu?.mesh.isEnabled(false) ?? false;
  }

  /** Whether any GPU resource exists (none on a tier whose cap is 0). */
  get hasGpuResources(): boolean {
    return this.gpu !== null;
  }

  /** Wisps in the live instance set. */
  get wispCount(): number {
    return this.liveWisps;
  }

  /** Vents in the live set (selected by the last completed query). */
  get ventCount(): number {
    return this.live.count;
  }

  /** Completed or started vent queries since construction. */
  get ventQueryCount(): number {
    return this.queries;
  }

  /** The live set's anchor (a query cell centre), in absolute world metres. */
  get anchorX(): number {
    return this.live.anchorX;
  }

  get anchorZ(): number {
    return this.live.anchorZ;
  }

  /** The instance records; the first `wispCount` are live. Null without GPU resources. */
  get instanceData(): Float32Array | null {
    return this.instances;
  }

  /** The mesh, for render-order and state assertions. Null without GPU resources. */
  get mesh(): Mesh | null {
    return this.gpu?.mesh ?? null;
  }

  /**
   * Apply the tier's wisp cap. 0 disposes every GPU resource; a non-zero cap
   * builds them (a runtime switch up from tier 0 compiles here, not at load).
   */
  setMaxWisps(maxWisps: number): void {
    const cap = Number.isFinite(maxWisps)
      ? Math.max(0, Math.min(STEAM_INSTANCE_CAPACITY, Math.floor(maxWisps)))
      : 0;
    if (cap === this.maxWisps && (cap === 0) === (this.gpu === null)) return;
    this.maxWisps = cap;
    if (cap === 0) {
      this.disposeGpu();
      this.live.count = 0;
      this.pending.count = 0;
      this.liveWisps = 0;
      this.building = false;
      return;
    }
    if (!this.gpu) this.createGpu();
    this.rebuildRequested = true;
  }

  /** Per-frame haze binding, fanned out by the renderer like every ShaderMaterial consumer's. */
  setAerialPerspective(binding: AerialPerspectiveBinding): void {
    this.binding = binding;
    const gpu = this.gpu;
    if (!gpu) return;
    applyAerialPerspectiveToShaderMaterial(
      gpu.material,
      binding,
      this.setAerialVector3,
      this.setAerialVector4,
    );
  }

  /** The scene depth to soften against (camera-space Z, 0 = sky); null turns that fade off. */
  setSceneDepth(texture: BaseTexture | null): void {
    this.sceneDepth = texture;
    const gpu = this.gpu;
    if (gpu) gpu.material.setTexture("steamSceneDepth", texture ?? gpu.defaultDepth);
  }

  /** Re-anchor after a floating-origin rebase: one uniform, the records are anchor-relative. */
  setFloatingOrigin(originX: number, originZ: number): void {
    this.originX = originX;
    this.originZ = originZ;
    this.anchorUniform.set(this.live.anchorX - originX, 0, this.live.anchorZ - originZ);
  }

  /**
   * Per-frame update. Allocation-free: positional arguments, typed arrays and
   * scratch vectors only. A vent query runs only on a cell change, and a
   * rebuild samples at most `heightSamplesPerFrame` ground heights a frame.
   */
  update(cameraWorldX: number, cameraWorldZ: number, simulationTimeSeconds: number): void {
    const gpu = this.gpu;
    if (!gpu) return;
    const cellX = Math.floor(cameraWorldX / STEAM_QUERY_CELL_METERS);
    const cellZ = Math.floor(cameraWorldZ / STEAM_QUERY_CELL_METERS);
    if (this.rebuildRequested || cellX !== this.cellX || cellZ !== this.cellZ) {
      this.cellX = cellX;
      this.cellZ = cellZ;
      this.rebuildRequested = false;
      this.beginRebuild();
    }
    if (this.building) this.continueRebuild(gpu);

    const draw = this.primePending || this.anyLiveVentInRange(cameraWorldX, cameraWorldZ);
    this.primePending = false;
    if (gpu.mesh.isEnabled(false) !== draw) gpu.mesh.setEnabled(draw);
    if (!draw) return;
    this.windUniform.w = steamClock(simulationTimeSeconds);
    const engine = this.scene.getEngine();
    this.viewportUniform.set(
      1 / Math.max(1, engine.getRenderWidth()),
      1 / Math.max(1, engine.getRenderHeight()),
    );
  }

  dispose(): void {
    this.disposeGpu();
    this.live.count = 0;
    this.pending.count = 0;
    this.liveWisps = 0;
    this.building = false;
    this.maxWisps = 0;
  }

  private createGpu(): void {
    const scene = this.scene;
    ShaderStore.ShadersStoreWGSL[`${STEAM_SHADER_NAME}VertexShader`] = VOLCANIC_STEAM_VERTEX_WGSL;
    ShaderStore.ShadersStoreWGSL[`${STEAM_SHADER_NAME}PixelShader`] = VOLCANIC_STEAM_FRAGMENT_WGSL;
    keepOpaqueDepthForRenderingGroup(scene, WATER_RENDERING_GROUP_ID);

    const mesh = new Mesh("volcanic-steam", scene);
    const quad = new VertexData();
    quad.positions = [-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0];
    // Wound (a, c, b), Babylon's convention; culling is off regardless.
    quad.indices = [0, 2, 1, 0, 3, 2];
    quad.applyToMesh(mesh, false);

    // Capacity-sized and zero-filled, so slot 0 is a transparent wisp for the
    // pipeline-priming draw and for any frame with nothing live.
    const instances = new Float32Array(STEAM_INSTANCE_CAPACITY * STEAM_FLOATS_PER_WISP);
    const buffer = new Buffer(
      scene.getEngine(),
      instances,
      true,
      STEAM_FLOATS_PER_WISP,
      false,
      true,
    );
    mesh.setVerticesBuffer(buffer.createVertexBuffer("steamA", 0, 4));
    mesh.setVerticesBuffer(buffer.createVertexBuffer("steamB", 4, 4));
    mesh.setVerticesBuffer(buffer.createVertexBuffer("steamC", 8, 4));
    // Never below 1: a non-zero count is what makes Babylon compile the
    // instanced permutation, and it must be the one that later draws.
    mesh.forcedInstanceCount = 1;
    mesh.renderingGroupId = WATER_RENDERING_GROUP_ID;
    mesh.alphaIndex = 2;
    mesh.isPickable = false;
    mesh.applyFog = false;
    mesh.receiveShadows = false;
    // The sprites are placed in the vertex shader, so the quad's own bounds
    // mean nothing; the range check in update() is the culling.
    mesh.alwaysSelectAsActiveMesh = true;
    mesh.doNotSyncBoundingInfo = true;

    const material = new ShaderMaterial(
      "volcanic-steam-material",
      scene,
      STEAM_SHADER_NAME,
      {
        attributes: ["position", "steamA", "steamB", "steamC"],
        uniforms: [
          "view",
          "projection",
          "cameraPosition",
          "steamAnchor",
          "steamWind",
          "steamRange",
          "steamInvViewport",
          ...AERIAL_PERSPECTIVE_UNIFORMS,
        ],
        samplers: ["steamSceneDepth"],
        shaderLanguage: ShaderLanguage.WGSL,
        needAlphaBlending: true,
      },
    );
    material.backFaceCulling = false;
    material.disableDepthWrite = true;
    material.transparencyMode = Material.MATERIAL_ALPHABLEND;
    material.alphaMode = Constants.ALPHA_PREMULTIPLIED_PORTERDUFF;
    // Bound so the material is never incomplete: a zero depth reads as sky,
    // which turns the terrain fade off rather than hiding the steam.
    const defaultDepth = RawTexture.CreateRTexture(
      new Float32Array([0]),
      1,
      1,
      scene,
      false,
      false,
      Texture.NEAREST_SAMPLINGMODE,
      Constants.TEXTURETYPE_FLOAT,
    );
    defaultDepth.name = "volcanic-steam-no-depth";
    material.setTexture("steamSceneDepth", this.sceneDepth ?? defaultDepth);
    // Stored by reference: update() writes these in place.
    material.setVector3("steamAnchor", this.anchorUniform);
    material.setVector4("steamWind", this.windUniform);
    material.setVector4("steamRange", this.rangeUniform);
    material.setVector2("steamInvViewport", this.viewportUniform);
    mesh.material = material;
    mesh.setEnabled(false);

    this.gpu = { mesh, material, buffer, defaultDepth };
    this.instances = instances;
    this.liveWisps = 0;
    this.live.count = 0;
    this.primePending = true;
    if (this.binding) this.setAerialPerspective(this.binding);
  }

  private disposeGpu(): void {
    const gpu = this.gpu;
    if (!gpu) return;
    this.gpu = null;
    this.instances = null;
    // NOT dispose(false, true): that disposes the material's textures, and
    // the scene depth bound here belongs to the atmosphere.
    gpu.mesh.dispose(false, false);
    gpu.material.dispose();
    gpu.buffer.dispose();
    gpu.defaultDepth.dispose();
  }

  private anyLiveVentInRange(cameraWorldX: number, cameraWorldZ: number): boolean {
    const set = this.live;
    if (this.liveWisps === 0) return false;
    for (let index = 0; index < set.count; index += 1) {
      const dx = set.x[index]! - cameraWorldX;
      const dz = set.z[index]! - cameraWorldZ;
      const reach = STEAM_VENT_RANGE_METERS + set.radius[index]!;
      if (dx * dx + dz * dz <= reach * reach) return true;
    }
    return false;
  }

  /** Query the cell's vents into the pending set, nearest the cell centre first. */
  private beginRebuild(): void {
    this.queries += 1;
    const set = this.pending;
    const centreX = (this.cellX + 0.5) * STEAM_QUERY_CELL_METERS;
    const centreZ = (this.cellZ + 0.5) * STEAM_QUERY_CELL_METERS;
    set.count = 0;
    set.anchorX = centreX;
    set.anchorZ = centreZ;
    const vents = this.queryVents(
      this.world,
      centreX - STEAM_QUERY_REACH_METERS,
      centreZ - STEAM_QUERY_REACH_METERS,
      centreX + STEAM_QUERY_REACH_METERS,
      centreZ + STEAM_QUERY_REACH_METERS,
      this.queryOut,
    );
    for (let index = 0; index < vents.length; index += 1) {
      const vent = vents[index]!;
      if (steamWispCount(vent) === 0) continue;
      if (!Number.isFinite(vent.x) || !Number.isFinite(vent.z)) continue;
      const dx = vent.x - centreX;
      const dz = vent.z - centreZ;
      const distanceSquared = dx * dx + dz * dz;
      // Any camera inside the cell is within half a diagonal of its centre.
      const reach = STEAM_VENT_RANGE_METERS + STEAM_QUERY_CELL_METERS * Math.SQRT1_2
        + Math.max(0, vent.radiusMeters);
      if (distanceSquared > reach * reach) continue;
      this.insertNearest(set, vent, distanceSquared);
    }
    // Heights already sampled for the live set carry over; only new vents
    // pay for a terrain sample.
    const live = this.live;
    for (let index = 0; index < set.count; index += 1) {
      set.height[index] = Number.NaN;
      for (let other = 0; other < live.count; other += 1) {
        if (
          live.x[other] === set.x[index]
          && live.z[other] === set.z[index]
          && live.seed[other] === set.seed[index]
        ) {
          set.height[index] = live.height[other]!;
          break;
        }
      }
    }
    this.heightCursor = 0;
    this.building = true;
  }

  /** Insertion into the distance-ordered set, dropping the farthest past capacity. */
  private insertNearest(set: SteamVentSet, vent: VolcanicVent, distanceSquared: number): void {
    let at = set.count;
    if (at === STEAM_MAX_VENTS) {
      if (distanceSquared >= set.distanceSquared[at - 1]!) return;
      at -= 1;
    } else {
      set.count += 1;
    }
    while (at > 0 && set.distanceSquared[at - 1]! > distanceSquared) {
      set.x[at] = set.x[at - 1]!;
      set.z[at] = set.z[at - 1]!;
      set.radius[at] = set.radius[at - 1]!;
      set.strength[at] = set.strength[at - 1]!;
      set.seed[at] = set.seed[at - 1]!;
      set.distanceSquared[at] = set.distanceSquared[at - 1]!;
      at -= 1;
    }
    set.x[at] = vent.x;
    set.z[at] = vent.z;
    set.radius[at] = Math.max(0, vent.radiusMeters);
    set.strength[at] = ventStrength(vent);
    set.seed[at] = vent.seed >>> 0;
    set.distanceSquared[at] = distanceSquared;
  }

  /** Sample this frame's share of ground heights; on the last, write and swap in the records. */
  private continueRebuild(gpu: SteamGpu): void {
    const set = this.pending;
    let budget = this.heightSamplesPerFrame;
    while (this.heightCursor < set.count && budget > 0) {
      const index = this.heightCursor;
      if (Number.isNaN(set.height[index]!)) {
        const ground = this.groundHeight(set.x[index]!, set.z[index]!);
        set.height[index] = Math.max(Number.isFinite(ground) ? ground : 0, this.world.seaLevel);
        budget -= 1;
      }
      this.heightCursor += 1;
    }
    if (this.heightCursor < set.count) return;

    const instances = this.instances!;
    const vent = this.scratchVent;
    let wisps = 0;
    for (let index = 0; index < set.count && wisps < this.maxWisps; index += 1) {
      vent.x = set.x[index]!;
      vent.z = set.z[index]!;
      vent.radiusMeters = set.radius[index]!;
      vent.strength = set.strength[index]!;
      vent.seed = set.seed[index]!;
      // Nearest first: when the cap binds, the farthest vents give way, and a
      // vent left a partial share keeps the first wisps of its own sequence.
      const count = Math.min(steamWispCount(vent), this.maxWisps - wisps);
      writeSteamWisps(
        vent,
        set.height[index]!,
        set.anchorX,
        set.anchorZ,
        this.windSpeed,
        count,
        instances,
        wisps * STEAM_FLOATS_PER_WISP,
      );
      wisps += count;
    }
    if (wisps === 0) instances.fill(0, 0, STEAM_FLOATS_PER_WISP);
    gpu.buffer.updateDirectly(instances, 0);
    gpu.mesh.forcedInstanceCount = Math.max(1, wisps);

    this.pending = this.live;
    this.live = set;
    this.liveWisps = wisps;
    this.building = false;
    this.anchorUniform.set(set.anchorX - this.originX, 0, set.anchorZ - this.originZ);
  }
}
