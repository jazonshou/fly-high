import { MaterialPluginBase } from "@babylonjs/core/Materials/materialPluginBase";
import type { PBRMaterial } from "@babylonjs/core/Materials/PBR/pbrMaterial";
import { ShaderLanguage } from "@babylonjs/core/Materials/shaderLanguage";
import type { UniformBuffer } from "@babylonjs/core/Materials/uniformBuffer";

const WGSL_VERTEX_CODE = Object.freeze({
  CUSTOM_VERTEX_DEFINITIONS: `
attribute instanceWind: vec4f;
`,
  CUSTOM_VERTEX_UPDATE_POSITION: `
let detailWindTip = clamp(positionUpdated.y, 0.0, 1.0);
let detailWindSpeed = 1.35 - min(vertexInputs.instanceWind.z, 36.0) * 0.012;
let detailWindPhase = uniforms.detailWindTime * detailWindSpeed + vertexInputs.instanceWind.x;
let detailWindGust = sin(detailWindPhase) + 0.32 * sin(
  detailWindPhase * 1.73 + vertexInputs.instanceWind.w * 6.2831853
);
let detailWindBend = detailWindTip * detailWindTip * vertexInputs.instanceWind.y * 0.072;
positionUpdated.x += detailWindGust * detailWindBend;
positionUpdated.z += cos(detailWindPhase * 0.83 + vertexInputs.instanceWind.w * 3.1)
  * detailWindBend * 0.58;
`,
});

const GLSL_VERTEX_CODE = Object.freeze({
  CUSTOM_VERTEX_DEFINITIONS: `
attribute vec4 instanceWind;
`,
  CUSTOM_VERTEX_UPDATE_POSITION: `
float detailWindTip = clamp(positionUpdated.y, 0.0, 1.0);
float detailWindSpeed = 1.35 - min(instanceWind.z, 36.0) * 0.012;
float detailWindPhase = detailWindTime * detailWindSpeed + instanceWind.x;
float detailWindGust = sin(detailWindPhase)
  + 0.32 * sin(detailWindPhase * 1.73 + instanceWind.w * 6.2831853);
float detailWindBend = detailWindTip * detailWindTip * instanceWind.y * 0.072;
positionUpdated.x += detailWindGust * detailWindBend;
positionUpdated.z += cos(detailWindPhase * 0.83 + instanceWind.w * 3.1)
  * detailWindBend * 0.58;
`,
});

/** Lightweight per-vertex tree sway driven by deterministic instance data. */
export class DetailWindMaterialPlugin extends MaterialPluginBase {
  private timeSeconds = 0;

  constructor(material: PBRMaterial) {
    super(material, "detail-tree-wind", 190, undefined, true, true);
    this.doNotSerialize = true;
  }

  override getClassName(): string {
    return "DetailWindMaterialPlugin";
  }

  override isCompatible(): boolean {
    return true;
  }

  setTimeSeconds(value: number): void {
    this.timeSeconds = Number.isFinite(value) ? value : 0;
  }

  override getAttributes(attributes: string[]): void {
    if (!attributes.includes("instanceWind")) attributes.push("instanceWind");
  }

  override getUniforms(): {
    ubo: Array<{ name: string; size: number; type: string }>;
  } {
    return { ubo: [{ name: "detailWindTime", size: 1, type: "float" }] };
  }

  override bindForSubMesh(uniformBuffer: UniformBuffer): void {
    uniformBuffer.updateFloat("detailWindTime", this.timeSeconds);
  }

  override getCustomCode(
    shaderType: string,
    shaderLanguage = ShaderLanguage.GLSL,
  ): { [pointName: string]: string } | null {
    if (shaderType !== "vertex") return null;
    return shaderLanguage === ShaderLanguage.WGSL ? WGSL_VERTEX_CODE : GLSL_VERTEX_CODE;
  }
}
