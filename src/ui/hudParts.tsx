/**
 * HUD pieces the aircraft, boat and car panels share, in their own module so
 * the panels can all use them without importing each other.
 */

import type { NearestAirportInfo } from "@/src/game/AirportNetworkController";
import { formatAirportDistance } from "@/src/ui/airportMarker";

export function formatHeading(heading: number): string {
  const normalized = ((heading % 360) + 360) % 360;
  return Math.round(normalized).toString().padStart(3, "0");
}

export function MetricTape({
  label,
  value,
  unit,
  side,
}: {
  label: string;
  value: string;
  unit: string;
  side: "left" | "right";
}) {
  return (
    <div className={`metric-tape metric-tape--${side}`} aria-label={`${label}: ${value} ${unit}`}>
      <span className="metric-tape__label">{label}</span>
      <span className="metric-tape__value">{value}</span>
      <span className="metric-tape__unit">{unit}</span>
      <span className="metric-tape__tick metric-tape__tick--one" />
      <span className="metric-tape__tick metric-tape__tick--two" />
      <span className="metric-tape__tick metric-tape__tick--three" />
    </div>
  );
}

/**
 * The topline's nearest-airport button (N) and, while it is on, its readout:
 * identifier, runways, bearing and distance. The aircraft and the car show it.
 */
export function NearestAirportControl({
  nearestAirport,
  shown,
  onToggle,
  aviation,
}: {
  nearestAirport: NearestAirportInfo;
  shown: boolean;
  onToggle: () => void;
  aviation: boolean;
}) {
  return (
    <div className={`hud-nearest${shown ? " is-active" : ""}`}>
      <button
        type="button"
        className="hud-nearest__toggle"
        aria-pressed={shown}
        title="Show the nearest airport (N)"
        // Keep focus on the canvas: a focused button would also take the
        // Space bar, which is the brake.
        onPointerDown={(event) => event.preventDefault()}
        onClick={onToggle}
      >
        <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
          <path d="M 8 1 L 15 8 L 8 15 L 1 8 Z" />
          <path d="M 8 4.5 L 8 11.5" />
        </svg>
        <span>NEAREST AIRPORT</span>
        <kbd>N</kbd>
      </button>
      {shown ? (
        <div
          className="hud-nearest__readout"
          aria-label={`Nearest airport ${nearestAirport.ident}, runway ${nearestAirport.runways}, bearing ${nearestAirport.bearingDegrees} degrees, ${formatAirportDistance(nearestAirport.distanceMeters, aviation)}`}
        >
          <strong>{nearestAirport.ident}</strong>
          {nearestAirport.isHome ? <em>HOME</em> : null}
          <span>RWY {nearestAirport.runways}</span>
          <span>BRG {nearestAirport.bearingDegrees.toString().padStart(3, "0")}°</span>
          <span>{formatAirportDistance(nearestAirport.distanceMeters, aviation)}</span>
        </div>
      ) : null}
    </div>
  );
}
