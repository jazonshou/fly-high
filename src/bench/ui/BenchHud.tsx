import { createPortal } from "react-dom";
import type { FlightVisualState } from "@/src/game/types";
import { seedToString, type GameSettings } from "@/src/settings";
import { Hud } from "@/src/ui/Hud";

/** FlightGame's label for the chase camera, the only camera a bench flight uses. */
const CHASE_CAMERA_LABEL = "CHASE CAM";

export interface BenchHudContentProps {
  /** The scripted state the recorder last wrote; read when this renders. */
  readonly state: FlightVisualState;
  /** The step's in-memory settings (`benchGameSettings`), for aircraft, units and control mode. */
  readonly settings: GameSettings;
  readonly seed: number;
}

export interface BenchHudProps extends BenchHudContentProps {
  /** `main.flight-shell`; null draws nothing. */
  readonly container: Element | null;
}

/**
 * The game's own HUD as a player sees it in a chase-camera flight: full
 * instruments, no diagnostics overlay, and none of the HUD's buttons (no
 * nearest airport, no autoland, no budget probe), so nothing on it can change
 * what is measured.
 */
export function BenchHudContent({ state, settings, seed }: BenchHudContentProps) {
  return (
    <Hud
      state={state}
      aircraft={settings.aircraft}
      mode="full"
      flightMode={settings.flightMode}
      units={settings.units}
      diagnostics={null}
      showDiagnostics={false}
      cameraMode="chase"
      cameraLabel={CHASE_CAMERA_LABEL}
      seedLabel={seedToString(seed)}
      mouseFlight={false}
    />
  );
}

/**
 * The bench flies in the menu phase, where FlightGame draws no HUD, so the
 * bench draws the real one itself, through a portal into `main.flight-shell`:
 * there it takes the shell's tokens and stacking like the game's own (plan
 * 2.11). The state object is reused and changed in place, so render this
 * again every 75 ms, the cadence FlightGame gives its own HUD, and do not wrap
 * it in `memo`. `hud=0` renders none, and the report records which.
 */
export function BenchHud({ container, ...content }: BenchHudProps) {
  return container ? createPortal(<BenchHudContent {...content} />, container) : null;
}
