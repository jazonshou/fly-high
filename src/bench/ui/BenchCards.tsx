import { noticeText } from "../flow";
import type { BenchAttemptNote, BenchNoticeCode } from "../types";
import { tierName } from "./words";

/**
 * The cards a step page shows over the flight when something got in the
 * way. "hidden" and "resized" void this attempt; "failed" ends the step;
 * "retry" says why this load is a second try; "notice" carries the flow's
 * message from the page before.
 */
export type BenchCardProps =
  | {
    readonly kind: "hidden" | "resized";
    readonly tierIndex: number;
    /** This load's attempt. */
    readonly attempt: number;
    readonly maxAttempts: number;
    /** Seconds before the page goes on by itself, or null to leave the count out. */
    readonly continueInS?: number | null;
    /** Draws a button that goes on at once. */
    readonly onContinue?: () => void;
  }
  | {
    readonly kind: "failed";
    readonly tierIndex: number;
    readonly message: string;
    readonly continueInS?: number | null;
    readonly onContinue?: () => void;
  }
  | {
    readonly kind: "retry";
    readonly tierIndex: number;
    /** Why the last attempt ended without a result. */
    readonly previous: BenchAttemptNote;
    /** This load's attempt. */
    readonly attempt: number;
    readonly maxAttempts: number;
  }
  | { readonly kind: "notice"; readonly notice: BenchNoticeCode };

interface CardWords {
  readonly title: string | null;
  readonly text: string;
  /** An alert interrupts a screen reader; a status waits its turn. */
  readonly urgent: boolean;
}

function retryReason(previous: BenchAttemptNote): string {
  switch (previous.outcome) {
    case "void-hidden":
      return "was paused because you switched away";
    case "void-resized":
      return "stopped because the window changed size";
    case "interrupted":
      return "closed the page";
  }
}

/** "the WebGPU device was lost" → "The WebGPU device was lost." */
function sentence(message: string): string {
  const text = message.trim();
  if (text === "") return "Something went wrong.";
  const capital = text.charAt(0).toUpperCase() + text.slice(1);
  return /[.!?]$/.test(capital) ? capital : `${capital}.`;
}

/** A card's title and text, so tests and the markup read the same words. */
export function cardWords(card: BenchCardProps): CardWords {
  switch (card.kind) {
    case "hidden":
    case "resized": {
      const last = card.attempt >= card.maxAttempts;
      const title = card.kind === "hidden" ? "Paused because you switched away" : "The window changed size";
      const why = card.kind === "hidden" ? "" : "A flight in a different window size cannot be compared. ";
      const text = last
        ? `${why}That was the last try at ${tierName(card.tierIndex)}, so the benchmark moves on to the next flight.`
        : `${why}This flight restarts${card.kind === "hidden" ? " when you are back" : ""} `
          + `(attempt ${card.attempt + 1} of ${card.maxAttempts}).`;
      return { title, text, urgent: true };
    }
    case "failed":
      return { title: `${tierName(card.tierIndex)} stopped`, text: sentence(card.message), urgent: true };
    case "retry":
      return {
        title: null,
        text: `The last try at ${tierName(card.tierIndex)} ${retryReason(card.previous)}. `
          + `Trying again (attempt ${card.attempt} of ${card.maxAttempts}).`,
        urgent: false,
      };
    case "notice":
      return { title: null, text: noticeText(card.notice), urgent: false };
  }
}

/**
 * One card. The urgent ones sit in the middle of the screen as alerts; the
 * notes sit under the run chip as polite status lines. Neither takes focus:
 * the page goes on by itself, and a card only says why.
 */
export function BenchCard(props: BenchCardProps) {
  const words = cardWords(props);
  const countdown = props.kind === "hidden" || props.kind === "resized" || props.kind === "failed"
    ? props.continueInS
    : null;
  const onContinue = props.kind === "hidden" || props.kind === "resized" || props.kind === "failed"
    ? props.onContinue
    : undefined;
  return (
    <div
      className={`bench-card ${words.urgent ? "bench-card--alert" : "bench-card--note"}`}
      role={words.urgent ? "alert" : "status"}
      data-bench-ui=""
    >
      {words.title ? <strong>{words.title}</strong> : null}
      <span>{words.text}</span>
      {countdown !== null && countdown !== undefined ? (
        <small>{countdown > 0 ? `Continuing in ${Math.ceil(countdown)} s.` : "Continuing…"}</small>
      ) : null}
      {onContinue ? (
        <button type="button" className="bench-action" onClick={onContinue}>
          Continue now
        </button>
      ) : null}
    </div>
  );
}

/**
 * The step page's cards: the notes in a column under the run chip, the
 * alerts in the middle of the screen, each group in the order given.
 */
export function BenchCards({ cards }: { readonly cards: readonly BenchCardProps[] }) {
  const notes = cards.filter((card) => !cardWords(card).urgent);
  const alerts = cards.filter((card) => cardWords(card).urgent);
  return (
    <>
      {notes.length > 0 ? (
        <div className="bench-cards bench-cards--notes">
          {notes.map((card, index) => <BenchCard key={`${card.kind}-${index}`} {...card} />)}
        </div>
      ) : null}
      {alerts.length > 0 ? (
        <div className="bench-cards bench-cards--alerts">
          {alerts.map((card, index) => <BenchCard key={`${card.kind}-${index}`} {...card} />)}
        </div>
      ) : null}
    </>
  );
}
