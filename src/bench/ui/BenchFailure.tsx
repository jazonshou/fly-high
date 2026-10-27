import { BenchDialog } from "./BenchDialog";

export interface BenchFailureProps {
  /** What went wrong, as the browser put it. */
  readonly message: string;
  /** Null when nothing was saved to download. */
  readonly onDownload: (() => void) | null;
  readonly onStartOver: () => void;
  readonly onExit: () => void;
}

/**
 * A bench page that could not set itself up, most likely because a saved run
 * holds something this version of the game cannot read (it was updated
 * while the run went on). Bench pages hide the game's own error banner, so
 * without this the page would be blank, with no way out.
 */
export function BenchFailure({ message, onDownload, onStartOver, onExit }: BenchFailureProps) {
  return (
    <BenchDialog
      id="bench-failure"
      eyebrow="BENCHMARK"
      title="This page could not open"
      description={(
        <p>
          The saved run could not be read, perhaps because the game was updated while it ran. Start over clears it
          and opens the benchmark&apos;s first page; Exit returns to the game.
        </p>
      )}
    >
      <p className="bench-hint"><small>Details: {message}</small></p>
      <div className="bench-actions">
        <button type="button" className="bench-action bench-action--primary" onClick={onStartOver}>
          Start over
        </button>
        {onDownload ? (
          <button type="button" className="bench-action" onClick={onDownload}>
            Download what was saved
          </button>
        ) : null}
        <button type="button" className="bench-action" onClick={onExit}>
          Exit
        </button>
      </div>
    </BenchDialog>
  );
}
