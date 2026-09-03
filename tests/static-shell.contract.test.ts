import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { readSource } from "./support/sourceText";

/**
 * The two deployment targets render the same game from two document shells:
 * `app/layout.tsx` + `app/page.tsx` (server-rendered by the Cloudflare Worker)
 * and `static/index.html` (the GitHub Pages bundle). Everything below the
 * `FlightGame` root is shared, so this is the whole surface that can drift —
 * and it drifts silently, because neither build reads the other.
 */
const layout = readFileSync(
  new URL("../app/layout.tsx", import.meta.url),
  "utf8",
);
const page = readSource(new URL("../app/page.tsx", import.meta.url));
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

function metaContent(name: string): string {
  return capture(
    staticHtml,
    new RegExp(`<meta\\s+name="${name}"\\s+content="([^"]+)"`),
    `<meta name="${name}"> in static/index.html`,
  );
}

describe("static shell matches the server-rendered shell", () => {
  it("uses the same document title", () => {
    const routeTitle = capture(page, /title:\s*"([^"]+)"/, "app/page.tsx title");
    const defaultTitle = capture(
      layout,
      /default:\s*"([^"]+)"/,
      "app/layout.tsx default title",
    );
    const htmlTitle = capture(
      staticHtml,
      /<title>([^<]+)<\/title>/,
      "static/index.html <title>",
    );

    expect(htmlTitle).toBe(routeTitle);
    expect(htmlTitle).toBe(defaultTitle);
  });

  it("uses the same application name and description", () => {
    expect(metaContent("application-name")).toBe(
      capture(layout, /applicationName:\s*"([^"]+)"/, "applicationName"),
    );
    expect(metaContent("description")).toBe(
      capture(page, /description:\s*\n?\s*"([^"]+)"/, "app/page.tsx description"),
    );
  });

  it("declares the same theme color", () => {
    expect(metaContent("theme-color")).toBe(
      capture(layout, /themeColor:\s*"([^"]+)"/, "themeColor"),
    );
  });

  it("mounts the same root component into a container the shell provides", () => {
    expect(page).toContain("<FlightGame />");
    expect(staticEntry).toContain("<FlightGame />");

    const containerId = capture(
      staticEntry,
      /getElementById\("([^"]+)"\)/,
      "static/main.tsx root container id",
    );
    expect(staticHtml).toContain(`id="${containerId}"`);
  });

  it("loads the shared global stylesheet", () => {
    expect(layout).toContain('import "./globals.css"');
    expect(staticEntry).toContain('globals.css"');
  });
});
