import type { CarVisualState, FlightMode, FlightVisualState } from "@/src/game/types";
import type { HudMode, UnitSystem } from "@/src/settings";
import { surfaceVehicleSpec } from "@/src/vehicles/catalogue";
import { formatHeading, MetricTape } from "@/src/ui/hudParts";

interface CarHudProps {
  state: FlightVisualState;
  car: CarVisualState;
  mode: Exclude<HudMode, "off">;
  flightMode: FlightMode;
  units: UnitSystem;
  cameraLabel: string;
  seedLabel: string;
}

/** What the gear readout shows: the automatic's selector (its gear in M), or the manual's gear. */
export function carGearLabel(car: CarVisualState): string {
  if (car.selector !== null && car.selector !== "M") return car.selector;
  if (car.gear < 0) return "R";
  if (car.gear === 0) return "N";
  return car.selector === "M" ? `M${car.gear}` : String(car.gear);
}

/**
 * The car's panel, in the aircraft HUD's visual language: road speed on the
 * left tape (mph with aviation units, km/h in metric), elevation on the
 * right, heading, engine, gear and range, and the car's own warnings. A
 * SHELL for the land build to finish (the plan's HUD: diff lock and downhill
 * lamps, the inclinometer, the wading bar).
 */
export function CarHud({ state, car, mode, flightMode, units, cameraLabel, seedLabel }: CarHudProps) {
  const spec = surfaceVehicleSpec("landcruiser");
  const imperial = units === "aviation";
  const speed = Math.abs(car.speed) * (imperial ? 2.23694 : 3.6);
  const speedUnit = imperial ? "MPH" : "KM/H";
  const elevation = state.altitude * (imperial ? 3.28084 : 1);
  const elevationUnit = imperial ? "FT" : "M";
  const controlModeLabel =
    flightMode === "unassisted" ? "DIRECT CONTROLS" : flightMode === "pilot" ? "PILOT DAMPING" : "SCENIC ASSIST";
  const upright = !state.crashed && !car.rolled;

  return (
    <div className={`flight-hud flight-hud--${mode} flight-hud--car`} aria-live="off">
      <div className="flight-hud__topline">
        <div className="hud-session">
          <span>{controlModeLabel}</span>
          <span>{cameraLabel}</span>
          <span>WORLD {seedLabel}</span>
        </div>
      </div>

      {mode === "full" ? (
        <>
          <MetricTape label="SPD" value={Math.round(speed).toString()} unit={speedUnit} side="left" />
          <MetricTape label="ELEV" value={Math.round(elevation).toString()} unit={elevationUnit} side="right" />
        </>
      ) : null}

      <div className="attitude" aria-label={`Heading ${formatHeading(state.heading)}`}>
        <div className="attitude__heading">
          <small>HDG</small>
          <strong>{formatHeading(state.heading)}</strong>
        </div>
      </div>

      {state.crashed ? <div className="flight-alert flight-alert--danger">CAR DAMAGED · PRESS R</div> : null}
      {!state.crashed && car.rolled ? <div className="flight-alert flight-alert--danger">ROLLED · PRESS R</div> : null}
      {upright && car.flooded ? <div className="flight-alert flight-alert--danger">FLOODED · PRESS R</div> : null}
      {upright && !car.flooded && car.stalled ? <div className="flight-alert flight-alert--warning">STALLED</div> : null}

      <div className="flight-hud__bottom">
        {mode === "full" ? (
          <div className="instrument-strip">
            <div className="instrument-readout">
              <small>{spec.engineReadout.label}</small>
              <strong>{Math.round(state.engineRpm / spec.engineReadout.roundTo) * spec.engineReadout.roundTo}</strong>
              <em>{spec.engineReadout.unit}</em>
            </div>
            <div className="instrument-readout" aria-label={`Gear ${carGearLabel(car)}`}>
              <small>GEAR</small>
              <strong>{carGearLabel(car)}</strong>
              <em>SHIFT · CTRL</em>
            </div>
            <div className="instrument-readout" aria-label={`Range ${car.range}`}>
              <small>RANGE</small>
              <strong>{car.range}</strong>
              <em>T</em>
            </div>
          </div>
        ) : null}
      </div>

      <div className="hud-help">
        <span>W accelerate · S brake</span>
        <span>A left · D right</span>
        <span>Space handbrake</span>
        <span>T range · K locks</span>
        <span>L lights · C view</span>
        <span>Esc pause</span>
      </div>
    </div>
  );
}
