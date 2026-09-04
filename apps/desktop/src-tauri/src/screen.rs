//! `DiveScreen`'s engine side: the project file beside a recording, reading
//! the recording into the chrome in pieces, and turning the editor's
//! rendered `WebM` into the finished MP4 or GIF with the source's sound.

use std::fmt::Write as _;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use base64::Engine as _;
use serde::{Deserialize, Serialize};
use specta::Type;
use tauri::State;

use crate::error::{AppError, AppResult};
use crate::screencast::{PREVIEW_DIR, RecordingResult, ffmpeg_path};
use crate::state::AppState;

/// A recording's facts the editor needs before it can draw anything.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct MediaInfo {
    pub duration_ms: f64,
    pub width: u32,
    pub height: u32,
    /// Whether the file carries sound.
    pub has_audio: bool,
    /// The decodable companion, if one exists beside the file.
    pub playable: Option<String>,
    /// The pointer track, if one was written.
    pub events: Option<String>,
}

/// One stretch of the source kept in the export, in order.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct KeptSegment {
    pub src_start_ms: f64,
    pub src_end_ms: f64,
    pub speed: f64,
}

/// What the editor asks for when it hands over its rendered frames.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct ExportRequest {
    /// The staged `WebM` the chrome rendered and uploaded.
    pub staged: String,
    /// The recording the project belongs to (for its sound).
    pub source: String,
    /// `mp4` or `gif`.
    pub format: String,
    /// Frames per second of the rendered video.
    pub fps: u32,
    /// GIF frame rate.
    pub gif_fps: u32,
    /// Kept stretches, so the sound follows the cuts and speed changes.
    pub segments: Vec<KeptSegment>,
    /// Take the source's sound along.
    pub with_audio: bool,
}

/// A file the editor may touch: inside the captures directory only.
fn captured(path: &str) -> AppResult<PathBuf> {
    let dir = crate::commands::captures_dir()?.canonicalize()?;
    let file = Path::new(path).canonicalize()?;
    if !file.starts_with(&dir) {
        return Err(AppError::new("not a recording"));
    }
    Ok(file)
}

/// Where a recording's project file lives.
fn project_path(source: &Path) -> AppResult<PathBuf> {
    let stem = source
        .file_stem()
        .ok_or_else(|| AppError::new("not a file"))?
        .to_string_lossy()
        .into_owned();
    let dir = source
        .parent()
        .ok_or_else(|| AppError::new("not a file"))?
        .join(PREVIEW_DIR);
    std::fs::create_dir_all(&dir)?;
    Ok(dir.join(format!("{stem}.divescreen.json")))
}

fn companion(source: &Path, ext: &str) -> Option<String> {
    let stem = source.file_stem()?.to_string_lossy().into_owned();
    let p = source
        .parent()?
        .join(PREVIEW_DIR)
        .join(format!("{stem}.{ext}"));
    p.exists().then(|| p.to_string_lossy().into_owned())
}

/// Duration, picture size and sound of a media file, from ffprobe.
fn probe(path: &Path) -> AppResult<(f64, u32, u32, bool)> {
    let probe = ffmpeg_path()
        .ok_or_else(|| AppError::new("ffmpeg not found"))?
        .with_file_name("ffprobe");
    let out = Command::new(probe)
        .args([
            "-v",
            "error",
            "-show_entries",
            "format=duration:stream=codec_type,width,height",
            "-of",
            "json",
        ])
        .arg(path)
        .output()
        .map_err(AppError::new)?;
    let v: serde_json::Value = serde_json::from_slice(&out.stdout).map_err(AppError::new)?;
    let duration = v["format"]["duration"]
        .as_str()
        .and_then(|d| d.parse::<f64>().ok())
        .unwrap_or(0.0);
    let mut width = 0;
    let mut height = 0;
    let mut has_audio = false;
    for s in v["streams"].as_array().into_iter().flatten() {
        match s["codec_type"].as_str() {
            Some("video") if width == 0 => {
                width = u32::try_from(s["width"].as_u64().unwrap_or(0)).unwrap_or(0);
                height = u32::try_from(s["height"].as_u64().unwrap_or(0)).unwrap_or(0);
            }
            Some("audio") => has_audio = true,
            _ => {}
        }
    }
    Ok((duration * 1000.0, width, height, has_audio))
}

#[tauri::command]
#[specta::specta]
/// What a recording is, so the editor can open it.
pub(crate) async fn screen_media_info(source: String) -> Result<MediaInfo, AppError> {
    let file = captured(&source)?;
    tauri::async_runtime::spawn_blocking(move || {
        let (duration_ms, width, height, has_audio) = probe(&file)?;
        Ok(MediaInfo {
            duration_ms,
            width,
            height,
            has_audio,
            playable: companion(&file, "webm"),
            events: companion(&file, "events.json"),
        })
    })
    .await
    .map_err(AppError::new)?
}

#[tauri::command]
#[specta::specta]
/// The saved project for a recording, if any.
#[allow(clippy::needless_pass_by_value)] // Tauri commands deserialize owned strings.
pub(crate) fn screen_project_read(source: String) -> AppResult<Option<String>> {
    let path = project_path(&captured(&source)?)?;
    if !path.exists() {
        return Ok(None);
    }
    Ok(Some(std::fs::read_to_string(path)?))
}

#[tauri::command]
#[specta::specta]
/// Save the project for a recording.
#[allow(clippy::needless_pass_by_value)] // Tauri commands deserialize owned strings.
pub(crate) fn screen_project_write(source: String, json: String) -> AppResult<()> {
    let path = project_path(&captured(&source)?)?;
    std::fs::write(path, json)?;
    Ok(())
}

/// Largest piece the chrome reads at once.
const CHUNK_MAX: u64 = 8 * 1024 * 1024;

#[tauri::command]
#[specta::specta]
/// A piece of a recording (or its companion) as base64, so a large file
/// reaches the chrome without one giant string.
pub(crate) async fn file_read_chunk(
    path: String,
    offset: f64,
    len: f64,
) -> Result<String, AppError> {
    use std::io::{Read as _, Seek as _};
    let file = captured(&path)?;
    #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
    // Offsets come from the chrome's own byte counts.
    let (offset, len) = (offset.max(0.0) as u64, (len.max(0.0) as u64).min(CHUNK_MAX));
    tauri::async_runtime::spawn_blocking(move || {
        let mut f = std::fs::File::open(file)?;
        f.seek(std::io::SeekFrom::Start(offset))?;
        let mut buf = vec![0u8; usize::try_from(len).unwrap_or(0)];
        let mut read = 0;
        while read < buf.len() {
            let n = f.read(&mut buf[read..])?;
            if n == 0 {
                break;
            }
            read += n;
        }
        buf.truncate(read);
        Ok(base64::engine::general_purpose::STANDARD.encode(buf))
    })
    .await
    .map_err(AppError::new)?
}

#[tauri::command]
#[specta::specta]
/// Size of a recording or companion, for chunked reads.
#[allow(clippy::needless_pass_by_value)] // Tauri commands deserialize owned strings.
pub(crate) fn file_size(path: String) -> AppResult<f64> {
    #[allow(clippy::cast_precision_loss)]
    Ok(std::fs::metadata(captured(&path)?)?.len() as f64)
}

#[tauri::command]
#[specta::specta]
/// Open a staging file for the editor's rendered `WebM`; returns its path.
pub(crate) fn screen_export_begin() -> AppResult<String> {
    let dir = crate::commands::captures_dir()?.join(".export");
    std::fs::create_dir_all(&dir)?;
    let path = dir.join(format!("render-{}.webm", dive_core::TabId::new()));
    std::fs::File::create(&path)?;
    Ok(path.to_string_lossy().into_owned())
}

#[tauri::command]
#[specta::specta]
/// Append a base64 piece to the staging file.
pub(crate) async fn screen_export_append(path: String, base64: String) -> Result<(), AppError> {
    use std::io::Write as _;
    let file = captured(&path)?;
    tauri::async_runtime::spawn_blocking(move || {
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(base64)
            .map_err(AppError::new)?;
        let mut f = std::fs::OpenOptions::new().append(true).open(file)?;
        f.write_all(&bytes)?;
        Ok(())
    })
    .await
    .map_err(AppError::new)?
}

#[tauri::command]
#[specta::specta]
/// Encode the staged render into the final file, with the source's sound
/// cut and sped the same way, and a preview companion beside it.
pub(crate) async fn screen_export_finish(
    state: State<'_, AppState>,
    request: ExportRequest,
) -> Result<RecordingResult, AppError> {
    let _ = &state;
    let staged = captured(&request.staged)?;
    let source = captured(&request.source)?;
    tauri::async_runtime::spawn_blocking(move || {
        let result = finish(&staged, &source, &request);
        let _ = std::fs::remove_file(&staged);
        result
    })
    .await
    .map_err(AppError::new)?
}

/// The ffmpeg filter that cuts and speeds the source's sound to match
/// the kept segments: one `atrim`+`atempo` chain per segment, concatenated.
pub fn audio_filter(segments: &[KeptSegment]) -> String {
    let mut f = String::new();
    let mut labels = String::new();
    for (i, s) in segments.iter().enumerate() {
        let _ = write!(
            f,
            "[0:a]atrim=start={:.3}:end={:.3},asetpts=PTS-STARTPTS{}[a{i}];",
            s.src_start_ms / 1000.0,
            s.src_end_ms / 1000.0,
            tempo_chain(s.speed)
        );
        let _ = write!(labels, "[a{i}]");
    }
    let _ = write!(f, "{labels}concat=n={}:v=0:a=1[aout]", segments.len());
    f
}

/// `atempo` only accepts 0.5..=100 per stage, so other speeds are chained.
fn tempo_chain(speed: f64) -> String {
    let mut out = String::new();
    let mut remaining = speed.clamp(0.05, 100.0);
    while (remaining - 1.0).abs() > 1e-6 {
        let step = remaining.clamp(0.5, 100.0);
        let _ = write!(out, ",atempo={step:.4}");
        remaining /= step;
        if (0.5..=100.0).contains(&remaining) && (remaining - 1.0).abs() > 1e-6 {
            let _ = write!(out, ",atempo={remaining:.4}");
            break;
        }
        if remaining >= 0.5 {
            break;
        }
    }
    out
}

#[allow(clippy::too_many_lines)] // The export command is intentionally one linear ffmpeg recipe.
fn finish(staged: &Path, source: &Path, req: &ExportRequest) -> AppResult<RecordingResult> {
    let ffmpeg = ffmpeg_path().ok_or_else(|| AppError::new("ffmpeg not found"))?;
    let dir = crate::commands::captures_dir()?;
    let stem = format!(
        "{}-edited-{}",
        source
            .file_stem()
            .map_or_else(|| "dive".into(), |s| s.to_string_lossy().into_owned(),),
        dive_core::Timestamp::now()
            .to_rfc3339()
            .replace([':', '.'], "-")
    );
    let gif = req.format.eq_ignore_ascii_case("gif");
    let with_audio = req.with_audio && !gif && !req.segments.is_empty();
    let path = dir.join(format!("{stem}.{}", if gif { "gif" } else { "mp4" }));
    let mut cmd = Command::new(&ffmpeg);
    cmd.args(["-hide_banner", "-loglevel", "error", "-y"]);
    cmd.arg("-i").arg(staged);
    if with_audio {
        cmd.arg("-i").arg(source);
        cmd.args(["-filter_complex", &audio_filter(&req.segments)]);
        cmd.args(["-map", "0:v:0", "-map", "[aout]"]);
    }
    if gif {
        let filter = format!(
            "fps={},split[a][b];[a]palettegen=max_colors=200:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle",
            req.gif_fps.clamp(5, 30)
        );
        cmd.args(["-vf", &filter, "-loop", "0"]);
    } else {
        cmd.args([
            "-c:v",
            "libx264",
            "-preset",
            "medium",
            "-crf",
            "20",
            "-pix_fmt",
            "yuv420p",
            "-movflags",
            "+faststart",
        ]);
        if with_audio {
            cmd.args(["-c:a", "aac", "-b:a", "160k", "-shortest"]);
        } else {
            cmd.arg("-an");
        }
    }
    cmd.arg(&path).stdin(Stdio::null());
    let out = cmd.output().map_err(AppError::new)?;
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr);
        return Err(AppError::new(format!(
            "ffmpeg could not finish the export: {}",
            err.lines().last().unwrap_or("unknown error")
        )));
    }
    let (duration_ms, width, height, _) = probe(&path).unwrap_or((0.0, 0, 0, false));
    let preview = if gif {
        None
    } else {
        let preview_dir = dir.join(PREVIEW_DIR);
        std::fs::create_dir_all(&preview_dir)?;
        let p = preview_dir.join(format!("{stem}.webm"));
        let mut c = Command::new(&ffmpeg);
        c.args(["-hide_banner", "-loglevel", "error", "-y"])
            .arg("-i")
            .arg(&path)
            .args([
                "-vf",
                "scale='min(1280,iw)':-2,format=yuv420p",
                "-c:v",
                "libvpx-vp9",
                "-deadline",
                "realtime",
                "-cpu-used",
                "8",
                "-crf",
                "34",
                "-b:v",
                "0",
                "-row-mt",
                "1",
            ]);
        if with_audio {
            c.args(["-c:a", "libopus", "-b:a", "64k"]);
        } else {
            c.arg("-an");
        }
        c.arg(&p).stdin(Stdio::null());
        let _ = c.output();
        p.exists().then(|| p.to_string_lossy().into_owned())
    };
    #[allow(clippy::cast_precision_loss)]
    let bytes = std::fs::metadata(&path)?.len() as f64;
    Ok(RecordingResult {
        path: path.to_string_lossy().into_owned(),
        duration_secs: duration_ms / 1000.0,
        bytes,
        width,
        height,
        format: if gif { "gif".into() } else { "mp4".into() },
        frames: 0,
        has_audio: with_audio,
        events: None,
        preview,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn audio_follows_cuts_and_speed() {
        let f = audio_filter(&[
            KeptSegment {
                src_start_ms: 0.0,
                src_end_ms: 2000.0,
                speed: 1.0,
            },
            KeptSegment {
                src_start_ms: 4000.0,
                src_end_ms: 6000.0,
                speed: 2.0,
            },
        ]);
        assert!(f.contains("atrim=start=0.000:end=2.000"), "{f}");
        assert!(
            f.contains("atrim=start=4.000:end=6.000,asetpts=PTS-STARTPTS,atempo=2.0000"),
            "{f}"
        );
        assert!(f.ends_with("[a0][a1]concat=n=2:v=0:a=1[aout]"), "{f}");
    }

    #[test]
    fn slow_speeds_chain_tempo_stages() {
        assert_eq!(tempo_chain(1.0), "");
        assert_eq!(tempo_chain(0.25), ",atempo=0.5000,atempo=0.5000");
        assert_eq!(tempo_chain(3.0), ",atempo=3.0000");
    }
}
