import { describe, expect, it } from "vitest";
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { readSource } from "./support/sourceText";

/**
 * COVERAGE, not correctness: does the winding guard look at every surface that
 * an inverted winding would actually blacken?
 *
 * `render.webgpu-prototype-winding.test.ts` asserts the winding of the
 * prototypes it is handed. What decides which prototypes it is handed is a
 * hand-written `cases()` list — and that list is exactly the kind of artefact
 * this codebase keeps finding rotted. It has already failed twice:
 *
 *  - `GroundCoverSystem.buildBladeRibbon` shipped inverted and was invisible,
 *    because `cases()` enumerated only `prototypeGeometry.ts`. Worse, the
 *    surface it DID cover was moot: `presentationBuild.ts` retires the grass
 *    card archetype globally whenever the blade field is live, so the guard
 *    checked grass no capture draws while the grass every capture draws was in
 *    no test at all.
 *  - `clutter.mossCushion` shipped inverted and was found only because the list
 *    was widened by hand; three of the four clutter kinds were unchecked.
 *
 * So this file guards the guard's SCOPE. It derives, from source, the set of
 * materials for which an inverted winding is actually a defect, and fails if
 * that set stops matching what has been declared.
 *
 * WHY THIS PAIRING AND NOT "ALL GEOMETRY". The defect needs two things
 * together: `backFaceCulling = false`, so both faces of a surface rasterise,
 * and `twoSidedLighting = true`, so the winding decides which fragments get
 * their shading normal negated. With that pair, an inverted winding flips the
 * normal away from the viewer, `N·L` clamps to zero and the surface renders
 * ambient-only — the near-black canopy and the near-black blades.
 *
 * Culling-off ALONE is common and harmless: twelve materials set it, and the
 * six that do not also set two-sided lighting (aircraft panels, hydrology, the
 * ocean, the star field, the sky) can never blacken this way. Scanning for
 * geometry construction instead would have flagged all of them plus Babylon's
 * own builders and every fullscreen quad — an exemption list on day one, which
 * is the failure mode this file exists to avoid. **The scope of the guard is
 * the mechanism of the defect, not a proxy for it.**
 *
 * DEMONSTRATED, NOT ASSERTED: run against the tree before `d713971` this fails,
 * naming `GroundCoverSystem.ts` as an undeclared two-sided-lit material — the
 * surface that actually shipped. It is green today. A reader should not have to
 * trust a commit message for that.
 *
 * WHAT THIS DOES NOT DO, stated so nobody over-trusts it: it guarantees the
 * BUILDER is represented in `cases()`, not that every VARIANT it produces is.
 * `clutter.mossCushion` was invisible for exactly that reason — one builder,
 * four kinds, one of them checked. Per-variant coverage remains a human
 * judgement and this file cannot make it otherwise.
 */

const WEBGPU_ROOT = "src/render/webgpu";

interface TwoSidedSite {
  /** Path relative to the repo root. */
  readonly file: string;
  /** The identifier the properties were set on. */
  readonly identifier: string;
  /** How many times this (file, identifier) pair is configured two-sided-lit. */
  readonly count: number;
}

function sourceFiles(directory: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(directory)) {
    const full = join(directory, entry);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (entry.endsWith(".ts")) out.push(full);
  }
  return out;
}

/**
 * Sites where the same identifier is given BOTH properties within a few lines.
 *
 * The proximity window matters: `WorldDetailRuntime` reuses the local name
 * `material` for several unrelated materials, so pairing by identifier across a
 * whole file would fuse them. Every real site sets the two on adjacent lines.
 */
function discoverTwoSidedLitMaterials(): TwoSidedSite[] {
  const PROXIMITY_LINES = 6;
  const found = new Map<string, TwoSidedSite>();
  for (const file of sourceFiles(WEBGPU_ROOT)) {
    const lines = readSource(file).split("\n");
    for (let index = 0; index < lines.length; index += 1) {
      const lit = /(\w+)\.twoSidedLighting\s*=\s*true/.exec(lines[index]!);
      if (!lit) continue;
      const identifier = lit[1]!;
      const from = Math.max(0, index - PROXIMITY_LINES);
      const to = Math.min(lines.length - 1, index + PROXIMITY_LINES);
      let culled = false;
      for (let near = from; near <= to; near += 1) {
        if (new RegExp(`${identifier}\\.backFaceCulling\\s*=\\s*false`).test(lines[near]!)) {
          culled = true;
          break;
        }
      }
      if (!culled) continue;
      const key = `${file}::${identifier}`;
      const previous = found.get(key);
      found.set(key, { file, identifier, count: (previous?.count ?? 0) + 1 });
    }
  }
  return [...found.values()].sort((left, right) =>
    `${left.file}${left.identifier}`.localeCompare(`${right.file}${right.identifier}`));
}

interface Declaration {
  readonly file: string;
  readonly identifier: string;
  readonly count: number;
  /**
   * The `cases()` name prefix whose geometry this material draws, or null when
   * the geometry has no prototype builder at all.
   */
  readonly casesPrefix: string | null;
  /** Required when `casesPrefix` is null: why no builder exists. */
  readonly runtimeGenerated?: string;
}

/**
 * Every material for which an inverted winding is a rendering defect.
 *
 * The SET is derived from source above; this table only says what covers each
 * entry. A material added anywhere fails as undeclared, and one removed fails
 * as stale — so the declaration cannot drift from the code the way a pure list
 * can.
 */
const DECLARED: readonly Declaration[] = [
  {
    file: "src/render/webgpu/detail/GroundCoverSystem.ts",
    identifier: "material",
    count: 1,
    casesPrefix: "groundCover.blade",
  },
  {
    file: "src/render/webgpu/detail/WorldDetailRuntime.ts",
    identifier: "crownMaterial",
    count: 1,
    casesPrefix: "tree.",
  },
  {
    file: "src/render/webgpu/detail/WorldDetailRuntime.ts",
    identifier: "impostorMaterial",
    count: 1,
    casesPrefix: null,
    // The impostor is a camera-facing billboard quad built in the vertex stage
    // from instance data, not from a prototype builder, so there is no geometry
    // for `cases()` to hold. Its ATLAS is baked from prototypes that ARE
    // covered, and `ImpostorAtlas`'s sidedness reads the authored normal rather
    // than the winding, so it is winding-invariant by construction. Named
    // specifically rather than left as a general escape hatch: the assertion
    // below permits exactly one runtime-generated surface, so a second cannot
    // quietly join it.
    runtimeGenerated: "camera-facing billboard quad, no prototype builder",
  },
  {
    file: "src/render/webgpu/detail/WorldDetailRuntime.ts",
    identifier: "material",
    count: 3,
    // The three anonymous locals: shrubs, clutter and the grass-patch
    // archetypes. All three build from `prototypeGeometry` builders that
    // `cases()` holds.
    casesPrefix: "shrub.",
  },
];

const DISCOVERED = discoverTwoSidedLitMaterials();

/** The `cases()` names the winding guard actually checks. */
function windingGuardCaseNames(): string[] {
  const source = readSource("tests/render.webgpu-prototype-winding.test.ts");
  return [...source.matchAll(/out\.push\(\[\s*`?"?([A-Za-z][\w.$*{}]*)/g)].map((m) => m[1]!);
}

describe("two-sided-lit material coverage", () => {
  it("finds the materials an inverted winding would blacken", () => {
    // Non-vacuity: if the scan matched nothing the assertions below would all
    // pass while covering an empty set — the exact fault this file exists to
    // catch, so it must not be possible here.
    expect(DISCOVERED.length, "the source scan matched no materials at all").toBeGreaterThan(0);
    expect(
      DISCOVERED.every((site) => site.file.endsWith(".ts")),
      "scan produced a non-source path",
    ).toBe(true);
  });

  it("has a declaration for every two-sided-lit material, and no stale ones", () => {
    const key = (s: { file: string; identifier: string; count: number }) =>
      `${s.file}::${s.identifier} x${s.count}`;
    const discovered = DISCOVERED.map(key).sort();
    const declared = DECLARED.map(key).sort();

    const undeclared = discovered.filter((k) => !declared.includes(k));
    const stale = declared.filter((k) => !discovered.includes(k));

    expect(
      undeclared,
      "a material is configured `backFaceCulling = false` with "
      + "`twoSidedLighting = true` and is not declared here. An inverted winding "
      + "on its geometry renders it ambient-only (near-black). Add it, and add "
      + "its builder to the winding guard's `cases()`",
    ).toEqual([]);
    expect(
      stale,
      "a declared two-sided-lit material no longer exists or changed shape; "
      + "delete or update its entry",
    ).toEqual([]);
  });

  it("covers each declared material with a builder the winding guard checks", () => {
    const names = windingGuardCaseNames();
    expect(names.length, "could not read any case names from the winding guard")
      .toBeGreaterThan(0);
    const uncovered: string[] = [];
    for (const entry of DECLARED) {
      if (entry.casesPrefix === null) continue;
      if (!names.some((name) => name.startsWith(entry.casesPrefix!))) {
        uncovered.push(`${entry.file}::${entry.identifier} claims cases() prefix `
          + `"${entry.casesPrefix}", which the winding guard does not check`);
      }
    }
    expect(uncovered, "a declared coverage claim is not honoured by the winding guard")
      .toEqual([]);
  });

  it("permits exactly one runtime-generated surface, named and justified", () => {
    // A general escape hatch would let the next uncovered surface join quietly,
    // which is how exemption lists start. One entry, named, with a reason.
    const runtime = DECLARED.filter((entry) => entry.casesPrefix === null);
    expect(
      runtime.map((entry) => `${entry.file}::${entry.identifier}`),
      "exactly one two-sided-lit surface may be runtime-generated; a second "
      + "needs its own justification rather than an addition to this list",
    ).toEqual(["src/render/webgpu/detail/WorldDetailRuntime.ts::impostorMaterial"]);
    for (const entry of runtime) {
      expect(
        entry.runtimeGenerated,
        `${entry.identifier} is declared runtime-generated without saying why`,
      ).toBeTruthy();
    }
  });
});
