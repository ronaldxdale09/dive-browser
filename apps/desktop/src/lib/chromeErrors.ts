import { ipc } from "./ipc";

/**
 * Chrome errors reach the host log. The chrome's console is only readable
 * with its developer tools open, so a component that threw or a promise
 * nobody awaited used to leave no trace in a bug report.
 */
export function reportChromeError(kind: string, error: unknown, extra?: string | null): void {
  const message = error instanceof Error ? error.message || error.name : String(error);
  const stack = [error instanceof Error ? error.stack : undefined, extra ?? undefined].filter(Boolean).join("\n") || null;
  try {
    void ipc.logChromeError(kind, message, stack);
  } catch {
    // Reporting must never throw from inside an error handler.
  }
}

let installed = false;

/** Forward uncaught errors and unhandled rejections to the host log, once per document. */
export function installChromeErrorReporting(target: Window = window): void {
  if (installed) return;
  installed = true;
  target.addEventListener("error", (event: ErrorEvent) => {
    reportChromeError("uncaught", event.error ?? event.message, event.filename ? `${event.filename}:${event.lineno}:${event.colno}` : null);
  });
  target.addEventListener("unhandledrejection", (event: PromiseRejectionEvent) => {
    reportChromeError("unhandled rejection", event.reason);
  });
}

/** Tests only: let `installChromeErrorReporting` install again. */
export function resetChromeErrorReporting(): void {
  installed = false;
}
