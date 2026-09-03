// Answers "what rendered this?" for the element the locator engine last held.
//
// Split out from picker.js so an agent can ask about an element it addressed
// by locator, without the picker's overlay and event listeners being
// installed in someone's page.
//
// @dive-include role-name.js
// @dive-include react-context.js
// The composed script runs inside a wrapper function (see pagescript.rs), so
// `return` here is what carries the answer out to `Runtime.evaluate`. That
// makes this file invalid on its own; `injected.test.ts` compiles every
// composed script instead, which is the form that actually runs.
//
// @dive-include css-path.js

return (function () {
  const el = window.__diveHeld;
  if (!el || !el.isConnected) {
    return { error: "not_found" };
  }
  const context = componentOf(el);
  return {
    ok: true,
    tag: el.tagName.toLowerCase(),
    role: roleOf(el),
    name: nameOf(el).slice(0, 200),
    selector: cssPathOf(el),
    component_name: context.componentName,
    source: context.source,
    stack: context.stack,
    owners: context.owners,
    html_preview: el.outerHTML.slice(0, 500),
  };
})();
