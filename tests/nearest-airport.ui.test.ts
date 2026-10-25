import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  AIRPORT_SPAWN_CHECK_INTERVAL_MS,
  AIRPORT_SPAWN_REANCHOR_METERS,
  AirportNetworkController,
  describeNearestAirport,
  type AirportSpawnWorker,
  type NearestAirportInfo,
} from "../src/game/AirportNetworkController";
import { INITIAL_VISUAL_STATE, type FlightVisualState } from "../src/game/types";
import { Hud } from "../src/ui/Hud";
import {
  AIRPORT_MARKER_EDGE_MARGIN,
  airportMarkerSideMargin,
  applyAirportMarker,
  createAirportMarkerPlacement,
  createAirportMarkerView,
  formatAirportDistance,
  placeAirportMarker,
} from "../src/ui/airportMarker";
import {
  AIRPORT_SPAWN_POLICY,
  createWorld,
  type AirportDefinition,
  type WorldDefinition,
} from "../src/world";
import type { AirportSpawnRequest, AirportSpawnResult } from "../src/workers/airportSpawnProtocol";

class FakeSpawnWorker implements AirportSpawnWorker {
  readonly requests: AirportSpawnRequest[] = [];
  private listener: ((event: MessageEvent<AirportSpawnResult>) => void) | null = null;
  terminated = false;

  postMessage(request: AirportSpawnRequest): void {
    this.requests.push(request);
  }

  addEventListener(_type: "message", listener: (event: MessageEvent<AirportSpawnResult>) => void): void {
    this.listener = listener;
  }

  terminate(): void {
    this.terminated = true;
  }

  reply(result: AirportSpawnResult): void {
    this.listener?.({ data: result } as MessageEvent<AirportSpawnResult>);
  }
}

function stateAt(x: number, z: number, heading = 90): FlightVisualState {
  return { ...INITIAL_VISUAL_STATE, position: { x, y: 600, z }, heading };
}

function farFromHome(world: WorldDefinition, extra = 1_000): { x: number; z: number } {
  const home = world.airport!;
  return { x: home.centerX + AIRPORT_SPAWN_POLICY.triggerDistanceMeters + extra, z: home.centerZ };
}

describe("airport network controller", () => {
  it("searches only once the aircraft is past the trigger, at most once a second", () => {
    const world = createWorld("open-skies");
    const worker = new FakeSpawnWorker();
    const controller = new AirportNetworkController(world, () => worker);
    const home = world.airport!;
    controller.observe(stateAt(home.centerX + 2_000, home.centerZ), 0);
    expect(worker.requests).toHaveLength(0);

    const far = farFromHome(world);
    controller.observe(stateAt(far.x, far.z), 100);
    // Throttled: the last check was at t = 0.
    expect(worker.requests).toHaveLength(0);
    controller.observe(stateAt(far.x, far.z), AIRPORT_SPAWN_CHECK_INTERVAL_MS + 1);
    expect(worker.requests).toHaveLength(1);
    expect(worker.requests[0]).toMatchObject({ x: far.x, z: far.z, world });
    expect(worker.requests[0]!.headingRadians).toBeCloseTo(Math.PI / 2, 12);
    // One search in flight at a time.
    controller.observe(stateAt(far.x, far.z), 3 * AIRPORT_SPAWN_CHECK_INTERVAL_MS);
    expect(worker.requests).toHaveLength(1);
  });

  it("installs a found airport once and tells every listener", () => {
    const world = createWorld("open-skies");
    const worker = new FakeSpawnWorker();
    const controller = new AirportNetworkController(world, () => worker);
    const heard: WorldDefinition[] = [];
    controller.onChange((next) => heard.push(next));
    const far = farFromHome(world);
    controller.observe(stateAt(far.x, far.z), 10_000);
    const spawned: AirportDefinition = { ...world.airport!, centerX: far.x, centerZ: far.z + 6_000 };
    worker.reply({ requestId: worker.requests[0]!.requestId, airport: spawned });
    expect(heard).toHaveLength(1);
    expect(controller.world.airports).toHaveLength(2);
    expect(controller.world.airports[1]).toEqual(spawned);
    // A stale or repeated reply changes nothing.
    worker.reply({ requestId: worker.requests[0]!.requestId, airport: spawned });
    expect(heard).toHaveLength(1);
  });

  it("re-anchors only after flying on when a search finds nothing", () => {
    const world = createWorld("open-skies");
    const worker = new FakeSpawnWorker();
    const controller = new AirportNetworkController(world, () => worker);
    const far = farFromHome(world);
    controller.observe(stateAt(far.x, far.z), 10_000);
    worker.reply({ requestId: worker.requests[0]!.requestId, airport: null });
    controller.observe(stateAt(far.x + 500, far.z), 20_000);
    expect(worker.requests).toHaveLength(1);
    controller.observe(stateAt(far.x + AIRPORT_SPAWN_REANCHOR_METERS + 1, far.z), 30_000);
    expect(worker.requests).toHaveLength(2);
  });

  it("never spawns during a crash and stops on dispose", () => {
    const world = createWorld("open-skies");
    const worker = new FakeSpawnWorker();
    const controller = new AirportNetworkController(world, () => worker);
    const far = farFromHome(world);
    controller.observe({ ...stateAt(far.x, far.z), crashed: true }, 10_000);
    expect(worker.requests).toHaveLength(0);
    controller.observe(stateAt(far.x, far.z), 20_000);
    controller.dispose();
    expect(worker.terminated).toBe(true);
  });

  it("describes the nearest airport for the HUD", () => {
    const world = createWorld("open-skies");
    const home = world.airport!;
    const info = describeNearestAirport(world, home.centerX, home.centerZ - 5_000)!;
    expect(info.isHome).toBe(true);
    expect(info.ident).toMatch(/^[A-Z]{4}$/);
    expect(info.runways).toMatch(/^\d{2}\/\d{2}$/);
    expect(info.distanceMeters).toBeCloseTo(5_000, 6);
    // Due north of the query point.
    expect(info.bearingDegrees).toBe(360);
    expect(describeNearestAirport(createWorld("open-skies", { airport: false }), 0, 0)).toBeNull();
  });
});

describe("nearest airport marker", () => {
  const size = { width: 1600, height: 900 };

  it("sits on the airport while it is in view", () => {
    expect(placeAirportMarker({ x: 900, y: 500, inFront: true, ...size }))
      .toMatchObject({ mode: "on", x: 900, y: 500 });
  });

  it("rides the screen edge, pointing the way to turn, when out of view or behind", () => {
    const right = placeAirportMarker({ x: 5_000, y: 450, inFront: true, ...size });
    expect(right.mode).toBe("edge");
    // Inboard of the altitude tape, not on top of it.
    expect(right.x).toBeCloseTo(size.width - airportMarkerSideMargin(size.width), 9);
    expect(airportMarkerSideMargin(size.width)).toBeGreaterThan(146 + 50);
    expect(right.angle).toBeCloseTo(0, 9);
    // Behind and to the left, but projected inside the frame: still the edge.
    const behind = placeAirportMarker({ x: 300, y: 450, inFront: false, ...size });
    expect(behind.mode).toBe("edge");
    expect(behind.x).toBeCloseTo(airportMarkerSideMargin(size.width), 9);
    // Dead astern: point down, "turn around".
    const astern = placeAirportMarker({ x: 800, y: 450, inFront: false, ...size });
    expect(astern.y).toBeCloseTo(size.height - AIRPORT_MARKER_EDGE_MARGIN, 9);
  });

  it("reuses the caller's placement and writes the element only when something changed", () => {
    const scratch = createAirportMarkerPlacement();
    expect(placeAirportMarker({ x: 900, y: 500, inFront: true, ...size }, scratch)).toBe(scratch);

    let transformWrites = 0;
    let angleWrites = 0;
    let textWrites = 0;
    const label = {
      get textContent() { return ""; },
      set textContent(_value: string) { textWrites += 1; },
    };
    const element = {
      hidden: true,
      dataset: {} as Record<string, string>,
      style: {
        set transform(_value: string) { transformWrites += 1; },
        setProperty: () => { angleWrites += 1; },
      },
      querySelector: () => label,
    } as unknown as HTMLElement;
    const view = createAirportMarkerView(element);
    applyAirportMarker(view, scratch, "KQRT · 6.0 NM");
    expect(element.hidden).toBe(false);
    expect(element.dataset.mode).toBe("on");
    expect([transformWrites, angleWrites, textWrites]).toEqual([1, 1, 1]);
    // The same frame again, and a sub-quarter-pixel wobble: no writes.
    applyAirportMarker(view, scratch, "KQRT · 6.0 NM");
    scratch.x += 0.1;
    applyAirportMarker(view, scratch, "KQRT · 6.0 NM");
    expect([transformWrites, angleWrites, textWrites]).toEqual([1, 1, 1]);
    applyAirportMarker(view, null, "");
    expect(element.hidden).toBe(true);
  });

  it("formats distance in the HUD's units", () => {
    expect(formatAirportDistance(1_852 * 4.24, true)).toBe("4.2 NM");
    expect(formatAirportDistance(23_400, false)).toBe("23 KM");
  });
});

describe("nearest airport HUD control", () => {
  const info: NearestAirportInfo = {
    ident: "KQRT",
    isHome: false,
    runways: "05/23",
    distanceMeters: 11_112,
    bearingDegrees: 47,
    markerX: 0,
    markerY: 0,
    markerZ: 0,
  };

  function render(shown: boolean): string {
    return renderToStaticMarkup(createElement(Hud, {
      state: INITIAL_VISUAL_STATE,
      aircraft: "trainer",
      mode: "full",
      flightMode: "pilot",
      units: "aviation",
      diagnostics: null,
      showDiagnostics: false,
      cameraMode: "chase",
      cameraLabel: "CHASE CAM",
      seedLabel: "AUD1T0",
      mouseFlight: false,
      nearestAirport: info,
      nearestAirportShown: shown,
      onToggleNearestAirport: () => undefined,
    }));
  }

  it("offers the toggle and shows the readout only when switched on", () => {
    const off = render(false);
    expect(off).toContain("NEAREST AIRPORT");
    expect(off).toContain('aria-pressed="false"');
    expect(off).not.toContain("KQRT");
    const on = render(true);
    expect(on).toContain('aria-pressed="true"');
    expect(on).toContain("KQRT");
    expect(on).toContain("RWY 05/23");
    expect(on).toContain("BRG 047°");
    expect(on).toContain("6.0 NM");
    expect(on).toContain("N nearest airport");
  });
});
