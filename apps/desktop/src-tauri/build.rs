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
