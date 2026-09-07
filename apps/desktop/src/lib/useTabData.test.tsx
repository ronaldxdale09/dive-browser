import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { isTransientReadError, readErrorText, useTabData } from "./useTabData";

function Probe({ tab, fetcher }: { tab: string | null; fetcher: (id: string) => Promise<string> }) {
  const { data, error } = useTabData(tab, "https://a.test/", fetcher);
  return <div>{error ? `error: ${error}` : (data ?? "reading")}</div>;
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("useTabData", () => {
  it("knows a read that raced a navigation", () => {
    expect(isTransientReadError("cdp error -32000: Inspected target navigated or closed")).toBe(true);
    expect(isTransientReadError("Not attached to an active page")).toBe(true);
    expect(isTransientReadError("boom")).toBe(false);
    expect(readErrorText("cdp error -32000: Inspected target navigated or closed")).toBe("The page was still loading when it was read.");
    expect(readErrorText("boom")).toBe("boom");
  });

  it("tries once more after a transient failure and then shows the answer", async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn<(id: string) => Promise<string>>().mockRejectedValueOnce(new Error("cdp error -32000: Inspected target navigated or closed")).mockResolvedValueOnce("Example Domain");
    render(<Probe tab="t1" fetcher={fetcher} />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10);
    });
    // Still reading: the raw protocol error never reaches the panel.
    expect(screen.getByText("reading")).toBeTruthy();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(800);
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(screen.getByText("Example Domain")).toBeTruthy();
  });

  it("gives up in plain words when the second try fails too", async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn<(id: string) => Promise<string>>().mockRejectedValue(new Error("Not attached to an active page"));
    render(<Probe tab="t1" fetcher={fetcher} />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(screen.getByText("error: The page was still loading when it was read.")).toBeTruthy();
  });

  it("shows other failures as they are, once", async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn<(id: string) => Promise<string>>().mockRejectedValue(new Error("no such tab"));
    render(<Probe tab="t1" fetcher={fetcher} />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(screen.getByText("error: no such tab")).toBeTruthy();
  });
});
