import { defineConfig, globalIgnores } from "eslint/config";
import react from "eslint-plugin-react";
import reactHooks from "eslint-plugin-react-hooks";
import globals from "globals";
import tseslint from "typescript-eslint";

// The rules the project linted with under eslint-config-next, minus the
// Next.js plugin: typescript-eslint's recommended set, React's, and the hooks
// rules.
const eslintConfig = defineConfig([
  {
    files: ["**/*.{js,jsx,mjs,ts,tsx,mts,cts}"],
    plugins: { react, "react-hooks": reactHooks },
    languageOptions: {
      globals: { ...globals.browser, ...globals.node },
    },
    settings: { react: { version: "detect" } },
    rules: {
      ...react.configs.recommended.rules,
      ...reactHooks.configs.recommended.rules,
      "react/no-unknown-property": "off",
      "react/react-in-jsx-scope": "off",
      "react/prop-types": "off",
      "react/jsx-no-target-blank": "off",
    },
  },
  ...tseslint.configs.recommended,
  {
    rules: {
      "@typescript-eslint/no-unused-vars": "warn",
      "@typescript-eslint/no-unused-expressions": "warn",
    },
  },
  globalIgnores([
    "dist/**",
    "dist-pages/**",
    // Left behind in older checkouts by the removed Next.js / Cloudflare build.
    ".next/**",
    ".vinext/**",
    ".wrangler/**",
    // Retained agent worktrees contain historical copies of the project. They
    // are useful evidence, but linting them multiplies every warning and can
    // report files that are not part of this checkout.
    ".claude/worktrees/**",
  ]),
]);

export default eslintConfig;
