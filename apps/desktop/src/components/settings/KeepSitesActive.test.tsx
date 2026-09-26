import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ipc } from "../../lib/ipc";
import { useBrowser } from "../../store/browser";
import { KeepSitesActive, siteAddress } from "./KeepSitesActive";
vi.mock("../../lib/ipc", () => ({ ipc: { keepSitesList: vi.fn(), keepSiteSet: vi.fn() } }));
afterEach(() => { cleanup(); vi.resetAllMocks(); });
it("does not claim host and port without scheme", async () => {
  useBrowser.setState({ activeProfile: "personal" });
  vi.mocked(ipc.keepSitesList).mockResolvedValue([]);
  render(<KeepSitesActive />);
  await waitFor(() => expect(ipc.keepSitesList).toHaveBeenCalledWith("personal"));
  const text = screen.getByText(/These site exceptions apply to this profile/).textContent ?? "";
  expect(text).toMatch(/same origin/);
  expect(text).not.toMatch(/address and port/);
});

it("adds and removes a site for the current profile and shows persistence errors", async () => {
  useBrowser.setState({ activeProfile: "personal" });
  vi.mocked(ipc.keepSitesList).mockResolvedValue([]);
  vi.mocked(ipc.keepSiteSet).mockResolvedValueOnce(["https://example.com"]).mockRejectedValueOnce(new Error("Cannot save"));
  render(<KeepSitesActive />);
  await waitFor(() => expect(ipc.keepSitesList).toHaveBeenCalledWith("personal"));
  fireEvent.change(screen.getByLabelText("Site to keep active"), { target: { value: "https://example.com/path" } });
  fireEvent.click(screen.getByRole("button", { name: "Add site" }));
  await screen.findByText("https://example.com");
  expect(ipc.keepSiteSet).toHaveBeenCalledWith("personal", "https://example.com/path", true);
  fireEvent.click(screen.getByRole("button", { name: "Remove https://example.com" }));
  await screen.findByRole("alert");
  expect(screen.getByRole("alert").textContent).toContain("Cannot save");
  expect(screen.getByText("https://example.com")).toBeTruthy();
});
it("ignores an old profile response after switching profiles", async () => {
  let resolve!: (value: string[]) => void;
  useBrowser.setState({ activeProfile: "old" });
  vi.mocked(ipc.keepSitesList).mockReturnValueOnce(new Promise((done) => { resolve = done; })).mockResolvedValueOnce(["https://new.example"]);
  render(<KeepSitesActive />);
  await act(async () => { useBrowser.setState({ activeProfile: "new" }); });
  await screen.findByText("https://new.example");
  await act(async () => { resolve(["https://old.example"]); });
  expect(screen.queryByText("https://old.example")).toBeNull();
});

it("takes a bare host as the https site it means", async () => {
  expect(siteAddress("  example.com ")).toBe("https://example.com");
  expect(siteAddress("localhost:3000")).toBe("https://localhost:3000");
  expect(siteAddress("http://intranet.test")).toBe("http://intranet.test");
  expect(siteAddress("")).toBe("");
  useBrowser.setState({ activeProfile: "personal" });
  vi.mocked(ipc.keepSitesList).mockResolvedValue([]);
  vi.mocked(ipc.keepSiteSet).mockResolvedValue(["https://example.com"]);
  render(<KeepSitesActive />);
  const field = await screen.findByLabelText("Site to keep active");
  expect(field.getAttribute("type")).toBe("text");
  fireEvent.change(field, { target: { value: "example.com" } });
  fireEvent.keyDown(field, { key: "Enter" });
  await waitFor(() => expect(ipc.keepSiteSet).toHaveBeenCalledWith("personal", "https://example.com", true));
});
