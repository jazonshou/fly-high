import { airfieldFurnitureWindingCases } from "../src/render/webgpu/detail/AirfieldFurniture";
import { describe, expect, it } from "vitest";
import { CreateSphereVertexData } from "@babylonjs/core/Meshes/Builders/sphereBuilder";
import { CreateBoxVertexData } from "@babylonjs/core/Meshes/Builders/boxBuilder";
import {
  buildTreePrototype,
  buildCrownFringePrototype,
  buildShrubPrototype,
  buildRockPrototype,
  buildGrassPatchPrototype,
  buildClutterPrototype,
  type GroundCoverArchetype,
} from "../src/render/webgpu/detail/prototypeGeometry";
import { buildBladeRibbon } from "../src/render/webgpu/detail/GroundCoverSystem";
import {
  hangarPlanFrom,
  hangarShellGeometry,
} from "../src/render/webgpu/airfield/AirfieldStructures";
import { buildTowerGeometry, TOWER_PART_NAMES } from "../src/render/webgpu/detail/towerGeometry";

/**
 * TRIANGLE WINDING, asserted against Babylon's own convention.
 *
 * Why this file exists. Surface orientation has now been wrong THREE times in
 * this project, each time shipping and each time found by eye rather than by a
 * test: Phase 5's inside-out mirrored planform winding; the impostor bake's
 * inverted double-sided normal test (far band 4.5-7.5x too dark); and the
 * `cross3(normal, tangent)` bitangent in `emitSkeletonCards` and
 * `buildShrubPrototype`, which flipped `gl_FrontFacing` so that
 * `twoSidedLighting` negated card normals and the near/mid canopy took NO
 * direct sun. A class that recurs three times with nothing checking it is a
 * missing guard.
 *
 * TWO metrics, and the second one is the point:
 *
 *  A. `agreement` = mean dot(unit(cross(b-a, c-a)), unit(avg authored N)).
 *     This is the quantity `gl_FrontFacing` and two-sided lighting key on.
 *
 *  B. `signedVolume` = (1/6) sum dot(a, cross(b, c)) — the divergence theorem.
 *     It references NO authored normals and NO engine convention.
 *
 * B exists because A's answer depends on the authored normals being an
 * INDEPENDENT statement of which way the surface faces. Where a builder
 * DERIVES its normals from the winding — `buildRockPrototype` accumulates
 * `cross3(b-a, c-a)` into its vertex normals — A no longer measures the
 * geometry; it measures the derivation's sign convention. Today's rocks are
 * caught by both metrics (agreement +1.000, volume +4.09, against Babylon's
 * -0.999 / -4.14). But a builder that derived its normals from the NEGATED
 * cross product would read agreement -1.000, pass A, and still be inside-out.
 * B cannot be fooled that way: it references no normals at all.
 *
 * Measured false-positive margin on the corrected tree: the smallest
 * |agreement| on any correctly-wound surface is 0.721 (pine fringe), against a
 * decision boundary at 0. Nothing sits near the threshold, so this is a
 * sign test with roughly 0.7 of headroom rather than a tuned one.
 *
 * The convention itself is never hard-coded: it is READ from Babylon's own
 * primitives at run time, so a Babylon upgrade that changed it fails here
 * loudly instead of silently reversing every assertion below.
 */

/**
 * **REGISTER THE MERGED PRODUCT, NOT ONLY ITS PARTS.**
 *
 * A builder that merges by transforming a unit — a fence from one post, an
 * instanced set from one card, a shell from one panel — applies a rotation per
 * placement. **A basis with a NEGATIVE DETERMINANT flips the winding of every
 * transformed triangle while each unit part stays perfectly correct**, so
 * checking the units alone certifies a mesh that is entirely inside-out.
 *
 * `fence.post` and `fence.rail` pass individually and say nothing about
 * `fence.perimeter`, which is why all three are cases here. The same applies to
 * anything this codebase builds by transforming a unit: the hangar shell, the
 * tower, any future merged or instanced set. **Add the assembled geometry, not
 * just the piece it was assembled from.**
 */
interface Geo {
  positions: Float32Array | number[];
  normals: Float32Array | number[];
  indices: ArrayLike<number>;
}

interface Winding {
  triangles: number;
  agreement: number;
  fracPositive: number;
  signedVolume: number;
  closed: boolean;
}

function measure(geo: Geo): Winding {
  const p = geo.positions;
  const nr = geo.normals;
  const ix = geo.indices;
  let agree = 0;
  let positive = 0;
  let counted = 0;
  let volume = 0;
  // A mesh is closed when every undirected edge is traversed once in each
  // direction — which is what makes its signed volume meaningful. Keyed on
  // POSITION, not index: Babylon's own primitives split vertices at UV seams
  // (its box carries 24 vertices for 12 triangles), so an index-keyed test
  // reports every one of them open and would silently skip the whole
  // signed-volume assertion.
  const edges = new Map<string, number>();
  const key = (i: number): string =>
    `${Math.round(p[i * 3]! * 1e5)},${Math.round(p[i * 3 + 1]! * 1e5)},${Math.round(p[i * 3 + 2]! * 1e5)}`;

  for (let t = 0; t * 3 + 2 < ix.length; t += 1) {
    const ia = ix[t * 3]!;
    const ib = ix[t * 3 + 1]!;
    const ic = ix[t * 3 + 2]!;
    for (const [from, to] of [[ia, ib], [ib, ic], [ic, ia]] as const) {
      const kf = key(from);
      const kt = key(to);
      if (kf === kt) continue;
      const forward = kf < kt;
      const edgeKey = forward ? `${kf}|${kt}` : `${kt}|${kf}`;
      edges.set(edgeKey, (edges.get(edgeKey) ?? 0) + (forward ? 1 : -1));
    }
    const ax = p[ia * 3]!, ay = p[ia * 3 + 1]!, az = p[ia * 3 + 2]!;
    const bx = p[ib * 3]!, by = p[ib * 3 + 1]!, bz = p[ib * 3 + 2]!;
    const cx = p[ic * 3]!, cy = p[ic * 3 + 1]!, cz = p[ic * 3 + 2]!;
    const ux = bx - ax, uy = by - ay, uz = bz - az;
    const vx = cx - ax, vy = cy - ay, vz = cz - az;
    const gx = uy * vz - uz * vy;
    const gy = uz * vx - ux * vz;
    const gz = ux * vy - uy * vx;
    const gl = Math.hypot(gx, gy, gz);
    volume += (ax * (by * cz - bz * cy) + ay * (bz * cx - bx * cz) + az * (bx * cy - by * cx)) / 6;
    if (!(gl > 1e-12)) continue;
    let nx = (nr[ia * 3]! + nr[ib * 3]! + nr[ic * 3]!) / 3;
    let ny = (nr[ia * 3 + 1]! + nr[ib * 3 + 1]! + nr[ic * 3 + 1]!) / 3;
    let nz = (nr[ia * 3 + 2]! + nr[ib * 3 + 2]! + nr[ic * 3 + 2]!) / 3;
    const nl = Math.hypot(nx, ny, nz);
    if (!(nl > 1e-9)) continue;
    nx /= nl; ny /= nl; nz /= nl;
    const d = (gx * nx + gy * ny + gz * nz) / gl;
    agree += d;
    if (d > 0) positive += 1;
    counted += 1;
  }

  let closed = edges.size > 0;
  for (const balance of edges.values()) {
    if (balance !== 0) { closed = false; break; }
  }
  return {
    triangles: counted,
    agreement: agree / Math.max(counted, 1),
    fracPositive: positive / Math.max(counted, 1),
    signedVolume: volume,
    closed,
  };
}

function babylonGeo(vd: { positions: number[] | Float32Array; normals: number[] | Float32Array; indices: number[] | Int32Array }): Geo {
  return {
    positions: Array.from(vd.positions),
    normals: Array.from(vd.normals),
    indices: Array.from(vd.indices),
  };
}

/** Babylon's own convention, read rather than assumed. */
const SPHERE = measure(babylonGeo(CreateSphereVertexData({ diameter: 2, segments: 16 }) as never));
const BOX = measure(babylonGeo(CreateBoxVertexData({ size: 2 }) as never));
const CONVENTION = Math.sign(SPHERE.agreement);
const VOLUME_CONVENTION = Math.sign(SPHERE.signedVolume);

/**
 * Surfaces KNOWN to be inverted, with the defect that owns each.
 *
 * This list is ASSERTED, not merely tolerated: an entry whose surface has been
 * FIXED fails the test and demands its own removal. Without that, the list
 * would rot into exactly the decorative table this codebase has been bitten by
 * before — a list checked for tidiness and never against the artifact.
 */
/**
 * EMPTY, and it emptied the way it was built to. Each fix made this test fail
 * with "now winds correctly -- delete its entry" until the entry was removed;
 * that is the mechanism that stops a known-defect list becoming an exception
 * list nobody revisits. It worked on its first real use.
 *
 * Keep the map rather than deleting it: a future builder that lands inverted
 * for a reason someone accepts belongs here WITH that reason, not suppressed.
 */
const KNOWN_INVERTED: ReadonlyMap<string, string> = new Map([]);

/**
 * Case-name prefixes whose builders DOCUMENT themselves as closed manifolds.
 *
 * The signed-volume metric is only defined on a closed surface, so the
 * assertion below skips anything open — which means a surface that promises
 * closure and stops delivering it leaves the guard with no failure anywhere.
 * Listing the promise here turns that silence into a red test.
 */
const CLOSED_BY_CONTRACT: readonly string[] = ["airfield.hangarShell."];

/**
 * The archetypes `buildGrassPatchPrototype` can actually build, matching the
 * four the shipping caller hard-codes at `WorldDetailRuntime.ts:3534`.
 *
 * `_coversEveryArchetype` below is a COMPILE-TIME exhaustiveness check: if
 * `prototypeGeometry`'s `GroundCoverArchetype` ever gains a member this list
 * lacks, the assignment stops typechecking. Without it this is a hand-written
 * roster, which is the thing that let the blade ribbon go unmeasured -- a list
 * a member can fail to appear in.
 */
const GRASS_ARCHETYPES = ["grass", "fern", "heather", "reed"] as const;
type _Uncovered = Exclude<GroundCoverArchetype, (typeof GRASS_ARCHETYPES)[number]>;
const _coversEveryArchetype: _Uncovered extends never ? true : never = true;
void _coversEveryArchetype;

function cases(): ReadonlyArray<readonly [string, Geo]> {
  const out: Array<readonly [string, Geo]> = [];
  for (const species of ["oak", "pine", "birch"] as const) {
    const proto = buildTreePrototype(species, 0, 1, "near");
    out.push([`tree.crown.${species}`, proto.crown as unknown as Geo]);
    out.push([`tree.trunk.${species}`, proto.trunk as unknown as Geo]);
    // (species, variant, seed, band) — matching buildTreePrototype's own
    // (species, variant, seed, band) above, so the fringe is measured on the
    // SAME prototype the crown and trunk come from. Passing (species, seed)
    // typechecked as (species, variant) with the seed silently in the variant
    // slot, which measured a different prototype than the rest of the row.
    out.push([`tree.fringe.${species}`, buildCrownFringePrototype(species, 0, 1, "near") as unknown as Geo]);
  }
  for (const species of ["juniper", "hazel", "sage"] as const) {
    out.push([`shrub.${species}`, buildShrubPrototype(species, 0, 1) as unknown as Geo]);
  }
  for (const variant of ["granite", "limestone", "dark"] as const) {
    out.push([`rock.${variant}`, buildRockPrototype(variant, 1) as unknown as Geo]);
  }
  // 7-13: derived from WINDSOCK_PART_KINDS rather than listed, so a part added
  // to the furniture is checked here without anyone remembering to come back.
  // Both inflation extremes: a slack sock is a different mesh from a streaming
  // one (the rings collapse toward the mast), so checking one arm would leave
  // the other unwound.
  // 7-13: SPREAD, not listed. `airfieldFurnitureWindingCases` enumerates every
  // furniture surface at its source, so furniture added there is wound-checked
  // with no change here at all — one step stronger than deriving from a kind
  // array, which would still need wiring per new kind.
  for (const [label, geometry] of airfieldFurnitureWindingCases()) {
    out.push([label, geometry as unknown as Geo]);
  }
  // EVERY archetype, not the default. The specs differ per archetype -- blade
  // count, length, lean, and `layer` -- so the default tested one member of a
  // family of four. And the default is `grass`, the one archetype
  // `presentationBuild.ts` retires GLOBALLY while the blade field is live:
  // the only one under test was the only one that never draws, while fern,
  // heather and reed DO draw beyond the field radius.
  //
  // Deliberately NOT `GROUND_COVER_ARCHETYPES` from `densityField`, which is
  // the canonical list and has FIVE members -- it includes `clutter`, which
  // `GROUND_COVER_SPECS` has no entry for, so `buildGrassPatchPrototype`
  // throws on it. `GroundCoverArchetype` is declared three times in this tree
  // (`densityField` derives five; `types.ts` and `prototypeGeometry` each
  // hard-code four) and the duplicates have drifted from the canonical one.
  // This roster is the BUILDER's, so it matches what the builder can build.
  for (const archetype of GRASS_ARCHETYPES) {
    out.push([`grass.patch.${archetype}`,
      buildGrassPatchPrototype(1, archetype) as unknown as Geo]);
  }
  // The COMPUTE ground-cover blade, which is what a capture actually draws.
  // `grass.patch` above is retired globally for the grass archetype while the
  // blade field is live (`presentationBuild.ts`), so without this row the only
  // grass under test was grass nothing renders. Every ring segment count in
  // `GROUND_COVER_LAWS`, since the ribbon is built per ring.
  for (const segments of [2, 3, 5, 7] as const) {
    out.push([`groundCover.blade.s${segments}`, buildBladeRibbon(segments) as unknown as Geo]);
  }
  // All four ClutterKinds. `ed5b703` found `mossCushion` at +0.964 -- "which
  // nobody had measured" -- and corrected it, but the guard still enumerated
  // only `log`, so the surface it had just fixed went straight back to being
  // unwatched. A fix without a case is a fix with a shelf life.
  for (const kind of ["log", "stump", "branchLitter", "mossCushion"] as const) {
    out.push([`clutter.${kind}`, buildClutterPrototype(kind as never, 1) as unknown as Geo]);
  }
  // `7-15`: every ATC tower surface, DERIVED from the builder's own roster
  // rather than listed here. 7D is the largest block of new hand-authored
  // geometry left in the programme and it is written by sessions that will not
  // be flying it, so a mesh that is added and not listed is the likeliest way
  // this class recurs. Naming a part in `TOWER_PART_NAMES` without building it
  // throws in the builder; building one without naming it is impossible.
  const tower = buildTowerGeometry();
  for (const name of TOWER_PART_NAMES) {
    out.push([`tower.${name}`, tower.parts[name] as unknown as Geo]);
  }
  // `7-10`'s hangar shell, registered AS IT IS BUILT rather than after -- the
  // owners row for `airfield-structures` requires exactly that, because
  // `ed5b703` fixed a surface the guard was not enumerating and it went
  // straight back to being unwatched.
  //
  // BOTH roof profiles, because they are different geometry: the gabled shell
  // emits 18 triangles and the arched 78, and a roster carrying one of them
  // would leave the other unmeasured in the same way the grass roster left the
  // blade. The profile is hash-chosen, so whichever one a given seed builds is
  // not a choice anybody makes deliberately.
  for (const roof of ["gabled", "arched"] as const) {
    const plan = { ...hangarPlanFrom(1, 0, 1), roof };
    out.push([`airfield.hangarShell.${roof}`, hangarShellGeometry(plan) as unknown as Geo]);
  }
  return out;
}

describe("prototype triangle winding (Babylon convention)", () => {
  it("reads the convention from Babylon's own primitives", () => {
    // If a Babylon upgrade flips this, every assertion below would silently
    // reverse — so pin it here and fail loudly instead.
    expect(Math.abs(SPHERE.agreement)).toBeGreaterThan(0.95);
    expect(Math.abs(BOX.agreement)).toBeGreaterThan(0.95);
    expect(Math.sign(BOX.agreement)).toBe(CONVENTION);
    expect(SPHERE.closed && BOX.closed).toBe(true);
    expect(Math.sign(BOX.signedVolume)).toBe(VOLUME_CONVENTION);
    expect(CONVENTION).toBe(-1);
  });

  it("yields geometry for every case (no silently empty builder)", () => {
    // A renamed or re-signatured builder that returns nothing would make every
    // assertion below vacuously true — the exact shape this codebase has been
    // bitten by. Fail here instead.
    for (const [name, geo] of cases()) {
      expect(measure(geo).triangles, `${name} produced no triangles`).toBeGreaterThan(0);
    }
  });

  it("winds every prototype the way Babylon does", () => {
    // Collect ALL violations rather than stopping at the first. Tonight's
    // lesson was that a fix reached one of five inverted surfaces; a test that
    // reports only the first would have hidden exactly that.
    const wrong: string[] = [];
    const staleEntries: string[] = [];
    for (const [name, geo] of cases()) {
      const w = measure(geo);
      if (w.triangles === 0) continue;
      const inverted = Math.sign(w.agreement) !== CONVENTION;
      const known = KNOWN_INVERTED.get(name);
      if (known) {
        if (!inverted) {
          staleEntries.push(`${name} (listed as "${known}") now winds correctly — delete its entry`);
        }
        continue;
      }
      if (inverted) {
        wrong.push(
          `${name}: agreement ${w.agreement.toFixed(3)}, `
          + `${(w.fracPositive * 100).toFixed(1)}% of triangles positive`);
      }
    }
    expect(staleEntries, "KNOWN_INVERTED has entries that are no longer true").toEqual([]);
    expect(
      wrong,
      "prototypes wound against Babylon's convention — two-sided lighting will "
      + "negate their normals and these surfaces will take no direct sun",
    ).toEqual([]);
  });

  it("keeps the foliage layer constant within every triangle", () => {
    // `ImpostorAtlas`'s rasterizer reads `layers[ia]` -- the foliage layer of a
    // triangle's FIRST vertex -- which makes the CPU bake winding-sensitive
    // unless the layer is constant across all three vertices.
    //
    // Today it is, so any index reorder is safe. That property held through the
    // winding fixes by LUCK rather than by statement: every reorder happened to
    // be (a,b,c) -> (a,c,b), preserving the first index, and nothing checked
    // it. An unstated invariant holding by luck is a latent defect with a good
    // outcome so far. Asserting the CONSTANCY rather than the ordering is the
    // stronger guarantee -- it makes every reorder safe, not just the ones that
    // keep vertex 0 first.
    const mixed: string[] = [];
    let surfacesChecked = 0;
    for (const [name, geo] of cases()) {
      const layer = (geo as unknown as { atlasLayer?: Float32Array }).atlasLayer;
      if (!layer) continue;
      surfacesChecked += 1;
      const ix = geo.indices;
      let bad = 0;
      for (let t = 0; t * 3 + 2 < ix.length; t += 1) {
        const a = layer[ix[t * 3]!]!;
        const b = layer[ix[t * 3 + 1]!]!;
        const c = layer[ix[t * 3 + 2]!]!;
        if (a !== b || b !== c) bad += 1;
      }
      if (bad > 0) mixed.push(`${name}: ${bad} triangles span more than one foliage layer`);
    }
    // The loop `continue`s past any surface without an `atlasLayer`, so if the
    // attribute is ever renamed or dropped this test would pass by checking
    // NOTHING -- green for the reason it was written to catch. Assert the
    // sample size, not just the result.
    expect(
      surfacesChecked,
      "no surface carried an `atlasLayer`, so this assertion examined nothing",
    ).toBeGreaterThan(0);
    expect(
      mixed,
      "a triangle whose vertices disagree on foliage layer makes ImpostorAtlas's "
      + "`layers[ia]` depend on index order, so a winding change would silently "
      + "re-texture the bake",
    ).toEqual([]);
  });

  it("agrees by signed volume on every closed mesh, independently of normals", () => {
    // The rock case is why this exists: agreement can be self-consistently
    // wrong when normals are derived from the winding. Signed volume cannot.
    const wrong: string[] = [];
    const staleEntries: string[] = [];
    const closedNames = new Set<string>();
    let closedSeen = 0;
    for (const [name, geo] of cases()) {
      const w = measure(geo);
      if (!w.closed || w.triangles === 0) continue;
      closedNames.add(name);
      closedSeen += 1;
      const inverted = Math.sign(w.signedVolume) !== VOLUME_CONVENTION;
      if (KNOWN_INVERTED.has(name)) {
        if (!inverted) staleEntries.push(`${name} signed volume now matches Babylon — delete its entry`);
        continue;
      }
      if (inverted) {
        wrong.push(`${name}: signed volume ${w.signedVolume.toExponential(2)} (inside-out)`);
      }
    }
    // Non-vacuity: if the closedness detector regresses, this assertion would
    // silently cover nothing.
    expect(closedSeen, "no closed mesh was examined").toBeGreaterThan(0);
    expect(staleEntries).toEqual([]);
    expect(wrong, "closed meshes wound inside-out").toEqual([]);

    // AND THE SURFACES THAT ARE SUPPOSED TO BE CLOSED MUST HAVE BEEN.
    //
    // `closedSeen > 0` above is satisfied by any one closed mesh in the whole
    // roster, so a builder whose docstring PROMISES a closed manifold can go
    // open and this assertion keeps passing on somebody else's geometry. That
    // is not hypothetical: the hangar shell claimed to be "ONE closed
    // manifold", was open by `2 * steps + 2` edges at the gable eave from the
    // day it landed, and sat in this very case list being skipped — green by
    // not being measured, which is the failure mode this file exists to catch,
    // reproduced inside the file itself.
    //
    // Keyed on a PREFIX rather than a list of names so both roof profiles are
    // covered without naming either, and a third profile joins automatically.
    const skipped = cases()
      .map(([name]) => name)
      .filter((name) => CLOSED_BY_CONTRACT.some((prefix) => name.startsWith(prefix)))
      .filter((name) => !closedNames.has(name));
    expect(
      skipped,
      "these surfaces document themselves as closed manifolds but were judged "
      + "OPEN, so the signed-volume assertion silently skipped them",
    ).toEqual([]);
    // The prefix must match something, or the check above is a filter over an
    // empty list — the same vacuity one level up.
    expect(
      cases().filter(([name]) => CLOSED_BY_CONTRACT.some((p) => name.startsWith(p))).length,
      "no case matched CLOSED_BY_CONTRACT — the prefixes have gone stale",
    ).toBeGreaterThan(0);
  });
});
