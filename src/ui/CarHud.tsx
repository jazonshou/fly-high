import type { NearestAirportInfo } from "@/src/game/AirportNetworkController";
import type { CameraMode, CarVisualState, FlightMode, FlightVisualState } from "@/src/game/types";
import type { HudMode, UnitSystem } from "@/src/settings";
import { surfaceVehicleSpec } from "@/src/vehicles/catalogue";
import { LANDCRUISER_76 } from "@/src/vehicles/landcruiser76";
import { formatHeading, MetricTape, NearestAirportControl } from "@/src/ui/hudParts";
import { WalkingPrompt } from "@/src/ui/PersonHud";

interface CarHudProps {
  state: FlightVisualState;
  car: CarVisualState;
  mode: Exclude<HudMode, "off">;
  flightMode: FlightMode;
  units: UnitSystem;
  cameraMode: CameraMode;
  cameraLabel: string;
  seedLabel: string;
  /** The airport nearest the car, or null in a world without one. */
  nearestAirport?: NearestAirportInfo | null;
  nearestAirportShown?: boolean;
  onToggleNearestAirport?: (() => void) | undefined;
}

/** What the gear readout shows: the automatic's selector (its gear in M), or the manual's gear. */
export function carGearLabel(car: CarVisualState): string {
  if (car.selector !== null && car.selector !== "M") return car.selector;
  if (car.gear < 0) return "R";
  if (car.gear === 0) return "N";
  return car.selector === "M" ? `M${car.gear}` : String(car.gear);
}

/** The tachometer's red band starts where the fuel cut does (L1's engine record). */
export const CAR_TACHOMETER_REDLINE_RPM = LANDCRUISER_76.engine.limiterRpm;

/**
 * The inclinometer's warning and danger angles, degrees. The 76 tips at
 * about 40 degrees on a tilt table (the plan's tests), so the lamp turns amber
 * well before and red within a few degrees of it.
 */
export const CAR_TILT_WARNING_DEGREES = 30;
export const CAR_TILT_DANGER_DEGREES = 36;

/** The wading bar shows from this depth, metres: a puddle is not a ford. */
export const CAR_WADING_SHOWN_METERS = 0.05;

export type CarHudLevel = "normal" | "warning" | "danger";

/** How alarming a tilt is, from the larger of its pitch and roll. */
export function carTiltLevel(pitchDegrees: number, rollDegrees: number): CarHudLevel {
  const worst = Math.max(Math.abs(pitchDegrees), Math.abs(rollDegrees));
  return worst >= CAR_TILT_DANGER_DEGREES ? "danger" : worst >= CAR_TILT_WARNING_DEGREES ? "warning" : "normal";
}

/**
 * How full the wading bar is (0 dry .. 1 at the intake), and how alarming:
 * amber from 70% of the 700 mm rating, red from 90%, where the next wave
 * reaches the snorkel's foot.
 */
export function carWading(depthMeters: number): { fraction: number; level: CarHudLevel } {
  const fraction = Math.min(1, Math.max(0, depthMeters / LANDCRUISER_76.water.wadingDepth));
  return { fraction, level: fraction >= 0.9 ? "danger" : fraction >= 0.7 ? "warning" : "normal" };
}

/** The wading depth as the bar labels it: centimetres in metric, inches with aviation units. */
export function formatWadingDepth(depthMeters: number, imperial: boolean): string {
  const depth = Math.max(0, depthMeters);
  return imperial ? `${Math.round(depth * 39.3701)} IN` : `${Math.round(depth * 100)} CM`;
}

/** The diff locks' lamp text, in Toyota's order: the rear engages first. */
const LOCK_LABELS: Record<CarVisualState["locks"], string> = {
  off: "OPEN",
  rear: "REAR",
  both: "F + R",
};

/**
 * The car's panel, in the aircraft HUD's visual language: road speed on the
 * left tape (mph with aviation units, km/h in metric), elevation on the
 * right, heading, the inclinometer, and a strip with the tachometer, gear,
 * range, the dash's lamps (diff locks, downhill assist, traction control,
 * ABS, main beam), tyre pressure and, in water, the wading bar. FLOODED,
 * ROLLED and STALLED are alerts; R puts the car back on its newest safe
 * spot (`GroundVehicleSimulator.recover`), so the alerts that need it say
 * where it goes. While the car waits at its start for the ground under it
 * to stream in (`settling`), a quiet WAITING FOR TERRAIN line says why the
 * controls do nothing yet. The nearest-airport readout is the aircraft's,
 * for finding the way back.
 *
 * In the cockpit the strip moves up under the session line, off the dash and
 * its own dials.
 */
export function CarHud({
  state,
  car,
  mode,
  flightMode,
  units,
  cameraMode,
  cameraLabel,
  seedLabel,
  nearestAirport = null,
  nearestAirportShown = false,
  onToggleNearestAirport,
}: CarHudProps) {
  const spec = surfaceVehicleSpec("landcruiser");
  const imperial = units === "aviation";
  const speed = Math.abs(car.speed) * (imperial ? 2.23694 : 3.6);
  const speedUnit = imperial ? "MPH" : "KM/H";
  const elevation = state.altitude * (imperial ? 3.28084 : 1);
  const elevationUnit = imperial ? "FT" : "M";
  const controlModeLabel =
    flightMode === "unassisted" ? "DIRECT CONTROLS" : flightMode === "pilot" ? "PILOT DAMPING" : "SCENIC ASSIST";
  const upright = !state.crashed && !car.rolled;
  const rpm = Math.round(state.engineRpm / spec.engineReadout.roundTo) * spec.engineReadout.roundTo;
  const wading = carWading(car.wadingDepth);
  const wadingShown = car.wadingDepth >= CAR_WADING_SHOWN_METERS;
  const tilt = carTiltLevel(state.pitch, state.bank);
  const cockpit = cameraMode === "cockpit";

  return (
    <div
      className={`flight-hud flight-hud--${mode} flight-hud--car${cockpit ? " flight-hud--car-cockpit" : ""}`}
      aria-live="off"
    >
      <div className="flight-hud__topline">
        <div className="hud-session">
          <span>{controlModeLabel}</span>
          <span>{cameraLabel}</span>
          <span>WORLD {seedLabel}</span>
        </div>
        {onToggleNearestAirport && nearestAirport ? (
          <NearestAirportControl
            nearestAirport={nearestAirport}
            shown={nearestAirportShown}
            onToggle={onToggleNearestAirport}
            aviation={imperial}
          />
        ) : null}
      </div>

      {mode === "full" ? (
        <>
          <MetricTape label="SPD" value={Math.round(speed).toString()} unit={speedUnit} side="left" />
          <MetricTape label="ELEV" value={Math.round(elevation).toString()} unit={elevationUnit} side="right" />
        </>
      ) : null}

      {upright && !car.settling ? <WalkingPrompt prompt={state.walking?.prompt} /> : null}
      {state.crashed ? <div className="flight-alert flight-alert--danger">CAR DAMAGED · PRESS R: BACK TO SAFE GROUND</div> : null}
      {!state.crashed && car.rolled ? <div className="flight-alert flight-alert--danger">ROLLED · PRESS R: BACK TO SAFE GROUND</div> : null}
      {upright && car.settling ? (
        <div className="flight-alert flight-alert--quiet" role="status">WAITING FOR TERRAIN</div>
      ) : null}
      {upright && !car.settling && car.flooded ? <div className="flight-alert flight-alert--danger">FLOODED · PRESS R: BACK TO SAFE GROUND</div> : null}
      {upright && !car.settling && !car.flooded && car.stalled ? <div className="flight-alert flight-alert--warning">STALLED</div> : null}
      {upright && !car.settling && !car.flooded && !car.stalled && wading.level === "danger" ? (
        <div className="flight-alert flight-alert--warning">DEEP WATER</div>
      ) : null}

      <div className="flight-hud__bottom">
        <CarInclinometer heading={state.heading} pitch={state.pitch} roll={state.bank} level={tilt} tilt={mode === "full"} />
        {mode === "full" ? (
          <div className="instrument-strip car-strip">
            <div className="instrument-readout car-tachometer" aria-label={`Engine ${rpm} rpm`}>
              <small>{spec.engineReadout.label}</small>
              <strong>{rpm}</strong>
              <span className="car-tachometer__bar" aria-hidden="true">
                <i style={{ transform: `scaleX(${Math.min(1, Math.max(0, state.engineRpm / spec.engineReadout.maximum))})` }} />
                <b style={{ left: `${(CAR_TACHOMETER_REDLINE_RPM / spec.engineReadout.maximum) * 100}%` }} />
              </span>
            </div>
            <div className="instrument-readout" aria-label={`Gear ${carGearLabel(car)}`}>
              <small>GEAR</small>
              <strong>{carGearLabel(car)}</strong>
              <em>{car.gearbox === "automatic" ? "AUTO" : "MANUAL"}</em>
            </div>
            <div className="instrument-readout" aria-label={`Range ${car.range}`}>
              <small>RANGE</small>
              <strong>{car.range}</strong>
              <em>T</em>
            </div>
            <div className="instrument-readout car-lamps" aria-label={carLampsLabel(car)}>
              <small>DIFF {LOCK_LABELS[car.locks]}</small>
              <span className="car-lamps__row">
                <CarLamp lit={car.locks === "both"} label="F" title="Front diff lock" />
                <CarLamp lit={car.locks !== "off"} label="R" title="Rear diff lock" />
                <CarLamp lit={car.downhillAssist} active={car.downhillAssistActive} label="DAC" title="Downhill assist" />
                <CarLamp lit={car.tractionControlActive} active={car.tractionControlActive} label="TRC" title="Traction control" tone="warning" />
                <CarLamp lit={car.absActive} active={car.absActive} label="ABS" title="ABS" tone="warning" />
                <CarLamp lit={car.headlights === "main"} label="HI" title="Main beam" tone="beam" />
              </span>
            </div>
            <div className="instrument-readout" aria-label={`Tyres ${car.tyrePressureBar.toFixed(1)} bar, ${car.tyrePressure} preset`}>
              <small>TYRES</small>
              <strong>{car.tyrePressureBar.toFixed(1)}</strong>
              <em>BAR · {car.tyrePressure === "sand" ? "SAND" : "ROAD"}</em>
            </div>
            {wadingShown ? (
              <div
                className={`instrument-readout car-wading car-wading--${wading.level}`}
                aria-label={`Wading ${formatWadingDepth(car.wadingDepth, imperial)}, ${Math.round(wading.fraction * 100)} percent of the intake height`}
              >
                <small>WADE</small>
                <strong>{formatWadingDepth(car.wadingDepth, imperial)}</strong>
                <span className="car-wading__bar" aria-hidden="true">
                  <i style={{ transform: `scaleX(${wading.fraction})` }} />
                </span>
              </div>
            ) : null}
          </div>
        ) : null}
      </div>

      <div className="hud-help">
        <span>W accelerate · S brake</span>
        <span>A left · D right</span>
        <span>Space handbrake</span>
        <span>Shift · Ctrl gears</span>
        <span>T range · K locks · B descent</span>
        <span>L lights · C view</span>
        {onToggleNearestAirport && nearestAirport ? <span>N nearest airport</span> : null}
        <span>Esc pause</span>
      </div>
    </div>
  );
}

function carLampsLabel(car: CarVisualState): string {
  const lit = [
    car.locks === "off" ? null : car.locks === "rear" ? "rear diff locked" : "both diffs locked",
    car.downhillAssist ? (car.downhillAssistActive ? "downhill assist holding" : "downhill assist armed") : null,
    car.tractionControlActive ? "traction control working" : null,
    car.absActive ? "ABS working" : null,
    car.headlights === "main" ? "main beam" : null,
  ].filter(Boolean);
  return lit.length > 0 ? `Lamps: ${lit.join(", ")}` : "Lamps: none lit";
}

function CarLamp({
  lit,
  active = false,
  label,
  title,
  tone = "accent",
}: {
  lit: boolean;
  /** Working right now, not merely armed: the lamp flashes. */
  active?: boolean;
  label: string;
  title: string;
  tone?: "accent" | "warning" | "beam";
}) {
  const classes = ["car-lamp", `car-lamp--${tone}`, lit ? "is-lit" : "", active ? "is-active" : ""].filter(Boolean).join(" ");
  return <i className={classes} title={title}>{label}</i>;
}

const COMPASS_POINTS = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"] as const;

/** The heading's nearest of the eight compass points. */
export function compassPoint(heading: number): (typeof COMPASS_POINTS)[number] {
  const normalized = ((heading % 360) + 360) % 360;
  return COMPASS_POINTS[Math.round(normalized / 45) % 8]!;
}

/**
 * The 4x4's attitude cluster, bottom left: a compass card turning under a
 * fixed lubber line with the heading beside it, then (in the full HUD) the
 * inclinometer: the car from the side, nose right and tilted by the pitch,
 * and from behind, tilted by the roll (right side down turns it clockwise,
 * as the driver feels it), each against a level line, with the angles
 * beside them.
 */
export function CarInclinometer({
  heading,
  pitch,
  roll,
  level,
  tilt,
}: {
  heading: number;
  pitch: number;
  roll: number;
  level: CarHudLevel;
  /** Show the pitch and roll; the minimal HUD keeps the compass alone. */
  tilt: boolean;
}) {
  const pitchShown = Math.max(-60, Math.min(60, pitch));
  const rollShown = Math.max(-60, Math.min(60, roll));
  const headingLabel = formatHeading(heading);
  return (
    <div className={`car-inclinometer car-inclinometer--${level}`}>
      <figure aria-label={`Heading ${headingLabel}`}>
        <svg viewBox="-20 -20 40 40" aria-hidden="true" focusable="false">
          <circle className="car-inclinometer__level" r="15" />
          <g transform={`rotate(${-Math.round(heading)})`}>
            <path className="car-inclinometer__ticks" d="M 0 -15 L 0 -10 M 15 0 L 11 0 M 0 15 L 0 11 M -15 0 L -11 0" />
            <text className="car-inclinometer__north" x="0" y="-4.5" textAnchor="middle">N</text>
          </g>
          <path className="car-inclinometer__lubber" d="M 0 -15.5 L -2.6 -19.5 L 2.6 -19.5 Z" />
        </svg>
        <figcaption>
          <small>HDG</small>
          <strong>{headingLabel}</strong>
          <em>{compassPoint(heading)}</em>
        </figcaption>
      </figure>
      {tilt ? (
        <>
          <figure className="car-inclinometer__tilt" aria-label={`Pitch ${Math.round(Math.abs(pitch))} degrees ${pitch >= 0 ? "nose up" : "nose down"}`}>
            <svg viewBox="-30 -20 60 40" aria-hidden="true" focusable="false">
              <path className="car-inclinometer__level" d="M -28 0 L 28 0" />
              <path className="car-inclinometer__ticks" d="M -24 -13.9 L -21.7 -12.5 M 24 -13.9 L 21.7 -12.5 M -24 13.9 L -21.7 12.5 M 24 13.9 L 21.7 12.5" />
              <g transform={`rotate(${-pitchShown})`}>
                <path className="car-inclinometer__body" d="M -19 4 L -19 -3 L -16 -4 L -16 -11 L 6 -11 L 8 -4 L 19 -3 L 20 4 Z" />
                <circle className="car-inclinometer__wheel" cx="-11" cy="5" r="4" />
                <circle className="car-inclinometer__wheel" cx="12" cy="5" r="4" />
              </g>
            </svg>
            <figcaption>
              <small>PITCH</small>
              <strong>{Math.round(Math.abs(pitch))}°</strong>
              <em>{Math.round(pitch) === 0 ? "LEVEL" : pitch > 0 ? "UP" : "DOWN"}</em>
            </figcaption>
          </figure>
          <figure className="car-inclinometer__tilt" aria-label={`Roll ${Math.round(Math.abs(roll))} degrees ${roll >= 0 ? "right side down" : "left side down"}`}>
            <svg viewBox="-30 -20 60 40" aria-hidden="true" focusable="false">
              <path className="car-inclinometer__level" d="M -28 0 L 28 0" />
              <path className="car-inclinometer__ticks" d="M -24 -13.9 L -21.7 -12.5 M 24 -13.9 L 21.7 -12.5 M -24 13.9 L -21.7 12.5 M 24 13.9 L 21.7 12.5" />
              <g transform={`rotate(${rollShown})`}>
                <path className="car-inclinometer__body" d="M -11 3 L -11 -4 L -8 -13 L 8 -13 L 11 -4 L 11 3 Z" />
                <rect className="car-inclinometer__wheel" x="-13" y="1" width="5" height="8" rx="1" />
                <rect className="car-inclinometer__wheel" x="8" y="1" width="5" height="8" rx="1" />
              </g>
            </svg>
            <figcaption>
              <small>ROLL</small>
              <strong>{Math.round(Math.abs(roll))}°</strong>
              <em>{Math.round(roll) === 0 ? "LEVEL" : roll > 0 ? "RIGHT" : "LEFT"}</em>
            </figcaption>
          </figure>
        </>
      ) : null}
    </div>
  );
}
