import { AIRCRAFT_KINDS, type AircraftKind } from "@/src/sim";

/**
 * Everything a session can drive. Aircraft keep their own kind list and every
 * aircraft code path keeps receiving `AircraftKind`; this is the wider type for
 * the few seams a surface vehicle also passes through (settings, the picker,
 * the sim worker, the renderer's vehicle slot, the HUD).
 *
 * `"landcruiser"` is the Toyota LandCruiser 76 wagon, the `"car"` class.
 */
export const SURFACE_VEHICLE_KINDS = ["speedboat", "landcruiser"] as const;
export type SurfaceVehicleKind = (typeof SURFACE_VEHICLE_KINDS)[number];
export type VehicleKind = AircraftKind | SurfaceVehicleKind;

/**
 * The class picks the simulator, the input profile, the camera follow law and
 * the HUD panel. A seam branches on the class, never on a kind, so a second
 * boat is a catalogue entry rather than a sweep through the code.
 */
export type VehicleClass = "aircraft" | "boat" | "car";

export const VEHICLE_KINDS: readonly VehicleKind[] = Object.freeze([
  ...AIRCRAFT_KINDS,
  ...SURFACE_VEHICLE_KINDS,
]);

export function isAircraftKind(kind: unknown): kind is AircraftKind {
  return (AIRCRAFT_KINDS as readonly unknown[]).includes(kind);
}

export function isSurfaceVehicleKind(kind: unknown): kind is SurfaceVehicleKind {
  return (SURFACE_VEHICLE_KINDS as readonly unknown[]).includes(kind);
}

export function isVehicleKind(kind: unknown): kind is VehicleKind {
  return isAircraftKind(kind) || isSurfaceVehicleKind(kind);
}

export function vehicleClass(kind: VehicleKind): VehicleClass {
  if (isAircraftKind(kind)) return "aircraft";
  switch (kind) {
    case "speedboat":
      return "boat";
    case "landcruiser":
      return "car";
  }
}
