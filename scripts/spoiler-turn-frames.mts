/**
 * The 747's flight spoilers rising on the down-going wing, IN A REAL TURN.
 *
 * Nothing here is staged. The scenic flight banks on its own and the mix reads
 * the same aileron the aeroplane is actually using, so this waits for a bank
 * rather than writing one — a frame of level flight captioned "in a turn"
 * would prove nothing, and a frame whose spoilers were posed by the capture
 * script would prove less.
 *
 * It REFUSES to shoot until it has seen both a bank and a difference between
 * the two wings, and it reports both numbers with the frame.
 *
 *   npx tsx scripts/spoiler-turn-frames.mts <outDir> <url> <expectTree>
 */
import { mkdirSync } from "node:fs";
import { chromium } from "playwright";
import { chromiumStdioLaunchOptions } from "./playwrightChromiumLaunch";

const [outDir, url, expectTree] = process.argv.slice(2);
if (!outDir || !url || !expectTree) throw new Error("usage: <outDir> <url> <expectTree>");
const WIDTH = 1600;
const HEIGHT = 900;
/** Enough bank that a viewer would expect roll spoilers to be doing something. */
const WANTED_BANK_DEGREES = 10;
/** And enough difference between the wings to photograph. */
const WANTED_SPLIT_DEGREES = 3;
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
const page = await browser.newPage({ viewport: { width: WIDTH, height: HEIGHT }, deviceScaleFactor: 2 });
for (const fatal of ["unhandledRejection", "uncaughtException"] as const) {
  process.on(fatal, (reason: unknown) => {
    void browser.close().catch(() => {}).then(() => {
      console.error(reason instanceof Error ? reason.stack ?? reason.message : String(reason));
      process.exit(1);
    });
  });
}
await page.addInitScript(() => {
  try {
    const key = Object.keys(localStorage).find((k) => k.includes("settings")) ?? "aerolith.settings.v3";
    localStorage.setItem(key, JSON.stringify({
      ...JSON.parse(localStorage.getItem(key) ?? "{}"),
      aircraft: "airliner", flightMode: "scenic", showDiagnostics: false,
      weather: "clear", timeOfDay: "day", airborneStartAgl: 900,
    }));
  } catch { /* first load has no settings yet */ }
});
await page.goto(url, { waitUntil: "domcontentloaded" });
await page.locator('[aria-label="fly high start"]').waitFor({ timeout: 120_000 });
await page.waitForTimeout(2_500);
await page.getByRole("button", { name: /^Start flying/ }).click();
await page.waitForTimeout(30_000);

interface Reading { bank: number; port: number; starboard: number; ground: number }

async function read(): Promise<Reading | null> {
  return page.evaluate(async () => {
    (globalThis as unknown as Record<string, unknown>).__name ??= (fn: unknown) => fn;
    const storeUrl = performance.getEntriesByType("resource")
      .map((r) => r.name).find((n) => /\/deps\/engineStore-[^/]*\.js/.test(n));
    if (!storeUrl) return null;
    const g = globalThis as unknown as { __spoilerTurnStore?: unknown };
    if (!g.__spoilerTurnStore) g.__spoilerTurnStore = await import(/* @vite-ignore */ storeUrl);
    const store = Object.values(g.__spoilerTurnStore as Record<string, unknown>).find(
      (v: unknown) => !!v && Array.isArray((v as { Instances?: unknown }).Instances),
    ) as { Instances: { scenes: unknown[] }[] } | undefined;
    const scene = store?.Instances[0]?.scenes[0] as {
      transformNodes: { name: string; rotation: { z: number } }[];
      meshes: { name: string; getTotalVertices: () => number;
        computeWorldMatrix: (f: boolean) => void; getWorldMatrix: () => { m: number[] } }[];
    } | undefined;
    if (!scene) return null;
    const body = scene.meshes.find((m) => /fuselage/.test(m.name) && m.getTotalVertices() > 0);
    if (!body) return null;
    body.computeWorldMatrix(true);
    const m = body.getWorldMatrix().m;
    // Bank from the aeroplane's own roof vector against world up.
    const roofLen = Math.hypot(m[4]!, m[5]!, m[6]!) || 1;
    const bank = (Math.acos(Math.min(1, Math.max(-1, m[5]! / roofLen))) * 180) / Math.PI
      * (m[6]! >= 0 ? 1 : -1);
    const angle = (pattern: RegExp) => {
      const node = scene.transformNodes.find((n) => pattern.test(n.name));
      return node ? Math.abs(node.rotation.z) * 180 / Math.PI : Number.NaN;
    };
    return {
      bank,
      port: angle(/^port-airliner-flight-spoilers$/),
      starboard: angle(/^starboard-airliner-flight-spoilers$/),
      ground: angle(/^starboard-airliner-ground-spoilers$/),
    };
  });
}

const first = await read();
if (!first || Number.isNaN(first.port) || Number.isNaN(first.starboard)) {
  throw new Error("VOID: could not read the spoiler nodes; nothing captured");
}
console.log(`level reading: bank ${first.bank.toFixed(1)} deg,`
  + ` port ${first.port.toFixed(1)}, starboard ${first.starboard.toFixed(1)}`);

// HOLD THE STICK, and nothing else. The scenic flight holds its wings level —
// measured, four minutes of bank between -1 and 0 degrees — so waiting for a
// turn waits forever. Pressing the game's own roll key is the player's input
// path: the sim rolls the aeroplane, the pose reads the aileron the aeroplane
// is actually using, and the mix does the rest. The alternative, writing
// angles on to the spoiler nodes, would photograph this script rather than the
// aeroplane.
await page.keyboard.down("KeyD");
console.log("holding right roll (KeyD)");

let shot = 0;
const deadline = Date.now() + 240_000;
const seen: string[] = [];
while (Date.now() < deadline && shot < 2) {
  await page.waitForTimeout(2_000);
  const now = await read();
  if (!now) continue;
  const split = Math.abs(now.starboard - now.port);
  seen.push(`bank ${now.bank.toFixed(0)} split ${split.toFixed(1)}`);
  if (Math.abs(now.bank) < WANTED_BANK_DEGREES || split < WANTED_SPLIT_DEGREES) continue;
  const label = `turn-${shot === 0 ? "first" : "second"}`;
  await page.screenshot({ path: `${outDir}/${label}.png`, type: "png" });
  const high = now.starboard > now.port ? "starboard" : "port";
  const lowWing = now.bank > 0 ? "starboard" : "port";
  console.log(`  ${label}: bank ${now.bank.toFixed(1)} deg (${lowWing} wing low),`
    + ` port ${now.port.toFixed(1)} deg, starboard ${now.starboard.toFixed(1)} deg`
    + ` -> ${high} panels up; ground spoilers ${now.ground.toFixed(1)} deg`);
  if (high !== lowWing) {
    throw new Error(`${label}: the ${high} panels rose with the ${lowWing} wing LOW. `
      + "Roll spoilers rise on the DOWN-going wing; this frame shows the mix backwards.");
  }
  shot += 1;
  await page.waitForTimeout(6_000);
}
await page.keyboard.up("KeyD");
await browser.close();
if (shot === 0) {
  console.error(`VOID: never saw ${WANTED_BANK_DEGREES} deg of bank with a `
    + `${WANTED_SPLIT_DEGREES} deg split in four minutes. Seen: ${seen.join(" | ")}`);
  process.exit(1);
}
console.log(`captured ${shot} frame(s) into ${outDir}`);
