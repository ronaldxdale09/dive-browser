import { afterEach, describe, expect, it, vi } from "vitest";
import { ipc } from "../lib/ipc";
import type { HttpAuthAsked, JsDialogAsked } from "../lib/ipc";
import { useBrowser } from "./browser";
import { useHttpAuth } from "./httpAuth";
import { useJsDialog } from "./jsDialog";

/** A failure as the IPC layer throws it: some words, and the host's kind. */
const failure = (message: string, kind: { type: "gone" } | null) => Object.assign(new Error(message), { kind });

const sign_in: HttpAuthAsked = { tab_id: "t1", request_id: "r1", host: "example.com", realm: "", scheme: "basic", is_proxy: false, secure: true };
const dialog: JsDialogAsked = { tab_id: "t1", dialog_id: "7", kind: "alert", origin: "https://example.com", message: "hi", default_value: "", is_reload: false };

afterEach(() => {
  vi.restoreAllMocks();
  useBrowser.setState({ error: null });
});

describe("answering something that is already gone", () => {
  it("stays quiet for a sign-in the host calls gone, whatever words it used", async () => {
    vi.spyOn(ipc, "httpAuthAnswer").mockRejectedValue(failure("this prompt has been withdrawn", { type: "gone" }));
    await useHttpAuth.getState().answer(sign_in, "ada", "pw");
    expect(useBrowser.getState().error).toBeNull();
  });

  it("shows any other sign-in failure, even one that borrows the old words", async () => {
    vi.spyOn(ipc, "httpAuthAnswer").mockRejectedValue(failure("that sign-in is no longer waiting", null));
    await useHttpAuth.getState().answer(sign_in, "ada", "pw");
    expect(useBrowser.getState().error).toBe("that sign-in is no longer waiting");
  });

  it("stays quiet for a dialog the host calls gone, whatever words it used", async () => {
    vi.spyOn(ipc, "jsDialogAnswer").mockRejectedValue(failure("the page moved on", { type: "gone" }));
    await useJsDialog.getState().answer(dialog, true);
    expect(useBrowser.getState().error).toBeNull();
  });

  it("shows any other dialog failure, even one that borrows the old words", async () => {
    vi.spyOn(ipc, "jsDialogAnswer").mockRejectedValue(failure("that dialog is no longer open", null));
    await useJsDialog.getState().answer(dialog, true);
    expect(useBrowser.getState().error).toBe("that dialog is no longer open");
  });
});
