import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { DisposableScope } from "../src/game/DisposableScope";

describe("partial flight-resource startup cleanup", () => {
  it.each([1, 2, 3, 4])(
    "disposes every acquired resource exactly once when acquisition %i is followed by failure",
    (failureAfter) => {
      const scope = new DisposableScope();
      const disposed: string[] = [];
      const resources = ["renderer", "input", "audio", "simulation"].map((name) => ({
        dispose: () => { disposed.push(name); },
      }));

      expect(() => {
        for (let index = 0; index < resources.length; index += 1) {
          scope.own(resources[index]!);
          if (index + 1 === failureAfter) throw new Error(`failure after ${failureAfter}`);
        }
      }).toThrow(`failure after ${failureAfter}`);
      scope.dispose();
      scope.dispose();

      expect(disposed).toEqual(
        ["renderer", "input", "audio", "simulation"]
          .slice(0, failureAfter)
          .reverse(),
      );
    },
  );

  it("transfers committed resources and still unwinds siblings if one destructor throws", () => {
    const scope = new DisposableScope();
    const disposed: string[] = [];
    const renderer = scope.own({ dispose: () => { disposed.push("renderer"); } });
    scope.own({
      dispose: () => {
        disposed.push("input");
        throw new Error("input cleanup failed");
      },
    });
    scope.own({ dispose: () => { disposed.push("audio"); } });
    scope.release(renderer);

    scope.dispose();
    expect(disposed).toEqual(["audio", "input"]);
  });

  it("wires each browser acquisition into the startup scope before ownership transfer", () => {
    const source = readFileSync(
      new URL("../src/game/FlightGame.tsx", import.meta.url),
      "utf8",
    );
    expect(source).toContain("startupResources.own(renderer)");
    expect(source).toContain("startupResources.own(new InputManager");
    expect(source).toContain("startupResources.own(new FlightAudio");
    expect(source).toContain("startupResources.own(new SimulationClient");
    expect(source).toContain("startupResources.dispose();");
    expect(source).toContain("cleanupResources.dispose();");
  });
});
