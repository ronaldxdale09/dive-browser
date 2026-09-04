import { Player } from "@remotion/player";
import type { PlayerRef } from "@remotion/player";
import { useEffect, useRef } from "react";
import { useReducedMotion } from "../lib/useReducedMotion";
import { DURATION, POSTER_FRAME, Showcase } from "../video/Showcase";
import { FPS, HEIGHT, WIDTH } from "../video/primitives";

/**
 * The one-minute feature reel on the welcome screen.
 *
 * Played live by Remotion's Player rather than shipped as a video file: the
 * composition is React drawn from the chrome's own CSS variables, so it
 * follows the theme and accent, stays sharp at any width, and costs no
 * megabytes. It has no sound, so autoplay is never blocked.
 */
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
      return;
    }
    let inView = true;
    const sync = () => {
      const player = ref.current;
      if (!player) return;
      if (document.hidden || !inView) player.pause();
      else player.play();
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
      role="img"
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
        loop
        controls={false}
        clickToPlay={false}
        initialFrame={reduced ? POSTER_FRAME : 0}
        style={{ width: "100%", height: "100%" }}
      />
    </div>
  );
}
