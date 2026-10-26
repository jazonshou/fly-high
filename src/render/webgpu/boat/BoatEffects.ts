import type { Mesh } from "@babylonjs/core/Meshes/mesh";
import type { Scene } from "@babylonjs/core/scene";
import type { FlightVisualState } from "@/src/game/types";
import type { AerialPerspectiveBinding } from "@/src/render/webgpu/atmosphere/AerialPerspective";
import type { WebGpuQualityProfile } from "@/src/render/webgpu/core/QualityProfile";
import { hullToBody, RUNABOUT_21_OUTBOARD } from "@/src/vehicles/boat/hullLines";
import type { WorldDefinition } from "@/src/world";
import { BoatSpraySystem, type BoatSprayGeometry } from "./BoatSpraySystem";

/**
 * Everything a boat leaves in the world around it, as opposed to the boat
 * itself (`createWebGpuBoat`): the spray now, the wake and the ocean's hull
 * clip as they land. The renderer's vehicle slot builds ONE of these when the
 * session's vehicle is a boat and never otherwise, so an aircraft session
 * compiles none of its shaders and pays none of its draws.
 *
 * The slot's calls, each where the aircraft-session equivalent already is:
 *  - `setProfile` on every tier change (the steam's `setMaxWisps` site);
 *  - `setFloatingOrigin` on every origin shift;
 *  - `setAerialPerspective` whenever the binding is rebuilt;
 *  - `update(state)` once a frame, after the ocean's own update.
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

export class BoatEffects {
  readonly spray: BoatSpraySystem;

  constructor(scene: Scene, options: BoatEffectsOptions) {
    // The direction the wind blows TOWARDS, as the volcanic steam reads it.
    const speed = Number.isFinite(options.world.prevailingWindSpeed) ? options.world.prevailingWindSpeed : 0;
    this.spray = new BoatSpraySystem(scene, {
      cap: options.profile.boatSprayParticleCap,
      geometry: RUNABOUT_21_SPRAY_GEOMETRY,
      windX: Math.sin(options.world.prevailingWindRadians) * speed,
      windZ: Math.cos(options.world.prevailingWindRadians) * speed,
    });
  }

  /** The meshes it may draw, none of which casts a shadow. */
  get meshes(): readonly Mesh[] {
    const spray = this.spray.mesh;
    return spray ? [spray] : [];
  }

  setProfile(profile: BoatEffectsProfile): void {
    this.spray.setCap(profile.boatSprayParticleCap);
  }

  setFloatingOrigin(originX: number, originZ: number): void {
    this.spray.setFloatingOrigin(originX, originZ);
  }

  setAerialPerspective(binding: AerialPerspectiveBinding): void {
    this.spray.setAerialPerspective(binding);
  }

  update(state: FlightVisualState): void {
    this.spray.update(state);
  }

  dispose(): void {
    this.spray.dispose();
  }
}
