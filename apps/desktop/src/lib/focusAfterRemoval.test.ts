import { afterEach, describe, expect, it } from "vitest";
import { focusAfterRemoval, listRows, rowAfterRemoval, rowIndexOf } from "./focusAfterRemoval";

afterEach(() => {
  document.body.innerHTML = "";
});

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function list(names: string[]): HTMLUListElement {
  const ul = document.createElement("ul");
  for (const name of names) {
    const li = document.createElement("li");
    const open = document.createElement("button");
    open.textContent = name;
    const remove = document.createElement("button");
    remove.title = "Remove";
    li.append(open, remove);
    ul.append(li);
  }
  document.body.append(ul);
  return ul;
}

describe("rowAfterRemoval", () => {
  it("takes the row that slid into place, else the one above, else none", () => {
    expect(rowAfterRemoval(["b", "c"], 0)).toBe("b");
    expect(rowAfterRemoval(["a", "b"], 2)).toBe("b");
    expect(rowAfterRemoval([], 0)).toBeNull();
  });
});

describe("focusAfterRemoval", () => {
  it("moves focus to the same control in the next row", async () => {
    const ul = list(["a", "b", "c"]);
    const remove = ul.children[1]!.querySelector<HTMLButtonElement>("[title=Remove]")!;
    remove.focus();
    expect(rowIndexOf(ul, remove)).toBe(1);
    focusAfterRemoval(ul, 1);
    ul.children[1]!.remove();
    await flush();
    expect(document.activeElement).toBe(ul.children[1]!.querySelector("[title=Remove]"));
  });

  it("falls back to the row above, then to the fallback", async () => {
    const ul = list(["a", "b"]);
    ul.children[1]!.querySelector<HTMLButtonElement>("button")!.focus();
    focusAfterRemoval(ul, 1);
    ul.children[1]!.remove();
    await flush();
    expect(document.activeElement).toBe(ul.children[0]!.querySelector("button"));

    const heading = document.createElement("h2");
    document.body.prepend(heading);
    focusAfterRemoval(ul, 0, heading);
    ul.remove();
    await flush();
    expect(document.activeElement).toBe(heading);
    expect(heading.getAttribute("tabindex")).toBe("-1");
  });

  it("uses marked rows when they are not direct children", () => {
    const root = document.createElement("div");
    root.innerHTML = `<section><h4>Today</h4><ul><li data-row><button>a</button></li></ul></section><section><ul><li data-row><button>b</button></li></ul></section>`;
    document.body.append(root);
    expect(listRows(root).map((row) => row.textContent)).toEqual(["a", "b"]);
  });

  it("leaves focus alone when it went somewhere on purpose", async () => {
    const ul = list(["a", "b"]);
    const elsewhere = document.createElement("input");
    document.body.append(elsewhere);
    ul.children[0]!.querySelector<HTMLButtonElement>("button")!.focus();
    focusAfterRemoval(ul, 0);
    elsewhere.focus();
    ul.children[0]!.remove();
    await flush();
    expect(document.activeElement).toBe(elsewhere);
  });
});
