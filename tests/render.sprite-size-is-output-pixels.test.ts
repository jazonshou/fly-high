/**
 * Sprite sizes are denominated in OUTPUT pixels, and the call sites must feed
 * them the output size.
 *
 * **This guards a bug that shipped for months behind a docblock asserting the
 * opposite.** `LightPointSystem` and `StarFieldSystem` size their sprites from
 * an NDC-per-pixel uniform, `2 / widthPixels`. Both setters were named
 * `setRenderSize`, and `FlightRenderer` duly passed `engine.getRenderWidth()`
 * — the SCALED raster. At tier 1 that raster is 1100x619 and is stretched to
 * the 1280x720 canvas, so every runway lamp and every star drew **16.3% wider**
 * than the pixel count the constant names.
 *
 * **Why a source guard rather than a behavioural one.** The quantity is a
 * uniform on a material inside a GPU pipeline; asserting it end-to-end needs a
 * real device and a readback, which `NullEngine` cannot do and which the GPU
 * suite cannot do either (`readPixels` returns zeros there). What CAN be
 * asserted cheaply and exactly is the thing that actually broke: **which size
 * the renderer hands to the setter.** That is a property of the source, so the
 * guard reads the source.
 *
 * **The tell that it was a bug and not a decision** is preserved in
 * `StarField`'s constructor, which initialises the same uniform to the literal
 * `2 / 1280, 2 / 720` — the OUTPUT size. Author's intent in the initialiser,
 * denomination silently changed by the per-frame setter. That initialiser is
 * asserted below too, because if someone "tidies" it to the render size the
 * evidence of intent disappears and the next reader has nothing to recover.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { readSource } from "./support/sourceText";

const ROOT = resolve(__dirname, "..");
const read = (relative: string) => readSource(resolve(ROOT, relative));

/** Every `setOutputSize(` call and the arguments up to its closing paren. */
function outputSizeCalls(source: string): string[] {
  const out: string[] = [];
  const marker = ".setOutputSize(";
  let index = source.indexOf(marker);
  while (index !== -1) {
    const open = index + marker.length - 1;
    let depth = 0;
    let end = open;
    for (; end < source.length; end += 1) {
      if (source[end] === "(") depth += 1;
      else if (source[end] === ")") {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    out.push(source.slice(open + 1, end));
    index = source.indexOf(marker, end);
  }
  return out;
}

describe("sprite sizing is denominated in output pixels", () => {
  it("feeds every setOutputSize the CSS size, never the scaled raster", () => {
    const renderer = read("src/render/FlightRenderer.ts");
    const calls = outputSizeCalls(renderer);

    // NON-VACUITY: if the parser finds nothing, every assertion below passes
    // over an empty list. Both systems are wired, so two is the floor.
    expect(calls.length).toBeGreaterThanOrEqual(2);

    for (const args of calls) {
      // FAILS IF: someone re-wires this to the render target. That is the exact
      // edit that produced the original 16.3% oversize, and it type-checks,
      // runs, and looks right.
      expect(args).not.toMatch(/getRenderWidth|getRenderHeight/);
      expect(args).toMatch(/clientWidth/);
      expect(args).toMatch(/clientHeight/);
    }
  });

  it("PROVES the check can fail, on a synthetic violator", () => {
    // Without this the test above is an assertion over text that happens to
    // pass; a parser that silently matched nothing would look identical.
    const violator = `
      this.stars.setOutputSize(this.engine.getRenderWidth(), this.engine.getRenderHeight());
    `;
    const calls = outputSizeCalls(violator);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatch(/getRenderWidth/);
    expect(calls[0]).not.toMatch(/clientWidth/);
  });

  it("keeps the setter named for the units it takes", () => {
    // FAILS IF: the name reverts. The old name is what made the wrong argument
    // look correct at the call site — `setRenderSize(getRenderWidth())` reads
    // as obviously right, which is why it survived a docblock saying otherwise.
    for (const file of [
      "src/render/webgpu/lighting/LightPoints.ts",
      "src/render/webgpu/atmosphere/StarField.ts",
    ]) {
      const source = read(file);
      expect(source).toMatch(/\n {2}setOutputSize\(/);
      // The identifier may still appear in the docblocks that explain the
      // rename; what must not come back is a declaration.
      expect(source).not.toMatch(/\n {2}setRenderSize\(/);
    }
  });

  it("keeps StarField's initialiser at the output size, as the record of intent", () => {
    const stars = read("src/render/webgpu/atmosphere/StarField.ts");
    expect(stars).toMatch(/starPixelSize",\s*new Vector2\(2 \/ 1280, 2 \/ 720\)/);
  });
});
