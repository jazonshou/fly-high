/**
 * What does going fast low down do to terrain streaming?
 *
 * Asked BEFORE any F-16 geometry exists, because the answer decides whether a
 * Mach 1.2 aeroplane is buildable at all. If the ground under the aircraft
 * stops being resident at 408 m/s, no amount of mesh work fixes it.
 *
 * Reads the game's own diagnostics panel out of the DOM rather than reaching
 * into the renderer: the panel already publishes pending pages, the collision
 * fallback count, frame-interval p95 and the detail instance count, and a
 * probe that reads what the game displays cannot drift from what the game
 * measures. No debug hooks are added or needed.
 *
 * The aircraft is held at a target speed by THRUST, not by a control loop:
 * each run sets the jet's static thrust to the value whose terminal speed at
 * low level is the target, then flies full throttle hands-off in scenic mode,
 * which is an attitude-command controller and so holds level by itself.
 *
 * Usage: lowlevel-streaming-probe.mts <outDir> <url> <seconds> <arm> <expectTree> [startAglFt]
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { chromium } from "playwright";
import { chromiumStdioLaunchOptions } from "./playwrightChromiumLaunch";

const [outDir, url, secondsRaw, arm, expectTree, startAglRaw] = process.argv.slice(2);
if (!outDir || !url || !arm) throw new Error("usage: <outDir> <url> <seconds> <arm> <expectTree> [startAglFt]");
const seconds = Number(secondsRaw ?? 60);
const startAgl = Number(startAglRaw ?? 500);
const WIDTH = 1600;
const HEIGHT = 900;
mkdirSync(outDir, { recursive: true });

if (expectTree) {
  const probeUrl = new URL(`/@fs${expectTree}/package.json`, url).toString();
  const response = await fetch(probeUrl);
  if (!response.ok) {
    throw new Error(`${url} is NOT serving ${expectTree} (got ${response.status}); nothing measured.`);
  }
  console.log(`serving: ${expectTree} (verified via /@fs)`);
} else {
  throw new Error("refusing to measure without a tree identity");
}

const browser = await chromium.launch({
  ...chromiumStdioLaunchOptions(),
  channel: "chromium",
  headless: false,
  args: [
    "--disable-crashpad-for-testing", "--disable-crash-reporter",
    "--enable-unsafe-webgpu", "--use-angle=metal", "--enable-features=WebGPU",
    `--window-size=${WIDTH},${HEIGHT + 120}`,
  ],
});
const page = await browser.newPage({ viewport: { width: WIDTH, height: HEIGHT } });
await page.addInitScript(({ startAgl }: { startAgl: number }) => {
  try {
    const key = Object.keys(localStorage).find((k) => k.includes("settings")) ?? "aerolith.settings.v3";
    const existing = JSON.parse(localStorage.getItem(key) ?? "{}");
    localStorage.setItem(key, JSON.stringify({
      ...existing,
      aircraft: "jet",
      // Scenic is the attitude-command mode: hands off, it holds level, so the
      // run measures streaming rather than my ability to fly a straight line.
      flightMode: "scenic",
      showDiagnostics: true,
      airborneStartAgl: startAgl,
      weather: "clear",
      timeOfDay: "day",
    }));
  } catch { /* first load has no settings yet */ }
}, { startAgl });

await page.goto(url, { waitUntil: "domcontentloaded" });
await page.locator('[aria-label="fly high start"]').waitFor({ timeout: 120_000 });
await page.waitForTimeout(2_000);
await page.getByRole("button", { name: /^Start$|^Start\b/ }).first().click();

/** HUD scalars, thousands separators and all. */
async function hud(): Promise<{ ias: number; agl: number; vs: number; thr: number }> {
  const text = await page.evaluate(() => document.body.innerText.replace(/\s+/g, " "));
  const grab = (re: RegExp) => Number((text.match(re)?.[1] ?? "").replace(/,/g, ""));
  return {
    ias: grab(/IAS ([\d,]+) KT/),
    agl: grab(/AGL ([\d,-]+) FT/),
    vs: grab(/V\/S ([+-]?[\d,]+) FT\/M/),
    thr: grab(/THR ([\d,]+)/),
  };
}

// Full power. The spawn throttle is whatever that airframe's spec says - 17%
// for this one - and an earlier version of this probe never touched it, then
// reported a "Mach 1.2" run that was actually 180 m/s in a 3,000 ft/min climb.
await page.keyboard.down("Shift");
await page.waitForTimeout(6_000);
await page.keyboard.up("Shift");

/**
 * Hold the target height for `ms`.
 *
 * Scenic mode is attitude-command, so a held key asks for a pitch attitude and
 * releasing recentres. This leans on that: each 200 ms tick holds nose-up or
 * nose-down for as much of the tick as the error and vertical speed call for.
 * Without it the aeroplane simply climbs away from low level on excess thrust,
 * and a low-level streaming test that is not at low level measures nothing.
 */
async function holdAltitude(ms: number, targetFt: number): Promise<void> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    const { agl, vs } = await hud();
    if (!Number.isFinite(agl) || agl === 0) {
      // No HUD means the flight ended - almost always a crash into the terrain
      // this loop is supposed to be holding clear of.
      await page.waitForTimeout(200);
      continue;
    }
    // Lead with vertical speed rather than reacting to height alone. The first
    // version of this used position error with a 0.35 ms/ft gain and no
    // damping, which porpoised +/-5,000 ft/min and flew two of three runs into
    // the ground; the guard below caught them, but the fix is here.
    const predictedFt = agl + (vs / 60) * 6 - targetFt;
    const command = Math.max(-1, Math.min(1, predictedFt / 900));
    if (Math.abs(command) < 0.12) { await page.waitForTimeout(200); continue; }
    const key = command > 0 ? "w" : "s";
    const hold = Math.min(95, Math.abs(command) * 95);
    await page.keyboard.down(key);
    await page.waitForTimeout(hold);
    await page.keyboard.up(key);
    await page.waitForTimeout(Math.max(40, 220 - hold));
  }
}

// Descend to the test height and let speed and streaming reach steady state.
// A sample taken while still accelerating understates the backlog.
await holdAltitude(75_000, startAgl);
const settled = await hud();
console.log(`settled: IAS ${settled.ias} kt, AGL ${settled.agl} ft, V/S ${settled.vs} ft/min, THR ${settled.thr}%`);
if (!Number.isFinite(settled.agl) || settled.agl === 0) {
  throw new Error("no HUD at the end of the descent: the flight ended, almost certainly a crash. Nothing measured.");
}
if (settled.thr < 95) throw new Error(`throttle only reached ${settled.thr}%; the run would not be at the target speed`);
await page.screenshot({ path: `${outDir}/${arm}-settled.png`, type: "png" });

interface Sample {
  t: number; text: string; pos: { x: number; y: number; z: number } | null;
}

/**
 * The aircraft's world position, straight off the scene graph.
 *
 * Needed because the HUD publishes INDICATED airspeed, which is true airspeed
 * scaled by the density ratio, and the density here depends on absolute
 * altitude while the HUD only shows height above ground. Over high terrain the
 * two diverge badly: a run calibrated for 340 m/s at sea level read 884 kt,
 * and the difference was the ground being 2 km up, not the aeroplane going
 * faster than asked. Ground speed differentiated from position needs no such
 * assumption.
 */
async function aircraftPosition(): Promise<{ x: number; y: number; z: number } | null> {
  return page.evaluate(() => {
    // tsx/esbuild rewrites named function expressions as `__name(fn, "name")`,
    // but page.evaluate ships the transpiled body WITHOUT esbuild's helper
    // preamble, so the helper has to exist before anything else runs.
    (globalThis as unknown as Record<string, unknown>).__name ??= (fn: unknown) => fn;
    const storeUrl = performance.getEntriesByType("resource")
      .map((r) => r.name).find((n) => /\/deps\/engineStore-[^/]*\.js/.test(n));
    if (!storeUrl) return null;
    const anyWindow = globalThis as unknown as { __streamProbeStore?: unknown };
    const load = async () => {
      if (!anyWindow.__streamProbeStore) {
        anyWindow.__streamProbeStore = await import(/* @vite-ignore */ storeUrl);
      }
      return anyWindow.__streamProbeStore as Record<string, unknown>;
    };
    return load().then((mod) => {
      const store = Object.values(mod).find(
        (v: unknown) => !!v && Array.isArray((v as { Instances?: unknown }).Instances),
      ) as { Instances: { scenes: { transformNodes: { metadata?: { aircraftVisual?: boolean }; position: { x: number; y: number; z: number } }[] }[] }[] } | undefined;
      const scene = store?.Instances[0]?.scenes[0];
      const root = scene?.transformNodes.find((n) => n.metadata?.aircraftVisual);
      return root ? { x: root.position.x, y: root.position.y, z: root.position.z } : null;
    });
  });
}
const samples: Sample[] = [];
const started = Date.now();
// Altitude hold keeps running through the measurement; without it the
// aeroplane drifts off the test height over 45 s of excess thrust.
const holding = holdAltitude(seconds * 1000, startAgl);
while ((Date.now() - started) / 1000 < seconds) {
  const text = await page.evaluate(() => {
    const panel = document.querySelector('[aria-label="Performance diagnostics"]');
    const hud = document.body.innerText.replace(/\s+/g, " ");
    return `${panel ? (panel as HTMLElement).innerText.replace(/\s+/g, " ") : "NO PANEL"} ||HUD|| ${hud}`;
  });
  samples.push({ t: (Date.now() - started) / 1000, text, pos: await aircraftPosition() });
  await page.waitForTimeout(250);
}
await holding;
await page.screenshot({ path: `${outDir}/${arm}-final.png`, type: "png" });
writeFileSync(`${outDir}/${arm}-samples.json`, JSON.stringify(samples, null, 1));

function numbers(pattern: RegExp): number[] {
  const out: number[] = [];
  for (const s of samples) {
    const m = s.text.match(pattern);
    if (m?.[1]) out.push(Number(m[1].replace(/,/g, "")));
  }
  return out;
}
function stat(label: string, values: number[], unit = ""): void {
  if (values.length === 0) { console.log(`  ${label.padEnd(26)} NOT FOUND`); return; }
  const sorted = [...values].sort((a, b) => a - b);
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  console.log(
    `  ${label.padEnd(26)} mean ${mean.toFixed(1).padStart(8)}  min ${sorted[0]!.toFixed(1).padStart(7)}  `
    + `p95 ${sorted[Math.floor(sorted.length * 0.95)]!.toFixed(1).padStart(8)}  max ${sorted[sorted.length - 1]!.toFixed(1).padStart(8)}${unit}`,
  );
}

// Ground speed from successive positions. The renderer rebases its origin as
// the aeroplane travels, which shows up as an impossible jump; those intervals
// are dropped rather than averaged in.
const groundSpeeds: number[] = [];
for (let i = 1; i < samples.length; i += 1) {
  const a = samples[i - 1]!;
  const b = samples[i]!;
  if (!a.pos || !b.pos) continue;
  const dt = b.t - a.t;
  if (dt <= 0) continue;
  const speed = Math.hypot(b.pos.x - a.pos.x, b.pos.z - a.pos.z) / dt;
  if (speed > 1_000) continue;
  groundSpeeds.push(speed);
}

console.log(`\n=== ${arm} · ${samples.length} samples over ${seconds}s ===`);
stat("GROUND SPEED (m/s)", groundSpeeds);
if (groundSpeeds.length) {
  const mean = groundSpeeds.reduce((a, b) => a + b, 0) / groundSpeeds.length;
  console.log(`  -> Mach ${(mean / 340).toFixed(2)} equivalent at sea level, ${(mean * 1.94384).toFixed(0)} kt true`);
}
console.log(`  first sample: ${samples[0]?.text.slice(0, 180)}`);
stat("IAS (kt)", numbers(/IAS ([\d,]+) KT/));
stat("AGL (ft)", numbers(/AGL ([\d,-]+) FT/));
stat("V/S (ft/min)", numbers(/V\/S ([+-]?[\d,]+) FT/));
stat("throttle (%)", numbers(/THR ([\d,]+)/));
stat("pending terrain pages", numbers(/(\d+) pending/));
stat("resident terrain pages", numbers(/(\d+) pages/));
stat("compute dispatches", numbers(/pending · (\d+) dispatches/));
stat("COLLISION FALLBACK", numbers(/(\d+) collision fallback/));
stat("detail instances", numbers(/([\d,]+) detail instances/));
stat("fps", numbers(/(\d+) FPS/));
stat("frame ms", numbers(/([\d.]+) ms frame/));
stat("interval p95 (ms)", numbers(/([\d.]+) ms interval p95/));
stat("max frame (ms)", numbers(/(\d+) ms max/));
stat("hitches", numbers(/(\d+) hitches/));
await browser.close();
