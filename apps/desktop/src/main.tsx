import { StrictMode } from "react";
import { bootMark } from "./lib/bootMarks";
import { createRoot } from "react-dom/client";
import { ChromeRoot } from "./components/ChromeRoot";
import { ChromeErrorBoundary } from "./components/ChromeErrorBoundary";
import { startStartupTelemetry } from "./lib/startup";
import { installChromeErrorReporting } from "./lib/chromeErrors";
import { ipc } from "./lib/ipc";
import "./styles.css";
import { isPrivateWindow } from "./lib/privateMode";
import { loadUiStorage } from "./lib/uiStorage";
import { useLayout } from "./store/layout";
import { useConnectHint } from "./store/connectHint";
import { useRecording } from "./store/recording";
import { rememberedModel, useSubtitles } from "./store/subtitles";

bootMark("script_start");
if (isPrivateWindow()) document.documentElement.dataset.private = "true";

// Errors outside React's reach (a throw in an event handler, a promise nobody
// awaited) go to the host log too; the console is only seen with devtools open.
installChromeErrorReporting();
// This document is new: a first boot, or a reload after the chrome's renderer
// died. Whatever cover or overlay mask the last document left over the page
// belonged to dialogs that no longer exist, so the host takes it down.
void ipc.chromeReady().catch(() => undefined);

const root = document.getElementById("root");
if (!root) throw new Error("missing #root");
// A tab torn off into its own window loads the same bundle with the tab
// named in the query, and gets the small chrome that window needs.
const query = new URLSearchParams(window.location.search);
const popout = query.get("popout");
// An installed app's window carries the app id too, for the app chrome.
const appId = query.get("app");
if (!popout) {
  const stopStartupTelemetry = startStartupTelemetry();
  import.meta.hot?.dispose(stopStartupTelemetry);
}

// The chrome's own state comes from the profile store (see `uiStorage`);
// the persisted stores hydrate from it before the first paint.
void loadUiStorage()
  .then(() =>
    Promise.all([useLayout.persist.rehydrate(), useRecording.persist.rehydrate(), useConnectHint.persist.rehydrate()]),
  )
  .then(() => {
    bootMark("ui_storage_loaded");
    useSubtitles.setState({ model: rememberedModel() });
  })
  .catch(() => undefined)
  .finally(() => {
// The chrome never scrolls: the page is a native view placed over it, so a
// scrolled chrome puts every control out of line with the page. Overflow
// clip on the root does not stop programmatic scrolling of the viewport
// (focus and scrollIntoView still move it), so snap it back whenever it moves.
window.addEventListener(
  "scroll",
  () => {
    if (window.scrollX !== 0 || window.scrollY !== 0) window.scrollTo(0, 0);
  },
  { passive: true },
);

    createRoot(root).render(
      <StrictMode>
        <ChromeErrorBoundary>
          <ChromeRoot tabId={popout} appId={appId} />
        </ChromeErrorBoundary>
      </StrictMode>,
    );
  });
