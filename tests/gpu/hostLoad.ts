import { commands } from "vitest/browser";
import type { HostLoad } from "../../scripts/gpuHostLoad";

declare module "vitest/browser" {
  interface BrowserCommands {
    /** What else is using this machine, read on the Node side (scripts/gpuHostLoad.ts, vitest.gpu.config.ts). */
    hostLoad: () => Promise<HostLoad>;
  }
}

/**
 * Reads the host's load and prints it under `label`, for a test that holds a
 * TIMING bound. Read it before the timed work and after it, never during:
 * the GPU's utilisation would then count the test's own passes.
 */
export async function hostLoad(label: string): Promise<HostLoad> {
  const load = await commands.hostLoad();
  console.log(`host load ${label}: ${load.summary}${load.busy.length > 0 ? `; BUSY: ${load.busy.join("; ")}` : ""}`);
  return load;
}
