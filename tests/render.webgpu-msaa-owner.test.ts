import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("MSAA beauty-target ownership", () => {
  it("updates whichever post-process is first on profile changes", () => {
    const source = readFileSync("src/render/FlightRenderer.ts", "utf8");
    expect(source).toContain(
      "this.scotopic.setSamples(this.scotopic.enabled ? this.profile.msaaSamples : 1)",
    );
    expect(source).toContain(
      "this.toneMap.samples = this.scotopic.enabled ? 1 : this.profile.msaaSamples",
    );
    expect(source).toContain("this.scotopic.setEnabled(this.camera, false)");
    expect(source).toContain("this.scotopic.setEnabled(this.camera, true)");
    expect(source).not.toContain("setAlphaToCoverage");
  });
});
