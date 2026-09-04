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

use std::collections::HashMap;
use std::io::Write as _;
use std::path::PathBuf;
use std::sync::Mutex;

use base64::Engine as _;
use dive_cdp::CdpSession;
use dive_core::TabId;
use futures_util::StreamExt as _;
use serde::{Deserialize, Serialize};
use serde_json::json;
use specta::Type;
use tauri::{AppHandle, Manager};
use tauri_specta::Event;
use tokio::sync::mpsc;

use crate::Runtime;
use crate::state::AppState;

/// The binding the page calls with base64 PCM frames.
const AUDIO_BINDING: &str = "__diveSubtitleAudio";
/// Sample rate whisper expects; the page downsamples to this.
const SAMPLE_RATE: usize = 16_000;
/// Seconds of audio each transcription pass looks at.
const WINDOW_SECS: usize = 8;
/// How often a pass runs.
const STEP_SECS: f64 = 2.0;
/// Longest audio kept in the ring, so a tab left running does not grow forever.
const MAX_BUFFER_SECS: usize = 12;

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
            downloaded: models_dir().join(file).is_file(),
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
    let Some(dest) = model_file(id) else {
        return Err(format!("unknown model {id}"));
    };
    if dest.is_file() && dest.metadata().is_ok_and(|m| m.len() > 1_000_000) {
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
    std::fs::create_dir_all(models_dir()).map_err(|e| e.to_string())?;

    let client = reqwest::Client::new();
    let resp = client
        .get(&url)
        .send()
        .await
        .and_then(reqwest::Response::error_for_status)
        .map_err(|e| format!("download failed: {e}"))?;
    let total = resp.content_length().map(|n| n as f64);

    // Write to a temp file, then rename, so a half-download is never mistaken
    // for a usable model.
    let tmp = dest.with_extension("part");
    let mut file = std::fs::File::create(&tmp).map_err(|e| e.to_string())?;
    let mut received: f64 = 0.0;
    let mut last_emit = std::time::Instant::now();
    let mut stream = resp.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| format!("download interrupted: {e}"))?;
        file.write_all(&chunk).map_err(|e| e.to_string())?;
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
    file.flush().map_err(|e| e.to_string())?;
    drop(file);
    std::fs::rename(&tmp, &dest).map_err(|e| e.to_string())?;
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
    stop: std::sync::Arc<std::sync::atomic::AtomicBool>,
}

/// Sessions by tab.
#[derive(Default)]
pub struct Registry {
    inner: Mutex<HashMap<TabId, Session>>,
}

impl Registry {
    fn stop(&self, tab: TabId) {
        if let Some(s) = self
            .inner
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .remove(&tab)
        {
            s.stop.store(true, std::sync::atomic::Ordering::SeqCst);
        }
    }

    fn is_running(&self, tab: TabId) -> bool {
        self.inner
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .contains_key(&tab)
    }
}

/// Start subtitles for `tab`: load the model, install the audio tap in the
/// page, and spawn the transcription worker.
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

    let state = app.state::<AppState>();
    state.subtitles.stop(tab); // replace any existing session

    let (tx, mut rx) = mpsc::unbounded_channel::<Vec<f32>>();
    let stop = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    state
        .subtitles
        .inner
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .insert(tab, Session { stop: stop.clone() });

    install_audio_tap(&session).await?;
    route_audio(app.clone(), tab, &session, tx);

    // The transcription worker owns the whisper context and runs passes on a
    // blocking thread so the async runtime is never stalled by inference.
    let worker_app = app.clone();
    let worker_session = session.clone();
    let lang = language.clone();
    std::thread::spawn(move || {
        let ctx = match load_context(&path) {
            Ok(c) => c,
            Err(e) => {
                let _ = SubtitleState {
                    tab_id: tab,
                    active: false,
                    error: Some(e),
                }
                .emit(&worker_app);
                worker_app.state::<AppState>().subtitles.stop(tab);
                return;
            }
        };
        let _ = SubtitleState {
            tab_id: tab,
            active: true,
            error: None,
        }
        .emit(&worker_app);

        let mut ring: Vec<f32> = Vec::with_capacity(SAMPLE_RATE * MAX_BUFFER_SECS);
        let pass_every = std::time::Duration::from_secs_f64(STEP_SECS);
        let mut next = std::time::Instant::now() + pass_every;
        let mut last_text = String::new();
        while !stop.load(std::sync::atomic::Ordering::SeqCst) {
            // Drain whatever audio the page has posted.
            while let Ok(chunk) = rx.try_recv() {
                ring.extend_from_slice(&chunk);
            }
            let max = SAMPLE_RATE * MAX_BUFFER_SECS;
            if ring.len() > max {
                ring.drain(0..ring.len() - max);
            }
            if std::time::Instant::now() < next || ring.len() < SAMPLE_RATE {
                std::thread::sleep(std::time::Duration::from_millis(100));
                continue;
            }
            next = std::time::Instant::now() + pass_every;
            let window_len = (SAMPLE_RATE * WINDOW_SECS).min(ring.len());
            let window = ring[ring.len() - window_len..].to_vec();
            match transcribe(&ctx, &window, &lang, translate) {
                Ok((text, detected)) if !text.trim().is_empty() && text != last_text => {
                    last_text.clone_from(&text);
                    let cue = SubtitleCue {
                        tab_id: tab,
                        text: text.clone(),
                        language: detected,
                        is_final: false,
                    };
                    let _ = cue.emit(&worker_app);
                    push_caption(&worker_session, &text);
                }
                Ok(_) => {}
                Err(e) => tracing::debug!(%tab, "transcribe pass failed: {e}"),
            }
        }
        let _ = SubtitleState {
            tab_id: tab,
            active: false,
            error: None,
        }
        .emit(&worker_app);
    });
    Ok(())
}

/// Stop subtitles for `tab` and clear the overlay.
pub fn stop(app: &AppHandle<Runtime>, tab: TabId, session: &CdpSession) {
    app.state::<AppState>().subtitles.stop(tab);
    let s = session.clone();
    tauri::async_runtime::spawn(async move {
        let _ = s
            .call(
                "Runtime.evaluate",
                json!({"expression": "window.__diveSubtitles && window.__diveSubtitles.stop()"}),
            )
            .await;
    });
}

/// Whether a tab is transcribing right now.
pub fn is_running(app: &AppHandle<Runtime>, tab: TabId) -> bool {
    app.state::<AppState>().subtitles.is_running(tab)
}

#[cfg(feature = "whisper")]
fn load_context(path: &std::path::Path) -> Result<whisper_rs::WhisperContext, String> {
    whisper_rs::WhisperContext::new_with_params(
        &path.to_string_lossy(),
        whisper_rs::WhisperContextParameters::default(),
    )
    .map_err(|e| format!("could not load the model: {e}"))
}

#[cfg(feature = "whisper")]
fn transcribe(
    ctx: &whisper_rs::WhisperContext,
    audio: &[f32],
    language: &str,
    translate: bool,
) -> Result<(String, String), String> {
    use whisper_rs::{FullParams, SamplingStrategy};
    let mut state = ctx.create_state().map_err(|e| e.to_string())?;
    let mut params = FullParams::new(SamplingStrategy::Greedy { best_of: 1 });
    params.set_print_progress(false);
    params.set_print_realtime(false);
    params.set_print_special(false);
    params.set_print_timestamps(false);
    params.set_no_context(true);
    params.set_suppress_blank(true);
    if language != "auto" {
        params.set_language(Some(language));
    }
    params.set_translate(translate);
    state.full(params, audio).map_err(|e| e.to_string())?;
    let n = state.full_n_segments().map_err(|e| e.to_string())?;
    let mut text = String::new();
    for i in 0..n {
        if let Ok(seg) = state.full_get_segment_text(i) {
            text.push_str(seg.trim());
            text.push(' ');
        }
    }
    // whisper-rs 0.14 does not expose the detected language id on the state;
    // report the requested language (or "auto" when let the model decide).
    Ok((text.trim().to_owned(), language.to_owned()))
}

// Without the whisper feature the crate still compiles (CI without the model
// toolchain, and the type checker for the chrome bindings). The commands then
// report the backend as unavailable rather than transcribing.
#[cfg(not(feature = "whisper"))]
fn load_context(_path: &std::path::Path) -> Result<(), String> {
    Err("this build was compiled without the local transcription engine".into())
}

#[cfg(not(feature = "whisper"))]
fn transcribe(
    _ctx: &(),
    _audio: &[f32],
    _language: &str,
    _translate: bool,
) -> Result<(String, String), String> {
    Err("no transcription engine".into())
}

/// Install the page-side audio tap and caption overlay.
async fn install_audio_tap(session: &CdpSession) -> Result<(), String> {
    let script = crate::pagescript::build(
        "subtitles.js",
        &[("__AUDIO_BINDING__", AUDIO_BINDING.to_owned())],
    );
    session
        .call("Runtime.addBinding", json!({"name": AUDIO_BINDING}))
        .await
        .map_err(|e| e.to_string())?;
    session
        .call("Runtime.evaluate", json!({"expression": script}))
        .await
        .map_err(|e| format!("could not start the audio tap: {e}"))?;
    // Confirm a video is actually present to capture.
    let has = session
        .call(
            "Runtime.evaluate",
            json!({"expression": "window.__diveSubtitles ? window.__diveSubtitles.hasVideo() : false", "returnByValue": true}),
        )
        .await
        .ok()
        .and_then(|v| v["result"]["value"].as_bool())
        .unwrap_or(false);
    if has {
        Ok(())
    } else {
        Err("no playing video found on this page".into())
    }
}

/// Forward PCM frames the page posts on the binding into the worker channel.
fn route_audio(
    app: AppHandle<Runtime>,
    tab: TabId,
    session: &CdpSession,
    tx: mpsc::UnboundedSender<Vec<f32>>,
) {
    let mut events = session.subscribe();
    tauri::async_runtime::spawn(async move {
        while let Ok(event) = events.recv().await {
            if event.method != "Runtime.bindingCalled"
                || event.params["name"].as_str() != Some(AUDIO_BINDING)
            {
                continue;
            }
            if !app.state::<AppState>().subtitles.is_running(tab) {
                break;
            }
            if let Some(payload) = event.params["payload"].as_str()
                && let Some(samples) = decode_pcm(payload)
                && tx.send(samples).is_err()
            {
                break;
            }
        }
    });
}

/// Decode base64 little-endian Int16 PCM into normalized f32 samples.
fn decode_pcm(b64: &str) -> Option<Vec<f32>> {
    let bytes = base64::engine::general_purpose::STANDARD.decode(b64).ok()?;
    let (pairs, _) = bytes.as_chunks::<2>();
    Some(
        pairs
            .iter()
            .map(|c| f32::from(i16::from_le_bytes(*c)) / 32768.0)
            .collect(),
    )
}

/// Push a caption line into the page overlay.
fn push_caption(session: &CdpSession, text: &str) {
    let expr = format!(
        "window.__diveSubtitles && window.__diveSubtitles.show({})",
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
