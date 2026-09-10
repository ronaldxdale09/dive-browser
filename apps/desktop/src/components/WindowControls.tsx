import { getCurrentWindow } from "@tauri-apps/api/window";
import { useEffect, useState } from "react";
import { isWindows } from "../lib/commands";
import { errorMessage } from "../lib/errors";
import { useBrowser } from "../store/browser";

/**
 * Minimise, maximise and close, for platforms whose window controls the app
 * has to draw itself.
 *
 * macOS puts its traffic lights in the window frame, so the chrome only has
 * to leave a gutter for them. Windows draws a title bar the chrome would
 * otherwise sit underneath -- a second bar above the one Dive already has --
 * so the frame is turned off there and these take its place, in the corner
 * Windows keeps them and at the size Windows draws them.
 *
 * Nothing renders anywhere else, so a macOS build is unchanged.
 */
export function WindowControls() {
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    if (!isWindows()) return;
    const window = getCurrentWindow();
    let alive = true;
    const sync = () => void window.isMaximized().then((v) => alive && setMaximized(v)).catch(() => undefined);
    sync();
    // Dragging to the top edge maximises without the button being pressed,
    // so the glyph follows the window rather than the last click.
    const stop = window.onResized(sync);
    return () => {
      alive = false;
      void stop.then((off) => off()).catch(() => undefined);
    };
  }, []);

  if (!isWindows()) return null;

  // A window command the capability does not grant rejects rather than
  // throwing, so without this a missing permission looks exactly like a
  // button that does nothing -- which is how the first version of this
  // shipped.
  const act = (what: string, run: () => Promise<unknown>) => () => {
    run().catch((error: unknown) => {
      useBrowser.setState({ error: `Could not ${what} the window: ${errorMessage(error)}` });
    });
  };

  const button = "grid h-full w-[46px] place-items-center text-ink-2 transition-colors hover:bg-surface-2 hover:text-ink";
  return (
    // Not a drag region: these are the controls, not the handle.
    <div className="flex h-full shrink-0 items-stretch" data-tauri-drag-region="false" onMouseDown={(e) => e.stopPropagation()}>
      <button type="button" aria-label="Minimise" className={button} onClick={act("minimise", () => getCurrentWindow().minimize())}>
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden><path d="M0 5h10" stroke="currentColor" strokeWidth="1" /></svg>
      </button>
      <button
        type="button"
        aria-label={maximized ? "Restore" : "Maximise"}
        className={button}
        onClick={act("maximise", () => getCurrentWindow().toggleMaximize())}
      >
        {maximized ? (
          <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden>
            <path d="M2.5 2.5h5v5h-5z" stroke="currentColor" />
            <path d="M0.5 7.5v-7h7" stroke="currentColor" />
          </svg>
        ) : (
          <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden>
            <path d="M0.5 0.5h9v9h-9z" stroke="currentColor" />
          </svg>
        )}
      </button>
      {/* Red on hover, as every Windows app does; anything else reads as a
          different button than the one people are aiming for. */}
      <button
        type="button"
        aria-label="Close"
        className={`${button} hover:!bg-[#c42b1c] hover:!text-white`}
        onClick={act("close", () => getCurrentWindow().close())}
      >
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden>
          <path d="M0 0l10 10M10 0L0 10" stroke="currentColor" strokeWidth="1" />
        </svg>
      </button>
    </div>
  );
}
