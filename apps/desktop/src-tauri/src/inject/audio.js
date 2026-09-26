// Whether this page is making a sound, reported to the host whenever the
// answer changes. It is what puts the speaker on a tab, so it follows what a
// person would hear: a playing, unmuted element with the volume up, or a
// running AudioContext (games, synths, WebRTC playback).
//
// This half runs in Dive's isolated world (see page_world.rs) and alone
// holds the binding and its nonce. It hears every player in the document
// through the DOM, which the worlds share. What only the page's own world
// can see -- an `Audio` made in script and never inserted, an AudioContext
// -- is followed by audio-hooks.js there, which says "__dive-audio-on" or
// "__dive-audio-off" on the window. The page can say those too; all it can
// claim that way is a sound it could just as well make.
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
      // No binding: nothing to report.
    }
  };

  // Media elements come and go; holding them weakly keeps a finished player
  // collectable, the way the activity guard does.
  const players = new Set();
  const seen = new WeakSet();
  const MEDIA_EVENTS = ["play", "playing", "pause", "ended", "emptied", "volumechange"];
  const Media = window.HTMLMediaElement;
  const watch = (element) => {
    if (seen.has(element)) return;
    seen.add(element);
    players.add(new WeakRef(element));
    for (const event of MEDIA_EVENTS) {
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
  // Sound made from the page's own world, as audio-hooks.js last said.
  let scripted = false;

  let timer = 0;
  // A play/pause pair while a player seeks would otherwise flicker the tab's
  // speaker on and off; one frame of settling is enough to hide that.
  function schedule() {
    if (timer) return;
    timer = setTimeout(() => {
      timer = 0;
      send(live(players, heard) || scripted);
    }, 250);
  }

  // Every media event of the document passes through the window on the way
  // down, bubbling or not, so a listener there learns of each player the
  // first time it does anything. Registered at document start, it runs
  // before any capture listener the page adds, which cannot hide a player
  // from it. A player seen once is then watched directly, so it is still
  // heard after it leaves the document.
  const noticed = (event) => {
    const target = event.target;
    if (Media && target instanceof Media) watch(target);
    schedule();
  };
  for (const event of MEDIA_EVENTS) {
    addEventListener(event, noticed, { capture: true, passive: true });
  }
  addEventListener("__dive-audio-on", () => {
    scripted = true;
    schedule();
  });
  addEventListener("__dive-audio-off", () => {
    scripted = false;
    schedule();
  });

  // A page put in the back/forward cache stops making sound.
  addEventListener("pagehide", () => send(false));
  addEventListener("pageshow", schedule);
})();
