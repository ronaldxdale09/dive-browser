import { cleanup, render } from "@testing-library/react";
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

describe("Settings › Wallet", () => {
  it("does not say card numbers live only in the Keychain on Windows", () => {
    Object.defineProperty(navigator, "platform", { configurable: true, value: "Win32" });
    render(<Wallet />);
    expect(document.body.textContent).not.toMatch(/Keychain/);
    expect(document.body.textContent).toMatch(/Credential Manager/);
  });
});
