// The React component behind an element, for a script in Dive's isolated
// world.
//
// React keeps its fibers as expando properties on the page's own DOM
// wrappers, which no other world can see, so the element picker cannot walk
// them itself. It asks react-bridge.js, which runs in the page's world: a
// "__dive-component-request" dispatched at the element, answered at once by
// a "__dive-component-reply" whose detail is the component as JSON. Both
// events are synchronous, so the answer is in before this returns.
//
// The answer is the page's own data -- a page decides what its fibers say
// either way -- so it is read as untrusted: parsed here, cut to the shape
// and sizes a pick carries, and anything else dropped.

const NO_COMPONENT = () => ({ componentName: null, source: null, stack: [], owners: [] });

const componentText = (value, limit) => (typeof value === "string" ? value.slice(0, limit) : null);

const componentLine = (value) => (typeof value === "number" && Number.isFinite(value) ? Math.trunc(value) : null);

const componentFrame = (value) => {
  if (!value || typeof value !== "object") return null;
  const fileName = componentText(value.fileName, 2000);
  if (!fileName) return null;
  return {
    functionName: componentText(value.functionName, 200),
    fileName,
    lineNumber: componentLine(value.lineNumber),
    columnNumber: componentLine(value.columnNumber),
  };
};

const componentOf = (el) => {
  let answer = null;
  const hear = (event) => {
    if (typeof event.detail === "string") answer = event.detail;
  };
  addEventListener("__dive-component-reply", hear, true);
  try {
    el.dispatchEvent(new CustomEvent("__dive-component-request", { bubbles: true, composed: true }));
  } catch {
    // An element that cannot take an event has no component to report.
  } finally {
    removeEventListener("__dive-component-reply", hear, true);
  }
  if (answer === null || answer.length > 64 * 1024) return NO_COMPONENT();
  let parsed;
  try {
    parsed = JSON.parse(answer);
  } catch {
    return NO_COMPONENT();
  }
  if (!parsed || typeof parsed !== "object") return NO_COMPONENT();
  const stack = (Array.isArray(parsed.stack) ? parsed.stack : []).slice(0, 8).map(componentFrame).filter(Boolean);
  return {
    componentName: componentText(parsed.componentName, 200),
    source: componentFrame(parsed.source),
    stack,
    owners: (Array.isArray(parsed.owners) ? parsed.owners : [])
      .slice(0, 8)
      .map((owner) => componentText(owner, 200))
      .filter(Boolean),
  };
};
