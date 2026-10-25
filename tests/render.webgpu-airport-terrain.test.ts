import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import { PBRMaterial } from "@babylonjs/core/Materials/PBR/pbrMaterial";
import { ShaderLanguage } from "@babylonjs/core/Materials/shaderLanguage";
import { Scene } from "@babylonjs/core/scene";
import { describe, expect, it } from "vitest";
import {
  TERRAIN_PAGE_GRADED_BY_NONE,
  TERRAIN_PAGE_GRADED_BY_SEVERAL,
  diffTerrainAirports,
  sameTerrainAirports,
  terrainAirportAirfieldReach,
  terrainAirportGradingReach,
  terrainPageAirportDomain,
  terrainPageGradingAirport,
  terrainRectIntersectsAirportReach,
} from "@/src/render/webgpu/terrain/AirportReach";
import {
  RUNWAY_EARTHWORKS_SET_FLOATS,
  RUNWAY_EARTHWORKS_UNIFORM_FLOATS,
  RUNWAY_EARTHWORKS_WGSL,
  TERRAIN_AIRPORT_SLOTS,
  packRunwayEarthworksSetUniform,
  packRunwayEarthworksUniform,
  runwayEarthworksHeightLocal,
  runwayEarthworksSetWgsl,
} from "@/src/render/webgpu/terrain/RunwayEarthworks";
import {
  RUNWAY_SDF_WGSL,
  RUNWAY_SURFACE_UNIFORMS,
  RUNWAY_SURFACE_WGSL,
  resolveRunwaySurfaceBinding,
  resolveRunwaySurfaceSetBinding,
} from "@/src/render/webgpu/terrain/RunwaySurface";
import { terrainPageGenerationWgsl } from "@/src/render/webgpu/terrain/TerrainPageAtlas";
import { TerrainSurfacePlugin } from "@/src/render/webgpu/terrain/TerrainSurfacePlugin";
import {
  terrainChannelTexelSizeMeters,
  terrainTexelSizeMeters,
} from "@/src/render/webgpu/terrain/TerrainSpineContract";
import { LAND_COVER_SPLAT_BAKE_WGSL } from "@/src/render/webgpu/terrain/LandCoverClassifier";
import {
  WORLD_PAGE_BASE_EXTENT_METERS,
  WORLD_PAGE_GUTTER,
} from "@/src/render/webgpu/world/pageGeometry";
import {
  createWorldPageAddress,
  worldPageBounds,
  type WorldPageAddress,
} from "@/src/render/webgpu/world/pageKey";
import {
  AIRPORT_SPAWN_POLICY,
  createWorld,
  getAirportInfluence,
  roundedRectangleSignedDistance,
  sampleNaturalTerrainHeight,
  sampleTerrainHeight,
  worldAirportAt,
  worldToRunway,
  type AirportDefinition,
} from "@/src/world";
import { oracleReaches, twoAirportWorld } from "./support/twoAirportWorld";

/**
 * The GPU terrain grades, paints and classifies EVERY airport in
 * `world.airports`, from fixed-size uniform arrays.
 *
 * What a Node test can hold: the packed uniforms (slot `n` is the one-airport
 * struct of airport `n`, bit for bit, so the GPU evaluates exactly what
 * assertion 82 already pins against the CPU), the nearest-centre selection the
 * shaders run over those f32 values against `worldAirportAt`, and the reach
 * geometry against an independent oracle. The WGSL itself runs in
 * `tests/gpu/runway-earthworks-set-parity.test.ts`; the clipmap's rebuild in
 * `tests/render.webgpu-terrain-airport-rebuild.test.ts`.
 */

/**
 * The shaders' nearest-centre rule, in f32, over centres read back out of the
 * packed uniforms — `terrainRunwayEarthworksSlot`, `terrainRunwayNearestSlot`
 * and the splat bake's per-texel loop are the same loop.
 */
function nearestSlotF32(
  centres: readonly (readonly [number, number])[],
  x: number,
  z: number,
): number {
  const f = Math.fround;
  const px = f(x);
  const pz = f(z);
  const squared = (index: number): number => {
    const dx = f(px - f(centres[index]![0]));
    const dz = f(pz - f(centres[index]![1]));
    return f(f(dx * dx) + f(dz * dz));
  };
  let best = 0;
  let bestDistance = squared(0);
  for (let slot = 1; slot < centres.length; slot += 1) {
    const distance = squared(slot);
    if (distance < bestDistance) {
      best = slot;
      bestDistance = distance;
    }
  }
  return best;
}

/** The centres `terrainRunwayEarthworksSlot` reads: `airports[slot].site.yz`. */
function earthworksSetCentres(packed: Float32Array): [number, number][] {
  const count = new Uint32Array(packed.buffer)[0]!;
  return Array.from({ length: count }, (_, slot) => {
    const base = 4 + slot * RUNWAY_EARTHWORKS_UNIFORM_FLOATS;
    return [packed[base + 1]!, packed[base + 2]!] as [number, number];
  });
}

function slotWords(packed: Float32Array, slot: number): number[] {
  const start = 4 + slot * RUNWAY_EARTHWORKS_UNIFORM_FLOATS;
  return [...new Uint32Array(packed.buffer, start * 4, RUNWAY_EARTHWORKS_UNIFORM_FLOATS)];
}

/** Probes over an airport's whole earthworks: platform, batter, and 20 m past it. */
function earthworksProbes(airport: Readonly<AirportDefinition>, steps = 20): { x: number; z: number }[] {
  const halfLength = airport.runwayLength * 0.5 + airport.endSafetyArea + airport.terrainBlendDistance + 20;
  const halfWidth = airport.runwayWidth * 0.5 + airport.shoulderWidth + airport.terrainBlendDistance + 20;
  const sin = Math.sin(airport.headingRadians);
  const cos = Math.cos(airport.headingRadians);
  const probes: { x: number; z: number }[] = [];
  for (let alongStep = -steps; alongStep <= steps; alongStep += 1) {
    for (let acrossStep = -steps; acrossStep <= steps; acrossStep += 1) {
      const along = (alongStep / steps) * halfLength;
      const across = (acrossStep / steps) * halfWidth;
      probes.push({
        x: airport.centerX + along * sin + across * cos,
        z: airport.centerZ + along * cos - across * sin,
      });
    }
  }
  return probes;
}

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

describe("airport terrain uniforms", () => {
  it("compiles exactly as many airport slots as the network can hold", () => {
    // Restated in RunwayEarthworks.ts to keep an import cycle open; pinned here.
    expect(TERRAIN_AIRPORT_SLOTS).toBe(AIRPORT_SPAWN_POLICY.maxAirports);
    expect(RUNWAY_EARTHWORKS_SET_FLOATS).toBe(4 + TERRAIN_AIRPORT_SLOTS * RUNWAY_EARTHWORKS_UNIFORM_FLOATS);
    const set = runwayEarthworksSetWgsl("earthworks");
    expect(set).toContain(`airports: array<RunwayEarthworks, ${TERRAIN_AIRPORT_SLOTS}>`);
    expect(set).toContain("header: vec4u");
    // WGSL layout: a 16-byte header, then 64-byte structs at 16-byte alignment.
    expect(RUNWAY_EARTHWORKS_UNIFORM_FLOATS * 4).toBe(64);
  });

  it("packs slot n as airport n's one-airport struct, bit for bit", () => {
    const world = createWorld("alpha");
    const home = world.airport!;
    const one = packRunwayEarthworksSetUniform([home], world.seedHash);
    const words = new Uint32Array(one.buffer);
    expect([...words.subarray(0, 4)]).toEqual([1, 0, 0, 0]);
    expect(slotWords(one, 0)).toEqual([...new Uint32Array(packRunwayEarthworksUniform(home, world.seedHash).buffer)]);
    // Every other slot is zero, so its enabled lane reads 0.
    expect(words.subarray(4 + RUNWAY_EARTHWORKS_UNIFORM_FLOATS).every((word) => word === 0)).toBe(true);
    // No airport: count 0 and slot 0 disabled, so the earthworks return the natural height.
    expect(packRunwayEarthworksSetUniform([], world.seedHash).every((value) => value === 0)).toBe(true);

    const many = Array.from({ length: TERRAIN_AIRPORT_SLOTS + 3 }, (_, index) => ({
      ...home,
      centerX: home.centerX + 10_000 * index,
      headingRadians: home.headingRadians + index * 0.1,
    }));
    const full = packRunwayEarthworksSetUniform(many, world.seedHash);
    expect(new Uint32Array(full.buffer)[0]).toBe(TERRAIN_AIRPORT_SLOTS);
    for (let slot = 0; slot < TERRAIN_AIRPORT_SLOTS; slot += 1) {
      expect(slotWords(full, slot)).toEqual(
        [...new Uint32Array(packRunwayEarthworksUniform(many[slot]!, world.seedHash).buffer)],
      );
    }
  });

  it("paints slot n with airport n's frame and shape, and slot 0 alone in a one-airport world", () => {
    const { home, spawned } = twoAirportWorld();
    const single = resolveRunwaySurfaceSetBinding([home]);
    const scalar = resolveRunwaySurfaceBinding(home);
    expect(single.count).toBe(1);
    expect([...single.frames.subarray(0, 4)]).toEqual([...new Float32Array(scalar.frame)]);
    expect([...single.shapes.subarray(0, 4)]).toEqual([...new Float32Array(scalar.shape)]);
    expect(single.frames.subarray(4).every((value) => value === 0)).toBe(true);
    const pair = resolveRunwaySurfaceSetBinding([home, spawned]);
    expect(pair.count).toBe(2);
    expect([...pair.frames.subarray(4, 8)]).toEqual([...new Float32Array(resolveRunwaySurfaceBinding(spawned).frame)]);
    expect(RUNWAY_SURFACE_UNIFORMS.filter((entry) => entry.arraySize === TERRAIN_AIRPORT_SLOTS)
      .map((entry) => entry.name)).toEqual(["terrainRunwayFrames", "terrainRunwayShapes"]);
  });

  it("selects one airport per texel and fragment, then evaluates the existing profile once", () => {
    const generation = terrainPageGenerationWgsl("", "", `${RUNWAY_SDF_WGSL}\n${RUNWAY_EARTHWORKS_WGSL}`);
    expect(generation).toContain("var<storage, read> earthworks: RunwayEarthworksSet;");
    expect(generation).toContain("terrainRunwayEarthworksNearestHeight(");
    // ONE call site of the profile: inside the nearest-airport wrapper.
    expect(generation.split("terrainRunwayEarthworksHeight(").length - 1).toBe(2); // definition + the wrapper's call

    expect(RUNWAY_SURFACE_WGSL).toContain("fn terrainRunwayNearestSlot(");
    // The SDF half is composed into compute shaders, which have no `uniforms`.
    expect(RUNWAY_SDF_WGSL).not.toContain("uniforms.");

    expect(LAND_COVER_SPLAT_BAKE_WGSL).toContain(
      `var<storage, read> splatAirports: array<SplatAirport, ${TERRAIN_AIRPORT_SLOTS}>`,
    );
    // The per-texel choice is gated per page; one reaching airport takes the job's lanes.
    expect(LAND_COVER_SPLAT_BAKE_WGSL).toContain("if (job.airportSet.z > 1.5)");

    const engine = new NullEngine();
    const scene = new Scene(engine);
    const material = new PBRMaterial("airport-terrain-test", scene);
    const plugin = new TerrainSurfacePlugin(material);
    try {
      const code = plugin.getCustomCode("fragment", ShaderLanguage.WGSL) as Record<string, string>;
      const fragment = Object.values(code).join("\n");
      expect(fragment.split("terrainRunwayNearestSlot(terrainAbsolutePosition.xz)").length - 1).toBe(1);
      expect(fragment).not.toContain("uniforms.terrainRunwayFrame,");
      const names = plugin.getUniforms().ubo?.map((entry) => entry.name) ?? [];
      expect(names).toEqual(expect.arrayContaining(["terrainRunwayFrames", "terrainRunwayShapes", "terrainRunwaySet"]));
      expect(names).not.toContain("terrainRunwayFrame");
    } finally {
      material.dispose(true, true);
      scene.dispose();
      engine.dispose();
    }
  });
});

describe("two-airport earthworks: CPU authority vs the shader's rule", () => {
  it("grades the spawned airport exactly as sampleTerrainHeight does, and leaves the bisector natural", () => {
    const { next, home, spawned } = twoAirportWorld();
    const packed = packRunwayEarthworksSetUniform(next.airports, next.seedHash);
    expect(new Uint32Array(packed.buffer)[0]).toBe(2);
    next.airports.forEach((airport, slot) => {
      expect(slotWords(packed, slot)).toEqual(
        [...new Uint32Array(packRunwayEarthworksUniform(airport, next.seedHash).buffer)],
      );
    });
    const centres = earthworksSetCentres(packed);

    const probes = [
      ...earthworksProbes(spawned),
      ...earthworksProbes(home, 10),
    ];
    // Across the perpendicular bisector, where the selection changes airport.
    const midX = (home.centerX + spawned.centerX) * 0.5;
    const midZ = (home.centerZ + spawned.centerZ) * 0.5;
    const gap = Math.hypot(spawned.centerX - home.centerX, spawned.centerZ - home.centerZ);
    const unitX = (spawned.centerX - home.centerX) / gap;
    const unitZ = (spawned.centerZ - home.centerZ) / gap;
    for (let along = -200; along <= 200; along += 2.5) {
      for (const across of [-3_000, -500, 0, 500, 3_000]) {
        probes.push({ x: midX + along * unitX - across * unitZ, z: midZ + along * unitZ + across * unitX });
      }
    }

    let graded = 0;
    let selectedSpawned = 0;
    let selectionDisagreements = 0;
    for (const probe of probes) {
      const natural = sampleNaturalTerrainHeight(next.seedHash, probe.x, probe.z, 0);
      const slot = nearestSlotF32(centres, probe.x, probe.z);
      const airport = next.airports[slot]!;
      const local = worldToRunway(airport, probe.x, probe.z);
      // The ONE evaluation the shader makes, of the slot it selected.
      const shader = runwayEarthworksHeightLocal(
        airport, natural, local.along, local.across, probe.x, probe.z, next.seedHash,
      );
      const authority = sampleTerrainHeight(next, probe.x, probe.z);
      expect(shader).toBe(authority);
      if (authority !== natural) graded += 1;
      if (airport === spawned) selectedSpawned += 1;
      if (worldAirportAt(next, probe.x, probe.z) !== airport) {
        // f32 and f64 may split a bisector tie differently; only where both
        // airports leave the ground natural.
        selectionDisagreements += 1;
        expect(authority).toBe(natural);
      }
    }
    // Every regime was exercised, near the SECOND airport in particular.
    expect(graded).toBeGreaterThan(1_000);
    expect(selectedSpawned).toBeGreaterThan(1_500);
    expect(selectionDisagreements).toBeLessThanOrEqual(5);
  });

  it("changes ground only inside the spawned airport's grading reach", () => {
    const { world, next, spawned } = twoAirportWorld();
    const reach = terrainAirportGradingReach(spawned);
    const outer = reach.radius + Math.max(reach.halfLength, reach.halfWidth) + 150;
    let changed = 0;
    for (let dx = -outer; dx <= outer; dx += 23) {
      for (let dz = -outer; dz <= outer; dz += 23) {
        const x = spawned.centerX + dx;
        const z = spawned.centerZ + dz;
        const local = worldToRunway(spawned, x, z);
        const distance = roundedRectangleSignedDistance(local.along, local.across, reach.halfLength, reach.halfWidth);
        if (getAirportInfluence(spawned, x, z) > 0) expect(distance).toBeLessThanOrEqual(reach.radius);
        if (sampleTerrainHeight(next, x, z) !== sampleTerrainHeight(world, x, z)) {
          changed += 1;
          expect(distance).toBeLessThanOrEqual(reach.radius);
        }
      }
    }
    expect(changed).toBeGreaterThan(500);
  });
});

describe("airport reach geometry", () => {
  it("meets a rectangle exactly when the rounded rectangle does (random oracle)", () => {
    const home = createWorld("alpha").airport!;
    const random = mulberry32(0x5eed);
    let reached = 0;
    let missed = 0;
    for (let trial = 0; trial < 600; trial += 1) {
      const airport: AirportDefinition = {
        ...home,
        centerX: (random() - 0.5) * 4_000,
        centerZ: (random() - 0.5) * 4_000,
        headingRadians: random() * Math.PI * 2,
        runwayLength: 400 + random() * 2_600,
        runwayWidth: 15 + random() * 45,
        endSafetyArea: random() * 300,
        shoulderWidth: random() * 40,
        terrainBlendDistance: 1 + random() * 500,
      };
      const size = 10 + random() * 3_000;
      const minX = (random() - 0.5) * 6_000;
      const minZ = (random() - 0.5) * 6_000;
      const rect = { minX, minZ, maxX: minX + size * (0.2 + random()), maxZ: minZ + size * (0.2 + random()) };
      for (const kind of ["grading", "airfield"] as const) {
        const expected = oracleReaches(rect, airport, kind);
        if (expected === null) continue;
        const reach = kind === "grading" ? terrainAirportGradingReach(airport) : terrainAirportAirfieldReach(airport);
        expect(terrainRectIntersectsAirportReach(rect, reach), `${kind} trial ${trial}`).toBe(expected);
        if (expected) reached += 1;
        else missed += 1;
      }
    }
    expect(reached).toBeGreaterThan(150);
    expect(missed).toBeGreaterThan(150);
  });

  it("widens a page by everything its texels, gutter and taps sample", () => {
    for (const level of [0, 3, 7]) {
      const address = createWorldPageAddress(level, -3, 5);
      const bounds = worldPageBounds(address, WORLD_PAGE_BASE_EXTENT_METERS);
      const domain = terrainPageAirportDomain(address);
      const needed = Math.max(
        (WORLD_PAGE_GUTTER + 1) * terrainTexelSizeMeters(level),
        (WORLD_PAGE_GUTTER + 1) * terrainChannelTexelSizeMeters(level),
      );
      expect(bounds.minX - domain.minX).toBeGreaterThanOrEqual(needed);
      expect(domain.maxZ - bounds.maxZ).toBeGreaterThanOrEqual(needed);
    }
  });

  it("names the airports grading a page, and diffs airport lists by value", () => {
    const { home, spawned } = twoAirportWorld();
    const at = (airport: Readonly<AirportDefinition>, level: number): WorldPageAddress => {
      const extent = WORLD_PAGE_BASE_EXTENT_METERS * 2 ** level;
      return createWorldPageAddress(level, Math.floor(airport.centerX / extent), Math.floor(airport.centerZ / extent));
    };
    const reaches = [home, spawned].map(terrainAirportGradingReach);
    expect(terrainPageGradingAirport(reaches, at(spawned, 0))).toBe(1);
    expect(terrainPageGradingAirport(reaches, at(home, 0))).toBe(0);
    // A page wide enough to hold both, and one far from either.
    const both = [6, 7, 8, 9].map((level) => terrainPageGradingAirport(reaches, at(home, level)));
    expect(both).toContain(TERRAIN_PAGE_GRADED_BY_SEVERAL);
    expect(terrainPageGradingAirport(reaches, createWorldPageAddress(0, 900, -900)))
      .toBe(TERRAIN_PAGE_GRADED_BY_NONE);

    const copies = [home, spawned].map((airport) => Object.freeze({ ...airport }));
    expect(diffTerrainAirports([home, spawned], copies)).toEqual({ added: [], removed: [] });
    // The per-frame "unchanged" check: by value, order-sensitive, truncated to the slots.
    expect(sameTerrainAirports([home, spawned], copies)).toBe(true);
    expect(sameTerrainAirports([home, spawned], [spawned, home])).toBe(false);
    expect(sameTerrainAirports([home], [home, spawned])).toBe(false);
    const overfull = Array.from({ length: TERRAIN_AIRPORT_SLOTS + 2 }, () => home);
    expect(sameTerrainAirports(overfull.slice(0, TERRAIN_AIRPORT_SLOTS), overfull)).toBe(true);
    expect(diffTerrainAirports([home], [home, spawned])).toEqual({ added: [spawned], removed: [] });
    expect(diffTerrainAirports([home, spawned], [home])).toEqual({ added: [], removed: [spawned] });
    const moved = { ...spawned, headingRadians: spawned.headingRadians + 0.01 };
    expect(diffTerrainAirports([home, spawned], [home, moved])).toEqual({ added: [moved], removed: [spawned] });
  });
});
