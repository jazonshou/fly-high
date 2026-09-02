import { readFileSync, readdirSync, statSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { readSource } from "./support/sourceText";

/**
 * Every define a `MaterialPluginBase` WRITES must appear in the define map it
 * DECLARES to its constructor.
 *
 * **This is the guard for a defect that has now shipped twice, and whose lesson
 * was already written down in the file it shipped in.**
 *
 * Babylon builds `MaterialDefines._keys` from the map passed to the plugin
 * constructor, and `MaterialDefines.toString()` emits **only `_keys`**. A define
 * assigned in `prepareDefines` but absent from that map therefore contributes no
 * `#define` to the compiled shader — so every `#ifdef` on it silently takes the
 * `#else` branch. Nothing errors: the uniforms are still declared, the samplers
 * still bound, the textures still uploaded every frame. Only the shader source
 * differs, which no runtime assertion can see.
 *
 * `DetailInstanceMaterialPlugin` declared `DETAIL_HORIZON_SHADOW` for exactly
 * this reason, with a comment recording that relying on `rebuild()` to re-derive
 * keys from `Object.keys` "is a Babylon implementation detail and not a contract
 * worth resting a compiled shader on" — and left `DETAIL_SUN_SHADOW`, four lines
 * away, undeclared. The impostor band's entire cascade-shadow receiver never
 * compiled: far vegetation has never received sun shadows while the mesh bands
 * always have, which is a visible tone step at the band handoff.
 *
 * The reason a rebuild does not save it, for anyone tempted to rely on that
 * again: the only `rebuild()` that can adopt a late key fires from
 * `PrepareDefinesForLights`, which runs BEFORE the plugin's `prepareDefines`
 * hook. On the first pass the key does not exist yet; on later passes no rebuild
 * occurs.
 *
 * A source scan is the right shape here precisely because the failure is
 * invisible at runtime. Its companion is the compiled-source assertion in
 * `tests/gpu/` — this one catches the omission at authoring time on every
 * plugin; that one proves the receiver reaches the adapter.
 */

/** Defines Babylon itself owns; a plugin may read or clear these without declaring them. */
const BABYLON_OWNED = new Set([
  "INSTANCES",
  "THIN_INSTANCES",
  "INSTANCESCOLOR",
  "LOGARITHMICDEPTH",
]);

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const path = `${dir}/${entry}`;
    if (statSync(path).isDirectory()) sourceFiles(path, out);
    else if (path.endsWith(".ts")) out.push(path);
  }
  return out;
}

describe("material plugin define declaration", () => {
  it("declares every define it writes, on every MaterialPluginBase", () => {
    const files = sourceFiles("src/render/webgpu")
      .filter((path) => readSource(path).includes("MaterialPluginBase"));
    expect(files.length, "no MaterialPluginBase files found — the scan is vacuous")
      .toBeGreaterThan(2);

    const failures: string[] = [];
    let checkedPlugins = 0;
    let checkedDefines = 0;

    for (const path of files) {
      const source = readSource(path);
      // Written: `defines["NAME"] = ...` and `defines.NAME = ...`
      const written = new Set<string>();
      for (const m of source.matchAll(/\bdefines\[\s*["'`]([A-Z0-9_]+)["'`]\s*\]\s*=/gu)) {
        written.add(m[1]!);
      }
      for (const m of source.matchAll(/\bdefines\.([A-Z][A-Z0-9_]*)\s*=/gu)) {
        written.add(m[1]!);
      }
      if (written.size === 0) continue;
      checkedPlugins += 1;

      // Declared: keys of the object literal handed to the plugin constructor,
      // matched as `NAME: false` / `NAME: true` ANYWHERE rather than anchored to
      // a line. The anchored form was this guard's own first bug: it reported
      // `GroundCoverMaterialPlugin` as undeclared because that plugin writes its
      // map inline — `{ GROUND_COVER_BLADES: false },` — so the key is not at a
      // line start. A guard that false-positives acquires an exception list and
      // is decorative within a week, which is the failure this whole family is
      // about.
      const declared = new Set<string>();
      for (const m of source.matchAll(/([A-Z][A-Z0-9_]*)\s*:\s*(?:false|true)\b/gu)) {
        declared.add(m[1]!);
      }

      for (const name of written) {
        if (BABYLON_OWNED.has(name)) continue;
        checkedDefines += 1;
        if (declared.has(name)) continue;
        failures.push(
          `${path}: writes defines["${name}"] but never declares it in the plugin's `
          + "define map. Babylon emits only the declared keys, so every #ifdef on "
          + `${name} silently compiles its #else branch while the bindings stay `
          + "correct — the exact failure DETAIL_SUN_SHADOW shipped. Add "
          + `\`${name}: false,\` to the map passed to the constructor.`,
        );
      }
    }

    // Non-vacuity: the scan must actually have found defines to check.
    expect(checkedPlugins, "no plugin wrote any define — the regexes stopped matching")
      .toBeGreaterThan(0);
    expect(checkedDefines, "no non-Babylon defines were checked — the scan is vacuous")
      .toBeGreaterThan(3);

    expect(failures, failures.join("\n")).toEqual([]);
  });
});
