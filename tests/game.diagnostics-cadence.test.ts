import { describe, expect, it } from "vitest";
import type { NearestAirportInfo } from "../src/game/AirportNetworkController";
import {
  DIAGNOSTICS_POLL_INTERVAL_MS,
  DiagnosticsPoller,
  diagnosticsShown,
  nearestAirportReadoutKey,
  shouldPollDiagnostics,
} from "../src/game/diagnosticsCadence";
import type { RenderDiagnostics } from "../src/game/types";
import { readSource } from "./support/sourceText";

const PHASES = ["menu", "flying", "paused", "viewer"] as const;

/** A renderer that counts getDiagnostics calls, and a setState that counts commits. */
function rig() {
  const counts = { reads: 0, commits: 0, clears: 0 };
  const snapshot = { fps: 120 } as RenderDiagnostics;
  const poller = new DiagnosticsPoller(
    () => {
      counts.reads += 1;
      return snapshot;
    },
    (diagnostics) => {
      counts.commits += 1;
      if (diagnostics === null) counts.clears += 1;
    },
  );
  let now = 1_000;
  /** `seconds` of 120 Hz frames, as FlightGame's rAF loop ticks the poller. */
  const run = (seconds: number, showDiagnostics: boolean, phase: string): void => {
    for (let frame = 0; frame < Math.round(seconds * 120); frame += 1) {
      now += 1_000 / 120;
      poller.tick(now, showDiagnostics, phase);
    }
  };
  return { counts, run };
}

describe("diagnostics polling (B3)", () => {
  it("polls only while the diagnostics setting is on or the viewer HUD is up", () => {
    for (const showDiagnostics of [false, true]) {
      for (const phase of PHASES) {
        const shown = showDiagnostics || phase === "viewer";
        expect(diagnosticsShown(showDiagnostics, phase)).toBe(shown);
        expect(shouldPollDiagnostics({ showDiagnostics, phase, now: 0, lastPolledAt: null }))
          .toBe(shown);
        expect(shouldPollDiagnostics({ showDiagnostics, phase, now: 10_000, lastPolledAt: 0 }))
          .toBe(shown);
      }
    }
  });

  it("polls every 500 ms while shown", () => {
    expect(DIAGNOSTICS_POLL_INTERVAL_MS).toBe(500);
    const poll = (now: number) =>
      shouldPollDiagnostics({ showDiagnostics: true, phase: "flying", now, lastPolledAt: 1_000 });
    expect(poll(1_000)).toBe(false);
    expect(poll(1_499.9)).toBe(false);
    expect(poll(1_500)).toBe(true);
    expect(poll(9_000)).toBe(true);
  });

  it("never reads diagnostics in flight with the panel closed", () => {
    const { counts, run } = rig();
    for (const phase of ["menu", "flying", "paused"]) run(10, false, phase);
    expect(counts).toEqual({ reads: 0, commits: 0, clears: 0 });
  });

  it("reads twice a second with the panel open, as before", () => {
    const { counts, run } = rig();
    run(10, true, "flying");
    // The first frame polls at once, then one poll per 500 ms of frames.
    expect(counts.reads).toBe(20);
    expect(counts.commits).toBe(20);
    expect(counts.clears).toBe(0);
  });

  it("clears once when the panel closes and polls on the next frame when it reopens", () => {
    const { counts, run } = rig();
    run(1, true, "flying");
    expect(counts.reads).toBe(2);
    run(5, false, "flying");
    expect(counts).toEqual({ reads: 2, commits: 3, clears: 1 });
    run(1 / 120, true, "paused");
    expect(counts).toEqual({ reads: 3, commits: 4, clears: 1 });
  });

  it("keeps the viewer HUD's numbers coming without the panel", () => {
    const { counts, run } = rig();
    run(2, false, "viewer");
    expect(counts.reads).toBe(4);
    run(2, false, "menu");
    expect(counts).toEqual({ reads: 4, commits: 5, clears: 1 });
  });
});

describe("nearest-airport readout dedupe (B3)", () => {
  const field: NearestAirportInfo = {
    ident: "KQRT",
    isHome: false,
    runways: "05/23",
    distanceMeters: 11_112,
    bearingDegrees: 47,
    markerX: 0,
    markerY: 0,
    markerZ: 0,
  };
  const key = (overrides: Partial<NearestAirportInfo>, aviation = true) =>
    nearestAirportReadoutKey({ ...field, ...overrides }, aviation);

  it("ignores what the HUD does not show", () => {
    expect(key({ distanceMeters: 11_112 + 20 })).toBe(key({}));
    expect(key({ markerX: 50, markerY: 300, markerZ: -20 })).toBe(key({}));
  });

  it("changes with everything the HUD shows", () => {
    // 0.1 NM is 185 m: one readout step.
    expect(key({ distanceMeters: 11_112 + 185 })).not.toBe(key({}));
    // Circling the field at constant distance turns the bearing only.
    expect(key({ bearingDegrees: 48 })).not.toBe(key({}));
    expect(key({ ident: "KQRS" })).not.toBe(key({}));
    expect(key({ runways: "09/27" })).not.toBe(key({}));
    expect(key({ isHome: true })).not.toBe(key({}));
    expect(key({}, false)).not.toBe(key({}, true));
    expect(nearestAirportReadoutKey(null, true)).toBe("");
    expect(nearestAirportReadoutKey(null, true)).not.toBe(key({}));
  });

  it("publishes a turn at constant distance and holds a steady readout", () => {
    let last: string | null = null;
    let commits = 0;
    const publish = (nearest: NearestAirportInfo | null) => {
      const readout = nearestAirportReadoutKey(nearest, true);
      if (readout !== last) {
        last = readout;
        commits += 1;
      }
    };
    // Four updates a second for 5 s, holding a distance and bearing.
    for (let update = 0; update < 20; update += 1) publish({ ...field, distanceMeters: 11_112 + update });
    expect(commits).toBe(1);
    // A 360° orbit at 6 NM, one update per degree of bearing.
    for (let bearing = 1; bearing <= 360; bearing += 1) publish({ ...field, bearingDegrees: bearing });
    expect(commits).toBe(1 + 360);
  });
});

describe("FlightGame publishes through the B3 gates", () => {
  const source = readSource(new URL("../src/game/FlightGame.tsx", import.meta.url));
  const renderLoop = source.match(
    /const renderLoop = \(now: number\) => \{[\s\S]*?\n {6}\};/u,
  )?.[0] ?? "";

  it("ticks the diagnostics poller from the frame loop and reads nowhere else", () => {
    expect(renderLoop).toContain(
      "diagnosticsPoller.tick(now, settingsRef.current.showDiagnostics, phaseRef.current);",
    );
    expect(renderLoop).not.toContain("getDiagnostics");
    expect(renderLoop).not.toContain("setDiagnostics");
    expect(source.match(/getDiagnostics\(\)/gu)).toHaveLength(1);
    expect(source).toMatch(
      /new DiagnosticsPoller\(\s*\(\) => renderer\.getDiagnostics\(\),\s*setDiagnostics,\s*\)/u,
    );
    expect(source.match(/setDiagnostics\b/gu)).toHaveLength(2);
  });

  it("sets the nearest airport only when its readout changes", () => {
    expect(source.match(/setNearestAirport\(/gu)).toHaveLength(1);
    expect(source).toMatch(
      /const readout = nearestAirportReadoutKey\(nearest, aviation\);\s*if \(readout !== nearestAirportReadout\) \{\s*nearestAirportReadout = readout;\s*setNearestAirport\(nearest\);\s*\}/u,
    );
    expect(source).toContain("let nearestAirportReadout: string | null = null;");
  });
});
