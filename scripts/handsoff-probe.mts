/**
 * The hands-off airborne trajectory AS THE PLAYER GETS IT.
 *
 * Exists because a headless harness and the running game disagreed. The
 * harness stepped the simulator with no environment argument at all — no
 * wind, and terrain only where it was passed — and reported that every
 * airframe holds altitude from its airborne spawn. In the app the 747-8
 * descended steadily during a camera capture and flew into a mountain.
 *
 * A trajectory measured without the environment the aeroplane actually flies
 * in is not a measurement of the aeroplane. This reads the game's own HUD.
 *
 * Usage: handsoff-probe.mts <outDir> <url> <kind> <seconds> <expectTree> [startAglFt]
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { chromium } from "playwright";
import { chromiumStdioLaunchOptions } from "./playwrightChromiumLaunch";

const [outDir, url, kind, secondsRaw, expectTree, startAglRaw, seed] = process.argv.slice(2);
if (!outDir || !url || !kind || !expectTree) {
  throw new Error("usage: <outDir> <url> <kind> <seconds> <expectTree> [startAglMetres] [seed]");
}
const seconds = Number(secondsRaw ?? 60);
/**
 * METRES. `protocol.ts` documents `airborneStartAgl` as metres above the
 * terrain datum, default 450, range 120-3000. An earlier run of this probe
 * passed 1500 meaning feet and spawned the aeroplane at 4,921 ft, where the
 * catalogue's throttle could not hold level and the 747 flew into a ridge.
 */
const startAgl = Number(startAglRaw ?? 450);
mkdirSync(outDir, { recursive: true });

const probeUrl = new URL(`/@fs${expectTree}/package.json`, url).toString();
const identity = await fetch(probeUrl);
if (!identity.ok) throw new Error(`${url} is NOT serving ${expectTree} (${identity.status})`);
console.log(`serving: ${expectTree} (verified via /@fs)`);

const browser = await chromium.launch({
  ...chromiumStdioLaunchOptions(),
  channel: "chromium",
  headless: false,
  args: [
    "--disable-crashpad-for-testing", "--disable-crash-reporter",
    "--enable-unsafe-webgpu", "--use-angle=metal", "--enable-features=WebGPU",
    "--window-size=1280,820",
  ],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
await page.addInitScript(({ kind, startAgl }: { kind: string; startAgl: number }) => {
  try {
    const key = Object.keys(localStorage).find((k) => k.includes("settings")) ?? "aerolith.settings.v3";
    const existing = JSON.parse(localStorage.getItem(key) ?? "{}");
    localStorage.setItem(key, JSON.stringify({
      ...existing, aircraft: kind, airborneStartAgl: startAgl,
      weather: "clear", timeOfDay: "day", showDiagnostics: false,
    }));
  } catch { /* first load */ }
}, { kind, startAgl });

/*
 * The world seed is PINNED. Without it every run generates fresh terrain, and
 * a probe reporting height above ground then measures the landscape as much as
 * the aeroplane — which is how a "descent" of 3,457 ft turned out to be partly
 * the aircraft flying over higher country. Altitude below is read from the
 * scene, in metres above the datum, for the same reason.
 */
const target = new URL(url);
if (seed) target.searchParams.set("seed", seed);
await page.goto(target.toString(), { waitUntil: "domcontentloaded" });
await page.locator('[aria-label="fly high start"]').waitFor({ timeout: 120_000 });
await page.waitForTimeout(2_000);
await page.getByRole("button", { name: /^Start$|^Start\b/ }).first().click();
// The menu button keeps focus after the click, and flight keys are swallowed
// while an interactive element has it. Nothing is pressed here, but blurring
// keeps this probe honest if it ever grows a control input.
await page.evaluate(() => {
  (globalThis as unknown as Record<string, unknown>).__name ??= (fn: unknown) => fn;
  (document.activeElement as HTMLElement | null)?.blur();
});
await page.waitForTimeout(3_000);

interface Row {
  t: number; ias: number; agl: number; vs: number; thr: number;
  altitude: number; damaged: boolean;
}

/** The aircraft's world Y, in metres — true altitude, not height above ground. */
async function altitudeMetres(): Promise<number> {
  return page.evaluate(() => {
    (globalThis as unknown as Record<string, unknown>).__name ??= (fn: unknown) => fn;
    const storeUrl = performance.getEntriesByType("resource")
      .map((r) => r.name).find((n) => /\/deps\/engineStore-[^/]*\.js/.test(n));
    if (!storeUrl) return Number.NaN;
    const w = globalThis as unknown as { __handsoffStore?: unknown };
    const load = async () => {
      if (!w.__handsoffStore) w.__handsoffStore = await import(/* @vite-ignore */ storeUrl);
      return w.__handsoffStore as Record<string, unknown>;
    };
    return load().then((mod) => {
      const store = Object.values(mod).find(
        (v: unknown) => !!v && Array.isArray((v as { Instances?: unknown }).Instances),
      ) as { Instances: { scenes: { transformNodes: { metadata?: { aircraftVisual?: boolean }; position: { y: number } }[] }[] }[] } | undefined;
      const root = store?.Instances[0]?.scenes[0]?.transformNodes
        .find((n) => n.metadata?.aircraftVisual);
      return root ? root.position.y : Number.NaN;
    });
  });
}
const rows: Row[] = [];
const started = Date.now();
while ((Date.now() - started) / 1000 < seconds) {
  const row = await page.evaluate(() => {
    // tsx/esbuild rewrites named function expressions as `__name(fn, "name")`
    // and page.evaluate ships the transpiled body WITHOUT esbuild's preamble.
    // Third probe in this session to trip over it; it belongs in every one.
    (globalThis as unknown as Record<string, unknown>).__name ??= (fn: unknown) => fn;
    const text = document.body.innerText.replace(/\s+/g, " ");
    const grab = (re: RegExp) => Number((text.match(re)?.[1] ?? "").replace(/,/g, ""));
    return {
      ias: grab(/IAS ([\d,]+) KT/),
      agl: grab(/AGL ([\d,-]+) FT/),
      vs: grab(/V\/S ([+-]?[\d,]+) FT\/M/),
      thr: grab(/THR ([\d,]+)/),
      damaged: /AIRCRAFT DAMAGED/.test(text),
    };
  });
  rows.push({
    t: Math.round((Date.now() - started) / 1000),
    ...row,
    altitude: await altitudeMetres(),
  });
  if (row.damaged) break;
  await page.waitForTimeout(1_000);
}
await page.screenshot({ path: `${outDir}/${kind}-handsoff-end.png`, type: "png" });
writeFileSync(`${outDir}/${kind}-handsoff.json`, JSON.stringify(rows, null, 1));

const first = rows[0]!;
const last = rows[rows.length - 1]!;
const altitudes = rows.map((r) => r.altitude).filter(Number.isFinite);
const minAltitude = Math.min(...altitudes);
const worstVs = Math.min(...rows.map((r) => r.vs).filter(Number.isFinite));
console.log(
  `${kind.padEnd(9)} thr ${String(first.thr).padStart(3)}%  `
  + `alt ${first.altitude.toFixed(0).padStart(5)} -> ${last.altitude.toFixed(0).padStart(5)} m  `
  + `lowest ${minAltitude.toFixed(0).padStart(5)} m  `
  + `drop ${(first.altitude - minAltitude).toFixed(0).padStart(4)} m  `
  + `worst V/S ${String(worstVs).padStart(6)} ft/min`
  + (rows.some((r) => r.damaged) ? "   *** CRASHED ***" : ""),
);
for (const r of rows.filter((r) => r.t % 10 === 0)) {
  console.log(`    t=${String(r.t).padStart(2)}s  IAS ${String(r.ias).padStart(4)}  AGL ${String(r.agl).padStart(6)}  V/S ${String(r.vs).padStart(7)}`);
}
await browser.close();
