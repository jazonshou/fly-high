import { Constants } from "@babylonjs/core/Engines/constants";
// Side-effect imports: register the sphericalPolynomial accessors and the
// scene's reflection-probe list on the tree-shaken build.
import "@babylonjs/core/Materials/Textures/baseTexture.polynomial";
import { RenderTargetTexture } from "@babylonjs/core/Materials/Textures/renderTargetTexture";
import { Texture } from "@babylonjs/core/Materials/Textures/texture";
import type { SphericalPolynomial } from "@babylonjs/core/Maths/sphericalPolynomial";
import type { Mesh } from "@babylonjs/core/Meshes/mesh";
import { CubeMapToSphericalPolynomialTools } from "@babylonjs/core/Misc/HighDynamicRange/cubemapToSphericalPolynomial";
import { ReflectionProbe } from "@babylonjs/core/Probes/reflectionProbe";
import type { Scene } from "@babylonjs/core/scene";
import {
  evaluateSkyRadiance,
  type AerialPerspectiveBinding,
} from "./AerialPerspective";

/**
 * The sky environment probe (1C-6) — image-based lighting from the one sky.
 *
 * INVARIANT THIS FILE OWNS: `scene.environmentTexture` and its spherical-
 * harmonics irradiance both derive from the SAME skyRadiance() the sky dome
 * and the aerial perspective evaluate. Before this file the entire indirect
 * budget was one unshadowed HemisphericLight at 4.4% of the light budget and
 * every `environmentIntensity` under 1.0 was a dead uniform compensating for
 * IBL that did not exist.
 *
 * Diffuse: the TS mirror of skyRadiance() sampled over a small cube and fed
 * through Babylon's ConvertCubeMapToSphericalPolynomial — a pure array API,
 * Node-testable, no GPU readback. The sampling is milliseconds of main-thread
 * work, so a re-light can also run sliced across frames (beginRebake), with
 * a bit-identical result.
 *
 * Specular: a 128 px half-float mipped cube RTT that renders the actual sky
 * dome through a ReflectionProbe. Deviation from the plan's one-face-per-
 * frame cadence, recorded: the sun is static between clock scrubs, so the
 * probe re-renders all six faces once per environment change (a six-draw
 * 128 px pass over a ~100-ALU shader) instead of trickling faces every
 * frame. Simpler, and the probe is never six frames stale after a scrub.
 */

export const SKY_PROBE_SIZE = 128;
export const SKY_IRRADIANCE_SAMPLE_SIZE = 16;

interface CubeFaceOrientation {
  readonly name: "right" | "left" | "up" | "down" | "front" | "back";
  readonly normal: readonly [number, number, number];
  readonly fileX: readonly [number, number, number];
  readonly fileY: readonly [number, number, number];
}

/** Must match CubeMapToSphericalPolynomialTools._FileFaces exactly. */
const CUBE_FACES: readonly CubeFaceOrientation[] = [
  { name: "right", normal: [1, 0, 0], fileX: [0, 0, -1], fileY: [0, -1, 0] },
  { name: "left", normal: [-1, 0, 0], fileX: [0, 0, 1], fileY: [0, -1, 0] },
  { name: "up", normal: [0, 1, 0], fileX: [1, 0, 0], fileY: [0, 0, 1] },
  { name: "down", normal: [0, -1, 0], fileX: [1, 0, 0], fileY: [0, 0, -1] },
  { name: "front", normal: [0, 0, 1], fileX: [1, 0, 0], fileY: [0, -1, 0] },
  { name: "back", normal: [0, 0, -1], fileX: [-1, 0, 0], fileY: [0, -1, 0] },
];

/**
 * A radiance field over unit directions. The bake reuses one direction
 * array for every sample and copies the result out at once, so a field must
 * not keep either.
 */
export type CubeRadianceField = (
  direction: [number, number, number],
) => readonly [number, number, number];

type CubeFaceData = Record<CubeFaceOrientation["name"], Float32Array>;

function readClock(): number {
  return typeof performance === "undefined" ? Date.now() : performance.now();
}

/**
 * The diffuse bake, resumable. It samples the radiance field a row at a
 * time, face by face in CUBE_FACES order and top row first within a face —
 * the order the one-shot bake always used — so a bake spread over any number
 * of advance() calls gives the bit-identical polynomial. That lets a climb's
 * re-light spread its 6 × 16 × 16 sky evaluations over several frames.
 *
 * Only the sampling slices. polynomial() is Babylon's converter in one call,
 * and applying it and re-arming the specular cube belong to the caller
 * (SkyEnvironmentProbe.applyRebakeIrradiance and rearmSpecular).
 */
export class SkyIrradianceBake {
  private radiance: CubeRadianceField | null = null;
  private size = 0;
  private faces: CubeFaceData | null = null;
  private face = 0;
  private row = 0;
  private readonly direction: [number, number, number] = [0, 0, 0];

  /** Starts a bake. The face arrays are reused while `size` stays the same. */
  begin(radiance: CubeRadianceField, size = SKY_IRRADIANCE_SAMPLE_SIZE): void {
    this.radiance = radiance;
    if (this.faces === null || size !== this.size) {
      const texels = size * size * 3;
      this.faces = {
        right: new Float32Array(texels),
        left: new Float32Array(texels),
        up: new Float32Array(texels),
        down: new Float32Array(texels),
        front: new Float32Array(texels),
        back: new Float32Array(texels),
      };
      this.size = size;
    }
    this.face = 0;
    this.row = 0;
  }

  /** Every texel of the begun bake has been sampled. */
  get done(): boolean {
    return this.radiance !== null && this.face >= CUBE_FACES.length;
  }

  /**
   * Samples whole rows until `budgetMs` has passed on `now`, always at least
   * one row, and returns `done`. An infinite budget never reads the clock.
   */
  advance(budgetMs: number, now: () => number = readClock): boolean {
    const radiance = this.radiance;
    const faces = this.faces;
    if (radiance === null || faces === null) {
      throw new Error("SkyIrradianceBake.advance called before begin");
    }
    const timed = budgetMs !== Number.POSITIVE_INFINITY;
    const started = timed ? now() : 0;
    const size = this.size;
    const du = 2 / size;
    const minUV = du / 2 - 1;
    const direction = this.direction;
    while (this.face < CUBE_FACES.length) {
      const face = CUBE_FACES[this.face]!;
      const data = faces[face.name];
      const y = this.row;
      const v = minUV + y * du;
      for (let x = 0; x < size; x += 1) {
        const u = minUV + x * du;
        const directionX = face.fileX[0] * u + face.fileY[0] * v + face.normal[0];
        const directionY = face.fileX[1] * u + face.fileY[1] * v + face.normal[1];
        const directionZ = face.fileX[2] * u + face.fileY[2] * v + face.normal[2];
        const length = Math.hypot(directionX, directionY, directionZ);
        direction[0] = directionX / length;
        direction[1] = directionY / length;
        direction[2] = directionZ / length;
        const rgb = radiance(direction);
        const offset = (y * size + x) * 3;
        data[offset] = rgb[0];
        data[offset + 1] = rgb[1];
        data[offset + 2] = rgb[2];
      }
      this.row += 1;
      if (this.row === size) {
        this.row = 0;
        this.face += 1;
      }
      if (timed && now() - started >= budgetMs) break;
    }
    return this.done;
  }

  /** Babylon's converter over the finished faces, in one call. */
  polynomial(): SphericalPolynomial {
    const faces = this.faces;
    if (!this.done || faces === null) {
      throw new Error("SkyIrradianceBake.polynomial called before the bake finished");
    }
    const polynomial = CubeMapToSphericalPolynomialTools.ConvertCubeMapToSphericalPolynomial({
      right: faces.right,
      left: faces.left,
      up: faces.up,
      down: faces.down,
      front: faces.front,
      back: faces.back,
      size: this.size,
      format: Constants.TEXTUREFORMAT_RGB,
      type: Constants.TEXTURETYPE_FLOAT,
      gammaSpace: false,
    });
    if (!polynomial) {
      throw new Error("Unable to convert the sky cube map to a spherical polynomial");
    }
    return polynomial;
  }
}

/**
 * Spherical-harmonics irradiance for an arbitrary radiance field, using the
 * exact texel-direction convention of Babylon's own converter so the result
 * plugs straight into `texture.sphericalPolynomial`.
 */
export function bakeSphericalPolynomialFromRadiance(
  radiance: CubeRadianceField,
  size = SKY_IRRADIANCE_SAMPLE_SIZE,
): SphericalPolynomial {
  const bake = new SkyIrradianceBake();
  bake.begin(radiance, size);
  bake.advance(Number.POSITIVE_INFINITY);
  return bake.polynomial();
}

/**
 * The albedo the below-horizon bake falls back to when no surface system has
 * published one — the same 0.18 grey `EnvironmentState.atmosphere.groundAlbedo`
 * carries, so a probe baked before the terrain exists lights exactly as it did.
 */
export const DEFAULT_GROUND_BOUNCE_ALBEDO = 0.18;

/**
 * Below-horizon attenuation for the DIFFUSE bake only. The sky field's lower
 * hemisphere is the clamped horizon haze — brighter than the zenith — so an
 * unattenuated bake would light undersides more than tops. Physically that
 * hemisphere is terrain: keep the haze's colour but scale it toward the
 * ground's actual bounce albedo. The specular cube deliberately keeps the
 * bright haze — grazing reflections genuinely see it at the horizon.
 *
 * `R-26` retires deviation `D-6`'s hardcoded 0.25 floor. That number was a
 * ground-bounce fake tuned against a ground colour Phase 3 replaced; with real
 * albedo it double-counts, and `G-B`'s seasonal ground would have fought it —
 * a snow-covered world bounces more than twice what a summer one does, and a
 * constant floor cannot say so. The floor is now the albedo itself.
 */
function groundBounceFactor(directionY: number, groundAlbedo: number): number {
  if (directionY >= 0) return 1;
  const albedo = Math.min(1, Math.max(0.01, groundAlbedo));
  // Same shape as before — full haze at the horizon, reaching the ground's own
  // albedo by 0.4 below it — with the terminal value derived rather than fixed.
  return Math.max(albedo, 1 + directionY * ((1 - albedo) / 0.4));
}

/**
 * The field the diffuse bake samples: skyRadiance's TS mirror with the
 * below-horizon ground bounce. It answers in one scratch tuple, which the
 * bake copies out before the next sample.
 */
function skyIrradianceRadiance(
  binding: AerialPerspectiveBinding,
  groundAlbedo: number,
): CubeRadianceField {
  const rgb: [number, number, number] = [0, 0, 0];
  return (direction) => {
    const radiance = evaluateSkyRadiance(binding, direction);
    const factor = groundBounceFactor(direction[1], groundAlbedo);
    rgb[0] = radiance[0] * factor;
    rgb[1] = radiance[1] * factor;
    rgb[2] = radiance[2] * factor;
    return rgb;
  };
}

/** The diffuse half of the probe: skyRadiance's TS mirror → SH irradiance. */
export function bakeSkyIrradiancePolynomial(
  binding: AerialPerspectiveBinding,
  size = SKY_IRRADIANCE_SAMPLE_SIZE,
  groundAlbedo = DEFAULT_GROUND_BOUNCE_ALBEDO,
): SphericalPolynomial {
  return bakeSphericalPolynomialFromRadiance(skyIrradianceRadiance(binding, groundAlbedo), size);
}

/**
 * A deep copy of a binding, so a sliced rebake samples one environment
 * however the live binding moves while it runs. evaluateSkyRadiance reads
 * cameraAltitudeMeters, sunDirection, all five coefficients, sunRadiance,
 * ambient, twilightArch, nightZenithFade, twilightWarm, twilightBelt and
 * sunsetDirection. sunTransmittance and strength, which it does not read,
 * are copied too: the copy is a whole binding, for the renderer to hand
 * AtmosphereGpuResources.update so the SH, the cloud ambient LUT and the
 * probe all light from the same environment.
 */
function snapshotAerialPerspectiveBinding(
  binding: AerialPerspectiveBinding,
): AerialPerspectiveBinding {
  const coefficients = binding.coefficients;
  return {
    cameraAltitudeMeters: binding.cameraAltitudeMeters,
    sunDirection: [binding.sunDirection[0], binding.sunDirection[1], binding.sunDirection[2]],
    coefficients: {
      rayleighScattering: [
        coefficients.rayleighScattering[0],
        coefficients.rayleighScattering[1],
        coefficients.rayleighScattering[2],
      ],
      mieScattering: [
        coefficients.mieScattering[0],
        coefficients.mieScattering[1],
        coefficients.mieScattering[2],
      ],
      mieExtinction: [
        coefficients.mieExtinction[0],
        coefficients.mieExtinction[1],
        coefficients.mieExtinction[2],
      ],
      ozoneAbsorption: [
        coefficients.ozoneAbsorption[0],
        coefficients.ozoneAbsorption[1],
        coefficients.ozoneAbsorption[2],
      ],
      mieAnisotropy: coefficients.mieAnisotropy,
    },
    sunRadiance: [binding.sunRadiance[0], binding.sunRadiance[1], binding.sunRadiance[2]],
    ambient: [binding.ambient[0], binding.ambient[1], binding.ambient[2]],
    sunTransmittance: [
      binding.sunTransmittance[0],
      binding.sunTransmittance[1],
      binding.sunTransmittance[2],
    ],
    twilightArch: [binding.twilightArch[0], binding.twilightArch[1], binding.twilightArch[2]],
    nightZenithFade: binding.nightZenithFade,
    twilightWarm: [binding.twilightWarm[0], binding.twilightWarm[1], binding.twilightWarm[2]],
    twilightBelt: [binding.twilightBelt[0], binding.twilightBelt[1], binding.twilightBelt[2]],
    sunsetDirection: [binding.sunsetDirection[0], binding.sunsetDirection[1]],
    strength: binding.strength,
  };
}

/** Camera-altitude drift from the last bake that re-lights the world. */
export const SKY_PROBE_REBAKE_ALTITUDE_METERS = 500;

export type SkyProbeRefreshAction = "none" | "begin" | "advance" | "sync";

export interface SkyProbeRefreshState {
  /** The environment changed since the last bake (a clock scrub, new weather). */
  readonly stale: boolean;
  /** Camera altitude now, less the altitude the last applied bake was taken at. */
  readonly altitudeDeltaMeters: number;
  /** A sliced rebake has begun and its irradiance is not applied yet. */
  readonly inProgress: boolean;
  /**
   * The renderer's explicit choice to re-light in one frame, as captures and
   * perf:ab do so their baselines cannot move. It is not render-scale
   * pinning: a pinned perf:flight run must still take the sliced path.
   */
  readonly synchronous: boolean;
}

/**
 * What the renderer does with the probe this frame:
 * - "sync": update() from the current binding, in this frame, as before
 *   slicing. An environment change always takes it: a scrub re-lights at
 *   once, and a half-sampled rebake is of the old environment. Synchronous,
 *   every re-light takes it, and so does a rebake left over from sliced
 *   frames.
 * - "begin": the camera has drifted past the threshold; snapshot the binding
 *   and start sampling.
 * - "advance": keep sampling the rebake in flight, and apply it once
 *   advanceRebake reports done. Drift waits for it; the next begin measures
 *   from the altitude it was taken at.
 * - "none".
 */
export function skyProbeRefreshAction(state: SkyProbeRefreshState): SkyProbeRefreshAction {
  const drifted = Math.abs(state.altitudeDeltaMeters) > SKY_PROBE_REBAKE_ALTITUDE_METERS;
  if (state.stale) return "sync";
  if (state.synchronous) return drifted || state.inProgress ? "sync" : "none";
  if (state.inProgress) return "advance";
  return drifted ? "begin" : "none";
}

/** O(1) counters for the sliced rebake, read by the perf probe. */
export interface SkyRebakeStats {
  /** Milliseconds the last advanceRebake call spent sampling. */
  readonly lastAdvanceMilliseconds: number;
  /** The longest single advanceRebake call since the probe was made. */
  readonly maxAdvanceMilliseconds: number;
  /** Milliseconds the last applyRebakeIrradiance call spent in the converter. */
  readonly lastApplyMilliseconds: number;
  readonly maxApplyMilliseconds: number;
  /** Sliced rebakes whose irradiance reached the probe. update() is not counted. */
  readonly bakesCompleted: number;
}

export class SkyEnvironmentProbe {
  private readonly probe: ReflectionProbe;
  private readonly scene: Scene;
  private readonly now: () => number;
  private readonly rebake = new SkyIrradianceBake();
  private rebakeSnapshot: AerialPerspectiveBinding | null = null;
  private rebaking = false;
  private lastAdvanceMilliseconds = 0;
  private maxAdvanceMilliseconds = 0;
  private lastApplyMilliseconds = 0;
  private maxApplyMilliseconds = 0;
  private bakesCompleted = 0;
  private disposed = false;

  constructor(scene: Scene, skyMesh: Mesh, now: () => number = readClock) {
    this.scene = scene;
    this.now = now;
    // useFloat picks half-float when renderable (it is on WebGPU); the
    // float32 path would be unfilterable since that feature is never
    // requested. linearSpace keeps the cube in linear HDR.
    this.probe = new ReflectionProbe("sky-environment", SKY_PROBE_SIZE, scene, true, true, true);
    this.probe.renderList?.push(skyMesh);
    const cube = this.probe.cubeTexture;
    cube.coordinatesMode = Texture.CUBIC_MODE;
    cube.refreshRate = RenderTargetTexture.REFRESHRATE_RENDER_ONCE;
    // PBR gathers only its own reflection RTTs; a probe serving
    // scene.environmentTexture must schedule itself.
    scene.customRenderTargets.push(cube);
    // 2-9: the captured cube is the AMBIENT environment — reflections and
    // IBL. Direct sun is analytic everywhere (the CSM light on solids, the
    // water Karis lobe), so the probe suppresses the sky dome's painted sun
    // disc for its six faces: a 40x-radiance disc is sub-texel at 128 px and
    // would double-count the sun as a blocky blob in every mirror direction.
    const skyUniforms = skyMesh.material as unknown as {
      setFloat?: (name: string, value: number) => void;
    } | null;
    cube.onBeforeBindObservable.add(() => {
      skyUniforms?.setFloat?.("sunDiscVisibility", 0);
    });
    cube.onAfterUnbindObservable.add(() => {
      skyUniforms?.setFloat?.("sunDiscVisibility", 1);
    });
  }

  get texture(): RenderTargetTexture {
    return this.probe.cubeTexture;
  }

  /**
   * Re-lights the world for a new environment: bakes the SH irradiance from
   * the TS mirror and re-arms the six-face specular render for the next
   * frame, which draws the sky dome with its already-current uniforms.
   */
  update(
    binding: AerialPerspectiveBinding,
    groundAlbedo = DEFAULT_GROUND_BOUNCE_ALBEDO,
  ): void {
    if (this.disposed) return;
    // A one-frame bake supersedes a sliced one: applying the older snapshot
    // after this would roll the lighting back.
    this.dropRebake();
    this.probe.cubeTexture.sphericalPolynomial = bakeSkyIrradiancePolynomial(
      binding,
      SKY_IRRADIANCE_SAMPLE_SIZE,
      groundAlbedo,
    );
    this.probe.cubeTexture.refreshRate = RenderTargetTexture.REFRESHRATE_RENDER_ONCE;
  }

  /**
   * Starts update()'s re-light as a sliced rebake: snapshots `binding` (see
   * snapshotAerialPerspectiveBinding) and samples nothing yet. A rebake in
   * flight is replaced.
   */
  beginRebake(
    binding: AerialPerspectiveBinding,
    groundAlbedo = DEFAULT_GROUND_BOUNCE_ALBEDO,
  ): void {
    if (this.disposed) return;
    const snapshot = snapshotAerialPerspectiveBinding(binding);
    this.rebakeSnapshot = snapshot;
    this.rebake.begin(skyIrradianceRadiance(snapshot, groundAlbedo), SKY_IRRADIANCE_SAMPLE_SIZE);
    this.rebaking = true;
  }

  /** A rebake has begun and its irradiance is not applied yet. */
  get rebakeInProgress(): boolean {
    return this.rebaking;
  }

  /**
   * The binding the current or last applied rebake samples. The renderer
   * hands it to AtmosphereGpuResources.update and takes the probe's altitude
   * from it. Null before any rebake and after update().
   */
  get rebakeBinding(): AerialPerspectiveBinding | null {
    return this.rebakeSnapshot;
  }

  /**
   * Samples the rebake for about `budgetMs` (at least one row of one face)
   * and returns true once it is ready for applyRebakeIrradiance. False with
   * no rebake in flight.
   */
  advanceRebake(budgetMs: number): boolean {
    if (this.disposed || !this.rebaking) return false;
    if (this.rebake.done) return true;
    const started = this.now();
    const done = this.rebake.advance(budgetMs, this.now);
    const elapsed = this.now() - started;
    this.lastAdvanceMilliseconds = elapsed;
    this.maxAdvanceMilliseconds = Math.max(this.maxAdvanceMilliseconds, elapsed);
    return done;
  }

  /**
   * Runs the converter over the finished rebake and lights the world with
   * it. The specular cube is not re-armed: call rearmSpecular, on this frame
   * or a later one, or applyRebake for both at once.
   */
  applyRebakeIrradiance(): void {
    if (this.disposed) return;
    if (!this.rebaking || !this.rebake.done) {
      throw new Error("SkyEnvironmentProbe.applyRebakeIrradiance called before the rebake finished");
    }
    const started = this.now();
    this.probe.cubeTexture.sphericalPolynomial = this.rebake.polynomial();
    const elapsed = this.now() - started;
    this.lastApplyMilliseconds = elapsed;
    this.maxApplyMilliseconds = Math.max(this.maxApplyMilliseconds, elapsed);
    this.bakesCompleted += 1;
    this.rebaking = false;
  }

  /**
   * Re-renders the six-face specular cube on the next frame, from the sky
   * dome's uniforms of that frame.
   */
  rearmSpecular(): void {
    if (this.disposed) return;
    this.probe.cubeTexture.refreshRate = RenderTargetTexture.REFRESHRATE_RENDER_ONCE;
  }

  /** applyRebakeIrradiance and rearmSpecular in one frame, as update() does. */
  applyRebake(): void {
    this.applyRebakeIrradiance();
    this.rearmSpecular();
  }

  get rebakeStats(): SkyRebakeStats {
    return {
      lastAdvanceMilliseconds: this.lastAdvanceMilliseconds,
      maxAdvanceMilliseconds: this.maxAdvanceMilliseconds,
      lastApplyMilliseconds: this.lastApplyMilliseconds,
      maxApplyMilliseconds: this.maxApplyMilliseconds,
      bakesCompleted: this.bakesCompleted,
    };
  }

  private dropRebake(): void {
    this.rebaking = false;
    this.rebakeSnapshot = null;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.dropRebake();
    const index = this.scene.customRenderTargets.indexOf(this.probe.cubeTexture);
    if (index >= 0) this.scene.customRenderTargets.splice(index, 1);
    if (this.scene.environmentTexture === this.probe.cubeTexture) {
      this.scene.environmentTexture = null;
    }
    this.probe.dispose();
  }
}
