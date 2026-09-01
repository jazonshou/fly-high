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
  STAR_EXTINCTION_MAGNITUDES_PER_AIRMASS,
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
 * Atmospheric transmission for a light point at a given elevation.
 *
 * Uses the star path's `relativeAirMass` and its extinction coefficient
 * DIRECTLY rather than restating them, which is what makes `7-5`'s pin —
 * *"extinction agrees with the star path's air mass at matched elevations"* —
 * true by construction instead of by tuning. A second Kasten-Young here is the
 * same defect as a second sun disc.
 *
 * This is the ELEVATION-dependent half. The finite-path half (in-scatter and
 * range extinction between the fixture and the camera) is the aerial
 * perspective include's, applied in the shader.
 */
export function lightPointAtmosphericTransmission(elevationDegrees: number): number {
  const magnitudes = STAR_EXTINCTION_MAGNITUDES_PER_AIRMASS
    * Math.min(Math.max(relativeAirMass(elevationDegrees), 1), 40);
  return 10 ** (-0.4 * magnitudes);
}

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
    for (let phi = 0; phi < width; phi += 1) {
      data[row * width + phi] = profile.data[phi]!;
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

var iesProfileSampler: sampler;
var iesProfile: texture_2d<f32>;

${AERIAL_PERSPECTIVE_WGSL}

@vertex
fn main(input: VertexInputs) -> FragmentOutputs {
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

  // Elevation extinction, Kasten-Young, the STAR PATH'S coefficients. A
  // second air-mass model here would drift against the star field exactly as
  // a second sun disc once did.
  let elevationDegrees = degrees(asin(clamp(-toViewer.y, -1.0, 1.0)));
  let clampedElevation = max(elevationDegrees, -2.0);
  let airMass = 1.0 / (sin(radians(clampedElevation))
    + 0.50572 * pow(clampedElevation + 6.07995, -1.6364));
  let extinction = pow(10.0, -0.4 * ${STAR_EXTINCTION_MAGNITUDES_PER_AIRMASS}
    * clamp(airMass, 1.0, 40.0));

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
  let irradiance = vertexInputs.lightParams.x * candela * extinction
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
      params[vertex * 4 + 3] = 0;
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

  constructor(scene: Scene, fixtures: readonly LightPointFixture[], iesRows: number) {
    ShaderStore.ShadersStoreWGSL[`${LIGHT_POINT_SHADER_NAME}VertexShader`] = LIGHT_POINT_WGSL;
    ShaderStore.ShadersStoreWGSL[`${LIGHT_POINT_SHADER_NAME}PixelShader`] =
      LIGHT_POINT_FRAGMENT_WGSL;

    this.fixtureCount = fixtures.length;
    const geometry = buildLightPointGeometry(fixtures);
    this.mesh = new Mesh("light-points", scene);
    const data = new VertexData();
    data.positions = geometry.positions;
    data.indices = Array.from(geometry.indices);
    data.applyToMesh(this.mesh, false);
    this.mesh.setVerticesData("lightCorner", geometry.corners, false, 2);
    this.mesh.setVerticesData("lightParams", geometry.params, false, 4);
    this.mesh.setVerticesData("lightAim", geometry.aims, false, 3);
    this.mesh.setVerticesData("lightColor", geometry.colors, false, 3);
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
    this.material.setFloat("lightPsfPixels", LIGHT_POINT_PSF_RADIUS_PIXELS);
    this.material.setFloat("lightIesRows", Math.max(iesRows, 1));
    this.material.setVector2("lightPixelSize", new Vector2(1, 1));
    this.mesh.material = this.material;
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
  }
}
