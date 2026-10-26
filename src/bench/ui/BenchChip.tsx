import { useEffect, useRef, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { clockText, fpsText, remainingText, tierName } from "./words";

/**
 * Where a step page is. "done" is the pause after a flight's result is
 * saved; "paused" and "failed" sit under a card that says why; "stopping"
 * is the moment between Stop and the report page.
 */
export type BenchChipPhase = "starting" | "settling" | "flying" | "done" | "paused" | "failed" | "stopping";

export interface BenchChipProps {
  readonly stepIndex: number;
  readonly stepCount: number;
  readonly tierIndex: number;
  /** 1 or 2: this load's attempt at the step. */
  readonly attempt: number;
  readonly phase: BenchChipPhase;
  /** Seconds since the flight's first frame; read while "flying". */
  readonly flightElapsedS: number;
  readonly flightS: number;
  /** The whole run's time left (`estimateRemainingSeconds`), or null to leave it out. */
  readonly remainingS: number | null;
  /** "done": how the flight ended, and its headline fps. */
  readonly result?: { readonly outcome: "ok" | "early-stop"; readonly fps: number | null } | null;
  /** "done": the next flight's tier, or null when the report comes next. */
  readonly nextTierIndex?: number | null;
  /** Stop was pressed (or Escape reached the page) and waits for a yes. */
  readonly stopConfirm: boolean;
  /** Asks to stop: show the confirmation. */
  readonly onStop: () => void;
  readonly onStopCancel: () => void;
  readonly onStopConfirm: () => void;
}

/** How far through the whole run, 0 to 1: finished steps plus this one's flight. */
export function chipProgress(props: Pick<BenchChipProps, "stepIndex" | "stepCount" | "phase" | "flightElapsedS" | "flightS">): number {
  const { stepIndex, stepCount, phase, flightElapsedS, flightS } = props;
  if (stepCount <= 0) return 0;
  const within = phase === "done" || phase === "failed" || phase === "stopping"
    ? 1
    : phase === "flying" && flightS > 0
      ? Math.min(1, Math.max(0, flightElapsedS / flightS))
      : 0;
  return Math.min(1, Math.max(0, (stepIndex + within) / stepCount));
}

/** The chip's visible phase words, ticking clock included. */
export function chipPhaseText(props: Pick<BenchChipProps, "phase" | "tierIndex" | "attempt" | "flightElapsedS" | "flightS" | "result" | "nextTierIndex">): string {
  const tier = tierName(props.tierIndex);
  switch (props.phase) {
    case "starting":
      return props.attempt > 1 ? `Starting again (attempt ${props.attempt})` : "Starting";
    case "settling":
      return "Loading the scenery";
    case "flying":
      return `Flying ${clockText(props.flightElapsedS)} / ${clockText(props.flightS)}`;
    case "done": {
      const next = props.nextTierIndex === null || props.nextTierIndex === undefined
        ? "Opening the report…"
        : `Loading ${tierName(props.nextTierIndex)}…`;
      const how = props.result?.outcome === "early-stop"
        ? `${tier} stopped early: under 5 fps.`
        : `${tier} done: ${fpsText(props.result?.fps)}.`;
      return `${how} ${next}`;
    }
    case "paused":
      return "Paused";
    case "failed":
      return `${tier} stopped`;
    case "stopping":
      return "Stopping. Opening the report…";
  }
}

/**
 * What the live region says: the phase only, never the clock, so a screen
 * reader hears each change once rather than every second.
 */
export function chipAnnouncement(props: Pick<BenchChipProps, "phase" | "tierIndex" | "stepIndex" | "stepCount" | "attempt" | "flightElapsedS" | "flightS" | "result" | "nextTierIndex">): string {
  const flight = `Flight ${props.stepIndex + 1} of ${props.stepCount}, ${tierName(props.tierIndex)}`;
  switch (props.phase) {
    case "starting":
      return `${flight}: starting.`;
    case "settling":
      return `${flight}: loading the scenery.`;
    case "flying":
      return `${flight}: flying.`;
    case "paused":
      return "Benchmark paused.";
    case "done":
    case "failed":
    case "stopping":
      return chipPhaseText(props);
  }
}

/**
 * The run chip, top centre on a step page: which flight of how many, the
 * quality, what is happening, a progress bar and the time left. Stop asks
 * inside the chip, never through `window.confirm`, which would stall the
 * frame loop being measured. The page owns `stopConfirm`, so Escape pressed
 * anywhere can open the same question.
 */
export function BenchChip(props: BenchChipProps) {
  const { stepIndex, stepCount, phase, stopConfirm, remainingS } = props;
  const keepGoingRef = useRef<HTMLButtonElement>(null);
  const percent = Math.round(chipProgress(props) * 100);
  const remaining = remainingS !== null && (phase === "starting" || phase === "settling" || phase === "flying")
    ? remainingText(remainingS)
    : null;
  const canStop = phase !== "stopping";

  useEffect(() => {
    // The safe answer takes focus, so a second Enter or Space keeps the run going.
    if (stopConfirm) keepGoingRef.current?.focus();
  }, [stopConfirm]);

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLElement>) => {
    event.stopPropagation();
    if (event.key !== "Escape") return;
    event.preventDefault();
    if (stopConfirm) props.onStopCancel();
    else if (canStop) props.onStop();
  };

  return (
    <section className="bench-chip" aria-label="Benchmark" onKeyDown={handleKeyDown} data-bench-ui="">
      <p className="bench-chip__line">
        <strong>Benchmark {stepIndex + 1}/{stepCount}</strong>
        <span>{tierName(props.tierIndex)}</span>
        <span>{chipPhaseText(props)}</span>
        {remaining ? <span>{remaining}</span> : null}
      </p>
      <div
        className="bench-chip__bar"
        role="progressbar"
        aria-label="Benchmark progress"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
      >
        <span style={{ transform: `scaleX(${percent / 100})` }} />
      </div>
      {stopConfirm ? (
        <div className="bench-chip__confirm" role="group" aria-labelledby="bench-chip-confirm">
          <span id="bench-chip-confirm">Stop the benchmark? Finished flights stay in the report.</span>
          <button type="button" className="bench-chip__button bench-chip__button--danger" onClick={props.onStopConfirm}>
            Stop now
          </button>
          <button ref={keepGoingRef} type="button" className="bench-chip__button" onClick={props.onStopCancel}>
            Keep going
          </button>
        </div>
      ) : canStop ? (
        <button type="button" className="bench-chip__button bench-chip__stop" onClick={props.onStop}>
          Stop
        </button>
      ) : null}
      <p className="bench-visually-hidden" role="status" aria-live="polite">{chipAnnouncement(props)}</p>
    </section>
  );
}
