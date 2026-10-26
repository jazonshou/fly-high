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
 * 2026-10-26). Framing numbers are first estimates from the hull's size; the
 * boat-presentation work measures them on the built model, as the aircraft's
 * are measured in tests/render.top-front-views.test.ts.
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
  topFront: Object.freeze({ centreForward: 0.6, centreUp: 0.4, topDistanceMeters: 16, frontDistanceMeters: 12 }),
  cockpitEye: Object.freeze({ forward: 0.7, up: 1.25, right: 0.55 }),
  engineReadout: Object.freeze({ label: "RPM", unit: "ENG", maximum: 6_000, roundTo: 50 }),
  // A V6 four-stroke fires three times per crank turn: the fundamental is
  // rpm / 20, 35 Hz at the 700 rpm idle and 300 Hz at the 6,000 rpm limiter.
  engineSound: Object.freeze({
    baseHz: 35,
    spanHz: 265,
    gainBase: 0.12,
    gainSpan: 0.3,
    filterHz: 900,
    filterQ: 0.6,
    waveforms: Object.freeze(["sawtooth", "square"] as const) as readonly [OscillatorType, OscillatorType],
  }),
});

export const SURFACE_VEHICLE_SPECS: Readonly<Record<SurfaceVehicleKind, SurfaceVehicleSpec>> = Object.freeze({
  speedboat: SPEEDBOAT,
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
