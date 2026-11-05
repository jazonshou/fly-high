import { Constants } from "@babylonjs/core/Engines/constants";
import { ShaderStore } from "@babylonjs/core/Engines/shaderStore";
import { Material } from "@babylonjs/core/Materials/material";
import { ShaderLanguage } from "@babylonjs/core/Materials/shaderLanguage";
import { ShaderMaterial } from "@babylonjs/core/Materials/shaderMaterial";
import { Vector3, Vector4 } from "@babylonjs/core/Maths/math.vector";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { VertexData } from "@babylonjs/core/Meshes/mesh.vertexData";
import type { Scene } from "@babylonjs/core/scene";
import type { FlightVisualState } from "@/src/game/types";
import {
  AERIAL_PERSPECTIVE_UNIFORMS,
  AERIAL_PERSPECTIVE_WGSL,
  applyAerialPerspectiveToShaderMaterial,
  type AerialPerspectiveBinding,
} from "@/src/render/webgpu/atmosphere/AerialPerspective";
import type { AtmosphereSnapshot } from "@/src/render/webgpu/atmosphere/AtmosphereSystem";
import { sprayClock } from "@/src/render/webgpu/boat/BoatSpraySystem";
import {
  keepOpaqueDepthForRenderingGroup,
  WATER_RENDERING_GROUP_ID,
} from "@/src/render/webgpu/core/RenderingGroups";
import {
  OCEAN_SURFACE_DISPLACEMENT_DECLARATIONS_WGSL,
  OCEAN_SURFACE_DISPLACEMENT_WGSL,
  OCEAN_SURFACE_SAMPLERS,
  OCEAN_SURFACE_UNIFORMS,
} from "@/src/render/webgpu/water/SpectralOceanSystem";
import {
  WATER_SKY_IRRADIANCE_FRACTION,
  WATER_SUN_IRRADIANCE_SCALE,
} from "@/src/render/webgpu/water/WaterShaders";
import { carWheelContacts, carWheelWaterDepths, createCarWheelContacts, rotateCarBodyToWorld } from "./carEffectLaws";
import { CarPipelinePrime, type CarPipelineCompiles } from "./carPipelinePrime";
import { BODY } from "./lc76Lines";

/**
 * The LandCruiser's bow wave in a ford, as ONE draw of a foam skirt lying on
 * the water around the body, and no draw out of the water.
 *
 * WHAT IS DRAWN. A ring of quads round the body's waterline footprint (the
 * bumpers' faces and the flares' sides, corners rounded), reaching out by a
 * width the vertex shader sets from the car's speed through the water:
 *  - **the bow wave** on the leading faces: water the bumper drives ahead of
 *    it, standing up against the bumper to the stagnation height v²/2g
 *    (capped by the depth: a shallow ford cannot pile more than it holds),
 *    wider with speed, white where it breaks;
 *  - **the wash** behind: churned water spreading from the trailing faces;
 *  - **a collar** of white water hugging the body wherever it moves.
 * The foam is broken into soft-edged patches by value noise that flows
 * outward from the body at the water's speed past it, and thinned inside them
 * by a finer octave, so it reads as bubbles rather than paint. The splash thrown up off the bumper is
 * the particles' (`CarParticleSystem`).
 *
 * WHERE. On the water the car stands in: the ground under its lowest tyre
 * (the feet raised by their sinkage, `carWheelContacts`) plus the payload's
 * `wadingDepth`, which the simulator measures from that tyre, turned with
 * the car's heading only, as the water stays level whatever the body does.
 * It fades in and out over a third of a second, so driving into a ford never
 * pops.
 *
 * ON THE SEA, ON ITS WAVES. The sea is drawn with its swell, and a skirt
 * lying at one calm level sat under a crest: the opaque sea covered the body down to the drawn
 * waterline while the skirt, a crest's height lower, could only be seen
 * where it lay clear of the body, so the foam broke off a body's width
 * behind the car and left a hole of plain sea under the tail lamps
 * (`car-ford-chase`, 2026-10-27). In the sea (`CarBowWaveOptions.sea`) the
 * skirt takes the drawn sea's height (`oceanSurfaceDisplacement`, the
 * include the ocean and the boat's wake are built from), so it lies on the
 * drawn waves and its collar meets the body where the water does. Only the
 * height: the sea's vertices also move sideways with the chop, and a skirt
 * moved with them stood a metre off the body in a Cloudy swell, so it reads
 * the surface over each of its own points as the sea twin the car wades
 * does, by two fixed-point steps back along the displacement. Inland
 * water is drawn flat and keeps the flat skirt; which water the car is in is
 * the simulator's (`CarVisualState.wadingSea`, the share of its wet tyres in
 * the sea), since a lake beside the shore can stand at the sea's level.
 *
 * LIT AS FOAM on a level surface: the albedo under the sea's downwelling (the
 * sun by its elevation, plus the sky), from the same snapshot as the spray.
 *
 * DRAW ORDER. Group 1 (water) at alphaIndex 2.4: after the inland water the
 * ford is in, before the particles. Depth-tested, never written.
 */

/** Points round the footprint, and rings out from it. */
export const CAR_BOW_WAVE_SEGMENTS = 48;
export const CAR_BOW_WAVE_RINGS = 4;
/** Below this water depth there is no bow wave. */
export const CAR_BOW_WAVE_MIN_DEPTH = 0.08;
/** The fade in and out, per second. */
export const CAR_BOW_WAVE_FADE_RATE = 3;
/** Foam on a ford: a little under the boat's fresh wake foam, and not quite white (silt). */
export const CAR_BOW_WAVE_ALBEDO = Object.freeze([0.5, 0.48, 0.43] as const);
/** The footprint's corner radius, metres. */
const CORNER_RADIUS = 0.45;
/** Shader define: the skirt reads the sea's displacement. */
export const CAR_BOW_WAVE_SEA_DEFINE = "CAR_BOW_WAVE_SEA";

/**
 * The footprint's outline in the body frame (x forward, z right) with each
 * point's outward normal and its distance round the outline, metres:
 * `CAR_BOW_WAVE_SEGMENTS` points spaced evenly along it.
 */
export function carBowWaveOutline(): { x: number; z: number; nx: number; nz: number; arc: number }[] {
  const front = BODY.bumperFront;
  const rear = BODY.bumperRear;
  const half = BODY.flareHalfWidth;
  const r = CORNER_RADIUS;
  const straightX = front - rear - 2 * r;
  const straightZ = 2 * half - 2 * r;
  const quarter = (Math.PI * r) / 2;
  const perimeter = 2 * straightX + 2 * straightZ + 4 * quarter;
  const out: { x: number; z: number; nx: number; nz: number; arc: number }[] = [];
  for (let index = 0; index < CAR_BOW_WAVE_SEGMENTS; index += 1) {
    const arc = (index / CAR_BOW_WAVE_SEGMENTS) * perimeter;
    let s = arc;
    let x: number;
    let z: number;
    let nx: number;
    let nz: number;
    // Round from the middle of the front bumper, to the right (+z) first.
    if (s < straightZ / 2) {
      x = front; z = s; nx = 1; nz = 0;
    } else if ((s -= straightZ / 2) < quarter) {
      const a = s / r;
      nx = Math.cos(a); nz = Math.sin(a);
      x = front - r + r * nx; z = half - r + r * nz;
    } else if ((s -= quarter) < straightX) {
      x = front - r - s; z = half; nx = 0; nz = 1;
    } else if ((s -= straightX) < quarter) {
      const a = Math.PI / 2 + s / r;
      nx = Math.cos(a); nz = Math.sin(a);
      x = rear + r + r * nx; z = half - r + r * nz;
    } else if ((s -= quarter) < straightZ) {
      x = rear; z = half - r - s; nx = -1; nz = 0;
    } else if ((s -= straightZ) < quarter) {
      const a = Math.PI + s / r;
      nx = Math.cos(a); nz = Math.sin(a);
      x = rear + r + r * nx; z = -half + r + r * nz;
    } else if ((s -= quarter) < straightX) {
      x = rear + r + s; z = -half; nx = 0; nz = -1;
    } else if ((s -= straightX) < quarter) {
      const a = (3 * Math.PI) / 2 + s / r;
      nx = Math.cos(a); nz = Math.sin(a);
      x = front - r + r * nx; z = -half + r + r * nz;
    } else {
      s -= quarter;
      x = front; z = -half + r + s; nx = 1; nz = 0;
    }
    out.push({ x, z, nx, nz, arc });
  }
  return out;
}

/** What the skirt needs of the sea: its displacement, bound to the skirt's material each frame. */
export interface CarBowWaveOcean {
  bindSurface(material: ShaderMaterial): void;
}

export interface CarBowWaveOptions {
  readonly atmosphere?: AtmosphereSnapshot;
  /** The drawn sea and its level. Without it the skirt lies flat in any water. */
  readonly sea?: { readonly ocean: CarBowWaveOcean; readonly seaLevel: number };
  /** The renderer's off-frame compiles, for the spawn's pipeline prime (`CarPipelinePrime`). */
  readonly pipelineCompiles?: CarPipelineCompiles | null;
}

export class CarBowWave {
  private readonly mesh: Mesh;
  private readonly material: ShaderMaterial;
  private readonly pipelinePrime: CarPipelinePrime;
  private readonly contacts = createCarWheelContacts();
  private readonly depths = [0, 0, 0, 0];
  private readonly forward = { x: 1, y: 0, z: 0 };
  private presenceValue = 0;
  private lastTime = Number.NaN;
  private worldX = 0;
  private worldZ = 0;
  private originX = 0;
  private originZ = 0;
  /** xyz the water at the car, from the floating origin; w the heading, radians from +x towards +z. */
  private readonly poseUniform = new Vector4();
  /** x speed along the body's forward axis, y water depth, z presence, w clock. */
  private readonly motionUniform = new Vector4();
  /** x the sea's share of the wet tyres (`wadingSea`), y the sea level, zw the floating origin. */
  private readonly seaUniform = new Vector4();
  private readonly sea: CarBowWaveOptions["sea"] | null;
  private readonly sunUniform = new Vector3(1, 1, 1);
  private readonly skyUniform = new Vector3(0.3, 0.3, 0.3);
  private readonly aerialVectors3 = new Map<string, Vector3>();
  private readonly aerialVectors4 = new Map<string, Vector4>();
  private readonly setAerialVector3 = (name: string, x: number, y: number, z: number): void => {
    let vector = this.aerialVectors3.get(name);
    if (!vector) {
      vector = new Vector3();
      this.aerialVectors3.set(name, vector);
    }
    vector.set(x, y, z);
    this.material.setVector3(name, vector);
  };
  private readonly setAerialVector4 = (name: string, x: number, y: number, z: number, w: number): void => {
    let vector = this.aerialVectors4.get(name);
    if (!vector) {
      vector = new Vector4();
      this.aerialVectors4.set(name, vector);
    }
    vector.set(x, y, z, w);
    this.material.setVector4(name, vector);
  };

  constructor(scene: Scene, options: CarBowWaveOptions = {}) {
    ShaderStore.ShadersStoreWGSL[`${CAR_BOW_WAVE_SHADER_NAME}VertexShader`] = CAR_BOW_WAVE_VERTEX_WGSL;
    ShaderStore.ShadersStoreWGSL[`${CAR_BOW_WAVE_SHADER_NAME}PixelShader`] = CAR_BOW_WAVE_FRAGMENT_WGSL;
    keepOpaqueDepthForRenderingGroup(scene, WATER_RENDERING_GROUP_ID);

    const outline = carBowWaveOutline();
    const positions: number[] = [];
    const normals: number[] = [];
    const arcs: number[] = [];
    const indices: number[] = [];
    const ringVertices = CAR_BOW_WAVE_RINGS + 1;
    for (const point of outline) {
      for (let ring = 0; ring <= CAR_BOW_WAVE_RINGS; ring += 1) {
        // position: the outline point (x, z) and how far out (0 at the body, 1 at the edge).
        positions.push(point.x, ring / CAR_BOW_WAVE_RINGS, point.z);
        normals.push(point.nx, point.nz);
        arcs.push(point.arc, 0);
      }
    }
    for (let index = 0; index < outline.length; index += 1) {
      const next = (index + 1) % outline.length;
      for (let ring = 0; ring < CAR_BOW_WAVE_RINGS; ring += 1) {
        const a = index * ringVertices + ring;
        const b = next * ringVertices + ring;
        indices.push(a, b, a + 1, a + 1, b, b + 1);
      }
    }
    const mesh = new Mesh("car-bow-wave", scene);
    const data = new VertexData();
    data.positions = positions;
    data.uvs = normals;
    data.uvs2 = arcs;
    data.indices = indices;
    data.applyToMesh(mesh, false);
    mesh.renderingGroupId = WATER_RENDERING_GROUP_ID;
    mesh.alphaIndex = 2.4;
    mesh.isPickable = false;
    mesh.applyFog = false;
    mesh.receiveShadows = false;
    mesh.alwaysSelectAsActiveMesh = true;
    mesh.doNotSyncBoundingInfo = true;

    const material = new ShaderMaterial(
      "car-bow-wave-material",
      scene,
      CAR_BOW_WAVE_SHADER_NAME,
      {
        attributes: ["position", "uv", "uv2"],
        uniforms: [
          "view",
          "projection",
          "cameraPosition",
          "bowPose",
          "bowMotion",
          "bowSun",
          "bowSky",
          "bowSea",
          ...(options.sea ? OCEAN_SURFACE_UNIFORMS : []),
          ...AERIAL_PERSPECTIVE_UNIFORMS,
        ],
        samplers: options.sea ? [...OCEAN_SURFACE_SAMPLERS] : [],
        defines: options.sea ? [`#define ${CAR_BOW_WAVE_SEA_DEFINE}`] : [],
        shaderLanguage: ShaderLanguage.WGSL,
        needAlphaBlending: true,
      },
    );
    material.backFaceCulling = false;
    material.disableDepthWrite = true;
    material.transparencyMode = Material.MATERIAL_ALPHABLEND;
    material.alphaMode = Constants.ALPHA_PREMULTIPLIED_PORTERDUFF;
    material.setVector4("bowPose", this.poseUniform);
    material.setVector4("bowMotion", this.motionUniform);
    material.setVector3("bowSun", this.sunUniform);
    material.setVector3("bowSky", this.skyUniform);
    this.sea = options.sea ?? null;
    this.seaUniform.y = this.sea?.seaLevel ?? 0;
    material.setVector4("bowSea", this.seaUniform);
    mesh.material = material;
    mesh.setEnabled(false);
    this.mesh = mesh;
    this.material = material;
    this.pipelinePrime = new CarPipelinePrime(options.pipelineCompiles ?? null);
    this.pipelinePrime.adopt(material);
    if (options.atmosphere) this.setAtmosphere(options.atmosphere);
  }

  get drawing(): boolean {
    return this.mesh.isEnabled(false);
  }

  /** 0 out of the water .. 1 wading, eased. */
  get presence(): number {
    return this.presenceValue;
  }

  /** The water surface the skirt lies on, world metres, and the car's heading. */
  get pose(): { readonly x: number; readonly y: number; readonly z: number; readonly heading: number } {
    return { x: this.worldX, y: this.poseUniform.y, z: this.worldZ, heading: this.poseUniform.w };
  }

  /** The share of the sea's waves the skirt rides: 1 in the sea, 0 on a lake or a river. */
  get seaShare(): number {
    return this.seaUniform.x;
  }

  get bowMesh(): Mesh {
    return this.mesh;
  }

  /** The sea's sun and sky, split as `BoatSpraySystem.setAtmosphere` splits them. */
  setAtmosphere(atmosphere: AtmosphereSnapshot): void {
    const sun = atmosphere.sunIlluminanceNormalized * WATER_SUN_IRRADIANCE_SCALE;
    this.sunUniform.set(atmosphere.sunColor.r * sun, atmosphere.sunColor.g * sun, atmosphere.sunColor.b * sun);
    const sky = 0.5 * WATER_SKY_IRRADIANCE_FRACTION * atmosphere.skylightIlluminanceNormalized;
    this.skyUniform.set(
      (atmosphere.skyZenith.r + atmosphere.skyHorizon.r) * sky,
      (atmosphere.skyZenith.g + atmosphere.skyHorizon.g) * sky,
      (atmosphere.skyZenith.b + atmosphere.skyHorizon.b) * sky,
    );
    this.material.setVector3("bowSun", this.sunUniform);
    this.material.setVector3("bowSky", this.skyUniform);
  }

  setAerialPerspective(binding: AerialPerspectiveBinding): void {
    applyAerialPerspectiveToShaderMaterial(this.material, binding, this.setAerialVector3, this.setAerialVector4);
  }

  setFloatingOrigin(originX: number, originZ: number): void {
    this.originX = originX;
    this.originZ = originZ;
    this.poseUniform.x = this.worldX - originX;
    this.poseUniform.z = this.worldZ - originZ;
    this.seaUniform.z = originX;
    this.seaUniform.w = originZ;
  }

  /** After the ocean's own update: hand the skirt this frame's waves. */
  bindOcean(): void {
    if (!this.sea || !this.mesh.isEnabled(false)) return;
    this.sea.ocean.bindSurface(this.material);
  }

  update(state: FlightVisualState): void {
    const car = state.vehicle?.kind === "car" ? state.vehicle : null;
    const time = Number.isFinite(state.simulationTime) ? state.simulationTime : 0;
    const elapsed = Number.isNaN(this.lastTime) ? 0 : Math.min(0.25, Math.max(0, time - this.lastTime));
    this.lastTime = time;
    const depth = car && Number.isFinite(car.wadingDepth) ? Math.max(0, car.wadingDepth) : 0;
    const target = car && !state.crashed && depth >= CAR_BOW_WAVE_MIN_DEPTH ? 1 : 0;
    const step = CAR_BOW_WAVE_FADE_RATE * elapsed;
    this.presenceValue = target > this.presenceValue
      ? Math.min(target, this.presenceValue + step)
      : Math.max(target, this.presenceValue - step);
    if (car && depth > 0) {
      carWheelContacts(state, car, this.contacts);
      const level = carWheelWaterDepths(car, this.contacts, this.depths);
      rotateCarBodyToWorld(state.orientation, 1, 0, 0, this.forward);
      this.worldX = state.position.x;
      this.worldZ = state.position.z;
      this.poseUniform.set(
        state.position.x - this.originX,
        level,
        state.position.z - this.originZ,
        Math.atan2(this.forward.z, this.forward.x),
      );
      this.motionUniform.set(Number.isFinite(car.speed) ? car.speed : 0, depth, this.presenceValue, sprayClock(time));
      this.seaUniform.x = this.sea && Number.isFinite(car.wadingSea) ? Math.min(1, Math.max(0, car.wadingSea)) : 0;
    } else {
      this.motionUniform.z = this.presenceValue;
      this.motionUniform.w = sprayClock(time);
    }
    const draw = this.presenceValue > 0.001 || this.pipelinePrime.wanted(this.mesh);
    if (this.mesh.isEnabled(false) !== draw) this.mesh.setEnabled(draw);
  }

  dispose(): void {
    this.mesh.dispose(false, false);
    this.material.dispose();
  }
}

function wgslFloat(value: number): string {
  return Number.isInteger(value) ? `${value}.0` : `${value}`;
}

const CAR_BOW_WAVE_SHADER_NAME = "carBowWave";

export const CAR_BOW_WAVE_VERTEX_WGSL = /* wgsl */ `
attribute position: vec3f;
// the outline's outward normal, body x and z
attribute uv: vec2f;
// x the distance round the outline, metres
attribute uv2: vec2f;

varying bowOut: f32;
varying bowLead: f32;
varying bowTrail: f32;
varying bowNoise: vec2f;
varying bowColor: vec3f;
varying bowGate: f32;

uniform view: mat4x4f;
uniform projection: mat4x4f;
uniform cameraPosition: vec3f;
uniform bowPose: vec4f;
uniform bowMotion: vec4f;
uniform bowSun: vec3f;
uniform bowSky: vec3f;
uniform bowSea: vec4f;
#ifdef ${CAR_BOW_WAVE_SEA_DEFINE}
${OCEAN_SURFACE_DISPLACEMENT_DECLARATIONS_WGSL}
#endif

${AERIAL_PERSPECTIVE_WGSL}
#ifdef ${CAR_BOW_WAVE_SEA_DEFINE}
${OCEAN_SURFACE_DISPLACEMENT_WGSL}
#endif

const BOW_GRAVITY: f32 = 9.81;
const BOW_ALBEDO: vec3f = vec3f(${CAR_BOW_WAVE_ALBEDO.map(wgslFloat).join(", ")});

@vertex
fn main(input: VertexInputs) -> FragmentInputs {
  let outline = vec2f(vertexInputs.position.x, vertexInputs.position.z);
  let out = vertexInputs.position.y;
  let normal = vertexInputs.uv;
  let speed = uniforms.bowMotion.x;
  let depth = uniforms.bowMotion.y;
  let way = smoothstep(0.2, 2.5, abs(speed));
  // Which way this face meets the water: the leading faces pile it, the trailing ones churn it.
  let facing = normal.x * select(1.0, -1.0, speed < 0.0);
  let lead = smoothstep(-0.3, 0.9, facing);
  let trail = smoothstep(0.2, -0.9, facing);
  let width = 0.25 + lead * (0.5 + 1.3 * way) + trail * (0.3 + 1.2 * way) + 0.25 * way;
  // The stagnation height v^2/2g against the leading faces, as deep as the ford allows.
  let stand = min(speed * speed / (2.0 * BOW_GRAVITY), min(0.3, 0.5 * depth));
  let rise = stand * lead * (1.0 - out) * (1.0 - out) * (1.0 + 2.0 * out);
  let local = outline + normal * (width * out - 0.03);
  let c = cos(uniforms.bowPose.w);
  let s = sin(uniforms.bowPose.w);
  // Body x forward, z right, turned to the heading (forward = (cos h, sin h) in world x, z).
  let turned = vec2f(local.x * c - local.y * s, local.x * s + local.y * c);
  // On the sea, the drawn surface's height over this point, so the skirt
  // lies on the drawn waves: the calm level eased to sea level, plus the
  // swell. The sea's vertices move sideways with the chop as well as up, so
  // the surface over this point is the one whose vertex started a
  // displacement away: found as the sea twin finds it, by two fixed-point
  // steps. The skirt keeps its own place round the body.
  var swell = 0.0;
  var level = uniforms.bowPose.y;
#ifdef ${CAR_BOW_WAVE_SEA_DEFINE}
  let share = uniforms.bowSea.x;
  if (share > 0.0) {
    let worldXZ = vec2f(uniforms.bowPose.x + turned.x, uniforms.bowPose.z + turned.y) + uniforms.bowSea.zw;
    var label = worldXZ;
    for (var iteration = 0; iteration < 2; iteration += 1) {
      label = worldXZ - oceanSurfaceDisplacement(label).xz * share;
    }
    swell = oceanSurfaceDisplacement(label).y * share;
    level = mix(level, uniforms.bowSea.y, share);
  }
#endif
  let world = vec3f(uniforms.bowPose.x + turned.x, level + 0.02 + rise + swell, uniforms.bowPose.z + turned.y);

  let toPoint = world - uniforms.cameraPosition;
  let distanceMeters = max(length(toPoint), 0.001);
  let sunDirection = normalize(uniforms.aerialSunDirection);
  let sun = uniforms.bowSun * max(sunDirection.y, 0.0);
  let radiance = BOW_ALBEDO * (sun + uniforms.bowSky);
  let haze = aerialPerspective(world.y, distanceMeters, dot(toPoint / distanceMeters, sunDirection));

  let clip = uniforms.projection * uniforms.view * vec4f(world, 1.0);
  // Out of the water (the spawn's pipeline prime) the skirt rasterises nothing.
  vertexOutputs.position = select(clip, vec4f(0.0, 0.0, 2.0, 1.0), uniforms.bowMotion.z <= 0.0);
  vertexOutputs.bowOut = out;
  vertexOutputs.bowLead = lead * (0.55 + 0.45 * way);
  vertexOutputs.bowTrail = trail * way;
  // The foam flows out from the body at the water's speed past it.
  vertexOutputs.bowNoise = vec2f(vertexInputs.uv2.x * 4.0, (width * out) * 5.0 - uniforms.bowMotion.w * (1.5 + 2.0 * abs(speed)));
  vertexOutputs.bowColor = radiance * haze.transmittance + haze.inScatter;
  vertexOutputs.bowGate = uniforms.bowMotion.z * smoothstep(${wgslFloat(CAR_BOW_WAVE_MIN_DEPTH)}, 0.35, depth);
}
`;

export const CAR_BOW_WAVE_FRAGMENT_WGSL = /* wgsl */ `
varying bowOut: f32;
varying bowLead: f32;
varying bowTrail: f32;
varying bowNoise: vec2f;
varying bowColor: vec3f;
varying bowGate: f32;

fn bowHash(cell: vec2i) -> f32 {
  var h = (bitcast<u32>(cell.x) * 0x8da6b343u) ^ (bitcast<u32>(cell.y) * 0xd8163841u);
  h = (h ^ (h >> 16u)) * 0x7feb352du;
  h = (h ^ (h >> 15u)) * 0x846ca68bu;
  h = h ^ (h >> 16u);
  return f32(h >> 8u) * (1.0 / 16777216.0);
}

fn bowValueNoise(p: vec2f) -> f32 {
  let cell = floor(p);
  let f = p - cell;
  let w = f * f * (vec2f(3.0) - 2.0 * f);
  let i = vec2i(cell);
  let bottom = mix(bowHash(i), bowHash(i + vec2i(1, 0)), w.x);
  let top = mix(bowHash(i + vec2i(0, 1)), bowHash(i + vec2i(1, 1)), w.x);
  return mix(bottom, top, w.y);
}

@fragment
fn main(input: FragmentInputs) -> FragmentOutputs {
  let out = fragmentInputs.bowOut;
  // White water: the collar at the body, the breaking bow wave ahead, the wash behind.
  let collar = 0.5 * (1.0 - smoothstep(0.0, 0.3, out));
  let reach = 1.0 - smoothstep(0.2, 1.0, out);
  let cover = clamp(collar + (0.75 * fragmentInputs.bowLead + 0.5 * fragmentInputs.bowTrail) * reach, 0.0, 0.85);
  let p = fragmentInputs.bowNoise;
  let noise = 0.62 * bowValueNoise(p) + 0.38 * bowValueNoise(p * 2.31 + vec2f(3.7, 9.1));
  // Patches that break up and thin towards the edge rather than a sheet, on
  // soft edges, and broken inside by finer bubbles and streaks: a hard edge
  // and a flat inside read as white paint on the water.
  let foam = smoothstep(0.95 - cover, 1.3 - cover, noise) * (0.35 + 0.65 * reach);
  let bubbles = bowValueNoise(p * vec2f(2.7, 1.6) + vec2f(11.3, 4.7));
  let alpha = fragmentInputs.bowGate * foam * (0.4 + 0.35 * bubbles);
  if (alpha < 0.003) { discard; }
  fragmentOutputs.color = vec4f(max(fragmentInputs.bowColor, vec3f(0.0)) * alpha, alpha);
}
`;
