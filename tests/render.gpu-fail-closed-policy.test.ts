import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const rendererSource = readFileSync(
  new URL("../src/render/FlightRenderer.ts", import.meta.url),
  "utf8",
);
const gameSource = readFileSync(
  new URL("../src/game/FlightGame.tsx", import.meta.url),
  "utf8",
);

describe("uncaptured WebGPU errors fail closed", () => {
  it("owns the raw-device listener before scene or pipeline startup", () => {
    const engineCreated = rendererSource.indexOf("WebGPUEngine.CreateAsync(");
    const guardInstalled = rendererSource.indexOf(
      "const gpuUncapturedErrorGuard = new GpuUncapturedErrorGuard(",
    );
    const sceneCreated = rendererSource.indexOf("const scene = new Scene(engine)");

    expect(engineCreated).toBeGreaterThan(0);
    expect(guardInstalled).toBeGreaterThan(engineCreated);
    expect(sceneCreated).toBeGreaterThan(guardInstalled);
    expect(rendererSource).toContain("gpuUncapturedErrorGuard.throwIfFailed();");
  });

  it("rejects later frames and detaches before GPU teardown", () => {
    const renderMethod = rendererSource.match(
      /render\(state: FlightVisualState[\s\S]*?\n  getDiagnostics\(/u,
    )?.[0] ?? "";
    const disposeMethod = rendererSource.match(
      /dispose\(\): void \{[\s\S]*?\n  \}\n\n  private installFrameGraph/u,
    )?.[0] ?? "";

    expect(renderMethod).toContain("this.gpuUncapturedErrorGuard.throwIfFailed();");
    expect(disposeMethod).toContain("this.gpuUncapturedErrorGuard.dispose();");
    expect(disposeMethod.indexOf("this.gpuUncapturedErrorGuard.dispose();"))
      .toBeLessThan(disposeMethod.indexOf("() => this.engine.dispose()"));
  });

  it("routes device loss, raw GPU errors, and frame throws through one stop path", () => {
    const stop = gameSource.match(
      /const stopRendererSafely[\s\S]*?\n    \};/u,
    )?.[0] ?? "";

    expect(stop).toContain("rendererTerminal = true");
    expect(stop).toContain("cancelAnimationFrame(animationFrame)");
    expect(stop).toContain("controlPump?.dispose()");
    expect(stop).toContain("simulationRef.current?.setPaused(true)");
    expect(stop).toContain("canvas.dataset.renderFailure = reason");
    expect(stop).toContain("setError(userMessage)");
    expect(gameSource).toContain("onDeviceLost: (reason: string) => {");
    expect(gameSource).toContain("onGpuUncapturedError: (reason: string) => {");
    expect(gameSource.match(/stopRendererSafely\(/gu)).toHaveLength(3);
    expect(gameSource).toContain("if (disposed || rendererTerminal) return;");
  });
});
