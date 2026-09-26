import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Card } from "../../lib/ipc";
import { useWallet } from "../../store/wallet";
import { Wallet } from "./Wallet";

const initial = useWallet.getState();
const card: Card = { id: "c1", profile_id: "p1", label: "", cardholder: "Dale", last4: "4242", brand: "visa", expiry_month: 9, expiry_year: 2030, created_at: "", last_used_at: null, uses: 0 };
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

  it("asks before deleting a card", async () => {
    const deleteCard = vi.fn().mockResolvedValue(undefined);
    useWallet.setState({ cards: [card], deleteCard });
    render(<Wallet />);
    fireEvent.click(screen.getByRole("button", { name: "Delete Visa •••• 4242, 09/2030" }));
    expect(deleteCard).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Keep" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete Visa •••• 4242, 09/2030" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete Visa •••• 4242, 09/2030 for good" }));
    await waitFor(() => expect(deleteCard).toHaveBeenCalledWith("c1"));
  });

  it("says why a card was refused inside the form, and saves on Enter", async () => {
    const saveCard = vi.fn().mockResolvedValue("13 is not a valid month; use a number from 1 to 12");
    useWallet.setState({ saveCard });
    render(<Wallet />);
    fireEvent.click(screen.getByRole("button", { name: "Add card…" }));
    const dialog = screen.getByRole("dialog", { name: "Add card" });
    fireEvent.change(screen.getByLabelText("Expiry month"), { target: { value: "13" } });
    fireEvent.change(screen.getByLabelText("Expiry year"), { target: { value: "30" } });
    fireEvent.submit(screen.getByLabelText("Expiry year"));
    await waitFor(() => expect(saveCard).toHaveBeenCalledWith(expect.objectContaining({ expiry_month: 13, expiry_year: 30 })));
    expect((await screen.findByRole("alert")).textContent).toContain("not a valid month");
    expect(dialog.contains(screen.getByRole("alert"))).toBe(true);
  });

  it("lets Escape dismiss Add card without closing Settings", () => {
    render(<SettingsHost />);
    fireEvent.click(screen.getByRole("button", { name: "Add card…" }));
    fireEvent.keyDown(screen.getByRole("dialog", { name: "Add card" }), { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Add card" })).toBeNull();
    expect(screen.getByRole("dialog", { name: "Settings" })).toBeTruthy();
  });
});
