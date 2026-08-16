import { describe, expect, it } from "vitest";
import { isFlightShortcutTargetInteractive } from "../src/input";
import {
  beginTransition,
  createTransitionGate,
  invalidateTransitions,
  isCurrentTransition,
} from "../src/game/transitionGate";
import { modalTabTarget } from "../src/ui/modalFocus";

function keyboardTarget(
  tagName: string,
  attributes: Record<string, string> = {},
): EventTarget {
  return {
    tagName,
    isContentEditable: false,
    getAttribute: (name: string) => attributes[name] ?? null,
    closest: () => null,
  } as unknown as EventTarget;
}

describe("flight UI lifecycle primitives", () => {
  it("allows only the latest asynchronous transition to commit", async () => {
    const gate = createTransitionGate();
    const committed: string[] = [];
    let releaseFirst: () => void = () => {};
    let releaseSecond: () => void = () => {};
    const firstWait = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const secondWait = new Promise<void>((resolve) => { releaseSecond = resolve; });
    const run = async (name: string, waiting: Promise<void>) => {
      const token = beginTransition(gate);
      await waiting;
      if (isCurrentTransition(gate, token)) committed.push(name);
    };

    const first = run("restart", firstWait);
    const second = run("end-flight", secondWait);
    releaseFirst();
    await first;
    expect(committed).toEqual([]);
    releaseSecond();
    await second;
    expect(committed).toEqual(["end-flight"]);

    const pending = beginTransition(gate);
    invalidateTransitions(gate);
    expect(isCurrentTransition(gate, pending)).toBe(false);
  });

  it("leaves Space and other native keys with focused interactive controls", () => {
    expect(isFlightShortcutTargetInteractive(keyboardTarget("button"))).toBe(true);
    expect(isFlightShortcutTargetInteractive(keyboardTarget("input"))).toBe(true);
    expect(isFlightShortcutTargetInteractive(keyboardTarget("a", { href: "/help" }))).toBe(true);
    expect(isFlightShortcutTargetInteractive(keyboardTarget("div", { role: "button" }))).toBe(true);
    expect(isFlightShortcutTargetInteractive(keyboardTarget("canvas"))).toBe(false);
  });

  it("wraps focus at both modal edges and recovers focus that escaped", () => {
    const first = { name: "resume" };
    const middle = { name: "restart" };
    const last = { name: "settings" };
    const focusable = [first, middle, last];

    expect(modalTabTarget(focusable, first, true)).toBe(last);
    expect(modalTabTarget(focusable, last, false)).toBe(first);
    expect(modalTabTarget(focusable, middle, false)).toBeNull();
    expect(modalTabTarget(focusable, { name: "canvas" }, false)).toBe(first);
    expect(modalTabTarget(focusable, { name: "canvas" }, true)).toBe(last);
  });
});
