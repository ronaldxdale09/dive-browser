import { create } from "zustand";
import { ipc } from "../lib/ipc";
import type { Address, Card, CardDraft } from "../lib/ipc";
import { errorMessage } from "../lib/errors";
import { useBrowser } from "./browser";

/**
 * Saved addresses and cards, and putting one into a form.
 *
 * A card's number is never here: the host keeps it in the Keychain and reads
 * it only for the one fill the person asked for, so nothing in the chrome
 * ever holds it.
 *
 * What is here belongs to the active profile, and is dropped when the
 * profile changes: the lists used to stay loaded, so after a switch the
 * wallet offered the previous profile's addresses and cards.
 */
interface WalletStore {
  addresses: Address[];
  cards: Card[];
  loaded: boolean;
  error: string | null;
  load: () => Promise<void>;
  /** Save an address; resolves to why it failed, or null once saved. */
  saveAddress: (address: Address) => Promise<string | null>;
  deleteAddress: (id: string) => Promise<void>;
  /** Save a card; resolves to why it failed, or null once saved. */
  saveCard: (draft: CardDraft) => Promise<string | null>;
  deleteCard: (id: string) => Promise<void>;
  /** Fill a form on `tabId`, and say how it went. */
  fillAddress: (tabId: string, id: string) => Promise<void>;
  fillCard: (tabId: string, id: string) => Promise<void>;
}

/** An empty address, for the "add" form. */
export const BLANK_ADDRESS: Address = {
  id: "",
  profile_id: "",
  label: "",
  name: "",
  organization: "",
  street: "",
  city: "",
  region: "",
  postal_code: "",
  country: "",
  phone: "",
  email: "",
  created_at: "",
  last_used_at: null,
  uses: 0,
};

/** How a card reads in a list: "Visa •••• 4242, 09/2030". */
export function describeCard(card: Card): string {
  const brand = card.brand ? card.brand[0]!.toUpperCase() + card.brand.slice(1) : "Card";
  const expiry = `${String(card.expiry_month).padStart(2, "0")}/${card.expiry_year}`;
  return `${brand} •••• ${card.last4}, ${expiry}`;
}

/** What to say after a fill: nothing matched is worth saying out loud. */
export function fillMessage(filled: number, what: string): string {
  if (filled === 0) return `Nothing on this page looked like ${what} fields.`;
  return `Filled ${filled} ${filled === 1 ? "field" : "fields"}.`;
}

/**
 * Bumped on every profile switch. A load that started under the previous
 * profile checks it before writing, so its answer cannot land after the
 * switch and put the old profile's cards back.
 */
let generation = 0;

export const useWallet = create<WalletStore>((set, get) => ({
  addresses: [],
  cards: [],
  loaded: false,
  error: null,
  load: async () => {
    const started = generation;
    try {
      const [addresses, cards] = await Promise.all([ipc.addressesList(), ipc.cardsList()]);
      if (started === generation) set({ addresses, cards, loaded: true, error: null });
    } catch (error) {
      if (started === generation) set({ error: errorMessage(error), loaded: true });
    }
  },
  saveAddress: async (address) => {
    try {
      await ipc.addressSave(address);
      await get().load();
      return null;
    } catch (error) {
      return errorMessage(error);
    }
  },
  deleteAddress: async (id) => {
    try {
      await ipc.addressDelete(id);
      await get().load();
    } catch (error) {
      set({ error: errorMessage(error) });
    }
  },
  saveCard: async (draft) => {
    try {
      await ipc.cardSave(draft);
      await get().load();
      return null;
    } catch (error) {
      return errorMessage(error);
    }
  },
  deleteCard: async (id) => {
    try {
      await ipc.cardDelete(id);
      await get().load();
    } catch (error) {
      set({ error: errorMessage(error) });
    }
  },
  fillAddress: async (tabId, id) => {
    try {
      useBrowser.getState().notify(fillMessage(await ipc.addressFill(tabId, id), "address"), 3000);
    } catch (error) {
      useBrowser.setState({ error: errorMessage(error) });
    }
  },
  fillCard: async (tabId, id) => {
    try {
      useBrowser.getState().notify(fillMessage(await ipc.cardFill(tabId, id), "payment"), 3000);
    } catch (error) {
      useBrowser.setState({ error: errorMessage(error) });
    }
  },
}));

/** Forget the lists when the active profile changes; whoever shows them loads again. */
export function forgetWallet(): void {
  generation += 1;
  useWallet.setState({ addresses: [], cards: [], loaded: false, error: null });
}

useBrowser.subscribe((state, previous) => {
  if (state.activeProfile !== previous.activeProfile) forgetWallet();
});
