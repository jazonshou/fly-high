import { MaterialPluginBase } from "@babylonjs/core/Materials/materialPluginBase";
import type { PBRMaterial } from "@babylonjs/core/Materials/PBR/pbrMaterial";
import { ShaderLanguage } from "@babylonjs/core/Materials/shaderLanguage";
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
positionUpdated = detailRotateByQuaternion(detailLocal, detailOrientation)
  + vertexInputs.instancePosition;
vertexOutputs.detailInstanceTint = vertexInputs.instanceTint
  * vec4f(1.0, 1.0, 1.0, 1.0);
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
`,
  CUSTOM_FRAGMENT_UPDATE_ALBEDO: `
surfaceAlbedo = surfaceAlbedo * fragmentInputs.detailInstanceTint.rgb;
`,
});

/** Builds the instance world transform and tint from the 32-byte record. */
export class DetailInstanceMaterialPlugin extends MaterialPluginBase {
  private timeSeconds = 0;
  private radialAspect = 1;

  constructor(material: PBRMaterial) {
    super(material, "detail-instance-transform", 190, undefined, true, true);
    this.doNotSerialize = true;
  }

  /** The prototype's authored radius-per-height at multiplier 1. */
  setRadialAspect(value: number): void {
    this.radialAspect = Number.isFinite(value) && value > 0 ? value : 1;
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
