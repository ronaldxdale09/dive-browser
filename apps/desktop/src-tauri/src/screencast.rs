//! Screen recorder: Chromium screencast frames of one tab, written to disk as
//! they arrive, then encoded when the recording stops: an MP4 through ffmpeg
//! (with a microphone track when asked for), or a GIF when ffmpeg is absent
//! or the person wanted one.
//!
//! The page is a native view, so what is captured is exactly what the page
//! paints: Dive's own chrome and the pointer are not in the picture.

use std::collections::HashMap;
use std::fmt::Write as _;
use std::fs::File;
use std::io::Write as _;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Output, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use base64::Engine as _;
use dive_cdp::CdpSession;
use dive_core::TabId;
use serde::{Deserialize, Serialize};
use serde_json::json;
use specta::Type;
use tauri::AppHandle;
use tauri_specta::Event;

use crate::Runtime;
use crate::error::{AppError, AppResult};

/// Output width of a GIF; wider frames scale down to keep the file small.
const GIF_WIDTH: u32 = 960;
/// Longest a GIF may run: past this the file is tens of megabytes.
const GIF_MAX_SECONDS: u32 = 60;
/// Longest a video may run.
const VIDEO_MAX_SECONDS: u32 = 600;

/// What the person asked for in the recording dialog.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct RecordOptions {
    /// `mp4` or `gif`.
    pub format: String,
    /// Frames per second of the encoded video.
    pub fps: u32,
    /// Widest the captured frames may be, in CSS pixels.
    pub max_width: u32,
    /// Microphone to record alongside, by capture-device id; `None` for none.
    pub microphone: Option<String>,
    /// `page` (the tab's own paint, through `DevTools`) or `window` (Dive's
    /// window as it appears on screen, pointer included, through native
    /// screen capture).
    #[serde(default = "default_source")]
    pub source: String,
}

fn default_source() -> String {
    "page".into()
}

impl Default for RecordOptions {
    fn default() -> Self {
        Self {
            format: "gif".into(),
            fps: 15,
            max_width: 1280,
            microphone: None,
            source: default_source(),
        }
    }
}

/// Where Dive's window sits on its display, for cropping a screen capture.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct WindowRect {
    /// Physical pixels from the display's top-left.
    pub x: u32,
    pub y: u32,
    pub width: u32,
    pub height: u32,
    /// Which display, as an index into the displays ffmpeg can capture.
    pub screen: usize,
}

impl RecordOptions {
    fn is_gif(&self) -> bool {
        self.format.eq_ignore_ascii_case("gif")
    }

    fn is_window(&self) -> bool {
        self.source.eq_ignore_ascii_case("window")
    }

    fn max_seconds(&self) -> u32 {
        if self.is_gif() {
            GIF_MAX_SECONDS
        } else {
            VIDEO_MAX_SECONDS
        }
    }

    fn fps(&self) -> u32 {
        self.fps.clamp(5, 60)
    }
}

/// The finished file.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct RecordingResult {
    /// Where it was written.
    pub path: String,
    /// Length in seconds, pauses excluded.
    pub duration_secs: f64,
    /// Size on disk. A float because the bindings cannot carry a u64.
    pub bytes: f64,
    /// Pixel size of the encoded picture.
    pub width: u32,
    /// Pixel size of the encoded picture.
    pub height: u32,
    /// `mp4` or `gif`.
    pub format: String,
    /// Frames captured.
    pub frames: u32,
    /// Whether a microphone track is in the file.
    pub has_audio: bool,
    /// Pointer positions and clicks over the recording, for the editor's
    /// cursor and zoom effects. A JSON sidecar; `None` when nothing was
    /// tracked (window captures carry the pointer in the picture already).
    pub events: Option<String>,
    /// A small `WebM` the chrome can play, beside the MP4: the embedded
    /// Chromium ships without H.264, so the file itself cannot be previewed.
    /// `None` for a GIF, which previews as is.
    pub preview: Option<String>,
}

/// Where preview companions live, hidden inside the captures directory.
pub const PREVIEW_DIR: &str = ".previews";

/// The page-side binding that reports pointer movement while recording.
const TRACK_BINDING: &str = "__diveRecordTrack";

/// The script that feeds the binding: pointer positions (throttled) and
/// clicks, in viewport CSS pixels, with the page's own clock.
const TRACK_SCRIPT: &str = r"(() => {
  if (window.__diveRecordTrackOn) return; window.__diveRecordTrackOn = true;
  const send = (o) => { try { window.__diveRecordTrack(JSON.stringify(o)); } catch (e) {} };
  let last = 0;
  addEventListener('pointermove', (e) => { const t = performance.now(); if (t - last < 16) return; last = t; send({k:'m', t, x:e.clientX, y:e.clientY}); }, {capture:true, passive:true});
  addEventListener('pointerdown', (e) => send({k:'c', t: performance.now(), x:e.clientX, y:e.clientY, b:e.button}), {capture:true, passive:true});
  addEventListener('keydown', (e) => send({k:'k', t: performance.now()}), {capture:true, passive:true});
  addEventListener('scroll', () => send({k:'s', t: performance.now(), x: scrollX, y: scrollY}), {capture:true, passive:true});
  send({k:'v', t: performance.now(), w: innerWidth, h: innerHeight, dpr: devicePixelRatio});
})();";

/// One tracked pointer event, on the recording's media clock.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct TrackedEvent {
    /// `m` move, `c` click, `k` key, `s` scroll, `v` viewport.
    pub k: String,
    /// Seconds of media time.
    pub t: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub x: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub y: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub w: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub h: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dpr: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub b: Option<i32>,
}

/// The sidecar written beside a recording.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct RecordingEvents {
    /// Viewport size in CSS pixels when tracking began.
    pub viewport: (f64, f64),
    /// Device pixel ratio of the page, to map CSS pixels onto the picture.
    pub dpr: f64,
    pub events: Vec<TrackedEvent>,
}

/// A microphone ffmpeg can capture from.
#[derive(Debug, Clone, Serialize, Deserialize, Type, PartialEq, Eq)]
pub struct Microphone {
    /// Capture-device id, as ffmpeg wants it.
    pub id: String,
    /// What the system calls it.
    pub name: String,
}

/// What this machine can do, so the dialog offers only what will work.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct RecordingCapabilities {
    /// ffmpeg was found; without it only GIF is possible.
    pub ffmpeg: bool,
    /// Microphones, when ffmpeg can list them.
    pub microphones: Vec<Microphone>,
    /// Length cap of a video, seconds.
    pub video_max_seconds: u32,
    /// Length cap of a GIF, seconds.
    pub gif_max_seconds: u32,
}

/// Something the chrome should react to while a recording runs.
#[derive(Debug, Clone, Serialize, Deserialize, Type, Event)]
pub struct RecordingEvent {
    /// The tab being recorded.
    pub tab: TabId,
    /// `limit` when the length cap was reached and no more frames are kept.
    pub kind: String,
}

/// One captured frame: when it was painted, and which file holds it.
struct Frame {
    /// Seconds of media time (pauses excluded).
    at: f64,
    path: PathBuf,
}

/// A capture process (microphone, or the whole screen) per stretch between
/// pauses; the stretches are joined when the recording stops.
#[derive(Default)]
struct Audio {
    /// Finished segments, in order.
    segments: Vec<PathBuf>,
    /// The process writing the current segment.
    child: Option<(Child, PathBuf)>,
    failed: bool,
}

struct Recording {
    dir: PathBuf,
    options: RecordOptions,
    /// File name without extension: "example.com recording 2026-09-08 04.03.23".
    stem: String,
    frames: Mutex<Vec<Frame>>,
    stopped: AtomicBool,
    paused: AtomicBool,
    limit_hit: AtomicBool,
    started: Instant,
    /// Total time spent paused, and when the current pause began.
    pauses: Mutex<(Duration, Option<Instant>)>,
    audio: Mutex<Audio>,
    /// Pointer and click events from the page, on the media clock.
    tracked: Mutex<Vec<TrackedEvent>>,
    /// Screen-capture stretches, when recording the whole window.
    screen: Mutex<Audio>,
    window: Option<WindowRect>,
    screencast_seen: AtomicBool,
    app: AppHandle<Runtime>,
    tab: TabId,
}

impl Recording {
    fn new(
        app: AppHandle<Runtime>,
        tab: TabId,
        options: RecordOptions,
        window: Option<WindowRect>,
        page_url: &str,
    ) -> AppResult<Self> {
        let now = dive_core::Timestamp::now();
        let stamp = now.to_rfc3339().replace([':', '.'], "-");
        let dir = crate::commands::captures_dir()?.join(format!(".recording-{stamp}"));
        std::fs::create_dir_all(&dir)?;
        Ok(Self {
            dir,
            options,
            stem: crate::commands::capture_stem(page_url, "recording", now),
            frames: Mutex::new(Vec::new()),
            stopped: AtomicBool::new(false),
            paused: AtomicBool::new(false),
            limit_hit: AtomicBool::new(false),
            started: Instant::now(),
            pauses: Mutex::new((Duration::ZERO, None)),
            audio: Mutex::new(Audio::default()),
            tracked: Mutex::new(Vec::new()),
            screen: Mutex::new(Audio::default()),
            window,
            screencast_seen: AtomicBool::new(false),
            app,
            tab,
        })
    }

    /// Seconds of media time so far: wall time minus pauses.
    fn media_time(&self) -> f64 {
        let (total, since) = *lock(&self.pauses);
        let paused = total + since.map_or(Duration::ZERO, |s| s.elapsed());
        self.started.elapsed().saturating_sub(paused).as_secs_f64()
    }

    fn done(&self) -> bool {
        self.stopped.load(Ordering::Relaxed) || self.limit_hit.load(Ordering::Relaxed)
    }

    /// Keep a frame unless paused; returns whether the length cap was hit.
    fn push(&self, jpeg: &[u8]) -> bool {
        if self.paused.load(Ordering::Relaxed) || self.done() {
            return self.limit_hit.load(Ordering::Relaxed);
        }
        let at = self.media_time();
        if at > f64::from(self.options.max_seconds()) {
            if !self.limit_hit.swap(true, Ordering::Relaxed) {
                let _ = RecordingEvent {
                    tab: self.tab,
                    kind: "limit".into(),
                }
                .emit(&self.app);
            }
            return true;
        }
        let mut frames = lock(&self.frames);
        // stop() drains this vector under the same mutex. Recheck after
        // acquiring it so a frame cannot be written into a removed work dir.
        if self.paused.load(Ordering::Relaxed) || self.done() {
            return self.limit_hit.load(Ordering::Relaxed);
        }
        let path = self.dir.join(format!("f{:06}.jpg", frames.len()));
        if let Err(e) = std::fs::write(&path, jpeg) {
            tracing::warn!("could not keep a frame: {e}");
            return false;
        }
        frames.push(Frame { at, path });
        false
    }

    fn set_paused(&self, paused: bool) {
        if self.paused.swap(paused, Ordering::Relaxed) == paused {
            return;
        }
        {
            let mut p = lock(&self.pauses);
            if paused {
                p.1 = Some(Instant::now());
            } else if let Some(since) = p.1.take() {
                p.0 += since.elapsed();
            }
        }
        if self.options.is_window() {
            if paused {
                self.stop_screen_segment();
            } else if let Err(e) = self.start_screen_segment() {
                tracing::warn!("screen capture did not resume: {e}");
            }
        } else if paused {
            self.stop_audio_segment();
        } else {
            self.start_audio_segment();
        }
    }

    /// Begin a stretch of screen capture of the window; the microphone, if
    /// any, is captured by the same process so it stays in sync.
    fn start_screen_segment(&self) -> AppResult<()> {
        let Some(rect) = self.window else {
            return Err(AppError::new("the window's position is unknown"));
        };
        let mut screen = lock(&self.screen);
        if screen.child.is_some() {
            return Ok(());
        }
        let path = self.dir.join(format!("s{:03}.mp4", screen.segments.len()));
        let child = spawn_screen(
            rect,
            self.options.microphone.as_deref(),
            self.options.fps(),
            &path,
        )?;
        screen.child = Some((child, path));
        Ok(())
    }

    /// Finish the current screen-capture stretch and keep its file.
    fn stop_screen_segment(&self) {
        let mut screen = lock(&self.screen);
        if let Some((child, path)) = screen.child.take() {
            quit(child);
            if path.exists() {
                screen.segments.push(path);
            }
        }
    }

    /// Begin a microphone segment, if a microphone was asked for.
    fn start_audio_segment(&self) {
        let Some(mic) = self.options.microphone.as_deref() else {
            return;
        };
        let mut audio = lock(&self.audio);
        if audio.child.is_some() || audio.failed {
            return;
        }
        let path = self.dir.join(format!("a{:03}.wav", audio.segments.len()));
        match spawn_mic(mic, &path) {
            Ok(child) => audio.child = Some((child, path)),
            Err(e) => {
                tracing::warn!("microphone capture failed to start: {e}");
                audio.failed = true;
            }
        }
    }

    /// Ask the current microphone process to finish and keep its file.
    fn stop_audio_segment(&self) {
        let mut audio = lock(&self.audio);
        if let Some((child, path)) = audio.child.take() {
            quit(child);
            if path.exists() {
                audio.segments.push(path);
            }
        }
    }

    fn remove_dir(&self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

/// Tell an ffmpeg process to finish and wait for it. It finalises its file
/// on 'q'; a stuck process is killed so a stop never hangs on it.
fn quit(mut child: Child) {
    if let Some(mut stdin) = child.stdin.take() {
        let _ = stdin.write_all(b"q\n");
    }
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if Instant::now() < deadline => {
                std::thread::sleep(Duration::from_millis(50));
            }
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                break;
            }
        }
    }
}

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
}

/// Recordings in progress, one per tab at most.
#[derive(Default)]
pub struct Registry {
    active: Mutex<HashMap<TabId, Arc<Recording>>>,
}

impl Registry {
    fn active(&self) -> std::sync::MutexGuard<'_, HashMap<TabId, Arc<Recording>>> {
        lock(&self.active)
    }

    /// Whether `tab` is being recorded right now.
    pub fn is_recording(&self, tab: TabId) -> bool {
        self.active().contains_key(&tab)
    }

    /// Start collecting frames for `tab`.
    #[allow(clippy::too_many_lines)] // One function owns the whole capture lifecycle.
    pub async fn start(
        &self,
        app: AppHandle<Runtime>,
        tab: TabId,
        session: CdpSession,
        options: RecordOptions,
        window: Option<WindowRect>,
        page_url: &str,
    ) -> AppResult<()> {
        if (!options.is_gif() || options.is_window()) && ffmpeg_path().is_none() {
            return Err(AppError::new(
                "this needs ffmpeg, which was not found; a GIF of the page works without it",
            ));
        }
        if options.is_window() && window.is_none() {
            return Err(AppError::new("the window could not be located on screen"));
        }
        let rec = Arc::new(Recording::new(app, tab, options, window, page_url)?);
        {
            let mut active = self.active();
            if active.contains_key(&tab) {
                return Err(AppError::new("already recording this tab"));
            }
            active.insert(tab, rec.clone());
        }
        if rec.options.is_window() {
            // Native capture of the window: no DevTools frames at all. A
            // capture that dies at once is almost always a missing Screen
            // Recording permission, so say that rather than "nothing painted".
            if let Err(e) = rec.start_screen_segment() {
                self.active().remove(&tab);
                rec.remove_dir();
                return Err(e);
            }
            tokio::time::sleep(Duration::from_millis(900)).await;
            let died = {
                let mut screen = lock(&rec.screen);
                match screen.child.as_mut() {
                    Some((child, _)) => child.try_wait().ok().flatten().is_some(),
                    None => true,
                }
            };
            if died {
                self.active().remove(&tab);
                rec.remove_dir();
                return Err(AppError::new(
                    "screen capture stopped at once. Allow Dive under System Settings › Privacy & Security › Screen Recording, then try again",
                ));
            }
            return Ok(());
        }
        // Subscribe before starting so the first frame is not missed.
        let mut events = session.subscribe();
        // A first explicit capture guarantees that even an immediately-stopped
        // or completely static page produces a useful one-frame file.
        let initial = capture_frame(&session).await;
        let captured_initial = initial.is_some();
        if let Some(jpeg) = initial {
            rec.push(&jpeg);
        }
        let every_nth = if rec.options.fps() >= 30 { 1 } else { 2 };
        let max_width = rec.options.max_width.clamp(320, 3840);
        let screencast = session
            .call(
                "Page.startScreencast",
                json!({
                    "format": "jpeg",
                    "quality": 75,
                    "maxWidth": max_width,
                    "maxHeight": max_width * 10 / 16 * 2,
                    "everyNthFrame": every_nth,
                }),
            )
            .await;
        if !captured_initial && let Err(error) = &screencast {
            self.active().remove(&tab);
            rec.remove_dir();
            return Err(AppError::new(format!(
                "screen capture is unavailable: {error}"
            )));
        }
        rec.start_audio_segment();
        // Pointer tracking: a binding the page calls, installed now and on
        // every navigation while the recording runs.
        // Subscribed before the script runs: its first message (the viewport)
        // arrives at once. `bindingCalled` only fires while Runtime is on.
        let mut track_events = session.subscribe();
        let _ = session.call0("Runtime.enable").await;
        let _ = session
            .call("Runtime.addBinding", json!({"name": TRACK_BINDING}))
            .await;
        let _ = session
            .call(
                "Page.addScriptToEvaluateOnNewDocument",
                json!({"source": TRACK_SCRIPT}),
            )
            .await;
        let _ = session
            .call("Runtime.evaluate", json!({"expression": TRACK_SCRIPT}))
            .await;
        {
            let track_rec = rec.clone();
            tauri::async_runtime::spawn(async move {
                loop {
                    let event = match track_events.recv().await {
                        Ok(event) => event,
                        Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
                        Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
                    };
                    if track_rec.stopped.load(Ordering::Relaxed) {
                        break;
                    }
                    if event.method != "Runtime.bindingCalled"
                        || event.params["name"] != TRACK_BINDING
                    {
                        continue;
                    }
                    let Some(payload) = event.params["payload"].as_str() else {
                        continue;
                    };
                    if let Ok(mut e) = serde_json::from_str::<TrackedEvent>(payload) {
                        if track_rec.paused.load(Ordering::Relaxed) {
                            continue;
                        }
                        // Stamp with the recording's clock; the page's own is
                        // only used for throttling.
                        e.t = track_rec.media_time();
                        let mut tracked = lock(&track_rec.tracked);
                        if tracked.len() < 200_000 {
                            tracked.push(e);
                        }
                    }
                }
            });
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
                    if event_rec.push(&jpeg) {
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

    /// Pause or resume: frames and microphone stop while paused, and the
    /// media clock with them.
    pub fn set_paused(&self, tab: TabId, paused: bool) -> AppResult<()> {
        let rec = self
            .active()
            .get(&tab)
            .cloned()
            .ok_or_else(|| AppError::new("not recording this tab"))?;
        rec.set_paused(paused);
        Ok(())
    }

    /// Drop a recording without encoding it (cancelled, or the tab is going away).
    pub fn discard(&self, tab: TabId) {
        if let Some(rec) = self.active().remove(&tab) {
            rec.stopped.store(true, Ordering::Relaxed);
            rec.stop_audio_segment();
            rec.stop_screen_segment();
            rec.remove_dir();
        }
    }

    /// Stop recording `tab` and encode what was captured; returns the file.
    pub async fn stop(&self, tab: TabId, session: &CdpSession) -> AppResult<RecordingResult> {
        let rec = self
            .active()
            .remove(&tab)
            .ok_or_else(|| AppError::new("not recording this tab"))?;
        rec.stopped.store(true, Ordering::Relaxed);
        let _ = session.call0("Page.stopScreencast").await;
        let duration = rec.media_time();
        let encoded = tauri::async_runtime::spawn_blocking(move || {
            rec.stop_audio_segment();
            if rec.options.is_window() {
                rec.stop_screen_segment();
                let segments = std::mem::take(&mut lock(&rec.screen).segments);
                let dir = crate::commands::captures_dir();
                let result = dir.and_then(|dir| {
                    finish_window(&segments, &rec.options, &dir, duration, &rec.stem)
                });
                rec.remove_dir();
                return result;
            }
            let frames = std::mem::take(&mut *lock(&rec.frames));
            let result = if frames.is_empty() {
                Err(AppError::new("nothing was painted while recording"))
            } else {
                let audio = std::mem::take(&mut lock(&rec.audio).segments);
                let dir = crate::commands::captures_dir()?;
                let end = duration.max(frames.last().map_or(0.0, |f| f.at) + 0.1);
                let encoded = if rec.options.is_gif() {
                    match ffmpeg_path() {
                        Some(_) => encode_gif_ffmpeg(&frames, &dir, end, &rec.stem),
                        None => encode_gif(&frames, &dir, end, &rec.stem),
                    }
                } else {
                    encode_video(&frames, &audio, &rec.options, &dir, end, &rec.stem)
                };
                encoded.map(|mut r| {
                    let tracked = std::mem::take(&mut *lock(&rec.tracked));
                    r.events = write_events(&dir, &r.path, tracked);
                    r
                })
            };
            rec.remove_dir();
            result
        })
        .await
        .map_err(AppError::new)??;
        Ok(encoded)
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
                "quality": 75,
                "fromSurface": true,
                "captureBeyondViewport": false,
                "optimizeForSpeed": true,
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
    let mut ticker = tokio::time::interval(poll_period(rec.options.fps()));
    // captureScreenshot is serialized by CDP. If one capture takes longer
    // than a frame slot, resume at the next current slot rather than adding a
    // second fixed sleep and compounding the slowdown.
    ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    while !rec.stopped.load(Ordering::Relaxed) {
        ticker.tick().await;
        if rec.stopped.load(Ordering::Relaxed) {
            break;
        }
        if let Some(jpeg) = capture_frame(&session).await
            && (rec.stopped.load(Ordering::Relaxed) || rec.push(&jpeg))
        {
            break;
        }
    }
}

fn poll_period(fps: u32) -> Duration {
    Duration::from_secs_f64(1.0 / f64::from(fps.clamp(5, 60)))
}

/// Where ffmpeg is, if anywhere on this machine.
pub fn ffmpeg_path() -> Option<PathBuf> {
    tool_path("ffmpeg")
}

/// Where ffprobe is: the same places as ffmpeg, since they ship together.
pub fn ffprobe_path() -> Option<PathBuf> {
    tool_path("ffprobe")
}

/// The usual install locations first, then whatever `PATH` says.
fn tool_path(name: &str) -> Option<PathBuf> {
    let candidates = ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"];
    for c in candidates {
        let p = Path::new(c).join(name);
        if p.is_file() {
            return Some(p);
        }
    }
    let path = std::env::var_os("PATH")?;
    std::env::split_paths(&path)
        .map(|d| d.join(name))
        .find(|p| p.is_file())
}

/// Most a subprocess may print on either stream before it is stopped.
pub(crate) const OUTPUT_LIMIT: u64 = 256 * 1024;
/// How long one ffmpeg or ffprobe run may take outside an export job.
pub(crate) const PROCESS_LIMIT: Duration = Duration::from_mins(30);
/// ffprobe only reads headers; anything longer is a stuck disk or file.
pub(crate) const PROBE_LIMIT: Duration = Duration::from_secs(120);

/// Run `command` to completion with a deadline and output caps, killing and
/// reaping it when it overruns. Output is capped at [`OUTPUT_LIMIT`].
pub(crate) fn run_with_deadline(command: &mut Command, timeout: Duration) -> AppResult<Output> {
    let name = program_name(command);
    let mut stdout = tempfile::tempfile()?;
    let mut stderr = tempfile::tempfile()?;
    let mut child = command
        .stdin(Stdio::null())
        .stdout(stdout.try_clone()?)
        .stderr(stderr.try_clone()?)
        .spawn()?;
    let result = wait_with_deadline(
        &mut child,
        &mut stdout,
        &mut stderr,
        Instant::now() + timeout,
        &name,
        || Ok(()),
    );
    if result.is_err() {
        stop_child(&mut child)?;
    }
    result
}

/// The program's file name, for messages.
pub(crate) fn program_name(command: &Command) -> String {
    Path::new(command.get_program())
        .file_name()
        .map_or_else(|| "subprocess".into(), |n| n.to_string_lossy().into_owned())
}

/// Poll `child` (named `name` in messages) until it exits, `interrupt`
/// fails, the deadline passes, or either output stream outgrows
/// [`OUTPUT_LIMIT`]. The child is left running on error so the caller can
/// stop it the way it owns it.
pub(crate) fn wait_with_deadline(
    child: &mut Child,
    stdout: &mut File,
    stderr: &mut File,
    deadline: Instant,
    name: &str,
    mut interrupt: impl FnMut() -> AppResult<()>,
) -> AppResult<Output> {
    use std::io::{Read as _, Seek as _};
    let status = loop {
        interrupt()?;
        if Instant::now() >= deadline {
            return Err(AppError::new(format!("{name} timed out")));
        }
        if stdout.metadata()?.len() > OUTPUT_LIMIT || stderr.metadata()?.len() > OUTPUT_LIMIT {
            return Err(AppError::new(format!("{name} output exceeded limit")));
        }
        if let Some(status) = child.try_wait()? {
            break status;
        }
        std::thread::sleep(Duration::from_millis(20));
    };
    stdout.rewind()?;
    stderr.rewind()?;
    let mut output = Output {
        status,
        stdout: Vec::new(),
        stderr: Vec::new(),
    };
    stdout.take(OUTPUT_LIMIT).read_to_end(&mut output.stdout)?;
    stderr.take(OUTPUT_LIMIT).read_to_end(&mut output.stderr)?;
    Ok(output)
}

/// Kill a child that is still running and reap it; an error means it could
/// not be confirmed gone.
pub(crate) fn stop_child(child: &mut Child) -> AppResult<()> {
    if child.try_wait()?.is_none()
        && let Err(error) = child.kill()
        && child.try_wait()?.is_none()
    {
        return Err(error.into());
    }
    child.wait()?;
    Ok(())
}

/// What the recording dialog may offer.
pub fn capabilities() -> RecordingCapabilities {
    let ffmpeg = ffmpeg_path();
    RecordingCapabilities {
        ffmpeg: ffmpeg.is_some(),
        microphones: ffmpeg.map(|f| list_microphones(&f)).unwrap_or_default(),
        video_max_seconds: VIDEO_MAX_SECONDS,
        gif_max_seconds: GIF_MAX_SECONDS,
    }
}

/// Ask ffmpeg for its capture devices and keep the audio ones.
fn list_microphones(ffmpeg: &Path) -> Vec<Microphone> {
    #[cfg(target_os = "macos")]
    let args: &[&str] = &[
        "-hide_banner",
        "-f",
        "avfoundation",
        "-list_devices",
        "true",
        "-i",
        "",
    ];
    #[cfg(not(target_os = "macos"))]
    let args: &[&str] = &[];
    if args.is_empty() {
        return Vec::new();
    }
    let Ok(out) = Command::new(ffmpeg).args(args).output() else {
        return Vec::new();
    };
    parse_avfoundation_devices(&String::from_utf8_lossy(&out.stderr))
}

/// The audio section of ffmpeg's avfoundation device listing:
/// `[AVFoundation indev @ ...] [0] MacBook Pro Microphone`.
pub fn parse_avfoundation_devices(listing: &str) -> Vec<Microphone> {
    let mut in_audio = false;
    let mut mics = Vec::new();
    for line in listing.lines() {
        if line.contains("audio devices") {
            in_audio = true;
            continue;
        }
        if line.contains("video devices") {
            in_audio = false;
            continue;
        }
        if !in_audio {
            continue;
        }
        let Some(rest) = line.split("] [").nth(1) else {
            continue;
        };
        let Some((id, name)) = rest.split_once("] ") else {
            continue;
        };
        if id.chars().all(|c| c.is_ascii_digit()) {
            mics.push(Microphone {
                id: id.to_owned(),
                name: name.trim().to_owned(),
            });
        }
    }
    mics
}

/// Start ffmpeg capturing one microphone into `path` until told to quit.
fn spawn_mic(mic: &str, path: &Path) -> AppResult<Child> {
    let ffmpeg = ffmpeg_path().ok_or_else(|| AppError::new("ffmpeg not found"))?;
    let mut cmd = Command::new(ffmpeg);
    cmd.args(["-hide_banner", "-loglevel", "error", "-y"]);
    #[cfg(target_os = "macos")]
    cmd.args(["-f", "avfoundation", "-i", &format!(":{mic}")]);
    #[cfg(not(target_os = "macos"))]
    cmd.args(["-f", "pulse", "-i", mic]);
    cmd.args(["-ac", "1", "-ar", "48000"])
        .arg(path)
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    cmd.spawn().map_err(AppError::new)
}

/// Start ffmpeg capturing the window's rectangle of its display (pointer
/// included), with the microphone in the same stream, until told to quit.
fn spawn_screen(rect: WindowRect, mic: Option<&str>, fps: u32, path: &Path) -> AppResult<Child> {
    let ffmpeg = ffmpeg_path().ok_or_else(|| AppError::new("ffmpeg not found"))?;
    let screens = list_screens(&ffmpeg);
    let device = screens
        .get(rect.screen)
        .or_else(|| screens.first())
        .ok_or_else(|| AppError::new("no display can be captured"))?;
    // H.264 wants even dimensions.
    let (w, h) = (rect.width & !1, rect.height & !1);
    let mut cmd = Command::new(ffmpeg);
    cmd.args(["-hide_banner", "-loglevel", "error", "-y"]);
    #[cfg(target_os = "macos")]
    {
        cmd.args([
            "-f",
            "avfoundation",
            "-capture_cursor",
            "1",
            "-capture_mouse_clicks",
            "1",
            "-framerate",
            &fps.to_string(),
            "-pixel_format",
            "uyvy422",
            "-i",
            &mic.map_or_else(|| device.clone(), |m| format!("{device}:{m}")),
        ]);
    }
    // gdigrab names no display: it takes the whole desktop and the crop
    // filter below picks the window out of it, which is what happens on the
    // other platforms too once the region is grabbed.
    #[cfg(target_os = "windows")]
    {
        let _ = device;
        cmd.args([
            "-f",
            "gdigrab",
            "-framerate",
            &fps.to_string(),
            "-i",
            "desktop",
        ]);
        // A microphone is a separate dshow input rather than part of the
        // video device, so it is added as its own -f/-i pair.
        if let Some(mic) = mic {
            cmd.args(["-f", "dshow", "-i", &format!("audio={mic}")]);
        }
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        let _ = (mic, device);
        cmd.args([
            "-f",
            "x11grab",
            "-framerate",
            &fps.to_string(),
            "-i",
            &format!(":0.0+{},{}", rect.x, rect.y),
        ]);
    }
    cmd.args([
        "-vf",
        &format!("crop={w}:{h}:{}:{},format=yuv420p", rect.x, rect.y),
        "-c:v",
        "libx264",
        "-preset",
        "veryfast",
        "-crf",
        "22",
    ]);
    if mic.is_some() {
        cmd.args(["-c:a", "aac", "-b:a", "128k"]);
    } else {
        cmd.arg("-an");
    }
    cmd.arg(path)
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    cmd.spawn().map_err(AppError::new)
}

/// Displays ffmpeg can capture, by device id, in display order.
fn list_screens(ffmpeg: &Path) -> Vec<String> {
    #[cfg(target_os = "macos")]
    {
        let Ok(out) = Command::new(ffmpeg)
            .args([
                "-hide_banner",
                "-f",
                "avfoundation",
                "-list_devices",
                "true",
                "-i",
                "",
            ])
            .output()
        else {
            return Vec::new();
        };
        parse_avfoundation_screens(&String::from_utf8_lossy(&out.stderr))
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = ffmpeg;
        vec![String::new()]
    }
}

/// `[AVFoundation indev @ ...] [2] Capture screen 0` lines, in screen order.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub fn parse_avfoundation_screens(listing: &str) -> Vec<String> {
    let mut screens: Vec<(u32, String)> = Vec::new();
    for line in listing.lines() {
        let Some(rest) = line.split("] [").nth(1) else {
            continue;
        };
        let Some((id, name)) = rest.split_once("] ") else {
            continue;
        };
        if let Some(n) = name.trim().strip_prefix("Capture screen")
            && let Ok(n) = n.trim().parse::<u32>()
        {
            screens.push((n, id.to_owned()));
        }
    }
    screens.sort_by_key(|(n, _)| *n);
    screens.into_iter().map(|(_, id)| id).collect()
}

/// Join the screen-capture stretches into the final file, in the format
/// asked for, and make its preview.
#[allow(clippy::too_many_lines)] // Two ffmpeg command lines, spelled out.
fn finish_window(
    segments: &[PathBuf],
    options: &RecordOptions,
    dir: &Path,
    duration: f64,
    stem: &str,
) -> AppResult<RecordingResult> {
    if segments.is_empty() {
        return Err(AppError::new("nothing was captured"));
    }
    let ffmpeg = ffmpeg_path().ok_or_else(|| AppError::new("ffmpeg not found"))?;
    let work = segments[0]
        .parent()
        .ok_or_else(|| AppError::new("capture directory vanished"))?;
    let list = work.join("screen.ffconcat");
    let mut text = String::from("ffconcat version 1.0\n");
    for seg in segments {
        let _ = writeln!(text, "file '{}'", seg.display());
    }
    std::fs::write(&list, text)?;
    let joined = work.join("joined.mp4");
    run_ffmpeg(&ffmpeg, |cmd| {
        cmd.args(["-f", "concat", "-safe", "0", "-i"])
            .arg(&list)
            .args(["-c", "copy", "-movflags", "+faststart"])
            .arg(&joined);
    })?;
    let has_audio = options.microphone.is_some();
    let max_width = options.max_width.clamp(320, 3840);
    if options.is_gif() {
        let path = dir.join(format!("{stem}.gif"));
        let filter = format!(
            "scale='min({GIF_WIDTH},iw)':-2:flags=lanczos,split[a][b];[a]palettegen=max_colors=200:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle"
        );
        run_ffmpeg(&ffmpeg, |cmd| {
            cmd.arg("-i")
                .arg(&joined)
                .args(["-filter_complex", &filter, "-loop", "0"])
                .arg(&path);
        })?;
        let (w, h) = probe_size(&path).unwrap_or((0, 0));
        return finish(&path, "gif", duration, w, h, 0, false);
    }
    let path = dir.join(format!("{stem}.mp4"));
    let preview_dir = dir.join(PREVIEW_DIR);
    std::fs::create_dir_all(&preview_dir)?;
    let preview = preview_dir.join(format!("{stem}.webm"));
    run_ffmpeg(&ffmpeg, |cmd| {
        cmd.arg("-i").arg(&joined);
        cmd.args([
            "-vf",
            &format!("scale='min({max_width},iw)':-2:flags=lanczos,format=yuv420p"),
            "-c:v",
            "libx264",
            "-preset",
            "veryfast",
            "-crf",
            "22",
            "-movflags",
            "+faststart",
        ]);
        if has_audio {
            cmd.args(["-c:a", "aac", "-b:a", "128k"]);
        } else {
            cmd.arg("-an");
        }
        cmd.arg(&path);
    })?;
    let (w, h) = probe_size(&path).unwrap_or((0, 0));
    let mut result = finish(&path, "mp4", duration, w, h, 0, has_audio)?;
    result.preview = write_companion(&path, &preview, max_width, has_audio);
    Ok(result)
}

/// Write the tracked pointer events beside the recording, keyed by its
/// file name; returns the sidecar's path when there was anything to write.
fn write_events(dir: &Path, recording: &str, events: Vec<TrackedEvent>) -> Option<String> {
    let viewport = events.iter().find(|e| e.k == "v")?;
    let sidecar = RecordingEvents {
        viewport: (viewport.w.unwrap_or(0.0), viewport.h.unwrap_or(0.0)),
        dpr: viewport.dpr.unwrap_or(1.0),
        events,
    };
    let stem = Path::new(recording)
        .file_stem()?
        .to_string_lossy()
        .into_owned();
    let meta_dir = dir.join(PREVIEW_DIR);
    std::fs::create_dir_all(&meta_dir).ok()?;
    let path = meta_dir.join(format!("{stem}.events.json"));
    std::fs::write(&path, serde_json::to_vec(&sidecar).ok()?).ok()?;
    Some(path.to_string_lossy().into_owned())
}

/// Write the VP8 `WebM` companion of a finished MP4 at `out`: what the
/// chrome plays in the "saved" dialog and edits in `DiveScreen`, since it
/// cannot decode H.264. VP8 rather than VP9 on purpose: the embedded
/// Chromium decodes VP9 in hardware and allows exactly one such decoder,
/// so a second element (the editor beside the dialog, or an export) fails
/// with a decode error; VP8 is software-decoded and any number play at
/// once. Its own ffmpeg pass, from the finished file: a second output of
/// the frame-encoding run produced a container the demuxer would not open.
pub fn write_companion(mp4: &Path, out: &Path, max_width: u32, with_audio: bool) -> Option<String> {
    let ffmpeg = ffmpeg_path()?;
    if let Some(dir) = out.parent() {
        std::fs::create_dir_all(dir).ok()?;
    }
    let mut cmd = Command::new(ffmpeg);
    cmd.args(["-hide_banner", "-loglevel", "error", "-y"])
        .arg("-i")
        .arg(mp4)
        .args([
            "-vf",
            &format!("scale='min({max_width},iw)':-2,format=yuv420p"),
            "-c:v",
            "libvpx",
            "-deadline",
            "realtime",
            "-cpu-used",
            "8",
            "-crf",
            "10",
            "-b:v",
            "6M",
            "-qmin",
            "4",
            "-qmax",
            "40",
            "-g",
            "30",
        ]);
    if with_audio {
        cmd.args(["-c:a", "libopus", "-b:a", "64k"]);
    } else {
        cmd.arg("-an");
    }
    cmd.arg(out);
    let ok = run_with_deadline(&mut cmd, PROCESS_LIMIT).is_ok_and(|o| o.status.success());
    (ok && out.exists()).then(|| out.to_string_lossy().into_owned())
}

/// Run one ffmpeg invocation to completion, turning a failure into a message.
fn run_ffmpeg(ffmpeg: &Path, args: impl FnOnce(&mut Command)) -> AppResult<()> {
    let mut cmd = Command::new(ffmpeg);
    cmd.args(["-hide_banner", "-loglevel", "error", "-y"]);
    args(&mut cmd);
    let out = cmd.stdin(Stdio::null()).output().map_err(AppError::new)?;
    if out.status.success() {
        return Ok(());
    }
    let err = String::from_utf8_lossy(&out.stderr);
    Err(AppError::new(format!(
        "ffmpeg failed: {}",
        err.lines().last().unwrap_or("unknown error")
    )))
}

/// ffconcat playlist at a constant `fps`: for every output tick, the frame
/// that was on screen then. Frames repeat across stalls and are skipped when
/// the page painted faster than the output rate, so the file's length is the
/// recording's length however many frames arrived. (The demuxer's per-entry
/// `duration` is not honoured for image files.)
fn write_playlist(frames: &[Frame], end: f64, fps: u32, path: &Path) -> AppResult<usize> {
    let fps = f64::from(fps.max(1));
    #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)] // Bounded by the length cap.
    let ticks = ((end * fps).ceil() as usize).max(1);
    let mut out = String::from("ffconcat version 1.0\n");
    let mut idx = 0;
    for i in 0..ticks {
        #[allow(clippy::cast_precision_loss)]
        let t = i as f64 / fps;
        while idx + 1 < frames.len() && frames[idx + 1].at <= t {
            idx += 1;
        }
        let _ = writeln!(out, "file '{}'", frames[idx].path.display());
    }
    std::fs::write(path, out)?;
    Ok(ticks)
}

/// Encode frames (and microphone segments) to an MP4 with ffmpeg.
fn encode_video(
    frames: &[Frame],
    audio: &[PathBuf],
    options: &RecordOptions,
    dir: &Path,
    end: f64,
    stem: &str,
) -> AppResult<RecordingResult> {
    let ffmpeg = ffmpeg_path().ok_or_else(|| AppError::new("ffmpeg not found"))?;
    let work = frames[0]
        .path
        .parent()
        .ok_or_else(|| AppError::new("frame directory vanished"))?;
    let playlist = work.join("frames.ffconcat");
    let fps = options.fps();
    write_playlist(frames, end, fps, &playlist)?;
    let audio_list = work.join("audio.ffconcat");
    let with_audio = !audio.is_empty();
    if with_audio {
        let mut out = String::from("ffconcat version 1.0\n");
        for seg in audio {
            let _ = writeln!(out, "file '{}'", seg.display());
        }
        std::fs::write(&audio_list, out)?;
    }
    let path = dir.join(format!("{stem}.mp4"));
    let preview_dir = dir.join(PREVIEW_DIR);
    std::fs::create_dir_all(&preview_dir)?;
    let preview = preview_dir.join(format!("{stem}.webm"));
    let max_width = options.max_width.clamp(320, 3840);
    let mut cmd = Command::new(ffmpeg);
    cmd.args(["-hide_banner", "-loglevel", "error", "-y"])
        .args(["-f", "concat", "-safe", "0", "-r", &fps.to_string(), "-i"])
        .arg(&playlist);
    if with_audio {
        cmd.args(["-f", "concat", "-safe", "0", "-i"])
            .arg(&audio_list);
    }
    cmd.args([
        "-vf",
        &format!("scale='min({max_width},iw)':-2:flags=lanczos,format=yuv420p"),
        "-c:v",
        "libx264",
        "-preset",
        "veryfast",
        "-crf",
        "22",
        "-movflags",
        "+faststart",
    ]);
    if with_audio {
        cmd.args(["-c:a", "aac", "-b:a", "128k", "-shortest"]);
    } else {
        cmd.arg("-an");
    }
    cmd.arg(&path).stdin(Stdio::null());
    let out = cmd.output().map_err(AppError::new)?;
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr);
        return Err(AppError::new(format!(
            "ffmpeg could not encode the recording: {}",
            err.lines().last().unwrap_or("unknown error")
        )));
    }
    let (width, height) = probe_size(&path).unwrap_or_else(|| {
        decode(&std::fs::read(&frames[0].path).unwrap_or_default())
            .map_or((0, 0), |i| (i.width().min(max_width), i.height()))
    });
    let mut result = finish(&path, "mp4", end, width, height, frames.len(), with_audio)?;
    result.preview = write_companion(&path, &preview, max_width, with_audio);
    Ok(result)
}

/// Ask ffprobe (beside ffmpeg) for the picture size of the finished file.
fn probe_size(path: &Path) -> Option<(u32, u32)> {
    let probe = ffmpeg_path()?.with_file_name("ffprobe");
    let out = Command::new(probe)
        .args([
            "-v",
            "error",
            "-select_streams",
            "v:0",
            "-show_entries",
            "stream=width,height",
            "-of",
            "csv=p=0",
        ])
        .arg(path)
        .output()
        .ok()?;
    let text = String::from_utf8_lossy(&out.stdout);
    let mut parts = text.trim().split(',');
    Some((parts.next()?.parse().ok()?, parts.next()?.parse().ok()?))
}

fn finish(
    path: &Path,
    format: &str,
    duration: f64,
    width: u32,
    height: u32,
    frames: usize,
    has_audio: bool,
) -> AppResult<RecordingResult> {
    #[allow(clippy::cast_precision_loss)] // Files are nowhere near 2^53 bytes.
    let bytes = std::fs::metadata(path)?.len() as f64;
    Ok(RecordingResult {
        path: path.to_string_lossy().into_owned(),
        duration_secs: duration,
        bytes,
        width,
        height,
        format: format.into(),
        frames: u32::try_from(frames).unwrap_or(u32::MAX),
        has_audio,
        events: None,
        preview: None,
    })
}

/// Frame rate a GIF is sampled at; more only makes the file heavier.
const GIF_FPS: u32 = 12;

/// Encode frames as a looping GIF with ffmpeg: a palette computed from the
/// whole clip, then dithered. Seconds of work where the pure-Rust encoder
/// below takes minutes on a 30 fps capture.
fn encode_gif_ffmpeg(
    frames: &[Frame],
    dir: &Path,
    end: f64,
    stem: &str,
) -> AppResult<RecordingResult> {
    let ffmpeg = ffmpeg_path().ok_or_else(|| AppError::new("ffmpeg not found"))?;
    let work = frames[0]
        .path
        .parent()
        .ok_or_else(|| AppError::new("frame directory vanished"))?;
    let playlist = work.join("frames.ffconcat");
    write_playlist(frames, end, GIF_FPS, &playlist)?;
    let path = dir.join(format!("{stem}.gif"));
    let filter = format!(
        "scale='min({GIF_WIDTH},iw)':-2:flags=lanczos,split[a][b];[a]palettegen=max_colors=200:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle"
    );
    let out = Command::new(ffmpeg)
        .args(["-hide_banner", "-loglevel", "error", "-y"])
        .args([
            "-f",
            "concat",
            "-safe",
            "0",
            "-r",
            &GIF_FPS.to_string(),
            "-i",
        ])
        .arg(&playlist)
        .args(["-filter_complex", &filter, "-loop", "0"])
        .arg(&path)
        .stdin(Stdio::null())
        .output()
        .map_err(AppError::new)?;
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr);
        return Err(AppError::new(format!(
            "ffmpeg could not encode the GIF: {}",
            err.lines().last().unwrap_or("unknown error")
        )));
    }
    let (width, height) = probe_size(&path).unwrap_or_else(|| {
        decode(&std::fs::read(&frames[0].path).unwrap_or_default())
            .map_or((0, 0), |i| (i.width().min(GIF_WIDTH), i.height()))
    });
    finish(&path, "gif", end, width, height, frames.len(), false)
}

/// Thin a capture to at most `fps`, keeping the first frame of each slot.
fn sample(frames: &[Frame], fps: u32) -> Vec<&Frame> {
    let step = 1.0 / f64::from(fps.max(1));
    let mut kept: Vec<&Frame> = Vec::new();
    let mut next_at = 0.0;
    for f in frames {
        if kept.is_empty() || f.at >= next_at {
            kept.push(f);
            next_at = f.at + step;
        }
    }
    kept
}

/// Encode frames as a looping GIF in `dir`, scaled to at most `GIF_WIDTH`,
/// without ffmpeg. Slow per frame, so the capture is thinned first.
// Every float here is rounded and clamped into range before the cast.
#[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
fn encode_gif(frames: &[Frame], dir: &Path, end: f64, stem: &str) -> AppResult<RecordingResult> {
    let total = frames.len();
    let frames = sample(frames, GIF_FPS);
    let first = decode(&std::fs::read(&frames[0].path)?)?;
    let width = GIF_WIDTH.min(first.width());
    let height =
        (u64::from(first.height()) * u64::from(width) / u64::from(first.width())).max(1) as u32;
    let (w16, h16) = (
        u16::try_from(width).map_err(AppError::new)?,
        u16::try_from(height).map_err(AppError::new)?,
    );

    let path = dir.join(format!("{stem}.gif"));
    let file = std::io::BufWriter::new(std::fs::File::create(&path)?);
    let mut encoder = gif::Encoder::new(file, w16, h16, &[]).map_err(AppError::new)?;
    encoder
        .set_repeat(gif::Repeat::Infinite)
        .map_err(AppError::new)?;

    for (i, frame) in frames.iter().enumerate() {
        let img = decode(&std::fs::read(&frame.path)?)?
            .resize_exact(width, height, image::imageops::FilterType::Triangle)
            .to_rgba8();
        let next_at = frames.get(i + 1).map_or(end, |n| n.at);
        let mut out = gif::Frame::from_rgba_speed(w16, h16, &mut img.into_raw(), 10);
        // Centiseconds; clamp so a static page still animates and a stall
        // doesn't freeze the loop for minutes.
        out.delay = ((next_at - frame.at) * 100.0).round().clamp(2.0, 500.0) as u16;
        encoder.write_frame(&out).map_err(AppError::new)?;
    }
    drop(encoder);
    finish(&path, "gif", end, width, height, total, false)
}

fn decode(jpeg: &[u8]) -> AppResult<image::DynamicImage> {
    image::load_from_memory_with_format(jpeg, image::ImageFormat::Jpeg).map_err(AppError::new)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn microphones_come_from_the_audio_section_only() {
        let listing = "[AVFoundation indev @ 0x1] AVFoundation video devices:\n\
            [AVFoundation indev @ 0x1] [0] FaceTime HD Camera\n\
            [AVFoundation indev @ 0x1] [1] Capture screen 0\n\
            [AVFoundation indev @ 0x1] AVFoundation audio devices:\n\
            [AVFoundation indev @ 0x1] [0] MacBook Pro Microphone\n\
            [AVFoundation indev @ 0x1] [1] AirPods Pro\n";
        assert_eq!(
            parse_avfoundation_devices(listing),
            vec![
                Microphone {
                    id: "0".into(),
                    name: "MacBook Pro Microphone".into()
                },
                Microphone {
                    id: "1".into(),
                    name: "AirPods Pro".into()
                },
            ]
        );
    }

    #[test]
    fn playlist_samples_frames_at_the_output_rate() {
        let dir = std::env::temp_dir().join(format!("dive-rec-{}", TabId::new()));
        std::fs::create_dir_all(&dir).unwrap();
        // Two frames over two seconds: the first holds for half a second,
        // the second for the rest, whatever rate the page painted at.
        let frames = vec![
            Frame {
                at: 0.0,
                path: dir.join("f000000.jpg"),
            },
            Frame {
                at: 0.5,
                path: dir.join("f000001.jpg"),
            },
        ];
        let list = dir.join("frames.ffconcat");
        let ticks = write_playlist(&frames, 2.0, 10, &list).unwrap();
        let text = std::fs::read_to_string(&list).unwrap();
        assert_eq!(ticks, 20);
        assert_eq!(text.matches("f000000.jpg").count(), 5, "{text}");
        assert_eq!(text.matches("f000001.jpg").count(), 15, "{text}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn screens_are_found_among_the_video_devices_in_display_order() {
        let listing = "[AVFoundation indev @ 0x1] AVFoundation video devices:\n\
            [AVFoundation indev @ 0x1] [0] FaceTime HD Camera\n\
            [AVFoundation indev @ 0x1] [1] Capture screen 1\n\
            [AVFoundation indev @ 0x1] [2] Capture screen 0\n\
            [AVFoundation indev @ 0x1] AVFoundation audio devices:\n\
            [AVFoundation indev @ 0x1] [0] MacBook Pro Microphone\n";
        assert_eq!(
            parse_avfoundation_screens(listing),
            vec!["2".to_owned(), "1".to_owned()]
        );
    }

    #[test]
    fn options_without_a_source_record_the_page() {
        let o: RecordOptions =
            serde_json::from_str(r#"{"format":"mp4","fps":30,"max_width":1280,"microphone":null}"#)
                .unwrap();
        assert!(!o.is_window());
        assert_eq!(o.source, "page");
    }

    #[test]
    fn sampling_keeps_one_frame_per_slot() {
        let frames: Vec<Frame> = (0..30)
            .map(|i| Frame {
                at: f64::from(i) / 30.0,
                path: PathBuf::from(format!("f{i}.jpg")),
            })
            .collect();
        let kept = sample(&frames, 10);
        assert_eq!(kept.len(), 10, "a second at 30 fps thins to 10");
        assert!(kept[0].at.abs() < 1e-9);
        assert!(kept[1].at >= 0.1 - 1e-9);
    }

    #[test]
    fn compatibility_capture_uses_the_requested_cadence() {
        assert_eq!(poll_period(30), Duration::from_nanos(33_333_333));
        assert_eq!(poll_period(15), Duration::from_nanos(66_666_667));
        assert_eq!(poll_period(0), Duration::from_millis(200));
    }

    #[test]
    fn caps_follow_the_format() {
        let gif = RecordOptions::default();
        assert_eq!(gif.max_seconds(), GIF_MAX_SECONDS);
        let video = RecordOptions {
            format: "mp4".into(),
            ..RecordOptions::default()
        };
        assert_eq!(video.max_seconds(), VIDEO_MAX_SECONDS);
    }
}
