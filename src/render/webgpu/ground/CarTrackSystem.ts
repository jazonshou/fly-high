import { Buffer } from "@babylonjs/core/Buffers/buffer";
import { Constants } from "@babylonjs/core/Engines/constants";
import { ShaderStore } from "@babylonjs/core/Engines/shaderStore";
import { Material } from "@babylonjs/core/Materials/material";
import { ShaderLanguage } from "@babylonjs/core/Materials/shaderLanguage";
import { ShaderMaterial } from "@babylonjs/core/Materials/shaderMaterial";
import { Vector3, Vector4 } from "@babylonjs/core/Maths/math.vector";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { VertexData } from "@babylonjs/core/Meshes/mesh.vertexData";
import type { Scene } from "@babylonjs/core/scene";
import type { CarVisualState, FlightVisualState } from "@/src/game/types";
import { OPAQUE_RENDERING_GROUP_ID } from "@/src/render/webgpu/core/RenderingGroups";
import {
  CAR_TRACK_MIN_DARKNESS,
  carTrackMark,
  carWheelContacts,
  createCarWheelContacts,
  type CarTrackMark,
} from "./carEffectLaws";
import { CarPipelinePrime, type CarPipelineCompiles } from "./carPipelinePrime";

/**
 * The LandCruiser's tyre tracks, as ONE instanced draw of ribbon segments
 * lying on the ground, and no draw until the first print is laid.
 *
 * WHAT IS DRAWN. Each tyre leaves a strip of segments joining points where its
 * foot was, each point carrying how dark and how wide the print was there
 * (`carTrackMark`: the ground's own print, darker wet, darker and wider the
 * deeper the tyre sank). A segment is committed once the tyre has gone
 * `CAR_TRACK_MAX_SEGMENT_METERS` straight, or turned `CAR_TRACK_COMMIT_TURN_DEGREES`
 * over at least `CAR_TRACK_MIN_SEGMENT_METERS`; the segment behind the tyre
 * stretches to it every frame, so the print always reaches the tread. Two
 * neighbouring segments share their joint's across-vector, so a curve has
 * neither gaps nor double-darkened overlaps. A strip ends where the print
 * fades (onto rock or a road, into water, or with the tyre in the air) and
 * a new one starts where it comes back.
 *
 * HOW IT DARKENS. Multiplicatively (`ALPHA_MULTIPLY`): the ground already
 * drawn under the print is scaled by one minus its darkness, so a print is
 * the ground's own colour, lit by whatever lights it (the sun, its shadow, the
 * headlamps), only darker, which is what a print in sand or a crushed sward
 * is. Lugs are drawn across the tread at the 265/70R16's pitch, faded out
 * where the screen cannot resolve them; the print's edges are soft, and the
 * oldest segments fade before the ring overwrites them.
 *
 * ON THE GROUND. Points are the tyres' feet raised by their sinkage, which is
 * the ground the physics drives on, lifted `CAR_TRACK_LIFT_METERS` and drawn
 * with a depth bias so the drawn terrain's own facets do not cut it.
 *
 * PRIMED. On the first frame, or after a jump, a car making way is given the
 * tracks it would have left holding its velocity: straight back along it,
 * on the ground the `groundHeight` callback reads, fading out at the far end.
 * A capture of a pinned car driving shows its tracks, the same at any frame
 * rate. Without a callback the tracks start at the tyres.
 *
 * DRAW ORDER. Group 0 at alphaIndex 0: after every opaque surface, and before
 * the cloud shell (alphaIndex 1), which must not be darkened. Depth-tested and
 * never written.
 */

/** The largest ring any tier may ask for (pinned by test against the profiles). */
export const CAR_TRACK_CAPACITY = 2_048;
/** Floats per segment record: four vec4 attributes. */
export const CAR_TRACK_FLOATS = 16;
/** Segments per upload chunk. */
export const CAR_TRACK_CHUNK = 32;
/** The longest a straight segment runs before it is committed, metres. */
export const CAR_TRACK_MAX_SEGMENT_METERS = 2;
/** The shortest committed segment, metres, however hard the turn. */
export const CAR_TRACK_MIN_SEGMENT_METERS = 0.4;
/** A turn that commits a segment once it is at least the shortest, degrees. */
export const CAR_TRACK_COMMIT_TURN_DEGREES = 3;
/** A tyre farther than this from its strip's last point has jumped: a new strip starts. */
export const CAR_TRACK_JUMP_METERS = 10;
/** Height above the ground the print lies at, metres. */
export const CAR_TRACK_LIFT_METERS = 0.02;
/** The prime's reach behind a car at speed, metres, and the seconds of travel it stands for. */
export const CAR_TRACK_PRIME_METERS = 40;
export const CAR_TRACK_PRIME_SECONDS = 8;
/** Below this speed a car is not primed with tracks. */
export const CAR_TRACK_PRIME_MIN_SPEED = 1;
/** The anchor is moved when the car is this far from it, so records stay small for f32. */
export const CAR_TRACK_REANCHOR_METERS = 2_000;
/** Beyond these distances from the camera the print fades out, metres. */
export const CAR_TRACK_FADE_START_METERS = 120;
export const CAR_TRACK_FADE_END_METERS = 220;
/** The tread's lug pitch along the print, metres. */
export const CAR_TRACK_LUG_PITCH_METERS = 0.085;

const COMMIT_TURN_COS = Math.cos((CAR_TRACK_COMMIT_TURN_DEGREES * Math.PI) / 180);

/** One tyre's strip as it is being laid. */
interface Strip {
  active: boolean;
  /** The strip's last committed point, world metres, and its distance along the strip. */
  x: number;
  y: number;
  z: number;
  distance: number;
  /** That point's across-vector (half the print's width), world x and z, and its darkness. */
  sideX: number;
  sideZ: number;
  darkness: number;
  /** The direction of the segment that ended at that point (or the tyre's heading at a start). */
  directionX: number;
  directionZ: number;
  /** The ring slot of the segment being stretched behind the tyre, or -1. */
  head: number;
}

function newStrip(): Strip {
  return {
    active: false, x: 0, y: 0, z: 0, distance: 0, sideX: 0, sideZ: 0, darkness: 0,
    directionX: 1, directionZ: 0, head: -1,
  };
}

interface TrackGpu {
  readonly mesh: Mesh;
  readonly material: ShaderMaterial;
  readonly buffer: Buffer;
  readonly chunkViews: readonly Float32Array[];
}

export interface CarTrackOptions {
  /** `WebGpuQualityProfile.tyreTrackSegments`. */
  readonly segments: number;
  /** The drawn ground's height, for the primed tracks behind a car first seen moving. */
  readonly groundHeight?: (x: number, z: number) => number;
  /** The renderer's off-frame compiles, for the spawn's pipeline prime (`CarPipelinePrime`). */
  readonly pipelineCompiles?: CarPipelineCompiles | null;
}

export class CarTrackSystem {
  private readonly scene: Scene;
  private readonly groundHeight: ((x: number, z: number) => number) | null;
  private readonly pipelinePrime: CarPipelinePrime;
  private cap = 0;
  private gpu: TrackGpu | null = null;
  private records: Float32Array | null = null;
  private cursor = 0;
  /** Segments allocated since the ring was built: the head of the sequence the shader fades by. */
  private sequence = 0;
  private readonly dirtyChunks: Uint8Array;
  private anchorX = Number.NaN;
  private anchorZ = Number.NaN;
  private originX = 0;
  private originZ = 0;
  private lastTime = Number.NaN;
  private lastX = Number.NaN;
  private lastZ = Number.NaN;
  private readonly strips: Strip[] = [newStrip(), newStrip(), newStrip(), newStrip()];
  private readonly contacts = createCarWheelContacts();
  private readonly mark: CarTrackMark = { darkness: 0, halfWidth: 0 };
  private readonly anchorUniform = new Vector3();
  /** x the newest sequence number, y the ring's size, z the lift, w unused. */
  private readonly ringUniform = new Vector4();

  constructor(scene: Scene, options: CarTrackOptions) {
    this.scene = scene;
    this.groundHeight = options.groundHeight ?? null;
    this.pipelinePrime = new CarPipelinePrime(options.pipelineCompiles ?? null);
    this.dirtyChunks = new Uint8Array(CAR_TRACK_CAPACITY / CAR_TRACK_CHUNK);
    this.setCap(options.segments);
  }

  get capacity(): number {
    return this.cap;
  }

  get drawing(): boolean {
    return this.gpu?.mesh.isEnabled(false) ?? false;
  }

  /** Segments laid since the ring was built (primed ones included). */
  get segmentCount(): number {
    return this.sequence;
  }

  get instanceData(): Float32Array | null {
    return this.records;
  }

  get mesh(): Mesh | null {
    return this.gpu?.mesh ?? null;
  }

  get anchor(): { readonly x: number; readonly z: number } {
    return { x: this.anchorX, z: this.anchorZ };
  }

  /** Apply the tier's ring size, in whole chunks. The prints laid so far are dropped; 0 disposes everything. */
  setCap(segments: number): void {
    const next = Number.isFinite(segments)
      ? Math.max(0, Math.min(CAR_TRACK_CAPACITY, Math.floor(segments / CAR_TRACK_CHUNK) * CAR_TRACK_CHUNK))
      : 0;
    if (next === this.cap && (next === 0) === (this.gpu === null)) return;
    this.disposeGpu();
    this.cap = next;
    this.cursor = 0;
    this.sequence = 0;
    for (const strip of this.strips) {
      strip.active = false;
      strip.head = -1;
    }
    if (next > 0) this.createGpu();
  }

  setFloatingOrigin(originX: number, originZ: number): void {
    this.originX = originX;
    this.originZ = originZ;
    this.syncAnchorUniform();
  }

  /** Per-frame update from the latest snapshot. Allocation-free. */
  update(state: FlightVisualState): void {
    const gpu = this.gpu;
    if (!gpu || !this.records) return;
    const car = state.vehicle?.kind === "car" ? state.vehicle : null;
    const time = Number.isFinite(state.simulationTime) ? state.simulationTime : 0;
    if (car && !state.crashed) {
      this.ensureAnchor(state.position.x, state.position.z);
      carWheelContacts(state, car, this.contacts);
      const elapsed = time - this.lastTime;
      const jumped = Number.isNaN(this.lastTime)
        || elapsed < 0
        || Math.hypot(state.position.x - this.lastX, state.position.z - this.lastZ) > CAR_TRACK_JUMP_METERS + 60 * Math.max(0, elapsed);
      if (jumped) this.prime(state, car);
      for (let wheel = 0; wheel < 4; wheel += 1) this.layWheel(wheel, carTrackMark(car, wheel, this.mark));
      this.lastTime = time;
      this.lastX = state.position.x;
      this.lastZ = state.position.z;
    } else {
      for (const strip of this.strips) {
        strip.active = false;
        strip.head = -1;
      }
    }
    this.flushChunks(gpu);
    this.ringUniform.set(this.sequence, this.cap, CAR_TRACK_LIFT_METERS, 0);
    const draw = this.sequence > 0 || this.pipelinePrime.wanted(gpu.mesh);
    if (gpu.mesh.isEnabled(false) !== draw) gpu.mesh.setEnabled(draw);
  }

  dispose(): void {
    this.disposeGpu();
    this.cap = 0;
  }

  /** One tyre's step: start, stretch, commit or end its strip. */
  private layWheel(wheel: number, mark: CarTrackMark): void {
    const strip = this.strips[wheel]!;
    const contact = this.contacts[wheel]!;
    if (!contact.loaded || mark.darkness < CAR_TRACK_MIN_DARKNESS) {
      strip.active = false;
      strip.head = -1;
      return;
    }
    if (!strip.active) {
      this.startStrip(strip, contact.x, contact.surfaceY, contact.z, contact.forwardX, contact.forwardZ, mark);
      return;
    }
    const dx = contact.x - strip.x;
    const dz = contact.z - strip.z;
    const length = Math.hypot(dx, dz);
    if (length > CAR_TRACK_JUMP_METERS) {
      this.startStrip(strip, contact.x, contact.surfaceY, contact.z, contact.forwardX, contact.forwardZ, mark);
      return;
    }
    if (length < 0.05) return;
    const directionX = dx / length;
    const directionZ = dz / length;
    const turn = directionX * strip.directionX + directionZ * strip.directionZ;
    if (turn < 0) {
      // Reversing over its own print: a fresh strip, so no segment folds back on itself.
      this.startStrip(strip, contact.x, contact.surfaceY, contact.z, directionX, directionZ, mark);
      return;
    }
    if (strip.head < 0) strip.head = this.allocate();
    const sideX = -directionZ * mark.halfWidth;
    const sideZ = directionX * mark.halfWidth;
    this.writeSegment(
      strip.head,
      strip.x, strip.y, strip.z, strip.distance, strip.sideX, strip.sideZ, strip.darkness,
      contact.x, contact.surfaceY, contact.z, strip.distance + length, sideX, sideZ, mark.darkness,
    );
    if (length >= CAR_TRACK_MAX_SEGMENT_METERS || (length >= CAR_TRACK_MIN_SEGMENT_METERS && turn < COMMIT_TURN_COS)) {
      strip.x = contact.x;
      strip.y = contact.surfaceY;
      strip.z = contact.z;
      strip.distance += length;
      strip.sideX = sideX;
      strip.sideZ = sideZ;
      strip.darkness = mark.darkness;
      strip.directionX = directionX;
      strip.directionZ = directionZ;
      strip.head = -1;
    }
  }

  private startStrip(
    strip: Strip,
    x: number,
    y: number,
    z: number,
    directionX: number,
    directionZ: number,
    mark: CarTrackMark,
  ): void {
    strip.active = true;
    strip.x = x;
    strip.y = y;
    strip.z = z;
    strip.distance = 0;
    strip.directionX = directionX;
    strip.directionZ = directionZ;
    strip.sideX = -directionZ * mark.halfWidth;
    strip.sideZ = directionX * mark.halfWidth;
    strip.darkness = mark.darkness;
    strip.head = -1;
  }

  /**
   * The tracks a car making way would have left holding its velocity: each
   * tyre's strip run straight back along it, on the drawn ground, fading out
   * at its far end, and left open at the tyre so driving on continues it.
   */
  private prime(state: FlightVisualState, car: CarVisualState): void {
    for (const strip of this.strips) {
      strip.active = false;
      strip.head = -1;
    }
    const ground = this.groundHeight;
    const speed = Math.hypot(state.velocity.x, state.velocity.z);
    if (!ground || speed < CAR_TRACK_PRIME_MIN_SPEED) return;
    const backX = -state.velocity.x / speed;
    const backZ = -state.velocity.z / speed;
    const reach = Math.min(CAR_TRACK_PRIME_METERS, speed * CAR_TRACK_PRIME_SECONDS);
    const steps = Math.max(1, Math.ceil(reach / CAR_TRACK_MAX_SEGMENT_METERS));
    const step = reach / steps;
    for (let wheel = 0; wheel < 4; wheel += 1) {
      const mark = carTrackMark(car, wheel, this.mark);
      const contact = this.contacts[wheel]!;
      if (!contact.loaded || mark.darkness < CAR_TRACK_MIN_DARKNESS) continue;
      const sideX = backZ * mark.halfWidth;
      const sideZ = -backX * mark.halfWidth;
      // From the far end towards the tyre, so the newest segment is the tyre's.
      for (let index = steps; index > 0; index -= 1) {
        const far = index * step;
        const near = (index - 1) * step;
        const farX = contact.x + backX * far;
        const farZ = contact.z + backZ * far;
        const nearX = contact.x + backX * near;
        const nearZ = contact.z + backZ * near;
        const nearY = index === 1 ? contact.surfaceY : ground(nearX, nearZ);
        this.writeSegment(
          this.allocate(),
          farX, ground(farX, farZ), farZ, -far, sideX, sideZ, mark.darkness * primeFade(far / reach),
          nearX, nearY, nearZ, -near, sideX, sideZ, mark.darkness * primeFade(near / reach),
        );
      }
      this.startStrip(this.strips[wheel]!, contact.x, contact.surfaceY, contact.z, -backX, -backZ, mark);
    }
  }

  /** The next ring slot, overwriting the oldest segment. */
  private allocate(): number {
    const slot = this.cursor;
    this.cursor = (this.cursor + 1) % this.cap;
    this.sequence += 1;
    const records = this.records!;
    records[slot * CAR_TRACK_FLOATS + 14] = this.sequence;
    // A strip still stretching the segment this slot held must not write over its new owner.
    for (const strip of this.strips) if (strip.head === slot) strip.head = -1;
    return slot;
  }

  private writeSegment(
    slot: number,
    startX: number, startY: number, startZ: number, startDistance: number,
    startSideX: number, startSideZ: number, startDarkness: number,
    endX: number, endY: number, endZ: number, endDistance: number,
    endSideX: number, endSideZ: number, endDarkness: number,
  ): void {
    const records = this.records!;
    const at = slot * CAR_TRACK_FLOATS;
    records[at] = startX - this.anchorX;
    records[at + 1] = startY;
    records[at + 2] = startZ - this.anchorZ;
    records[at + 3] = startDistance;
    records[at + 4] = endX - this.anchorX;
    records[at + 5] = endY;
    records[at + 6] = endZ - this.anchorZ;
    records[at + 7] = endDistance;
    records[at + 8] = startSideX;
    records[at + 9] = startSideZ;
    records[at + 10] = endSideX;
    records[at + 11] = endSideZ;
    records[at + 12] = startDarkness;
    records[at + 13] = endDarkness;
    this.dirtyChunks[Math.floor(slot / CAR_TRACK_CHUNK)] = 1;
  }

  private ensureAnchor(worldX: number, worldZ: number): void {
    if (!Number.isNaN(this.anchorX)
      && Math.abs(worldX - this.anchorX) < CAR_TRACK_REANCHOR_METERS
      && Math.abs(worldZ - this.anchorZ) < CAR_TRACK_REANCHOR_METERS) return;
    const records = this.records!;
    if (!Number.isNaN(this.anchorX)) {
      const dx = this.anchorX - worldX;
      const dz = this.anchorZ - worldZ;
      for (let slot = 0; slot < this.cap; slot += 1) {
        const at = slot * CAR_TRACK_FLOATS;
        records[at] = records[at]! + dx;
        records[at + 2] = records[at + 2]! + dz;
        records[at + 4] = records[at + 4]! + dx;
        records[at + 6] = records[at + 6]! + dz;
      }
      this.dirtyChunks.fill(1, 0, this.cap / CAR_TRACK_CHUNK);
    }
    this.anchorX = worldX;
    this.anchorZ = worldZ;
    this.syncAnchorUniform();
  }

  private syncAnchorUniform(): void {
    if (Number.isNaN(this.anchorX)) return;
    this.anchorUniform.set(this.anchorX - this.originX, 0, this.anchorZ - this.originZ);
  }

  private flushChunks(gpu: TrackGpu): void {
    const chunks = this.cap / CAR_TRACK_CHUNK;
    for (let chunk = 0; chunk < chunks; chunk += 1) {
      if (this.dirtyChunks[chunk] === 0) continue;
      this.dirtyChunks[chunk] = 0;
      gpu.buffer.updateDirectly(gpu.chunkViews[chunk]!, chunk * CAR_TRACK_CHUNK * CAR_TRACK_FLOATS, CAR_TRACK_CHUNK);
    }
  }

  private createGpu(): void {
    const scene = this.scene;
    ShaderStore.ShadersStoreWGSL[`${CAR_TRACK_SHADER_NAME}VertexShader`] = CAR_TRACK_VERTEX_WGSL;
    ShaderStore.ShadersStoreWGSL[`${CAR_TRACK_SHADER_NAME}PixelShader`] = CAR_TRACK_FRAGMENT_WGSL;

    const mesh = new Mesh("car-tracks", scene);
    // x: 0 at a segment's start, 1 at its end; y: -1 and +1 across.
    const quad = new VertexData();
    quad.positions = [0, -1, 0, 1, -1, 0, 1, 1, 0, 0, 1, 0];
    quad.indices = [0, 2, 1, 0, 3, 2];
    quad.applyToMesh(mesh, false);

    const records = new Float32Array(this.cap * CAR_TRACK_FLOATS);
    const buffer = new Buffer(scene.getEngine(), records, true, CAR_TRACK_FLOATS, false, true);
    for (let lane = 0; lane < 4; lane += 1) {
      mesh.setVerticesBuffer(buffer.createVertexBuffer(CAR_TRACK_ATTRIBUTES[lane]!, lane * 4, 4));
    }
    const chunkViews: Float32Array[] = [];
    for (let chunk = 0; chunk < this.cap / CAR_TRACK_CHUNK; chunk += 1) {
      const start = chunk * CAR_TRACK_CHUNK * CAR_TRACK_FLOATS;
      chunkViews.push(records.subarray(start, start + CAR_TRACK_CHUNK * CAR_TRACK_FLOATS));
    }
    mesh.forcedInstanceCount = this.cap;
    mesh.renderingGroupId = OPAQUE_RENDERING_GROUP_ID;
    mesh.alphaIndex = 0;
    mesh.isPickable = false;
    mesh.applyFog = false;
    mesh.receiveShadows = false;
    mesh.alwaysSelectAsActiveMesh = true;
    mesh.doNotSyncBoundingInfo = true;

    const material = new ShaderMaterial(
      "car-tracks-material",
      scene,
      CAR_TRACK_SHADER_NAME,
      {
        attributes: ["position", ...CAR_TRACK_ATTRIBUTES],
        uniforms: ["view", "projection", "cameraPosition", "trackAnchor", "trackRing"],
        shaderLanguage: ShaderLanguage.WGSL,
        needAlphaBlending: true,
      },
    );
    // Either winding: a segment's across-vector can face either way up.
    material.backFaceCulling = false;
    material.disableDepthWrite = true;
    material.transparencyMode = Material.MATERIAL_ALPHABLEND;
    material.alphaMode = Constants.ALPHA_MULTIPLY;
    material.zOffset = -1;
    material.zOffsetUnits = -4;
    material.setVector3("trackAnchor", this.anchorUniform);
    material.setVector4("trackRing", this.ringUniform);
    mesh.material = material;
    mesh.setEnabled(false);

    this.gpu = { mesh, material, buffer, chunkViews };
    this.records = records;
    this.pipelinePrime.adopt(material);
  }

  private disposeGpu(): void {
    const gpu = this.gpu;
    if (!gpu) return;
    this.gpu = null;
    this.records = null;
    gpu.mesh.dispose(false, false);
    gpu.material.dispose();
    gpu.buffer.dispose();
  }
}

/** A primed print's darkness along it: full at the tyre, gone at the far end. */
function primeFade(fraction: number): number {
  const t = Math.min(1, Math.max(0, 1 - fraction));
  return t * t * (3 - 2 * t);
}

function wgslFloat(value: number): string {
  return Number.isInteger(value) ? `${value}.0` : `${value}`;
}

const CAR_TRACK_SHADER_NAME = "carTracks";
const CAR_TRACK_ATTRIBUTES = ["trackA", "trackB", "trackC", "trackD"] as const;

export const CAR_TRACK_VERTEX_WGSL = /* wgsl */ `
attribute position: vec3f;
// xyz the segment's start (x, z from the anchor; y absolute), w its distance along the strip
attribute trackA: vec4f;
// the same at its end
attribute trackB: vec4f;
// xy the start's across-vector (world x, z), zw the end's
attribute trackC: vec4f;
// x the start's darkness, y the end's, z the segment's sequence number
attribute trackD: vec4f;

varying trackAcross: f32;
varying trackAlong: f32;
varying trackDarkness: f32;

uniform view: mat4x4f;
uniform projection: mat4x4f;
uniform cameraPosition: vec3f;
uniform trackAnchor: vec3f;
// x the newest sequence number, y the ring's size, z the lift
uniform trackRing: vec4f;

@vertex
fn main(input: VertexInputs) -> FragmentInputs {
  let t = vertexInputs.position.x;
  let across = vertexInputs.position.y;
  let start = vertexInputs.trackA;
  let end = vertexInputs.trackB;
  let sides = vertexInputs.trackC;
  let shade = vertexInputs.trackD;
  let side = mix(sides.xy, sides.zw, t);
  let local = mix(start.xyz, end.xyz, t) + vec3f(side.x, uniforms.trackRing.z, side.y) * vec3f(across, 1.0, across);
  let world = uniforms.trackAnchor + local;
  let darkness = mix(shade.x, shade.y, t);
  // The oldest quarter of the ring fades out before it is overwritten.
  let age = uniforms.trackRing.x - shade.z;
  let ringFade = smoothstep(0.0, 0.25, (uniforms.trackRing.y - age) / max(uniforms.trackRing.y, 1.0));
  let distanceMeters = length(world - uniforms.cameraPosition);
  let farFade = 1.0 - smoothstep(${wgslFloat(CAR_TRACK_FADE_START_METERS)}, ${wgslFloat(CAR_TRACK_FADE_END_METERS)}, distanceMeters);
  let strength = darkness * ringFade * farFade;
  var clip = uniforms.projection * uniforms.view * vec4f(world, 1.0);
  // A dead or faded record rasterises nothing.
  clip = select(clip, vec4f(0.0, 0.0, 2.0, 1.0), max(shade.x, shade.y) <= 0.0 || strength < 0.002);
  vertexOutputs.position = clip;
  vertexOutputs.trackAcross = across;
  vertexOutputs.trackAlong = mix(start.w, end.w, t);
  vertexOutputs.trackDarkness = strength;
}
`;

export const CAR_TRACK_FRAGMENT_WGSL = /* wgsl */ `
varying trackAcross: f32;
varying trackAlong: f32;
varying trackDarkness: f32;

const TRACK_LUG_PITCH: f32 = ${wgslFloat(CAR_TRACK_LUG_PITCH_METERS)};

@fragment
fn main(input: FragmentInputs) -> FragmentOutputs {
  let across = abs(fragmentInputs.trackAcross);
  let along = fragmentInputs.trackAlong / TRACK_LUG_PITCH;
  // Soft edges: the rut's walls and the soil pushed up beside them.
  let edge = 1.0 - smoothstep(0.7, 1.0, across);
  // Lugs: two staggered rows, the shoulder blocks half a pitch from the
  // centre blocks, with the grooves between them pressed less. Faded to their
  // mean where a pitch is too small on screen to resolve.
  let row = select(0.0, 0.5, across > 0.45);
  let lug = step(0.42, fract(along + row));
  let resolve = 1.0 - smoothstep(0.25, 0.6, fwidth(along));
  let tread = mix(0.85, mix(0.7, 1.0, lug), resolve);
  let darkening = clamp(fragmentInputs.trackDarkness * edge * tread, 0.0, 1.0);
  // ALPHA_MULTIPLY: the ground already drawn is scaled by this; alpha untouched.
  fragmentOutputs.color = vec4f(vec3f(1.0 - darkening), 0.0);
}
`;
