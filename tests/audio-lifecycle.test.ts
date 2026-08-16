import { describe, expect, it, vi } from "vitest";
import { FlightAudio } from "../src/audio";

interface AudioInternals {
  context: AudioContext | null;
  enabled: boolean;
  desiredEnabled: boolean;
}

function createAudio(): FlightAudio {
  return new FlightAudio({
    aircraft: "trainer",
    master: 1,
    engine: 1,
    wind: 1,
  });
}

describe("audio activation lifecycle", () => {
  it("does not let a late unlock resume re-enable audio after suspend/end", async () => {
    let state: AudioContextState = "suspended";
    let releaseResume: () => void = () => {};
    const pendingResume = new Promise<void>((resolve) => {
      releaseResume = () => {
        state = "running";
        resolve();
      };
    });
    const resume = vi.fn(() => pendingResume);
    const suspend = vi.fn(async () => { state = "suspended"; });
    const close = vi.fn(async () => { state = "closed"; });
    const context = {
      get state() { return state; },
      resume,
      suspend,
      close,
    } as unknown as AudioContext;
    const audio = createAudio();
    const internals = audio as unknown as AudioInternals;
    internals.context = context;

    const unlocking = audio.unlock();
    audio.suspend();
    releaseResume();
    await unlocking;
    await Promise.resolve();

    expect(resume).toHaveBeenCalledTimes(1);
    expect(suspend).toHaveBeenCalledTimes(1);
    expect(internals.desiredEnabled).toBe(false);
    expect(internals.enabled).toBe(false);
    expect(state).toBe("suspended");
    audio.dispose();
  });

  it("reconciles a newer unlock after an older suspension settles late", async () => {
    let state: AudioContextState = "running";
    let releaseSuspend: () => void = () => {};
    const pendingSuspend = new Promise<void>((resolve) => {
      releaseSuspend = () => {
        state = "suspended";
        resolve();
      };
    });
    const resume = vi.fn(async () => { state = "running"; });
    const suspend = vi.fn(() => pendingSuspend);
    const close = vi.fn(async () => { state = "closed"; });
    const context = {
      get state() { return state; },
      resume,
      suspend,
      close,
    } as unknown as AudioContext;
    const audio = createAudio();
    const internals = audio as unknown as AudioInternals;
    internals.context = context;

    await audio.unlock();
    audio.suspend();
    await audio.unlock();
    releaseSuspend();
    await pendingSuspend;
    await Promise.resolve();
    await Promise.resolve();

    expect(suspend).toHaveBeenCalledTimes(1);
    expect(resume).toHaveBeenCalledTimes(1);
    expect(internals.desiredEnabled).toBe(true);
    expect(internals.enabled).toBe(true);
    expect(state).toBe("running");
    audio.dispose();
  });
});
