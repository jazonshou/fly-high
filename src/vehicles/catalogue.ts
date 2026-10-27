import {
  aircraftSpec,
  type ChaseFramingSpec,
  type CinematicOrbitSpec,
  type CockpitEyeSpec,
  type EngineReadoutSpec,
  type EngineSoundSpec,
  type TopFrontViewSpec,
} from "@/src/aircraft/catalogue";
import {
  isAircraftKind,
  SURFACE_VEHICLE_KINDS,
  type SurfaceVehicleKind,
  type VehicleClass,
  type VehicleKind,
} from "./kinds";

/**
 * How the chase rig follows a vehicle.
 *
 * `"aircraft"` is today's rig: it adopts part of the bank and clamps above the
 * terrain. `"surface"` is yaw-led: the vehicle's wave or bump pitch and roll
 * are damped out of the view, and over water the camera also clamps above the
 * local wave surface.
 */
export type ChaseFollow = "aircraft" | "surface";

/**
 * What the shared seams need to know about a vehicle: its name in the picker,
 * how every camera frames it, and its engine readout and sound. The aircraft
 * keep their full `AircraftSpec`; `vehicleSpec` presents its shared part.
 */
export interface VehicleSpec {
  readonly kind: VehicleKind;
  readonly vehicleClass: VehicleClass;
  readonly name: string;
  readonly description: string;
  readonly follow: ChaseFollow;
  readonly chase: ChaseFramingSpec;
  readonly cinematic: CinematicOrbitSpec;
  readonly topFront: TopFrontViewSpec;
  /** The driver's eye for the cockpit (helm) view, body frame, metres from the CG. */
  readonly cockpitEye: CockpitEyeSpec;
  readonly engineReadout: EngineReadoutSpec;
  readonly engineSound: EngineSoundSpec;
}

export interface SurfaceVehicleSpec extends VehicleSpec {
  readonly kind: SurfaceVehicleKind;
  readonly vehicleClass: Exclude<VehicleClass, "aircraft">;
}

/**
 * The generic 21 ft deep-V runabout with one 200 hp V6 outboard (decision D3,
 * 2026-10-26). The top and front framing is measured on the built model in
 * tests/render.top-front-views.test.ts, as the aircraft's is: its box runs
 * from the propeller (2.67 m aft of the centre of gravity) to the stem
 * (4.63 m ahead) and from the skeg (0.99 m below) to the all-round light
 * (1.83 m above). The helm eye is a seated driver's: 0.8 m above the helm
 * seat's cushion, over the hips, behind the wheel.
 */
const SPEEDBOAT: SurfaceVehicleSpec = Object.freeze({
  kind: "speedboat",
  vehicleClass: "boat",
  name: "Runabout 21",
  description: "Speedboat",
  follow: "surface",
  chase: Object.freeze({
    distance: Object.freeze({ base: 14, knee: 8, slope: 0.08, cap: 3 }),
    height: 4.5,
    fieldOfView: Object.freeze({ base: 58, knee: 8, slope: 0.25, cap: 8 }),
    aimAhead: Object.freeze({ base: 6, knee: 0, slope: 0, cap: 0 }),
  }),
  cinematic: Object.freeze({ radiusMeters: 18, heightMeters: 5, heightDriftMeters: 1.5 }),
  topFront: Object.freeze({ centreForward: 0.98, centreUp: 0.42, topDistanceMeters: 20, frontDistanceMeters: 12 }),
  cockpitEye: Object.freeze({ forward: 0.27, up: 1.12, right: 0.53 }),
  engineReadout: Object.freeze({ label: "RPM", unit: "ENG", maximum: 6_000, roundTo: 50 }),
  // A V6 four-stroke fires three times per crank turn: the fundamental is
  // rpm / 20, 35 Hz at the 700 rpm idle and 300 Hz at the 6,000 rpm limiter,
  // which is exactly 0 + (rpm / 6,000) x 300. The low-pass is the exhaust's,
  // set every frame by `boatSoundTargets` (open at idle, muffled through the
  // hub under way); this is its idle value.
  engineSound: Object.freeze({
    baseHz: 0,
    spanHz: 300,
    gainBase: 0.12,
    gainSpan: 0.3,
    filterHz: 760,
    filterQ: 0.6,
    waveforms: Object.freeze(["sawtooth", "square"] as const) as readonly [OscillatorType, OscillatorType],
  }),
});

/**
 * The LandCruiser 76 GXL wagon: 2.8 litre 1GD-FTV four-cylinder turbo-diesel,
 * part-time 4WD (the land plan, 2026-10-25). The top and front views are
 * measured on the built model (`render.top-front-views`): the drawn car runs
 * from the tow hitch 2.72 m behind the centre of gravity to the bumper 2.19 m
 * ahead, and from the tyres' feet 0.82 m below it to the snorkel's head
 * 1.19 m above, so the views aim 0.26 m aft of it and fill 60% of the frame.
 * Right-hand drive: the driver's eye is to starboard, over the seat, and
 * about 0.2 m lower than a seated driver's so the level cockpit lens holds
 * the gauges through the wheel (`DRIVER_EYE` in the drawn car's lines).
 */
const LANDCRUISER: SurfaceVehicleSpec = Object.freeze({
  kind: "landcruiser",
  vehicleClass: "car",
  name: "LandCruiser 76",
  description: "4x4",
  follow: "surface",
  chase: Object.freeze({
    distance: Object.freeze({ base: 7.5, knee: 8, slope: 0.08, cap: 2.5 }),
    height: 2.6,
    fieldOfView: Object.freeze({ base: 58, knee: 8, slope: 0.25, cap: 8 }),
    aimAhead: Object.freeze({ base: 4, knee: 0, slope: 0, cap: 0 }),
  }),
  cinematic: Object.freeze({ radiusMeters: 12, heightMeters: 3, heightDriftMeters: 1 }),
  topFront: Object.freeze({ centreForward: -0.26, centreUp: 0, topDistanceMeters: 13.45, frontDistanceMeters: 10.25 }),
  cockpitEye: Object.freeze({ forward: -0.36, up: 0.7, right: 0.37 }),
  engineReadout: Object.freeze({ label: "RPM", unit: "ENG", maximum: 4_500, roundTo: 50 }),
  // A four-cylinder four-stroke fires twice per crank turn: the fundamental
  // is rpm / 30, 25 Hz at the 750 rpm idle and 150 Hz at 4,500 rpm, which is
  // exactly 0 + (rpm / 4,500) x 150. A stand-in until the car's own sound
  // (diesel clatter, turbo whistle, gear whine) replaces it.
  engineSound: Object.freeze({
    baseHz: 0,
    spanHz: 150,
    gainBase: 0.12,
    gainSpan: 0.28,
    filterHz: 520,
    filterQ: 0.7,
    waveforms: Object.freeze(["sawtooth", "square"] as const) as readonly [OscillatorType, OscillatorType],
  }),
});

export const SURFACE_VEHICLE_SPECS: Readonly<Record<SurfaceVehicleKind, SurfaceVehicleSpec>> = Object.freeze({
  speedboat: SPEEDBOAT,
  landcruiser: LANDCRUISER,
});

export const SURFACE_VEHICLE_CATALOGUE: readonly SurfaceVehicleSpec[] = Object.freeze(
  SURFACE_VEHICLE_KINDS.map((kind) => SURFACE_VEHICLE_SPECS[kind]),
);

export function surfaceVehicleSpec(kind: SurfaceVehicleKind): SurfaceVehicleSpec {
  return SURFACE_VEHICLE_SPECS[kind];
}

const aircraftVehicleSpecs = new Map<VehicleKind, VehicleSpec>();

/** The shared part of any vehicle's spec. Aircraft specs are adapted once and cached. */
export function vehicleSpec(kind: VehicleKind): VehicleSpec {
  if (!isAircraftKind(kind)) return surfaceVehicleSpec(kind);
  let spec = aircraftVehicleSpecs.get(kind);
  if (!spec) {
    const aircraft = aircraftSpec(kind);
    spec = Object.freeze({
      kind,
      vehicleClass: "aircraft",
      name: aircraft.name,
      description: aircraft.description,
      follow: "aircraft",
      chase: aircraft.chase,
      cinematic: aircraft.cinematic,
      topFront: aircraft.topFront,
      cockpitEye: aircraft.cockpitEye,
      engineReadout: aircraft.engineReadout,
      engineSound: aircraft.engineSound,
    } satisfies VehicleSpec);
    aircraftVehicleSpecs.set(kind, spec);
  }
  return spec;
}
