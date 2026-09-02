import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { saturate, smoothstep } from "../src/world/noise";
import {
  GROUND_COVER_ARCHETYPES,
  groundCoverWeights,
  type GroundCoverWeights,
} from "../src/render/webgpu/detail/densityField";
import {
  VEGETATION_DENSITY_FIELD_WGSL,
  VEGETATION_GROUND_COVER_LAW_WGSL,
} from "../src/render/webgpu/detail/densityFieldWgsl";
import {
  GROUND_COVER_ARCHETYPE_SHAPES,
  GROUND_COVER_COUNTER_RING,
  GROUND_COVER_COUNTER_SLOTS,
  GROUND_COVER_DRAW_COUNT_MARGIN,
  GROUND_COVER_FIELD_ARCHETYPES,
  GROUND_COVER_LAWS,
  groundCoverArchetypeAlbedoTint,
  groundCoverCounterBytes,
  groundCoverDrawCount,
  groundCoverHandoffRadiusMeters,
  groundCoverLaneCount,
} from "../src/render/webgpu/detail/groundCoverLaw";
import { GROUND_COVER_COMPUTE_WGSL } from "../src/render/webgpu/detail/groundCoverWgsl";
import { readSource } from "./support/sourceText";
import {
  SURFACE_MATERIALS,
  SurfaceMaterial,
} from "../src/render/webgpu/terrain/surfaceMaterials";
import {
  INDIRECT_DRAW_BYTES,
  INDIRECT_INSTANCE_COUNT_WORD,
  MAIN_RENDER_PASS_ID,
  assertIndirectInstanceCountSupported,
  mainRenderPassId,
  probeIndirectInstanceCountSupport,
} from "../src/render/webgpu/detail/indirectDrawCapability";

/**
 * `6-9` — the generalised GPU ground-cover field and its cull.
 *
 * Three things are pinned here that nothing else can pin:
 *
 * 1. **TS/WGSL parity of the archetype law IN THE COMPOSED CONTEXT.** The
 *    mirror used to be dead code checked by string containment. It is now
 *    composed into the placement compute AND into the density field the splat
 *    bake reads, so the test transliterates the shipped WGSL back to
 *    JavaScript and runs both halves over a fixture chunk. A retune that
 *    moved one half only would change the archetype COUNTS, and the counts
 *    are what this compares.
 * 2. **§7 R4's private-API tripwire.** `@babylonjs/core` is pinned exactly and
 *    the two private members the indirect path needs are read out of the
 *    installed package, so a Babylon bump fails here rather than in the
 *    renderer.
 * 3. **The cull's degradation ladder.** No count yet, a failed readback, or a
 *    count that has grown back toward what is being drawn all resolve to
 *    "draw the whole lattice", which is wave G's shipped behaviour.
 */

const projectRoot = join(import.meta.dirname, "..");

// ---------------------------------------------------------------------------
// The WGSL half, executed
// ---------------------------------------------------------------------------

/** Extract one WGSL function body by name, brace-matched. */
function wgslFunctionBody(source: string, name: string): string {
  const start = source.indexOf(`fn ${name}(`);
  expect(start, `WGSL function ${name} is missing`).toBeGreaterThanOrEqual(0);
  const open = source.indexOf("{", start);
  let depth = 0;
  for (let index = open; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    else if (source[index] === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(open + 1, index);
    }
  }
  throw new Error(`Unbalanced braces in WGSL function ${name}`);
}

/**
 * Transliterate the shipped WGSL body back to JavaScript.
 *
 * Deliberately a SMALL rewrite over straight-line arithmetic — declarations,
 * the two scalar helpers, and the result struct. Anything the law grows that
 * this cannot express (a loop, a texture read, a builtin) makes the rewrite
 * throw or the numbers diverge, which is the correct outcome: the whole point
 * of the archetype law living in its own include is that it stays a pure
 * function of five scalars.
 */
function transliterateGroundCoverLaw(): (
  moisture: number,
  slope: number,
  canopyShade: number,
  elevationAboveSeaLevel: number,
  riparianBand: number,
) => GroundCoverWeights {
  const body = wgslFunctionBody(VEGETATION_GROUND_COVER_LAW_WGSL, "vegetationGroundCoverWeights")
    .replace(/\/\/[^\n]*/gu, "")
    .replace(/\blet\b/gu, "const")
    .replace(/var result: VegetationGroundCoverMix;/u, "const result = {};")
    .replace(/\bkSmoothstep\(/gu, "smoothstep(")
    .replace(/\bkSaturate\(/gu, "saturate(");
  expect(body, "the law grew a construct the transliteration cannot express")
    .not.toMatch(/\b(?:for|while|textureLoad|f32|u32|vec)\b/u);
  const factory = new Function(
    "smoothstep",
    "saturate",
    `return (moisture, slope, canopyShade, elevationAboveSeaLevel, riparianBand) => {${body}};`,
  ) as (
    s: typeof smoothstep,
    t: typeof saturate,
  ) => (a: number, b: number, c: number, d: number, e: number) => GroundCoverWeights;
  return factory(smoothstep, saturate);
}

/** The same for the archetype pick, so selection parity is executed too. */
function transliterateArchetypePick(): (mix: GroundCoverWeights, pick: number) => number {
  const body = wgslFunctionBody(GROUND_COVER_COMPUTE_WGSL, "groundArchetypeFor")
    .replace(/\/\/[^\n]*/gu, "")
    .replace(/\bvar\b/gu, "let")
    .replace(/\blet\b(?=\s+\w+\s*=)/gu, "let")
    .replace(/(\d)u\b/gu, "$1")
    .replace(/\bmix5\./gu, "mix.");
  const factory = new Function("mix", "pick", body) as (
    mix: GroundCoverWeights,
    pick: number,
  ) => number;
  return factory;
}

/**
 * A fixture chunk: 64 × 64 driver samples spanning the whole domain of the
 * law — dry ridge to wet flat bank, open to closed canopy, sea level to
 * alpine. Deterministic, and wide enough that every archetype wins somewhere.
 */
function fixtureChunk(): ReadonlyArray<{
  moisture: number;
  slope: number;
  shade: number;
  elevation: number;
  bank: number;
  pick: number;
}> {
  const samples: Array<{
    moisture: number; slope: number; shade: number;
    elevation: number; bank: number; pick: number;
  }> = [];
  let state = 0x9e3779b9;
  const next = (): number => {
    state = (Math.imul(state ^ (state >>> 15), 0x2c1b3c6d) + 0x165667b1) >>> 0;
    return state / 0x1_0000_0000;
  };
  for (let row = 0; row < 64; row += 1) {
    for (let column = 0; column < 64; column += 1) {
      samples.push({
        moisture: column / 63,
        slope: (row / 63) * 0.6,
        shade: next(),
        elevation: next() * 1_400,
        bank: next() < 0.25 ? next() : 0,
        pick: next(),
      });
    }
  }
  return samples;
}

describe("6-9 archetype law: TS/WGSL parity in the composed context", () => {
  it("composes the ONE law into both the density field and the placement kernel", () => {
    // The include is text-identical in both consumers rather than a copy in
    // each — that is what makes a retune reach the splat bake and the blade
    // field together.
    expect(VEGETATION_DENSITY_FIELD_WGSL).toContain(VEGETATION_GROUND_COVER_LAW_WGSL);
    expect(GROUND_COVER_COMPUTE_WGSL).toContain(VEGETATION_GROUND_COVER_LAW_WGSL);
    // And the grass helper is the mix's first lane, not a second copy of it.
    expect(VEGETATION_GROUND_COVER_LAW_WGSL)
      .toContain("return vegetationGroundCoverWeights(");
    // The forbidden-builtins rule: the include runs beside the terrain kernel
    // and must use its guarded smoothstep, never WGSL's.
    const code = VEGETATION_GROUND_COVER_LAW_WGSL
      .replace(/\/\*[\s\S]*?\*\//gu, "")
      .replace(/\/\/[^\n]*/gu, "");
    expect(code).not.toMatch(/[^k]smoothstep\(/u);
    // No sin-fract hashing anywhere in the placement kernel (house trap).
    expect(GROUND_COVER_COMPUTE_WGSL).not.toMatch(/fract\(\s*sin\(/u);
  });

  it("agrees with densityField.ts's groundCoverWeights on every lane", () => {
    const wgsl = transliterateGroundCoverLaw();
    let worst = 0;
    for (const sample of fixtureChunk()) {
      const ts = groundCoverWeights(
        sample.moisture, sample.slope, sample.shade, sample.elevation, sample.bank,
      );
      const gpu = wgsl(
        sample.moisture, sample.slope, sample.shade, sample.elevation, sample.bank,
      );
      for (const lane of GROUND_COVER_ARCHETYPES) {
        worst = Math.max(worst, Math.abs(ts[lane] - gpu[lane]));
      }
    }
    // Both halves are f64 here; the transliteration is the SAME expressions,
    // so this is an equality check with a rounding allowance, not a tolerance
    // negotiated down to green.
    expect(worst).toBeLessThan(1e-12);
  });

  it("selects the same archetype counts on a fixture chunk (count parity)", () => {
    const wgslLaw = transliterateGroundCoverLaw();
    const wgslPick = transliterateArchetypePick();
    const gpuCounts = new Map<number, number>();
    const cpuCounts = new Map<number, number>();
    for (const sample of fixtureChunk()) {
      const ts = groundCoverWeights(
        sample.moisture, sample.slope, sample.shade, sample.elevation, sample.bank,
      );
      const gpu = wgslLaw(
        sample.moisture, sample.slope, sample.shade, sample.elevation, sample.bank,
      );
      // The CPU reference walk, written here so the WGSL's own cumulative
      // walk is compared against something rather than against itself.
      let cumulative = 0;
      let cpuCode: number = GROUND_COVER_FIELD_ARCHETYPES.length;
      for (let code = 0; code < GROUND_COVER_FIELD_ARCHETYPES.length; code += 1) {
        cumulative += ts[GROUND_COVER_FIELD_ARCHETYPES[code]!];
        if (sample.pick < cumulative) {
          cpuCode = code;
          break;
        }
      }
      const gpuCode = wgslPick(gpu, sample.pick);
      expect(gpuCode).toBe(cpuCode);
      gpuCounts.set(gpuCode, (gpuCounts.get(gpuCode) ?? 0) + 1);
      cpuCounts.set(cpuCode, (cpuCounts.get(cpuCode) ?? 0) + 1);
    }
    expect([...gpuCounts.entries()].sort()).toEqual([...cpuCounts.entries()].sort());
    // Non-vacuous: every ribbon archetype has to win somewhere in the fixture,
    // and the clutter tail (code 4 — no blade at all) has to be reachable.
    for (let code = 0; code <= GROUND_COVER_FIELD_ARCHETYPES.length; code += 1) {
      expect(cpuCounts.get(code) ?? 0, `archetype code ${code} never selected`)
        .toBeGreaterThan(0);
    }
  });

  it("keeps the clutter lane out of the ribbon set but inside the normalisation", () => {
    // Clutter keeps its cards. If the field renormalised it away, every other
    // archetype's share would silently rise — a count increase disguised as a
    // representation change, which is exactly what the ratchet forbids.
    expect(GROUND_COVER_FIELD_ARCHETYPES).not.toContain("clutter");
    expect(GROUND_COVER_ARCHETYPES).toContain("clutter");
    expect(VEGETATION_GROUND_COVER_LAW_WGSL).toContain("result.clutter = clutter / total;");
    const steep = groundCoverWeights(0.3, 0.5, 0.6, 400, 0);
    expect(steep.clutter).toBeGreaterThan(0.05);
  });

  it("injects the archetype shape table from the one TypeScript authority", () => {
    for (const name of GROUND_COVER_FIELD_ARCHETYPES) {
      const shape = GROUND_COVER_ARCHETYPE_SHAPES[name];
      const literal = Number.isInteger(shape.densityScale)
        ? `${shape.densityScale}.0`
        : String(shape.densityScale);
      expect(GROUND_COVER_COMPUTE_WGSL, `${name} densityScale`).toContain(literal);
    }
    // A frond is not a blade: the non-grass archetypes must claim a small
    // share of a lattice sized for grass, or the field draws a wall.
    expect(GROUND_COVER_ARCHETYPE_SHAPES.grass.densityScale).toBe(1);
    for (const name of ["fern", "heather", "reed"] as const) {
      expect(GROUND_COVER_ARCHETYPE_SHAPES[name].densityScale).toBeLessThan(0.5);
    }
  });

  /**
   * D-18: the archetype colours are the CARD path's instance tints, and the
   * blade path's base colour is a linear terrain albedo. They are not the same
   * units, and the grass row is what proves it.
   */
  it("carries the archetype colour as a TINT, never as a linear albedo", () => {
    const grassMaterial = SURFACE_MATERIALS[SurfaceMaterial.Grass]!.referenceAlbedo;
    const forestFloor = SURFACE_MATERIALS[SurfaceMaterial.ForestFloor]!.referenceAlbedo;
    const luminance = (c: readonly number[]) =>
      0.2126 * c[0]! + 0.7152 * c[1]! + 0.0722 * c[2]!;

    // The table's grass row is ~3x the Grass material's own linear albedo, so
    // the entries cannot be albedos. Grass's colorMix of 0 is why the mismatch
    // never rendered until 6-9 turned the other three lanes on.
    const grassTintValue = GROUND_COVER_ARCHETYPE_SHAPES.grass.color;
    expect(GROUND_COVER_ARCHETYPE_SHAPES.grass.colorMix).toBe(0);
    expect(luminance(grassTintValue) / luminance(grassMaterial)).toBeGreaterThan(2.5);

    // Read as a tint relative to the reference row, grass is the identity...
    expect(groundCoverArchetypeAlbedoTint("grass")).toEqual([1, 1, 1]);
    // ...and every archetype lands inside the terrain palette rather than
    // several times above it. Mixed ADDITIVELY these reached 3.4-3.9x the
    // forest floor's own albedo and desaturated toward the tint's grey, which
    // is what rendered as grey-blue shapes that do not read as vegetation.
    for (const name of GROUND_COVER_FIELD_ARCHETYPES) {
      const { colorMix } = GROUND_COVER_ARCHETYPE_SHAPES[name];
      const tint = groundCoverArchetypeAlbedoTint(name);
      const applied = forestFloor.map(
        (value, index) => value * (1 - colorMix + tint[index]! * colorMix));
      const ratio = luminance(applied) / luminance(forestFloor);
      expect(ratio, `${name} albedo ratio`).toBeGreaterThan(0.6);
      expect(ratio, `${name} albedo ratio`).toBeLessThan(1.6);
    }

    // The vertex stage must MULTIPLY the tint into the ground albedo, not mix
    // toward it as if it were a colour in the same space.
    const plugin = readFileSync(
      join(process.cwd(), "src/render/webgpu/detail/GroundCoverMaterialPlugin.ts"),
      "utf8",
    );
    expect(plugin).toContain(
      "groundAlbedo.rgb * mix(vec3f(1.0), groundLook.tint, groundLook.colorMix)");
    expect(plugin).not.toContain("mix(groundAlbedo.rgb, groundLook.color");
  });
});

describe("6-9 compaction and the conservative draw count", () => {
  it("compacts with a workgroup-reduced atomic and clamps to capacity", () => {
    expect(GROUND_COVER_COMPUTE_WGSL).toContain("var<workgroup> groundLiveInWorkgroup: atomic<u32>");
    expect(GROUND_COVER_COMPUTE_WGSL).toContain("atomicAdd(&groundLiveInWorkgroup, 1u)");
    expect(GROUND_COVER_COMPUTE_WGSL).toContain("if (index < capacity) { blades[index] = record; }");
    // Three barriers, all at the top level of the entry point: a `return`
    // before a barrier in the last partial workgroup is undefined behaviour,
    // which is why out-of-range lanes fall through with `placed == false`.
    const body = wgslFunctionBody(GROUND_COVER_COMPUTE_WGSL, "placeGroundCover");
    expect(body.match(/workgroupBarrier\(\)/gu)).toHaveLength(3);
    expect(body).not.toMatch(/\breturn;/u);
  });

  it("keeps the FRUSTUM out of the compaction predicate", () => {
    // The count is read back two frames late. A predicate that re-rolls
    // wholesale on a camera turn would make it wrong; the frustum therefore
    // still collapses per blade in the vertex stage (a degenerate record),
    // exactly as wave G shipped it, and only slow-moving ground decides the
    // count.
    const body = wgslFunctionBody(GROUND_COVER_COMPUTE_WGSL, "placeGroundCover");
    const frustum = body.indexOf("uniforms.planes[plane]");
    const placed = body.indexOf("placed = true;");
    expect(frustum).toBeGreaterThan(placed);
    expect(body).toContain("var visible = 1.0;");
    expect(body).toContain("bladeHeight * rim * visible");
  });

  it("degrades to the whole lattice rather than truncating the field", () => {
    const lanes = 50_000;
    // No count yet — wave G's shipped behaviour, and the first frames.
    expect(groundCoverDrawCount(lanes, null, lanes)).toBe(lanes);
    // A count that has grown back toward what is drawn re-opens to capacity
    // instead of shaving the margin, so a rising field never truncates.
    expect(groundCoverDrawCount(lanes, 9_500, 10_000)).toBe(lanes);
    // A comfortably smaller count culls, with margin.
    const culled = groundCoverDrawCount(lanes, 4_000, lanes);
    expect(culled).toBeGreaterThan(4_000 * GROUND_COVER_DRAW_COUNT_MARGIN);
    expect(culled).toBeLessThan(lanes);
    // Never above capacity, never below zero, and a malformed count is
    // treated as no count at all.
    expect(groundCoverDrawCount(lanes, 4_000_000, lanes)).toBe(lanes);
    expect(groundCoverDrawCount(lanes, Number.NaN, lanes)).toBe(lanes);
    expect(groundCoverDrawCount(lanes, -1, lanes)).toBe(lanes);
  });

  it("sizes the counter ring so a reset cannot outrun a readback", () => {
    // One buffer would be re-zeroed by the next frame before the previous
    // frame's copy executed, and every count would read the atomic identity.
    expect(GROUND_COVER_COUNTER_RING).toBeGreaterThanOrEqual(3);
    expect(GROUND_COVER_COUNTER_SLOTS).toBeGreaterThanOrEqual(
      GROUND_COVER_LAWS[0]!.rings.length,
    );
    expect(groundCoverCounterBytes())
      .toBe(GROUND_COVER_COUNTER_RING * GROUND_COVER_COUNTER_SLOTS * 4);
  });

  it("zeroes the lattice on a floating-origin rebase", () => {
    // The one way a stale tail record becomes WRONG rather than merely old:
    // roots are stored origin-local, so a rebase would draw the tail
    // displaced by the whole rebase delta. Wave G had no tail to displace.
    const source = readFileSync(
      join(projectRoot, "src/render/webgpu/detail/GroundCoverSystem.ts"),
      "utf8",
    );
    expect(source).toContain("this.residentOriginX !== input.floatingOriginX");
    expect(source).toContain("ring.blades.clear();");
    // And the count is invalidated with it, so the next frame cannot draw a
    // culled window into a buffer that was just zeroed.
    const guard = source.slice(
      source.indexOf("this.residentOriginX !== input.floatingOriginX"),
      source.indexOf("Frustum.GetPlanesToRef"),
    );
    expect(guard).toContain("ring.liveCount = null;");
    expect(guard).toContain("ring.drawCount = ring.laneCount;");
  });

  it("hands the card path a radius that tracks the law, not a constant", () => {
    GROUND_COVER_LAWS.forEach((law, tier) => {
      const radius = groundCoverHandoffRadiusMeters(law);
      expect(radius, `tier ${tier}`).toBe(law.rings[law.rings.length - 1]!.outerRadiusMeters);
      // The field must never claim ground it cannot reach.
      for (const ring of law.rings) {
        expect(ring.outerRadiusMeters).toBeLessThanOrEqual(radius);
      }
      expect(groundCoverLaneCount(law.rings[0]!)).toBeGreaterThan(0);
    });
  });
});

describe("§7 R4: the indirect path is an optimisation behind a loud assertion", () => {
  it("fails loudly, by name, when the private surface has moved", () => {
    const gone = probeIndirectInstanceCountSupport({});
    expect(gone.supported).toBe(false);
    expect(gone.missing).toContain("WebGPUDrawContext.prototype.setIndirectData");
    expect(() => assertIndirectInstanceCountSupported(gone))
      .toThrowError(/setIndirectData/u);
    expect(() => assertIndirectInstanceCountSupported(gone))
      .toThrowError(/indirectInstanceCount/u);
    const missingClass = probeIndirectInstanceCountSupport(null);
    expect(missingClass.missing).toContain("WebGPUDrawContext");
    expect(() => assertIndirectInstanceCountSupported(missingClass)).toThrow();
    // And the supported case never throws — the assertion is not a warning.
    expect(() => assertIndirectInstanceCountSupported(
      Object.freeze({ supported: true, missing: Object.freeze([]) }),
    )).not.toThrow();
  });

  it("still finds the private Babylon members it depends on (a bump fails HERE)", async () => {
    // §7 R4 verbatim: `_currentDrawContext.indirectDrawBuffer` and
    // `setIndirectData`'s instance-count early-return are verified present in
    // 9.21.2 and are NOT public API.
    const drawContext = readFileSync(
      join(projectRoot, "node_modules/@babylonjs/core/Engines/WebGPU/webgpuDrawContext.js"),
      "utf8",
    );
    expect(drawContext).toContain("setIndirectData(indexOrVertexCount, instanceCount");
    // The early-return IS the mechanism: it is what stops Babylon overwriting
    // the count a compute pass wrote.
    expect(drawContext).toContain("instanceCount === this._currentInstanceCount");
    expect(drawContext).toContain("this.indirectDrawBuffer = this._bufferManager.createRawBuffer(20,");
    expect(drawContext).toContain("WebGPUConstants.BufferUsage.Indirect");
    expect(drawContext).toContain("WebGPUConstants.BufferUsage.Storage");

    const engine = readFileSync(
      join(projectRoot, "node_modules/@babylonjs/core/Engines/webgpuEngine.pure.js"),
      "utf8",
    );
    expect(engine).toContain("this._currentDrawContext.indirectDrawBuffer");
    expect(engine).toContain("drawIndexedIndirect(this._currentDrawContext.indirectDrawBuffer, 0)");
    // Compatibility mode needs the explicit opt-in the adapter sets.
    expect(engine).toContain("this._currentDrawContext._enableIndirectDrawInCompatMode");

    // The per-pass shape R4 says both original designs missed: a wrapper per
    // render-pass id, so a compute write fixes exactly one pass.
    const subMesh = readFileSync(
      join(projectRoot, "node_modules/@babylonjs/core/Meshes/subMesh.pure.js"),
      "utf8",
    );
    expect(subMesh).toContain("_getDrawWrapper(passId, createIfNotExisting = false)");
    expect(subMesh).toContain("this._drawWrappers[passId]");

    // And the live probe agrees with the source scan.
    const { WebGPUDrawContext } = await import(
      "@babylonjs/core/Engines/WebGPU/webgpuDrawContext"
    );
    expect(probeIndirectInstanceCountSupport(WebGPUDrawContext.prototype).supported).toBe(true);
  });

  it("pins @babylonjs/core to an exact version", () => {
    const manifest = JSON.parse(
      readSource(join(projectRoot, "package.json")),
    ) as { dependencies?: Record<string, string> };
    const pinned = manifest.dependencies?.["@babylonjs/core"];
    // No caret, no tilde, no range: R4 asks for a pin because the feature
    // reads private state, and a pin is what makes the test above meaningful.
    expect(pinned).toMatch(/^\d+\.\d+\.\d+$/u);
    const installed = JSON.parse(
      readFileSync(
        join(projectRoot, "node_modules/@babylonjs/core/package.json"),
        "utf8",
      ),
    ) as { version: string };
    expect(installed.version).toBe(pinned);
  });

  it("writes only the instance-count word, into the MAIN pass's record", () => {
    expect(MAIN_RENDER_PASS_ID).toBe(0);
    expect(INDIRECT_DRAW_BYTES).toBe(20);
    expect(INDIRECT_INSTANCE_COUNT_WORD).toBe(1);
    const source = readFileSync(
      join(projectRoot, "src/render/webgpu/detail/indirectDrawCapability.ts"),
      "utf8",
    );
    // ONE pass, resolved rather than assumed. Shadow and reflection passes
    // keep the mesh's forcedInstanceCount, which is the conservative count
    // R4 prescribes.
    expect(source).toContain("subMesh._getDrawWrapper?.(passId, false)");
  });

  it("keeps the blade meshes in exactly ONE pass, which is what makes one count safe", () => {
    // The load-bearing premise of the DEFAULT path. `forcedInstanceCount` is
    // per-MESH, not per-pass, so a frustum-derived count would wrongly cull a
    // shadow caster outside the camera frustum. It is safe here only because
    // the blade meshes are drawn by the camera and by nothing else: they are
    // never collected as shadow casters, and the only two custom render
    // targets in the renderer take a named mesh each.
    const system = readFileSync(
      join(projectRoot, "src/render/webgpu/detail/GroundCoverSystem.ts"),
      "utf8",
    );
    expect(system).not.toMatch(/addShadowCaster|renderList|customRenderTargets/u);
    const renderer = readSource(join(projectRoot, "src/render/FlightRenderer.ts"));
    const casters = renderer.slice(
      renderer.indexOf("private syncDynamicShadowCasters()"),
      renderer.indexOf("private syncDynamicShadowCasters()") + 2_000,
    );
    expect(casters.length).toBeGreaterThan(100);
    expect(casters).not.toContain("groundCover");
    // And the cloud depth pass takes the terrain mesh alone.
    const atmosphere = readFileSync(
      join(projectRoot, "src/render/webgpu/atmosphere/AtmosphereGpuResources.ts"),
      "utf8",
    );
    expect(atmosphere).toContain('mesh.name === "terrain-cdlod"');
  });

  it("targets the CAMERA's pass, not Babylon's default pass id", () => {
    // Measured on a real adapter: a blade mesh carried two draw wrappers —
    // id 0 (`useInstancing: false`) and the camera's id 1 — and BOTH had an
    // indirect buffer. Writing id 0's succeeds completely and fixes a pass
    // that never draws, which is the sharpest form of R4's per-pass warning.
    expect(mainRenderPassId(null)).toBe(MAIN_RENDER_PASS_ID);
    expect(mainRenderPassId({ activeCamera: null })).toBe(MAIN_RENDER_PASS_ID);
    expect(mainRenderPassId({ activeCamera: { renderPassId: 7 } })).toBe(7);
    // Scene.render prefers the camera's OUTPUT RENDER TARGET when it has one,
    // which is exactly the shape the shipping renderer's hand-built post
    // chain produces. Mirrored here rather than approximated.
    expect(mainRenderPassId({
      activeCamera: { renderPassId: 7, outputRenderTarget: { renderPassId: 12 } },
    })).toBe(12);
    // And the Babylon expression this mirrors is still what Scene.render does.
    const scene = readFileSync(
      join(projectRoot, "node_modules/@babylonjs/core/scene.pure.js"),
      "utf8",
    );
    expect(scene).toContain(
      "this._engine.currentRenderPassId = camera.outputRenderTarget?.renderPassId "
      + "?? camera.renderPassId ?? 0;",
    );
  });
});
