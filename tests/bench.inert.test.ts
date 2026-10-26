import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { describe, expect, it } from "vitest";
import { readSource, stripComments } from "./support/sourceText";

/**
 * `?bench=1` must change nothing for a player (plan 2.12). Without the flag
 * FlightGame parses the URL once more and finds nothing: no bench module is
 * fetched, nothing is patched, observed or stored, and the frame loop is the
 * one players run. These guards hold the source to that.
 *
 * Kept elsewhere, beside the code they guard: storage names and writes in
 * src/bench (`tests/bench.flow.test.ts`, "storage in src/bench"), the probe's
 * callers and body (`tests/render.bench-probe.test.ts`), and the URL reader's
 * no-storage slice (`tests/settings.bench-url.test.ts`).
 *
 * Several names below are capture-only hooks that other guards count across
 * every file under tests/ (critique B1). They are built from pieces here, so
 * this file never names them whole.
 */

const projectRoot = join(import.meta.dirname, "..");
const flightGame = readSource(join(projectRoot, "src/game/FlightGame.tsx"));

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.(ts|tsx|mts)$/u.test(entry.name) ? [path] : [];
  });
}

function repoPath(path: string): string {
  return relative(projectRoot, path).split(sep).join("/");
}

describe("FlightGame without ?bench=1", () => {
  it("parses the flag once and reaches the bench only through one dynamic import", () => {
    expect(flightGame.match(/readBenchFromUrl\(\)/gu)).toHaveLength(1);
    expect(flightGame.match(/import\("@\/src\/bench\/session"\)/gu)).toHaveLength(1);
    const benchImports = [...flightGame.matchAll(/^import\s+([^;]*?)\s+from\s+"(@\/src\/bench[^"]*)";/gmu)]
      .map((match) => `${match[1]} from ${match[2]}`);
    expect(benchImports).toEqual(["type { BenchSession } from @/src/bench/types"]);
  });

  it("reads the session in the three places that need it, and nowhere else", () => {
    expect(flightGame.match(/benchRef\.current/gu)).toHaveLength(3);
    expect(flightGame).toContain("benchRef.current = session;");
    expect(flightGame).toContain("if (error !== null) benchRef.current?.reportGameError(error);");
    expect(flightGame).toContain("const bench = benchRef.current;");
    // The local that holds it, apart from the module paths checked above.
    const benchLines = flightGame.split("\n")
      .filter((line) => /\bbench\b/u.test(line.replaceAll("@/src/bench/", "")))
      .map((line) => line.trim());
    expect(benchLines).toEqual([
      "const bench = benchRef.current;",
      "...(bench ? bench.rendererOptions(canvas) : {}),",
      "const renderer: FlightRenderingSystem = bench ? bench.attach(created, world) : created;",
    ]);
  });

  it("returns from the bootstrap before the player's settings are loaded only under the flag", () => {
    const bootstrap = flightGame.slice(
      flightGame.indexOf("const benchRequest = readBenchFromUrl();"),
      flightGame.indexOf("const loaded = loadSettings();"),
    );
    expect(bootstrap).toMatch(/^const benchRequest = readBenchFromUrl\(\);\s+if \(benchRequest\) \{/u);
    expect(bootstrap).toMatch(/return \(\) => \{\s+cancelled = true;\s+\};\s+\}\s+$/u);
    expect(bootstrap).not.toMatch(/\b(saveSettings|applySettings|loadSettings|localStorage|replaceState)\b/u);
  });

  it("adds nothing to the frame loop", () => {
    // The same extract as tests/game.diagnostics-cadence.test.ts.
    const renderLoop = flightGame.match(/const renderLoop = \(now: number\) => \{[\s\S]*?\n {6}\};/u)?.[0] ?? "";
    expect(renderLoop).toContain("renderer.render(frameState, deltaSeconds);");
    expect(renderLoop).not.toMatch(/bench/iu);
  });
});

describe("src/bench stays apart", () => {
  it("is imported by FlightGame alone, outside src/bench", () => {
    const importers = [...sourceFiles(join(projectRoot, "src")), ...sourceFiles(join(projectRoot, "app"))]
      .filter((path) => !repoPath(path).startsWith("src/bench/"))
      .filter((path) => /["']@\/src\/bench\b|["'](\.\.?\/)+bench\//u.test(readSource(path)))
      .map(repoPath);
    expect(importers).toEqual(["src/game/FlightGame.tsx"]);
  });

  const benchFiles = sourceFiles(join(projectRoot, "src/bench"))
    .map((path) => ({ path: repoPath(path), code: readSource(path) }));

  it("never saves settings, never reaches into capture hooks, and imports no test or script code", () => {
    expect(benchFiles.length).toBeGreaterThan(15);
    const forbidden = [
      /\bsaveSettings\b/u,
      /\bapplySettings\b/u,
      /\bresetPerformanceWindow\b/u,
      /\bwaitForGpuIdleForCapture\b/u,
      /\bsetPinnedRenderScaleForCapture\b/u,
      /\bsetVegetationVisibleForCapture\b/u,
      /\.startBudgetProbe\(/u,
      /from\s+["'](\.\.\/)+(tests|scripts)\//u,
      /["']@\/(tests|scripts)\//u,
    ];
    for (const { path, code } of benchFiles) {
      for (const pattern of forbidden) expect(`${path}: ${pattern.test(code)}`).toBe(`${path}: false`);
    }
  });

  it("never names the capture-only hooks that other guards count, in its code or its tests", () => {
    const names = [
      ["pinOcean", "CascadePhase", "ForCapture"],
      ["pinWild", "life", "ForCapture"],
      ["cockpit", "Rig", "Override"],
      ["respawn", "ForCapture"],
      ["restartStep", "Count", "ForCapture"],
      ["__setProfile", "Override", "ForCapture", "ExperimentsOnly"],
    ].map((pieces) => pieces.join(""));
    const testFiles = sourceFiles(join(projectRoot, "tests"))
      .filter((path) => /\/(bench\.[\w-]+\.test\.ts|benchReportFixture\.ts)$/u.test(repoPath(path)) || repoPath(path) === "tests/render.bench-probe.test.ts");
    expect(testFiles.length).toBeGreaterThan(10);
    // Raw text, comments included: the guards that count these names read it so.
    const files = [
      ...benchFiles.map(({ path }) => ({ path, text: readFileSync(join(projectRoot, path), "utf8") })),
      ...testFiles.map((path) => ({ path: repoPath(path), text: readFileSync(path, "utf8") })),
    ];
    const naming = files.filter(({ text }) => names.some((name) => text.includes(name))).map(({ path }) => path);
    expect(naming).toEqual([]);
    // The fragments themselves really are the names (a typo would make this vacuous).
    const renderer = stripComments(readFileSync(join(projectRoot, "src/render/FlightRenderer.ts"), "utf8"));
    expect(renderer).toContain(`${names[0]}(): void`);
    expect(renderer).toContain(`${names[1]}(): void`);
  });
});
