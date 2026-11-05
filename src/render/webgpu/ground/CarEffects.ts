import type { Scene } from "@babylonjs/core/scene";
import type { AtmosphereSnapshot } from "@/src/render/webgpu/atmosphere/AtmosphereSystem";
import type { WebGpuQualityProfile } from "@/src/render/webgpu/core/QualityProfile";
import type { WorldDefinition } from "@/src/world";
import { CarBowWave, type CarBowWaveOcean } from "./CarBowWave";
import { CarParticleSystem } from "./CarParticleSystem";
import type { CarPipelineCompiles } from "./carPipelinePrime";
import { CarTrackSystem } from "./CarTrackSystem";

/**
 * Everything the LandCruiser does to the world around it, as opposed to the
 * car itself (`createWebGpuCar`): what it throws into the air, the prints it
 * leaves and the bow wave it pushes through a ford. Three draws at most, each
 * only while it has something to show. The renderer builds these when the
 * session's vehicle is a car and never otherwise, so an aircraft or boat
 * session compiles none of their shaders and pays none of their draws; each
 * is called where the boat's effects are: its tier field on every profile
 * change, `setFloatingOrigin` on every origin shift, `setAerialPerspective`
 * whenever the binding is rebuilt, `setAtmosphere` with the weather,
 * `update(state)` once a frame, and the bow wave's `bindOcean` after the
 * sea's own update, as the boat's wake is. With the renderer's off-frame
 * compiles each one's pipeline is built from spawn, not in the frame of its
 * first dust, print or ford (`CarPipelinePrime`).
 */

/** The tier fields the effects read. */
export type CarEffectsProfile = Pick<WebGpuQualityProfile, "vehicleParticleBudget" | "tyreTrackSegments">;

export interface CarEffectsOptions {
  readonly profile: CarEffectsProfile;
  /** The prevailing surface wind the dust and smoke drift on. */
  readonly world: Pick<WorldDefinition, "prevailingWindRadians" | "prevailingWindSpeed">;
  readonly atmosphere?: AtmosphereSnapshot;
  /** The drawn ground's height, for the tracks primed behind a car first seen moving. */
  readonly groundHeight?: (x: number, z: number) => number;
  /** The drawn sea and its level: in a sea ford the bow wave rides its waves. */
  readonly sea?: { readonly ocean: CarBowWaveOcean; readonly seaLevel: number };
  /** The renderer's off-frame pipeline compiles (`AsyncPipelineCompiles`), when it has them. */
  readonly pipelineCompiles?: CarPipelineCompiles | null;
}

export interface CarEffects {
  readonly particles: CarParticleSystem;
  readonly tracks: CarTrackSystem;
  readonly bowWave: CarBowWave;
}

export function createCarEffects(scene: Scene, options: CarEffectsOptions): CarEffects {
  // The direction the wind blows TOWARDS, as the volcanic steam and the boat's spray read it.
  const speed = Number.isFinite(options.world.prevailingWindSpeed) ? options.world.prevailingWindSpeed : 0;
  const particles = new CarParticleSystem(scene, {
    cap: options.profile.vehicleParticleBudget,
    windX: Math.sin(options.world.prevailingWindRadians) * speed,
    windZ: Math.cos(options.world.prevailingWindRadians) * speed,
    pipelineCompiles: options.pipelineCompiles ?? null,
  });
  const tracks = new CarTrackSystem(scene, {
    segments: options.profile.tyreTrackSegments,
    ...(options.groundHeight ? { groundHeight: options.groundHeight } : {}),
    pipelineCompiles: options.pipelineCompiles ?? null,
  });
  const bowWave = new CarBowWave(scene, {
    ...(options.atmosphere ? { atmosphere: options.atmosphere } : {}),
    ...(options.sea ? { sea: options.sea } : {}),
    pipelineCompiles: options.pipelineCompiles ?? null,
  });
  if (options.atmosphere) particles.setAtmosphere(options.atmosphere);
  return { particles, tracks, bowWave };
}
