import { describe, expect, it } from "vitest";
import { HitchWindow } from "../src/render/hitchWindow";

/**
 * The diagnostics' hitch count (PR B part 2b): each interval is judged once,
 * against the threshold it was pushed with, and its verdict leaves the window
 * with it. The renderer's own wiring is tested in render.governor-wiring.
 */

/** What the window should report: the last `capacity` pushes, each against its own threshold. */
function recount(pushes: readonly (readonly [number, number])[], capacity: number): number {
  return pushes.slice(-capacity).filter(([interval, threshold]) => interval > threshold).length;
}

describe("HitchWindow", () => {
  it("keeps each verdict when the threshold moves", () => {
    const window = new HitchWindow(8);
    for (let frame = 0; frame < 4; frame += 1) window.push(33.3, 60);
    expect(window.count).toBe(0);
    for (let frame = 0; frame < 3; frame += 1) window.push(33.3, 27.4);
    expect(window.count).toBe(3);
    window.push(33.3, 60);
    expect(window.count).toBe(3);
  });

  it("counts only intervals above the threshold", () => {
    const window = new HitchWindow(4);
    window.push(27.4, 27.4);
    expect(window.count).toBe(0);
    window.push(27.400001, 27.4);
    expect(window.count).toBe(1);
  });

  it("lets the oldest verdict leave once the window is full", () => {
    const window = new HitchWindow(3);
    window.push(40, 27.4);
    window.push(10, 27.4);
    window.push(40, 27.4);
    expect(window.count).toBe(2);
    window.push(10, 27.4);
    expect(window.count).toBe(1);
    window.push(10, 27.4);
    expect(window.count).toBe(1);
    window.push(10, 27.4);
    expect(window.count).toBe(0);
  });

  it("agrees with a recount of the last pushes, each against its own threshold, through many wraps", () => {
    const capacity = 7;
    const window = new HitchWindow(capacity);
    const pushes: [number, number][] = [];
    let seed = 12_345;
    const next = () => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
      return seed / 2_147_483_648;
    };
    for (let push = 0; push < 200; push += 1) {
      const entry: [number, number] = [5 + next() * 70, next() < 0.5 ? 27.4 : 60];
      pushes.push(entry);
      window.push(entry[0], entry[1]);
      expect(window.count).toBe(recount(pushes, capacity));
    }
  });

  it("clears to an empty window", () => {
    const window = new HitchWindow(2);
    window.push(40, 27.4);
    window.push(40, 27.4);
    window.clear();
    expect(window.count).toBe(0);
    window.push(10, 27.4);
    window.push(40, 27.4);
    expect(window.count).toBe(1);
    window.push(40, 27.4);
    expect(window.count).toBe(2);
  });

  it("holds at least one interval", () => {
    expect(() => new HitchWindow(0)).toThrow(RangeError);
    expect(() => new HitchWindow(1.5)).toThrow(RangeError);
  });
});
