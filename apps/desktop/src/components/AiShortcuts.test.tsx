import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useBrowser } from "../store/browser";
import { AI_SITES, AiLogo, AiShortcuts } from "./AiShortcuts";

afterEach(() => cleanup());

describe("AiShortcuts", () => {
  it("opens each assistant in a new tab of the active workspace", () => {
    const openTab = vi.fn().mockResolvedValue(undefined);
    useBrowser.setState({ openTab });
    render(<AiShortcuts />);
    for (const site of AI_SITES) {
      fireEvent.click(screen.getByRole("button", { name: `Open ${site.name} in a new tab` }));
      expect(openTab).toHaveBeenCalledWith(site.url);
    }
    expect(openTab).toHaveBeenCalledTimes(AI_SITES.length);
  });

  it("draws a brand glyph for every site", () => {
    for (const site of AI_SITES) {
      const { container, unmount } = render(<AiLogo id={site.id} size={20} />);
      const img = container.querySelector("img");
      expect(img?.getAttribute("width")).toBe("20");
      expect(img?.getAttribute("src")).toMatch(/svg/);
      unmount();
    }
  });
});
