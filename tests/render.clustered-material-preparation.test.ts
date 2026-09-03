import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  CLUSTERED_MAX_SIMULTANEOUS_LIGHTS,
  prepareMaterialForClusteredLighting,
} from "../src/render/webgpu/lighting/ClusteredLighting";
import { PBRMaterial } from "@babylonjs/core/Materials/PBR/pbrMaterial";
import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import { Scene } from "@babylonjs/core/scene";
import { readSource } from "./support/sourceText";

/**
 * Every PBR material that a clustered light can reach must have its light-slot
 * cap raised — and no sheen material may.
 *
 * **Why the cap matters when nothing is dropped today.** The scene holds
 * exactly four lights: three in `AtmosphereSystem` plus the container, which is
 * itself a `Light`. Babylon's default `maxSimultaneousLights` is 4. That fits
 * with ZERO margin, and `PrepareDefinesForLights` breaks at the cap rather than
 * reporting — so the next light silently costs whichever the iteration reaches
 * last, and if that is the container then every clustered lamp stops
 * contributing with nothing to say so.
 *
 * **Why the roster is derived and not listed.** A hand-maintained list of the
 * creation sites goes stale the first time someone adds a material, which is
 * exactly the failure it would exist to prevent. So the roster comes from the
 * source: every file that constructs a `PBRMaterial` must also prepare it.
 */

const ROOT = "src/render/webgpu";

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) out.push(...sourceFiles(path));
    else if (entry.endsWith(".ts")) out.push(path);
  }
  return out;
}

describe("clustered material preparation", () => {
  it("prepares at EVERY file that constructs a PBRMaterial", () => {
    // The roster is derived from the artifact. A new creation site fails here
    // on the day it is added rather than the day a light silently drops.
    const creators = sourceFiles(ROOT)
      .filter((f) => !f.endsWith("ClusteredLighting.ts"))
      .filter((f) => /new PBRMaterial\(/.test(readSource(f)));
    expect(creators.length, "no PBRMaterial creation sites found — the scan is broken")
      .toBeGreaterThan(4);
    const unprepared = creators.filter(
      (f) => !readSource(f).includes("prepareMaterialForClusteredLighting"));
    expect(
      unprepared,
      "these files construct a PBRMaterial and never prepare it. The container "
      + "occupies a light slot, Babylon's default cap is 4, and the scene has 4 "
      + "lights — so an unprepared material has no margin and drops a light "
      + "silently as soon as a fifth exists",
    ).toEqual([]);
  });

  it("prepares every material a creation site actually builds", () => {
    // Presence of the call is not enough: a site could construct two materials
    // and prepare one. Count both and require agreement.
    for (const file of sourceFiles(ROOT).filter((f) => !f.endsWith("ClusteredLighting.ts"))) {
      const text = readSource(file);
      const built = (text.match(/new PBRMaterial\(/g) ?? []).length;
      if (built === 0) continue;
      const prepared = (text.match(/prepareMaterialForClusteredLighting\(/g) ?? []).length;
      expect(
        prepared,
        `${file} constructs ${built} PBRMaterial(s) but prepares ${prepared}`,
      ).toBe(built);
    }
  });

  it("REFUSES a sheen material, and reports that it refused", () => {
    // The outcome, not the call. `excludeSheenReceivers` keeps the container
    // away from sheen meshes because Babylon's clustered sheen emission
    // references a `main`-local `normalW` from inside a separate function and
    // fails to compile — a black frame that no Node test can see. Deciding both
    // rules on the same property means they cannot disagree.
    const engine = new NullEngine();
    const scene = new Scene(engine);
    try {
      const plain = new PBRMaterial("plain", scene);
      expect(prepareMaterialForClusteredLighting(plain)).toBe(true);
      expect(plain.maxSimultaneousLights).toBe(CLUSTERED_MAX_SIMULTANEOUS_LIGHTS);

      const sheen = new PBRMaterial("sheen", scene);
      sheen.sheen.isEnabled = true;
      const before = sheen.maxSimultaneousLights;
      expect(prepareMaterialForClusteredLighting(sheen), "a sheen material must be refused")
        .toBe(false);
      expect(sheen.maxSimultaneousLights, "a refused material must be left alone")
        .toBe(before);
    } finally {
      scene.dispose();
      engine.dispose();
    }
  });

  it("leaves headroom over the scene's actual light count", () => {
    // Three standalone lights plus the container. The cap must exceed that, or
    // preparing buys nothing.
    expect(CLUSTERED_MAX_SIMULTANEOUS_LIGHTS).toBeGreaterThan(3 + 1);
  });
});
