import type { WorldDefinition } from "../types";
import type { RoadClassSpec } from "./roadClasses";
import { ROAD_GROUND_COST, roadGroundAt, roadGroundHeight, type RoadGroundId } from "./roadTerrain";

/**
 * A* routing of one edge over a cost grid on the ground before every
 * earthwork.
 *
 * THE GRID is the edge's own: origin at its start, axes along and across the
 * straight line, square cells of the class's routing grid. So a route is a
 * pure function of the edge (its ends and class) and of the world, never of
 * the region that asked for it or of what was routed before.
 *
 * COARSE, THEN FINE. A first pass at `coarseFactor` cells over the whole
 * corridor finds the line; a second at the fine grid, inside a band two
 * coarse cells either side of it, finds the road. Each move between cells
 * (16 directions: the king's and the knight's) costs its length times
 *
 *   1 + grade term + side-slope term + ground term
 *
 * where the grade term grows gently up to the class's maximum and steeply
 * past it (the cut and fill a too-steep line needs), the side-slope term
 * charges a hillside's bench, and the ground term is the class's dislike of
 * sand, lava and snow; water and the home airport are walls.
 *
 * `penalty` (metres of extra cost per metre, by fine cell) lets the caller
 * steer a retry away from where the last route needed too deep a fill.
 */

export interface RoadRoute {
  /** Fine-grid route, world metres, from the edge's start to its end (both exact). */
  readonly x: Float64Array;
  readonly z: Float64Array;
  /** A* settled cells, both passes (the probe's work count). */
  readonly expanded: number;
  /** Ground samples taken, both passes. */
  readonly samples: number;
}

export interface RoadRouteRequest {
  readonly world: WorldDefinition;
  readonly spec: RoadClassSpec;
  readonly ax: number;
  readonly az: number;
  readonly bx: number;
  readonly bz: number;
  /** Half width of the corridor round the straight line, metres. */
  readonly corridor: number;
  /** Extra cost per metre in the fine pass, keyed by world position (a retry's steer). */
  readonly penalty?: (x: number, z: number) => number;
}

/** 16 moves: king's and knight's. */
const MOVES: readonly (readonly [number, number])[] = Object.freeze([
  [1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1],
  [2, 1], [2, -1], [-2, 1], [-2, -1], [1, 2], [1, -2], [-1, 2], [-1, -2],
].map((move) => Object.freeze(move) as readonly [number, number]));

const MOVE_LENGTH = MOVES.map(([di, dj]) => Math.hypot(di, dj));

/** Grade cost: gentle to the class's maximum, steep past it; never past `GRADE_WALL` times it. */
const GRADE_SOFT = 0.3;
const GRADE_HARD = 12;
const GRADE_WALL = 2.5;
/** Side slope a bench is cheap on, and the face past which no bench is built. */
const SIDE_SOFT = 0.25;
const SIDE_COST = 3;
const SIDE_WALL = 1.2;

/** A min-heap of cell indices keyed by f, ties by index: deterministic. */
class CellHeap {
  private cells = new Int32Array(256);
  private keys = new Float64Array(256);
  size = 0;

  clear(): void {
    this.size = 0;
  }

  push(cell: number, key: number): void {
    if (this.size === this.cells.length) {
      const cells = new Int32Array(this.size * 2);
      const keys = new Float64Array(this.size * 2);
      cells.set(this.cells);
      keys.set(this.keys);
      this.cells = cells;
      this.keys = keys;
    }
    let i = this.size;
    this.size += 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (!this.less(cell, key, this.cells[parent]!, this.keys[parent]!)) break;
      this.cells[i] = this.cells[parent]!;
      this.keys[i] = this.keys[parent]!;
      i = parent;
    }
    this.cells[i] = cell;
    this.keys[i] = key;
  }

  /** Pops the minimum; returns its cell. */
  pop(): number {
    const top = this.cells[0]!;
    this.size -= 1;
    if (this.size > 0) {
      const cell = this.cells[this.size]!;
      const key = this.keys[this.size]!;
      let i = 0;
      for (;;) {
        const left = 2 * i + 1;
        if (left >= this.size) break;
        const right = left + 1;
        let child = left;
        if (right < this.size && this.less(this.cells[right]!, this.keys[right]!, this.cells[left]!, this.keys[left]!)) {
          child = right;
        }
        if (!this.less(this.cells[child]!, this.keys[child]!, cell, key)) break;
        this.cells[i] = this.cells[child]!;
        this.keys[i] = this.keys[child]!;
        i = child;
      }
      this.cells[i] = cell;
      this.keys[i] = key;
    }
    return top;
  }

  private less(cellA: number, keyA: number, cellB: number, keyB: number): boolean {
    return keyA < keyB || (keyA === keyB && cellA < cellB);
  }
}

/**
 * One pass over a grid in the edge's frame: cells (i, j) at a + i*h*u + j*h*v,
 * i in [iMin, iMax], j in [jMin, jMax], restricted to `allowed` cells.
 */
class GridPass {
  readonly width: number;
  readonly height: number;
  readonly heights: Float64Array;
  readonly ground: Uint8Array;
  /** The caller's penalty per cell, NaN until read. */
  readonly extra: Float64Array;
  samples = 0;

  constructor(
    readonly world: WorldDefinition,
    readonly ax: number,
    readonly az: number,
    readonly ux: number,
    readonly uz: number,
    readonly h: number,
    readonly iMin: number,
    readonly iMax: number,
    readonly jMin: number,
    readonly jMax: number,
  ) {
    this.width = iMax - iMin + 1;
    this.height = jMax - jMin + 1;
    const count = this.width * this.height;
    this.heights = new Float64Array(count).fill(Number.NaN);
    this.ground = new Uint8Array(count).fill(255);
    this.extra = new Float64Array(count).fill(Number.NaN);
  }

  penaltyAt(i: number, j: number, penalty: (x: number, z: number) => number): number {
    const k = this.index(i, j);
    let value = this.extra[k]!;
    if (value !== value) {
      value = penalty(this.worldX(i, j), this.worldZ(i, j));
      this.extra[k] = value;
    }
    return value;
  }

  index(i: number, j: number): number {
    return (j - this.jMin) * this.width + (i - this.iMin);
  }

  contains(i: number, j: number): boolean {
    return i >= this.iMin && i <= this.iMax && j >= this.jMin && j <= this.jMax;
  }

  worldX(i: number, j: number): number {
    // v = (uz, -ux): right of a->b seen from above.
    return this.ax + (i * this.ux + j * this.uz) * this.h;
  }

  worldZ(i: number, j: number): number {
    return this.az + (i * this.uz - j * this.ux) * this.h;
  }

  heightAt(i: number, j: number): number {
    const k = this.index(i, j);
    let value = this.heights[k]!;
    if (value !== value) {
      value = roadGroundHeight(this.world, this.worldX(i, j), this.worldZ(i, j));
      this.heights[k] = value;
      this.samples += 1;
    }
    return value;
  }

  groundAt(i: number, j: number): RoadGroundId {
    const k = this.index(i, j);
    let value = this.ground[k]!;
    if (value === 255) {
      value = roadGroundAt(this.world, this.worldX(i, j), this.worldZ(i, j), this.heightAt(i, j));
      this.ground[k] = value;
    }
    return value as RoadGroundId;
  }

  /** Ground gradient in the edge frame (d/du, d/dv), from neighbouring cells inside the grid. */
  gradient(i: number, j: number, out: [number, number]): [number, number] {
    const iL = Math.max(this.iMin, i - 1);
    const iR = Math.min(this.iMax, i + 1);
    const jL = Math.max(this.jMin, j - 1);
    const jR = Math.min(this.jMax, j + 1);
    out[0] = iR > iL ? (this.heightAt(iR, j) - this.heightAt(iL, j)) / ((iR - iL) * this.h) : 0;
    out[1] = jR > jL ? (this.heightAt(i, jR) - this.heightAt(i, jL)) / ((jR - jL) * this.h) : 0;
    return out;
  }
}

const GRADIENT: [number, number] = [0, 0];

/** Cost of moving between two cells, or Infinity. */
function moveCost(
  pass: GridPass,
  spec: RoadClassSpec,
  i0: number,
  j0: number,
  move: number,
  penalty: ((x: number, z: number) => number) | undefined,
): number {
  const [di, dj] = MOVES[move]!;
  const i1 = i0 + di;
  const j1 = j0 + dj;
  const ground = pass.groundAt(i1, j1);
  const groundCost = ROAD_GROUND_COST[ground];
  if (!Number.isFinite(groundCost)) return Number.POSITIVE_INFINITY;
  // A knight's move jumps a cell: it must not jump a wall.
  if (Math.abs(di) + Math.abs(dj) === 3) {
    const mi = i0 + Math.round(di / 2);
    const mj = j0 + Math.round(dj / 2);
    if (!Number.isFinite(ROAD_GROUND_COST[pass.groundAt(mi, mj)])) return Number.POSITIVE_INFINITY;
  }
  const length = MOVE_LENGTH[move]! * pass.h;
  const grade = Math.abs(pass.heightAt(i1, j1) - pass.heightAt(i0, j0)) / length;
  const limit = spec.maxGrade;
  if (grade > GRADE_WALL * limit) return Number.POSITIVE_INFINITY;
  const g = grade / limit;
  const gradeCost = g <= 1 ? GRADE_SOFT * g * g : GRADE_SOFT + GRADE_HARD * (g - 1);
  pass.gradient(i1, j1, GRADIENT);
  // Side slope: the gradient across the direction of travel.
  const norm = MOVE_LENGTH[move]!;
  const side = Math.abs((GRADIENT[0] * -dj + GRADIENT[1] * di) / norm);
  if (side > SIDE_WALL) return Number.POSITIVE_INFINITY;
  const sideCost = side > SIDE_SOFT ? SIDE_COST * (side - SIDE_SOFT) : 0;
  let extra = 0;
  if (penalty) extra = pass.penaltyAt(i1, j1, penalty);
  return length * (1 + gradeCost + sideCost + groundCost + extra);
}

/**
 * A* over a pass from (si, sj) to (gi, gj); `allowed` (by pass index) limits
 * the cells, null allowing all. Returns the cell path, start to goal, or null.
 */
function search(
  pass: GridPass,
  spec: RoadClassSpec,
  si: number,
  sj: number,
  gi: number,
  gj: number,
  allowed: Uint8Array | null,
  penalty: ((x: number, z: number) => number) | undefined,
  stats: { expanded: number },
): Int32Array | null {
  const count = pass.width * pass.height;
  const cost = new Float64Array(count).fill(Number.POSITIVE_INFINITY);
  const from = new Int32Array(count).fill(-1);
  const closed = new Uint8Array(count);
  const heap = new CellHeap();
  const start = pass.index(si, sj);
  const goal = pass.index(gi, gj);
  const gx = pass.worldX(gi, gj);
  const gz = pass.worldZ(gi, gj);
  const heuristic = (i: number, j: number) => Math.hypot(pass.worldX(i, j) - gx, pass.worldZ(i, j) - gz);
  cost[start] = 0;
  heap.push(start, heuristic(si, sj));
  while (heap.size > 0) {
    const cell = heap.pop();
    if (closed[cell]) continue;
    closed[cell] = 1;
    stats.expanded += 1;
    if (cell === goal) break;
    const i0 = (cell % pass.width) + pass.iMin;
    const j0 = Math.floor(cell / pass.width) + pass.jMin;
    for (let move = 0; move < MOVES.length; move += 1) {
      const i1 = i0 + MOVES[move]![0];
      const j1 = j0 + MOVES[move]![1];
      if (!pass.contains(i1, j1)) continue;
      const next = pass.index(i1, j1);
      if (closed[next] || (allowed && !allowed[next])) continue;
      const step = moveCost(pass, spec, i0, j0, move, penalty);
      if (!Number.isFinite(step)) continue;
      const candidate = cost[cell]! + step;
      if (candidate < cost[next]!) {
        cost[next] = candidate;
        from[next] = cell;
        heap.push(next, candidate + heuristic(i1, j1));
      }
    }
  }
  if (!closed[goal]) return null;
  const path: number[] = [];
  for (let cell = goal; cell !== -1; cell = from[cell]!) path.push(cell);
  path.reverse();
  return Int32Array.from(path);
}

/** Mark every cell of `pass` within `radius` metres of the polyline. */
function bandMask(pass: GridPass, x: Float64Array, z: Float64Array, radius: number): Uint8Array {
  const mask = new Uint8Array(pass.width * pass.height);
  const h = pass.h;
  for (let s = 0; s + 1 < x.length; s += 1) {
    // The segment in the pass's (u, v) cell coordinates.
    const toU = (px: number, pz: number) => ((px - pass.ax) * pass.ux + (pz - pass.az) * pass.uz) / h;
    const toV = (px: number, pz: number) => ((px - pass.ax) * pass.uz - (pz - pass.az) * pass.ux) / h;
    const u0 = toU(x[s]!, z[s]!);
    const v0 = toV(x[s]!, z[s]!);
    const u1 = toU(x[s + 1]!, z[s + 1]!);
    const v1 = toV(x[s + 1]!, z[s + 1]!);
    const r = radius / h;
    const iLo = Math.max(pass.iMin, Math.floor(Math.min(u0, u1) - r));
    const iHi = Math.min(pass.iMax, Math.ceil(Math.max(u0, u1) + r));
    const jLo = Math.max(pass.jMin, Math.floor(Math.min(v0, v1) - r));
    const jHi = Math.min(pass.jMax, Math.ceil(Math.max(v0, v1) + r));
    const du = u1 - u0;
    const dv = v1 - v0;
    const lengthSquared = du * du + dv * dv;
    for (let j = jLo; j <= jHi; j += 1) {
      for (let i = iLo; i <= iHi; i += 1) {
        const t = lengthSquared > 0 ? Math.min(1, Math.max(0, ((i - u0) * du + (j - v0) * dv) / lengthSquared)) : 0;
        if (Math.hypot(i - (u0 + du * t), j - (v0 + dv * t)) <= r) mask[pass.index(i, j)] = 1;
      }
    }
  }
  return mask;
}

function pathPoints(pass: GridPass, path: Int32Array, request: RoadRouteRequest): { x: Float64Array; z: Float64Array } {
  const x = new Float64Array(path.length);
  const z = new Float64Array(path.length);
  for (let k = 0; k < path.length; k += 1) {
    const cell = path[k]!;
    const i = (cell % pass.width) + pass.iMin;
    const j = Math.floor(cell / pass.width) + pass.jMin;
    x[k] = pass.worldX(i, j);
    z[k] = pass.worldZ(i, j);
  }
  // The ends exactly on the nodes (the goal cell is within half a cell of b).
  x[0] = request.ax;
  z[0] = request.az;
  x[path.length - 1] = request.bx;
  z[path.length - 1] = request.bz;
  return { x, z };
}

/** Coarse cells behind the start and past the end a route may use (a switchback at a node). */
const ROUTE_OVERSHOOT_CELLS = 2;

/** The coarse grid an edge routes on, in coarse cells: across (each side), past the ends, and to the goal. */
export function roadRouteGrid(spec: RoadClassSpec, length: number, corridor: number): {
  readonly wide: number;
  readonly over: number;
  readonly goal: number;
  readonly coarse: number;
} {
  const coarse = spec.routingGrid * spec.coarseFactor;
  return {
    wide: Math.max(2, Math.ceil(corridor / coarse)),
    over: ROUTE_OVERSHOOT_CELLS,
    goal: Math.max(1, Math.round(length / coarse)),
    coarse,
  };
}

/** How far smoothing may move a route's points before the curves are fitted: one fine cell. */
export function roadRouteRelaxShift(spec: RoadClassSpec): number {
  return spec.routingGrid;
}

/**
 * The farthest a road's centreline can lie from its edge's straight segment,
 * metres: the corner of the grid both passes share (the fine pass never
 * leaves the coarse grid's rectangle), a fine cell for the goal cell's
 * rounding, the smoothing's shift, and a fine cell more for the curve fit.
 * The network drops any edge whose fitted line strays past it, so the bound
 * holds by construction.
 */
export function roadRouteDeviationLimit(spec: RoadClassSpec, length: number, corridor: number): number {
  const grid = roadRouteGrid(spec, length, corridor);
  return grid.coarse * Math.hypot(grid.over, grid.wide) + 2 * spec.routingGrid + roadRouteRelaxShift(spec);
}

/** Route an edge; null when no route exists inside its corridor. */
export function routeRoadEdge(request: RoadRouteRequest): RoadRoute | null {
  const { world, spec, ax, az, bx, bz, corridor } = request;
  const length = Math.hypot(bx - ax, bz - az);
  if (!(length > 0)) return null;
  const ux = (bx - ax) / length;
  const uz = (bz - az) / length;
  const stats = { expanded: 0 };
  const grid = roadRouteGrid(spec, length, corridor);
  const coarse = grid.coarse;

  // Coarse: the whole corridor, a little past each end for a switchback there.
  const coarsePass = new GridPass(world, ax, az, ux, uz, coarse, -grid.over, grid.goal + grid.over, -grid.wide, grid.wide);
  const coarsePath = search(coarsePass, spec, 0, 0, grid.goal, 0, null, undefined, stats);
  if (!coarsePath) return null;
  const coarsePoints = pathPoints(coarsePass, coarsePath, request);

  // Fine: a band two coarse cells either side of the coarse route, inside
  // the coarse grid's own rectangle (so `roadRouteDeviationLimit` holds).
  const fine = spec.routingGrid;
  const ratio = spec.coarseFactor;
  const fGoal = Math.max(1, Math.round(length / fine));
  const finePass = new GridPass(
    world, ax, az, ux, uz, fine,
    -grid.over * ratio, (grid.goal + grid.over) * ratio, -grid.wide * ratio, grid.wide * ratio,
  );
  const mask = bandMask(finePass, coarsePoints.x, coarsePoints.z, 2 * coarse);
  // The ends are always allowed.
  mask[finePass.index(0, 0)] = 1;
  mask[finePass.index(fGoal, 0)] = 1;
  const finePath = search(finePass, spec, 0, 0, fGoal, 0, mask, request.penalty, stats);
  if (!finePath) return null;
  const points = pathPoints(finePass, finePath, request);
  return {
    x: points.x,
    z: points.z,
    expanded: stats.expanded,
    samples: coarsePass.samples + finePass.samples,
  };
}
