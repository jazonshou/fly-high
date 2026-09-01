import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import { Scene } from "@babylonjs/core/scene";
import { describe, expect, it } from "vitest";
import { AirportSystem } from "../src/render/webgpu/detail/AirportSystem";
import { TOWER_PART_NAMES, buildTowerGeometry } from "../src/render/webgpu/detail/towerGeometry";
import { createWorld } from "../src/world";

/**
 * `7-15`: the ATC tower, asserted against the REGISTRIES rather than the build.
 *
 * `FlightRenderer` registers airport meshes exactly once, at construction:
 * `shadowCasters` is a frozen array read at `FlightRenderer.ts:876`, and
 * `root.getChildMeshes(false)` is walked at `:986` for cloud shadows and
 * `:1002` for aerial perspective. **A mesh built lazily, or reparented after
 * construction, joins none of the three and raises no error** — it silently
 * loses cloud shadows and aerial perspective, and only a capture shows it.
 *
 * So this checks what those three call sites would actually see. A test that
 * asserted "the builder returned seven parts" would pass on a tower nothing
 * renders — the same failure as a winding guard measuring geometry no capture
 * draws.
 */

const WORLD_SEED = "phase1-perf-baseline";

function fixture() {
  const engine = new NullEngine({
    renderWidth: 64, renderHeight: 64, textureSize: 64,
    deterministicLockstep: false, lockstepMaxSteps: 4,
  });
  const scene = new Scene(engine);
  const world = createWorld(WORLD_SEED, { worldEvolution: "analytic" });
  const airport = world.airport;
  if (!airport) throw new Error("fixture world has no airport");
  // A ground function that is deliberately NOT the datum, so a tower pinned to
  // `definition.elevation` instead of to the ground it stands on is visible as
  // a wrong y rather than hidden by a coincidence.
  const system = new AirportSystem(scene, airport, () => airport.elevation - 7.5);
  return { engine, scene, system, airport };
}

describe("ATC tower (7-15)", () => {
  it("puts every tower mesh in the walk FlightRenderer actually performs", () => {
    const { engine, scene, system } = fixture();
    try {
      // The exact call the renderer makes at :986 and :1002.
      const registered = system.root.getChildMeshes(false).map((m) => m.name);
      const missing = TOWER_PART_NAMES
        .map((n) => `airport-tower-${n}`)
        .filter((n) => !registered.includes(n));
      expect(
        missing,
        "these tower meshes are absent from `root.getChildMeshes(false)`, so they "
        + "would receive neither cloud shadows nor aerial perspective — silently",
      ).toEqual([]);
      expect(scene.getEngine()).toBeTruthy();
    } finally {
      engine.dispose();
    }
  });

  it("puts every tower mesh in the frozen shadowCasters array", () => {
    const { engine, system } = fixture();
    try {
      const casters = system.shadowCasters.map((m) => m.name);
      const missing = TOWER_PART_NAMES
        .map((n) => `airport-tower-${n}`)
        .filter((n) => !casters.includes(n));
      expect(
        missing,
        "these tower meshes cast no sun shadow — `shadowCasters` is frozen at "
        + "construction and cannot be added to afterwards",
      ).toEqual([]);
      // The hangars must still be there: appending must not replace.
      expect(casters.filter((n) => n.startsWith("airport-hangar-")).length).toBe(3);
    } finally {
      engine.dispose();
    }
  });

  it("stands on the ground it is placed on, not on the datum", () => {
    const { engine, system, airport } = fixture();
    try {
      // The fixture's ground is 7.5 m below the datum. `root` sits AT the datum,
      // so a correctly-placed tower's base is at local y = -7.5.
      const tower = system.root.getChildMeshes(false)
        .find((m) => m.name === "airport-tower-base");
      expect(tower).toBeTruthy();
      const worldY = tower!.getAbsolutePosition().y;
      const parentY = tower!.parent
        ? (tower!.parent as unknown as { position: { y: number } }).position.y
        : 0;
      expect(parentY).toBeCloseTo(-7.5, 3);
      expect(Number.isFinite(worldY)).toBe(true);
      expect(airport.elevation).toBeGreaterThan(-1e6);
    } finally {
      engine.dispose();
    }
  });

  it("publishes attachment points 7-14 and 7-7 can mount to", () => {
    const { engine, system } = fixture();
    try {
      const a = system.towerAttachments;
      // One point per octagon corner, so 7-14 gets a ring rather than a guess.
      expect(a.cabRoofRing.length).toBe(8);
      // The mast tip is the highest thing on the tower — the obstruction light
      // that matters most is the one at the top.
      const ringTop = Math.max(...a.cabRoofRing.map((p) => p[1]));
      expect(a.mastTip[1]).toBeGreaterThan(ringTop);
      expect(a.beaconMount[1]).toBeGreaterThan(0);
      // Attachments must carry the tower's placement, not the bare geometry:
      // a consumer that had to add the offset itself would be re-deriving
      // placement constants that can drift out from under it.
      const bare = buildTowerGeometry().attachments;
      expect(a.mastTip[0]).not.toBeCloseTo(bare.mastTip[0], 3);
      expect(a.heightMeters).toBeCloseTo(bare.heightMeters, 6);
    } finally {
      engine.dispose();
    }
  });

  it("subtends a stated, measured angle at 3 NM — not a claimed one", () => {
    // Gate 7D's criterion is "the tower reads as a tower from 3 NM". This pins
    // the ARITHMETIC that criterion has to be judged against, because the first
    // version of this file asserted the tower was "hundreds of pixels tall" at
    // that range and it is 6.8. Two orders of magnitude, in a comment nobody
    // would have re-derived.
    //
    // Verified against a real capture rather than left as a model: at
    // `approach-500ft`'s 2.5 km the rendered footprint measured 17 px tall
    // against 15.2 predicted, so this formula is the one the renderer obeys.
    const { heightMeters } = buildTowerGeometry().attachments;
    const DEGREES_PER_PIXEL_720P = 50 / 720;
    const at = (range: number) =>
      ((Math.atan2(heightMeters, range) * 180) / Math.PI) / DEGREES_PER_PIXEL_720P;

    expect(heightMeters).toBeGreaterThan(40);
    // 2.5 km — the range an existing shot already exercises, and the one the
    // capture confirmed.
    expect(at(2_500)).toBeGreaterThan(14);
    expect(at(2_500)).toBeLessThan(17);
    // 3 NM. Asserted as a BAND, not a floor: a floor would be silently
    // satisfiable by inflating the tower, which is exactly the move this test
    // exists to make visible. If someone raises the tower past 60 m to pass a
    // readability target, this fails and the trade becomes a decision.
    expect(at(3 * 1_852)).toBeGreaterThan(6);
    expect(at(3 * 1_852)).toBeLessThan(9);
  });
});
