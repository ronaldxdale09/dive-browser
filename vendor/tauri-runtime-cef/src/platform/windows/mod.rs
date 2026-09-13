// Copyright 2019-2024 Tauri Programme within The Commons Conservancy
// SPDX-License-Identifier: Apache-2.0
// SPDX-License-Identifier: MIT

mod event_loop;
mod icon;
mod modal_input;
mod monitor;
mod webview;
mod window;

#[cfg(test)]
mod tests {
    #[test]
    fn standalone_harness_loads_common_controls_v6() {
        use windows::{
            Win32::{
                System::LibraryLoader::{GetModuleHandleW, GetProcAddress},
                UI::Shell::DLLVERSIONINFO,
            },
            core::{HRESULT, s, w},
        };
        // Inspect the loaded module, rather than merely checking manifest text.
        // A missing v6 activation context previously prevented this executable
        // from even entering libtest (GetWindowSubclass, status 0xc0000139).
        let module =
            unsafe { GetModuleHandleW(w!("comctl32.dll")) }.expect("Common Controls is loaded");
        let address = unsafe { GetProcAddress(module, s!("DllGetVersion")) }
            .expect("DllGetVersion is exported");
        let get_version: unsafe extern "system" fn(*mut DLLVERSIONINFO) -> HRESULT =
            unsafe { std::mem::transmute(address) };
        let mut version = DLLVERSIONINFO {
            cbSize: std::mem::size_of::<DLLVERSIONINFO>() as u32,
            ..Default::default()
        };
        unsafe { get_version(&mut version) }
            .ok()
            .expect("query Common Controls version");
        assert!(
            version.dwMajorVersion >= 6,
            "loaded Common Controls {version:?}; standalone tests require v6"
        );
    }
}
