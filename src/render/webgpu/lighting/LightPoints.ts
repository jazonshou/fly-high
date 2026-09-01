import { Constants } from "@babylonjs/core/Engines/constants";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { ShaderMaterial } from "@babylonjs/core/Materials/shaderMaterial";
import { ShaderStore } from "@babylonjs/core/Engines/shaderStore";
import { ShaderLanguage } from "@babylonjs/core/Materials/shaderLanguage";
import { VertexData } from "@babylonjs/core/Meshes/mesh.vertexData";
import type { Scene } from "@babylonjs/core/scene";
import { RawTexture } from "@babylonjs/core/Materials/Textures/rawTexture";
import { Vector2, Vector3, Vector4 } from "@babylonjs/core/Maths/math.vector";
import { Texture } from "@babylonjs/core/Materials/Textures/texture";
import { Constants as EngineConstants } from "@babylonjs/core/Engines/constants";
import { LoadIESData } from "@babylonjs/core/Lights/IES/iesLoader";
import {
  AERIAL_PERSPECTIVE_UNIFORMS,
  AERIAL_PERSPECTIVE_WGSL,
  applyAerialPerspectiveToShaderMaterial,
  type AerialPerspectiveBinding,
} from "@/src/render/webgpu/atmosphere/AerialPerspective";
import {
  relativeAirMass,
} from "@/src/render/webgpu/atmosphere/StarCatalogue";

/**
 * `7-5` — the ~200 lights you SEE.
 *
 * Instanced emissive billboards that **illuminate nothing**; the illumination
 * is `7-4b`'s clustered lighting. Two systems, one for what a light looks like
 * and one for what it does, is deliberate — `RENDERING_PLAN.md:183-190`.
 *
 * ONE INSTANCED DRAW. That is a design constraint rather than an aspiration:
 * the night shot's draw ceiling is 160, and a per-fixture draw would spend
 * more than the whole airfield's budget on geometry that covers a few hundred
 * pixels.
 *
 * WHY THIS CLONES `StarFieldSystem` RATHER THAN INVENTING A BRIGHTNESS MODEL.
 * A star and a runway edge light are the same rendering problem — a point
 * source smaller than a pixel, whose apparent brightness must survive changes
 * in render scale, PSF radius and distance without changing its total flux.
 * The star field already solves it, and two point-source brightness models
 * would drift exactly as two sun discs once did in this renderer. So the PSF,
 * its `exp(-4.5 r^2)` profile, and above all its **flux normalisation** are
 * taken from `StarField.ts` unchanged.
 *
 * THREE THINGS THAT ARE *NOT* THE STAR FIELD, and each is a real difference:
 *
 *  1. **Light points are at finite world positions**, so they take real depth
 *     and are occluded by geometry in front of them. Stars write reversed-Z
 *     far and are occluded by everything.
 *  2. **They resolve.** A star is never larger than its PSF; a runway light at
 *     50 m is a visible disc. The near->far transition below is what stops
 *     lights popping on approach (`7-5`'s third bullet), and it works by
 *     holding FLUX constant across the transition rather than by cross-fading
 *     two appearances.
 *  3. **Extinction is applied by hand.** `isOpaqueAerialReceiver` rejects
 *     `alpha < 1` and any non-zero `transparencyMode`, so an additive
 *     billboard cannot join the aerial-perspective registry
 *     ([AerialPerspective.ts:628-636]). It uses the owned include through
 *     `applyAerialPerspectiveToShaderMaterial` — NOT a second extinction
 *     model, which is the drift the include exists to prevent.
 *
 * WHAT IS DELIBERATELY NOT HERE. `LoadIESData` returns a **one-dimensional,
 * rotationally symmetric** profile: 180 vertical-angle samples at horizontal
 * angle 0, indexed by polar angle about the fixture axis. A PAPI is
 * azimuthally asymmetric with a sharp vertical transition, and a runway edge
 * light has a horizontal cutoff — **neither is a function of polar angle about
 * one axis** (D-3). IES carries the rotationally symmetric fixtures here; the
 * PAPI's law is authored analytically in `7-7`. Feeding a PAPI through this
 * path would produce a plausible light with the wrong law, which is worse than
 * no PAPI.
 */

/** Gaussian PSF radius in output pixels. Cloned from the star field so the two point-source models cannot drift. */
export const LIGHT_POINT_PSF_RADIUS_PIXELS = 1.7;

/**
 * The rendered radius of a light point, in pixels, and the flux normaliser
 * that keeps its total emitted flux invariant across the near->far transition.
 *
 * THE POP THIS PREVENTS. Far away a fixture is smaller than the PSF and must
 * be drawn AS the PSF, or it vanishes below a pixel. Near, it resolves into a
 * disc of real angular size. Cross-fading between "a glow" and "a disc" makes
 * the light change brightness as it crosses, which is exactly the pop
 * `7-5` calls out. Instead the rendered radius is the LARGER of the two, and
 * the normaliser follows the radius — so peak brightness falls as area grows
 * and the integral is unchanged. A light approaching the camera spreads, it
 * does not brighten.
 */
export function lightPointRadiusPixels(
  projectedRadiusPixels: number,
  psfRadiusPixels: number = LIGHT_POINT_PSF_RADIUS_PIXELS,
): number {
  return Math.max(psfRadiusPixels, projectedRadiusPixels);
}

/**
 * Angular softening of the beam edge, in cosine units.
 *
 * 0.08 is about 4.6 degrees at a hemisphere cutoff — enough that the edge does
 * not alias into a hard line as a lamp crosses it, and deliberately far coarser
 * than the 0.1 degree the PAPI's angular law is pinned to. A PAPI is NOT drawn
 * through this gate for exactly that reason; its indication is resolved on the
 * CPU by `AirfieldLightingSystem.update`.
 */
export const LIGHT_POINT_BEAM_SOFTNESS = 0.08;

/**
 * The beam gain for a fixture, mirroring the shader exactly.
 *
 * Exported so the gate can be asserted without a GPU — the WGSL below
 * interpolates the same constant, so this is not a parallel implementation of
 * the number, only of the expression.
 */
export function lightPointBeamGain(beamCosineCutoff: number, axisCosine: number): number {
  if (beamCosineCutoff <= -1) return 1;
  const t = (axisCosine - beamCosineCutoff) / LIGHT_POINT_BEAM_SOFTNESS;
  const clamped = Math.min(Math.max(t, 0), 1);
  return clamped * clamped * (3 - 2 * clamped);
}

/** Flux-conserving normaliser for a rendered radius. Mirrors the star field's `1 / psf^2`. */
export function lightPointFluxNormaliser(renderedRadiusPixels: number): number {
  return 1 / (renderedRadiusPixels * renderedRadiusPixels);
}

/**
 * IES lookup coordinate for a fixture aim and a direction to the viewer.
 *
 * Babylon's profile is candela against POLAR ANGLE from the fixture axis, so
 * the coordinate is that angle normalised to [0, 1]. Both arguments must be
 * unit vectors; `aim` points the way the fixture points and `toViewer` from
 * the fixture toward the eye, so a viewer on the beam axis reads u = 0.
 */
export function iesProfileCoordinate(
  aim: readonly [number, number, number],
  toViewer: readonly [number, number, number],
): number {
  const cosine = Math.min(Math.max(
    aim[0] * toViewer[0] + aim[1] * toViewer[1] + aim[2] * toViewer[2],
  -1), 1);
  return Math.acos(cosine) / Math.PI;
}

/**
 * Pack N one-dimensional IES profiles into one R32F texture, one row each.
 *
 * `LoadIESData` is the Light-free parser: it returns `{width, height: 1, data}`
 * of candela values against polar angle, so a fixture kind is a ROW and the
 * polar angle is the U axis. One texture for every kind keeps the promise this
 * module exists to keep -- ONE draw -- because a per-kind texture would mean a
 * per-kind material.
 *
 * THE RETURN SHAPE IS NOT WHAT IT SAYS, and this cost a real bug here. The
 * loader reports `{ width: 180, height: 1 }` but hands back a Float32Array of
 * **64,800** floats -- it builds a 180-phi x 360-theta grid and indexes it
 * `[phi + theta * 180]` (`iesLoader.js:124-146`), then returns `width / 2` and
 * a hardcoded `height: 1`. Code that trusts `height` reads 1/360th of the
 * buffer. This function takes the **theta = 0 column explicitly**, which is the
 * first 180 entries, because these fixtures are rotationally symmetric -- not
 * because that is all there is.
 *
 * AND THE LOADER IS NOT ONE-DIMENSIONAL. `InterpolateCandelaValues` lerps
 * across `candelaValues[thetaIndex]` and `[nextThetaIndex]`, so a .ies file
 * declaring several horizontal angles produces a genuinely azimuthally
 * asymmetric distribution. D-3 records the opposite; see the note filed against
 * it. If that is corrected, this function is where a 2D profile would land.
 */
export function packIesProfiles(
  scene: Scene,
  files: readonly Uint8Array[],
): { texture: RawTexture; rows: number; width: number } {
  if (files.length === 0) throw new RangeError("packIesProfiles: no profiles");
  const parsed = files.map((file) => LoadIESData(file));
  const rows = parsed.length;
  // The loader always emits 180 phi samples per theta column, whatever the
  // source file's angular resolution -- it resamples internally. So the width
  // is fixed rather than negotiated, and a file with 19 measured angles and one
  // with 200 both arrive as 180.
  const width = IES_PHI_SAMPLES;
  const data = new Float32Array(width * rows);
  for (let row = 0; row < rows; row += 1) {
    const profile = parsed[row]!;
    if (profile.data.length < width) {
      throw new RangeError(
        `packIesProfiles: profile ${row} has ${profile.data.length} samples, `
        + `fewer than the ${width} phi samples the loader is documented to emit`,
      );
    }
    // The theta = 0 column: entries [0, 180) of a [phi + theta * 180] grid.
    //
    // TWO CORRECTIONS TO THE LOADER, both VERIFIED against the compiled
    // `@babylonjs/core/Lights/IES/iesLoader.js` rather than taken on report,
    // and both latent until a real `.ies` file flows through this function.
    //
    // 1. CLAMP. `InterpolateCandelaValues` lets its interpolant exceed 1 past
    //    the file's last vertical angle, so it EXTRAPOLATES rather than holding
    //    the endpoint. Measured on a 0-90 degree file falling 100 -> 0:
    //    **32,040 of 64,800 entries come back NEGATIVE**, reaching -0.9889.
    //    Real edge-light and downlight files commonly span 0-90 degrees, so
    //    roughly half of such a profile would be negative candela feeding
    //    straight into the shader's gain chain — a lamp that SUBTRACTS light.
    //
    // 2. SQUARE ROOT. `iesLoader.js:111` reads
    //    `candelaValues[i][j] *= candelaValues[i][j] * multiplier * ...`,
    //    which squares the photometry before max-normalising, so a packed row
    //    holds `(x / xmax)^2`. Every IES-driven fixture would render with the
    //    SQUARE of its real angular falloff: beams too narrow, tails crushed.
    //    Measured on a linear 100 -> 50 file, the midpoint returns 0.6250
    //    where 0.75 is correct — and 0.6250 is exactly `lerp(1, 0.25, 0.5)`,
    //    which identifies it as lerp-of-squares rather than a scale error.
    //
    // WHAT THE SQUARE ROOT DOES AND DOES NOT RECOVER, stated because it is
    // tempting to call it exact: the loader squares BEFORE interpolating, so
    // `sqrt` is exact at the file's own sample angles (the 100 -> 50 endpoint
    // returns 0.5041) and approximate between them (the midpoint returns
    // 0.7906 against 0.75). It turns a -16.7% error into +5.4% and removes the
    // systematic narrowing; it cannot undo interpolation performed in squared
    // space. Doing that would mean re-implementing the loader's sampling.
    //
    // The clamp precedes the root, or a negative would produce NaN.
    for (let phi = 0; phi < width; phi += 1) {
      data[row * width + phi] = Math.sqrt(Math.max(profile.data[phi]!, 0));
    }
  }
  const texture = RawTexture.CreateRTexture(
    data,
    width,
    rows,
    scene,
    false,
    false,
    // The profile is a smooth function of angle, so filtering across it is
    // correct; NEAREST would step the beam edge.
    Texture.BILINEAR_SAMPLINGMODE,
    EngineConstants.TEXTURETYPE_FLOAT,
  );
  texture.name = "ies-profiles";
  texture.wrapU = Texture.CLAMP_ADDRESSMODE;
  texture.wrapV = Texture.CLAMP_ADDRESSMODE;
  return { texture, rows, width };
}

/** Phi samples per theta column that `LoadIESData` always emits (`iesLoader.js:124`). */
export const IES_PHI_SAMPLES = 180;

const LIGHT_POINT_SHADER_NAME = "lightPoints";

/**
 * The billboard shader.
 *
 * The vertex stage carries the whole photometric chain — IES gain, elevation
 * extinction, flux normalisation — because all of it is per-FIXTURE, not
 * per-fragment, and doing it once per light instead of once per covered pixel
 * is the difference between a free effect and a measurable one at 200 lights.
 * The fragment stage does the PSF and nothing else.
 */
export const LIGHT_POINT_WGSL = /* wgsl */ `
// position must be declared even though Babylon lists it in the material's
// attributes: the WGSL processor builds VertexInputs from THESE declarations,
// so omitting it compiles to "struct member position not found".
attribute position: vec3f;
attribute lightCorner: vec2f;
attribute lightParams: vec4f;
attribute lightAim: vec3f;
attribute lightColor: vec3f;

varying lightOffset: vec2f;
varying lightTint: vec3f;

uniform worldViewProjection: mat4x4f;
uniform lightPixelSize: vec2f;
uniform lightPsfPixels: f32;
uniform lightCameraPosition: vec3f;
uniform lightIesRows: f32;
// Daylight suppression. Exactly 1 whenever the sun is at or below the horizon,
// so every night frame is bit-identical to one rendered without this term.
uniform lightDaylightAttenuation: f32;

var iesProfileSampler: sampler;
var iesProfile: texture_2d<f32>;

${AERIAL_PERSPECTIVE_WGSL}

// Babylon's WGSL convention: the VERTEX stage returns FragmentInputs and only
// the FRAGMENT stage returns FragmentOutputs. Writing FragmentOutputs here
// parses as an unresolved type and the pipeline is invalid -- caught on the
// adapter, invisible to tsc and to every Node test.
@vertex
fn main(input: VertexInputs) -> FragmentInputs {
  let worldPosition = vertexInputs.position;
  let toEye = uniforms.lightCameraPosition - worldPosition;
  let distanceMeters = max(length(toEye), 1.0);
  let toViewer = toEye / distanceMeters;

  // IES gain. The profile is rotationally symmetric about the fixture axis
  // (D-3): one row per fixture kind, polar angle across it.
  let axisCosine = clamp(dot(vertexInputs.lightAim, toViewer), -1.0, 1.0);
  let profileU = acos(axisCosine) / ${Math.PI};
  let profileV = (vertexInputs.lightParams.y + 0.5) / max(uniforms.lightIesRows, 1.0);
  let candela = textureSampleLevel(iesProfile, iesProfileSampler, vec2f(profileU, profileV), 0.0).r;

  // Beam gate. lightParams.w is the cosine of the beam half-angle; <= -1 means
  // omnidirectional and takes the constant path so a fixture with no beam is
  // never dimmed by the smoothstep's own lower edge. The 0.08 softening is
  // LIGHT_POINT_BEAM_SOFTNESS wide -- about 4.6 degrees at a hemisphere cutoff,
  // enough that the edge does not
  // alias into a hard line as a lamp crosses it, and far coarser than anything
  // the PAPI needs, which is why the PAPI is not drawn through this.
  let beamCutoff = vertexInputs.lightParams.w;
  let beam = select(
    smoothstep(beamCutoff, beamCutoff + ${LIGHT_POINT_BEAM_SOFTNESS}, axisCosine),
    1.0,
    beamCutoff <= -1.0,
  );

  // NO ELEVATION AIR MASS HERE, and its removal is a bug fix rather than a
  // simplification.
  //
  // This shader used to apply the star field's Kasten-Young air mass, on the
  // reasoning that a light point is a point source like a star and a second
  // air-mass model would drift against the star field. The source-kind analogy
  // holds; the PATH analogy does not. Kasten-Young integrates the FULL
  // atmospheric column to space as a function of elevation above the horizon.
  // A runway lamp is a terrestrial source a known, finite distance away, and it
  // is usually BELOW the viewer, which makes the elevation negative.
  //
  // MEASURED, not argued: at every approach geometry an aircraft can fly --
  // 1,200 m at 70 m, 500 m at 30 m, 200 m at 10 m, 1,200 m at 400 m -- the
  // negative elevation clamped to -2 degrees and the air mass pinned to its
  // own ceiling of 40, giving a CONSTANT extinction of 6.31e-4. A 1,585x
  // attenuation, identical in every case, on paths of a few hundred metres.
  // Nothing in the term varied with the geometry it was supposed to model.
  //
  // The correct extinction for a finite path is the aerial include's, applied
  // immediately below, which integrates altitude and distance. That was always
  // here; the air-mass term was a SECOND model layered on top of it, which is
  // the very thing the comment it replaced was worried about. Removing it
  // leaves exactly one.
  //
  // This was invisible for as long as it existed because no fixture ever
  // rendered: FlightRenderer built the system with an empty list.

  // The finite-path half of extinction, from the OWNED include rather than a
  // second model -- the elevation term above is the star path's, this is the
  // atmosphere's, and neither is restated here.
  //
  // TRANSMITTANCE ONLY, DELIBERATELY. aerialPerspective also returns
  // inScatter, and an opaque receiver adds it because the haze along the
  // path is part of what that surface looks like. An ADDITIVE billboard must
  // not: whatever drew behind it has already contributed the path's in-scatter
  // to the framebuffer, and adding it again would put the haze in twice --
  // once per light. A light point contributes its own flux, attenuated.
  let haze = aerialPerspective(worldPosition.y, distanceMeters, 0.0);

  // Inverse-square falloff to scene-linear radiance, then the photometry.
  let irradiance = vertexInputs.lightParams.x * candela * beam
    * uniforms.lightDaylightAttenuation
    / (distanceMeters * distanceMeters);

  var clipPosition = uniforms.worldViewProjection * vec4f(worldPosition, 1.0);

  // The fixture's own projected radius in pixels. lightParams.z is its
  // physical radius in metres.
  let projectedRadiusPixels = vertexInputs.lightParams.z
    / (distanceMeters * max(uniforms.lightPixelSize.y, 1e-6));
  // The near->far transition: draw at the LARGER of the PSF and the resolved
  // disc, and normalise flux by whichever won. Peak falls as area grows, the
  // integral does not move, and the light spreads on approach rather than
  // brightening. Cross-fading two appearances is what pops.
  let renderedRadiusPixels = max(uniforms.lightPsfPixels, projectedRadiusPixels);

  clipPosition = vec4f(
    clipPosition.xy
      + vertexInputs.lightCorner * renderedRadiusPixels
        * uniforms.lightPixelSize * clipPosition.w,
    clipPosition.zw,
  );
  vertexOutputs.position = clipPosition;
  vertexOutputs.lightOffset = vertexInputs.lightCorner;
  vertexOutputs.lightTint = vertexInputs.lightColor * irradiance * haze.transmittance
    / (renderedRadiusPixels * renderedRadiusPixels);
}
`;

export const LIGHT_POINT_FRAGMENT_WGSL = /* wgsl */ `
varying lightOffset: vec2f;
varying lightTint: vec3f;

@fragment
fn main(input: FragmentInputs) -> FragmentOutputs {
  let radiusSquared = dot(fragmentInputs.lightOffset, fragmentInputs.lightOffset);
  if (radiusSquared > 1.0) { discard; }
  // The star field's profile, unchanged. exp(-4.5) is 1.1% of peak, so the
  // cut at the quad edge is invisible.
  let psf = exp(-4.5 * radiusSquared);
  fragmentOutputs.color = vec4f(fragmentInputs.lightTint * psf, 1.0);
}
`;

/** One fixture, as the system consumes it. */
export interface LightPointFixture {
  readonly position: readonly [number, number, number];
  /** Unit vector the fixture points along. */
  readonly aim: readonly [number, number, number];
  /** Peak luminous intensity scale, scene-linear. */
  readonly intensity: number;
  /** Row of the IES profile texture this fixture's photometry lives in. */
  readonly profileRow: number;
  /** Physical emitter radius in metres — decides where it stops being a point. */
  readonly radiusMeters: number;
  readonly color: readonly [number, number, number];
  /**
   * Cosine of the beam half-angle, or `<= -1` for omnidirectional (the
   * default). `0` is a hemisphere: visible ahead of the fixture, dark behind.
   *
   * WHY THIS AND NOT AN IES ROW. The IES path can express a cutoff, but it
   * samples 180 values over 180 degrees — 1.0 deg/sample — and the cutoff would
   * land wherever the nearest sample is. That resolution is the same reason
   * `7-7` requires the PAPI's transition to be analytic rather than IES-sampled.
   * A beam is also not photometry: it is which way the lamp FACES, and folding
   * it into the profile would mean a new synthetic IES row per aiming, which is
   * a per-kind texture in disguise — the thing this module's ONE draw exists to
   * avoid. This rides the fourth `lightParams` slot, which was already
   * allocated and written as a constant zero.
   *
   * REQUIRED by airfield lighting: a threshold lamp is green to an aircraft
   * arriving over it and red to one rolling at it. Without a beam, one lamp
   * emitted per direction shows BOTH colours from both sides.
   */
  readonly beamCosineCutoff?: number;
}

/** Interleaved buffers for one instanced draw over every fixture. */
export function buildLightPointGeometry(fixtures: readonly LightPointFixture[]): {
  positions: Float32Array;
  indices: Uint32Array;
  corners: Float32Array;
  params: Float32Array;
  aims: Float32Array;
  colors: Float32Array;
} {
  const count = fixtures.length;
  const positions = new Float32Array(count * 4 * 3);
  const corners = new Float32Array(count * 4 * 2);
  const params = new Float32Array(count * 4 * 4);
  const aims = new Float32Array(count * 4 * 3);
  const colors = new Float32Array(count * 4 * 3);
  const indices = new Uint32Array(count * 6);
  const CORNERS: readonly (readonly [number, number])[] = [[-1, -1], [1, -1], [1, 1], [-1, 1]];

  for (let index = 0; index < count; index += 1) {
    const fixture = fixtures[index]!;
    for (let corner = 0; corner < 4; corner += 1) {
      const vertex = index * 4 + corner;
      positions[vertex * 3] = fixture.position[0];
      positions[vertex * 3 + 1] = fixture.position[1];
      positions[vertex * 3 + 2] = fixture.position[2];
      corners[vertex * 2] = CORNERS[corner]![0];
      corners[vertex * 2 + 1] = CORNERS[corner]![1];
      params[vertex * 4] = fixture.intensity;
      params[vertex * 4 + 1] = fixture.profileRow;
      params[vertex * 4 + 2] = fixture.radiusMeters;
      // `?? -1` and NOT `?? 0`: zero is a HEMISPHERE here, so defaulting to it
      // would silently darken the back half of every fixture that did not ask
      // for a beam. -1 is "no cutoff".
      params[vertex * 4 + 3] = fixture.beamCosineCutoff ?? -1;
      aims[vertex * 3] = fixture.aim[0];
      aims[vertex * 3 + 1] = fixture.aim[1];
      aims[vertex * 3 + 2] = fixture.aim[2];
      colors[vertex * 3] = fixture.color[0];
      colors[vertex * 3 + 1] = fixture.color[1];
      colors[vertex * 3 + 2] = fixture.color[2];
    }
    const base = index * 4;
    const out = index * 6;
    // Wound (a, c, b) — Babylon's convention, the pairing checked by
    // `render.webgpu-two-sided-coverage.test.ts`. This material is
    // `backFaceCulling = false` with NO `twoSidedLighting`, so it sits outside
    // that defect family, but the winding is correct rather than accidentally
    // correct.
    indices[out] = base;
    indices[out + 1] = base + 2;
    indices[out + 2] = base + 1;
    indices[out + 3] = base;
    indices[out + 4] = base + 3;
    indices[out + 5] = base + 2;
  }
  return { positions, indices, corners, params, aims, colors };
}

/**
 * The system. ONE mesh, ONE material, ONE draw, however many fixtures.
 */
export class LightPointSystem {
  private readonly mesh: Mesh;
  private readonly material: ShaderMaterial;
  readonly fixtureCount: number;
  /**
   * The fixtures as handed in, in ABSOLUTE world coordinates.
   *
   * Kept because the vertex buffer holds origin-RELATIVE positions and the
   * renderer rebases every 4,096 m flown (`FLOATING_ORIGIN_THRESHOLD`). The
   * absolute list is the only thing that survives a rebase unchanged, so it is
   * what the rebuilt buffer is derived from.
   */
  private readonly fixtures: readonly LightPointFixture[];
  private originX = 0;
  private originZ = 0;
  /**
   * A unit profile, bound at construction so the material is never incomplete.
   *
   * FOUND BY A TEST THAT READS THE FRAMEBUFFER, and it was a latent crash
   * rather than a dim frame: the shader samples `iesProfile` unconditionally,
   * and with no texture bound Babylon fails to build the bind group and
   * `createBindGroup` THROWS on the draw. Nothing in the tree ever called
   * `setIesProfiles` — so the first frame that drew a real fixture would have
   * thrown, every frame.
   *
   * It stayed invisible because the fixture list was EMPTY: no fixtures, no
   * draw, no bind group, no error. Populating the airfield is what would have
   * exposed it, in flight, as a hard failure.
   *
   * So the default is not a convenience. A system whose own draw call cannot
   * succeed until an optional setter is called is constructible into an invalid
   * state, and the fix belongs here rather than in a note telling every caller
   * to remember. Value 1.0 = unit candela at every angle, which makes the
   * beam gate and the inverse-square falloff the whole photometry until a real
   * profile is supplied.
   */
  private readonly defaultProfile: RawTexture;

  constructor(scene: Scene, fixtures: readonly LightPointFixture[], iesRows: number) {
    ShaderStore.ShadersStoreWGSL[`${LIGHT_POINT_SHADER_NAME}VertexShader`] = LIGHT_POINT_WGSL;
    ShaderStore.ShadersStoreWGSL[`${LIGHT_POINT_SHADER_NAME}PixelShader`] =
      LIGHT_POINT_FRAGMENT_WGSL;

    this.fixtureCount = fixtures.length;
    this.fixtures = fixtures;
    const geometry = buildLightPointGeometry(fixtures);
    this.mesh = new Mesh("light-points", scene);
    const data = new VertexData();
    data.positions = geometry.positions;
    data.indices = Array.from(geometry.indices);
    // UPDATABLE, and its absence was the defect that kept the airfield dark.
    // `position` is rewritten by `setFloatingOrigin` and `lightColor` by
    // `setColors`; a non-updatable buffer cannot take either write, and Babylon
    // does not report the attempt. The capture world's airport sits ~30 km from
    // the world origin, so the renderer rebases on the FIRST frame -- after
    // which the camera works in origin-relative space while the lamp positions
    // were still absolute, putting all 402 of them ~30 km outside the frustum.
    // The mesh was submitted every frame (draw calls went +1 on 30 of 30 shots)
    // and produced no fragment anywhere, which reads exactly like "the lamps are
    // too dim" and is not.
    data.applyToMesh(this.mesh, true);
    this.mesh.setVerticesData("lightCorner", geometry.corners, false, 2);
    this.mesh.setVerticesData("lightParams", geometry.params, false, 4);
    this.mesh.setVerticesData("lightAim", geometry.aims, false, 3);
    this.mesh.setVerticesData("lightColor", geometry.colors, true, 3);
    this.mesh.isPickable = false;
    this.mesh.applyFog = false;
    this.mesh.alwaysSelectAsActiveMesh = true;
    this.mesh.receiveShadows = false;

    this.material = new ShaderMaterial(
      "light-points-material",
      scene,
      LIGHT_POINT_SHADER_NAME,
      {
        attributes: ["position", "lightCorner", "lightParams", "lightAim", "lightColor"],
        uniforms: [
          "worldViewProjection",
          "lightPixelSize",
          "lightPsfPixels",
          "lightCameraPosition",
          "lightIesRows",
          "lightDaylightAttenuation",
          ...AERIAL_PERSPECTIVE_UNIFORMS,
        ],
        samplers: ["iesProfile"],
        shaderLanguage: ShaderLanguage.WGSL,
      },
    );
    this.material.backFaceCulling = false;
    this.material.disableDepthWrite = true;
    // Additive: a fixture ADDS its flux to whatever is behind it, which is why
    // a bright approach light still reads against a lit apron and a dim taxiway
    // edge does not.
    this.material.alphaMode = Constants.ALPHA_ADD;
    this.material.needAlphaBlending = () => true;
    this.defaultProfile = RawTexture.CreateRTexture(
      new Float32Array([1]),
      1,
      1,
      scene,
      false,
      false,
      Texture.BILINEAR_SAMPLINGMODE,
      EngineConstants.TEXTURETYPE_FLOAT,
    );
    this.defaultProfile.name = "ies-unit-profile";
    this.defaultProfile.wrapU = Texture.CLAMP_ADDRESSMODE;
    this.defaultProfile.wrapV = Texture.CLAMP_ADDRESSMODE;
    this.material.setTexture("iesProfile", this.defaultProfile);
    this.material.setFloat("lightPsfPixels", LIGHT_POINT_PSF_RADIUS_PIXELS);
    this.material.setFloat("lightIesRows", Math.max(iesRows, 1));
    // Defaults to full effect: a renderer that never calls the setter behaves
    // exactly as it did before this term existed, rather than dark.
    this.material.setFloat("lightDaylightAttenuation", 1);
    this.material.setVector2("lightPixelSize", new Vector2(1, 1));
    this.mesh.material = this.material;
  }

  /**
   * Re-anchor the fixtures after a floating-origin rebase.
   *
   * THIS IS NOT OPTIONAL AND ITS ABSENCE IS SILENT. The shader computes
   * `toEye = lightCameraPosition - worldPosition` from the raw vertex
   * attribute, and `FlightRenderer` feeds it `camera.position`, which is
   * ORIGIN-RELATIVE (`FlightRenderer` stores it as `state.position - origin`).
   * `worldViewProjection` likewise transforms the raw attribute. So the buffer
   * must hold origin-relative positions or both the projection and the
   * inverse-square falloff are wrong by the origin — 4,096 m at the first
   * rebase, which puts every lamp below the horizon rather than merely in the
   * wrong place.
   *
   * O(fixtures) and called once per 4,096 m flown, not per frame.
   */
  setFloatingOrigin(originX: number, originZ: number): void {
    if (originX === this.originX && originZ === this.originZ) return;
    this.originX = originX;
    this.originZ = originZ;
    if (this.fixtureCount === 0) return;
    const positions = new Float32Array(this.fixtureCount * 4 * 3);
    for (let index = 0; index < this.fixtureCount; index += 1) {
      const fixture = this.fixtures[index]!;
      for (let corner = 0; corner < 4; corner += 1) {
        const vertex = index * 4 + corner;
        positions[vertex * 3] = fixture.position[0] - originX;
        positions[vertex * 3 + 1] = fixture.position[1];
        positions[vertex * 3 + 2] = fixture.position[2] - originZ;
      }
    }
    this.mesh.updateVerticesData("position", positions, false, false);
  }

  /**
   * Replace every fixture colour, one entry per fixture.
   *
   * Exists for the PAPI, whose indication is a STEP function of the observer's
   * elevation angle and therefore changes rarely — so this is called on a
   * transition, not per frame. Rewriting the whole buffer rather than a range
   * keeps the call shape honest about what it costs and avoids an index
   * arithmetic bug in the caller for a saving nobody measured.
   */
  setColors(colors: readonly (readonly [number, number, number])[]): void {
    if (colors.length !== this.fixtureCount) {
      throw new Error(
        `light-point colour update has ${colors.length} entries for `
        + `${this.fixtureCount} fixtures`,
      );
    }
    if (this.fixtureCount === 0) return;
    const buffer = new Float32Array(this.fixtureCount * 4 * 3);
    for (let index = 0; index < this.fixtureCount; index += 1) {
      const colour = colors[index]!;
      for (let corner = 0; corner < 4; corner += 1) {
        const vertex = index * 4 + corner;
        buffer[vertex * 3] = colour[0];
        buffer[vertex * 3 + 1] = colour[1];
        buffer[vertex * 3 + 2] = colour[2];
      }
    }
    this.mesh.updateVerticesData("lightColor", buffer, false, false);
  }

  /**
   * Per-frame haze binding, resolved once by the renderer for every consumer.
   * Mirrors `HydrologySystem.setAerialPerspective` exactly; a second call
   * shape would be a second integration point for one owned include.
   */
  setAerialPerspective(binding: AerialPerspectiveBinding): void {
    applyAerialPerspectiveToShaderMaterial(
      this.material,
      binding,
      (name, x, y, z) => this.material.setVector3(name, new Vector3(x, y, z)),
      (name, x, y, z, w) => this.material.setVector4(name, new Vector4(x, y, z, w)),
    );
  }

  /**
   * NDC-per-pixel, so the sprite is sized in OUTPUT PIXELS and render scale
   * cannot change its apparent size. Same call shape and same arithmetic as
   * `StarFieldSystem.setRenderSize` deliberately: two sprite-sizing rules that
   * looked alike but computed differently would be the drift this module
   * exists to avoid.
   */
  setRenderSize(widthPixels: number, heightPixels: number): void {
    this.material.setVector2(
      "lightPixelSize",
      new Vector2(2 / Math.max(1, widthPixels), 2 / Math.max(1, heightPixels)),
    );
  }

  /** The camera position the inverse-square falloff and IES angle are taken from. */
  /**
   * Daylight suppression, from `airfieldLampDaylightAttenuation`.
   *
   * Clamped here as well as computed there: this value multiplies every lamp in
   * the scene, so a NaN or a negative arriving from a future caller would take
   * the whole airfield out silently rather than loudly.
   */
  setDaylightAttenuation(attenuation: number): void {
    const safe = Number.isFinite(attenuation)
      ? Math.min(1, Math.max(0, attenuation))
      : 1;
    this.material.setFloat("lightDaylightAttenuation", safe);
  }

  setCameraPosition(position: Vector3): void {
    this.material.setVector3("lightCameraPosition", position);
  }

  /** Bind the packed IES profile texture. */
  setIesProfiles(texture: RawTexture): void {
    this.material.setTexture("iesProfile", texture);
  }

  dispose(): void {
    this.mesh.dispose(false, true);
    this.material.dispose();
    this.defaultProfile.dispose();
  }
}
