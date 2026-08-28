import { MaterialPluginBase } from "@babylonjs/core/Materials/materialPluginBase";
import type { MaterialDefines } from "@babylonjs/core/Materials/materialDefines";
import type { PBRMaterial } from "@babylonjs/core/Materials/PBR/pbrMaterial";
import { ShaderLanguage } from "@babylonjs/core/Materials/shaderLanguage";
import type { BaseTexture } from "@babylonjs/core/Materials/Textures/baseTexture";
import type { RenderTargetTexture } from "@babylonjs/core/Materials/Textures/renderTargetTexture";
import type { UniformBuffer } from "@babylonjs/core/Materials/uniformBuffer";
import {
  DETAIL_INSTANCE_ATTRIBUTES,
  DETAIL_INSTANCE_RADIAL_MAX,
  DETAIL_INSTANCE_RADIAL_MIN,
} from "./instanceFormat";
import {
  TREE_BARK_LAYER_MIN,
  TREE_BARK_LAYER_SPAN,
} from "./treePrototypeFamily";

/**
 * Wave Q: one frame's CSM state for the far band's hand-packed shadow
 * receiver. Assembled by the renderer from the atmosphere's generator (the
 * only CSM owner) and forwarded through WorldDetailRuntime unchanged.
 */
export interface DetailSunShadowSnapshot {
  /** Four cascade transform matrices, packed row-after-row (64 floats). */
  readonly matrices: Float32Array;
  /** The render camera's view matrix (16 floats). */
  readonly view: Float32Array;
  readonly splits: readonly [number, number, number, number];
  readonly blendStarts: readonly [number, number, number, number];
  readonly cascadeCount: number;
  readonly darkness: number;
  readonly shadowMaxZ: number;
  readonly valid: boolean;
  /** The generator's depth map; bound as a depth-comparison array. */
  readonly map: RenderTargetTexture | null;
}

/** World-space scale of one vertical bark-tile repeat on live tree trunks. */
export const DETAIL_TREE_BARK_REPEAT_METERS = 2;
/** sweepTube authors three normalized-height repeats before instance scaling. */
export const DETAIL_TREE_BARK_AUTHORED_V_REPEATS = 3;

/** CPU mirror of the tree-bark vertex transform, used by contract tests. */
export function detailMetricTreeBarkV(authoredV: number, treeHeightMeters: number): number {
  if (!Number.isFinite(authoredV) || !Number.isFinite(treeHeightMeters) || treeHeightMeters < 0) {
    throw new RangeError("Tree bark UV inputs must be finite and height non-negative");
  }
  return authoredV * treeHeightMeters
    / (DETAIL_TREE_BARK_AUTHORED_V_REPEATS * DETAIL_TREE_BARK_REPEAT_METERS);
}

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

/**
 * Rows in the per-species impostor bake table. Seven species today; the
 * eighth slot is the round-up to a power of two. The variant byte's high
 * three bits index it, so this cannot grow past eight without spending
 * instance-format bits — which is a decision, not an accident.
 */
export const DETAIL_IMPOSTOR_SPECIES_SLOTS = 8;

/** One species' bake frame: the square the billboard must reconstruct. */
export interface ImpostorSpeciesFrame {
  readonly extentUnit: number;
  readonly centerYUnit: number;
  readonly leafedLayer: number;
  readonly bareLayer: number;
}

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
#ifndef DETAIL_IMPOSTOR
// Bark and rocks have output locations to spare — the fade byte rides its
// own lane there. The impostor path carries its fade in detailImpostorA.z,
// so this lane must not exist there (it cost the 16th input slot).
varying detailFadeByte: f32;
#endif
#endif
#ifdef DETAIL_IMPOSTOR
// 2-17: the billboard quad's own lanes. Impostor meshes cannot take
// Babylon's CSM varyings (16-fragment-input limit — and at every tier they
// START inside the cascade reach, so they DO need sun shadow: the wave-Q
// hand-packed receiver below the frame decoder supplies it varying-free),
// which frees the cascade varyings these consume. detailImpostorA = (quadU, quadV, fadeByte, weightA);
// detailImpostorB = (tileA.uv, tileB.uv); detailImpostorC = (tileC.uv,
// weightB, mirror).
#ifndef DETAIL_FOLIAGE_ATLAS
attribute uv: vec2f;
#endif
varying detailImpostorA: vec4f;
varying detailImpostorB: vec4f;
varying detailImpostorC: vec4f;

// Hemi-octahedral encode — inverse of the bake's decode.
fn detailHemiOctaUv(direction: vec3f) -> vec2f {
  let norm = abs(direction.x) + max(direction.y, 0.0) + abs(direction.z);
  let px = direction.x / max(norm, 1e-5);
  let pz = direction.z / max(norm, 1e-5);
  return vec2f((px - pz) * 0.5 + 0.5, (px + pz) * 0.5 + 0.5);
}
#endif

fn detailRotateByQuaternion(v: vec3f, q: vec4f) -> vec3f {
  return v + 2.0 * cross(q.xyz, cross(q.xyz, v) + q.w * v);
}

#ifdef DETAIL_BAND_FADES
// TRUE when the instance does not own this camera range. Near and mid use a
// hard handoff halfway through the residency overlap: they share the exact
// same closed crown geometry, so a hard switch preserves the silhouette and
// avoids both opaque overlap and fragment discard. Far retains only the
// outer cull fade. Membership slack keeps both sides resident while chunks
// rebuild asynchronously.
fn detailBandWindowEmpty(bandCode: f32, instancePosition: vec3f, switchSeed: f32) -> bool {
  let bandRange = distance(instancePosition.xz, scene.vEyePosition.xz);
  let nearSwitch = uniforms.detailBandRadii.x - 50.0;
  let farSwitchHash = fract(switchSeed);
  let farSwitch = uniforms.detailBandRadii.y - 100.0 + farSwitchHash * 100.0;
  // Code 4: the MID-band leaf-card shell (wave T). Lives between the near
  // switch and the per-stem far switch; the fragment dissolves the near edge so
  // the near/mid card handoff and the impostor handoff both stay gradual.
  if (bandCode > 3.5) { return bandRange < nearSwitch || bandRange >= farSwitch; }
  // Code 3: the near-band card shell. Same hard vertex cull as near, but
  // the FRAGMENT dissolves it over the preceding 50 m (detailBandWindow), so
  // the cards never vanish in one frame at the switch radius.
  if (bandCode > 2.5) { return bandRange >= nearSwitch; }
  // Mid and far are not identical representations (skeletal mesh vs species
  // impostor), so a shared radial threshold makes an entire forest ring pop
  // in one frame. Both records carry the same stable wind-phase seed: use it
  // to distribute each stem's hard handoff across the existing 160 m
  // residency overlap. Tint is seasonal and must not move an LOD boundary.
  let fCull = clamp((uniforms.detailBandRadii.z - bandRange) / 420.0, 0.0, 1.0);
  if (bandCode < 0.5) { return bandRange >= nearSwitch; }
  if (bandCode < 1.5) { return bandRange < nearSwitch || bandRange >= farSwitch; }
  return bandRange < farSwitch || fCull <= 0.0;
}
#endif
`,
  CUSTOM_VERTEX_UPDATE_POSITION: `
// Gate B / 67d: instance positions are authored relative to the origin at
// upload time. During an amortized origin rebuild the owning mesh carries
// the built-origin -> current-origin translation; mirror that translation
// here for camera-distance and facing calculations that run before
// Babylon applies the mesh world matrix to positionUpdated.
let detailInstancePositionW = vertexInputs.instancePosition
  + uniforms.detailMeshOffset.xyz;
#ifdef DETAIL_IMPOSTOR
// 2-17 — cylindrical billboard + three-view hemi-octahedral selection.
// The quad prototype spans x,y ∈ [−1, 1]. Per-instance variety at zero
// atlas cost: the variant byte rotates the sampled view azimuth
// (view-phase offset) and mirrors the quad, so no two neighbours share
// both silhouette aspect and phase.
//
// Perf-debt pass: the byte's HIGH three bits now carry the SPECIES, and the
// bake frame (extent, centre, leafed layer, bare layer) is a per-species
// row of detailImpostorSpecies instead of a per-material uniform. That is
// what lets all seven species share one quad, one material and therefore
// ONE draw per presentation chunk — the far band spans by far the most
// chunks, so seven meshes there was the programme's largest draw-call line.
// The low five bits keep 2-17's per-stem hash exactly: bit 0 mirror,
// bits 1-2 view phase, bits 3-4 spare.
let impostorVariantByte = floor(vertexInputs.instanceState.y * 255.0 + 0.5);
let impostorSpeciesIndex = floor(impostorVariantByte / 32.0);
let impostorFrame = uniforms.detailImpostorSpecies[i32(impostorSpeciesIndex)];
let impostorHeight = vertexInputs.instanceScale.x * 48.0;
let impostorScale = impostorHeight * impostorFrame.x;
let impostorCenter = impostorHeight * impostorFrame.y;
let impostorToCamera = scene.vEyePosition.xyz - detailInstancePositionW;
var impostorFlat = vec2f(impostorToCamera.x, impostorToCamera.z);
let impostorFlatLength = max(length(impostorFlat), 1e-3);
impostorFlat = impostorFlat / impostorFlatLength;
let impostorRight = vec3f(-impostorFlat.y, 0.0, impostorFlat.x);
let impostorMirror = select(1.0, -1.0, fract(impostorVariantByte / 2.0) >= 0.5);
// The record already accounts for the baked source prototype's radial bound.
// Apply it exactly once; the atlas square's empty margin does not change the
// visible silhouette's source-prototype radius.
let impostorRadial = ${DETAIL_INSTANCE_RADIAL_MIN.toFixed(1)}
  + vertexInputs.instanceScale.y
    * ${(DETAIL_INSTANCE_RADIAL_MAX - DETAIL_INSTANCE_RADIAL_MIN).toFixed(1)};
positionUpdated = vec3f(0.0, 0.0, 0.0)
  + impostorRight * (positionUpdated.x * impostorScale * impostorRadial)
  + vec3f(0.0, positionUpdated.y * impostorScale + impostorCenter, 0.0)
  + vertexInputs.instancePosition;
#ifdef DETAIL_BAND_FADES
if (detailBandWindowEmpty(2.0, detailInstancePositionW, vertexInputs.instanceState.z)) {
  positionUpdated = vec3f(0.0, -100000.0, 0.0);
}
#endif
// View direction for tile selection — phase-rotated by the variant.
let impostorPhase = (floor(impostorVariantByte / 2.0) % 4.0) * 0.19635;
let impostorCos = cos(impostorPhase);
let impostorSin = sin(impostorPhase);
let impostorView = normalize(vec3f(
  -impostorToCamera.x * impostorCos + impostorToCamera.z * impostorSin,
  max(-impostorToCamera.y, 0.0) * 0.001 + max(impostorToCamera.y, 0.0),
  -impostorToCamera.x * impostorSin - impostorToCamera.z * impostorCos,
) * vec3f(-1.0, 1.0, -1.0));
let impostorUv = detailHemiOctaUv(impostorView);
// Three-view triangle in the 4×4 grid: the containing half-cell.
let impostorGrid = clamp(impostorUv * 4.0 - 0.5, vec2f(0.0), vec2f(3.0));
let impostorBase = floor(impostorGrid);
let impostorFrac = impostorGrid - impostorBase;
let impostorUpper = impostorFrac.x + impostorFrac.y > 1.0;
let cornerA = impostorBase + select(vec2f(0.0, 0.0), vec2f(1.0, 1.0), impostorUpper);
let cornerB = impostorBase + vec2f(1.0, 0.0);
let cornerC = impostorBase + vec2f(0.0, 1.0);
let weightA = select(1.0 - impostorFrac.x - impostorFrac.y,
  impostorFrac.x + impostorFrac.y - 1.0, impostorUpper);
let weightB = select(impostorFrac.x, 1.0 - impostorFrac.y, impostorUpper);
let quadU = clamp(positionUpdated.x * 0.0 + (vertexInputs.uv.x - 0.5) * impostorMirror + 0.5, 0.0, 1.0);
vertexOutputs.detailImpostorA = vec4f(
  quadU,
  vertexInputs.uv.y,
  floor(vertexInputs.instanceState.x * 255.0 + 0.5),
  weightA,
);
vertexOutputs.detailImpostorB = vec4f(cornerA * 0.25, cornerB * 0.25);
vertexOutputs.detailImpostorC = vec4f(cornerC * 0.25, weightB, impostorVariantByte);
vertexOutputs.detailInstanceTint = vertexInputs.instanceTint;
#else
let detailHeight = vertexInputs.instanceScale.x * 48.0;
// One radial convention: worldRadius = authored prototype radius * height *
// decoded multiplier. The CPU divides the desired radius by the exact
// prototype bound; applying another per-material aspect here would square it.
let detailRadial = ${DETAIL_INSTANCE_RADIAL_MIN.toFixed(1)}
  + vertexInputs.instanceScale.y
    * ${(DETAIL_INSTANCE_RADIAL_MAX - DETAIL_INSTANCE_RADIAL_MIN).toFixed(1)};
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
#ifdef DETAIL_OPAQUE_CROWN
// Dense closed crowns cannot seasonally shed with fragment discards without
// forfeiting the early-Z path that exists to make them playable. Deciduous
// broadleaf layer 16 instead contracts coherently toward the branch/trunk
// centre; conifer layer 17 stays evergreen. The character "thinned" modifier
// similarly changes the silhouette rather than punching screen-door holes.
let detailDenseLayer = floor(max(vertexInputs.atlasLayer, 0.0));
var detailDenseScale = 1.0;
if (detailDenseLayer == 16.0) {
  detailDenseScale = max(0.08, clamp(vertexInputs.instanceTint.a, 0.0, 1.0));
}
if (detailModifierBits == 3.0) { detailDenseScale = detailDenseScale * 0.76; }
// WGSL swizzles are values, not assignable l-values. Rebuild the vector so
// this opaque-crown permutation cannot invalidate the whole scene pipeline.
detailLocal = vec3f(
  detailLocal.x * detailDenseScale,
  detailLocal.y,
  detailLocal.z * detailDenseScale,
);
let detailCrownPivot = detailHeight * 0.42;
detailLocal.y = detailCrownPivot
  + (detailLocal.y - detailCrownPivot)
    * sqrt(detailDenseScale);
// Fix-pack F2: per-instance silhouette wobble. With tier 1's single variant
// per family, every crown in a stand shared one hull silhouette — the
// copy-paste forest. Two azimuth harmonics keyed to the instance's phase
// byte reshape the hull radially per stem at zero geometry cost. Scaling
// x/z only is watertight by construction: shared vertices share azimuth,
// and on-axis vertices are unmoved.
let detailWobbleAzimuth = atan2(detailLocal.z, detailLocal.x);
let detailWobble = 1.0
  + 0.085 * sin(detailWobbleAzimuth * 3.0 + detailWindPhaseRadians * 2.317)
  + 0.05 * sin(detailWobbleAzimuth * 7.0 + detailWindPhaseRadians * 5.61);
detailLocal = vec3f(
  detailLocal.x * detailWobble,
  detailLocal.y,
  detailLocal.z * detailWobble,
);
#endif
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
// Band 3 — leaf flutter: high-frequency jitter, spatially decorrelated
// through the local position so one crown shimmers rather than shifting as a
// block. Gust speeds the flutter, never the amplitude. Fix-pack F2: opaque
// hulls flutter too, at reduced amplitude — a rigid blob in wind was part of
// the reported plastic look — the vertex jitter is what a closed surface can
// afford without cracking (shared vertices share local position, so the
// displacement agrees along every edge).
#ifdef DETAIL_OPAQUE_CROWN
let detailFlutterAmplitude = 0.0035;
#else
let detailFlutterAmplitude = 0.006;
#endif
let detailFlutterPhase = dot(detailLocal.xz, vec2f(12.9898, 78.233))
  + detailLocal.y * 4.1 + detailWindPhaseRadians;
let detailFlutter = sin(uniforms.detailWindTime
  * (7.0 + 3.0 * uniforms.detailWind.w) + detailFlutterPhase);
detailSwayed += vec3f(detailWindDir.x, 0.35, detailWindDir.y)
  * detailFlutter * detailWindResponse * detailWindStrength
  * detailHeight * detailFlutterAmplitude;
#endif
positionUpdated = detailSwayed + vertexInputs.instancePosition;
#ifdef DETAIL_BAND_FADES
if (detailBandWindowEmpty(
  floor(vertexInputs.instanceState.x * 255.0 + 0.5) / 2.0,
  detailInstancePositionW,
  vertexInputs.instanceState.z,
)) { positionUpdated = vec3f(0.0, -100000.0, 0.0); }
#endif
#ifdef DETAIL_FOLIAGE_ATLAS
// Baked crown occlusion rides the prototype's vertex-colour alpha; a dead
// top bleaches upward.
var detailAtlasUvOut = vertexInputs.uv;
var detailAtlasLayerOut = vertexInputs.atlasLayer;
#if defined(DETAIL_BAND_FADES) && !defined(DETAIL_OPAQUE_CROWN)
// Tier-1 families share trunk geometry, not bark identity. Opaque tree bark
// owns the tint alpha lane, so decode its stable conifer/broadleaf/birch
// selector here without adding a material or draw. Tree bark also repeats in
// world metres: the authored V carries three repeats over unit height, so
// height / (3 * repeatMetres) removes the otherwise enormous 6-10 m streaks
// on mature trunks. Other bark consumers (logs/stumps) have no band define
// and retain their authored UVs.
if (detailAtlasLayerOut >= ${TREE_BARK_LAYER_MIN.toFixed(1)}
  && detailAtlasLayerOut <= ${(TREE_BARK_LAYER_MIN + TREE_BARK_LAYER_SPAN).toFixed(1)}) {
  let detailBarkSelector = floor(
    clamp(vertexInputs.instanceTint.a, 0.0, 1.0) * ${TREE_BARK_LAYER_SPAN.toFixed(1)} + 0.5);
  detailAtlasLayerOut = ${TREE_BARK_LAYER_MIN.toFixed(1)} + detailBarkSelector;
  detailAtlasUvOut.y = detailAtlasUvOut.y * detailHeight
    / ${(DETAIL_TREE_BARK_AUTHORED_V_REPEATS * DETAIL_TREE_BARK_REPEAT_METERS).toFixed(1)};
}
#endif
vertexOutputs.detailAtlasData = vec4f(
  detailAtlasUvOut.x,
  detailAtlasUvOut.y,
  detailAtlasLayerOut + floor(vertexInputs.instanceState.x * 255.0 + 0.5) / 512.0,
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
#endif
// Streaming fix-pack (defect C) — stochastic reveal for NEWLY CREATED batch
// meshes. detailMeshOffset.w is the mesh's reveal value: 1 everywhere by
// default (steady-state meshes skip this entirely), ramped 0 -> 1 over
// ~0.7 s by the runtime after a mesh's first publication flip. The
// per-instance threshold reuses the stable wind-phase byte
// (instanceState.z), scrambled so reveal order is uncorrelated with sway
// phase; the constant offset keeps zero-phase records (rocks, clutter) from
// all appearing in the first revealed frame. The collapse rides the
// existing vertex kill — NO fragment discard may implement this on the
// opaque-crown path, whose early-Z is the perf keystone.
if (uniforms.detailMeshOffset.w < 1.0
  && fract(vertexInputs.instanceState.z * 157.31 + 0.371) > uniforms.detailMeshOffset.w) {
  positionUpdated = vec3f(0.0, -100000.0, 0.0);
}
`,
  CUSTOM_VERTEX_UPDATE_NORMAL: `
#if defined(NORMAL) && !defined(DETAIL_IMPOSTOR)
let detailNormalRadial = ${DETAIL_INSTANCE_RADIAL_MIN.toFixed(1)}
  + vertexInputs.instanceScale.y
    * ${(DETAIL_INSTANCE_RADIAL_MAX - DETAIL_INSTANCE_RADIAL_MIN).toFixed(1)};
var detailNormalDenseY = 1.0;
#ifdef DETAIL_OPAQUE_CROWN
// Position scales are (radial*dense, sqrt(dense), radial*dense).
// After dropping the common inverse factor, the inverse-transpose normal
// scale is (1, radial*sqrt(dense), 1).
detailNormalDenseY = sqrt(detailDenseScale);
#endif
normalUpdated = detailRotateByQuaternion(
  normalize(normalUpdated * vec3f(1.0, detailNormalRadial * detailNormalDenseY, 1.0)),
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
#ifndef DETAIL_IMPOSTOR
varying detailFadeByte: f32;
#endif
#endif
#ifdef DETAIL_IMPOSTOR
varying detailImpostorA: vec4f;
varying detailImpostorB: vec4f;
varying detailImpostorC: vec4f;
var impostorAlbedoSampler: sampler;
var impostorAlbedo: texture_2d_array<f32>;
var impostorNormalDepthSampler: sampler;
var impostorNormalDepth: texture_2d_array<f32>;

// Tile origin for one view, in the atlas's 4x4 grid.
fn detailImpostorTileUv(tileOrigin: vec2f, quadUv: vec2f) -> vec2f {
  return tileOrigin + clamp(quadUv, vec2f(0.002), vec2f(0.998)) * 0.25;
}

// One view's sample, season-blended between the leafed and bare layers.
// The layer pair arrives per INSTANCE now (the species rides the variant
// byte), so a single material serves every species.
fn detailImpostorSample(
  tileOrigin: vec2f,
  quadUv: vec2f,
  layers: vec2f,
  seasonSelector: f32,
) -> vec4f {
  let uv = detailImpostorTileUv(tileOrigin, quadUv);
  let leafed = textureSample(impostorAlbedo, impostorAlbedoSampler, uv, i32(layers.x));
  let bare = textureSample(impostorAlbedo, impostorAlbedoSampler, uv, i32(layers.y));
  // The bake is straight-alpha with RGB dilation. Convert each bucket to
  // premultiplied form BEFORE any view blend, otherwise silhouette
  // disagreement leaves coloured RGB at low alpha and the final unpremultiply
  // produces bright fringes. Season changes pick one whole distant stem at a
  // stable per-instance threshold instead of making every deciduous pixel in
  // the world vanish together when a global alpha mix crosses 0.5.
  let leafedPremultiplied = vec4f(leafed.rgb * leafed.a, leafed.a);
  let barePremultiplied = vec4f(bare.rgb * bare.a, bare.a);
  return select(
    leafedPremultiplied,
    barePremultiplied,
    uniforms.detailImpostorSeason > seasonSelector,
  );
}

// The per-fragment species row, decoded from the interpolated variant byte.
fn detailImpostorFrame() -> vec4f {
  let variant = floor(fragmentInputs.detailImpostorC.w + 0.5);
  return uniforms.detailImpostorSpecies[i32(floor(variant / 32.0))];
}

// Wave Q (tree-cutoff fix): a hand-packed CSM receiver for the far band.
// Impostors begin 260-400 m INSIDE the cascade reach at every tier, and
// with receiveShadows the geometry bands have while the impostor cannot
// (Babylon's CSM varyings overflow the 16-fragment-input limit on this
// bundle — the compile-test contract), the mid->far handoff was a binary
// full-shadow -> no-shadow cliff across every dusk forest. This is the
// water system's receiver (SunShadowReceiver.ts) recomputed entirely in
// the fragment stage from vPositionW: zero extra fragment inputs.
#ifdef DETAIL_SUN_SHADOW
var detailSunShadowMapSampler: sampler_comparison;
var detailSunShadowMap: texture_depth_2d_array;

fn detailSunShadowCascade(cascade: i32, world: vec3f) -> f32 {
  let projected = uniforms.detailSunShadowMatrices[cascade] * vec4f(world, 1.0);
  let clip = projected.xyz / max(abs(projected.w), 0.000001);
  let uv = clip.xy * 0.5 + vec2f(0.5);
  if (uv.x <= 0.0 || uv.x >= 1.0 || uv.y <= 0.0 || uv.y >= 1.0
    || clip.z < 0.0 || clip.z > 1.0) {
    return 1.0;
  }
  let compared = textureSampleCompareLevel(
    detailSunShadowMap,
    detailSunShadowMapSampler,
    uv,
    cascade,
    clamp(clip.z, 0.0, 0.99999994),
  );
  return mix(uniforms.detailSunShadowParams.y, 1.0, compared);
}

fn detailSunShadow(world: vec3f) -> f32 {
  if (uniforms.detailSunShadowParams.z < 0.5) { return 1.0; }
  let viewDepth = max(-(uniforms.detailSunShadowView * vec4f(world, 1.0)).z, 0.0);
  let cascadeCount = i32(uniforms.detailSunShadowParams.x + 0.5);
  var cascade = 0;
  if (viewDepth > uniforms.detailSunShadowSplits.x) { cascade = 1; }
  if (viewDepth > uniforms.detailSunShadowSplits.y) { cascade = 2; }
  if (viewDepth > uniforms.detailSunShadowSplits.z) { cascade = 3; }
  if (viewDepth > uniforms.detailSunShadowSplits.w) { cascade = 4; }
  if (cascade >= cascadeCount) { return 1.0; }
  let current = detailSunShadowCascade(cascade, world);
  // Unlike Babylon's hard stop at shadowMaxZ, fade the term out over the
  // last stretch so the cascade boundary never draws its own line on the
  // forest — the exact artifact this receiver exists to remove.
  let maxZ = uniforms.detailSunShadowParams.w;
  let fade = smoothstep(maxZ * 0.82, maxZ, viewDepth);
  return mix(current, 1.0, fade);
}
#endif
#endif

#ifdef DETAIL_OPAQUE_CROWN
// Fix-pack F1: world-locked value noise with analytic gradient for the
// leaf-cluster shading on closed crown hulls. Same construction as the
// terrain surface's — a hash lattice under a smoothstep bilinear.
fn detailClusterHash(point: vec2f) -> f32 {
  var value = fract(vec3f(point.x, point.y, point.x) * 0.1031);
  value += dot(value, value.yzx + vec3f(33.33));
  return fract((value.x + value.y) * value.z);
}

fn detailClusterGrad(point: vec2f) -> vec3f {
  let cell = floor(point);
  let local = fract(point);
  let blend = local * local * (vec2f(3.0) - 2.0 * local);
  let slope = 6.0 * local * (vec2f(1.0) - local);
  let a = detailClusterHash(cell);
  let b = detailClusterHash(cell + vec2f(1.0, 0.0));
  let c = detailClusterHash(cell + vec2f(0.0, 1.0));
  let d = detailClusterHash(cell + vec2f(1.0));
  return vec3f(
    mix(mix(a, b, blend.x), mix(c, d, blend.x), blend.y),
    mix(b - a, d - c, blend.y) * slope.x,
    mix(c - a, d - b, blend.x) * slope.y,
  );
}
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

#ifdef DETAIL_BAND_FADES
// The vertex helper owns the hard switch from the stem centre. Re-evaluating
// that edge per fragment clips half a billboard as its centre crosses the
// boundary. Near/mid fragments therefore survive wholesale; far fragments
// dither only through the outer 420 m cull edge.
fn detailBandWindow(bandCode: f32, positionW: vec3f, pixel: vec2f, tintRgb: vec3f) -> bool {
  // Code 4 — the mid-band card shell (wave T): dither IN over the 50 m after
  // the near switch (exact complement of code 3's dither OUT, same Bayer and
  // hash, so the near/mid card handoff covers every pixel exactly once). The
  // far edge is the vertex window's per-stem hashed switch, same as mid bark.
  if (bandCode > 3.5) {
    let cardRange = distance(positionW.xz, scene.vEyePosition.xz);
    let nearEdge = uniforms.detailBandRadii.x - 50.0;
    let inFade = clamp((nearEdge - cardRange) / 50.0, 0.0, 1.0);
    let cardHash = fract(dot(tintRgb, vec3f(12.9898, 78.233, 37.719)) * 43758.5453);
    let cardOffset = vec2u(u32(cardHash * 5.0), u32(fract(cardHash * 7.0) * 5.0));
    if (inFade > 0.0) {
      // Complement of code 3's survival: threshold >= fade keeps the pixels
      // the outgoing near cards released.
      return detailBayer8(vec2u(pixel) + cardOffset) >= inFade;
    }
    return true;
  }
  // Code 3 — the near card shell's dither dissolve over the last 50 m of the
  // near band. Without it every stem's cards popped off in one frame at the
  // switch radius (the reported "trees jump").
  if (bandCode > 2.5) {
    let fringeRange = distance(positionW.xz, scene.vEyePosition.xz);
    let fringeEdge = uniforms.detailBandRadii.x - 50.0;
    let fringeFade = clamp((fringeEdge - fringeRange) / 50.0, 0.0, 1.0);
    if (fringeFade >= 1.0) { return true; }
    if (fringeFade <= 0.0) { return false; }
    let fringeHash = fract(dot(tintRgb, vec3f(12.9898, 78.233, 37.719)) * 43758.5453);
    let fringeOffset = vec2u(u32(fringeHash * 5.0), u32(fract(fringeHash * 7.0) * 5.0));
    return detailBayer8(vec2u(pixel) + fringeOffset) < fringeFade;
  }
  if (bandCode < 1.5) { return true; }
  let bandRange = distance(positionW.xz, scene.vEyePosition.xz);
  let fCull = clamp((uniforms.detailBandRadii.z - bandRange) / 420.0, 0.0, 1.0);
  if (fCull <= 0.0) { return false; }
  if (fCull >= 1.0) { return true; }
  let hash = fract(dot(tintRgb, vec3f(12.9898, 78.233, 37.719)) * 43758.5453);
  let offset = vec2u(u32(hash * 5.0), u32(fract(hash * 7.0) * 5.0));
  let threshold = detailBayer8(vec2u(pixel) + offset);
  return threshold < fCull;
}
#endif
`,
  CUSTOM_FRAGMENT_UPDATE_ALBEDO: `
#ifdef DETAIL_IMPOSTOR
// 2-17: three-view barycentric blend — the view snap that makes cheap
// impostors flicker under bank is averaged away across the containing
// grid triangle. All three samples are unconditional (uniform control
// flow); the dither fade shares 2-14's exact machinery.
#ifdef DETAIL_BAND_FADES
if (!detailBandWindow(
  2.0,
  fragmentInputs.vPositionW,
  fragmentInputs.position.xy,
  fragmentInputs.detailInstanceTint.rgb,
)) { discard; }
#else
if (!detailDitherSurvives(
  fragmentInputs.detailImpostorA.z,
  fragmentInputs.position.xy,
  fragmentInputs.detailInstanceTint.rgb,
)) { discard; }
#endif
let impostorQuadUv = vec2f(
  fragmentInputs.detailImpostorA.x,
  1.0 - fragmentInputs.detailImpostorA.y,
);
let impostorLayers = detailImpostorFrame().zw;
// Low five variant bits are the stable per-stem identity hash. Tint is not:
// seasonal colour transforms change it, which would reshuffle which distant
// trees are leafed every time a cell regenerates.
let impostorVariantByteForSeason = floor(fragmentInputs.detailImpostorC.w + 0.5);
let impostorSeasonSelector = (
  impostorVariantByteForSeason - floor(impostorVariantByteForSeason / 32.0) * 32.0 + 0.5
) / 32.0;
let impostorSampleA = detailImpostorSample(
  fragmentInputs.detailImpostorB.xy, impostorQuadUv, impostorLayers, impostorSeasonSelector);
let impostorSampleB = detailImpostorSample(
  fragmentInputs.detailImpostorB.zw, impostorQuadUv, impostorLayers, impostorSeasonSelector);
let impostorSampleC = detailImpostorSample(
  fragmentInputs.detailImpostorC.xy, impostorQuadUv, impostorLayers, impostorSeasonSelector);
let impostorWeightA = clamp(fragmentInputs.detailImpostorA.w, 0.0, 1.0);
let impostorWeightB = clamp(fragmentInputs.detailImpostorC.z, 0.0, 1.0);
let impostorWeightC = clamp(1.0 - impostorWeightA - impostorWeightB, 0.0, 1.0);
let impostorBlend = impostorSampleA * impostorWeightA
  + impostorSampleB * impostorWeightB
  + impostorSampleC * impostorWeightC;
if (impostorBlend.a < 0.5) { discard; }
surfaceAlbedo = impostorBlend.rgb / max(impostorBlend.a, 0.25)
  * fragmentInputs.detailInstanceTint.rgb;
#else
#ifdef DETAIL_FOLIAGE_ATLAS
let detailFadeByteDecoded = fract(fragmentInputs.detailAtlasData.z) * 512.0;
#else
let detailFadeByteDecoded = fragmentInputs.detailFadeByte;
#endif
#ifdef DETAIL_OPAQUE_CROWN
// Fix-pack F1: the leaf-cluster field, shared by the albedo modulation below
// and the shading-normal perturbation before lights. Two octaves (~0.74 m and
// ~0.27 m) over a sheared plane, WORLD-locked through detailWorldOrigin
// (vPositionW is floating-origin-rebased — without the offset the whole
// canopy's pattern popped on every 2,048 m origin move), each octave faded
// by its own pixel-footprint Nyquist so mid-band crowns converge to the
// texture instead of carrying per-pixel shimmer.
let detailClusterCoord = fragmentInputs.vPositionW.xz + uniforms.detailWorldOrigin.xy
  + vec2f(fragmentInputs.vPositionW.y * 0.53, fragmentInputs.vPositionW.y * 0.31);
let detailClusterFootprint = max(
  length(dpdx(detailClusterCoord)), length(dpdy(detailClusterCoord)));
let detailClusterFadeA = 1.0 - smoothstep(0.15, 0.55, detailClusterFootprint);
let detailClusterFadeB = 1.0 - smoothstep(0.06, 0.2, detailClusterFootprint);
let detailClusterA = detailClusterGrad(detailClusterCoord * 1.35);
let detailClusterB = detailClusterGrad(detailClusterCoord * 3.7 + vec2f(17.1, 3.3));
let detailClusterMix = 0.5
  + (detailClusterA.x - 0.5) * 0.62 * detailClusterFadeA
  + (detailClusterB.x - 0.5) * 0.38 * detailClusterFadeB;
#endif
#ifndef DETAIL_OPAQUE_CROWN
#ifdef DETAIL_BAND_FADES
if (!detailBandWindow(
  floor(detailFadeByteDecoded / 2.0),
  fragmentInputs.vPositionW,
  fragmentInputs.position.xy,
  fragmentInputs.detailInstanceTint.rgb,
)) { discard; }
#else
if (!detailDitherSurvives(
  detailFadeByteDecoded,
  fragmentInputs.position.xy,
  fragmentInputs.detailInstanceTint.rgb,
)) { discard; }
#endif
#endif
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
#ifdef DETAIL_OPAQUE_CROWN
  // Closed near crowns compile a genuinely opaque pipeline: no alpha test,
  // no seasonal screen-door dissolve, and no fragment LOD dither. The
  // vertex-stage band window performs the hard range cull instead.
  // Fix-pack F1: the cluster field modulates tone — lit clumps against dark
  // crevices — which the deliberately restrained dense layer cannot supply
  // alone; the companion normal perturbation lands before lights.
  surfaceAlbedo = surfaceAlbedo * detailCard.rgb
    * (0.84 + 0.32 * detailClusterMix);
#else
  let detailAtlasLayer = floor(max(fragmentInputs.detailAtlasData.z, 0.0));
  // Bark (5..7) and dense near-crown layers (16..17) texture closed geometry,
  // so their detail is albedo, never cut-outs. The old shared foliage path
  // alpha-tested and seasonally dissolved bark as if it were a leaf card,
  // punching literal vertical holes through nearby trunks. Keep the sample
  // unconditional for WGSL derivatives, then confine coverage/dissolve to
  // genuinely card-based foliage.
  let detailOpaqueSurface = (detailAtlasLayer >= 5.0 && detailAtlasLayer <= 7.0)
    || (detailAtlasLayer >= 16.0 && detailAtlasLayer <= 17.0);
  // 2-12: the shipping alpha test (Castano coverage preserved per mip in
  // the atlas bake); a thinned-crown modifier raises the threshold so the
  // canopy loses texels, not quads.
  if (!detailOpaqueSurface) {
    var detailAlphaTest = 0.5;
    if (detailModifierDecoded == 3.0) { detailAlphaTest = 0.72; }
    if (detailCard.a < detailAlphaTest) { discard; }
    // 2-13a: the tint's ALPHA lane is the seasonal leaf fraction, shed by a
    // uv-cell DISSOLVE — a threshold lift cannot drop painted leaves (their
    // interiors carry alpha ≈ 1; measured 17.1% → 16.3% coverage at 0.86).
    // 40-cell quantisation drops leaf-sized clumps; the impostor bake runs
    // the same rule (ImpostorAtlas.leafDissolveSurvives).
    let detailLeafFraction = clamp(fragmentInputs.detailInstanceTint.a, 0.0, 1.0);
    if (detailLeafFraction < 0.999) {
      let detailLeafCell = floor(fragmentInputs.detailAtlasData.xy * 40.0);
      let detailLeafHash = fract(
        sin(detailLeafCell.x * 127.1 + detailLeafCell.y * 311.7) * 43758.5453);
      if (detailLeafHash > detailLeafFraction) { discard; }
    }
  }
  surfaceAlbedo = surfaceAlbedo * detailCard.rgb;
#endif
}
// Baked crown occlusion — interior leaves go dark, sunlit tips stay bright.
surfaceAlbedo = surfaceAlbedo * mix(0.42, 1.0, detailOcclusionDecoded);
#endif
surfaceAlbedo = surfaceAlbedo * fragmentInputs.detailInstanceTint.rgb;
#endif
`,
  CUSTOM_FRAGMENT_BEFORE_LIGHTS: `
#ifdef DETAIL_OPAQUE_CROWN
// Fix-pack F1: the closed hull's smooth interpolated normal is why crowns
// read as playdough — N·L varies only at icosphere-vertex frequency. Perturb
// the shading normal with the same world-locked cluster field the albedo
// modulation uses (recomputed here — the hook scopes are separate), so the
// hull lights as thousands of leaf clumps facing every direction.
let crownClusterCoord = fragmentInputs.vPositionW.xz + uniforms.detailWorldOrigin.xy
  + vec2f(fragmentInputs.vPositionW.y * 0.53, fragmentInputs.vPositionW.y * 0.31);
let crownClusterFootprint = max(
  length(dpdx(crownClusterCoord)), length(dpdy(crownClusterCoord)));
let crownClusterFadeA = 1.0 - smoothstep(0.15, 0.55, crownClusterFootprint);
let crownClusterFadeB = 1.0 - smoothstep(0.06, 0.2, crownClusterFootprint);
let crownClusterA = detailClusterGrad(crownClusterCoord * 1.35);
let crownClusterB = detailClusterGrad(crownClusterCoord * 3.7 + vec2f(17.1, 3.3));
let crownClusterSlope = vec2f(crownClusterA.y, crownClusterA.z) * 0.4 * crownClusterFadeA
  + vec2f(crownClusterB.y, crownClusterB.z) * 0.3 * crownClusterFadeB;
normalW = normalize(normalW + vec3f(
  crownClusterSlope.x,
  (crownClusterA.x - 0.5) * 0.5 * crownClusterFadeA,
  crownClusterSlope.y,
));
#endif
#ifdef DETAIL_IMPOSTOR
// 2-17's DEFERRED NORMAL HOOKUP, closed by the perf-debt pass. The
// normal+depth array was baked and uploaded and then never sampled, so
// every impostor shaded with the billboard quad's own object normal — the
// vertex stage deliberately skips the instance rotation for impostors, so
// distant forest was lit from a direction unrelated to the crown it was
// drawing. ONE sample (the highest-weight view; the three-view blend exists
// for silhouette coherence and a normal does not need it) restores it.
let impostorNormalVariant = floor(fragmentInputs.detailImpostorC.w + 0.5);
let impostorNormalFrame = uniforms.detailImpostorSpecies[
  i32(floor(impostorNormalVariant / 32.0))
];
let impostorNormalQuadUv = vec2f(
  fragmentInputs.detailImpostorA.x,
  1.0 - fragmentInputs.detailImpostorA.y,
);
let impostorNormalWeightA = clamp(fragmentInputs.detailImpostorA.w, 0.0, 1.0);
let impostorNormalWeightB = clamp(fragmentInputs.detailImpostorC.z, 0.0, 1.0);
var impostorNormalOrigin = fragmentInputs.detailImpostorB.xy;
var impostorNormalBest = impostorNormalWeightA;
if (impostorNormalWeightB > impostorNormalBest) {
  impostorNormalOrigin = fragmentInputs.detailImpostorB.zw;
  impostorNormalBest = impostorNormalWeightB;
}
if (1.0 - impostorNormalWeightA - impostorNormalWeightB > impostorNormalBest) {
  impostorNormalOrigin = fragmentInputs.detailImpostorC.xy;
}
let impostorNormalTexel = textureSample(
  impostorNormalDepth,
  impostorNormalDepthSampler,
  detailImpostorTileUv(impostorNormalOrigin, impostorNormalQuadUv),
  i32(impostorNormalFrame.z),
).xyz * 2.0 - 1.0;
// The sprite is the tree seen from a direction the vertex stage rotated by
// +phase about Y and optionally mirrored about the billboard's right axis,
// so the baked (prototype-frame) normal carries exactly those two
// transforms in reverse.
let impostorNormalPhase = (floor(impostorNormalVariant / 2.0) % 4.0) * 0.19635;
let impostorNormalCos = cos(impostorNormalPhase);
let impostorNormalSin = sin(impostorNormalPhase);
var impostorNormalWorld = vec3f(
  impostorNormalTexel.x * impostorNormalCos + impostorNormalTexel.z * impostorNormalSin,
  impostorNormalTexel.y,
  -impostorNormalTexel.x * impostorNormalSin + impostorNormalTexel.z * impostorNormalCos,
);
let impostorNormalEyeVector = scene.vEyePosition.xyz - fragmentInputs.vPositionW;
let impostorNormalFlatEye = normalize(vec2f(impostorNormalEyeVector.x, impostorNormalEyeVector.z));
if (fract(impostorNormalVariant / 2.0) >= 0.5) {
  let impostorNormalRight = vec3f(-impostorNormalFlatEye.y, 0.0, impostorNormalFlatEye.x);
  impostorNormalWorld -= 2.0 * dot(impostorNormalWorld, impostorNormalRight) * impostorNormalRight;
}
// The soften-toward base is the CAMERA-FACING billboard normal, not the quad's
// authored normal: the vertex stage billboards positions only, so normalW
// arrives as world ±Z — a world-constant direction that biased 25% of every
// far tree's shading toward a heading unrelated to sun, camera or crown.
let impostorBillboardNormal = normalize(vec3f(
  impostorNormalFlatEye.x,
  max(impostorNormalEyeVector.y, 0.0) * 0.001 + 0.25,
  impostorNormalFlatEye.y,
));
let impostorNormalLength = length(impostorNormalWorld);
if (impostorNormalLength > 0.25) {
  // Softened toward the billboard normal: a ≤20 px sprite carrying a raw
  // leaf-facet normal would flicker as the view crosses tile boundaries,
  // and 2-14's whole crossfade design exists to keep that from happening.
  normalW = normalize(mix(
    impostorBillboardNormal,
    impostorNormalWorld / impostorNormalLength,
    0.75,
  ));
} else {
  normalW = impostorBillboardNormal;
}
// Wave Q (tree-cutoff fix): every term above faces the VIEWER (the bake
// flips normals toward the bake camera; the billboard base is the flat eye
// vector), so a far sprite was near-maximally lit whenever the sun stood
// anywhere behind the camera — while the mid band's crowns spread their
// normals across the hemisphere. A fixed tilt toward the sky moves the
// sprite's response toward that omnidirectional average from both sides:
// it darkens the sun-behind-camera case and lifts the sun-opposed case.
normalW = normalize(mix(normalW, vec3f(0.0, 1.0, 0.0), 0.3));
#endif
`,
  CUSTOM_FRAGMENT_BEFORE_FINALCOLORCOMPOSITION: `
#ifdef DETAIL_FOLIAGE_ATLAS
// 2-12's OTHER recorded gap, closed by the perf-debt pass: leaves are thin,
// so a crown lit from behind glows instead of going black — the single
// largest reason a backlit canopy reads as cardboard. This is a wrap
// transmission term on the frame's KEY LIGHT, which the runtime forwards
// from AtmosphereSystem's snapshot exactly as it forwards the wind field.
// No second sun is defined here (that is the ownership failure the manifest
// exists to prevent) and no exposure is multiplied (assertion 29); after
// Gate 7A the key light is the moon at night, which is what a moonlit
// canopy actually transmits.
let detailBacklit = uniforms.detailKeyLight.w
  * pow(clamp(-dot(viewDirectionW, uniforms.detailKeyLight.xyz), 0.0, 1.0), 4.0);
if (detailBacklit > 0.0) {
  // Baked crown occlusion gates it: an interior leaf sits behind several
  // others and transmits a fraction of what a rim leaf does.
  let detailBacklitOcclusion =
    (fragmentInputs.detailAtlasData.w - floor(fragmentInputs.detailAtlasData.w)) * 2.0;
  finalDiffuse += surfaceAlbedo * uniforms.detailKeyLightColor.rgb
    * (detailBacklit * mix(0.15, 1.0, clamp(detailBacklitOcclusion, 0.0, 1.0)));
}
#endif
#ifdef DETAIL_IMPOSTOR
// Wave Q (tree-cutoff fix): the hand-packed CSM term. Multiplying here
// mirrors the terrain horizon-shadow hook — direct diffuse and specular
// only; ambient/irradiance are untouched.
#ifdef DETAIL_SUN_SHADOW
let impostorSunShadow = detailSunShadow(fragmentInputs.vPositionW);
finalDiffuse *= impostorSunShadow;
#ifdef SPECULARTERM
finalSpecularScaled *= impostorSunShadow;
#endif
#else
let impostorSunShadow = 1.0;
#endif
// Fix-pack polish: the far band gets the SAME wrap-transmission response as
// the crowns it hands off to — the term was gated on the atlas define the
// impostor material never sets, so every backlit stand stepped from glowing
// mid hulls to flat far sprites at the handoff ring. The bake folds
// per-texel occlusion into the sprite's ALBEDO already, so a mid-level
// constant stands in for the per-fragment occlusion gate. Wave Q lowered
// the constant 0.6 -> 0.45: the geometry side's per-fragment gate averages
// below its midpoint on interior-heavy crowns, and the flat 0.6 was one of
// the terms brightening the whole far band at the handoff ring. The wrap
// is sun transmission, so it carries the shadow term like the direct lobe.
let impostorBacklit = uniforms.detailKeyLight.w
  * pow(clamp(-dot(viewDirectionW, uniforms.detailKeyLight.xyz), 0.0, 1.0), 4.0);
if (impostorBacklit > 0.0) {
  finalDiffuse += surfaceAlbedo * uniforms.detailKeyLightColor.rgb
    * (impostorBacklit * 0.45 * impostorSunShadow);
}
#endif
`,
});

/** Builds the instance world transform and tint from the 32-byte record. */
export class DetailInstanceMaterialPlugin extends MaterialPluginBase {
  private timeSeconds = 0;
  private foliageAtlas: BaseTexture | null = null;
  private opaqueCrown = false;
  /** 2-17: impostor albedo + normal/depth arrays, and the species table. */
  private impostorAtlas: BaseTexture | null = null;
  private impostorNormalAtlas: BaseTexture | null = null;
  /**
   * Perf-debt pass: one row per species — (extentUnit, centerYUnit,
   * leafedLayer, bareLayer) — indexed by the instance's variant byte, which
   * is what collapses seven per-species impostor meshes into one draw.
   */
  private readonly impostorSpecies = new Float32Array(
    DETAIL_IMPOSTOR_SPECIES_SLOTS * 4,
  );
  private impostorSeasonMix = 0;
  private sunShadow: DetailSunShadowSnapshot | null = null;
  /**
   * 2-12's translucency term: the frame's key light, forwarded from
   * `AtmosphereSystem`'s snapshot by the runtime. `w` is the strength
   * (0 disables the term entirely, which is what a sunless sky gives).
   */
  private keyLightX = 0.36;
  private keyLightY = 0.82;
  private keyLightZ = 0.44;
  private keyLightStrength = 0;
  private keyLightR = 1;
  private keyLightG = 1;
  private keyLightB = 1;
  /** 2-17 close: band edges for shader-computed tree fades (0 = off). */
  private bandFadesEnabled = false;
  private bandNearEdge = 0;
  private bandMidEdge = 0;
  private bandCullEdge = 0;
  /** 2-13: (dirX, dirZ, strength01, gust01) from the shared wind field. */
  private windDirectionX = 0.70710678;
  private windDirectionZ = 0.70710678;
  private windStrength = 0.25;
  private windGust = 0;
  private worldOriginX = 0;
  private worldOriginZ = 0;

  constructor(material: PBRMaterial) {
    // enable=false at super: registerForExtraEvents must be set BEFORE
    // _enable or hardBindForSubMesh never registers (the cloud plugin's
    // exact constructor sequence) — without it the atlas texture is never
    // bound and the first foliage draw dies in createBindGroup.
    super(
      material,
      "detail-instance-transform",
      190,
      // EVERY define the plugin can set must be DECLARED here: Babylon
      // only tracks declared plugin defines, and an undeclared key written
      // in prepareDefines is silently dropped from the compiled define
      // string (DETAIL_BAND_FADES was missing — every tree compiled the
      // legacy fade path and read band codes as ~zero fades: an invisible
      // forest of 1%-dither speckle).
      {
        DETAIL_FOLIAGE_ATLAS: false,
        DETAIL_IMPOSTOR: false,
        DETAIL_BAND_FADES: false,
        DETAIL_OPAQUE_CROWN: false,
      },
      true,
      false,
    );
    this.doNotSerialize = true;
    this.registerForExtraEvents = true;
    this._enable(true);
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

  /** Compiles the closed near-crown path with no fragment discard. */
  setOpaqueCrown(enabled = true): void {
    if (enabled === this.opaqueCrown) return;
    this.opaqueCrown = enabled;
    this.markAllDefinesAsDirty();
  }

  /**
   * 2-17: switches the material into billboard-impostor mode — the quad
   * prototype, the three-view hemi-octahedral blend, and the season
   * cross-fade between the two baked buckets.
   *
   * Perf-debt pass: the bake frame is a TABLE now, one row per species in
   * `IMPOSTOR_SPECIES` order, so a single material draws every species. The
   * normal/depth array is bound alongside the albedo array — 2-17 uploaded
   * it and deferred its shading hookup; `CUSTOM_FRAGMENT_BEFORE_LIGHTS`
   * consumes it.
   */
  setImpostorAtlas(
    albedo: BaseTexture,
    normalDepth: BaseTexture,
    species: readonly ImpostorSpeciesFrame[],
  ): void {
    if (species.length > DETAIL_IMPOSTOR_SPECIES_SLOTS) {
      throw new RangeError(
        `The impostor species table holds ${DETAIL_IMPOSTOR_SPECIES_SLOTS} rows; `
        + `${species.length} were supplied. The variant byte's high three bits `
        + "carry the index, so widening it costs instance-format bits.",
      );
    }
    this.impostorAtlas = albedo;
    this.impostorNormalAtlas = normalDepth;
    this.impostorSpecies.fill(0);
    species.forEach((frame, index) => {
      this.impostorSpecies[index * 4] = frame.extentUnit;
      this.impostorSpecies[index * 4 + 1] = frame.centerYUnit;
      this.impostorSpecies[index * 4 + 2] = frame.leafedLayer;
      this.impostorSpecies[index * 4 + 3] = frame.bareLayer;
    });
    this.markAllDefinesAsDirty();
  }

  /**
   * The frame's key light, in the same convention `AtmosphereSnapshot` uses
   * (a unit vector FROM the world TOWARD the light). `strength` is the
   * relative illuminance the translucency term is scaled by, so the glow
   * follows the real sun and, after Gate 7A, the moon.
   */
  setKeyLight(
    directionX: number,
    directionY: number,
    directionZ: number,
    radiance: readonly [number, number, number],
    strength: number,
  ): void {
    const length = Math.hypot(directionX, directionY, directionZ);
    if (Number.isFinite(length) && length > 1e-6) {
      this.keyLightX = directionX / length;
      this.keyLightY = directionY / length;
      this.keyLightZ = directionZ / length;
    }
    this.keyLightR = Math.max(0, radiance[0]);
    this.keyLightG = Math.max(0, radiance[1]);
    this.keyLightB = Math.max(0, radiance[2]);
    this.keyLightStrength = Number.isFinite(strength)
      ? Math.min(1, Math.max(0, strength))
      : 0;
  }

  /** 2-17a: 0 = leafed bucket … 1 = bare (deciduous shed cross-fade). */
  setImpostorSeason(mix: number): void {
    this.impostorSeasonMix = Number.isFinite(mix) ? Math.min(1, Math.max(0, mix)) : 0;
  }

  /**
   * 2-17 close: switches the material's tree bands to fragment-computed
   * fades (the record's fade lane then carries a band CODE 0/1/2, not a
   * level) and provides the law's radii.
   */
  setBandFades(nearEdge: number, midEdge: number, cullEdge: number): void {
    const enable = Number.isFinite(nearEdge) && nearEdge > 0;
    if (enable !== this.bandFadesEnabled) this.markAllDefinesAsDirty();
    this.bandFadesEnabled = enable;
    this.bandNearEdge = nearEdge;
    this.bandMidEdge = midEdge;
    this.bandCullEdge = cullEdge;
  }

  override prepareDefines(defines: MaterialDefines): void {
    defines["DETAIL_FOLIAGE_ATLAS"] = this.foliageAtlas !== null;
    defines["DETAIL_IMPOSTOR"] = this.impostorAtlas !== null;
    // Wave Q: the CSM receiver compiles only when a depth map can actually
    // be bound — a declared-but-unbound depth sampler is a createBindGroup
    // crash, not a silent fallback.
    defines["DETAIL_SUN_SHADOW"] = this.impostorAtlas !== null && this.sunShadow?.map != null;
    defines["DETAIL_BAND_FADES"] = this.bandFadesEnabled;
    defines["DETAIL_OPAQUE_CROWN"] = this.opaqueCrown;
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
    if (!samplers.includes("impostorAlbedo")) samplers.push("impostorAlbedo");
    if (!samplers.includes("impostorNormalDepth")) samplers.push("impostorNormalDepth");
    if (!samplers.includes("detailSunShadowMap")) samplers.push("detailSunShadowMap");
  }

  override hardBindForSubMesh(
    uniformBuffer: UniformBuffer,
    _scene?: Parameters<MaterialPluginBase["hardBindForSubMesh"]>[1],
    _engine?: Parameters<MaterialPluginBase["hardBindForSubMesh"]>[2],
    subMesh?: Parameters<MaterialPluginBase["hardBindForSubMesh"]>[3],
  ): void {
    if (this.foliageAtlas) {
      uniformBuffer.setTexture("foliageAtlas", this.foliageAtlas);
    }
    if (this.impostorAtlas) {
      uniformBuffer.setTexture("impostorAlbedo", this.impostorAtlas);
    }
    if (this.impostorNormalAtlas) {
      uniformBuffer.setTexture("impostorNormalDepth", this.impostorNormalAtlas);
    }
    // Wave Q: the CSM depth array, impostor material only. Depth-comparison
    // textures bind through the effect (the water receiver's route) — the
    // uniform-buffer setTexture path would pair a filtering sampler with a
    // depth texture, which WebGPU validation rejects.
    if (this.impostorAtlas && this.sunShadow?.map) {
      subMesh?.effect?.setDepthStencilTexture("detailSunShadowMap", this.sunShadow.map);
    }
    // Unlike bindForSubMesh, Babylon invokes the hard-bind hook even when a
    // shared material/effect remains cached. The offset is mesh-dependent,
    // so every batch draw must refresh it through this unconditional path.
    //
    // The `.w` lane carries the mesh's REVEAL value (streaming fix-pack,
    // defect C): the runtime ramps a newly created batch mesh's
    // `metadata.detailReveal` 0 -> 1 over ~0.7 s after its first publication
    // flip, and the vertex stage collapses instances whose per-stem hash
    // exceeds it. The lane was verified unused before being repurposed —
    // every WGSL consumer reads `uniforms.detailMeshOffset.xyz` only, and
    // this call was the single binding site (writing a literal 0). The
    // default is 1 (fully revealed) so meshes without a ramp — prototypes,
    // NullEngine paths, steady-state batches — are bit-for-bit unaffected.
    const mesh = subMesh?.getMesh();
    const meshOffset = mesh?.position;
    const reveal = (
      mesh?.metadata as { detailReveal?: unknown } | null | undefined
    )?.detailReveal;
    uniformBuffer.updateFloat4(
      "detailMeshOffset",
      meshOffset?.x ?? 0,
      meshOffset?.y ?? 0,
      meshOffset?.z ?? 0,
      typeof reveal === "number" ? reveal : 1,
    );
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
   * Wave Q: the frame's CSM snapshot for the far band, on the same
   * forward-the-snapshot pattern as the key light and the wind. Null (or
   * valid: false) disarms the receiver — the WGSL returns 1.0 unshadowed.
   */
  setSunShadow(snapshot: DetailSunShadowSnapshot | null): void {
    const next = snapshot && snapshot.valid ? snapshot : null;
    const hadMap = this.sunShadow?.map != null;
    this.sunShadow = next;
    if ((next?.map != null) !== hadMap) this.markAllDefinesAsDirty();
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
    if (this.impostorAtlas && !attributes.includes("uv")) {
      attributes.push("uv");
    }
  }

  override getUniforms(): {
    ubo: Array<{ name: string; size: number; type: string; arraySize?: number }>;
  } {
    return {
      ubo: [
        { name: "detailWindTime", size: 1, type: "float" },
        { name: "detailMeshOffset", size: 4, type: "vec4" },
        { name: "detailWind", size: 4, type: "vec4" },
        { name: "detailWorldOrigin", size: 4, type: "vec4" },
        { name: "detailImpostorSeason", size: 1, type: "float" },
        { name: "detailBandRadii", size: 4, type: "vec4" },
        { name: "detailKeyLight", size: 4, type: "vec4" },
        { name: "detailKeyLightColor", size: 4, type: "vec4" },
        {
          name: "detailImpostorSpecies",
          size: 4,
          type: "vec4",
          arraySize: DETAIL_IMPOSTOR_SPECIES_SLOTS,
        },
        // Wave Q: the far band's hand-packed CSM receiver (define-independent
        // layout, the house rule — only the impostor material samples them).
        { name: "detailSunShadowMatrices", size: 16, type: "mat4", arraySize: 4 },
        { name: "detailSunShadowView", size: 16, type: "mat4" },
        { name: "detailSunShadowSplits", size: 4, type: "vec4" },
        { name: "detailSunShadowBlendStarts", size: 4, type: "vec4" },
        { name: "detailSunShadowParams", size: 4, type: "vec4" },
      ],
    };
  }

  /**
   * Fix-pack F1: the crown cluster field must be WORLD-locked. vPositionW is
   * floating-origin-rebased, so without this offset every crown's shading
   * pattern jumped on each 2,048 m origin move.
   */
  setWorldOrigin(x: number, z: number): void {
    this.worldOriginX = Number.isFinite(x) ? x : 0;
    this.worldOriginZ = Number.isFinite(z) ? z : 0;
  }

  override bindForSubMesh(uniformBuffer: UniformBuffer): void {
    uniformBuffer.updateFloat("detailWindTime", this.timeSeconds);
    uniformBuffer.updateFloat4(
      "detailWorldOrigin",
      this.worldOriginX,
      this.worldOriginZ,
      0,
      0,
    );
    uniformBuffer.updateFloat4(
      "detailWind",
      this.windDirectionX,
      this.windDirectionZ,
      this.windStrength,
      this.windGust,
    );
    uniformBuffer.updateFloat("detailImpostorSeason", this.impostorSeasonMix);
    uniformBuffer.updateFloat4(
      "detailBandRadii",
      this.bandNearEdge,
      this.bandMidEdge,
      this.bandCullEdge,
      0,
    );
    uniformBuffer.updateFloat4(
      "detailKeyLight",
      this.keyLightX,
      this.keyLightY,
      this.keyLightZ,
      this.keyLightStrength,
    );
    uniformBuffer.updateFloat4(
      "detailKeyLightColor",
      this.keyLightR,
      this.keyLightG,
      this.keyLightB,
      0,
    );
    uniformBuffer.updateFloatArray("detailImpostorSpecies", this.impostorSpecies);
    const sunShadow = this.sunShadow;
    if (sunShadow) {
      uniformBuffer.updateMatrices("detailSunShadowMatrices", sunShadow.matrices);
      uniformBuffer.updateMatrices("detailSunShadowView", sunShadow.view);
      uniformBuffer.updateFloat4(
        "detailSunShadowSplits",
        sunShadow.splits[0],
        sunShadow.splits[1],
        sunShadow.splits[2],
        sunShadow.splits[3],
      );
      uniformBuffer.updateFloat4(
        "detailSunShadowBlendStarts",
        sunShadow.blendStarts[0],
        sunShadow.blendStarts[1],
        sunShadow.blendStarts[2],
        sunShadow.blendStarts[3],
      );
      uniformBuffer.updateFloat4(
        "detailSunShadowParams",
        sunShadow.cascadeCount,
        sunShadow.darkness,
        1,
        sunShadow.shadowMaxZ,
      );
    } else {
      uniformBuffer.updateFloat4("detailSunShadowParams", 0, 0, 0, 0);
    }
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
