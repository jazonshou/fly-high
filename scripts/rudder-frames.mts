/**
 * Both box-rudder airframes' rudders, neutral and hard over each way.
 *
 * A rudder's whole job is visible from behind, so these are the game's own
 * chase view plus a rear three-quarter, and the panel is the thing the eye
 * follows in a turn.
 *
 * THE DEFLECTION IS MEASURED, NOT CAPTIONED: the rotation of the hinge node
 * between its rest pose and this frame, off its world matrix as
 * acos((trace-1)/2) — the same quantity `render.swept-flap-hinge` measures and
 * independent of how the panel is modelled. A frame disagreeing with its
 * caption by more than a degree fails the run.
 *
 *   npx tsx scripts/rudder-frames.mts <outDir> <url> <expectTree> <kind>
 */
import { mkdirSync } from "node:fs";
import { chromium } from "playwright";
import { chromiumStdioLaunchOptions } from "./playwrightChromiumLaunch";

const [outDir, url, expectTree, kind] = process.argv.slice(2);
if (!outDir || !url || !expectTree || !kind) {
  throw new Error("usage: <outDir> <url> <expectTree> <kind>");
}
/** `SURFACE_TRAVEL` in `animation.ts`; a caption is checked against these. */
const TRAVEL: Record<string, number> = { trainer: 0.32, jet: 0.28, bizjet: 0.24, airliner: 0.22 };
const travel = TRAVEL[kind];
if (travel === undefined) throw new RangeError(`no rudder travel recorded for "${kind}"`);
// Narrowed into a const: the guard above proves it, but the narrowing does not
// survive into the page closures below.
const airframe: string = kind;
const WIDTH = 1600;
const HEIGHT = 900;
const FULL_DEGREES = (travel * 180) / Math.PI;
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
await page.addInitScript((wantedKind: string) => {
  try {
    const key = Object.keys(localStorage).find((k) => k.includes("settings")) ?? "aerolith.settings.v3";
    localStorage.setItem(key, JSON.stringify({
      ...JSON.parse(localStorage.getItem(key) ?? "{}"),
      aircraft: wantedKind, flightMode: "scenic", showDiagnostics: false,
      weather: "clear", timeOfDay: "day", airborneStartAgl: 900,
    }));
  } catch { /* first load has no settings yet */ }
}, airframe);
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
    { angle, wanted, range, airframe }:
      { angle: number; wanted: View; range: number; airframe: string },
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
      transformNodes: { name: string; rotation: { y: number } }[];
      meshes: { name: string; getTotalVertices: () => number; computeWorldMatrix: (f: boolean) => void;
        getWorldMatrix: () => { m: number[] };
        getBoundingInfo: () => { boundingBox: { centerWorld: { x: number; y: number; z: number } } } }[];
      activeCamera: unknown;
      onBeforeRenderObservable: { add: (fn: () => void) => unknown };
    } | undefined;
    if (!scene) return -1;
    const nodes = scene.transformNodes.filter((n) => /^rudder$/.test(n.name));
    if (nodes.length === 0) return -1;
    const body = scene.meshes.find((m) => new RegExp(`${airframe}-fuselage|fuselage`).test(m.name) && m.getTotalVertices() > 0);
    if (!body) return -1;
    if (!g.__brakeHold) {
      g.__brakeHold = { angle, view: wanted, range };
      scene.onBeforeRenderObservable.add(() => {
        const held = g.__brakeHold!;
        // `^rudder$` and not /rudder/, because `rudder-mount` and
        // `rudder-frame` are nodes too and writing a yaw on the MOUNT would
        // turn the hinge axis itself rather than the panel about it.
        for (const n of nodes) n.rotation.y = held.angle;
        if (held.view === "chase") return;
        body.computeWorldMatrix(true);
        // AIM AT THE RUDDER, not at the fuselage's centre. On a 70 m aeroplane
        // those are 30 m apart, and a camera parked "behind the centroid" ends
        // up beside the nose with the tail out of frame.
        const subject = scene.meshes.find((mesh) => mesh.name === "rudder-surface") ?? body;
        subject.computeWorldMatrix(true);
        const c = subject.getBoundingInfo().boundingBox.centerWorld;
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
  }, { angle: radians, wanted: view, range: distance, airframe });
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
      .filter((n) => /^rudder$/.test(n.name))
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
if (held <= 0) throw new Error("VOID: no rudder node in the live scene; nothing captured");
console.log(`holding ${held} rudder node(s)`);
await page.waitForTimeout(1_500);
await measureDegrees();

for (const [name, fraction] of [["neutral", 0], ["right", 1], ["left", -1]] as const) {
  const radians = travel * fraction;
  const degrees = Math.abs(FULL_DEGREES * fraction);
  for (const [view, range] of [["chase", 0], ["quarter", airframe === "airliner" ? 46 : 12]] as const) {
    await stage(radians, view, range);
    await page.waitForTimeout(1_500);
    await shoot(`${view}-${name}`, degrees);
  }
}
await browser.close();
console.log(`captured into ${outDir}`);
