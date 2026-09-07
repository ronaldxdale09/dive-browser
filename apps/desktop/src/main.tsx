import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { ChromeRoot } from "./components/ChromeRoot";
import { ChromeErrorBoundary } from "./components/ChromeErrorBoundary";
import { startStartupTelemetry } from "./lib/startup";
import "./styles.css";
import { isPrivateWindow } from "./lib/privateMode";
import { loadUiStorage } from "./lib/uiStorage";
import { useLayout } from "./store/layout";
import { useRecording } from "./store/recording";
import { rememberedModel, useSubtitles } from "./store/subtitles";

if (isPrivateWindow()) document.documentElement.dataset.private = "true";

const root = document.getElementById("root");
if (!root) throw new Error("missing #root");
// A tab torn off into its own window loads the same bundle with the tab
// named in the query, and gets the small chrome that window needs.
const popout = new URLSearchParams(window.location.search).get("popout");
if (!popout) {
  const stopStartupTelemetry = startStartupTelemetry();
  import.meta.hot?.dispose(stopStartupTelemetry);
}

// The chrome's own state comes from the profile store (see `uiStorage`);
// the persisted stores hydrate from it before the first paint.
void loadUiStorage()
  .then(() => Promise.all([useLayout.persist.rehydrate(), useRecording.persist.rehydrate()]))
  .then(() => useSubtitles.setState({ model: rememberedModel() }))
  .catch(() => undefined)
  .finally(() => {
    createRoot(root).render(
      <StrictMode>
        <ChromeErrorBoundary>
          <ChromeRoot tabId={popout} />
        </ChromeErrorBoundary>
      </StrictMode>,
    );
  });
