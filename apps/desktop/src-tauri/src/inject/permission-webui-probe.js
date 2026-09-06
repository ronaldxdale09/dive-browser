// Chromium 151 settings handlers + ui/webui/resources/js/cr.ts. No page APIs or
// OS registration requests: query existing services, remove only exact fixtures.
async ({ cr, chrome, href, fixture }) => {
  if (!href.startsWith("chrome://settings/")) throw new Error("Not native Settings WebUI");
  const require = (condition, message) => { if (!condition) throw new Error(message); };
  const bounded = promise => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("WebUI query timed out")), 5000);
    promise.then(value => { clearTimeout(timer); resolve(value); }, error => { clearTimeout(timer); reject(error); });
  });
  const protocols = () => new Promise((resolve, reject) => {
    let listener;
    const timer = setTimeout(() => {
      cr.removeWebUiListener(listener);
      reject(new Error("Protocol WebUI query timed out"));
    }, 5000);
    listener = cr.addWebUiListener("setProtocolHandlers", value => {
      clearTimeout(timer);
      cr.removeWebUiListener(listener);
      resolve(value.flatMap(group => group.handlers));
    });
    try { chrome.send("observeProtocolHandlers"); }
    catch (error) { clearTimeout(timer); cr.removeWebUiListener(listener); reject(error); }
  });
  const grants = () => bounded(cr.sendWithPromise("getFileSystemGrants"));
  const sameHandler = (value, other) => value.protocol === other.protocol && value.spec === other.spec;
  const sameOrigin = (value, origin) => value.origin.replace(/\/$/, "") === origin;
  const beforeProtocols = await protocols();
  const beforeGrants = await grants();
  require(beforeProtocols.some(value => sameHandler(value, fixture) && !value.app_id), "Ordinary handler fixture not loaded by native registry");
  for (const protectedHandler of fixture.protected) require(beforeProtocols.some(value => sameHandler(value, protectedHandler) && (!protectedHandler.app_id || value.app_id === protectedHandler.app_id)), "Protected handler fixture missing");
  require(beforeGrants.some(value => sameOrigin(value, fixture.origin)), "Chooser fixture not loaded by native service");
  require(beforeGrants.some(value => sameOrigin(value, fixture.siblingOrigin)), "Sibling chooser fixture missing");
  // Do not replay mutations after timeout or transport failure.
  chrome.send("removeHandler", [fixture.protocol, fixture.spec]);
  chrome.send("revokeFileSystemGrants", [fixture.origin]);
  const afterProtocols = await protocols();
  const afterGrants = await grants();
  require(!afterProtocols.some(value => sameHandler(value, fixture)), "Native protocol removal did not take effect");
  require(!afterGrants.some(value => sameOrigin(value, fixture.origin)), "Native chooser revocation did not take effect");
  const remainingProtocols = beforeProtocols.filter(value => !sameHandler(value, fixture));
  const remainingGrants = beforeGrants.filter(value => !sameOrigin(value, fixture.origin));
  require(JSON.stringify(remainingProtocols) === JSON.stringify(afterProtocols), "Unrelated native handlers changed");
  require(JSON.stringify(remainingGrants) === JSON.stringify(afterGrants), "Unrelated native chooser grants changed");
  return { ok: true, preservedHandlers: afterProtocols.length, preservedChooserOrigins: afterGrants.length,
    additionalBaselineHandlers: beforeProtocols.length - fixture.protected.length - 1 };
}
