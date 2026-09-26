import { Check, Globe } from "lucide-react";
import { useRef } from "react";
import { useBrowser } from "../store/browser";
import { useDefaultBrowser } from "../store/defaultBrowser";
import { browserForBundle, useBrowserImport } from "../store/browserImport";
import { Icon } from "./Icon";
import { useCoversContent } from "../lib/overlay";
import { useFadeClose } from "../lib/useFadeClose";
import { useFocusTrap } from "../lib/useFocusTrap";
import { isWindows } from "../lib/commands";

export { POLL_INTERVAL_MS, WAIT_TIMEOUT_MS, WINDOWS_WAIT_TIMEOUT_MS } from "../store/defaultBrowser";

const KNOWN: Record<string, string> = {
  "com.apple.safari": "Safari",
  "com.google.chrome": "Chrome",
  "com.brave.browser": "Brave",
  "org.mozilla.firefox": "Firefox",
};

/** A bundle id as a name, for the handful of browsers people actually have. */
export function prettyBundleId(id: string): string {
  return KNOWN[id.toLowerCase()] ?? id;
}

/** Where this OS lets someone pick the default browser. Windows opens `ms-settings:defaultapps`. */
export function defaultBrowserSettingsPath(windows = isWindows()): string {
  return windows
    ? "Settings › Apps › Default apps"
    : "System Settings › Desktop & Dock › Default web browser";
}

export function defaultBrowserAskCopy(windows = isWindows()): string {
  return windows
    ? "Links from other apps will open in Dive. Windows Settings will open so you can pick Dive."
    : "Links from other apps will open in Dive. macOS will ask you to confirm.";
}

export function defaultBrowserWaitingCopy(windows = isWindows()): string {
  return windows
    ? "Waiting for Windows… pick Dive under Settings › Apps › Default apps."
    : "Waiting for macOS… choose “Use Dive” in the system dialog.";
}

export function defaultBrowserTimeoutCopy(windows = isWindows()): string {
  return `Still not the default. You can set it under ${defaultBrowserSettingsPath(windows)}.`;
}

/** Short hint on first-run Features, next to Set as default. */
export function defaultBrowserOnboardingHint(waiting: boolean, windows = isWindows()): string {
  if (waiting) {
    return windows
      ? " · pick Dive under Settings › Apps › Default apps."
      : " · macOS is asking you to confirm.";
  }
  return windows
    ? " · Windows Settings will open so you can pick Dive."
    : " · macOS will ask to confirm.";
}

function isDive(id: string): boolean {
  return /dive/i.test(id);
}

/**
 * Ask macOS to make Dive the default browser, and say how it went.
 *
 * The system shows its own confirmation, and the command returns before that
 * is answered, so after asking we poll the status until it flips or a timeout
 * passes; either way the dialog says what to do next.
 */
export function DefaultBrowserDialog() {
  const open = useBrowser((s) => s.open.defaultBrowser);
  const toggle = useBrowser((s) => s.toggle);
  const status = useDefaultBrowser((s) => s.status);
  const phase = useDefaultBrowser((s) => s.phase);
  const error = useDefaultBrowser((s) => s.error);
  const decline = useDefaultBrowser((s) => s.decline);
  const makeDefault = useDefaultBrowser((s) => s.makeDefault);
  const reset = useDefaultBrowser((s) => s.reset);
  // The store follows the answer, so setup's own button hears it too.
  const timedOut = useDefaultBrowser((s) => s.timedOut);
  useCoversContent(open);
  const root = useRef<HTMLDivElement>(null);
  const primary = useRef<HTMLButtonElement>(null);
  useFocusTrap(root, { active: open, initialFocus: primary });
  const { close, className } = useFadeClose(() => {
    reset();
    toggle("defaultBrowser", false);
  });
  // Declining rests the rail's offer for this session; the dialog stays reachable from Settings.
  const notNow = () => {
    decline();
    close();
  };

  if (!open) return null;

  const alreadyDefault = phase === "idle" && Boolean(status?.is_default);
  const done = phase === "done";
  const current = status?.current && !isDive(status.current) ? prettyBundleId(status.current) : null;
  const importable = browserForBundle(status?.current);
  // The browser being replaced is the one worth importing from; the offer
  // sits here because this is the moment someone is leaving it.
  const openImport = () => {
    useBrowserImport.getState().setPreferBrowser(importable);
    close();
    toggle("import", true);
  };
  const importRow = current && (
    <p className="mt-2.5 flex items-center gap-2 border-t border-line pt-2.5 text-[11px] text-ink-3">
      <span className="min-w-0 flex-1">Bring your bookmarks, history, passwords and form entries from {current} too.</span>
      <button type="button" onClick={openImport} className="pressable h-7 shrink-0 rounded-full border border-line-2 px-2.5 text-[11px] text-ink-2 hover:bg-surface-2 hover:text-ink">
        Import…
      </button>
    </p>
  );
  const title = alreadyDefault ? "Dive is your default browser" : done ? "Dive is now your default browser" : "Make Dive your default browser";

  const start = () => void makeDefault();

  let body: React.ReactNode;
  let actions: React.ReactNode;
  const secondary = "h-8 rounded-full px-3 text-xs text-ink-2 hover:bg-surface-2";
  const primaryClass = "h-8 rounded-full bg-accent px-4 text-xs font-medium text-accent-ink disabled:opacity-40";

  if (alreadyDefault) {
    body = <p className="text-xs text-ink-2">Links from other apps already open here.</p>;
    actions = (
      <button ref={primary} type="button" onClick={close} className={primaryClass}>
        Close
      </button>
    );
  } else if (done) {
    body = (
      <>
        <p className="text-xs text-ink-2">Links from other apps will open in Dive from now on.</p>
        {importRow}
      </>
    );
    actions = (
      <button ref={primary} type="button" onClick={close} className={primaryClass}>
        Done
      </button>
    );
  } else if (phase === "error") {
    body = (
      <p className="text-xs text-danger" role="alert">
        {error ?? "Something went wrong."}
      </p>
    );
    actions = (
      <>
        <button type="button" onClick={notNow} className={secondary}>
          Not now
        </button>
        <button ref={primary} type="button" onClick={start} className={primaryClass}>
          Try again
        </button>
      </>
    );
  } else if (phase === "waiting" && timedOut) {
    body = (
      <p className="text-xs text-ink-2" role="status">
        {defaultBrowserTimeoutCopy()}
      </p>
    );
    actions = (
      <>
        <button type="button" onClick={notNow} className={secondary}>
          Not now
        </button>
        <button ref={primary} type="button" onClick={start} className={primaryClass}>
          Try again
        </button>
      </>
    );
  } else if (phase === "waiting") {
    body = (
      <p className="text-xs text-ink-2" role="status">
        {defaultBrowserWaitingCopy()}
      </p>
    );
    actions = (
      <button type="button" onClick={notNow} className={secondary}>
        Not now
      </button>
    );
  } else {
    body = (
      <>
        <p className="text-xs text-ink-2">{defaultBrowserAskCopy()}</p>
        {current && <p className="mt-1.5 text-[11px] text-ink-3">Currently: {current}</p>}
        {importRow}
      </>
    );
    actions = (
      <>
        <button type="button" onClick={notNow} className={secondary}>
          Not now
        </button>
        <button ref={primary} type="button" onClick={start} disabled={phase === "asking"} className={primaryClass}>
          Make default
        </button>
      </>
    );
  }

  return (
    <div ref={root} className={`overlay-backdrop fixed inset-0 z-50 ${className}`} onMouseDown={close}>
      <div
        onMouseDown={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onKeyDown={(e) => e.key === "Escape" && close()}
        className="mx-auto mt-28 w-[380px] rounded-2xl border border-line-2 bg-surface p-4 shadow-2xl"
      >
        <div className="flex items-center gap-2.5">
          <span className="relative grid size-8 shrink-0 place-items-center rounded-[11px] bg-surface-2 text-ink-2">
            <Icon icon={Globe} size={16} />
            {(alreadyDefault || done) && (
              <span className="absolute -right-1 -bottom-1 grid size-3.5 place-items-center rounded-full bg-accent text-accent-ink" aria-hidden>
                <Icon icon={Check} size={9} />
              </span>
            )}
          </span>
          <h2 className="min-w-0 text-sm font-semibold">{title}</h2>
        </div>
        <div className="mt-3">{body}</div>
        <div className="mt-5 flex items-center gap-2">
          <span className="flex-1" />
          {actions}
        </div>
      </div>
    </div>
  );
}

