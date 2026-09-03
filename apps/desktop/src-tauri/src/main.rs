//! Binary entry point. On CEF the same executable is re-launched as a
//! sub-process with `--type=...`; `cef_entry_point` on `run` handles that.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    dive_desktop_lib::run();
}
