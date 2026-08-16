import { MaterialPluginBase } from "@babylonjs/core/Materials/materialPluginBase";
import type { PBRMaterial } from "@babylonjs/core/Materials/PBR/pbrMaterial";
import { ShaderLanguage } from "@babylonjs/core/Materials/shaderLanguage";
import type { UniformBuffer } from "@babylonjs/core/Materials/uniformBuffer";

export const TERRAIN_MATERIAL_FRAGMENT_WGSL = Object.freeze({
  CUSTOM_FRAGMENT_DEFINITIONS: /* wgsl */ `
fn terrainHash(point: vec2f) -> f32 {
  var value = fract(vec3f(point.x, point.y, point.x) * 0.1031);
  value += dot(value, value.yzx + vec3f(33.33));
  return fract((value.x + value.y) * value.z);
}

fn terrainNoise(point: vec2f) -> f32 {
  let cell = floor(point);
  let local = fract(point);
  let blend = local * local * (vec2f(3.0) - 2.0 * local);
  return mix(
    mix(terrainHash(cell), terrainHash(cell + vec2f(1.0, 0.0)), blend.x),
    mix(terrainHash(cell + vec2f(0.0, 1.0)), terrainHash(cell + vec2f(1.0)), blend.x),
    blend.y,
  );
}

fn terrainFbm(point: vec2f) -> f32 {
  var position = point;
  var amplitude = 0.55;
  var result = 0.0;
  for (var octave = 0; octave < 3; octave += 1) {
    result += terrainNoise(position) * amplitude;
    position = mat2x2f(1.62, 1.17, -1.17, 1.62) * position + vec2f(13.1, 7.7);
    amplitude *= 0.48;
  }
  return result;
}

fn terrainTriplanarNoise(position: vec3f, normal: vec3f) -> f32 {
  var weight = pow(abs(normal), vec3f(4.0));
  weight /= max(weight.x + weight.y + weight.z, 0.0001);
  return terrainNoise(position.yz) * weight.x
    + terrainNoise(position.xz) * weight.y
    + terrainNoise(position.xy) * weight.z;
}
`,
  CUSTOM_FRAGMENT_BEFORE_LIGHTS: /* wgsl */ `
let terrainAbsolutePosition = vec3f(
  fragmentInputs.vPositionW.x + uniforms.terrainWorldOrigin.x,
  fragmentInputs.vPositionW.y,
  fragmentInputs.vPositionW.z + uniforms.terrainWorldOrigin.y,
);
let terrainSlope = 1.0 - clamp(abs(normalW.y), 0.0, 1.0);
let terrainMacro = terrainFbm(terrainAbsolutePosition.xz * 0.0025);
let terrainDetail = terrainNoise(terrainAbsolutePosition.xz * 0.14 + vec2f(19.7, 4.2));
let terrainStrata = 0.5 + 0.5 * sin(
  terrainAbsolutePosition.y * 0.075 + terrainMacro * 6.0
);
let terrainVariation = mix(0.82, 1.16, terrainMacro)
  * mix(0.92, 1.08, terrainDetail);
surfaceAlbedo *= terrainVariation;
let terrainRockTint = surfaceAlbedo * mix(
  vec3f(0.82, 0.78, 0.71),
  vec3f(1.08, 1.03, 0.94),
  terrainStrata,
);
surfaceAlbedo = mix(
  surfaceAlbedo,
  terrainRockTint,
  smoothstep(0.32, 0.82, terrainSlope) * 0.42,
);

let terrainCameraDistance = length(fragmentInputs.vPositionW - scene.vEyePosition.xyz);
let terrainMicroWeight = 1.0 - smoothstep(1200.0, 4200.0, terrainCameraDistance);
if (terrainMicroWeight > 0.001) {
  let terrainHelper = select(
    vec3f(0.0, 1.0, 0.0),
    vec3f(1.0, 0.0, 0.0),
    abs(normalW.y) > 0.92,
  );
  let terrainTangent = normalize(cross(terrainHelper, normalW));
  let terrainBitangent = normalize(cross(normalW, terrainTangent));
  let terrainMicroPosition = terrainAbsolutePosition * 0.72;
  let terrainMicro = terrainTriplanarNoise(terrainMicroPosition, normalW);
  let terrainMicroTangent = terrainTriplanarNoise(
    terrainMicroPosition + terrainTangent * 0.38,
    normalW,
  );
  let terrainMicroBitangent = terrainTriplanarNoise(
    terrainMicroPosition + terrainBitangent * 0.38,
    normalW,
  );
  normalW = normalize(
    normalW
      + terrainTangent * (terrainMicro - terrainMicroTangent) * 0.42 * terrainMicroWeight
      + terrainBitangent * (terrainMicro - terrainMicroBitangent) * 0.42 * terrainMicroWeight
  );
}
`,
});

export const TERRAIN_MATERIAL_FRAGMENT_GLSL = Object.freeze({
  CUSTOM_FRAGMENT_DEFINITIONS: /* glsl */ `
float terrainHash(vec2 point) {
  vec3 value = fract(vec3(point.x, point.y, point.x) * 0.1031);
  value += dot(value, value.yzx + 33.33);
  return fract((value.x + value.y) * value.z);
}

float terrainNoise(vec2 point) {
  vec2 cell = floor(point);
  vec2 local = fract(point);
  vec2 blend = local * local * (3.0 - 2.0 * local);
  return mix(
    mix(terrainHash(cell), terrainHash(cell + vec2(1.0, 0.0)), blend.x),
    mix(terrainHash(cell + vec2(0.0, 1.0)), terrainHash(cell + vec2(1.0)), blend.x),
    blend.y
  );
}

float terrainFbm(vec2 point) {
  vec2 position = point;
  float amplitude = 0.55;
  float result = 0.0;
  for (int octave = 0; octave < 3; octave += 1) {
    result += terrainNoise(position) * amplitude;
    position = mat2(1.62, 1.17, -1.17, 1.62) * position + vec2(13.1, 7.7);
    amplitude *= 0.48;
  }
  return result;
}

float terrainTriplanarNoise(vec3 position, vec3 normal) {
  vec3 weight = pow(abs(normal), vec3(4.0));
  weight /= max(weight.x + weight.y + weight.z, 0.0001);
  return terrainNoise(position.yz) * weight.x
    + terrainNoise(position.xz) * weight.y
    + terrainNoise(position.xy) * weight.z;
}
`,
  CUSTOM_FRAGMENT_BEFORE_LIGHTS: /* glsl */ `
vec3 terrainAbsolutePosition = vec3(
  vPositionW.x + terrainWorldOrigin.x,
  vPositionW.y,
  vPositionW.z + terrainWorldOrigin.y
);
float terrainSlope = 1.0 - clamp(abs(normalW.y), 0.0, 1.0);
float terrainMacro = terrainFbm(terrainAbsolutePosition.xz * 0.0025);
float terrainDetail = terrainNoise(terrainAbsolutePosition.xz * 0.14 + vec2(19.7, 4.2));
float terrainStrata = 0.5 + 0.5 * sin(terrainAbsolutePosition.y * 0.075 + terrainMacro * 6.0);
float terrainVariation = mix(0.82, 1.16, terrainMacro) * mix(0.92, 1.08, terrainDetail);
surfaceAlbedo *= terrainVariation;
vec3 terrainRockTint = surfaceAlbedo * mix(
  vec3(0.82, 0.78, 0.71),
  vec3(1.08, 1.03, 0.94),
  terrainStrata
);
surfaceAlbedo = mix(
  surfaceAlbedo,
  terrainRockTint,
  smoothstep(0.32, 0.82, terrainSlope) * 0.42
);

float terrainCameraDistance = length(vPositionW - vEyePosition.xyz);
float terrainMicroWeight = 1.0 - smoothstep(1200.0, 4200.0, terrainCameraDistance);
if (terrainMicroWeight > 0.001) {
  vec3 terrainHelper = abs(normalW.y) > 0.92 ? vec3(1.0, 0.0, 0.0) : vec3(0.0, 1.0, 0.0);
  vec3 terrainTangent = normalize(cross(terrainHelper, normalW));
  vec3 terrainBitangent = normalize(cross(normalW, terrainTangent));
  vec3 terrainMicroPosition = terrainAbsolutePosition * 0.72;
  float terrainMicro = terrainTriplanarNoise(terrainMicroPosition, normalW);
  float terrainMicroTangent = terrainTriplanarNoise(
    terrainMicroPosition + terrainTangent * 0.38,
    normalW
  );
  float terrainMicroBitangent = terrainTriplanarNoise(
    terrainMicroPosition + terrainBitangent * 0.38,
    normalW
  );
  normalW = normalize(
    normalW
      + terrainTangent * (terrainMicro - terrainMicroTangent) * 0.42 * terrainMicroWeight
      + terrainBitangent * (terrainMicro - terrainMicroBitangent) * 0.42 * terrainMicroWeight
  );
}
`,
});

/** Camera-stable macro geology and close-range triplanar micro-normal detail. */
export class TerrainMaterialPlugin extends MaterialPluginBase {
  private originX = 0;
  private originZ = 0;

  constructor(material: PBRMaterial) {
    super(material, "terrain-procedural-detail", 180, undefined, true, true);
    this.doNotSerialize = true;
  }

  override getClassName(): string {
    return "TerrainMaterialPlugin";
  }

  override isCompatible(): boolean {
    return true;
  }

  setWorldOrigin(x: number, z: number): void {
    this.originX = Number.isFinite(x) ? x : 0;
    this.originZ = Number.isFinite(z) ? z : 0;
  }

  override getUniforms(): {
    ubo: Array<{ name: string; size: number; type: string }>;
  } {
    return { ubo: [{ name: "terrainWorldOrigin", size: 2, type: "vec2" }] };
  }

  override bindForSubMesh(uniformBuffer: UniformBuffer): void {
    uniformBuffer.updateFloat2("terrainWorldOrigin", this.originX, this.originZ);
  }

  override getCustomCode(
    shaderType: string,
    shaderLanguage = ShaderLanguage.GLSL,
  ): { [pointName: string]: string } | null {
    if (shaderType !== "fragment") return null;
    return shaderLanguage === ShaderLanguage.WGSL
      ? TERRAIN_MATERIAL_FRAGMENT_WGSL
      : TERRAIN_MATERIAL_FRAGMENT_GLSL;
  }
}
