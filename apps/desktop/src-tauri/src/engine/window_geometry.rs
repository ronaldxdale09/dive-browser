//! The main window's remembered frame, and which displays can reach it.

use std::sync::Mutex;

use tauri::{AppHandle, Manager, Window};

use crate::Runtime;
use crate::state::{AppState, lock};

/// Settings key holding the main window's last position and size.
pub const WINDOW_BOUNDS: &str = "window_bounds";

/// The main window's frame, remembered across launches.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct WindowBounds {
    /// Outer position, logical pixels.
    pub x: f64,
    /// Outer position, logical pixels.
    pub y: f64,
    /// Inner size, logical pixels.
    pub width: f64,
    /// Inner size, logical pixels.
    pub height: f64,
}

impl WindowBounds {
    /// Read the main window's `x,y,width,height`; anything malformed or
    /// smaller than the main window allows is ignored.
    pub fn parse(s: &str) -> Option<Self> {
        Self::parse_at_least(s, 720.0, 480.0)
    }

    /// Read an app window's frame. App windows may be much smaller than the
    /// main window -- a chat or a music player kept in a corner -- and
    /// holding them to the main window's minimum threw such a frame away,
    /// so the app came back at a default size every time.
    pub fn parse_app(s: &str) -> Option<Self> {
        Self::parse_at_least(s, POPOUT_MIN_WIDTH, POPOUT_MIN_HEIGHT)
    }

    fn parse_at_least(s: &str, min_width: f64, min_height: f64) -> Option<Self> {
        let mut it = s.split(',').map(|p| p.trim().parse::<f64>().ok());
        let (x, y, width, height) = (it.next()??, it.next()??, it.next()??, it.next()??);
        if !(x.is_finite() && y.is_finite() && width >= min_width && height >= min_height) {
            return None;
        }
        Some(Self {
            x,
            y,
            width,
            height,
        })
    }

    /// The form [`WindowBounds::parse`] reads.
    pub fn serialize(&self) -> String {
        format!("{},{},{},{}", self.x, self.y, self.width, self.height)
    }
}

/// The smallest frame a torn-off tab or app window may have.
pub(super) const POPOUT_MIN_WIDTH: f64 = 360.0;
/// See [`POPOUT_MIN_WIDTH`].
pub(super) const POPOUT_MIN_HEIGHT: f64 = 240.0;

/// One display's area in logical pixels.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ScreenArea {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

/// The displays connected now, in logical pixels. Each is scaled by its own
/// factor, which is how the platforms lay mixed displays out side by side.
pub(super) fn screen_areas(monitors: &[tauri::Monitor]) -> Vec<ScreenArea> {
    monitors
        .iter()
        .map(|m| {
            let scale = m.scale_factor();
            let at = m.position().to_logical::<f64>(scale);
            let size = m.size().to_logical::<f64>(scale);
            ScreenArea {
                x: at.x,
                y: at.y,
                width: size.width,
                height: size.height,
            }
        })
        .collect()
}

/// Where to put a window remembered at `bounds`, given the displays now
/// connected: its own position when enough of its top edge -- the part it
/// is dragged by -- is on one of them, otherwise `None` to centre it.
///
/// A position left of or above the primary display is ordinary with a second
/// display there, and clamping it to zero pulled such windows back onto the
/// wrong display; a remembered display that is no longer connected left the
/// window somewhere no one could reach it. With no display list to go by,
/// the remembered position is trusted.
pub fn visible_position(bounds: &WindowBounds, screens: &[ScreenArea]) -> Option<(f64, f64)> {
    const GRAB_WIDTH: f64 = 80.0;
    const GRAB_HEIGHT: f64 = 24.0;
    if screens.is_empty() {
        return Some((bounds.x, bounds.y));
    }
    let reachable = screens.iter().any(|s| {
        let left = bounds.x.max(s.x);
        let right = (bounds.x + bounds.width).min(s.x + s.width);
        let top = bounds.y.max(s.y);
        let bottom = (bounds.y + GRAB_HEIGHT).min(s.y + s.height);
        right - left >= GRAB_WIDTH && bottom - top >= GRAB_HEIGHT / 2.0
    });
    reachable.then_some((bounds.x, bounds.y))
}

/// Store the main window's frame at most every half second, for the bursts
/// of resize and move events a drag produces, and once more when the burst
/// ends: without that last write, the frame a drag ended on was kept only if
/// the window was then blurred, closed or quit -- a crash lost it.
pub fn remember_window_bounds_throttled(window: &Window<Runtime>) {
    const EVERY: std::time::Duration = std::time::Duration::from_millis(500);
    static LAST: Mutex<Option<std::time::Instant>> = Mutex::new(None);
    static TRAILING: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
    let now = std::time::Instant::now();
    {
        let mut last = crate::state::lock(&LAST);
        if last.is_some_and(|t| now.duration_since(t) < EVERY) {
            drop(last);
            if !TRAILING.swap(true, std::sync::atomic::Ordering::AcqRel) {
                let window = window.clone();
                tauri::async_runtime::spawn(async move {
                    tokio::time::sleep(EVERY).await;
                    TRAILING.store(false, std::sync::atomic::Ordering::Release);
                    *crate::state::lock(&LAST) = Some(std::time::Instant::now());
                    // Read the frame on the main thread, where the window's
                    // getters answer inline instead of waiting on it.
                    let on_main = window.clone();
                    let _ = window.run_on_main_thread(move || remember_window_bounds(&on_main));
                });
            }
            return;
        }
        *last = Some(now);
    }
    remember_window_bounds(window);
}

/// Store the main window's current frame so the next launch opens there.
/// A window's frame in logical pixels, or `None` while it is full screen or
/// minimized: neither is a frame to come back to.
pub fn windowed_bounds(window: &Window<Runtime>) -> Option<WindowBounds> {
    if window.is_fullscreen().unwrap_or(false) || window.is_minimized().unwrap_or(false) {
        return None;
    }
    let scale = window.scale_factor().unwrap_or(1.0);
    let (Ok(pos), Ok(size)) = (window.outer_position(), window.inner_size()) else {
        return None;
    };
    let pos = pos.to_logical::<f64>(scale);
    let size = size.to_logical::<f64>(scale);
    Some(WindowBounds {
        x: pos.x,
        y: pos.y,
        width: size.width,
        height: size.height,
    })
}

/// A full-screen frame is not one to come back to; the last windowed frame
/// stays on record instead.
pub fn remember_window_bounds(window: &Window<Runtime>) {
    static PENDING: Mutex<Option<(AppHandle<Runtime>, String)>> = Mutex::new(None);
    static RUNNING: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
    use std::sync::atomic::Ordering;
    let Some(bounds) = windowed_bounds(window) else {
        return;
    };
    // Even an uncontended Rust mutex can lead to SQLite's busy timeout. Keep
    // disk work off the window callback and coalesce drag bursts to one worker.
    *lock(&PENDING) = Some((window.app_handle().clone(), bounds.serialize()));
    if RUNNING.swap(true, Ordering::AcqRel) {
        return;
    }
    tauri::async_runtime::spawn_blocking(move || {
        loop {
            let next = {
                let mut pending = lock(&PENDING);
                let next = pending.take();
                if next.is_none() {
                    // Hold PENDING until the flag is reset so a racing producer
                    // either reaches this worker or starts the next one.
                    RUNNING.store(false, Ordering::Release);
                }
                next
            };
            let Some((app, bounds)) = next else { break };
            let state = app.state::<AppState>();
            if let Err(e) = lock(&state.store).set_setting(WINDOW_BOUNDS, &bounds) {
                tracing::debug!("could not remember window bounds: {e}");
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn window_bounds_round_trip_and_reject_tiny_frames() {
        let b = WindowBounds {
            x: 12.0,
            y: -3.5,
            width: 1280.0,
            height: 820.0,
        };
        assert_eq!(WindowBounds::parse(&b.serialize()), Some(b));
        assert_eq!(WindowBounds::parse("1,2,100,100"), None);
        // An app window may be smaller than the main window allows.
        assert_eq!(
            WindowBounds::parse_app("1,2,400,300").map(|b| b.width),
            Some(400.0)
        );
        assert_eq!(WindowBounds::parse_app("1,2,100,100"), None);
        assert_eq!(WindowBounds::parse("garbage"), None);
    }

    #[test]
    fn a_remembered_frame_is_kept_only_while_a_display_can_reach_it() {
        let primary = ScreenArea {
            x: 0.0,
            y: 0.0,
            width: 1440.0,
            height: 900.0,
        };
        // A second display to the left: negative x is on screen.
        let left = ScreenArea {
            x: -1920.0,
            y: -180.0,
            width: 1920.0,
            height: 1080.0,
        };
        let frame = |x, y| WindowBounds {
            x,
            y,
            width: 1000.0,
            height: 700.0,
        };
        assert_eq!(
            visible_position(&frame(-1500.0, 100.0), &[primary, left]),
            Some((-1500.0, 100.0))
        );
        // The same frame once that display is unplugged: centre it instead.
        assert_eq!(visible_position(&frame(-1500.0, 100.0), &[primary]), None);
        // Only a sliver of the title bar showing is not reachable.
        assert_eq!(visible_position(&frame(1420.0, 100.0), &[primary]), None);
        assert_eq!(visible_position(&frame(200.0, 950.0), &[primary]), None);
        assert_eq!(
            visible_position(&frame(200.0, 100.0), &[primary]),
            Some((200.0, 100.0))
        );
        // No display list at all: trust the frame.
        assert_eq!(
            visible_position(&frame(-5000.0, 0.0), &[]),
            Some((-5000.0, 0.0))
        );
    }
}
