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
// The detail materials carry no PBR textures, so the base vertex shader
// never declares uv or vMainUV1 — the plugin owns its own UV lane.
attribute uv: vec2f;
attribute atlasLayer: f32;
// One packed varying — PBR with 4-cascade shadows sits near the 16-location
// vertex output limit: (uv.x, uv.y, atlasLayer + fadeByte/512, modifier +
// occlusion·0.5). The 2-14 fade byte hides in the layer's fraction so the
// atlas path adds NO output location; layers stay ≤ 15, so layer + byte/512
// is exact in f32 and floor() recovers the integer.
varying detailAtlasData: vec4f;
#else
// Bark and rocks have output locations to spare — the fade byte rides its
// own lane there.
varying detailFadeByte: f32;
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
let detailWindPhaseRadians = vertexInputs.instanceState.z * 6.2831853;
let detailWindResponse = vertexInputs.instanceState.w;
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
#endif
// 2-13 — three-band wind, WORLD space (the absorbed single band bent in
// pre-rotation local axes, so a tree's sway direction spun with its yaw).
// Direction/strength/gust arrive from the shared src/world wind field
// sampled once per frame at the observer; the phase byte decorrelates
// instances, the response byte scales all three bands.
var detailSwayed = detailRotateByQuaternion(detailLocal, detailOrientation);
let detailWindDir = vec2f(uniforms.detailWind.x, uniforms.detailWind.y);
let detailWindCross = vec2f(-detailWindDir.y, detailWindDir.x);
let detailWindStrength = uniforms.detailWind.z
  * (1.0 + 0.35 * uniforms.detailWind.w
    * sin(uniforms.detailWindTime * 0.9 + detailWindPhaseRadians));
// Band 1 — trunk sway: slow whole-stem lean, mean deflection held downwind.
let detailTrunkAngle = uniforms.detailWindTime * (0.5 + 0.3 * uniforms.detailWind.z)
  + detailWindPhaseRadians;
let detailTrunkBend = detailTip * detailTip * detailWindResponse
  * detailWindStrength * detailHeight * 0.05;
detailSwayed += vec3f(detailWindDir.x, 0.0, detailWindDir.y)
  * (sin(detailTrunkAngle) * 0.7 + 0.3) * detailTrunkBend;
detailSwayed += vec3f(detailWindCross.x, 0.0, detailWindCross.y)
  * sin(detailTrunkAngle * 0.71 + 1.7) * detailTrunkBend * 0.3;
// Band 2 — branch flex: the absorbed 2-11a band retuned; taller trees flex
// slower, gust composite kept, now wind-aligned with cross-wind wobble.
let detailBranchSpeed = 1.35 - min(detailHeight, 36.0) * 0.012;
let detailBranchAngle = uniforms.detailWindTime * detailBranchSpeed + detailWindPhaseRadians;
let detailBranchGust = sin(detailBranchAngle)
  + 0.32 * sin(detailBranchAngle * 1.73 + vertexInputs.instanceState.y * 6.2831853);
let detailBranchBend = detailTip * detailWindResponse
  * detailWindStrength * detailHeight * 0.035;
detailSwayed += vec3f(detailWindDir.x, 0.0, detailWindDir.y)
  * detailBranchGust * detailBranchBend;
detailSwayed += vec3f(detailWindCross.x, 0.0, detailWindCross.y)
  * cos(detailBranchAngle * 0.83 + vertexInputs.instanceState.y * 3.1)
  * detailBranchBend * 0.58;
#ifdef DETAIL_FOLIAGE_ATLAS
// Band 3 — leaf flutter: high-frequency card jitter, spatially decorrelated
// through the card's local position so one crown shimmers rather than
// shifting as a block. Gust speeds the flutter, never the amplitude.
let detailFlutterPhase = dot(detailLocal.xz, vec2f(12.9898, 78.233))
  + detailLocal.y * 4.1 + detailWindPhaseRadians;
let detailFlutter = sin(uniforms.detailWindTime
  * (7.0 + 3.0 * uniforms.detailWind.w) + detailFlutterPhase);
detailSwayed += vec3f(detailWindDir.x, 0.35, detailWindDir.y)
  * detailFlutter * detailWindResponse * detailWindStrength * detailHeight * 0.006;
#endif
positionUpdated = detailSwayed + vertexInputs.instancePosition;
#ifdef DETAIL_FOLIAGE_ATLAS
// Baked crown occlusion rides the prototype's vertex-colour alpha; a dead
// top bleaches upward.
vertexOutputs.detailAtlasData = vec4f(
  vertexInputs.uv.x,
  vertexInputs.uv.y,
  vertexInputs.atlasLayer + floor(vertexInputs.instanceState.x * 255.0 + 0.5) / 512.0,
  detailModifierBits + clamp(vertexInputs.color.a, 0.0, 1.0) * 0.5,
);
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
vertexOutputs.detailFadeByte = floor(vertexInputs.instanceState.x * 255.0 + 0.5);
#endif
`,
  CUSTOM_VERTEX_UPDATE_NORMAL: `
#ifdef NORMAL
let detailNormalRadial = (0.5 + vertexInputs.instanceScale.y * 1.1)
  * uniforms.detailRadialAspect;
normalUpdated = detailRotateByQuaternion(
  normalize(normalUpdated * vec3f(1.0, detailNormalRadial, 1.0)),
  normalize(vertexInputs.instanceOrientation),
);
#endif
`,
});

const WGSL_FRAGMENT_CODE = Object.freeze({
  CUSTOM_FRAGMENT_DEFINITIONS: `
varying detailInstanceTint: vec4f;
#ifdef DETAIL_FOLIAGE_ATLAS
varying detailAtlasData: vec4f;
var foliageAtlasSampler: sampler;
var foliageAtlas: texture_2d_array<f32>;
#else
varying detailFadeByte: f32;
#endif

// 2-14 — ordered 8×8 Bayer threshold in [1/128, 127/128], the standard
// bit-interleave construction.
fn detailBayer8(pixel: vec2u) -> f32 {
  let x = pixel.x % 8u;
  let y = pixel.y % 8u;
  let xorBits = x ^ y;
  let index = ((y & 1u) << 5u) | ((xorBits & 1u) << 4u)
    | ((y & 2u) << 2u) | ((xorBits & 2u) << 1u)
    | ((y & 4u) >> 1u) | ((xorBits & 4u) >> 2u);
  return (f32(index) + 0.5) / 64.0;
}

// 2-14 — the LOD crossfade decision. Fade byte: 7-bit level, direction in
// bit 0. Outgoing survives bayer < fade; incoming survives bayer >= 1 −
// fade — EXACT complements under one shared pattern offset, so a stem mid-
// crossfade covers every pixel exactly once (a statistical complement
// double-draws the whole canopy at fade 0.5). The offset hashes the tint,
// which is per-stem and identical in BOTH bands; pixels are render-target
// coordinates, so a governor render-scale step cannot make the pattern
// swim against the output.
fn detailDitherSurvives(fadeByte: f32, pixel: vec2f, tintRgb: vec3f) -> bool {
  if (fadeByte >= 254.0) { return true; }
  if (fadeByte <= 1.0) { return false; }
  let incoming = fadeByte - floor(fadeByte / 2.0) * 2.0 >= 1.0;
  let fade = floor(fadeByte / 2.0) / 127.0;
  let hash = fract(dot(tintRgb, vec3f(12.9898, 78.233, 37.719)) * 43758.5453);
  let offset = vec2u(u32(hash * 5.0), u32(fract(hash * 7.0) * 5.0));
  let threshold = detailBayer8(vec2u(pixel) + offset);
  if (incoming) { return threshold >= 1.0 - fade; }
  return threshold < fade;
}
`,
  CUSTOM_FRAGMENT_UPDATE_ALBEDO: `
#ifdef DETAIL_FOLIAGE_ATLAS
let detailFadeByteDecoded = fract(fragmentInputs.detailAtlasData.z) * 512.0;
#else
let detailFadeByteDecoded = fragmentInputs.detailFadeByte;
#endif
if (!detailDitherSurvives(
  detailFadeByteDecoded,
  fragmentInputs.position.xy,
  fragmentInputs.detailInstanceTint.rgb,
)) { discard; }
#ifdef DETAIL_FOLIAGE_ATLAS
let detailModifierDecoded = floor(fragmentInputs.detailAtlasData.w);
let detailOcclusionDecoded = (fragmentInputs.detailAtlasData.w - detailModifierDecoded) * 2.0;
// Sampled UNCONDITIONALLY: WGSL forbids implicit-derivative samples in
// non-uniform control flow. Untextured vertices (layer −1) clamp to layer 0
// and simply ignore the texel.
let detailCard = textureSample(
  foliageAtlas,
  foliageAtlasSampler,
  fragmentInputs.detailAtlasData.xy,
  i32(floor(max(fragmentInputs.detailAtlasData.z, 0.0))),
);
if (fragmentInputs.detailAtlasData.z >= 0.0) {
  // 2-12: the shipping alpha test (Castano coverage preserved per mip in
  // the atlas bake); a thinned-crown modifier raises the threshold so the
  // canopy loses texels, not quads. 2-13a: the tint's ALPHA lane is the
  // seasonal leaf fraction — as deciduous crowns shed, the threshold lifts
  // toward 0.86 and the canopy decays to bare speckle, texel by texel.
  var detailAlphaTest = mix(0.86, 0.5, clamp(fragmentInputs.detailInstanceTint.a, 0.0, 1.0));
  if (detailModifierDecoded == 3.0) { detailAlphaTest = max(detailAlphaTest, 0.72); }
  if (detailCard.a < detailAlphaTest) { discard; }
  surfaceAlbedo = surfaceAlbedo * detailCard.rgb;
}
// Baked crown occlusion — interior leaves go dark, sunlit tips stay bright.
surfaceAlbedo = surfaceAlbedo * mix(0.42, 1.0, detailOcclusionDecoded);
#endif
surfaceAlbedo = surfaceAlbedo * fragmentInputs.detailInstanceTint.rgb;
`,
});

/** Builds the instance world transform and tint from the 32-byte record. */
export class DetailInstanceMaterialPlugin extends MaterialPluginBase {
  private timeSeconds = 0;
  private radialAspect = 1;
  private foliageAtlas: BaseTexture | null = null;
  /** 2-13: (dirX, dirZ, strength01, gust01) from the shared wind field. */
  private windDirectionX = 0.70710678;
  private windDirectionZ = 0.70710678;
  private windStrength = 0.25;
  private windGust = 0;

  constructor(material: PBRMaterial) {
    // enable=false at super: registerForExtraEvents must be set BEFORE
    // _enable or hardBindForSubMesh never registers (the cloud plugin's
    // exact constructor sequence) — without it the atlas texture is never
    // bound and the first foliage draw dies in createBindGroup.
    super(material, "detail-instance-transform", 190, { DETAIL_FOLIAGE_ATLAS: false }, true, false);
    this.doNotSerialize = true;
    this.registerForExtraEvents = true;
    this._enable(true);
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
    // forcedInstanceCount routes the draw through Babylon's thin-instance
    // path, which compiles PBR with INSTANCES/THIN_INSTANCES and rebuilds
    // finalWorld from world0..world3 instance attributes. No matrix buffer
    // exists by design (the 32-byte record IS the transform), so Babylon
    // binds its shared empty fallback buffer and every vertex collapses
    // through a zero matrix — full vertex cost, nothing rasterized. R-20's
    // spike missed this: it drove forcedInstanceCount through a
    // ShaderMaterial, which has no INSTANCES semantics. With instancing off
    // in the shader the mesh's own world matrix rides the classic uniform
    // path and the decoded record supplies the per-instance transform.
    defines["INSTANCES"] = false;
    defines["THIN_INSTANCES"] = false;
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

  /**
   * 2-13: the frame's wind snapshot — a unit XZ direction, a strength in
   * [0, 1] (speed over MAX_WIND_SPEED) and a gust scalar in [0, 1]. Sampled
   * once per frame from src/world's shared field at the observer; the
   * per-instance phase/response bytes supply all spatial variation.
   */
  setWind(directionX: number, directionZ: number, strength: number, gust: number): void {
    const length = Math.hypot(directionX, directionZ);
    if (Number.isFinite(length) && length > 1e-6) {
      this.windDirectionX = directionX / length;
      this.windDirectionZ = directionZ / length;
    }
    this.windStrength = Number.isFinite(strength) ? Math.min(1, Math.max(0, strength)) : 0;
    this.windGust = Number.isFinite(gust) ? Math.min(1, Math.max(0, gust)) : 0;
  }

  override getAttributes(attributes: string[]): void {
    for (const attribute of DETAIL_INSTANCE_ATTRIBUTES) {
      if (!attributes.includes(attribute.kind)) attributes.push(attribute.kind);
    }
    if (this.foliageAtlas) {
      if (!attributes.includes("uv")) attributes.push("uv");
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
        { name: "detailWind", size: 4, type: "vec4" },
      ],
    };
  }

  override bindForSubMesh(uniformBuffer: UniformBuffer): void {
    uniformBuffer.updateFloat("detailWindTime", this.timeSeconds);
    uniformBuffer.updateFloat("detailRadialAspect", this.radialAspect);
    uniformBuffer.updateFloat4(
      "detailWind",
      this.windDirectionX,
      this.windDirectionZ,
      this.windStrength,
      this.windGust,
    );
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
