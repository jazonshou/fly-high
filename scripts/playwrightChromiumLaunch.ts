import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import type { LaunchOptions } from "playwright";

export const PLAYWRIGHT_CHROMIUM_EXECUTABLE_ENV =
  "FLIGHT_SIM_PLAYWRIGHT_CHROMIUM_EXECUTABLE";

const macosChromiumShim = fileURLToPath(
  new URL("./playwright-chromium-macos.sh", import.meta.url),
);

function definedEnvironment(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
}

/**
 * Full Chrome for Testing may leave a macOS crashpad helper holding the stderr
 * pipe that Playwright waits to close. The shim keeps CDP on descriptors 3/4
 * while detaching descriptor 2 before Chromium can hand it to crashpad.
 */
export function chromiumStdioLaunchOptions(
  platform: NodeJS.Platform = process.platform,
): Pick<LaunchOptions, "env" | "executablePath"> | Record<string, never> {
  if (platform !== "darwin") {
    return {};
  }

  return {
    executablePath: macosChromiumShim,
    env: {
      ...definedEnvironment(),
      [PLAYWRIGHT_CHROMIUM_EXECUTABLE_ENV]: chromium.executablePath(),
    },
  };
}
