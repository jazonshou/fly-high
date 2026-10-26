import type { Scene } from "@babylonjs/core/scene";
import type { WebGpuQualityProfile } from "@/src/render/webgpu/core/QualityProfile";
import { hullToBody, RUNABOUT_21_OUTBOARD } from "@/src/vehicles/boat/hullLines";
import type { WorldDefinition } from "@/src/world";
import { BoatSpraySystem, type BoatSprayGeometry } from "./BoatSpraySystem";

/**
 * Everything a boat leaves in the world around it, as opposed to the boat
 * itself (`createWebGpuBoat`): the spray now, the wake as it lands. The
 * renderer builds these when the session's vehicle is a boat and never
 * otherwise, so an aircraft session compiles none of their shaders and pays
 * none of their draws. Each is a renderer system of its own, called where
 * the aircraft-session equivalent already is: its tier field on every profile
 * change (the steam's `setMaxWisps` site), `setFloatingOrigin` on every
 * origin shift, `setAerialPerspective` whenever the binding is rebuilt and
 * `update(state)` once a frame.
 */

/** The Runabout 21's propeller hub and tilt pivot in the body frame, from the hull lines. */
export const RUNABOUT_21_SPRAY_GEOMETRY: BoatSprayGeometry = Object.freeze({
  propellerHub: bodyTuple(RUNABOUT_21_OUTBOARD.propellerHub),
  tiltPivot: bodyTuple(RUNABOUT_21_OUTBOARD.tiltPivot),
});

function bodyTuple(point: { readonly x: number; readonly y: number; readonly z: number }): readonly [number, number, number] {
  const body = hullToBody(point);
  return Object.freeze([body.x, body.y, body.z] as const);
}

/** The tier fields the effects read. */
export type BoatEffectsProfile = Pick<WebGpuQualityProfile, "boatSprayParticleCap">;

export interface BoatEffectsOptions {
  readonly profile: BoatEffectsProfile;
  /** The prevailing surface wind the spray drifts on. */
  readonly world: Pick<WorldDefinition, "prevailingWindRadians" | "prevailingWindSpeed">;
}

export interface BoatEffects {
  readonly spray: BoatSpraySystem;
}

export function createBoatEffects(scene: Scene, options: BoatEffectsOptions): BoatEffects {
  // The direction the wind blows TOWARDS, as the volcanic steam reads it.
  const speed = Number.isFinite(options.world.prevailingWindSpeed) ? options.world.prevailingWindSpeed : 0;
  const spray = new BoatSpraySystem(scene, {
    cap: options.profile.boatSprayParticleCap,
    geometry: RUNABOUT_21_SPRAY_GEOMETRY,
    windX: Math.sin(options.world.prevailingWindRadians) * speed,
    windZ: Math.cos(options.world.prevailingWindRadians) * speed,
  });
  return { spray };
}
