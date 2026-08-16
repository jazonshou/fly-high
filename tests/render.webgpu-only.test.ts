import { readdirSync, readFileSync } from "node:fs";
import { extname, join } from "node:path";
import { describe, expect, it } from "vitest";

const projectRoot = join(import.meta.dirname, "..");

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return [".ts", ".tsx", ".js", ".jsx"].includes(extname(path)) ? [path] : [];
  });
}

describe("WebGPU-only renderer boundary", () => {
  it("does not ship Three.js or a WebGL/Canvas renderer dependency", () => {
    const packageJson = JSON.parse(
      readFileSync(join(projectRoot, "package.json"), "utf8"),
    ) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const packages = {
      ...packageJson.dependencies,
      ...packageJson.devDependencies,
    };

    expect(packages).not.toHaveProperty("three");
    expect(packages).not.toHaveProperty("@types/three");
  });

  it("contains no production imports or context creation for a legacy renderer", () => {
    const violations = sourceFiles(join(projectRoot, "src")).flatMap((path) => {
      const source = readFileSync(path, "utf8");
      const forbidden = [
        /(?:from\s+|import\s*\()\s*["']three(?:\/[^"']*)?["']/u,
        /\bWebGLRenderer\b/u,
        /\bCanvasFlightRenderer\b/u,
        /getContext\(\s*["'](?:webgl|webgl2|experimental-webgl)["']/u,
      ];
      return forbidden.some((pattern) => pattern.test(source)) ? [path] : [];
    });

    expect(violations).toEqual([]);
  });
});
