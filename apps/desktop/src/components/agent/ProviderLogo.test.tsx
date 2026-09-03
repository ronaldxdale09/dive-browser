import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { Provider } from "../../lib/ipc";
import { getProviderBadgeStyle, ProviderLogo } from "./ProviderLogo";

const ALL_PROVIDERS: Provider[] = [
  "anthropic",
  "openai",
  "google",
  "groq",
  "ollama",
  "lmstudio",
  "openrouter",
  "deepseek",
  "mistral",
  "xai",
  "together",
  "fireworks",
  "cerebras",
  "custom",
];

describe("ProviderLogo", () => {
  ALL_PROVIDERS.forEach((id) => {
    it(`renders logo for ${id}`, () => {
      const { container } = render(<ProviderLogo id={id} size={20} />);
      const svg = container.querySelector("svg");
      expect(svg).toBeTruthy();
      expect(svg?.getAttribute("width")).toBe("20");
    });

    it(`provides valid badge styles for ${id}`, () => {
      const style = getProviderBadgeStyle(id);
      expect(style.bg).toBeTruthy();
      expect(style.text).toBeTruthy();
      expect(style.border).toBeTruthy();
    });
  });
});
