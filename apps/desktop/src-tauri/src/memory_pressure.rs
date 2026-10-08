//! Putting tabs to sleep when the system runs short of memory.
//!
//! The regular sweep waits an hour before it puts an unused tab to sleep.
//! That is the right pace on a machine with room to spare, and the wrong one
//! when the system is already compressing and swapping: macOS starts killing
//! the processes it can, and a renderer for a tab nobody has looked at in
//! twenty minutes is exactly what it picks, with nothing on screen to say why
//! the tab came back blank.
//!
//! macOS says when memory gets short through a dispatch source. A warning
//! runs the sweep with a five-minute idle time; a critical notice puts every
//! hidden tab to sleep that nothing protects -- the one on screen, one
//! playing sound or being recorded, a local dev server, an agent's tab --
//! whatever its tier. Sleeping tabs keep their place, their scroll and their
//! history, and wake when clicked.

#[cfg(target_os = "macos")]
use std::sync::atomic::{AtomicBool, Ordering};

use tauri::AppHandle;

use crate::Runtime;
#[cfg(any(target_os = "macos", test))]
use crate::housekeeping::Reach;

/// One pressure sweep at a time: the system repeats its notice while the
/// pressure lasts, and overlapping sweeps would only race each other.
#[cfg(target_os = "macos")]
static SWEEPING: AtomicBool = AtomicBool::new(false);

/// Run the sweep `reach` asks for, unless one is already going.
#[cfg(target_os = "macos")]
fn relieve(app: &AppHandle<Runtime>, reach: Reach) {
    if SWEEPING.swap(true, Ordering::AcqRel) {
        return;
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        match crate::housekeeping::sweep_with(&app, reach, usize::MAX).await {
            Ok(n) => tracing::warn!(?reach, n, "memory pressure: put tabs to sleep"),
            Err(error) => tracing::warn!(?reach, %error, "memory pressure sweep failed"),
        }
        SWEEPING.store(false, Ordering::Release);
    });
}

/// What the system's pressure level asks of the sweep, if anything.
#[cfg(any(target_os = "macos", test))]
fn reach_for(level: usize) -> Option<Reach> {
    if level & platform::CRITICAL != 0 {
        Some(Reach::Critical)
    } else if level & platform::WARN != 0 {
        Some(Reach::Warn)
    } else {
        None
    }
}

/// Start listening for the system's memory pressure notices.
pub fn watch(app: AppHandle<Runtime>) {
    platform::watch(app);
}

#[cfg(target_os = "macos")]
#[allow(unsafe_code)] // libdispatch's C API; the source and its context live for the process.
mod platform {
    use std::ffi::c_void;
    use std::sync::OnceLock;

    use tauri::AppHandle;

    use crate::Runtime;

    /// `DISPATCH_MEMORYPRESSURE_WARN`.
    pub(super) const WARN: usize = 0x2;
    /// `DISPATCH_MEMORYPRESSURE_CRITICAL`.
    pub(super) const CRITICAL: usize = 0x4;
    /// `DISPATCH_MEMORYPRESSURE_NORMAL`, listened for so the source reports
    /// the way back down as well; it asks nothing of the sweep.
    const NORMAL: usize = 0x1;
    /// `QOS_CLASS_UTILITY`: the notice is not urgent work for this process.
    const QOS_CLASS_UTILITY: isize = 0x11;

    #[repr(C)]
    struct DispatchSourceType {
        _private: [u8; 0],
    }
    type DispatchObject = *mut c_void;

    unsafe extern "C" {
        static _dispatch_source_type_memorypressure: DispatchSourceType;
        fn dispatch_get_global_queue(identifier: isize, flags: usize) -> DispatchObject;
        fn dispatch_source_create(
            kind: *const DispatchSourceType,
            handle: usize,
            mask: usize,
            queue: DispatchObject,
        ) -> DispatchObject;
        fn dispatch_source_set_event_handler_f(
            source: DispatchObject,
            handler: extern "C" fn(*mut c_void),
        );
        fn dispatch_set_context(object: DispatchObject, context: *mut c_void);
        fn dispatch_source_get_data(source: DispatchObject) -> usize;
        fn dispatch_resume(object: DispatchObject);
    }

    /// The app handle the notices are delivered to. Set once; the source is
    /// never cancelled, so it outlives nothing it points at.
    static APP: OnceLock<AppHandle<Runtime>> = OnceLock::new();
    /// The source, as an address: the handler reads its level from it.
    static SOURCE: OnceLock<usize> = OnceLock::new();

    extern "C" fn on_pressure(_context: *mut c_void) {
        let (Some(app), Some(source)) = (APP.get(), SOURCE.get()) else {
            return;
        };
        // SAFETY: the source was created below and is never released.
        let level = unsafe { dispatch_source_get_data(*source as DispatchObject) };
        tracing::info!(level, "memory pressure notice");
        if let Some(reach) = super::reach_for(level) {
            super::relieve(app, reach);
        }
    }

    pub(super) fn watch(app: AppHandle<Runtime>) {
        if APP.set(app).is_err() {
            return;
        }
        // SAFETY: documented libdispatch calls with a valid source type; the
        // queue is a global one and needs no retain; the handler touches only
        // the statics above.
        unsafe {
            let queue = dispatch_get_global_queue(QOS_CLASS_UTILITY, 0);
            let source = dispatch_source_create(
                &raw const _dispatch_source_type_memorypressure,
                0,
                NORMAL | WARN | CRITICAL,
                queue,
            );
            if source.is_null() {
                tracing::warn!("memory pressure notices unavailable");
                return;
            }
            let _ = SOURCE.set(source as usize);
            dispatch_set_context(source, std::ptr::null_mut());
            dispatch_source_set_event_handler_f(source, on_pressure);
            dispatch_resume(source);
        }
    }
}

#[cfg(not(target_os = "macos"))]
mod platform {
    use tauri::AppHandle;

    use crate::Runtime;

    #[cfg(test)]
    pub(super) const WARN: usize = 0x2;
    #[cfg(test)]
    pub(super) const CRITICAL: usize = 0x4;

    /// No system notice to listen to here; the regular sweep and the live
    /// view cap still apply.
    pub(super) fn watch(_app: AppHandle<Runtime>) {}
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_warning_sweeps_sooner_and_a_critical_notice_sweeps_everything_hidden() {
        assert_eq!(reach_for(platform::WARN), Some(Reach::Warn));
        assert_eq!(reach_for(platform::CRITICAL), Some(Reach::Critical));
        assert_eq!(
            reach_for(platform::WARN | platform::CRITICAL),
            Some(Reach::Critical)
        );
        assert_eq!(reach_for(0x1), None, "back to normal asks for nothing");
    }

    #[test]
    fn a_warning_reaches_today_tabs_idle_for_minutes_and_critical_any_tier() {
        assert_eq!(Reach::Warn.idle(), crate::housekeeping::WARN_IDLE);
        assert_eq!(Reach::Warn.scope(), dive_core::DiscardScope::Today);
        assert_eq!(Reach::Critical.idle(), time::Duration::ZERO);
        assert_eq!(Reach::Critical.scope(), dive_core::DiscardScope::AnyTier);
        assert_eq!(Reach::OverCap.scope(), dive_core::DiscardScope::Today);
    }
}
