import {
  useEffect,
  useRef,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from "react";
import { modalTabTarget } from "@/src/ui/modalFocus";

const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "textarea",
  "summary",
  '[tabindex]:not([tabindex="-1"])',
].join(",");

interface BenchDialogProps {
  /** Prefix of the dialog's element ids: `<id>-title`, `<id>-description`. */
  readonly id: string;
  readonly eyebrow: string;
  readonly title: string;
  readonly description: ReactNode;
  /** Escape inside the dialog. Nothing by default: the page has nothing behind it to return to. */
  readonly onEscape?: () => void;
  readonly children: ReactNode;
}

/**
 * The intro's and the report's modal panel, on SettingsDialog's pattern: it
 * takes focus when it mounts so a screen reader reads its title and
 * description first, keeps Tab inside, and stops every key from reaching the
 * game's window listeners. The panel itself focuses rather than a button, so
 * an Enter pressed out of habit starts nothing.
 */
export function BenchDialog({ id, eyebrow, title, description, onEscape, children }: BenchDialogProps) {
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    panelRef.current?.focus();
  }, []);

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLElement>) => {
    event.stopPropagation();
    if (event.key === "Escape") {
      if (!onEscape) return;
      event.preventDefault();
      onEscape();
      return;
    }
    if (event.key !== "Tab") return;
    const focusable = Array.from(
      panelRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR) ?? [],
    ).filter((element) => element.tabIndex >= 0 && element.getClientRects().length > 0);
    if (focusable.length === 0) {
      event.preventDefault();
      panelRef.current?.focus();
      return;
    }
    const target = modalTabTarget(
      focusable,
      document.activeElement instanceof HTMLElement ? document.activeElement : null,
      event.shiftKey,
    );
    if (target) {
      event.preventDefault();
      target.focus();
    }
  };

  return (
    <section className="bench-screen" onKeyDown={handleKeyDown} data-bench-ui="">
      <div
        id={id}
        ref={panelRef}
        className="bench-panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${id}-title`}
        aria-describedby={`${id}-description`}
        tabIndex={-1}
      >
        <header className="bench-panel__header">
          <p>{eyebrow}</p>
          <h2 id={`${id}-title`}>{title}</h2>
          <div id={`${id}-description`} className="bench-panel__description">{description}</div>
        </header>
        {children}
      </div>
    </section>
  );
}
