/**
 * Source text for guards that assert on the tree, with comments removed.
 *
 * **WHY THIS EXISTS, and it is not tidiness.** 52 test files read source with
 * `readFileSync`; before this helper, **41 of them searched the raw text**. A
 * guard that does not strip comments is asserting on the prose as well as the
 * code, and the failure is not incidental — it is structural:
 *
 * > **A comment that explains a defect necessarily NAMES it.** So the very
 * > files most likely to be searched for a forbidden identifier are the ones
 * > whose docblocks explain why it is forbidden.
 *
 * Five instances were found in one evening across three sessions. The worst was
 * a live decision: a guard titled *"7-9: PCSS stays declined"* asserted that
 * `FILTER_PCF` appears in `QualityProfile.ts`, where it occurs **exactly once,
 * inside a comment**. The real assignment is in `AtmosphereSystem.ts`. Change
 * the shipped filter and that guard stays green.
 *
 * One of them was mine, in the other direction: a regex hunting a removed
 * vacuous assertion matched the comment *explaining* the vacuity that had just
 * been removed, and reported a stale file as current.
 *
 * **KNOWN LIMIT, stated because a helper's limits are load-bearing when 41
 * guards depend on it.** This is a lexer-free regex strip. It removes `//` and
 * comment blocks wherever they appear, INCLUDING inside string literals and
 * regex literals. A guard searching for a string that itself contains `//` or
 * `/*` must not use this — `rawSource` is provided for that case, and using it
 * should be a deliberate, commented choice.
 *
 * The `(^|[^:])` guard on the line-comment rule spares `https://`, which is the
 * one in-string case common enough to be worth handling.
 */
import { readFileSync } from "node:fs";
import type { PathOrFileDescriptor } from "node:fs";

/**
 * Block and line comments replaced with a space, so a mention in prose cannot
 * satisfy an assertion about code.
 *
 * Replaced with a SPACE rather than the empty string, deliberately: removing
 * `/**\/` between two identifiers would fuse them into a third that appears
 * nowhere in the file.
 */
export function stripComments(code: string): string {
  return code
    .replace(/\/\*[\s\S]*?\*\//gu, " ")
    .replace(/(^|[^:])\/\/[^\n]*/gu, "$1 ");
}

/** A source file's text with comments stripped. The default for guards. */
export function readSource(path: PathOrFileDescriptor | URL): string {
  return stripComments(readFileSync(path as PathOrFileDescriptor, "utf8"));
}

/**
 * A source file's text UNCHANGED, comments included.
 *
 * **Use this only where a guard deliberately anchors on prose**, and say so at
 * the call site. At least one guard legitimately does: a note asserting that a
 * recorded finding stays recorded is *about* the comment, and stripping it
 * would make the guard assert nothing. That is a correct use and it should be
 * visible as a choice rather than looking like an oversight — which is exactly
 * what it looked like while all 41 read raw text.
 */
export function rawSource(path: PathOrFileDescriptor | URL): string {
  return readFileSync(path as PathOrFileDescriptor, "utf8");
}
