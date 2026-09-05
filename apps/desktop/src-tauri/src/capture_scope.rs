//! Asset access follows the active profile, including hidden media companions.

use std::path::{Path, PathBuf};

use tauri::Manager;

use crate::error::{AppError, AppResult};

pub(crate) fn install<R: tauri::Runtime>(app: &tauri::App<R>) -> AppResult<()> {
    let directories = managed_directories(&crate::commands::captures_dir()?)?;
    let scope = app.asset_protocol_scope();
    for directory in directories {
        scope.allow_directory(directory, true)?;
    }
    Ok(())
}

/// Validate every directory before granting anything. Tauri canonicalizes
/// allowed paths, so an escaping preview symlink must never become a grant.
fn managed_directories(captures: &Path) -> AppResult<[PathBuf; 2]> {
    let captures = captures.canonicalize()?;
    let preview = captures.join(crate::screencast::PREVIEW_DIR);
    std::fs::create_dir_all(&preview)?;
    let preview = preview.canonicalize()?;
    if !preview.starts_with(&captures) {
        return Err(AppError::new(
            "recording previews must stay inside captures",
        ));
    }
    Ok([captures, preview])
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    struct Fixture(PathBuf);
    impl Fixture {
        fn new() -> Self {
            static NEXT: AtomicUsize = AtomicUsize::new(0);
            let path = std::env::temp_dir().join(format!(
                "dive-capture-scope-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
            std::fs::create_dir_all(path.join("captures")).unwrap();
            Self(path)
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn custom_profile_grants_only_capture_root_and_explicit_hidden_previews() {
        let fixture = Fixture::new();
        let root = fixture.0.join("captures").canonicalize().unwrap();
        let dirs = managed_directories(&root).unwrap();
        assert_eq!(dirs, [root.clone(), root.join(".previews")]);
        assert!(dirs.iter().all(|p| p.is_dir()));
        assert!(!dirs.contains(&fixture.0.canonicalize().unwrap()));
    }

    #[cfg(unix)]
    #[test]
    fn escaping_preview_symlink_is_rejected_before_scope_expansion() {
        let fixture = Fixture::new();
        let outside = fixture.0.join("outside");
        std::fs::create_dir(&outside).unwrap();
        std::os::unix::fs::symlink(&outside, fixture.0.join("captures/.previews")).unwrap();
        assert!(managed_directories(&fixture.0.join("captures")).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn canonicalizes_a_profile_path_without_granting_its_parent() {
        let fixture = Fixture::new();
        let alias = fixture.0.join("alias");
        std::os::unix::fs::symlink(fixture.0.join("captures"), &alias).unwrap();
        let dirs = managed_directories(&alias).unwrap();
        assert_eq!(dirs[0], fixture.0.join("captures").canonicalize().unwrap());
        assert!(dirs[1].starts_with(&dirs[0]));
    }
}
