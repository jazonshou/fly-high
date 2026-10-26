/**
 * The commit a GitHub Pages build was made from, which `vite.static.config.ts`
 * defines from GITHUB_SHA (null for a local Pages build). The Worker build,
 * the dev server and vitest define nothing, so read it only behind
 * `typeof __FLY_HIGH_COMMIT__ === "string"`.
 */
declare const __FLY_HIGH_COMMIT__: string | null | undefined;
