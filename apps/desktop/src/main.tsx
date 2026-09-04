import { lazy, StrictMode, Suspense } from "react";
import { createRoot } from "react-dom/client";
import { ChromeErrorBoundary } from "./components/ChromeErrorBoundary";
import "./styles.css";

const App = lazy(() => import("./App").then(({ App }) => ({ default: App })));
const Popout = lazy(() => import("./components/Popout").then(({ Popout }) => ({ default: Popout })));

const root = document.getElementById("root");
if (!root) throw new Error("missing #root");
// A tab torn off into its own window loads the same bundle with the tab
// named in the query, and gets the small chrome that window needs.
const popout = new URLSearchParams(window.location.search).get("popout");

createRoot(root).render(
  <StrictMode>
    <ChromeErrorBoundary>
      <Suspense fallback={<div className="h-full bg-ground" aria-label="Loading Dive" />}>
        {popout ? <Popout tabId={popout} /> : <App />}
      </Suspense>
    </ChromeErrorBoundary>
  </StrictMode>,
);
