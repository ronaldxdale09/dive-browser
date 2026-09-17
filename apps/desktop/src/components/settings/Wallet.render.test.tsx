import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useWallet } from "../../store/wallet";
import { Wallet } from "./Wallet";

const initial = useWallet.getState();
const platform = Object.getOwnPropertyDescriptor(navigator, "platform");

beforeEach(() => {
  useWallet.setState({ addresses: [], cards: [], loaded: true, error: null });
});

afterEach(() => {
  cleanup();
  useWallet.setState(initial, true);
  if (platform) Object.defineProperty(navigator, "platform", platform);
});

/** Settings closes on Escape at the dialog. A nested form must eat that key. */
function SettingsHost() {
  const [open, setOpen] = useState(true);
  if (!open) return null;
  return (
    <div role="dialog" aria-modal="true" aria-label="Settings" onKeyDown={(e) => e.key === "Escape" && setOpen(false)}>
      <button type="button">General</button>
      <Wallet />
    </div>
  );
}

describe("Settings › Wallet", () => {
  it("does not say card numbers live only in the Keychain on Windows", () => {
    Object.defineProperty(navigator, "platform", { configurable: true, value: "Win32" });
    render(<Wallet />);
    expect(document.body.textContent).not.toMatch(/Keychain/);
    expect(document.body.textContent).toMatch(/Credential Manager/);
  });

  it("lets Escape dismiss Add address without closing Settings", () => {
    render(<SettingsHost />);
    fireEvent.click(screen.getByRole("button", { name: "Add address…" }));
    const address = screen.getByRole("dialog", { name: "Add address" });
    fireEvent.keyDown(address, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Add address" })).toBeNull();
    expect(screen.getByRole("dialog", { name: "Settings" })).toBeTruthy();
  });

  it("lets Escape dismiss Add card without closing Settings", () => {
    render(<SettingsHost />);
    fireEvent.click(screen.getByRole("button", { name: "Add card…" }));
    fireEvent.keyDown(screen.getByRole("dialog", { name: "Add card" }), { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Add card" })).toBeNull();
    expect(screen.getByRole("dialog", { name: "Settings" })).toBeTruthy();
  });
});
