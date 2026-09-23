import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import type { Mesh } from "@babylonjs/core/Meshes/mesh";
import { Scene } from "@babylonjs/core/scene";
import { describe, expect, it } from "vitest";
import { resolveWebGpuQualityProfile } from "../src/render/webgpu/core/QualityProfile";
import {
  WildlifeSystem,
  type WildlifeAgent,
  type WildlifeObserver,
  type WildlifeTerrainSampler,
} from "../src/render/webgpu/wildlife";
import { TerrainBiome } from "../src/world";

/**
 * The perf harness respawns the wildlife at each shot's time pin.
 *
 * THE DEFECT. The birds in a shot are agent state, integrated on the wildlife
 * system's own fixed-step clock by every render of the run — every earlier
 * shot's streaming, settle and measurement, and this shot's own streaming,
 * whose length is wall-clock paced. So identical code put them in different
 * places run to run: on pinned-ocean repeats with an identical sea, birds
 * alone swung water-400ft-glitter's worst-tile SSIM against its baseline
 * between 0.9784 and 0.9953 (docs/findings/OCEAN_CASCADE_PIN_2026_09_22.md).
 *
 * THE FIX. `FlightRenderer.pinWildlifeForCapture`, called by the harness at the
 * instant it pins simulation time, respawns the population from its per-cell
 * seed and restarts both of the system's clocks.
 *
 * WHAT THIS FILE PROVES. It drives the SHIPPED `WildlifeSystem` — under a
 * NullEngine, so the thin-instance matrices it hands the GPU are real — through
 * the harness's own frame sequence (every render at 1/60 s, the capture 395
 * renders after the pin). Every determinism claim has its unpinned twin beside
 * it as the positive control, and each of the pin's three parts is shown to be
 * necessary: the registered finding was that a clock pin alone would not do it,
 * and on reading the simulation there is a third piece of history besides the
 * clock and the agents — the simulation's own step count.
 */

// Every harness render passes 1/60 s (a scan below holds that).
const FRAME_SECONDS = 1 / 60;
// The harness's render calls from the time pin to the captured frame on a
// static shot (tests/perf/perf-capture.test.ts): 150 settle + 4 drain + 240
// measure + 1.
const FRAMES_FROM_PIN_TO_CAPTURE = 150 + 4 + 240 + 1;
/** The capture's profile: report.json records tier 1, medium, balanced. */
const CAPTURE_PROFILE = resolveWebGpuQualityProfile("medium", "balanced");

/** A coast: open water west of x = 0 (gulls), forest east of it (hawks, deer, boar). */
const coast: WildlifeTerrainSampler = (x, z) => x < 0
  ? { height: -4, slope: 0, biome: TerrainBiome.WATER }
  : {
    height: 40 + Math.sin(x * 0.0021) * 12 + Math.cos(z * 0.0017) * 9,
    slope: 0.06,
    biome: TerrainBiome.FOREST,
  };

/** The shot: 120 m over the water, facing the shore, parked as a static shot is. */
const SHOT: WildlifeObserver = { x: -300, y: 120, z: 150, velocityX: 55, velocityZ: 0 };
/** An earlier shot of the run, somewhere else entirely. */
const EARLIER_SHOT: WildlifeObserver = { x: 6_400, y: 460, z: -5_200, velocityX: 0, velocityZ: 62 };
const ORIGIN = { x: 0, y: 0, z: 0 };

interface Segment {
  readonly observer: WildlifeObserver;
  readonly frames: number;
}

/**
 * Pre-pin histories a real run can give this shot. Streaming loops exit on
 * frame % 30 == 29, so within one shot list histories differ by multiples of
 * 30; a different list (VITE_PERF_SHOTS) also shifts the frame count by the
 * odd per-shot constants (395 static, 1019 motion), hence the odd one.
 */
const HISTORIES: Record<string, readonly Segment[]> = {
  "own streaming 1110": [{ observer: SHOT, frames: 1_110 }],
  "own streaming 1260": [{ observer: SHOT, frames: 1_260 }],
  "earlier shot, then 1110": [
    { observer: EARLIER_SHOT, frames: 1_425 },
    { observer: SHOT, frames: 1_110 },
  ],
  "odd total (another list)": [{ observer: SHOT, frames: 1_111 }],
  "first shot of the run": [],
};

type Internals = {
  agents: WildlifeAgent[];
  populationSignature: string;
  clock: { reset(): void };
  simulation: { restartStepCountForCapture(): void };
};
function internals(system: WildlifeSystem): Internals {
  const inner = system as unknown as Internals;
  // Fail loudly if a rename leaves these partial pins reaching nothing.
  expect(Array.isArray(inner.agents)).toBe(true);
  expect(typeof inner.clock.reset).toBe("function");
  expect(typeof inner.simulation.restartStepCountForCapture).toBe("function");
  return inner;
}

type Pin = (system: WildlifeSystem) => void;
const SHIPPED_PIN: Pin = (system) => system.respawnForCapture();
const NO_PIN: Pin = () => {};

interface CaptureFrame {
  /** Every agent, every field — positions, velocities, headings, phases. */
  readonly agents: string;
  /** What the GPU draws: every wildlife batch's thin-instance matrices. */
  readonly matrices: Record<string, number[]>;
  readonly birds: number;
  readonly birdPositions: ReadonlyMap<string, { x: number; y: number; z: number }>;
}

/** One run of the shipped system: a history, the pin, the frames to capture. */
function captureAfter(
  history: readonly Segment[],
  pin: Pin,
  postPin: (frame: number) => WildlifeObserver = () => SHOT,
  framesToCapture = FRAMES_FROM_PIN_TO_CAPTURE,
): CaptureFrame {
  const engine = new NullEngine();
  const scene = new Scene(engine);
  scene.useRightHandedSystem = true;
  const system = new WildlifeSystem(scene, { worldSeed: "wildlife-capture-pin", terrainSample: coast });
  try {
    for (const segment of history) {
      for (let frame = 0; frame < segment.frames; frame += 1) {
        system.update(segment.observer, ORIGIN, CAPTURE_PROFILE, FRAME_SECONDS);
      }
    }
    pin(system);
    for (let frame = 0; frame < framesToCapture; frame += 1) {
      system.update(postPin(frame), ORIGIN, CAPTURE_PROFILE, FRAME_SECONDS);
    }
    const agents = [...internals(system).agents].sort((a, b) => a.id.localeCompare(b.id));
    const matrices: Record<string, number[]> = {};
    for (const mesh of scene.meshes) {
      if (mesh.metadata?.wildlife !== true) continue;
      matrices[mesh.name] = (mesh as Mesh).thinInstanceGetWorldMatrices()
        .slice(0, (mesh as Mesh).thinInstanceCount)
        .flatMap((matrix) => [...matrix.asArray()]);
    }
    const birdPositions = new Map<string, { x: number; y: number; z: number }>();
    for (const agent of agents) {
      if (agent.kind === "bird") birdPositions.set(agent.id, { ...agent.position });
    }
    return {
      agents: JSON.stringify(agents),
      matrices,
      birds: system.statistics.birdCount,
      birdPositions,
    };
  } finally {
    system.dispose();
    scene.dispose();
    engine.dispose();
  }
}

/** The largest distance any bird present in both frames sits apart. */
function maxBirdSeparation(a: CaptureFrame, b: CaptureFrame): number {
  let worst = 0;
  for (const [id, p] of a.birdPositions) {
    const q = b.birdPositions.get(id);
    if (q) worst = Math.max(worst, Math.hypot(p.x - q.x, p.y - q.y, p.z - q.z));
  }
  return worst;
}

function sameFrame(a: CaptureFrame, b: CaptureFrame): boolean {
  return a.agents === b.agents && JSON.stringify(a.matrices) === JSON.stringify(b.matrices);
}

describe("the capture's birds, before the pin (the positive control)", () => {
  it("are wherever the run's earlier frames flew them", () => {
    const frames = Object.values(HISTORIES).map((history) => captureAfter(history, NO_PIN));
    // Not a test of nothing: the shot has birds, and they are near enough.
    expect(frames[0]!.birds).toBeGreaterThan(20);
    const reference = frames[0]!;
    for (const [index, frame] of frames.entries()) {
      if (index === 0) continue;
      expect(sameFrame(reference, frame), Object.keys(HISTORIES)[index]).toBe(false);
    }
    // Metres apart, not rounding: the same bird is somewhere else.
    expect(maxBirdSeparation(frames[0]!, frames[1]!)).toBeGreaterThan(5);
  });
});

describe("the capture's birds, pinned", () => {
  it("are the same agents and the same drawn matrices whatever came before", () => {
    const [reference, ...others] = Object.entries(HISTORIES).map(
      ([name, history]) => [name, captureAfter(history, SHIPPED_PIN)] as const,
    );
    expect(reference![1].birds).toBeGreaterThan(20);
    for (const [name, frame] of others) {
      expect(frame.agents, name).toBe(reference![1].agents);
      expect(frame.matrices, name).toEqual(reference![1].matrices);
    }
  });

  it("stay the same on a motion shot, which flies on through its frames", () => {
    // Motion shots render 1,019 frames after the pin while the aircraft moves
    // on (24 temporal + a 600-frame drain + the static sequence), crossing
    // cells, so the population is reconciled mid-window. That must still be a
    // function of the pin alone.
    const flying = (frame: number): WildlifeObserver => ({
      ...SHOT,
      x: SHOT.x + (SHOT.velocityX ?? 0) * frame * FRAME_SECONDS,
    });
    const a = captureAfter(HISTORIES["own streaming 1110"]!, SHIPPED_PIN, flying, 1_019);
    const b = captureAfter(HISTORIES["earlier shot, then 1110"]!, SHIPPED_PIN, flying, 1_019);
    const unpinned = captureAfter(HISTORIES["earlier shot, then 1110"]!, NO_PIN, flying, 1_019);
    expect(sameFrame(a, b)).toBe(true);
    expect(sameFrame(a, unpinned)).toBe(false);
  });
});

describe("each part of the pin is needed", () => {
  // A pin that did any one of these alone would pass the pinned test above
  // for none of the histories that matter. Each is run on the pair it must
  // fail on, and must leave the two captures different.
  const partial: Record<string, { pin: Pin; histories: readonly [string, string] }> = {
    // The registered finding: resetting the clock leaves every agent where
    // the run flew it.
    "the clock alone": {
      pin: (system) => internals(system).clock.reset(),
      histories: ["own streaming 1110", "earlier shot, then 1110"],
    },
    "a respawn and the clock, without the step count": {
      pin: (system) => {
        const inner = internals(system);
        inner.agents = [];
        inner.populationSignature = "";
        inner.clock.reset();
      },
      histories: ["own streaming 1110", "own streaming 1260"],
    },
    // Within one shot list the pre-pin histories differ by multiples of 30
    // frames, the 1/60 s renders step the 1/30 s clock in pairs, and the
    // accumulator sits at exactly 0 at the pin either way (measured at
    // 1110/1260, 1110/1140, 14190/15060) — so this part only bites across
    // lists, where the frame count can differ by an odd number.
    "a respawn and the step count, without the clock": {
      pin: (system) => {
        const inner = internals(system);
        inner.agents = [];
        inner.populationSignature = "";
        inner.simulation.restartStepCountForCapture();
      },
      histories: ["own streaming 1110", "odd total (another list)"],
    },
    "the clock and the step count, without a respawn": {
      pin: (system) => {
        const inner = internals(system);
        inner.clock.reset();
        inner.simulation.restartStepCountForCapture();
      },
      histories: ["own streaming 1110", "earlier shot, then 1110"],
    },
  };
  for (const [name, { pin, histories: [first, second] }] of Object.entries(partial)) {
    it(`${name} is not enough`, () => {
      const a = captureAfter(HISTORIES[first]!, pin);
      const b = captureAfter(HISTORIES[second]!, pin);
      expect(sameFrame(a, b)).toBe(false);
      // ...while the shipped pin makes that same pair identical.
      expect(sameFrame(
        captureAfter(HISTORIES[first]!, SHIPPED_PIN),
        captureAfter(HISTORIES[second]!, SHIPPED_PIN),
      )).toBe(true);
    });
  }
});

describe("the pin is capture-only and sits at the time pin", () => {
  const ROOT = fileURLToPath(new URL("..", import.meta.url));
  const rel = (path: string) => relative(ROOT, path).split("\\").join("/");
  const read = (path: string) => readFileSync(join(ROOT, path), "utf8");
  const THIS_FILE = rel(fileURLToPath(import.meta.url));
  function sourceFiles(directory: string): string[] {
    const found: string[] = [];
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name === "artifacts") continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) found.push(...sourceFiles(path));
      else if (/\.(ts|tsx|mts)$/.test(entry.name)) found.push(path);
    }
    return found;
  }
  const PIN_NAMES = /pinWildlifeForCapture|respawnForCapture|restartStepCountForCapture/;
  const count = (text: string, pattern: RegExp) => text.match(new RegExp(pattern, "g"))?.length ?? 0;

  it("under src/, is named only along the renderer -> wildlife -> simulation chain, once per link", () => {
    const allowed = new Set([
      "src/render/FlightRenderer.ts",
      "src/render/webgpu/wildlife/WildlifeSystem.ts",
      "src/render/webgpu/wildlife/simulation.ts",
    ]);
    const offenders = sourceFiles(join(ROOT, "src"))
      .map(rel)
      .filter((path) => !allowed.has(path) && PIN_NAMES.test(read(path)));
    // Mid-flight, a respawn teleports every animal back to its spawn point.
    expect(offenders).toEqual([]);
    // Defined once and called once at each link, so nothing inside the chain
    // (an update path, say) calls it either.
    const renderer = read("src/render/FlightRenderer.ts");
    const system = read("src/render/webgpu/wildlife/WildlifeSystem.ts");
    const simulation = read("src/render/webgpu/wildlife/simulation.ts");
    expect(count(renderer, /pinWildlifeForCapture\(\)/)).toBe(1);
    expect(count(renderer, /respawnForCapture\(\)/)).toBe(1);
    expect(count(system, /respawnForCapture\(\)/)).toBe(1);
    expect(count(system, /restartStepCountForCapture\(\)/)).toBe(1);
    expect(count(simulation, /restartStepCountForCapture\(\)/)).toBe(1);
  });

  it("outside src/, is called by the perf harness alone", () => {
    const callers = [...sourceFiles(join(ROOT, "tests")), ...sourceFiles(join(ROOT, "scripts"))]
      .map(rel)
      .filter((path) => path !== THIS_FILE)
      .filter((path) => PIN_NAMES.test(read(path)));
    expect(callers).toEqual(["tests/perf/perf-capture.test.ts"]);
  });

  it("pins once per shot, after the time pin and before the settle", () => {
    // Before the time pin, the streaming loop would fly the birds on past it;
    // after the first settle frame, the settle would start from history.
    const harness = read("tests/perf/perf-capture.test.ts");
    const timePin = harness.indexOf("simulationTime = 500 + canonicalShotIndex * 120");
    const pin = harness.indexOf("renderer.pinWildlifeForCapture();");
    const settle = harness.indexOf("for (let settle = 0; settle < 150; settle += 1)");
    expect(timePin).toBeGreaterThan(-1);
    expect(pin).toBeGreaterThan(timePin);
    expect(settle).toBeGreaterThan(pin);
    expect(count(harness, /renderer\.pinWildlifeForCapture\(\)/)).toBe(1);
  });

  it("the pinned frames are the ones this file models: every render steps the wildlife at 1/60 s", () => {
    // The wildlife advances by the delta the harness hands `render`, and
    // determinism after the pin rests on it being a constant. A wall-clock
    // delta would make the capture depend on timing again.
    const harness = read("tests/perf/perf-capture.test.ts");
    const renders = harness.match(/renderer\.render\([^;]*\);/g) ?? [];
    expect(renders.length).toBeGreaterThan(0);
    for (const call of renders) expect(call, call).toMatch(/,\s*1 \/ 60\)\s*;$/);
    // And the renderer steps the wildlife on every render: its pass has no
    // cadence or enabled predicate (the frame graph's own frame index is not
    // pinned), and nothing returns early between the pass and the update.
    const renderer = read("src/render/FlightRenderer.ts");
    const name = renderer.indexOf('name: "world-page-visibility"');
    const start = renderer.lastIndexOf("this.graph.register({", name);
    const end = renderer.indexOf("this.graph.register({", name);
    expect(name).toBeGreaterThan(-1);
    const pass = renderer.slice(start, end);
    expect(pass).toContain("this.updateWorldVisibility()");
    expect(pass).not.toMatch(/\b(?:cadence|enabled)\s*[:(,]/);
    const body = renderer.slice(
      renderer.indexOf("private updateWorldVisibility(): void {"),
      renderer.indexOf("this.wildlife.update("),
    );
    expect(body.length).toBeGreaterThan(0);
    expect(body.match(/\breturn\b/g) ?? []).toHaveLength(1); // `if (!state) return;` only
    expect(body).toContain("if (!state) return;");
  });
});
