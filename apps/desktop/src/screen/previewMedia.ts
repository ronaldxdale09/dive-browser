import { recordMediaProbe } from "./mediaProbe";

/** Explicit ownership of one preview resource on a reusable media element. */
const leases = new WeakMap<HTMLVideoElement, () => void>();

export function leasePreviewMedia(
  video: HTMLVideoElement,
  source: string,
  { isCurrent, onError, generation }: { isCurrent: () => boolean; onError: () => void; generation?: number },
): () => void {
  leases.get(video)?.();
  let active = true;
  let timer = 0;
  const current = () => active && leases.get(video) === release && isCurrent();
  const error = () => {
    if (current()) {
      recordMediaProbe(video, "media_error", generation);
      onError();
    }
  };
  function release() {
    if (!active) return;
    active = false;
    window.clearTimeout(timer);
    video.removeEventListener("error", error);
    if (leases.get(video) !== release) return;
    recordMediaProbe(video, "lease_release", generation);
    leases.delete(video);
    video.pause();
    // Removing the DOM only pauses Chromium's media player. Clearing the
    // source and invoking the load algorithm explicitly releases its resource.
    video.removeAttribute("src");
    video.load();
  }
  leases.set(video, release);
  video.addEventListener("error", error);
  // This effect owns src as well as teardown; React must not set the next src
  // before the previous resource's cleanup removes it.
  recordMediaProbe(video, "lease_setup", generation);
  video.src = source;
  video.load();
  timer = window.setTimeout(() => {
    if (current() && video.readyState < 1) {
      void video.play().then(() => {
        if (current()) video.pause();
      }).catch(() => undefined);
    }
  }, 400);
  return release;
}
