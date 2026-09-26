//! Putting a secret -- a saved password -- on the clipboard without leaving
//! it there.
//!
//! Copied as ordinary text, a password sat on the clipboard until something
//! else replaced it, and clipboard managers kept it in their history for
//! good. Here it is marked so those managers skip it (the nspasteboard.org
//! concealed and transient types on macOS, the history and cloud-sync
//! exclusions on Windows, the password-manager hint on Linux), and taken off
//! again after [`CLEAR_AFTER`] unless something else was copied since.

use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use crate::error::{AppError, AppResult};

/// How long a copied secret stays on the clipboard.
pub const CLEAR_AFTER: Duration = Duration::from_secs(30);

/// Bumped by every secret copy, so only the newest one's timer clears.
static GENERATION: AtomicU64 = AtomicU64::new(0);

/// Put `secret` on the clipboard, concealed, and clear it after
/// [`CLEAR_AFTER`] if it is still what the clipboard holds. Blocks on the
/// pasteboard briefly, so call it off the main thread.
pub fn write(secret: &str) -> AppResult<()> {
    let mut clipboard = arboard::Clipboard::new().map_err(AppError::new)?;
    concealed_set(&mut clipboard, secret)?;
    let generation = GENERATION.fetch_add(1, Ordering::SeqCst) + 1;
    let stamp = platform::change_stamp();
    let secret = secret.to_owned();
    std::thread::Builder::new()
        .name("dive-clipboard-clear".into())
        .spawn(move || {
            std::thread::sleep(CLEAR_AFTER);
            if GENERATION.load(Ordering::SeqCst) != generation {
                return;
            }
            let Ok(mut clipboard) = arboard::Clipboard::new() else {
                return;
            };
            if still_ours(&mut clipboard, stamp, &secret) {
                let _ = clipboard.clear();
            }
        })
        .map_err(AppError::new)?;
    Ok(())
}

/// Whether the clipboard still holds the secret this module put there, and
/// not something the person copied since. The pasteboard's change count says
/// so where there is one; elsewhere the text itself is compared.
fn still_ours(clipboard: &mut arboard::Clipboard, stamp: Option<i64>, secret: &str) -> bool {
    match (stamp, platform::change_stamp()) {
        (Some(then), Some(now)) => then == now,
        _ => clipboard.get_text().is_ok_and(|text| text == secret),
    }
}

#[cfg(target_os = "macos")]
fn concealed_set(clipboard: &mut arboard::Clipboard, secret: &str) -> AppResult<()> {
    use arboard::SetExtApple as _;
    clipboard
        .set()
        .exclude_from_history()
        .text(secret)
        .map_err(AppError::new)?;
    platform::mark_transient();
    Ok(())
}

#[cfg(windows)]
fn concealed_set(clipboard: &mut arboard::Clipboard, secret: &str) -> AppResult<()> {
    use arboard::SetExtWindows as _;
    clipboard
        .set()
        .exclude_from_history()
        .exclude_from_cloud()
        .text(secret)
        .map_err(AppError::new)
}

#[cfg(all(unix, not(target_os = "macos")))]
fn concealed_set(clipboard: &mut arboard::Clipboard, secret: &str) -> AppResult<()> {
    use arboard::SetExtLinux as _;
    clipboard
        .set()
        .exclude_from_history()
        .text(secret)
        .map_err(AppError::new)
}

#[cfg(target_os = "macos")]
#[allow(unsafe_code)] // NSPasteboard's change count and extra types are reachable only through the Objective-C runtime.
mod platform {
    use objc2::msg_send;
    use objc2::rc::Retained;
    use objc2::runtime::{AnyClass, AnyObject, Bool};
    use objc2_foundation::NSString;

    fn general_pasteboard() -> Option<Retained<AnyObject>> {
        let class = AnyClass::get(c"NSPasteboard")?;
        // SAFETY: `+[NSPasteboard generalPasteboard]` takes no arguments and
        // returns the shared pasteboard, retained here for the call.
        unsafe { msg_send![class, generalPasteboard] }
    }

    /// The pasteboard's change count, which moves whenever anyone writes
    /// to it.
    pub fn change_stamp() -> Option<i64> {
        // The pool catches anything autoreleased on this worker thread,
        // which has none of its own.
        objc2::rc::autoreleasepool(|_| {
            let pasteboard = general_pasteboard()?;
            // SAFETY: `-changeCount` takes no arguments and returns an
            // NSInteger.
            let count: isize = unsafe { msg_send![&pasteboard, changeCount] };
            Some(count as i64)
        })
    }

    /// Add the transient marker next to arboard's concealed one: managers
    /// that honour it do not record the item at all.
    pub fn mark_transient() {
        objc2::rc::autoreleasepool(|_| {
            let Some(pasteboard) = general_pasteboard() else {
                return;
            };
            let empty = NSString::from_str("");
            let kind = NSString::from_str("org.nspasteboard.TransientType");
            // SAFETY: `-setString:forType:` with two NSStrings, on the item
            // the copy just wrote; it returns whether the type was added.
            let _: Bool = unsafe { msg_send![&pasteboard, setString: &*empty, forType: &*kind] };
        });
    }
}

#[cfg(not(target_os = "macos"))]
mod platform {
    /// No change count to read here; the text is compared instead.
    pub fn change_stamp() -> Option<i64> {
        None
    }
}

#[cfg(test)]
mod tests {
    /// The pasteboard query goes through the runtime with the types it
    /// expects. Reading the change count leaves the clipboard alone.
    #[cfg(target_os = "macos")]
    #[test]
    fn the_pasteboard_change_count_reads() {
        assert!(super::platform::change_stamp().is_some());
    }
}
