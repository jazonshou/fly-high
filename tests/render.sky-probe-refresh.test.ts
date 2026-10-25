import { afterEach, describe, expect, it, vi } from "vitest";
import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import { RenderTargetTexture } from "@babylonjs/core/Materials/Textures/renderTargetTexture";
import type { SphericalPolynomial } from "@babylonjs/core/Maths/sphericalPolynomial";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { Scene } from "@babylonjs/core/scene";
import { FlightRenderer } from "../src/render/FlightRenderer";
import {
  resolveAerialPerspectiveBinding,
  type AerialPerspectiveBinding,
} from "../src/render/webgpu/atmosphere/AerialPerspective";
import {
  bakeSkyIrradiancePolynomial,
  SKY_IRRADIANCE_SAMPLE_SIZE,
  SkyEnvironmentProbe,
} from "../src/render/webgpu/atmosphere/SkyEnvironmentProbe";
import { resolveEnvironmentState } from "../src/render/webgpu/nature/EnvironmentDirector";
import { bakeReport, type SkyWork } from "../scripts/perfFlightBakes.mts";
import { FlightBakeProbe, type BakeStatsReading } from "./perf/ab/bakeProbe";
import type { FlightFrame } from "./perf/ab/protocol";

/**
 * `FlightRenderer.refreshSkyProbe`, the renderer's own decision of when and
 * how the sky probe re-lights the world, driven frame by frame on a stand-in
 * renderer that carries only the fields it reads (the real method, called
 * through the prototype) and a real SkyEnvironmentProbe on a NullEngine.
 *
 *  - Synchronous (the capture's renderer): the same irradiance, cloud LUT
 *    bindings and specular re-arm frames as the one-frame re-light before
 *    slicing (347f52a), frame for frame.
 *  - Sliced (a flight): the irradiance lands on frame N, the specular cube
 *    re-arms on N+1 and the cloud LUT re-bakes on N+2 from the very snapshot
 *    the irradiance was sampled from; no frame does two of them.
 *  - A one-frame re-light between a landing and its LUT drops the older LUT;
 *    turning synchronous mid-rebake re-lights from the live binding.
 *  - A teleport (an altitude jump past the threshold between two frames)
 *    re-lights at once from the live binding, whether or not a rebake was in
 *    flight; a jump inside the threshold is a drift and is sliced.
 *  - perf:flight's account of it (`tests/perf/ab/bakeProbe.ts`,
 *    `scripts/perfFlightBakes.mts`) reads the renderer's own bookkeeping:
 *    its refresh frame index moves on exactly the frames that did sky work,
 *    with that frame's ms, and the report names each frame's work as the
 *    probe's outputs show it.
 */

const SENTINEL = 777;
const ALBEDO = 0.21;

function createProbe(now?: () => number) {
  const engine = new NullEngine();
  const scene = new Scene(engine);
  const probe = new SkyEnvironmentProbe(scene, new Mesh("sky", scene), now);
  let polynomial: SphericalPolynomial | null = null;
  Object.defineProperty(probe.texture, "sphericalPolynomial", {
    get: () => polynomial,
    set: (value: SphericalPolynomial | null) => { polynomial = value; },
    configurable: true,
  });
  return probe;
}

/** A clock that moves 0.05 ms a read, so a 0.5 ms slice samples a fixed number of rows on any host. */
function fakeClock(): () => number {
  let reads = 0;
  return () => { reads += 1; return reads * 0.05; };
}

const env = resolveEnvironmentState({ clock: { dayOfYear: 171, solarTimeHours: 16 }, latitudeDegrees: 45, weather: "clear" });
const bindingAt = (altitude: number): AerialPerspectiveBinding =>
  resolveAerialPerspectiveBinding(env, altitude, [1, 0.9, 0.8], [0.6, 0.7, 0.9], 0.9);

/** The renderer's fields refreshSkyProbe reads and writes. */
interface Receiver {
  skyProbe: SkyEnvironmentProbe;
  atmosphere: { surfaceAlbedoLuminance: number };
  atmosphereResources: { update: (binding: AerialPerspectiveBinding) => void };
  skyProbeStale: boolean;
  skyProbeAltitudeMeters: number;
  skyRebakeSynchronous: boolean;
  skyRebakeSampled: boolean;
  skyProbeRearmPending: boolean;
  skyProbeCameraAltitudeMeters: number;
  skyAmbientLutPending: AerialPerspectiveBinding | null;
  skyRefreshLastMilliseconds: number;
  skyRefreshMaxMilliseconds: number;
  skyRefreshFrameIndex: number;
  frameIndex: number;
}

function receiver(synchronous: boolean, lut: AerialPerspectiveBinding[]): Receiver {
  return {
    skyProbe: createProbe(fakeClock()),
    atmosphere: { surfaceAlbedoLuminance: ALBEDO },
    atmosphereResources: { update: (binding) => lut.push(binding) },
    skyProbeStale: true,
    skyProbeAltitudeMeters: 0,
    skyRebakeSynchronous: synchronous,
    skyRebakeSampled: false,
    skyProbeRearmPending: false,
    skyProbeCameraAltitudeMeters: Number.NaN,
    skyAmbientLutPending: null,
    skyRefreshLastMilliseconds: 0,
    skyRefreshMaxMilliseconds: 0,
    skyRefreshFrameIndex: -1,
    frameIndex: 0,
  };
}

/** One frame: the renderer's frame index moves, then its refresh runs on `binding`. */
const refresh = (target: Receiver, binding: AerialPerspectiveBinding): void => {
  target.frameIndex += 1;
  (FlightRenderer.prototype as unknown as { refreshSkyProbe(b: AerialPerspectiveBinding): void })
    .refreshSkyProbe.call(target, binding);
};

/** The 347f52a block, verbatim in effect. */
function baseRefresh(state: { stale: boolean; altitude: number; poly: SphericalPolynomial | null; lut: AerialPerspectiveBinding[]; rearms: number }, binding: AerialPerspectiveBinding) {
  if (state.stale || Math.abs(binding.cameraAltitudeMeters - state.altitude) > 500) {
    state.poly = bakeSkyIrradiancePolynomial(binding, SKY_IRRADIANCE_SAMPLE_SIZE, ALBEDO);
    state.rearms += 1;
    state.lut.push(binding);
    state.stale = false;
    state.altitude = binding.cameraAltitudeMeters;
  }
}

describe("refreshSkyProbe", () => {
  // A climb of 7 m a frame: a drift re-light every 72 frames or so.
  const climb = Array.from({ length: 400 }, (_, frame) => bindingAt(100 + frame * 7));

  it("sync: same SH, LUT bindings and re-arm frames as 347f52a, frame for frame", () => {
    const lut: AerialPerspectiveBinding[] = [];
    const head = receiver(true, lut);
    const base = { stale: true, altitude: 0, poly: null as SphericalPolynomial | null, lut: [] as AerialPerspectiveBinding[], rearms: 0 };
    let headRearms = 0;
    for (const binding of climb) {
      head.skyProbe.texture.refreshRate = SENTINEL;
      refresh(head, binding);
      if (head.skyProbe.texture.refreshRate === RenderTargetTexture.REFRESHRATE_RENDER_ONCE) headRearms += 1;
      baseRefresh(base, binding);
      expect(head.skyProbe.texture.sphericalPolynomial).toStrictEqual(base.poly);
      expect(headRearms).toBe(base.rearms);
      expect(lut).toEqual(base.lut);
      expect(lut.every((b, i) => b === base.lut[i])).toBe(true);
      expect(head.skyProbeAltitudeMeters).toBe(base.altitude);
    }
    expect(base.rearms).toBeGreaterThan(3);
  });

  it("sliced: SH on N, cube re-arm on N+1, LUT from the very snapshot on N+2", () => {
    const lut: AerialPerspectiveBinding[] = [];
    const head = receiver(false, lut);
    const log: string[] = [];
    let landed: { frame: number; poly: SphericalPolynomial | null; altitude: number } | null = null;
    let applied = 0;
    for (const [frame, binding] of climb.entries()) {
      head.skyProbe.texture.refreshRate = SENTINEL;
      const lutBefore = lut.length;
      const polyBefore = head.skyProbe.texture.sphericalPolynomial;
      refresh(head, binding);
      const rearmed = head.skyProbe.texture.refreshRate === RenderTargetTexture.REFRESHRATE_RENDER_ONCE;
      const polyChanged = head.skyProbe.texture.sphericalPolynomial !== polyBefore;
      const lutFed = lut.length > lutBefore;
      if (frame > 0 && polyChanged) {
        expect(landed).toBeNull();
        landed = { frame, poly: head.skyProbe.texture.sphericalPolynomial, altitude: head.skyProbeAltitudeMeters };
        expect(rearmed).toBe(false);
        expect(lutFed).toBe(false);
      }
      if (frame > 0 && rearmed) {
        expect(landed!.frame).toBe(frame - 1);
        expect(lutFed).toBe(false);
      }
      if (frame > 0 && lutFed) {
        expect(landed!.frame).toBe(frame - 2);
        const fed = lut[lut.length - 1]!;
        expect(landed!.poly).toStrictEqual(bakeSkyIrradiancePolynomial(fed, SKY_IRRADIANCE_SAMPLE_SIZE, ALBEDO));
        expect(landed!.altitude).toBe(fed.cameraAltitudeMeters);
        expect(head.skyProbeAltitudeMeters).toBe(fed.cameraAltitudeMeters);
        expect(fed).not.toBe(binding);
        expect(fed.cameraAltitudeMeters).toBeLessThan(binding.cameraAltitudeMeters);
        expect(rearmed).toBe(false);
        expect(polyChanged).toBe(false);
        applied += 1;
        landed = null;
      }
      log.push(`${frame}:${polyChanged ? "S" : ""}${lutFed ? "L" : ""}${rearmed ? "R" : ""}`);
    }
    expect(applied).toBeGreaterThan(3);
    // Only the first frame (stale: a one-frame re-light) does more than one.
    const multi = log.filter((entry) => /:..+/.test(entry));
    expect(multi).toEqual(["0:SLR"]);
  });

  it("a one-frame re-light between a landing and its LUT drops the older LUT", () => {
    for (const gap of [1, 2]) {
      const lut: AerialPerspectiveBinding[] = [];
      const head = receiver(false, lut);
      let frame = 1;
      refresh(head, climb[0]!);
      let polyBefore = head.skyProbe.texture.sphericalPolynomial;
      for (; frame < climb.length; frame += 1) {
        refresh(head, climb[frame]!);
        if (head.skyProbe.texture.sphericalPolynomial !== polyBefore) break;
        polyBefore = head.skyProbe.texture.sphericalPolynomial;
      }
      expect(head.skyAmbientLutPending).not.toBeNull();
      // gap 1: the stale re-light on N+1 (with the re-arm); gap 2: on N+2 (instead of the LUT).
      if (gap === 2) refresh(head, climb[frame + 1]!);
      head.skyProbeStale = true;
      const live = climb[frame + gap]!;
      const lutLength = lut.length;
      refresh(head, live);
      expect(lut.length).toBe(lutLength + 1);
      expect(lut[lut.length - 1]).toBe(live);
      for (let after = 1; after < 6; after += 1) refresh(head, climb[frame + gap + after]!);
      expect(lut.length).toBe(lutLength + 1);
      expect(head.skyAmbientLutPending).toBeNull();
    }
  });

  it("turning synchronous mid-rebake re-lights from the live binding in one frame and drops the snapshot", () => {
    const lut: AerialPerspectiveBinding[] = [];
    const head = receiver(false, lut);
    let frame = 0;
    for (; frame < climb.length; frame += 1) {
      refresh(head, climb[frame]!);
      if (head.skyProbe.rebakeInProgress) break;
    }
    expect(head.skyProbe.rebakeInProgress).toBe(true);
    head.skyRebakeSynchronous = true;
    const next = climb[frame + 1]!;
    refresh(head, next);
    expect(head.skyProbe.rebakeInProgress).toBe(false);
    expect(lut[lut.length - 1]).toBe(next);
    expect(head.skyProbeAltitudeMeters).toBe(next.cameraAltitudeMeters);
  });

  it("teleport: a jump past the threshold between two frames re-lights from the live binding at once", () => {
    for (const midRebake of [false, true]) {
      const lut: AerialPerspectiveBinding[] = [];
      const head = receiver(false, lut);
      let frame = 0;
      // Climb until a rebake is in flight (midRebake) or has landed and settled.
      for (; frame < climb.length; frame += 1) {
        refresh(head, climb[frame]!);
        if (midRebake && head.skyProbe.rebakeInProgress) break;
        if (!midRebake && frame > 120 && !head.skyProbe.rebakeInProgress && !head.skyProbeRearmPending) break;
      }
      expect(head.skyProbe.rebakeInProgress).toBe(midRebake);
      const from = climb[frame]!.cameraAltitudeMeters;
      const spawn = bindingAt(from > 1500 ? from - 1200 : from + 1200);
      head.skyProbe.texture.refreshRate = SENTINEL;
      refresh(head, spawn);
      expect(head.skyProbe.rebakeInProgress).toBe(false);
      expect(lut[lut.length - 1]).toBe(spawn);
      expect(head.skyProbeAltitudeMeters).toBe(spawn.cameraAltitudeMeters);
      expect(head.skyProbe.texture.sphericalPolynomial).toStrictEqual(
        bakeSkyIrradiancePolynomial(spawn, SKY_IRRADIANCE_SAMPLE_SIZE, ALBEDO),
      );
      expect(head.skyProbe.texture.refreshRate).toBe(RenderTargetTexture.REFRESHRATE_RENDER_ONCE);
      // And the next frame at the new place does nothing more.
      const lutLength = lut.length;
      head.skyProbe.texture.refreshRate = SENTINEL;
      refresh(head, bindingAt(spawn.cameraAltitudeMeters + 3));
      expect(lut.length).toBe(lutLength);
      expect(head.skyProbe.rebakeInProgress).toBe(false);
    }
  });

  it("a jump inside the threshold is a drift: sliced, as a climb", () => {
    const lut: AerialPerspectiveBinding[] = [];
    const head = receiver(false, lut);
    refresh(head, bindingAt(1000));
    expect(lut.length).toBe(1);
    // 400 m in a frame (no flight does it, but it is under the threshold), then 200 m more of drift.
    refresh(head, bindingAt(1400));
    expect(head.skyProbe.rebakeInProgress).toBe(false);
    refresh(head, bindingAt(1600));
    expect(head.skyProbe.rebakeInProgress).toBe(true);
    expect(lut.length).toBe(1);
  });
});

describe("perf:flight's account of refreshSkyProbe", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("marks exactly the frames that did sky work, with their ms, and names each one's part as the probe shows it", () => {
    // The refresh times itself on performance.now: a clock that moves a fixed
    // step a read, so every frame that does sky work spends more than 0 ms.
    let reads = 0;
    vi.spyOn(performance, "now").mockImplementation(() => { reads += 1; return reads * 0.01; });
    const lut: AerialPerspectiveBinding[] = [];
    const head = receiver(false, lut);
    // A climb, with a teleport 1200 m up half way (a spawn reset).
    const bindings = Array.from({ length: 400 }, (_, frame) => bindingAt(100 + frame * 7 + (frame >= 200 ? 1200 : 0)));
    const reading = (): BakeStatsReading => ({
      sky: { frameIndex: head.skyRefreshFrameIndex, lastMilliseconds: head.skyRefreshLastMilliseconds },
      skyRebake: head.skyProbe.rebakeStats,
      groundCover: { lastMilliseconds: 0, tilesCompleted: 0, paceFloorCalls: 0 },
    });
    const probe = new FlightBakeProbe(reading());
    const truth: (readonly SkyWork[] | null)[] = [];
    const frames: FlightFrame[] = [];
    for (const binding of bindings) {
      // What the probe's outputs show this frame did.
      const polyBefore = head.skyProbe.texture.sphericalPolynomial;
      const lutBefore = lut.length;
      const advancesBefore = head.skyProbe.rebakeStats.advanceCalls;
      const inProgressBefore = head.skyProbe.rebakeInProgress;
      head.skyProbe.texture.refreshRate = SENTINEL;
      refresh(head, binding);
      const polyChanged = head.skyProbe.texture.sphericalPolynomial !== polyBefore;
      const lutFed = lut.length > lutBefore;
      const rearmed = head.skyProbe.texture.refreshRate === RenderTargetTexture.REFRESHRATE_RENDER_ONCE;
      const sliced = head.skyProbe.rebakeStats.advanceCalls > advancesBefore;
      const work: SkyWork[] = [];
      if (polyChanged && lutFed) work.push("one-frame");
      else if (polyChanged) work.push("land");
      else {
        if (rearmed) work.push("cube");
        if (lutFed) work.push("LUT");
        if (sliced) work.push(inProgressBefore ? "advance" : "begin");
      }
      truth.push(work.length > 0 ? work : null);
      // The renderer's bookkeeping: its refresh ran on this frame exactly when it did sky work.
      expect(head.skyRefreshFrameIndex === head.frameIndex).toBe(work.length > 0);
      const bake = probe.observe(reading());
      if (work.length > 0) {
        expect(bake?.skyMs).toBe(head.skyRefreshLastMilliseconds);
        expect(bake!.skyMs).toBeGreaterThan(0);
      } else {
        expect(bake).toBeNull();
      }
      frames.push({
        renderMs: 10, betweenMs: 0, heapRenderBytes: 0, heapBetweenBytes: 0, pipelinesCreated: 0,
        shaderModulesCreated: 0, shaderCodeChars: 0, passMs: {}, bake,
      });
    }
    // The report's names for each frame's work, from the re-lights it followed and the one-frame re-lights.
    const report = bakeReport({
      shas: { base: "base", head: "head" },
      reports: {
        base: [],
        head: [{
          frames, renderCalls: frames.length, elapsedMs: 1_000, longTasks: [], position: { x: 0, y: 0, z: 0 },
          pendingTerrainPages: 0, pendingDetailWork: 0, visibleInstances: 0, residentTerrainPages: 0, detailWorker: null,
        }],
      },
    });
    const named: (readonly SkyWork[] | null)[] = bindings.map(() => null);
    for (const relight of report.relights) {
      for (const entry of relight.frames) {
        if (entry.work[0] !== "after") named[entry.frame] = entry.work as readonly SkyWork[];
      }
    }
    const sky = report.rows.find((entry) => entry.phase === "leg 1" && entry.arm === "head")!.sky!;
    for (const entry of sky.oneFrame) named[entry.frame] = entry.work;
    expect(named).toEqual(truth);
    // The climb re-lit in slices several times, and the stale first frame and the teleport in one frame.
    expect(sky.landed).toBe(truth.filter((work) => work?.includes("land")).length);
    expect(sky.landed).toBeGreaterThan(3);
    expect(sky.oneFrame.map((entry) => entry.frame)).toEqual([0, 200]);
  });
});
