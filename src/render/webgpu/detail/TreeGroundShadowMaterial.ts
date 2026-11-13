import { Constants } from "@babylonjs/core/Engines/constants";
import { ShaderStore } from "@babylonjs/core/Engines/shaderStore";
import { Material } from "@babylonjs/core/Materials/material";
import { ShaderLanguage } from "@babylonjs/core/Materials/shaderLanguage";
import { ShaderMaterial } from "@babylonjs/core/Materials/shaderMaterial";
import type { BaseTexture } from "@babylonjs/core/Materials/Textures/baseTexture";
import { RawTexture } from "@babylonjs/core/Materials/Textures/rawTexture";
import { Texture } from "@babylonjs/core/Materials/Textures/texture";
import { Vector2, Vector3, Vector4 } from "@babylonjs/core/Maths/math.vector";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { VertexData } from "@babylonjs/core/Meshes/mesh.vertexData";
import type { Scene } from "@babylonjs/core/scene";
import {
  CLOUD_SHADOW_RECEIVER_SAMPLER,
  CLOUD_SHADOW_RECEIVER_UNIFORMS,
  CLOUD_SHADOW_RECEIVER_WGSL,
  resolveCloudShadowReceiverBinding,
  type CloudShadowProjection,
} from "@/src/render/webgpu/clouds/CloudShadowReceiver";
import { OPAQUE_RENDERING_GROUP_ID } from "@/src/render/webgpu/core/RenderingGroups";
import { HORIZON_FIELD_LOOKUP_WGSL } from "@/src/render/webgpu/terrain/HorizonField";
import {
  DETAIL_INSTANCE_ATTRIBUTES,
  DETAIL_INSTANCE_HEIGHT_MAX_METERS,
  DETAIL_INSTANCE_RADIAL_MAX,
  DETAIL_INSTANCE_RADIAL_MIN,
} from "./instanceFormat";
import {
  TREE_GROUND_SHADOW_CORE,
  TREE_GROUND_SHADOW_CROWN_FILL,
  TREE_GROUND_SHADOW_MAX_COTANGENT,
  TREE_GROUND_SHADOW_SKY_SHADE_RADIUS,
  TREE_GROUND_SHADOW_SOFT_EDGE,
  TREE_GROUND_SHADOW_TRUNK_STEP_METERS,
} from "./treeGroundShadow";

/**
 * The GPU half of the tree ground shadow (`treeGroundShadow.ts` has the why
 * and the record): one material, shared by a batch per presentation chunk.
 *
 * HOW IT DARKENS. Like the tyre tracks (`CarTrackSystem`): `ALPHA_MULTIPLY`,
 * no depth write, drawn after the opaque world and before water, so whatever
 * is already drawn under the decal is scaled by it. Ground, road, runway and
 * short grass under a crown all take the shadow, and a trunk or a crown in
 * front of the decal still hides it through the depth test.
 *
 * A multiplying decal scales the whole lit colour, where a real shadow removes
 * only the direct sun. The vertex stage therefore works out, once per stem,
 * what share of the ground's light is direct right now, and the decal removes
 * that share and no more: the sun's strength against the sky's, its angle to
 * the ground the tree stands on, the cloud shadow over the stem, and the
 * terrain's own shadow at low sun (the horizon field). Under a cloud or in a
 * mountain's shadow the crown shadow fades out on its own; the round sky shade
 * under the crown stays.
 *
 * WHERE IT LIES. On a plane through the stem's base tilted to the ground's
 * slope there. The drawn terrain is not that plane: it is a mesh, coarser the
 * farther away it is, and wherever it rose above the plane it would cut the
 * decal off. So the decal is drawn where the plane is but depth-tested as if
 * it lay a little higher, more with distance: each vertex keeps its place on
 * screen and takes the depth of the point where its view ray crosses the
 * raised plane. Raising the quad itself would do the same for the depth test
 * and slide the shadow toward the camera, by tens of metres at a kilometre
 * seen from a few hundred metres up. The cost of the depth slack is that
 * anything shorter than it standing in the shadow takes the shadow too.
 * Known limit: on ground that curves sharply within the shadow's length (a
 * ridge line, a gully) part of the shadow is hidden or sits a little off.
 *
 * WHEN IT DRAWS. While its tree does: the record carries the stem's key, and
 * the vertex stage compares it with the law's drawn share at the live camera
 * range, the same test the tree's own band windows run. Where near
 * trees cast real shadows (High and Ultra), the crown shadow hands over to
 * them at the edge of the near band.
 *
 * BUSHES AND BOULDERS (`groundObjects.ts`). Their shadows are records in the
 * same batch, told apart by a variant lane of 0. Such a record has no stem
 * key: it draws by the reach law, out to a range in proportion to the
 * object's height, as its body does. It has no trunk and no handover.
 *
 * It also has a problem a tree's shadow does not. The depth slack above is
 * taller than a bush at range, so the bush's own body would take its own
 * shadow and stand there blackened. The decal therefore leaves out the part
 * of its plane the object's own body hides from the camera: the body's foot
 * and its top, thrown onto the plane along the view ray, and a tapered
 * capsule between them. A bush's body shrinks to its core up close, so the
 * capsule follows the same rule from the same distance. Known limit: another
 * bush's or a tree's shadow falling across a distant bush still darkens it.
 */

const SHADER_NAME = "treeGroundShadow";

/**
 * Direct sun over sky light on ground facing the sun, in the units the
 * atmosphere snapshot publishes both in (each normalised to its own peak),
 * and the sky light's colour beside the sun's. Together they say what share
 * of the ground's light is direct in each channel, which is all a shadow
 * removes.
 *
 * Calibrated against the real thing, a near tree's cast shadow on High
 * (2026-11-12, forest soil, display values turned linear with the tone
 * curve's local slope of 0.63). The shadowed ground kept this share of its
 * sunlit red / green / blue:
 *
 *   sun 57 degrees up (sun 0.93, sky 0.96):  0.19 / 0.27 / 0.44
 *   sun 20 degrees up (sun 0.75, sky 0.41):  0.17 / 0.31 / 0.51
 *
 * With these two constants a solid crown's decal keeps 0.17 / 0.24 / 0.36 and
 * 0.21 / 0.36 / 0.61: the same shadow to within the scatter of the ground
 * under it, and bluer as the sun reddens, as the real one is.
 */
export const TREE_GROUND_SHADOW_DIRECT_TO_SKY = 6;
export const TREE_GROUND_SHADOW_SKY_COLOUR: readonly [number, number, number] = [1, 1.5, 2.4];
/** How much of the ground's light the crown takes as sky shade right under it. */
export const TREE_GROUND_SHADOW_SKY_SHADE = 0.2;
/** A sun this low on the ground (sine of its height) throws no crown shadow; full by the second. */
const LOW_SUN_START = 0.03;
const LOW_SUN_END = 0.16;
/** The trunk's own shadow: nearly opaque, and gone where it is thinner than a pixel. */
const TRUNK_OPACITY = 0.8;
const TRUNK_FADE_START_METERS = 60;
const TRUNK_FADE_END_METERS = 140;
/** Outline lumps, as shares of the ellipse radius (second and third harmonic). */
const LOBE_SECOND = 0.09;
const LOBE_THIRD = 0.07;
/** Where the lumpy outline is fully faded, so the quad's edge never cuts it. */
const CROWN_OUTER = TREE_GROUND_SHADOW_SOFT_EDGE * (1 - LOBE_SECOND - LOBE_THIRD);
/** Stems stand in clumps, so shadows overlap more than an even spread would. */
const OVERLAP_CLUMPING = 1.5;
/**
 * Half the width of the handover to real shadows, in metres. Narrow on
 * purpose: a tree's cast shadow ends at one range, the near switch, where
 * its near shell hands over to the mid one in a single step, and the decal
 * has to start there. A wide blend left a ring of double shadow inside the
 * switch and a ring of half shadow outside it.
 */
const REAL_SHADOW_HANDOVER_HALF_WIDTH_METERS = 2;
/** Share of the near cap over which a newly drawn stem's shadow fades in. */
const DRAWN_FADE_SHARE = 1 / 60;
/** The shadow is gone over the last fifth of its range. */
const RANGE_FADE_START_SHARE = 0.8;

/**
 * How far above its plane the decal still passes the depth test: metres, and
 * metres per metre of range (the terrain's vertices are 2 m apart at its
 * finest and double with each level out).
 */
export const TREE_GROUND_SHADOW_DEPTH_SLACK_METERS = 0.15;
export const TREE_GROUND_SHADOW_DEPTH_SLACK_PER_METER = 0.005;
/**
 * The slack is never more than this share of the camera's own height above
 * the plane: a camera near the ground would otherwise see a far shadow
 * through whatever stands in front of it.
 */
const DEPTH_SLACK_MAX_EYE_SHARE = 0.25;
/**
 * A bush or a boulder is shorter than the depth slack at range, so its own
 * decal would darken all of it: a hillside of black balls. The decal leaves
 * out the part of its plane the object itself hides from the camera, which is
 * known in closed form (the body carried along the view rays to the plane is
 * a capsule running away from the camera's foot) and costs no visible ground,
 * because the body covers it. The lowest share of the body stays in the
 * shadow, as the contact shade at its foot. The capsule narrows to the top
 * as the body does and has a soft edge a little inside the outline. It is the
 * body as drawn: inside its leaf cards' reach a bush's body is its core
 * (`SHRUB_BODY_CORE_SCALE`), and the capsule shrinks with it, so the ground
 * between the cards keeps its shadow.
 */
const OWN_BODY_FOOT_SHARE = 0.12;
const OWN_BODY_TOP_TAPER = 0.5;
const OWN_BODY_INNER = 0.8;
const OWN_BODY_FEATHER = 0.35;
/** The capsule's far end when the camera is level with the object's top or below it. */
const OWN_BODY_MAX_THROW = 64;
/** Default haze: the shadow's contrast falls with range as the air between fills in. */
export const TREE_GROUND_SHADOW_HAZE_PER_METER = 4e-5;

function wgslFloat(value: number): string {
  return Number.isInteger(value) ? `${value}.0` : `${value}`;
}

const UNIFORMS = [
  "world",
  "viewProjection",
  "cameraPosition",
  "treeShadowSun",
  "treeShadowSunColour",
  "treeShadowSky",
  "treeShadowBands",
  "treeShadowStand",
  "treeShadowObjects",
  "treeShadowCore",
  "treeShadowOrigin",
  "treeShadowHorizon",
  ...CLOUD_SHADOW_RECEIVER_UNIFORMS,
] as const;

const HORIZON_SAMPLER_A = "treeShadowHorizonA";
const HORIZON_SAMPLER_B = "treeShadowHorizonB";
/** The horizon field's soft band, as the detail and water consumers set it. */
const HORIZON_SOFT_BAND = 0.05;

export const TREE_GROUND_SHADOW_VERTEX_WGSL = /* wgsl */ `
attribute position: vec3f;
attribute instancePosition: vec3f;
attribute instanceOrientation: vec4f;
attribute instanceScale: vec2f;
attribute instanceTint: vec4f;
attribute instanceState: vec4f;

uniform world: mat4x4f;
uniform viewProjection: mat4x4f;
uniform cameraPosition: vec3f;
// xyz toward the sun, w the direct light's strength (1 at clear noon)
uniform treeShadowSun: vec4f;
// rgb the direct light's colour
uniform treeShadowSunColour: vec4f;
// x the sky light's strength (1 at clear noon), y haze per metre, z depth slack in metres, w depth slack per metre of range
uniform treeShadowSky: vec4f;
// x the near radius, y the shadow's range, z the geometry floor share, w the drawn floor share
uniform treeShadowBands: vec4f;
// x the near cap in stems per hectare, y where real shadows end (0 when nothing casts them)
uniform treeShadowStand: vec4f;
// bushes and boulders: x metres of reach per metre of height, y the tier's cap, z the share of the reach they grow in over
uniform treeShadowObjects: vec4f;
// a bush's body near the camera: x its leaf cards' metres of reach per metre of body height, y their cap, z the share they grow in over, w the scale the body shrinks to inside it
uniform treeShadowCore: vec4f;
// xy the floating origin's x and z: world metres = local metres + this
uniform treeShadowOrigin: vec4f;
// xy the horizon field's origin, z one over its span (0 = no field yet), w its soft band
uniform treeShadowHorizon: vec4f;
${CLOUD_SHADOW_RECEIVER_WGSL}
var ${HORIZON_SAMPLER_A}Sampler: sampler; var ${HORIZON_SAMPLER_A}: texture_2d<f32>;
var ${HORIZON_SAMPLER_B}Sampler: sampler; var ${HORIZON_SAMPLER_B}: texture_2d<f32>;
${HORIZON_FIELD_LOOKUP_WGSL}

// metres in the ground plane: x away from the sun, y across it
varying shadowPlane: vec2f;
// x the crown shadow's centre along x, y and z one over its half-length and half-width, w the trunk's half-width
varying shadowShape: vec4f;
// rgb the share of the ground's light the sun's shadow takes, per channel
varying shadowSun: vec3f;
// x the crown's opacity, y the sky shade's strength, z the trunk's opacity, w the overlap exponent
varying shadowStrength: vec4f;
// the outline's second and third harmonic, each as (cosine, sine) of its phase times its size
varying shadowLobes: vec4f;
// x one over the sky shade's radius, y the radius of the object's own body on the plane (negative: a tree, none)
varying shadowBlob: vec2f;
// the part of the plane a bush or boulder hides behind itself: xy where it starts, zw where it ends
varying shadowOwn: vec4f;

fn treeShadowRotate(v: vec3f, q: vec4f) -> vec3f {
  return v + 2.0 * cross(q.xyz, cross(q.xyz, v) + q.w * v);
}

// DetailInstanceMaterialPlugin's detailStemHash, so a stem's shadow and its tree agree.
fn treeShadowStemHash(lane: f32) -> f32 {
  return fract(lane * 157.31 + 0.371);
}

// renderedDensity.ts's drawnShareAtDistance, as DetailInstanceMaterialPlugin's detailDrawnShare reads it.
fn treeShadowDrawnShare(bandRange: f32) -> f32 {
  let nearRadius = uniforms.treeShadowBands.x;
  if (bandRange <= nearRadius) { return 1.0; }
  let ratio = nearRadius / max(bandRange, 1e-3);
  return max(max(ratio * ratio, uniforms.treeShadowBands.z), uniforms.treeShadowBands.w);
}

fn treeShadowHorizonJitter(point: vec2f) -> f32 {
  var value = fract(vec3f(point.x, point.y, point.x) * 0.1031);
  value += dot(value, value.yzx + vec3f(33.33));
  return fract((value.x + value.y) * value.z);
}

// Whether the terrain lets the sun reach a world position: 1 lit, 0 in its shadow.
fn treeShadowTerrainSun(worldXZ: vec2f, sun: vec3f) -> f32 {
  let field = uniforms.treeShadowHorizon;
  let uv = (worldXZ - field.xy) * field.z;
  let packedA = textureSampleLevel(${HORIZON_SAMPLER_A}, ${HORIZON_SAMPLER_A}Sampler, uv, 0.0);
  let packedB = textureSampleLevel(${HORIZON_SAMPLER_B}, ${HORIZON_SAMPLER_B}Sampler, uv, 0.0);
  let visibility = horizonFieldShadow(
    packedA, packedB, sun, field.w, treeShadowHorizonJitter(worldXZ * 0.37));
  return mix(1.0, visibility, select(0.0, 1.0, field.z > 0.0));
}

@vertex
fn main(input: VertexInputs) -> FragmentInputs {
  let quaternion = normalize(vertexInputs.instanceOrientation);
  let height = vertexInputs.instanceScale.x * ${wgslFloat(DETAIL_INSTANCE_HEIGHT_MAX_METERS)};
  let crownRadius = height * (${wgslFloat(DETAIL_INSTANCE_RADIAL_MIN)}
    + vertexInputs.instanceScale.y * ${wgslFloat(DETAIL_INSTANCE_RADIAL_MAX - DETAIL_INSTANCE_RADIAL_MIN)});
  let centreHeight = vertexInputs.instanceTint.x * height;
  let semiAxis = vertexInputs.instanceTint.y * height;
  let opacity = vertexInputs.instanceTint.z;
  let standShare = vertexInputs.instanceTint.w;
  let stemKey = vertexInputs.instanceState.z;
  let trunkRadius = floor(vertexInputs.instanceState.y * 255.0 + 0.5)
    * ${wgslFloat(TREE_GROUND_SHADOW_TRUNK_STEP_METERS)};

  let base = (uniforms.world * vec4f(vertexInputs.instancePosition, 1.0)).xyz;
  let toEye = uniforms.cameraPosition - base;
  let bandRange = length(toEye.xz);
  let distanceMeters = length(toEye);

  // Drawn while the tree is: the stem's key against the drawn share at this
  // range. It fades in over a sliver of share INSIDE the tree's own window,
  // so a shadow grows under a tree that is already there and none is ever
  // left without one. The sliver closes toward the near band, where every
  // stem draws.
  let drawnShare = treeShadowDrawnShare(bandRange);
  let drawnSliver = clamp((1.0 - drawnShare) * 0.5, 1e-4, ${wgslFloat(DRAWN_FADE_SHARE)});
  let stemDrawn = clamp(
    (drawnShare - stemKey) / drawnSliver + select(0.25, 1.0, drawnShare >= 1.0), 0.0, 1.0);
  // A bush or a boulder (variant 0) is drawn by its size instead: out to the
  // reach its body computes from the same height lane (groundObjects.ts), and
  // fading in over the stretch the body grows in over.
  let groundObject = vertexInputs.instanceState.y * 255.0 < 0.5;
  let objectReach = min(height * uniforms.treeShadowObjects.x, uniforms.treeShadowObjects.y)
    * (floor(floor(vertexInputs.instanceState.x * 255.0 + 0.5) / 2.0) / 127.0);
  let objectDrawn = clamp(
    (objectReach - distanceMeters) / max(objectReach * uniforms.treeShadowObjects.z, 1.0),
    0.0, 1.0);
  let drawn = select(stemDrawn, objectDrawn, groundObject);
  let shadowRange = uniforms.treeShadowBands.y;
  let rangeFade = 1.0 - smoothstep(
    shadowRange * ${wgslFloat(RANGE_FADE_START_SHARE)}, shadowRange, bandRange);
  let haze = exp(-distanceMeters * uniforms.treeShadowSky.y);
  let presence = drawn * rangeFade * haze;

  // The ground's own frame: its normal, and the way the shadow falls on it.
  let normal = treeShadowRotate(vec3f(0.0, 1.0, 0.0), quaternion);
  let sun = uniforms.treeShadowSun.xyz;
  let incidence = dot(normal, sun);
  let sunInPlane = sun - normal * incidence;
  let inPlaneLength = length(sunInPlane);
  var along = treeShadowRotate(vec3f(1.0, 0.0, 0.0), quaternion);
  if (inPlaneLength > 1e-4) { along = -sunInPlane / inPlaneLength; }
  let across = cross(normal, along);
  let cotangent = min(
    inPlaneLength / max(incidence, 1e-3), ${wgslFloat(TREE_GROUND_SHADOW_MAX_COTANGENT)});

  // How much of this ground's light is the direct sun, right now.
  let cloud = sampleCloudShadowReceiver(base);
  let terrainSun = treeShadowTerrainSun(base.xz + uniforms.treeShadowOrigin.xy, sun);
  let direct = ${wgslFloat(TREE_GROUND_SHADOW_DIRECT_TO_SKY)} * uniforms.treeShadowSun.w
    * max(incidence, 0.0) * cloud * terrainSun * max(uniforms.treeShadowSunColour.rgb, vec3f(0.0));
  let skyLight = max(uniforms.treeShadowSky.x, 0.02)
    * vec3f(${TREE_GROUND_SHADOW_SKY_COLOUR.map(wgslFloat).join(", ")});
  let directShare = direct / (direct + skyLight);
  let lowSun = smoothstep(${wgslFloat(LOW_SUN_START)}, ${wgslFloat(LOW_SUN_END)}, incidence);
  // Where near trees cast real shadows, those own the near band. Bushes and
  // boulders cast none anywhere, so theirs is always the decal.
  let realEdge = uniforms.treeShadowStand.y;
  let handover = select(
    1.0,
    smoothstep(
      realEdge - ${wgslFloat(REAL_SHADOW_HANDOVER_HALF_WIDTH_METERS)},
      realEdge + ${wgslFloat(REAL_SHADOW_HANDOVER_HALF_WIDTH_METERS)},
      bandRange),
    realEdge > 0.0 && !groundObject);
  let sunShadow = directShare * (lowSun * handover * presence);
  let crownStrength = max(sunShadow.r, max(sunShadow.g, sunShadow.b)) * opacity;
  let trunkOpacity = select(
    ${wgslFloat(TRUNK_OPACITY)} * (1.0 - smoothstep(
      ${wgslFloat(TRUNK_FADE_START_METERS)}, ${wgslFloat(TRUNK_FADE_END_METERS)}, bandRange)),
    0.0,
    groundObject);
  let skyStrength = ${wgslFloat(TREE_GROUND_SHADOW_SKY_SHADE)} * opacity * presence;

  // The footprint (treeGroundShadow.ts's treeGroundShadowFootprint is its CPU mirror).
  let semiAcross = crownRadius * ${wgslFloat(TREE_GROUND_SHADOW_CROWN_FILL)};
  let semiAlong = length(vec2f(semiAcross, semiAxis * cotangent));
  let offset = centreHeight * cotangent;
  let skyRadius = crownRadius * ${wgslFloat(TREE_GROUND_SHADOW_SKY_SHADE_RADIUS)};
  let sunOn = crownStrength > 0.004;
  let softEdge = ${wgslFloat(TREE_GROUND_SHADOW_SOFT_EDGE)};
  let quadEnd = select(skyRadius, max(skyRadius, offset + semiAlong * softEdge), sunOn);
  let quadStart = select(-skyRadius, -max(skyRadius, semiAlong * softEdge - offset), sunOn);
  let halfWidth = select(skyRadius, max(skyRadius, semiAcross * softEdge), sunOn);
  let planeX = mix(quadStart, quadEnd, vertexInputs.position.x * 0.5 + 0.5);
  let planeY = vertexInputs.position.z * halfWidth;
  let worldPosition = base + along * planeX + across * planeY;
  var clip = uniforms.viewProjection * vec4f(worldPosition, 1.0);
  // Depth as if the plane lay a slack higher: the depth of the point where
  // this vertex's view ray crosses that raised plane. The share is the same
  // at all four corners, so the depth stays a plane's.
  let eyeHeight = dot(uniforms.cameraPosition - base, normal);
  let slack = uniforms.treeShadowSky.z + uniforms.treeShadowSky.w * distanceMeters;
  let towardEye = min(
    slack / max(eyeHeight, 1e-3), ${wgslFloat(DEPTH_SLACK_MAX_EYE_SHARE)});
  let depthClip = uniforms.viewProjection
    * vec4f(mix(worldPosition, uniforms.cameraPosition, towardEye), 1.0);
  if (abs(depthClip.w) > 1e-6) { clip.z = depthClip.z / depthClip.w * clip.w; }
  // A shadow with nothing to show rasterises nothing, and neither does one
  // whose ground faces away from the camera.
  if (max(crownStrength, skyStrength) < 0.004 || eyeHeight <= 0.0) {
    clip = vec4f(0.0, 0.0, 2.0, 1.0);
  }

  // A closed stand's shadows overlap, and each one multiplies: without this a
  // forest floor goes to black. The expected number of crown shadows over a
  // point, from the drawn stems per hectare and one shadow's area, becomes
  // the exponent that brings their product back to one shadow's depth.
  let drawnPerHectare = uniforms.treeShadowStand.x
    * select(min(standShare, drawnShare), standShare, groundObject);
  let overlap = drawnPerHectare * 3.14159265 * semiAlong * semiAcross * 1e-4
    * ${wgslFloat(OVERLAP_CLUMPING)};

  // Two outline harmonics with per-stem phases, so no two crowns throw the
  // same ellipse. World position joins the hash because keys repeat.
  let worldXZ = base.xz + uniforms.treeShadowOrigin.xy;
  let outlineHash = fract(treeShadowStemHash(stemKey) + worldXZ.x * 0.37 + worldXZ.y * 0.61);
  let phaseSecond = outlineHash * 6.2831853;
  let phaseThird = fract(outlineHash * 7.31) * 6.2831853;

  vertexOutputs.position = clip;
  vertexOutputs.shadowPlane = vec2f(planeX, planeY);
  vertexOutputs.shadowShape = vec4f(
    offset, 1.0 / max(semiAlong, 1e-3), 1.0 / max(semiAcross, 1e-3), max(trunkRadius, 0.03));
  vertexOutputs.shadowSun = sunShadow;
  vertexOutputs.shadowStrength = vec4f(
    opacity, skyStrength, trunkOpacity, 1.0 / max(1.0, overlap));
  vertexOutputs.shadowLobes = vec4f(
    cos(phaseSecond) * ${wgslFloat(LOBE_SECOND)}, sin(phaseSecond) * ${wgslFloat(LOBE_SECOND)},
    cos(phaseThird) * ${wgslFloat(LOBE_THIRD)}, sin(phaseThird) * ${wgslFloat(LOBE_THIRD)});
  // What the object's own body hides of this plane, seen from here: each
  // height of the body lands where its view ray meets the plane, further from
  // the camera's foot the higher it is and the lower the camera.
  let eyeFoot = vec2f(dot(toEye, along), dot(toEye, across));
  // The body's size right now: DetailInstanceMaterialPlugin's DETAIL_SIZE_RANGE
  // core rule, for a record whose wind lane says its body has a core.
  let coreReach = min(height * uniforms.treeShadowCore.x, uniforms.treeShadowCore.y);
  let coreGrow = clamp(
    (coreReach - distanceMeters) / max(coreReach * uniforms.treeShadowCore.z, 1.0), 0.0, 1.0);
  let ownScale = mix(
    1.0, mix(1.0, uniforms.treeShadowCore.w, vertexInputs.instanceState.w), coreGrow);
  let ownTop = height * ownScale;
  let ownFoot = ownTop * ${wgslFloat(OWN_BODY_FOOT_SHARE)};
  let ownEndThrow = select(
    ${wgslFloat(OWN_BODY_MAX_THROW)},
    min(ownTop / max(eyeHeight - ownTop, 1e-4), ${wgslFloat(OWN_BODY_MAX_THROW)}),
    eyeHeight > ownTop);
  let ownStartThrow = min(ownFoot / max(eyeHeight - ownFoot, 1e-4), ownEndThrow);
  vertexOutputs.shadowBlob = vec2f(
    1.0 / max(skyRadius, 1e-3), select(-1.0, crownRadius * ownScale, groundObject));
  vertexOutputs.shadowOwn = vec4f(-eyeFoot * ownStartThrow, -eyeFoot * ownEndThrow);
}
`;

export const TREE_GROUND_SHADOW_FRAGMENT_WGSL = /* wgsl */ `
varying shadowPlane: vec2f;
varying shadowShape: vec4f;
varying shadowSun: vec3f;
varying shadowStrength: vec4f;
varying shadowLobes: vec4f;
varying shadowBlob: vec2f;
varying shadowOwn: vec4f;

@fragment
fn main(input: FragmentInputs) -> FragmentOutputs {
  let plane = fragmentInputs.shadowPlane;
  let shape = fragmentInputs.shadowShape;
  let strength = fragmentInputs.shadowStrength;
  let lobes = fragmentInputs.shadowLobes;

  // The crown: an ellipse with a soft, slightly lumpy edge.
  let ellipse = vec2f((plane.x - shape.x) * shape.y, plane.y * shape.z);
  let radius = length(ellipse);
  let direction = ellipse / max(radius, 1e-4);
  let cosSecond = direction.x * direction.x - direction.y * direction.y;
  let sinSecond = 2.0 * direction.x * direction.y;
  let cosThird = direction.x * (4.0 * direction.x * direction.x - 3.0);
  let sinThird = direction.y * (3.0 - 4.0 * direction.y * direction.y);
  let lumpy = radius * (1.0
    + cosSecond * lobes.x + sinSecond * lobes.y + cosThird * lobes.z + sinThird * lobes.w);
  let crown = (1.0 - smoothstep(
    ${wgslFloat(TREE_GROUND_SHADOW_CORE)}, ${wgslFloat(CROWN_OUTER)}, lumpy)) * strength.x;

  // The trunk: a strip from the stem to the crown's shadow, blurring as it goes.
  let alongTrunk = clamp(plane.x, 0.0, shape.x);
  let trunkDistance = length(vec2f(plane.x - alongTrunk, plane.y));
  let trunk = (1.0 - smoothstep(
    shape.w, shape.w * 2.0 + 0.12 + alongTrunk * 0.03, trunkDistance)) * strength.z;

  // The sky shade right under the crown, there whatever the sun does.
  let sky = (1.0 - smoothstep(0.15, 1.0, length(plane) * fragmentInputs.shadowBlob.x)) * strength.y;

  // A bush or boulder leaves its own body out (see OWN_BODY_FOOT_SHARE).
  let own = fragmentInputs.shadowOwn;
  let ownAxis = own.zw - own.xy;
  let ownAlong = clamp(
    dot(plane - own.xy, ownAxis) / max(dot(ownAxis, ownAxis), 1e-6), 0.0, 1.0);
  let ownRadius = fragmentInputs.shadowBlob.y
    * mix(1.0, ${wgslFloat(OWN_BODY_TOP_TAPER)}, ownAlong);
  let ownDistance = length(plane - own.xy - ownAxis * ownAlong);
  let notOwn = select(
    1.0,
    clamp(
      (ownDistance - ownRadius * ${wgslFloat(OWN_BODY_INNER)})
        / max(ownRadius * ${wgslFloat(OWN_BODY_FEATHER)}, 1e-4),
      0.0, 1.0),
    ownRadius > 0.0);

  var keep = (vec3f(1.0) - fragmentInputs.shadowSun * max(crown * notOwn, trunk))
    * (1.0 - sky * notOwn);
  keep = pow(max(keep, vec3f(1e-3)), vec3f(strength.w));
  // ALPHA_MULTIPLY: what is already drawn is scaled by this; alpha untouched.
  fragmentOutputs.color = vec4f(keep, 0.0);
}
`;

/** Inputs the shadow's law reads each update, from the tier's profile. */
export interface TreeGroundShadowLaw {
  readonly nearRadiusMeters: number;
  readonly rangeMeters: number;
  readonly geometryFloorShare: number;
  readonly drawnFloorShare: number;
  readonly nearStemsPerHectare: number;
  /** Range inside which near trees cast real shadows; 0 when they cast none. */
  readonly realShadowEdgeMeters: number;
}

export class TreeGroundShadowMaterial {
  readonly material: ShaderMaterial;
  private readonly scene: Scene;
  private readonly fallbackTexture: RawTexture;
  private readonly sun = new Vector4(0, 1, 0, 1);
  private readonly sunColour = new Vector4(1, 1, 1, 0);
  private readonly sky = new Vector4(
    1,
    TREE_GROUND_SHADOW_HAZE_PER_METER,
    TREE_GROUND_SHADOW_DEPTH_SLACK_METERS,
    TREE_GROUND_SHADOW_DEPTH_SLACK_PER_METER,
  );
  private readonly bands = new Vector4(400, 0, 1, 1);
  private readonly stand = new Vector4(78, 0, 0, 0);
  private readonly objects = new Vector4(0, 0, 1, 0);
  private readonly core = new Vector4(0, 0, 1, 1);
  private readonly origin = new Vector4(0, 0, 0, 0);
  private readonly horizon = new Vector4(0, 0, 0, HORIZON_SOFT_BAND);
  private readonly cloudShadowCenterLocal = new Vector2(0, 0);
  private readonly cloudShadowSunDirection = new Vector3(0, 1, 0);
  private cloudShadowProjection: CloudShadowProjection | null = null;
  private disposed = false;

  constructor(scene: Scene) {
    this.scene = scene;
    ShaderStore.ShadersStoreWGSL[`${SHADER_NAME}VertexShader`] = TREE_GROUND_SHADOW_VERTEX_WGSL;
    ShaderStore.ShadersStoreWGSL[`${SHADER_NAME}PixelShader`] = TREE_GROUND_SHADOW_FRAGMENT_WGSL;
    const material = new ShaderMaterial(
      "detail-tree-ground-shadow",
      scene,
      SHADER_NAME,
      {
        attributes: ["position", ...DETAIL_INSTANCE_ATTRIBUTES.map((attribute) => attribute.kind)],
        uniforms: [...UNIFORMS],
        samplers: [CLOUD_SHADOW_RECEIVER_SAMPLER, HORIZON_SAMPLER_A, HORIZON_SAMPLER_B],
        shaderLanguage: ShaderLanguage.WGSL,
        needAlphaBlending: true,
      },
    );
    // Culling stays off: the vertex stage already drops a shadow whose ground
    // faces away from the camera.
    material.backFaceCulling = false;
    material.disableDepthWrite = true;
    material.transparencyMode = Material.MATERIAL_ALPHABLEND;
    material.alphaMode = Constants.ALPHA_MULTIPLY;
    material.zOffset = -1;
    material.zOffsetUnits = -4;
    // Bound from construction: a declared sampler with nothing bound keeps a
    // WebGPU material un-ready forever. The renderer swaps in the real cloud
    // map and horizon field as they arrive; until then both read as "lit".
    this.fallbackTexture = RawTexture.CreateRGBATexture(
      new Uint8Array([255, 255, 255, 255]),
      1,
      1,
      scene,
      false,
      false,
      Texture.NEAREST_SAMPLINGMODE,
    );
    this.fallbackTexture.name = "tree-ground-shadow-fallback";
    material.setTexture(CLOUD_SHADOW_RECEIVER_SAMPLER, this.fallbackTexture);
    material.setTexture(HORIZON_SAMPLER_A, this.fallbackTexture);
    material.setTexture(HORIZON_SAMPLER_B, this.fallbackTexture);
    material.setVector2("cloudShadowCenterLocal", this.cloudShadowCenterLocal);
    material.setFloat("cloudShadowWorldSize", 1);
    material.setFloat("cloudShadowReferenceAltitude", 0);
    material.setVector3("cloudShadowSunDirection", this.cloudShadowSunDirection);
    material.setFloat("cloudShadowReceiverValid", 0);
    material.setFloat("cloudShadowStrength", 0);
    material.setVector4("treeShadowSun", this.sun);
    material.setVector4("treeShadowSunColour", this.sunColour);
    material.setVector4("treeShadowSky", this.sky);
    material.setVector4("treeShadowBands", this.bands);
    material.setVector4("treeShadowStand", this.stand);
    material.setVector4("treeShadowObjects", this.objects);
    material.setVector4("treeShadowCore", this.core);
    material.setVector4("treeShadowOrigin", this.origin);
    material.setVector4("treeShadowHorizon", this.horizon);
    this.material = material;
  }

  /** The unit quad every shadow batch is cloned from: x along the sun, z across it. */
  createPrototypeMesh(): Mesh {
    const mesh = new Mesh("detail-tree-ground-shadow", this.scene);
    const quad = new VertexData();
    quad.positions = new Float32Array([-1, 0, -1, 1, 0, -1, 1, 0, 1, -1, 0, 1]);
    quad.indices = new Uint16Array([0, 2, 1, 0, 3, 2]);
    quad.applyToMesh(mesh, false);
    mesh.material = this.material;
    this.configureBatchMesh(mesh);
    mesh.setEnabled(false);
    return mesh;
  }

  /**
   * Draw state a shadow batch needs and a clone must keep: after the opaque
   * world and before water, among the blended meshes ahead of the cloud shell
   * (the tyre tracks' slot), and neither casting nor receiving anything.
   */
  configureBatchMesh(mesh: Mesh): void {
    mesh.renderingGroupId = OPAQUE_RENDERING_GROUP_ID;
    mesh.alphaIndex = 0;
    mesh.isPickable = false;
    mesh.applyFog = false;
    mesh.receiveShadows = false;
  }

  /** The key light: a direction toward it, its colour, and its strength (1 at clear noon). */
  setSun(
    directionX: number,
    directionY: number,
    directionZ: number,
    colour: readonly [number, number, number],
    strength: number,
  ): void {
    const length = Math.hypot(directionX, directionY, directionZ);
    if (!Number.isFinite(length) || length < 1e-6) {
      this.sun.set(0, 1, 0, 0);
    } else {
      this.sun.set(
        directionX / length,
        directionY / length,
        directionZ / length,
        Number.isFinite(strength) ? Math.max(0, strength) : 0,
      );
    }
    const channel = (value: number): number => (Number.isFinite(value) ? Math.max(0, value) : 0);
    this.sunColour.set(channel(colour[0]), channel(colour[1]), channel(colour[2]), 0);
    this.material.setVector4("treeShadowSun", this.sun);
    this.material.setVector4("treeShadowSunColour", this.sunColour);
  }

  /** The sky light's strength, 1 at clear noon. */
  setSkylight(strength: number): void {
    this.sky.x = Number.isFinite(strength) ? Math.max(0, strength) : 1;
    this.material.setVector4("treeShadowSky", this.sky);
  }

  /** How fast the shadow's contrast falls with range, per metre. */
  setHazePerMeter(extinction: number): void {
    this.sky.y = Number.isFinite(extinction) ? Math.max(0, extinction) : 0;
    this.material.setVector4("treeShadowSky", this.sky);
  }

  setLaw(law: TreeGroundShadowLaw): void {
    this.bands.set(
      law.nearRadiusMeters,
      Math.max(0, law.rangeMeters),
      law.geometryFloorShare,
      law.drawnFloorShare,
    );
    this.stand.x = law.nearStemsPerHectare;
    this.stand.y = Math.max(0, law.realShadowEdgeMeters);
    this.material.setVector4("treeShadowBands", this.bands);
    this.material.setVector4("treeShadowStand", this.stand);
  }

  /**
   * The reach law for bushes' and boulders' shadows: the same three numbers
   * their bodies' materials take (`groundObjectReachMeters`). A cap of 0
   * draws none of them.
   */
  setGroundObjectReach(metersPerMeter: number, capMeters: number, growShare: number): void {
    const enabled = Number.isFinite(metersPerMeter) && metersPerMeter > 0
      && Number.isFinite(capMeters) && capMeters > 0;
    this.objects.set(
      enabled ? metersPerMeter : 0,
      enabled ? capMeters : 0,
      Number.isFinite(growShare) ? Math.min(1, Math.max(1e-3, growShare)) : 1,
      0,
    );
    this.material.setVector4("treeShadowObjects", this.objects);
  }

  /**
   * A bush's body near the camera, as its own material shrinks it
   * (`DetailInstanceMaterialPlugin.setSizeCore`, the same four numbers): the
   * shadow leaves out only what the body as drawn hides.
   */
  setGroundObjectCore(
    metersPerMeter: number,
    capMeters: number,
    growShare: number,
    coreScale: number,
  ): void {
    const enabled = Number.isFinite(metersPerMeter) && metersPerMeter > 0
      && Number.isFinite(capMeters) && capMeters > 0;
    this.core.set(
      enabled ? metersPerMeter : 0,
      enabled ? capMeters : 0,
      Number.isFinite(growShare) ? Math.min(1, Math.max(1e-3, growShare)) : 1,
      Number.isFinite(coreScale) ? Math.min(1, Math.max(0, coreScale)) : 1,
    );
    this.material.setVector4("treeShadowCore", this.core);
  }

  setWorldOrigin(worldX: number, worldZ: number): void {
    if (this.origin.x === worldX && this.origin.y === worldZ) return;
    this.origin.x = worldX;
    this.origin.y = worldZ;
    this.material.setVector4("treeShadowOrigin", this.origin);
    this.applyCloudShadowProjection();
  }

  setCloudShadow(projection: CloudShadowProjection | null): void {
    this.cloudShadowProjection = projection;
    this.applyCloudShadowProjection();
  }

  /** The terrain's global horizon field, on the detail plugin's signature. */
  setHorizonField(
    layerA: BaseTexture | null,
    layerB: BaseTexture | null,
    originX: number,
    originZ: number,
    spanMeters: number,
  ): void {
    const resident = layerA !== null && layerB !== null && spanMeters > 0
      && Number.isFinite(originX) && Number.isFinite(originZ);
    this.material.setTexture(HORIZON_SAMPLER_A, resident ? layerA : this.fallbackTexture);
    this.material.setTexture(HORIZON_SAMPLER_B, resident ? layerB : this.fallbackTexture);
    this.horizon.set(
      resident ? originX : 0,
      resident ? originZ : 0,
      resident ? 1 / spanMeters : 0,
      HORIZON_SOFT_BAND,
    );
    this.material.setVector4("treeShadowHorizon", this.horizon);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.material.dispose();
    this.fallbackTexture.dispose();
  }

  private applyCloudShadowProjection(): void {
    const projection = this.cloudShadowProjection;
    if (!projection) {
      this.material.setTexture(CLOUD_SHADOW_RECEIVER_SAMPLER, this.fallbackTexture);
      this.material.setFloat("cloudShadowReceiverValid", 0);
      return;
    }
    const binding = resolveCloudShadowReceiverBinding(projection, this.origin.x, this.origin.y);
    this.cloudShadowCenterLocal.set(binding.centerLocalX, binding.centerLocalZ);
    this.cloudShadowSunDirection.set(
      binding.sunDirectionX,
      binding.sunDirectionY,
      binding.sunDirectionZ,
    );
    this.material.setTexture(CLOUD_SHADOW_RECEIVER_SAMPLER, projection.texture);
    this.material.setVector2("cloudShadowCenterLocal", this.cloudShadowCenterLocal);
    this.material.setFloat("cloudShadowWorldSize", binding.worldSizeMeters);
    this.material.setFloat("cloudShadowReferenceAltitude", binding.referenceAltitudeMeters);
    this.material.setVector3("cloudShadowSunDirection", this.cloudShadowSunDirection);
    this.material.setFloat("cloudShadowReceiverValid", binding.valid ? 1 : 0);
    this.material.setFloat("cloudShadowStrength", binding.strength);
  }
}
