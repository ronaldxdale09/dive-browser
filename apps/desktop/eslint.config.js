import js from "@eslint/js";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";

export default tseslint.config(
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
