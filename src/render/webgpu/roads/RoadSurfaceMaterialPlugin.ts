import type { BaseTexture } from "@babylonjs/core/Materials/Textures/baseTexture";
import type { Material } from "@babylonjs/core/Materials/material";
import type { MaterialDefines } from "@babylonjs/core/Materials/materialDefines";
import { MaterialPluginBase } from "@babylonjs/core/Materials/materialPluginBase";
import type { UniformBuffer } from "@babylonjs/core/Materials/uniformBuffer";
import type { Nullable } from "@babylonjs/core/types";
import { ROAD_CLASS, roadClass } from "@/src/world/roads/roadClasses";
import {
  TERRAIN_DRAWN_HEIGHT_SAMPLERS,
  TERRAIN_DRAWN_HEIGHT_UNIFORMS,
  TERRAIN_DRAWN_HEIGHT_WGSL,
  type TerrainDrawnAtlasShape,
  type TerrainDrawnHeight,
} from "../terrain/TerrainDrawnHeight";
import {
  TERRAIN_MATERIAL_DETAIL_FULL_FOOTPRINT_METERS,
  TERRAIN_MATERIAL_DETAIL_ZERO_FOOTPRINT_METERS,
} from "../terrain/TerrainSurfacePlugin";
import { SURFACE_MATERIALS, SurfaceMaterial } from "../terrain/surfaceMaterials";
import { ROAD_RIBBON_CHUNK_METERS, ROAD_RIBBON_PAD_KIND } from "./roadSurfaceGeometry";

/**
 * The roads' drawn surfaces as PBR materials: the ribbons (running surface,
 * shoulders, a track's ruts, the sealed road's edge lines) and the
 * guardrails. One plugin, two roles; both lay their vertices on the ground as
 * the terrain DRAWS it this frame (`TerrainDrawnHeight`), so neither floats
 * over nor sinks under a facet whatever level of detail the terrain gives it.
 *
 * ON THE GROUND. A ribbon vertex takes the drawn height under it, lifted by
 * its kind's `ROAD_RIBBON_LIFTS` (a centimetre or two, the depth bias does
 * the rest), and the drawn surface's own gradient as its normal, so it is lit
 * as the terrain under it is. The lifts are ORDERED: a higher class lies a few
 * millimetres over a lower one, and a pad over every road that meets it, so
 * where two ribbons overlap (a crossing, a junction) the one that owns the
 * ground there wins the depth test rather than fighting it. A rail vertex
 * stands its own height (the surface lane) above the drawn ground; a rail
 * over ground the lookup does not hold is not drawn.
 *
 * WHAT A RIBBON LOOKS LIKE. Opaque, sampled from the terrain's own material
 * arrays (asphalt, gravel), planar, at their tiling periods, so the ribbon is
 * the material the splat paints under it, only sharp. Its edge is ragged:
 * loose stone spills up to `raggedMeters` past the formation, where the splat's
 * own feather takes over. A track draws its two ruts only (the sward between
 * and beside them is the terrain's). The sealed road carries white edge lines
 * inside its seal, faded with their footprint so they never alias.
 */

/** Lift over the drawn ground by class id, on a road and on a pad (each over every road that meets it), metres. */
export const ROAD_RIBBON_LIFTS = Object.freeze({
  road: Object.freeze([0.01, 0.0135, 0.017] as const),
  pad: Object.freeze([0.0125, 0.016, 0.0195] as const),
});

/** The lift of a surface lane's kind (class id, plus `ROAD_RIBBON_PAD_KIND` on a pad). */
export function roadRibbonLift(kind: number): number {
  const pad = kind >= ROAD_RIBBON_PAD_KIND;
  const classId = Math.min(2, Math.max(0, Math.round(pad ? kind - ROAD_RIBBON_PAD_KIND : kind)));
  return (pad ? ROAD_RIBBON_LIFTS.pad : ROAD_RIBBON_LIFTS.road)[classId]!;
}

/** The ribbons' markings and wear, metres. */
export const ROAD_RIBBON_LOOK = Object.freeze({
  /** How far past the formation a ragged edge may wander. */
  raggedMeters: 0.35,
  /** The ragged edge's wavelength along the road. */
  raggedWavelengthMeters: 1.3,
  /** Sealed: the white edge line's centre inside the seal's edge, and its width. */
  edgeLineInsetMeters: 0.22,
  edgeLineWidthMeters: 0.12,
  /** Linear albedo of road paint, worn. */
  edgeLineAlbedo: 0.55,
  /** Gravel: the two compacted wheel paths' centres either side, and their half width. */
  wheelPathOffsetMeters: 1.6,
  wheelPathHalfWidthMeters: 0.5,
  /** Track: the two ruts' centres either side, and their half width. */
  rutOffsetMeters: 0.85,
  rutHalfWidthMeters: 0.28,
  /** A rut is compacted fines: the gravel darkened toward bare earth. */
  rutTint: Object.freeze([0.8, 0.72, 0.6] as const),
});

/** The guardrail's galvanised steel. */
export const ROAD_RAIL_FINISH = Object.freeze({
  albedo: Object.freeze([0.56, 0.57, 0.58] as const),
  metallic: 0.75,
  roughness: 0.42,
});

/** What both roles bind: the lookup, the atlas its records index, and the meshes' anchor. */
export interface RoadSurfaceBinding {
  readonly lookup: TerrainDrawnHeight;
  readonly atlas: BaseTexture;
  readonly atlasShape: TerrainDrawnAtlasShape;
  /** Absolute world position of the meshes' local origin, metres: the corner of chunk (anchorCx, anchorCz). */
  readonly anchorX: number;
  readonly anchorZ: number;
  readonly anchorCx: number;
  readonly anchorCz: number;
}

export type RoadSurfaceRole = "ribbon" | "rail";

function wgslNumber(value: number): string {
  if (!Number.isFinite(value)) throw new RangeError("WGSL constants must be finite");
  return Number.isInteger(value) ? `${value}.0` : String(value);
}

function liftWgsl(): string {
  const table = (lifts: readonly number[], offset: number) => lifts.map((lift, classId) =>
    classId === lifts.length - 1
      ? `${offset > 0 ? "    " : "  "}return ${wgslNumber(lift)};`
      : `${offset > 0 ? "    " : "  "}if (kind < ${wgslNumber(offset + classId + 0.5)}) { return ${wgslNumber(lift)}; }`).join("\n");
  return `fn roadSurfaceLift(kind: f32) -> f32 {
  if (kind > ${wgslNumber(ROAD_RIBBON_PAD_KIND - 0.5)}) {
${table(ROAD_RIBBON_LIFTS.pad, ROAD_RIBBON_PAD_KIND)}
  }
${table(ROAD_RIBBON_LIFTS.road, 0)}
}`;
}

function material(id: number): { readonly inversePeriod: string; readonly reference: string } {
  const spec = SURFACE_MATERIALS[id]!;
  return {
    inversePeriod: wgslNumber(1 / spec.tilingPeriodMeters),
    reference: `vec3f(${spec.referenceAlbedo.map(wgslNumber).join(", ")})`,
  };
}

const SEALED = roadClass(ROAD_CLASS.airport);
const ASPHALT = material(SurfaceMaterial.Asphalt);
const GRAVEL = material(SurfaceMaterial.Gravel);
const LOOK = ROAD_RIBBON_LOOK;

const VERTEX_DEFINITIONS = /* wgsl */ `
attribute roadSurface: vec4f;
attribute roadChunk: vec2f;
varying roadSurfaceV: vec4f;
varying roadAbsolute: vec2f;
${TERRAIN_DRAWN_HEIGHT_WGSL}
${liftWgsl()}
`;

// A vertex is where its chunk built it, relative to the chunk's corner: the
// chunk's offset from the anchor's puts it in the mesh's frame.
const CHUNK_OFFSET = /* wgsl */ `
let roadChunkOffset = (vertexInputs.roadChunk - uniforms.roadAnchor.zw) * ${wgslNumber(ROAD_RIBBON_CHUNK_METERS)};
positionUpdated.x += roadChunkOffset.x;
positionUpdated.z += roadChunkOffset.y;
`;

const RIBBON_VERTEX = /* wgsl */ `${CHUNK_OFFSET}
let roadDrawn = terrainDrawnSurfaceAtLocal(positionUpdated.xz);
if (roadDrawn.valid) {
  positionUpdated.y = roadDrawn.height + roadSurfaceLift(vertexInputs.roadSurface.w);
  normalUpdated = normalize(vec3f(-roadDrawn.gradient.x, 1.0, -roadDrawn.gradient.y));
}
vertexOutputs.roadSurfaceV = vertexInputs.roadSurface;
vertexOutputs.roadAbsolute = positionUpdated.xz + uniforms.roadAnchor.xy;
`;

const RAIL_VERTEX = /* wgsl */ `${CHUNK_OFFSET}
let roadDrawn = terrainDrawnSurfaceAtLocal(positionUpdated.xz);
if (roadDrawn.valid) {
  positionUpdated.y = roadDrawn.height + vertexInputs.roadSurface.x;
} else {
  positionUpdated = vec3f(0.0, -100000.0, 0.0);
}
vertexOutputs.roadSurfaceV = vertexInputs.roadSurface;
vertexOutputs.roadAbsolute = positionUpdated.xz + uniforms.roadAnchor.xy;
`;

const RIBBON_FRAGMENT_DEFINITIONS = /* wgsl */ `
varying roadSurfaceV: vec4f;
varying roadAbsolute: vec2f;
var roadSurfaceAlbedoSampler: sampler;
var roadSurfaceAlbedo: texture_2d_array<f32>;
var roadSurfaceNormalSampler: sampler;
var roadSurfaceNormal: texture_2d_array<f32>;

fn roadSurfaceHash(point: vec2f) -> f32 {
  var value = fract(vec3f(point.x, point.y, point.x) * 0.1031);
  value += dot(value, value.yzx + vec3f(33.33));
  return fract((value.x + value.y) * value.z);
}

fn roadSurfaceValue(point: vec2f) -> f32 {
  let cell = floor(point);
  let local = fract(point);
  let blend = local * local * (vec2f(3.0) - 2.0 * local);
  return mix(
    mix(roadSurfaceHash(cell), roadSurfaceHash(cell + vec2f(1.0, 0.0)), blend.x),
    mix(roadSurfaceHash(cell + vec2f(0.0, 1.0)), roadSurfaceHash(cell + vec2f(1.0)), blend.x),
    blend.y,
  );
}

// 0..1, two octaves: the ragged edge's wander.
fn roadSurfaceRagged(point: vec2f) -> f32 {
  let scale = ${wgslNumber(1 / LOOK.raggedWavelengthMeters)};
  return roadSurfaceValue(point * scale) * 0.65 + roadSurfaceValue(point * (scale * 3.7) + vec2f(17.1, 3.3)) * 0.35;
}

// A line's coverage: 1 within halfWidth of 0, faded over the pixel's footprint.
fn roadSurfaceLine(distance: f32, halfWidth: f32, footprint: f32) -> f32 {
  return clamp((halfWidth - abs(distance)) / max(footprint, 1e-4) + 0.5, 0.0, 1.0)
    * clamp(halfWidth * 2.0 / max(footprint, 1e-4), 0.0, 1.0);
}

struct RoadSurfaceTexel {
  albedo: vec3f,
  // Tangent-space detail normal, hemisphere-decoded.
  normal: vec3f,
};

fn roadSurfaceTexel(layer: i32, inversePeriod: f32, reference: vec3f, position: vec2f,
    ddx: vec2f, ddy: vec2f, detailWeight: f32) -> RoadSurfaceTexel {
  let uv = position * inversePeriod;
  let albedo = textureSampleGrad(roadSurfaceAlbedo, roadSurfaceAlbedoSampler, uv, layer,
    ddx * inversePeriod, ddy * inversePeriod);
  let normal = textureSampleGrad(roadSurfaceNormal, roadSurfaceNormalSampler, uv, layer,
    ddx * inversePeriod, ddy * inversePeriod);
  var texel: RoadSurfaceTexel;
  // Array A stores sqrt(linear albedo) (SURFACE_ALBEDO_STORAGE_GAMMA).
  texel.albedo = mix(reference, albedo.rgb * albedo.rgb, detailWeight);
  let xy = (normal.xy * 2.0 - vec2f(1.0)) * detailWeight;
  texel.normal = vec3f(xy, sqrt(max(0.0, 1.0 - dot(xy, xy))));
  return texel;
}
`;

// Main-scope: everything later hooks read. Discards first, so a cut edge or
// the sward between a track's ruts costs no texture fetch.
const RIBBON_FRAGMENT_MAIN_BEGIN = /* wgsl */ `
let roadLanes = fragmentInputs.roadSurfaceV;
let roadKind = floor(roadLanes.w + 0.5);
let roadOnPad = roadKind > ${ROAD_RIBBON_PAD_KIND - 0.5};
let roadClassId = select(roadKind, roadKind - ${wgslNumber(ROAD_RIBBON_PAD_KIND)}, roadOnPad);
let roadAcross = abs(roadLanes.x);
let roadInFromEdge = roadLanes.z;
let roadPosition = fragmentInputs.roadAbsolute;
let roadDdx = dpdx(roadPosition);
let roadDdy = dpdy(roadPosition);
let roadFootprint = max(length(roadDdx), length(roadDdy));
let roadRagged = roadSurfaceRagged(roadPosition);
if (roadClassId < 0.5) {
  // A track: its two ruts, and nothing between or beside them.
  if (roadOnPad) { discard; }
  let roadRut = abs(roadAcross - ${wgslNumber(LOOK.rutOffsetMeters)});
  if (roadRut > ${wgslNumber(LOOK.rutHalfWidthMeters)} + (roadRagged - 0.5) * 0.16) { discard; }
} else if (roadInFromEdge < -${wgslNumber(LOOK.raggedMeters)} * roadRagged) {
  discard;
}
let roadDetailWeight = 1.0 - smoothstep(
  ${wgslNumber(TERRAIN_MATERIAL_DETAIL_FULL_FOOTPRINT_METERS)},
  ${wgslNumber(TERRAIN_MATERIAL_DETAIL_ZERO_FOOTPRINT_METERS)},
  roadFootprint,
);
// The sealed road's seal stops a shoulder in from its formation; its edge is
// laid by a machine, so it wanders a few centimetres, not decimetres.
let roadSealed = roadClassId > 1.5
  && roadInFromEdge > ${wgslNumber(SEALED.shoulderWidth)} + (roadRagged - 0.5) * 0.06;
var roadTexel: RoadSurfaceTexel;
if (roadSealed) {
  roadTexel = roadSurfaceTexel(${SurfaceMaterial.Asphalt}, ${ASPHALT.inversePeriod}, ${ASPHALT.reference},
    roadPosition, roadDdx, roadDdy, roadDetailWeight);
} else {
  roadTexel = roadSurfaceTexel(${SurfaceMaterial.Gravel}, ${GRAVEL.inversePeriod}, ${GRAVEL.reference},
    roadPosition, roadDdx, roadDdy, roadDetailWeight);
}
var roadAlbedo = roadTexel.albedo;
if (roadClassId < 0.5) {
  roadAlbedo = roadAlbedo * vec3f(${LOOK.rutTint.map(wgslNumber).join(", ")});
} else if (roadClassId < 1.5 && !roadOnPad) {
  // Gravel: two compacted wheel paths, darker and finer; loose stone between.
  let roadPath = roadSurfaceLine(roadAcross - ${wgslNumber(LOOK.wheelPathOffsetMeters)},
    ${wgslNumber(LOOK.wheelPathHalfWidthMeters)}, max(roadFootprint, 0.6));
  roadAlbedo = roadAlbedo * mix(1.04, 0.86, roadPath);
}
if (roadSealed && !roadOnPad) {
  let roadLineAt = ${wgslNumber(SEALED.shoulderWidth + LOOK.edgeLineInsetMeters)};
  let roadLine = roadSurfaceLine(roadInFromEdge - roadLineAt, ${wgslNumber(LOOK.edgeLineWidthMeters / 2)}, roadFootprint);
  roadAlbedo = mix(roadAlbedo, vec3f(${wgslNumber(LOOK.edgeLineAlbedo)}), roadLine * (0.85 + 0.15 * roadRagged));
}
`;

// Main's own albedo and normal, before the reflectivity block reads either:
// CUSTOM_FRAGMENT_UPDATE_ALBEDO is inside Babylon's albedo function, where
// nothing main declared is in scope. The detail normal goes on the drawn
// surface's own, in the planar XZ frame the terrain's planar materials use
// (TerrainSurfacePlugin's terrainSurfaceTangent).
const RIBBON_FRAGMENT_BEFORE_LIGHTS = /* wgsl */ `
surfaceAlbedo = roadAlbedo;
{
  let roadGeometric = normalize(normalW);
  let roadAxis = select(vec3f(1.0, 0.0, 0.0), vec3f(0.0, 0.0, 1.0), abs(roadGeometric.x) > 0.7);
  let roadTangent = normalize(roadAxis - roadGeometric * dot(roadAxis, roadGeometric));
  let roadBitangent = cross(roadTangent, roadGeometric);
  let roadRise = 1.0 / max(roadTexel.normal.z, 0.32);
  normalW = normalize(roadGeometric
    + roadTangent * (roadTexel.normal.x * roadRise)
    + roadBitangent * (roadTexel.normal.y * roadRise));
}
`;

const RAIL_FRAGMENT_DEFINITIONS = /* wgsl */ `
varying roadSurfaceV: vec4f;
varying roadAbsolute: vec2f;
`;

/** The material arrays a ribbon samples (the terrain's own; `TerrainClipmapSystem.surfaceMaterialArrays`). */
export interface RoadSurfaceArrays {
  readonly albedoHeight: BaseTexture;
  readonly normalMaterial: BaseTexture;
}

export class RoadSurfaceMaterialPlugin extends MaterialPluginBase {
  private bound: RoadSurfaceBinding | null = null;
  private arrays: RoadSurfaceArrays | null = null;

  constructor(material: Material, readonly role: RoadSurfaceRole) {
    super(material, `road-surface-${role}`, 190, { ROAD_SURFACE_RIBBON: false, ROAD_SURFACE_RAIL: false }, true, false);
    this.doNotSerialize = true;
    // Extra events before enabling, or hardBindForSubMesh never fires.
    this.registerForExtraEvents = true;
  }

  /** What the vertex stage reads; the material is not drawn until both this and (ribbons) the arrays are set. */
  setBinding(binding: RoadSurfaceBinding): void {
    this.bound = binding;
    this.updateEnabled();
  }

  get binding(): RoadSurfaceBinding | null {
    return this.bound;
  }

  setArrays(arrays: RoadSurfaceArrays | null): void {
    if (arrays === this.arrays) return;
    this.arrays = arrays;
    this.updateEnabled();
  }

  get ready(): boolean {
    return this.bound !== null && (this.role === "rail" || this.arrays !== null);
  }

  override prepareDefines(defines: MaterialDefines): void {
    defines["ROAD_SURFACE_RIBBON"] = this.role === "ribbon";
    defines["ROAD_SURFACE_RAIL"] = this.role === "rail";
  }

  override getClassName(): string {
    return "RoadSurfaceMaterialPlugin";
  }

  /** WGSL-only, on the WGSL-only engine (the detail plugins' shape). */
  override isCompatible(): boolean {
    return true;
  }

  override getAttributes(attributes: string[]): void {
    for (const name of ["roadSurface", "roadChunk"]) if (!attributes.includes(name)) attributes.push(name);
  }

  override getSamplers(samplers: string[]): void {
    const names = this.role === "ribbon"
      ? [...TERRAIN_DRAWN_HEIGHT_SAMPLERS, "roadSurfaceAlbedo", "roadSurfaceNormal"]
      : TERRAIN_DRAWN_HEIGHT_SAMPLERS;
    for (const name of names) if (!samplers.includes(name)) samplers.push(name);
  }

  override getUniforms(): { ubo: Array<{ name: string; size: number; type: string }> } {
    return {
      ubo: [
        ...TERRAIN_DRAWN_HEIGHT_UNIFORMS.map((uniform) => ({ ...uniform })),
        { name: "roadAnchor", size: 4, type: "vec4" },
      ],
    };
  }

  override hardBindForSubMesh(uniformBuffer: UniformBuffer): void {
    const binding = this.bound;
    if (!binding) return;
    binding.lookup.bind(uniformBuffer, binding.atlas, binding.atlasShape, binding.anchorX, binding.anchorZ);
    uniformBuffer.updateFloat4("roadAnchor", binding.anchorX, binding.anchorZ, binding.anchorCx, binding.anchorCz);
    if (this.role === "ribbon" && this.arrays) {
      uniformBuffer.setTexture("roadSurfaceAlbedo", this.arrays.albedoHeight);
      uniformBuffer.setTexture("roadSurfaceNormal", this.arrays.normalMaterial);
    }
  }

  override getCustomCode(shaderType: "vertex" | "fragment", shaderLanguage?: unknown): Nullable<Record<string, string>> {
    void shaderLanguage;
    if (shaderType === "vertex") {
      return {
        CUSTOM_VERTEX_DEFINITIONS: VERTEX_DEFINITIONS,
        CUSTOM_VERTEX_UPDATE_POSITION: this.role === "ribbon" ? RIBBON_VERTEX : RAIL_VERTEX,
      };
    }
    if (this.role === "rail") return { CUSTOM_FRAGMENT_DEFINITIONS: RAIL_FRAGMENT_DEFINITIONS };
    return {
      CUSTOM_FRAGMENT_DEFINITIONS: RIBBON_FRAGMENT_DEFINITIONS,
      CUSTOM_FRAGMENT_MAIN_BEGIN: RIBBON_FRAGMENT_MAIN_BEGIN,
      CUSTOM_FRAGMENT_BEFORE_LIGHTS: RIBBON_FRAGMENT_BEFORE_LIGHTS,
    };
  }

  private updateEnabled(): void {
    this._enable(this.ready);
  }
}

/** The WGSL each role injects, for tests that pin the hooks and the lift order. */
export const ROAD_SURFACE_WGSL = Object.freeze({
  lift: liftWgsl(),
  vertexDefinitions: VERTEX_DEFINITIONS,
  ribbonVertex: RIBBON_VERTEX,
  railVertex: RAIL_VERTEX,
  ribbonFragmentMainBegin: RIBBON_FRAGMENT_MAIN_BEGIN,
});
