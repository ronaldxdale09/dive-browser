//! What a launch does when the database cannot be opened.
//!
//! Opening the store used to sit behind a `?` inside Tauri's setup, so any
//! database problem became "Failed to setup app" -- a panic with no window
//! and no message, at every launch, until someone found the file by hand.
//! Now the failure is sorted into the few cases a person can act on:
//!
//! - **Damaged** (not a database, corrupt, or failing SQLite's quick check):
//!   the files are set aside under a `.corrupt-<time>` name, never deleted,
//!   and the person chooses to start fresh, go back to the copy taken before
//!   the last migration, or quit.
//! - **In use**, **read-only**, or **from a newer Dive**: nothing here can
//!   fix those, so a dialog says what is wrong and Dive quits cleanly.
//!
//! Everything that decides is a plain function with tests; the dialogs are
//! the thin part at the end.

use std::path::{Path, PathBuf};

use dive_core::{CoreError, Store};
use rusqlite::ErrorCode;

/// Why the database could not be opened.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum Failure {
    /// The file is not a readable database; setting it aside helps.
    Damaged,
    /// Another process holds it.
    Locked,
    /// It, or its folder, cannot be written.
    ReadOnly,
    /// A newer build wrote it.
    NewerSchema { found: usize, known: usize },
    /// Anything else, described by the error itself.
    Other,
}

/// The damage SQLite's quick check found in a database that opened.
#[derive(Debug, thiserror::Error)]
#[error("SQLite's integrity check found damage in the database")]
pub(crate) struct FailedCheck;

/// The launch stopped on purpose, after telling the person why.
#[derive(Debug, thiserror::Error)]
#[error("Dive stopped at launch because its data could not be opened")]
pub(crate) struct Aborted;

/// Sort an open failure into what can be done about it.
pub(crate) fn classify(error: &anyhow::Error) -> Failure {
    for cause in error.chain() {
        if cause.is::<FailedCheck>() {
            return Failure::Damaged;
        }
        if let Some(CoreError::NewerSchema { found, known }) = cause.downcast_ref::<CoreError>() {
            return Failure::NewerSchema {
                found: *found,
                known: *known,
            };
        }
        let sqlite = match cause.downcast_ref::<CoreError>() {
            Some(CoreError::Db(e)) => Some(e),
            _ => cause.downcast_ref::<rusqlite::Error>(),
        };
        if let Some(rusqlite::Error::SqliteFailure(failure, _)) = sqlite {
            return match failure.code {
                ErrorCode::DatabaseCorrupt | ErrorCode::NotADatabase => Failure::Damaged,
                ErrorCode::DatabaseBusy | ErrorCode::DatabaseLocked => Failure::Locked,
                ErrorCode::ReadOnly | ErrorCode::CannotOpen | ErrorCode::PermissionDenied => {
                    Failure::ReadOnly
                }
                _ => Failure::Other,
            };
        }
        if let Some(io) = cause.downcast_ref::<std::io::Error>() {
            return match io.kind() {
                std::io::ErrorKind::PermissionDenied | std::io::ErrorKind::ReadOnlyFilesystem => {
                    Failure::ReadOnly
                }
                _ => Failure::Other,
            };
        }
    }
    Failure::Other
}

/// The files that make up the database at `path`: the file itself and the
/// write-ahead log and shared-memory index SQLite keeps beside it.
fn database_files(path: &Path) -> [(PathBuf, &'static str); 3] {
    let with = |suffix: &str| {
        let mut name = path.as_os_str().to_owned();
        name.push(suffix);
        PathBuf::from(name)
    };
    [
        (path.to_owned(), ""),
        (with("-wal"), "-wal"),
        (with("-shm"), "-shm"),
    ]
}

/// Move a damaged database aside as `<name>.corrupt-<stamp>`, with its WAL
/// and index under the same stamp, so a fresh one can be made in its place
/// and nothing is lost. Returns the new name of the main file.
pub(crate) fn quarantine(path: &Path, stamp: &str) -> std::io::Result<PathBuf> {
    let mut moved = None;
    for (file, suffix) in database_files(path) {
        if !file.exists() {
            continue;
        }
        let mut name = path.as_os_str().to_owned();
        name.push(format!(".corrupt-{stamp}{suffix}"));
        let target = PathBuf::from(name);
        std::fs::rename(&file, &target)?;
        if suffix.is_empty() {
            moved = Some(target);
        }
    }
    moved.ok_or_else(|| std::io::Error::new(std::io::ErrorKind::NotFound, "no database to move"))
}

/// Put a pre-migration copy back as the database. The current files must
/// already have been moved aside.
pub(crate) fn restore(backup: &Path, path: &Path) -> std::io::Result<()> {
    std::fs::copy(backup, path).map(|_| ())
}

/// A file-name-safe timestamp for the quarantined copy.
fn stamp() -> String {
    time::OffsetDateTime::now_utc()
        .format(&time::format_description::well_known::Rfc3339)
        .unwrap_or_default()
        .replace(':', "-")
}

/// What the person chose for a damaged database.
enum Choice {
    StartFresh,
    Restore(PathBuf),
    Quit,
}

/// Open the store at `path`, recovering from a damaged file with the
/// person's say, and seed it with `seed`.
///
/// `check` runs SQLite's quick check first: it reads the whole file, so the
/// caller asks for it only after an unclean exit, which is when damage is
/// likely. Returns [`Aborted`] once the person has been told why Dive cannot
/// go on; the caller then quits cleanly.
pub(crate) fn open<T>(
    path: &Path,
    check: bool,
    seed: impl Fn(&Store) -> anyhow::Result<T>,
) -> anyhow::Result<(Store, T)> {
    // Each round is one recovery; a fresh or restored file that is damaged
    // again is not worth a loop of dialogs.
    for _ in 0..3 {
        let attempt = Store::open(path)
            .map_err(anyhow::Error::from)
            .and_then(|store| {
                if check && !store.quick_check().unwrap_or(false) {
                    return Err(anyhow::Error::new(FailedCheck));
                }
                let seeded = seed(&store)?;
                Ok((store, seeded))
            });
        let error = match attempt {
            Ok(opened) => return Ok(opened),
            Err(error) => error,
        };
        let failure = classify(&error);
        tracing::error!(?failure, "could not open the database: {error:#}");
        if failure != Failure::Damaged {
            explain(&failure, &error, path);
            return Err(Aborted.into());
        }
        let backup = Store::migration_backups(path).into_iter().next();
        let moved = match quarantine(path, &stamp()) {
            Ok(moved) => moved,
            Err(move_error) => {
                tracing::error!("could not set the damaged database aside: {move_error}");
                explain(&Failure::Other, &error, path);
                return Err(Aborted.into());
            }
        };
        tracing::warn!(moved = %moved.display(), "set a damaged database aside");
        match ask_about_damage(&moved, backup.as_deref()) {
            Choice::StartFresh => tracing::info!("starting with a fresh database"),
            Choice::Restore(backup) => {
                if let Err(e) = restore(&backup, path) {
                    tracing::error!("could not restore {}: {e}", backup.display());
                    explain(&Failure::Other, &anyhow::Error::from(e), path);
                    return Err(Aborted.into());
                }
                tracing::info!(backup = %backup.display(), "restored the pre-migration copy");
            }
            Choice::Quit => return Err(Aborted.into()),
        }
    }
    explain(
        &Failure::Other,
        &anyhow::anyhow!("the database was damaged again after recovery"),
        path,
    );
    Err(Aborted.into())
}

/// The sentence a dialog leads with for each failure.
pub(crate) fn describe(failure: &Failure, error: &anyhow::Error, path: &Path) -> String {
    let folder = path.parent().unwrap_or(path).display();
    match failure {
        Failure::Damaged => format!("Dive's data is damaged: {error}"),
        Failure::Locked => format!(
            "Dive's data is in use by another program, so this copy of Dive cannot open it.\n\n\
             Quit any other copy of Dive, or a program reading the folder {folder}, then open \
             Dive again."
        ),
        Failure::ReadOnly => format!(
            "Dive cannot write to its data folder:\n{folder}\n\nCheck that the disk is not full \
             or read-only and that the folder belongs to you, then open Dive again."
        ),
        Failure::NewerSchema { found, known } => format!(
            "This data was last used by a newer version of Dive (format {found}; this version \
             reads up to {known}).\n\nInstall the latest Dive to open it. Nothing has been \
             changed."
        ),
        Failure::Other => format!(
            "Dive could not open its data in {folder}:\n{error}\n\nNothing has been deleted."
        ),
    }
}

/// Say why Dive cannot start; the only way on is Quit.
fn explain(failure: &Failure, error: &anyhow::Error, path: &Path) {
    let _ = rfd::MessageDialog::new()
        .set_title("Dive can't open its data")
        .set_description(describe(failure, error, path))
        .set_level(rfd::MessageLevel::Error)
        .set_buttons(rfd::MessageButtons::OkCustom("Quit".into()))
        .show();
}

fn ask_about_damage(moved: &Path, backup: Option<&Path>) -> Choice {
    const FRESH: &str = "Start Fresh";
    const RESTORE: &str = "Restore Copy";
    const QUIT: &str = "Quit";
    let kept = moved.file_name().map_or_else(
        || moved.display().to_string(),
        |n| n.to_string_lossy().into_owned(),
    );
    let mut description = format!(
        "Dive could not read its database. It has been set aside as \u{201c}{kept}\u{201d} in \
         the data folder; nothing was deleted.\n\n"
    );
    let buttons = if backup.is_some() {
        description.push_str(
            "Start fresh with no tabs, history or settings, or go back to the copy Dive made \
             before its last update, which loses what changed since.",
        );
        rfd::MessageButtons::YesNoCancelCustom(FRESH.into(), RESTORE.into(), QUIT.into())
    } else {
        description.push_str("Start fresh with no tabs, history or settings?");
        rfd::MessageButtons::OkCancelCustom(FRESH.into(), QUIT.into())
    };
    let answer = rfd::MessageDialog::new()
        .set_title("Dive's data is damaged")
        .set_description(description)
        .set_level(rfd::MessageLevel::Warning)
        .set_buttons(buttons)
        .show();
    match answer {
        rfd::MessageDialogResult::Custom(label) if label == FRESH => Choice::StartFresh,
        rfd::MessageDialogResult::Custom(label) if label == RESTORE => {
            backup.map_or(Choice::Quit, |b| Choice::Restore(b.to_owned()))
        }
        _ => Choice::Quit,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sqlite(code: i32) -> anyhow::Error {
        CoreError::Db(rusqlite::Error::SqliteFailure(
            rusqlite::ffi::Error::new(code),
            None,
        ))
        .into()
    }

    #[test]
    fn failures_are_sorted_by_what_can_be_done_about_them() {
        assert_eq!(
            classify(&sqlite(rusqlite::ffi::SQLITE_NOTADB)),
            Failure::Damaged
        );
        assert_eq!(
            classify(&sqlite(rusqlite::ffi::SQLITE_CORRUPT)),
            Failure::Damaged
        );
        assert_eq!(
            classify(&sqlite(rusqlite::ffi::SQLITE_BUSY)),
            Failure::Locked
        );
        assert_eq!(
            classify(&sqlite(rusqlite::ffi::SQLITE_READONLY)),
            Failure::ReadOnly
        );
        assert_eq!(
            classify(&sqlite(rusqlite::ffi::SQLITE_FULL)),
            Failure::Other
        );
        assert_eq!(classify(&anyhow::Error::new(FailedCheck)), Failure::Damaged);
        assert_eq!(
            classify(
                &CoreError::NewerSchema {
                    found: 30,
                    known: 25
                }
                .into()
            ),
            Failure::NewerSchema {
                found: 30,
                known: 25
            }
        );
        // Context on top keeps the cause visible.
        let wrapped = sqlite(rusqlite::ffi::SQLITE_NOTADB).context("opening dive.db");
        assert_eq!(classify(&wrapped), Failure::Damaged);
    }

    #[test]
    fn a_file_that_is_not_a_database_is_recognised_as_damaged() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("dive.db");
        std::fs::write(
            &path,
            b"this is not sqlite, just some bytes that go on for a while",
        )
        .unwrap();
        let error = Store::open(&path)
            .map_err(anyhow::Error::from)
            .err()
            .unwrap();
        assert_eq!(classify(&error), Failure::Damaged);
    }

    #[test]
    fn quarantine_moves_the_database_and_its_journal_under_one_stamp() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("dive.db");
        std::fs::write(&path, b"db").unwrap();
        std::fs::write(dir.path().join("dive.db-wal"), b"wal").unwrap();
        let moved = quarantine(&path, "T1").unwrap();
        assert_eq!(moved, dir.path().join("dive.db.corrupt-T1"));
        assert!(!path.exists());
        assert!(!dir.path().join("dive.db-wal").exists());
        assert_eq!(
            std::fs::read(dir.path().join("dive.db.corrupt-T1-wal")).unwrap(),
            b"wal"
        );
        // With the damaged file out of the way a fresh store opens.
        assert!(Store::open(&path).is_ok());
    }

    #[test]
    fn a_restored_copy_opens_and_migrates() {
        let dir = tempfile::tempdir().unwrap();
        let good = dir.path().join("good.db");
        drop(Store::open(&good).unwrap());
        let path = dir.path().join("dive.db");
        restore(&good, &path).unwrap();
        assert!(Store::open(&path).is_ok());
    }

    #[test]
    fn a_newer_database_is_explained_without_offering_to_replace_it() {
        let text = describe(
            &Failure::NewerSchema {
                found: 40,
                known: 30,
            },
            &anyhow::anyhow!("x"),
            Path::new("/data/dive.db"),
        );
        assert!(text.contains("newer version of Dive"), "{text}");
        assert!(text.contains("Nothing has been changed"), "{text}");
    }
}
