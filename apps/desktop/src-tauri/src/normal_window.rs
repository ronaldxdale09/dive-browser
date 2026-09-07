//! A profile-owned, authenticated local channel for opening normal windows.
//! Private processes send only a fixed new-window request, never their URLs.
use std::collections::HashMap;
use std::fs::{File, OpenOptions};
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{Ipv4Addr, SocketAddr, TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use crate::{AppError, Runtime, state};
use serde::{Deserialize, Serialize};
use tauri::Manager;

const WAIT: Duration = Duration::from_secs(20);
const ENDPOINT: &str = "normal-window.json";
#[derive(Serialize, Deserialize)]
struct Endpoint {
    port: u16,
    token: String,
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Request {
    token: String,
    id: String,
    urls: Vec<String>,
}
#[derive(Clone, Serialize, Deserialize)]
struct Reply {
    ok: bool,
    error: Option<String>,
}

pub(crate) struct Broker {
    _lock: File,
    listener: TcpListener,
    endpoint: Endpoint,
    root: PathBuf,
}

fn lock_file(path: &Path) -> std::io::Result<File> {
    let mut options = OpenOptions::new();
    options.create(true).read(true).write(true).truncate(false);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    options.open(path)
}

/// Claim before CEF opens the profile. A second process forwards its request
/// instead of competing for the same database and Chromium cache.
pub(crate) fn claim(root: &Path) -> Result<Option<Broker>, AppError> {
    std::fs::create_dir_all(root).map_err(AppError::new)?;
    let lock = lock_file(&root.join("normal-window.lock")).map_err(AppError::new)?;
    match lock.try_lock() {
        Ok(()) => {}
        Err(std::fs::TryLockError::WouldBlock) => return Ok(None),
        Err(error) => return Err(AppError::new(error)),
    }
    let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).map_err(AppError::new)?;
    let endpoint = Endpoint {
        port: listener.local_addr().map_err(AppError::new)?.port(),
        token: dive_core::TabId::new().to_string(),
    };
    let mut file = tempfile::NamedTempFile::new_in(root).map_err(AppError::new)?;
    serde_json::to_writer(&mut file, &endpoint).map_err(AppError::new)?;
    file.persist(root.join(ENDPOINT)).map_err(AppError::new)?;
    Ok(Some(Broker {
        _lock: lock,
        listener,
        endpoint,
        root: root.to_owned(),
    }))
}

impl Drop for Broker {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(self.root.join(ENDPOINT));
    }
}

impl Broker {
    pub(crate) fn start(&self, app: tauri::AppHandle<Runtime>) -> Result<(), AppError> {
        let listener = self.listener.try_clone().map_err(AppError::new)?;
        let token = self.endpoint.token.clone();
        let mut primary = std::env::var_os("DIVE_NORMAL_FRESH_WINDOW").is_some();
        std::thread::spawn(move || {
            let mut completed = HashMap::new();
            for stream in listener.incoming().flatten() {
                handle(stream, &token, &mut completed, |urls| {
                    if primary && urls.is_empty() {
                        primary = false;
                        let app = app.clone();
                        let (tx, rx) = std::sync::mpsc::channel();
                        app.clone().run_on_main_thread(move || {
                            let result = app
                                .get_window(crate::MAIN_WINDOW)
                                .ok_or_else(|| AppError::new("normal window missing"))
                                .and_then(|window| {
                                    window.show()?;
                                    window.set_focus()?;
                                    Ok(())
                                });
                            let _ = tx.send(result);
                        })?;
                        rx.recv().map_err(AppError::new)??;
                    } else if urls.is_empty() {
                        crate::commands::window_open_local(app.clone())?;
                    } else {
                        crate::open_handed_urls(&app, urls);
                    }
                    Ok(())
                });
            }
        });
        Ok(())
    }
}

fn handle(
    mut stream: TcpStream,
    token: &str,
    completed: &mut HashMap<String, Reply>,
    mut open: impl FnMut(Vec<String>) -> Result<(), AppError>,
) {
    let _ = stream.set_read_timeout(Some(Duration::from_secs(2)));
    let _ = stream.set_write_timeout(Some(Duration::from_secs(2)));
    let mut line = String::new();
    if BufReader::new((&mut stream).take(8193))
        .read_line(&mut line)
        .is_err()
        || line.len() > 8192
    {
        return;
    }
    let Ok(request) = serde_json::from_str::<Request>(&line) else {
        return;
    };
    if request.token != token
        || request.id.len() > 64
        || request.id.is_empty()
        || request.urls.len() > 16
    {
        return;
    }
    let reply = completed
        .entry(request.id)
        .or_insert_with(|| match open(request.urls) {
            Ok(()) => Reply {
                ok: true,
                error: None,
            },
            Err(error) => Reply {
                ok: false,
                error: Some(error.to_string()),
            },
        })
        .clone();
    // Bound retained request ids. The window request contains no private URLs.
    if completed.len() > 128 {
        completed.clear();
    }
    if serde_json::to_writer(&mut stream, &reply).is_ok() {
        let _ = stream.write_all(b"\n");
    }
}

/// Reuse the same id after a lost reply; the broker never opens it twice.
pub(crate) fn request(root: &Path, id: &str, urls: &[String]) -> Result<(), AppError> {
    let endpoint: Endpoint =
        serde_json::from_reader(File::open(root.join(ENDPOINT)).map_err(AppError::new)?)
            .map_err(AppError::new)?;
    let address = SocketAddr::from((Ipv4Addr::LOCALHOST, endpoint.port));
    let mut stream =
        TcpStream::connect_timeout(&address, Duration::from_secs(1)).map_err(AppError::new)?;
    stream
        .set_read_timeout(Some(Duration::from_secs(2)))
        .map_err(AppError::new)?;
    stream
        .set_write_timeout(Some(Duration::from_secs(2)))
        .map_err(AppError::new)?;
    serde_json::to_writer(
        &mut stream,
        &Request {
            token: endpoint.token,
            id: id.into(),
            urls: urls.to_vec(),
        },
    )
    .map_err(AppError::new)?;
    stream.write_all(b"\n").map_err(AppError::new)?;
    let mut line = String::new();
    BufReader::new(stream.take(8193))
        .read_line(&mut line)
        .map_err(AppError::new)?;
    let reply: Reply = serde_json::from_str(&line).map_err(AppError::new)?;
    if reply.ok {
        Ok(())
    } else {
        Err(AppError::new(
            reply
                .error
                .unwrap_or_else(|| "Normal window could not open".into()),
        ))
    }
}

/// Called off the UI thread. A launch lock serializes simultaneous requests
/// from different private processes while the normal host starts.
pub(crate) fn open() -> Result<(), AppError> {
    let root = std::env::var_os("DIVE_NORMAL_DATA_DIR")
        .map_or_else(state::default_data_root, PathBuf::from);
    std::fs::create_dir_all(&root).map_err(AppError::new)?;
    let launch = lock_file(&root.join("normal-window-launch.lock")).map_err(AppError::new)?;
    let lock_deadline = Instant::now() + WAIT;
    loop {
        match launch.try_lock() {
            Ok(()) => break,
            Err(std::fs::TryLockError::WouldBlock) if Instant::now() < lock_deadline => {
                std::thread::sleep(Duration::from_millis(50));
            }
            Err(error) => {
                return Err(AppError::new(format!(
                    "A normal-window request is already pending: {error}"
                )));
            }
        }
    }
    let id = dive_core::TabId::new().to_string();
    if request(&root, &id, &[]).is_ok() {
        return Ok(());
    }
    let owner = lock_file(&root.join("normal-window.lock")).map_err(AppError::new)?;
    let deadline = Instant::now() + WAIT;
    if owner.try_lock().is_ok() {
        drop(owner);
        let mut command = Command::new(std::env::current_exe().map_err(AppError::new)?);
        for (key, _) in std::env::vars_os() {
            if key.to_string_lossy().starts_with("DIVE_") {
                command.env_remove(key);
            }
        }
        command
            .env("DIVE_DATA_DIR", &root)
            .env("DIVE_NORMAL_FRESH_WINDOW", "1")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        if std::env::var_os("DIVE_NORMAL_MOCK_KEYCHAIN").is_some() {
            command
                .env("DIVE_USE_MOCK_KEYCHAIN", "1")
                .env("DIVE_MCP_PORT", "0");
        }
        #[cfg(target_os = "macos")]
        command.args([
            "-ApplePersistenceIgnoreState",
            "YES",
            "-ApplePersistence",
            "-1",
        ]);
        let mut child = command.spawn().map_err(AppError::new)?;
        std::thread::spawn(move || {
            let _ = child.wait();
        });
    }
    while Instant::now() < deadline {
        if request(&root, &id, &[]).is_ok() {
            return Ok(());
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    Err(AppError::new(
        "The normal browser did not respond. Close and reopen the normal Dive app, then try New Window again. You can still exit Private Mode without opening it.",
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    };

    #[test]
    fn only_one_normal_owner_and_stale_endpoint_is_replaced() {
        let root = tempfile::tempdir().unwrap();
        let owner = claim(root.path()).unwrap().unwrap();
        assert!(claim(root.path()).unwrap().is_none());
        drop(owner);
        assert!(!root.path().join(ENDPOINT).exists());
        std::fs::write(root.path().join(ENDPOINT), "stale").unwrap();
        let replacement = claim(root.path()).unwrap().unwrap();
        assert!(
            serde_json::from_reader::<_, Endpoint>(File::open(root.path().join(ENDPOINT)).unwrap())
                .is_ok()
        );
        drop(replacement);
    }

    #[test]
    fn retries_are_idempotent_and_unauthenticated_requests_do_nothing() {
        let root = tempfile::tempdir().unwrap();
        let owner = claim(root.path()).unwrap().unwrap();
        let listener = owner.listener.try_clone().unwrap();
        let token = owner.endpoint.token.clone();
        let calls = Arc::new(AtomicUsize::new(0));
        let count = calls.clone();
        let worker = std::thread::spawn(move || {
            let mut completed = HashMap::new();
            for _ in 0..4 {
                handle(
                    listener.accept().unwrap().0,
                    &token,
                    &mut completed,
                    |urls| {
                        assert!(urls.is_empty());
                        count.fetch_add(1, Ordering::SeqCst);
                        Ok(())
                    },
                );
            }
        });
        let mut bad = TcpStream::connect((Ipv4Addr::LOCALHOST, owner.endpoint.port)).unwrap();
        bad.write_all(b"{\"token\":\"wrong\",\"id\":\"bad\",\"urls\":[]}\n")
            .unwrap();
        drop(bad);
        request(root.path(), "one", &[]).unwrap();
        request(root.path(), "one", &[]).unwrap();
        request(root.path(), "two", &[]).unwrap();
        worker.join().unwrap();
        assert_eq!(calls.load(Ordering::SeqCst), 2);
    }
}
