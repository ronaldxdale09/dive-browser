import { useEffect, useState } from "react";
import { ipc } from "./ipc";

/** Icons already fetched this session, by app id; an app's icon does not change while it is installed. */
const cache = new Map<string, string | null>();
const inflight = new Map<string, Promise<string | null>>();

/** Read an installed app's icon once, as a data URL the chrome can render. */
export function loadWebAppIcon(appId: string): Promise<string | null> {
  const known = cache.get(appId);
  if (known !== undefined) return Promise.resolve(known);
  let pending = inflight.get(appId);
  if (!pending) {
    pending = ipc.webappIcon(appId)
      .then((icon) => { cache.set(appId, icon); return icon; })
      .catch(() => { cache.set(appId, null); return null; })
      .finally(() => inflight.delete(appId));
    inflight.set(appId, pending);
  }
  return pending;
}

/** Forget a cached icon, after an uninstall or reinstall. */
export function forgetWebAppIcon(appId: string) {
  cache.delete(appId);
}

/** The icon for `appId`, or null until it loads (and if it cannot). */
export function useWebAppIcon(appId: string | null | undefined): string | null {
  // What the last load produced, tagged with the id it was for, so a change
  // of app never shows the previous app's icon while the new one loads.
  const [loaded, setLoaded] = useState<{ id: string; icon: string | null } | null>(null);
  useEffect(() => {
    if (!appId) return;
    let live = true;
    void loadWebAppIcon(appId).then((icon) => { if (live) setLoaded({ id: appId, icon }); });
    return () => { live = false; };
  }, [appId]);
  if (!appId) return null;
  if (loaded && loaded.id === appId) return loaded.icon;
  return cache.get(appId) ?? null;
}
