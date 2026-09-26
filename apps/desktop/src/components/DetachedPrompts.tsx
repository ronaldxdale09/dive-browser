import { ipc } from "../lib/ipc";
import { errorMessage } from "../lib/errors";
import { useBrowser } from "../store/browser";
import { CrashBanner, PermissionDialog } from "./Content";
import { CredentialPromptCard } from "./CredentialPromptCard";
import { ExternalLinkDialog } from "./ExternalLinkDialog";
import { PagePrompts } from "./PagePrompts";

/**
 * Everything a page can ask of the person, drawn in the window that shows
 * the page: a torn-off tab, a ⌘N window or an installed app's window. The
 * main window leaves these tabs' questions alone, so a window without them
 * left a camera request to be denied at its deadline, a proxy sign-in
 * waiting forever and an app's login never offered for saving.
 */
export function DetachedPrompts({ tabId }: { tabId: string }) {
  const asked = useBrowser((s) => s.permissionRequests[tabId]?.[0]);
  return (
    <>
      <PagePrompts tabId={tabId} />
      <CredentialPromptCard tabId={tabId} />
      <ExternalLinkDialog tabId={tabId} />
      {/* Keyed on the request, so an answer to one never carries to the next. */}
      <PermissionDialog key={asked?.request_id ?? "none"} tabId={tabId} request={asked} />
    </>
  );
}

/**
 * The crash notice for a detached window's page, as a row above it: the
 * page's rectangle is measured from the element below, so the notice pushes
 * the native view down instead of vanishing behind it.
 */
export function DetachedCrashBanner({ tabId }: { tabId: string }) {
  const crash = useBrowser((s) => s.crashedTabs[tabId]);
  if (!crash) return null;
  const reload = () => void ipc.tabReload(tabId).catch((e: unknown) => useBrowser.setState({ error: errorMessage(e) }));
  return <CrashBanner attempt={crash.attempt} recovering={crash.recovering} onReload={reload} />;
}
