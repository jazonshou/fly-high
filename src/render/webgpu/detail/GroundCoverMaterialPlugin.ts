import { MaterialPluginBase } from "@babylonjs/core/Materials/materialPluginBase";
import type { Material } from "@babylonjs/core/Materials/material";
import type { MaterialDefines } from "@babylonjs/core/Materials/materialDefines";
import type { UniformBuffer } from "@babylonjs/core/Materials/uniformBuffer";
import type { Nullable } from "@babylonjs/core/types";

/**
 * Wave G — the blade material plugin.
 *
 * The blade RECORD is the geometry: two instanced vec4 attributes carry the
 * root position, packed size, facing, bend/phase, harmonised ground albedo
 * and the terrain normal; the base mesh's `position.xy` is just `(side, t)`
 * along a quadratic Bézier ribbon the vertex stage evaluates. A zero-height
 * record collapses to the vertex kill — the compute writes every lane every
 * frame, so no counters or indirect draws exist anywhere in the path.
 *
 * Shading intent (wave-G research): the blade's base colour is the ground's
 * own harmonised albedo (the fade line has nothing to reveal), the shading
 * normal is curved across the width then blended toward the terrain normal
 * with range (specular anti-aliasing), and wind is a gust wave plus
 * per-blade flutter against the shared detail wind state.
 */
export class GroundCoverMaterialPlugin extends MaterialPluginBase {
  private windDirectionX = 1;
  private windDirectionZ = 0;
  private windStrength = 0;
  private windGust = 0;
  private windTime = 0;
  private cameraLocalX = 0;
  private cameraLocalY = 0;
  private cameraLocalZ = 0;

  constructor(material: Material) {
    super(
      material,
      "ground-cover-blades",
      195,
      { GROUND_COVER_BLADES: false },
      true,
      false,
    );
    this.doNotSerialize = true;
    // The 2-12 lesson, kept verbatim: extra events must be requested BEFORE
    // enabling or hardBindForSubMesh never fires.
    this.registerForExtraEvents = true;
    this._enable(true);
  }

  setWind(directionX: number, directionZ: number, strength: number, gust: number): void {
    const length = Math.hypot(directionX, directionZ);
    this.windDirectionX = length > 1e-6 ? directionX / length : 1;
    this.windDirectionZ = length > 1e-6 ? directionZ / length : 0;
    this.windStrength = Math.min(1, Math.max(0, strength));
    this.windGust = Math.min(1, Math.max(0, gust));
  }

  setWindTime(seconds: number): void {
    this.windTime = seconds;
  }

  setCameraLocal(x: number, y: number, z: number): void {
    this.cameraLocalX = x;
    this.cameraLocalY = y;
    this.cameraLocalZ = z;
  }

  override prepareDefines(defines: MaterialDefines): void {
    defines["GROUND_COVER_BLADES"] = true;
    // The 2-12-close discovery, verbatim: `forcedInstanceCount` routes PBR
    // through the thin-instance path, which compiles INSTANCES and rebuilds
    // finalWorld from world0..3 instance attributes — absent by design here,
    // so Babylon's empty-buffer fallback would zero every vertex (full
    // vertex cost, zero pixels). The record IS the transform.
    defines["INSTANCES"] = false;
    defines["THIN_INSTANCES"] = false;
  }

  override getClassName(): string {
    return "GroundCoverMaterialPlugin";
  }

  /** WGSL-only plugin on the WGSL-only engine (the detail plugin's shape). */
  override isCompatible(): boolean {
    return true;
  }

  override getAttributes(attributes: string[]): void {
    attributes.push("bladeA", "bladeB");
  }

  override getUniforms(): {
    ubo: Array<{ name: string; size: number; type: string }>;
  } {
    // Define-independent layout (the terrain plugin's rule).
    return {
      ubo: [
        { name: "groundWind", size: 4, type: "vec4" },
        { name: "groundCamera", size: 4, type: "vec4" },
      ],
    };
  }

  override bindForSubMesh(uniformBuffer: UniformBuffer): void {
    uniformBuffer.updateFloat4(
      "groundWind",
      this.windDirectionX,
      this.windDirectionZ,
      this.windStrength,
      this.windGust,
    );
    uniformBuffer.updateFloat4(
      "groundCamera",
      this.cameraLocalX,
      this.cameraLocalY,
      this.cameraLocalZ,
      this.windTime,
    );
  }

  override getCustomCode(
    shaderType: "vertex" | "fragment",
    shaderLanguage?: unknown,
  ): Nullable<Record<string, string>> {
    void shaderLanguage;
    if (shaderType === "vertex") {
      return {
        CUSTOM_VERTEX_DEFINITIONS: /* wgsl */ `
attribute bladeA: vec4f;
attribute bladeB: vec4u;
varying groundTint: vec4f;
`,
        CUSTOM_VERTEX_UPDATE_POSITION: /* wgsl */ `
let groundHeight = vertexInputs.bladeA.w;
if (groundHeight <= 0.002) {
  positionUpdated = vec3f(0.0, -100000.0, 0.0);
  vertexOutputs.groundTint = vec4f(0.0);
} else {
  let groundRoot = vertexInputs.bladeA.xyz;
  let groundFacing2 = unpack2x16float(vertexInputs.bladeB.x);
  let groundBendWidth = unpack2x16float(vertexInputs.bladeB.y);
  let groundAlbedo = unpack4x8unorm(vertexInputs.bladeB.z);
  let groundNormal2 = unpack2x16float(vertexInputs.bladeB.w);
  let groundTerrainNormal = vec3f(
    groundNormal2.x,
    sqrt(max(0.05, 1.0 - dot(groundNormal2, groundNormal2))),
    groundNormal2.y,
  );
  let groundT = clamp(positionUpdated.y, 0.0, 1.0);
  let groundSide = clamp(positionUpdated.x, -1.0, 1.0);
  // Wind: a travelling gust wave over the field plus per-blade flutter.
  let groundGustPhase = uniforms.groundCamera.w * 1.35
    + dot(groundRoot.xz, vec2f(0.101, 0.083))
    + groundAlbedo.a * 6.2831853;
  let groundFlutter = sin(uniforms.groundCamera.w * (5.5 + 3.0 * uniforms.groundWind.w)
    + groundAlbedo.a * 12.4);
  let groundWindAmount = uniforms.groundWind.z
    * (0.4 + 0.35 * sin(groundGustPhase) + 0.1 * groundFlutter);
  let groundLean = vec2f(groundFacing2.x, groundFacing2.y) * groundBendWidth.x
    + uniforms.groundWind.xy * groundWindAmount;
  let groundLeanLength = min(length(groundLean), 1.2);
  // Length-preserving tip: strong lean lowers the tip instead of stretching.
  let groundTipY = groundHeight * (1.0 - 0.32 * groundLeanLength * groundLeanLength);
  let groundTip = groundRoot + vec3f(
    groundLean.x * groundHeight,
    groundTipY,
    groundLean.y * groundHeight,
  );
  let groundMid = groundRoot
    + vec3f(groundLean.x * groundHeight * 0.22, groundHeight * 0.58, groundLean.y * groundHeight * 0.22);
  let groundOneMinusT = 1.0 - groundT;
  let groundSpine = groundRoot * (groundOneMinusT * groundOneMinusT)
    + groundMid * (2.0 * groundOneMinusT * groundT)
    + groundTip * (groundT * groundT);
  var groundTangent = normalize(
    (groundMid - groundRoot) * groundOneMinusT + (groundTip - groundMid) * groundT,
  );
  let groundFacing3 = vec3f(groundFacing2.x, 0.0, groundFacing2.y);
  var groundWidthDir = cross(groundTangent, groundFacing3);
  let groundWidthLength = length(groundWidthDir);
  if (groundWidthLength < 1e-4) {
    groundWidthDir = vec3f(-groundFacing2.y, 0.0, groundFacing2.x);
  } else {
    groundWidthDir = groundWidthDir / groundWidthLength;
  }
  let groundWidth = groundBendWidth.y * (1.0 - groundT * 0.82);
  positionUpdated = groundSpine + groundWidthDir * (groundSide * groundWidth);
  // Curved cross-section normal, blended toward the terrain normal with
  // range so distant grass stops sparkling and matches the ground shading.
  var groundBladeNormal = normalize(
    cross(groundWidthDir, groundTangent) + groundWidthDir * (groundSide * 0.55),
  );
  let groundRange = distance(groundRoot.xz, uniforms.groundCamera.xz);
  let groundNormalBlend = smoothstep(7.0, 42.0, groundRange);
  groundBladeNormal = normalize(mix(groundBladeNormal, groundTerrainNormal, groundNormalBlend));
  normalUpdated = groundBladeNormal;
  vertexOutputs.groundTint = vec4f(groundAlbedo.rgb, groundT);
}
`,
      };
    }
    return {
      CUSTOM_FRAGMENT_DEFINITIONS: /* wgsl */ `
varying groundTint: vec4f;
`,
      CUSTOM_FRAGMENT_UPDATE_ALBEDO: /* wgsl */ `
// Root-to-tip gradient over the harmonised ground albedo: shadowed base,
// lit tips — the cheap ambient-occlusion read every grass reference uses.
surfaceAlbedo = fragmentInputs.groundTint.rgb
  * mix(0.5, 1.32, pow(clamp(fragmentInputs.groundTint.w, 0.0, 1.0), 1.5));
`,
    };
  }
}
