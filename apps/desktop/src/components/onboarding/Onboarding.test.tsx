import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Profile, Workspace } from "../../lib/ipc";
import { ipc } from "../../lib/ipc";
import { useBrowser } from "../../store/browser";
import { useDefaultBrowser } from "../../store/defaultBrowser";
import { useOnboarding } from "../../store/onboarding";
import { DEFAULT_PREFS, usePrefs } from "../../store/prefs";
import { Onboarding } from "./Onboarding";

vi.mock("./IntroScene", () => ({
  IntroScene: () => {
    const skip = useOnboarding((s) => s.skipIntro);
    return (
      <div role="dialog" aria-label="Welcome to Dive">
        <button type="button" onClick={skip}>
          Skip
        </button>
      </div>
    );
  },
}));
vi.mock("../CharacterBg", () => ({ CharacterBg: () => null }));
vi.mock("../OrbBurst", () => ({ OrbBurst: () => null }));
vi.mock("../FeatureReel", () => ({ FeatureReel: () => <div>reel</div> }));

const profile: Profile = { id: "p1", name: "Personal", color: "#7FD8C8", avatar: "someone", note: "", container_id: "c1", position: 0, created_at: "2026-09-07T00:00:00Z" };
const workspace: Workspace = { id: "w1", name: "Home", color: "#7FD8C8", icon: "aurora", container_id: "c1", profile_id: "p1", position: 0, created_at: "2026-09-07T00:00:00Z" };

const updateProfile = vi.fn(async () => undefined);
const updateWorkspace = vi.fn(async () => undefined);

beforeEach(() => {
  useBrowser.setState({ ready: true, profiles: [profile], activeProfile: "p1", workspaces: [workspace], activeWorkspace: "w1", updateProfile, updateWorkspace });
  useDefaultBrowser.setState({ status: { supported: true, is_default: false, current: "com.brave.browser" }, phase: "idle", error: null });
  vi.spyOn(ipc, "defaultBrowserStatus").mockResolvedValue({ supported: true, is_default: false, current: "com.brave.browser" });
  vi.spyOn(ipc, "prefsSet").mockImplementation(async (p) => p);
  vi.spyOn(ipc, "browserImportSources").mockResolvedValue([]);
  vi.spyOn(ipc, "prepareContentCover").mockResolvedValue([]);
  vi.spyOn(ipc, "setContentCovered").mockResolvedValue(null);
  useOnboarding.setState({ stage: null });
});

afterEach(() => {
  cleanup();
  usePrefs.setState({ prefs: DEFAULT_PREFS, loaded: false });
  vi.restoreAllMocks();
  updateProfile.mockClear();
  updateWorkspace.mockClear();
});

describe("Onboarding", () => {
  it("stays out of the way once the preferences say it ran", () => {
    usePrefs.setState({ prefs: { ...DEFAULT_PREFS, onboarded: true }, loaded: true });
    const { container } = render(<Onboarding />);
    expect(container.firstChild).toBeNull();
  });

  it("opens on a fresh install and runs every step through to the welcome screen", async () => {
    usePrefs.setState({ prefs: DEFAULT_PREFS, loaded: true });
    render(<Onboarding />);
    expect(await screen.findByRole("dialog", { name: "Welcome to Dive" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Skip" }));

    // The start screen: one button, focused, and Enter is enough.
    const start = await screen.findByRole("button", { name: /Start Dive/ });
    expect(document.activeElement).toBe(start);
    fireEvent.click(start);

    // Profile: naming the install's own profile rather than creating one.
    expect(await screen.findByRole("heading", { name: "Who's diving?" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Continue" })).toHaveProperty("disabled", true);
    fireEvent.change(screen.getByLabelText("Your name"), { target: { value: "Ada" } });
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    await waitFor(() => expect(updateProfile).toHaveBeenCalledWith("p1", expect.objectContaining({ name: "Ada", avatar: "ada" })));

    // Import: nothing on this Mac to import from, so it only offers Continue.
    expect(await screen.findByRole("heading", { name: "Bring your bookmarks and history" })).toBeTruthy();
    expect(await screen.findByText("No other browsers with data were found")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Skip" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));

    // Workspace: a suggestion fills the name; the Home workspace is renamed.
    expect(await screen.findByRole("heading", { name: "Your first workspace" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Side project" }));
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    await waitFor(() => expect(updateWorkspace).toHaveBeenCalledWith("w1", expect.objectContaining({ name: "Side project" })));

    // Features: every feature listed, protection preselected, default browser offered.
    expect(await screen.findByRole("heading", { name: "What's inside" })).toBeTruthy();
    expect(within(screen.getByRole("list", { name: "Features" })).getAllByRole("listitem")).toHaveLength(4);
    expect(screen.getByRole("switch", { name: "Block ads and trackers" }).getAttribute("aria-checked")).toBe("true");
    expect(screen.getByRole("button", { name: "Set as default" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Start browsing" }));

    await waitFor(() => expect(useOnboarding.getState().stage).toBeNull());
    await waitFor(() => expect(usePrefs.getState().prefs).toMatchObject({ onboarded: true, block_trackers: true }));
  });

  it("lets a step be skipped and walked back", async () => {
    usePrefs.setState({ prefs: DEFAULT_PREFS, loaded: true });
    act(() => useOnboarding.setState({ stage: "profile" }));
    render(<Onboarding />);
    fireEvent.click(screen.getByRole("button", { name: "Skip" }));
    expect(await screen.findByRole("heading", { name: "Bring your bookmarks and history" })).toBeTruthy();
    expect(updateProfile).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(await screen.findByRole("heading", { name: "Who's diving?" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Back" })).toBeNull();
  });
});
