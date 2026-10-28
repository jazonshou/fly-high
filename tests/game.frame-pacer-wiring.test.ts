import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readSource } from "./support/sourceText";

/**
 * PR B, step 3.2: how FlightGame runs the frame pacer. The pacer's logic is
 * tested in `game.frame-pacer.test.ts`; these guards hold FlightGame to the
 * wiring around it. A tick that does not draw only asks for the next frame,
 * the renderer hears of a new cadence inside the frame's `try` (so a throw
 * there takes the one stop path), and the fail-closed, bench.inert and
 * diagnostics-cadence guards keep passing unchanged.
 */

const projectRoot = join(import.meta.dirname, "..");
const flightGame = readSource(join(projectRoot, "src/game/FlightGame.tsx"));
const pacerSource = readSource(join(projectRoot, "src/game/framePacer.ts"));
// The same extract as tests/bench.inert.test.ts and tests/game.diagnostics-cadence.test.ts.
const renderLoop = flightGame.match(/const renderLoop = \(now: number\) => \{[\s\S]*?\n {6}\};/u)?.[0] ?? "";

describe("FlightGame's frame loop paces its ticks", () => {
  it("asks the pacer first, right after the stop check", () => {
    expect(renderLoop).toMatch(
      /^const renderLoop = \(now: number\) => \{\s+if \(disposed \|\| rendererTerminal\) return;\s+const paced = framePacer\.tick\(now, settingsRef\.current\.frameRate, phaseRef\.current === "paused"\);/u,
    );
  });

  it("only asks for the next frame on a tick that does not draw", () => {
    expect(renderLoop).toMatch(
      /if \(!paced\.render\) \{\s+animationFrame = requestAnimationFrame\(renderLoop\);\s+return;\s+\}/u,
    );
    const skip = renderLoop.indexOf("if (!paced.render)");
    expect(skip).toBeGreaterThan(0);
    expect(renderLoop.indexOf("const deltaSeconds")).toBeGreaterThan(skip);
    expect(renderLoop.indexOf("lastFrame = now;")).toBeGreaterThan(skip);
  });

  it("hands the renderer a new cadence inside the frame's try, before it renders", () => {
    expect(renderLoop).toContain("if (paced.cadence !== null) pendingCadence = paced.cadence;");
    const attempt = renderLoop.slice(renderLoop.indexOf("try {"), renderLoop.indexOf("} catch (renderError)"));
    expect(attempt).toMatch(
      /if \(pendingCadence !== null\) \{\s+renderer\.setPresentationCadence\(pendingCadence\);\s+pendingCadence = null;\s+\}\s+renderer\.render\(frameState, deltaSeconds\);/u,
    );
    expect(flightGame.match(/setPresentationCadence\(/gu)).toHaveLength(1);
  });

  it("holds the governor while the flight is paused, inside the frame's try", () => {
    const attempt = renderLoop.slice(renderLoop.indexOf("try {"), renderLoop.indexOf("} catch (renderError)"));
    expect(attempt).toMatch(
      /renderer\.setGovernorHold\(phaseRef\.current === "paused"\);[\s\S]*renderer\.render\(frameState, deltaSeconds\);/u,
    );
    expect(flightGame.match(/setGovernorHold\(/gu)).toHaveLength(1);
  });

  it("drops the interval a re-probe's skipped ticks leave, inside the frame's try", () => {
    const attempt = renderLoop.slice(renderLoop.indexOf("try {"), renderLoop.indexOf("} catch (renderError)"));
    expect(attempt).toMatch(
      /if \(paced\.afterReprobe\) renderer\.discardNextFrameInterval\(\);[\s\S]*renderer\.render\(frameState, deltaSeconds\);/u,
    );
    expect(flightGame.match(/discardNextFrameInterval\(/gu)).toHaveLength(1);
  });

  it("runs the shipped pacer, with no override of its switches", () => {
    expect(flightGame).toContain("const framePacer = new FramePacer();");
    expect(flightGame.match(/new FramePacer\(/gu)).toHaveLength(1);
  });

  it("forgets the timing on every visibility change", () => {
    expect(flightGame).toMatch(/const handleVisibility = \(\) => \{\s+framePacer\.reset\(\);/u);
  });

  it("probes the display while the renderer is created, after its quiet lead at every setting, and always stops the probe", () => {
    expect(flightGame).toMatch(
      /idleProbe = startIdleProbe\(framePacer\);\s+let created: FlightRenderer;\s+try \{\s+await idleProbe\.lead;\s+created = await FlightRenderer\.create\(rendererOptions\);\s+\} finally \{\s+idleProbe\.stop\(\);\s+\}/u,
    );
    // The effect's cleanup stops a probe that is still running.
    const cleanup = flightGame.slice(flightGame.indexOf("disposed = true;\n      startupAbortController.abort();"));
    expect(cleanup.slice(0, 200)).toContain("idleProbe?.stop();");
  });
});

describe("the pacer module", () => {
  it("touches no DOM when it is imported or ticked", () => {
    expect(pacerSource).not.toMatch(/\b(window|document|performance)\./u);
    // The browser's frame and timer functions are reached only through the probe's default host.
    const browserCall = /(?<![.\w])(requestAnimationFrame|cancelAnimationFrame|setTimeout|clearTimeout)\(/gu;
    const between = (from: string, to: string) => [pacerSource.indexOf(from), pacerSource.indexOf(to)] as const;
    const [hostStart, hostEnd] = between("function browserHost()", "export function startIdleProbe");
    const [typeStart, typeEnd] = between("export interface IdleProbeHost", "export interface IdleProbe {");
    expect(pacerSource.slice(hostStart, hostEnd).match(browserCall)).toHaveLength(4);
    const rest = pacerSource.slice(0, typeStart) + pacerSource.slice(typeEnd, hostStart) + pacerSource.slice(hostEnd);
    expect(rest.match(browserCall)).toBeNull();
  });
});
