// Translate the page where it stands, with Chromium's on-device translator.
// Nothing leaves the machine: the model is downloaded once by the engine and
// runs locally, so a translated page is not a page sent to a translation
// service.
//
// The original text is kept beside every node that changes, so showing the
// original again is exact and needs no reload.

(function () {
  if (window.__diveTranslateInstalled) return;
  window.__diveTranslateInstalled = true;

  const ORIGINALS = new WeakMap();
  // Text inside these says nothing a reader reads.
  const SKIP = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "CODE", "PRE", "KBD", "SAMP", "TEXTAREA"]);
  // One request per batch of this many nodes keeps a long page from making
  // thousands of calls, which is what makes a naive translator crawl.
  const BATCH = 40;
  const MAX_NODES = 4000;

  const textNodes = () => {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        if (!node.nodeValue || !node.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
        const parent = node.parentElement;
        if (!parent || SKIP.has(parent.tagName)) return NodeFilter.FILTER_REJECT;
        if (parent.isContentEditable) return NodeFilter.FILTER_REJECT;
        // A node nobody can see is not worth a translation.
        if (!parent.offsetParent && parent.tagName !== "TITLE" && getComputedStyle(parent).display === "none") return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    const nodes = [];
    for (let node = walker.nextNode(); node && nodes.length < MAX_NODES; node = walker.nextNode()) nodes.push(node);
    return nodes;
  };

  /** The language the page says it is, else what the detector makes of it. */
  const pageLanguage = async (sample) => {
    const declared = (document.documentElement.lang || "").trim().slice(0, 2).toLowerCase();
    if (declared) return declared;
    if (typeof LanguageDetector !== "function") return "";
    try {
      const detector = await LanguageDetector.create();
      const [best] = await detector.detect(sample.slice(0, 2000));
      return best && best.confidence > 0.5 ? best.detectedLanguage.slice(0, 2) : "";
    } catch {
      return "";
    }
  };

  window.__diveTranslate = async (target) => {
    if (typeof Translator !== "function") return { ok: false, reason: "unsupported" };
    const nodes = textNodes();
    if (nodes.length === 0) return { ok: false, reason: "empty" };
    const sample = nodes.slice(0, 40).map((n) => n.nodeValue).join(" ");
    const from = await pageLanguage(sample);
    if (!from) return { ok: false, reason: "unknown-language" };
    if (from === target) return { ok: false, reason: "already", from };
    let translator;
    try {
      translator = await Translator.create({ sourceLanguage: from, targetLanguage: target });
    } catch (error) {
      // A pair with no model, or a download the engine would not start.
      return { ok: false, reason: error.name === "NotSupportedError" ? "unsupported-pair" : "unavailable", from };
    }
    let changed = 0;
    for (let i = 0; i < nodes.length; i += BATCH) {
      const batch = nodes.slice(i, i + BATCH);
      const results = await Promise.all(
        batch.map(async (node) => {
          const original = node.nodeValue;
          try {
            return await translator.translate(original);
          } catch {
            return null;
          }
        }),
      );
      results.forEach((text, index) => {
        const node = batch[index];
        if (text === null || text === node.nodeValue) return;
        if (!ORIGINALS.has(node)) ORIGINALS.set(node, node.nodeValue);
        node.nodeValue = text;
        changed += 1;
      });
    }
    window.__diveTranslated = { from, target, nodes: nodes.filter((n) => ORIGINALS.has(n)) };
    document.documentElement.setAttribute("data-dive-translated", target);
    return { ok: true, from, target, changed };
  };

  window.__diveTranslateRestore = () => {
    const state = window.__diveTranslated;
    if (!state) return { ok: false, reason: "not-translated" };
    let restored = 0;
    for (const node of state.nodes) {
      const original = ORIGINALS.get(node);
      if (original !== undefined && node.isConnected) {
        node.nodeValue = original;
        restored += 1;
      }
    }
    window.__diveTranslated = null;
    document.documentElement.removeAttribute("data-dive-translated");
    return { ok: true, restored };
  };

  window.__diveTranslateState = async () => ({
    translated: Boolean(window.__diveTranslated),
    target: window.__diveTranslated ? window.__diveTranslated.target : null,
    language: await pageLanguage(document.body ? document.body.innerText.slice(0, 2000) : ""),
    supported: typeof Translator === "function",
  });
})();
