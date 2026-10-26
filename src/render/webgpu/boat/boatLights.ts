import {
  cockpitInstrumentGlow,
  NAV_LIGHT_OUT_OF_ARC_SCALE,
  type AircraftLightState,
  type AircraftWashLight,
} from "../lighting/AircraftLighting";

/**
 * A power-driven vessel's navigation lights, under the collision regulations
 * (COLREGs Rules 21 and 23), as the aircraft lighting law's state.
 *
 * The boat goes through the aircraft law's SHAPE, not its arcs: the renderer
 * resolves one `AircraftLightState` a frame and the visual scales its lamps by
 * it (`VehicleVisual.setLightState`). What differs is the regulation:
 *
 * - **Sidelights cover 112.5 degrees each**, from right ahead to 22.5 degrees
 *   abaft the beam (Rule 21(b)), where an aircraft's cover 110. Red to port,
 *   green to starboard, so an observer still reads the heading from the
 *   colour, and from dead astern neither is seen.
 * - **The white light is all-round.** A power-driven vessel under 12 m may
 *   show one all-round white light in place of the masthead and stern lights
 *   (Rule 23(d)(i)), which is what a runabout's stern pole carries. It is on
 *   from every bearing, so it rides `tailNav` at full scale.
 * - **No beacon, strobe or landing light.** A boat has none; they stay 0.
 * - **On from sunset to sunrise**, which is when the rules require them
 *   (Rule 20(b)), and off by day, as a skipper switches them. An aircraft's
 *   nav lights burn by day as well; a moored runabout lit at noon would look
 *   wrong. They come up over the last few degrees of the sun's descent rather
 *   than at one instant, so a sunset run does not see them pop on.
 */

/** Nose-relative azimuth, degrees, positive toward STARBOARD (body +Z). */
export type BoatNavLight = "port" | "starboard";

/** Each sidelight's arc from right ahead, degrees (Rule 21(b)). */
export const BOAT_SIDELIGHT_ARC_DEGREES = 112.5;

/**
 * The sun elevation, degrees, above which the lamps are off. Between it and
 * the horizon they ramp up; below the horizon they are fully on.
 */
export const BOAT_NAV_LIGHTS_ON_BELOW_SUN_DEGREES = 3;

const ON_BELOW_SINE = Math.sin((BOAT_NAV_LIGHTS_ON_BELOW_SUN_DEGREES * Math.PI) / 180);

/**
 * Which sidelight an observer at this bearing sees, or null from astern of
 * both. Half-open at every edge, so no bearing sees two: dead ahead belongs to
 * starboard, exactly as the aircraft law's partition does.
 */
export function boatSidelightAtAzimuth(azimuth: number): BoatNavLight | null {
  if (!Number.isFinite(azimuth)) return null;
  let a = ((azimuth + 180) % 360 + 360) % 360 - 180;
  if (a === -180) a = 180;
  if (a >= 0 && a < BOAT_SIDELIGHT_ARC_DEGREES) return "starboard";
  if (a < 0 && a > -BOAT_SIDELIGHT_ARC_DEGREES) return "port";
  return null;
}

/**
 * How much the lamps are switched on, 0 by day to 1 from sunset. `!(x > ...)`
 * so a NaN sun lights them: a dark boat at night is the worse failure.
 */
export function boatNavLightsOn(sunElevationSine: number): number {
  if (!(sunElevationSine > 0)) return 1;
  if (sunElevationSine >= ON_BELOW_SINE) return 0;
  const t = 1 - sunElevationSine / ON_BELOW_SINE;
  return t * t * (3 - 2 * t);
}

export interface BoatLightInput {
  /** Bearing of the observer from the bow, degrees, positive toward starboard. */
  readonly observerAzimuthDegrees: number;
  /** `state.sun.direction[1]`. */
  readonly sunElevationSine: number;
  /** Horizontal illuminance, for the helm dash glow. */
  readonly horizontalLux: number;
}

/**
 * Resolve the boat's lamps for one frame. Pure, so the regulation is held in
 * Node. A sidelight seen from outside its arc keeps the aircraft law's dim
 * housing glow (`NAV_LIGHT_OUT_OF_ARC_SCALE`) rather than vanishing.
 */
export function resolveBoatLights(input: BoatLightInput): AircraftLightState {
  const on = boatNavLightsOn(input.sunElevationSine);
  const visible = boatSidelightAtAzimuth(input.observerAzimuthDegrees);
  const side = (light: BoatNavLight): number =>
    on * (visible === light ? 1 : NAV_LIGHT_OUT_OF_ARC_SCALE);
  return {
    portNav: side("port"),
    starboardNav: side("starboard"),
    tailNav: on,
    beacon: 0,
    strobe: 0,
    landing: 0,
    cockpitGlow: cockpitInstrumentGlow(input.sunElevationSine, input.horizontalLux),
  };
}

/**
 * Where the runabout's lamps are, body frame (+X forward, +Y up, +Z starboard,
 * metres from the centre of gravity). The bi-colour bow lantern is ONE fixture
 * on the stem head with a red lens to port and a green one to starboard, the
 * way runabouts carry them; the white light tops a stern pole a metre above
 * the gunwale (Annex I 2(k) asks it to stand at least 1 m above the
 * sidelights). The drawn lamps and the washes below are both read from here.
 */
export interface BoatLampPlacement {
  readonly port: readonly [number, number, number];
  readonly starboard: readonly [number, number, number];
  readonly allRound: readonly [number, number, number];
}

/**
 * Spill of the boat's own lamps onto its own deck, for the clustered
 * container, in the aircraft wash table's shape. Small ranges keep the spill
 * on the boat, as the aircraft's keep theirs on the airframe.
 */
export function boatWashLights(lamps: BoatLampPlacement): readonly AircraftWashLight[] {
  return Object.freeze([
    Object.freeze({
      name: "boat-sidelight-wash-port",
      offset: lamps.port,
      color: [1, 0.125, 0.094] as const,
      intensity: 0.9,
      rangeMeters: 3,
      driver: "portNav" as const,
    }),
    Object.freeze({
      name: "boat-sidelight-wash-starboard",
      offset: lamps.starboard,
      color: [0.141, 1, 0.514] as const,
      intensity: 0.9,
      rangeMeters: 3,
      driver: "starboardNav" as const,
    }),
  ]);
}
