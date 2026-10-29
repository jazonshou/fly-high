import type { CarVisualState } from "@/src/game/types";
import { BODY, h } from "./lc76Lines";

/**
 * The LandCruiser's lamps, and the light its headlamps throw on the ground.
 *
 * LAMPS are the emissive lenses on the drawn car; their law is the driver's
 * switches, not the sun: the LED day-running rings burn whenever the engine
 * runs, the headlamps when L has them dipped or on main beam (main keeps the
 * dipped beam lit, as the 76's H4-pattern switch does), the tail lamps with
 * the headlamps, and the stop, reversing and high-mounted stop lamps when the
 * car says it is braking or in reverse. A lamp in daylight is still lit and
 * still seen, so none of them is attenuated by the sun.
 *
 * POOLS are the light on the ground ahead, and they ARE attenuated by daylight
 * (the renderer's `airfieldLampDaylightAttenuation`, the law every cast pool
 * and flood in the scene takes): a beam on the road at noon is invisible in
 * life. They ride the aircraft's two cast-pool slots in the clustered
 * container while the car is on screen, as the boat's sidelight washes ride
 * its nav-wash slots, so the container and every aircraft frame stay exactly
 * what they were: the dipped beam on the taxi pool's slot (its 34 m reach),
 * main beam on the landing pool's (90 m). The container's lights are points,
 * so each pool's source stands ahead of the car and over the road, where the
 * beam lands, as the aircraft's do.
 */

export interface CarLampState {
  /** The LED day-running rings round the headlamps. */
  readonly dayRunning: number;
  readonly dipped: number;
  readonly main: number;
  /** Tail lamps (the stop lamps' dim filament). */
  readonly tail: number;
  readonly brake: number;
  readonly reverse: number;
}

export const CAR_LAMPS_OFF: CarLampState = Object.freeze({
  dayRunning: 0,
  dipped: 0,
  main: 0,
  tail: 0,
  brake: 0,
  reverse: 0,
});

/**
 * The car's lamps for one frame, from its switches. Pure, so the switch logic
 * is held in Node. The panel's glow is the scene's law, not the switches':
 * `cockpitInstrumentGlow`, as the aircraft's and the boat's.
 */
export function carLampState(car: Readonly<CarVisualState> | null): CarLampState {
  if (!car) return CAR_LAMPS_OFF;
  const dipped = car.headlights === "off" ? 0 : 1;
  return {
    dayRunning: car.engineRunning && !car.flooded ? 1 : 0,
    dipped,
    main: car.headlights === "main" ? 1 : 0,
    tail: dipped,
    brake: car.brakeLights ? 1 : 0,
    reverse: car.reversing ? 1 : 0,
  };
}

/**
 * One headlamp beam's pool of light on the road, riding an aircraft
 * cast-pool slot. The slot keeps its own colour and reach (the container's
 * definitions are fixed when it is built); the car moves it and sets its
 * intensity.
 */
export interface CarCastPool {
  readonly name: string;
  /** The aircraft pool whose clustered slot this one drives while the car is on screen. */
  readonly slot: "aircraft-taxi-pool" | "aircraft-landing-pool";
  readonly driver: "dipped" | "main";
  /** Body-frame offset of the pool's source: +X forward, +Y up, +Z right. */
  readonly offset: readonly [number, number, number];
  readonly intensity: number;
}

/**
 * The two beams' pools, body frame. The dipped beam's source stands 8 m past
 * the bumper and 2 m over flat ground, so its pool spreads over the road
 * ahead and fades toward the bumper; main beam's stands 24 m past it and
 * higher, lighting the road far beyond the dipped beam's.
 */
export const CAR_HEADLAMP_POOLS: readonly CarCastPool[] = Object.freeze([
  Object.freeze({
    name: "landcruiser-dipped-pool",
    slot: "aircraft-taxi-pool" as const,
    driver: "dipped" as const,
    offset: [BODY.bumperFront + 8, h(2), 0] as const,
    intensity: 4,
  }),
  Object.freeze({
    name: "landcruiser-main-pool",
    slot: "aircraft-landing-pool" as const,
    driver: "main" as const,
    offset: [BODY.bumperFront + 24, h(3.5), 0] as const,
    intensity: 10,
  }),
]);

/** A pool's intensity for the car's lamps and the daylight attenuation every cast pool takes. */
export function carPoolIntensity(pool: CarCastPool, lamps: CarLampState, daylightAttenuation: number): number {
  const attenuation = Number.isFinite(daylightAttenuation) ? Math.min(1, Math.max(0, daylightAttenuation)) : 0;
  return pool.intensity * lamps[pool.driver] * attenuation;
}
