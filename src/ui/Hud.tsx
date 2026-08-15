import type { FlightMode, FlightVisualState, RenderDiagnostics } from "@/src/game/types";
import type { HudMode, UnitSystem } from "@/src/settings";

interface HudProps {
  state: FlightVisualState;
  mode: HudMode;
  flightMode: FlightMode;
  units: UnitSystem;
  diagnostics: RenderDiagnostics | null;
  showDiagnostics: boolean;
  cameraLabel: string;
  seedLabel: string;
  mouseFlight: boolean;
}

function formatHeading(heading: number): string {
  const normalized = ((heading % 360) + 360) % 360;
  return Math.round(normalized).toString().padStart(3, "0");
}

function MetricTape({
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

export function Hud({
  state,
  mode,
  flightMode,
  units,
  diagnostics,
  showDiagnostics,
  cameraLabel,
  seedLabel,
  mouseFlight,
}: HudProps) {
  if (mode === "off") return null;
  const aviation = units === "aviation";
  const speed = aviation ? state.airspeed * 1.94384 : state.airspeed * 3.6;
  const altitude = aviation ? state.altitudeAgl * 3.28084 : state.altitudeAgl;
  const verticalSpeed = aviation ? state.verticalSpeed * 196.85 : state.verticalSpeed;
  const speedUnit = aviation ? "KT" : "KM/H";
  const altitudeUnit = aviation ? "FT" : "M";
  const verticalUnit = aviation ? "FT/M" : "M/S";
  const pitchPixels = Math.max(-95, Math.min(95, state.pitch * 2.25));
  const controlModeLabel =
    flightMode === "unassisted"
      ? "DIRECT CONTROLS"
      : flightMode === "pilot"
        ? "PILOT DAMPING"
        : "SCENIC ASSIST";

  return (
    <div className={`flight-hud flight-hud--${mode}`} aria-live="off">
      <div className="flight-hud__topline">
        <div className="hud-brand">
          <span className="hud-brand__mark">A</span>
          <span>AEROLITH</span>
        </div>
        <div className="hud-session">
          <span>{controlModeLabel}</span>
          <span>{cameraLabel}</span>
          <span>WORLD {seedLabel}</span>
        </div>
      </div>

      {mode === "full" ? (
        <>
          <MetricTape label="IAS" value={Math.max(0, Math.round(speed)).toString()} unit={speedUnit} side="left" />
          <MetricTape
            label="AGL"
            value={Math.max(-999, Math.round(altitude)).toLocaleString()}
            unit={altitudeUnit}
            side="right"
          />
        </>
      ) : null}

      <div className="attitude" aria-label={`Pitch ${Math.round(state.pitch)} degrees, bank ${Math.round(state.bank)} degrees`}>
        <div
          className="attitude__horizon"
          style={{ transform: `translate(-50%, calc(-50% + ${pitchPixels}px)) rotate(${-state.bank}deg)` }}
        >
          <span className="attitude__line attitude__line--wide" />
          <span className="attitude__line attitude__line--up-one" />
          <span className="attitude__line attitude__line--up-two" />
          <span className="attitude__line attitude__line--down-one" />
          <span className="attitude__line attitude__line--down-two" />
        </div>
        <div className="attitude__aircraft">
          <span />
          <i />
          <span />
        </div>
        <div className="attitude__heading">
          <small>HDG</small>
          <strong>{formatHeading(state.heading)}</strong>
        </div>
      </div>

      {state.stalled && !state.onGround ? <div className="flight-alert flight-alert--danger">STALL · LOWER NOSE</div> : null}
      {(!state.stalled || state.onGround) && Math.abs(state.bank) > 70 ? (
        <div className="flight-alert flight-alert--warning">BANK ANGLE</div>
      ) : null}
      {state.crashed ? <div className="flight-alert flight-alert--danger">AIRCRAFT DAMAGED · PRESS R</div> : null}

      <div className="flight-hud__bottom">
        {mode === "full" ? (
          <div className="instrument-strip">
            <div className="instrument-readout">
              <small>V/S</small>
              <strong>{verticalSpeed >= 0 ? "+" : ""}{Math.round(verticalSpeed)}</strong>
              <em>{verticalUnit}</em>
            </div>
            <div className="instrument-readout">
              <small>RPM</small>
              <strong>{Math.round(state.engineRpm / 10) * 10}</strong>
              <em>PROP</em>
            </div>
            <div className="instrument-readout">
              <small>AOA</small>
              <strong>{state.angleOfAttack.toFixed(1)}°</strong>
              <em>{state.stalled && !state.onGround ? "STALL" : "NORMAL"}</em>
            </div>
            <div className="instrument-readout">
              <small>LOAD</small>
              <strong>{state.loadFactor.toFixed(1)}G</strong>
              <em>{state.onGround ? "GROUND" : "FLIGHT"}</em>
            </div>
          </div>
        ) : null}

        <div className="control-status">
          <div
            className="control-status__axes"
            aria-label={`Actual controls: elevator ${Math.round(state.elevator * 100)}, aileron ${Math.round(state.aileron * 100)}, rudder ${Math.round(state.rudder * 100)}`}
          >
            <span className="control-status__label">ACTUAL</span>
            <div className="control-status__yoke" aria-hidden="true">
              <i className="control-status__axis control-status__axis--horizontal" />
              <i className="control-status__axis control-status__axis--vertical" />
              <b
                style={{
                  left: `${50 + state.aileron * 40}%`,
                  top: `${50 - state.elevator * 40}%`,
                }}
              />
            </div>
            <div className="control-status__rudder" aria-hidden="true">
              <i />
              <b style={{ left: `${50 + state.rudder * 44}%` }} />
            </div>
          </div>
          <div className="control-status__meters">
            <div className="control-status__meter">
              <span>THR</span>
              <i><b style={{ width: `${state.throttle * 100}%` }} /></i>
              <strong>{Math.round(state.throttle * 100)}</strong>
            </div>
            <div className="control-status__meter">
              <span>TRIM</span>
              <i><b style={{ width: `${(state.trim * 0.5 + 0.5) * 100}%` }} /></i>
              <strong>{state.trim > 0 ? "+" : ""}{Math.round(state.trim * 100)}</strong>
            </div>
            <div className="control-status__meter">
              <span>FLAP</span>
              <i><b style={{ width: `${state.flaps * 100}%` }} /></i>
              <strong>{Math.round(state.flaps * 30)}°</strong>
            </div>
            <div className="control-status__meter">
              <span>BRK</span>
              <i><b style={{ width: `${state.brake * 100}%` }} /></i>
              <strong>{Math.round(state.brake * 100)}</strong>
            </div>
          </div>
        </div>
      </div>

      <div className="hud-help">
        <span>W nose down · S nose up</span>
        <span>A left · D right</span>
        <span>Q left rudder · E right</span>
        <span>+ power · − reduce</span>
        <span>C view</span>
        <span>Esc pause</span>
        {mouseFlight ? <span className="hud-help__active">Click view for mouse yoke</span> : null}
      </div>

      {showDiagnostics && diagnostics ? (
        <div className="diagnostics" aria-label="Performance diagnostics">
          <strong>{diagnostics.fps.toFixed(0)} FPS</strong>
          <span>{diagnostics.frameTime.toFixed(1)} ms</span>
          <span>{diagnostics.drawCalls} calls</span>
          <span>{Math.round(diagnostics.triangles / 1_000)}k tris</span>
          <span>{diagnostics.terrainTiles} tiles</span>
        </div>
      ) : null}
    </div>
  );
}
