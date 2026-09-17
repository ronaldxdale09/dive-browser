import { CreditCard, MapPin, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button, Group, Row } from "../SettingsFields";
import { Icon } from "../Icon";
import type { Address } from "../../lib/ipc";
import { useFocusTrap } from "../../lib/useFocusTrap";
import { BLANK_ADDRESS, describeCard, useWallet } from "../../store/wallet";
import { credentialStoreName } from "../../lib/commands";

/**
 * Addresses and payment cards, for the forms that ask for them.
 *
 * Addresses are ordinary data and are shown in full. A card is not: the list
 * has its last four digits and nothing else, because the number itself is in
 * the Keychain and the chrome never sees it -- not here, and not while
 * filling, which the host does on the page's side.
 */
export function Wallet() {
  const addresses = useWallet((s) => s.addresses);
  const cards = useWallet((s) => s.cards);
  const loaded = useWallet((s) => s.loaded);
  const error = useWallet((s) => s.error);
  const load = useWallet((s) => s.load);
  const deleteAddress = useWallet((s) => s.deleteAddress);
  const deleteCard = useWallet((s) => s.deleteCard);
  const [editing, setEditing] = useState<Address | null>(null);
  const [addingCard, setAddingCard] = useState(false);
  useEffect(() => {
    if (!loaded) void load();
  }, [loaded, load]);

  return (
    <>
      {error && <p className="mb-3 rounded-lg bg-surface-2 px-3 py-2 text-xs text-warn">{error}</p>}
      <Group title="Addresses">
        {addresses.map((address) => (
          <Row
            key={address.id}
            label={address.label || address.name || "Address"}
            hint={[address.name, address.street.split("\n").join(", "), address.city, address.region, address.postal_code, address.country].filter(Boolean).join(" · ")}
            control={
              <div className="flex items-center gap-1.5">
                <Button onClick={() => setEditing(address)}>Edit…</Button>
                <button type="button" aria-label={`Delete ${address.label || address.name}`} onClick={() => void deleteAddress(address.id)} className="grid size-7 place-items-center rounded-lg text-ink-3 hover:bg-surface-2 hover:text-warn">
                  <Icon icon={Trash2} size={13} />
                </button>
              </div>
            }
          />
        ))}
        <Row
          label={addresses.length === 0 ? "No saved addresses" : "Add another"}
          hint="Filled into checkout and delivery forms when you pick it, never on its own."
          control={<Button onClick={() => setEditing({ ...BLANK_ADDRESS })}>Add address…</Button>}
        />
      </Group>

      <Group title="Payment cards">
        {cards.map((card) => (
          <Row
            key={card.id}
            label={card.label || describeCard(card)}
            hint={`${card.cardholder} · ${describeCard(card)} · the number is kept in ${credentialStoreName()}, not in Dive's database`}
            control={
              <button type="button" aria-label={`Delete ${card.label || describeCard(card)}`} onClick={() => void deleteCard(card.id)} className="grid size-7 place-items-center rounded-lg text-ink-3 hover:bg-surface-2 hover:text-warn">
                <Icon icon={Trash2} size={13} />
              </button>
            }
          />
        ))}
        <Row
          label={cards.length === 0 ? "No saved cards" : "Add another"}
          hint={`The number goes to ${credentialStoreName()} under this profile and is read only for the fill you ask for. Dive never saves a card on its own, and never stores the security code.`}
          control={<Button onClick={() => setAddingCard(true)}>Add card…</Button>}
        />
      </Group>

      {editing && <AddressForm address={editing} onClose={() => setEditing(null)} />}
      {addingCard && <CardForm onClose={() => setAddingCard(false)} />}
    </>
  );
}

const field = "h-8 w-full rounded-lg border border-line-2 bg-surface-2 px-2.5 text-xs text-ink outline-none focus:border-highlight";

function AddressForm({ address, onClose }: { address: Address; onClose: () => void }) {
  const save = useWallet((s) => s.saveAddress);
  const [draft, setDraft] = useState(address);
  const root = useRef<HTMLDivElement>(null);
  const first = useRef<HTMLInputElement>(null);
  useFocusTrap(root, { initialFocus: first, onEscape: onClose });
  const set = (key: keyof Address, value: string) => setDraft((was) => ({ ...was, [key]: value }));
  const submit = async () => {
    if (await save(draft)) onClose();
  };
  const input = (key: keyof Address, label: string, placeholder = "") => (
    <label className="flex flex-col gap-1 text-[11px] text-ink-3">
      {label}
      <input className={field} value={String(draft[key] ?? "")} placeholder={placeholder} onChange={(e) => set(key, e.target.value)} />
    </label>
  );
  return (
    <div className="overlay-backdrop fixed inset-0 z-50 grid place-items-center" onMouseDown={onClose}>
      <div ref={root} onMouseDown={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-label={address.id ? "Edit address" : "Add address"} className="w-[min(520px,calc(100vw-32px))] rounded-2xl border border-line-2 bg-surface p-4 shadow-2xl">
        <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold">
          <Icon icon={MapPin} size={14} /> {address.id ? "Edit address" : "Add address"}
        </h2>
        <div className="grid grid-cols-2 gap-2.5">
          <label className="flex flex-col gap-1 text-[11px] text-ink-3">
            Label
            <input ref={first} className={field} value={draft.label} placeholder="Home" onChange={(e) => set("label", e.target.value)} />
          </label>
          {input("name", "Full name")}
          {input("organization", "Company")}
          {input("phone", "Phone")}
          <label className="col-span-2 flex flex-col gap-1 text-[11px] text-ink-3">
            Street
            <textarea className={`${field} h-14 resize-none py-1.5`} value={draft.street} onChange={(e) => set("street", e.target.value)} />
          </label>
          {input("city", "City")}
          {input("region", "State or region")}
          {input("postal_code", "Postcode")}
          {input("country", "Country")}
          {input("email", "Email")}
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <Button onClick={onClose}>Cancel</Button>
          <button type="button" onClick={() => void submit()} className="h-8 rounded-full bg-accent px-4 text-xs font-medium text-accent-ink">
            Save
          </button>
        </div>
      </div>
    </div>
  );
}

function CardForm({ onClose }: { onClose: () => void }) {
  const save = useWallet((s) => s.saveCard);
  const [label, setLabel] = useState("");
  const [cardholder, setCardholder] = useState("");
  const [number, setNumber] = useState("");
  const [month, setMonth] = useState("");
  const [year, setYear] = useState("");
  const root = useRef<HTMLDivElement>(null);
  const first = useRef<HTMLInputElement>(null);
  useFocusTrap(root, { initialFocus: first, onEscape: onClose });
  const submit = async () => {
    const ok = await save({ label, cardholder, number, expiry_month: Number(month) || 0, expiry_year: Number(year) || 0 });
    if (ok) onClose();
  };
  return (
    <div className="overlay-backdrop fixed inset-0 z-50 grid place-items-center" onMouseDown={onClose}>
      <div ref={root} onMouseDown={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-label="Add card" className="w-[min(460px,calc(100vw-32px))] rounded-2xl border border-line-2 bg-surface p-4 shadow-2xl">
        <h2 className="mb-1 flex items-center gap-2 text-sm font-semibold">
          <Icon icon={CreditCard} size={14} /> Add card
        </h2>
        <p className="mb-3 text-[11px] text-ink-3">The number goes straight to {credentialStoreName()}; Dive's database keeps only the last four digits. The security code is never saved.</p>
        <div className="grid grid-cols-2 gap-2.5">
          <label className="flex flex-col gap-1 text-[11px] text-ink-3">
            Label
            <input ref={first} className={field} value={label} placeholder="Personal" onChange={(e) => setLabel(e.target.value)} />
          </label>
          <label className="flex flex-col gap-1 text-[11px] text-ink-3">
            Name on card
            <input className={field} value={cardholder} onChange={(e) => setCardholder(e.target.value)} />
          </label>
          <label className="col-span-2 flex flex-col gap-1 text-[11px] text-ink-3">
            Card number
            <input className={`${field} font-mono`} value={number} inputMode="numeric" autoComplete="off" onChange={(e) => setNumber(e.target.value)} />
          </label>
          <label className="flex flex-col gap-1 text-[11px] text-ink-3">
            Expiry month
            <input className={field} value={month} inputMode="numeric" placeholder="09" onChange={(e) => setMonth(e.target.value)} />
          </label>
          <label className="flex flex-col gap-1 text-[11px] text-ink-3">
            Expiry year
            <input className={field} value={year} inputMode="numeric" placeholder="2030" onChange={(e) => setYear(e.target.value)} />
          </label>
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <Button onClick={onClose}>Cancel</Button>
          <button type="button" onClick={() => void submit()} className="h-8 rounded-full bg-accent px-4 text-xs font-medium text-accent-ink">
            Save
          </button>
        </div>
      </div>
    </div>
  );
}
