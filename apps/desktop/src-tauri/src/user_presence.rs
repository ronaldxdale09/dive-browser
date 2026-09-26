//! Asking the OS whether the person at the keyboard is the owner, before a
//! saved password is shown, copied or exported.
//!
//! An unlocked, unattended Mac used to hand every saved password to whoever
//! opened Settings. On macOS the check is `LocalAuthentication`'s device-owner
//! policy: Touch ID, or the login password when there is no sensor. Once it
//! passes, the next minute of reveals goes through without asking again, the
//! way Chrome and Safari do it, so showing three passwords is one prompt.
//!
//! Windows has no check here yet: Windows Hello and the credential prompt
//! both need Windows crate features this build does not compile, so the
//! call passes through there and on Linux.
//!
//! Every call blocks until the person answers, so it must never run on the
//! main thread: the prompt is drawn by the system, and the reply arrives on a
//! `LocalAuthentication` queue while the calling thread waits.

use std::sync::Mutex;
use std::time::{Duration, Instant};

use crate::error::AppResult;

/// How long one successful check covers later reveals.
const GRACE: Duration = Duration::from_secs(60);

/// When the owner last proved they were here.
static LAST_CONFIRMED: Mutex<Option<Instant>> = Mutex::new(None);

fn within_grace(now: Instant) -> bool {
    LAST_CONFIRMED
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .is_some_and(|at| now.duration_since(at) < GRACE)
}

fn remember(now: Instant) {
    *LAST_CONFIRMED
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner) = Some(now);
}

/// Ask the OS to confirm the device owner is present, for `reason` -- a
/// phrase that finishes "Dive is trying to …", like "show a saved
/// password". `Ok(true)` when confirmed (or within the grace period),
/// `Ok(false)` when the person cancelled, and an error when the check
/// failed or could not run.
pub fn confirm(reason: &str) -> AppResult<bool> {
    if within_grace(Instant::now()) {
        return Ok(true);
    }
    let confirmed = platform::confirm(reason)?;
    if confirmed {
        remember(Instant::now());
    }
    Ok(confirmed)
}

/// [`confirm`] off the async runtime's threads, for async commands.
pub async fn confirm_async(reason: &'static str) -> AppResult<bool> {
    tauri::async_runtime::spawn_blocking(move || confirm(reason))
        .await
        .map_err(crate::error::AppError::new)?
}

#[cfg(target_os = "macos")]
#[allow(unsafe_code)] // LocalAuthentication is reachable only through the Objective-C runtime.
mod platform {
    use std::sync::mpsc;
    use std::time::Duration;

    use objc2::msg_send;
    use objc2::rc::Retained;
    use objc2::runtime::{AnyClass, AnyObject, Bool};
    use objc2_foundation::NSString;

    use crate::error::{AppError, AppResult};

    // LAContext lives in LocalAuthentication.framework, which nothing else
    // in the app links; naming it here makes the linker load it, so the
    // class lookup below finds it.
    #[link(name = "LocalAuthentication", kind = "framework")]
    unsafe extern "C" {}

    /// `LAPolicyDeviceOwnerAuthentication`: biometrics, or the login
    /// password when there is no sensor or it is not enrolled.
    const POLICY_DEVICE_OWNER: isize = 2;
    /// `LAError` codes this cares about.
    const USER_CANCEL: isize = -2;
    const SYSTEM_CANCEL: isize = -4;
    const PASSCODE_NOT_SET: isize = -5;
    const APP_CANCEL: isize = -9;
    /// How long to wait on an answer before giving up on the prompt.
    const ANSWER_TIMEOUT: Duration = Duration::from_secs(300);

    /// An `NSError*`'s code, or 0 for none.
    fn error_code(error: *mut AnyObject) -> isize {
        if error.is_null() {
            return 0;
        }
        // SAFETY: a non-null NSError handed back by LocalAuthentication,
        // alive for the autorelease pool or block call this runs in.
        unsafe { msg_send![&*error, code] }
    }

    /// A fresh `LAContext`, or `None` when the framework is missing.
    pub(super) fn new_context() -> Option<Retained<AnyObject>> {
        let class = AnyClass::get(c"LAContext")?;
        // SAFETY: `+[LAContext new]` returns a fresh, owned context.
        Some(unsafe { msg_send![class, new] })
    }

    /// Whether `context` can ask for the owner at all, or the `LAError` code
    /// that says why not. Shows nothing.
    pub(super) fn can_evaluate(context: &AnyObject) -> Result<(), isize> {
        objc2::rc::autoreleasepool(|_| {
            let mut error: *mut AnyObject = std::ptr::null_mut();
            // SAFETY: the documented selector with an NSInteger policy and an
            // `NSError **` out-parameter; the error is autoreleased into the
            // pool around this closure and read before the pool drains.
            let ok: Bool = unsafe {
                msg_send![context, canEvaluatePolicy: POLICY_DEVICE_OWNER, error: &mut error]
            };
            if ok.as_bool() {
                Ok(())
            } else {
                Err(error_code(error))
            }
        })
    }

    pub fn confirm(reason: &str) -> AppResult<bool> {
        let Some(context) = new_context() else {
            return Err(AppError::new(
                "this Mac cannot confirm it is you, so saved passwords stay hidden",
            ));
        };
        let can = can_evaluate(&context);
        match can {
            Ok(()) => {}
            // A Mac with no login password has nothing to check against,
            // and no one to keep out: the same as Chrome, it shows.
            Err(PASSCODE_NOT_SET) => return Ok(true),
            Err(code) => {
                return Err(AppError::new(format!(
                    "this Mac could not ask who you are (LocalAuthentication error {code})"
                )));
            }
        }

        let (tx, rx) = mpsc::channel::<Result<(), isize>>();
        // Called once, on a LocalAuthentication queue, when the person
        // answers or the prompt is dismissed.
        let reply = block2::RcBlock::new(move |success: Bool, error: *mut AnyObject| {
            let _ = tx.send(if success.as_bool() {
                Ok(())
            } else {
                Err(error_code(error))
            });
        });
        let reason = NSString::from_str(reason);
        // SAFETY: the documented selector; the context and block are kept
        // alive (and the block copied by the callee) until the reply arrives.
        unsafe {
            let _: () = msg_send![
                &context,
                evaluatePolicy: POLICY_DEVICE_OWNER,
                localizedReason: &*reason,
                reply: &*reply
            ];
        }
        let answer = rx.recv_timeout(ANSWER_TIMEOUT);
        if answer.is_err() {
            // SAFETY: `-[LAContext invalidate]` (macOS 10.11 and later)
            // takes no arguments; it dismisses a prompt still on screen.
            unsafe {
                let _: () = msg_send![&context, invalidate];
            }
        }
        match answer {
            Ok(Ok(())) => Ok(true),
            Ok(Err(USER_CANCEL | SYSTEM_CANCEL | APP_CANCEL)) | Err(_) => Ok(false),
            Ok(Err(_)) => Err(AppError::new("your Mac could not confirm it is you")),
        }
    }
}

#[cfg(not(target_os = "macos"))]
mod platform {
    use crate::error::AppResult;

    /// No owner check on this platform yet; see the module notes.
    #[allow(clippy::unnecessary_wraps)]
    pub fn confirm(_reason: &str) -> AppResult<bool> {
        Ok(true)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn one_check_covers_the_next_minute_only() {
        let start = Instant::now();
        remember(start);
        assert!(within_grace(start + Duration::from_secs(59)));
        assert!(!within_grace(start + GRACE));
    }

    /// The framework links and the policy query goes through the runtime
    /// with the argument types it expects, without putting up a prompt.
    #[cfg(target_os = "macos")]
    #[test]
    fn local_authentication_answers_without_prompting() {
        let context = platform::new_context().expect("LAContext is linked");
        // Either answer is fine; a wrong message signature would panic.
        let _ = platform::can_evaluate(&context);
    }
}
