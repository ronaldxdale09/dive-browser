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
use std::sync::atomic::{AtomicBool, AtomicU8, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime};

use base64::Engine as _;
use dive_cdp::CdpSession;
use dive_core::TabId;
use serde::{Deserialize, Serialize};
use serde_json::json;
use specta::Type;
use tauri::{AppHandle, Manager as _};
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
///
/// A page keeps its listeners after a recording ends, so a second recording
/// of the same document finds them installed. It used to return there
/// without a word, and the viewport message the sidecar is built on never
/// came: the second recording had no cursor or zoom data at all. Now it
/// switches the listeners back on and announces the viewport again, and a
/// stop switches them off.
const TRACK_SCRIPT: &str = r"(() => {
  const viewport = () => ({k:'v', t: performance.now(), w: innerWidth, h: innerHeight, dpr: devicePixelRatio});
  const known = window.__diveRecordTrackState;
  if (known) { known.live = true; known.send(viewport()); return; }
  const state = { live: true, send: (o) => { if (!state.live) return; try { window.__diveRecordTrack(JSON.stringify(o)); } catch (e) {} } };
  window.__diveRecordTrackState = state;
  const send = state.send;
  let last = 0;
  addEventListener('pointermove', (e) => { const t = performance.now(); if (t - last < 16) return; last = t; send({k:'m', t, x:e.clientX, y:e.clientY}); }, {capture:true, passive:true});
  addEventListener('pointerdown', (e) => send({k:'c', t: performance.now(), x:e.clientX, y:e.clientY, b:e.button}), {capture:true, passive:true});
  addEventListener('keydown', (e) => send({k:'k', t: performance.now()}), {capture:true, passive:true});
  addEventListener('scroll', () => send({k:'s', t: performance.now(), x: scrollX, y: scrollY}), {capture:true, passive:true});
  send(viewport());
})();";

/// Switches the page's pointer tracking off when a recording ends.
const UNTRACK_SCRIPT: &str =
    "window.__diveRecordTrackState && (window.__diveRecordTrackState.live = false)";

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

/// Something the chrome should react to while a recording runs or saves.
#[derive(Debug, Clone, Serialize, Deserialize, Type, Event)]
pub struct RecordingEvent {
    /// The tab being recorded.
    pub tab: TabId,
    /// `limit` when the length cap was reached and no more frames are kept;
    /// `mic_failed` when the microphone stopped recording; `finishing` when
    /// Dive began saving on its own (the tab closed, or Dive is quitting);
    /// `progress` while a save runs; `saved` or `failed` when a save Dive
    /// began on its own ends.
    pub kind: String,
    /// Share of the save done, 0 to 1, with `progress`.
    pub progress: Option<f64>,
    /// The file, with `saved`.
    pub result: Option<RecordingResult>,
    /// Why, with `failed`.
    pub error: Option<String>,
}

impl RecordingEvent {
    fn new(tab: TabId, kind: &str) -> Self {
        Self {
            tab,
            kind: kind.into(),
            progress: None,
            result: None,
            error: None,
        }
    }
}

/// Prefix of the hidden work directory a recording keeps its frames in.
const WORK_DIR_PREFIX: &str = ".recording-";
/// A work directory untouched this long belongs to no live recording: a
/// crash or a kill left it. Launch removes it; frames are gigabytes.
const STALE_WORK_DIR: Duration = Duration::from_hours(1);
/// Capture processes are told to end this long after the length cap, so
/// the watchdog, which cuts at the cap exactly, always gets there first
/// and the limit only matters when Dive is gone and cannot stop them.
const CAPTURE_SLACK_SECONDS: f64 = 2.0;
/// What a save stopped by the person reports.
const SAVE_STOPPED: &str = "saving was stopped";

/// One captured frame: when it was painted, and which file holds it.
#[derive(Clone)]
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
    /// A save is running. A second stop is refused meanwhile, and a cancel
    /// stops the save instead of deleting what it is saving.
    finishing: AtomicBool,
    /// The person asked the running save to stop.
    cancel_save: AtomicBool,
    /// Length fixed by the first stop, so a save tried again later does not
    /// count the minutes spent in between as recording.
    length: Mutex<Option<f64>>,
    /// Why the last save failed, while the recording waits to be tried again.
    error: Mutex<Option<String>>,
    /// The microphone was lost and the chrome has been told.
    mic_lost: AtomicBool,
    started: Instant,
    /// Total time spent paused, and when the current pause began.
    pauses: Mutex<(Duration, Option<Instant>)>,
    audio: Mutex<Audio>,
    /// Pointer and click events from the page, on the media clock.
    tracked: Mutex<Vec<TrackedEvent>>,
    /// The new-document script feeding `tracked`, removed when capture ends
    /// so every later page load of the tab stops installing it.
    track_script: Mutex<Option<String>>,
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
        let dir = crate::commands::captures_dir()?.join(format!("{WORK_DIR_PREFIX}{stamp}"));
        std::fs::create_dir_all(&dir)?;
        Ok(Self {
            dir,
            options,
            stem: crate::commands::capture_stem(page_url, "recording", now),
            frames: Mutex::new(Vec::new()),
            stopped: AtomicBool::new(false),
            paused: AtomicBool::new(false),
            limit_hit: AtomicBool::new(false),
            finishing: AtomicBool::new(false),
            cancel_save: AtomicBool::new(false),
            length: Mutex::new(None),
            error: Mutex::new(None),
            mic_lost: AtomicBool::new(false),
            started: Instant::now(),
            pauses: Mutex::new((Duration::ZERO, None)),
            audio: Mutex::new(Audio::default()),
            tracked: Mutex::new(Vec::new()),
            track_script: Mutex::new(None),
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

    /// The recording's length, fixed the first time it is asked for.
    fn length(&self) -> f64 {
        *lock(&self.length).get_or_insert_with(|| self.media_time())
    }

    fn done(&self) -> bool {
        self.stopped.load(Ordering::Relaxed) || self.limit_hit.load(Ordering::Relaxed)
    }

    fn emit(&self, event: &RecordingEvent) {
        if let Err(error) = event.emit(&self.app) {
            tracing::debug!(tab = %self.tab, %error, kind = %event.kind, "recording event not delivered");
        }
    }

    /// Mark the length cap as reached, telling the chrome once.
    fn hit_limit(&self) {
        if !self.limit_hit.swap(true, Ordering::Relaxed) {
            self.emit(&RecordingEvent::new(self.tab, "limit"));
        }
    }

    /// Seconds a capture process started now may run: the rest of the
    /// length cap, so one that outlives Dive still ends on its own.
    fn capture_budget(&self) -> f64 {
        capture_budget(self.options.max_seconds(), self.media_time())
    }

    /// Whether anything was captured that a save could turn into a file.
    fn has_material(&self) -> bool {
        !lock(&self.frames).is_empty() || !lock(&self.screen).segments.is_empty()
    }

    /// Keep a frame unless paused; returns whether the length cap was hit.
    fn push(&self, jpeg: &[u8]) -> bool {
        if self.paused.load(Ordering::Relaxed) || self.done() {
            return self.limit_hit.load(Ordering::Relaxed);
        }
        let at = self.media_time();
        if at > f64::from(self.options.max_seconds()) {
            self.hit_limit();
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
        // Past the cap or the stop, a resume would start capture processes
        // nobody is going to end.
        if self.done() {
            return;
        }
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
            self.capture_budget(),
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
        match spawn_mic(mic, self.capture_budget(), &path) {
            Ok(child) => audio.child = Some((child, path)),
            Err(e) => {
                tracing::warn!("microphone capture failed to start: {e}");
                audio.failed = true;
            }
        }
    }

    /// Whether the microphone process is running.
    fn microphone_alive(&self) -> bool {
        lock(&self.audio)
            .child
            .as_mut()
            .is_some_and(|(child, _)| matches!(child.try_wait(), Ok(None)))
    }

    /// Notice a microphone process that ended on its own (the device was
    /// unplugged, or access was withdrawn), keep what it wrote, and tell
    /// the chrome once: the rest of the recording will be silent.
    fn check_microphone(&self) {
        let mut audio = lock(&self.audio);
        let exited = audio
            .child
            .as_mut()
            .is_some_and(|(child, _)| matches!(child.try_wait(), Ok(Some(_)) | Err(_)));
        if !exited {
            return;
        }
        if let Some((_, path)) = audio.child.take()
            && path.exists()
        {
            audio.segments.push(path);
        }
        audio.failed = true;
        drop(audio);
        if !self.mic_lost.swap(true, Ordering::Relaxed) {
            tracing::warn!(tab = %self.tab, "microphone capture ended while recording");
            self.emit(&RecordingEvent::new(self.tab, "mic_failed"));
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

    /// Switch pointer tracking off in the page and stop installing it on
    /// the tab's next page loads.
    async fn untrack(&self, session: &CdpSession) {
        let script = lock(&self.track_script).take();
        let _ = session
            .call("Runtime.evaluate", json!({"expression": UNTRACK_SCRIPT}))
            .await;
        if let Some(identifier) = script {
            let _ = session
                .call(
                    "Page.removeScriptToEvaluateOnNewDocument",
                    json!({"identifier": identifier}),
                )
                .await;
        }
        let _ = session
            .call("Runtime.removeBinding", json!({"name": TRACK_BINDING}))
            .await;
    }

    /// Encode what was captured into the captures directory. The frames stay
    /// where they are, so a save that fails can be tried again.
    fn encode(&self, duration: f64) -> AppResult<RecordingResult> {
        self.stop_audio_segment();
        self.stop_screen_segment();
        let dir = crate::commands::captures_dir()?;
        if self.options.is_window() {
            let segments = lock(&self.screen).segments.clone();
            let watch = Watch::new(self, duration);
            return finish_window(&segments, &self.options, &dir, duration, &self.stem, &watch);
        }
        let frames = lock(&self.frames).clone();
        let Some(last) = frames.last() else {
            return Err(AppError::new("nothing was painted while recording"));
        };
        let audio = lock(&self.audio).segments.clone();
        let end = duration.max(last.at + 0.1);
        let watch = Watch::new(self, end);
        let mut result = if self.options.is_gif() {
            match ffmpeg_path() {
                Some(_) => encode_gif_ffmpeg(&frames, &dir, end, &self.stem, &watch),
                None => encode_gif(&frames, &dir, end, &self.stem, &watch),
            }
        } else {
            encode_video(
                &frames,
                &audio,
                &self.options,
                &dir,
                end,
                &self.stem,
                &watch,
            )
        }?;
        let tracked = lock(&self.tracked).clone();
        result.events = write_events(&dir, &result.path, tracked);
        Ok(result)
    }

    fn remove_dir(&self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

/// The last owner of a recording takes its capture processes and its work
/// directory with it. Every early return between creating the directory and
/// handing the recording over used to leave both behind.
impl Drop for Recording {
    fn drop(&mut self) {
        for slot in [&mut self.audio, &mut self.screen] {
            let audio = slot
                .get_mut()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            if let Some((mut child, _)) = audio.child.take() {
                let _ = child.kill();
                let _ = child.wait();
            }
        }
        self.remove_dir();
    }
}

/// Seconds a capture process may run when `elapsed` of a `max`-second
/// recording has gone: the rest, and a little over.
fn capture_budget(max: u32, elapsed: f64) -> f64 {
    (f64::from(max) - elapsed).max(0.0) + CAPTURE_SLACK_SECONDS
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

/// Watch a running recording: end it at its length cap even when nothing
/// paints (a static page sends no frames, and a window capture sends none
/// through here at all), and notice a microphone that stops.
fn spawn_watchdog(rec: Arc<Recording>) {
    tauri::async_runtime::spawn(async move {
        let mut ticker = tokio::time::interval(Duration::from_millis(500));
        ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        loop {
            ticker.tick().await;
            if rec.stopped.load(Ordering::Relaxed) {
                break;
            }
            if rec.media_time() > f64::from(rec.options.max_seconds()) {
                rec.hit_limit();
                // Ending a segment waits for ffmpeg to finalise its file.
                let worker = rec.clone();
                let _ = tauri::async_runtime::spawn_blocking(move || {
                    worker.stop_audio_segment();
                    worker.stop_screen_segment();
                })
                .await;
                break;
            }
            if !rec.paused.load(Ordering::Relaxed) {
                rec.check_microphone();
            }
        }
    });
}

/// What an `ExitRequested` should do about recordings.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ExitAction {
    /// Nothing to save, or the person insisted: let the exit happen.
    Immediate,
    /// Hold the exit while recordings are saved; [`save_for_exit`] exits.
    Save,
}

const EXIT_IDLE: u8 = 0;
const EXIT_SAVING: u8 = 1;
const EXIT_RELEASED: u8 = 2;

/// Recordings in progress, one per tab at most. A recording stays here
/// while it saves and after a save fails, until it is saved or thrown away.
#[derive(Default)]
pub struct Registry {
    active: Mutex<HashMap<TabId, Arc<Recording>>>,
    /// Where a quit stands: idle, holding for saves, or let through.
    exit: AtomicU8,
}

impl Registry {
    fn active(&self) -> std::sync::MutexGuard<'_, HashMap<TabId, Arc<Recording>>> {
        lock(&self.active)
    }

    /// Whether `tab` has a recording, running, saving, or waiting to be saved.
    pub fn is_recording(&self, tab: TabId) -> bool {
        self.active().contains_key(&tab)
    }

    /// Take `rec` out of the registry, if it is still the one for its tab.
    fn forget(&self, rec: &Arc<Recording>) {
        let mut active = self.active();
        if active.get(&rec.tab).is_some_and(|r| Arc::ptr_eq(r, rec)) {
            active.remove(&rec.tab);
        }
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
        // Refused before a work directory exists: a second start used to
        // create one and then leave it behind when it found the first.
        if self.is_recording(tab) {
            return Err(AppError::new("already recording this tab"));
        }
        let rec = Arc::new(Recording::new(app, tab, options, window, page_url)?);
        {
            let mut active = self.active();
            if active.contains_key(&tab) {
                return Err(AppError::new("already recording this tab"));
            }
            active.insert(tab, rec.clone());
        }
        // A quit that was held and then called off must not wave this one
        // through the next time.
        self.exit.store(EXIT_IDLE, Ordering::SeqCst);
        if rec.options.is_window() {
            // Native capture of the window: no DevTools frames at all. A
            // capture that dies at once is almost always a missing Screen
            // Recording permission, so say that rather than "nothing painted".
            if let Err(e) = rec.start_screen_segment() {
                rec.stopped.store(true, Ordering::Relaxed);
                self.forget(&rec);
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
            if rec.stopped.load(Ordering::Relaxed) {
                return Err(AppError::new("the tab closed before recording began"));
            }
            if died {
                rec.stopped.store(true, Ordering::Relaxed);
                self.forget(&rec);
                return Err(AppError::new(
                    "screen capture stopped at once. Allow Dive under System Settings › Privacy & Security › Screen Recording, then try again",
                ));
            }
            spawn_watchdog(rec);
            return Ok(());
        }
        // The microphone first, and checked: a capture refused access ends
        // at once, and the recording used to carry on without a word and
        // save a silent file. Starting it before the frames also lines the
        // sound up with the picture, both counted from the same moment.
        if rec.options.microphone.is_some() {
            rec.start_audio_segment();
            tokio::time::sleep(Duration::from_millis(700)).await;
            if !rec.microphone_alive() {
                rec.stopped.store(true, Ordering::Relaxed);
                self.forget(&rec);
                return Err(AppError::new(
                    "the microphone could not be recorded. Allow Dive under System Settings › Privacy & Security › Microphone, or choose another microphone, then try again",
                ));
            }
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
        // The tab can close during the waits above; its recording was then
        // finished without frames, and nothing here should start again.
        if rec.stopped.load(Ordering::Relaxed) {
            let _ = session.call0("Page.stopScreencast").await;
            return Err(AppError::new("the tab closed before recording began"));
        }
        if !captured_initial && let Err(error) = &screencast {
            rec.stopped.store(true, Ordering::Relaxed);
            self.forget(&rec);
            return Err(AppError::new(format!(
                "screen capture is unavailable: {error}"
            )));
        }
        spawn_watchdog(rec.clone());
        // Pointer tracking: a binding the page calls, installed now and on
        // every navigation while the recording runs.
        // Subscribed before the script runs: its first message (the viewport)
        // arrives at once. `bindingCalled` only fires while Runtime is on.
        let mut track_events = session.subscribe();
        let _ = session.call0("Runtime.enable").await;
        let _ = session
            .call("Runtime.addBinding", json!({"name": TRACK_BINDING}))
            .await;
        // Kept so the stop can remove it; left in place, every later page
        // load of the tab installed the tracker again for nobody.
        if let Ok(registered) = session
            .call(
                "Page.addScriptToEvaluateOnNewDocument",
                json!({"source": TRACK_SCRIPT}),
            )
            .await
            && let Some(identifier) = registered["identifier"].as_str()
        {
            *lock(&rec.track_script) = Some(identifier.to_owned());
        }
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
        if rec.stopped.load(Ordering::Relaxed) {
            return Err(AppError::new("this recording has already stopped"));
        }
        rec.set_paused(paused);
        Ok(())
    }

    /// Drop a recording without encoding it (the person threw it away).
    ///
    /// Mid-save, this stops the save instead: the recording stays, stopped,
    /// to be saved again or thrown away with a second call, so a click meant
    /// for a slow save cannot delete what it was saving.
    ///
    /// Stopping a segment asks ffmpeg to quit and then waits up to five
    /// seconds for it, so the wait runs on the blocking pool: `tab_close` runs
    /// on the main thread, which also pumps CEF, and a busy encoder froze the
    /// whole browser there for as long as it took to go.
    pub fn discard(&self, tab: TabId) {
        let rec = {
            let mut active = self.active();
            match active.get(&tab) {
                Some(rec) if rec.finishing.load(Ordering::SeqCst) => {
                    rec.cancel_save.store(true, Ordering::SeqCst);
                    return;
                }
                Some(_) => active.remove(&tab),
                None => None,
            }
        };
        if let Some(rec) = rec {
            rec.stopped.store(true, Ordering::Relaxed);
            tauri::async_runtime::spawn_blocking(move || {
                rec.stop_audio_segment();
                rec.stop_screen_segment();
                rec.remove_dir();
            });
        }
    }

    /// Drop every recording at once because the process is exiting.
    ///
    /// `discard` hands its wait to the blocking pool, which does not outlive
    /// the event loop, and its ffmpeg processes were then left behind: a
    /// microphone capture has nothing to end it, so the orphan kept the mic
    /// open after Dive had gone. Here each process is killed outright, since
    /// nobody will read the file, and the work directory removed in place.
    /// By now a quit has already saved what it could (see [`save_for_exit`]).
    pub fn abandon_all(&self) {
        let recordings: Vec<_> = self.active().drain().map(|(_, rec)| rec).collect();
        for rec in recordings {
            rec.stopped.store(true, Ordering::Relaxed);
            rec.cancel_save.store(true, Ordering::SeqCst);
            for slot in [&rec.audio, &rec.screen] {
                if let Some((mut child, _)) = lock(slot).child.take() {
                    let _ = child.kill();
                    let _ = child.wait();
                }
            }
            rec.remove_dir();
        }
    }

    /// Stop capture of `tab` and mark its recording as saving.
    fn begin_stop(&self, tab: TabId) -> AppResult<Arc<Recording>> {
        let rec = self
            .active()
            .get(&tab)
            .cloned()
            .ok_or_else(|| AppError::new("not recording this tab"))?;
        if rec.finishing.swap(true, Ordering::SeqCst) {
            return Err(AppError::new("this recording is already being saved"));
        }
        rec.cancel_save.store(false, Ordering::SeqCst);
        rec.stopped.store(true, Ordering::Relaxed);
        rec.length();
        Ok(rec)
    }

    /// Encode a recording `begin_stop` stopped. It leaves the registry only
    /// once saved, or when nothing was captured to save; a failed save keeps
    /// its frames so trying again can succeed. It used to leave first and
    /// delete the frames whatever happened, so a failed save lost the
    /// recording and every later try said "not recording this tab".
    async fn complete_stop(
        &self,
        rec: Arc<Recording>,
        session: Option<&CdpSession>,
    ) -> AppResult<RecordingResult> {
        if let Some(session) = session {
            let _ = session.call0("Page.stopScreencast").await;
            rec.untrack(session).await;
        }
        let duration = rec.length();
        let worker = rec.clone();
        let encoded = tauri::async_runtime::spawn_blocking(move || {
            let result = worker.encode(duration);
            if result.is_ok() {
                worker.remove_dir();
            }
            result
        })
        .await
        .map_err(AppError::new)
        .and_then(std::convert::identity);
        match &encoded {
            Err(error) if rec.has_material() => {
                tracing::warn!(tab = %rec.tab, %error, "recording not saved; its frames are kept to try again");
                *lock(&rec.error) = Some(error.message.clone());
            }
            _ => self.forget(&rec),
        }
        rec.cancel_save.store(false, Ordering::SeqCst);
        rec.finishing.store(false, Ordering::SeqCst);
        encoded
    }

    /// Stop recording `tab` and encode what was captured; returns the file.
    /// Without a session (the tab is gone) the page is simply not told.
    pub async fn stop(
        &self,
        tab: TabId,
        session: Option<&CdpSession>,
    ) -> AppResult<RecordingResult> {
        let rec = self.begin_stop(tab)?;
        self.complete_stop(rec, session).await
    }

    /// Save `tab`'s recording without the chrome asking: its tab is closing,
    /// or Dive is quitting. The chrome hears `finishing` now, and `saved`
    /// or `failed` when the save ends. Returns at once, so a tab closing on
    /// the main thread does not wait for an encoder.
    ///
    /// Closing the tab used to throw the recording away, which the person
    /// learned only from a toast once it was gone.
    pub fn finish_detached(&self, tab: TabId) {
        let Ok(rec) = self.begin_stop(tab) else {
            return;
        };
        rec.emit(&RecordingEvent::new(tab, "finishing"));
        let app = rec.app.clone();
        tauri::async_runtime::spawn(async move {
            let state = app.state::<crate::state::AppState>();
            let event = match state.screencast.complete_stop(rec, None).await {
                Ok(result) => RecordingEvent {
                    result: Some(result),
                    ..RecordingEvent::new(tab, "saved")
                },
                Err(error) => RecordingEvent {
                    error: Some(error.message),
                    ..RecordingEvent::new(tab, "failed")
                },
            };
            if let Err(error) = event.emit(&app) {
                tracing::debug!(%tab, %error, "recording outcome not delivered");
            }
        });
    }

    /// Decide what a request to quit does about recordings. The first
    /// request with recordings open holds the exit while they are saved;
    /// a second one while that runs lets Dive go, so a save that will not
    /// finish never keeps it open against the person's wishes.
    pub fn prepare_exit(&self) -> ExitAction {
        if self.active().is_empty() {
            return ExitAction::Immediate;
        }
        if self
            .exit
            .compare_exchange(EXIT_IDLE, EXIT_SAVING, Ordering::SeqCst, Ordering::SeqCst)
            .is_ok()
        {
            return ExitAction::Save;
        }
        self.exit.store(EXIT_RELEASED, Ordering::SeqCst);
        ExitAction::Immediate
    }

    /// Whether any recording is saving right now.
    fn saving(&self) -> bool {
        self.active()
            .values()
            .any(|rec| rec.finishing.load(Ordering::SeqCst))
    }

    /// Why a recording that is still here could not be saved, if one could not.
    fn first_failure(&self) -> Option<String> {
        self.active()
            .values()
            .find_map(|rec| lock(&rec.error).clone())
    }
}

/// Save every open recording, then exit with `code`; the second half of
/// [`ExitAction::Save`]. Quitting mid-recording used to throw the recording
/// away without a word. If a save fails, the person chooses between losing
/// it and staying to try again.
pub fn save_for_exit(app: AppHandle<Runtime>, code: i32) {
    const QUIT_ANYWAY: &str = "Quit Anyway";
    tauri::async_runtime::spawn(async move {
        let state = app.state::<crate::state::AppState>();
        let registry = &state.screencast;
        let tabs: Vec<TabId> = registry.active().keys().copied().collect();
        for tab in tabs {
            registry.finish_detached(tab);
        }
        while registry.saving() {
            if registry.exit.load(Ordering::SeqCst) == EXIT_RELEASED {
                // The person quit again meanwhile; that exit is under way.
                return;
            }
            tokio::time::sleep(Duration::from_millis(200)).await;
        }
        if let Some(error) = registry.first_failure() {
            let answer = rfd::AsyncMessageDialog::new()
                .set_title("Dive could not save your recording")
                .set_description(format!(
                    "{error}. Quit anyway and lose the recording, or stay to try saving it again?"
                ))
                .set_level(rfd::MessageLevel::Warning)
                .set_buttons(rfd::MessageButtons::OkCancelCustom(
                    QUIT_ANYWAY.into(),
                    "Stay".into(),
                ))
                .show()
                .await;
            let quit = match answer {
                rfd::MessageDialogResult::Ok => true,
                rfd::MessageDialogResult::Custom(label) => label == QUIT_ANYWAY,
                _ => false,
            };
            if !quit {
                registry.exit.store(EXIT_IDLE, Ordering::SeqCst);
                return;
            }
            registry.exit.store(EXIT_RELEASED, Ordering::SeqCst);
        }
        app.exit(code);
    });
}

/// Remove recording work directories older than [`STALE_WORK_DIR`] from
/// the captures directory. A crash, a kill or a power cut leaves one
/// behind with every frame of the recording in it, hidden, and nothing
/// else ever looked at them again.
pub fn sweep_stale_work_dirs() {
    let Ok(dir) = crate::commands::captures_dir() else {
        return;
    };
    let removed = sweep_work_dirs(&dir, STALE_WORK_DIR);
    if removed > 0 {
        tracing::info!(
            removed,
            "removed recording work directories left by an earlier run"
        );
    }
}

/// Remove `.recording-*` directories in `dir` untouched for `max_age`;
/// returns how many went. A live recording writes a frame every few dozen
/// milliseconds, which keeps its directory's time fresh.
fn sweep_work_dirs(dir: &Path, max_age: Duration) -> usize {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return 0;
    };
    let now = SystemTime::now();
    let mut removed = 0;
    for entry in entries.flatten() {
        if !entry
            .file_name()
            .to_string_lossy()
            .starts_with(WORK_DIR_PREFIX)
        {
            continue;
        }
        let Ok(meta) = entry.metadata() else {
            continue;
        };
        let age = meta
            .modified()
            .ok()
            .and_then(|at| now.duration_since(at).ok())
            .unwrap_or(Duration::ZERO);
        if meta.is_dir() && age >= max_age && std::fs::remove_dir_all(entry.path()).is_ok() {
            removed += 1;
        }
    }
    removed
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
        // A closed session refuses every call at once, so without this a
        // recording whose tab went away without a discard kept this loop
        // ticking at the frame rate for the rest of the process.
        if session.is_closed() {
            tracing::debug!(tab = %rec.tab, "recorded tab's session closed; frame polling stops");
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
    run_watched(command, timeout, || Ok(()))
}

/// [`run_with_deadline`], also stopped when `interrupt` fails; it is called
/// every few dozen milliseconds while the process runs.
fn run_watched(
    command: &mut Command,
    timeout: Duration,
    interrupt: impl FnMut() -> AppResult<()>,
) -> AppResult<Output> {
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
        interrupt,
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
    let Ok(out) = run_with_deadline(Command::new(ffmpeg).args(args), PROBE_LIMIT) else {
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

/// Start ffmpeg capturing one microphone into `path` until told to quit, or
/// for `seconds` at most: a capture Dive can no longer stop (it crashed) must
/// not hold the microphone open for ever.
fn spawn_mic(mic: &str, seconds: f64, path: &Path) -> AppResult<Child> {
    let ffmpeg = ffmpeg_path().ok_or_else(|| AppError::new("ffmpeg not found"))?;
    let mut cmd = Command::new(ffmpeg);
    cmd.args(["-hide_banner", "-loglevel", "error", "-y"]);
    #[cfg(target_os = "macos")]
    cmd.args(["-f", "avfoundation", "-i", &format!(":{mic}")]);
    #[cfg(not(target_os = "macos"))]
    cmd.args(["-f", "pulse", "-i", mic]);
    cmd.args(["-ac", "1", "-ar", "48000", "-t", &format!("{seconds:.1}")])
        .arg(path)
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    cmd.spawn().map_err(AppError::new)
}

/// Start ffmpeg capturing the window's rectangle of its display (pointer
/// included), with the microphone in the same stream, until told to quit or
/// for `seconds` at most.
fn spawn_screen(
    rect: WindowRect,
    mic: Option<&str>,
    fps: u32,
    seconds: f64,
    path: &Path,
) -> AppResult<Child> {
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
    cmd.args(["-t", &format!("{seconds:.1}")])
        .arg(path)
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    cmd.spawn().map_err(AppError::new)
}

/// Displays ffmpeg can capture, by device id, in display order.
fn list_screens(ffmpeg: &Path) -> Vec<String> {
    #[cfg(target_os = "macos")]
    {
        let Ok(out) = run_with_deadline(
            Command::new(ffmpeg).args([
                "-hide_banner",
                "-f",
                "avfoundation",
                "-list_devices",
                "true",
                "-i",
                "",
            ]),
            PROBE_LIMIT,
        ) else {
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

/// What a save checks while it works: whether the person stopped it, and
/// how far it has got, which the chrome shows. Every pass runs under the
/// same deadline as any other ffmpeg run; the encoders used to wait on
/// ffmpeg with no limit at all, and a stuck one held "Saving…" for good.
struct Watch<'a> {
    rec: &'a Recording,
    /// Seconds of media being written, to turn ffmpeg's position into a share.
    total: f64,
}

impl<'a> Watch<'a> {
    fn new(rec: &'a Recording, total: f64) -> Self {
        Self { rec, total }
    }

    /// Fails once the person has stopped the save.
    fn check(&self) -> AppResult<()> {
        if self.rec.cancel_save.load(Ordering::SeqCst) {
            Err(AppError::new(SAVE_STOPPED))
        } else {
            Ok(())
        }
    }

    /// Tell the chrome that `share` of the save is done.
    fn report(&self, share: f64) {
        self.rec.emit(&RecordingEvent {
            progress: Some(share.clamp(0.0, 1.0)),
            ..RecordingEvent::new(self.rec.tab, "progress")
        });
    }

    /// Where ffmpeg writes its position during a pass.
    fn progress_file(&self) -> PathBuf {
        self.rec.dir.join("progress.txt")
    }

    /// An ffmpeg command for one pass; with `report`, ffmpeg writes its
    /// position where [`Watch::run`] reads it.
    fn command(&self, ffmpeg: &Path, report: bool) -> Command {
        let mut cmd = Command::new(ffmpeg);
        cmd.args(["-hide_banner", "-loglevel", "error", "-y"]);
        if report {
            let file = self.progress_file();
            let _ = std::fs::remove_file(&file);
            cmd.arg("-nostats").arg("-progress").arg(file);
        }
        cmd
    }

    /// Run one pass. `span` is the share of the whole save it stands for,
    /// from and to, when its command was made with `report`.
    fn run(&self, cmd: &mut Command, span: Option<(f64, f64)>) -> AppResult<Output> {
        let file = self.progress_file();
        let mut last = Instant::now();
        run_watched(cmd, PROCESS_LIMIT, || {
            self.check()?;
            if let Some((from, to)) = span
                && self.total > 0.0
                && last.elapsed() >= Duration::from_millis(400)
            {
                last = Instant::now();
                if let Some(at) = read_progress(&file) {
                    self.report(from + (to - from) * (at / self.total).clamp(0.0, 1.0));
                }
            }
            Ok(())
        })
    }

    /// [`Watch::run`], turning ffmpeg's failure into a message about `what`.
    fn run_ok(&self, cmd: &mut Command, span: Option<(f64, f64)>, what: &str) -> AppResult<()> {
        let out = self.run(cmd, span)?;
        if out.status.success() {
            return Ok(());
        }
        let err = String::from_utf8_lossy(&out.stderr);
        Err(AppError::new(format!(
            "ffmpeg could not encode {what}: {}",
            err.lines().last().unwrap_or("unknown error")
        )))
    }
}

/// The last position ffmpeg wrote to its progress file, in seconds.
fn read_progress(file: &Path) -> Option<f64> {
    use std::io::{Read as _, Seek as _, SeekFrom};
    let mut f = File::open(file).ok()?;
    let len = f.metadata().ok()?.len();
    f.seek(SeekFrom::Start(len.saturating_sub(1024))).ok()?;
    let mut tail = Vec::new();
    f.read_to_end(&mut tail).ok()?;
    progress_seconds(&String::from_utf8_lossy(&tail))
}

/// The newest `out_time_us` in ffmpeg's `-progress` output, in seconds.
/// Early blocks say `N/A`, and `out_time_ms` is microseconds too despite
/// its name.
fn progress_seconds(text: &str) -> Option<f64> {
    text.lines().rev().find_map(|line| {
        let value = line
            .strip_prefix("out_time_us=")
            .or_else(|| line.strip_prefix("out_time_ms="))?;
        let micros: i64 = value.trim().parse().ok()?;
        #[allow(clippy::cast_precision_loss)] // Microseconds of a ten-minute cap.
        (micros >= 0).then(|| micros as f64 / 1_000_000.0)
    })
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
    watch: &Watch<'_>,
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
    let mut cmd = watch.command(&ffmpeg, false);
    cmd.args(["-f", "concat", "-safe", "0", "-i"])
        .arg(&list)
        .args(["-c", "copy", "-movflags", "+faststart"])
        .arg(&joined);
    watch.run_ok(&mut cmd, None, "the recording")?;
    let has_audio = options.microphone.is_some();
    let max_width = options.max_width.clamp(320, 3840);
    if options.is_gif() {
        let path = dir.join(format!("{stem}.gif"));
        let filter = format!(
            "scale='min({GIF_WIDTH},iw)':-2:flags=lanczos,split[a][b];[a]palettegen=max_colors=200:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle"
        );
        let mut cmd = watch.command(&ffmpeg, true);
        cmd.arg("-i")
            .arg(&joined)
            .args(["-filter_complex", &filter, "-loop", "0"])
            .arg(&path);
        watch.run_ok(&mut cmd, Some((0.0, 1.0)), "the GIF")?;
        let (w, h) = probe_size(&path).unwrap_or((0, 0));
        return finish(&path, "gif", duration, w, h, 0, false);
    }
    let path = dir.join(format!("{stem}.mp4"));
    let preview_dir = dir.join(PREVIEW_DIR);
    std::fs::create_dir_all(&preview_dir)?;
    let preview = preview_dir.join(format!("{stem}.webm"));
    let mut cmd = watch.command(&ffmpeg, true);
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
    watch.run_ok(&mut cmd, Some((0.0, 0.9)), "the recording")?;
    let (w, h) = probe_size(&path).unwrap_or((0, 0));
    let mut result = finish(&path, "mp4", duration, w, h, 0, has_audio)?;
    result.preview = companion(&path, &preview, max_width, has_audio, || watch.check());
    watch.check()?;
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
    companion(mp4, out, max_width, with_audio, || Ok(()))
}

/// [`write_companion`], given up when `interrupt` fails.
fn companion(
    mp4: &Path,
    out: &Path,
    max_width: u32,
    with_audio: bool,
    interrupt: impl FnMut() -> AppResult<()>,
) -> Option<String> {
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
    let ok = run_watched(&mut cmd, PROCESS_LIMIT, interrupt).is_ok_and(|o| o.status.success());
    (ok && out.exists()).then(|| out.to_string_lossy().into_owned())
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
    watch: &Watch<'_>,
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
    let mut cmd = watch.command(&ffmpeg, true);
    cmd.args(["-f", "concat", "-safe", "0", "-r", &fps.to_string(), "-i"])
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
        // Cut at the picture's length rather than the shorter stream's:
        // `-shortest` cut the video short wherever the sound ended early,
        // as it does when a microphone is lost partway through.
        cmd.args(["-c:a", "aac", "-b:a", "128k", "-t", &format!("{end:.3}")]);
    } else {
        cmd.arg("-an");
    }
    cmd.arg(&path);
    watch.run_ok(&mut cmd, Some((0.0, 0.9)), "the recording")?;
    let (width, height) = probe_size(&path).unwrap_or_else(|| {
        decode(&std::fs::read(&frames[0].path).unwrap_or_default())
            .map_or((0, 0), |i| (i.width().min(max_width), i.height()))
    });
    let mut result = finish(&path, "mp4", end, width, height, frames.len(), with_audio)?;
    result.preview = companion(&path, &preview, max_width, with_audio, || watch.check());
    watch.check()?;
    Ok(result)
}

/// Ask ffprobe (beside ffmpeg) for the picture size of the finished file.
fn probe_size(path: &Path) -> Option<(u32, u32)> {
    let probe = ffmpeg_path()?.with_file_name("ffprobe");
    let mut cmd = Command::new(probe);
    cmd.args([
        "-v",
        "error",
        "-select_streams",
        "v:0",
        "-show_entries",
        "stream=width,height",
        "-of",
        "csv=p=0",
    ])
    .arg(path);
    let out = run_with_deadline(&mut cmd, PROBE_LIMIT).ok()?;
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
    watch: &Watch<'_>,
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
    let mut cmd = watch.command(&ffmpeg, true);
    cmd.args([
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
    .arg(&path);
    watch.run_ok(&mut cmd, Some((0.0, 1.0)), "the GIF")?;
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
fn encode_gif(
    frames: &[Frame],
    dir: &Path,
    end: f64,
    stem: &str,
    watch: &Watch<'_>,
) -> AppResult<RecordingResult> {
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

    let mut reported = Instant::now();
    for (i, frame) in frames.iter().enumerate() {
        watch.check()?;
        if reported.elapsed() >= Duration::from_millis(400) {
            reported = Instant::now();
            #[allow(clippy::cast_precision_loss)] // A few thousand frames at most.
            watch.report(i as f64 / frames.len() as f64);
        }
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
    fn stale_work_directories_go_and_everything_else_stays() {
        let dir = std::env::temp_dir().join(format!("dive-sweep-{}", TabId::new()));
        let work = dir.join(format!("{WORK_DIR_PREFIX}2026-09-27T01-02-03Z"));
        std::fs::create_dir_all(&work).unwrap();
        std::fs::write(work.join("f000000.jpg"), b"jpeg").unwrap();
        std::fs::create_dir_all(dir.join(PREVIEW_DIR)).unwrap();
        std::fs::write(dir.join("page recording.mp4"), b"mp4").unwrap();
        // A file that only looks like a work directory is not one.
        std::fs::write(dir.join(format!("{WORK_DIR_PREFIX}note")), b"x").unwrap();

        // Fresh: a recording may still be writing into it.
        assert_eq!(sweep_work_dirs(&dir, STALE_WORK_DIR), 0);
        assert!(work.exists());

        assert_eq!(sweep_work_dirs(&dir, Duration::ZERO), 1);
        assert!(!work.exists());
        assert!(dir.join(PREVIEW_DIR).exists());
        assert!(dir.join("page recording.mp4").exists());
        assert!(dir.join(format!("{WORK_DIR_PREFIX}note")).exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn capture_processes_are_told_the_rest_of_the_cap() {
        assert!((capture_budget(600, 0.0) - (600.0 + CAPTURE_SLACK_SECONDS)).abs() < 1e-9);
        assert!((capture_budget(60, 45.5) - (14.5 + CAPTURE_SLACK_SECONDS)).abs() < 1e-9);
        // Past the cap a resumed segment still gets a moment, never a
        // negative length ffmpeg would refuse.
        assert!((capture_budget(60, 75.0) - CAPTURE_SLACK_SECONDS).abs() < 1e-9);
    }

    #[test]
    fn progress_reads_the_newest_position() {
        let text = "frame=10\nout_time_us=N/A\nprogress=continue\n\
            frame=40\nout_time_us=1500000\nout_time_ms=1500000\nprogress=continue\n\
            frame=90\nout_time_ms=3250000\nout_time_us=N/A\nprogress=end\n";
        assert_eq!(progress_seconds(text), Some(3.25));
        assert_eq!(progress_seconds("out_time_us=N/A\n"), None);
        assert_eq!(progress_seconds("out_time_us=-5\n"), None);
        assert_eq!(progress_seconds(""), None);
    }

    #[test]
    fn a_second_recording_of_a_page_announces_its_viewport_again() {
        // The early return for an already-installed tracker must still send
        // the viewport, which the sidecar cannot be written without.
        let known = TRACK_SCRIPT
            .lines()
            .find(|l| l.contains("if (known)"))
            .expect("the script handles a tracker already in the page");
        assert!(known.contains("known.live = true"), "{known}");
        assert!(known.contains("known.send(viewport())"), "{known}");
        assert!(UNTRACK_SCRIPT.contains("live = false"));
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
