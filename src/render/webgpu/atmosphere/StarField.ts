import { Constants } from "@babylonjs/core/Engines/constants";
import { ShaderStore } from "@babylonjs/core/Engines/shaderStore";
import { ShaderLanguage } from "@babylonjs/core/Materials/shaderLanguage";
import { ShaderMaterial } from "@babylonjs/core/Materials/shaderMaterial";
import { Vector2, Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { VertexData } from "@babylonjs/core/Meshes/mesh.vertexData";
import type { Scene } from "@babylonjs/core/scene";
import type { EnvironmentClock } from "@/src/world/environmentClock";
import {
  brightStars,
  colorForColorIndex,
  equatorialToWorld,
  equatorialToWorldRows,
  generateBackgroundStars,
  localSiderealTimeHours,
  GALACTIC_CENTER_EQUATORIAL,
  GALACTIC_POLE_EQUATORIAL,
  STAR_EXTINCTION_MAGNITUDES_PER_AIRMASS,
  type CatalogueStar,
} from "./StarCatalogue";

/**
 * `7-3` — the star field (owner: lighting).
 *
 * One additive draw of magnitude-driven point sprites. The catalogue and the
 * frame come from `StarCatalogue`; this file is the GPU side and nothing
 * else. The `1C-10` placeholder — a hash of the view direction inside the
 * sky fragment, which put a fixed pattern of identical "stars" on a dome
 * that never rotated — is deleted with it.
 *
 * Resolution independence is the reason this is a quad per star and not a
 * point primitive: the sprite is sized in PIXELS in clip space, so a star is
 * the same apparent size at every render scale and the governor cannot make
 * the sky sparkle. The PSF is a Gaussian whose total flux is held constant
 * when the radius changes, so the pixel size is a look knob and not a
 * brightness knob.
 *
 * **Scene scale, stated plainly (a recorded deviation).** A magnitude-0 star
 * delivers 2.54 × 10⁻⁶ lux and the sun 1.2 × 10⁵ — a range of 4.7 × 10¹⁰,
 * against an fp16 beauty target whose smallest normal value is 6.1 × 10⁻⁵.
 * Rendering night at its photometric scale therefore requires a scene
 * PRE-EXPOSURE, which this programme does not have and which `1C-2`
 * deliberately did not build (assertion 29 forbids a shader multiplying its
 * own exposure, and a pre-exposure is exactly that, applied everywhere). So
 * the absolute scale here is art-directed by one named constant and every
 * RELATIVE quantity — magnitude ratios, atmospheric extinction, the
 * chromaticity of each spectral class — is physical. `7-2` reads the true
 * physical illuminance for the rod/cone blend, so what the viewer perceives
 * is driven by real photometry even though the buffer is not.
 */

const STAR_SHADER_NAME = "aerolithStarField";

/**
 * Scene-linear value of a magnitude-0 star at the centre of its PSF, before
 * extinction and twilight suppression. See the scale note above: this is the
 * one art-directed constant, and Sirius at −1.46 lands 3.8× above it.
 */
export const STAR_ZERO_MAGNITUDE_SCENE_VALUE = 0.5;

/** Gaussian PSF radius in output pixels. Flux is normalised against it. */
export const STAR_PSF_RADIUS_PIXELS = 1.7;

/** Radius the dome is drawn at, metres. Inside the 45 km far plane. */
const STAR_DOME_RADIUS_METERS = 40_000;

const STAR_VERTEX_WGSL = /* wgsl */ `
attribute position: vec3f;
attribute starCorner: vec2f;
attribute starParams: vec4f;

uniform worldViewProjection: mat4x4f;
uniform starRowEast: vec3f;
uniform starRowUp: vec3f;
uniform starRowNorth: vec3f;
uniform starPixelSize: vec2f;
uniform starVisibility: f32;
uniform starIntensity: f32;
uniform starPsfPixels: f32;

varying starOffset: vec2f;
varying starTint: vec3f;

@vertex
fn main(input: VertexInputs) -> FragmentInputs {
  // Equatorial -> horizon, by the rows the CPU built from the local sidereal
  // time and the latitude. The catalogue never moves; the frame does.
  let equatorial = vertexInputs.position;
  let direction = vec3f(
    dot(uniforms.starRowEast, equatorial),
    dot(uniforms.starRowUp, equatorial),
    dot(uniforms.starRowNorth, equatorial),
  );
  // Kasten-Young relative air mass, and the V-band extinction it costs. The
  // point of doing it per star rather than as a horizon fade is that it is
  // MAGNITUDE-dependent: a first-magnitude star still shows at 5° where a
  // fourth-magnitude one has already gone, which is what the horizon of a
  // real sky looks like.
  let altitudeDegrees = degrees(asin(clamp(direction.y, -1.0, 1.0)));
  let clamped = max(altitudeDegrees, -2.0);
  let airMass = 1.0 / (sin(radians(clamped))
    + 0.50572 * pow(clamped + 6.07995, -1.6364));
  let extinguished = vertexInputs.starParams.w
    + ${STAR_EXTINCTION_MAGNITUDES_PER_AIRMASS} * clamp(airMass, 1.0, 40.0);
  var brightness = pow(10.0, -0.4 * extinguished)
    * uniforms.starIntensity
    * uniforms.starVisibility;
  // Below the horizon there is a planet in the way.
  brightness = brightness * smoothstep(-0.012, 0.004, direction.y);

  var clipPosition = uniforms.worldViewProjection
    * vec4f(direction * ${STAR_DOME_RADIUS_METERS}.0, 1.0);
  // Screen-space quad: the sprite is sized in PIXELS, so render scale cannot
  // change a star's apparent size.
  clipPosition = vec4f(
    clipPosition.xy
      + vertexInputs.starCorner * uniforms.starPsfPixels
        * uniforms.starPixelSize * clipPosition.w,
    clipPosition.zw,
  );
  // Reversed-Z far value, exactly as the sky dome does it: the star passes
  // only where nothing nearer has been drawn, so terrain occludes it.
  clipPosition.z = 0.0;
  vertexOutputs.position = clipPosition;
  vertexOutputs.starOffset = vertexInputs.starCorner;
  // Flux, not peak, is held constant when the PSF radius changes.
  vertexOutputs.starTint = vertexInputs.starParams.xyz
    * (brightness / (uniforms.starPsfPixels * uniforms.starPsfPixels));
}
`;

const STAR_FRAGMENT_WGSL = /* wgsl */ `
varying starOffset: vec2f;
varying starTint: vec3f;

@fragment
fn main(input: FragmentInputs) -> FragmentOutputs {
  let radiusSquared = dot(fragmentInputs.starOffset, fragmentInputs.starOffset);
  if (radiusSquared > 1.0) { discard; }
  // Gaussian point-spread function, cut at the quad edge. exp(-4.5) is
  // 1.1% of peak, so the cut is invisible.
  let psf = exp(-4.5 * radiusSquared);
  fragmentOutputs.color = vec4f(fragmentInputs.starTint * psf, 1.0);
}
`;

function registerShaders(): void {
  ShaderStore.ShadersStoreWGSL[`${STAR_SHADER_NAME}VertexShader`] = STAR_VERTEX_WGSL;
  ShaderStore.ShadersStoreWGSL[`${STAR_SHADER_NAME}PixelShader`] = STAR_FRAGMENT_WGSL;
}

export interface StarFieldGeometry {
  readonly positions: Float32Array;
  readonly corners: Float32Array;
  readonly params: Float32Array;
  readonly indices: Uint32Array;
  readonly starCount: number;
}

/**
 * Builds the quad soup. Pure — the geometry is a function of the catalogue
 * alone, so the star count, the magnitude distribution and the packing are
 * all Node-testable without an adapter.
 */
export function buildStarFieldGeometry(
  stars: readonly CatalogueStar[],
): StarFieldGeometry {
  const count = stars.length;
  const positions = new Float32Array(count * 4 * 3);
  const corners = new Float32Array(count * 4 * 2);
  const params = new Float32Array(count * 4 * 4);
  const indices = new Uint32Array(count * 6);
  const cornerX = [-1, 1, 1, -1];
  const cornerY = [-1, -1, 1, 1];
  stars.forEach((star, index) => {
    const color = colorForColorIndex(star.colorIndex);
    for (let corner = 0; corner < 4; corner += 1) {
      const vertex = index * 4 + corner;
      positions[vertex * 3] = star.equatorial[0];
      positions[vertex * 3 + 1] = star.equatorial[1];
      positions[vertex * 3 + 2] = star.equatorial[2];
      corners[vertex * 2] = cornerX[corner]!;
      corners[vertex * 2 + 1] = cornerY[corner]!;
      params[vertex * 4] = color[0];
      params[vertex * 4 + 1] = color[1];
      params[vertex * 4 + 2] = color[2];
      params[vertex * 4 + 3] = star.magnitude;
    }
    const base = index * 4;
    indices.set(
      [base, base + 1, base + 2, base, base + 2, base + 3],
      index * 6,
    );
  });
  return { positions, corners, params, indices, starCount: count };
}

/**
 * Twilight suppression, 0…1. Stars do not switch on at sunset — the sky's
 * own brightness drowns them, first-magnitude stars appearing around civil
 * twilight (sun −6°) and the sixth magnitude only after astronomical
 * twilight (−18°). One smoothstep over the sun's elevation reproduces the
 * order for free, because the extinction term is already magnitude-scaled.
 */
export function starVisibilityForSunElevation(sunElevationSine: number): number {
  const civil = Math.sin((-6 * Math.PI) / 180);
  const astronomical = Math.sin((-16 * Math.PI) / 180);
  const t = Math.min(1, Math.max(0, (civil - sunElevationSine) / (civil - astronomical)));
  return t * t * (3 - 2 * t);
}

export class StarFieldSystem {
  private readonly mesh: Mesh;
  private readonly material: ShaderMaterial;
  readonly starCount: number;

  constructor(scene: Scene, seed = 1) {
    registerShaders();
    const stars = [...brightStars(), ...generateBackgroundStars(seed)];
    this.starCount = stars.length;
    const geometry = buildStarFieldGeometry(stars);
    this.mesh = new Mesh("star-field", scene);
    const data = new VertexData();
    data.positions = geometry.positions;
    data.indices = geometry.indices;
    data.applyToMesh(this.mesh, false);
    this.mesh.setVerticesData("starCorner", geometry.corners, false, 2);
    this.mesh.setVerticesData("starParams", geometry.params, false, 4);
    this.mesh.infiniteDistance = true;
    this.mesh.isPickable = false;
    this.mesh.applyFog = false;
    this.mesh.alwaysSelectAsActiveMesh = true;
    this.mesh.receiveShadows = false;

    this.material = new ShaderMaterial(
      "star-field-material",
      scene,
      STAR_SHADER_NAME,
      {
        attributes: ["position", "starCorner", "starParams"],
        uniforms: [
          "worldViewProjection",
          "starRowEast",
          "starRowUp",
          "starRowNorth",
          "starPixelSize",
          "starVisibility",
          "starIntensity",
          "starPsfPixels",
        ],
        shaderLanguage: ShaderLanguage.WGSL,
      },
    );
    this.material.backFaceCulling = false;
    this.material.disableDepthWrite = true;
    // Additive: a star ADDS its flux to the sky already there, which is why
    // a bright star still reads against twilight and a faint one does not.
    this.material.alphaMode = Constants.ALPHA_ADD;
    this.material.needAlphaBlending = () => true;
    this.material.setFloat("starPsfPixels", STAR_PSF_RADIUS_PIXELS);
    this.material.setFloat("starIntensity", STAR_ZERO_MAGNITUDE_SCENE_VALUE);
    this.material.setFloat("starVisibility", 0);
    this.material.setVector2("starPixelSize", new Vector2(2 / 1280, 2 / 720));
    this.material.setVector3("starRowEast", new Vector3(1, 0, 0));
    this.material.setVector3("starRowUp", new Vector3(0, 0, 1));
    this.material.setVector3("starRowNorth", new Vector3(0, 1, 0));
    this.mesh.material = this.material;
    this.mesh.setEnabled(false);
  }

  /** The sky's frame for this clock instant, plus the twilight fade. */
  setClock(
    clock: EnvironmentClock,
    latitudeDegrees: number,
    sunElevationSine: number,
  ): void {
    const rows = equatorialToWorldRows(localSiderealTimeHours(clock), latitudeDegrees);
    this.material.setVector3("starRowEast", Vector3.FromArray([...rows[0]]));
    this.material.setVector3("starRowUp", Vector3.FromArray([...rows[1]]));
    this.material.setVector3("starRowNorth", Vector3.FromArray([...rows[2]]));
    const visibility = starVisibilityForSunElevation(sunElevationSine);
    this.material.setFloat("starVisibility", visibility);
    this.mesh.setEnabled(visibility > 0.002);
  }

  /**
   * Keeps the sprite size in OUTPUT pixels as the canvas resizes.
   *
   * **Was `setRenderSize`, and the caller passed the scaled raster**, so at any
   * render scale below 1 a star drew wider than its stated pixel size -- 16.3%
   * at tier 1's 0.86. The constructor above initialises `starPixelSize` to
   * `2 / 1280, 2 / 720`, the OUTPUT size, so the intent was never in doubt;
   * only the setter's argument was. Same defect and same fix as
   * `LightPointSystem.setOutputSize`.
   */
  setOutputSize(widthPixels: number, heightPixels: number): void {
    this.material.setVector2(
      "starPixelSize",
      new Vector2(2 / Math.max(1, widthPixels), 2 / Math.max(1, heightPixels)),
    );
  }

  update(cameraLocalPosition: Vector3): void {
    this.mesh.position.copyFrom(cameraLocalPosition);
  }

  /** The galactic frame in world axes, for the sky's Milky Way band. */
  galacticFrame(
    clock: EnvironmentClock,
    latitudeDegrees: number,
  ): { readonly pole: [number, number, number]; readonly center: [number, number, number] } {
    const rows = equatorialToWorldRows(localSiderealTimeHours(clock), latitudeDegrees);
    return {
      pole: equatorialToWorld(GALACTIC_POLE_EQUATORIAL, rows),
      center: equatorialToWorld(GALACTIC_CENTER_EQUATORIAL, rows),
    };
  }

  dispose(): void {
    this.mesh.dispose(false, false);
    this.material.dispose(true, true);
  }
}
