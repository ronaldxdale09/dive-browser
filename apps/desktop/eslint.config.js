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
    rules: {
      ...reactHooks.configs.recommended.rules,
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
);
