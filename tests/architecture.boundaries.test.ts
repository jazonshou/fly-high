import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ARCHITECTURAL_OWNERS,
  SEASONAL_FIELD_FAMILY,
} from "../src/render/webgpu/owners";

/**
 * Boundary enforcement for the architectural owner manifest (0-1).
 *
 * Deliberately a plain file-reading test — no ESLint plugin, no
 * dependency-cruiser. It fails with a message naming the owner, and it has no
 * dependency that can rot.
 */

const REPO_ROOT = join(__dirname, "..");
const SOURCE_ROOT = join(REPO_ROOT, "src");

interface SourceFile {
  /** Repo-relative POSIX-style path. */
  readonly path: string;
  readonly content: string;
}

/**
 * Remove comments, import statements, and re-export-from statements, so that
 * `type Foo` inside an import brace does not read as a declaration of Foo and
 * a mention inside a comment cannot satisfy a convention check.
 */
function withoutImportClauses(content: string): string {
  return content
    .replace(/\/\*[\s\S]*?\*\//gu, "")
    .replace(/\/\/[^\n]*/gu, "")
    .replace(/^import\s[^;]*?;/gmu, "")
    .replace(/^export\s+\{[^}]*\}\s+from\s+["'][^"']*["'];/gmu, "");
}

function collectSourceFiles(directory: string, into: SourceFile[]): SourceFile[] {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const absolute = join(directory, entry.name);
    if (entry.isDirectory()) {
      collectSourceFiles(absolute, into);
    } else if (/\.(ts|tsx)$/.test(entry.name)) {
      into.push({
        path: relative(REPO_ROOT, absolute).split(sep).join("/"),
        content: withoutImportClauses(readFileSync(absolute, "utf8")),
      });
    }
  }
  return into;
}

const sourceFiles = collectSourceFiles(SOURCE_ROOT, []);
const filesByPath = new Map(sourceFiles.map((file) => [file.path, file]));

function declarationPattern(symbol: string): RegExp {
  return new RegExp(
    String.raw`\b(?:export\s+)?(?:abstract\s+)?(?:const|let|function|class|interface|type|enum)\s+${symbol}\b`,
    "u",
  );
}

describe("architecture boundaries (0-1)", () => {
  it("keeps the manifest complete: every definition site exists or is planned", () => {
    for (const owner of ARCHITECTURAL_OWNERS) {
      const existing = owner.definitionSites.filter((site) => filesByPath.has(site));
      if (owner.plannedBy) {
        // The reverse rot: when the planned file lands, the marker must go, or
        // a typo'd planned path would silently exempt the row forever.
        expect(
          existing.length,
          `Manifest rot: "${owner.artifact}" is marked planned (${owner.plannedBy}) but `
          + `${existing.join(", ")} exists — remove plannedBy so the row is fully enforced.`,
        ).toBe(0);
        continue;
      }
      expect(
        existing.length,
        `Manifest rot: "${owner.artifact}" (owner: ${owner.owner}) lists definition sites `
        + `${owner.definitionSites.join(", ")} but none exist and the row is not marked planned.`,
      ).toBeGreaterThan(0);
    }
  });

  it("allows owned symbols to be declared only at their definition sites", () => {
    for (const owner of ARCHITECTURAL_OWNERS) {
      for (const symbol of owner.ownedSymbols ?? []) {
        const pattern = declarationPattern(symbol);
        for (const file of sourceFiles) {
          if (owner.definitionSites.includes(file.path)) continue;
          expect(
            pattern.test(file.content),
            `${file.path} declares "${symbol}", but that artifact ("${owner.artifact}") is owned by `
            + `${owner.owner} and defined only in ${owner.definitionSites.join(", ")}. `
            + `Import it instead of re-deriving it.`,
          ).toBe(false);
        }
      }
    }
  });

  it("keeps page identity and page geometry defined only under world/", () => {
    // Any WorldPage*/WORLD_PAGE_* declaration, and any gutter/page-extent
    // constant, belongs to src/render/webgpu/world/. This is what stops a
    // fifth page geometry.
    const pageSymbol =
      /\b(?:export\s+)?(?:const|let|function|class|interface|type|enum)\s+(WorldPage\w*|worldPage\w*|WORLD_PAGE_\w*)\b/u;
    const rogueGeometryConstant = /\b(?:const|let)\s+[A-Z0-9_]*(?:GUTTER|PAGE_EXTENT)[A-Z0-9_]*\s*=/u;
    for (const file of sourceFiles) {
      if (file.path.startsWith("src/render/webgpu/world/")) continue;
      expect(
        pageSymbol.test(file.content),
        `${file.path} declares a world-page symbol. Page identity, layout and addressing are `
        + `owned by terrain-geometry under src/render/webgpu/world/ — import them.`,
      ).toBe(false);
      expect(
        rogueGeometryConstant.test(file.content),
        `${file.path} declares a page-gutter/extent constant. The page geometry has exactly one `
        + `definition: src/render/webgpu/world/pageGeometry.ts (512 m / gutter 4 / 256 / 128).`,
      ).toBe(false);
    }
  });

  it("keeps quality-tier branching inside core/ (plus grandfathered readers)", () => {
    // The tier table is performance-owned. These pre-Phase-0 tier readers are
    // grandfathered until their items land (1B-3 and Phase 2 water work);
    // do not add to this list — extend WebGpuQualityProfile with data instead.
    const grandfathered = new Set([
      // TerrainClipmapSystem left this list at 1B-3 (terrainTileResolution
      // became a profile datum); PlanarWaterReflectionSystem left at 2-10
      // (its capture system and tier budgets were retired outright). The
      // ocean reader leaves with Phase 2's water work. The list only shrinks.
      "src/render/webgpu/water/SpectralOceanSystem.ts",
    ]);
    const tierRead = /\.tier\b/u;
    for (const file of sourceFiles) {
      if (file.path.startsWith("src/render/webgpu/core/")) continue;
      if (grandfathered.has(file.path)) continue;
      expect(
        tierRead.test(file.content),
        `${file.path} branches on the quality tier. Tier tables are owned by performance in `
        + `src/render/webgpu/core/ — contribute a data field to WebGpuQualityProfile instead.`,
      ).toBe(false);
    }
  });

  it("keeps terrain/ off detail/ internals except the density-field entry point", () => {
    const detailImport = /from\s+["'][^"']*\/detail\/(?!densityField\b)[^"']*["']/u;
    for (const file of sourceFiles) {
      if (!file.path.startsWith("src/render/webgpu/terrain/")) continue;
      expect(
        detailImport.test(file.content),
        `${file.path} imports detail/ internals. Terrain may consume vegetation only through `
        + `the density-field entry point (vegetation-owned).`,
      ).toBe(false);
    }
  });

  it("routes every physics terrain query through src/sim/terrainGrid.ts", () => {
    // §1.3: when the authority changes at 5-2, exactly one file changes. A
    // direct collision-kernel import anywhere else re-opens the hunt across
    // the simulation the contract exists to prevent.
    const collisionImport = /\bsampleTerrainCollision(?:Height)?\b/u;
    const allowed = new Set([
      "src/world/terrain.ts", // the definitions
      "src/world/index.ts", // the barrel re-export
      "src/sim/terrainGrid.ts", // the authority
    ]);
    for (const file of sourceFiles) {
      if (allowed.has(file.path)) continue;
      expect(
        collisionImport.test(file.content),
        `${file.path} references the collision kernel directly. Physics terrain queries route `
        + `through src/sim/terrainGrid.ts (simulation-owned, §1.3) so 5-2 changes one file.`,
      ).toBe(false);
    }
  });

  it("threads the environment clock through every existing seasonal field", () => {
    for (const member of SEASONAL_FIELD_FAMILY) {
      for (const site of member.definitionSites) {
        const file = filesByPath.get(site);
        if (!file) {
          // Not written yet; its plan item inherits the convention.
          expect(
            member.plannedBy,
            `Seasonal family member "${member.artifact}" has no file at ${site} and no plannedBy marker.`,
          ).toBeTruthy();
          continue;
        }
        expect(
          // Type-position only: a parameter or property typed EnvironmentClock,
          // or a dayOfYear field/parameter. A comment cannot satisfy this
          // (comments are stripped), and neither can an unrelated identifier.
          /:\s*(?:Readonly<)?EnvironmentClock\b|\bdayOfYear\s*\??\s*:/u.test(file.content),
          `${site} is in the seasonal field family ("${member.artifact}") but takes no `
          + `environment clock in its signatures. §1.6: dayOfYear is part of these signatures `
          + `from the moment they are first written — never a retrofit.`,
        ).toBe(true);
      }
    }
  });
});
