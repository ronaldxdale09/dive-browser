import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ipc } from "../../lib/ipc";
import { DEFAULT_PREFS, usePrefs } from "../../store/prefs";
import { useOnboarding } from "../../store/onboarding";
import { ThemeStep } from "./ThemeStep";

beforeEach(() => {
  usePrefs.setState({ prefs: DEFAULT_PREFS, loaded: true });
  useOnboarding.setState({ stage: "theme" });
  vi.spyOn(ipc, "prefsSet").mockImplementation(async (p) => p);
});
afterEach(() => {
  cleanup();
  usePrefs.setState({ prefs: DEFAULT_PREFS, loaded: false });
  vi.restoreAllMocks();
});

describe("ThemeStep", () => {
  it("offers every template plus Custom, with the current one checked", () => {
    render(<ThemeStep />);
    const options = screen.getAllByRole("radio");
    // The seven built-in templates and Custom.
    expect(options).toHaveLength(8);
    expect(screen.getByRole("radio", { name: "Graphite" }).getAttribute("aria-checked")).toBe("true");
    expect(screen.getByRole("radio", { name: "Custom" })).toBeTruthy();
  });

  it("applies a template as it is chosen, so the step is its own preview", async () => {
    render(<ThemeStep />);
    fireEvent.click(screen.getByRole("radio", { name: "Sepia" }));
    await waitFor(() => expect(usePrefs.getState().prefs.appearance_preset).toBe("sepia"));
    expect(screen.getByRole("radio", { name: "Sepia" }).getAttribute("aria-checked")).toBe("true");
    expect(screen.getByRole("radio", { name: "Graphite" }).getAttribute("aria-checked")).toBe("false");
  });

  it("moves on without waiting for a choice, since one is already applied", () => {
    render(<ThemeStep />);
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(useOnboarding.getState().stage).toBe("import");
  });

  it("takes focus to the heading, so the keyboard follows the step", () => {
    render(<ThemeStep />);
    expect(document.activeElement).toBe(screen.getByRole("heading", { name: "Make it yours" }));
  });

  it("says where the rest of the appearance controls are rather than crowding them in", () => {
    render(<ThemeStep />);
    expect(screen.getByText(/Settings › Appearance/)).toBeTruthy();
  });
});
