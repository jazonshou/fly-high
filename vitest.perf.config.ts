import { fileURLToPath } from "node:url";
import { playwright } from "@vitest/browser-playwright";
import { defineConfig } from "vitest/config";

/**
 * The perf-capture project (1A-1c).
 *
 * `npm run perf:capture` boots the real FlightRenderer in WebGPU-capable
 * headless Chromium, renders the sixteen canonical shots (fixed seed, camera,
 * weather, clock, and viewport per definition), and writes screenshots plus a numeric report to
 * tests/perf/artifacts, comparing against the committed baselines in
 * tests/perf/baseline. The baseline directory is always read-only. A missing
 * or dimension-mismatched committed image is a hard failure.
 *
 * `npm run perf:capture:candidate` runs the exact full canonical set, buffers
 * every image until all visual/performance/renderer validations pass, then
 * writes only a fresh timestamped directory beneath
 * tests/perf/artifacts/rebaseline-candidates for human review. It never
 * promotes or rewrites a committed baseline.
 *
 * Real GPU. A focused tier-1 set runs on renderer PRs; the full set runs on
 * main and on schedule. Deliberately excluded from `npm run verify` and the
 * Node-only `npm test` command.
 */
/**
 * The browser window for this run: the swept viewport when `VITE_PERF_VIEWPORT`
 * is set, otherwise the canonical 1280x720. Parsed defensively — an unreadable
 * value falls back to canonical rather than silently producing a clamped run,
 * and the driver validates the same variable strictly and will throw there.
 */
function sweepViewport(): { width: number; height: number } | null {
  const raw = String(process.env.VITE_PERF_VIEWPORT ?? "").trim();
  const match = /^(\d+)x(\d+)$/u.exec(raw);
  if (!match) return null;
  return { width: Number(match[1]), height: Number(match[2]) };
}

/** The swept viewport, or the canonical 1280x720 when not sweeping. */
function sweepWindowSize(): { width: number; height: number } {
  return sweepViewport() ?? { width: 1_280, height: 720 };
}

export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL(".", import.meta.url)),
    },
  },
  test: {
    include: ["tests/perf/**/*.test.ts"],
    passWithNoTests: false,
    reporters: ["default"],
    // 2Z and later terrain phases grew the shot list to sixteen; streaming dominates.
    testTimeout: 1_500_000,
    hookTimeout: 120_000,
    browser: {
      enabled: true,
      headless: true,
      screenshotFailures: false,
      provider: playwright({
        launchOptions: {
          channel: "chromium",
          args: [
            "--enable-unsafe-webgpu",
            "--use-angle=metal",
            "--enable-features=WebGPU",
            // 6-11.1: sized to the swept viewport, and ONLY when sweeping.
            //
            // The OS window must be at least the page viewport or the canvas is
            // clamped by layout before it ever sees the CSS size — the first
            // sweep attempt asked for 1920x1080 and rendered 1333x750 while the
            // report faithfully said 1080p.
            //
            // It is conditional because the canonical run must be BYTE-IDENTICAL
            // to what it was before the sweep existed. Adding the flag
            // unconditionally measured a lower median on this host, and while a
            // hot host cannot settle whether the flag truly costs anything (see
            // §1.2's A->B->A amendment), the standing gate is not the place to
            // find out. The sweep opts in; the shipping tier does not.
            ...(sweepViewport() ? [`--window-size=${sweepViewport()!.width},${sweepViewport()!.height + 120}`] : []),
          ],
        },
      }),
      /**
       * `6-11.1`: the browser WINDOW must be at least the viewport being swept.
       *
       * Playwright's default window is 1280x720 — the canonical shot size, which
       * is why this never mattered before. A CSS-sized canvas larger than the
       * window is CLAMPED by layout, silently: the first sweep attempt asked for
       * 1920x1080, the report faithfully recorded 1920x1080 because that is what
       * the driver set, and the renderer drew 1333x750. The numbers looked like a
       * 1080p row and were not one. Only the render-scale pin caught it, and it
       * caught it as a confusing scale error rather than as "your viewport did
       * not take".
       *
       * Sizing the window from the same variable that sizes the canvas keeps the
       * two from disagreeing. Off the sweep this resolves to the canonical
       * 1280x720 and nothing changes.
       */
      viewport: sweepWindowSize(),
      instances: [{ browser: "chromium" }],
    },
  },
});
