/**
 * The chrome document's own boot marks, on its `performance.now()` clock.
 * Startup telemetry sends them once with controls readiness, so the host can
 * place each step on the launch clock (see `observe_renderer_timeline`).
 */
export type BootMark = "script_start" | "ui_storage_loaded" | "app_module_loaded" | "app_rendered" | "boot_ready";

const marks = new Map<string, number>();

/** Note the first time this boot reaches `name`; later calls keep the first. */
export function bootMark(name: BootMark): void {
  if (!marks.has(name)) marks.set(name, performance.now());
}

/** Navigation timing plus every boot mark reached so far. */
export function bootTimeline(): Record<string, number> {
  const timeline: Record<string, number> = { navigation_start: 0 };
  const navigation = performance.getEntriesByType?.("navigation")[0] as PerformanceNavigationTiming | undefined;
  if (navigation) {
    if (navigation.responseEnd > 0) timeline.response_end = navigation.responseEnd;
    if (navigation.domInteractive > 0) timeline.dom_interactive = navigation.domInteractive;
  }
  // The static shell in index.html stamps its own first frame.
  const shell = (window as { __diveShellPainted?: number }).__diveShellPainted;
  if (typeof shell === "number" && shell >= 0) timeline.shell_painted = shell;
  for (const [name, at] of marks) timeline[name] = at;
  return timeline;
}

/** Tests only. */
export function resetBootMarks(): void {
  marks.clear();
}
