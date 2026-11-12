//! Finding ffmpeg and ffprobe, running them under a deadline, watching their progress, and listing capture devices.

use std::fs::File;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Output, Stdio};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use specta::Type;

use crate::error::{AppError, AppResult};

/// A microphone ffmpeg can capture from.
#[derive(Debug, Clone, Serialize, Deserialize, Type, PartialEq, Eq)]
pub struct Microphone {
    /// Capture-device id, as ffmpeg wants it.
    pub id: String,
    /// What the system calls it.
    pub name: String,
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
pub(crate) fn run_watched(
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

/// Ask ffmpeg for its capture devices and keep the audio ones.
pub(crate) fn list_microphones(ffmpeg: &Path) -> Vec<Microphone> {
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

/// Displays ffmpeg can capture, by device id, in display order.
pub(crate) fn list_screens(ffmpeg: &Path) -> Vec<String> {
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

/// The last position ffmpeg wrote to its progress file, in seconds.
pub(crate) fn read_progress(file: &Path) -> Option<f64> {
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
    fn progress_reads_the_newest_position() {
        let text = "frame=10\nout_time_us=N/A\nprogress=continue\n\
            frame=40\nout_time_us=1500000\nout_time_ms=1500000\nprogress=continue\n\
            frame=90\nout_time_ms=3250000\nout_time_us=N/A\nprogress=end\n";
        assert_eq!(progress_seconds(text), Some(3.25));
        assert_eq!(progress_seconds("out_time_us=N/A\n"), None);
        assert_eq!(progress_seconds("out_time_us=-5\n"), None);
        assert_eq!(progress_seconds(""), None);
    }
}
