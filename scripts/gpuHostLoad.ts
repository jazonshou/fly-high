import { execFile } from "node:child_process";
import { cpus, loadavg } from "node:os";
import { promisify } from "node:util";

/**
 * What else is using this machine while a GPU test measures time, read on the
 * Node side of the GPU project (the browser cannot run `ps`) and handed to a
 * test through the `hostLoad` browser command (vitest.gpu.config.ts).
 *
 * A GPU pass's timestamps bracket the pass on the GPU's clock, so another
 * context the GPU time-slices in (a WebGPU game tab rendering at frame rate,
 * another engineer's capture) lands inside a trivial pass's reading. The
 * gate's one red on 2026-09-23 was that: a one-invocation pass reading
 * 1.52 ms against a 1 ms bound, with the host busy. A timing bound is not a
 * correctness bound, so a test holds its correctness assertions whatever the
 * load and lets a failed TIMING bound skip, naming the load, when `busy` is
 * not empty.
 *
 * The recorded quantities follow the breach sample's guard: the GPU's own
 * utilisation (IOAccelerator's "Device Utilization %", readable without
 * privileges on Apple silicon), Jason's Firefox (its GPU helper renders any
 * open game tab), and the host's one-minute load average against its cores.
 * An instrument that cannot be read reports null, never 0: an unread GPU is
 * not a quiet one, and it adds no skip reason, so a failed bound on a host
 * that cannot be characterised still fails.
 */
export interface HostLoad {
  /** Every sample of the GPU's utilisation, per cent; null when unreadable (no ioreg, no field). */
  readonly gpuUtilisation: readonly number[] | null;
  /** Firefox's CPU, per cent of one core: the GPU helper processes and the main process. */
  readonly firefox: { readonly gpuHelper: number; readonly main: number } | null;
  readonly loadAverage1m: number;
  readonly cores: number;
  /** Processes above half a core, "name pcpu%". */
  readonly heavyProcesses: readonly string[];
  /** Why this host is too busy for a timing bound; empty when it is not. */
  readonly busy: readonly string[];
  /** The readings on one line, for the test's output (the browser side cannot import this module). */
  readonly summary: string;
}

type HostReadings = Omit<HostLoad, "busy" | "summary">;

/** A GPU above this share of its time, in any sample, is someone else's frame. */
export const GPU_BUSY_PERCENT = 20;
/** Firefox's GPU helper above this share of a core is a game tab rendering. */
export const FIREFOX_HELPER_BUSY_PERCENT = 10;

const run = promisify(execFile);

/** "Device Utilization %"=31 from `ioreg -r -d 1 -w 0 -c IOAccelerator`; the highest accelerator's, or null. */
export function parseGpuUtilisation(ioreg: string): number | null {
  const values = [...ioreg.matchAll(/"Device Utilization %"\s*=\s*(\d+)/g)].map((match) => Number(match[1]));
  return values.length > 0 ? Math.max(...values) : null;
}

/** Firefox's CPU from `ps -Ao pcpu,command`: the GPU helpers and the main process, summed. */
export function parseFirefox(ps: string): { gpuHelper: number; main: number } {
  let gpuHelper = 0;
  let main = 0;
  for (const line of ps.split("\n")) {
    const match = /^\s*([\d.]+)\s+(.*)$/.exec(line);
    if (!match) continue;
    const pcpu = Number(match[1]);
    const command = match[2]!;
    if (/firefox.*(gpu-helper|GPU Helper)/i.test(command)) gpuHelper += pcpu;
    else if (/\/Firefox\.app\/Contents\/MacOS\/firefox( |$)/.test(command)) main += pcpu;
  }
  return { gpuHelper, main };
}

/** Processes above half a core from `ps -Ao pcpu,comm`, as "name pcpu%". */
export function parseHeavyProcesses(ps: string): string[] {
  const out: string[] = [];
  for (const line of ps.split("\n").slice(1)) {
    const match = /^\s*([\d.]+)\s+(.*)$/.exec(line);
    if (!match || Number(match[1]) <= 50) continue;
    out.push(`${match[2]!.split("/").pop()} ${Math.round(Number(match[1]))}%`);
  }
  return out;
}

/** The skip reasons for a timing bound, from the readings alone. */
export function busyReasons(load: HostReadings): string[] {
  const reasons: string[] = [];
  const gpuPeak = load.gpuUtilisation && load.gpuUtilisation.length > 0 ? Math.max(...load.gpuUtilisation) : null;
  if (gpuPeak !== null && gpuPeak >= GPU_BUSY_PERCENT) reasons.push(`the GPU was ${gpuPeak}% busy (>= ${GPU_BUSY_PERCENT}%)`);
  if (load.firefox && load.firefox.gpuHelper >= FIREFOX_HELPER_BUSY_PERCENT) {
    reasons.push(`Firefox's GPU helper at ${load.firefox.gpuHelper.toFixed(1)}% of a core (>= ${FIREFOX_HELPER_BUSY_PERCENT}%)`);
  }
  if (load.loadAverage1m >= load.cores) {
    reasons.push(`one-minute load ${load.loadAverage1m.toFixed(1)} on ${load.cores} cores`);
  }
  return reasons;
}

async function output(file: string, args: readonly string[]): Promise<string | null> {
  try {
    return (await run(file, [...args], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 })).stdout;
  } catch {
    return null;
  }
}

/** Reads the host: `samples` GPU readings `intervalMs` apart (utilisation flickers frame to frame), then the processes. */
export async function readHostLoad(samples = 5, intervalMs = 200): Promise<HostLoad> {
  const gpu: number[] = [];
  let gpuReadable = true;
  for (let sample = 0; sample < samples && gpuReadable; sample += 1) {
    if (sample > 0) await new Promise((resolve) => setTimeout(resolve, intervalMs));
    const ioreg = await output("ioreg", ["-r", "-d", "1", "-w", "0", "-c", "IOAccelerator"]);
    const value = ioreg === null ? null : parseGpuUtilisation(ioreg);
    if (value === null) gpuReadable = false;
    else gpu.push(value);
  }
  const psCommand = await output("ps", ["-Ao", "pcpu,command"]);
  const psComm = await output("ps", ["-Ao", "pcpu,comm"]);
  const load: HostReadings = {
    gpuUtilisation: gpuReadable ? gpu : null,
    firefox: psCommand === null ? null : parseFirefox(psCommand),
    loadAverage1m: loadavg()[0]!,
    cores: cpus().length,
    heavyProcesses: psComm === null ? [] : parseHeavyProcesses(psComm),
  };
  return { ...load, busy: busyReasons(load), summary: summariseHostLoad(load) };
}

/** The readings on one line. */
export function summariseHostLoad(load: HostReadings): string {
  const gpu = load.gpuUtilisation === null ? "unreadable" : `${load.gpuUtilisation.join("/")}%`;
  const firefox = load.firefox === null
    ? "unreadable"
    : `GPU helper ${load.firefox.gpuHelper.toFixed(1)}%, main ${load.firefox.main.toFixed(1)}%`;
  const heavy = load.heavyProcesses.length > 0 ? load.heavyProcesses.join(", ") : "none";
  return `GPU ${gpu}; Firefox ${firefox}; load ${load.loadAverage1m.toFixed(2)} on ${load.cores} cores; above half a core: ${heavy}`;
}
