import { describe, expect, it } from "vitest";
import {
  HANGAR_DETAIL,
  HANGAR_DETAIL_PARTS,
  HANGAR_PLAN_LIMITS,
  HANGAR_SHADOW_CASTING_SURFACES,
  hangarAttachments,
  hangarDetailBoxes,
  hangarFootprint,
  hangarPlanFrom,
  hangarShellGeometry,
  hangarYawRadians,
  HANGAR_MAX_YAW_RADIANS,
  type HangarPlan,
} from "../src/render/webgpu/airfield/AirfieldStructures";
import {
  AIRFIELD_CONCRETE_TILE_METERS,
  AIRFIELD_METAL_TILE_METERS,
} from "../src/render/webgpu/airfield/AirfieldMaterials";
import { DEFAULT_AIRPORT } from "../src/world/airport";

/**
 * `7-10` detail — doors, clerestory, ridge vents, gutters, downpipes and
 * pilasters — and the CLOSURE the winding guard depends on.
 *
 * **The reason this file exists is a latent defect the detail pass surfaced.**
 * `hangarShellGeometry`'s own docstring calls the shell "ONE closed manifold"
 * and explains at length that closure is what makes the winding guard's
 * signed-volume metric meaningful. **The shell was never closed.** It was open
 * by `2 * steps + 2` edges — 6 gabled, 26 arched — all of them on the eave line
 * at the gable ends, where a single full-width wall quad met a roof-segmented
 * gable infill. A T-junction.
 *
 * That is a rendering defect (a hairline crack wherever the two rasterise a
 * fraction of a pixel apart) and, worse, a SILENT one: the guard's signed
 * volume assertion `continue`s past any mesh it judges open, so the hangar
 * shell sat in the guard's case list and was skipped by the one metric that
 * cannot be fooled by a builder deriving its normals from its own winding. It
 * passed by not being measured — the house failure mode, on a surface whose
 * comment claimed the opposite.
 *
 * So closure is asserted HERE, directly, over the whole plan space, with a
 * non-vacuity arm proving the detector can say "open" at all.
 */

/**
 * Every plan `hangarPlanFrom` can produce. The space is FINITE — five bay
 * counts times two roof profiles — so there is no reason to sample it. Skirt
 * height is continuous, so both ends of the seating range are taken.
 */
function everyPlan(): ReadonlyArray<readonly [string, HangarPlan]> {
  const out: Array<readonly [string, HangarPlan]> = [];
  const base = hangarPlanFrom(1, 0, 1);
  for (let bays = HANGAR_PLAN_LIMITS.minBays; bays <= HANGAR_PLAN_LIMITS.maxBays; bays += 1) {
    for (const roof of ["gabled", "arched"] as const) {
      for (const skirt of [0.35, 3.2] as const) {
        const eave = HANGAR_PLAN_LIMITS.baseEaveHeightMeters
          + (bays - HANGAR_PLAN_LIMITS.minBays) * HANGAR_PLAN_LIMITS.eaveHeightPerBayMeters;
        const rise = base.widthMeters * (roof === "gabled"
          ? HANGAR_PLAN_LIMITS.gabledRiseFraction
          : HANGAR_PLAN_LIMITS.archedRiseFraction);
        out.push([`bays${bays}.${roof}.skirt${skirt}`, {
          ...base,
          bays,
          roof,
          eaveHeightMeters: eave,
          ridgeHeightMeters: eave + rise,
          skirtHeightMeters: skirt,
        }]);
      }
    }
  }
  return out;
}

interface Closure {
  closed: boolean;
  openEdges: number;
  signedVolume: number;
  agreement: number;
}

/**
 * The winding guard's own closure and volume metrics, reimplemented here so
 * this file can assert them DIRECTLY rather than relying on a guard that
 * silently skips exactly the case that fails.
 *
 * Edges are keyed on POSITION, not index — the same choice the guard makes,
 * and it is load-bearing: Babylon's own primitives split vertices at UV seams,
 * and this shell splits them at every quad, so an index-keyed test would call
 * a perfectly closed mesh open.
 */
function closure(geo: {
  positions: number[];
  normals: number[];
  indices: number[];
}): Closure {
  const { positions: p, normals: nr, indices: ix } = geo;
  const edges = new Map<string, number>();
  const key = (i: number): string =>
    `${Math.round(p[i * 3]! * 1e5)},${Math.round(p[i * 3 + 1]! * 1e5)},${Math.round(p[i * 3 + 2]! * 1e5)}`;
  let volume = 0;
  let agree = 0;
  let counted = 0;
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
    volume += (ax * (by * cz - bz * cy) + ay * (bz * cx - bx * cz) + az * (bx * cy - by * cx)) / 6;
    const ux = bx - ax, uy = by - ay, uz = bz - az;
    const vx = cx - ax, vy = cy - ay, vz = cz - az;
    const gx = uy * vz - uz * vy, gy = uz * vx - ux * vz, gz = ux * vy - uy * vx;
    const gl = Math.hypot(gx, gy, gz);
    if (!(gl > 1e-12)) continue;
    const nx = (nr[ia * 3]! + nr[ib * 3]! + nr[ic * 3]!) / 3;
    const ny = (nr[ia * 3 + 1]! + nr[ib * 3 + 1]! + nr[ic * 3 + 1]!) / 3;
    const nz = (nr[ia * 3 + 2]! + nr[ib * 3 + 2]! + nr[ic * 3 + 2]!) / 3;
    const nl = Math.hypot(nx, ny, nz);
    if (!(nl > 1e-12)) continue;
    agree += (gx * nx + gy * ny + gz * nz) / (gl * nl);
    counted += 1;
  }
  let openEdges = 0;
  for (const value of edges.values()) if (value !== 0) openEdges += 1;
  return {
    closed: openEdges === 0,
    openEdges,
    signedVolume: volume,
    agreement: counted > 0 ? agree / counted : 0,
  };
}

describe("the hangar shell is a closed manifold (7-10)", () => {
  it("closes on every plan the generator can produce", () => {
    const open: string[] = [];
    for (const [label, plan] of everyPlan()) {
      const result = closure(hangarShellGeometry(plan) as never);
      if (!result.closed) open.push(`${label}: ${result.openEdges} unmatched edges`);
    }
    expect(
      open,
      "an open shell is not merely cracked — it drops out of the winding "
      + "guard's signed-volume assertion, which skips open meshes silently",
    ).toEqual([]);
  });

  it("would report OPEN on a T-JUNCTION — the shape it actually missed", () => {
    // NON-VACUITY, and not a formality: the assertion above is exactly the
    // shape that passed while measuring nothing.
    //
    // A deleted triangle would prove less than it looks. The historical defect
    // left NO HOLE — every point of the eave was covered by some face; what
    // was wrong was that one full-width edge faced two half-width ones. So
    // this reproduces THAT: split one triangle's first edge at its midpoint
    // and leave its neighbour whole. The surface still covers everything and
    // is still watertight to the eye; only the edge bookkeeping disagrees.
    const [, plan] = everyPlan()[0]!;
    const geo = hangarShellGeometry(plan) as unknown as {
      positions: number[]; normals: number[]; uvs: number[]; indices: number[];
    };
    const positions = [...geo.positions];
    const normals = [...geo.normals];
    const [ia, ib, ic] = [geo.indices[0]!, geo.indices[1]!, geo.indices[2]!];
    const mid = positions.length / 3;
    for (let axis = 0; axis < 3; axis += 1) {
      positions.push((geo.positions[ia * 3 + axis]! + geo.positions[ib * 3 + axis]!) / 2);
      normals.push(geo.normals[ia * 3 + axis]!);
    }
    const indices = [ia, mid, ic, mid, ib, ic, ...geo.indices.slice(3)];
    const tJunction = closure({ positions, normals, indices });

    expect(
      tJunction.closed,
      "a T-junction was reported CLOSED — the detector cannot see the defect "
      + "this whole file exists for, and the assertion above proves nothing",
    ).toBe(false);
    // Three edges go unmatched: the neighbour's original full-width edge, and
    // the two halves that replaced it.
    expect(tJunction.openEdges).toBe(3);

    // And the control: the triangle count did not fall and no hole appeared,
    // so this is genuinely the no-hole case rather than a deletion in disguise.
    expect(indices.length).toBeGreaterThan(geo.indices.length);
  });

  it("winds every plan Babylon's way, by volume as well as by normal", () => {
    // Babylon's convention, pinned by the winding guard against its own
    // primitives: agreement -1, signed volume negative. Repeated here because
    // the guard only reaches the volume metric on a CLOSED mesh, and closure
    // is the property that just broke.
    for (const [label, plan] of everyPlan()) {
      const result = closure(hangarShellGeometry(plan) as never);
      expect(result.agreement, `${label} normals disagree with its winding`).toBeLessThan(-0.95);
      expect(result.signedVolume, `${label} is inside-out by volume`).toBeLessThan(0);
    }
  });

  it("keeps the gable-end tiling continuous across the roof's breakpoints", () => {
    // The closure fix split the gable ends on the roof's own segment
    // boundaries. U is measured from each quad's corner 0, so a naive split
    // restarts the tiling at every seam — a hard jump every 3.8 m on an arched
    // gable, where the split is 12 ways. `quad` takes a U origin to prevent it,
    // and this asserts the RESULT: U is a single linear function of x across
    // the whole face, independent of how it was cut.
    for (const [label, plan] of everyPlan()) {
      const shell = hangarShellGeometry(plan);
      const halfW = plan.widthMeters / 2;
      const halfD = plan.depthMeters / 2;
      let checked = 0;
      const bands = new Set<number>();
      for (let v = 0; v < shell.positions.length / 3; v += 1) {
        const x = shell.positions[v * 3]!;
        const z = shell.positions[v * 3 + 2]!;
        const nz = shell.normals[v * 3 + 2]!;
        // The shell's own -z gable geometry only. Detail solids also present
        // -z faces, and the gutter's sits in exactly this plane — but at
        // |x| >= halfW, outside the wall it hangs off.
        if (Math.abs(nz + 1) > 1e-9) continue;
        if (Math.abs(z + halfD) > 1e-9) continue;
        if (Math.abs(x) >= halfW - 1e-6) continue;
        const u = shell.uvs[v * 2]!;
        // The gable end is TWO bands with different tile periods — a concrete
        // skirt below the slab and metal cladding above — so continuity is
        // "matches its own band's period", not one global constant. The first
        // version of this test asserted the metal period everywhere and failed
        // on the skirt: a true failure about the test, not the geometry.
        // Vertices at y = 0 belong to both bands at once, which is why this
        // accepts either rather than selecting on y.
        const match = [AIRFIELD_METAL_TILE_METERS, AIRFIELD_CONCRETE_TILE_METERS]
          .find((period) => Math.abs(u - (halfW - x) / period) < 1e-6);
        expect(
          match,
          `${label}: U at x=${x.toFixed(2)} is ${u.toFixed(4)}, which is continuous `
          + "under neither tile period — the face restarts its tiling at a seam",
        ).toBeDefined();
        bands.add(match!);
        checked += 1;
      }
      expect(checked, `${label}: no gable vertex was checked`).toBeGreaterThan(4);
      // Non-vacuity for accepting either period: both bands must actually be
      // present, or "matches one of two" is doing no work on a face that only
      // ever has one.
      expect(bands.size, `${label}: only one tile period appeared on the gable`).toBe(2);
    }
  });
});

describe("hangar detail solids (7-10)", () => {
  it("emits every part in the roster, on every plan", () => {
    for (const [label, plan] of everyPlan()) {
      const present = new Set(hangarDetailBoxes(plan).map((b) => b.part));
      for (const part of HANGAR_DETAIL_PARTS) {
        expect(present.has(part), `${label} builds no ${part}`).toBe(true);
      }
    }
  });

  it("gives every solid a real extent on all three axes", () => {
    // A collapsed box contributes only degenerate triangles, which the shell
    // builder drops — so it would vanish with no error and no triangle to find.
    for (const [label, plan] of everyPlan()) {
      for (const box of hangarDetailBoxes(plan)) {
        for (let axis = 0; axis < 3; axis += 1) {
          expect(
            box.max[axis]! - box.min[axis]!,
            `${label}: ${box.part} is flat on axis ${axis}`,
          ).toBeGreaterThan(1e-3);
        }
      }
    }
  });

  it("stands every solid PROUD of the shell, so detail reads on the silhouette", () => {
    // `7-11`'s metal recipe says in as many words that "geometry on the
    // silhouette arrives via geometry in 7-10; this map carries the inboard
    // relief". A part sunk into the cladding delivers neither: it is invisible
    // in profile and z-fights with the wall it is buried in.
    for (const [label, plan] of everyPlan()) {
      const halfW = plan.widthMeters / 2;
      const halfD = plan.depthMeters / 2;
      for (const box of hangarDetailBoxes(plan)) {
        const proud = box.min[0]! < -halfW - 1e-6
          || box.max[0]! > halfW + 1e-6
          || box.min[2]! < -halfD - 1e-6
          || box.max[2]! > halfD + 1e-6
          || box.max[1]! > plan.ridgeHeightMeters + 1e-6;
        expect(proud, `${label}: ${box.part} is entirely inside the shell`).toBe(true);
      }
    }
  });

  it("clears the glazing above the door header on every plan", () => {
    // The collision this prevents renders as z-fighting between a metal header
    // and a dark glass band — a defect no triangle count would catch. The
    // builder throws when the clearance fails, so "no plan throws" IS the
    // assertion; the margin is reported too, because a rule that passes by
    // 1 mm is a rule about to fail.
    let tightest = Number.POSITIVE_INFINITY;
    for (const [label, plan] of everyPlan()) {
      const boxes = hangarDetailBoxes(plan);
      const header = boxes.find((b) => b.part === "door-header")!;
      const glazing = boxes.find((b) => b.part === "clerestory")!;
      const gap = glazing.min[1]! - header.max[1]!;
      expect(gap, `${label}: glazing sits ${gap.toFixed(2)} m from the header`)
        .toBeGreaterThanOrEqual(HANGAR_DETAIL.clerestoryClearanceMeters);
      tightest = Math.min(tightest, gap);
    }
    expect(tightest).toBeLessThan(5); // it is a real constraint, not slack
  });

  it("throws rather than smearing when a plan cannot clear it", () => {
    // NON-VACUITY for the rule above. Without this, "no plan throws" is
    // satisfied just as well by a builder that cannot throw at all.
    const [, plan] = everyPlan()[0]!;
    // The clearance fails below an eave of ~9.97 m; the generator's floor is
    // 11 m, which is why no producible plan trips it.
    expect(() => hangarDetailBoxes({ ...plan, eaveHeightMeters: 9, ridgeHeightMeters: 14 }))
      .toThrow(/clearance/);
    expect(() => hangarDetailBoxes(plan)).not.toThrow();
  });

  it("makes the hash-driven bay count visible as geometry", () => {
    // Without the pilasters, `bays` moves the eave height and nothing else, so
    // three hangars differing only in height read as one building at three
    // scales. This is the assertion that the bay count reaches the silhouette.
    const counts = new Map<number, number>();
    for (const [, plan] of everyPlan()) {
      const piers = hangarDetailBoxes(plan).filter((b) => b.part === "pilaster").length;
      counts.set(plan.bays, piers);
    }
    expect(counts.size).toBe(HANGAR_PLAN_LIMITS.maxBays - HANGAR_PLAN_LIMITS.minBays + 1);
    // One per bay boundary, on both gable ends.
    for (const [bays, piers] of counts) expect(piers).toBe((bays + 1) * 2);
    // And they genuinely differ across the space — a constant count would
    // satisfy "one per bay boundary" if the formula ignored `bays`.
    expect(new Set(counts.values()).size).toBeGreaterThan(1);
  });

  it("puts the door on the wall the apron sees", () => {
    // -across is the runway side. A door on a gable end would aim the
    // building's one recognisable feature along the runway, where no approach
    // pose ever sees it.
    for (const [label, plan] of everyPlan()) {
      const halfW = plan.widthMeters / 2;
      const leaves = hangarDetailBoxes(plan).filter((b) => b.part === "door-leaf");
      expect(leaves.length).toBe(HANGAR_DETAIL.doorLeaves);
      for (const leaf of leaves) {
        expect(leaf.max[0]!, `${label}: a door leaf is not on the -across wall`)
          .toBeCloseTo(-halfW, 9);
        expect(leaf.min[1]!, `${label}: a door leaf does not reach the slab`).toBe(0);
      }
      // The leaves must not overlap each other, or they read as one panel.
      const sorted = [...leaves].sort((a, b) => a.min[2]! - b.min[2]!);
      for (let i = 1; i < sorted.length; i += 1) {
        expect(sorted[i]!.min[2]!, `${label}: door leaves overlap`)
          .toBeGreaterThan(sorted[i - 1]!.max[2]!);
      }
    }
  });

  it("keeps the ridge vents clear of 7-14's ridge-end mounts", () => {
    for (const [label, plan] of everyPlan()) {
      const halfD = plan.depthMeters / 2;
      const vents = hangarDetailBoxes(plan).filter((b) => b.part === "ridge-vent");
      expect(vents.length).toBe(HANGAR_DETAIL.ventCount);
      for (const vent of vents) {
        expect(halfD - vent.max[2]!, `${label}: a vent crowds the +along ridge mount`)
          .toBeGreaterThan(2);
        expect(vent.min[2]! + halfD, `${label}: a vent crowds the -along ridge mount`)
          .toBeGreaterThan(2);
      }
    }
  });

  it("reports the height of the tallest metal, not of the ridge", () => {
    // `7-14` mounts obstruction lighting against `heightMeters`. The ridge
    // vents stand above the ridge, so a figure that stopped at the ridge would
    // put the light BELOW the highest thing on the building — the one place an
    // obstruction light must never be. Derived from the built geometry rather
    // than restated, so a part that grows taller than the vents fails here.
    for (const [label, plan] of everyPlan()) {
      const shell = hangarShellGeometry(plan);
      let top = Number.NEGATIVE_INFINITY;
      let bottom = Number.POSITIVE_INFINITY;
      for (let v = 0; v < shell.positions.length / 3; v += 1) {
        const y = shell.positions[v * 3 + 1]!;
        if (y > top) top = y;
        if (y < bottom) bottom = y;
      }
      const mounts = hangarAttachments(DEFAULT_AIRPORT, 0, plan, DEFAULT_AIRPORT.elevation);
      expect(mounts.heightMeters, `${label}: heightMeters is not the built height`)
        .toBeCloseTo(top - bottom, 6);
      // And the ridge really is below it, or the vents contribute nothing.
      expect(top).toBeGreaterThan(plan.ridgeHeightMeters);

      // AND THE FIELD THE CONSUMER ACTUALLY READS AGREES. `ObstructionLighting`
      // mounts its top lamps at `ridgeEnds` plus a 0.5 m stand and never looks
      // at `heightMeters` — so a correct `heightMeters` beside a ridge-height
      // `ridgeEnds` would fix nothing and read as fixed. Both are checked
      // against the same built geometry, so they cannot drift apart.
      const slab = DEFAULT_AIRPORT.elevation - DEFAULT_AIRPORT.elevation;
      for (const end of mounts.ridgeEnds) {
        expect(end[1] - slab, `${label}: a ridge mount is below the highest metal`)
          .toBeCloseTo(top, 6);
      }
    }
  });
});

describe("the vents do not outrank the obstruction lights (7-10 / 7-14)", () => {
  // `OBSTRUCTION_ROOF_STAND_METERS` in `ObstructionLighting.ts`. Duplicated
  // rather than imported ON PURPOSE: importing it would make this test agree
  // with that module by construction, and the property under test is exactly
  // that two modules agree about where the top of the building is. If that
  // module shrinks its stand below the ventilator height, this fails and the
  // conversation happens.
  const OBSTRUCTION_ROOF_STAND_METERS = 0.5;

  /** Highest lamp minus highest metal. Positive means the lamp clears. */
  function lampClearance(plan: HangarPlan, mountY: number): number {
    const shell = hangarShellGeometry(plan);
    let top = Number.NEGATIVE_INFINITY;
    for (let v = 0; v < shell.positions.length / 3; v += 1) {
      top = Math.max(top, shell.positions[v * 3 + 1]!);
    }
    return mountY + OBSTRUCTION_ROOF_STAND_METERS - top;
  }

  it("puts the highest lamp above every vertex of the shell", () => {
    // Against the MESH, not against a height formula. `ObstructionLighting`
    // mounts at `ridgeEnds` + the stand and reads no height field at all, so
    // the only thing that settles this is the geometry itself.
    for (const [label, plan] of everyPlan()) {
      const mounts = hangarAttachments(DEFAULT_AIRPORT, 0, plan, DEFAULT_AIRPORT.elevation);
      const slab = mounts.ridgeEnds[0]![1] - (plan.ridgeHeightMeters + HANGAR_DETAIL.ventHeightMeters);
      expect(
        lampClearance(plan, mounts.ridgeEnds[0]![1] - slab),
        `${label}: the highest obstruction lamp sits below the highest metal`,
      ).toBeGreaterThan(0);
    }
  });

  it("would FAIL with the mounts at the structural ridge — the fix is load-bearing", () => {
    // NON-VACUITY, and the first version of this test had none: once `ridgeEnds`
    // tracks the ventilator height, "vent top <= mount + stand" reduces to
    // "h <= h + 0.5" and is true by construction. It could never fail, on any
    // plan, for any vent height. A guard that cannot fail is not a guard.
    //
    // So the control reproduces the ACTUAL pre-fix state: mounts at the
    // structural ridge, which is where they sat until this change. A 0.7 m
    // ventilator against a 0.5 m stand means the highest lamp lands 0.2 m
    // BELOW the highest metal — the hazard, demonstrated rather than described.
    for (const [label, plan] of everyPlan()) {
      expect(
        lampClearance(plan, plan.ridgeHeightMeters),
        `${label}: ridge-height mounts already cleared the roof, so raising `
        + "them fixed nothing and this test is measuring the wrong thing",
      ).toBeLessThan(0);
    }
    // And the size of the miss, so a future stand change is visible as a number
    // rather than as a flipped boolean.
    const [, plan] = everyPlan()[0]!;
    expect(lampClearance(plan, plan.ridgeHeightMeters)).toBeCloseTo(
      OBSTRUCTION_ROOF_STAND_METERS - HANGAR_DETAIL.ventHeightMeters,
      9,
    );
  });
});

describe("the hangars do not read as primitives (7-10 organic pass)", () => {
  /**
   * Jason, on the first frame ever rendered of a hangar at apron range:
   * *"it looks like it was thrown together with a semi circle and a square.
   * Let's try to make it look more organic."*
   *
   * Every assertion here defends one of the cues that answers that. They are
   * PROPERTIES OF THE VARIANCE, not pinned values — a pinned crown offset
   * would be satisfied by a build that put all three hangars at the same
   * offset, which is the failure being fixed.
   */
  const SEEDS = [1_437_115_038, 1, 99, 12_345, 777_777];

  it("does not lay the eave heights out in an arithmetic sequence", () => {
    // THE ORIGINAL DEFECT. Eave came from bay count alone in fixed 0.9 m
    // steps, so three hangars formed a sequence and read as one building at
    // three scales — `AirfieldStructures` says exactly that in its own
    // pilaster comment. Equal gaps are the signature.
    let seedsWithUnequalGaps = 0;
    for (const seed of SEEDS) {
      const eaves = [0, 1, 2].map((i) => hangarPlanFrom(seed, i, 2.5).eaveHeightMeters);
      const gaps = [eaves[1]! - eaves[0]!, eaves[2]! - eaves[1]!];
      if (Math.abs(gaps[0]! - gaps[1]!) > 0.25) seedsWithUnequalGaps += 1;
    }
    expect(
      seedsWithUnequalGaps,
      "the eave heights still step evenly, so the three hangars are one "
      + "building at three scales",
    ).toBe(SEEDS.length);
  });

  it("puts the roof's high point OFF the centreline, in both directions", () => {
    const offsets = SEEDS.flatMap((seed) =>
      [0, 1, 2].map((i) => hangarPlanFrom(seed, i, 2.5).crownOffset));
    for (const offset of offsets) {
      expect(Math.abs(offset), "a crown sits too near the centreline to read").toBeGreaterThanOrEqual(HANGAR_PLAN_LIMITS.minCrownOffset - 1e-9);
      expect(Math.abs(offset)).toBeLessThanOrEqual(HANGAR_PLAN_LIMITS.maxCrownOffset + 1e-9);
    }
    // NON-VACUITY: a build that offset every crown the same way would satisfy
    // "non-zero" and still be mirror-symmetric as a ROW. Both signs must occur.
    expect(offsets.some((o) => o > 0), "no crown leans one way").toBe(true);
    expect(offsets.some((o) => o < 0), "no crown leans the other").toBe(true);
  });

  it("keeps the arch exponent BELOW the boxy direction", () => {
    // The first attempt at this used 2.3-3.2, which flattens a superellipse
    // toward a rounded RECTANGLE — the opposite of the note. A true segmental
    // arc stands at 0.782 of its rise at half-span; p = 2.8 stands at 0.946.
    expect(HANGAR_PLAN_LIMITS.maxArchExponent).toBeLessThanOrEqual(2.3);
    for (const seed of SEEDS) {
      for (let i = 0; i < 3; i += 1) {
        const plan = hangarPlanFrom(seed, i, 2.5);
        expect(plan.archExponent).toBeGreaterThanOrEqual(HANGAR_PLAN_LIMITS.minArchExponent);
        expect(plan.archExponent).toBeLessThanOrEqual(HANGAR_PLAN_LIMITS.maxArchExponent);
      }
    }
  });

  it("builds a roof that is not a dome: shallower rise than the old cosine", () => {
    // `archedRiseFraction` was 0.32 — a rise of 14.7 m over a 23 m half-span,
    // ratio 0.64, which is what read as a half-cylinder. Asserted as a RATIO
    // so it survives a width change.
    for (const seed of SEEDS) {
      for (let i = 0; i < 3; i += 1) {
        const plan = hangarPlanFrom(seed, i, 2.5);
        if (plan.roof !== "arched") continue;
        const ratio = (plan.ridgeHeightMeters - plan.eaveHeightMeters) / (plan.widthMeters / 2);
        expect(ratio, "the arch is back to dome proportions").toBeLessThan(0.55);
        expect(ratio, "the arch has flattened into a lid").toBeGreaterThan(0.28);
      }
    }
  });

  it("renders an ASYMMETRIC silhouette — the halves differ", () => {
    // The property a reader actually sees. Sample the built shell either side
    // of the centreline and require the two profiles to differ; a symmetric
    // roof is a primitive however its constants were drawn.
    for (const seed of SEEDS) {
      const plan = hangarPlanFrom(seed, 1, 2.5);
      const shell = hangarShellGeometry(plan);
      const halfW = plan.widthMeters / 2;
      // WHERE THE ROOF ACTUALLY PEAKS, read off the built vertices. The first
      // version of this sampled bands either side of the centreline and could
      // not see the answer: a gabled roof has three span vertices, so beyond
      // 35% of the half-width there is nothing but the two eaves, which are
      // equal by construction. It failed on geometry that was correct AND on
      // geometry that was wrong, which is no test at all.
      const crownAcross = halfW * plan.crownOffset;
      const peaks: number[] = [];
      for (let v = 0; v < shell.positions.length / 3; v += 1) {
        if (Math.abs(shell.positions[v * 3 + 1]! - plan.ridgeHeightMeters) < 1e-6) {
          peaks.push(shell.positions[v * 3]!);
        }
      }
      expect(peaks.length, "no vertex reaches the ridge height — the crown is not a VERTEX, "
        + "so the offset exists only between sample points and nothing renders it")
        .toBeGreaterThan(0);
      for (const x of peaks) {
        expect(x, "the roof peaks on the centreline — mirror-symmetric").toBeCloseTo(crownAcross, 6);
      }
      expect(Math.abs(crownAcross), "the crown offset is too small to see at apron range")
        .toBeGreaterThan(0.5);
    }
  });

  it("moves the ridge mounts and vents onto the crown, not the centreline", () => {
    // A mount left at across = 0 would hang over a roof that is no longer
    // highest there, and `7-14` puts its top obstruction lamp on it.
    for (const seed of SEEDS) {
      for (let i = 0; i < 3; i += 1) {
        const plan = hangarPlanFrom(seed, i, 2.5);
        const crownAcross = (plan.widthMeters / 2) * plan.crownOffset;
        const vents = hangarDetailBoxes(plan).filter((b) => b.part === "ridge-vent");
        for (const vent of vents) {
          const centre = (vent.min[0]! + vent.max[0]!) / 2;
          expect(centre, "a ridge vent still straddles the centreline")
            .toBeCloseTo(crownAcross, 6);
        }
        const mounts = hangarAttachments(DEFAULT_AIRPORT, i, plan, DEFAULT_AIRPORT.elevation);
        const footprint = hangarFootprint(DEFAULT_AIRPORT, i);
        for (const end of mounts.ridgeEnds) {
          expect(end[0] - footprint.across, "a ridge mount is on the centreline")
            .toBeCloseTo(crownAcross, 6);
        }
      }
    }
  });

  it("sets the hangars out by eye — seeded yaw, bounded and non-zero", () => {
    const yaws = SEEDS.flatMap((seed) => [0, 1, 2].map((i) => hangarYawRadians(seed, i)));
    for (const yaw of yaws) {
      expect(Math.abs(yaw), "a hangar sits on the exact runway axis").toBeGreaterThan(1e-9);
      expect(Math.abs(yaw)).toBeLessThanOrEqual(HANGAR_MAX_YAW_RADIANS + 1e-12);
    }
    expect(yaws.some((y) => y > 0) && yaws.some((y) => y < 0), "every hangar leans the same way").toBe(true);
    // The bound is what keeps this from becoming a collision: at the maximum a
    // 46 x 34 m footprint's corner moves under a metre, against 18 m of
    // clearance between hangars.
    const halfDiagonal = Math.hypot(46, 34) / 2;
    expect(halfDiagonal * Math.sin(HANGAR_MAX_YAW_RADIANS)).toBeLessThan(1);
  });

  it("costs no triangles — the whole pass is free in the draw budget", () => {
    // The constraint the pass was given. Every casting mesh costs 3.00 draws,
    // so form had to come from the shape already there rather than new
    // geometry. Asserted as a CEILING on the built shell, per plan.
    for (const seed of SEEDS) {
      for (let i = 0; i < 3; i += 1) {
        const plan = hangarPlanFrom(seed, i, 2.5);
        const triangles = hangarShellGeometry(plan).indices.length / 3;
        expect(triangles, "the shell grew past its budget").toBeLessThanOrEqual(600);
      }
    }
  });
});

describe("the glazing's cost is bounded (7-10)", () => {
  it("uses glass for the clerestory and for nothing else", () => {
    for (const [label, plan] of everyPlan()) {
      for (const box of hangarDetailBoxes(plan)) {
        if (box.surface === "glass") {
          expect(box.part, `${label}: ${box.part} is glazed`).toBe("clerestory");
        } else {
          expect(box.part, `${label}: the clerestory is not glazed`).not.toBe("clerestory");
        }
      }
    }
  });

  it("adds exactly one group, so glazing costs one draw per hangar", () => {
    // Draw calls are this airfield's binding axis, and `82c4182` measured
    // 2.00 draws per hangar mesh inside the LOD cull. A third material is a
    // third mesh; anything that split glass across more than one group would
    // multiply that without anybody noticing.
    for (const [label, plan] of everyPlan()) {
      const groups = hangarShellGeometry(plan).groups;
      const glass = groups.filter((g) => g.surface === "glass");
      expect(glass.length, `${label}: glass is split across groups`).toBe(1);
      expect(glass[0]!.count, `${label}: the glass group is empty`).toBeGreaterThan(0);
      expect(new Set(groups.map((g) => g.surface)).size).toBe(3);
    }
  });

  it("excludes glass from the caster surfaces and keeps the rest", () => {
    expect([...HANGAR_SHADOW_CASTING_SURFACES].sort()).toEqual(["concrete", "metal"]);
    // Every surface the shell can emit is either a caster or deliberately not.
    // A fourth surface added later is caught here rather than silently
    // defaulting to whichever branch the code happens to take.
    const surfaces = new Set(everyPlan().flatMap(([, plan]) =>
      hangarShellGeometry(plan).groups.map((g) => g.surface)));
    expect([...surfaces].sort()).toEqual(["concrete", "glass", "metal"]);
  });
});

describe("the detail sits on the airfield, not just in the plan", () => {
  it("keeps every hangar's detail inside its own footprint", () => {
    // The siting rules place hangars 52 m apart along the runway on a 34 m
    // depth. Detail that protruded past the footprint would let two hangars
    // interpenetrate — the same class of bug as the lateral-band collision
    // the furniture had.
    for (let index = 0; index < 3; index += 1) {
      const plan = hangarPlanFrom(1_234, index, 2.5);
      const footprint = hangarFootprint(DEFAULT_AIRPORT, index);
      const maxProud = Math.max(
        HANGAR_DETAIL.pilasterProudMeters,
        HANGAR_DETAIL.gutterProudMeters,
        HANGAR_DETAIL.doorProudMeters * 2 + 0.05,
        HANGAR_DETAIL.clerestoryProudMeters,
      );
      for (const box of hangarDetailBoxes(plan)) {
        expect(Math.abs(box.min[2]!)).toBeLessThanOrEqual(footprint.depthMeters / 2 + maxProud + 1e-6);
        expect(Math.abs(box.max[2]!)).toBeLessThanOrEqual(footprint.depthMeters / 2 + maxProud + 1e-6);
        expect(Math.abs(box.min[0]!)).toBeLessThanOrEqual(footprint.widthMeters / 2 + maxProud + 1e-6);
        expect(Math.abs(box.max[0]!)).toBeLessThanOrEqual(footprint.widthMeters / 2 + maxProud + 1e-6);
      }
      // Non-vacuity: the whole check is empty if no box was examined.
      expect(hangarDetailBoxes(plan).length).toBeGreaterThan(10);
    }
  });
});
