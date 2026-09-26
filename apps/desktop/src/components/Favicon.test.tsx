import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ipc } from "../lib/ipc";
import { isFaviconKey, resetFavicons } from "../lib/favicons";
import { Favicon } from "./Favicon";

afterEach(() => {
  cleanup();
  resetFavicons();
  vi.restoreAllMocks();
});

const images = (container: HTMLElement) => [...container.querySelectorAll("img")].map((img) => img.getAttribute("src"));

describe("Favicon", () => {
  it("reads every key a render shows in one call, and each key once", async () => {
    const get = vi.spyOn(ipc, "faviconGet").mockResolvedValue([
      ["a1b2", "data:image/png;base64,QQ=="],
      ["c3d4", "data:image/svg+xml;base64,Qg=="],
    ]);
    const { container, rerender } = render(
      <>
        <Favicon src="a1b2" />
        <Favicon src="a1b2" />
        <Favicon src="c3d4" />
        <Favicon src="ffff" />
      </>,
    );
    // Nothing to show until the host answers: the fallback, not a broken image.
    expect(images(container)).toEqual([]);
    await waitFor(() => expect(images(container)).toHaveLength(3));
    expect(images(container)).toEqual(["data:image/png;base64,QQ==", "data:image/png;base64,QQ==", "data:image/svg+xml;base64,Qg=="]);
    expect(get).toHaveBeenCalledTimes(1);
    expect(get.mock.calls[0]?.[0]?.sort()).toEqual(["a1b2", "c3d4", "ffff"]);

    // Kept: a later row with a known key, or one the host had nothing for,
    // asks nothing.
    rerender(
      <>
        <Favicon src="c3d4" />
        <Favicon src="ffff" />
      </>,
    );
    await Promise.resolve();
    expect(get).toHaveBeenCalledTimes(1);
    expect(images(container)).toEqual(["data:image/svg+xml;base64,Qg=="]);
  });

  it("shows a URL as it is", () => {
    const get = vi.spyOn(ipc, "faviconGet");
    const { container } = render(<Favicon src="data:image/png;base64,QQ==" />);
    expect(images(container)).toEqual(["data:image/png;base64,QQ=="]);
    expect(get).not.toHaveBeenCalled();
  });

  it("tells a key from a URL", () => {
    expect(isFaviconKey("0123456789abcdef1f")).toBe(true);
    expect(isFaviconKey("data:image/png;base64,QQ==")).toBe(false);
    expect(isFaviconKey("https://a.test/favicon.ico")).toBe(false);
    expect(isFaviconKey("")).toBe(false);
  });
});
