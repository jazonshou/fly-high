import type { Camera } from "@babylonjs/core/Cameras/camera";
import { ShaderStore } from "@babylonjs/core/Engines/shaderStore";
import { ShaderLanguage } from "@babylonjs/core/Materials/shaderLanguage";
import { ShaderMaterial } from "@babylonjs/core/Materials/shaderMaterial";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { VertexData } from "@babylonjs/core/Meshes/mesh.vertexData";
import type { Scene } from "@babylonjs/core/scene";
import { CarPipelinePrime, type CarPipelineCompiles } from "../ground/carPipelinePrime";
import type { UnderwaterLight } from "./underwaterLight";

/**
 * Air under the water (walking plan, "Underwater view"): the burst a body
 * drives down with it when it goes under, then the breath it lets out every
 * few seconds and a thin trickle between, rising to the surface. One draw of
 * camera-facing discs, simulated on the main thread, and only while there is
 * a bubble to draw (above the water nothing of it runs).
 *
 * A bubble rises at its terminal speed for its size (a 1 mm bubble at about
 * 0.17 m/s, a 4 mm one near 0.3 m/s, which is where clean bubbles level off),
 * wobbles as it goes, and swells as the pressure on it falls (Boyle's law:
 * radius as the cube root of the pressure ratio). Seen from inside the water a
 * bubble is a mirror: total internal reflection at its rim makes it a silver
 * ring round a dimmer core. It is drawn lit as in air and opaque, so it writes
 * depth and the water column fades and dims it like anything else under water.
 *
 * The timing follows the walker's bubble sounds (`audio/personVoice.ts`): the
 * burst on going under, the first breath out 2.5 to 4.5 s later, then one
 * every 3 to 5 s.
 */

/** Bubbles alive at once: one draw of this many discs. */
export const UNDERWATER_BUBBLE_CAP = 64;

/** Bubbles in the burst a body drives down with it as it goes under. */
export const UNDERWATER_BUBBLE_ENTRY_COUNT = 28;

/** Bubbles in one breath let out. */
export const UNDERWATER_BUBBLE_BREATH_COUNT = 7;

/** Seconds between the trickle's bubbles while the head stays under. */
export const UNDERWATER_BUBBLE_TRICKLE_SECONDS = 0.9;

/** A bubble's longest life, seconds (a deep breath has surfaced long before). */
export const UNDERWATER_BUBBLE_LIFE_SECONDS = 14;

/** Terminal rise speed of clean air bubbles levels off at about this, m/s. */
const RISE_CEILING = 0.3;
/** ...and is reached at radii around this scale, metres. */
const RISE_RADIUS_SCALE = 0.0012;
/** How fast a bubble driven down by the plunge turns round to its rise, seconds. */
const PLUNGE_RELAXATION_SECONDS = 0.25;
/** The water's pressure head at the surface: one atmosphere is 10.3 m of sea water. */
const ATMOSPHERE_HEAD_METERS = 10.3;

const STRIDE = 10;
// State per bubble: x, y, z (world), radius at birth, birth depth, age, vertical
// velocity, wobble phase, wobble rate, alive (0/1).
const X = 0;
const Y = 1;
const Z = 2;
const RADIUS = 3;
const BIRTH_DEPTH = 4;
const AGE = 5;
const VELOCITY = 6;
const PHASE = 7;
const RATE = 8;
const ALIVE = 9;

const SHADER = "flyHighUnderwaterBubbles";

const VERTEX_WGSL = /* wgsl */ `
attribute position: vec3f;
attribute bubble: vec4f;
uniform viewProjection: mat4x4f;
uniform cameraRight: vec3f;
uniform cameraUp: vec3f;
varying corner: vec2f;

@vertex
fn main(input: VertexInputs) -> FragmentInputs {
  // A disc facing the camera; a radius of 0 (a free slot) is a point and draws nothing.
  let world = vertexInputs.bubble.xyz
    + (uniforms.cameraRight * vertexInputs.position.x + uniforms.cameraUp * vertexInputs.position.y) * vertexInputs.bubble.w;
  vertexOutputs.position = uniforms.viewProjection * vec4f(world, 1.0);
  vertexOutputs.corner = vertexInputs.position.xy;
}
`;

const FRAGMENT_WGSL = /* wgsl */ `
varying corner: vec2f;
uniform bubbleLight: vec3f;

@fragment
fn main(input: FragmentInputs) -> FragmentOutputs {
  let r2 = dot(input.corner, input.corner);
  if (r2 > 1.0) { discard; }
  // The silver rim of total internal reflection round a dimmer core, and the
  // highlight of the bright surface above caught near its top.
  let rim = smoothstep(0.45, 0.95, r2);
  let highlight = exp(-24.0 * dot(input.corner - vec2f(-0.3, 0.38), input.corner - vec2f(-0.3, 0.38)));
  fragmentOutputs.color = vec4f(uniforms.bubbleLight * (0.22 + 0.7 * rim + 0.9 * highlight), 1.0);
}
`;

function registerShaders(): void {
  ShaderStore.ShadersStoreWGSL[`${SHADER}VertexShader`] = VERTEX_WGSL;
  ShaderStore.ShadersStoreWGSL[`${SHADER}FragmentShader`] = FRAGMENT_WGSL;
}

/** Terminal rise speed of a clean air bubble of this radius in sea water, m/s. */
export function bubbleRiseSpeed(radiusMeters: number): number {
  return RISE_CEILING * (1 - Math.exp(-Math.max(radiusMeters, 0) / RISE_RADIUS_SCALE));
}

/** A bubble's radius at a depth, from its radius at the depth it was let out (Boyle). */
export function bubbleRadiusAtDepth(radiusAtBirth: number, birthDepth: number, depth: number): number {
  const ratio = (ATMOSPHERE_HEAD_METERS + Math.max(birthDepth, 0)) / (ATMOSPHERE_HEAD_METERS + Math.max(depth, 0));
  return radiusAtBirth * Math.cbrt(ratio);
}

/** Where the bubbles come from this frame: the walker's head (world metres) and whether it is under. */
export interface BubbleSource {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly under: boolean;
  /** The still surface above it, world metres. */
  readonly surfaceHeight: number;
}

export interface UnderwaterBubblesOptions {
  readonly scene: Scene;
  readonly camera: Camera;
  readonly light: UnderwaterLight;
  readonly pipelineCompiles: CarPipelineCompiles | null;
}

export class UnderwaterBubbles {
  readonly mesh: Mesh;
  readonly material: ShaderMaterial;
  private readonly camera: Camera;
  private readonly light: UnderwaterLight;
  private readonly prime: CarPipelinePrime;
  private readonly state = new Float32Array(UNDERWATER_BUBBLE_CAP * STRIDE);
  private readonly instances = new Float32Array(UNDERWATER_BUBBLE_CAP * 4 * 4);
  private readonly right = new Vector3();
  private readonly up = new Vector3();
  private readonly lightColour = new Vector3();
  private seed = 0x2f6b9e1d;
  private wasUnder = false;
  private nextBreath = Number.POSITIVE_INFINITY;
  private nextTrickle = Number.POSITIVE_INFINITY;
  private lastTime = Number.NaN;
  private alive = 0;

  constructor(options: UnderwaterBubblesOptions) {
    registerShaders();
    this.camera = options.camera;
    this.light = options.light;
    this.material = new ShaderMaterial(
      "underwater-bubbles",
      options.scene,
      { vertex: SHADER, fragment: SHADER },
      {
        attributes: ["position", "bubble"],
        uniforms: ["viewProjection", "cameraRight", "cameraUp", "bubbleLight"],
        shaderLanguage: ShaderLanguage.WGSL,
      },
    );
    this.material.backFaceCulling = false;
    this.mesh = new Mesh("underwater-bubbles", options.scene);
    const positions = new Float32Array(UNDERWATER_BUBBLE_CAP * 4 * 3);
    const indices = new Uint32Array(UNDERWATER_BUBBLE_CAP * 6);
    const corners = [-1, -1, 1, -1, 1, 1, -1, 1];
    for (let bubble = 0; bubble < UNDERWATER_BUBBLE_CAP; bubble += 1) {
      for (let corner = 0; corner < 4; corner += 1) {
        positions[(bubble * 4 + corner) * 3] = corners[corner * 2]!;
        positions[(bubble * 4 + corner) * 3 + 1] = corners[corner * 2 + 1]!;
      }
      const base = bubble * 4;
      indices.set([base, base + 1, base + 2, base, base + 2, base + 3], bubble * 6);
    }
    const data = new VertexData();
    data.positions = positions;
    data.indices = indices;
    data.applyToMesh(this.mesh, false);
    this.mesh.setVerticesData("bubble", this.instances, true, 4);
    this.mesh.isPickable = false;
    this.mesh.alwaysSelectAsActiveMesh = true;
    this.mesh.material = this.material;
    this.mesh.setEnabled(false);
    this.prime = new CarPipelinePrime(options.pipelineCompiles);
    this.prime.adopt(this.material);
  }

  /** Bubbles alive after the last `update`. */
  get count(): number {
    return this.alive;
  }

  /**
   * One frame: spawn from `source` (null: no body in the water), rise, and
   * draw. `originX`/`originZ` are the floating origin (world x and z at the
   * render origin).
   */
  update(timeSeconds: number, source: BubbleSource | null, originX: number, originZ: number): void {
    const dt = Number.isFinite(this.lastTime) ? Math.min(Math.max(timeSeconds - this.lastTime, 0), 0.1) : 0;
    this.lastTime = timeSeconds;
    const under = source?.under ?? false;
    if (source && under && !this.wasUnder) {
      this.spawn(source, UNDERWATER_BUBBLE_ENTRY_COUNT, 0.35, 0.0005, 0.004, -0.8);
      this.nextBreath = timeSeconds + 2.5 + 2 * this.random();
      this.nextTrickle = timeSeconds + UNDERWATER_BUBBLE_TRICKLE_SECONDS;
    } else if (source && under) {
      if (timeSeconds >= this.nextBreath) {
        this.spawn(source, UNDERWATER_BUBBLE_BREATH_COUNT, 0.06, 0.001, 0.005, 0.15);
        this.nextBreath = timeSeconds + 3 + 2 * this.random();
      }
      if (timeSeconds >= this.nextTrickle) {
        this.spawn(source, 1, 0.03, 0.0006, 0.0018, 0.1);
        this.nextTrickle = timeSeconds + UNDERWATER_BUBBLE_TRICKLE_SECONDS * (0.6 + 0.8 * this.random());
      }
    }
    this.wasUnder = under;
    this.step(dt, source?.surfaceHeight ?? Number.POSITIVE_INFINITY);
    const priming = this.alive === 0 && this.prime.wanted(this.mesh);
    const enabled = this.alive > 0 || priming;
    if (this.mesh.isEnabled(false) !== enabled) this.mesh.setEnabled(enabled);
    if (!enabled) return;
    this.write(originX, originZ);
  }

  dispose(): void {
    this.mesh.dispose(false, false);
    this.material.dispose(true, false);
  }

  private spawn(source: BubbleSource, count: number, spread: number, minRadius: number, maxRadius: number, velocity: number): void {
    const state = this.state;
    for (let made = 0; made < count; made += 1) {
      let slot = -1;
      for (let index = 0; index < UNDERWATER_BUBBLE_CAP; index += 1) {
        if (state[index * STRIDE + ALIVE] === 0) {
          slot = index;
          break;
        }
      }
      if (slot < 0) return;
      const base = slot * STRIDE;
      // Uniform in a ball, sizes log-uniform (many small, a few large).
      let dx = 0;
      let dy = 0;
      let dz = 0;
      do {
        dx = 2 * this.random() - 1;
        dy = 2 * this.random() - 1;
        dz = 2 * this.random() - 1;
      } while (dx * dx + dy * dy + dz * dz > 1);
      state[base + X] = source.x + dx * spread;
      state[base + Y] = source.y + dy * spread;
      state[base + Z] = source.z + dz * spread;
      state[base + RADIUS] = minRadius * (maxRadius / minRadius) ** this.random();
      state[base + BIRTH_DEPTH] = Math.max(source.surfaceHeight - state[base + Y]!, 0);
      state[base + AGE] = 0;
      state[base + VELOCITY] = velocity * (0.6 + 0.8 * this.random());
      state[base + PHASE] = 2 * Math.PI * this.random();
      state[base + RATE] = 2 * Math.PI * (2 + 3 * this.random());
      state[base + ALIVE] = 1;
    }
  }

  private step(dt: number, surfaceHeight: number): void {
    const state = this.state;
    const relax = dt > 0 ? 1 - Math.exp(-dt / PLUNGE_RELAXATION_SECONDS) : 0;
    let alive = 0;
    for (let index = 0; index < UNDERWATER_BUBBLE_CAP; index += 1) {
      const base = index * STRIDE;
      if (state[base + ALIVE] === 0) continue;
      const depth = Math.max(surfaceHeight - state[base + Y]!, 0);
      const radius = bubbleRadiusAtDepth(state[base + RADIUS]!, state[base + BIRTH_DEPTH]!, depth);
      const velocity = state[base + VELOCITY]! + (bubbleRiseSpeed(radius) - state[base + VELOCITY]!) * relax;
      state[base + VELOCITY] = velocity;
      state[base + Y] = state[base + Y]! + velocity * dt;
      state[base + AGE] = state[base + AGE]! + dt;
      if (state[base + Y]! >= surfaceHeight || state[base + AGE]! > UNDERWATER_BUBBLE_LIFE_SECONDS) {
        state[base + ALIVE] = 0;
        continue;
      }
      alive += 1;
    }
    this.alive = alive;
  }

  private write(originX: number, originZ: number): void {
    const state = this.state;
    const instances = this.instances;
    for (let index = 0; index < UNDERWATER_BUBBLE_CAP; index += 1) {
      const base = index * STRIDE;
      const live = state[base + ALIVE] === 1;
      const radius = live ? state[base + RADIUS]! : 0;
      // The wobble: a large bubble rocks and spirals about a few of its own radii.
      const phase = state[base + PHASE]! + state[base + RATE]! * state[base + AGE]!;
      const sway = 1.5 * radius;
      const x = state[base + X]! - originX + sway * Math.cos(phase);
      const y = state[base + Y]!;
      const z = state[base + Z]! - originZ + sway * Math.sin(phase);
      for (let corner = 0; corner < 4; corner += 1) {
        const at = (index * 4 + corner) * 4;
        instances[at] = x;
        instances[at + 1] = y;
        instances[at + 2] = z;
        instances[at + 3] = radius;
      }
    }
    this.mesh.updateVerticesData("bubble", instances, false, false);
    const view = this.camera.getViewMatrix();
    // The view's rows are the camera's axes in world space.
    this.right.set(view.m[0]!, view.m[4]!, view.m[8]!);
    this.up.set(view.m[1]!, view.m[5]!, view.m[9]!);
    this.material.setVector3("cameraRight", this.right);
    this.material.setVector3("cameraUp", this.up);
    const light = this.light.downwelling;
    this.lightColour.set(light[0], light[1], light[2]);
    this.material.setVector3("bubbleLight", this.lightColour);
  }

  /** A deterministic draw in [0, 1) (captures repeat their bubbles). */
  private random(): number {
    this.seed = (Math.imul(this.seed, 1664525) + 1013904223) >>> 0;
    return this.seed / 4294967296;
  }
}
