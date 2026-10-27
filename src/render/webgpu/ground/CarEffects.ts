import type { Scene } from "@babylonjs/core/scene";
import type { AtmosphereSnapshot } from "@/src/render/webgpu/atmosphere/AtmosphereSystem";
import type { WebGpuQualityProfile } from "@/src/render/webgpu/core/QualityProfile";
import type { WorldDefinition } from "@/src/world";
import { CarBowWave } from "./CarBowWave";
import { CarParticleSystem } from "./CarParticleSystem";
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
 * whenever the binding is rebuilt, `setAtmosphere` with the weather, and
 * `update(state)` once a frame.
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
  });
  const tracks = new CarTrackSystem(scene, {
    segments: options.profile.tyreTrackSegments,
    ...(options.groundHeight ? { groundHeight: options.groundHeight } : {}),
  });
  const bowWave = new CarBowWave(scene, options.atmosphere ? { atmosphere: options.atmosphere } : {});
  if (options.atmosphere) particles.setAtmosphere(options.atmosphere);
  return { particles, tracks, bowWave };
}
