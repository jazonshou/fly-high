import type { BoatVisualState, FlightMode, FlightVisualState } from "@/src/game/types";
import type { HudMode, UnitSystem } from "@/src/settings";
import { surfaceVehicleSpec } from "@/src/vehicles/catalogue";
import { formatHeading, MetricTape } from "@/src/ui/hudParts";

interface BoatHudProps {
  state: FlightVisualState;
  boat: BoatVisualState;
  mode: Exclude<HudMode, "off">;
  flightMode: FlightMode;
  units: UnitSystem;
  cameraLabel: string;
  seedLabel: string;
}

const GEAR_LABELS: Record<BoatVisualState["gear"], string> = {
  forward: "F",
  neutral: "N",
  reverse: "R",
};

/** Under the keel, the sounder warns. */
export const BOAT_SHALLOW_WARNING_METERS = 1.5;

/**
 * The boat's panel, in the aircraft HUD's visual language: speed through the
 * water on the left tape (knots in aviation units, km/h in metric), heading,
 * engine, gear, trim and depth, and the boat's own states. The shared base's
 * first cut; the boat-presentation work owns its content from here.
 */
export function BoatHud({ state, boat, mode, flightMode, units, cameraLabel, seedLabel }: BoatHudProps) {
  const spec = surfaceVehicleSpec("speedboat");
  const aviation = units === "aviation";
  const speed = aviation ? boat.speedThroughWater * 1.94384 : boat.speedThroughWater * 3.6;
  const speedUnit = aviation ? "KN" : "KM/H";
  const depth = aviation ? boat.depthUnderKeel * 3.28084 : boat.depthUnderKeel;
  const depthUnit = aviation ? "FT" : "M";
  const controlModeLabel =
    flightMode === "unassisted" ? "DIRECT CONTROLS" : flightMode === "pilot" ? "PILOT DAMPING" : "SCENIC ASSIST";
  const shallow = !boat.moored && boat.depthUnderKeel < BOAT_SHALLOW_WARNING_METERS;

  return (
    <div className={`flight-hud flight-hud--${mode} flight-hud--boat`} aria-live="off">
      <div className="flight-hud__topline">
        <div className="hud-session">
          <span>{controlModeLabel}</span>
          <span>{cameraLabel}</span>
          <span>WORLD {seedLabel}</span>
        </div>
      </div>

      {mode === "full" ? (
        <>
          <MetricTape label="SPD" value={Math.max(0, Math.round(speed)).toString()} unit={speedUnit} side="left" />
          <MetricTape label="DEPTH" value={Math.max(0, depth).toFixed(1)} unit={depthUnit} side="right" />
        </>
      ) : null}

      <div className="attitude" aria-label={`Heading ${formatHeading(state.heading)}`}>
        <div className="attitude__heading">
          <small>HDG</small>
          <strong>{formatHeading(state.heading)}</strong>
        </div>
      </div>

      {state.crashed ? <div className="flight-alert flight-alert--danger">BOAT DAMAGED · PRESS R</div> : null}
      {!state.crashed && boat.capsized ? <div className="flight-alert flight-alert--danger">CAPSIZED · PRESS R</div> : null}
      {!state.crashed && boat.moored ? <div className="flight-alert flight-alert--warning">MOORED · THROTTLE OR M TO CAST OFF</div> : null}
      {!state.crashed && shallow ? <div className="flight-alert flight-alert--warning">SHALLOW</div> : null}
      {!state.crashed && boat.ventilating ? <div className="flight-alert flight-alert--warning">VENTILATING</div> : null}

      <div className="flight-hud__bottom">
        {mode === "full" ? (
          <div className="instrument-strip">
            <div className="instrument-readout">
              <small>{spec.engineReadout.label}</small>
              <strong>{Math.round(state.engineRpm / spec.engineReadout.roundTo) * spec.engineReadout.roundTo}</strong>
              <em>{spec.engineReadout.unit}</em>
            </div>
            <div className="instrument-readout" aria-label={`Gear ${boat.gear}`}>
              <small>GEAR</small>
              <strong>{GEAR_LABELS[boat.gear]}</strong>
              <em>SHIFT · CTRL</em>
            </div>
            <div className="instrument-readout" aria-label={`Trim ${Math.round(boat.trim * 100)} percent`}>
              <small>TRIM</small>
              <strong>{Math.round(boat.trim * 100)}%</strong>
              <em>S OUT · W IN</em>
            </div>
            <div className="instrument-readout" aria-label={`Tabs ${Math.round(((boat.tabPort + boat.tabStarboard) / 2) * 100)} percent`}>
              <small>TABS</small>
              <strong>{Math.round(((boat.tabPort + boat.tabStarboard) / 2) * 100)}%</strong>
              <em>F DN · V UP</em>
            </div>
          </div>
        ) : null}
      </div>

      <div className="hud-help">
        <span>Shift ahead · Ctrl astern</span>
        <span>A port · D starboard</span>
        <span>S trim out · W trim in</span>
        <span>F tabs down · V up</span>
        <span>Space neutral · M moor</span>
        <span>C view</span>
        <span>Esc pause</span>
      </div>
    </div>
  );
}
