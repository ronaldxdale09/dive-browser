//! The standalone libtest executable does not run the desktop application's
//! tauri-build script, so it must select Common Controls v6 for subclass APIs.

fn main() {
    println!("cargo::rerun-if-changed=windows-test.manifest");
    // Explicit opt-in keeps application/dependency builds on their own
    // manifests. Cargo does not expose cfg(test) to build scripts, and its
    // rustc-link-arg-tests directive excludes library unit-test harnesses.
    if std::env::var_os("CARGO_FEATURE_NATIVE_TEST_MANIFEST").is_none()
        || std::env::var("CARGO_CFG_TARGET_OS").as_deref() != Ok("windows")
        || std::env::var("CARGO_CFG_TARGET_ENV").as_deref() != Ok("msvc")
    {
        return;
    }
    let manifest = std::path::PathBuf::from(
        std::env::var_os("CARGO_MANIFEST_DIR").expect("Cargo supplies the package directory"),
    )
    .join("windows-test.manifest");
    println!("cargo::rustc-link-arg=/MANIFEST:EMBED");
    println!(
        "cargo::rustc-link-arg=/MANIFESTINPUT:{}",
        manifest.display()
    );
}
