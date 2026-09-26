// Sound a page makes from script, for the audible-tab watcher (audio.js).
//
// That watcher runs in Dive's isolated world and hears every player in the
// document through the DOM. An `Audio` made in script and never inserted,
// and every AudioContext, exist only in the page's own world, so the
// constructors are wrapped here, in that world, and whether any of them is
// heard is said on the window as "__dive-audio-on" or "__dive-audio-off".
//
// Nothing here is secret and nothing reaches the host from here: the page
// can call these wrappers, replace them or say the same events itself, and
// all it gains is a speaker on its own tab, which playing a sound would
// give it anyway.

(function () {
  if (window.top !== window) return; // main frame only
  if (window.__diveAudioHooked) return;
  try {
    Object.defineProperty(window, "__diveAudioHooked", { value: true });
  } catch {
    return;
  }
  const players = new Set();
  const contexts = new Set();
  const seen = new WeakSet();
  const live = (set, predicate) => {
    let found = false;
    for (const ref of set) {
      const value = ref.deref();
      if (!value) set.delete(ref);
      else if (predicate(value)) found = true;
    }
    return found;
  };
  const heard = (element) => !element.paused && !element.ended && !element.muted && element.volume > 0;
  let said = false;
  let timer = 0;
  // Settled for a frame, like the watcher, so a seek's pause and play do not
  // flicker the speaker.
  const schedule = () => {
    if (timer) return;
    timer = setTimeout(() => {
      timer = 0;
      const now = live(players, heard) || live(contexts, (context) => context.state === "running");
      if (now === said) return;
      said = now;
      dispatchEvent(new Event(now ? "__dive-audio-on" : "__dive-audio-off"));
    }, 250);
  };
  const MEDIA_EVENTS = ["play", "playing", "pause", "ended", "emptied", "volumechange"];
  for (const name of ["Audio", "AudioContext", "webkitAudioContext"]) {
    const Native = window[name];
    if (typeof Native !== "function") continue;
    const audio = name === "Audio";
    try {
      window[name] = new Proxy(Native, {
        construct(target, args, newTarget) {
          const made = Reflect.construct(target, args, newTarget);
          if (audio) {
            if (!seen.has(made)) {
              seen.add(made);
              players.add(new WeakRef(made));
              for (const event of MEDIA_EVENTS) made.addEventListener(event, schedule, { passive: true });
            }
          } else {
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
      // A page that froze the global keeps its own constructor; the
      // document's media events still cover everything it puts in the page.
    }
  }
})();
