/**
 * Photograph the cockpit's MOVING instruments in the shipped page, in flight
 * states the player can actually be in, and refuse to save a frame that is not
 * what it claims.
 *
 * The Cessna is photographed in level cruise, a climbing right turn and a descent
 * at idle; the Global in level flight, a 20 degree right bank and a 20 degree left
 * bank. The level frames are the Scenic-assist start left to settle; the others
 * are flown by holding the real keys (Direct controls) under a closed loop that
 * reads the HUD's own pitch and bank, releases the key when the attitude is where
 * it is wanted and takes the frame while it holds.
 *
 * Every capture asserts, from the LIVE page rather than from the request:
 *
 *   - the HUD names the view COCKPIT, the scene's aircraft is the kind asked for
 *     (read from the root node's own metadata), the camera is at the catalogue's
 *     `cockpitEye` with the shipped lens (as `scripts/cockpit-frames.mts` does);
 *   - the flight state is the one the frame is FOR (a band on the HUD's pitch, bank
 *     and vertical speed: a "climbing right turn" that is not climbing throws);
 *   - the INSTRUMENTS agree with the HUD's numbers for the same moment. The needles'
 *     and the ball's poses are read from the live scene, in the aircraft's body
 *     frame, and turned back into readings with the inverse of the mapping, and each
 *     must match the HUD within a tolerance that allows for the HUD's 75 ms
 *     refresh: airspeed +-3 kt, vertical speed +-200 ft/min, RPM +-60, bank +-3
 *     degrees, pitch +-2 degrees. A needle running the wrong way, or a dial on the
 *     wrong field, cannot pass. The altimeter has no HUD number (the HUD shows
 *     height above the ground); it is checked to be finite, and held to
 *     `tests/render.cockpit-instruments.test.ts` for the rest.
 *
 *   npx tsx scripts/cockpit-instrument-frames.mts <outDir> <url> <expectTree> <trainer|bizjet> [scenario,...]
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { chromium } from "playwright";
import { aircraftSpec } from "@/src/aircraft/catalogue";
import { COCKPIT_HORIZONTAL_FOV_DEGREES } from "@/src/render/cameraPresentation";
import type { AircraftKind } from "@/src/sim";
import { chromiumStdioLaunchOptions } from "./playwrightChromiumLaunch";

const [outDir, url, expectTree, kindArgument, scenariosArgument] = process.argv.slice(2);
if (!outDir || !url || !expectTree || (kindArgument !== "trainer" && kindArgument !== "bizjet")) {
  throw new Error("usage: <outDir> <url> <expectTree> <trainer|bizjet> [scenario,...]");
}
const KIND: AircraftKind = kindArgument;
const WIDTH = Number(process.env.FRAME_WIDTH ?? 1600);
const HEIGHT = Number(process.env.FRAME_HEIGHT ?? 900);
const TRACE = process.env.TRACE === "1";
mkdirSync(outDir, { recursive: true });

interface Band { readonly min: number; readonly max: number }
interface Scenario {
  readonly name: string;
  readonly mode: "scenic" | "unassisted";
  /** What to steer toward, degrees; absent means leave it. */
  readonly target: { readonly pitch?: number; readonly bank?: number };
  readonly throttle?: "idle";
  /** The bands the HUD's own numbers must be inside for the frame to be for this state. */
  readonly require: { pitch?: Band; bank?: Band; verticalSpeedFpm?: Band; rpm?: Band };
}
const SCENARIOS: Readonly<Record<AircraftKind, readonly Scenario[]>> = {
  trainer: [
    { name: "level-cruise", mode: "scenic", target: {}, require: { pitch: { min: -4, max: 4 }, bank: { min: -3, max: 3 }, verticalSpeedFpm: { min: -350, max: 350 } } },
    { name: "climbing-right-turn", mode: "unassisted", target: { pitch: 6, bank: 20 }, require: { pitch: { min: 2, max: 14 }, bank: { min: 12, max: 30 }, verticalSpeedFpm: { min: 150, max: 3000 } } },
    { name: "descent-at-idle", mode: "unassisted", target: { pitch: -5, bank: 0 }, throttle: "idle", require: { pitch: { min: -14, max: -1.5 }, bank: { min: -12, max: 12 }, verticalSpeedFpm: { min: -3000, max: -250 } } },
  ],
  bizjet: [
    { name: "level", mode: "scenic", target: {}, require: { pitch: { min: -4, max: 5 }, bank: { min: -3, max: 3 } } },
    { name: "bank-right-20", mode: "unassisted", target: { bank: 20 }, require: { bank: { min: 14, max: 28 } } },
    { name: "bank-left-20", mode: "unassisted", target: { bank: -20 }, require: { bank: { min: -28, max: -14 } } },
  ],
  jet: [],
  airliner: [],
};
const WANTED = new Set((scenariosArgument ?? "").split(",").filter(Boolean));
const RUN = SCENARIOS[KIND].filter((s) => WANTED.size === 0 || WANTED.has(s.name));
if (RUN.length === 0) throw new Error(`no scenario selected for ${KIND}`);

const identity = await fetch(new URL(`/@fs${expectTree}/package.json`, url).toString());
if (!identity.ok) throw new Error(`${url} is NOT serving ${expectTree} (${identity.status}); nothing captured.`);
console.log(`serving: ${expectTree} (verified via /@fs)`);

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
for (const fatal of ["unhandledRejection", "uncaughtException"] as const) {
  process.on(fatal, (reason: unknown) => {
    void browser.close().catch(() => {}).then(() => {
      console.error(reason instanceof Error ? reason.stack ?? reason.message : String(reason));
      process.exit(1);
    });
  });
}

interface HudReading {
  readonly view: string;
  readonly pitch: number;
  readonly bank: number;
  readonly knots: number;
  readonly aglFeet: number;
  readonly verticalSpeedFpm: number;
  readonly engine: number;
  readonly engineLabel: string;
}
interface SceneReading {
  readonly aircraftKind: string | null;
  readonly cameraFovDegrees: number;
  readonly cameraFovMode: number;
  readonly eyeInBodyFrame: readonly [number, number, number];
  /** Trainer: the needle pose of each dial as degrees clockwise from 12 o'clock as the pilot sees it, in the dial's own plane. */
  readonly needleDegrees: Readonly<Record<string, number>> | null;
  /** Global: the ball's pivot rotation about X (degrees, positive clockwise as seen) and the pitch bar's local y (metres, positive up). */
  readonly ball: { readonly pivotDegrees: number; readonly barMetres: number } | null;
  readonly cockpitOnlyVisible: number;
  readonly cockpitOnlyTotal: number;
}

async function readHud(page: import("playwright").Page): Promise<HudReading> {
  return page.evaluate(() => {
    // tsx compiles named arrow functions with a `__name` helper the page does not have
    (globalThis as unknown as Record<string, unknown>).__name ??= (fn: unknown) => fn;
    const text = document.body.innerText.replace(/\s+/g, " ");
    const attitude = document.querySelector(".attitude")?.getAttribute("aria-label") ?? "";
    const ias = document.querySelector(".metric-tape--left")?.getAttribute("aria-label") ?? "";
    const agl = document.querySelector(".metric-tape--right")?.getAttribute("aria-label") ?? "";
    const readout = (label: string): string => {
      for (const block of Array.from(document.querySelectorAll(".instrument-readout"))) {
        if (block.querySelector("small")?.textContent?.trim() === label) return block.querySelector("strong")?.textContent ?? "";
      }
      return "";
    };
    const engineBlock = Array.from(document.querySelectorAll(".instrument-readout")).find((b) => /^(RPM|N1|N2)$/.test(b.querySelector("small")?.textContent?.trim() ?? ""));
    return {
      view: /\b(CHASE CAM|COCKPIT|ORBIT CAM|FREE CAM)\b/.exec(text)?.[1] ?? "unknown",
      pitch: Number(/Pitch (-?\d+)/.exec(attitude)?.[1]),
      bank: Number(/bank (-?\d+)/.exec(attitude)?.[1]),
      knots: Number(/IAS: (-?\d+)/.exec(ias)?.[1]),
      aglFeet: Number(/AGL: (-?[\d,]+)/.exec(agl)?.[1]?.replace(/,/g, "")),
      verticalSpeedFpm: Number(readout("V/S").replace("+", "")),
      engine: Number(engineBlock?.querySelector("strong")?.textContent),
      engineLabel: engineBlock?.querySelector("small")?.textContent?.trim() ?? "",
    };
  });
}

async function readScene(page: import("playwright").Page): Promise<SceneReading> {
  return page.evaluate(async () => {
    (globalThis as unknown as Record<string, unknown>).__name ??= (fn: unknown) => fn;
    const storeUrl = performance.getEntriesByType("resource").map((r) => r.name).find((n) => /\/deps\/engineStore-[^/]*\.js/.test(n));
    if (!storeUrl) throw new Error("no engineStore chunk in the page");
    const store = await import(/* @vite-ignore */ storeUrl) as Record<string, unknown>;
    const holder = Object.values(store).find((v: unknown) => !!v && Array.isArray((v as { Instances?: unknown }).Instances)) as { Instances: { scenes: unknown[] }[] } | undefined;
    if (!holder) throw new Error("engineStore has no Instances");
    interface Vec { x: number; y: number; z: number }
    interface Matrixish { m: ArrayLike<number> }
    interface NodeLike { name: string; position: Vec; rotation?: Vec; rotationQuaternion: { x: number; y: number; z: number; w: number } | null; metadata: { aircraftVisual?: boolean; aircraftKind?: string; cockpitOnly?: boolean } | null; isVisible?: boolean; computeWorldMatrix(force: boolean): Matrixish; getWorldMatrix(): Matrixish }
    interface SceneLike { activeCamera: { position: Vec; fov: number; fovMode: number } | null; transformNodes: NodeLike[]; meshes: NodeLike[] }
    const scenes = holder.Instances.flatMap((engine) => engine.scenes as SceneLike[]);
    const scene = scenes.find((s) => s.transformNodes.some((n) => n.metadata?.aircraftVisual));
    if (!scene) throw new Error("no scene holds an aircraft root");
    const root = scene.transformNodes.find((n) => n.metadata?.aircraftVisual)!;
    const camera = scene.activeCamera;
    if (!camera) throw new Error("scene has no active camera");
    const q = root.rotationQuaternion ?? { x: 0, y: 0, z: 0, w: 1 };
    const v = { x: camera.position.x - root.position.x, y: camera.position.y - root.position.y, z: camera.position.z - root.position.z };
    const c = { x: -q.x, y: -q.y, z: -q.z, w: q.w };
    const tx = 2 * (c.y * v.z - c.z * v.y);
    const ty = 2 * (c.z * v.x - c.x * v.z);
    const tz = 2 * (c.x * v.y - c.y * v.x);
    const body = {
      x: v.x + c.w * tx + (c.y * tz - c.z * ty),
      y: v.y + c.w * ty + (c.z * tx - c.x * tz),
      z: v.z + c.w * tz + (c.x * ty - c.y * tx),
    };
    const rows = (mesh: NodeLike) => { const m = mesh.computeWorldMatrix(true).m; return [[m[0]!, m[1]!, m[2]!], [m[4]!, m[5]!, m[6]!], [m[8]!, m[9]!, m[10]!]] as const; };
    const dot = (a: readonly number[], b: readonly number[]) => a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]!;
    root.computeWorldMatrix(true);
    const rootRows = rows(root);
    /** A world direction as body coordinates: the components along the root's three axes. */
    const inBody = (d: readonly number[]) => [dot(d, rootRows[0]), dot(d, rootRows[1]), dot(d, rootRows[2])] as const;
    const kind = root.metadata?.aircraftKind ?? null;
    let needleDegrees: Record<string, number> | null = null;
    let ball: { pivotDegrees: number; barMetres: number } | null = null;
    if (kind === "trainer") {
      const panel = scene.meshes.find((m) => m.name === "trainer-instrument-panel")!;
      const panelRows = rows(panel);
      const up = inBody(panelRows[1]);
      // The pilot's right is panel local X x local Y = local Z (the pilot looks along -X, the face's normal reversed).
      const right = inBody(panelRows[2]);
      needleDegrees = {};
      for (const dial of ["airspeed", "attitude", "altimeter", "vertical-speed", "engine"]) {
        const needle = scene.meshes.find((m) => m.name === `trainer-${dial}-needle`)!;
        const pointer = inBody(rows(needle)[1]);
        needleDegrees[dial] = (Math.atan2(dot(pointer, right), dot(pointer, up)) * 180) / Math.PI;
      }
    } else if (kind === "bizjet") {
      const pivot = scene.transformNodes.find((n) => n.name === "bizjet-pfd-attitude-pivot")!;
      const bar = scene.meshes.find((m) => m.name === "bizjet-pfd-pitch-bar")!;
      ball = { pivotDegrees: ((pivot.rotation?.x ?? 0) * 180) / Math.PI, barMetres: bar.position.y };
    }
    const cockpitOnly = scene.meshes.filter((m) => m.metadata?.cockpitOnly === true);
    return {
      aircraftKind: kind,
      cameraFovDegrees: (camera.fov * 180) / Math.PI,
      cameraFovMode: camera.fovMode,
      eyeInBodyFrame: [body.x, body.y, body.z] as const,
      needleDegrees,
      ball,
      cockpitOnlyVisible: cockpitOnly.filter((m) => m.isVisible).length,
      cockpitOnlyTotal: cockpitOnly.length,
    };
  });
}

const sleep = (page: import("playwright").Page, ms: number) => page.waitForTimeout(ms);

/**
 * Steer to `target` with the keys, closed loop on the HUD's own pitch and bank, in
 * PULSES: a key is held for a time proportional to the error, released, and the
 * airframe is given a moment to answer before the HUD is read again. Holding a key
 * until the attitude arrives overshoots badly (the pitch actuator and the airframe
 * both lag), and a phugoid is not a frame worth taking.
 */
async function steer(page: import("playwright").Page, scenario: Scenario): Promise<void> {
  const { pitch: pitchTarget, bank: bankTarget } = scenario.target;
  if (pitchTarget === undefined && bankTarget === undefined && scenario.throttle === undefined) return;
  const pulse = async (code: string, milliseconds: number) => {
    await page.keyboard.down(code);
    await sleep(page, milliseconds);
    await page.keyboard.up(code);
  };
  const clamp = (value: number, low: number, high: number) => Math.min(high, Math.max(low, value));
  if (scenario.throttle === "idle") {
    // hold the reduce key until the engine is at idle (the HUD's own number), then let go: it stays there
    await page.keyboard.down("ControlLeft");
    for (let i = 0; i < 60; i += 1) {
      const hud = await readHud(page);
      if (hud.engine <= aircraftSpec(KIND).engineReadout.roundTo * 71) break;
      await sleep(page, 100);
    }
    await page.keyboard.up("ControlLeft");
  }
  const started = Date.now();
  let settled = 0;
  while (Date.now() - started < 60_000) {
    const hud = await readHud(page);
    let acted = false;
    if (bankTarget !== undefined && Number.isFinite(hud.bank)) {
      const err = bankTarget - hud.bank;
      if (Math.abs(err) > 2.5) {
        await pulse(err > 0 ? "KeyD" : "KeyA", clamp(Math.abs(err) * 9, 30, 140));
        acted = true;
      }
    }
    if (pitchTarget !== undefined && Number.isFinite(hud.pitch)) {
      const err = pitchTarget - hud.pitch;
      if (Math.abs(err) > 1.5) {
        await pulse(err > 0 ? "KeyS" : "KeyW", clamp(Math.abs(err) * 16, 25, 150));
        acted = true;
      }
    }
    if (TRACE) console.log(`  steer: pitch ${hud.pitch} bank ${hud.bank} fpm ${hud.verticalSpeedFpm} rpm ${hud.engine} kt ${hud.knots} ${acted ? "pulsed" : "holding"}`);
    await sleep(page, 260);
    settled = acted ? 0 : settled + 1;
    if (settled >= 3) break;
  }
}

function inBand(value: number, band: Band | undefined): boolean {
  return band === undefined || (Number.isFinite(value) && value >= band.min && value <= band.max);
}

async function runGroup(mode: "scenic" | "unassisted", scenarios: readonly Scenario[]): Promise<void> {
  const context = await browser.newContext({ viewport: { width: WIDTH, height: HEIGHT }, deviceScaleFactor: 1 });
  try {
    const page = await context.newPage();
    await page.addInitScript((wanted: { kind: string; mode: string }) => {
      localStorage.setItem("aerolith.settings.v3", JSON.stringify({
        aircraft: wanted.kind,
        flightMode: wanted.mode,
        showDiagnostics: false,
        weather: "clear",
        timeOfDay: "day",
        airborneStartAgl: 900,
      }));
    }, { kind: KIND, mode });
    await page.goto(url!, { waitUntil: "domcontentloaded" });
    await page.locator('[aria-label="fly high start"]').waitFor({ timeout: 180_000 });
    await sleep(page, 2_500);
    await page.getByRole("button", { name: /^Start flying/ }).click();
    await sleep(page, Number(process.env.SETTLE_AIR ?? 16) * 1_000);
    for (let press = 0; press < 4; press += 1) {
      const hud = await readHud(page);
      if (hud.view === "COCKPIT") break;
      await page.keyboard.press("KeyC");
      await sleep(page, 1_400);
    }
    await sleep(page, 1_500);

    for (const scenario of scenarios) {
      const label = `${KIND}-${scenario.name}`;
      let last: { hud: HudReading; scene: SceneReading } | null = null;
      let ok = false;
      for (let attempt = 0; attempt < 4 && !ok; attempt += 1) {
        await steer(page, scenario);
        await sleep(page, 350);
        const hud = await readHud(page);
        const scene = await readScene(page);
        last = { hud, scene };
        const r = scenario.require;
        ok = inBand(hud.pitch, r.pitch) && inBand(hud.bank, r.bank) && inBand(hud.verticalSpeedFpm, r.verticalSpeedFpm) && inBand(hud.engine, r.rpm);
        if (TRACE) console.log(`${label} attempt ${attempt}: ${JSON.stringify(hud)} ok=${ok}`);
      }
      if (!ok || !last) {
        throw new Error(`${label}: never reached the state this frame is for; last HUD ${JSON.stringify(last?.hud)} against ${JSON.stringify(scenario.require)}`);
      }
      // the frame itself: read again right around the screenshot, and keep the worse of the two for the assertions
      const before = await readHud(page);
      const png = `${outDir}/${label}.png`;
      await page.screenshot({ path: png, type: "png" });
      const hud = await readHud(page);
      const scene = await readScene(page);
      const readings = [before, hud];
      if (readings.some((r) => !inBand(r.pitch, scenario.require.pitch) || !inBand(r.bank, scenario.require.bank) || !inBand(r.verticalSpeedFpm, scenario.require.verticalSpeedFpm))) {
        throw new Error(`${label}: the state drifted out of its band while the frame was taken: ${JSON.stringify(readings)}`);
      }
      // ---- the assertions of the live page
      if (hud.view !== "COCKPIT") throw new Error(`${label}: HUD says ${hud.view}, not COCKPIT`);
      if (scene.aircraftKind !== KIND) throw new Error(`${label}: the scene holds a "${scene.aircraftKind}", not "${KIND}"`);
      if (scene.cameraFovMode !== 1) throw new Error(`${label}: camera fovMode ${scene.cameraFovMode}, not horizontal-fixed`);
      if (Math.abs(scene.cameraFovDegrees - COCKPIT_HORIZONTAL_FOV_DEGREES) > 0.01) throw new Error(`${label}: live lens ${scene.cameraFovDegrees}`);
      const eye = aircraftSpec(KIND).cockpitEye;
      for (const [axis, expected] of [eye.forward, eye.up, eye.right].entries()) {
        if (Math.abs(scene.eyeInBodyFrame[axis]! - expected) > 0.005) throw new Error(`${label}: live eye ${scene.eyeInBodyFrame.join(", ")} is not the catalogue's`);
      }
      if (scene.cockpitOnlyVisible !== scene.cockpitOnlyTotal || scene.cockpitOnlyTotal === 0) {
        throw new Error(`${label}: ${scene.cockpitOnlyVisible} of ${scene.cockpitOnlyTotal} cockpit-only meshes visible in cockpit view`);
      }
      const checks: string[] = [];
      const within = (name: string, measured: number, reference: number, tolerance: number) => {
        if (!Number.isFinite(measured) || !Number.isFinite(reference) || Math.abs(measured - reference) > tolerance) {
          throw new Error(`${label}: the ${name} instrument says ${measured}, the HUD says ${reference} (tolerance ${tolerance})`);
        }
        checks.push(`${name} ${measured.toFixed(1)} vs HUD ${reference}`);
      };
      if (scene.needleDegrees) {
        const n = scene.needleDegrees;
        // the inverse of the mapping, written here as literals (the PM's numbers)
        within("airspeed kt", ((n.airspeed! + 150) / 300) * 160, hud.knots, 3);
        within("vertical speed ft/min", ((n["vertical-speed"]! + 90) / 90) * 2_000, hud.verticalSpeedFpm, 200);
        within("engine rpm", ((n.engine! + 135) / 270) * 2_750, hud.engine, 60);
        if (!Number.isFinite(n.altimeter)) throw new Error(`${label}: the altimeter needle is not finite`);
        checks.push(`altimeter ${(((n.altimeter! % 360) + 360) % 360 / 360 * 1_000).toFixed(0)} ft (mod 1,000; no HUD number)`);
        if (Math.abs(n.attitude!) > 0.5) throw new Error(`${label}: the attitude dial's needle moved (${n.attitude}); it has no mapping`);
      }
      if (scene.ball) {
        // the ball turns clockwise-as-seen by MINUS the bank; the bar slides DOWN 1 mm a degree of nose-up
        within("ball bank deg", -scene.ball.pivotDegrees, hud.bank, 3);
        within("pitch bar deg", -scene.ball.barMetres * 1_000, hud.pitch, 2);
      }
      writeFileSync(`${outDir}/${label}.json`, `${JSON.stringify({ label, kind: KIND, mode, scenario: scenario.name, url, expectTree, before, hud, scene, checks }, null, 2)}\n`);
      console.log(
        `${label}: HUD COCKPIT, scene kind ${scene.aircraftKind}, eye == catalogue, lens ${scene.cameraFovDegrees.toFixed(2)}, `
        + `pitch ${hud.pitch} bank ${hud.bank} IAS ${hud.knots} kt V/S ${hud.verticalSpeedFpm} ft/min ${hud.engineLabel} ${hud.engine}; instruments: ${checks.join("; ")} -> ${png}`,
      );
      // let the airframe settle a moment before the next steer
      await sleep(page, 400);
    }
  } finally {
    await context.close().catch(() => {});
  }
}

for (const mode of ["scenic", "unassisted"] as const) {
  const group = RUN.filter((s) => s.mode === mode);
  if (group.length > 0) await runGroup(mode, group);
}
await browser.close();
console.log("instrument frames written");
