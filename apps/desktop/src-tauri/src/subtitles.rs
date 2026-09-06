//! Live subtitles: tap a playing video's audio in the page, transcribe it
//! locally with whisper.cpp, and stream caption cues back for an overlay.
//!
//! The page (`inject/subtitles.js`) taps the `<video>` element through the
//! Web Audio API, downsamples to `16 kHz` mono, and posts PCM frames over a
//! `DevTools` binding. The model runs entirely on the machine; a chosen model
//! is downloaded on demand into the app data directory. Cloud transcription
//! is a planned future backend behind the same command surface.

// Byte counts become f64 for the download-progress event (specta forbids
// u64). At a model download's scale they never approach f64's 52-bit mantissa,
// so the precision-loss lint does not apply.
#![allow(clippy::cast_precision_loss)]

use std::collections::{HashMap, VecDeque};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use base64::Engine as _;
use dive_cdp::CdpSession;
use dive_core::TabId;
use futures_util::StreamExt as _;
use serde::{Deserialize, Serialize};
use serde_json::json;
use sha2::{Digest, Sha256};
use specta::Type;
use tauri::{AppHandle, Manager};
use tauri_specta::Event;

use crate::Runtime;
use crate::state::AppState;

/// The binding the page calls with base64 PCM frames.
const AUDIO_BINDING: &str = "__diveSubtitleAudio";
static NEXT_SESSION: AtomicU64 = AtomicU64::new(1);
static MODEL_DOWNLOAD_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
/// How long a model download may take to connect.
const MODEL_CONNECT_TIMEOUT: Duration = Duration::from_secs(20);
/// Longest silence tolerated between chunks of a model download.
const MODEL_READ_TIMEOUT: Duration = Duration::from_secs(60);
/// Sample rate whisper expects; the page downsamples to this.
const SAMPLE_RATE: usize = 16_000;
/// Seconds of audio each transcription pass looks at. Smaller means the
/// newest words appear sooner and each pass is cheaper; too small loses the
/// context whisper needs for accuracy. `DIVE_SUBTITLE_WINDOW_SECS` overrides.
const WINDOW_SECS: usize = 5;
/// How often a pass runs; the dominant source of caption latency after
/// inference time. `DIVE_SUBTITLE_STEP_SECS` overrides.
const STEP_SECS: f64 = 0.8;
/// Longest audio kept in the ring, so a tab left running does not grow forever.
const MAX_BUFFER_SECS: usize = 8;

/// Read a positive number from `key`, or use `default`.
fn env_num<T: std::str::FromStr + PartialOrd + Copy>(key: &str, default: T, min: T) -> T {
    std::env::var(key)
        .ok()
        .and_then(|v| v.trim().parse::<T>().ok())
        .filter(|v| *v >= min)
        .unwrap_or(default)
}

/// A downloadable whisper model.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct SubtitleModel {
    /// Stable id used in commands and the file name.
    pub id: String,
    /// Human label for the picker.
    pub label: String,
    /// A one-line note on the speed/accuracy trade.
    pub detail: String,
    /// Approximate download size in megabytes.
    pub size_mb: u32,
    /// Whether the file is already on disk.
    pub downloaded: bool,
}

/// The models Dive offers, newest-friendly first. All are multilingual
/// (~99 languages including English, Japanese and Tagalog); the English-only
/// variants are deliberately omitted so language choice always works.
const MODELS: &[(&str, &str, &str, u32, &str)] = &[
    (
        "tiny",
        "Tiny",
        "Fastest and lowest latency. Good for clear English; less accurate.",
        78,
        "ggml-tiny.bin",
    ),
    (
        "base",
        "Base",
        "Fast, light, good for clear speech. Recommended to start.",
        148,
        "ggml-base.bin",
    ),
    (
        "small",
        "Small",
        "More accurate, a little slower. Better for accents and noise.",
        488,
        "ggml-small.bin",
    ),
    (
        "medium",
        "Medium",
        "Most accurate offered, noticeably heavier on the machine.",
        1533,
        "ggml-medium.bin",
    ),
];

/// Where model files live.
fn models_dir() -> PathBuf {
    crate::state::data_root().join("models")
}

fn model_file(id: &str) -> Option<PathBuf> {
    MODELS
        .iter()
        .find(|(mid, ..)| *mid == id)
        .map(|(_, _, _, _, file)| models_dir().join(file))
}

/// The download URL for a model on the whisper.cpp model host.
fn model_url(id: &str) -> Option<String> {
    MODELS
        .iter()
        .find(|(mid, ..)| *mid == id)
        .map(|(_, _, _, _, file)| {
            format!("https://huggingface.co/ggerganov/whisper.cpp/resolve/main/{file}")
        })
}

// Pinned SHA-256/LFS sizes from the upstream multilingual whisper.cpp models.
fn model_integrity(id: &str) -> Option<(u64, &'static str)> {
    Some(match id {
        "tiny" => (
            77_691_713,
            "be07e048e1e599ad46341c8d2a135645097a538221678b7acdd1b1919c6e1b21",
        ),
        "base" => (
            147_951_465,
            "60ed5bc3dd14eea856493d334349b405782ddcaf0028d4b5df4088345fba2efe",
        ),
        "small" => (
            487_601_967,
            "1be3a9b2063867b937e64e2ec7483364a79917e157fa98c5d94b5c1fffea987b",
        ),
        "medium" => (
            1_533_763_059,
            "6c14d5adee5f86394037b4e4e8b59f1673b6cee10e3cf0b11bbdbee79c156208",
        ),
        _ => return None,
    })
}

fn verify_model(path: &std::path::Path, id: &str) -> Result<(), String> {
    use std::io::Read as _;
    let (size, digest) = model_integrity(id).ok_or("Unknown model")?;
    let mut file = std::fs::File::open(path).map_err(|e| e.to_string())?;
    if file.metadata().map_err(|e| e.to_string())?.len() != size {
        return Err("Model download is incomplete. Download the model again.".into());
    }
    let mut hash = Sha256::new();
    let mut buffer = vec![0; 1024 * 1024];
    loop {
        let count = file.read(&mut buffer).map_err(|e| e.to_string())?;
        if count == 0 {
            break;
        }
        hash.update(&buffer[..count]);
    }
    if format!("{:x}", hash.finalize()) != digest {
        return Err("Model checksum failed. Download the model again.".into());
    }
    Ok(())
}

/// The catalog, each flagged with whether it is already downloaded.
#[must_use]
pub fn models() -> Vec<SubtitleModel> {
    MODELS
        .iter()
        .map(|(id, label, detail, size_mb, file)| SubtitleModel {
            id: (*id).to_owned(),
            label: (*label).to_owned(),
            detail: (*detail).to_owned(),
            size_mb: *size_mb,
            downloaded: model_integrity(id).is_some_and(|(size, _)| {
                models_dir()
                    .join(file)
                    .metadata()
                    .is_ok_and(|m| m.len() == size)
            }),
        })
        .collect()
}

/// Progress of a model download.
#[derive(Debug, Clone, Serialize, Deserialize, Type, Event)]
pub struct SubtitleModelProgress {
    /// Model id.
    pub id: String,
    /// Bytes received so far.
    pub received: f64,
    /// Total bytes, when the server reported a length.
    pub total: Option<f64>,
    /// Set when the file is fully written and verified.
    pub done: bool,
    /// A human message when the download failed.
    pub error: Option<String>,
}

/// Download `id` into the models directory, emitting progress. Skips work if
/// the file is already present and non-empty.
pub async fn download_model(app: &AppHandle<Runtime>, id: &str) -> Result<(), String> {
    let _download = MODEL_DOWNLOAD_LOCK.lock().await;
    let Some(dest) = model_file(id) else {
        return Err(format!("unknown model {id}"));
    };
    let existing = dest.clone();
    let model_id = id.to_owned();
    if tokio::task::spawn_blocking(move || verify_model(&existing, &model_id))
        .await
        .is_ok_and(|r| r.is_ok())
    {
        let _ = SubtitleModelProgress {
            id: id.to_owned(),
            received: dest.metadata().map_or(0.0, |m| m.len() as f64),
            total: None,
            done: true,
            error: None,
        }
        .emit(app);
        return Ok(());
    }
    let url = model_url(id).ok_or_else(|| format!("unknown model {id}"))?;
    tokio::fs::create_dir_all(models_dir())
        .await
        .map_err(|e| e.to_string())?;

    // Write to a temp file, then rename, so a half-download is never mistaken
    // for a usable model. Whatever fails, the temp file does not outlive the
    // attempt.
    let tmp = dest.with_extension("part");
    let outcome = fetch_model_to(app, id, &url, &tmp, &dest).await;
    if outcome.is_err() {
        let _ = tokio::fs::remove_file(&tmp).await;
    }
    outcome
}

/// Stream `url` into `tmp`, verify it, and move it to `dest`. Progress is
/// emitted while it runs and once at the end.
async fn fetch_model_to(
    app: &AppHandle<Runtime>,
    id: &str,
    url: &str,
    tmp: &std::path::Path,
    dest: &std::path::Path,
) -> Result<(), String> {
    use tokio::io::AsyncWriteExt as _;

    let client = reqwest::Client::builder()
        .connect_timeout(MODEL_CONNECT_TIMEOUT)
        .read_timeout(MODEL_READ_TIMEOUT)
        .build()
        .map_err(|e| format!("download client: {e}"))?;
    let resp = client
        .get(url)
        .send()
        .await
        .and_then(reqwest::Response::error_for_status)
        .map_err(|e| format!("download failed: {e}"))?;
    let total = resp.content_length().map(|n| n as f64);

    let mut file = tokio::fs::File::create(tmp)
        .await
        .map_err(|e| e.to_string())?;
    let mut received: f64 = 0.0;
    let mut hash = Sha256::new();
    let mut last_emit = std::time::Instant::now();
    let mut stream = resp.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| format!("download interrupted: {e}"))?;
        file.write_all(&chunk).await.map_err(|e| e.to_string())?;
        hash.update(&chunk);
        received += chunk.len() as f64;
        if last_emit.elapsed().as_millis() > 200 {
            last_emit = std::time::Instant::now();
            let _ = SubtitleModelProgress {
                id: id.to_owned(),
                received,
                total,
                done: false,
                error: None,
            }
            .emit(app);
        }
    }
    file.flush().await.map_err(|e| e.to_string())?;
    file.sync_all().await.map_err(|e| e.to_string())?;
    drop(file);
    let (expected_size, expected_hash) = model_integrity(id).ok_or("Unknown model")?;
    let written = tokio::fs::metadata(tmp)
        .await
        .map_err(|e| e.to_string())?
        .len();
    if written != expected_size || format!("{:x}", hash.finalize()) != expected_hash {
        return Err("Model download failed integrity verification. Please retry.".into());
    }
    tokio::fs::rename(tmp, dest)
        .await
        .map_err(|e| e.to_string())?;
    let _ = SubtitleModelProgress {
        id: id.to_owned(),
        received,
        total,
        done: true,
        error: None,
    }
    .emit(app);
    Ok(())
}

/// A caption line for the overlay.
#[derive(Debug, Clone, Serialize, Deserialize, Type, Event)]
pub struct SubtitleCue {
    /// Tab the caption belongs to.
    pub tab_id: TabId,
    /// The transcribed (or translated) text.
    pub text: String,
    /// Language the model detected or was told to use.
    pub language: String,
    /// True once the line is stable and will not be revised.
    pub is_final: bool,
}

/// Whether subtitles are running on a tab, with any error.
#[derive(Debug, Clone, Serialize, Deserialize, Type, Event)]
pub struct SubtitleState {
    /// The tab.
    pub tab_id: TabId,
    /// Running or stopped.
    pub active: bool,
    /// A human message when it could not start or stay running.
    pub error: Option<String>,
}

/// One running transcription session; dropping the sender stops the worker.
struct Session {
    stop: Arc<AtomicBool>,
    binding: String,
    cdp: CdpSession,
}

/// Sessions by tab.
#[derive(Default)]
pub struct Registry {
    inner: Mutex<HashMap<TabId, Session>>,
    setup: tokio::sync::Mutex<()>,
}

impl Registry {
    fn take(&self, tab: TabId, binding: Option<&str>) -> Option<Session> {
        let mut sessions = self
            .inner
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if binding.is_some_and(|id| sessions.get(&tab).is_none_or(|s| s.binding != id)) {
            return None;
        }
        let session = sessions.remove(&tab)?;
        session.stop.store(true, Ordering::SeqCst);
        Some(session)
    }

    fn is_running(&self, tab: TabId) -> bool {
        self.inner
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .contains_key(&tab)
    }
}

/// Bounded latest-audio mailbox. The renderer can never queue arbitrary audio
/// while the worker is loading or decoding. Epoch changes invalidate inference.
struct AudioInput {
    samples: VecDeque<f32>,
    epoch: u64,
    sequence: u64,
    last_audio: Instant,
    status: String,
    error: Option<String>,
    ended: bool,
}

impl Default for AudioInput {
    fn default() -> Self {
        Self {
            samples: VecDeque::new(),
            epoch: 0,
            sequence: 0,
            last_audio: Instant::now(),
            status: String::new(),
            error: None,
            ended: false,
        }
    }
}

impl AudioInput {
    /// Keep an utterance's start fixed while revising it. End at a quiet gap
    /// or the window budget, retaining 250 ms of overlap at a hard boundary.
    fn window(&mut self, seconds: usize) -> Option<(Vec<f32>, bool)> {
        if self.samples.len() < SAMPLE_RATE {
            return None;
        }
        let audio: Vec<_> = self.samples.iter().copied().collect();
        if !has_speech(&audio) {
            let excess = self.samples.len().saturating_sub(SAMPLE_RATE / 4);
            self.samples.drain(..excess);
            return None;
        }
        let quiet = !has_speech(&audio[audio.len().saturating_sub(SAMPLE_RATE * 4 / 5)..]);
        let final_pass = quiet || audio.len() >= SAMPLE_RATE * seconds;
        if final_pass {
            let keep = if quiet { 0 } else { SAMPLE_RATE / 4 };
            self.samples
                .drain(..self.samples.len().saturating_sub(keep));
        }
        Some((audio, final_pass))
    }

    fn reset(&mut self, epoch: u64) {
        self.samples.clear();
        self.epoch = epoch;
        self.sequence += 1;
        self.last_audio = Instant::now();
    }

    fn append(&mut self, epoch: u64, samples: &[f32]) {
        if epoch < self.epoch {
            return;
        }
        if epoch != self.epoch {
            self.reset(epoch);
        }
        self.samples.extend(samples);
        let excess = self
            .samples
            .len()
            .saturating_sub(SAMPLE_RATE * MAX_BUFFER_SECS);
        self.samples.drain(..excess);
        self.sequence += 1;
        self.last_audio = Instant::now();
    }
}

/// Agreement between successive passes stabilizes words while the last words
/// remain revisable. A final pass may correct the complete utterance.
#[derive(Default)]
struct CaptionTracker {
    previous: Vec<String>,
    confirmed: Vec<String>,
    last_final: Vec<String>,
}

impl CaptionTracker {
    fn update(&mut self, text: &str, final_pass: bool) -> String {
        if matches!(
            text.trim().to_ascii_lowercase().as_str(),
            "[blank_audio]"
                | "[silence]"
                | "(silence)"
                | "[music]"
                | "(music)"
                | "[applause]"
                | "(applause)"
                | "[laughter]"
                | "(laughter)"
        ) {
            if final_pass {
                *self = Self::default();
            }
            return String::new();
        }
        let mut words: Vec<String> = text.split_whitespace().map(str::to_owned).collect();
        // Remove only the short audio overlap from the previous utterance.
        let overlap = (1..=3.min(words.len()).min(self.last_final.len()))
            .rev()
            .find(|&n| {
                self.last_final[self.last_final.len() - n..]
                    .iter()
                    .zip(&words[..n])
                    .all(|(a, b)| a.eq_ignore_ascii_case(b))
            })
            .unwrap_or(0);
        words.drain(..overlap);
        if final_pass {
            self.last_final.clone_from(&words);
            self.previous.clear();
            self.confirmed.clear();
            return caption_tail(&words.join(" "));
        }
        let agreed = self
            .previous
            .iter()
            .zip(&words)
            .take_while(|(a, b)| a == b)
            .count();
        if agreed > self.confirmed.len() {
            self.confirmed = words[..agreed].to_vec();
        }
        self.previous.clone_from(&words);
        let mut display = self.confirmed.clone();
        display.extend(words.into_iter().skip(display.len()));
        caption_tail(&display.join(" "))
    }
}

#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
enum AudioMessage {
    Audio { epoch: u64, pcm: String },
    Reset { epoch: u64 },
    State { epoch: u64, state: String },
    Error { error: String },
    Ended,
}

/// Start a single session, awaiting model load and successful tap installation.
/// Duplicate requests cannot launch competing models or page taps.
#[allow(clippy::too_many_lines)] // The worker's cancellation and publication share one lifecycle.
pub async fn start(
    app: AppHandle<Runtime>,
    tab: TabId,
    session: CdpSession,
    model_id: String,
    language: String,
    translate: bool,
) -> Result<(), String> {
    let path = model_file(&model_id)
        .filter(|p| p.is_file())
        .ok_or_else(|| format!("model {model_id} is not downloaded"))?;
    #[cfg(feature = "whisper")]
    if language != "auto" && whisper_rs::get_lang_id(&language).is_none() {
        return Err("Unsupported subtitle language".into());
    }
    let state = app.state::<AppState>();
    let _setup = state.subtitles.setup.lock().await;
    let stop = Arc::new(AtomicBool::new(false));
    let binding = format!(
        "{AUDIO_BINDING}_{}",
        NEXT_SESSION.fetch_add(1, Ordering::Relaxed)
    );
    {
        let mut sessions = state
            .subtitles
            .inner
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if sessions.contains_key(&tab) {
            return Err("Subtitles are already starting or running on this tab".into());
        }
        sessions.insert(
            tab,
            Session {
                stop: stop.clone(),
                binding: binding.clone(),
                cdp: session.clone(),
            },
        );
    }
    let loaded = tokio::task::spawn_blocking(move || {
        verify_model(&path, &model_id)?;
        load_context(&path)
    })
    .await
    .map_err(|e| format!("Model loader failed: {e}"))
    .and_then(|r| r);
    let mut ctx = match loaded {
        Ok(ctx) if !stop.load(Ordering::SeqCst) => ctx,
        Ok(_) => return Err("Subtitle start cancelled".into()),
        Err(e) => {
            finish(&app, tab, Some(&binding), Some(e.clone()));
            return Err(e);
        }
    };
    let input = Arc::new(Mutex::new(AudioInput::default()));
    // Subscribe before injection so even the first state/audio message is seen.
    route_audio(&session, binding.clone(), stop.clone(), input.clone());
    if let Err(e) = install_audio_tap(&session, &binding).await {
        finish(&app, tab, Some(&binding), Some(e.clone()));
        return Err(e);
    }
    if stop.load(Ordering::SeqCst) {
        cleanup_page(&session, &binding);
        return Err("Subtitle start cancelled".into());
    }
    let _ = SubtitleState {
        tab_id: tab,
        active: true,
        error: None,
    }
    .emit(&app);

    let app = app.clone();
    std::thread::spawn(move || {
        let window_secs = env_num("DIVE_SUBTITLE_WINDOW_SECS", WINDOW_SECS, 2).min(MAX_BUFFER_SECS);
        let step_secs = env_num("DIVE_SUBTITLE_STEP_SECS", STEP_SECS, 0.2);
        let pass_every = Duration::from_secs_f64(if step_secs.is_finite() {
            step_secs.min(5.0)
        } else {
            STEP_SECS
        });
        let mut next = Instant::now();
        let mut sequence = 0;
        let mut epoch = 0;
        let mut last_text = String::new();
        let mut last_status = String::new();
        let mut captions = CaptionTracker::default();
        let mut failures = 0;
        let mut final_error = None;
        while !stop.load(Ordering::SeqCst) {
            std::thread::sleep(Duration::from_millis(20));
            let (audio, current_epoch, final_pass, retained_overlap) = {
                let mut buffer = input
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner);
                if buffer.ended || buffer.error.is_some() {
                    final_error.clone_from(&buffer.error);
                    break;
                }
                if matches!(
                    buffer.status.as_str(),
                    "Listening…" | "Waiting for video audio…"
                ) && buffer.last_audio.elapsed() > Duration::from_secs(20)
                {
                    final_error =
                        Some("Audio capture stopped responding. Restart subtitles.".into());
                    break;
                }
                if buffer.status != last_status {
                    last_status.clone_from(&buffer.status);
                    let _ = SubtitleCue {
                        tab_id: tab,
                        text: last_status.clone(),
                        language: language.clone(),
                        is_final: false,
                    }
                    .emit(&app);
                }
                if epoch != buffer.epoch {
                    epoch = buffer.epoch;
                    last_text.clear();
                    captions = CaptionTracker::default();
                }
                // No fresh audio means no inference, even after a pause or teardown.
                if Instant::now() < next
                    || buffer.sequence == sequence
                    || buffer.samples.len() < SAMPLE_RATE
                {
                    continue;
                }
                sequence = buffer.sequence;
                let Some((audio, final_pass)) = buffer.window(window_secs) else {
                    continue;
                };
                (audio, epoch, final_pass, !buffer.samples.is_empty())
            };
            next = Instant::now() + pass_every;
            let began = Instant::now();
            let result = transcribe(&mut ctx, &audio, &language, translate);
            tracing::debug!(%tab, samples = audio.len(), inference_ms = began.elapsed().as_millis(), "subtitle inference");
            // Never publish a result after stopping, seeking, or changing source.
            let buffer = input
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            if stop.load(Ordering::SeqCst) || buffer.epoch != current_epoch || buffer.ended {
                continue;
            }
            match result {
                Ok((text, detected)) => {
                    failures = 0;
                    let text = captions.update(&text, final_pass);
                    if final_pass && !retained_overlap {
                        captions.last_final.clear();
                    }
                    if !text.is_empty() && (text != last_text || final_pass) {
                        last_text.clone_from(&text);
                        let _ = SubtitleCue {
                            tab_id: tab,
                            text: text.clone(),
                            language: detected,
                            is_final: final_pass,
                        }
                        .emit(&app);
                        push_caption(&session, &binding, current_epoch, &text);
                    }
                }
                Err(e) => {
                    failures += 1;
                    if failures >= 3 {
                        final_error = Some(format!("Transcription failed: {e}"));
                        break;
                    }
                }
            }
        }
        finish(&app, tab, Some(&binding), final_error);
    });
    Ok(())
}

fn has_speech(samples: &[f32]) -> bool {
    !samples.is_empty()
        && samples.iter().map(|v| v * v).sum::<f32>() / samples.len() as f32 > 0.000_004
}

/// Keep the overlay readable even when a model returns a long single segment.
fn caption_tail(text: &str) -> String {
    let words: Vec<_> = text.split_whitespace().collect();
    words[words.len().saturating_sub(24)..].join(" ")
}

fn cleanup_page(session: &CdpSession, binding: &str) {
    let session = session.clone();
    let binding = serde_json::to_string(binding).unwrap_or_default();
    tauri::async_runtime::spawn(async move {
        let _ = session.call("Runtime.evaluate", json!({"expression": format!(
            "if (window.__diveSubtitles?.binding === {binding}) window.__diveSubtitles.stop()"
        )})).await;
        let _ = session
            .call(
                "Runtime.removeBinding",
                json!({"name": serde_json::from_str::<String>(&binding).unwrap_or_default()}),
            )
            .await;
    });
}

fn finish(app: &AppHandle<Runtime>, tab: TabId, binding: Option<&str>, error: Option<String>) {
    if let Some(session) = app.state::<AppState>().subtitles.take(tab, binding) {
        cleanup_page(&session.cdp, &session.binding);
        let _ = SubtitleState {
            tab_id: tab,
            active: false,
            error,
        }
        .emit(app);
    }
}

/// Stop works even after the tab's `DevTools` session has been removed.
pub fn stop_tab(app: &AppHandle<Runtime>, tab: TabId) {
    finish(app, tab, None, None);
}

/// Whether a tab is starting or transcribing.
pub fn is_running(app: &AppHandle<Runtime>, tab: TabId) -> bool {
    app.state::<AppState>().subtitles.is_running(tab)
}

#[cfg(feature = "whisper")]
type LocalContext = whisper_rs::WhisperState;
#[cfg(not(feature = "whisper"))]
type LocalContext = ();

#[cfg(feature = "whisper")]
fn load_context(path: &std::path::Path) -> Result<LocalContext, String> {
    let ctx = whisper_rs::WhisperContext::new_with_params(
        &path.to_string_lossy(),
        whisper_rs::WhisperContextParameters::default(),
    )
    .map_err(|e| format!("could not load the model: {e}"))?;
    ctx.create_state()
        .map_err(|e| format!("could not create transcription state: {e}"))
}

#[cfg(feature = "whisper")]
fn transcribe(
    state: &mut LocalContext,
    audio: &[f32],
    language: &str,
    translate: bool,
) -> Result<(String, String), String> {
    use whisper_rs::{FullParams, SamplingStrategy};
    let mut params = FullParams::new(SamplingStrategy::Greedy { best_of: 1 });
    let threads =
        std::thread::available_parallelism().map_or(4, |n| (n.get().saturating_sub(2)).clamp(2, 8));
    params.set_n_threads(i32::try_from(threads).unwrap_or(4));
    params.set_single_segment(true);
    params.set_print_progress(false);
    params.set_print_realtime(false);
    params.set_print_special(false);
    params.set_print_timestamps(false);
    params.set_no_context(true);
    params.set_suppress_blank(true);
    params.set_suppress_nst(true);
    // Explicit None requests detection; leaving the default selects English.
    params.set_language(if language == "auto" {
        None
    } else {
        Some(language)
    });
    params.set_translate(translate);
    state.full(params, audio).map_err(|e| e.to_string())?;
    let n = state.full_n_segments().map_err(|e| e.to_string())?;
    let mut text = String::new();
    for i in 0..n {
        let seg = state.full_get_segment_text(i).map_err(|e| e.to_string())?;
        text.push_str(seg.trim());
        text.push(' ');
    }
    let detected = state
        .full_lang_id_from_state()
        .ok()
        .and_then(whisper_rs::get_lang_str)
        .unwrap_or(language);
    Ok((text.trim().to_owned(), detected.to_owned()))
}

#[cfg(not(feature = "whisper"))]
fn load_context(_path: &std::path::Path) -> Result<LocalContext, String> {
    Err("this build was compiled without the local transcription engine".into())
}

#[cfg(not(feature = "whisper"))]
fn transcribe(
    _ctx: &mut LocalContext,
    _audio: &[f32],
    _language: &str,
    _translate: bool,
) -> Result<(String, String), String> {
    Err("no transcription engine".into())
}

async fn install_audio_tap(session: &CdpSession, binding: &str) -> Result<(), String> {
    let script =
        crate::pagescript::build("subtitles.js", &[("__AUDIO_BINDING__", binding.to_owned())]);
    session
        .call("Runtime.enable", json!({}))
        .await
        .map_err(|e| e.to_string())?;
    session
        .call("Runtime.addBinding", json!({"name": binding}))
        .await
        .map_err(|e| e.to_string())?;
    let result = session
        .call(
            "Runtime.evaluate",
            json!({"expression": script, "returnByValue": true}),
        )
        .await
        .map_err(|e| format!("could not start the audio tap: {e}"))?;
    if result["result"]["value"]["ok"] == true {
        Ok(())
    } else {
        Err(result["result"]["value"]["error"]
            .as_str()
            .or_else(|| result["exceptionDetails"]["text"].as_str())
            .unwrap_or("Could not capture this video's audio")
            .to_owned())
    }
}

fn route_audio(
    session: &CdpSession,
    binding: String,
    stop: Arc<AtomicBool>,
    input: Arc<Mutex<AudioInput>>,
) {
    let session = session.clone();
    let mut events = session.subscribe();
    tauri::async_runtime::spawn(async move {
        while !stop.load(Ordering::SeqCst) {
            if session.is_closed() {
                input
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner)
                    .ended = true;
                break;
            }
            let event = match tokio::time::timeout(Duration::from_millis(500), events.recv()).await
            {
                Err(_) => continue,
                Ok(Ok(event)) => event,
                Ok(Err(tokio::sync::broadcast::error::RecvError::Lagged(n))) => {
                    // A burst of unrelated CDP events overflowed the buffer;
                    // a few lost audio frames are a hiccup, not a lost session.
                    tracing::debug!(n, "subtitle audio listener lagged; continuing");
                    continue;
                }
                Ok(Err(tokio::sync::broadcast::error::RecvError::Closed)) => {
                    input
                        .lock()
                        .unwrap_or_else(std::sync::PoisonError::into_inner)
                        .error =
                        Some("Audio connection was interrupted. Restart subtitles.".into());
                    break;
                }
            };
            if matches!(
                event.method.as_str(),
                "Runtime.executionContextsCleared"
                    | "Inspector.detached"
                    | "Inspector.targetCrashed"
            ) {
                input
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner)
                    .ended = true;
                break;
            }
            if event.method != "Runtime.bindingCalled"
                || event.params["name"].as_str() != Some(&binding)
            {
                continue;
            }
            let Some(payload) = event.params["payload"].as_str().filter(|p| p.len() <= 8192) else {
                continue;
            };
            let Ok(message) = serde_json::from_str::<AudioMessage>(payload) else {
                continue;
            };
            let mut buffer = input
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            match message {
                AudioMessage::Audio { epoch, pcm } => {
                    if let Some(samples) = decode_pcm(&pcm) {
                        buffer.append(epoch, &samples);
                    }
                }
                AudioMessage::Reset { epoch } if epoch >= buffer.epoch => buffer.reset(epoch),
                AudioMessage::State { epoch, state } if epoch >= buffer.epoch => {
                    if epoch != buffer.epoch {
                        buffer.reset(epoch);
                    }
                    buffer.status = state.chars().take(200).collect();
                }
                AudioMessage::Error { error } => {
                    buffer.error = Some(error.chars().take(500).collect());
                }
                AudioMessage::Ended => buffer.ended = true,
                _ => {}
            }
        }
    });
}

/// Decode base64 little-endian Int16 PCM into normalized f32 samples.
fn decode_pcm(b64: &str) -> Option<Vec<f32>> {
    if b64.is_empty() || b64.len() > 8192 {
        return None;
    }
    let bytes = base64::engine::general_purpose::STANDARD.decode(b64).ok()?;
    if bytes.len() % 2 != 0 {
        return None;
    }
    let (pairs, _) = bytes.as_chunks::<2>();
    Some(
        pairs
            .iter()
            .map(|c| f32::from(i16::from_le_bytes(*c)) / 32768.0)
            .collect(),
    )
}

/// Push a caption line into the page overlay.
fn push_caption(session: &CdpSession, binding: &str, epoch: u64, text: &str) {
    let expr = format!(
        "if (window.__diveSubtitles?.binding === {}) window.__diveSubtitles.show({}, {epoch})",
        serde_json::to_string(binding).unwrap_or_default(),
        serde_json::to_string(text).unwrap_or_else(|_| "\"\"".into())
    );
    let s = session.clone();
    tauri::async_runtime::spawn(async move {
        let _ = s
            .call("Runtime.evaluate", json!({"expression": expr}))
            .await;
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn closed_cdp_ends_a_paused_audio_route() {
        struct Disconnected;
        impl dive_cdp::Transport for Disconnected {
            fn send(&self, _: &str) -> Result<(), dive_cdp::CdpError> {
                Err(dive_cdp::CdpError::Closed)
            }
        }
        let session = CdpSession::new(Disconnected);
        let input = Arc::new(Mutex::new(AudioInput::default()));
        route_audio(
            &session,
            "test".into(),
            Arc::new(AtomicBool::new(false)),
            input.clone(),
        );
        session.close();
        tokio::time::sleep(Duration::from_millis(600)).await;
        assert!(
            input.lock().unwrap().ended,
            "closed tabs must release even paused models"
        );
    }

    #[test]
    fn old_session_cleanup_cannot_remove_a_new_session() {
        struct Disconnected;
        impl dive_cdp::Transport for Disconnected {
            fn send(&self, _: &str) -> Result<(), dive_cdp::CdpError> {
                Err(dive_cdp::CdpError::Closed)
            }
        }
        let registry = Registry::default();
        let tab = TabId::new();
        let flag = Arc::new(AtomicBool::new(false));
        registry.inner.lock().unwrap().insert(
            tab,
            Session {
                stop: flag.clone(),
                binding: "new-session".into(),
                cdp: CdpSession::new(Disconnected),
            },
        );
        assert!(registry.take(tab, Some("old-session")).is_none());
        assert!(!flag.load(Ordering::SeqCst));
        assert!(registry.is_running(tab));
        assert!(registry.take(tab, Some("new-session")).is_some());
        assert!(flag.load(Ordering::SeqCst));
        assert!(!registry.is_running(tab));
    }

    #[test]
    fn audio_mailbox_is_bounded_and_seek_drops_old_audio() {
        let mut input = AudioInput::default();
        input.append(0, &vec![0.25; SAMPLE_RATE * 20]);
        assert_eq!(input.samples.len(), SAMPLE_RATE * MAX_BUFFER_SECS);
        input.reset(1);
        input.append(0, &[0.5; 100]);
        assert!(input.samples.is_empty());
        input.append(1, &[0.1; 100]);
        assert_eq!(input.samples.len(), 100);
    }

    #[test]
    fn silence_is_not_speech_and_caption_lines_are_bounded() {
        assert!(!has_speech(&[0.0; 1600]));
        assert!(has_speech(&[0.1; 1600]));
        assert_eq!(caption_tail("  hello   world  "), "hello world");
        assert_eq!(
            caption_tail(&"word ".repeat(100))
                .split_whitespace()
                .count(),
            24
        );
    }

    #[test]
    fn quiet_gap_gets_one_final_pass_including_the_last_speech() {
        let mut input = AudioInput::default();
        input.append(0, &vec![0.1; SAMPLE_RATE]);
        input.append(0, &vec![0.0; SAMPLE_RATE]);
        let (audio, final_pass) = input.window(5).expect("final utterance");
        assert!(final_pass);
        assert_eq!(audio.len(), SAMPLE_RATE * 2);
        assert!(
            input.window(5).is_none(),
            "never transcribe the same silence again"
        );
    }

    #[test]
    fn confirmed_words_remain_stable_until_final_correction() {
        let mut captions = CaptionTracker::default();
        assert_eq!(captions.update("Hello world", false), "Hello world");
        assert_eq!(
            captions.update("Hello world again", false),
            "Hello world again"
        );
        assert_eq!(
            captions.update("Yellow world again today", false),
            "Hello world again today"
        );
        assert_eq!(
            captions.update("Hello world again today.", true),
            "Hello world again today."
        );
        assert_eq!(
            captions.update("today. Welcome back", false),
            "Welcome back"
        );
    }

    #[test]
    fn non_speech_model_markers_never_become_captions() {
        let mut captions = CaptionTracker::default();
        assert_eq!(captions.update("[BLANK_AUDIO]", false), "");
        assert_eq!(captions.update("[Music]", true), "");
        assert_eq!(captions.update("We enjoy music.", false), "We enjoy music.");
    }

    /// Opt-in real local inference, using a 16 kHz mono PCM WAV fixture.
    #[test]
    #[ignore = "requires DIVE_SUBTITLE_TEST_MODEL and DIVE_SUBTITLE_TEST_WAV"]
    #[cfg(feature = "whisper")]
    fn local_model_transcribes_real_audio() {
        let expected_language =
            std::env::var("DIVE_SUBTITLE_EXPECT_LANGUAGE").unwrap_or_else(|_| "en".into());
        let expected_word =
            std::env::var("DIVE_SUBTITLE_EXPECT_WORD").unwrap_or_else(|_| "country".into());
        let translate = std::env::var_os("DIVE_SUBTITLE_TRANSLATE").is_some();
        let path = PathBuf::from(std::env::var("DIVE_SUBTITLE_TEST_MODEL").expect("model path"));
        let bytes =
            std::fs::read(std::env::var("DIVE_SUBTITLE_TEST_WAV").expect("WAV path")).unwrap();
        assert_eq!(&bytes[..4], b"RIFF");
        let mut offset = 12;
        let mut audio = Vec::new();
        while offset + 8 <= bytes.len() {
            let size =
                u32::from_le_bytes(bytes[offset + 4..offset + 8].try_into().unwrap()) as usize;
            if &bytes[offset..offset + 4] == b"data" {
                audio = bytes[offset + 8..offset + 8 + size]
                    .as_chunks::<2>()
                    .0
                    .iter()
                    .map(|b| f32::from(i16::from_le_bytes([b[0], b[1]])) / 32768.0)
                    .collect();
                break;
            }
            offset += 8 + size + size % 2;
        }
        assert!(audio.len() >= SAMPLE_RATE * 5);
        let began = Instant::now();
        let mut ctx = load_context(&path).unwrap();
        eprintln!("model_load_ms={}", began.elapsed().as_millis());
        let mut combined = String::new();
        for end in [SAMPLE_RATE * 2, SAMPLE_RATE * 5, audio.len()] {
            let offset = end.saturating_sub(SAMPLE_RATE * 5);
            let began = Instant::now();
            let (text, language) =
                transcribe(&mut ctx, &audio[offset..end], "auto", translate).unwrap();
            eprintln!(
                "window_samples={} inference_ms={} language={} text={}",
                end - offset,
                began.elapsed().as_millis(),
                language,
                text
            );
            if end >= SAMPLE_RATE * 5 {
                assert_eq!(language, expected_language);
            }
            combined.push_str(&text.to_lowercase());
        }
        assert!(
            combined.contains(&expected_word),
            "Expected known speech, got {combined}"
        );
    }

    #[test]
    fn rejects_malformed_or_oversized_pcm() {
        assert!(decode_pcm("AA==").is_none());
        assert!(decode_pcm("").is_none());
        assert!(decode_pcm(&"A".repeat(100_000)).is_none());
    }

    #[test]
    fn catalog_is_multilingual_and_flags_downloads() {
        let m = models();
        assert!(m.iter().any(|x| x.id == "base"));
        assert!(m.iter().all(|x| x.size_mb > 0));
        // Every offered model has a resolvable URL and file path.
        for x in &m {
            assert!(model_url(&x.id).is_some(), "{}", x.id);
            assert!(model_file(&x.id).is_some(), "{}", x.id);
        }
        assert!(model_url("nope").is_none());
    }

    #[test]
    fn pcm_decodes_le_int16_to_unit_float() {
        // 0x0000 -> 0.0, 0x00_80 (i16 min little-endian) -> -1.0
        let b64 = base64::engine::general_purpose::STANDARD.encode([0u8, 0u8, 0u8, 0x80u8]);
        let s = decode_pcm(&b64).unwrap();
        assert_eq!(s.len(), 2);
        assert!(s[0].abs() < 1e-6);
        assert!((s[1] + 1.0).abs() < 1e-4);
    }
}
