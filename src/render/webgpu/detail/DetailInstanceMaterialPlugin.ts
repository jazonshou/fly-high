import { MaterialPluginBase } from "@babylonjs/core/Materials/materialPluginBase";
import type { MaterialDefines } from "@babylonjs/core/Materials/materialDefines";
import type { PBRMaterial } from "@babylonjs/core/Materials/PBR/pbrMaterial";
import { ShaderLanguage } from "@babylonjs/core/Materials/shaderLanguage";
import type { BaseTexture } from "@babylonjs/core/Materials/Textures/baseTexture";
import type { UniformBuffer } from "@babylonjs/core/Materials/uniformBuffer";
import { DETAIL_INSTANCE_ATTRIBUTES } from "./instanceFormat";

/**
 * 2-11a — decodes the 32-byte instance record and builds the world transform
 * in the vertex stage (no per-instance matrices exist anywhere). Absorbs
 * `DetailWindMaterialPlugin`: the sway that used to read a 16-byte
 * `instanceWind` float4 now reads two unorm8 lanes of `instanceState`, with
 * the height-based damping recomputed from the decoded height.
 *
 * WebGPU-only by design — the renderer never compiles GLSL (the absorbed
 * plugin's dead GLSL branch is deleted with it, per the plan).
 *
 * 0-9 incantation reminder for every attaching site: attach this plugin to
 * the PBRMaterial FIRST, then assign `material.shadowDepthWrapper` BEFORE
 * the material's first effect compiles.
 */

const WGSL_VERTEX_CODE = Object.freeze({
  CUSTOM_VERTEX_DEFINITIONS: `
attribute instancePosition: vec3f;
attribute instanceOrientation: vec4f;
attribute instanceScale: vec2f;
attribute instanceTint: vec4f;
attribute instanceState: vec4f;
varying detailInstanceTint: vec4f;
#ifdef DETAIL_FOLIAGE_ATLAS
attribute atlasLayer: f32;
varying detailAtlasLayer: f32;
varying detailOcclusion: f32;
varying detailModifier: f32;
#endif

fn detailRotateByQuaternion(v: vec3f, q: vec4f) -> vec3f {
  return v + 2.0 * cross(q.xyz, cross(q.xyz, v) + q.w * v);
}
`,
  CUSTOM_VERTEX_UPDATE_POSITION: `
let detailHeight = vertexInputs.instanceScale.x * 48.0;
// radialScale is a slenderness MULTIPLIER over [0.5, 1.6]; the prototype's
// own radius-per-height lives in the per-material aspect uniform (a trunk
// batch and a crown batch decode the same record differently on purpose).
let detailRadial = (0.5 + vertexInputs.instanceScale.y * 1.1) * uniforms.detailRadialAspect;
let detailOrientation = normalize(vertexInputs.instanceOrientation);
// Prototypes are unit-height; radial scale is a fraction of height.
let detailTip = clamp(positionUpdated.y, 0.0, 1.0);
var detailLocal = positionUpdated
  * vec3f(detailHeight * detailRadial, detailHeight, detailHeight * detailRadial);
// Absorbed wind sway (2-13 replaces this with the three-band model): phase
// arrives in turns, response in [0, 1]; taller instances sway slower.
let detailWindPhaseRadians = vertexInputs.instanceState.z * 6.2831853;
let detailWindResponse = vertexInputs.instanceState.w;
let detailWindSpeed = 1.35 - min(detailHeight, 36.0) * 0.012;
let detailWindAngle = uniforms.detailWindTime * detailWindSpeed + detailWindPhaseRadians;
let detailWindGust = sin(detailWindAngle)
  + 0.32 * sin(detailWindAngle * 1.73 + vertexInputs.instanceState.y * 6.2831853);
let detailWindBend = detailTip * detailTip * detailWindResponse * 0.072 * detailHeight;
detailLocal.x += detailWindGust * detailWindBend;
detailLocal.z += cos(detailWindAngle * 0.83 + vertexInputs.instanceState.y * 3.1)
  * detailWindBend * 0.58;
#ifdef DETAIL_FOLIAGE_ATLAS
// 2-12: character modifiers from the variant byte's high three bits — real
// stands are not all intact symmetric specimens, and this is the cheapest
// variance in the item. 0 intact · 1 lean · 2 broken top · 3 thinned crown
// (fragment raises the alpha test) · 4 dead top (broken + bleached tint).
let detailVariantByte = vertexInputs.instanceState.y * 255.0;
let detailModifierBits = floor(detailVariantByte / 32.0);
if (detailModifierBits == 1.0) {
  let detailLeanAngle = 0.10 + fract(vertexInputs.instanceState.z * 7.31) * 0.11;
  detailLocal.x += detailLocal.y * detailLeanAngle;
}
if (detailModifierBits == 2.0 || detailModifierBits == 4.0) {
  let detailBreak = detailHeight * 0.72;
  detailLocal.y = min(detailLocal.y, detailBreak + (detailLocal.y - detailBreak) * 0.06);
}
vertexOutputs.detailModifier = detailModifierBits;
vertexOutputs.detailAtlasLayer = vertexInputs.atlasLayer;
#endif
positionUpdated = detailRotateByQuaternion(detailLocal, detailOrientation)
  + vertexInputs.instancePosition;
#ifdef DETAIL_FOLIAGE_ATLAS
// Baked crown occlusion rides the prototype's vertex-colour alpha; a dead
// top bleaches upward.
vertexOutputs.detailOcclusion = vertexInputs.color.a;
var detailTintOut = vertexInputs.instanceTint;
if (detailModifierBits == 4.0) {
  let detailBleach = clamp((positionUpdated.y - vertexInputs.instancePosition.y)
    / max(detailHeight, 0.001) - 0.55, 0.0, 0.45) * 1.6;
  detailTintOut = vec4f(
    mix(detailTintOut.rgb, vec3f(0.71, 0.66, 0.55), detailBleach),
    detailTintOut.a,
  );
}
vertexOutputs.detailInstanceTint = detailTintOut;
#else
vertexOutputs.detailInstanceTint = vertexInputs.instanceTint
  * vec4f(1.0, 1.0, 1.0, 1.0);
#endif
`,
  CUSTOM_VERTEX_UPDATE_NORMAL: `
let detailNormalRadial = (0.5 + vertexInputs.instanceScale.y * 1.1)
  * uniforms.detailRadialAspect;
normalUpdated = detailRotateByQuaternion(
  normalize(normalUpdated * vec3f(1.0, detailNormalRadial, 1.0)),
  normalize(vertexInputs.instanceOrientation),
);
`,
});

const WGSL_FRAGMENT_CODE = Object.freeze({
  CUSTOM_FRAGMENT_DEFINITIONS: `
varying detailInstanceTint: vec4f;
#ifdef DETAIL_FOLIAGE_ATLAS
varying detailAtlasLayer: f32;
varying detailOcclusion: f32;
varying detailModifier: f32;
var foliageAtlasSampler: sampler;
var foliageAtlas: texture_2d_array<f32>;
#endif
`,
  CUSTOM_FRAGMENT_UPDATE_ALBEDO: `
#ifdef DETAIL_FOLIAGE_ATLAS
if (fragmentInputs.detailAtlasLayer >= 0.0) {
  let detailCard = textureSample(
    foliageAtlas,
    foliageAtlasSampler,
    fragmentInputs.vMainUV1,
    i32(fragmentInputs.detailAtlasLayer + 0.5),
  );
  // 2-12: the shipping alpha test (Castano coverage preserved per mip in
  // the atlas bake); a thinned-crown modifier raises the threshold so the
  // canopy loses texels, not quads.
  var detailAlphaTest = 0.5;
  if (fragmentInputs.detailModifier == 3.0) { detailAlphaTest = 0.72; }
  if (detailCard.a < detailAlphaTest) { discard; }
  surfaceAlbedo = surfaceAlbedo * detailCard.rgb;
}
// Baked crown occlusion — interior leaves go dark, sunlit tips stay bright.
surfaceAlbedo = surfaceAlbedo * mix(0.42, 1.0, fragmentInputs.detailOcclusion);
#endif
surfaceAlbedo = surfaceAlbedo * fragmentInputs.detailInstanceTint.rgb;
`,
});

/** Builds the instance world transform and tint from the 32-byte record. */
export class DetailInstanceMaterialPlugin extends MaterialPluginBase {
  private timeSeconds = 0;
  private radialAspect = 1;
  private foliageAtlas: BaseTexture | null = null;

  constructor(material: PBRMaterial) {
    super(material, "detail-instance-transform", 190, { DETAIL_FOLIAGE_ATLAS: false }, true, true);
    this.doNotSerialize = true;
    // Binding happens in hardBindForSubMesh (which requires this flag) —
    // the Z-1 per-submesh WebGPU material-context lesson.
    this.registerForExtraEvents = true;
  }

  /** The prototype's authored radius-per-height at multiplier 1. */
  setRadialAspect(value: number): void {
    this.radialAspect = Number.isFinite(value) && value > 0 ? value : 1;
  }

  /**
   * 2-12: enables the foliage-atlas path — array sampling by the mesh's
   * per-vertex `atlasLayer`, the shipping alpha test, baked occlusion, and
   * the variant byte's character modifiers.
   */
  setFoliageAtlas(texture: BaseTexture): void {
    this.foliageAtlas = texture;
    this.markAllDefinesAsDirty();
  }

  override prepareDefines(defines: MaterialDefines): void {
    defines["DETAIL_FOLIAGE_ATLAS"] = this.foliageAtlas !== null;
  }

  override getSamplers(samplers: string[]): void {
    if (!samplers.includes("foliageAtlas")) samplers.push("foliageAtlas");
  }

  override hardBindForSubMesh(uniformBuffer: UniformBuffer): void {
    if (this.foliageAtlas) {
      uniformBuffer.setTexture("foliageAtlas", this.foliageAtlas);
    }
  }

  override getClassName(): string {
    return "DetailInstanceMaterialPlugin";
  }

  override isCompatible(): boolean {
    return true;
  }

  setTimeSeconds(value: number): void {
    this.timeSeconds = Number.isFinite(value) ? value : 0;
  }

  override getAttributes(attributes: string[]): void {
    for (const attribute of DETAIL_INSTANCE_ATTRIBUTES) {
      if (!attributes.includes(attribute.kind)) attributes.push(attribute.kind);
    }
    if (this.foliageAtlas) {
      if (!attributes.includes("atlasLayer")) attributes.push("atlasLayer");
      if (!attributes.includes("color")) attributes.push("color");
    }
  }

  override getUniforms(): {
    ubo: Array<{ name: string; size: number; type: string }>;
  } {
    return {
      ubo: [
        { name: "detailWindTime", size: 1, type: "float" },
        { name: "detailRadialAspect", size: 1, type: "float" },
      ],
    };
  }

  override bindForSubMesh(uniformBuffer: UniformBuffer): void {
    uniformBuffer.updateFloat("detailWindTime", this.timeSeconds);
    uniformBuffer.updateFloat("detailRadialAspect", this.radialAspect);
  }

  override getCustomCode(
    shaderType: string,
    shaderLanguage = ShaderLanguage.GLSL,
  ): { [pointName: string]: string } | null {
    if (shaderLanguage !== ShaderLanguage.WGSL) return null;
    if (shaderType === "vertex") return { ...WGSL_VERTEX_CODE };
    if (shaderType === "fragment") return { ...WGSL_FRAGMENT_CODE };
    return null;
  }
}
