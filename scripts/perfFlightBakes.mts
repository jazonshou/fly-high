/**
 * perf:flight's account of the two bakes the renderer spreads over frames,
 * from each flight frame's `bake` record (`tests/perf/ab/bakeProbe.ts`), per
 * arm and leg and per settle trial. Pure; no I/O.
 *
 * Sky re-light. A climb re-lights the sky probe every 500 m, over frames: a
 * begin frame snapshots the sky and samples it for about 0.5 ms, advance
 * frames sample about 0.5 ms each, the landing frame runs the converter over
 * the samples and lights the world with them, the next frame re-arms the
 * specular cube and the one after re-bakes the cloud ambient LUT. An
 * environment change or a teleport re-lights in one frame instead. A frame's
 * sky work is the renderer's own time in its sky-probe refresh; the cube's
 * six faces render later in that frame, inside the scene pass, and are not in
 * it. The target is no frame over 1 ms.
 *
 * Which of these a frame did is read from its record and the frames before
 * it: landings and sampling slices are counted by the renderer; the cube and
 * the LUT are the first and second frames after a landing; a slice is a begin
 * when no rebake was in flight: after a landing or a one-frame re-light, or
 * after a frame on which the refresh did not run (it runs on every frame of a
 * rebake in flight). On the first frame of an arm's first leg or of a trial
 * that is not known, and a slice there reads "advance". A refresh that did
 * none of those is a one-frame re-light. So a one-frame re-light on either
 * of the two frames after a landing reads as the cube or the LUT.
 *
 * Ground cover. Each tile-bake call's time on the bake's own clock, against
 * 2 ms: its 1.5 ms budget and one 32-column step past it.
 *
 * Both targets count a reading AT the target with those over it. The agent's
 * page is not cross-origin isolated, so its clock reads in 0.1 ms steps: a
 * frame that reads 1.0 ms spent anywhere from about 0.9 to 1.1 ms and cannot
 * be shown to be within it, and the difference of two such readings is 1.0
 * give or take a float's last bit, so a strict comparison would count it or
 * not at random.
 *
 * An arm whose build does not report its bakes (no `bake` on its frames) is
 * "n/a" throughout. Plain Node, as `perfAbHarness.mts`.
 */

import type { FlightFrame, FlightReport } from "../tests/perf/ab/protocol.ts";
import { ARMS, percentiles, type ArmName, type SettleTrial } from "./perfFlightVerdict.mts";

/** No frame should spend more than this in the sky-probe refresh. */
export const SKY_FRAME_TARGET_MS = 1;
/** A ground-cover tile-bake call should end within its 1.5 ms budget and one 32-column step. */
export const GROUND_COVER_CALL_TARGET_MS = 2;
/** The report lists at most this many sky-work frames over the target; report.json keeps them all. */
const LISTED_FRAMES = 40;

/** At or over `target`, give or take the float error of a difference of two clock readings. */
export function reaches(milliseconds: number, target: number): boolean {
  return milliseconds >= target - 1e-6;
}

export type SkyWork = "one-frame" | "begin" | "advance" | "land" | "cube" | "LUT";

/** A frame on which the sky-probe refresh ran. */
export interface SkyWorkFrame {
  readonly phase: string;
  readonly frame: number;
  readonly work: readonly SkyWork[];
  readonly skyMs: number;
  /** The sampling slice's ms, and the converter's, when the frame had them. */
  readonly advanceMs: number | null;
  readonly applyMs: number | null;
  readonly renderMs: number;
}

export interface SkySummary {
  /** Sliced re-lights that landed their irradiance. */
  readonly landed: number;
  readonly oneFrame: number;
  /** Frames on which the refresh ran. */
  readonly workFrames: number;
  readonly worst: SkyWorkFrame | null;
  readonly overTarget: readonly SkyWorkFrame[];
}

export interface GroundCoverSummary {
  readonly calls: number;
  /** Per call; null with no calls. */
  readonly ms: { readonly p50: number; readonly p95: number; readonly max: number } | null;
  readonly overTarget: number;
  readonly paceFloorCalls: number;
  readonly tilesCompleted: number;
}

export interface BakeRow {
  /** "leg 1", ..., "all legs", "trial 1", ... */
  readonly phase: string;
  readonly arm: ArmName;
  readonly sha: string;
  /** Null: the arm's build does not report its bakes. */
  readonly sky: SkySummary | null;
  readonly groundCover: GroundCoverSummary | null;
}

export interface BakeReport {
  readonly rows: readonly BakeRow[];
}

export interface BakeReportInput {
  readonly shas: Readonly<Record<ArmName, string>>;
  readonly reports: Readonly<Record<ArmName, readonly FlightReport[]>>;
  readonly settleTrials?: readonly SettleTrial[];
}

/** What the attribution knows of the renderer's sliced re-light, carried from frame to frame of one renderer. */
interface SkyState {
  /** A rebake has begun and not landed; null when not known. */
  inFlight: boolean | null;
  /** Frames since the last landing; null before one. */
  sinceLanding: number | null;
  /** The refresh ran on the frame before; null when not known. */
  previousRan: boolean | null;
}

const unknownSky = (): SkyState => ({ inFlight: null, sinceLanding: null, previousRan: null });

/** What one phase's frames say, before summing. */
interface PhaseBakes {
  readonly recorded: boolean;
  readonly sky: SkyWorkFrame[];
  readonly landed: number;
  readonly callMs: number[];
  readonly paceFloorCalls: number;
  readonly tilesCompleted: number;
}

function recorded(frames: readonly FlightFrame[]): boolean {
  return frames.some((frame) => frame.bake !== undefined);
}

function phaseBakes(phase: string, frames: readonly FlightFrame[], state: SkyState): PhaseBakes {
  const sky: SkyWorkFrame[] = [];
  const callMs: number[] = [];
  let landed = 0;
  let paceFloorCalls = 0;
  let tilesCompleted = 0;
  for (const [index, frame] of frames.entries()) {
    if (state.sinceLanding !== null) state.sinceLanding += 1;
    const bake = frame.bake;
    const ran = bake === undefined ? null : bake !== null && bake.skyMs !== null;
    const previousRan = state.previousRan;
    state.previousRan = ran;
    if (!bake) continue;
    if (bake.groundCoverCalls > 0) callMs.push(bake.groundCoverMs ?? 0);
    paceFloorCalls += bake.groundCoverPaceFloorCalls;
    tilesCompleted += bake.groundCoverTilesCompleted;
    landed += bake.skyLandings;
    if (bake.skyMs === null) continue;
    const work: SkyWork[] = [];
    if (bake.skyLandings > 0) {
      // The landing frame does nothing else (`refreshSkyProbe`).
      work.push("land");
      state.inFlight = false;
      state.sinceLanding = 0;
    } else {
      if (state.sinceLanding === 1) work.push("cube");
      else if (state.sinceLanding === 2) work.push("LUT");
      if (bake.skyAdvances > 0) {
        work.push(state.inFlight === false || previousRan === false ? "begin" : "advance");
        state.inFlight = true;
      }
      if (work.length === 0) {
        // It drops any rebake in flight.
        work.push("one-frame");
        state.inFlight = false;
      }
    }
    sky.push({
      phase,
      frame: index,
      work,
      skyMs: bake.skyMs,
      advanceMs: bake.skyAdvanceMs,
      applyMs: bake.skyApplyMs,
      renderMs: frame.renderMs,
    });
  }
  return { recorded: recorded(frames), sky, landed, callMs, paceFloorCalls, tilesCompleted };
}

interface BakeFigures {
  readonly sky: SkySummary;
  readonly groundCover: GroundCoverSummary;
}

/** The phases' figures together; null when none of them was recorded. */
function figures(parts: readonly PhaseBakes[]): BakeFigures | null {
  if (!parts.some((part) => part.recorded)) return null;
  const sky = parts.flatMap((part) => part.sky);
  const callMs = parts.flatMap((part) => part.callMs);
  const calls = percentiles(callMs);
  const worst = sky.reduce<SkyWorkFrame | null>((most, frame) => (most && most.skyMs >= frame.skyMs ? most : frame), null);
  return {
    sky: {
      landed: parts.reduce((sum, part) => sum + part.landed, 0),
      oneFrame: sky.filter((frame) => frame.work.includes("one-frame")).length,
      workFrames: sky.length,
      worst,
      overTarget: sky.filter((frame) => reaches(frame.skyMs, SKY_FRAME_TARGET_MS)),
    },
    groundCover: {
      calls: callMs.length,
      ms: callMs.length > 0 ? { p50: calls.p50, p95: calls.p95, max: calls.max } : null,
      overTarget: callMs.filter((ms) => reaches(ms, GROUND_COVER_CALL_TARGET_MS)).length,
      paceFloorCalls: parts.reduce((sum, part) => sum + part.paceFloorCalls, 0),
      tilesCompleted: parts.reduce((sum, part) => sum + part.tilesCompleted, 0),
    },
  };
}

function summarize(phase: string, arm: ArmName, sha: string, parts: readonly PhaseBakes[]): BakeRow {
  return { phase, arm, sha, ...(figures(parts) ?? { sky: null, groundCover: null }) };
}

/**
 * Rows per leg, base then head, then each arm over all its legs, then per
 * settle trial. An arm's legs fly one renderer in order, so the attribution
 * runs on across them; each trial is a new renderer.
 */
export function bakeReport(input: BakeReportInput): BakeReport {
  const legs = {} as Record<ArmName, PhaseBakes[]>;
  for (const arm of ARMS) {
    const state: SkyState = unknownSky();
    legs[arm] = input.reports[arm].map((leg, index) => phaseBakes(`leg ${index + 1}`, leg.frames, state));
  }
  const rows: BakeRow[] = [];
  const legCount = Math.max(...ARMS.map((arm) => legs[arm].length));
  for (let index = 0; index < legCount; index += 1) {
    for (const arm of ARMS) {
      const leg = legs[arm][index];
      if (leg) rows.push(summarize(`leg ${index + 1}`, arm, input.shas[arm], [leg]));
    }
  }
  for (const arm of ARMS) rows.push(summarize("all legs", arm, input.shas[arm], legs[arm]));
  for (const [index, trial] of (input.settleTrials ?? []).entries()) {
    for (const arm of ARMS) {
      const phase = `trial ${index + 1}`;
      rows.push(summarize(phase, arm, input.shas[arm], [phaseBakes(phase, trial[arm].frames, unknownSky())]));
    }
  }
  return { rows };
}

function fmt(value: number | null | undefined, digits = 2): string {
  return value !== null && value !== undefined && Number.isFinite(value) ? value.toFixed(digits) : "n/a";
}

function describeSkyFrame(frame: SkyWorkFrame): string {
  const parts = [
    ...(frame.advanceMs !== null ? [`slice ${fmt(frame.advanceMs)}`] : []),
    ...(frame.applyMs !== null ? [`converter ${fmt(frame.applyMs)}`] : []),
  ];
  return `${frame.work.join(" + ")} ${fmt(frame.skyMs)} ms${parts.length > 0 ? ` (${parts.join(", ")})` : ""}`;
}

/** One leg's bakes for the run log, or "" from a build that does not report them. */
export function describeLegBakes(leg: FlightReport): string {
  const seen = figures([phaseBakes("", leg.frames, unknownSky())]);
  if (!seen) return "";
  const { sky, groundCover } = seen;
  const skyPart = sky.worst === null
    ? "no sky work"
    : `sky ${sky.landed} landed / ${sky.oneFrame} one-frame, worst ${fmt(sky.worst.skyMs)} ms, `
      + `${sky.overTarget.length} at or over ${SKY_FRAME_TARGET_MS} ms`;
  const coverPart = groundCover.ms === null
    ? "no ground-cover bake"
    : `ground cover ${groundCover.calls} calls, max ${fmt(groundCover.ms.max)} ms, `
      + `${groundCover.overTarget} at or over ${GROUND_COVER_CALL_TARGET_MS} ms`;
  return `, ${skyPart}; ${coverPart}`;
}

export function renderBakeMarkdown(report: BakeReport): string {
  const na = (cells: number) => Array.from({ length: cells }, () => "n/a");
  const head = (row: BakeRow) => [row.phase, row.arm, row.sha.slice(0, 10)];
  const skyRows = report.rows.map((row) => {
    const { sky } = row;
    return [
      ...head(row),
      ...(sky
        ? [
          String(sky.landed),
          String(sky.oneFrame),
          String(sky.workFrames),
          sky.worst ? `${fmt(sky.worst.skyMs)} (${sky.worst.work.join(" + ")})` : "-",
          sky.overTarget.length > 0 ? `**${sky.overTarget.length}**` : "0",
        ]
        : na(5)),
    ];
  });
  // Legs and trials; the "all legs" rows repeat the legs' frames.
  const over = report.rows.filter((row) => row.phase !== "all legs")
    .flatMap((row) => (row.sky?.overTarget ?? []).map((frame) => ({ arm: row.arm, frame })));
  const recordedAny = report.rows.some((row) => row.sky !== null);
  const coverRows = report.rows.map((row) => {
    const cover = row.groundCover;
    return [
      ...head(row),
      ...(cover
        ? [
          String(cover.calls),
          cover.ms ? `${fmt(cover.ms.p50)} / ${fmt(cover.ms.p95)} / ${fmt(cover.ms.max)}` : "-",
          cover.overTarget > 0 ? `**${cover.overTarget}**` : "0",
          String(cover.paceFloorCalls),
          String(cover.tilesCompleted),
        ]
        : na(5)),
    ];
  });
  const table = (header: string, rows: readonly (readonly string[])[]) => [
    `| ${header} |`,
    `| ${header.split(" | ").map(() => "---").join(" | ")} |`,
    ...rows.map((cells) => `| ${cells.join(" | ")} |`),
  ];
  return [
    "### Sky re-light and ground-cover bake",
    "",
    "From each frame's bake record, read after render() outside its timed windows; n/a: the arm's build does "
      + "not report its bakes. Sky work: the renderer's own ms in its sky-probe refresh on the frames it ran. A "
      + "sliced re-light (every 500 m of climb) begins and samples about 0.5 ms a frame, lands its irradiance "
      + "(the converter), re-arms the specular cube on the next frame (its six faces render in the scene pass, "
      + "outside these ms) and re-bakes the cloud LUT on the one after; a one-frame re-light (an environment "
      + `change, a teleport) does it all at once. Target: no frame over ${SKY_FRAME_TARGET_MS} ms. The page's clock `
      + "reads in 0.1 ms steps (it is not cross-origin isolated), so a frame that reads the target is counted with "
      + "those over it: it cannot be shown to be within it.",
    "",
    ...table(
      "phase | arm | commit | sliced re-lights landed | one-frame re-lights | sky-work frames "
        + `| worst sky-work frame ms (work) | frames at or over ${SKY_FRAME_TARGET_MS} ms`,
      skyRows,
    ),
    "",
    ...(!recordedAny ? [] : over.length === 0
      ? [`No sky-work frame at or over ${SKY_FRAME_TARGET_MS} ms.`, ""]
      : [
        `Sky-work frames at or over ${SKY_FRAME_TARGET_MS} ms (the work, the refresh's ms with the slice's and the `
          + "converter's, and the frame's render() ms):",
        "",
        ...over.slice(0, LISTED_FRAMES).map(({ arm, frame }) =>
          `- ${arm} ${frame.phase} frame ${frame.frame}: ${describeSkyFrame(frame)}, render() ${fmt(frame.renderMs)} ms`),
        ...(over.length > LISTED_FRAMES ? [`- and ${over.length - LISTED_FRAMES} more (report.json)`] : []),
        "",
      ]),
    `Ground cover: each tile-bake call's ms on the bake's own clock. Target: each within ${GROUND_COVER_CALL_TARGET_MS} ms `
      + "(the 1.5 ms budget and one 32-column step). Pace-floor calls kept baking past the budget to keep the tile's pace.",
    "",
    ...table(
      `phase | arm | commit | tile-bake calls | ms per call p50 / p95 / max | calls at or over ${GROUND_COVER_CALL_TARGET_MS} ms `
        + "| pace-floor calls | tiles completed",
      coverRows,
    ),
    "",
  ].join("\n");
}
