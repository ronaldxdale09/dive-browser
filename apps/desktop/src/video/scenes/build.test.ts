import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const source = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "build.tsx"), "utf8");

describe("feature tour agent scene", () => {
  it("does not claim the agent asks before anything irreversible", () => {
    expect(source).not.toMatch(/asks before anything irreversible/);
    expect(source).toMatch(/floor, not a guarantee/);
  });

  it("does not invent an MCP tool count", () => {
    expect(source).not.toMatch(/\d+ tools/);
  });

  it("does not claim MCP reads every tab", () => {
    expect(source).not.toMatch(/read your tabs/);
    expect(source).toMatch(/Sleeping tabs are omitted/);
    expect(source).toMatch(/workspace in front/);
  });

  it("does not say every workspace keeps cookies apart", () => {
    expect(source).not.toMatch(/Tabs, cookies and logins kept apart/);
    expect(source).toMatch(/unless/);
  });

  it("does not say any page becomes a QR code", () => {
    expect(source).not.toMatch(/Any page becomes a QR/);
    expect(source).toMatch(/http or https/);
  });

  it("does not say every listener appears in the palette by itself", () => {
    expect(source).not.toMatch(/by themselves/);
    expect(source).toMatch(/serve a page/);
  });
});



