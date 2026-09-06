import { Player } from "@remotion/player";
import type { PlayerRef } from "@remotion/player";
import { useEffect, useRef } from "react";
import { useReducedMotion } from "../lib/useReducedMotion";
import { DURATION, POSTER_FRAME, Showcase } from "../video/Showcase";
import { FPS, HEIGHT, WIDTH } from "../video/primitives";

/** Explicitly opened feature tour. Player controls own playback; it does not loop. */
export function FeatureReel() {
  const ref = useRef<PlayerRef>(null);
  const root = useRef<HTMLDivElement>(null);
  const reduced = useReducedMotion();

  // Thirty React renders a second are not free; stop when the window is
  // hidden, and stop for good (on the poster frame) under reduced motion --
  // including when that preference changes while the reel is playing.
  useEffect(() => {
    const player = ref.current;
    if (!player) return;
    if (reduced) {
      player.pause();
      player.seekTo(POSTER_FRAME);
    }
    let inView = true;
    let suspended = false;
    let resume = false;
    const sync = () => {
      const player = ref.current;
      if (!player) return;
      const hidden = document.hidden || !inView;
      if (hidden && !suspended) { resume = player.isPlaying(); player.pause(); }
      else if (!hidden && suspended && resume) player.play();
      suspended = hidden;
    };
    const observer = new IntersectionObserver(([entry]) => {
      inView = entry?.isIntersecting ?? true;
      sync();
    }, { rootMargin: "120px" });
    if (root.current) observer.observe(root.current);
    sync();
    document.addEventListener("visibilitychange", sync);
    return () => {
      observer.disconnect();
      document.removeEventListener("visibilitychange", sync);
    };
  }, [reduced]);

  return (
    <div
      ref={root}
      role="region"
      aria-label="A tour of what Dive can do: workspaces, coding agents, an agent that acts, network and console inspection, mock rules, a mobile simulator, GIF recording, full-page capture, a Playwright recorder, bug reports and local server sharing."
      className="w-full overflow-hidden rounded-2xl border border-line bg-surface shadow-[0_40px_90px_-50px_rgba(0,0,0,.8)]"
      style={{ aspectRatio: `${WIDTH} / ${HEIGHT}` }}
    >
      <Player
        ref={ref}
        component={Showcase}
        durationInFrames={DURATION}
        fps={FPS}
        compositionWidth={WIDTH}
        compositionHeight={HEIGHT}
        autoPlay={!reduced}
        initiallyMuted
        loop={false}
        controls
        clickToPlay
        initialFrame={reduced ? POSTER_FRAME : 0}
        style={{ width: "100%", height: "100%" }}
      />
    </div>
  );
}
