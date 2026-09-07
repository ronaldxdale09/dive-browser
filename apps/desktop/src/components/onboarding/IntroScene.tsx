import { Player } from "@remotion/player";
import type { PlayerRef } from "@remotion/player";
import { useEffect, useRef, useState } from "react";
import { useReducedMotion } from "../../lib/useReducedMotion";
import { useOnboarding } from "../../store/onboarding";
import { INTRO_DURATION, INTRO_FPS, INTRO_HEIGHT, INTRO_POSTER_FRAME, INTRO_WIDTH, Intro } from "../../video/Intro";

/** How long the intro's last frame crossfades into the start screen. */
export const INTRO_EXIT_MS = 420;
/** Frames before the end at which the fade begins, so it finishes as the reel does. */
export const INTRO_EXIT_FRAMES = Math.round((INTRO_EXIT_MS / 1000) * INTRO_FPS);
/** Under reduced motion the poster holds this long, then the flow moves on. */
export const INTRO_STILL_MS = 1600;

/**
 * The five-second sting, full window. It plays once, then hands over to the
 * start screen; Skip, Enter, Space or Escape hand over early. With reduced
 * motion it shows the finished lockup as a still instead of animating.
 */
export function IntroScene() {
  const skip = useOnboarding((s) => s.skipIntro);
  const reduced = useReducedMotion();
  const ref = useRef<PlayerRef>(null);
  const [leaving, setLeaving] = useState(false);

  // Leave once, whatever asked for it: the end of the reel, a key, or the button.
  const leave = () => {
    setLeaving((was) => {
      if (!was) window.setTimeout(skip, INTRO_EXIT_MS);
      return true;
    });
  };

  useEffect(() => {
    const player = ref.current;
    if (!player) return;
    if (reduced) {
      player.pause();
      player.seekTo(INTRO_POSTER_FRAME);
      const t = window.setTimeout(leave, INTRO_STILL_MS);
      return () => window.clearTimeout(t);
    }
    // Leave a few frames before the end so the fade covers the reel's last
    // frames, and pin the final frame when it ends: a player that has ended
    // may rewind to its first frame, which would flash the empty ground.
    const onFrame = ({ detail }: { detail: { frame: number } }) => {
      if (detail.frame >= INTRO_DURATION - INTRO_EXIT_FRAMES) leave();
    };
    const hold = () => {
      player.pause();
      player.seekTo(INTRO_DURATION - 1);
    };
    player.addEventListener("frameupdate", onFrame);
    player.addEventListener("ended", hold);
    return () => {
      player.removeEventListener("frameupdate", onFrame);
      player.removeEventListener("ended", hold);
    };
    // `leave` is stable enough: it only touches state setters and the store.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reduced]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Enter" || e.key === " " || e.key === "Escape") {
        e.preventDefault();
        leave();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div
      role="dialog"
      aria-label="Welcome to Dive"
      className="onboarding-intro fixed inset-0 z-[61] bg-ground"
      style={{ opacity: leaving ? 0 : 1, transition: `opacity ${INTRO_EXIT_MS}ms ease-in` }}
    >
      <Player
        ref={ref}
        component={Intro}
        durationInFrames={INTRO_DURATION}
        fps={INTRO_FPS}
        compositionWidth={INTRO_WIDTH}
        compositionHeight={INTRO_HEIGHT}
        autoPlay={!reduced}
        initiallyMuted
        loop={false}
        controls={false}
        clickToPlay={false}
        initialFrame={reduced ? INTRO_POSTER_FRAME : 0}
        style={{ width: "100%", height: "100%" }}
      />
      <button
        type="button"
        onClick={leave}
        className="pressable absolute top-5 right-6 h-8 rounded-full border border-line-2 bg-surface/70 px-3.5 font-mono text-[11px] tracking-[0.12em] text-ink-2 uppercase backdrop-blur hover:bg-surface-2 hover:text-ink"
      >
        Skip
      </button>
    </div>
  );
}
