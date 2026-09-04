import { invoke } from "@tauri-apps/api/core";

interface StartupObservation {
  controlsReady(): void;
  dispose(): void;
}
let active: StartupObservation | undefined;

/**
 * Observe the main chrome's real FCP. IPC carries only milestone names: Rust
 * timestamps receipt on its launch clock, so these are host-observed timings,
 * including renderer scheduling and IPC latency, not performance.now values.
 */
export function startStartupTelemetry(): () => void {
  active?.dispose();
  if (new URLSearchParams(window.location.search).has("popout")) return () => {};
  let disposed = false;
  let paintSent = false;
  let paintAcknowledged = false;
  let controlsRendered = false;
  let controlsSent = false;
  let observer: PerformanceObserver | undefined;

  const flushControls = () => {
    if (disposed || !paintAcknowledged || !controlsRendered || controlsSent) return;
    controlsSent = true;
    void invoke("report_startup_milestone", { milestone: "controls_ready" }).catch((error: unknown) => {
      console.warn("Could not report startup controls readiness", error);
    });
  };
  const observation: StartupObservation = {
    controlsReady() {
      if (disposed) return;
      controlsRendered = true;
      flushControls();
    },
    dispose() {
      disposed = true;
      observer?.disconnect();
      window.removeEventListener("pagehide", observation.dispose);
      if (active === observation) active = undefined;
    },
  };
  active = observation;
  if (typeof PerformanceObserver !== "undefined") {
    observer = new PerformanceObserver((entries) => {
      if (disposed || paintSent || !entries.getEntries().some((entry) => entry.name === "first-contentful-paint")) return;
      paintSent = true;
      observer?.disconnect();
      void invoke("report_startup_milestone", { milestone: "chrome_first_paint" }).then(() => {
        paintAcknowledged = true;
        flushControls();
      }).catch((error: unknown) => {
        console.warn("Could not report startup contentful paint", error);
      });
    });
    observer.observe({ type: "paint", buffered: true });
  }
  window.addEventListener("pagehide", observation.dispose, { once: true });
  return observation.dispose;
}

/** Wait for a frame to render after React removed the splash. Never use a timer fallback. */
export function scheduleControlsReady(): () => void {
  const observation = active;
  if (!observation) return () => {};
  let secondFrame: number | undefined;
  const firstFrame = requestAnimationFrame(() => {
    secondFrame = requestAnimationFrame(() => observation.controlsReady());
  });
  return () => {
    cancelAnimationFrame(firstFrame);
    if (secondFrame !== undefined) cancelAnimationFrame(secondFrame);
  };
}
