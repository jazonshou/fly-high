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
 * microseconds, Node-testable, no GPU readback.
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
 * Spherical-harmonics irradiance for an arbitrary radiance field, using the
 * exact texel-direction convention of Babylon's own converter so the result
 * plugs straight into `texture.sphericalPolynomial`.
 */
export function bakeSphericalPolynomialFromRadiance(
  radiance: (direction: [number, number, number]) => [number, number, number],
  size = SKY_IRRADIANCE_SAMPLE_SIZE,
): SphericalPolynomial {
  const du = 2 / size;
  const minUV = du / 2 - 1;
  const faces: Record<string, Float32Array> = {};
  for (const face of CUBE_FACES) {
    const data = new Float32Array(size * size * 3);
    for (let y = 0; y < size; y += 1) {
      const v = minUV + y * du;
      for (let x = 0; x < size; x += 1) {
        const u = minUV + x * du;
        const direction: [number, number, number] = [
          face.fileX[0] * u + face.fileY[0] * v + face.normal[0],
          face.fileX[1] * u + face.fileY[1] * v + face.normal[1],
          face.fileX[2] * u + face.fileY[2] * v + face.normal[2],
        ];
        const length = Math.hypot(direction[0], direction[1], direction[2]);
        direction[0] /= length;
        direction[1] /= length;
        direction[2] /= length;
        const rgb = radiance(direction);
        const offset = (y * size + x) * 3;
        data[offset] = rgb[0];
        data[offset + 1] = rgb[1];
        data[offset + 2] = rgb[2];
      }
    }
    faces[face.name] = data;
  }
  const polynomial = CubeMapToSphericalPolynomialTools.ConvertCubeMapToSphericalPolynomial({
    right: faces["right"]!,
    left: faces["left"]!,
    up: faces["up"]!,
    down: faces["down"]!,
    front: faces["front"]!,
    back: faces["back"]!,
    size,
    format: Constants.TEXTUREFORMAT_RGB,
    type: Constants.TEXTURETYPE_FLOAT,
    gammaSpace: false,
  });
  if (!polynomial) {
    throw new Error("Unable to convert the sky cube map to a spherical polynomial");
  }
  return polynomial;
}

/**
 * Below-horizon attenuation for the DIFFUSE bake only. The sky field's lower
 * hemisphere is the clamped horizon haze — brighter than the zenith — so an
 * unattenuated bake would light undersides more than tops. Physically that
 * hemisphere is terrain: keep the haze's colour but scale it toward a dark
 * ground-bounce albedo. The specular cube deliberately keeps the bright
 * haze — grazing reflections genuinely see it at the horizon.
 */
function groundBounceFactor(directionY: number): number {
  if (directionY >= 0) return 1;
  return Math.max(0.25, 1 + directionY * 1.875);
}

/** The diffuse half of the probe: skyRadiance's TS mirror → SH irradiance. */
export function bakeSkyIrradiancePolynomial(
  binding: AerialPerspectiveBinding,
  size = SKY_IRRADIANCE_SAMPLE_SIZE,
): SphericalPolynomial {
  return bakeSphericalPolynomialFromRadiance(
    (direction) => {
      const radiance = evaluateSkyRadiance(binding, direction);
      const factor = groundBounceFactor(direction[1]);
      return [radiance[0] * factor, radiance[1] * factor, radiance[2] * factor];
    },
    size,
  );
}

export class SkyEnvironmentProbe {
  private readonly probe: ReflectionProbe;
  private readonly scene: Scene;
  private disposed = false;

  constructor(scene: Scene, skyMesh: Mesh) {
    this.scene = scene;
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
  update(binding: AerialPerspectiveBinding): void {
    if (this.disposed) return;
    this.probe.cubeTexture.sphericalPolynomial = bakeSkyIrradiancePolynomial(binding);
    this.probe.cubeTexture.refreshRate = RenderTargetTexture.REFRESHRATE_RENDER_ONCE;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const index = this.scene.customRenderTargets.indexOf(this.probe.cubeTexture);
    if (index >= 0) this.scene.customRenderTargets.splice(index, 1);
    if (this.scene.environmentTexture === this.probe.cubeTexture) {
      this.scene.environmentTexture = null;
    }
    this.probe.dispose();
  }
}
