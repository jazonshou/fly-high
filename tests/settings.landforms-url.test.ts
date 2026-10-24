import { describe, expect, it } from "vitest";
import { readLandformsFromUrl } from "../src/settings";
import { readSource } from "./support/sourceText";

/**
 * `?landforms=` forces sand seas or volcanic fields near the start for one
 * review session, the way `?world=eroded` opts into the eroded world: URL
 * only, never persisted, and absent means the natural world.
 */
describe("forced-landforms URL opt-in", () => {
  it("reads each landform, alone or together, in any order", () => {
    expect(readLandformsFromUrl("http://local/?landforms=dunes")).toEqual({ dunes: true });
    expect(readLandformsFromUrl("http://local/?landforms=volcanic")).toEqual({ volcanic: true });
    expect(readLandformsFromUrl("http://local/?seed=abc&landforms=volcanic,dunes"))
      .toEqual({ dunes: true, volcanic: true });
    expect(readLandformsFromUrl("http://local/?landforms=dunes,%20mesas")).toEqual({ dunes: true });
  });

  it("returns undefined for absence, unknown names, junk, and unparseable URLs", () => {
    expect(readLandformsFromUrl("http://local/")).toBeUndefined();
    expect(readLandformsFromUrl("http://local/?landforms=")).toBeUndefined();
    expect(readLandformsFromUrl("http://local/?landforms=mesas")).toBeUndefined();
    expect(readLandformsFromUrl("http://local/?landforms=DUNES")).toBeUndefined();
    expect(readLandformsFromUrl("not a url")).toBeUndefined();
  });

  it("is never persisted, and FlightGame threads it into createWorld", () => {
    const settingsSource = readSource("src/settings/index.ts");
    const readerBody = settingsSource.slice(
      settingsSource.indexOf("export function readLandformsFromUrl"),
      settingsSource.indexOf("export function seedToString"),
    );
    expect(readerBody.length).toBeGreaterThan(0);
    expect(readerBody).not.toContain("localStorage");
    expect(readerBody).not.toContain("setItem");
    const game = readSource("src/game/FlightGame.tsx");
    expect(game).toContain("readLandformsFromUrl()");
    expect(game).toMatch(/\.\.\.\(landforms \? \{ landforms \} : \{\}\)/);
  });
});
