//! The one place that hands paths and links to the operating system.
//!
//! Nothing here goes through `cmd`: it re-parses its arguments, so a file
//! name such as `report&calc.csv` (legal on Windows, and kept from the server
//! or from an import) would be split into a second command. Every "open with
//! the system" and "show in folder" in Dive calls [`open`] or [`reveal`].

use crate::error::{AppError, AppResult};

/// Hand a path or URL to the system to open with its default application;
/// `what` names it in the error ("the file", "the link").
pub(crate) fn open(target: &std::ffi::OsStr, what: &str) -> AppResult<()> {
    #[cfg(target_os = "windows")]
    return open_with_shell(target, what);
    #[cfg(not(target_os = "windows"))]
    {
        #[cfg(target_os = "macos")]
        let status = std::process::Command::new("/usr/bin/open")
            .arg(target)
            .status();
        #[cfg(not(target_os = "macos"))]
        let status = std::process::Command::new("xdg-open").arg(target).status();
        match status {
            Ok(s) if s.success() => Ok(()),
            Ok(s) => Err(AppError::new(format!("could not open {what} ({s})"))),
            Err(e) => Err(AppError::new(e)),
        }
    }
}

/// Open `path` in the platform file manager, selecting it when it is a file.
pub(crate) fn reveal(path: &std::path::Path) -> AppResult<()> {
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt as _;
        // The argument is built whole and passed raw, so Rust adds no quotes
        // of its own. Explorer exits 1 even when it worked, so only a failure
        // to start it counts.
        let arg = explorer_select_arg(&path.display().to_string(), path.is_file());
        std::process::Command::new("explorer")
            .raw_arg(arg)
            .spawn()
            .map(|_| ())
            .map_err(AppError::new)
    }
    #[cfg(not(target_os = "windows"))]
    {
        #[cfg(target_os = "macos")]
        let status = {
            let mut cmd = std::process::Command::new("open");
            if path.is_file() {
                cmd.arg("-R");
            }
            cmd.arg(path).status()
        };
        #[cfg(target_os = "linux")]
        let status = std::process::Command::new("xdg-open")
            .arg(if path.is_file() {
                path.parent().unwrap_or(path)
            } else {
                path
            })
            .status();
        match status {
            Ok(s) if s.success() => Ok(()),
            Ok(s) => Err(AppError::new(format!("file manager exited with {s}"))),
            Err(e) => Err(AppError::new(e)),
        }
    }
}

/// The argument Explorer needs to open a folder with `path` selected.
/// Windows paths cannot contain `"`, so wrapping in quotes is safe.
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
fn explorer_select_arg(path: &str, is_file: bool) -> String {
    if is_file {
        format!("/select,\"{path}\"")
    } else {
        format!("\"{path}\"")
    }
}

/// Windows goes through the shell API: `ShellExecuteW` takes the path as one
/// wide string and parses nothing.
#[cfg(target_os = "windows")]
#[allow(unsafe_code)] // ShellExecuteW is reachable only through the Win32 API.
fn open_with_shell(target: &std::ffi::OsStr, what: &str) -> AppResult<()> {
    use std::os::windows::ffi::OsStrExt as _;
    use windows::Win32::UI::Shell::ShellExecuteW;
    use windows::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;
    use windows::core::PCWSTR;

    let wide = |s: &std::ffi::OsStr| {
        s.encode_wide()
            .chain(std::iter::once(0))
            .collect::<Vec<u16>>()
    };
    let verb = wide(std::ffi::OsStr::new("open"));
    let path = wide(target);
    // SAFETY: both strings are NUL-terminated and outlive the call, and a null
    // HWND is documented as "no parent window".
    let result = unsafe {
        ShellExecuteW(
            None,
            PCWSTR(verb.as_ptr()),
            PCWSTR(path.as_ptr()),
            PCWSTR::null(),
            PCWSTR::null(),
            SW_SHOWNORMAL,
        )
    };
    // Success is documented as a value greater than 32; anything else is an
    // error code in disguise.
    if result.0 as usize > 32 {
        Ok(())
    } else {
        Err(AppError::new(format!(
            "Windows could not open {what} (code {})",
            result.0 as usize
        )))
    }
}

#[cfg(test)]
mod tests {
    use super::explorer_select_arg;

    #[test]
    fn explorer_selects_a_file_with_a_quoted_path() {
        assert_eq!(
            explorer_select_arg(r"C:\a b\c.txt", true),
            r#"/select,"C:\a b\c.txt""#
        );
    }

    #[test]
    fn explorer_opens_a_folder_with_a_quoted_path() {
        assert_eq!(explorer_select_arg(r"C:\a b", false), r#""C:\a b""#);
    }
}
