import { act, cleanup, render } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { CharacterBg } from "./CharacterBg";
import { OrbBurst } from "./OrbBurst";

const pending = new Map<number, FrameRequestCallback>();
let id = 0;
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); pending.clear(); });
function frames() {
  vi.stubGlobal("requestAnimationFrame", (run: FrameRequestCallback) => { pending.set(++id, run); return id; });
  vi.stubGlobal("cancelAnimationFrame", (key: number) => pending.delete(key));
  vi.stubGlobal("IntersectionObserver", class {
    constructor(private callback: (entries: { isIntersecting: boolean }[]) => void) {}
    observe() { this.callback([{ isIntersecting: true }]); }
    disconnect() {}
  });
  Object.defineProperty(document, "hidden", { configurable: true, value: false });
}
it("a static character field schedules no recurring work even when visible", () => {
  frames();
  const view = render(<CharacterBg animated={false} />);
  expect(pending.size).toBe(0);
  view.rerender(<CharacterBg animated />);
  expect(pending.size).toBe(1);
  view.rerender(<CharacterBg animated={false} />);
  expect(pending.size).toBe(0);
});
it("a static orb paints once and schedules no next frame", () => {
  frames();
  const paint = vi.fn();
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({ setTransform() {}, clearRect: paint, beginPath() {}, arc() {}, fill() {} } as unknown as CanvasRenderingContext2D);
  render(<OrbBurst animated={false} pointer={{ drag: 0 }} />);
  expect(pending.size).toBe(1);
  act(() => {
    const work = [...pending.values()]; pending.clear();
    for (const run of work) run(100);
  });
  expect(paint).toHaveBeenCalledTimes(1);
  expect(pending.size).toBe(0);
});
it("repaints a static orb once for changed colors/size and live theme changes", async () => {
  frames();
  const paint = vi.fn();
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({ setTransform() {}, clearRect: paint, beginPath() {}, arc() {}, fill() {} } as unknown as CanvasRenderingContext2D);
  const view = render(<OrbBurst animated={false} width={100} dotColor="#000000" />);
  const draw = () => act(() => { const work = [...pending.values()]; pending.clear(); for (const run of work) run(100); });
  draw();
  view.rerender(<OrbBurst animated={false} width={200} dotColor="#ffffff" />);
  expect(pending.size).toBe(1);
  draw();
  expect(paint).toHaveBeenLastCalledWith(0, 0, 200, 120);
  expect(pending.size).toBe(0);
  await act(async () => { document.documentElement.style.setProperty("--color-ink", "#abcdef"); });
  expect(pending.size).toBe(1);
  draw();
  expect(paint).toHaveBeenCalledTimes(3);
  expect(pending.size).toBe(0);
  view.rerender(<OrbBurst animated={false} width={200} dotColor="#ffffff" />);
  expect(pending.size).toBe(0);
  view.unmount();
  document.documentElement.style.removeProperty("--color-ink");
});
function animatedOrb() {
  frames();
  vi.spyOn(document, "hasFocus").mockReturnValue(true);
  const paint = vi.fn();
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({ setTransform() {}, clearRect: paint, beginPath() {}, arc() {}, fill() {} } as unknown as CanvasRenderingContext2D);
  const step = (at: number) => act(() => { const work = [...pending.values()]; pending.clear(); for (const run of work) run(at); });
  return { paint, step };
}
it("an orb capped at 30 fps paints every other frame of a 60 Hz display", () => {
  vi.stubGlobal("matchMedia", (query: string) => ({ matches: false, media: query, addEventListener() {}, removeEventListener() {} }));
  const { paint, step } = animatedOrb();
  render(<OrbBurst animated pointer={{ drag: 0 }} width={100} maxFps={30} />);
  for (let frame = 0; frame < 12; frame += 1) step(1000 + frame * (1000 / 60));
  expect(paint).toHaveBeenCalledTimes(6);
  expect(pending.size).toBe(1);
});
it("an idle orb holds its frame until the pointer moves", () => {
  vi.stubGlobal("matchMedia", (query: string) => ({ matches: false, media: query, addEventListener() {}, removeEventListener() {} }));
  let clock = 0;
  vi.spyOn(performance, "now").mockImplementation(() => clock);
  const { paint, step } = animatedOrb();
  render(<OrbBurst animated pointer={{ drag: 0 }} width={100} idleAfterMs={8000} />);
  step(100);
  expect(paint).toHaveBeenCalledTimes(1);
  step(9000);
  expect(paint).toHaveBeenCalledTimes(1);
  expect(pending.size).toBe(0);
  clock = 9100;
  act(() => { window.dispatchEvent(new Event("pointermove")); });
  expect(pending.size).toBe(1);
  step(9120);
  expect(paint).toHaveBeenCalledTimes(2);
  expect(pending.size).toBe(1);
});
