import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { ChromeRoot } from "./components/ChromeRoot";
import { ChromeErrorBoundary } from "./components/ChromeErrorBoundary";
import { startStartupTelemetry } from "./lib/startup";
import "./styles.css";

const root = document.getElementById("root");
if (!root) throw new Error("missing #root");
// A tab torn off into its own window loads the same bundle with the tab
// named in the query, and gets the small chrome that window needs.
const popout = new URLSearchParams(window.location.search).get("popout");
if (!popout) {
  const stopStartupTelemetry = startStartupTelemetry();
  import.meta.hot?.dispose(stopStartupTelemetry);
}

createRoot(root).render(
  <StrictMode>
    <ChromeErrorBoundary>
      <ChromeRoot tabId={popout} />
    </ChromeErrorBoundary>
  </StrictMode>,
);
