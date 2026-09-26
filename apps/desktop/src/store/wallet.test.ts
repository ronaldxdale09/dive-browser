import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ipc } from "../lib/ipc";
import type { Address, Card } from "../lib/ipc";
import { useBrowser } from "./browser";
import { BLANK_ADDRESS, describeCard, fillMessage, useWallet } from "./wallet";

const address: Address = { ...BLANK_ADDRESS, id: "a1", label: "Home", name: "Dale", city: "Manila" };
const card: Card = {
  id: "c1",
  profile_id: "p1",
  label: "",
  cardholder: "Dale",
  last4: "4242",
  brand: "visa",
  expiry_month: 9,
  expiry_year: 2030,
  created_at: "",
  last_used_at: null,
  uses: 0,
};

beforeEach(() => {
  vi.spyOn(ipc, "addressesList").mockResolvedValue([address]);
  vi.spyOn(ipc, "cardsList").mockResolvedValue([card]);
  vi.spyOn(ipc, "addressFill").mockResolvedValue(6);
  vi.spyOn(ipc, "cardFill").mockResolvedValue(4);
  useWallet.setState({ addresses: [], cards: [], loaded: false, error: null });
});

afterEach(() => {
  vi.restoreAllMocks();
  useBrowser.setState({ notice: null, activeProfile: null });
});

describe("describeCard", () => {
  it("says what a person would recognise, and never the number", () => {
    expect(describeCard(card)).toBe("Visa •••• 4242, 09/2030");
    expect(describeCard({ ...card, brand: "" })).toBe("Card •••• 4242, 09/2030");
  });
});

describe("fillMessage", () => {
  it("says plainly when a page had nothing to fill", () => {
    expect(fillMessage(0, "address")).toContain("Nothing on this page");
    expect(fillMessage(1, "address")).toBe("Filled 1 field.");
    expect(fillMessage(6, "address")).toBe("Filled 6 fields.");
  });
});

describe("useWallet", () => {
  it("loads both lists at once", async () => {
    await useWallet.getState().load();
    expect(useWallet.getState()).toMatchObject({ addresses: [address], cards: [card], loaded: true, error: null });
  });

  it("fills and says how it went", async () => {
    await useWallet.getState().fillAddress("t1", "a1");
    expect(ipc.addressFill).toHaveBeenCalledWith("t1", "a1");
    expect(useBrowser.getState().notice).toBe("Filled 6 fields.");
    await useWallet.getState().fillCard("t1", "c1");
    expect(ipc.cardFill).toHaveBeenCalledWith("t1", "c1");
  });

  it("keeps a refused card out of the list and hands the reason to the form", async () => {
    vi.spyOn(ipc, "cardSave").mockRejectedValue(new Error("that does not look like a card number"));
    expect(await useWallet.getState().saveCard({ label: "", cardholder: "Dale", number: "1234", expiry_month: 9, expiry_year: 2030 })).toContain("card number");
    // The form shows it; the page behind the form does not.
    expect(useWallet.getState().error).toBeNull();
    expect(useWallet.getState().cards).toEqual([]);
  });

  it("forgets the lists when the profile changes, even mid-load", async () => {
    useBrowser.setState({ activeProfile: "p1" });
    await useWallet.getState().load();
    expect(useWallet.getState().cards).toEqual([card]);

    let answer: (cards: Card[]) => void = () => {};
    vi.mocked(ipc.cardsList).mockReturnValue(new Promise((resolve) => (answer = resolve)));
    const pending = useWallet.getState().load();
    useBrowser.setState({ activeProfile: "p2" });
    expect(useWallet.getState()).toMatchObject({ addresses: [], cards: [], loaded: false });
    answer([card]);
    await pending;
    // The first profile's answer arrived after the switch and was dropped.
    expect(useWallet.getState()).toMatchObject({ cards: [], loaded: false });
  });
});
