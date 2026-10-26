import { useEffect, useMemo, useRef, useState } from "react";
import { noticeText } from "../flow";
import {
  REPORT_TABLE_COLUMNS,
  compactReportJson,
  deviceLine,
  issueUrl,
  reportFileName,
  reportTableRows,
  smoothnessText,
  summaryMarkdown,
  verdictText,
} from "../report";
import type { BenchNoticeCode, BenchReport, BenchReportRun, BenchReportStep, BenchSmoothness } from "../types";
import { BenchDialog } from "./BenchDialog";
import { decimalText, fpsText, tierName } from "./words";

/** What a copy button put on the clipboard. */
export type BenchCopyTarget = "report" | "summary" | "issue";

/** The last copy and how it went, as the page learnt from the clipboard. */
export interface BenchCopyState {
  readonly target: BenchCopyTarget;
  readonly status: "copied" | "failed";
  /** The text meant for the clipboard, shown read-only to copy by hand when that failed. */
  readonly text: string;
}

export interface BenchReportDialogProps {
  readonly report: BenchReport;
  readonly notice: BenchNoticeCode | null;
  /** Null before the first copy. */
  readonly copy: BenchCopyState | null;
  /** Something the page is doing for a button (saving, leaving): the run buttons wait. */
  readonly busy?: boolean;
  /** Save the full report as `reportFileName(report)`. */
  readonly onDownload: () => void;
  /**
   * Put `text` on the clipboard. Called synchronously inside the click, the
   * issue link's included, so the page can start `clipboard.writeText` while
   * the click still counts as the person's: nothing may be awaited first.
   */
  readonly onCopy: (target: BenchCopyTarget, text: string) => void;
  /** "Run the GPU comparison pass": the same tiers again, pinned, keeping this run. */
  readonly onPinnedPass: () => void;
  /** "Run again", after the person confirmed this report will be replaced. */
  readonly onRunAgain: () => void;
  readonly onExit: () => void;
}

const SMOOTHNESS_LEGEND = "Smooth: at most 1 slow frame in 240. Mostly smooth: up to 6. Choppy: more than that. "
  + "A slow frame takes longer than 27.4 ms (60 ms on Ultra), which shows as a stutter.";

const COPY_DONE: Readonly<Record<BenchCopyTarget, string>> = {
  report: "Report copied. Paste it wherever you like.",
  summary: "Short summary copied. Paste it into a chat.",
  issue: "Report copied. Paste it into the empty block in the GitHub issue.",
};

/** A run that flew nothing: the browser had no WebGPU, or the tab no storage. */
function deviceOnly(run: BenchReportRun): boolean {
  return run.status === "no-webgpu" || run.status === "storage-unavailable";
}

function verdictBannerText(run: BenchReportRun): string {
  if (run.status === "no-webgpu") {
    return "Device report only: this browser cannot run the game, so no flights ran. "
      + "The report describes this computer.";
  }
  if (run.status === "storage-unavailable") {
    return "Device report only: this tab cannot keep the benchmark's progress, so no flights ran. "
      + "The report describes this computer.";
  }
  return verdictText(run);
}

function VerdictBanner({ run }: { readonly run: BenchReportRun }) {
  const kind = deviceOnly(run) ? "device" : run.verdict;
  return (
    <p className={`bench-verdict bench-verdict--${kind}`}>{verdictBannerText(run)}</p>
  );
}

/** "Medium: Smooth" for each tier flown, worst step counting. */
function TierLabels({ run, steps }: { readonly run: BenchReportRun; readonly steps: readonly BenchReportStep[] }) {
  if (run.tierLabels.length === 0) return null;
  const limitedHz = (tierIndex: number) =>
    steps.find((step) => step.tierIndex === tierIndex && step.label === "limited")?.result?.raf.idleHz ?? null;
  return (
    <dl className="bench-labels">
      {run.tierLabels.map((entry) => (
        <div key={entry.tierIndex} className={`bench-label bench-label--${entry.label}`}>
          <dt>{tierName(entry.tierIndex)}</dt>
          <dd>{smoothnessText(entry.label, limitedHz(entry.tierIndex))}</dd>
        </div>
      ))}
    </dl>
  );
}

function labelClass(label: BenchSmoothness): string {
  return `bench-label--${label}`;
}

/**
 * One row per flight: the plain label first, then the air window (the
 * headline) and the runway window side by side. Slow frames are counted
 * against the quality's own threshold, the one its label and the legend use
 * (60 ms on Ultra); "All numbers" keeps the 27.4 ms count. The table scrolls sideways
 * inside its own box on a narrow screen, never the page, so the label stays
 * in view and the numbers follow.
 */
function StepTable({ steps, caption }: { readonly steps: readonly BenchReportStep[]; readonly caption: string }) {
  const rows = reportTableRows(steps);
  const firstMarked = rows.some((row) => row.firstRendererInTab);
  return (
    <div className="bench-table-wrap">
      <table className="bench-table">
        <caption>{caption}</caption>
        <thead>
          <tr>
            <th scope="col">Flight</th>
            <th scope="col">Quality</th>
            <th scope="col">Result</th>
            <th scope="col">In the air</th>
            <th scope="col">Slow frames in the air</th>
            <th scope="col">On the runway</th>
            <th scope="col">Slow frames on the runway</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => {
            const windows = steps[index]?.result?.windows;
            return (
              <tr key={row.stepIndex}>
                <th scope="row">{row.stepIndex + 1}</th>
                <td>{row.tierName}{row.firstRendererInTab ? " *" : ""}</td>
                <td className={labelClass(row.label)}>{row.cells[REPORT_TABLE_COLUMNS.length - 1]}</td>
                <td>{fpsText(row.fps)}</td>
                <td>{decimalText(windows?.air?.over.hitch.per240)}</td>
                <td>{fpsText(row.groundFps)}</td>
                <td>{decimalText(windows?.ground?.over.hitch.per240)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <p className="bench-hint">
        Slow frames are counted per 240 frames, about 4 seconds at 60 fps. Lower is better.
        {firstMarked ? " * The first flight also prepares the graphics, so it can be a little slower." : ""}
      </p>
    </div>
  );
}

/** Every column the summary and the issue use, for whoever reads the numbers closely. */
function AllNumbers({ steps }: { readonly steps: readonly BenchReportStep[] }) {
  const rows = reportTableRows(steps);
  return (
    <details className="bench-section bench-details">
      <summary>All numbers</summary>
      <div className="bench-table-wrap">
        <table className="bench-table bench-table--dense">
          <thead>
            <tr>
              {REPORT_TABLE_COLUMNS.map((column) => <th key={column} scope="col">{column}</th>)}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.stepIndex}>
                {row.cells.map((cell, column) => (column === 0
                  ? <th key={column} scope="row">{cell}</th>
                  : <td key={column}>{cell}</td>))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );
}

function Warnings({ run }: { readonly run: BenchReportRun }) {
  if (run.warnings.length === 0) return null;
  return (
    <details className="bench-section bench-details">
      <summary>Things to know ({run.warnings.length})</summary>
      <ul className="bench-warnings">
        {run.warnings.map((warning, index) => <li key={`${warning.code}-${index}`}>{warning.message}</li>)}
      </ul>
    </details>
  );
}

function modeText(run: BenchReportRun): string {
  return run.plan.mode === "pinned" ? "GPU comparison" : "as players get it";
}

/** The copy that failed, read-only and selected, to copy by hand. */
function CopyFallback({ copy }: { readonly copy: BenchCopyState }) {
  const areaRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    areaRef.current?.focus();
    areaRef.current?.select();
  }, [copy]);
  return (
    <div className="bench-section bench-fallback">
      <label htmlFor="bench-report-fallback">
        The browser would not let the page copy. Select this text and copy it yourself (Ctrl+C, or ⌘C on a Mac).
      </label>
      <textarea
        id="bench-report-fallback"
        ref={areaRef}
        readOnly
        rows={8}
        spellCheck={false}
        value={copy.text}
        onFocus={(event) => event.currentTarget.select()}
      />
    </div>
  );
}

/**
 * The report page: the verdict, what each tier felt like, a row per flight,
 * the warnings, any earlier run of this tab, and the ways to keep or send the
 * report. The download is the main route: it holds everything. The issue
 * link is an `<a target=_blank>` so no pop-up blocker stands in the way, and
 * copies the compact report in the same click (critique S4). Run again asks
 * first, because it replaces this report.
 */
export function BenchReportDialog(props: BenchReportDialogProps) {
  const { report, notice, copy, busy = false } = props;
  const [confirmRunAgain, setConfirmRunAgain] = useState(false);
  const runAgainCancelRef = useRef<HTMLButtonElement>(null);
  const run = report.run;
  const flown = !deviceOnly(run);
  const canFlyAgain = run.status === "finished" || run.status === "stopped";
  const issueHref = useMemo(() => issueUrl(report), [report]);
  const compactJson = useMemo(() => compactReportJson(report), [report]);

  useEffect(() => {
    if (confirmRunAgain) runAgainCancelRef.current?.focus();
  }, [confirmRunAgain]);

  return (
    <BenchDialog
      id="bench-report"
      eyebrow="BENCHMARK REPORT"
      title="Results"
      description={<p>{deviceLine(report)}</p>}
      {...(confirmRunAgain ? { onEscape: () => setConfirmRunAgain(false) } : {})}
    >
      {notice ? <p className="bench-notice" role="status">{noticeText(notice)}</p> : null}

      <VerdictBanner run={run} />
      {run.plan.mode === "pinned" ? (
        <p className="bench-hint">
          GPU comparison run: a fixed resolution for each quality, with graphics card timing. Use it to compare
          graphics cards, not to judge smoothness.
        </p>
      ) : null}
      {run.nonStandard ? (
        <p className="bench-hint">Quick run, for testing: its numbers cannot be compared with a full run.</p>
      ) : null}

      {flown ? (
        <>
          <section className="bench-section" aria-labelledby="bench-report-labels-title">
            <h3 id="bench-report-labels-title">How it felt</h3>
            <TierLabels run={run} steps={report.steps} />
            <p className="bench-hint">{SMOOTHNESS_LEGEND}</p>
          </section>
          <StepTable steps={report.steps} caption="Each flight" />
          <AllNumbers steps={report.steps} />
        </>
      ) : null}
      <Warnings run={run} />

      {report.earlierRuns.map((earlier) => (
        <section key={earlier.run.id} className="bench-section bench-earlier">
          <h3>Earlier run in this tab ({modeText(earlier.run)})</h3>
          <VerdictBanner run={earlier.run} />
          {deviceOnly(earlier.run) ? null : <StepTable steps={earlier.steps} caption="Each flight of the earlier run" />}
        </section>
      ))}

      <div className="bench-actions bench-actions--report">
        <button type="button" className="bench-action bench-action--primary" onClick={props.onDownload}>
          Download report (.json)
        </button>
        <a
          className="bench-action"
          href={issueHref}
          target="_blank"
          rel="noopener"
          aria-describedby="bench-report-issue-hint"
          onClick={() => props.onCopy("issue", compactJson)}
        >
          Open GitHub issue
        </a>
        <button type="button" className="bench-action" onClick={() => props.onCopy("report", compactJson)}>
          Copy report
        </button>
        <button type="button" className="bench-action" onClick={() => props.onCopy("summary", summaryMarkdown(report))}>
          Copy short summary
        </button>
        {canFlyAgain && run.plan.mode === "shipped" ? (
          <button
            type="button"
            className="bench-action"
            disabled={busy}
            aria-describedby="bench-report-pinned-hint"
            onClick={props.onPinnedPass}
          >
            Run the GPU comparison pass
          </button>
        ) : null}
        {canFlyAgain ? (
          <button
            type="button"
            className="bench-action"
            disabled={busy || confirmRunAgain}
            onClick={() => setConfirmRunAgain(true)}
          >
            Run again
          </button>
        ) : null}
        <button type="button" className="bench-action" disabled={busy} onClick={props.onExit}>
          Exit
        </button>
      </div>

      {confirmRunAgain ? (
        <div className="bench-confirm" role="group" aria-labelledby="bench-report-run-again">
          <span id="bench-report-run-again">
            Run again? This report will be replaced. Download it first if you want to keep it.
          </span>
          <button type="button" className="bench-action bench-action--danger" disabled={busy} onClick={props.onRunAgain}>
            Run again
          </button>
          <button
            ref={runAgainCancelRef}
            type="button"
            className="bench-action"
            onClick={() => setConfirmRunAgain(false)}
          >
            Cancel
          </button>
        </div>
      ) : null}

      <p className="bench-report__status" role="status">
        {copy?.status === "copied" ? COPY_DONE[copy.target] : ""}
      </p>
      {copy?.status === "failed" ? <CopyFallback copy={copy} /> : null}

      <div className="bench-hints">
        <p id="bench-report-issue-hint" className="bench-hint">
          Open GitHub issue copies the report and opens a new issue in another tab. Sign in to GitHub, then paste
          the report into the empty block, or attach the downloaded file ({reportFileName(report)}).
        </p>
        {canFlyAgain && run.plan.mode === "shipped" ? (
          <p id="bench-report-pinned-hint" className="bench-hint">
            The GPU comparison pass flies the same qualities again at a fixed resolution and times the graphics
            card. This report is kept, and both go in one file.
          </p>
        ) : null}
      </div>

      <p className="bench-privacy">
        Nothing has been sent. The buttons above save or copy the report; you choose where it goes.
      </p>
    </BenchDialog>
  );
}
