/**
 * What the cabin glazing looks like from OUTSIDE and from the pilot's seat.
 *
 * Both halves in one run, because the Cessna's glazing is a trade between
 * them: the depth pre-pass that makes the cockpit view usable is the same flag
 * that makes the cabin read as a bare shell from outside, and a frame of
 * either one alone has been enough to "prove" the wrong thing twice.
 *
 * The camera key cycles, so which view a frame is actually in is READ from the
 * HUD and asserted, not assumed from the number of key presses.
 *
 *   npx tsx scripts/glazing-frames.mts <outDir> <url> <expectTree> [kind]
 */
import { mkdirSync } from "node:fs";
import { chromium } from "playwright";
import { chromiumStdioLaunchOptions } from "./playwrightChromiumLaunch";

const [outDir, url, expectTree, kindRaw] = process.argv.slice(2);
if (!outDir || !url || !expectTree) throw new Error("usage: <outDir> <url> <expectTree> [kind]");
const kind = kindRaw ?? "trainer";
const WIDTH = 1920;
const HEIGHT = 1080;
mkdirSync(outDir, { recursive: true });

const probe = await fetch(new URL(`/@fs${expectTree}/package.json`, url).toString());
if (!probe.ok) throw new Error(`${url} is NOT serving ${expectTree} (${probe.status}); nothing captured.`);
console.log(`serving: ${expectTree}`);

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
const page = await browser.newPage({
  viewport: { width: WIDTH, height: HEIGHT },
  deviceScaleFactor: 2,
});
for (const fatal of ["unhandledRejection", "uncaughtException"] as const) {
  process.on(fatal, (reason: unknown) => {
    void browser.close().catch(() => {}).then(() => {
      console.error(reason instanceof Error ? reason.stack ?? reason.message : String(reason));
      process.exit(1);
    });
  });
}
await page.addInitScript((wantedKind: string) => {
  try {
    const key = Object.keys(localStorage).find((k) => k.includes("settings")) ?? "aerolith.settings.v3";
    localStorage.setItem(key, JSON.stringify({
      ...JSON.parse(localStorage.getItem(key) ?? "{}"),
      aircraft: wantedKind,
      flightMode: "scenic",
      showDiagnostics: false,
      weather: "clear",
      timeOfDay: "day",
      airborneStartAgl: 900,
    }));
  } catch { /* first load has no settings yet */ }
}, kind);
await page.goto(url, { waitUntil: "domcontentloaded" });
await page.locator('[aria-label="fly high start"]').waitFor({ timeout: 120_000 });
await page.waitForTimeout(2_500);
await page.getByRole("button", { name: /^Start flying/ }).click();
// Long enough for the airborne spawn's phugoid to settle; a frame taken
// mid-oscillation is a frame of an aeroplane doing something.
await page.waitForTimeout(30_000);

/**
 * Which view the HUD says we are in. The camera key CYCLES, so this is READ
 * rather than counted: "press C twice" is a guess about a state machine, and a
 * frame captioned with the wrong view is worse than no frame.
 */
async function view(): Promise<string> {
  const text = await page.evaluate(() => document.body.innerText.replace(/\s+/g, " "));
  const named = text.match(/SCENIC ASSIST\s+([A-Z ]+?)\s+WORLD/);
  return (named?.[1] ?? "unknown").trim().toLowerCase().replace(/\s+/g, "-");
}

/**
 * Where the cabin glazing is on screen, through the LIVE camera.
 *
 * The defect is a property of a few hundred pixels of one mesh, and at orbit
 * distance the aeroplane is a couple of centimetres of a 4K frame. Projecting
 * the canopy's own world bounding box puts the crop on it by construction
 * rather than by my eye, and the same rectangle is used for both arms.
 */
async function canopyRect(): Promise<{ x: number; y: number; w: number; h: number } | null> {
  return page.evaluate(async () => {
    (globalThis as unknown as Record<string, unknown>).__name ??= (fn: unknown) => fn;
    const storeUrl = performance.getEntriesByType("resource")
      .map((r) => r.name).find((n) => /\/deps\/engineStore-[^/]*\.js/.test(n));
    if (!storeUrl) return null;
    const anyWindow = globalThis as unknown as { __glazeStore?: unknown };
    if (!anyWindow.__glazeStore) anyWindow.__glazeStore = await import(/* @vite-ignore */ storeUrl);
    const mod = anyWindow.__glazeStore as Record<string, unknown>;
    const store = Object.values(mod).find(
      (v: unknown) => !!v && Array.isArray((v as { Instances?: unknown }).Instances),
    ) as { Instances: { scenes: unknown[] }[] } | undefined;
    const scene = store?.Instances[0]?.scenes[0] as {
      meshes: { name: string; computeWorldMatrix: (f: boolean) => void;
        getBoundingInfo: () => { boundingBox: { vectorsWorld: { x: number; y: number; z: number }[] } } }[];
      getTransformMatrix: () => { m: number[] };
    } | undefined;
    const canopy = scene?.meshes.find((m) => m.name === "trainer-canopy");
    if (!scene || !canopy) return null;
    canopy.computeWorldMatrix(true);
    const m = scene.getTransformMatrix().m;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const p of canopy.getBoundingInfo().boundingBox.vectorsWorld) {
      const cw = p.x * m[3]! + p.y * m[7]! + p.z * m[11]! + m[15]!;
      if (cw <= 0) continue;
      const sx = (((p.x * m[0]! + p.y * m[4]! + p.z * m[8]! + m[12]!) / cw) * 0.5 + 0.5) * window.innerWidth;
      const sy = (0.5 - ((p.x * m[1]! + p.y * m[5]! + p.z * m[9]! + m[13]!) / cw) * 0.5) * window.innerHeight;
      minX = Math.min(minX, sx); maxX = Math.max(maxX, sx);
      minY = Math.min(minY, sy); maxY = Math.max(maxY, sy);
    }
    return Number.isFinite(minX) ? { x: minX, y: minY, w: maxX - minX, h: maxY - minY } : null;
  });
}

async function shoot(label: string): Promise<void> {
  await page.waitForTimeout(1_500);
  await page.screenshot({ path: `${outDir}/${label}.png`, type: "png" });
  const rect = await canopyRect();
  if (rect && rect.w > 4 && rect.h > 4) {
    const pad = Math.max(24, rect.w * 0.5);
    const x = Math.max(0, rect.x - pad);
    const y = Math.max(0, rect.y - pad);
    await page.screenshot({
      path: `${outDir}/${label}-cabin.png`,
      type: "png",
      clip: {
        x,
        y,
        width: Math.min(WIDTH - x, rect.w + pad * 2),
        height: Math.min(HEIGHT - y, rect.h + pad * 2),
      },
    });
  }
  console.log(`${label}: view is ${await view()}${rect ? `, cabin at ${Math.round(rect.x)},${Math.round(rect.y)} ${Math.round(rect.w)}x${Math.round(rect.h)}` : ", cabin NOT PROJECTED"}`);
}

// Every view the camera key cycles through, each labelled with what the HUD
// says it is. Stops when it comes back round to where it started.
const first = await view();
const seen = new Set<string>();
for (let step = 0; step < 8; step += 1) {
  const current = await view();
  if (seen.has(current)) break;
  seen.add(current);
  await shoot(current);
  await page.keyboard.press("KeyC");
  await page.waitForTimeout(1_200);
}
if (!seen.has("cockpit")) {
  throw new Error(`never reached the cockpit view (saw ${[...seen].join(", ")}); nothing usable`);
}
console.log(`views captured from ${first}: ${[...seen].join(", ")}`);
await browser.close();
console.log("frames written");
