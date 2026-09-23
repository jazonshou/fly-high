import { describe, expect, it } from "vitest";
import {
  busyReasons,
  FIREFOX_HELPER_BUSY_PERCENT,
  GPU_BUSY_PERCENT,
  parseFirefox,
  parseGpuUtilisation,
  parseHeavyProcesses,
  readHostLoad,
} from "../scripts/gpuHostLoad";

// Lines as this M2 Pro printed them on 2026-09-23 (paths shortened past the flags).
const IOREG = `+-o AGXAcceleratorG14X  <class AGXAcceleratorG14X, id 0x1000003f4>
    "PerformanceStatistics" = {"In use system memory (driver)"=0,"Tiler Utilization %"=30,"Renderer Utilization %"=30,"Device Utilization %"=31,"SplitSceneCount"=0}`;
const PS_COMMAND = `%CPU COMMAND
 1.0 /Applications/Firefox.app/Contents/MacOS/firefox
 0.0 /Applications/Firefox.app/Contents/MacOS/crashhelper 13939 gecko-crash-server-pipe.13939
37.5 /Applications/Firefox.app/Contents/MacOS/gpu-helper.app/Contents/MacOS/Firefox GPU Helper -parentBuildID 20260909172920 -prefsHandle 0:47987
 1.1 /Applications/Firefox.app/Contents/MacOS/plugin-container.app/Contents/MacOS/plugin-container -isForBrowser -prefsHandle 0:56028
12.0 /Applications/Google Chrome.app/Contents/Frameworks/Google Chrome Framework.framework/Versions/1/Helpers/Google Chrome Helper (GPU).app/Contents/MacOS/Google Chrome Helper (GPU) --type=gpu-process`;
const PS_COMM = `%CPU COMM
89.5 /opt/homebrew/Cellar/node/26.7.0/bin/node
 1.0 /Applications/Firefox.app/Contents/MacOS/firefox
50.0 /usr/sbin/cfprefsd`;

describe("the GPU tests' host-load reader", () => {
  it("reads the GPU's utilisation from ioreg, and nothing from output without the field", () => {
    expect(parseGpuUtilisation(IOREG)).toBe(31);
    expect(parseGpuUtilisation(`${IOREG}\n"Device Utilization %"=4`)).toBe(31);
    expect(parseGpuUtilisation("+-o IOAccelerator  <class IOAccelerator>")).toBeNull();
  });

  it("finds Firefox's GPU helper by the name its app bundle gives it, apart from Chrome's GPU process", () => {
    expect(parseFirefox(PS_COMMAND)).toEqual({ gpuHelper: 37.5, main: 1.0 });
    expect(parseFirefox("%CPU COMMAND\n 3.0 /usr/sbin/cfprefsd")).toEqual({ gpuHelper: 0, main: 0 });
  });

  it("lists processes above half a core by name", () => {
    expect(parseHeavyProcesses(PS_COMM)).toEqual(["node 90%"]);
  });

  it("names each busy reading, and none for a quiet host or an unread GPU", () => {
    const quiet = { gpuUtilisation: [0, 13, 0], firefox: { gpuHelper: 0.4, main: 1 }, loadAverage1m: 3, cores: 10, heavyProcesses: [] };
    expect(busyReasons(quiet)).toEqual([]);
    expect(busyReasons({ ...quiet, gpuUtilisation: null })).toEqual([]);
    expect(busyReasons({ ...quiet, gpuUtilisation: [0, GPU_BUSY_PERCENT, 0] })).toEqual([`the GPU was ${GPU_BUSY_PERCENT}% busy (>= ${GPU_BUSY_PERCENT}%)`]);
    expect(busyReasons({ ...quiet, firefox: { gpuHelper: FIREFOX_HELPER_BUSY_PERCENT, main: 0 } })).toHaveLength(1);
    expect(busyReasons({ ...quiet, loadAverage1m: 10.6 })).toEqual(["one-minute load 10.6 on 10 cores"]);
  });

  it.runIf(process.platform === "darwin")("reads this Mac: a GPU figure every sample, and a summary line", async () => {
    const load = await readHostLoad(2, 50);
    expect(load.gpuUtilisation).toHaveLength(2);
    expect(load.firefox).not.toBeNull();
    expect(load.summary).toMatch(/^GPU \d+\/\d+%; Firefox /);
  });
});
