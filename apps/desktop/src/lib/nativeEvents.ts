/** DOM events the native shell dispatches into the chrome for reserved shortcuts.
 * The Rust side spells them in `vendor/tauri-runtime-cef/src/reserved_shortcut_native.rs`;
 * `nativeEvents.test.ts` keeps the two equal. */
export const NATIVE_NEW_TAB = "dive-native-new-tab";
export const NATIVE_FOCUS_ADDRESS = "dive-native-focus-address";
