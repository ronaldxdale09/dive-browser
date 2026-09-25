import { BookOpen, CreditCard, Languages, Loader2, MapPin } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { ipc } from "../lib/ipc";
import { errorMessage } from "../lib/errors";
import { useCoversContent } from "../lib/overlay";
import { useDismiss } from "../lib/useDismiss";
import { useFocusTrap } from "../lib/useFocusTrap";
import { tabInThisWindow, useBrowser } from "../store/browser";
import { describeCard, useWallet } from "../store/wallet";
import { Icon } from "./Icon";
import { Tooltip } from "./Tooltip";

/** Languages offered, as the on-device translator names them. */
export const LANGUAGES: readonly (readonly [string, string])[] = [
  ["en", "English"],
  ["es", "Spanish"],
  ["fr", "French"],
  ["de", "German"],
  ["pt", "Portuguese"],
  ["it", "Italian"],
  ["nl", "Dutch"],
  ["ja", "Japanese"],
  ["ko", "Korean"],
  ["zh", "Chinese"],
  ["ru", "Russian"],
  ["ar", "Arabic"],
  ["hi", "Hindi"],
  ["tr", "Turkish"],
  ["vi", "Vietnamese"],
  ["id", "Indonesian"],
];

/** What the browser is set to, as a language the translator understands. */
export function preferredLanguage(tag = navigator.language): string {
  const base = tag.slice(0, 2).toLowerCase();
  return LANGUAGES.some(([code]) => code === base) ? base : "en";
}

/** Why a translation did not happen, in words worth showing someone. */
export function translationMessage(reason: string | null, from: string | null): string {
  switch (reason) {
    case "already":
      return "This page is already in that language.";
    case "no-article":
      return "There is no article on this page to read.";
    case "unsupported":
      return "This build cannot translate pages.";
    case "unsupported-pair":
      return from ? `Dive cannot translate ${nameOf(from)} into that language yet.` : "That pair of languages is not available.";
    case "unavailable":
      return "The language could not be downloaded. Check the connection and try again.";
    case "unknown-language":
      return "Dive could not tell what language this page is in.";
    case "empty":
      return "There is nothing on this page to translate.";
    default:
      return "This page could not be translated.";
  }
}

function nameOf(code: string): string {
  return LANGUAGES.find(([key]) => key === code)?.[1] ?? code;
}

/**
 * Reader view and translation for the page in the address bar.
 *
 * Both act on the live page rather than opening something else: reader view
 * swaps the body for the article and puts it back, and translation rewrites
 * the text in place with the engine's on-device model -- nothing about the
 * page is sent anywhere. Both reset when the tab navigates, which is what the
 * page itself does to them.
 */
export function PageActions() {
  const tabId = useBrowser((s) => tabInThisWindow(s.activeTab, s.detached));
  const url = useBrowser((s) => {
    const id = tabInThisWindow(s.activeTab, s.detached);
    return id ? (s.tabs.find((t) => t.id === id)?.url ?? "") : "";
  });
  // Keyed by tab and address: a page that navigated is neither in reader view
  // nor translated any more, and a fresh pair of buttons is exactly that.
  if (!tabId || !/^https?:/i.test(url)) return null;
  return <Actions key={`${tabId}|${url}`} tabId={tabId} />;
}

function Actions({ tabId }: { tabId: string }) {
  const notify = useBrowser((s) => s.notify);
  const [reading, setReading] = useState(false);
  const [translated, setTranslated] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [menu, setMenu] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const dismiss = useCallback(() => setMenu(false), []);
  useDismiss(root, menu, dismiss);
  useCoversContent(menu);
  useFocusTrap(panel, { active: menu, menu: true, onEscape: dismiss });

  const toggleReader = async () => {
    setBusy(true);
    try {
      if (reading) {
        await ipc.pageReaderLeave(tabId);
        setReading(false);
      } else {
        const result = await ipc.pageReader(tabId);
        if (result.ok) setReading(true);
        else notify(translationMessage(result.reason, null), 4000);
      }
    } catch (error) {
      notify(errorMessage(error), 4000);
    } finally {
      setBusy(false);
    }
  };

  const translate = async (target: string) => {
    setMenu(false);
    setBusy(true);
    // The first use of a language pair downloads a model, which is not quick.
    notify(`Translating into ${nameOf(target)}…`, 2500);
    try {
      const result = await ipc.pageTranslate(tabId, target);
      if (result.ok) {
        setTranslated(target);
        notify(`Translated from ${nameOf(result.from ?? "")} into ${nameOf(target)}.`, 3000);
      } else {
        notify(translationMessage(result.reason, result.from), 5000);
      }
    } catch (error) {
      notify(errorMessage(error), 4000);
    } finally {
      setBusy(false);
    }
  };

  const showOriginal = async () => {
    setMenu(false);
    try {
      await ipc.pageTranslateRestore(tabId);
      setTranslated(null);
    } catch (error) {
      notify(errorMessage(error), 4000);
    }
  };

  const button = "grid size-6 place-items-center rounded-full text-ink-3 hover:bg-surface-3 hover:text-ink";
  return (
    <div ref={root} className="relative flex items-center gap-0.5">
      <WalletButton tabId={tabId} className={button} />
      <Tooltip label={reading ? "Leave reader view" : "Reader view"}>
        <button type="button" aria-label={reading ? "Leave reader view" : "Reader view"} aria-pressed={reading} onClick={() => void toggleReader()} className={`${button} ${reading ? "text-highlight" : ""}`}>
          <Icon icon={busy && !menu ? Loader2 : BookOpen} size={13} className={busy && !menu ? "motion-safe:animate-spin" : undefined} />
        </button>
      </Tooltip>
      <Tooltip label={translated ? `Translated into ${nameOf(translated)}` : "Translate this page"}>
        <button type="button" aria-label="Translate this page" aria-haspopup="menu" aria-expanded={menu} onClick={() => setMenu((open) => !open)} className={`${button} ${translated ? "text-highlight" : ""}`}>
          <Icon icon={Languages} size={13} />
        </button>
      </Tooltip>
      {menu && (
        <div ref={panel} role="menu" aria-label="Translate this page" className="surface-enter absolute top-full right-0 z-50 mt-1.5 max-h-[60vh] w-56 overflow-y-auto rounded-xl border border-line-2 bg-surface p-1 text-xs shadow-2xl">
          <p className="px-2.5 py-1.5 text-[10.5px] leading-snug text-ink-3">Translated on this machine; the page is not sent anywhere.</p>
          {translated && (
            <button type="button" role="menuitem" onClick={() => void showOriginal()} className="mb-1 w-full rounded-lg px-2.5 py-1.5 text-left text-ink hover:bg-surface-2">
              Show original
            </button>
          )}
          {LANGUAGES.map(([code, name]) => (
            <button key={code} type="button" role="menuitem" onClick={() => void translate(code)} className={`w-full rounded-lg px-2.5 py-1.5 text-left hover:bg-surface-2 ${translated === code ? "text-highlight" : "text-ink"}`}>
              {name}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * A saved address or card, into the form on this page.
 *
 * It only appears once something is saved, so a browser nobody has filled in
 * shows nothing, and filling is always this click -- the host reads a card
 * number for exactly this one fill and never at any other time.
 */
function WalletButton({ tabId, className }: { tabId: string; className: string }) {
  const addresses = useWallet((s) => s.addresses);
  const cards = useWallet((s) => s.cards);
  const loaded = useWallet((s) => s.loaded);
  const load = useWallet((s) => s.load);
  const fillAddress = useWallet((s) => s.fillAddress);
  const fillCard = useWallet((s) => s.fillCard);
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const dismiss = useCallback(() => setOpen(false), []);
  useDismiss(root, open, dismiss);
  useCoversContent(open);
  useFocusTrap(panel, { active: open, menu: true, onEscape: dismiss });
  useEffect(() => {
    if (!loaded) void load();
  }, [loaded, load]);
  if (loaded && addresses.length === 0 && cards.length === 0) return null;
  return (
    <div ref={root} className="relative">
      <Tooltip label="Fill a saved address or card">
        <button type="button" aria-label="Fill a saved address or card" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((was) => !was)} className={className}>
          <Icon icon={CreditCard} size={13} />
        </button>
      </Tooltip>
      {open && (
        <div ref={panel} role="menu" aria-label="Saved addresses and cards" className="surface-enter absolute top-full right-0 z-50 mt-1.5 w-64 rounded-xl border border-line-2 bg-surface p-1 text-xs shadow-2xl">
          {addresses.map((address) => (
            <button
              key={address.id}
              type="button"
              role="menuitem"
              onClick={() => {
                setOpen(false);
                void fillAddress(tabId, address.id);
              }}
              className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-ink hover:bg-surface-2"
            >
              <Icon icon={MapPin} size={12} className="shrink-0 text-ink-3" />
              <span className="truncate">{address.label || address.name}</span>
            </button>
          ))}
          {cards.map((card) => (
            <button
              key={card.id}
              type="button"
              role="menuitem"
              onClick={() => {
                setOpen(false);
                void fillCard(tabId, card.id);
              }}
              className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-ink hover:bg-surface-2"
            >
              <Icon icon={CreditCard} size={12} className="shrink-0 text-ink-3" />
              <span className="truncate">{card.label || describeCard(card)}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
