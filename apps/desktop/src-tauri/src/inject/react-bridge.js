// Answers the element picker's "which React component is this?" from the
// page's own world, where React's fibers live (see component-bridge.js for
// the asking side, in Dive's isolated world).
//
// Nothing here is secret and nothing here reaches the host: it reads the
// page's fibers and says what it found on the element that asked. A page can
// answer for it or stop it answering, which only changes what the page says
// about its own components.
//
// @dive-include react-context.js

if (window.__diveComponentBridge) return;
Object.defineProperty(window, "__diveComponentBridge", { value: true });
addEventListener(
  "__dive-component-request",
  (event) => {
    const el = event.composedPath()[0];
    if (!(el instanceof Element)) return;
    let detail;
    try {
      detail = JSON.stringify(componentOf(el));
    } catch {
      return;
    }
    el.dispatchEvent(new CustomEvent("__dive-component-reply", { detail, bubbles: true, composed: true }));
  },
  true,
);
