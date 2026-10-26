import { useState } from "react";
import { parseBenchTiers } from "@/src/settings";
import { USER_LABEL_MAX, noticeText } from "../flow";
import { benchTimings, estimateBenchDuration, type BenchUrlOptions } from "../plan";
import { describeBrowser, describeGpu, describeOs } from "../report";
import type {
  BenchDeviceReport,
  BenchMode,
  BenchNoticeCode,
  BenchRefresh,
  BenchRunRecord,
  BenchWebGpuStatus,
} from "../types";
import { BenchDialog } from "./BenchDialog";
import { durationText, flightCountText, tierListText } from "./words";

/** What the intro starts with: the page's options or Advanced's edits, and the typed label. */
export interface BenchIntroChoice {
  readonly options: BenchUrlOptions;
  /** "Your computer" as typed; `benchUserLabel` trims and caps it. */
  readonly userLabel: string;
}

export interface BenchIntroProps {
  /** The tiers, mode, HUD and quick flags this page's URL asked for. */
  readonly options: BenchUrlOptions;
  /** "unavailable": the tab cannot keep progress between reloads, so only a device report is possible. */
  readonly storage: "ok" | "unavailable";
  /** Null while the device check runs, or if it found nothing. */
  readonly device: BenchDeviceReport | null;
  /** The intro's idle refresh probe; null while it runs. */
  readonly refresh: BenchRefresh | null;
  /** The device check or the refresh probe is still running: Start waits for both. */
  readonly checking: boolean;
  /** An unfinished run of this tab, offered as Resume or Start over. */
  readonly resumable: BenchRunRecord | null;
  readonly notice: BenchNoticeCode | null;
  /** Something the page is doing for a button (saving, leaving): every button waits. */
  readonly busy?: boolean;
  readonly onStart: (choice: BenchIntroChoice) => void;
  readonly onResume: () => void;
  readonly onDeviceOnly: (choice: BenchIntroChoice) => void;
  /** "Back to the game". */
  readonly onExit: () => void;
}

const WEBGPU_PROBLEMS: Readonly<Record<Exclude<BenchWebGpuStatus, "ok">, { readonly title: string; readonly text: string }>> = {
  missing: {
    title: "This browser has no WebGPU",
    text: "The game draws with WebGPU, and this browser does not offer it. Try the latest Chrome or Edge.",
  },
  "no-adapter": {
    title: "No graphics card found",
    text: "The browser has WebGPU but could not find a graphics card to use. Graphics acceleration may be "
      + "turned off in the browser's settings, or the graphics driver may be blocked.",
  },
  "fallback-only": {
    title: "Only a software stand-in for the graphics card",
    text: "The browser offers WebGPU only through the processor, which is far too slow for the game.",
  },
  "limits-short": {
    title: "The graphics card is missing features the game needs",
    text: "The browser found a graphics card, but it falls short of what the game asks for.",
  },
};

const STORAGE_PROBLEM = {
  title: "This tab cannot save the benchmark's progress",
  text: "The benchmark reloads the page between flights and keeps its progress in this tab's site data, "
    + "which the browser is blocking. A private window, or site data turned off, does this. Use a normal "
    + "window, or allow site data for this site, then reload this page.",
};

const MODE_CHOICES: readonly { readonly value: BenchMode; readonly label: string; readonly hint: string }[] = [
  {
    value: "shipped",
    label: "As players get it",
    hint: "The game adjusts its own resolution and detail, as it does for every player.",
  },
  {
    value: "pinned",
    label: "GPU comparison",
    hint: "A fixed resolution for each quality, with graphics card timing. For comparing graphics cards, "
      + "not for judging smoothness.",
  },
];

/**
 * What the problem card can add to its own words: for a graphics card short
 * of a limit, which limits, as "maxStorageBuffersPerShaderStage: 8, needs
 * 10". The device report's `reason` only says the card's text again.
 */
function limitShortfallText(device: BenchDeviceReport | null): string | null {
  const shortfalls = device?.webgpu.limitShortfalls ?? [];
  if (shortfalls.length === 0) return null;
  return shortfalls.map((entry) => `${entry.limit}: ${entry.reported}, needs ${entry.required}`).join("; ");
}

/** "1920 × 1080, 125% scaling". */
function screenText(device: BenchDeviceReport): string {
  const { width, height, devicePixelRatio } = device.screen;
  const scaling = devicePixelRatio && devicePixelRatio !== 1 ? `, ${Math.round(devicePixelRatio * 100)}% scaling` : "";
  return `${width} × ${height}${scaling}`;
}

function DeviceCard({ device, refresh, checking }: Pick<BenchIntroProps, "device" | "refresh" | "checking">) {
  const pending = checking ? "Checking…" : "Unknown";
  const rows: [string, string][] = [
    ["Graphics", device ? describeGpu(device) : pending],
    ["Browser", device ? describeBrowser(device) : pending],
    ["System", device ? describeOs(device) : pending],
    ["Screen", device ? screenText(device) : pending],
    ["Frame rate", refresh ? `${Math.round(refresh.rafHz)} Hz` : checking ? "Measuring…" : "Unknown"],
  ];
  if (device?.hardwareConcurrency) rows.push(["Processor", `${device.hardwareConcurrency} threads`]);
  if (device?.deviceMemoryGiB) {
    // Browsers round the memory down and stop at 8 GB.
    rows.push(["Memory", device.deviceMemoryGiB >= 8 ? "8 GB or more" : `${device.deviceMemoryGiB} GB`]);
  }
  return (
    <section className="bench-section bench-device" aria-labelledby="bench-intro-device-title">
      <h3 id="bench-intro-device-title">This computer</h3>
      <dl>
        {rows.map(([name, value]) => (
          <div key={name}>
            <dt>{name}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

/**
 * The intro page: what the benchmark does and how long it takes, what to do
 * first, this computer as the browser describes it, the optional "Your
 * computer" label, and an Advanced section for the tier list and mode. It
 * becomes an explanation and a device-only report button when WebGPU or the
 * tab's storage is missing, and offers Resume or Start over when this tab
 * already has an unfinished run. It decides nothing itself: every button
 * calls back with what the person chose.
 */
export function BenchIntro(props: BenchIntroProps) {
  const { options, storage, device, resumable, notice, busy = false } = props;
  const [userLabel, setUserLabel] = useState("");
  const [tiersText, setTiersText] = useState(() => options.tiers.join(","));
  const [mode, setMode] = useState<BenchMode>(options.mode);
  const [advancedOpen, setAdvancedOpen] = useState(
    () => options.mode !== "shipped" || options.quick || !options.hud,
  );

  const tiers = parseBenchTiers(tiersText);
  const chosen: BenchUrlOptions = { ...options, tiers: tiers ?? options.tiers, mode };
  const choice: BenchIntroChoice = { options: chosen, userLabel };
  const timings = benchTimings(chosen.quick);
  const duration = estimateBenchDuration(chosen.tiers.length, timings);

  const webgpuStatus = device?.webgpu.status ?? "ok";
  const webgpuProblem = webgpuStatus === "ok" ? null : WEBGPU_PROBLEMS[webgpuStatus];
  const shortfalls = webgpuProblem ? limitShortfallText(device) : null;
  const blocked = storage === "unavailable" || webgpuProblem !== null;
  const resume = !blocked && resumable !== null ? resumable : null;
  const startDisabled = busy || props.checking || tiers === null;

  const description = blocked ? (
    <p>The benchmark cannot run here. You can still make a short report about this computer.</p>
  ) : (
    <p>
      It takes {durationText(duration.typicalS, duration.worstS)}. The game {flightCountText(chosen.tiers.length)} at
      different quality settings and reloads the page between flights. Please do not touch anything until the report appears.
      {chosen.quick ? " This is a quick run for testing: its numbers cannot be compared with a full run." : ""}
    </p>
  );

  return (
    <BenchDialog
      id="bench-intro"
      eyebrow="BENCHMARK"
      title="Test how fly high runs on this computer"
      description={description}
    >
      {notice ? <p className="bench-notice" role="status">{noticeText(notice)}</p> : null}

      {blocked ? (
        <section className="bench-section bench-problems" aria-label="Why the benchmark cannot run">
          {webgpuProblem ? (
            <div className="bench-problem">
              <strong>{webgpuProblem.title}</strong>
              <span>{webgpuProblem.text}</span>
              {shortfalls ? <small>Details: {shortfalls}</small> : null}
            </div>
          ) : null}
          {storage === "unavailable" ? (
            <div className="bench-problem">
              <strong>{STORAGE_PROBLEM.title}</strong>
              <span>{STORAGE_PROBLEM.text}</span>
            </div>
          ) : null}
          <p className="bench-hint">
            A device report lists your browser and graphics card. It helps us see which computers cannot
            run the game.
          </p>
        </section>
      ) : null}

      {resume ? (
        <section className="bench-section bench-resume" aria-labelledby="bench-intro-resume-title">
          <h3 id="bench-intro-resume-title">You have an unfinished benchmark in this tab</h3>
          <p>
            {resume.steps.filter((step) => step.status !== "pending" && step.status !== "running").length} of
            {" "}{resume.steps.length} flights done ({tierListText(resume.plan.tiers)}). Resume it, or start over.
          </p>
        </section>
      ) : null}

      {!blocked ? (
        <section className="bench-section" aria-labelledby="bench-intro-checklist-title">
          <h3 id="bench-intro-checklist-title">Before you start</h3>
          <ul className="bench-checklist">
            <li>Plug in your laptop.</li>
            <li>Maximise the browser window. Full screen ends when the page reloads.</li>
            <li>Close games, video calls and other busy programs.</li>
            <li>Keep this tab in front until the report shows.</li>
          </ul>
        </section>
      ) : null}

      <DeviceCard device={device} refresh={props.refresh} checking={props.checking} />

      <section className="bench-section bench-field">
        <label htmlFor="bench-intro-label">Your computer (GPU model if you know it)</label>
        <input
          id="bench-intro-label"
          type="text"
          maxLength={USER_LABEL_MAX}
          autoComplete="off"
          spellCheck={false}
          placeholder="For example: Dell XPS 15, RTX 3050"
          aria-describedby="bench-intro-label-hint"
          value={userLabel}
          onChange={(event) => setUserLabel(event.target.value)}
        />
        <small id="bench-intro-label-hint">Optional. It goes in the report so we know which computer it was.</small>
      </section>

      {!blocked ? (
        <details
          className="bench-section bench-advanced"
          open={advancedOpen}
          onToggle={(event) => setAdvancedOpen(event.currentTarget.open)}
        >
          <summary>Advanced</summary>
          <div className="bench-field">
            <label htmlFor="bench-intro-tiers">Qualities to fly, in order</label>
            <input
              id="bench-intro-tiers"
              type="text"
              autoComplete="off"
              spellCheck={false}
              aria-invalid={tiers === null}
              aria-describedby="bench-intro-tiers-hint"
              value={tiersText}
              onChange={(event) => setTiersText(event.target.value)}
            />
            <small id="bench-intro-tiers-hint">
              {tiers === null
                ? "Use 1 to 8 numbers from 0 to 3, with commas between them."
                : `${tierListText(tiers)}. 0 is Low, 1 Medium, 2 High, 3 Ultra. Start and end on the same `
                  + "one so the run can check itself."}
            </small>
          </div>
          <fieldset className="bench-modes">
            <legend>Mode</legend>
            {MODE_CHOICES.map((option) => (
              <label key={option.value} className="bench-mode">
                <input
                  type="radio"
                  name="bench-intro-mode"
                  value={option.value}
                  checked={mode === option.value}
                  onChange={() => setMode(option.value)}
                />
                <span>{option.label}</span>
                <small>{option.hint}</small>
              </label>
            ))}
          </fieldset>
          {!options.hud ? <p className="bench-hint">The flight instruments are hidden for this run.</p> : null}
        </details>
      ) : null}

      <div className="bench-panel__footer">
        <p className="bench-privacy">
          The report contains your graphics card, processor, memory, screen size, battery level and whether it
          is charging, your browser and system with their versions (and the device model, where the browser
          gives one), the name you type in Your computer, and the timings the benchmark measures. Nothing is
          sent unless you send it.
        </p>

        <div className="bench-actions">
          {blocked ? (
            <button
              type="button"
              className="bench-action bench-action--primary"
              disabled={busy || props.checking}
              onClick={() => props.onDeviceOnly(choice)}
            >
              Make a device-only report
            </button>
          ) : resume ? (
            <>
              <button
                type="button"
                className="bench-action bench-action--primary"
                disabled={busy}
                onClick={props.onResume}
              >
                Resume
              </button>
              <button
                type="button"
                className="bench-action"
                disabled={startDisabled}
                onClick={() => props.onStart(choice)}
              >
                Start over
              </button>
            </>
          ) : (
            <button
              type="button"
              className="bench-action bench-action--primary"
              disabled={startDisabled}
              onClick={() => props.onStart(choice)}
            >
              Start benchmark
            </button>
          )}
          <button type="button" className="bench-action" disabled={busy} onClick={props.onExit}>
            Back to the game
          </button>
        </div>
      </div>
    </BenchDialog>
  );
}
