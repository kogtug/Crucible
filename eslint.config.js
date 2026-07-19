// @ts-check
import js from "@eslint/js";
import tseslint from "typescript-eslint";
import eslintConfigPrettier from "eslint-config-prettier";

export default tseslint.config(
  {
    ignores: ["**/dist/**", "**/node_modules/**", "**/*.js", "**/*.d.ts"],
  },
  {
    files: ["packages/**/*.ts"],
    extends: [
      js.configs.recommended,
      ...tseslint.configs.recommendedTypeChecked,
      ...tseslint.configs.stylisticTypeChecked,
    ],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // The rule this whole setup most wanted: every async fixture/chaos
      // bug this repo has hit so far (the module-level BREAK_MODE capture,
      // the close() hang on an already-exited process) was the kind of
      // thing this rule class exists to catch mechanically.
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": "error",

      // Deliberately off rather than tuned: this codebase's style is
      // "narrate the reasoning in a comment," and a chatty style is a
      // false positive machine against block comments this long.
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],

      // require/no-require-imports is CJS-era; everything here is ESM.
      "@typescript-eslint/no-require-imports": "off",

      // Not part of eslint:recommended by default. Library code
      // (core/conformance/chaos) writing to the console would almost
      // always be a stray debug statement, not a feature - the
      // console.log/error calls that genuinely belong here (fixtures
      // speaking their protocol, the CLI reporting results) get an
      // explicit override below, in the one place each of them lives.
      "no-console": "error",

      // Every Check/ModernCheck/ChaosScenario/tool-callback's run() is
      // async because the *interface* returns a Promise (some checks poll
      // or make network calls; others just inspect data already in hand).
      // Flagging the ones that happen not to await anything internally
      // would mean either a pointless `await Promise.resolve()` or
      // splitting each check into a sync/async variant depending on what
      // it happens to need today - worse in both cases than just not
      // requiring it.
      "@typescript-eslint/require-await": "off",
    },
  },
  {
    // node:test's test(name, fn) does return a Promise, but the runner
    // manages awaiting it internally - the idiomatic way to register a
    // test is exactly the un-awaited top-level call this rule would
    // otherwise flag on every single test in the repo.
    files: ["packages/**/*.test.ts"],
    rules: {
      "@typescript-eslint/no-floating-promises": "off",
    },
  },
  // Fixture entry points and CLI scripts legitimately use console.log/error
  // for their actual job (writing protocol messages, reporting results) -
  // not debug output left behind by accident.
  {
    files: ["packages/fixtures/**/*.ts", "packages/cli/**/*.ts"],
    rules: {
      "no-console": "off",
    },
  },
  eslintConfigPrettier,
);
