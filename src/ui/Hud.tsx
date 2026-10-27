import type {
  AutolandVisualState,
  CameraMode,
  FlightMode,
  FlightVisualState,
  RenderDiagnostics,
} from "@/src/game/types";
import type { HudMode, UnitSystem } from "@/src/settings";
import { aircraftDefinition, type AircraftKind } from "@/src/sim";
import type { CSSProperties } from "react";
import { aircraftSpec } from "@/src/aircraft/catalogue";
import { cockpitDeckKStyleValue } from "@/src/ui/cockpitHudLayout";
import { formatAirportDistance } from "@/src/ui/airportMarker";
import type { NearestAirportInfo } from "@/src/game/AirportNetworkController";
import { BoatHud } from "@/src/ui/BoatHud";
import { formatHeading, MetricTape } from "@/src/ui/hudParts";

interface HudProps {
  state: FlightVisualState;
  aircraft: AircraftKind;
  mode: HudMode;
  flightMode: FlightMode;
  units: UnitSystem;
  diagnostics: RenderDiagnostics | null;
  showDiagnostics: boolean;
  cameraMode: CameraMode;
  cameraLabel: string;
  seedLabel: string;
  mouseFlight: boolean;
  /** Starts the 1A-1 GPU budget-probe sweep from the diagnostics overlay. */
  onRunBudgetProbe?: () => void;
  /** The airport nearest the aircraft, or null in a world without one. */
  nearestAirport?: NearestAirportInfo | null;
  /** Whether the nearest-airport marker and readout are switched on. */
  nearestAirportShown?: boolean;
  onToggleNearestAirport?: () => void;
  /** Engages or hands back the autoland; the button is drawn only when given. */
  onToggleAutoland?: () => void;
}

const AUTOLAND_PHASE_LABELS: Record<AutolandVisualState["phase"], string> = {
  approach: "APPROACH",
  final: "FINAL",
  flare: "FLARE",
  rollout: "ROLLOUT",
  landed: "LANDED",
  "go-around": "GO AROUND",
};

const GO_AROUND_LABELS: Record<NonNullable<AutolandVisualState["goAroundReason"]>, string> = {
  glideslope: "OFF GLIDESLOPE",
  centreline: "OFF CENTRELINE",
  "speed-high": "TOO FAST",
  "speed-low": "TOO SLOW",
  "sink-rate": "SINK RATE",
  unconfigured: "NOT CONFIGURED",
  bank: "BANK",
  "long-landing": "LANDING LONG",
  bounce: "BOUNCED",
  terrain: "TERRAIN",
};

/** The painted number of the runway end being landed on: `runwayDesignator`'s rule. */
function runwayNumber(headingDegrees: number): string {
  const number = Math.round(headingDegrees / 10) % 36;
  return String(number === 0 ? 36 : number).padStart(2, "0");
}

/**
 * The fixed aircraft symbol marks where the nose points on the attitude
 * horizon, which means something only when the camera looks roughly along the
 * nose. The orbit view circles the aeroplane, the top view looks down on it
 * and the front view looks back at it, so none of them shows it.
 */
export function hudShowsAircraftReticle(cameraMode: CameraMode): boolean {
  return cameraMode !== "cinematic" && cameraMode !== "top" && cameraMode !== "front";
}

function renderTechniqueLabel(diagnostics: RenderDiagnostics): string {
  return diagnostics.renderTechnique === "forward-spectral-volumetric"
    ? "WEBGPU FORWARD / SPECTRAL / VOLUMETRIC"
    : diagnostics.renderTechnique;
}

function requestedRenderingLabel(diagnostics: RenderDiagnostics): string {
  return diagnostics.requestedRenderingMode;
}

/** What became of the vegetation worker, when anything did; empty while it is healthy. */
function detailWorkerLabel(diagnostics: RenderDiagnostics): string {
  const worker = diagnostics.detailWorker;
  if (!worker) return "";
  return (!worker.active && worker.fallbacks > 0 ? " · VEG GEN ON MAIN THREAD" : "")
    + (worker.respawns > 0 ? ` · VEG WORKER RESTARTED x${worker.respawns}` : "");
}

export function Hud({
  state,
  aircraft,
  mode,
  flightMode,
  units,
  diagnostics,
  showDiagnostics,
  cameraMode,
  cameraLabel,
  seedLabel,
  mouseFlight,
  onRunBudgetProbe,
  nearestAirport = null,
  nearestAirportShown = false,
  onToggleNearestAirport,
  onToggleAutoland,
}: HudProps) {
  if (mode === "off") return null;
  // A surface vehicle has its own panel; the aircraft HUD below is exactly
  // the markup it always was for every aircraft session.
  if (state.vehicle?.kind === "boat") {
    return (
      <BoatHud
        state={state}
        boat={state.vehicle}
        mode={mode}
        flightMode={flightMode}
        units={units}
        cameraLabel={cameraLabel}
        seedLabel={seedLabel}
      />
    );
  }
  const spec = aircraftSpec(aircraft);
  // Read from the FLIGHT MODEL, not from a presentation copy of the number.
  // The bar marks where thrust actually changes, so a HUD that disagreed with
  // the engine would be worse than no marking at all.
  const reheatGate = aircraftDefinition(aircraft).afterburner?.engageThrottle ?? null;
  const inReheat = reheatGate !== null && state.throttle > reheatGate;
  const aviation = units === "aviation";
  const speed = aviation ? state.airspeed * 1.94384 : state.airspeed * 3.6;
  const altitude = aviation ? state.altitudeAgl * 3.28084 : state.altitudeAgl;
  const verticalSpeed = aviation ? state.verticalSpeed * 196.85 : state.verticalSpeed;
  const speedUnit = aviation ? "KT" : "KM/H";
  const altitudeUnit = aviation ? "FT" : "M";
  const verticalUnit = aviation ? "FT/M" : "M/S";
  const pitchPixels = Math.max(-95, Math.min(95, state.pitch * 2.25));
  const autoland = state.autoland ?? null;
  const autolandDistance = autoland && (autoland.phase === "approach" || autoland.phase === "final")
    ? formatAirportDistance(autoland.distanceToTouchdown, aviation)
    : null;
  const controlModeLabel =
    flightMode === "unassisted"
      ? "DIRECT CONTROLS"
      : flightMode === "pilot"
        ? "PILOT DAMPING"
        : "SCENIC ASSIST";
  const gearLabel = state.gear >= 0.98
    ? "DOWN"
    : state.gear <= 0.02
      ? "UP"
      : "TRANSIT";
  // The flap lever has three detents (`InputManager`: 0, 0.5, 1) and the panels
  // take seconds to run between them; this reads the PANELS, as the gear block
  // reads the legs, so "FULL" means the lift is there and not merely asked for.
  const flapLabel = state.flaps <= 0.02
    ? "UP"
    : state.flaps >= 0.98
      ? "FULL"
      : Math.abs(state.flaps - 0.5) <= 0.02
        ? "HALF"
        : "MOVING";

  // Cockpit view keeps the HUD above the deck line (src/ui/cockpitHudLayout.ts);
  // the class and `--deck-k` exist ONLY there, so every other camera's HUD is
  // exactly the markup it was.
  const cockpit = cameraMode === "cockpit";
  const cockpitStyle = cockpit
    ? ({ "--deck-k": cockpitDeckKStyleValue(spec.cockpitDeckLineDegrees) } as CSSProperties)
    : undefined;

  return (
    <div
      className={`flight-hud flight-hud--${mode}${cockpit ? " flight-hud--cockpit" : ""}`}
      style={cockpitStyle}
      aria-live="off"
    >
      <div className="flight-hud__topline">
        <div className="hud-session">
          <span>{controlModeLabel}</span>
          <span>{cameraLabel}</span>
          <span>WORLD {seedLabel}</span>
        </div>
        {onToggleNearestAirport && nearestAirport ? (
          <div className={`hud-nearest${nearestAirportShown ? " is-active" : ""}`}>
            <button
              type="button"
              className="hud-nearest__toggle"
              aria-pressed={nearestAirportShown}
              title="Show the nearest airport (N)"
              // Keep focus on the canvas: a focused button would also take the
              // Space bar, which is the brake.
              onPointerDown={(event) => event.preventDefault()}
              onClick={onToggleNearestAirport}
            >
              <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
                <path d="M 8 1 L 15 8 L 8 15 L 1 8 Z" />
                <path d="M 8 4.5 L 8 11.5" />
              </svg>
              <span>NEAREST AIRPORT</span>
              <kbd>N</kbd>
            </button>
            {nearestAirportShown ? (
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
        ) : null}
        {onToggleAutoland ? (
          <button
            type="button"
            className={`hud-autoland__toggle${autoland ? " is-active" : ""}`}
            aria-pressed={autoland !== null}
            title="Land at the nearest airport (L)"
            disabled={!autoland && (state.onGround || state.crashed)}
            onPointerDown={(event) => event.preventDefault()}
            onClick={onToggleAutoland}
          >
            <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
              <path d="M 6 15 L 7 1 L 9 1 L 10 15 Z" />
              <path d="M 8 4 L 8 6 M 8 9 L 8 11" />
            </svg>
            <span>AUTOLAND</span>
            <kbd>L</kbd>
          </button>
        ) : null}
      </div>

      {autoland ? (
        <div
          className={`hud-autoland${autoland.phase === "go-around" ? " is-go-around" : ""}`}
          role="status"
          aria-label={`Autoland ${AUTOLAND_PHASE_LABELS[autoland.phase].toLowerCase()}, runway ${runwayNumber(autoland.runwayHeading)}${autolandDistance ? `, ${autolandDistance} to touchdown` : ""}, approach ${autoland.attempt}`}
        >
          <strong>AUTOLAND</strong>
          <span className="hud-autoland__phase">{AUTOLAND_PHASE_LABELS[autoland.phase]}</span>
          <span>RWY {runwayNumber(autoland.runwayHeading)}</span>
          {autolandDistance ? <span>{autolandDistance}</span> : null}
          {autoland.attempt > 1 ? <span>APP {autoland.attempt}</span> : null}
          {autoland.goAroundReason && (autoland.phase === "go-around" || autoland.phase === "approach")
            ? <em>{GO_AROUND_LABELS[autoland.goAroundReason]}</em>
            : null}
        </div>
      ) : null}

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
        {hudShowsAircraftReticle(cameraMode) ? (
          <div className="attitude__aircraft">
            <span />
            <i />
            <span />
          </div>
        ) : null}
        <div className="attitude__heading">
          <small>HDG</small>
          <strong>{formatHeading(state.heading)}</strong>
        </div>
      </div>

      {!state.crashed && state.stalled && !state.onGround ? <div className="flight-alert flight-alert--danger">STALL · LOWER NOSE</div> : null}
      {!state.crashed && (!state.stalled || state.onGround) && Math.abs(state.bank) > 70 ? (
        <div className="flight-alert flight-alert--warning">BANK ANGLE</div>
      ) : null}
      {state.crashed ? <div className="flight-alert flight-alert--danger">AIRCRAFT DAMAGED · PRESS R</div> : null}
      {!state.crashed && state.brake > 0.08 ? (
        <div className="flight-alert flight-alert--warning flight-alert--brake">
          {spec.speedBrake
            ? state.onGround ? "SPEED + WHEEL BRAKE" : "SPEED BRAKE"
            : state.onGround ? "WHEEL BRAKE" : "BRAKE ARMED"}
        </div>
      ) : null}

      <div className="flight-hud__bottom">
        {mode === "full" ? (
          <div className="instrument-strip">
            <div className="instrument-readout">
              <small>V/S</small>
              <strong>{verticalSpeed >= 0 ? "+" : ""}{Math.round(verticalSpeed)}</strong>
              <em>{verticalUnit}</em>
            </div>
            <div className="instrument-readout">
              <small>{spec.engineReadout.label}</small>
              <strong>
                {Math.round(state.engineRpm / spec.engineReadout.roundTo)
                  * spec.engineReadout.roundTo}
              </strong>
              <em>{spec.engineReadout.unit}</em>
              {inReheat ? <b className="engine-reheat">REHEAT</b> : null}
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
            {spec.retractableGear ? (
              <div className="instrument-readout" aria-label={`Landing gear ${gearLabel.toLowerCase()}`}>
                <small>GEAR</small>
                <strong>{gearLabel}</strong>
                <em>{gearLabel === "TRANSIT" ? `${Math.round(state.gear * 100)}%` : "G TOGGLE"}</em>
              </div>
            ) : null}
            <div className="instrument-readout" aria-label={`Flaps ${flapLabel.toLowerCase()}`}>
              <small>FLAPS</small>
              <strong>{flapLabel}</strong>
              <em>{flapLabel === "MOVING" ? `${Math.round(state.flaps * 100)}%` : "F DN · V UP"}</em>
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
              <i>
                {/*
                  * The reheat zone, drawn only for an airframe that has one.
                  * It sits under the fill so the bar still reads as one bar,
                  * and it starts exactly at the gate the engine uses.
                  */}
                {reheatGate === null ? null : (
                  <u
                    className="control-status__reheat"
                    style={{ left: `${reheatGate * 100}%` }}
                    aria-hidden="true"
                  />
                )}
                <b
                  className={inReheat ? "is-reheat" : undefined}
                  style={{ width: `${state.throttle * 100}%` }}
                />
              </i>
              <strong>{Math.round(state.throttle * 100)}</strong>
            </div>
            <div className="control-status__meter">
              <span>TRIM</span>
              <i><b style={{ width: `${(state.trim * 0.5 + 0.5) * 100}%` }} /></i>
              <strong>{state.trim > 0 ? "+" : ""}{Math.round(state.trim * 100)}</strong>
            </div>
          </div>
        </div>
      </div>

      <div className="hud-help">
        <span>W nose down · S nose up</span>
        <span>A left · D right</span>
        <span>Q left rudder · E right</span>
        <span>Shift power · Ctrl reduce</span>
        {spec.retractableGear
          ? <span>G gear · Space speed / wheel brake</span>
          : <span>Space wheel brake</span>}
        <span>F flaps down · V up</span>
        <span>C view</span>
        {onToggleNearestAirport && nearestAirport ? <span>N nearest airport</span> : null}
        {onToggleAutoland ? <span>L autoland</span> : null}
        <span>Esc pause</span>
        {mouseFlight ? <span className="hud-help__active">Click view for mouse yoke</span> : null}
      </div>

      {showDiagnostics && diagnostics ? (
        <div className="diagnostics" aria-label="Performance diagnostics">
          <strong>{diagnostics.fps.toFixed(0)} FPS</strong>
          <span>{diagnostics.frameTime.toFixed(1)} ms frame</span>
          <span>{diagnostics.cpuFrameTime.toFixed(1)} ms CPU</span>
          <span>{diagnostics.presentWaitTime === null ? "present wait n/a" : `${diagnostics.presentWaitTime.toFixed(1)} ms present wait`}</span>
          <span>{diagnostics.drawCalls} calls</span>
          <span>{Math.round(diagnostics.triangles / 1_000)}k tris</span>
          <span>{diagnostics.residentTerrainPages} pages · {diagnostics.terrainTiles} nodes</span>
          <span>{diagnostics.collisionSamplesServedByFallback} collision fallback</span>
          <span>{diagnostics.renderScale.toFixed(2)}x scale</span>
          <span>{diagnostics.gpuFrameTime === null ? "GPU timing n/a" : `${diagnostics.gpuFrameTime.toFixed(1)} ms GPU`}</span>
          <span>{(diagnostics.renderPixels / 1_000_000).toFixed(2)} Mpx</span>
          <span>{diagnostics.pendingTerrainPages} pending · {diagnostics.terrainComputeDispatches} dispatches</span>
          <span>{diagnostics.gpuP95Ms === null ? "GPU p95 n/a" : `${diagnostics.gpuP95Ms.toFixed(1)} ms GPU p95`}</span>
          <span>{diagnostics.cpuP95Ms === null ? "CPU p95 n/a" : `${diagnostics.cpuP95Ms.toFixed(1)} ms CPU p95`}</span>
          <span className="diagnostics__wide">
            {diagnostics.frameIntervalP95Ms === null
              ? "interval p95 n/a"
              : `${diagnostics.frameIntervalP95Ms.toFixed(1)} ms interval p95`}
            {" · "}
            {diagnostics.presentWaitP95Ms === null
              ? "present wait p95 n/a"
              : `${diagnostics.presentWaitP95Ms.toFixed(1)} ms present wait p95`}
          </span>
          <span className="diagnostics__wide">
            {diagnostics.maxFrameMs === null ? "max n/a" : `${diagnostics.maxFrameMs.toFixed(0)} ms max`}
            {" · "}
            {diagnostics.p999FrameMs === null ? "p999 n/a" : `${diagnostics.p999FrameMs.toFixed(0)} ms p999`}
            {" · "}{diagnostics.hitchCount} hitches
          </span>
          <span className="diagnostics__wide">
            GOV {diagnostics.activeGovernor.toUpperCase()}
            {diagnostics.resolutionInsensitive ? " · RES-INSENSITIVE" : ""}
            {" · "}cpu L{diagnostics.cpuWorkLevel} · gpu L{diagnostics.gpuWorkLevel}
            {diagnostics.cpuWorkLever ? ` (${diagnostics.cpuWorkLever})` : ""}
            {" · ~"}{Math.round(diagnostics.estimatedGpuMemoryMiB)} MiB est
          </span>
          {diagnostics.topPassesByCpuMs.length > 0 ? (
            <span className="diagnostics__wide">
              {diagnostics.topPassesByCpuMs
                .map((pass) => `${pass.name} ${pass.p95Ms.toFixed(1)}`)
                .join(" · ")} ms CPU p95
            </span>
          ) : null}
          <span className="diagnostics__wide">
            {diagnostics.renderBackend.toUpperCase()} · {renderTechniqueLabel(diagnostics)}
          </span>
          <span className="diagnostics__wide">
            {requestedRenderingLabel(diagnostics).toUpperCase()} · {diagnostics.oceanFftCascades}×{diagnostics.oceanFftResolution}² FFT · {diagnostics.cloudRaySteps} cloud steps
          </span>
          <span className="diagnostics__wide">
            {diagnostics.visibleInstances.toLocaleString()} detail instances · {diagnostics.activeAnimals} animals · {diagnostics.riverCount} rivers / {diagnostics.lakeCount} lakes
            {diagnostics.hydrologyMainThreadFallback ? " · WATER GEN ON MAIN THREAD" : ""}
            {detailWorkerLabel(diagnostics)}
          </span>
          <span className="diagnostics__wide">
            {diagnostics.adapter}
          </span>
          {diagnostics.renderingFallbackReason ? (
            <span className="diagnostics__wide diagnostics__fallback">
              {diagnostics.renderingFallbackReason}
            </span>
          ) : null}
          {onRunBudgetProbe ? (
            <button
              type="button"
              className="diagnostics__probe"
              onClick={onRunBudgetProbe}
              disabled={diagnostics.budgetProbeActive}
            >
              {diagnostics.budgetProbeActive ? "PROBING GPU BUDGET…" : "RUN GPU BUDGET PROBE"}
            </button>
          ) : null}
          {diagnostics.budgetProbeReport ? (
            <span className="diagnostics__wide">
              {diagnostics.budgetProbeReport
                .map((row) => `${row.pass} ${
                  row.gpuP95DeltaMs === null ? "n/a" : row.gpuP95DeltaMs.toFixed(1)
                }`)
                .join(" · ")} ms GPU
            </span>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
