import { CreditCard, MapPin, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
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
  // The row asking "Delete …?" -- one at a time, and nothing is deleted on
  // the first click, which used to throw a saved card away on a stray one.
  const [confirming, setConfirming] = useState<string | null>(null);
  useEffect(() => {
    if (!loaded) void load();
  }, [loaded, load]);

  return (
    <>
      {error && (
        <p role="alert" className="mb-3 rounded-lg bg-surface-2 px-3 py-2 text-xs text-warn">
          {error}
        </p>
      )}
      <Group title="Addresses">
        {addresses.map((address) => {
          const name = address.label || address.name || "Address";
          return (
            <Row
              key={address.id}
              label={name}
              hint={[address.name, address.street.split("\n").join(", "), address.city, address.region, address.postal_code, address.country].filter(Boolean).join(" · ")}
              control={
                confirming === address.id ? (
                  <ConfirmDelete question="Delete this address?" label={`Delete ${name} for good`} onKeep={() => setConfirming(null)} onDelete={() => void deleteAddress(address.id).finally(() => setConfirming(null))} />
                ) : (
                  <div className="flex items-center gap-1.5">
                    <Button onClick={() => setEditing(address)}>Edit…</Button>
                    <DeleteButton label={`Delete ${name}`} onClick={() => setConfirming(address.id)} />
                  </div>
                )
              }
            />
          );
        })}
        <Row
          label={addresses.length === 0 ? "No saved addresses" : "Add another"}
          hint="Filled into checkout and delivery forms when you pick it, never on its own."
          control={<Button onClick={() => setEditing({ ...BLANK_ADDRESS })}>Add address…</Button>}
        />
      </Group>

      <Group title="Payment cards">
        {cards.map((card) => {
          const name = card.label || describeCard(card);
          return (
            <Row
              key={card.id}
              label={name}
              hint={`${card.cardholder} · ${describeCard(card)} · the number is kept in ${credentialStoreName()}, not in Dive's database`}
              control={
                confirming === card.id ? (
                  <ConfirmDelete question="Delete this card?" label={`Delete ${name} for good`} onKeep={() => setConfirming(null)} onDelete={() => void deleteCard(card.id).finally(() => setConfirming(null))} />
                ) : (
                  <DeleteButton label={`Delete ${name}`} onClick={() => setConfirming(card.id)} />
                )
              }
            />
          );
        })}
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

function DeleteButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button type="button" aria-label={label} onClick={onClick} className="grid size-7 place-items-center rounded-lg text-ink-3 hover:bg-surface-2 hover:text-warn">
      <Icon icon={Trash2} size={13} />
    </button>
  );
}

/** The second step of a delete, in place of the row's buttons. */
function ConfirmDelete({ question, label, onKeep, onDelete }: { question: string; label: string; onKeep: () => void; onDelete: () => void }) {
  return (
    <div className="flex items-center gap-1.5">
      <span className="shrink-0 text-[11px] text-ink-2">{question}</span>
      <button type="button" onClick={onKeep} className="h-7 shrink-0 rounded-full px-2.5 text-[11px] text-ink-2 hover:bg-surface-3 hover:text-ink">
        Keep
      </button>
      <button type="button" aria-label={label} onClick={onDelete} className="h-7 shrink-0 rounded-full bg-danger px-2.5 text-[11px] font-medium text-danger-ink hover:brightness-110">
        Delete
      </button>
    </div>
  );
}

const field = "h-8 w-full rounded-lg border border-line-2 bg-surface-2 px-2.5 text-xs text-ink outline-none focus:border-highlight";

/**
 * The frame both forms share. It is a real <form>, so Enter in any field
 * saves, and a refused save says why inside the dialog: the reason used to
 * go to the page behind the modal, where the backdrop hid it and the form
 * simply stayed open.
 */
function WalletDialog({ title, icon, onClose, onSubmit, error, busy, initialFocus, children }: { title: string; icon: typeof MapPin; onClose: () => void; onSubmit: () => void; error: string | null; busy: boolean; initialFocus: React.RefObject<HTMLInputElement | null>; children: ReactNode }) {
  const root = useRef<HTMLFormElement>(null);
  useFocusTrap(root, { initialFocus, onEscape: onClose });
  return (
    <div className="overlay-backdrop fixed inset-0 z-50 grid place-items-center" onMouseDown={onClose}>
      <form
        ref={root}
        onMouseDown={(e) => e.stopPropagation()}
        onSubmit={(e) => {
          e.preventDefault();
          if (!busy) onSubmit();
        }}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="w-[min(520px,calc(100vw-32px))] rounded-2xl border border-line-2 bg-surface p-4 shadow-2xl"
      >
        <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold">
          <Icon icon={icon} size={14} /> {title}
        </h2>
        {children}
        {error && (
          <p role="alert" className="mt-3 rounded-lg bg-surface-2 px-3 py-2 text-[11px] text-warn">
            {error}
          </p>
        )}
        <div className="mt-4 flex justify-end gap-2">
          <Button onClick={onClose}>Cancel</Button>
          <button type="submit" disabled={busy} className="h-8 rounded-full bg-accent px-4 text-xs font-medium text-accent-ink disabled:opacity-40">
            {busy ? "Saving…" : "Save"}
          </button>
        </div>
      </form>
    </div>
  );
}

function AddressForm({ address, onClose }: { address: Address; onClose: () => void }) {
  const save = useWallet((s) => s.saveAddress);
  const [draft, setDraft] = useState(address);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const first = useRef<HTMLInputElement>(null);
  const set = (key: keyof Address, value: string) => setDraft((was) => ({ ...was, [key]: value }));
  const submit = async () => {
    setBusy(true);
    const failed = await save(draft);
    setBusy(false);
    if (failed) setError(failed);
    else onClose();
  };
  const input = (key: keyof Address, label: string, placeholder = "") => (
    <label className="flex flex-col gap-1 text-[11px] text-ink-3">
      {label}
      <input className={field} value={String(draft[key] ?? "")} placeholder={placeholder} onChange={(e) => set(key, e.target.value)} />
    </label>
  );
  return (
    <WalletDialog title={address.id ? "Edit address" : "Add address"} icon={MapPin} onClose={onClose} onSubmit={() => void submit()} error={error} busy={busy} initialFocus={first}>
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
    </WalletDialog>
  );
}

function CardForm({ onClose }: { onClose: () => void }) {
  const save = useWallet((s) => s.saveCard);
  const [label, setLabel] = useState("");
  const [cardholder, setCardholder] = useState("");
  const [number, setNumber] = useState("");
  const [month, setMonth] = useState("");
  const [year, setYear] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const first = useRef<HTMLInputElement>(null);
  const submit = async () => {
    setBusy(true);
    // A two-digit year ("30") goes as typed; the host reads it as 2030.
    const failed = await save({ label, cardholder, number, expiry_month: Number(month) || 0, expiry_year: Number(year) || 0 });
    setBusy(false);
    if (failed) setError(failed);
    else onClose();
  };
  return (
    <WalletDialog title="Add card" icon={CreditCard} onClose={onClose} onSubmit={() => void submit()} error={error} busy={busy} initialFocus={first}>
      <p className="-mt-2 mb-3 text-[11px] text-ink-3">The number goes straight to {credentialStoreName()}; Dive's database keeps only the last four digits. The security code is never saved.</p>
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
          <input className={field} value={year} inputMode="numeric" placeholder="30 or 2030" onChange={(e) => setYear(e.target.value)} />
        </label>
      </div>
    </WalletDialog>
  );
}
