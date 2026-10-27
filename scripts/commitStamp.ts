import type { HtmlTagDescriptor, Plugin } from "vite";

/**
 * The `<meta>` that names the commit a GitHub Pages build was made from, for
 * the `?bench=1` reports (`buildCommit` in src/bench/device.ts reads it).
 *
 * The commit goes into index.html and nowhere else. index.html changes on
 * every deploy anyway, but a hashed chunk that held the commit would change
 * its name on every deploy, and so would every chunk that imports it: a
 * docs-only push would hand returning players a whole new bundle.
 */
export const COMMIT_META_NAME = "fly-high-commit";

/** The tag for `commit`, or none for a build that has no commit (a local one). */
export function commitMetaTags(commit: string | undefined): HtmlTagDescriptor[] {
  if (commit === undefined || commit === "") return [];
  return [{ tag: "meta", attrs: { name: COMMIT_META_NAME, content: commit }, injectTo: "head" }];
}

/** Writes {@link commitMetaTags} into the page's head. */
export function commitStamp(commit: string | undefined): Plugin {
  return {
    name: "fly-high-commit-stamp",
    transformIndexHtml: () => commitMetaTags(commit),
  };
}
