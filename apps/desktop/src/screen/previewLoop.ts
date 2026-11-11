/**
 * A paused, decoded preview is static. Keep requesting frames only while
 * playback can change it or the media element is still producing its frame.
 */
export function previewNeedsFrame(playing: boolean, readyState: number, seeking: boolean): boolean {
  return playing || readyState < 2 || seeking;
}

/**
 * Output time while the preview plays. The loop writes the playhead it
 * computed; any other playhead change is a seek, and the clock jumps to it.
 */
export class PlaybackClock {
  private written: number | null = null;
  constructor(public outMs: number) {}
  /** True when `playhead` was not written by this clock: someone sought. */
  sought(playhead: number): boolean {
    return this.written !== null && playhead !== this.written;
  }
  wrote(playhead: number) {
    this.written = playhead;
  }
  jump(outMs: number) {
    this.outMs = outMs;
    this.written = null;
  }
  /** Advance by `dtMs`; `ended` when the end was reached this step. */
  advance(dtMs: number, durationMs: number): { outMs: number; ended: boolean } {
    this.outMs = Math.min(durationMs, this.outMs + Math.max(0, dtMs));
    return { outMs: this.outMs, ended: this.outMs >= durationMs };
  }
}
