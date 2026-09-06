import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { Star } from "lucide-react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EmptyState } from "./EmptyState";

afterEach(cleanup);

describe("EmptyState", () => {
  it("renders the title, the optional hint and the optional action", () => {
    const onClick = vi.fn();
    render(<EmptyState icon={Star} title="No bookmarks yet" hint="Press ⌘D on a page to keep it here" action={{ label: "Open a page", onClick }} />);
    expect(screen.getByRole("status").textContent).toContain("No bookmarks yet");
    expect(screen.getByText("Press ⌘D on a page to keep it here")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Open a page" }));
    expect(onClick).toHaveBeenCalledOnce();
  });

  it("leaves out what it is not given", () => {
    render(<EmptyState icon={Star} title="Nothing matches" />);
    expect(screen.getByText("Nothing matches")).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
  });
});
