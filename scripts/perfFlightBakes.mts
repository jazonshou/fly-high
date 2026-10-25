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
 * it. The target is no frame of a sliced re-light over 1 ms. A one-frame
 * re-light (a renderer's first frame, a teleport, an environment change) is
 * synchronous by design and outside it: it has its own column, and the
 * worst frame and the frames over the target are the sliced ones alone.
 *
 * The refresh's own ms leave out what the re-light costs elsewhere in the
 * frame: the cube's six faces in the scene pass above all. So each sliced
 * re-light is also followed frame by frame, from its begin to the frame after
 * its LUT, with each frame's render() and the two passes its work lands in
 * (`RELIGHT_PASSES`), against their medians over the frame's leg.
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
 * 2 ms: its 1.5 ms budget and one 32-column step past it. A call over it is
 * not by itself the bake's own overrun, so each one carries what else its
 * frame says: a collection during render() (its heap fell), which may have
 * run inside the call; a pace-floor hold, which bakes past the budget by
 * design; and the call that finished the tile, which also times its three
 * texture uploads. The calls over it with neither of the first two are
 * counted apart.
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
/** The report follows at most this many sliced re-lights frame by frame; report.json keeps them all. */
const LISTED_RELIGHTS = 6;

/**
 * How to make a run exercise each target, for the report and perf:flight's
 * usage. The agent's terrain following climbs at most 25 m/s and descends
 * at most 10 m/s, at 60 frames a simulated second.
 */
export const SKY_RELIGHT_HOW = "A climb re-lights the sky every 500 m and the agent climbs at most 25 m/s, so a "
  + "re-light needs about 1200 frames of climb: e.g. --clearance 1500 --speed 250 --legs 2 --leg-frames 720.";
export const GROUND_COVER_HOW = "The ground cover bakes only below its fade height (55 to 110 m above the ground, by "
  + "quality tier), and the agent descends at most 10 m/s from the shot's altitude; --start x,z begins the "
  + "legs at --clearance above the ground: e.g. --clearance 30 --speed 70 --start <x,z>.";

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
  /** Frames that did a sliced re-light's work: a begin, an advance, a landing, the cube or the LUT. */
  readonly slicedFrames: number;
  /** The sliced frame with the most sky work; null with none. */
  readonly worst: SkyWorkFrame | null;
  /** The sliced frames at or over the target. */
  readonly overTarget: readonly SkyWorkFrame[];
  /** Every one-frame re-light: outside the target. */
  readonly oneFrame: readonly SkyWorkFrame[];
}

/** One tile-bake call, with what its frame says of it. */
export interface GroundCoverCall {
  readonly phase: string;
  readonly frame: number;
  readonly ms: number;
  /** The pace floor kept it baking past the budget. */
  readonly paceFloor: boolean;
  /** It finished the tile, and timed the three texture uploads. */
  readonly tileCompleted: boolean;
  /** The JS heap fell during the frame's render(): a collection ran there, maybe in the call. Null: not measured. */
  readonly collection: boolean | null;
  readonly renderMs: number;
}

export interface GroundCoverSummary {
  readonly calls: number;
  /** Per call; null with no calls. */
  readonly ms: { readonly p50: number; readonly p95: number; readonly max: number } | null;
  /** The calls at or over the target. */
  readonly overTarget: readonly GroundCoverCall[];
  /** Of those, the calls with neither a collection in their frame's render() nor a pace-floor hold. */
  readonly overTargetUnflagged: number;
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

/**
 * The frame-graph passes a sliced re-light's work lands in: the sky refresh
 * runs inside flight-presentation, and the specular cube's six faces render
 * inside the scene render, hdr-present (they draw even when perf:flight drops
 * the frame's own draws: a bake's target is never gated, `gpuDrawGate.ts`).
 */
export const RELIGHT_PASSES = ["flight-presentation", "hdr-present"] as const;

/** One frame of a sliced re-light, with what the frame cost besides the refresh. */
export interface RelightFrame {
  readonly phase: string;
  readonly frame: number;
  /** The frame's part of the re-light; "after": the frame after the LUT, which did no sky work. */
  readonly work: readonly (SkyWork | "after")[];
  /** The refresh's ms, and the slice's and the converter's; null when the frame had none. */
  readonly skyMs: number | null;
  readonly advanceMs: number | null;
  readonly applyMs: number | null;
  readonly renderMs: number;
  /** The median render() of the frame's leg (or trial). */
  readonly renderP50Ms: number;
  /** Each of `RELIGHT_PASSES`: its main-thread ms in this frame and its median over the leg; null when not timed. */
  readonly passes: Readonly<Record<string, { readonly ms: number; readonly p50Ms: number } | null>>;
}

/** A sliced re-light, frame by frame. */
export interface SlicedRelight {
  readonly arm: ArmName;
  readonly sha: string;
  /** "landed"; "dropped": a one-frame re-light or a new begin replaced it first; "unfinished": the frames ended first. */
  readonly outcome: "landed" | "dropped" | "unfinished";
  readonly frames: readonly RelightFrame[];
}

export interface BakeReport {
  readonly rows: readonly BakeRow[];
  /** Every sliced re-light of the legs (per arm, in order), then of the trials. */
  readonly relights: readonly SlicedRelight[];
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
  /** The sliced re-light being followed; null with none. */
  relight: OpenRelight | null;
  /** The re-lights followed to their end. */
  readonly relights: { readonly outcome: SlicedRelight["outcome"]; readonly frames: readonly RelightFrame[] }[];
}

interface OpenRelight {
  readonly frames: RelightFrame[];
  landed: boolean;
  /** Its LUT has landed: the next frame is its last. */
  awaitingAfter: boolean;
}

const unknownSky = (): SkyState => ({ inFlight: null, sinceLanding: null, previousRan: null, relight: null, relights: [] });

function closeRelight(state: SkyState, unlanded: "dropped" | "unfinished"): void {
  const open = state.relight;
  if (open === null) return;
  state.relights.push({ outcome: open.landed ? "landed" : unlanded, frames: open.frames });
  state.relight = null;
}

/** One frame into the re-light being followed: `work` null when the frame did no sky work. */
function followRelight(
  state: SkyState,
  work: readonly SkyWork[] | null,
  make: (work: readonly (SkyWork | "after")[]) => RelightFrame,
): void {
  if (state.relight?.awaitingAfter) {
    // The frame after the LUT ends it, and is part of it unless it starts something else.
    if (work === null) state.relight.frames.push(make(["after"]));
    closeRelight(state, "unfinished");
  }
  if (work === null) return;
  if (work.includes("one-frame")) {
    closeRelight(state, "dropped");
    return;
  }
  const slicing = work.includes("begin") || work.includes("advance");
  if (state.relight && work.includes("LUT") && slicing) {
    // The LUT's frame also begins the next rebake: it ends this one and starts that.
    state.relight.frames.push(make(work));
    closeRelight(state, "unfinished");
  }
  if (state.relight && work.includes("begin") && !state.relight.landed) closeRelight(state, "dropped");
  state.relight ??= { frames: [], landed: false, awaitingAfter: false };
  state.relight.frames.push(make(work));
  if (work.includes("land")) state.relight.landed = true;
  if (work.includes("LUT") && !slicing) state.relight.awaitingAfter = true;
}

/** A phase's median render() and `RELIGHT_PASSES` ms, the yardstick for its re-light frames. */
function phaseMedians(frames: readonly FlightFrame[]): { renderP50Ms: number; passP50Ms: Record<string, number | null> } {
  const passP50Ms: Record<string, number | null> = {};
  for (const name of RELIGHT_PASSES) {
    const values = frames.map((frame) => frame.passMs?.[name])
      .filter((value): value is number => typeof value === "number" && Number.isFinite(value));
    passP50Ms[name] = values.length > 0 ? percentiles(values).p50 : null;
  }
  return { renderP50Ms: percentiles(frames.map((frame) => frame.renderMs)).p50, passP50Ms };
}

/** What one phase's frames say, before summing. */
interface PhaseBakes {
  readonly recorded: boolean;
  readonly sky: SkyWorkFrame[];
  readonly landed: number;
  readonly calls: GroundCoverCall[];
  readonly paceFloorCalls: number;
  readonly tilesCompleted: number;
}

function recorded(frames: readonly FlightFrame[]): boolean {
  return frames.some((frame) => frame.bake !== undefined);
}

function phaseBakes(phase: string, frames: readonly FlightFrame[], state: SkyState): PhaseBakes {
  const sky: SkyWorkFrame[] = [];
  const calls: GroundCoverCall[] = [];
  let landed = 0;
  let paceFloorCalls = 0;
  let tilesCompleted = 0;
  let medians: ReturnType<typeof phaseMedians> | null = null;
  for (const [index, frame] of frames.entries()) {
    const relightFrame = (work: readonly (SkyWork | "after")[]): RelightFrame => {
      medians ??= phaseMedians(frames);
      const passes: Record<string, { ms: number; p50Ms: number } | null> = {};
      for (const name of RELIGHT_PASSES) {
        const ms = frame.passMs?.[name];
        const p50Ms = medians.passP50Ms[name];
        passes[name] = typeof ms === "number" && Number.isFinite(ms) && typeof p50Ms === "number" ? { ms, p50Ms } : null;
      }
      return {
        phase,
        frame: index,
        work,
        skyMs: frame.bake?.skyMs ?? null,
        advanceMs: frame.bake?.skyAdvanceMs ?? null,
        applyMs: frame.bake?.skyApplyMs ?? null,
        renderMs: frame.renderMs,
        renderP50Ms: medians.renderP50Ms,
        passes,
      };
    };
    if (state.sinceLanding !== null) state.sinceLanding += 1;
    const bake = frame.bake;
    const ran = bake === undefined ? null : bake !== null && bake.skyMs !== null;
    const previousRan = state.previousRan;
    state.previousRan = ran;
    if (bake === undefined) continue;
    if (bake === null || bake.skyMs === null) followRelight(state, null, relightFrame);
    if (bake === null) continue;
    if (bake.groundCoverCalls > 0) {
      calls.push({
        phase,
        frame: index,
        ms: bake.groundCoverMs ?? 0,
        paceFloor: bake.groundCoverPaceFloorCalls > 0,
        tileCompleted: bake.groundCoverTilesCompleted > 0,
        // NaN in the page (no precise heap figures) is null in report.json.
        collection: typeof frame.heapRenderBytes === "number" && Number.isFinite(frame.heapRenderBytes)
          ? frame.heapRenderBytes < 0
          : null,
        renderMs: frame.renderMs,
      });
    }
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
    followRelight(state, work, relightFrame);
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
  return { recorded: recorded(frames), sky, landed, calls, paceFloorCalls, tilesCompleted };
}

function worstOf(frames: readonly SkyWorkFrame[]): SkyWorkFrame | null {
  return frames.reduce<SkyWorkFrame | null>((most, frame) => (most && most.skyMs >= frame.skyMs ? most : frame), null);
}

interface BakeFigures {
  readonly sky: SkySummary;
  readonly groundCover: GroundCoverSummary;
}

/** The phases' figures together; null when none of them was recorded. */
function figures(parts: readonly PhaseBakes[]): BakeFigures | null {
  if (!parts.some((part) => part.recorded)) return null;
  const sky = parts.flatMap((part) => part.sky);
  const sliced = sky.filter((frame) => !frame.work.includes("one-frame"));
  const calls = parts.flatMap((part) => part.calls);
  const callMs = percentiles(calls.map((call) => call.ms));
  const overCalls = calls.filter((call) => reaches(call.ms, GROUND_COVER_CALL_TARGET_MS));
  return {
    sky: {
      landed: parts.reduce((sum, part) => sum + part.landed, 0),
      slicedFrames: sliced.length,
      worst: worstOf(sliced),
      overTarget: sliced.filter((frame) => reaches(frame.skyMs, SKY_FRAME_TARGET_MS)),
      oneFrame: sky.filter((frame) => frame.work.includes("one-frame")),
    },
    groundCover: {
      calls: calls.length,
      ms: calls.length > 0 ? { p50: callMs.p50, p95: callMs.p95, max: callMs.max } : null,
      overTarget: overCalls,
      overTargetUnflagged: overCalls.filter((call) => call.collection !== true && !call.paceFloor).length,
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
  const relights: SlicedRelight[] = [];
  const followed = (arm: ArmName, state: SkyState) => {
    closeRelight(state, "unfinished");
    relights.push(...state.relights.map((relight) => ({ arm, sha: input.shas[arm], ...relight })));
  };
  for (const arm of ARMS) {
    const state: SkyState = unknownSky();
    legs[arm] = input.reports[arm].map((leg, index) => phaseBakes(`leg ${index + 1}`, leg.frames, state));
    followed(arm, state);
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
      const state = unknownSky();
      rows.push(summarize(phase, arm, input.shas[arm], [phaseBakes(phase, trial[arm].frames, state)]));
      followed(arm, state);
    }
  }
  return { rows, relights };
}

function fmt(value: number | null | undefined, digits = 2): string {
  return value !== null && value !== undefined && Number.isFinite(value) ? value.toFixed(digits) : "n/a";
}

/** The sliced re-lights, frame by frame, or nothing when there were none. */
function renderRelights(relights: readonly SlicedRelight[]): string[] {
  if (relights.length === 0) return [];
  const cell = (timing: { readonly ms: number; readonly p50Ms: number } | null) =>
    (timing ? `${fmt(timing.ms)} (${fmt(timing.p50Ms)})` : "n/a");
  const rows = relights.slice(0, LISTED_RELIGHTS).flatMap((relight, index) => relight.frames.map((frame) => [
    `${index + 1} ${relight.outcome}`,
    relight.arm,
    frame.phase,
    String(frame.frame),
    frame.work.join(" + "),
    frame.skyMs === null
      ? "-"
      : `${fmt(frame.skyMs)}${frame.advanceMs !== null ? ` (slice ${fmt(frame.advanceMs)})` : ""}`
        + `${frame.applyMs !== null ? ` (converter ${fmt(frame.applyMs)})` : ""}`,
    `${fmt(frame.renderMs)} (${fmt(frame.renderP50Ms)})`,
    ...RELIGHT_PASSES.map((name) => cell(frame.passes[name] ?? null)),
  ]));
  const header = "re-light | arm | phase | frame | work | sky ms | render() ms (leg p50) | "
    + RELIGHT_PASSES.map((name) => `${name} ms (leg p50)`).join(" | ");
  return [
    "Each sliced re-light, frame by frame, from its begin to the frame after its LUT: what the refresh's own ms "
      + "leave out. render() and the two passes the re-light's work lands in, flight-presentation (where the sky "
      + "refresh runs) and hdr-present (the scene render, where the specular cube's six faces render on the cube "
      + "frame, even with the frame's own draws dropped), each with its median over the frame's leg.",
    "",
    `| ${header} |`,
    `| ${header.split(" | ").map(() => "---").join(" | ")} |`,
    ...rows.map((cells) => `| ${cells.join(" | ")} |`),
    ...(relights.length > LISTED_RELIGHTS ? ["", `And ${relights.length - LISTED_RELIGHTS} more re-lights (report.json).`] : []),
    "",
  ];
}

/** What a tile-bake call's frame says of it, or "" when nothing. */
function describeCallFlags(call: GroundCoverCall): string {
  const flags = [
    ...(call.collection === true ? ["collection in render()"] : call.collection === null ? ["heap not measured"] : []),
    ...(call.paceFloor ? ["pace-floor hold"] : []),
    ...(call.tileCompleted ? ["finished the tile (its three uploads)"] : []),
  ];
  return flags.length > 0 ? `; ${flags.join("; ")}` : "";
}

/** How many one-frame re-lights, and the worst one's ms. */
function oneFrameCell(frames: readonly SkyWorkFrame[]): string {
  const worst = worstOf(frames);
  return worst === null ? "0" : `${frames.length} (${fmt(worst.skyMs)})`;
}

function describeSkyFrame(frame: SkyWorkFrame): string {
  const parts = [
    ...(frame.advanceMs !== null ? [`slice ${fmt(frame.advanceMs)}`] : []),
    ...(frame.applyMs !== null ? [`converter ${fmt(frame.applyMs)}`] : []),
  ];
  return `${frame.work.join(" + ")} ${fmt(frame.skyMs)} ms${parts.length > 0 ? ` (${parts.join(", ")})` : ""}`;
}

/**
 * The bake section and its report.json figures. It is new beside tables a
 * run has always had, so a frame it cannot read costs only itself: on a
 * throw the section says so, `bakes` is null, and the rest of the report is
 * still written.
 */
export function bakeSection(input: BakeReportInput): { readonly bakes: BakeReport | null; readonly markdown: string } {
  try {
    const bakes = bakeReport(input);
    return { bakes, markdown: renderBakeMarkdown(bakes) };
  } catch (error) {
    return {
      bakes: null,
      markdown: [
        "### Sky re-light and ground-cover bake",
        "",
        `The bake section failed: ${error instanceof Error ? error.message : String(error)}. The tables above do not `
          + "depend on it; report.json carries `bakes: null`.",
        "",
      ].join("\n"),
    };
  }
}

/** One leg's bakes for the run log, or "" from a build that does not report them; never throws. */
export function describeLegBakes(leg: FlightReport): string {
  try {
    return legBakes(leg);
  } catch (error) {
    return `, bake summary failed: ${error instanceof Error ? error.message : String(error)}`;
  }
}

function legBakes(leg: FlightReport): string {
  const seen = figures([phaseBakes("", leg.frames, unknownSky())]);
  if (!seen) return "";
  const { sky, groundCover } = seen;
  const oneFrameWorst = worstOf(sky.oneFrame);
  const oneFramePart = oneFrameWorst === null
    ? ""
    : `, ${sky.oneFrame.length} one-frame (worst ${fmt(oneFrameWorst.skyMs)} ms)`;
  const skyPart = sky.worst === null
    ? `no sliced sky re-light${oneFramePart}`
    : `sky ${sky.landed} landed, worst sliced frame ${fmt(sky.worst.skyMs)} ms, `
      + `${sky.overTarget.length} at or over ${SKY_FRAME_TARGET_MS} ms${oneFramePart}`;
  const coverPart = groundCover.ms === null
    ? "no ground-cover bake"
    : `ground cover ${groundCover.calls} calls, max ${fmt(groundCover.ms.max)} ms, `
      + `${groundCover.overTarget.length} at or over ${GROUND_COVER_CALL_TARGET_MS} ms`
      + ` (${groundCover.overTargetUnflagged} with no collection or pace-floor hold)`;
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
          String(sky.slicedFrames),
          // "-": no sliced frame, so nothing to hold to the target.
          sky.worst ? `${fmt(sky.worst.skyMs)} (${sky.worst.work.join(" + ")})` : "-",
          sky.slicedFrames === 0 ? "-" : sky.overTarget.length > 0 ? `**${sky.overTarget.length}**` : "0",
          oneFrameCell(sky.oneFrame),
        ]
        : na(5)),
    ];
  });
  // Legs and trials; the "all legs" rows repeat the legs' frames.
  const listed = report.rows.filter((row) => row.phase !== "all legs");
  const over = listed.flatMap((row) => (row.sky?.overTarget ?? []).map((frame) => ({ arm: row.arm, frame })));
  const oneFrame = listed.flatMap((row) => (row.sky?.oneFrame ?? []).map((frame) => ({ arm: row.arm, frame })));
  const listFrames = (frames: readonly { readonly arm: ArmName; readonly frame: SkyWorkFrame }[]) => [
    ...frames.slice(0, LISTED_FRAMES).map(({ arm, frame }) =>
      `- ${arm} ${frame.phase} frame ${frame.frame}: ${describeSkyFrame(frame)}, render() ${fmt(frame.renderMs)} ms`),
    ...(frames.length > LISTED_FRAMES ? [`- and ${frames.length - LISTED_FRAMES} more (report.json)`] : []),
  ];
  // An arm whose legs never reached a target does not check it: say so, not "0 over".
  const allLegs = report.rows.filter((row) => row.phase === "all legs");
  const noRelight = allLegs.filter((row) => row.sky !== null && row.sky.landed === 0).map((row) => row.arm);
  const noCover = allLegs.filter((row) => row.groundCover !== null && row.groundCover.calls === 0).map((row) => row.arm);
  const slicedAny = listed.some((row) => (row.sky?.slicedFrames ?? 0) > 0);
  const coverRows = report.rows.map((row) => {
    const cover = row.groundCover;
    return [
      ...head(row),
      ...(cover
        ? [
          String(cover.calls),
          cover.ms ? `${fmt(cover.ms.p50)} / ${fmt(cover.ms.p95)} / ${fmt(cover.ms.max)}` : "-",
          cover.calls === 0 ? "-" : cover.overTarget.length > 0 ? `**${cover.overTarget.length}**` : "0",
          cover.calls === 0 ? "-" : String(cover.overTargetUnflagged),
          String(cover.paceFloorCalls),
          String(cover.tilesCompleted),
        ]
        : na(6)),
    ];
  });
  const overCalls = listed.flatMap((row) => (row.groundCover?.overTarget ?? []).map((call) => ({ arm: row.arm, call })));
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
      + "outside these ms) and re-bakes the cloud LUT on the one after. Target: no frame of a sliced re-light "
      + `over ${SKY_FRAME_TARGET_MS} ms. A one-frame re-light (a renderer's first frame, a teleport, an environment `
      + "change) does it all at once, synchronous by design: it is outside the target and has its own column. "
      + "The page's clock "
      + "reads in 0.1 ms steps (it is not cross-origin isolated), so a frame that reads the target is counted with "
      + "those over it: it cannot be shown to be within it.",
    "",
    ...table(
      "phase | arm | commit | sliced re-lights landed | sliced-re-light frames | worst sliced frame ms (work) "
        + `| sliced frames at or over ${SKY_FRAME_TARGET_MS} ms | one-frame re-lights (worst ms)`,
      skyRows,
    ),
    "",
    ...(noRelight.length === 0 ? [] : [
      `**Not exercised:** no sliced re-light landed in the legs of ${noRelight.join(" and ")}, so this run does `
        + `not check the ${SKY_FRAME_TARGET_MS} ms target there. ${SKY_RELIGHT_HOW}`,
      "",
    ]),
    ...(!slicedAny ? [] : over.length === 0
      ? [`No sliced-re-light frame at or over ${SKY_FRAME_TARGET_MS} ms.`, ""]
      : [
        `Sliced-re-light frames at or over ${SKY_FRAME_TARGET_MS} ms (the work, the refresh's ms with the slice's `
          + "and the converter's, and the frame's render() ms):",
        "",
        ...listFrames(over),
        "",
      ]),
    ...(oneFrame.length === 0 ? [] : [
      "One-frame re-lights, outside the target:",
      "",
      ...listFrames(oneFrame),
      "",
    ]),
    ...renderRelights(report.relights),
    `Ground cover: each tile-bake call's ms on the bake's own clock. Target: each within ${GROUND_COVER_CALL_TARGET_MS} ms `
      + "(the 1.5 ms budget and one 32-column step). Pace-floor calls kept baking past the budget to keep the tile's "
      + "pace, by design. A call over the target is not by itself the bake's own overrun: a collection during the "
      + "frame's render() (its heap fell) may have run inside the call, so the calls over it with neither a collection "
      + "nor a pace-floor hold are counted apart, and each call over it is listed with what its frame says. "
      + "perf:flight asks every arm's renderer for the game's height-only terrain sampler, under which the tile bakes "
      + "in 32-column steps; a build without FlightRendererOptions.terrainHeight (before 69746b7) ignores it and "
      + "bakes whole rows on the full sample, as that build's game did.",
    "",
    ...table(
      `phase | arm | commit | tile-bake calls | ms per call p50 / p95 / max | calls at or over ${GROUND_COVER_CALL_TARGET_MS} ms `
        + "| of those, with no collection or pace-floor hold | pace-floor calls | tiles completed",
      coverRows,
    ),
    "",
    ...(overCalls.length === 0 ? [] : [
      `Tile-bake calls at or over ${GROUND_COVER_CALL_TARGET_MS} ms (the call's ms, what its frame says, and the frame's `
        + "render() ms):",
      "",
      ...overCalls.slice(0, LISTED_FRAMES).map(({ arm, call }) =>
        `- ${arm} ${call.phase} frame ${call.frame}: ${fmt(call.ms)} ms${describeCallFlags(call)}, `
          + `render() ${fmt(call.renderMs)} ms`),
      ...(overCalls.length > LISTED_FRAMES ? [`- and ${overCalls.length - LISTED_FRAMES} more (report.json)`] : []),
      "",
    ]),
    ...(noCover.length === 0 ? [] : [
      `**Not exercised:** no tile-bake call in the legs of ${noCover.join(" and ")}, so this run does not check `
        + `the ${GROUND_COVER_CALL_TARGET_MS} ms target there. ${GROUND_COVER_HOW}`,
      "",
    ]),
  ].join("\n");
}
