import { describe, expect, it } from "vitest";
import {
  cockpitTerrainCoverage,
  PERF_CAPTURE_DEFAULT_CLOCK,
  PERF_CAPTURE_HEIGHT,
  PERF_CAPTURE_SEED,
  PERF_CAPTURE_SHOTS,
  PERF_CAPTURE_WIDTH,
  yawForSunBearing,
} from "../scripts/perf-capture.mts";
import { sunDirectionForClock } from "../src/render/webgpu/nature/EnvironmentDirector";
import { createWorld, sampleTerrainHeight } from "../src/world";
import { runwayToWorld } from "../src/world/airport";
import {
  HANGAR_DETAIL,
  hangarAttachments,
  hangarFootprint,
  hangarFootprintSamples,
  hangarPlanFrom,
  hangarSeatingFrom,
} from "../src/render/webgpu/airfield/AirfieldStructures";

/**
 * `apron-hangar-variety` is a REGRESSION instrument for 7-10's "visually
 * distinct under the same seed", so the thing that must not rot is not the
 * frame's prettiness — it is that the frame still CONTAINS a contrast.
 *
 * **The non-vacuity leg is the point.** A seed change, a channel change or a
 * re-tuned `minBays` could make all three hangars draw the same plan, and the
 * shot would keep capturing happily while testing nothing at all. `7-9` shipped
 * `horizon-shadow-far-annulus` with 0 stems/m2 at every sampled range for
 * exactly this reason: a shot that could not fail.
 *
 * **The framing leg exists because the terrain oracle cannot do it.**
 * `cockpitTerrainCoverage` marches rays against terrain and sea and is blind to
 * buildings — it returns identical numbers whether or not a hangar is there. It
 * can only rule out the shot becoming a capture of open ocean. Whether the
 * hangars are IN FRAME needs a projection, which is what this file computes.
 */
const shot = PERF_CAPTURE_SHOTS.find((s) => s.name === "apron-hangar-variety");
if (!shot) throw new Error("The apron-hangar-variety capture shot is missing");
const SHOT = shot;

const world = createWorld(PERF_CAPTURE_SEED, { worldEvolution: "analytic" });
const airport = world.airport;
if (!airport) throw new Error("The capture seed must build an airport");
const AIRPORT = airport;

/**
 * Sample, seat, plan, attach — the shipping path, so this guard MODELS nothing
 * about the building's vertical extent.
 *
 * **Two versions of this file got the extent wrong at opposite ends.** The
 * first projected slab-to-ridge: the concrete skirt hangs BELOW the slab, so a
 * frame cropping it would have passed. The second fixed the bottom and left the
 * top at the ridge — but `7-10`'s ventilators stand `ventHeightMeters` above it,
 * on the centreline, where they are the silhouette's highest point from any
 * oblique angle. **Both times the verdict happened to survive; both times the
 * solid was shorter than the one that draws.**
 *
 * **So the extent is not composed here.** `hangarAttachments().heightMeters` IS
 * the skirt-foot-to-vent-top height, and `render.webgpu-hangar-detail.test.ts`
 * asserts it equals `max(y) - min(y)` over the built shell's own positions. If a
 * part ever grows taller than the vents, that assertion and this projection move
 * together and neither needs editing. Adding a literal 0.7 here would have been
 * a third transcription waiting to drift.
 *
 * **The skirt is `max(relief, MINIMUM_SKIRT_METERS)`, not the raw relief** — a
 * floor a hand-rolled min/max misses on flat ground, so `hangarSeatingFrom` does
 * it. Likewise `hangarFootprintSamples` guarantees the corners are sampled; a
 * stride that misses them under-reports relief, which is the reassuring answer.
 */
function hangarAt(index: number) {
  const footprint = hangarFootprint(AIRPORT, index);
  const groundSamples = hangarFootprintSamples(footprint, 2).map((sample) => {
    const point = runwayToWorld(AIRPORT, sample.along, sample.across);
    return sampleTerrainHeight(world, point.x, point.z);
  });
  const seating = hangarSeatingFrom(groundSamples);
  const plan = hangarPlanFrom(world.seedHash, index, seating.skirtHeightMeters);
  const attachments = hangarAttachments(AIRPORT, index, plan, seating.baseAltitudeMeters);
  const bottomMeters = seating.baseAltitudeMeters - seating.skirtHeightMeters;
  return {
    index,
    footprint,
    plan,
    bottomMeters,
    topMeters: bottomMeters + attachments.heightMeters,
  };
}

const HANGARS = [0, 1, 2].map(hangarAt);

/** Cockpit rig: FOVMODE_HORIZONTAL_FIXED at 56 deg (FlightRenderer.updateCamera). */
const HORIZONTAL_FOV_DEGREES = 56;
const VERTICAL_FOV_DEGREES = (2 * Math.atan(
  Math.tan((HORIZONTAL_FOV_DEGREES / 2) * Math.PI / 180)
  * (PERF_CAPTURE_HEIGHT / PERF_CAPTURE_WIDTH),
) * 180) / Math.PI;

function cameraGround(): { x: number; z: number; ground: number } {
  const x = AIRPORT.centerX + SHOT.offsetXMeters;
  const z = AIRPORT.centerZ + SHOT.offsetZMeters;
  return { x, z, ground: sampleTerrainHeight(world, x, z) };
}

function shotYawDegrees(): number {
  const clock = SHOT.clock ?? PERF_CAPTURE_DEFAULT_CLOCK;
  return yawForSunBearing(
    sunDirectionForClock(clock, world.latitudeDegrees),
    SHOT.relativeSunBearingDegrees ?? 0,
  );
}

function angularExtent(hangarIndex: number) {
  const h = HANGARS[hangarIndex]!;
  const { x, z, ground } = cameraGround();
  const agl = SHOT.altitudeAglMeters ?? 0;
  const yaw = (shotYawDegrees() * Math.PI) / 180;
  const forward = [Math.cos(yaw), 0, -Math.sin(yaw)] as const;
  const right = [Math.sin(yaw), 0, Math.cos(yaw)] as const;
  const eye = [x + forward[0] * 1.15, ground + agl + 1.12, z + forward[2] * 1.15] as const;
  let horizMin = Infinity, horizMax = -Infinity, vertMin = Infinity, vertMax = -Infinity;
  for (const da of [-h.footprint.depthMeters / 2, h.footprint.depthMeters / 2]) {
    for (const dc of [-h.footprint.widthMeters / 2, h.footprint.widthMeters / 2]) {
      for (const y of [h.bottomMeters, h.topMeters]) {
        const p = runwayToWorld(AIRPORT, h.footprint.along + da, h.footprint.across + dc);
        const v = [p.x - eye[0], y - eye[1], p.z - eye[2]] as const;
        const f = v[0] * forward[0] + v[2] * forward[2];
        if (f <= 0) continue;
        const r = v[0] * right[0] + v[2] * right[2];
        horizMin = Math.min(horizMin, (Math.atan2(r, f) * 180) / Math.PI);
        horizMax = Math.max(horizMax, (Math.atan2(r, f) * 180) / Math.PI);
        const av = (Math.atan2(v[1], Math.hypot(v[0], v[2])) * 180) / Math.PI;
        vertMin = Math.min(vertMin, av);
        vertMax = Math.max(vertMax, av);
      }
    }
  }
  return { horizMin, horizMax, vertMin, vertMax };
}

describe("apron-hangar-variety capture shot", () => {
  it("keeps a plan contrast to photograph, in BOTH hash channels", () => {
    const bays = new Set(HANGARS.map((h) => h.plan.bays));
    const roofs = new Set(HANGARS.map((h) => h.plan.roof));
    // Without this the shot still captures, and tests nothing.
    expect(bays.size).toBeGreaterThan(1);
    expect(roofs.size).toBeGreaterThan(1);
    // The two the framing is built around must themselves differ in both.
    expect(HANGARS[0]!.plan.bays).not.toBe(HANGARS[1]!.plan.bays);
    expect(HANGARS[0]!.plan.roof).not.toBe(HANGARS[1]!.plan.roof);
  });

  it("carries the bay count into visible geometry via pilaster PITCH", () => {
    // Pier WIDTH is frozen, so it can never distinguish two hangars; a budget
    // or a guard gated on it reads the same whether bay counts vary or not.
    const pitches = HANGARS.map(
      (h) => (h.footprint.widthMeters - HANGAR_DETAIL.pilasterWidthMeters) / h.plan.bays,
    );
    expect(new Set(pitches.map((p) => p.toFixed(2))).size).toBe(HANGARS.length);
    // The two framed hangars must differ enough to read, not merely differ.
    const ratio = Math.max(pitches[0]!, pitches[1]!) / Math.min(pitches[0]!, pitches[1]!);
    expect(ratio).toBeGreaterThan(1.5);
  });

  it("frames both target hangars fully inside the cockpit frustum", () => {
    const halfH = HORIZONTAL_FOV_DEGREES / 2;
    const halfV = VERTICAL_FOV_DEGREES / 2;
    for (const index of [0, 1]) {
      const e = angularExtent(index);
      expect(e.horizMin).toBeGreaterThan(-halfH);
      expect(e.horizMax).toBeLessThan(halfH);
      expect(e.vertMin).toBeGreaterThan(-halfV);
      expect(e.vertMax).toBeLessThan(halfV);
    }
  });

  it("is a ground pose looking at terrain rather than open ocean", () => {
    const { x, z, ground } = cameraGround();
    expect(SHOT.cameraMode).toBe("cockpit");
    expect(SHOT.altitudeAglMeters).not.toBeNull();
    expect(SHOT.locate).toBeUndefined(); // offsets are a POSITION, not a search seed
    const coverage = cockpitTerrainCoverage({
      aircraftPosition: [x, ground + (SHOT.altitudeAglMeters ?? 0), z],
      yawDegrees: shotYawDegrees(),
      pitchDownDegrees: SHOT.pitchDownDegrees,
      seaLevelMeters: world.seaLevel,
      terrainHeightAt: (px, pz) => sampleTerrainHeight(world, px, pz),
      viewportWidth: PERF_CAPTURE_WIDTH,
      viewportHeight: PERF_CAPTURE_HEIGHT,
      horizontalFovDegrees: HORIZONTAL_FOV_DEGREES,
    });
    expect(coverage.terrainHitFraction).toBeGreaterThan(0.3);
    expect(coverage.seaHits / coverage.sampledRays).toBeLessThan(0.05);
  });
});
