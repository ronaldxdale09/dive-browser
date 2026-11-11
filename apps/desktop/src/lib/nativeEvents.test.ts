import { describe, expect, it } from "vitest";
import runtimeSource from "../../../../vendor/tauri-runtime-cef/src/reserved_shortcut_native.rs?raw";
import { NATIVE_FOCUS_ADDRESS, NATIVE_NEW_TAB } from "./nativeEvents";

const declared = (name: string, value: string) => new RegExp(`const ${name}: &str = "${value}";`).test(runtimeSource);

describe("native DOM event names", () => {
  it("match the constants the vendored runtime dispatches", () => {
    expect(declared("NEW_TAB_EVENT", NATIVE_NEW_TAB)).toBe(true);
    expect(declared("FOCUS_ADDRESS_EVENT", NATIVE_FOCUS_ADDRESS)).toBe(true);
  });
});
