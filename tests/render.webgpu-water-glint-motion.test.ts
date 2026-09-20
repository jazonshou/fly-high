import { describe, expect, it } from "vitest";
import {
  WATER_GLINT_FACET_LENGTH_METERS,
  WATER_GLINT_TWINKLE_HZ,
  waterFarHash,
  waterGlintCell,
  waterGlintExpectedCount,
  waterGlintTwinkle,
  waterSparkleGain,
} from "../src/render/webgpu/water/WaterShaders";

/**
 * `W-11` — THE MOTION INSTRUMENT.
 *
 * A still frame cannot tell you whether a sparkle is glitter or static.
 * Television static is temporal as much as spatial, and the failure mode that
 * matters is the one a parked screenshot cannot show: a field that is perfectly
 * good standing still and re-rolls completely the moment the camera moves.
 *
 * **The first version of W-11 had exactly that defect and this file is what
 * found it.** It built the cell lattice from the inverse of the fragment's
 * screen-to-world Jacobian, which gives one cell per pixel at any grazing angle
 * and is anchored to nothing: the cell SIZE is a continuous function of range,
 * so a cell boundary at world coordinate p moves by p·(ds/s) whenever the
 * footprint changes. `measures the drift of a continuously scaled lattice`
 * below is that arithmetic, and it reads 29 cells of shift per frame at 500 m
 * in ordinary cruise. The fix is the one the glint literature already uses and
 * for the same reason: quantise the scale.
 *
 * Everything here runs on the CPU mirrors, which are the same arithmetic the
 * WGSL performs (the parity tests pin that), so it measures the shipped rule
 * rather than a model of it — and it needs no GPU, which matters when three
 * sessions share one.
 */

/** The capture's own camera: 1280×720 at 62° horizontal, 120 m up, 12° down. */
const VIEWPORT_WIDTH = 1_280;
const VIEWPORT_HEIGHT = 720;
const HALF_FOV_TANGENT = Math.tan((31 * Math.PI) / 180);
const CAMERA_HEIGHT_METERS = 120;
const PITCH_DOWN_RADIANS = (12 * Math.PI) / 180;
/** Straight and level, the speed a light aircraft crosses water at. */
const CRUISE_METERS_PER_SECOND = 45;
const FRAME_SECONDS = 1 / 60;
/**
 * Far from the origin on purpose: a lattice built by dividing a world
 * coordinate amplifies any scale change by that coordinate's magnitude, so an
 * instrument run near (0,0) cannot see the defect this file exists to catch.
 */
const START_X_METERS = 12_000;
const START_Z_METERS = -8_000;

interface SeaSample {
  readonly worldX: number;
  readonly worldZ: number;
  readonly footprintArea: number;
  readonly footprintMinor: number;
}

/** Where pixel (column, row) lands on still water, and the footprint it covers. */
function traceSea(cameraX: number, column: number, row: number): SeaSample | null {
  const point = (dColumn: number, dRow: number): readonly [number, number] | null => {
    const ndcX = ((column + dColumn + 0.5) / VIEWPORT_WIDTH) * 2 - 1;
    const ndcY = 1 - ((row + dRow + 0.5) / VIEWPORT_HEIGHT) * 2;
    const forward = [Math.cos(PITCH_DOWN_RADIANS), -Math.sin(PITCH_DOWN_RADIANS), 0] as const;
    const up = [Math.sin(PITCH_DOWN_RADIANS), Math.cos(PITCH_DOWN_RADIANS), 0] as const;
    const right = [0, 0, 1] as const;
    const aspect = VIEWPORT_HEIGHT / VIEWPORT_WIDTH;
    const component = (axis: 0 | 1 | 2): number =>
      forward[axis]
      + ndcX * HALF_FOV_TANGENT * right[axis]
      + ndcY * HALF_FOV_TANGENT * aspect * up[axis];
    const rayX = component(0);
    const rayY = component(1);
    const rayZ = component(2);
    if (rayY >= -1e-6) return null;
    const t = CAMERA_HEIGHT_METERS / -rayY;
    return [cameraX + rayX * t, START_Z_METERS + rayZ * t];
  };
  const centre = point(0, 0);
  const alongColumn = point(1, 0);
  const alongRow = point(0, 1);
  if (!centre || !alongColumn || !alongRow) return null;
  const dx = [alongColumn[0] - centre[0], alongColumn[1] - centre[1]] as const;
  const dy = [alongRow[0] - centre[0], alongRow[1] - centre[1]] as const;
  return {
    worldX: centre[0],
    worldZ: centre[1],
    footprintArea: Math.abs(dx[0] * dy[1] - dx[1] * dy[0]),
    footprintMinor: Math.min(Math.hypot(...dx), Math.hypot(...dy)),
  };
}

const FACET_AREA = WATER_GLINT_FACET_LENGTH_METERS ** 2;
const GLINT_SEED = 3;
/** A half-vector near the glitter path's core, and the sea's own roughness. */
const PATH_ALPHA = 0.36;
const SUN_ANGULAR_RADIUS = 0.004675;

function glintAt(sample: SeaSample, time: number): { readonly cell: string; readonly lit: boolean } {
  const cell = waterGlintCell(
    sample.worldX,
    sample.worldZ,
    sample.footprintArea,
    sample.footprintMinor,
    FACET_AREA,
    GLINT_SEED,
  );
  const count = waterGlintExpectedCount(0.999, PATH_ALPHA, SUN_ANGULAR_RADIUS, cell.area);
  const gain = waterGlintTwinkle(
    count,
    cell.cellX,
    cell.cellY,
    time,
    WATER_GLINT_TWINKLE_HZ,
    GLINT_SEED,
  );
  return { cell: `${cell.cellX},${cell.cellY},${cell.area}`, lit: gain > 2 };
}

/**
 * The rule W-11 replaced, reproduced here ONLY as the contrast this file
 * measures against: the draw was hashed on the SCREEN pixel, and the phase was
 * one number for the whole frame. It is not imported because it no longer
 * exists in the renderer.
 */
function shippedScreenGlint(
  column: number,
  row: number,
  sample: SeaSample,
  time: number,
): boolean {
  const count = waterGlintExpectedCount(
    0.999,
    PATH_ALPHA,
    SUN_ANGULAR_RADIUS,
    sample.footprintArea,
  );
  const phaseTime = time * WATER_GLINT_TWINKLE_HZ;
  const phase = Math.floor(phaseTime);
  const t = phaseTime - phase;
  const blend = t * t * (3 - 2 * t);
  const a = waterSparkleGain(count, waterFarHash(column, row, phase * 2 + 1));
  const b = waterSparkleGain(count, waterFarHash(column, row, (phase + 1) * 2 + 1));
  return a + (b - a) * blend > 2;
}

/** Every 7th pixel over the lower half of the frame, which is all sea. */
function sampleGrid(cameraX: number): readonly (SeaSample & { column: number; row: number })[] {
  const samples: (SeaSample & { column: number; row: number })[] = [];
  for (let row = VIEWPORT_HEIGHT / 2; row < VIEWPORT_HEIGHT; row += 7) {
    for (let column = 0; column < VIEWPORT_WIDTH; column += 7) {
      const sample = traceSea(cameraX, column, row);
      if (sample) samples.push({ ...sample, column, row });
    }
  }
  return samples;
}

describe("glint motion coherence", () => {
  it("measures the drift of a continuously scaled lattice — the defect that gated this design", () => {
    // A lattice L = worldXZ / (k · footprint) shifts by L · (ds/s) when the
    // footprint changes. This is the arithmetic, at the shot's own geometry.
    const pixel = 2 * HALF_FOV_TANGENT / VIEWPORT_WIDTH;
    const drift = (range: number): number => {
      const before = START_X_METERS / (range * pixel * 1.5);
      const after = START_X_METERS / ((range - CRUISE_METERS_PER_SECOND * FRAME_SECONDS) * pixel * 1.5);
      return Math.abs(after - before);
    };
    // Tens of cells per frame: every cell id under every pixel changes, every
    // frame, and the whole field re-rolls. A parked screenshot cannot see it.
    expect(drift(500)).toBeGreaterThan(10);
    expect(drift(1_000)).toBeGreaterThan(3);
    // The quantised grid this was replaced by does not move at all between
    // level boundaries, which is the point of quantising it.
  });

  it("divides exactly, because the grid side is a power of two", () => {
    // worldXZ / side with side = 2^k is an exponent shift: exact in binary
    // floating point at any world coordinate the renderer can reach. A grid
    // whose side was the footprint itself would lose bits here, at 10^4 m from
    // the origin, in f32.
    for (const world of [12_000.5, -8_000.25, 98_765.75]) {
      for (const exponent of [-2, -1, 0, 3]) {
        const side = 2 ** exponent;
        expect(Math.fround(Math.fround(world) / side)).toBe(Math.fround(world) / side);
      }
    }
  });

  it("keeps a glint on the water through straight cruise, where the screen hash could not", () => {
    const frames = 8;
    let anchoredPersisted = 0;
    let anchoredLit = 0;
    let screenPersisted = 0;
    let screenLit = 0;
    for (let frame = 0; frame < frames; frame += 1) {
      const time = 500 + frame * FRAME_SECONDS;
      const cameraX = START_X_METERS + frame * CRUISE_METERS_PER_SECOND * FRAME_SECONDS;
      const nextTime = time + FRAME_SECONDS;
      const nextCameraX = cameraX + CRUISE_METERS_PER_SECOND * FRAME_SECONDS;
      for (const sample of sampleGrid(cameraX)) {
        const now = glintAt(sample, time);
        if (now.lit) {
          anchoredLit += 1;
          // Reprojection: the SAME patch of water, seen from the next frame's
          // camera, so the footprint is the next frame's too.
          const reprojected = traceSea(nextCameraX, sample.column, sample.row);
          const followed: SeaSample = {
            worldX: sample.worldX,
            worldZ: sample.worldZ,
            footprintArea: reprojected?.footprintArea ?? sample.footprintArea,
            footprintMinor: reprojected?.footprintMinor ?? sample.footprintMinor,
          };
          if (glintAt(followed, nextTime).lit) anchoredPersisted += 1;
        }
        if (shippedScreenGlint(sample.column, sample.row, sample, time)) {
          screenLit += 1;
          // The old rule hashed the SCREEN pixel, so following the water means
          // the water has moved to a different pixel by the next frame.
          const moved = traceSea(nextCameraX, sample.column, sample.row + 1);
          if (moved && shippedScreenGlint(sample.column, sample.row + 1, moved, nextTime)) {
            screenPersisted += 1;
          }
        }
      }
    }
    expect(anchoredLit).toBeGreaterThan(200);
    expect(screenLit).toBeGreaterThan(200);
    const anchored = anchoredPersisted / anchoredLit;
    const screen = screenPersisted / screenLit;
    // A glint is a world feature and survives the camera moving under it.
    expect(anchored).toBeGreaterThan(0.6);
    // The screen hash re-rolls: a glint's survival is no better than the
    // chance of an unrelated pixel lighting up, which is what static is.
    expect(screen).toBeLessThan(0.25);
    expect(anchored).toBeGreaterThan(screen * 3);
  });

  it("parked, a glint's life is its own clock rather than the frame rate", () => {
    // Jason's screenshot is a parked camera. The old phase was
    // floor(time · rate), ONE number for the whole frame, so every pixel of
    // the sea redrew at the same instant 5.5 times a second. Per-cell phase
    // offsets decorrelate the births; per-cell rate jitter varies the lives.
    const samples = sampleGrid(START_X_METERS).slice(0, 4_000);
    let lives = 0;
    let lifeFrames = 0;
    let previous = samples.map((sample) => glintAt(sample, 500).lit);
    const birthsPerFrame: number[] = [];
    for (let frame = 1; frame < 40; frame += 1) {
      const time = 500 + frame * FRAME_SECONDS;
      let births = 0;
      const current = samples.map((sample, index) => {
        const lit = glintAt(sample, time).lit;
        if (lit && !previous[index]) births += 1;
        if (lit) lifeFrames += 1;
        if (!lit && previous[index]) lives += 1;
        return lit;
      });
      birthsPerFrame.push(births);
      previous = current;
    }
    expect(lives).toBeGreaterThan(20);
    const meanLifeFrames = lifeFrames / lives;
    // A glint lasts several frames — it is a 100-300 ms transient, not a
    // per-frame coin flip. At 60 fps and 5.5 Hz with a ±45% rate jitter that
    // is a handful of frames.
    expect(meanLifeFrames).toBeGreaterThan(2.5);
    expect(meanLifeFrames).toBeLessThan(30);
    // Births are spread across frames rather than arriving in one lockstep
    // burst: no frame carries more than a third of them.
    const totalBirths = birthsPerFrame.reduce((sum, value) => sum + value, 0);
    expect(totalBirths).toBeGreaterThan(20);
    expect(Math.max(...birthsPerFrame) / totalBirths).toBeLessThan(0.34);
  });
});
