import { Constants } from "@babylonjs/core/Engines/constants";
import type { Material } from "@babylonjs/core/Materials/material";
import type { MaterialDefines } from "@babylonjs/core/Materials/materialDefines";
import { MaterialPluginBase } from "@babylonjs/core/Materials/materialPluginBase";
import type { BaseTexture } from "@babylonjs/core/Materials/Textures/baseTexture";
import { RawTexture2DArray } from "@babylonjs/core/Materials/Textures/rawTexture2DArray";
import { Texture } from "@babylonjs/core/Materials/Textures/texture";
import type { UniformBuffer } from "@babylonjs/core/Materials/uniformBuffer";
import type { Nullable } from "@babylonjs/core/types";
import { STRUCTURE_SURFACES } from "@/src/world/structures/structureModel";
import { structureSurfaceTextureTable } from "@/src/world/structures/kit/kitTextures";
import {
  STRUCTURE_LAMP_RGB,
  STRUCTURE_LAMP_STEPS,
  STRUCTURE_NIGHT_OFF,
  type StructureNightLighting,
} from "../../structures/structureNightLighting";
import { STRUCTURE_CODE_LAMP_SPAN, STRUCTURE_CODE_STRIDE } from "../../structures/structureSurfaceCode";
import { STRUCTURE_CLIMATES, STRUCTURE_WEAR_STEPS } from "@/src/world/structures/kit/kitWeathering";
import { STRUCTURE_TEXTURE_LAYER_COUNT, structurePlaceholderTexel } from "../../structures/structureTextures";
import { TERRAIN_SURFACE_INJECTION_ANCHORS } from "../terrain/TerrainSurfacePlugin";

/**
 * The generated buildings' one material (the plan's "One material"), as a
 * plugin on a PBR material, in four roles that share its shader:
 *
 *   far    the blocks: drawn between the near radius and the far radius,
 *          dithered in across the handoff band past the near radius and out
 *          across the band inside the far radius.
 *   near   the closed shells: drawn inside the near radius, dithered out across
 *          the band past it, the complement of the far blocks' dither there,
 *          so a building is one or the other at every pixel and never both or
 *          neither. A building drawn open is dropped from it.
 *   open   the open buildings next to the camera: shells with real openings,
 *          their rooms and furniture. Only the buildings drawn open now (the
 *          near set's dropped list) are drawn; the mesh holds those built
 *          ahead, from further out, too.
 *   glass  the open buildings' window glass, blended, likewise.
 *
 * Who is drawn is a function of the camera alone, per building: every vertex
 * carries its building's footprint centre (`structureCentre`), the vertex
 * stage measures it to the camera horizontally, and a building wholly out of
 * its set collapses to nothing (all its vertices to one point, so its
 * triangles have no area). The fragment stage dithers the band on an 8 x 8
 * Bayer threshold.
 *
 * WHAT A FACE LOOKS LIKE. Its albedo is its vertex colour (linear RGB), which
 * is all Low draws. The textured tiers (`structureTextureEdge` > 0; never the
 * glass) add the kit's synthesised layers (`kitTextures.ts`): the surface's
 * layer at its UV over the layer's tile (window and doorway fitted 0 to 1),
 * albedo `mix(rgb, colour * rgb * 2, a)`, the normal map's RG in the face's
 * (u, v) frame, B the roughness and A the cavity, each scaled towards flat by
 * the surface's strength. The frame comes from the screen derivatives of the
 * UV and the position (a cotangent frame), so it is the UV's own whatever
 * way the face or the building turns, and the vertices carry no tangent.
 * The derivatives are taken first thing in `main`, in uniform control flow,
 * and the arrays read with explicit gradients after the dither's discard.
 *
 * INSIDE. A face with an indoor factor (`structureIndoor`, 0 outside; inside
 * about 0.15 in a corner to 1 by a window: an eye adapted indoors) sees no
 * sun or moon (their light is cut at each directional light's own colour,
 * `CUSTOM_LIGHT{X}_COLOR`, so lamps and clustered lights still reach it) and
 * only that share of the sky's ambient light and reflections. So rooms need
 * no second pipeline and no shadows to be dark where they should be.
 *
 * A vertex's surface is a code (`structureSurfaceCode.ts`): the surface id,
 * its building's lamp threshold and its weather (wear and climate).
 *
 * WEATHERED (`kitWeathering.ts`). The colours come aged from the CPU; here,
 * on every tier, grime in the face's own metres (its UV), seeded by the
 * part's colour (which the CPU scatters per building): mottled stains on
 * every outside face, rain streaks down walls and dirt splashed up their
 * foot, moss or lichen on roofs where the climate is damp, dust where it is
 * dry, rust on corrugated iron and steel. The fine terms fade out with the
 * pixel's footprint, so they never shimmer far off.
 *
 * AT NIGHT (`setNight`, `structureNightLighting.ts`). The vertex stage
 * compares the building's lamp threshold with the night's lit share and
 * passes the fragment stage the id, the lit flag and the weather. Its windows' glass
 * glows (the window layer's A, its glass, on the textured tiers; about the
 * same share of the quad on Low), its doorways show a lamp-lit inside, and
 * its rooms' faces add a warm lamp's light, brightest by the windows as the
 * indoor factor is. The glass role never lights.
 */

/** Which of the four meshes a material draws. */
export type StructureMaterialRole = "far" | "near" | "open" | "glass";

const ROLE_ID: Readonly<Record<StructureMaterialRole, number>> = Object.freeze({
  far: 0,
  near: 1,
  open: 2,
  glass: 3,
});

/** How many buildings the near set can drop at once for the open set (three vec4 of centre pairs). */
export const STRUCTURE_OPEN_SLOTS = 6;

/** The vertex attributes the meshes carry, past position and normal. */
export const STRUCTURE_VERTEX_ATTRIBUTES = Object.freeze({
  surface: { kind: "structureSurface", floats: 1 },
  colour: { kind: "structureColour", floats: 3 },
  indoor: { kind: "structureIndoor", floats: 1 },
  centre: { kind: "structureCentre", floats: 2 },
  uv: { kind: "structureUv", floats: 2 },
});

/** What each draw binds: the camera and the radii, in the mesh's own frame. */
export interface StructureMaterialBinding {
  /** The camera, horizontally, relative to the mesh's build origin, metres. */
  readonly cameraX: number;
  readonly cameraZ: number;
  readonly nearRadiusMeters: number;
  /** The near radius of the thin-member buildings (`STRUCTURE_THIN_ARCHETYPES`), no further than `nearRadiusMeters`. */
  readonly thinNearRadiusMeters: number;
  readonly bandMeters: number;
  readonly farRadiusMeters: number;
  /** Centres (x, z pairs, relative to the same origin) of buildings the near set drops, at most `STRUCTURE_OPEN_SLOTS`. */
  readonly dropped: readonly number[];
}

/** The material's own roughness, which the textured tiers' layers vary about. */
export const STRUCTURE_BASE_ROUGHNESS = 0.82;
export const STRUCTURE_GLASS_ROUGHNESS = 0.06;

/** The share of a window quad that glows on Low, which has no window layer (about the layer's mean glass). */
export const STRUCTURE_UNTEXTURED_GLASS_SHARE = 0.75;

/** A lit building's doorway (the dark inside, on its shells) at this share of a lamp-lit room's light, on a room of this albedo. */
export const STRUCTURE_DOORWAY_LAMP_SHARE = 0.5;
export const STRUCTURE_ROOM_ALBEDO = 0.45;

const WINDOW_ID = STRUCTURE_SURFACES.indexOf("window");
const DOORWAY_ID = STRUCTURE_SURFACES.indexOf("doorway");

const SURFACE_ID = (surface: (typeof STRUCTURE_SURFACES)[number]) => STRUCTURE_SURFACES.indexOf(surface);

/** Linear colours the grime mixes towards, per climate (`STRUCTURE_CLIMATES` order). */
export const STRUCTURE_GRIME = Object.freeze({
  /** Moss (damp), lichen (cold), dust (dry), mould and moss (humid), on roofs. */
  roofGrowth: [[0.075, 0.095, 0.035], [0.2, 0.22, 0.16], [0.36, 0.3, 0.22], [0.05, 0.075, 0.03]],
  /** How much of a roof the growth may take, at full wear. */
  roofGrowthShare: [0.6, 0.45, 0.35, 0.8],
  /** The foot of a wall: splashed earth, green where damp, dust where dry. */
  footTint: [[0.6, 0.58, 0.46], [0.66, 0.63, 0.58], [0.8, 0.68, 0.52], [0.5, 0.6, 0.4]],
  /** Bare, silvered wood where paint has peeled. */
  peeled: [0.24, 0.23, 0.21],
  /** Rain streaks' darkening at full wear. */
  streak: [0.45, 0.38, 0.3, 0.55],
  /** How much paint may have peeled off wooden walls and trim, at full wear. */
  peelShare: [0.7, 0.8, 1.0, 0.8],
  /** Rust on iron and steel: how much, at full wear. */
  rustShare: [0.5, 0.4, 0.35, 0.75],
  rust: [0.2, 0.07, 0.025],
});

const vec3Table = (rows: readonly (readonly number[])[]) =>
  `array<vec3f, 4>(${rows.map((row) => `vec3f(${row.map((value) => wgslNumber(value)).join(", ")})`).join(", ")})`;
const floatTable = (values: readonly number[]) => `array<f32, 4>(${values.map((value) => wgslNumber(value)).join(", ")})`;

if (STRUCTURE_CLIMATES.length !== 4) throw new Error("the grime tables have a row per climate");

/** The grime's per-climate tables, as private arrays (indexed at run time, which a const array value is not, portably). */
const GRIME_TABLES_WGSL = /* wgsl */ `
var<private> structureRoofGrowth: array<vec3f, 4> = ${vec3Table(STRUCTURE_GRIME.roofGrowth)};
var<private> structureRoofGrowthShare: array<f32, 4> = ${floatTable(STRUCTURE_GRIME.roofGrowthShare)};
var<private> structureFootTint: array<vec3f, 4> = ${vec3Table(STRUCTURE_GRIME.footTint)};
var<private> structureStreakShare: array<f32, 4> = ${floatTable(STRUCTURE_GRIME.streak)};
var<private> structurePeelShare: array<f32, 4> = ${floatTable(STRUCTURE_GRIME.peelShare)};
var<private> structureRustShare: array<f32, 4> = ${floatTable(STRUCTURE_GRIME.rustShare)};
`;

/**
 * The grime, after the layers (so it ages the painted surface) and before
 * the lights: only on outside faces (indoor 0, or a thin tower's -1) that
 * are not a window or a doorway, and only on a weathered building.
 */
const WEATHERING_WGSL = /* wgsl */ `
{
  let structureWearStep = floor((structureWeatherCode + 0.5) / 4.0);
  let structureWear = structureWearStep / ${wgslNumber(STRUCTURE_WEAR_STEPS)};
  let structureClimate = u32(clamp(structureWeatherCode - 4.0 * structureWearStep, 0.0, 3.0));
  let structureFitted = abs(structureSurfaceCode - ${wgslNumber(WINDOW_ID)}) < 0.5 || abs(structureSurfaceCode - ${wgslNumber(DOORWAY_ID)}) < 0.5;
  if (structureWear > 0.0 && fragmentInputs.structureColourIndoorV.a <= ${wgslNumber(1e-3)} && !structureFitted) {
    let structureUvM = fragmentInputs.structureUvSurfaceShareV.xy;
    // Metres a pixel spans on the face: the fine terms fade out before they alias.
    let structureFootprint = max(length(structureUvDx), length(structureUvDy));
    let structureFine = 1.0 - smoothstep(0.05, 0.22, structureFootprint);
    let structureCoarse = 1.0 - smoothstep(0.5, 2.0, structureFootprint);
    // Seeded by the part's colour, which the CPU scatters per building.
    let structureQ = vec3u(clamp(fragmentInputs.structureColourIndoorV.rgb, vec3f(0.0), vec3f(4.0)) * 1023.0 + 0.5);
    let structureSeed = (structureQ.x * 73856093u) ^ (structureQ.y * 19349663u) ^ (structureQ.z * 83492791u);
    let structureShift = vec2f(f32(structureSeed & 255u), f32((structureSeed >> 8u) & 255u));
    let structureGeomNormal = normalize(fragmentInputs.vNormalW);
    // Mottled stains everywhere outside.
    let structureStain = structureNoise(structureUvM * 0.45 + structureShift, structureSeed) * 0.6
      + structureNoise(structureUvM * 1.3 + structureShift.yx, structureSeed + 1u) * 0.4;
    var structureAged = surfaceAlbedo * mix(1.0, 0.62 + 0.55 * structureStain, structureWear * structureCoarse);
    let structurePainted = abs(structureSurfaceCode - ${wgslNumber(SURFACE_ID("clapboard"))}) < 0.5
      || abs(structureSurfaceCode - ${wgslNumber(SURFACE_ID("boards"))}) < 0.5
      || abs(structureSurfaceCode - ${wgslNumber(SURFACE_ID("trim"))}) < 0.5;
    if (structurePainted) {
      // Paint peeled off wood in flakes and patches, the grey boards showing.
      let structurePeel = structureNoise(vec2f(structureUvM.x * 2.6, structureUvM.y * 1.4) + structureShift.yx, structureSeed + 7u) * 0.55
        + structureNoise(structureUvM * 7.0 + structureShift, structureSeed + 8u) * 0.45;
      let structurePeelMask = smoothstep(0.74 - 0.14 * structureWear, 0.8 - 0.1 * structureWear, structurePeel)
        * structureFine * structureWear * structurePeelShare[structureClimate];
      structureAged = mix(structureAged, vec3f(${STRUCTURE_GRIME.peeled.map((value) => wgslNumber(value)).join(", ")}), structurePeelMask);
    }
    if (abs(structureGeomNormal.y) < 0.35) {
      // Walls: rain streaks, narrow across and long down, and the foot splashed with earth.
      let structureStreak = structureNoise(vec2f(structureUvM.x * 3.5, structureUvM.y * 0.22) + structureShift, structureSeed + 2u);
      structureAged *= 1.0 - smoothstep(0.55, 0.9, structureStreak) * structureFine * structureWear
        * structureStreakShare[structureClimate];
      let structureFoot = 1.0 - smoothstep(-0.1, 0.55 + 0.35 * structureStain, structureUvM.y);
      structureAged = mix(structureAged, structureAged * structureFootTint[structureClimate],
        structureFoot * structureWear);
    }
    // Moss and lichen take shingle, tile and slate; iron roofs rust instead.
    let structureRoof = structureSurfaceCode > ${wgslNumber(SURFACE_ID("shingle") - 0.5)} && structureSurfaceCode < ${wgslNumber(SURFACE_ID("slate") + 0.5)};
    if (structureRoof && structureGeomNormal.y > 0.2) {
      // Roofs: moss or lichen (dust where dry) in small tufts, gathered where a
      // broad field says the roof stays damp; the tufts blur to their mean far off.
      let structureGrowthField = structureNoise(structureUvM * 0.45 + structureShift, structureSeed + 3u);
      let structureTufts = mix(0.5, structureNoise(structureUvM * 4.5 + structureShift.yx, structureSeed + 4u), structureFine);
      let structureGrowthMask = smoothstep(0.55, 0.85, structureGrowthField * (0.55 + 0.6 * structureWear) + structureTufts * 0.45)
        * structureRoofGrowthShare[structureClimate] * structureWear;
      structureAged = mix(structureAged, structureRoofGrowth[structureClimate], structureGrowthMask);
    }
    let structureIron = abs(structureSurfaceCode - ${wgslNumber(SURFACE_ID("metal"))}) < 0.5 || abs(structureSurfaceCode - ${wgslNumber(SURFACE_ID("steel"))}) < 0.5;
    if (structureIron) {
      // Rust in streaks down the sheet (v runs up a roof's slope and a wall),
      // where a broad field says the galvanising has gone.
      let structureRustField = structureNoise(structureUvM * 0.5 + structureShift.yx, structureSeed + 5u);
      let structureRustStreaks = mix(0.5, structureNoise(vec2f(structureUvM.x * 3.2, structureUvM.y * 0.4) + structureShift, structureSeed + 6u), structureFine);
      let structureRust = smoothstep(0.55, 0.85, structureRustField * (0.5 + 0.6 * structureWear) + structureRustStreaks * 0.45)
        * structureRustShare[structureClimate] * structureWear;
      structureAged = mix(structureAged, vec3f(${STRUCTURE_GRIME.rust.map((value) => wgslNumber(value)).join(", ")}), structureRust);
#ifdef STRUCTURE_TEXTURED
      structureRoughness = mix(structureRoughness, 0.92, structureRust);
#endif
    }
    surfaceAlbedo = structureAged;
  }
}
`;

/** A centre no building has. */
const NO_CENTRE = 1e9;

function wgslNumber(value: number): string {
  if (!Number.isFinite(value)) throw new RangeError("WGSL constants must be finite");
  return Number.isInteger(value) ? `${value}.0` : String(value);
}

const VERTEX_DEFINITIONS = /* wgsl */ `
attribute structureSurface: f32;
attribute structureColour: vec3f;
attribute structureIndoor: f32;
attribute structureCentre: vec2f;
attribute structureUv: vec2f;
// Two varyings for the lot: the PBR stage with haze, cloud shadows and the
// cascades already passes 13, and the inter-stage limit is 16.
// rgb: the part's colour; a: the indoor factor.
varying structureColourIndoorV: vec4f;
// xy: the face's UV (metres); z: the surface id, plus the code stride if the
// building is lit, plus twice the stride times its weather; w: the share of
// the building drawn (0..1).
varying structureUvSurfaceShareV: vec4f;

fn structureDropped(centre: vec2f) -> bool {
  let a = uniforms.structureDroppedA;
  let b = uniforms.structureDroppedB;
  let c = uniforms.structureDroppedC;
  return distance(centre, a.xy) < 0.01 || distance(centre, a.zw) < 0.01
    || distance(centre, b.xy) < 0.01 || distance(centre, b.zw) < 0.01
    || distance(centre, c.xy) < 0.01 || distance(centre, c.zw) < 0.01;
}
`;

const VERTEX_UPDATE_POSITION = /* wgsl */ `
{
  let structureRanges = uniforms.structureRanges;
  let structureRole = uniforms.structureCamera.z;
  let structureDistance = distance(vertexInputs.structureCentre, uniforms.structureCamera.xy);
  let structureBand = max(structureRanges.y, 1e-3);
  // A thin-member building's block takes over sooner (its far and near vertices carry indoor -1).
  let structureNear = select(structureRanges.x, structureRanges.w, vertexInputs.structureIndoor < -0.5);
  var structureShare = 1.0;
  if (structureRole < 0.5) {
    // Far: in across the band past the near radius, out across the band inside the far one.
    structureShare = clamp((structureDistance - structureNear) / structureBand, 0.0, 1.0)
      * clamp((structureRanges.z - structureDistance) / structureBand, 0.0, 1.0);
  } else if (structureRole < 1.5) {
    structureShare = clamp((structureNear + structureBand - structureDistance) / structureBand, 0.0, 1.0);
    if (structureDropped(vertexInputs.structureCentre)) { structureShare = 0.0; }
  } else {
    // Open and glass: only the buildings drawn open now (the open mesh holds
    // those built ahead, from further out, too).
    structureShare = select(0.0, 1.0, structureDropped(vertexInputs.structureCentre));
  }
  if (structureShare <= 0.0) {
    // The whole building to one point: its triangles have no area.
    positionUpdated = vec3f(0.0, -100000.0, 0.0);
  }
  // The surface code: the id, the building's lamp threshold in steps and its weather.
  let structureTotal = floor((vertexInputs.structureSurface + 0.5) / ${wgslNumber(STRUCTURE_CODE_STRIDE)});
  let structureWeather = floor((structureTotal + 0.5) / ${wgslNumber(STRUCTURE_CODE_LAMP_SPAN)});
  let structureSteps = structureTotal - ${wgslNumber(STRUCTURE_CODE_LAMP_SPAN)} * structureWeather;
  let structureSurfaceId = vertexInputs.structureSurface - ${wgslNumber(STRUCTURE_CODE_STRIDE)} * structureTotal;
  let structureLit = select(0.0, 1.0,
    (structureSteps / ${wgslNumber(STRUCTURE_LAMP_STEPS)} < uniforms.structureNight.x) && (structureRole < 2.5));
  vertexOutputs.structureColourIndoorV = vec4f(vertexInputs.structureColour, vertexInputs.structureIndoor);
  vertexOutputs.structureUvSurfaceShareV = vec4f(vertexInputs.structureUv,
    structureSurfaceId + ${wgslNumber(STRUCTURE_CODE_STRIDE)} * structureLit + ${wgslNumber(2 * STRUCTURE_CODE_STRIDE)} * structureWeather,
    structureShare);
}
`;

/** The kit's surface table (layer, 1 / tile, strength, fitted) as WGSL, a vec4 per surface id. */
function surfaceTableWgsl(): string {
  const table = structureSurfaceTextureTable();
  const rows: string[] = [];
  for (let id = 0; id < STRUCTURE_SURFACES.length; id += 1) {
    const row = [0, 1, 2, 3].map((k) => wgslNumber(Math.fround(table[id * 4 + k]!)));
    rows.push(`vec4f(${row.join(", ")})`);
  }
  // var<private>, not const: an index known only at run time reads a
  // reference everywhere, where indexing a const array value is not portable.
  return `var<private> structureSurfaceTable: array<vec4f, ${STRUCTURE_SURFACES.length}> = array<vec4f, ${STRUCTURE_SURFACES.length}>(\n  ${rows.join(",\n  ")},\n);`;
}

const FRAGMENT_DEFINITIONS = /* wgsl */ `
#ifdef STRUCTURE_TEXTURED
var structureDetailSampler: sampler;
var structureDetail: texture_2d_array<f32>;
var structureNormalSampler: sampler;
var structureNormal: texture_2d_array<f32>;
${surfaceTableWgsl()}
#endif
varying structureColourIndoorV: vec4f;
varying structureUvSurfaceShareV: vec4f;
${GRIME_TABLES_WGSL}
// Value noise for the grime: an integer hash per lattice cell, smoothly
// blended (i32 to u32 is a bit cast, so negative cells hash too).
fn structureHash(cell: vec2i, seed: u32) -> f32 {
  var h = (u32(cell.x) * 0x8da6b343u) ^ (u32(cell.y) * 0xd8163841u) ^ (seed * 0xcb1ab31fu);
  h = (h ^ (h >> 13u)) * 0x5bd1e995u;
  h = h ^ (h >> 15u);
  return f32(h & 0xffffffu) / 16777216.0;
}

fn structureNoise(p: vec2f, seed: u32) -> f32 {
  let cell = vec2i(floor(p));
  let f = fract(p);
  let s = f * f * (3.0 - 2.0 * f);
  let a = structureHash(cell, seed);
  let b = structureHash(cell + vec2i(1, 0), seed);
  let c = structureHash(cell + vec2i(0, 1), seed);
  let d = structureHash(cell + vec2i(1, 1), seed);
  return mix(mix(a, b, s.x), mix(c, d, s.x), s.y);
}

// 2-14's ordered 8x8 Bayer threshold in [1/128, 127/128] (the detail
// plugins' construction), on render-target pixels.
fn structureBayer8(pixel: vec2u) -> f32 {
  let x = pixel.x % 8u;
  let y = pixel.y % 8u;
  let xorBits = x ^ y;
  let index = ((y & 1u) << 5u) | ((xorBits & 1u) << 4u)
    | ((y & 2u) << 2u) | ((xorBits & 2u) << 1u)
    | ((y & 4u) >> 1u) | ((xorBits & 4u) >> 2u);
  return (f32(index) + 0.5) / 64.0;
}
`;

// The dither, first: a building in the handoff band keeps the pixels its
// share owns. The far blocks keep the complement of the shells' pixels.
const FRAGMENT_MAIN_BEGIN = /* wgsl */ `
// Before anything can discard or branch: the UV's gradients (the grime's
// footprint, the textures' mips) and, textured, the position's for the frame.
let structureUvDx = dpdx(fragmentInputs.structureUvSurfaceShareV.xy);
let structureUvDy = dpdy(fragmentInputs.structureUvSurfaceShareV.xy);
#ifdef STRUCTURE_TEXTURED
let structurePositionDx = dpdx(fragmentInputs.vPositionW);
let structurePositionDy = dpdy(fragmentInputs.vPositionW);
#endif
{
  let structureShare = fragmentInputs.structureUvSurfaceShareV.w;
  if (structureShare < 0.999) {
    let structureThreshold = structureBayer8(vec2u(fragmentInputs.position.xy));
    // Parenthesised: an unbracketed "a < b, c >= d" parses as a template list.
    let structureKeep = select(
      (structureThreshold < structureShare),
      (structureThreshold >= 1.0 - structureShare),
      (uniforms.structureCamera.z < 0.5),
    );
    if (!structureKeep) { discard; }
  }
}
`;

const FRAGMENT_BEFORE_LIGHTS = /* wgsl */ `
surfaceAlbedo = fragmentInputs.structureColourIndoorV.rgb;
// The building's weather, its lamps (the vertex stage's lit flag) and the bare surface id.
let structureWeatherCode = floor((fragmentInputs.structureUvSurfaceShareV.z + 0.5) / ${wgslNumber(2 * STRUCTURE_CODE_STRIDE)});
let structureCodeRest = fragmentInputs.structureUvSurfaceShareV.z - ${wgslNumber(2 * STRUCTURE_CODE_STRIDE)} * structureWeatherCode;
let structureLitFace = structureCodeRest > ${wgslNumber(STRUCTURE_CODE_STRIDE - 0.5)};
let structureSurfaceCode = structureCodeRest - select(0.0, ${wgslNumber(STRUCTURE_CODE_STRIDE)}, structureLitFace);
// The share of a window face that is glass: the window layer's A where it is drawn.
var structureGlassMask = ${wgslNumber(STRUCTURE_UNTEXTURED_GLASS_SHARE)};
#ifdef STRUCTURE_TEXTURED
var structureRoughness = ${wgslNumber(STRUCTURE_BASE_ROUGHNESS)};
var structureCavity = 1.0;
{
  let structureId = u32(clamp(round(structureSurfaceCode), 0.0, ${wgslNumber(STRUCTURE_SURFACES.length - 1)}));
  let structureEntry = structureSurfaceTable[structureId];
  let structureStrength = structureEntry.z;
  if (structureStrength > 0.0) {
    // Tiled surfaces at metres over the tile; window and doorway as laid, 0 to 1.
    let structureScale = select(structureEntry.y, 1.0, structureEntry.w > 0.5);
    let structureUv = fragmentInputs.structureUvSurfaceShareV.xy * structureScale;
    let structureLayer = i32(structureEntry.x + 0.5);
    let structureDetailTexel = textureSampleGrad(structureDetail, structureDetailSampler, structureUv, structureLayer,
      structureUvDx * structureScale, structureUvDy * structureScale);
    let structureNormalTexel = textureSampleGrad(structureNormal, structureNormalSampler, structureUv, structureLayer,
      structureUvDx * structureScale, structureUvDy * structureScale);
    let structurePainted = mix(structureDetailTexel.rgb, surfaceAlbedo * structureDetailTexel.rgb * 2.0, structureDetailTexel.a);
    surfaceAlbedo = mix(surfaceAlbedo, structurePainted, structureStrength);
    structureRoughness = mix(${wgslNumber(STRUCTURE_BASE_ROUGHNESS)}, structureNormalTexel.b, structureStrength);
    structureCavity = mix(1.0, structureNormalTexel.a, structureStrength);
    if (structureId == ${WINDOW_ID}u) { structureGlassMask = structureDetailTexel.a; }
    // The cotangent frame: the surface gradients of u and v, solved from the
    // screen derivatives (signed by the solve's determinant, so neither the
    // framebuffer's y direction nor the face's winding flips the bumps).
    let structureN = normalize(normalW);
    let structureDp2Perp = cross(structurePositionDy, structureN);
    let structureDp1Perp = cross(structureN, structurePositionDx);
    let structureSign = select(-1.0, 1.0, dot(structurePositionDx, structureDp2Perp) >= 0.0);
    let structureT = (structureDp2Perp * structureUvDx.x + structureDp1Perp * structureUvDy.x) * structureSign;
    let structureB = (structureDp2Perp * structureUvDx.y + structureDp1Perp * structureUvDy.y) * structureSign;
    let structureInvLength = inverseSqrt(max(max(dot(structureT, structureT), dot(structureB, structureB)), 1e-20));
    let structureTangentXy = (structureNormalTexel.rg * 2.0 - 1.0) * structureStrength;
    let structureTangentZ = sqrt(max(0.0, 1.0 - dot(structureTangentXy, structureTangentXy)));
    normalW = normalize((structureT * structureTangentXy.x + structureB * structureTangentXy.y) * structureInvLength
      + structureN * structureTangentZ);
  }
}
#endif
${WEATHERING_WGSL}
// Inside: no sun or moon, and only the indoor share of the sky.
let structureInside = fragmentInputs.structureColourIndoorV.a > ${wgslNumber(1e-3)};
let structureSunShare = select(1.0, 0.0, structureInside);
let structureSkyShare = select(1.0, clamp(fragmentInputs.structureColourIndoorV.a, 0.0, 1.0), structureInside);
`;

const FRAGMENT_INJECTIONS = Object.freeze({
  [TERRAIN_SURFACE_INJECTION_ANCHORS.sunLightColor]: /* wgsl */ `$1
#ifdef DIRLIGHT$2
diffuse$2 = vec4f(diffuse$2.rgb * structureSunShare, diffuse$2.a);
#endif
`,
  // Both anchors are in main alone (not the clustered helper; see the terrain's notes on them).
  [TERRAIN_SURFACE_INJECTION_ANCHORS.ambientOcclusion]: /* wgsl */ `$1
#ifdef STRUCTURE_TEXTURED
aoOut.ambientOcclusionColor *= vec3f(structureCavity);
#endif
`,
  [TERRAIN_SURFACE_INJECTION_ANCHORS.roughness]: /* wgsl */ `$1
#ifdef STRUCTURE_TEXTURED
roughness = structureRoughness;
#endif
`,
});

const FRAGMENT_BEFORE_FINAL_COLOR = /* wgsl */ `
#ifndef UNLIT
#ifdef REFLECTION
finalIrradiance *= structureSkyShare;
finalRadianceScaled *= structureSkyShare;
#endif
#endif
if (structureLitFace) {
  // A lit building: its windows' glass glows, its doorways and its rooms take a lamp's light.
  let structureLamp = vec3f(${STRUCTURE_LAMP_RGB.map((c) => wgslNumber(Math.fround(c))).join(", ")});
  let structureNight = uniforms.structureNight;
  let structureWindow = abs(structureSurfaceCode - ${wgslNumber(WINDOW_ID)}) < 0.5;
  let structureDoorway = abs(structureSurfaceCode - ${wgslNumber(DOORWAY_ID)}) < 0.5;
  // A doorway is the room behind it: a lamp-lit inside of a middling albedo, not the quad's daytime dark.
  let structureFlatGlow = select(0.0, structureNight.y * structureGlassMask, structureWindow)
    + select(0.0, structureNight.z * ${wgslNumber(STRUCTURE_DOORWAY_LAMP_SHARE * STRUCTURE_ROOM_ALBEDO)}, structureDoorway);
  let structureRoomLight = select(0.0, 0.5 + 0.5 * clamp(fragmentInputs.structureColourIndoorV.a, 0.0, 1.0), structureInside);
  finalEmissive += structureLamp * (vec3f(structureFlatGlow) + surfaceAlbedo * (structureNight.z * structureRoomLight));
}
`;

/** The kit's two material arrays as uploaded. */
export interface StructureTextureArrays {
  readonly detail: BaseTexture;
  readonly normal: BaseTexture;
}

export class StructureMaterialPlugin extends MaterialPluginBase {
  private bound: StructureMaterialBinding | null = null;
  private texturedNow: boolean;
  private arrays: StructureTextureArrays | null = null;
  private placeholders: StructureTextureArrays | null = null;
  private nightNow: StructureNightLighting = STRUCTURE_NIGHT_OFF;

  /** `textured`: the material reads the kit's arrays (never the glass). */
  constructor(material: Material, readonly role: StructureMaterialRole, textured = false) {
    super(material, "structure-surface", 195, { STRUCTURE_SURFACE: false, STRUCTURE_TEXTURED: false }, true, false);
    this.doNotSerialize = true;
    // Extra events before enabling, or hardBindForSubMesh never fires.
    this.registerForExtraEvents = true;
    this.texturedNow = textured && role !== "glass";
  }

  get textured(): boolean {
    return this.texturedNow;
  }

  /**
   * A profile change turns the arrays on or off: the defines change, and a
   * material the scene's priority froze after its first ready draw must be
   * told to prepare again (`markDirty(true)`).
   */
  setTextured(textured: boolean): void {
    const next = textured && this.role !== "glass";
    if (next === this.texturedNow) return;
    this.texturedNow = next;
    this.markAllDefinesAsDirty();
    this._material.markDirty(true);
  }

  /** The arrays to read; until they are in (or with null), flat 1 x 1 placeholders. Not disposed here. */
  setTextures(arrays: StructureTextureArrays | null): void {
    this.arrays = arrays;
  }

  get textures(): StructureTextureArrays | null {
    return this.arrays;
  }

  /** The buildings' lights for the next draws (`structureNightLighting`); off until set. */
  setNight(night: StructureNightLighting): void {
    this.nightNow = night;
  }

  get night(): StructureNightLighting {
    return this.nightNow;
  }

  /** What the next draws bind; the material is not drawn until one is set. */
  setBinding(binding: StructureMaterialBinding): void {
    const first = this.bound === null;
    this.bound = binding;
    if (first) this._enable(true);
  }

  get binding(): StructureMaterialBinding | null {
    return this.bound;
  }

  get ready(): boolean {
    return this.bound !== null;
  }

  override prepareDefines(defines: MaterialDefines): void {
    defines["STRUCTURE_SURFACE"] = true;
    defines["STRUCTURE_TEXTURED"] = this.texturedNow;
  }

  override getSamplers(samplers: string[]): void {
    for (const name of ["structureDetail", "structureNormal"]) if (!samplers.includes(name)) samplers.push(name);
  }

  override dispose(forceDisposeTextures?: boolean): void {
    this.placeholders?.detail.dispose();
    this.placeholders?.normal.dispose();
    this.placeholders = null;
    super.dispose(forceDisposeTextures);
  }

  override getClassName(): string {
    return "StructureMaterialPlugin";
  }

  /** WGSL-only, on the WGSL-only engine (the detail plugins' shape). */
  override isCompatible(): boolean {
    return true;
  }

  override getAttributes(attributes: string[]): void {
    for (const { kind } of Object.values(STRUCTURE_VERTEX_ATTRIBUTES)) {
      if (!attributes.includes(kind)) attributes.push(kind);
    }
  }

  override getUniforms(): { ubo: Array<{ name: string; size: number; type: string }> } {
    return {
      ubo: [
        { name: "structureCamera", size: 4, type: "vec4" },
        { name: "structureRanges", size: 4, type: "vec4" },
        { name: "structureDroppedA", size: 4, type: "vec4" },
        { name: "structureDroppedB", size: 4, type: "vec4" },
        { name: "structureDroppedC", size: 4, type: "vec4" },
        { name: "structureNight", size: 4, type: "vec4" },
      ],
    };
  }

  override hardBindForSubMesh(uniformBuffer: UniformBuffer): void {
    const binding = this.bound;
    if (!binding) return;
    if (this.texturedNow) {
      const arrays = this.arrays ?? this.placeholderArrays();
      uniformBuffer.setTexture("structureDetail", arrays.detail);
      uniformBuffer.setTexture("structureNormal", arrays.normal);
    }
    uniformBuffer.updateFloat4("structureCamera", binding.cameraX, binding.cameraZ, ROLE_ID[this.role], 0);
    uniformBuffer.updateFloat4(
      "structureRanges",
      binding.nearRadiusMeters,
      binding.bandMeters,
      binding.farRadiusMeters,
      Math.min(binding.thinNearRadiusMeters, binding.nearRadiusMeters),
    );
    const dropped = binding.dropped;
    const at = (index: number) => (index < dropped.length && index < STRUCTURE_OPEN_SLOTS * 2 ? dropped[index]! : NO_CENTRE);
    uniformBuffer.updateFloat4("structureDroppedA", at(0), at(1), at(2), at(3));
    uniformBuffer.updateFloat4("structureDroppedB", at(4), at(5), at(6), at(7));
    uniformBuffer.updateFloat4("structureDroppedC", at(8), at(9), at(10), at(11));
    const night = this.nightNow;
    uniformBuffer.updateFloat4("structureNight", night.litFraction, night.windowScene, night.lampScene, 0);
  }

  private placeholderArrays(): StructureTextureArrays {
    if (!this.placeholders) {
      const scene = this._material.getScene();
      const flat = (array: "detail" | "normal") => {
        const texel = structurePlaceholderTexel(array, STRUCTURE_BASE_ROUGHNESS);
        const texels = new Uint8Array(STRUCTURE_TEXTURE_LAYER_COUNT * 4);
        for (let layer = 0; layer < STRUCTURE_TEXTURE_LAYER_COUNT; layer += 1) texels.set(texel, layer * 4);
        const texture = new RawTexture2DArray(
          texels,
          1,
          1,
          STRUCTURE_TEXTURE_LAYER_COUNT,
          Constants.TEXTUREFORMAT_RGBA,
          scene,
          false,
          false,
          Texture.NEAREST_SAMPLINGMODE,
          Constants.TEXTURETYPE_UNSIGNED_BYTE,
        );
        texture.name = `structures-${array}-placeholder`;
        return texture;
      };
      this.placeholders = { detail: flat("detail"), normal: flat("normal") };
    }
    return this.placeholders;
  }

  override getCustomCode(shaderType: "vertex" | "fragment", shaderLanguage?: unknown): Nullable<Record<string, string>> {
    void shaderLanguage;
    if (shaderType === "vertex") {
      return {
        CUSTOM_VERTEX_DEFINITIONS: VERTEX_DEFINITIONS,
        CUSTOM_VERTEX_UPDATE_POSITION: VERTEX_UPDATE_POSITION,
      };
    }
    return {
      CUSTOM_FRAGMENT_DEFINITIONS: FRAGMENT_DEFINITIONS,
      CUSTOM_FRAGMENT_MAIN_BEGIN: FRAGMENT_MAIN_BEGIN,
      CUSTOM_FRAGMENT_BEFORE_LIGHTS: FRAGMENT_BEFORE_LIGHTS,
      CUSTOM_FRAGMENT_BEFORE_FINALCOLORCOMPOSITION: FRAGMENT_BEFORE_FINAL_COLOR,
      ...FRAGMENT_INJECTIONS,
    };
  }
}

/** The WGSL the plugin injects, for tests that pin its hooks. */
export const STRUCTURE_MATERIAL_WGSL = Object.freeze({
  vertexDefinitions: VERTEX_DEFINITIONS,
  vertexUpdatePosition: VERTEX_UPDATE_POSITION,
  fragmentDefinitions: FRAGMENT_DEFINITIONS,
  fragmentMainBegin: FRAGMENT_MAIN_BEGIN,
  fragmentBeforeLights: FRAGMENT_BEFORE_LIGHTS,
  fragmentBeforeFinalColor: FRAGMENT_BEFORE_FINAL_COLOR,
  fragmentInjections: FRAGMENT_INJECTIONS,
});
