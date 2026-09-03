//! Tier-1 screen recorder: Chromium screencast frames of one tab, encoded as
//! a GIF when the recording stops.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use base64::Engine as _;
use dive_cdp::CdpSession;
use dive_core::TabId;
use serde_json::json;

use crate::error::{AppError, AppResult};

/// Longest recording kept.
const MAX_SECONDS: f64 = 60.0;
/// Frame cap; at Chromium's paint rate this is a minute of a busy page.
const MAX_FRAMES: usize = 600;
/// Requested screencast size.
const MAX_WIDTH: u32 = 1280;
const MAX_HEIGHT: u32 = 800;
/// Output width; taller frames scale to keep the file small.
const GIF_WIDTH: u32 = 960;

struct Frame {
    /// Seconds, Chromium's monotonic clock.
    at: f64,
    jpeg: Vec<u8>,
}

struct Recording {
    frames: Mutex<Vec<Frame>>,
    stopped: AtomicBool,
    started: Instant,
    screencast_seen: AtomicBool,
}

impl Default for Recording {
    fn default() -> Self {
        Self {
            frames: Mutex::new(Vec::new()),
            stopped: AtomicBool::new(false),
            started: Instant::now(),
            screencast_seen: AtomicBool::new(false),
        }
    }
}

impl Recording {
    /// Add a frame and report whether the configured recording bounds have
    /// now been reached.
    fn push(&self, jpeg: Vec<u8>) -> bool {
        let at = self.started.elapsed().as_secs_f64();
        let mut frames = self
            .frames
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let full = frames.len() >= MAX_FRAMES || at > MAX_SECONDS;
        if !full {
            frames.push(Frame { at, jpeg });
        }
        full
    }
}

/// Recordings in progress, one per tab at most.
#[derive(Default)]
pub struct Registry {
    active: Mutex<HashMap<TabId, Arc<Recording>>>,
}

impl Registry {
    fn active(&self) -> std::sync::MutexGuard<'_, HashMap<TabId, Arc<Recording>>> {
        self.active
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    /// Start collecting frames for `tab`.
    pub async fn start(&self, tab: TabId, session: CdpSession) -> AppResult<()> {
        let rec = Arc::new(Recording::default());
        {
            let mut active = self.active();
            if active.contains_key(&tab) {
                return Err(AppError::new("already recording this tab"));
            }
            active.insert(tab, rec.clone());
        }
        // Subscribe before starting so the first frame is not missed.
        let mut events = session.subscribe();
        // A first explicit capture guarantees that even an immediately-stopped
        // or completely static page produces a useful one-frame GIF.
        let initial = capture_frame(&session).await;
        let captured_initial = initial.is_some();
        if let Some(jpeg) = initial {
            rec.push(jpeg);
        }
        let screencast = session
            .call(
                "Page.startScreencast",
                json!({"format": "jpeg", "quality": 60, "maxWidth": MAX_WIDTH, "maxHeight": MAX_HEIGHT, "everyNthFrame": 2}),
            )
            .await;
        if !captured_initial && let Err(error) = &screencast {
            self.active().remove(&tab);
            return Err(AppError::new(format!(
                "screen capture is unavailable: {error}"
            )));
        }
        if let Err(error) = screencast {
            tracing::debug!(%tab, %error, "screencast unavailable; using screenshot polling");
            tauri::async_runtime::spawn(poll_frames(rec, session));
        } else {
            let event_rec = rec.clone();
            let event_session = session.clone();
            tauri::async_runtime::spawn(async move {
                loop {
                    let event = match events.recv().await {
                        Ok(event) => event,
                        Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
                        Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
                    };
                    if event_rec.stopped.load(Ordering::Relaxed) {
                        break;
                    }
                    if event.method != "Page.screencastFrame" {
                        continue;
                    }
                    event_rec.screencast_seen.store(true, Ordering::Relaxed);
                    let p = &event.params;
                    // Chromium holds the next frame until this one is acknowledged.
                    let _ = event_session
                        .call(
                            "Page.screencastFrameAck",
                            json!({"sessionId": p["sessionId"]}),
                        )
                        .await;
                    let Some(data) = p["data"].as_str() else {
                        continue;
                    };
                    let Ok(jpeg) = base64::engine::general_purpose::STANDARD.decode(data) else {
                        continue;
                    };
                    if event_rec.stopped.load(Ordering::Relaxed) {
                        break;
                    }
                    if event_rec.push(jpeg) {
                        // Keep what we have; stop() still encodes it.
                        let _ = event_session.call0("Page.stopScreencast").await;
                        break;
                    }
                }
            });

            // Some CEF builds accept startScreencast but never emit its event.
            // Fall back after a short grace period so recording remains useful.
            tauri::async_runtime::spawn(async move {
                tokio::time::sleep(Duration::from_millis(750)).await;
                if rec.stopped.load(Ordering::Relaxed)
                    || rec.screencast_seen.load(Ordering::Relaxed)
                {
                    return;
                }
                tracing::debug!(%tab, "no screencast frames; using screenshot polling");
                let _ = session.call0("Page.stopScreencast").await;
                poll_frames(rec, session).await;
            });
        }
        Ok(())
    }

    /// Drop a recording without encoding it (the tab is going away).
    pub fn discard(&self, tab: TabId) {
        if let Some(rec) = self.active().remove(&tab) {
            rec.stopped.store(true, Ordering::Relaxed);
        }
    }

    /// Stop recording `tab` and encode the frames to a GIF; returns its path.
    pub async fn stop(&self, tab: TabId, session: &CdpSession) -> AppResult<std::path::PathBuf> {
        let rec = self
            .active()
            .remove(&tab)
            .ok_or_else(|| AppError::new("not recording this tab"))?;
        rec.stopped.store(true, Ordering::Relaxed);
        let _ = session.call0("Page.stopScreencast").await;
        let frames = std::mem::take(
            &mut *rec
                .frames
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner),
        );
        if frames.is_empty() {
            return Err(AppError::new("nothing was painted while recording"));
        }
        let dir = crate::commands::captures_dir()?;
        tauri::async_runtime::spawn_blocking(move || encode(&frames, &dir))
            .await
            .map_err(AppError::new)?
    }
}

/// Capture one viewport frame using a CDP method supported by CEF even when
/// the screencast event stream is not implemented.
async fn capture_frame(session: &CdpSession) -> Option<Vec<u8>> {
    let result = session
        .call(
            "Page.captureScreenshot",
            json!({
                "format": "jpeg",
                "quality": 60,
                "fromSurface": true,
                "captureBeyondViewport": false,
            }),
        )
        .await
        .ok()?;
    base64::engine::general_purpose::STANDARD
        .decode(result["data"].as_str()?)
        .ok()
}

/// Compatibility recorder used only when `Page.screencastFrame` is absent.
async fn poll_frames(rec: Arc<Recording>, session: CdpSession) {
    while !rec.stopped.load(Ordering::Relaxed) {
        if let Some(jpeg) = capture_frame(&session).await
            && (rec.stopped.load(Ordering::Relaxed) || rec.push(jpeg))
        {
            break;
        }
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
}

/// Encode frames as a looping GIF in `dir`, scaled to at most `GIF_WIDTH`.
// Every float here is rounded and clamped into range before the cast.
#[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
fn encode(frames: &[Frame], dir: &std::path::Path) -> AppResult<std::path::PathBuf> {
    let first = decode(&frames[0].jpeg)?;
    let width = GIF_WIDTH.min(first.width());
    let height =
        (u64::from(first.height()) * u64::from(width) / u64::from(first.width())).max(1) as u32;
    let (w16, h16) = (
        u16::try_from(width).map_err(AppError::new)?,
        u16::try_from(height).map_err(AppError::new)?,
    );

    let stamp = dive_core::Timestamp::now()
        .to_rfc3339()
        .replace([':', '.'], "-");
    let path = dir.join(format!("dive-{stamp}.gif"));
    let file = std::io::BufWriter::new(std::fs::File::create(&path)?);
    let mut encoder = gif::Encoder::new(file, w16, h16, &[]).map_err(AppError::new)?;
    encoder
        .set_repeat(gif::Repeat::Infinite)
        .map_err(AppError::new)?;

    for (i, frame) in frames.iter().enumerate() {
        let img = decode(&frame.jpeg)?
            .resize_exact(width, height, image::imageops::FilterType::Triangle)
            .to_rgba8();
        let next_at = frames.get(i + 1).map_or(frame.at + 0.5, |n| n.at);
        let mut out = gif::Frame::from_rgba_speed(w16, h16, &mut img.into_raw(), 10);
        // Centiseconds; clamp so a static page still animates and a stall
        // doesn't freeze the loop for minutes.
        out.delay = ((next_at - frame.at) * 100.0).round().clamp(2.0, 500.0) as u16;
        encoder.write_frame(&out).map_err(AppError::new)?;
    }
    drop(encoder);
    Ok(path)
}

fn decode(jpeg: &[u8]) -> AppResult<image::DynamicImage> {
    image::load_from_memory_with_format(jpeg, image::ImageFormat::Jpeg).map_err(AppError::new)
}
