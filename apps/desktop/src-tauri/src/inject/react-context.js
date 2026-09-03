// The React component that rendered a DOM element, and the source file it
// came from.
//
// React hangs a fiber node off every element it owns under a
// `__reactFiber$<random>` key. Walking up the `return` chain from there
// reaches the nearest function or class component. `_debugSource` (React 18)
// and `_debugStack` (React 19) carry the file and line, but only when the
// bundle was built for development — a production build has neither, and the
// component name comes back minified or null. Callers fall back to the DOM
// description in that case rather than reporting a wrong location.

const fiberOf = (el) => {
  for (const key of Object.keys(el)) {
    if (key.startsWith("__reactFiber$") || key.startsWith("__reactInternalInstance$")) {
      return el[key];
    }
  }
  return null;
};

const componentNameOf = (fiber) => {
  const type = fiber.type || fiber.elementType;
  if (!type || typeof type === "string") return null;
  if (typeof type === "function") return type.displayName || type.name || null;
  if (typeof type === "object") {
    return type.displayName || (type.render && (type.render.displayName || type.render.name)) || null;
  }
  return null;
};

const frameFrom = (source) => {
  const fileName = source && (source.fileName || source.file);
  if (!fileName) return null;
  return {
    functionName: null,
    fileName,
    lineNumber: typeof source.lineNumber === "number" ? source.lineNumber : null,
    columnNumber: typeof source.columnNumber === "number" ? source.columnNumber : null,
  };
};

const parseStackText = (raw) => {
  const frames = [];
  for (const line of String(raw).split("\n")) {
    const m = /at\s+(?:(.+?)\s+\()?((?:https?|file|webpack|rsc):\/\/[^\s)]+|\/[^\s)]+):(\d+):(\d+)\)?/.exec(line);
    if (!m) continue;
    frames.push({
      functionName: m[1] || null,
      fileName: m[2],
      lineNumber: Number(m[3]),
      columnNumber: Number(m[4]),
    });
    if (frames.length >= 12) break;
  }
  return frames;
};

const componentOf = (el) => {
  let fiber = null;
  for (let node = el; node && !fiber; node = node.parentElement) fiber = fiberOf(node);
  if (!fiber) return { componentName: null, source: null, stack: [], owners: [] };
  const owners = [];
  const stack = [];
  let componentName = null;
  for (let node = fiber, depth = 0; node && depth < 24; node = node.return, depth++) {
    const name = componentNameOf(node);
    if (!name) continue;
    if (!componentName) componentName = name;
    if (owners.length < 8) owners.push(name);
    const frame = frameFrom(node._debugSource);
    if (frame) {
      frame.functionName = name;
      if (stack.length < 8) stack.push(frame);
    } else if (!stack.length && node._debugStack) {
      for (const parsed of parseStackText(node._debugStack.stack || node._debugStack)) {
        if (stack.length < 8) stack.push(parsed);
      }
    }
  }
  return { componentName, source: stack[0] || null, stack, owners };
};
