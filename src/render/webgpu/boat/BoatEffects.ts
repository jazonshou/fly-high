import type { Scene } from "@babylonjs/core/scene";
import type { WeatherPreset } from "@/src/game/types";
import type { AtmosphereSnapshot } from "@/src/render/webgpu/atmosphere/AtmosphereSystem";
import type { WebGpuQualityProfile } from "@/src/render/webgpu/core/QualityProfile";
import {
  HULL_STATIONS,
  hullToBody,
  RUNABOUT_21_CG,
  RUNABOUT_21_OUTBOARD,
  RUNABOUT_21_REST_WATERLINE,
} from "@/src/vehicles/boat/hullLines";
import type { WorldDefinition } from "@/src/world";
import { BoatSpraySystem, type BoatSprayGeometry } from "./BoatSpraySystem";
import { BoatWakeSystem, type BoatWakeGeometry, type BoatWakeOcean } from "./BoatWakeSystem";
import { OceanHullClip } from "./oceanHullClip";
import { UndrawnSeaHeave } from "./undrawnSeaHeave";

/**
 * Everything a boat does to the world around it, as opposed to the boat
 * itself (`createWebGpuBoat`): the spray, the wake, and the sea kept out of
 * its hull (`OceanHullClip`, set on the ocean here, once, at load). The
 * renderer builds these when the session's vehicle is a boat and never
 * otherwise, so an aircraft session compiles none of their shaders and pays
 * none of their draws. Each is a renderer system of its own, called where
 * the aircraft-session equivalent already is: its tier field on every profile
 * change (the steam's `setMaxWisps` site), `setFloatingOrigin` on every
 * origin shift, `setAerialPerspective` whenever the binding is rebuilt and
 * `update(state)` once a frame; the wake also takes `bindOcean()` after the
 * ocean's own update, which hands it the displacement the sea is drawn with.
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

/**
 * Where the Runabout 21's wake starts: the transom's foot on the centreline at
 * the still waterline, and the half-beam at the transom's chine.
 */
export const RUNABOUT_21_WAKE_GEOMETRY: BoatWakeGeometry = Object.freeze({
  transom: Object.freeze([-RUNABOUT_21_CG.x, -RUNABOUT_21_REST_WATERLINE.cgAboveWater, 0] as const),
  halfBeam: HULL_STATIONS[0]!.chineHalfBeam,
});

/** The tier fields the effects read. */
export type BoatEffectsProfile = Pick<
  WebGpuQualityProfile,
  "boatSprayParticleCap" | "boatWakeTrailSeconds" | "oceanCascades"
>;

export interface BoatEffectsOptions {
  readonly profile: BoatEffectsProfile;
  /** The prevailing surface wind the spray drifts on, and the sea level the wake lies on. */
  readonly world: Pick<WorldDefinition, "prevailingWindRadians" | "prevailingWindSpeed" | "seaLevel">;
  /** The sea whose displacement the wake rides and whose water the hull keeps out. */
  readonly ocean: BoatEffectsOcean;
  /** The light the sea is lit by at load; `BoatWakeSystem.setAtmosphere` with every change after. */
  readonly atmosphere?: AtmosphereSnapshot;
  /** The session's world and starting weather, for the swell the tier does not draw (`UndrawnSeaHeave`). */
  readonly sea?: { readonly world: WorldDefinition; readonly weather: WeatherPreset };
}

/** What the effects need of the sea. */
export interface BoatEffectsOcean extends BoatWakeOcean {
  setHullClip(clip: OceanHullClip | null): void;
}

export interface BoatEffects {
  readonly spray: BoatSpraySystem;
  readonly wake: BoatWakeSystem;
  /** The renderer poses it every frame the boat is on screen and clears it while it is not. */
  readonly hullClip: OceanHullClip;
  /** How far to lower the drawn boat onto the sea the tier draws; null without `sea`. */
  readonly heave: UndrawnSeaHeave | null;
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
  const wake = new BoatWakeSystem(scene, {
    trailSeconds: options.profile.boatWakeTrailSeconds,
    geometry: RUNABOUT_21_WAKE_GEOMETRY,
    seaLevel: options.world.seaLevel,
    ocean: options.ocean,
  });
  if (options.atmosphere) {
    wake.setAtmosphere(options.atmosphere);
    spray.setAtmosphere(options.atmosphere);
  }
  const hullClip = new OceanHullClip();
  options.ocean.setHullClip(hullClip);
  const heave = options.sea
    ? new UndrawnSeaHeave(options.sea.world, options.sea.weather, options.profile.oceanCascades)
    : null;
  return { spray, wake, hullClip, heave };
}
