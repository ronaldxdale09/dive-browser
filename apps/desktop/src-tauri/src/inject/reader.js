// Reader view: the article, without the rest of the page.
//
// Chromium's own reader is disabled in this build (its Read Anything service
// crashes the renderer), so the article is found here. The scoring is the
// familiar one -- paragraphs carry weight, the block holding most of them
// wins, and navigation-shaped things are held against a block -- and it runs
// over a copy, so the live page is never touched until the view opens.
//
// The original body is put aside rather than rebuilt, so leaving reader view
// restores the page exactly, listeners and all.

(function () {
  if (window.__diveReaderInstalled) return;
  window.__diveReaderInstalled = true;

  const BLOCKS = "article, main, [role=main], .post, .article, .entry, .content, #content, .story, section, div";
  const NEGATIVE = /(^|[\s_-])(comment|share|sidebar|footer|header|nav|menu|promo|banner|advert|related|recirc|newsletter|subscribe|paywall|cookie|social|breadcrumb)([\s_-]|$)/i;
  const POSITIVE = /(^|[\s_-])(article|body|content|entry|main|page|post|story|text)([\s_-]|$)/i;
  const KEEP = new Set(["P", "H1", "H2", "H3", "H4", "H5", "H6", "BLOCKQUOTE", "UL", "OL", "LI", "PRE", "CODE", "FIGURE", "FIGCAPTION", "IMG", "A", "EM", "STRONG", "B", "I", "BR", "HR", "TABLE", "THEAD", "TBODY", "TR", "TH", "TD", "SUP", "SUB", "SPAN", "DIV", "TIME", "PICTURE", "SOURCE", "VIDEO"]);
  const DROP_ATTRS = /^(on|data-|aria-hidden)/i;

  const textLength = (node) => (node.textContent || "").replace(/\s+/g, " ").trim().length;

  /** How much this block reads like the body of an article. */
  const score = (element) => {
    const paragraphs = element.querySelectorAll("p");
    if (paragraphs.length === 0) return 0;
    let points = 0;
    for (const p of paragraphs) {
      const length = textLength(p);
      if (length < 25) continue;
      points += 1 + Math.min(length / 100, 3);
    }
    const marks = `${element.className || ""} ${element.id || ""}`;
    if (NEGATIVE.test(marks)) points -= 25;
    if (POSITIVE.test(marks)) points += 10;
    if (element.tagName === "ARTICLE" || element.getAttribute("role") === "main" || element.tagName === "MAIN") points += 20;
    // A block that is mostly links is a list of other articles.
    const linkText = [...element.querySelectorAll("a")].reduce((sum, a) => sum + textLength(a), 0);
    const total = textLength(element) || 1;
    if (linkText / total > 0.5) points -= 20;
    return points;
  };

  /** Strip a copied tree down to what is worth reading. */
  const clean = (root) => {
    for (const node of [...root.querySelectorAll("*")]) {
      if (!KEEP.has(node.tagName)) {
        node.remove();
        continue;
      }
      for (const attribute of [...node.attributes]) {
        const name = attribute.name.toLowerCase();
        const allowed = (node.tagName === "A" && name === "href") || (["IMG", "SOURCE", "VIDEO"].includes(node.tagName) && ["src", "srcset", "alt", "poster"].includes(name)) || name === "datetime";
        if (!allowed || DROP_ATTRS.test(name)) node.removeAttribute(attribute.name);
      }
      // An empty wrapper adds a gap and nothing else.
      if (["DIV", "SPAN"].includes(node.tagName) && !node.firstChild) node.remove();
    }
    // Relative addresses have to survive being moved into a new tree.
    for (const link of root.querySelectorAll("a[href]")) {
      try {
        link.href = new URL(link.getAttribute("href"), document.baseURI).href;
        link.target = "_self";
      } catch {
        link.removeAttribute("href");
      }
    }
    for (const image of root.querySelectorAll("img[src]")) {
      try {
        image.src = new URL(image.getAttribute("src"), document.baseURI).href;
        image.loading = "lazy";
      } catch {
        image.remove();
      }
    }
    return root;
  };

  /** The article's own title and byline, as the page states them. */
  const heading = () => {
    const meta = (selector, attribute = "content") => document.querySelector(selector)?.getAttribute(attribute)?.trim() || "";
    const title = meta('meta[property="og:title"]') || document.querySelector("h1")?.textContent?.trim() || document.title;
    const byline = meta('meta[name="author"]') || meta('meta[property="article:author"]') || document.querySelector('[rel=author], .byline, .author')?.textContent?.trim() || "";
    const published = meta('meta[property="article:published_time"]') || document.querySelector("time[datetime]")?.getAttribute("datetime") || "";
    return { title: title.slice(0, 300), byline: byline.replace(/\s+/g, " ").slice(0, 200), published: published.slice(0, 40) };
  };

  const STYLE = `
    :root { color-scheme: light dark; }
    html.dive-reader, html.dive-reader body { background: Canvas !important; }
    .dive-reader-shell { max-width: 42rem; margin: 0 auto; padding: 3rem 1.25rem 6rem; font: 1.125rem/1.7 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif; color: CanvasText; }
    .dive-reader-shell h1 { font-size: 2rem; line-height: 1.2; margin: 0 0 .5rem; }
    .dive-reader-shell .dive-reader-meta { font-size: .8125rem; opacity: .6; margin-bottom: 2.5rem; }
    .dive-reader-shell img, .dive-reader-shell video { max-width: 100%; height: auto; border-radius: .5rem; }
    .dive-reader-shell p, .dive-reader-shell ul, .dive-reader-shell ol, .dive-reader-shell blockquote { margin: 0 0 1.4em; }
    .dive-reader-shell blockquote { padding-left: 1rem; border-left: 3px solid currentColor; opacity: .85; }
    .dive-reader-shell pre { overflow-x: auto; padding: 1rem; background: color-mix(in srgb, CanvasText 8%, Canvas); border-radius: .5rem; font-size: .9rem; }
    .dive-reader-shell a { color: LinkText; }
    @media print { .dive-reader-shell { padding: 0; } }
  `;

  window.__diveReader = () => {
    if (window.__diveReaderState) return { ok: true, already: true };
    if (!document.body) return { ok: false, reason: "empty" };
    let best = null;
    let bestScore = 0;
    for (const candidate of document.querySelectorAll(BLOCKS)) {
      const points = score(candidate);
      if (points > bestScore) {
        bestScore = points;
        best = candidate;
      }
    }
    // Under this there is no article here -- a search page, an app, a feed.
    if (!best || bestScore < 15 || textLength(best) < 500) return { ok: false, reason: "no-article" };
    const article = clean(best.cloneNode(true));
    const { title, byline, published } = heading();
    const shell = document.createElement("div");
    shell.className = "dive-reader-shell";
    const head = document.createElement("h1");
    head.textContent = title;
    shell.append(head);
    if (byline || published) {
      const meta = document.createElement("p");
      meta.className = "dive-reader-meta";
      meta.textContent = [byline, published ? new Date(published).toLocaleDateString() : ""].filter(Boolean).join(" · ");
      shell.append(meta);
    }
    shell.append(article);
    const style = document.createElement("style");
    style.id = "dive-reader-style";
    style.textContent = STYLE;
    // The page is put aside whole, so leaving reader view is exact.
    const kept = document.createDocumentFragment();
    while (document.body.firstChild) kept.append(document.body.firstChild);
    window.__diveReaderState = { kept, scroll: window.scrollY, className: document.body.className };
    document.body.className = "";
    document.documentElement.classList.add("dive-reader");
    document.head.append(style);
    document.body.append(shell);
    window.scrollTo(0, 0);
    return { ok: true, words: textLength(article) };
  };

  window.__diveReaderRestore = () => {
    const state = window.__diveReaderState;
    if (!state) return { ok: false, reason: "not-in-reader" };
    document.getElementById("dive-reader-style")?.remove();
    document.body.replaceChildren(state.kept);
    document.body.className = state.className;
    document.documentElement.classList.remove("dive-reader");
    window.__diveReaderState = null;
    window.scrollTo(0, state.scroll);
    return { ok: true };
  };

  window.__diveReaderState_ = () => ({ inReader: Boolean(window.__diveReaderState) });
})();
