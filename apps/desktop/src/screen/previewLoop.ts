/**
 * A paused, decoded preview is static. Keep requesting frames only while
 * playback can change it or the media element is still producing its frame.
 */
export function previewNeedsFrame(playing: boolean, readyState: number, seeking: boolean): boolean {
  return playing || readyState < 2 || seeking;
}
