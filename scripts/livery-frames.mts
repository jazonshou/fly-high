/**
 * The livery from the angles it has to survive: several orbit bearings, plus
 * the chase view a player actually flies in.
 *
 * A paint scheme defined in BODY coordinates is meant to cross panel joints
 * without stepping, and the only way to know it does is to look at the joins
 * from more than one bearing -- a stripe can line up perfectly from the side
 * and step visibly from three-quarters behind. The orbit camera moves on its
 * own, so frames are spaced in TIME and the bearing comes for free.
 *
 *   npx tsx scripts/livery-frames.mts <outDir> <url> <expectTree> [kind] [frames]
 */
import { mkdirSync } from "node:fs";
import { chromium } from "playwright";
import { chromiumStdioLaunchOptions } from "./playwrightChromiumLaunch";

const [outDir, url, expectTree, kindRaw, framesRaw] = process.argv.slice(2);
if (!outDir || !url || !expectTree) throw new Error("usage: <outDir> <url> <expectTree> [kind] [frames]");
const kind = kindRaw ?? "bizjet";
const orbitFrames = Number(framesRaw ?? 6);
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
await page.waitForTimeout(30_000);

async function view(): Promise<string> {
  const text = await page.evaluate(() => document.body.innerText.replace(/\s+/g, " "));
  const named = text.match(/SCENIC ASSIST\s+([A-Z ]+?)\s+WORLD/);
  return (named?.[1] ?? "unknown").trim().toLowerCase().replace(/\s+/g, "-");
}

/** The aeroplane's own pixels, so a crop lands on paint rather than on sky. */
async function aircraftRect(): Promise<{ x: number; y: number; w: number; h: number } | null> {
  return page.evaluate(async (airframe: string) => {
    (globalThis as unknown as Record<string, unknown>).__name ??= (fn: unknown) => fn;
    const storeUrl = performance.getEntriesByType("resource")
      .map((r) => r.name).find((n) => /\/deps\/engineStore-[^/]*\.js/.test(n));
    if (!storeUrl) return null;
    const anyWindow = globalThis as unknown as { __liveryStore?: unknown };
    if (!anyWindow.__liveryStore) anyWindow.__liveryStore = await import(/* @vite-ignore */ storeUrl);
    const mod = anyWindow.__liveryStore as Record<string, unknown>;
    const store = Object.values(mod).find(
      (v: unknown) => !!v && Array.isArray((v as { Instances?: unknown }).Instances),
    ) as { Instances: { scenes: unknown[] }[] } | undefined;
    const scene = store?.Instances[0]?.scenes[0] as {
      meshes: { name: string; getTotalVertices: () => number; computeWorldMatrix: (f: boolean) => void;
        getBoundingInfo: () => { boundingBox: { vectorsWorld: { x: number; y: number; z: number }[] } } }[];
      getTransformMatrix: () => { m: number[] };
    } | undefined;
    if (!scene) return null;
    const m = scene.getTransformMatrix().m;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    // Anything named for this airframe: fuselage, fin, nacelles, winglets.
    for (const mesh of scene.meshes) {
      // Anything belonging to THIS airframe. Matching one kind's prefix was a
      // bizjet-only habit and cropped the 747 to its tail surfaces.
      if (mesh.getTotalVertices() === 0) continue;
      if (!new RegExp(`${airframe}|aileron|elevator|rudder|flaperon`).test(mesh.name)) continue;
      mesh.computeWorldMatrix(true);
      for (const p of mesh.getBoundingInfo().boundingBox.vectorsWorld) {
        const cw = p.x * m[3]! + p.y * m[7]! + p.z * m[11]! + m[15]!;
        if (cw <= 0) continue;
        const sx = (((p.x * m[0]! + p.y * m[4]! + p.z * m[8]! + m[12]!) / cw) * 0.5 + 0.5) * window.innerWidth;
        const sy = (0.5 - ((p.x * m[1]! + p.y * m[5]! + p.z * m[9]! + m[13]!) / cw) * 0.5) * window.innerHeight;
        minX = Math.min(minX, sx); maxX = Math.max(maxX, sx);
        minY = Math.min(minY, sy); maxY = Math.max(maxY, sy);
      }
    }
    return Number.isFinite(minX) ? { x: minX, y: minY, w: maxX - minX, h: maxY - minY } : null;
  }, kind);
}

/**
 * A tight crop around a BODY STATION, for looking at a specific mesh join.
 *
 * The livery's whole claim is that a boundary crosses a join without stepping,
 * and a join is at a known x. Projecting that station beats cropping by eye,
 * which is how you end up photographing the wrong 200 pixels.
 */
async function stationRect(bodyX: number): Promise<{ x: number; y: number; w: number; h: number } | null> {
  return page.evaluate(async (station: number) => {
    (globalThis as unknown as Record<string, unknown>).__name ??= (fn: unknown) => fn;
    const storeUrl = performance.getEntriesByType("resource")
      .map((r) => r.name).find((n) => /\/deps\/engineStore-[^/]*\.js/.test(n));
    if (!storeUrl) return null;
    const anyWindow = globalThis as unknown as { __liveryStore?: unknown };
    if (!anyWindow.__liveryStore) anyWindow.__liveryStore = await import(/* @vite-ignore */ storeUrl);
    const mod = anyWindow.__liveryStore as Record<string, unknown>;
    const store = Object.values(mod).find(
      (v: unknown) => !!v && Array.isArray((v as { Instances?: unknown }).Instances),
    ) as { Instances: { scenes: unknown[] }[] } | undefined;
    const scene = store?.Instances[0]?.scenes[0] as {
      meshes: { name: string; computeWorldMatrix: (f: boolean) => void; getWorldMatrix: () => { m: number[] } }[];
      getTransformMatrix: () => { m: number[] };
    } | undefined;
    const anchor = scene?.meshes.find((mesh) => /fuselage|shell/.test(mesh.name));
    if (!scene || !anchor) return null;
    anchor.computeWorldMatrix(true);
    const w = anchor.getWorldMatrix().m;
    const m = scene.getTransformMatrix().m;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const dy of [-1.2, 0, 1.2]) {
      for (const dz of [-1.2, 0, 1.2]) {
        const lx = station, ly = dy, lz = dz;
        const px = w[0]! * lx + w[4]! * ly + w[8]! * lz + w[12]!;
        const py = w[1]! * lx + w[5]! * ly + w[9]! * lz + w[13]!;
        const pz = w[2]! * lx + w[6]! * ly + w[10]! * lz + w[14]!;
        const cw = px * m[3]! + py * m[7]! + pz * m[11]! + m[15]!;
        if (cw <= 0) continue;
        const sx = (((px * m[0]! + py * m[4]! + pz * m[8]! + m[12]!) / cw) * 0.5 + 0.5) * window.innerWidth;
        const sy = (0.5 - ((px * m[1]! + py * m[5]! + pz * m[9]! + m[13]!) / cw) * 0.5) * window.innerHeight;
        minX = Math.min(minX, sx); maxX = Math.max(maxX, sx);
        minY = Math.min(minY, sy); maxY = Math.max(maxY, sy);
      }
    }
    return Number.isFinite(minX) ? { x: minX, y: minY, w: maxX - minX, h: maxY - minY } : null;
  }, bodyX);
}

async function shoot(label: string): Promise<void> {
  await page.screenshot({ path: `${outDir}/${label}.png`, type: "png" });
  const rect = await aircraftRect();
  if (rect && rect.w > 8 && rect.h > 8) {
    const pad = Math.max(20, rect.w * 0.08);
    const x = Math.max(0, rect.x - pad);
    const y = Math.max(0, rect.y - pad);
    await page.screenshot({
      path: `${outDir}/${label}-close.png`,
      type: "png",
      clip: {
        x, y,
        width: Math.min(WIDTH - x, rect.w + pad * 2),
        height: Math.min(HEIGHT - y, rect.h + pad * 2),
      },
    });
  }
  // The fuselage/tailcone seam, where the cheatline has the most to prove.
  const seam = await stationRect(-13.0);
  if (seam && seam.w > 4) {
    const pad = Math.max(60, seam.w);
    const x = Math.max(0, seam.x - pad);
    const y = Math.max(0, seam.y - pad * 0.4);
    await page.screenshot({
      path: `${outDir}/${label}-seam.png`,
      type: "png",
      clip: {
        x, y,
        width: Math.min(WIDTH - x, seam.w + pad * 2),
        height: Math.min(HEIGHT - y, seam.h + pad * 0.8),
      },
    });
  }
  console.log(`${label}: ${await view()}${rect ? `, aeroplane ${Math.round(rect.w)}x${Math.round(rect.h)} px` : ", NOT PROJECTED"}${seam ? `, seam ${Math.round(seam.w)}x${Math.round(seam.h)}` : ", seam off screen"}`);
}

// Chase first, then round to the orbit camera and let it carry the bearing.
for (let step = 0; step < 6; step += 1) {
  if (await view() === "chase-cam") break;
  await page.keyboard.press("KeyC");
  await page.waitForTimeout(900);
}
await shoot("chase");
for (let step = 0; step < 6; step += 1) {
  if (await view() === "orbit-cam") break;
  await page.keyboard.press("KeyC");
  await page.waitForTimeout(900);
}
if (await view() !== "orbit-cam") throw new Error("never reached the orbit view");
for (let frame = 0; frame < orbitFrames; frame += 1) {
  await shoot(`orbit-${String(frame).padStart(2, "0")}`);
  await page.waitForTimeout(5_000);
}
await browser.close();
console.log("frames written");
