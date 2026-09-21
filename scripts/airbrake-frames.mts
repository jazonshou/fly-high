/**
 * The F-16's airbrakes from the angles Jason's complaint was about.
 *
 * "The speed brakes at the back of the F-16 also feel out of place with
 * respect to the plane" is a statement about what the chase camera shows, so
 * the frames are of the shipped page: the game's own chase view, plus a view
 * from DIRECTLY ASTERN and a rear three-quarter, both parked in the
 * aeroplane's own frame rather than on world axes — it is flying a heading, so
 * world -X is not "behind it".
 *
 * THE DEFLECTION IS MEASURED, NOT CAPTIONED. The angle reported for each frame
 * is the rotation of the hinge NODE between its rest pose and this frame, read
 * off its world matrix as acos((trace-1)/2) — the same quantity
 * `render.swept-flap-hinge` measures, and independent of how the panel happens
 * to be modelled. A frame whose measurement disagrees with its caption by more
 * than a degree fails the run.
 *
 *   npx tsx scripts/airbrake-frames.mts <outDir> <url> <expectTree>
 */
import { mkdirSync } from "node:fs";
import { chromium } from "playwright";
import { chromiumStdioLaunchOptions } from "./playwrightChromiumLaunch";

const [outDir, url, expectTree] = process.argv.slice(2);
if (!outDir || !url || !expectTree) throw new Error("usage: <outDir> <url> <expectTree>");
const WIDTH = 1600;
const HEIGHT = 900;
/** Full airbrake travel on this airframe, from `animation.ts`: 0.68 rad. */
const FULL_DEGREES = (0.68 * 180) / Math.PI;
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
      aircraft: "jet", flightMode: "scenic", showDiagnostics: false,
      weather: "clear", timeOfDay: "day", airborneStartAgl: 900,
    }));
  } catch { /* first load has no settings yet */ }
});
await page.goto(url, { waitUntil: "domcontentloaded" });
await page.locator('[aria-label="fly high start"]').waitFor({ timeout: 120_000 });
await page.waitForTimeout(2_500);
await page.getByRole("button", { name: /^Start flying/ }).click();
await page.waitForTimeout(30_000);

type View = "chase" | "astern" | "quarter";

/**
 * Hold the brake at an angle and park the camera, both reinstated per frame
 * because the game rewrites the pose and the camera every tick.
 */
async function stage(radians: number, view: View, distance: number): Promise<number> {
  return page.evaluate(async (
    { angle, wanted, range }: { angle: number; wanted: View; range: number },
  ) => {
    (globalThis as unknown as Record<string, unknown>).__name ??= (fn: unknown) => fn;
    const storeUrl = performance.getEntriesByType("resource")
      .map((r) => r.name).find((n) => /\/deps\/engineStore-[^/]*\.js/.test(n));
    if (!storeUrl) return -1;
    const g = globalThis as unknown as {
      __brakeStore?: unknown;
      __brakeHold?: { angle: number; view: View; range: number };
    };
    if (!g.__brakeStore) g.__brakeStore = await import(/* @vite-ignore */ storeUrl);
    const store = Object.values(g.__brakeStore as Record<string, unknown>).find(
      (v: unknown) => !!v && Array.isArray((v as { Instances?: unknown }).Instances),
    ) as { Instances: { scenes: unknown[] }[] } | undefined;
    const scene = store?.Instances[0]?.scenes[0] as {
      transformNodes: { name: string; rotation: { z: number } }[];
      meshes: { name: string; getTotalVertices: () => number; computeWorldMatrix: (f: boolean) => void;
        getWorldMatrix: () => { m: number[] };
        getBoundingInfo: () => { boundingBox: { centerWorld: { x: number; y: number; z: number } } } }[];
      activeCamera: unknown;
      onBeforeRenderObservable: { add: (fn: () => void) => unknown };
    } | undefined;
    if (!scene) return -1;
    const nodes = scene.transformNodes.filter((n) => /speed-brake$/.test(n.name));
    if (nodes.length === 0) return -1;
    const body = scene.meshes.find((m) => /jet-fuselage$/.test(m.name) && m.getTotalVertices() > 0);
    if (!body) return -1;
    if (!g.__brakeHold) {
      g.__brakeHold = { angle, view: wanted, range };
      scene.onBeforeRenderObservable.add(() => {
        const held = g.__brakeHold!;
        // THE LOWER PAIR OPENS THE OTHER WAY. `update` drives them as
        // `sense * pose.speedBrake`, and the name filter here catches all four
        // because "lower-speed-brake" also ends in "speed-brake" — so holding
        // them all to one angle swings the lower petals UP, and the frames
        // would show an arrangement the game never renders.
        for (const n of nodes) {
          n.rotation.z = /lower-speed-brake$/.test(n.name) ? -held.angle : held.angle;
        }
        if (held.view === "chase") return;
        body.computeWorldMatrix(true);
        const c = body.getBoundingInfo().boundingBox.centerWorld;
        const m = body.getWorldMatrix().m;
        const unit = (a: number, b: number, c2: number) => {
          const len = Math.hypot(m[a]!, m[b]!, m[c2]!) || 1;
          return [m[a]! / len, m[b]! / len, m[c2]! / len] as const;
        };
        const nose = unit(0, 1, 2);
        const roof = unit(4, 5, 6);
        const wing = unit(8, 9, 10);
        // Astern: straight behind, on the aeroplane's own level. Quarter: behind,
        // out to starboard and a little above.
        const back = held.view === "astern"
          ? [-nose[0], -nose[1], -nose[2]] as const
          : [
            -nose[0] * 0.78 + wing[0] * 0.55 + roof[0] * 0.3,
            -nose[1] * 0.78 + wing[1] * 0.55 + roof[1] * 0.3,
            -nose[2] * 0.78 + wing[2] * 0.55 + roof[2] * 0.3,
          ] as const;
        const cam = scene.activeCamera as unknown as {
          position: { set: (x: number, y: number, z: number) => void;
            constructor: new (x: number, y: number, z: number) => unknown };
          upVector: { set: (x: number, y: number, z: number) => void };
          setTarget: (v: unknown) => void;
        } | null;
        if (!cam) return;
        const len = Math.hypot(back[0]!, back[1]!, back[2]!) || 1;
        cam.position.set(
          c.x + (back[0]! / len) * held.range,
          c.y + (back[1]! / len) * held.range,
          c.z + (back[2]! / len) * held.range,
        );
        cam.upVector.set(roof[0]!, roof[1]!, roof[2]!);
        const Point = cam.position.constructor as new (x: number, y: number, z: number) => unknown;
        cam.setTarget(new Point(c.x, c.y, c.z));
      });
    } else {
      g.__brakeHold.angle = angle;
      g.__brakeHold.view = wanted;
      g.__brakeHold.range = range;
    }
    return nodes.length;
  }, { angle: radians, wanted: view, range: distance });
}

/** The hinge node's rotation since rest, off its world matrix. */
let restRotations: number[][] | null = null;
async function measureDegrees(): Promise<number | null> {
  const now = await page.evaluate(() => {
    (globalThis as unknown as Record<string, unknown>).__name ??= (fn: unknown) => fn;
    const g = globalThis as unknown as { __brakeStore?: unknown };
    const store = Object.values((g.__brakeStore ?? {}) as Record<string, unknown>).find(
      (v: unknown) => !!v && Array.isArray((v as { Instances?: unknown }).Instances),
    ) as { Instances: { scenes: unknown[] }[] } | undefined;
    const scene = store?.Instances[0]?.scenes[0] as {
      transformNodes: { name: string; computeWorldMatrix: (f: boolean) => { m: number[] } }[];
    } | undefined;
    if (!scene) return null;
    return scene.transformNodes
      .filter((n) => /speed-brake$/.test(n.name))
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((n) => [...n.computeWorldMatrix(true).m]);
  });
  if (!now || now.length === 0) return null;
  if (!restRotations) { restRotations = now; return 0; }
  let worst = 0;
  for (let i = 0; i < now.length && i < restRotations.length; i += 1) {
    const a = restRotations[i]!; const b = now[i]!;
    // R = A^T B for the rotation part; the angle is acos((trace - 1) / 2).
    let trace = 0;
    for (let r = 0; r < 3; r += 1) {
      for (let k = 0; k < 3; k += 1) {
        if (r !== k) continue;
        let sum = 0;
        for (let j = 0; j < 3; j += 1) sum += a[j * 4 + r]! * b[j * 4 + k]!;
        trace += sum;
      }
    }
    worst = Math.max(worst, (Math.acos(Math.min(1, Math.max(-1, (trace - 1) / 2))) * 180) / Math.PI);
  }
  return worst;
}

async function shoot(label: string, captionDegrees: number): Promise<void> {
  const measured = await measureDegrees();
  if (measured === null) throw new Error(`${label}: VOID, no hinge nodes to measure`);
  if (Math.abs(measured - captionDegrees) > 1) {
    throw new Error(`${label}: caption says ${captionDegrees.toFixed(1)} deg but the hinges are at `
      + `${measured.toFixed(2)} deg; the frame does not show what it claims.`);
  }
  await page.screenshot({ path: `${outDir}/${label}.png`, type: "png" });
  console.log(`  ${label}: hinges at ${measured.toFixed(2)} deg`);
}

const held = await stage(0, "chase", 0);
if (held <= 0) throw new Error("VOID: no speed-brake nodes in the live scene; nothing captured");
console.log(`holding ${held} petals (upper and lower, opposite senses)`);
await page.waitForTimeout(1_500);
await measureDegrees();

for (const [name, fraction] of [["closed", 0], ["half", 0.5], ["full", 1]] as const) {
  const radians = -0.68 * fraction;
  const degrees = FULL_DEGREES * fraction;
  await stage(radians, "chase", 0);
  await page.waitForTimeout(1_500);
  await shoot(`chase-${name}`, degrees);
}
for (const [name, fraction] of [["closed", 0], ["full", 1]] as const) {
  const radians = -0.68 * fraction;
  const degrees = FULL_DEGREES * fraction;
  await stage(radians, "quarter", 9);
  await page.waitForTimeout(1_500);
  await shoot(`quarter-${name}`, degrees);
  await stage(radians, "astern", 11);
  await page.waitForTimeout(1_500);
  await shoot(`astern-${name}`, degrees);
}
await browser.close();
console.log(`captured into ${outDir}`);
