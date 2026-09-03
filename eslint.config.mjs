import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Retained agent worktrees contain historical copies of the project. They
    // are useful evidence, but linting them multiplies every warning and can
    // report files that are not part of this checkout.
    ".claude/worktrees/**",
  ]),
]);

export default eslintConfig;
