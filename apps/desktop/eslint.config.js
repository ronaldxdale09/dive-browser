import js from "@eslint/js";
import { defineConfig } from "eslint/config";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";

export default defineConfig(
  { ignores: ["dist", "src/generated"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["src/**/*.{ts,tsx}"],
    plugins: { "react-hooks": reactHooks },
    languageOptions: {
      parserOptions: {
        project: ["./tsconfig.test.json"],
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": "error",
      // The agent has a mark of its own (components/AgentIcon.tsx). A sparkle
      // says "generic AI" and nothing about this browser; keep it out for good.
      // A promise that is allowed to fail still leaves a trace in the host log.
      // Only a handler that does nothing is flagged: one that sets a fallback
      // (`.catch(() => setItems([]))`) has handled the failure, not swallowed it.
      "no-restricted-syntax": [
        "error",
        {
          selector:
            "CallExpression[callee.property.name='catch'] > ArrowFunctionExpression[params.length=0]:matches([body.type='BlockStatement'][body.body.length=0], [body.type='Identifier'][body.name='undefined'], [body.type='Literal'][body.raw='null'])",
          message: 'Don\'t swallow errors: use .catch(ignored("what")) from lib/chromeErrors so they reach the log.',
        },
      ],
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "lucide-react",
              importNames: ["Sparkles", "Sparkle", "WandSparkles", "Stars"],
              message: "Use AgentIcon from components/AgentIcon for the agent; sparkles are not part of Dive's visual language.",
            },
          ],
        },
      ],
    },
  },
  // lib/ and store/ sit under the components. A pure helper a component and a
  // module both need belongs in lib/. markdown.tsx is a component in all but
  // location; type imports are free.
  {
    files: ["src/lib/**/*.{ts,tsx}", "src/store/**/*.{ts,tsx}"],
    ignores: ["src/lib/markdown.tsx", "**/*.test.*"],
    rules: {
      "@typescript-eslint/no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["**/components/*", "**/components/**"],
              message: "lib/ and store/ must not import components; move the pure helper into lib/.",
              allowTypeImports: true,
            },
          ],
        },
      ],
    },
  },
  // TypeScript keeps only one of `X.test.ts` / `X.test.tsx` when both exist, so
  // these two sit outside every program. Vitest still runs them; they just
  // cannot be typed-linted until they get distinct names.
  {
    files: ["src/components/ReplayEditor.test.tsx", "src/lib/overlay.test.tsx"],
    ...tseslint.configs.disableTypeChecked,
  },
  // mediaPlaybackObserver.test.ts is out of tsconfig.test.json (its "exclude").
  // Its first line is a `@ts-expect-error` for `node:fs` that the test
  // project's Node types make unused (TS2578). The file is being edited
  // elsewhere; once that line is deleted, remove this block and the exclude.
  {
    files: ["src/test/mediaPlaybackObserver.test.ts"],
    ...tseslint.configs.disableTypeChecked,
  },
);
