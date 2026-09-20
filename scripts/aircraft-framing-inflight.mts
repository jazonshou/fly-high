/**
 * Measure, inside the SHIPPED page at full frame rate, where the aeroplane
 * actually sits in the chase view and how level it looks.
 *
 * The headless rig transcription (scripts/aircraft-framing-probe.mts) says the
 * chase camera centres the aircraft exactly at zero bank. This checks that
 * claim against the running renderer instead of trusting the transcription: it
 * reaches the live Babylon scene through Vite's own optimised-dependency copy
 * of engineStore, reads the real camera and the real aircraft root every
 * frame, and projects the airframe through the real view-projection matrix.
 *
 * Nothing is written to the page or to src/: the sampler is a closure inside a
 * single page.evaluate and disappears with it. It installs no debug hook on
 * the window, so the pre-merge scan for one stays clean.
 *
 *   npm run dev -- --port 3002        # in another shell
 *   npx tsx scripts/aircraft-framing-inflight.mts <outDir> [url] [seconds]
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { chromium } from "playwright";
import { chromiumStdioLaunchOptions } from "./playwrightChromiumLaunch";

const outDir = process.argv[2] ?? "/tmp/aircraft-frames";
const url = process.argv[3] ?? "http://localhost:3002/";
const seconds = Number(process.argv[4] ?? 8);
/** "trainer" | "jet" - written into the persisted settings before load. */
const kindWanted = process.argv[5] ?? "trainer";
/** "level" = hands off; "turn" = roll right, hold, centre, then watch it settle. */
const manoeuvre = process.argv[6] ?? "level";
/** Weather preset, which scales the wind: clear 0.62, breezy 1, cloudy 1.28. */
const weather = process.argv[7] ?? "clear";
/** Label for the output files, so two arms of an A/B do not overwrite. */
const arm = process.argv[8] ?? "arm";
const WIDTH = 1600;
const HEIGHT = 900;

mkdirSync(outDir, { recursive: true });

// HEADED deliberately. Headless Chromium only produces a frame when something
// asks for one (a screenshot), so a free-running sampler sees one frame in
// eight seconds. A headed window runs the real rAF loop, which is the thing
// being measured.
const browser = await chromium.launch({
  ...chromiumStdioLaunchOptions(),
  channel: "chromium",
  headless: false,
  args: [
    "--disable-crashpad-for-testing",
    "--disable-crash-reporter",
    "--enable-unsafe-webgpu",
    "--use-angle=metal",
    "--enable-features=WebGPU",
    `--window-size=${WIDTH},${HEIGHT + 120}`,
  ],
});
const page = await browser.newPage({ viewport: { width: WIDTH, height: HEIGHT } });
await page.addInitScript(({ kind, weather }: { kind: string; weather: string }) => {
  // The picker persists to localStorage; set it before the app reads it so the
  // run starts on the requested airframe without driving the start screen UI.
  try {
    const key = Object.keys(localStorage).find((k) => k.includes("settings")) ?? "aerolith.settings.v3";
    const existing = JSON.parse(localStorage.getItem(key) ?? "{}");
    localStorage.setItem(key, JSON.stringify({ ...existing, aircraft: kind, weather }));
  } catch { /* first load has no settings yet; the default is the trainer */ }
}, { kind: kindWanted, weather });
await page.goto(url, { waitUntil: "domcontentloaded" });
await page.waitForTimeout(4_000);
await page.locator("text=Start").first().click();
await page.waitForTimeout(16_000);
await page.screenshot({ path: `${outDir}/prestate.png`, type: "png" });
console.log("visibility/fps:", await page.evaluate(() => ({
  visibility: document.visibilityState,
  hasFocus: document.hasFocus(),
  hud: document.body.innerText.replace(/\s+/g, " ").slice(0, 120),
})));

// Find the Vite dep chunk that holds Babylon's EngineStore. The hashed name
// changes whenever Vite re-optimises, so discover it from the page's own
// resource list rather than hard-coding it.
const storeUrl = await page.evaluate(() => {
  const entry = performance
    .getEntriesByType("resource")
    .map((r) => r.name)
    .find((n) => /\/deps\/engineStore-[^/]*\.js/.test(n));
  return entry ?? null;
});
if (!storeUrl) throw new Error("could not locate Babylon's engineStore chunk in the page");

console.log("engine diagnostics:", await page.evaluate(async ({ storeUrl }) => {
  const mod = await import(/* @vite-ignore */ storeUrl);
  const store = Object.values(mod).find((v: unknown) => !!v && Array.isArray((v as { Instances?: unknown }).Instances)) as { Instances: Record<string, unknown>[] };
  return store.Instances.map((e) => ({
    name: (e as { name?: string }).name,
    scenes: (e.scenes as unknown[]).length,
    renderLoops: ((e as { _activeRenderLoops?: unknown[] })._activeRenderLoops ?? []).length,
    frameId: (e as { frameId?: number }).frameId,
    fps: typeof (e as { getFps?: () => number }).getFps === "function" ? (e as { getFps: () => number }).getFps() : null,
    meshes: ((e.scenes as { meshes: unknown[] }[])[0]?.meshes ?? []).length,
    canvasSize: [(e as { getRenderWidth: () => number }).getRenderWidth(), (e as { getRenderHeight: () => number }).getRenderHeight()],
  }));
}, { storeUrl }));

async function flyManoeuvre(): Promise<void> {
  if (manoeuvre === "level") return;
  await page.waitForTimeout(1_000);
  // A right turn the way a pilot flies one: roll in, hold the bank, then
  // centre the stick and let it settle. Sampling runs across all of it.
  await page.keyboard.down("d");
  await page.waitForTimeout(1_200);
  await page.keyboard.up("d");
  await page.waitForTimeout(3_500);
  await page.keyboard.down("a");
  await page.waitForTimeout(1_100);
  await page.keyboard.up("a");
}

const sampling = page.evaluate(
  async ({ storeUrl, seconds }) => {
    // tsx/esbuild rewrites named function expressions as `__name(fn, "name")`,
    // but page.evaluate ships the transpiled body WITHOUT esbuild's helper
    // preamble, so the helper has to exist before anything else runs.
    (globalThis as unknown as Record<string, unknown>).__name ??= (fn: unknown) => fn;
    const mod = await import(/* @vite-ignore */ storeUrl);
    // EngineStore is exported as a CLASS from the minified dep chunk, so the
    // holder of `Instances` is a function, not a plain object.
    const store = Object.values(mod).find(
      (v: unknown): v is { Instances: { scenes: unknown[] }[] } =>
        !!v && Array.isArray((v as { Instances?: unknown }).Instances),
    );
    if (!store) throw new Error(`engineStore chunk had no Instances: ${storeUrl}`);
    if (store.Instances.length === 0) throw new Error("no Babylon engine running yet");
    const scene = store.Instances[0]!.scenes[0] as {
      transformNodes: { name: string; metadata?: { aircraftVisual?: boolean; aircraftKind?: string }; position: { x: number; y: number; z: number }; rotationQuaternion: unknown }[];
      activeCamera: { name: string; position: { x: number; y: number; z: number }; upVector: { x: number; y: number; z: number }; fov: number; getViewMatrix: () => { multiply: (o: unknown) => { m: number[] } }; getProjectionMatrix: () => unknown };
      getEngine: () => { getRenderWidth: () => number; getRenderHeight: () => number };
    };
    const root = scene.transformNodes.find((n) => n.metadata?.aircraftVisual);
    if (!root) throw new Error("no aircraft visual in the scene");
    const kind = root.metadata?.aircraftKind ?? "unknown";

    const samples: Record<string, number>[] = [];
    // Polled, not hooked to scene.onAfterRenderObservable: FlightRenderer
    // drives its own frame pipeline (engine._activeRenderLoops is empty while
    // frameId advances), so the scene's render observables never fire. Each
    // poll reads whatever the last presented frame left on the camera.
    const sample = () => {
      const cam = scene.activeCamera;
      const engine = scene.getEngine();
      const vp = cam.getViewMatrix().multiply(cam.getProjectionMatrix());
      // Rotate a body axis into world by the root quaternion directly:
      // v' = v + 2w(u x v) + 2(u x (u x v)). Done by hand rather than through
      // Babylon's Matrix so this sampler never touches engine internals - an
      // observer that throws kills the render loop.
      const q = root.rotationQuaternion as unknown as { x: number; y: number; z: number; w: number };
      const axis = (v: [number, number, number]) => {
        const c1 = [q.y * v[2] - q.z * v[1], q.z * v[0] - q.x * v[2], q.x * v[1] - q.y * v[0]];
        const c2 = [q.y * c1[2]! - q.z * c1[1]!, q.z * c1[0]! - q.x * c1[2]!, q.x * c1[1]! - q.y * c1[0]!];
        return {
          x: v[0] + 2 * q.w * c1[0]! + 2 * c2[0]!,
          y: v[1] + 2 * q.w * c1[1]! + 2 * c2[1]!,
          z: v[2] + 2 * q.w * c1[2]! + 2 * c2[2]!,
        };
      };
      const fwd = axis([1, 0, 0]);
      const up = axis([0, 1, 0]);
      const stb = axis([0, 0, 1]);            // D-6: starboard is body +Z
      const w = vp.m;
      const project = (p: { x: number; y: number; z: number }) => {
        const cw = w[3]! * p.x + w[7]! * p.y + w[11]! * p.z + w[15]!;
        return {
          x: (w[0]! * p.x + w[4]! * p.y + w[8]! * p.z + w[12]!) / cw,
          y: (w[1]! * p.x + w[5]! * p.y + w[9]! * p.z + w[13]!) / cw,
        };
      };
      const P = root.position;
      const origin = project(P);
      const half = 5.4;
      const tipR = project({ x: P.x + stb.x * half, y: P.y + stb.y * half, z: P.z + stb.z * half });
      const tipL = project({ x: P.x - stb.x * half, y: P.y - stb.y * half, z: P.z - stb.z * half });
      const aspect = engine.getRenderWidth() / engine.getRenderHeight();
      const dx = tipR.x - tipL.x;
      const dy = (tipR.y - tipL.y) / aspect;
      // Positive = starboard wingtip lower on screen = looks tilted right.
      const apparentRoll = (-Math.atan2(dy, Math.abs(dx)) * Math.sign(dx || 1) * 180) / Math.PI;
      // True bank: body up measured against the horizontal right of the track.
      const hr = { x: fwd.z, z: -fwd.x };
      const hl = Math.hypot(hr.x, hr.z) || 1;
      const bank = (Math.atan2((up.x * hr.x + up.z * hr.z) / hl, up.y) * 180) / Math.PI;
      const cp = cam.position;
      // The rig's own yaw error: the horizontal angle between the aircraft's
      // NOSE and the direction the camera actually sits from it. Zero means
      // the camera is directly behind the nose, which is what the rig asks
      // for. A camera that lags along the GROUND TRACK instead sits off the
      // nose by the crab angle whenever there is a crosswind - the mechanism
      // that puts a wings-level aeroplane off centre in a steady wind.
      const backX = P.x - cp.x;
      const backZ = P.z - cp.z;
      const backLen = Math.hypot(backX, backZ) || 1;
      const fwdLen = Math.hypot(fwd.x, fwd.z) || 1;
      const cross = (fwd.x / fwdLen) * (backZ / backLen) - (fwd.z / fwdLen) * (backX / backLen);
      const dot = (fwd.x / fwdLen) * (backX / backLen) + (fwd.z / fwdLen) * (backZ / backLen);
      const rigYawDeg = (Math.atan2(cross, dot) * 180) / Math.PI;
      samples.push({
        rigYawDeg,
        distance: Math.hypot(P.x - cp.x, P.y - cp.y, P.z - cp.z),
        bank,
        ndcX: origin.x,
        ndcY: origin.y,
        apparentRoll,
        camUpX: cam.upVector.x,
        camUpZ: cam.upVector.z,
        fovDeg: (cam.fov * 180) / Math.PI,
      });
    };
    const timer = setInterval(sample, 16);
    const engineBefore = (scene.getEngine() as unknown as { frameId: number }).frameId;
    await new Promise((resolve) => setTimeout(resolve, seconds * 1000));
    clearInterval(timer);
    const engineAfter = (scene.getEngine() as unknown as { frameId: number }).frameId;
    return { kind, samples, enginePresents: engineAfter - engineBefore };
  },
  { storeUrl, seconds },
);
await flyManoeuvre();
const result = await sampling;

const s = result.samples;
if (s.length === 0) {
  throw new Error(`no frames sampled; the engine presented ${(result as { enginePresents?: number }).enginePresents} frames in that window`);
}
const col = (k: string) => s.map((x) => x[k]!);
const mean = (k: string) => col(k).reduce((a, b) => a + b, 0) / s.length;
const min = (k: string) => Math.min(...col(k));
const max = (k: string) => Math.max(...col(k));
const stat = (k: string, unit = "") =>
  `${k.padEnd(13)} mean ${mean(k).toFixed(4).padStart(10)}   min ${min(k).toFixed(4).padStart(10)}   max ${max(k).toFixed(4).padStart(10)} ${unit}`;

console.log(`aircraft: ${result.kind}; manoeuvre: ${manoeuvre}; weather: ${weather}; arm: ${arm};  ${s.length} frames over ${seconds}s (${(s.length / seconds).toFixed(1)} fps)`);
console.log(stat("distance", "m   <- chase profile asks for 13.5 m"));
console.log(stat("bank", "deg"));
console.log(stat("apparentRoll", "deg"));
console.log(stat("ndcX", "   <- 0 = centred; -1 left edge, +1 right edge"));
console.log(stat("ndcY", ""));
console.log(stat("rigYawDeg", "deg  <- camera's bearing off the nose; 0 = directly astern"));
console.log(stat("fovDeg", "deg"));
console.log(
  `\nHORIZONTAL OFFSET: ${(mean("ndcX") / 2 * 100).toFixed(2)}% of frame width ` +
  `(${mean("ndcX") < 0 ? "LEFT" : "RIGHT"} of centre)`,
);
console.log(`VERTICAL OFFSET:   ${(mean("ndcY") / 2 * 100).toFixed(2)}% of frame height (positive = above centre)`);

writeFileSync(`${outDir}/framing-${result.kind}-${manoeuvre}-${arm}.json`, JSON.stringify(result, null, 1));
await page.screenshot({ path: `${outDir}/framing-${result.kind}-${manoeuvre}-${arm}.png`, type: "png" });
console.log(`\nwrote ${outDir}/framing-${result.kind}-${manoeuvre}-${arm}.json and .png`);

// The coupling the report describes: at each sampled bank angle, how far off
// centre and how rolled does the airframe look?
const buckets = new Map<number, { n: number; ndcX: number; roll: number }>();
for (const x of s) {
  const b = Math.round(x.bank! / 2) * 2;
  const acc = buckets.get(b) ?? { n: 0, ndcX: 0, roll: 0 };
  acc.n += 1; acc.ndcX += x.ndcX!; acc.roll += x.apparentRoll!;
  buckets.set(b, acc);
}
console.log("\n  bank(deg)  frames   mean ndcX   shift(% width)   apparent roll(deg)   roll/bank");
for (const b of [...buckets.keys()].sort((a, c) => a - c)) {
  const acc = buckets.get(b)!;
  const nx = acc.ndcX / acc.n;
  const rl = acc.roll / acc.n;
  console.log(
    `  ${String(b).padStart(7)}   ${String(acc.n).padStart(5)}   ${nx.toFixed(4).padStart(9)}   ${((nx / 2) * 100).toFixed(2).padStart(9)}        ${rl.toFixed(3).padStart(9)}        ${b === 0 ? "   -" : (rl / b).toFixed(3).padStart(6)}`,
  );
}
await browser.close();
