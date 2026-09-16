import { AppWindow, MonitorDown } from "lucide-react";
import { useEffect, useState } from "react";
import { tabInThisWindow, useBrowser } from "../store/browser";
import { WEBAPPS_CHANGED, useWebApps } from "../store/webapps";
import { FeatureButton } from "./FeatureBar";
import { InstallAppDialog } from "./InstallAppDialog";

/**
 * Right of the address: "Install app" when the page's manifest passes the
 * install rules, "Open in <app>" once it is installed, nothing otherwise.
 * The page is probed once per URL after it finishes loading, so the button
 * appears with the page rather than flickering while it loads.
 */
export function InstallAppButton() {
  const activeTab = useBrowser((s) => tabInThisWindow(s.activeTab, s.detached));
  const url = useBrowser((s) => {
    const id = tabInThisWindow(s.activeTab, s.detached);
    return id ? (s.tabs.find((t) => t.id === id)?.url ?? "") : "";
  });
  const loading = useBrowser((s) => {
    const id = tabInThisWindow(s.activeTab, s.detached);
    return id ? s.loading[id] === true : false;
  });
  const probe = useWebApps((s) => (activeTab ? s.probes[activeTab] : undefined));
  const ask = useWebApps((s) => s.probe);
  const forget = useWebApps((s) => s.forgetTab);
  const open = useWebApps((s) => s.open);
  const [dialog, setDialog] = useState(false);

  useEffect(() => {
    if (!activeTab || loading || !url) return;
    void ask(activeTab, url);
  }, [activeTab, url, loading, ask]);

  // Installing or uninstalling anywhere changes what this page can become.
  useEffect(() => {
    if (!activeTab) return;
    const changed = () => {
      forget(activeTab);
      if (url && !loading) void ask(activeTab, url);
    };
    window.addEventListener(WEBAPPS_CHANGED, changed);
    return () => window.removeEventListener(WEBAPPS_CHANGED, changed);
  }, [activeTab, url, loading, ask, forget]);

  // Leaving the page closes the offer for it.
  useEffect(() => () => setDialog(false), [activeTab, url]);

  const result = probe && probe.url === url ? probe.probe : null;
  if (!activeTab || !result) return null;

  if (result.installed) {
    const app = result.installed;
    return (
      <FeatureButton
        icon={AppWindow}
        label={`Open in ${app.short_name || app.name}`}
        iconOnly
        onClick={() => void open(app.id)}
      />
    );
  }
  if (!result.installable) return null;
  return (
    <>
      <FeatureButton
        icon={MonitorDown}
        label={`Install ${result.short_name || result.name || "app"}`}
        iconOnly
        active={dialog}
        hasPopup="dialog"
        onClick={() => setDialog(true)}
      />
      {dialog && <InstallAppDialog tabId={activeTab} probe={result} onClose={() => setDialog(false)} />}
    </>
  );
}
