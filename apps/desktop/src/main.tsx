import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { Popout } from "./components/Popout";
import "./styles.css";

const root = document.getElementById("root");
if (!root) throw new Error("missing #root");
// A tab torn off into its own window loads the same bundle with the tab
// named in the query, and gets the small chrome that window needs.
const popout = new URLSearchParams(window.location.search).get("popout");
createRoot(root).render(
  <StrictMode>
    {popout ? <Popout tabId={popout} /> : <App />}
  </StrictMode>,
);
