import type { Material } from "@babylonjs/core/Materials/material";
import type { MaterialDefines } from "@babylonjs/core/Materials/materialDefines";
import { MaterialPluginBase } from "@babylonjs/core/Materials/materialPluginBase";
import type { UniformBuffer } from "@babylonjs/core/Materials/uniformBuffer";
import type { Nullable } from "@babylonjs/core/types";
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
 * is all Low draws; the textured tiers add the kit's synthesised layers.
 *
 * INSIDE. A face with an indoor factor (`structureIndoor`, 0 outside; inside
 * about 0.15 in a corner to 1 by a window: an eye adapted indoors) sees no
 * sun or moon (their light is cut at each directional light's own colour,
 * `CUSTOM_LIGHT{X}_COLOR`, so lamps and clustered lights still reach it) and
 * only that share of the sky's ambient light and reflections. So rooms need
 * no second pipeline and no shadows to be dark where they should be.
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
  readonly bandMeters: number;
  readonly farRadiusMeters: number;
  /** Centres (x, z pairs, relative to the same origin) of buildings the near set drops, at most `STRUCTURE_OPEN_SLOTS`. */
  readonly dropped: readonly number[];
}

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
varying structureColourV: vec3f;
varying structureIndoorV: f32;
varying structureUvV: vec2f;
varying structureSurfaceV: f32;
// x: the share of the building drawn (0..1); y: 1 where the dither is the far blocks' (the complement).
varying structureDitherV: vec2f;

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
  var structureShare = 1.0;
  var structureComplement = 0.0;
  if (structureRole < 0.5) {
    // Far: in across the band past the near radius, out across the band inside the far one.
    structureShare = clamp((structureDistance - structureRanges.x) / structureBand, 0.0, 1.0)
      * clamp((structureRanges.z - structureDistance) / structureBand, 0.0, 1.0);
    structureComplement = 1.0;
  } else if (structureRole < 1.5) {
    structureShare = clamp((structureRanges.x + structureBand - structureDistance) / structureBand, 0.0, 1.0);
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
  vertexOutputs.structureDitherV = vec2f(structureShare, structureComplement);
}
vertexOutputs.structureColourV = vertexInputs.structureColour;
vertexOutputs.structureIndoorV = vertexInputs.structureIndoor;
vertexOutputs.structureUvV = vertexInputs.structureUv;
vertexOutputs.structureSurfaceV = vertexInputs.structureSurface;
`;

const FRAGMENT_DEFINITIONS = /* wgsl */ `
varying structureColourV: vec3f;
varying structureIndoorV: f32;
varying structureUvV: vec2f;
varying structureSurfaceV: f32;
varying structureDitherV: vec2f;

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
{
  let structureShare = fragmentInputs.structureDitherV.x;
  if (structureShare < 0.999) {
    let structureThreshold = structureBayer8(vec2u(fragmentInputs.position.xy));
    // Parenthesised: an unbracketed "a < b, c >= d" parses as a template list.
    let structureKeep = select(
      (structureThreshold < structureShare),
      (structureThreshold >= 1.0 - structureShare),
      (fragmentInputs.structureDitherV.y > 0.5),
    );
    if (!structureKeep) { discard; }
  }
}
`;

const FRAGMENT_BEFORE_LIGHTS = /* wgsl */ `
surfaceAlbedo = fragmentInputs.structureColourV;
// Inside: no sun or moon, and only the indoor share of the sky.
let structureInside = fragmentInputs.structureIndoorV > ${wgslNumber(1e-3)};
let structureSunShare = select(1.0, 0.0, structureInside);
let structureSkyShare = select(1.0, clamp(fragmentInputs.structureIndoorV, 0.0, 1.0), structureInside);
`;

const FRAGMENT_INJECTIONS = Object.freeze({
  [TERRAIN_SURFACE_INJECTION_ANCHORS.sunLightColor]: /* wgsl */ `$1
#ifdef DIRLIGHT$2
diffuse$2 = vec4f(diffuse$2.rgb * structureSunShare, diffuse$2.a);
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
`;

export class StructureMaterialPlugin extends MaterialPluginBase {
  private bound: StructureMaterialBinding | null = null;

  constructor(material: Material, readonly role: StructureMaterialRole) {
    super(material, "structure-surface", 195, { STRUCTURE_SURFACE: false }, true, false);
    this.doNotSerialize = true;
    // Extra events before enabling, or hardBindForSubMesh never fires.
    this.registerForExtraEvents = true;
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
      ],
    };
  }

  override hardBindForSubMesh(uniformBuffer: UniformBuffer): void {
    const binding = this.bound;
    if (!binding) return;
    uniformBuffer.updateFloat4("structureCamera", binding.cameraX, binding.cameraZ, ROLE_ID[this.role], 0);
    uniformBuffer.updateFloat4("structureRanges", binding.nearRadiusMeters, binding.bandMeters, binding.farRadiusMeters, 0);
    const dropped = binding.dropped;
    const at = (index: number) => (index < dropped.length && index < STRUCTURE_OPEN_SLOTS * 2 ? dropped[index]! : NO_CENTRE);
    uniformBuffer.updateFloat4("structureDroppedA", at(0), at(1), at(2), at(3));
    uniformBuffer.updateFloat4("structureDroppedB", at(4), at(5), at(6), at(7));
    uniformBuffer.updateFloat4("structureDroppedC", at(8), at(9), at(10), at(11));
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
