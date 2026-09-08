import { describe, expect, it } from "vitest";
import { scopeLabel } from "./Privacy";

describe("scopeLabel", () => {
  it("names the container only when it differs from the profile", () => {
    expect(scopeLabel("Personal", "Personal")).toBe("Personal");
    expect(scopeLabel("Personal", "Client work")).toBe("Personal · Client work");
    expect(scopeLabel("Personal", "")).toBe("Personal");
  });
});
