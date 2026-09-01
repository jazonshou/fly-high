import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CLUSTERED_MAX_SIMULTANEOUS_LIGHTS } from "../src/render/webgpu/lighting/ClusteredLighting";

/**
 * **How many lights the scene actually has, and why the answer must stay 4.**
 *
 * Babylon's `_maxSimultaneousLights` defaults to **4**, and
 * `PrepareDefinesForLights` `break`s at the cap rather than reporting anything
 * — so a fifth light does not error, warn, or render dimly. **It silently stops
 * contributing.**
 *
 * Production runs exactly three standalone lights — `sun`, `sky-ambient` and
 * `moon`, all in `AtmosphereSystem` — and a `ClusteredLightContainer` **is
 * itself a Light**, so it takes the fourth slot and the cap is consumed
 * exactly.
 *
 * **The container does NOT make this worse as it fills up, and that is the load
 * bearing fact.** `ClusteredLightContainer.addLight` calls
 * `this._scene.removeLight(light)` — child lights LEAVE `scene.lights`. So a
 * hundred clustered lamps still cost one slot between them, and the count stays
 * at four however many fixtures `7-8` and `7-14` add.
 *
 * **So the risk is a fifth STANDALONE light, and this pins against exactly
 * that.** The list below is the assertion, not a lookup table: it says what the
 * scene is allowed to construct outside the container.
 *
 * ---
 *
 * **AND RAISING THE CAP IS NOT THE FREE FIX IT LOOKS LIKE.** The obvious repair
 * is to set `maxSimultaneousLights` above 4 everywhere and stop worrying. That
 * trades a quiet failure for a loud one rather than removing it:
 *
 *  - **At the default cap**, a fifth light silently drops. Subtle, hard to
 *    notice, easy to ship.
 *  - **Above the cap**, the fifth light COMPILES IN — and a fifth *directional*
 *    light costs **nine** inter-stage variables (`vPositionFromLight{X}_0..3`,
 *    `vDepthMetric{X}_0..3`, `vPositionFromCamera{X}`). Terrain and detail sit
 *    at 15 of 16 with the container attached, so nine more is not a
 *    degradation: **pipeline creation fails and the mesh stops drawing.**
 *
 * The loud failure is arguably the better one — it is diagnosable — but it is a
 * different failure, not an absence of one, and `CLUSTERED_MAX_SIMULTANEOUS_LIGHTS`
 * exists so that trade is made deliberately rather than by whoever adds the
 * fifth light. **Neither the plan nor the owners row states this interaction;
 * it is the reason this file is a pin and not a bump.**
 */

const SRC = "src/render";

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) sourceFiles(path, out);
    else if (path.endsWith(".ts") && !path.endsWith(".d.ts")) out.push(path);
  }
  return out;
}

const LIGHT_CONSTRUCTION = /new\s+(Directional|Hemispheric|Point|Spot)Light\s*\(/gu;

/** Every light construction in the renderer, as `file -> count`. */
function lightSites(): Record<string, number> {
  const out: Record<string, number> = {};
  for (const path of sourceFiles(SRC)) {
    const code = readFileSync(path, "utf8")
      .replace(/\/\*[\s\S]*?\*\//gu, " ")
      .replace(/(^|[^:])\/\/[^\n]*/gu, "$1 ");
    const count = [...code.matchAll(LIGHT_CONSTRUCTION)].length;
    if (count > 0) out[path] = count;
  }
  return out;
}

describe("the scene's light slots", () => {
  it("constructs lights in exactly two places, and this is the pin", () => {
    // `AtmosphereSystem` owns the three standalone lights. `ClusteredLighting`
    // constructs point lights that are immediately handed to the container and
    // therefore REMOVED from `scene.lights`, so they cost no slot.
    expect(lightSites()).toEqual({
      "src/render/webgpu/atmosphere/AtmosphereSystem.ts": 3,
      "src/render/webgpu/lighting/ClusteredLighting.ts": 1,
    });
  });

  it("so the standalone count is 3, and the container makes 4 — exactly Babylon's default", () => {
    const standalone = lightSites()["src/render/webgpu/atmosphere/AtmosphereSystem.ts"] ?? 0;
    expect(standalone).toBe(3);
    // The container is itself a Light and takes the fourth slot.
    expect(standalone + 1).toBe(4);
    // Which is exactly the default `PrepareDefinesForLights` breaks at.
    expect(CLUSTERED_MAX_SIMULTANEOUS_LIGHTS).toBeGreaterThan(standalone + 1);
  });

  it("the contract this rests on is still Babylon's: a clustered light LEAVES scene.lights", () => {
    // If `addLight` ever stopped removing the light from the scene, every
    // clustered lamp would take a slot of its own and the fourth fixture would
    // start silently dropping. Read from the shipped source, because that is
    // the only place the guarantee lives.
    const container = readFileSync(
      "node_modules/@babylonjs/core/Lights/Clustered/clusteredLightContainer.pure.js",
      "utf8",
    );
    expect(
      container.includes("this._scene.removeLight(light)"),
      "ClusteredLightContainer.addLight no longer removes its child from scene.lights — "
      + "every clustered fixture now costs a light slot and the cap is blown",
    ).toBe(true);
  });

  it("NON-VACUITY — the scanner finds light constructions at all", () => {
    // An over-tight regex would report an empty map and pass the pin above by
    // matching nothing against nothing.
    const total = Object.values(lightSites()).reduce((a, b) => a + b, 0);
    expect(total).toBeGreaterThanOrEqual(4);
  });
});
