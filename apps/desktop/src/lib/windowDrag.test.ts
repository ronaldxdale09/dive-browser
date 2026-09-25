import { describe, expect, it, vi } from "vitest";

const win = { startDragging: vi.fn().mockResolvedValue(undefined), toggleMaximize: vi.fn().mockResolvedValue(undefined) };
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => win }));

const { pressMovesWindow, windowDrag } = await import("./windowDrag");

function element(html: string, selector?: string): Element {
  const host = document.createElement("div");
  host.innerHTML = html;
  return selector ? host.querySelector(selector)! : host.firstElementChild!;
}

const press = (target: Element, over: Partial<{ button: number; detail: number; metaKey: boolean }> = {}) =>
  ({ button: 0, detail: 1, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, target, ...over }) as unknown as React.MouseEvent;

describe("pressMovesWindow", () => {
  it("moves the window from the bar's own surface", () => {
    expect(pressMovesWindow(element("<div><span>Dive</span></div>", "span"))).toBe(true);
    expect(pressMovesWindow(element("<header></header>"))).toBe(true);
  });

  it("leaves a press that belongs to a control alone", () => {
    for (const html of [
      "<button>Agent</button>",
      "<input />",
      "<a href='#'>x</a>",
      "<div role='button'>x</div>",
      "<div data-no-drag><span>x</span></div>",
      "<div data-tauri-drag-region='false'><span>tab</span></div>",
      // A suggestion row or popover padding hanging out of the bar.
      "<ul role='listbox'><li role='option'><span>example.com</span></li></ul>",
      "<div role='dialog'><p><span>Protection</span></p></div>",
      "<div role='menu'><hr /><span>sep</span></div>",
    ]) {
      const host = element(html);
      const target = host.querySelector("span") ?? host;
      expect(pressMovesWindow(target)).toBe(false);
    }
  });

  it("stands aside where Tauri's own drag region already applies", () => {
    expect(pressMovesWindow(element("<div data-tauri-drag-region='true'></div>"))).toBe(false);
  });

  it("ignores anything that is not an element", () => {
    expect(pressMovesWindow(null)).toBe(false);
  });
});

describe("windowDrag", () => {
  it("drags on a plain press and zooms on a double-click", () => {
    const { onMouseDown, onDoubleClick } = windowDrag();
    const bar = element("<header></header>");
    win.startDragging.mockClear();
    win.toggleMaximize.mockClear();

    onMouseDown(press(bar));
    expect(win.startDragging).toHaveBeenCalledTimes(1);

    // The second press of a double-click must not also start a drag.
    onMouseDown(press(bar, { detail: 2 }));
    expect(win.startDragging).toHaveBeenCalledTimes(1);

    onDoubleClick(press(bar, { detail: 2 }));
    expect(win.toggleMaximize).toHaveBeenCalledTimes(1);
  });

  it("does nothing for a right-click, a modified press, or a control", () => {
    const { onMouseDown } = windowDrag();
    const bar = element("<header></header>");
    win.startDragging.mockClear();
    onMouseDown(press(bar, { button: 2 }));
    onMouseDown(press(bar, { metaKey: true }));
    onMouseDown(press(element("<button>x</button>")));
    expect(win.startDragging).not.toHaveBeenCalled();
  });
});
