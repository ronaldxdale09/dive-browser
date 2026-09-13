import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useRef } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Select } from "./SettingsFields";
import { ipc } from "../lib/ipc";
import { contentCoverDepth, resetContentCover, resetOverlayElements, useCoversContent, visibleOverlayRegions } from "../lib/overlay";
import { useFocusTrap } from "../lib/useFocusTrap";

const options = [{ value: "a", label: "Apple" }, { value: "b", label: "Banana" }, { value: "c", label: "Cherry" }];
beforeEach(() => {
  Object.defineProperty(window, "__DIVE_LIVE_OVERLAYS__", { value: true, configurable: true });
  vi.spyOn(ipc, "setOverlayRegions").mockResolvedValue(null);
});
afterEach(() => { cleanup(); resetContentCover(); resetOverlayElements(); vi.restoreAllMocks(); Reflect.deleteProperty(window, "__DIVE_LIVE_OVERLAYS__"); });
function trigger() { return screen.getByRole("combobox", { name: "Fruit" }); }
function key(key: string) { fireEvent.keyDown(trigger(), { key }); }
function active() { return document.getElementById(trigger().getAttribute("aria-activedescendant") ?? "")?.textContent; }

it("opens DOM options, highlights without committing, and commits exactly once", () => {
  const change = vi.fn();
  render(<Select value="b" label="Fruit" id="fruit" options={options} onChange={change} />);
  expect(trigger().tagName).toBe("BUTTON");
  fireEvent.click(trigger());
  expect(screen.getByRole("listbox").id).toBe(trigger().getAttribute("aria-controls"));
  expect(screen.getByRole("option", { name: "Banana" }).getAttribute("aria-selected")).toBe("true");
  key("ArrowDown");
  expect(active()).toContain("Cherry");
  expect(change).not.toHaveBeenCalled();
  key("Enter");
  expect(change.mock.calls).toEqual([["c"]]);
  expect(screen.queryByRole("listbox")).toBeNull();
  fireEvent.click(trigger());
  fireEvent.mouseDown(screen.getByRole("option", { name: "Apple" }));
  fireEvent.click(screen.getByRole("option", { name: "Apple" }));
  expect(change.mock.calls).toEqual([["c"], ["a"]]);
  expect(document.activeElement).toBe(trigger());
});

it("supports end points, typeahead, space, cancellation, and normal Tab", () => {
  const change = vi.fn();
  render(<Select value="a" label="Fruit" options={options} onChange={change} />);
  trigger().focus();
  key("ArrowUp"); key("End"); expect(active()).toContain("Cherry");
  key("Home"); expect(active()).toContain("Apple");
  key("b"); expect(active()).toContain("Banana");
  key("Escape"); expect(change).not.toHaveBeenCalled();
  expect(screen.queryByRole("listbox")).toBeNull();
  key(" "); key("End"); key(" "); expect(change).toHaveBeenCalledWith("c");
  key("ArrowDown");
  expect(fireEvent.keyDown(trigger(), { key: "Tab" })).toBe(true);
  expect(screen.queryByRole("listbox")).toBeNull();
});

it("keeps the parent's focus trap, rounded native mask and Escape independent from the portalled list", async () => {
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({ x: 10, y: 20, left: 10, top: 20, right: 210, bottom: 100, width: 200, height: 80 } as DOMRect);
  const close = vi.fn();
  function Dialog() {
    const ref = useRef<HTMLDivElement>(null);
    useFocusTrap(ref, { onEscape: close });
    useCoversContent(true);
    return <div ref={ref} role="dialog" aria-modal="true" style={{ borderRadius: 16 }}><Select value="a" label="Fruit" options={options} onChange={() => undefined} /><button>Next</button></div>;
  }
  render(<Dialog />);
  fireEvent.click(trigger());
  expect(screen.getByRole("dialog").contains(screen.getByRole("listbox"))).toBe(false);
  expect(contentCoverDepth()).toBe(2);
  await waitFor(() => expect(ipc.setOverlayRegions).toHaveBeenLastCalledWith([{ x: 10, y: 20, width: 200, height: 80, radius: 16 }, { x: 10, y: 20, width: 200, height: 80, radius: 12 }], true, true));
  key("Escape"); expect(close).not.toHaveBeenCalled(); expect(contentCoverDepth()).toBe(1);
  key("Escape"); expect(close).toHaveBeenCalledOnce();
});

it("handles disabled, empty, removed and reordered options without stale commits", () => {
  const change = vi.fn();
  const view = render(<Select value="a" label="Fruit" options={options} onChange={change} disabled />);
  fireEvent.click(trigger()); expect(screen.queryByRole("listbox")).toBeNull();
  view.rerender(<Select value="a" label="Fruit" options={options} onChange={change} />);
  key("ArrowDown"); key("End");
  view.rerender(<Select value="a" label="Fruit" options={[options[2]!, options[0]!]} onChange={change} />);
  expect(active()).toContain("Cherry");
  view.rerender(<Select value="a" label="Fruit" options={[options[0]!]} onChange={change} />);
  key("Enter"); expect(change).not.toHaveBeenCalled();
  view.rerender(<Select value="a" label="Fruit" options={[]} onChange={change} />);
  fireEvent.click(trigger()); expect(screen.queryByRole("listbox")).toBeNull();
});

it("owns native input outside a dialog and sends rounded portal geometry", async () => {
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({ x: 10, y: 20, left: 10, top: 20, right: 210, bottom: 52, width: 200, height: 32 } as DOMRect);
  const view = render(<Select value="a" label="Fruit" options={options} onChange={() => undefined} />);
  fireEvent.click(trigger());
  const list = screen.getByRole("listbox");
  expect(list.hasAttribute("aria-modal")).toBe(false);
  await waitFor(() => expect(ipc.setOverlayRegions).toHaveBeenLastCalledWith(expect.any(Array), true, true));
  expect(visibleOverlayRegions()).toContainEqual({ x: 10, y: 20, width: 200, height: 32, radius: 12 });
  view.unmount();
  await waitFor(() => expect(ipc.setOverlayRegions).toHaveBeenLastCalledWith([], false, false));
});

it("dismisses outside clicks without choosing or activating the underlying control", () => {
  const change = vi.fn(), outside = vi.fn();
  render(<><Select value="a" label="Fruit" options={options} onChange={change} /><button onClick={outside}>Outside</button></>);
  fireEvent.click(trigger());
  fireEvent.pointerDown(screen.getByText("Outside"));
  fireEvent.click(screen.getByText("Outside"));
  expect(screen.queryByRole("listbox")).toBeNull();
  expect(change).not.toHaveBeenCalled(); expect(outside).not.toHaveBeenCalled();
});

it("repositions on scrolling and resizing without a stationary animation loop", async () => {
  let bottom = 740;
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) { return this.getAttribute("role") === "combobox" ? { x: 900, y: bottom - 32, left: 900, top: bottom - 32, right: 1100, bottom, width: 200, height: 32 } as DOMRect : { x: 0, y: 0, width: 200, height: 100 } as DOMRect; });
  render(<Select value="a" label="Fruit" options={options} onChange={() => undefined} />);
  fireEvent.click(trigger());
  const list = screen.getByRole("listbox");
  expect(Number.parseFloat(list.style.left) + Number.parseFloat(list.style.width)).toBeLessThanOrEqual(window.innerWidth - 8);
  expect(Number.parseFloat(list.style.top)).toBeLessThan(708);
  bottom = 100;
  fireEvent.scroll(document);
  await waitFor(() => expect(list.style.top).toBe("104px"));
  const frame = vi.spyOn(window, "requestAnimationFrame");
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 40)); });
  frame.mockClear();
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 40)); });
  expect(frame).not.toHaveBeenCalled();
});

it("does not reopen after a disabled or empty control becomes available again", () => {
  const props = { value: "b", label: "Fruit", options, onChange: vi.fn() };
  const view = render(<Select {...props} />);
  fireEvent.click(trigger());
  view.rerender(<Select {...props} disabled />);
  expect(contentCoverDepth()).toBe(0);
  view.rerender(<Select {...props} />);
  expect(screen.queryByRole("listbox")).toBeNull();
  fireEvent.click(trigger());
  view.rerender(<Select {...props} options={[]} />);
  view.rerender(<Select {...props} />);
  expect(screen.queryByRole("listbox")).toBeNull();
});

it("returns highlighting to the selected option when the highlighted choice disappears", () => {
  const change = vi.fn();
  const view = render(<Select value="b" label="Fruit" options={options} onChange={change} />);
  fireEvent.click(trigger()); key("End");
  view.rerender(<Select value="b" label="Fruit" options={options.slice(0, 2)} onChange={change} />);
  expect(active()).toContain("Banana");
  key("Enter"); expect(change).not.toHaveBeenCalled();
});

it("consumes the dismissal click when release retargets from a child to its button", () => {
  const outside = vi.fn();
  render(<><Select value="a" label="Fruit" options={options} onChange={() => undefined} /><button onClick={outside}><span>Outside icon</span>Outside action</button></>);
  fireEvent.click(trigger());
  fireEvent.pointerDown(screen.getByText("Outside icon"));
  fireEvent.pointerUp(screen.getByRole("button", { name: "Outside iconOutside action" }));
  fireEvent.click(screen.getByRole("button", { name: "Outside iconOutside action" }));
  expect(screen.queryByRole("listbox")).toBeNull();
  expect(outside).not.toHaveBeenCalled();
});

it.each(["pointerCancel", "next press", "dragStart", "contextMenu"])("clears a dismissal gesture on %s so a later independent click can activate", (ending) => {
  const outside = vi.fn();
  render(<><Select value="a" label="Fruit" options={options} onChange={() => undefined} /><button onClick={outside}>Outside</button></>);
  const button = screen.getByRole("button", { name: "Outside" });
  fireEvent.click(trigger());
  fireEvent.pointerDown(button);
  if (ending === "next press") fireEvent.pointerDown(button);
  else if (ending === "pointerCancel") fireEvent.pointerCancel(button);
  else if (ending === "dragStart") fireEvent.dragStart(button);
  else fireEvent.contextMenu(button);
  fireEvent.click(button);
  expect(outside).toHaveBeenCalledOnce();
});

it("dismisses without committing when scrolling carries its trigger below the viewport", () => {
  let top = 100;
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) { return this.getAttribute("role") === "combobox" ? { x: 10, y: top, left: 10, top, right: 210, bottom: top + 32, width: 200, height: 32 } as DOMRect : { x: 0, y: 0, width: 200, height: 100 } as DOMRect; });
  const change = vi.fn();
  render(<Select value="a" label="Fruit" options={options} onChange={change} />);
  fireEvent.click(trigger());
  expect(screen.getByRole("listbox")).toBeTruthy();
  top = window.innerHeight + 200;
  fireEvent.scroll(document);
  expect(screen.queryByRole("listbox")).toBeNull();
  expect(contentCoverDepth()).toBe(0);
  expect(change).not.toHaveBeenCalled();
});

it("expires dismissal after a release that produces no click", async () => {
  const outside = vi.fn();
  render(<><Select value="a" label="Fruit" options={options} onChange={() => undefined} /><button onClick={outside}>Outside</button></>);
  const button = screen.getByRole("button", { name: "Outside" });
  fireEvent.click(trigger());
  fireEvent.pointerDown(button);
  fireEvent.pointerUp(button);
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  fireEvent.click(button);
  expect(outside).toHaveBeenCalledOnce();
});
