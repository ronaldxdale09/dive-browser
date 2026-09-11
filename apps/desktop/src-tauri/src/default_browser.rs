//! Being the system's default browser: asking the system, and handling the
//! links it then hands us.
//!
//! The two platforms differ in what "asking" even means. macOS lets an app
//! set the handler itself and confirms with the person. Windows has not
//! allowed that since Windows 8 -- the choice lives in a registry key signed
//! with a hash only the shell can produce -- so all an application can do is
//! register itself as a browser and open the Settings page where the person
//! makes the change. Both are honest about it: [`make_default`] returns the
//! status right after asking, and on Windows that status still says Dive is
//! not the default until the person picks it.

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
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
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

/// Registering as a browser, and sending the person to the one place Windows
/// lets the default be chosen.
#[cfg(target_os = "windows")]
mod win {
    use winreg::RegKey;
    use winreg::enums::{HKEY_CURRENT_USER, KEY_READ, KEY_WRITE};

    /// The `ProgID` Dive registers for `http` and `https`.
    pub const PROG_ID: &str = "DiveHTML";

    /// Whatever currently handles `scheme`, as the `ProgID` the shell records.
    ///
    /// This is `UserChoice`, the key the shell writes when someone picks a
    /// default. It is the only honest answer: an application can be
    /// perfectly registered and still not be the default.
    pub fn handler_for(scheme: &str) -> Option<String> {
        RegKey::predef(HKEY_CURRENT_USER)
            .open_subkey_with_flags(
                format!(
                    "Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\{scheme}\\UserChoice"
                ),
                KEY_READ,
            )
            .ok()?
            .get_value::<String, _>("ProgId")
            .ok()
    }

    /// Announce Dive to the shell as something that can be a browser.
    ///
    /// Windows will not offer an application in the defaults list at all
    /// until it has registered its capabilities, so this has to succeed
    /// before sending anyone to Settings -- otherwise they arrive to a list
    /// Dive is not in. Everything goes under `HKCU`, so no elevation.
    pub fn register() -> Result<(), String> {
        let exe = std::env::current_exe().map_err(|e| format!("cannot locate Dive: {e}"))?;
        let exe = exe.display().to_string();
        let hkcu = RegKey::predef(HKEY_CURRENT_USER);
        let write = |path: String| {
            hkcu.create_subkey_with_flags(path, KEY_WRITE)
                .map(|(key, _)| key)
                .map_err(|e| format!("could not register Dive as a browser: {e}"))
        };

        let classes = format!("Software\\Classes\\{PROG_ID}");
        let prog = write(classes.clone())?;
        prog.set_value("", &"Dive Document")
            .map_err(|e| e.to_string())?;
        write(format!("{classes}\\DefaultIcon"))?
            .set_value("", &format!("{exe},0"))
            .map_err(|e| e.to_string())?;
        write(format!("{classes}\\shell\\open\\command"))?
            .set_value("", &format!("\"{exe}\" \"%1\""))
            .map_err(|e| e.to_string())?;

        let caps = "Software\\Dive\\Capabilities";
        let capabilities = write(caps.to_owned())?;
        capabilities
            .set_value("ApplicationName", &"Dive")
            .map_err(|e| e.to_string())?;
        capabilities
            .set_value(
                "ApplicationDescription",
                &"The browser built for developers",
            )
            .map_err(|e| e.to_string())?;
        let urls = write(format!("{caps}\\URLAssociations"))?;
        for scheme in super::SCHEMES {
            urls.set_value(scheme, &PROG_ID)
                .map_err(|e| e.to_string())?;
        }
        // The list the defaults UI actually reads.
        write("Software\\RegisteredApplications".to_owned())?
            .set_value("Dive", &caps)
            .map_err(|e| e.to_string())?;
        Ok(())
    }

    /// Open the defaults page. Windows allows nothing more direct than this.
    pub fn open_settings() -> Result<(), String> {
        std::process::Command::new("cmd")
            .args(["/C", "start", "", "ms-settings:defaultapps"])
            .status()
            .map_err(|e| format!("could not open Windows Settings: {e}"))
            .and_then(|s| {
                s.success()
                    .then_some(())
                    .ok_or_else(|| format!("Windows Settings would not open ({s})"))
            })
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
    #[cfg(target_os = "windows")]
    {
        let current = win::handler_for("https");
        let is_default = SCHEMES
            .iter()
            .all(|s| win::handler_for(s).as_deref() == Some(win::PROG_ID));
        DefaultBrowserStatus {
            supported: true,
            is_default,
            current,
        }
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
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
    #[cfg(target_os = "windows")]
    {
        // Register first: an unregistered application is not in the list the
        // Settings page shows, so sending someone there would waste the trip.
        win::register()?;
        win::open_settings()?;
        Ok(status())
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
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
        // Windows counts as supported even though it will not let anyone set
        // the default: Dive can register itself and open the page where the
        // choice is made, which is the whole of what "supported" promises.
        assert_eq!(
            s.supported,
            cfg!(any(target_os = "macos", target_os = "windows"))
        );
        if !s.supported {
            assert!(!s.is_default);
            assert_eq!(s.current, None);
        }
    }

    /// A platform that cannot be asked must not claim Dive is already the
    /// default, or the chrome would hide the button that says otherwise.
    #[test]
    fn an_unsupported_platform_never_claims_to_be_the_default() {
        let s = status();
        assert!(s.supported || !s.is_default);
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
