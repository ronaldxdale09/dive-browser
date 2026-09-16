// Whether this page is making a sound, reported to the host whenever the
// answer changes. It is what puts the speaker on a tab, so it follows what a
// person would hear: a playing, unmuted element with the volume up, or a
// running AudioContext (games, synths, WebRTC playback).
//
// The host's own mute is native and applies underneath this; the page cannot
// see it and does not need to.

(function () {
  if (window.top !== window) return; // main frame only
  if (window.__diveAudioInstalled) return;
  window.__diveAudioInstalled = true;
  const NONCE = __NONCE__;
  let reported = null;
  const send = (audible) => {
    if (audible === reported) return;
    reported = audible;
    try {
      window.__BINDING__(JSON.stringify({ nonce: NONCE, audible }));
    } catch {
      // No binding, or a page that broke JSON: nothing to report.
    }
  };

  // Media elements come and go; holding them weakly keeps a finished player
  // collectable, the way the activity guard does.
  const players = new Set();
  const contexts = new Set();
  const seen = new WeakSet();
  const watch = (element) => {
    if (seen.has(element)) return;
    seen.add(element);
    players.add(new WeakRef(element));
    for (const event of ["play", "playing", "pause", "ended", "emptied", "volumechange"]) {
      element.addEventListener(event, schedule, { passive: true });
    }
  };
  const heard = (element) => !element.paused && !element.ended && !element.muted && element.volume > 0;
  const live = (set, predicate) => {
    let found = false;
    for (const ref of set) {
      const value = ref.deref();
      if (!value) set.delete(ref);
      else if (predicate(value)) found = true;
    }
    return found;
  };

  let timer = 0;
  // A play/pause pair while a player seeks would otherwise flicker the tab's
  // speaker on and off; one frame of settling is enough to hide that.
  function schedule() {
    if (timer) return;
    timer = setTimeout(() => {
      timer = 0;
      send(live(players, heard) || live(contexts, (context) => context.state === "running"));
    }, 250);
  }

  const scan = () => {
    for (const element of document.querySelectorAll("video, audio")) watch(element);
    schedule();
  };

  // Elements built in script and never inserted still play, so the
  // constructors are watched as well as the document.
  for (const name of ["Audio", "AudioContext", "webkitAudioContext"]) {
    const Native = window[name];
    if (typeof Native !== "function") continue;
    const audio = name === "Audio";
    try {
      window[name] = new Proxy(Native, {
        construct(target, args, newTarget) {
          const made = Reflect.construct(target, args, newTarget);
          if (audio) watch(made);
          else {
            contexts.add(new WeakRef(made));
            made.addEventListener?.("statechange", schedule);
            schedule();
          }
          return made;
        },
      });
      // This wrapper replaces a global the activity guard may have proxied
      // first. Telling it so keeps its coverage known; without this every
      // tab looks tampered with and none is ever discarded.
      window.__diveActivityAdopt?.(window, name);
    } catch {
      // A page that froze the global keeps its own constructor; the document
      // scan below still covers everything it puts in the page.
    }
  }

  const observer = new MutationObserver(scan);
  const start = () => {
    observer.observe(document.documentElement, { childList: true, subtree: true });
    scan();
  };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start, { once: true });
  else start();
  // A page put in the back/forward cache stops making sound.
  addEventListener("pagehide", () => send(false));
  addEventListener("pageshow", schedule);
})();
