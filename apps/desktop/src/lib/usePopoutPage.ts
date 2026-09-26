import { useEffect, useState } from "react";
import { events, ipc } from "./ipc";
import type { Tab } from "./ipc";
import { useBrowser, withoutRequest } from "../store/browser";
import { errorMessage } from "./errors";

/** A detached window owns one page, independently of the main workspace. */
export function usePopoutPage(tabId: string) {
  const [page, setPage] = useState<{ id: string; tab: Tab | null; ready: boolean; loading: boolean }>(() => ({
    id: tabId, tab: useBrowser.getState().tabs.find((tab) => tab.id === tabId) ?? null, ready: false, loading: false,
  }));
  useEffect(() => {
    let live = true;
    let revision = 0;
    const stops: (() => void)[] = [];
    const report = (error: unknown) => {
      if (live) useBrowser.setState({ error: errorMessage(error) });
    };
    void events.stateChanged.listen(({ payload }) => {
      if (!live) return;
      if (payload.type === "tab_upserted" && payload.data.id === tabId) {
        revision++;
        setPage((old) => ({ id: tabId, tab: payload.data, ready: old.id === tabId && old.ready, loading: old.id === tabId && old.loading }));
      } else if (payload.type === "tab_closed" && payload.data === tabId) {
        revision++;
        setPage({ id: tabId, tab: null, ready: true, loading: false });
      }
    }).then(async (stop) => {
      if (!live) { stop(); return; }
      stops.push(stop);
      const started = revision;
      try {
        const tab = await ipc.tabInfo(tabId);
        if (live && started === revision) setPage((old) => ({ id: tabId, tab, ready: true, loading: old.id === tabId && old.loading }));
        else if (live) setPage((old) => ({ ...old, ready: true }));
      } catch (error) {
        if (started === revision) report(error);
      }
    }).catch(report);
    void events.tabLoad.listen(({ payload }) => {
      if (!live || payload.tab_id !== tabId) return;
      setPage((old) => ({ id: tabId, tab: old.id === tabId ? old.tab : null, ready: old.id === tabId && old.ready, loading: payload.phase === "started" }));
      // The store keeps the load state (and a failed document's error), so the
      // window explains a failure the way the main window does, not as a raw code.
      useBrowser.getState().applyLoad(payload);
    }).then((stop) => { if (live) stops.push(stop); else stop(); }).catch(report);
    // A detached window never boots the whole store, so the page's questions
    // and its crashes have to be heard here. Without them a camera request
    // waited on a dialog no window drew until its deadline denied it, and a
    // crashed renderer left the window blank with nothing to say why.
    void events.permissionAsked.listen(({ payload }) => {
      if (live && payload.tab_id === tabId) useBrowser.getState().applyPermissionAsked(payload);
    }).then((stop) => { if (live) stops.push(stop); else stop(); }).catch(report);
    void events.permissionDismissed.listen(({ payload }) => {
      if (!live || payload.tab_id !== tabId) return;
      useBrowser.setState((s) => ({ permissionRequests: withoutRequest(s.permissionRequests, tabId, payload) }));
    }).then((stop) => { if (live) stops.push(stop); else stop(); }).catch(report);
    // Zoom steps start from the level the engine last reported, as in the
    // main window; a site's remembered level arrives here as the page loads.
    void events.tabZoom.listen(({ payload }) => {
      if (live && payload.tab_id === tabId && payload.factor != null) useBrowser.getState().applyZoom(tabId, payload.factor);
    }).then((stop) => { if (live) stops.push(stop); else stop(); }).catch(report);
    void events.tabCrashed.listen(({ payload }) => {
      if (live && payload.tab_id === tabId) useBrowser.getState().applyCrash(payload);
    }).then((stop) => { if (live) stops.push(stop); else stop(); }).catch(report);
    return () => { live = false; stops.forEach((stop) => stop()); };
  }, [tabId]);
  return page.id === tabId ? page : { id: tabId, tab: null, ready: false, loading: false };
}
