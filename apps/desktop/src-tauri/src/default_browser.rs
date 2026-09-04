//! Being the system's default browser: asking macOS, and handling the
//! links it then hands us.

#![allow(unsafe_code)] // LaunchServices exposes these default-handler APIs only through C FFI.

use serde::{Deserialize, Serialize};
use specta::Type;

/// Where Dive stands as the handler for web links.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
pub struct DefaultBrowserStatus {
    /// Whether this platform build can ask to become the default at all.
    pub supported: bool,
    /// Whether Dive handles both `http` and `https` right now.
    pub is_default: bool,
    /// Bundle id of whatever handles `https` today, when known.
    pub current: Option<String>,
}

/// Schemes a browser must own to count as the default.
pub const SCHEMES: [&str; 2] = ["http", "https"];

/// The bundle id the app is built with.
pub const BUNDLE_ID: &str = "app.dive.browser";

// Launch Services has no safe binding; the two calls below are the whole
// unsafe surface, each with its ownership rule spelled out.
#[allow(unsafe_code)]
#[cfg(target_os = "macos")]
mod mac {
    use core_foundation::base::TCFType;
    use core_foundation::string::{CFString, CFStringRef};

    #[link(name = "CoreServices", kind = "framework")]
    unsafe extern "C" {
        fn LSCopyDefaultHandlerForURLScheme(scheme: CFStringRef) -> CFStringRef;
        fn LSSetDefaultHandlerForURLScheme(scheme: CFStringRef, handler: CFStringRef) -> i32;
    }

    /// Bundle id of the app registered for `scheme`, if any.
    pub fn handler_for(scheme: &str) -> Option<String> {
        let scheme = CFString::new(scheme);
        // SAFETY: Launch Services returns a +1 CFString or null; we take
        // ownership of the non-null case with `wrap_under_create_rule`.
        let raw = unsafe { LSCopyDefaultHandlerForURLScheme(scheme.as_concrete_TypeRef()) };
        if raw.is_null() {
            return None;
        }
        let handler = unsafe { CFString::wrap_under_create_rule(raw) };
        Some(handler.to_string().to_ascii_lowercase())
    }

    /// Ask Launch Services to route `scheme` to `bundle_id`. On modern macOS
    /// the system shows its own confirmation and applies the change after
    /// the person answers, so a zero status only means the request was
    /// accepted.
    pub fn set_handler(scheme: &str, bundle_id: &str) -> Result<(), i32> {
        let scheme = CFString::new(scheme);
        let handler = CFString::new(bundle_id);
        // SAFETY: both arguments are live CFStrings for the duration of the call.
        let status = unsafe {
            LSSetDefaultHandlerForURLScheme(
                scheme.as_concrete_TypeRef(),
                handler.as_concrete_TypeRef(),
            )
        };
        if status == 0 { Ok(()) } else { Err(status) }
    }

    /// Make sure Launch Services knows this bundle claims web schemes; a
    /// freshly built app that was never opened from Finder is not on its
    /// list, and then the request to become default is refused.
    pub fn register_bundle() {
        let Some(bundle) = bundle_path() else {
            return;
        };
        let lsregister = "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister";
        let _ = std::process::Command::new(lsregister)
            .arg("-f")
            .arg(&bundle)
            .output();
    }

    fn bundle_path() -> Option<std::path::PathBuf> {
        // <bundle>.app/Contents/MacOS/<exe>
        let exe = std::env::current_exe().ok()?;
        let bundle = exe.parent()?.parent()?.parent()?;
        (bundle.extension().is_some_and(|e| e == "app")).then(|| bundle.to_path_buf())
    }
}

/// The current state.
pub fn status() -> DefaultBrowserStatus {
    #[cfg(target_os = "macos")]
    {
        let current = mac::handler_for("https");
        let is_default = SCHEMES
            .iter()
            .all(|s| mac::handler_for(s).as_deref() == Some(BUNDLE_ID));
        DefaultBrowserStatus {
            supported: true,
            is_default,
            current,
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        DefaultBrowserStatus {
            supported: false,
            is_default: false,
            current: None,
        }
    }
}

/// Ask the system to make Dive the default. Returns the status right after
/// asking; the chrome polls [`status`] for a few seconds afterwards because
/// macOS confirms with the person before applying it.
pub fn make_default() -> Result<DefaultBrowserStatus, String> {
    #[cfg(target_os = "macos")]
    {
        mac::register_bundle();
        for scheme in SCHEMES {
            mac::set_handler(scheme, BUNDLE_ID).map_err(|code| match code {
                -54 => "macOS refused the change (permission denied). Set it under System Settings > Desktop & Dock > Default web browser.".to_owned(),
                -10814 => "macOS does not know this build of Dive as a browser yet. Open Dive from the Applications folder once, then try again.".to_owned(),
                other => format!("Launch Services returned {other} while setting the {scheme} handler"),
            })?;
        }
        Ok(status())
    }
    #[cfg(not(target_os = "macos"))]
    {
        Err("setting the default browser is not supported on this platform yet".to_owned())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn status_reports_the_platform_honestly() {
        let s = status();
        assert_eq!(s.supported, cfg!(target_os = "macos"));
        if !s.supported {
            assert!(!s.is_default);
        }
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn launch_services_answers_with_a_bundle_id() {
        // Whatever browser this machine uses, the FFI must come back with
        // its bundle id rather than crash or return garbage.
        let handler = mac::handler_for("https").expect("some app handles https");
        assert!(handler.contains('.'), "{handler}");
        assert_eq!(handler, handler.to_ascii_lowercase());
        assert_eq!(status().is_default, handler == BUNDLE_ID);
    }

    #[test]
    fn default_means_both_schemes() {
        assert_eq!(SCHEMES, ["http", "https"]);
        assert_eq!(BUNDLE_ID, "app.dive.browser");
    }
}
