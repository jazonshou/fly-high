/**
 * The machinery of the cloud A/B (`scripts/perf-ab.mts`): check out the base,
 * build the agent page once per arm, serve each build, launch the browser and
 * talk to the agent. No statistics and no policy live here.
 *
 * Plain Node (22.18+ strips the types), so it can run where `tsx` is not
 * installed: only explicit `.ts`/`.mts` imports, and nothing from
 * `scripts/perf-capture.mts`, which imports `src/` without extensions.
 */

import { execFileSync } from "node:child_process";
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, relative, resolve, sep } from "node:path";
import { chromium, type Browser, type Page } from "playwright";
import { build } from "vite";
import { cacheDirFor } from "./checkoutCacheDir.ts";
import { chromiumStdioLaunchOptions } from "./playwrightChromiumLaunch.ts";
import { PERF_AB_PROTOCOL, type PerfAgent } from "../tests/perf/ab/protocol.ts";

/**
 * The instrument. Copied from the checkout that runs the A/B into each arm's
 * worktree before it is built, so both arms are measured by the same code and
 * differ only in what they measure.
 */
export const HARNESS_PATHS: readonly string[] = [
  "tests/perf/ab",
  "tests/perf/gpuDrawGate.ts",
  "tests/perf/gpuPassLabels.ts",
  "tests/perf/gpuPassTiming.ts",
  "tests/perf/gpuWorkCounters.ts",
  "tests/perf/shotPlacement.ts",
];

export function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

/**
 * A detached worktree of `commit` with this checkout's harness laid over it
 * and this checkout's `node_modules` linked in. Returns the worktree path.
 *
 * `node_modules` is linked rather than installed: a PR that changes no
 * dependency builds both arms against the same packages, which is what a
 * same-dependency A/B wants. When the lockfiles differ the caller is told and
 * decides (`installBaseDependencies`).
 */
export function prepareArmCheckout(headRoot: string, commit: string, directory: string): string {
  removeArmCheckout(headRoot, directory);
  git(headRoot, "worktree", "add", "--detach", directory, commit);
  for (const path of HARNESS_PATHS) {
    const source = join(headRoot, path);
    const target = join(directory, path);
    rmSync(target, { recursive: true, force: true });
    cpSync(source, target, { recursive: true });
  }
  const modules = join(directory, "node_modules");
  if (!existsSync(modules)) symlinkSync(join(headRoot, "node_modules"), modules, "dir");
  return directory;
}

/**
 * Removes an arm's worktree, including one left half made: a directory git
 * does not list as a worktree is deleted and the registry pruned.
 */
export function removeArmCheckout(headRoot: string, directory: string): void {
  if (!existsSync(directory)) return;
  const modules = join(directory, "node_modules");
  if (lstatSync(modules, { throwIfNoEntry: false })?.isSymbolicLink()) rmSync(modules);
  try {
    git(headRoot, "worktree", "remove", "--force", directory);
  } catch {
    rmSync(directory, { recursive: true, force: true });
    git(headRoot, "worktree", "prune");
  }
}

export function lockfilesDiffer(headRoot: string, baseRoot: string): boolean {
  const read = (root: string) => {
    const path = join(root, "package-lock.json");
    return existsSync(path) ? readFileSync(path, "utf8") : "";
  };
  return read(headRoot) !== read(baseRoot);
}

/** Replaces the linked `node_modules` with the base's own locked install. */
export function installBaseDependencies(baseRoot: string): void {
  const modules = join(baseRoot, "node_modules");
  if (existsSync(modules) && lstatSync(modules).isSymbolicLink()) rmSync(modules);
  execFileSync("npm", ["ci", "--ignore-scripts", "--no-audit", "--no-fund"], { cwd: baseRoot, stdio: "inherit" });
}

/**
 * A production build of the agent page from `checkout`: what ships is a
 * minified production bundle (`process.env.NODE_ENV` is "production", so
 * Babylon's GPU debug markers are off), and both arms must be built the same
 * way whatever that way is.
 */
export async function buildAgent(checkout: string, outDir: string, cacheDir?: string): Promise<void> {
  const root = join(checkout, "tests/perf/ab");
  await build({
    configFile: false,
    root,
    base: "./",
    mode: "production",
    logLevel: "warn",
    // A worktree's own cache would land in the linked node_modules under a
    // new name per base commit; the caller passes one inside its output.
    cacheDir: cacheDir ?? cacheDirFor("perf-ab", checkout),
    resolve: { alias: { "@": checkout } },
    build: {
      outDir,
      emptyOutDir: true,
      target: "es2022",
      reportCompressedSize: false,
      chunkSizeWarningLimit: 100_000,
      rolldownOptions: { input: join(root, "agent.html") },
    },
  });
}

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".map": "application/json",
  ".wasm": "application/wasm",
  ".png": "image/png",
  ".svg": "image/svg+xml",
};

export interface StaticServer {
  readonly origin: string;
  close(): Promise<void>;
}

/** Serves `directory` on an ephemeral loopback port. Nothing outside it is reachable. */
export function serveDirectory(directory: string): Promise<StaticServer> {
  const root = resolve(directory);
  const server = createServer((request, response) => {
    const pathname = decodeURIComponent(new URL(request.url ?? "/", "http://localhost").pathname);
    const path = resolve(root, `.${pathname}`);
    if ((path !== root && !path.startsWith(`${root}${sep}`)) || !existsSync(path) || lstatSync(path).isDirectory()) {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, {
      "content-type": CONTENT_TYPES[extname(path)] ?? "application/octet-stream",
      "cache-control": "no-store",
    });
    response.end(readFileSync(path));
  });
  return new Promise((resolveServer, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("perf-ab: the static server has no port"));
        return;
      }
      resolveServer({
        origin: `http://127.0.0.1:${address.port}`,
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}

/**
 * `swiftshader`: Chrome's CPU implementation of Vulkan, under Dawn — WebGPU on
 * a machine with no GPU, which is every hosted Linux runner and this cloud
 * container. `hardware`: the machine's own GPU (Metal on macOS).
 */
export type GpuBackend = "swiftshader" | "hardware";

export function chromiumArgs(backend: GpuBackend, platform: NodeJS.Platform = process.platform): string[] {
  const common = [
    // As vitest.perf.config.ts: no crashpad helper may inherit the pipes. On
    // Linux `--disable-crashpad-for-testing` stops every navigation with
    // ERR_ABORTED (Chromium 141), so it is macOS's alone.
    ...(platform === "darwin" ? ["--disable-crashpad-for-testing"] : []),
    "--disable-crash-reporter",
    // Also lifts timestamp quantisation, which per-pass timing depends on.
    "--enable-unsafe-webgpu",
  ];
  if (backend === "swiftshader") {
    // Not `--disable-vulkan-surface`, which headless recipes often add: with
    // it the WebGPU canvas can no longer be read back (drawImage, toDataURL
    // and createImageBitmap all return transparent black), so every capture
    // would be blank while the frame itself rendered fine.
    return [
      ...common,
      "--enable-features=Vulkan",
      "--use-vulkan=swiftshader",
      "--use-angle=swiftshader",
    ];
  }
  return platform === "darwin"
    ? [...common, "--use-angle=metal", "--enable-features=WebGPU"]
    : [...common, "--enable-features=Vulkan"];
}

/**
 * The Chromium to launch: an explicit path, else Playwright's own build, else
 * the container-provided one under `PLAYWRIGHT_BROWSERS_PATH` (cloud sessions
 * ship a Chromium that may not match this checkout's Playwright version).
 */
export function chromiumExecutable(explicit: string | undefined): string | undefined {
  if (explicit) return explicit;
  const own = chromium.executablePath();
  if (existsSync(own)) return undefined;
  const provided = process.env.PLAYWRIGHT_BROWSERS_PATH
    ? join(process.env.PLAYWRIGHT_BROWSERS_PATH, "chromium")
    : undefined;
  if (provided && existsSync(provided)) return provided;
  throw new Error(
    `perf-ab: no Chromium at ${own}. Run \`npx playwright install chromium\`, or pass --chromium <path>.`,
  );
}

/**
 * Launched as `vitest.perf.config.ts` launches the capture's browser: the full
 * Chromium build in headless mode (`channel: "chromium"`, not the headless
 * shell), and on macOS through the stdio shim that keeps crashpad from holding
 * Playwright's pipe open.
 */
export async function launchBrowser(backend: GpuBackend, executable: string | undefined): Promise<Browser> {
  const executablePath = chromiumExecutable(executable);
  return chromium.launch({
    headless: true,
    channel: "chromium",
    ...(executablePath ? { executablePath } : chromiumStdioLaunchOptions()),
    args: chromiumArgs(backend),
  });
}

/**
 * The renderer refuses a fallback adapter on purpose — players must have a
 * GPU. The harness is the one place that knowingly runs on SwiftShader, so it
 * tells the page the adapter is not a fallback before any script runs.
 */
const ACCEPT_FALLBACK_ADAPTER = `(() => {
  const proto = globalThis.GPUAdapterInfo && globalThis.GPUAdapterInfo.prototype;
  if (proto) Object.defineProperty(proto, "isFallbackAdapter", { get() { return false; }, configurable: true });
})();`;

/**
 * One arm: its own browser, so its own GPU process, and one page in it.
 *
 * Not a page per arm in one browser, where both arms' WebGPU devices share a
 * GPU process. Measured there on SwiftShader (2026-10-12), in four A/A runs
 * out of four: one arm's terrain horizon bake waited on a compute pipeline
 * that became ready only after Babylon's `dispatchWhenReady` had stopped
 * polling (it gives up after 3,000 tries, about 30 s, without settling), so
 * that arm never published the horizon field and its water lost its terrain
 * occlusion, every water pixel up to 22 levels brighter. With a browser
 * each, the two arms' frames are identical.
 */
export class AgentArm {
  readonly name: string;
  readonly page: Page;
  private readonly browser: Browser;
  private closed = false;

  // Not parameter properties: Node's type stripping cannot run them.
  private constructor(name: string, browser: Browser, page: Page) {
    this.name = name;
    this.browser = browser;
    this.page = page;
  }

  static async open(
    name: string,
    origin: string,
    backend: GpuBackend,
    executable: string | undefined,
    log: (line: string) => void,
    verbose = false,
  ): Promise<AgentArm> {
    const browser = await launchBrowser(backend, executable);
    try {
      const context = await browser.newContext({ viewport: { width: 1_280, height: 720 }, deviceScaleFactor: 1 });
      if (backend === "swiftshader") await context.addInitScript(ACCEPT_FALLBACK_ADAPTER);
      const page = await context.newPage();
      page.on("console", (message) => {
        const type = message.type();
        if (type === "error" || type === "warning" || verbose) log(`[${name}] ${type}: ${message.text()}`);
      });
      page.on("pageerror", (error) => log(`[${name}] page error: ${error.message}`));
      page.on("crash", () => log(`[${name}] the page crashed`));
      await page.goto(`${origin}/agent.html`);
      await page.waitForFunction(() => window.__perfAgent !== undefined, undefined, { timeout: 120_000 });
      const protocol = await page.evaluate(() => window.__perfAgent!.protocol);
      if (protocol !== PERF_AB_PROTOCOL) {
        throw new Error(`perf-ab: the ${name} page speaks protocol ${protocol}, this orchestrator ${PERF_AB_PROTOCOL}`);
      }
      return new AgentArm(name, browser, page);
    } catch (error) {
      await browser.close().catch(() => undefined);
      throw error;
    }
  }

  /** Calls one agent method in the page; a page-side throw rejects with its message. */
  call<Method extends Exclude<keyof PerfAgent, "protocol">>(
    method: Method,
    ...args: Parameters<PerfAgent[Method]>
  ): Promise<Awaited<ReturnType<PerfAgent[Method]>>> {
    return this.page.evaluate(
      ({ method: name, args: values }) => {
        const agent = window.__perfAgent as unknown as Record<string, (...input: unknown[]) => unknown>;
        return agent[name]!(...values);
      },
      { method: method as string, args: args as unknown[] },
    ) as Promise<Awaited<ReturnType<PerfAgent[Method]>>>;
  }

  async setViewport(width: number, height: number): Promise<void> {
    await this.page.setViewportSize({ width, height });
  }

  /** Closes the arm's browser; safe to call again. */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.browser.close();
  }
}

/** `path` relative to `root`, for messages. */
export function shortPath(root: string, path: string): string {
  const relativePath = relative(root, path);
  return relativePath.startsWith("..") ? path : relativePath;
}

export function ensureDirectory(path: string): string {
  mkdirSync(path, { recursive: true });
  return path;
}
