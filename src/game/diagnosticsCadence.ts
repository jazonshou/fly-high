import { formatAirportDistance } from "@/src/ui/airportMarker";
import type { NearestAirportInfo } from "./AirportNetworkController";
import type { RenderDiagnostics } from "./types";

/**
 * B3: what the frame loop and the simulation callback publish to React, and
 * when. Every publication re-renders the whole FlightGame tree.
 */

/** The diagnostics panel and the viewer HUD refresh twice a second. */
export const DIAGNOSTICS_POLL_INTERVAL_MS = 500;

/**
 * Only the diagnostics panel and the terrain viewer's HUD (fps, draws,
 * triangles) show renderer diagnostics, so they are polled only while the
 * diagnostics setting is on or the viewer HUD is up. Otherwise a poll is a
 * main-thread spike (`detail.pendingWorkItems` walks every desired cell and
 * GPU memory is inventoried) plus a React commit nobody sees. With the
 * setting on, the menu's attract flight still polls, though no panel is
 * mounted there.
 */
export function diagnosticsShown(showDiagnostics: boolean, phase: string): boolean {
  return showDiagnostics || phase === "viewer";
}

export interface DiagnosticsPollInput {
  readonly showDiagnostics: boolean;
  /** FlightGame's phase: "menu", "flying", "paused" or "viewer". */
  readonly phase: string;
  readonly now: number;
  /** When the last poll ran; null before the first, and after polling stops. */
  readonly lastPolledAt: number | null;
}

export function shouldPollDiagnostics(input: DiagnosticsPollInput): boolean {
  if (!diagnosticsShown(input.showDiagnostics, input.phase)) return false;
  return input.lastPolledAt === null
    || input.now - input.lastPolledAt >= DIAGNOSTICS_POLL_INTERVAL_MS;
}

/**
 * The frame loop's diagnostics publication: a poll per interval while
 * `diagnosticsShown`, then one clear when it stops, so reopening polls on
 * the next frame instead of showing a stale snapshot.
 */
export class DiagnosticsPoller {
  private lastPolledAt: number | null = null;

  constructor(
    private readonly read: () => RenderDiagnostics,
    private readonly publish: (diagnostics: RenderDiagnostics | null) => void,
  ) {}

  tick(now: number, showDiagnostics: boolean, phase: string): void {
    if (shouldPollDiagnostics({ showDiagnostics, phase, now, lastPolledAt: this.lastPolledAt })) {
      this.lastPolledAt = now;
      this.publish(this.read());
    } else if (this.lastPolledAt !== null && !diagnosticsShown(showDiagnostics, phase)) {
      this.lastPolledAt = null;
      this.publish(null);
    }
  }
}

/**
 * Everything the HUD's nearest-airport readout shows, as one string; the
 * readout is republished only when this changes. The bearing is part of it,
 * or BRG would freeze while circling a field at constant distance. It is
 * already whole degrees (`describeNearestAirport`), which the HUD shows as is.
 */
export function nearestAirportReadoutKey(
  nearest: NearestAirportInfo | null,
  aviation: boolean,
): string {
  if (nearest === null) return "";
  return [
    nearest.ident,
    nearest.isHome ? "home" : "",
    nearest.runways,
    nearest.bearingDegrees,
    formatAirportDistance(nearest.distanceMeters, aviation),
  ].join("|");
}
