import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ipc } from "../../lib/ipc";
import { exportTheme } from "../../lib/theme";
import { DEFAULT_PREFS, usePrefs } from "../../store/prefs";
import { Appearance, normalizeHex } from "./Appearance";

const clipboard = { writeText: vi.fn(), readText: vi.fn() };

beforeEach(() => {
  usePrefs.setState({ prefs: DEFAULT_PREFS, loaded: true });
  vi.spyOn(ipc, "prefsSet").mockImplementation((prefs) => Promise.resolve(prefs));
  clipboard.writeText.mockReset().mockResolvedValue(undefined);
  clipboard.readText.mockReset().mockResolvedValue("");
  Object.defineProperty(navigator, "clipboard", { value: clipboard, configurable: true });
});

afterEach(() => {
  cleanup();
  for (const name of ["data-theme", "data-density", "data-tab-style", "data-motion", "style"]) document.documentElement.removeAttribute(name);
  vi.restoreAllMocks();
});

const prefs = () => usePrefs.getState().prefs;

describe("Appearance", () => {
  it("shows a token-drawn preview and every template as a card", () => {
    render(<Appearance />);
    expect(screen.getByTestId("appearance-preview")).toBeTruthy();
    const cards = screen.getByRole("radiogroup", { name: "Template" }).querySelectorAll('[role="radio"]');
    expect(cards.length).toBe(8);
    expect(screen.getByRole("radio", { name: "Graphite" }).getAttribute("aria-checked")).toBe("true");
    expect(screen.getByRole("radio", { name: "Custom" }).getAttribute("aria-checked")).toBe("false");
  });

  it("selects a template, forces its scheme in the preview, and notes it", async () => {
    render(<Appearance />);
    fireEvent.click(screen.getByRole("radio", { name: "Midnight" }));
    await waitFor(() => expect(prefs().appearance_preset).toBe("midnight"));
    expect(prefs().theme).toBe("system");
    expect(screen.getByText("This template is dark only.")).toBeTruthy();
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(document.documentElement.style.getPropertyValue("--color-ground")).toBe("#0b0c0e");
    // The Mode control shows the scheme the template forces, not System.
    expect(screen.getByRole("radio", { name: "Dark" }).getAttribute("aria-checked")).toBe("true");

    fireEvent.click(screen.getByRole("radio", { name: "Paper" }));
    await waitFor(() => expect(document.documentElement.dataset.theme).toBe("light"));
    expect(screen.getByRole("radio", { name: "Light" }).getAttribute("aria-checked")).toBe("true");
    // Mode is inert while a fixed template is chosen.
    fireEvent.click(screen.getByRole("radio", { name: "Dark" }));
    expect(prefs().theme).toBe("system");
  });

  it("changes the mode for an auto template", async () => {
    render(<Appearance />);
    fireEvent.click(screen.getByRole("radio", { name: "Light" }));
    await waitFor(() => expect(prefs().theme).toBe("light"));
    expect(document.documentElement.dataset.theme).toBe("light");
  });

  it("edits custom colours by picker and hex, reads out contrast, and starts from a template", async () => {
    render(<Appearance />);
    fireEvent.click(screen.getByRole("radio", { name: "Custom" }));
    await waitFor(() => expect(prefs().appearance_preset).toBe("custom"));
    expect(screen.getByTestId("contrast-readout").textContent).toContain("16.0:1");

    fireEvent.change(screen.getByLabelText("Background colour"), { target: { value: "#202020" } });
    await waitFor(() => expect(prefs().custom_ground).toBe("#202020"));

    const hex = screen.getByLabelText("Text hex") as HTMLInputElement;
    fireEvent.change(hex, { target: { value: "444444" } });
    fireEvent.blur(hex);
    await waitFor(() => expect(prefs().custom_ink).toBe("#444444"));
    expect(screen.getByTestId("contrast-readout").textContent).toContain("below 4.5");

    const bad = screen.getByLabelText("Highlight hex") as HTMLInputElement;
    fireEvent.change(bad, { target: { value: "nope" } });
    fireEvent.blur(bad);
    expect(prefs().custom_highlight).toBe(DEFAULT_PREFS.custom_highlight);

    fireEvent.click(screen.getByLabelText("Start from template"));
    fireEvent.click(screen.getByRole("option", { name: "Sepia" }));
    fireEvent.click(screen.getByRole("button", { name: "Start from Sepia" }));
    await waitFor(() => expect(prefs().custom_ground).toBe("#231a14"));
    expect(prefs().custom_ink).toBe("#f0e4d2");
    expect(prefs().custom_highlight).toBe("#e0a04a");
  });

  it("starts custom colours from Graphite's light seeds when the window is light", async () => {
    // Graphite is auto. Copying the dark set claims this window is dark.
    usePrefs.setState({ prefs: { ...DEFAULT_PREFS, theme: "light" }, loaded: true });
    render(<Appearance />);
    fireEvent.click(screen.getByRole("radio", { name: "Custom" }));
    await waitFor(() => expect(prefs().appearance_preset).toBe("custom"));
    fireEvent.click(screen.getByRole("button", { name: "Start from Graphite" }));
    await waitFor(() => expect(prefs().custom_ground).toBe("#f3f3f1"));
    expect(prefs().custom_ink).toBe("#161616");
    expect(prefs().custom_highlight).toBe("#0b7568");
  });

  it("keeps the accent swatches and adds a custom well", async () => {
    render(<Appearance />);
    fireEvent.click(screen.getByRole("radio", { name: "Sky" }));
    await waitFor(() => expect(prefs().accent).toBe("#8FB8F0"));
    fireEvent.change(screen.getByLabelText("Custom accent"), { target: { value: "#ff8800" } });
    await waitFor(() => expect(prefs().accent).toBe("#FF8800"));
    expect(document.documentElement.style.getPropertyValue("--color-highlight")).toBe("#FF8800");
  });

  it("reads a short hex, flags one it cannot use, and puts the colour back on blur", async () => {
    expect(normalizeHex("#abc")).toBe("#AABBCC");
    expect(normalizeHex("12ab34")).toBe("#12AB34");
    expect(normalizeHex("#12345")).toBeNull();
    usePrefs.setState({ prefs: { ...DEFAULT_PREFS, appearance_preset: "custom" }, loaded: true });
    render(<Appearance />);
    const hex = screen.getByLabelText("Highlight hex") as HTMLInputElement;
    fireEvent.change(hex, { target: { value: "#zz" } });
    expect(hex.getAttribute("aria-invalid")).toBe("true");
    expect(screen.getByText("Use #RRGGBB")).toBeTruthy();
    fireEvent.blur(hex);
    expect(hex.value).toBe(DEFAULT_PREFS.custom_highlight.toUpperCase());
    expect(hex.getAttribute("aria-invalid")).toBeNull();
    fireEvent.change(hex, { target: { value: "#f80" } });
    fireEvent.blur(hex);
    await waitFor(() => expect(prefs().custom_highlight).toBe("#FF8800"));
  });

  it("previews a drag without saving each step, and saves once it is let go", async () => {
    const set = vi.spyOn(ipc, "prefsSet");
    render(<Appearance />);
    const slider = screen.getByLabelText("Interface size");
    // React's onChange follows every input event of the drag.
    fireEvent.input(slider, { target: { value: "110" } });
    fireEvent.input(slider, { target: { value: "115" } });
    expect(document.documentElement.style.fontSize).toBe("18.4px");
    expect(screen.getByTestId("scale-value").textContent).toBe("115%");
    expect(set).not.toHaveBeenCalled();
    expect(prefs().ui_scale).toBe(1);
    fireEvent.change(slider, { target: { value: "115" } });
    await waitFor(() => expect(prefs().ui_scale).toBe(1.15));
    expect(set).toHaveBeenCalledTimes(1);
  });

  it("moves the interface size slider and resets it", async () => {
    render(<Appearance />);
    const slider = screen.getByLabelText("Interface size");
    fireEvent.change(slider, { target: { value: "120" } });
    await waitFor(() => expect(prefs().ui_scale).toBe(1.2));
    expect(screen.getByTestId("scale-value").textContent).toBe("120%");
    expect(document.documentElement.style.fontSize).toBe("19.2px");
    fireEvent.click(screen.getByRole("button", { name: "Reset" }));
    await waitFor(() => expect(prefs().ui_scale).toBe(1));
    expect(document.documentElement.style.fontSize).toBe("");
  });

  it("sets font, density, corners, tabs, motion and welcome background", async () => {
    render(<Appearance />);
    fireEvent.click(screen.getByLabelText("Font"));
    fireEvent.click(screen.getByRole("option", { name: "Mono" }));
    fireEvent.click(screen.getByRole("radio", { name: "Compact" }));
    fireEvent.click(screen.getByRole("radio", { name: "Sharp" }));
    fireEvent.click(screen.getByRole("radio", { name: "Flat" }));
    fireEvent.click(screen.getByRole("radio", { name: "Reduce" }));
    fireEvent.click(screen.getByRole("radio", { name: "Gradient" }));
    await waitFor(() => expect(prefs().welcome_background).toBe("gradient"));
    expect(prefs()).toMatchObject({ ui_font: "mono", density: "compact", corner_radius: "sharp", tab_style: "flat", motion: "reduce" });
    expect(document.documentElement.dataset.tabStyle).toBe("flat");
    expect(document.documentElement.dataset.motion).toBe("reduce");
    expect(document.documentElement.style.getPropertyValue("--row-h")).toBe("30px");
  });

  it("copies the theme as JSON and pastes one back, reporting a bad paste", async () => {
    usePrefs.setState({ prefs: { ...DEFAULT_PREFS, appearance_preset: "forest" }, loaded: true });
    render(<Appearance />);
    fireEvent.click(screen.getByRole("button", { name: "Copy theme" }));
    await waitFor(() => expect(clipboard.writeText).toHaveBeenCalledWith(exportTheme(prefs())));
    expect(JSON.parse(clipboard.writeText.mock.calls[0]![0] as string).appearance_preset).toBe("forest");
    expect(screen.getByRole("status").textContent).toContain("copied");

    clipboard.readText.mockResolvedValue(JSON.stringify({ appearance_preset: "rose", tab_style: "flat" }));
    fireEvent.click(screen.getByRole("button", { name: "Paste theme" }));
    await waitFor(() => expect(prefs().appearance_preset).toBe("rose"));
    expect(prefs().tab_style).toBe("flat");

    clipboard.readText.mockResolvedValue('{"accent":"purple"}');
    fireEvent.click(screen.getByRole("button", { name: "Paste theme" }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("accent"));
    expect(prefs().accent).toBe(DEFAULT_PREFS.accent);
  });

  it("resets every appearance field and nothing else", async () => {
    usePrefs.setState({
      prefs: { ...DEFAULT_PREFS, appearance_preset: "ocean", ui_scale: 1.1, density: "relaxed", tab_style: "flat", homepage: "https://kept.test" },
      loaded: true,
    });
    render(<Appearance />);
    fireEvent.click(screen.getByRole("button", { name: "Reset appearance" }));
    await waitFor(() => expect(prefs().appearance_preset).toBe("graphite"));
    expect(prefs()).toMatchObject({ ui_scale: 1, density: "comfortable", tab_style: "pill", homepage: "https://kept.test" });
    expect(document.documentElement.style.getPropertyValue("--color-ground")).toBe("");
  });

  it("keeps the tell-pages switch, enabled once the scheme is known", async () => {
    render(<Appearance />);
    expect((screen.getByRole("switch", { name: "Tell pages the theme" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("radio", { name: "Sepia" }));
    await waitFor(() => expect((screen.getByRole("switch", { name: "Tell pages the theme" }) as HTMLButtonElement).disabled).toBe(false));
  });

  it("shows Graphite's light seeds when the window is light", () => {
    // Graphite is auto. The dark dots are not the colours this window gets.
    usePrefs.setState({ prefs: { ...DEFAULT_PREFS, theme: "light" }, loaded: true });
    render(<Appearance />);
    const swatch = screen.getByRole("radio", { name: "Graphite" }).querySelector("[style]") as HTMLElement;
    expect(swatch.style.background).toBe("rgb(243, 243, 241)");
  });

  it("shows Mode as the scheme Custom actually paints, not the leftover Light pref", async () => {
    // Factory custom ground is dark. Mode saying Light claims this window stayed light.
    usePrefs.setState({ prefs: { ...DEFAULT_PREFS, theme: "light" }, loaded: true });
    render(<Appearance />);
    fireEvent.click(screen.getByRole("radio", { name: "Custom" }));
    await waitFor(() => expect(prefs().appearance_preset).toBe("custom"));
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(screen.getByRole("radio", { name: "Dark" }).getAttribute("aria-checked")).toBe("true");
    expect(screen.getByRole("radio", { name: "Light" }).getAttribute("aria-checked")).toBe("false");
  });
});
