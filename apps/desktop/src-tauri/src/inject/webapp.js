// Reads the page's web app manifest and says whether it can be installed.
//
// The rules are Chrome's, since "installable" should mean the same thing to a
// site whichever browser it is looking at: served over https (or from the
// local machine), a manifest with a name, a start URL on this origin, a
// display mode that is not a plain browser tab, and one icon large enough to
// stand on a Dock. Chrome dropped its service-worker requirement in 2024, so
// it is not one here either.
//
// Runs inside the page so the manifest fetch carries the page's cookies and
// obeys its CSP, the same way the browser's own check would. `return` reaches
// `Runtime.evaluate` through the wrapper (see pagescript.rs).

const MIN_ICON = __MIN_ICON__;

const same = (a, b) => {
  try { return new URL(a).origin === new URL(b).origin; } catch { return false; }
};

const local = (host) => host === "localhost" || host === "127.0.0.1" || host === "[::1]" || host.endsWith(".localhost");

// Icons say their sizes as "192x192 512x512"; "any" is a scalable SVG. The
// largest square PNG or SVG is the one that survives being made into an icon.
const bestIcon = (icons, base) => {
  let best = null;
  for (const icon of icons || []) {
    if (!icon || typeof icon.src !== "string") continue;
    const purpose = (icon.purpose || "any").split(/\s+/);
    if (!purpose.includes("any") && !purpose.includes("maskable")) continue;
    const type = (icon.type || "").toLowerCase();
    const src = icon.src.toLowerCase();
    const svg = type === "image/svg+xml" || src.endsWith(".svg");
    if (type && !svg && type !== "image/png" && type !== "image/jpeg" && type !== "image/webp") continue;
    let size = 0;
    for (const token of (icon.sizes || "").split(/\s+/)) {
      if (token === "any") { size = Math.max(size, svg ? 1024 : 0); continue; }
      const m = /^(\d+)x(\d+)$/i.exec(token);
      if (m && m[1] === m[2]) size = Math.max(size, Number(m[1]));
    }
    if (size === 0 && svg) size = 1024;
    if (size < MIN_ICON) continue;
    let url;
    try { url = new URL(icon.src, base).href; } catch { continue; }
    // Prefer "any" over "maskable" at equal size: maskable art expects a
    // platform mask we do not apply.
    const rank = size * 2 + (purpose.includes("any") ? 1 : 0);
    if (!best || rank > best.rank) best = { url, size, rank };
  }
  return best;
};

const text = (value, limit) => (typeof value === "string" ? value.trim().slice(0, limit) : "");

const notInstallable = (reason) => ({ installable: false, reason });

return (async () => {
  const link = document.querySelector('link[rel~="manifest"]');
  if (!link || !link.getAttribute("href")) return notInstallable("no manifest");

  const page = location.href;
  if (location.protocol !== "https:" && !local(location.hostname)) return notInstallable("not https");

  let manifestUrl;
  try { manifestUrl = new URL(link.getAttribute("href"), page).href; } catch { return notInstallable("bad manifest url"); }

  let manifest;
  try {
    const credentials = link.getAttribute("crossorigin") === "use-credentials" ? "include" : "same-origin";
    const response = await fetch(manifestUrl, { credentials, cache: "force-cache" });
    if (!response.ok) return notInstallable("manifest " + response.status);
    manifest = await response.json();
  } catch (error) {
    return notInstallable("manifest unreadable: " + (error && error.message ? error.message : String(error)));
  }
  if (!manifest || typeof manifest !== "object") return notInstallable("manifest not an object");

  const name = text(manifest.name, 120) || text(manifest.short_name, 120);
  if (!name) return notInstallable("no name");
  const shortName = text(manifest.short_name, 40) || name.slice(0, 40);

  let startUrl;
  try { startUrl = new URL(typeof manifest.start_url === "string" ? manifest.start_url : ".", manifestUrl).href; } catch { return notInstallable("bad start_url"); }
  if (!same(startUrl, page)) return notInstallable("start_url on another origin");

  // Scope defaults to the start URL's directory; a start URL outside the
  // declared scope makes the manifest inconsistent, and Chrome ignores it.
  let scope;
  try {
    scope = typeof manifest.scope === "string"
      ? new URL(manifest.scope, manifestUrl).href
      : new URL(".", startUrl).href;
  } catch { return notInstallable("bad scope"); }
  if (!same(scope, page)) return notInstallable("scope on another origin");
  if (!startUrl.startsWith(scope)) return notInstallable("start_url outside scope");

  const display = ["standalone", "fullscreen", "minimal-ui"].includes(manifest.display) ? manifest.display : "browser";
  if (display === "browser") return notInstallable("display is browser");

  const icon = bestIcon(manifest.icons, manifestUrl);
  if (!icon) return notInstallable("no icon of " + MIN_ICON + "px");

  // A manifest id names the app across URL changes; Chrome uses start_url
  // when it is absent, and so do we.
  let id;
  try { id = new URL(typeof manifest.id === "string" ? manifest.id : startUrl, startUrl).href; } catch { id = startUrl; }

  const color = (value) => (typeof value === "string" && /^#?[0-9a-f]{3,8}$|^[a-z]+$|^rgba?\(/i.test(value.trim()) ? value.trim().slice(0, 32) : null);

  return {
    installable: true,
    id,
    name,
    short_name: shortName,
    start_url: startUrl,
    scope,
    display,
    theme_color: color(manifest.theme_color),
    background_color: color(manifest.background_color),
    icon_url: icon.url,
    icon_size: icon.size,
    manifest_url: manifestUrl,
    description: text(manifest.description, 300) || null,
  };
})();
