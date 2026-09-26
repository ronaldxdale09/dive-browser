import { BookOpen, CreditCard, Languages, Loader2, MapPin } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { ipc } from "../lib/ipc";
import { errorMessage } from "../lib/errors";
import { useCoversContent } from "../lib/overlay";
import { useDismiss } from "../lib/useDismiss";
import { useFocusTrap } from "../lib/useFocusTrap";
import { languageName, LANGUAGES, translationMessage } from "../lib/translate";
import { tabInThisWindow, useBrowser } from "../store/browser";
import { describeCard, useWallet } from "../store/wallet";
import { Icon } from "./Icon";
import { Tooltip } from "./Tooltip";

// The language list and messages are shared with the palette's command.
export { LANGUAGES, preferredLanguage, translationMessage } from "../lib/translate";

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
  const setPageMode = useBrowser((s) => s.setPageMode);
  // Kept per tab in the store, so reader view or a translation started from
  // the palette shows here too, and a tab switched back to still says so.
  const reading = useBrowser((s) => s.pageModes[tabId]?.reader ?? false);
  const translated = useBrowser((s) => s.pageModes[tabId]?.translated ?? null);
  // Each button spins for its own work: translating a long page is slow, and
  // the reader button spinning meanwhile said the wrong thing was busy.
  const [readerBusy, setReaderBusy] = useState(false);
  const [translateBusy, setTranslateBusy] = useState(false);
  const [menu, setMenu] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const dismiss = useCallback(() => setMenu(false), []);
  useDismiss(root, menu, dismiss);
  useCoversContent(menu);
  useFocusTrap(panel, { active: menu, menu: true, onEscape: dismiss });

  // A click made while the page was still being asked wins over the answer.
  const acted = useRef(false);

  // What the page is in right now: the buttons mount fresh on every tab
  // switch and address, and the page may have been changed from elsewhere.
  useEffect(() => {
    let alive = true;
    void Promise.all([ipc.pageReaderOpen(tabId).catch(() => null), ipc.pageTranslateState(tabId).catch(() => null)]).then(([reader, translation]) => {
      if (!alive || acted.current) return;
      const patch: { reader?: boolean; translated?: string | null } = {};
      if (reader !== null) patch.reader = reader;
      if (translation) patch.translated = translation.translated ? (translation.target ?? null) : null;
      if (Object.keys(patch).length > 0) setPageMode(tabId, patch);
    });
    return () => {
      alive = false;
    };
  }, [tabId, setPageMode]);

  const toggleReader = async () => {
    acted.current = true;
    setReaderBusy(true);
    try {
      if (reading) {
        await ipc.pageReaderLeave(tabId);
        setPageMode(tabId, { reader: false });
      } else {
        const result = await ipc.pageReader(tabId);
        if (result.ok) setPageMode(tabId, { reader: true });
        else notify(translationMessage(result.reason, null), 4000);
      }
    } catch (error) {
      notify(errorMessage(error), 4000);
    } finally {
      setReaderBusy(false);
    }
  };

  const translate = async (target: string) => {
    setMenu(false);
    if (translated === target) return;
    acted.current = true;
    setTranslateBusy(true);
    // The first use of a language pair downloads a model, which is not quick.
    notify(`Translating into ${languageName(target)}…`, 2500);
    try {
      const result = await ipc.pageTranslate(tabId, target);
      if (result.ok) {
        setPageMode(tabId, { translated: target });
        notify(`Translated from ${languageName(result.from ?? "")} into ${languageName(target)}.`, 3000);
      } else {
        notify(translationMessage(result.reason, result.from, target), 5000);
      }
    } catch (error) {
      notify(errorMessage(error), 4000);
    } finally {
      setTranslateBusy(false);
    }
  };

  const showOriginal = async () => {
    setMenu(false);
    acted.current = true;
    try {
      await ipc.pageTranslateRestore(tabId);
      setPageMode(tabId, { translated: null });
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
          <Icon icon={readerBusy ? Loader2 : BookOpen} size={13} className={readerBusy ? "motion-safe:animate-spin" : undefined} />
        </button>
      </Tooltip>
      <Tooltip label={translateBusy ? "Translating…" : translated ? `Translated into ${languageName(translated)}` : "Translate this page"}>
        <button type="button" aria-label="Translate this page" aria-busy={translateBusy || undefined} aria-haspopup="menu" aria-expanded={menu} onClick={() => setMenu((open) => !open)} className={`${button} ${translated ? "text-highlight" : ""}`}>
          <Icon icon={translateBusy ? Loader2 : Languages} size={13} className={translateBusy ? "motion-safe:animate-spin" : undefined} />
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
