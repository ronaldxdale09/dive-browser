import { beforeEach, describe, expect, it } from "vitest";
import { useAgentPresence } from "./agentPresence";

beforeEach(() => useAgentPresence.getState().reset());

describe("agent presence", () => {
  it("remembers which tabs are driven and forgets them when told", () => {
    const { set } = useAgentPresence.getState();
    set("a", true);
    set("b", true);
    expect(useAgentPresence.getState().driving).toEqual({ a: true, b: true });
    set("a", false);
    expect(useAgentPresence.getState().driving).toEqual({ b: true });
  });

  it("keeps the same object when nothing changed, so tab rows do not re-render", () => {
    // Every tab row subscribes to this, and the host repeats itself across a
    // run; a new object each time would re-render the whole list per action.
    const { set } = useAgentPresence.getState();
    set("a", true);
    const first = useAgentPresence.getState().driving;
    set("a", true);
    expect(useAgentPresence.getState().driving).toBe(first);
    set("b", false);
    expect(useAgentPresence.getState().driving).toBe(first);
  });
});
