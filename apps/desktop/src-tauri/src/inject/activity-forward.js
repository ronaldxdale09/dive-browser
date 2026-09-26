// Carries the activity guard's "something changed" to the host.
//
// The guard (activity-guard.js) has to live in the page's own world: what it
// watches -- constructors, capture requests, beforeunload handlers -- is the
// page's JavaScript, which no other world can see. The binding and its nonce
// do not have to, so they live here, in Dive's isolated world (see
// page_world.rs), and the guard says "__dive-activity-changed" on the window
// instead. Cancelling the event is how the guard learns the host was told;
// one nobody cancelled leaves its evidence unknown, which keeps the tab.
//
// The page can say the same event. All that does is keep its own tab from
// being discarded, which it could as well do by playing a sound.

(function () {
  if (window.__diveActivityForwarding) return;
  window.__diveActivityForwarding = true;
  const payload = JSON.stringify({ nonce: __NONCE__ });
  const bind = window.__diveActivityChanged;
  // Capture, and registered at document start: at the window every capture
  // listener runs before any other, and this one before the page's.
  addEventListener(
    "__dive-activity-changed",
    (event) => {
      try {
        bind(payload);
        event.preventDefault();
      } catch (_) {
        // No binding: the guard sees the event uncancelled.
      }
    },
    true,
  );
})();
