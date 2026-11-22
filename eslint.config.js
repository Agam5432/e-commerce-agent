// Lint: the rules that catch real bugs (undefined names, unreachable code, duplicate keys, unused
// variables, ...), not style. `npm run lint` runs it; CI fails on any error.
import js from "@eslint/js";
import globals from "globals";

export default [
  { ignores: ["node_modules/**", "src/public/admin/vendor/**", "coverage/**", "shopify-app/**", "e2e-output/**", "scripts/e2e-support.mjs", "scripts/e2e-shopper.mjs", "scripts/live-llm-support.mjs"] }, // these run page code inside a browser
  js.configs.recommended,
  {
    files: ["**/*.js", "**/*.mjs"],
    languageOptions: { ecmaVersion: 2024, sourceType: "module", globals: { ...globals.node } },
    rules: {
      "no-unused-vars": ["error", { args: "none", caughtErrors: "none", ignoreRestSiblings: true, varsIgnorePattern: "^_" }],
      "no-empty": ["error", { allowEmptyCatch: true }],
      // stripping control characters from shopper input is deliberate
      "no-control-regex": "off",
    },
  },
  {
    files: ["src/public/**/*.js"],
    languageOptions: { globals: { ...globals.browser } },
  },
];
