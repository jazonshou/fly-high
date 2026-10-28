import type { NearestAirportInfo } from "@/src/game/AirportNetworkController";
import type { FlightVisualState, PersonVisualState, WalkingPrompt as WalkingPromptState } from "@/src/game/types";
import type { HudMode, UnitSystem } from "@/src/settings";
import { PERSON } from "@/src/vehicles/person";
import { formatHeading, MetricTape, NearestAirportControl } from "@/src/ui/hudParts";

interface PersonHudProps {
  state: FlightVisualState;
  person: PersonVisualState;
  mode: Exclude<HudMode, "off">;
  units: UnitSystem;
  cameraLabel: string;
  seedLabel: string;
  nearestAirport?: NearestAirportInfo | null;
  nearestAirportShown?: boolean;
  onToggleNearestAirport?: (() => void) | undefined;
}

/** The water readout shows from this depth, metres: a puddle is not wading. */
export const PERSON_WATER_SHOWN_METERS = 0.1;

/** What the water readout says: wading to a depth, swimming, or diving to a depth below the surface. */
export function personWaterLabel(person: PersonVisualState, imperial: boolean): { label: string; value: string } | null {
  const format = (meters: number) => imperial ? `${Math.round(meters * 3.28084)} FT` : `${meters.toFixed(1)} M`;
  if (person.mode === "dive" || person.headDepth > 0.3) return { label: "DEPTH", value: format(Math.max(0, person.headDepth)) };
  if (person.mode === "swim") return { label: "SWIMMING", value: format(person.waterDepth) };
  if (person.waterDepth >= PERSON_WATER_SHOWN_METERS) return { label: "WADING", value: format(person.waterDepth) };
  return null;
}

/** The prompt's words: the key, and what it does or why it can't yet. */
export function walkingPromptText(prompt: WalkingPromptState): string {
  if (prompt.action === "getIn") {
    if (prompt.reason === "moving") return "THE CAR IS MOVING";
    if (prompt.reason === "blocked") return "CAN'T GET IN";
    return prompt.ready ? "X · GET IN LANDCRUISER" : "LANDCRUISER";
  }
  if (prompt.reason === "blocked") return "BOTH DOORS BLOCKED";
  return `HOLD X · GET OUT`;
}

/** The get-in or get-out prompt, quiet unless it is ready. Shared by the walker's and the car's panels. */
export function WalkingPrompt({ prompt }: { prompt: WalkingPromptState | null | undefined }) {
  if (!prompt) return null;
  return (
    <div
      className={`flight-alert walking-prompt${prompt.ready ? " walking-prompt--ready" : " flight-alert--quiet"}`}
      role="status"
    >
      {walkingPromptText(prompt)}
    </div>
  );
}

/**
 * The walker's panel (the walking plan's "Start, controls, HUD, sound"): the
 * heading as a compass readout, elevation, the nearest airport (the shared
 * control the car uses), a water readout while wading, swimming or diving,
 * and the get-in prompt near the car. Speed is left off: a walker does not
 * read one.
 */
export function PersonHud({
  state,
  person,
  mode,
  units,
  cameraLabel,
  seedLabel,
  nearestAirport = null,
  nearestAirportShown = false,
  onToggleNearestAirport,
}: PersonHudProps) {
  const imperial = units === "aviation";
  const elevation = state.altitude * (imperial ? 3.28084 : 1);
  const water = personWaterLabel(person, imperial);
  const gait = person.mode === "run" ? "RUNNING" : person.mode === "swim" || person.mode === "dive" ? "SWIMMING" : "ON FOOT";
  return (
    <div className={`flight-hud flight-hud--${mode} flight-hud--person`} aria-live="off">
      <div className="flight-hud__topline">
        <div className="hud-session">
          <span>{gait}</span>
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
        <MetricTape label="ELEV" value={Math.round(elevation).toString()} unit={imperial ? "FT" : "M"} side="right" />
      ) : null}

      <WalkingPrompt prompt={state.walking?.prompt} />

      <div className="flight-hud__bottom">
        <div className="instrument-strip person-strip">
          <div className="instrument-readout" aria-label={`Heading ${formatHeading(state.heading)}`}>
            <small>HDG</small>
            <strong>{formatHeading(state.heading)}</strong>
          </div>
          {water ? (
            <div className="instrument-readout" aria-label={`${water.label} ${water.value}`}>
              <small>{water.label}</small>
              <strong>{water.value}</strong>
              <em>{person.waterDepth > PERSON.swimDepthFraction * PERSON.stature ? "OUT OF DEPTH" : ""}</em>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
