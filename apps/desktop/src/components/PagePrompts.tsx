import { useJsDialog } from "../store/jsDialog";
import { HttpAuthCard } from "./HttpAuthCard";
import { JsDialogCard } from "./JsDialogCard";

/**
 * The questions a page is waiting on -- its own `alert`/`confirm`/`prompt`
 * and a server's sign-in -- as one column at the top centre of the page.
 *
 * Both can be up at once (a page behind Basic auth that also asks before
 * leaving), and each used to be pinned to the same spot, so the second sat
 * exactly on top of the first with both holding the keyboard. Stacked in a
 * column both are readable, and only the first takes focus: the page's script
 * is the one that is paused, so its question is answered first and the
 * sign-in takes the keyboard once it is gone.
 *
 * `top` leaves room for whatever the window floats over the top of the page
 * (the find bar, a crash notice); `auth` is off where a window never shows a
 * sign-in challenge of its own.
 */
export function PagePrompts({ tabId, top = 8, auth = true }: { tabId: string | null; top?: number; auth?: boolean }) {
  const dialogUp = useJsDialog((s) => (tabId ? (s.byTab[tabId]?.length ?? 0) > 0 : false));
  return (
    <div style={{ top }} className="pointer-events-none absolute inset-x-0 z-40 flex flex-col items-center gap-2 px-2 *:pointer-events-auto">
      <JsDialogCard tabId={tabId} />
      {auth && <HttpAuthCard tabId={tabId} takesFocus={!dialogUp} />}
    </div>
  );
}
