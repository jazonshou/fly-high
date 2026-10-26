import { describe, expect, it, vi } from "vitest";
import {
  BenchRenderer,
  BenchRendererSlot,
  type BenchFramePort,
  type BenchProbedRenderer,
} from "../src/bench/recorder";
import {
  INITIAL_VISUAL_STATE,
  type FlightVisualState,
  type RenderDiagnostics,
} from "../src/game/types";
import type { FlightRenderer, RendererBenchProbe } from "../src/render/FlightRenderer";
import type { FlightRenderingSystem, ScreenPoint } from "../src/render/types";

/**
 * The `?bench=1` renderer decorator, around a fake renderer. FlightGame calls
 * every member of `FlightRenderingSystem`; each must reach the real renderer
 * except the few that would change the measured work mid-flight.
 */

function state(x: number): FlightVisualState {
  return {
    ...INITIAL_VISUAL_STATE,
    position: { ...INITIAL_VISUAL_STATE.position, x },
    velocity: { ...INITIAL_VISUAL_STATE.velocity },
    orientation: { ...INITIAL_VISUAL_STATE.orientation },
    angularVelocity: { ...INITIAL_VISUAL_STATE.angularVelocity },
  };
}

function fakeRenderer() {
  const canvas = { id: "flight-canvas" } as unknown as HTMLCanvasElement;
  const diagnostics = { fps: 60 } as unknown as RenderDiagnostics;
  let frameIndex = 0;
  const calls: string[] = [];
  const inner = {
    domElement: canvas,
    setCameraMode: vi.fn(() => calls.push("setCameraMode")),
    cutCamera: vi.fn(),
    setViewerMode: vi.fn(),
    sampleGroundHeight: vi.fn(() => 12.5),
    setQuality: vi.fn(),
    setRenderingMode: vi.fn(),
    setReducedMotion: vi.fn(),
    setAirports: vi.fn(),
    setPresentationCadence: vi.fn(),
    projectWorldPointToRef: vi.fn(() => true),
    setTerrainAuthorityPublisher: vi.fn(),
    setAtmosphere: vi.fn(),
    render: vi.fn<(state: FlightVisualState, deltaSeconds: number) => void>(() => {
      frameIndex += 1;
      calls.push("render");
    }),
    getDiagnostics: vi.fn(() => diagnostics),
    startBudgetProbe: vi.fn(() => true),
    dispose: vi.fn(() => calls.push("dispose")),
    readBenchProbe: vi.fn((into: RendererBenchProbe) => {
      into.frameIndex = frameIndex;
      into.appliedRenderScale = 0.86;
      into.renderWidth = 1_101;
      into.renderHeight = 619;
      into.pinned = false;
      into.gpuFrameMs = null;
      calls.push("readBenchProbe");
    }),
  };
  return { inner, canvas, diagnostics, calls };
}

function fakePort(scripted: FlightVisualState | null = null) {
  const calls: string[] = [];
  const probes: { frameIndex: number; probe: Readonly<RendererBenchProbe> }[] = [];
  const port = {
    stateFor: vi.fn<(now: number) => FlightVisualState | null>(() => {
      calls.push("stateFor");
      return scripted;
    }),
    afterFrame: vi.fn((_start: number, _end: number, probe: Readonly<RendererBenchProbe>) => {
      calls.push("afterFrame");
      probes.push({ frameIndex: probe.frameIndex, probe });
    }),
    renderThrew: vi.fn(() => calls.push("renderThrew")),
    overhead: vi.fn(() => calls.push("overhead")),
    detached: vi.fn(() => calls.push("detached")),
  } satisfies BenchFramePort;
  return { port, calls, probes };
}

/** A clock that reads 1, 2, 3, ... */
function steppingClock() {
  let now = 0;
  return () => {
    now += 1;
    return now;
  };
}

describe("the bench renderer decorator", () => {
  it("passes every member of the game's renderer interface through before the first frame", () => {
    const { inner, canvas, diagnostics } = fakeRenderer();
    const bench = new BenchRenderer(inner as BenchProbedRenderer, fakePort().port);
    const point: ScreenPoint = { x: 0, y: 0, inFront: false, width: 0, height: 0 };
    const publisher = { publishTerrainPage: vi.fn(), publishTerrainMacro: vi.fn() };
    const clock = { dayOfYear: 171, solarTimeHours: 12.5 };
    const cadence = { frameCapHz: 60, divisor: 2, displayPeriodMs: 1_000 / 120, periodConfirmed: true } as const;

    // Typed against the interface, so a member added to it fails to compile here.
    const exercised: Record<keyof FlightRenderingSystem, () => unknown> = {
      domElement: () => expect(bench.domElement).toBe(canvas),
      setCameraMode: () => bench.setCameraMode("cockpit"),
      cutCamera: () => bench.cutCamera(),
      setViewerMode: () => bench.setViewerMode(true),
      sampleGroundHeight: () => expect(bench.sampleGroundHeight(3, 4)).toBe(12.5),
      setQuality: () => bench.setQuality("low"),
      setRenderingMode: () => bench.setRenderingMode("ultra"),
      setReducedMotion: () => bench.setReducedMotion(true),
      setAirports: () => bench.setAirports([]),
      setPresentationCadence: () => bench.setPresentationCadence(cadence),
      projectWorldPointToRef: () => expect(bench.projectWorldPointToRef(1, 2, 3, point)).toBe(true),
      setTerrainAuthorityPublisher: () => bench.setTerrainAuthorityPublisher(publisher),
      setAtmosphere: () => bench.setAtmosphere(clock, "clear"),
      render: () => undefined,
      getDiagnostics: () => expect(bench.getDiagnostics()).toBe(diagnostics),
      startBudgetProbe: () => undefined,
      dispose: () => undefined,
    };
    for (const run of Object.values(exercised)) run();

    expect(inner.setCameraMode).toHaveBeenCalledWith("cockpit");
    expect(inner.cutCamera).toHaveBeenCalledOnce();
    expect(inner.setViewerMode).toHaveBeenCalledWith(true);
    expect(inner.sampleGroundHeight).toHaveBeenCalledWith(3, 4);
    expect(inner.setQuality).toHaveBeenCalledWith("low");
    expect(inner.setRenderingMode).toHaveBeenCalledWith("ultra");
    expect(inner.setReducedMotion).toHaveBeenCalledWith(true);
    expect(inner.setAirports).toHaveBeenCalledWith([]);
    expect(inner.setPresentationCadence).toHaveBeenCalledWith(cadence);
    expect(inner.projectWorldPointToRef).toHaveBeenCalledWith(1, 2, 3, point);
    expect(inner.setTerrainAuthorityPublisher).toHaveBeenCalledWith(publisher);
    expect(inner.setAtmosphere).toHaveBeenCalledWith(clock, "clear");
    expect(inner.getDiagnostics).toHaveBeenCalledOnce();
    expect(bench.ignoredRendererCalls).toBe(0);
  });

  it("draws the scripted state with FlightGame's delta, and the game's own when there is none", () => {
    const { inner } = fakeRenderer();
    const scripted = state(1_000);
    const game = state(-550);
    const withScript = new BenchRenderer(inner as BenchProbedRenderer, fakePort(scripted).port);
    withScript.render(game, 1 / 60);
    expect(inner.render).toHaveBeenLastCalledWith(scripted, 1 / 60);

    const withoutScript = new BenchRenderer(inner as BenchProbedRenderer, fakePort(null).port);
    withoutScript.render(game, 0.1);
    expect(inner.render).toHaveBeenLastCalledWith(game, 0.1);
  });

  it("draws nothing once the port holds its frames, so the next page can load", () => {
    const { inner } = fakeRenderer();
    const { port, calls } = fakePort(state(0));
    let holding = false;
    const bench = new BenchRenderer(inner as BenchProbedRenderer, { ...port, holdFrames: () => holding });
    bench.render(state(0), 1 / 60);
    holding = true;
    bench.render(state(0), 1 / 60);
    bench.render(state(0), 1 / 60);
    expect(inner.render).toHaveBeenCalledTimes(1);
    expect(bench.frames).toBe(1);
    expect(calls).toEqual(["stateFor", "afterFrame", "overhead"]);
  });

  it("times the inner render alone, reads the probe after it, and reports its own overhead", () => {
    const { inner, calls: innerCalls } = fakeRenderer();
    const { port, calls, probes } = fakePort(state(0));
    const bench = new BenchRenderer(inner as BenchProbedRenderer, port, steppingClock());
    innerCalls.length = 0;

    bench.render(state(0), 1 / 60);

    // stateFor at 1; render from 2 to 3; overhead = (4 - 3) + (2 - 1).
    expect(port.stateFor).toHaveBeenCalledWith(1);
    expect(port.afterFrame).toHaveBeenCalledWith(2, 3, expect.anything());
    expect(port.overhead).toHaveBeenCalledWith(2);
    expect(calls).toEqual(["stateFor", "afterFrame", "overhead"]);
    expect(innerCalls).toEqual(["render", "readBenchProbe"]);
    expect(probes[0]!.frameIndex).toBe(1);
    expect(bench.frames).toBe(1);
  });

  it("hands the port one probe object, rewritten every frame", () => {
    const { inner } = fakeRenderer();
    const { port, probes } = fakePort();
    const bench = new BenchRenderer(inner as BenchProbedRenderer, port);
    bench.render(state(0), 1 / 60);
    bench.render(state(0), 1 / 60);
    bench.render(state(0), 1 / 60);

    expect(probes.map((entry) => entry.frameIndex)).toEqual([1, 2, 3]);
    expect(new Set(probes.map((entry) => entry.probe)).size).toBe(1);
    expect(probes[0]!.probe.renderWidth).toBe(1_101);
  });

  it("drops and counts calls that would change the work once the first frame has started", () => {
    const { inner } = fakeRenderer();
    const bench = new BenchRenderer(inner as BenchProbedRenderer, fakePort().port);
    bench.setQuality("medium");
    bench.render(state(0), 1 / 60);

    bench.setQuality("high");
    bench.setRenderingMode("performance");
    bench.setReducedMotion(true);
    bench.setAtmosphere({ dayOfYear: 1, solarTimeHours: 22 }, "cloudy");
    bench.setViewerMode(true);
    bench.setCameraMode("cockpit");
    bench.setCameraMode("chase");
    bench.cutCamera();
    bench.setAirports([]);
    bench.setPresentationCadence(null);

    expect(inner.setQuality).toHaveBeenCalledExactlyOnceWith("medium");
    expect(inner.setRenderingMode).not.toHaveBeenCalled();
    expect(inner.setReducedMotion).not.toHaveBeenCalled();
    expect(inner.setAtmosphere).not.toHaveBeenCalled();
    expect(inner.setViewerMode).not.toHaveBeenCalled();
    expect(inner.setCameraMode).toHaveBeenCalledExactlyOnceWith("chase");
    expect(inner.cutCamera).toHaveBeenCalledOnce();
    expect(inner.setAirports).toHaveBeenCalledOnce();
    // The pacer's cadence is what a player's game does: never swallowed.
    expect(inner.setPresentationCadence).toHaveBeenCalledExactlyOnceWith(null);
    expect(bench.ignoredRendererCalls).toBe(6);
    expect(bench.ignoredCalls).toEqual({
      setQuality: 1,
      setRenderingMode: 1,
      setReducedMotion: 1,
      setAtmosphere: 1,
      setViewerMode: 1,
      setCameraMode: 1,
    });
  });

  it("never starts the budget probe", () => {
    const { inner } = fakeRenderer();
    const bench = new BenchRenderer(inner as BenchProbedRenderer, fakePort().port);
    expect(bench.startBudgetProbe()).toBe(false);
    expect(inner.startBudgetProbe).not.toHaveBeenCalled();
    expect(bench.ignoredCalls).toEqual({ startBudgetProbe: 1 });
  });

  it("records a frame that throws and rethrows the same error to FlightGame", () => {
    const { inner } = fakeRenderer();
    const failure = new Error("The WebGPU device was lost; rendering cannot continue");
    inner.render.mockImplementationOnce(() => {
      throw failure;
    });
    const { port, calls } = fakePort();
    const bench = new BenchRenderer(inner as BenchProbedRenderer, port);

    expect(() => bench.render(state(0), 1 / 60)).toThrow(failure);
    expect(port.renderThrew).toHaveBeenCalledExactlyOnceWith(failure);
    expect(calls).toEqual(["stateFor", "renderThrew"]);
    expect(bench.frames).toBe(0);
  });

  it("rethrows the renderer's error even when the port fails to record it", () => {
    const { inner } = fakeRenderer();
    const failure = new Error("frame failed");
    inner.render.mockImplementationOnce(() => {
      throw failure;
    });
    const { port } = fakePort();
    port.renderThrew.mockImplementationOnce(() => {
      throw new Error("bench bug");
    });
    const bench = new BenchRenderer(inner as BenchProbedRenderer, port);
    expect(() => bench.render(state(0), 1 / 60)).toThrow(failure);
  });

  it("detaches the port before disposing the renderer, then draws the game's own state", () => {
    const { inner, calls: innerCalls } = fakeRenderer();
    const { port, calls } = fakePort(state(9));
    const bench = new BenchRenderer(inner as BenchProbedRenderer, port);
    const order: string[] = [];
    port.detached.mockImplementation(() => order.push("detached"));
    inner.dispose.mockImplementation(() => order.push("dispose"));

    bench.dispose();
    expect(order).toEqual(["detached", "dispose"]);
    expect(bench.attached).toBe(false);

    calls.length = 0;
    innerCalls.length = 0;
    const game = state(-1);
    bench.render(game, 1 / 60);
    expect(inner.render).toHaveBeenLastCalledWith(game, 1 / 60);
    expect(calls).toEqual([]);
    bench.detach();
    expect(port.detached).toHaveBeenCalledOnce();
  });
});

describe("the bench renderer slot", () => {
  it("takes the game's real renderer", () => {
    // A compile-time check: FlightRenderer is what FlightGame will hand over.
    const accepts = (renderer: FlightRenderer): BenchProbedRenderer => renderer;
    expect(accepts).toBeTypeOf("function");
  });

  it("follows the latest renderer when StrictMode creates a second", () => {
    const slot = new BenchRendererSlot();
    const first = fakeRenderer();
    const firstPort = fakePort();
    const a = slot.attach(first.inner as BenchProbedRenderer, () => firstPort.port);
    expect(slot.attached).toBe(a);

    const second = fakeRenderer();
    const secondPort = fakePort();
    const b = slot.attach(second.inner as BenchProbedRenderer, () => secondPort.port);
    expect(firstPort.port.detached).toHaveBeenCalledOnce();
    expect(slot.attached).toBe(b);

    a.render(state(0), 1 / 60);
    b.render(state(0), 1 / 60);
    expect(firstPort.port.afterFrame).not.toHaveBeenCalled();
    expect(secondPort.port.afterFrame).toHaveBeenCalledOnce();

    // The first renderer is disposed by FlightGame's cleanup; the second carries on.
    a.dispose();
    expect(slot.attached).toBe(b);
    b.dispose();
    expect(slot.attached).toBeNull();
  });

  it("disposes the renderer it was given when attaching fails", () => {
    const slot = new BenchRendererSlot();
    const { inner } = fakeRenderer();
    const failure = new Error("path precompute failed");
    expect(() => slot.attach(inner as BenchProbedRenderer, () => {
      throw failure;
    })).toThrow(failure);
    expect(inner.dispose).toHaveBeenCalledOnce();
    expect(slot.attached).toBeNull();
  });

  it("reports the attach error even when disposing also fails", () => {
    const slot = new BenchRendererSlot();
    const { inner } = fakeRenderer();
    inner.dispose.mockImplementation(() => {
      throw new Error("dispose failed");
    });
    const failure = new Error("attach failed");
    expect(() => slot.attach(inner as BenchProbedRenderer, () => {
      throw failure;
    })).toThrow(failure);
  });
});
