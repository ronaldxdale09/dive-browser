//! Tauri build script. Also stamps the build's identity (commit, count and
//! time) into the binary for the title bar's build badge.

use std::process::Command;

fn git(args: &[&str]) -> Option<String> {
    let out = Command::new("git").args(args).output().ok()?;
    out.status
        .success()
        .then(|| String::from_utf8_lossy(&out.stdout).trim().to_owned())
        .filter(|s| !s.is_empty())
}

fn main() {
    // `whisper_enabled` rather than the bare feature: whisper.cpp cannot be
    // built for Windows-on-ARM (ggml refuses MSVC there), so the dependency
    // is absent on that target even when the feature is on. Expressing that
    // once here keeps the condition out of eight call sites.
    println!("cargo::rustc-check-cfg=cfg(whisper_enabled)");
    let target_os = std::env::var("CARGO_CFG_TARGET_OS").unwrap_or_default();
    let target_arch = std::env::var("CARGO_CFG_TARGET_ARCH").unwrap_or_default();
    let buildable = !(target_os == "windows" && target_arch == "aarch64");
    if std::env::var_os("CARGO_FEATURE_WHISPER").is_some() && buildable {
        println!("cargo::rustc-cfg=whisper_enabled");
    }

    // Naming any trigger turns off cargo's "rerun on any change" default, so
    // the chrome bundle the binary embeds has to be named too: without it a
    // rebuilt `dist` shipped stale inside a binary cargo thought was current.
    println!("cargo:rerun-if-changed=../dist");
    println!("cargo:rerun-if-changed=../../../.git/HEAD");
    println!("cargo:rerun-if-changed=../../../.git/refs");
    let commit = git(&["rev-parse", "--short=9", "HEAD"]).unwrap_or_else(|| "unknown".into());
    let number = git(&["rev-list", "--count", "HEAD"]).unwrap_or_else(|| "0".into());
    let built_at = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_secs());
    println!("cargo:rustc-env=DIVE_BUILD_COMMIT={commit}");
    println!("cargo:rustc-env=DIVE_BUILD_NUMBER={number}");
    println!("cargo:rustc-env=DIVE_BUILD_UNIX={built_at}");
    tauri_build::build();
}
