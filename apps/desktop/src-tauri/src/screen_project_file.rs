//! Replace one project sidecar without exposing a partial save at its final path.

use std::fs::File;
use std::io::{self, Write};
use std::path::Path;

pub(super) fn write_project(path: &Path, bytes: &[u8]) -> io::Result<()> {
    replace_with(path, |file| file.write_all(bytes))
}

fn replace_with(path: &Path, write: impl FnOnce(&mut File) -> io::Result<()>) -> io::Result<()> {
    let parent = path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "project path has no parent"))?;
    // A unique sibling stays on the destination filesystem. Failed writes,
    // synchronization or replacement drop this file without touching the old
    // project. The final path changes only at persist's atomic replacement.
    let mut staged = tempfile::NamedTempFile::new_in(parent)?;
    write(staged.as_file_mut())?;
    staged.as_file().sync_all()?;
    staged.persist(path).map_err(|error| error.error)?;
    // No parent-directory durability or pending frontend-save guarantee here.
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    const OLD: &[u8] = br#"{"version":1,"title":"previous complete project","clips":[1,2,3]}"#;

    #[test]
    fn partial_write_failure_preserves_previous_complete_project_and_cleans_staging() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("recording.divescreen.json");
        std::fs::write(&path, OLD).unwrap();
        let error = replace_with(&path, |file| {
            file.write_all(br#"{"version":2,"title":"unfinished"#)?;
            Err(io::Error::other("injected partial write failure"))
        })
        .unwrap_err();
        assert_eq!(error.to_string(), "injected partial write failure");
        assert_eq!(std::fs::read(&path).unwrap(), OLD);
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 1);
    }

    #[test]
    fn failed_first_save_leaves_no_project_or_staging_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("recording.divescreen.json");
        assert!(
            replace_with(&path, |file| {
                file.write_all(b"partial")?;
                Err(io::Error::other("injected partial write failure"))
            })
            .is_err()
        );
        assert!(!path.exists());
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 0);
    }

    #[test]
    fn successful_shorter_save_replaces_whole_project_without_old_suffix() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("recording.divescreen.json");
        std::fs::write(&path, OLD).unwrap();
        let new = br#"{"version":2}"#;
        write_project(&path, new).unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), new);
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 1);
    }

    #[test]
    fn replacement_failure_cleans_staging_and_preserves_destination() {
        let dir = tempfile::tempdir().unwrap();
        // A directory cannot be replaced by a file; this reaches persist after
        // the staged bytes have been successfully written and synchronized.
        let path = dir.path().join("recording.divescreen.json");
        std::fs::create_dir(&path).unwrap();
        let sentinel = path.join("sentinel");
        std::fs::write(&sentinel, OLD).unwrap();
        assert!(write_project(&path, br#"{"version":2}"#).is_err());
        assert_eq!(std::fs::read(sentinel).unwrap(), OLD);
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 1);
    }
}
