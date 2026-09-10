// What the running page can say about itself, for the stack detector.
//
// The signals a fingerprint database cannot reach: a library's own version
// property. Wappalyzer and its forks match script URLs and headers with
// regular expressions, so they usually report "React" and guess a version
// from a filename. React, Vue, Angular, jQuery and the rest each publish
// their version on the object they expose, and a framework's own bootstrap
// data (`__NEXT_DATA__`, `__NUXT__`, `__remixContext`) says both that it is
// there and how it was built. Read here, in the page, that is exact.
//
// Everything is read defensively: a getter on `window` may throw, and a
// half-hydrated app may have a global that is not the shape we expect.

const seen = [];

/** Record a technology with an optional version and how it was found. */
const found = (name, version, evidence) => {
  const v = typeof version === "string" && /^[\w.+-]{1,32}$/.test(version) ? version : null;
  seen.push({ name, version: v, evidence });
};

/** A window property, or undefined if reading it throws. */
const win = (key) => {
  try {
    return window[key];
  } catch {
    return undefined;
  }
};

/** A dotted path off an object, guarding every hop. */
const at = (root, path) => {
  let node = root;
  for (const step of path.split(".")) {
    if (node === null || node === undefined) return undefined;
    try {
      node = node[step];
    } catch {
      return undefined;
    }
  }
  return node;
};

const text = (value) => (typeof value === "string" ? value : undefined);

// --- Frameworks that publish a version -------------------------------------

const react = win("React");
if (react) found("React", text(at(react, "version")), "window.React.version");
// A production React app usually has no window.React; the renderer still
// tags every root it owns, so the fibre key proves it without a version.
if (!react && document.querySelector("[data-reactroot], #root, #__next")) {
  const host = document.querySelector("#__next, #root, [data-reactroot]");
  if (host && Object.keys(host).some((k) => k.startsWith("__react"))) {
    found("React", null, "React fibre on the root element");
  }
}

const vue = win("Vue");
if (vue) found("Vue", text(at(vue, "version")), "window.Vue.version");
if (!vue && document.querySelector("[data-v-app], [data-server-rendered]")) {
  found("Vue", null, "Vue root attribute");
}

const ng = win("ng");
const ngVersion = text(at(ng, "version.full")) ?? text(at(win("angular"), "version.full"));
if (ngVersion) found("Angular", ngVersion, "ng.version.full");
else if (ng || document.querySelector("[ng-version]")) {
  found("Angular", text(document.querySelector("[ng-version]")?.getAttribute("ng-version")), "ng-version attribute");
}

const jq = win("jQuery") ?? win("$");
const jqVersion = text(at(jq, "fn.jquery"));
if (jqVersion) found("jQuery", jqVersion, "jQuery.fn.jquery");

const svelte = win("__svelte");
if (svelte || document.querySelector("[class*='svelte-']")) {
  found("Svelte", text(at(svelte, "v")), svelte ? "window.__svelte" : "svelte- scoped class");
}

// --- Meta-frameworks, which also say how the page was rendered --------------

const nextData = win("__NEXT_DATA__");
if (nextData || win("next") || document.querySelector("#__next")) {
  found("Next.js", text(at(win("next"), "version")), nextData ? "__NEXT_DATA__" : "Next.js root");
  // Whether this page was static or server-rendered is the kind of thing a
  // URL regex can never tell you.
  if (nextData && typeof nextData === "object") {
    if (nextData.gssp) found("Next.js SSR", null, "__NEXT_DATA__.gssp");
    else if (nextData.gsp) found("Next.js SSG", null, "__NEXT_DATA__.gsp");
  }
}
if (win("__NUXT__") || win("$nuxt") || document.querySelector("#__nuxt")) {
  found("Nuxt", text(at(win("$nuxt"), "$config.public.version")), "__NUXT__");
}
if (win("__remixContext") || win("__remixManifest")) found("Remix", null, "__remixContext");
if (win("__sveltekit_dev") || document.querySelector("[data-sveltekit-preload-data]")) {
  found("SvelteKit", null, "SvelteKit marker");
}
if (document.querySelector("astro-island, [astro-island]") || win("__astro")) {
  found("Astro", null, "astro-island");
}
if (win("Alpine")) found("Alpine.js", text(at(win("Alpine"), "version")), "window.Alpine.version");
if (win("htmx")) found("htmx", text(at(win("htmx"), "version")), "window.htmx.version");
if (win("Shopify")) found("Shopify", null, "window.Shopify");
if (win("Turbo") || win("Turbolinks")) found("Turbo", null, "window.Turbo");
if (win("__gatsby") || win("___gatsby")) found("Gatsby", null, "___gatsby");

// --- Build tooling, visible only at runtime ---------------------------------

if (win("__vite_plugin_react_preamble_installed__") || document.querySelector("script[src*='/@vite/client']")) {
  found("Vite", null, "Vite client");
}
if (win("webpackChunk") || Object.keys(window).some((k) => k.startsWith("webpackChunk"))) {
  found("webpack", null, "webpackChunk global");
}
if (win("__TURBOPACK__")) found("Turbopack", null, "__TURBOPACK__");

// --- UI and state, where a version matters for upgrade decisions ------------

if (win("__REDUX_DEVTOOLS_EXTENSION__") || win("__REDUX_STORE__")) found("Redux", null, "Redux devtools hook");
if (win("__APOLLO_CLIENT__")) found("Apollo Client", text(at(win("__APOLLO_CLIENT__"), "version")), "__APOLLO_CLIENT__");
if (win("__REACT_QUERY_STATE__") || win("__TANSTACK_QUERY_STATE__")) found("TanStack Query", null, "query state global");
if (document.querySelector("[class*='mantine-']")) found("Mantine", null, "mantine- class");
if (document.querySelector("[class*='chakra-']")) found("Chakra UI", null, "chakra- class");
if (document.querySelector("[class*='MuiBox-'], [class*='MuiButton-']")) found("MUI", null, "Mui class");
if (win("bootstrap") || document.querySelector("[class*='navbar-toggler'], [data-bs-toggle]")) {
  found("Bootstrap", text(at(win("bootstrap"), "Tooltip.VERSION")), "Bootstrap marker");
}

// --- Analytics, which developers usually want to know are present ----------

if (win("gtag") || win("dataLayer")) found("Google Tag", null, "gtag/dataLayer");
if (win("ga") || win("google_tag_manager")) found("Google Tag Manager", null, "google_tag_manager");
if (win("posthog")) found("PostHog", text(at(win("posthog"), "version")), "window.posthog");
if (win("Sentry") || win("__SENTRY__")) found("Sentry", text(at(win("Sentry"), "SDK_VERSION")), "window.Sentry");
if (win("mixpanel")) found("Mixpanel", null, "window.mixpanel");
if (win("amplitude")) found("Amplitude", null, "window.amplitude");
if (win("Intercom")) found("Intercom", null, "window.Intercom");
if (win("plausible")) found("Plausible", null, "window.plausible");

// --- What the document declares about itself -------------------------------

const generator = document.querySelector('meta[name="generator"]')?.getAttribute("content") ?? "";

return {
  technologies: seen,
  generator: generator.slice(0, 120),
  // The renderer's own answer to "was there HTML before JavaScript ran",
  // which tells a developer whether they are looking at SSR or a shell.
  server_rendered: document.documentElement.hasAttribute("data-server-rendered")
    || Boolean(win("__NEXT_DATA__") || win("__NUXT__") || win("__remixContext")),
};
