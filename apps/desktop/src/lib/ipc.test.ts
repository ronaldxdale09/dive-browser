import { describe, expect, it } from "vitest";
import { IpcError, unwrap } from "./ipc";

describe("unwrap", () => {
  it("returns the data of an ok result", () => {
    expect(unwrap({ status: "ok", data: 3 })).toBe(3);
  });

  it("throws an IpcError that keeps the host's kind and leaves the message alone", () => {
    let thrown: unknown;
    try {
      unwrap({ status: "error", error: { message: "that dialog is no longer open", kind: { type: "gone" } } });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(IpcError);
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as IpcError).message).toBe("that dialog is no longer open");
    expect((thrown as IpcError).kind?.type).toBe("gone");
  });

  it("gives a kind of null when the host sent none", () => {
    for (const error of [{ message: "boom" }, { message: "boom", kind: null }]) {
      try {
        unwrap({ status: "error", error });
        expect.unreachable();
      } catch (e) {
        expect((e as IpcError).kind).toBeNull();
        expect((e as IpcError).message).toBe("boom");
      }
    }
  });
});
