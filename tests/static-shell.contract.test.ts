import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * The page shell: `static/index.html` and the entry `static/main.tsx` that
 * mounts the game into it. Everything below the `FlightGame` root is the game.
 */
const staticHtml = readFileSync(
  new URL("../static/index.html", import.meta.url),
  "utf8",
);
const staticEntry = readFileSync(
  new URL("../static/main.tsx", import.meta.url),
  "utf8",
);

function capture(source: string, pattern: RegExp, label: string): string {
  const match = source.match(pattern);
  expect(match?.[1], `Could not read ${label}`).toBeDefined();
  return match?.[1] ?? "";
}

describe("the page shell", () => {
  it("mounts the game root into a container the page provides", () => {
    expect(staticEntry).toContain("<FlightGame />");

    const containerId = capture(
      staticEntry,
      /getElementById\("([^"]+)"\)/,
      "static/main.tsx root container id",
    );
    expect(staticHtml).toContain(`id="${containerId}"`);
  });

  it("loads the global stylesheet", () => {
    expect(staticEntry).toContain('import "./globals.css"');
  });
});
