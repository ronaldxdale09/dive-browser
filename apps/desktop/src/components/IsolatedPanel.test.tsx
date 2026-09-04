import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { lazy, Suspense, useState } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ipc } from "../lib/ipc";
import { contentCoverDepth, resetContentCover, useCoversContent } from "../lib/overlay";
import { IsolatedPanel } from "./IsolatedPanel";

beforeEach(() => {
  resetContentCover();
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(ipc, "prepareContentCover").mockResolvedValue([]);
  vi.spyOn(ipc, "setContentCovered").mockResolvedValue(null);
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

function Tool({ broken }: { broken: boolean }) {
  useCoversContent(true);
  if (broken) throw Error("render failed");
  return <button>Healthy tool</button>;
}

it("keeps the native page covered through a modal crash and releases it on keyboard close", async () => {
  function Harness({ broken }: { broken: boolean }) {
    const [open, setOpen] = useState(true);
    return <><button>Address bar</button>{open && <IsolatedPanel label="Extensions" modal onClose={() => setOpen(false)}><Tool broken={broken} /></IsolatedPanel>}</>;
  }
  const view = render(<Harness broken={false} />);
  await waitFor(() => expect(ipc.setContentCovered).toHaveBeenCalledWith(true));
  expect(contentCoverDepth()).toBe(2);
  view.rerender(<Harness broken />);
  expect(contentCoverDepth()).toBe(1);
  expect(ipc.setContentCovered).not.toHaveBeenCalledWith(false);
  const close = screen.getByRole("button", { name: "Close Extensions" });
  expect(document.activeElement).toBe(close);
  fireEvent.keyDown(close, { key: "Tab" });
  expect(document.activeElement).toBe(close);
  fireEvent.keyDown(close, { key: "Escape" });
  expect(contentCoverDepth()).toBe(0);
  expect(ipc.setContentCovered).toHaveBeenLastCalledWith(false);
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(screen.getByRole("button", { name: "Address bar" })).toBeTruthy();
});

it("contains rejected lazy imports while leaving sibling controls alive", async () => {
  const Broken = lazy(() => Promise.reject(Error("chunk unavailable")));
  const close = vi.fn();
  render(<><button>New tab</button><IsolatedPanel label="Developer dock" onClose={close}><Suspense fallback="Loading"><Broken /></Suspense></IsolatedPanel></>);
  await screen.findByRole("alert");
  expect(screen.getByRole("button", { name: "New tab" })).toBeTruthy();
  expect(contentCoverDepth()).toBe(0);
  fireEvent.click(screen.getByRole("button", { name: "Close Developer dock" }));
  expect(close).toHaveBeenCalledTimes(1);
});

it("does not steal toolbar focus for an inline failure and recovers on reopen", () => {
  function Crash({ broken }: { broken: boolean }) { if (broken) throw Error("bad panel"); return <p>Recovered</p>; }
  function Harness() {
    const [open, setOpen] = useState(false);
    const [broken, setBroken] = useState(true);
    return <><button onClick={() => setOpen(true)}>Open agent</button>{open && <IsolatedPanel label="Agent" onClose={() => { setOpen(false); setBroken(false); }}><Crash broken={broken} /></IsolatedPanel>}</>;
  }
  render(<Harness />);
  const toolbar = screen.getByRole("button", { name: "Open agent" });
  toolbar.focus();
  fireEvent.click(toolbar);
  expect(document.activeElement).toBe(toolbar);
  fireEvent.click(screen.getByRole("button", { name: "Close Agent" }));
  fireEvent.click(toolbar);
  expect(screen.getByText("Recovered")).toBeTruthy();
  expect(screen.queryByRole("alert")).toBeNull();
});
