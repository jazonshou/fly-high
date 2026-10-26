import { BenchCards, type BenchCardProps } from "./BenchCards";
import { BenchChip, type BenchChipProps } from "./BenchChip";
import { BenchFailure, type BenchFailureProps } from "./BenchFailure";
import { BenchHud, type BenchHudProps } from "./BenchHud";
import { BenchIntro, type BenchIntroProps } from "./BenchIntro";
import { BenchReportDialog, type BenchReportDialogProps } from "./BenchReportDialog";

/**
 * The marker on every bench element a person can reach. The step page's key
 * blocker lets Tab, Enter, Space and Escape through only to targets inside
 * it; `isInsideBenchUi` is that test, ready to hand to the blocker.
 */
export const BENCH_UI_ATTRIBUTE = "data-bench-ui";

export function isInsideBenchUi(target: EventTarget | null): boolean {
  return typeof Element !== "undefined"
    && target instanceof Element
    && target.closest(`[${BENCH_UI_ATTRIBUTE}]`) !== null;
}

/**
 * What the bench's React root shows. The session builds it from the flow's
 * page and what it has measured, and renders the root again whenever it
 * changes: once a second for the chip, or every 75 ms on a step page whose
 * HUD is on.
 */
export type BenchView =
  | { readonly kind: "intro"; readonly intro: BenchIntroProps }
  | {
    readonly kind: "step";
    readonly chip: BenchChipProps;
    readonly cards: readonly BenchCardProps[];
    /** Null for `hud=0`. */
    readonly hud: BenchHudProps | null;
  }
  | { readonly kind: "report"; readonly report: BenchReportDialogProps }
  /** The page threw while it set itself up. */
  | { readonly kind: "failed"; readonly failure: BenchFailureProps }
  /** A redirect is under way: nothing to show. */
  | { readonly kind: "none" };

/**
 * The bench's pages in one component: the intro dialog, the step page's chip,
 * cards and HUD, the report dialog, or a page that could not open. Props in,
 * callbacks out: it holds no run state, reads no storage and never touches
 * the renderer.
 */
export function BenchApp({ view }: { readonly view: BenchView }) {
  switch (view.kind) {
    case "intro":
      return <BenchIntro {...view.intro} />;
    case "step":
      return (
        <>
          <BenchChip {...view.chip} />
          <BenchCards cards={view.cards} />
          {view.hud ? <BenchHud {...view.hud} /> : null}
        </>
      );
    case "report":
      return <BenchReportDialog {...view.report} />;
    case "failed":
      return <BenchFailure {...view.failure} />;
    case "none":
      return null;
  }
}
