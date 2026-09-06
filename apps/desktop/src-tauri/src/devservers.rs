//! Find dev servers on this machine and help open them on a phone.
//!
//! Ports are discovered by asking the OS what is listening rather than by
//! probing a list of ports we guessed in advance. A fixed list misses the
//! second Vite instance on 5174, anything a monorepo assigns dynamically, and
//! every project that does not use a fashionable framework's default.
//!
//! Discovery is `lsof -iTCP -sTCP:LISTEN -P -n -F pcn`, which also gives the
//! process id and command holding each port, so the list can say *what* is
//! serving. Windows, and any machine without `lsof`, falls back to probing
//! [`COMMON_PORTS`].
//!
//! A listening socket is not necessarily a web server, so each candidate gets
//! short HTTP and HTTPS probes and is only reported once it answers with HTML. Probe
//! results are cached briefly, keyed by port *and* the pid holding it, so
//! restarting a dev server on the same port is noticed rather than served
//! from a stale classification.

use std::collections::HashMap;
use std::sync::{LazyLock, Mutex};
use std::time::{Duration, Instant};

use futures_util::StreamExt as _;
use serde::{Deserialize, Serialize};
use specta::Type;
use tauri::AppHandle;
use tauri_specta::Event;

use crate::Runtime;
use crate::error::{AppError, AppResult};

/// Ports dev servers commonly bind. Only used where `lsof` is unavailable.
pub const COMMON_PORTS: &[u16] = &[
    3000, 3001, 3333, 4000, 4200, 4321, 5000, 5173, 5174, 5175, 5500, 6006, 8000, 8080, 8081, 8788,
    8888, 9000,
];
const MAX_PROBE_BODY: usize = 256 * 1024;
/// How long a probe result is trusted.
const PROBE_CACHE_TTL: Duration = Duration::from_secs(15);
/// Gap between scans while anything is watching.
const POLL_INTERVAL: Duration = Duration::from_secs(3);
/// How long one `watch(true)` keeps polling alive without another. A chrome
/// reload drops the panel that would have sent `watch(false)`, so a watch
/// is a lease, not a counter: it lapses on its own. The chrome renews it by
/// calling `watch(true)` again; a panel open longer than this goes quiet
/// until it does.
const WATCH_LEASE: Duration = Duration::from_mins(15);
/// Ceiling on concurrent HTTP probes, so a machine with a hundred listeners
/// does not open a hundred sockets at once.
const PROBE_CONCURRENCY: usize = 16;
/// Budget for `lsof`. It occasionally blocks on a wedged mount.
const LSOF_TIMEOUT: Duration = Duration::from_secs(5);
/// Ports above this are almost always ephemeral client sockets rather than
/// something a person started on purpose.
const MAX_INTERESTING_PORT: u16 = 49_151;

/// A server that answered.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
pub struct DevServer {
    /// Port on localhost.
    pub port: u16,
    /// `http://localhost:<port>/`.
    pub url: String,
    /// Detected tool, e.g. `Vite`, `Next.js`, `Storybook`, or `HTTP`.
    pub framework: String,
    /// `<title>` of the root document, when any.
    pub title: String,
    /// Command holding the port, when the OS told us.
    pub process: Option<String>,
    /// Process id holding the port, when the OS told us.
    pub pid: Option<u32>,
}

/// LAN address plus a QR code for it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
pub struct ShareInfo {
    /// The URL rewritten to this machine's LAN IP.
    pub lan_url: String,
    /// SVG markup of a QR code for `lan_url`.
    pub qr_svg: String,
}

/// Emitted when the set of running dev servers changes.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type, Event)]
pub struct DevServersChanged {
    /// The current list.
    pub servers: Vec<DevServer>,
}

/// A local socket the OS reports as listening.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Listener {
    /// Port bound.
    pub port: u16,
    /// Process id holding it.
    pub pid: Option<u32>,
    /// Command name, as the OS reports it.
    pub command: Option<String>,
}

/// Whether a bound address is reachable on loopback.
///
/// `*` and `0.0.0.0` mean every interface, which includes loopback; a socket
/// bound to one specific LAN address is not something `localhost` will reach.
fn is_local_bind(host: &str) -> bool {
    matches!(
        host,
        "127.0.0.1" | "localhost" | "[::1]" | "::1" | "*" | "0.0.0.0" | "[::]" | "::"
    ) || host.starts_with("127.")
}

/// Whether `url` points at a server on this machine: the kind of page a
/// developer is iterating against, which must never be discarded under them.
pub fn is_local_url(url: &str) -> bool {
    url::Url::parse(url)
        .ok()
        .and_then(|u| {
            u.host_str()
                .map(|h| is_local_bind(h) || h.ends_with(".localhost"))
        })
        .unwrap_or(false)
}

/// Parse `lsof -F pcn` output into listeners.
///
/// The format is line-per-field with a one-character tag: `p` starts a
/// process, `c` names it, and each following `n` line is one of that
/// process's sockets. Fields persist until replaced, which is why `pid` and
/// `command` are carried down the loop rather than read per socket.
pub fn parse_lsof(output: &str) -> Vec<Listener> {
    let mut listeners = Vec::new();
    let mut pid = None;
    let mut command = None;
    for line in output.lines() {
        let Some((tag, value)) = line.split_at_checked(1) else {
            continue;
        };
        match tag {
            "p" => {
                pid = value.trim().parse::<u32>().ok();
                command = None;
            }
            "c" => command = Some(value.trim().to_owned()),
            "n" => {
                // `127.0.0.1:5173`, `*:3000`, `[::1]:8080`, or a pair with
                // `->` for a connected socket we do not want.
                let name = value.trim();
                if name.contains("->") {
                    continue;
                }
                let Some((host, port)) = name.rsplit_once(':') else {
                    continue;
                };
                let Ok(port) = port.parse::<u16>() else {
                    continue;
                };
                if port == 0 || port > MAX_INTERESTING_PORT || !is_local_bind(host) {
                    continue;
                }
                let listener = Listener {
                    port,
                    pid,
                    command: command.clone(),
                };
                // IPv4 and IPv6 binds of the same server appear separately.
                if !listeners.contains(&listener) {
                    listeners.push(listener);
                }
            }
            _ => {}
        }
    }
    listeners.sort_by_key(|l| l.port);
    listeners
}

/// Ask the OS what is listening. `None` when `lsof` is unavailable.
async fn listeners() -> Option<Vec<Listener>> {
    if cfg!(target_os = "windows") {
        return None;
    }
    let run = tokio::process::Command::new("lsof")
        .args(["-iTCP", "-sTCP:LISTEN", "-P", "-n", "-F", "pcn"])
        .kill_on_drop(true)
        .output();
    match tokio::time::timeout(LSOF_TIMEOUT, run).await {
        Ok(Ok(output)) if output.status.success() => {
            Some(parse_lsof(&String::from_utf8_lossy(&output.stdout)))
        }
        Ok(Ok(output)) => {
            tracing::debug!(
                status = %output.status,
                stderr = %String::from_utf8_lossy(&output.stderr),
                "lsof failed, falling back to common ports"
            );
            None
        }
        Ok(Err(e)) => {
            tracing::debug!("lsof unavailable, falling back to common ports: {e}");
            None
        }
        Err(_) => {
            tracing::warn!("lsof timed out, falling back to common ports");
            None
        }
    }
}

/// What a probe concluded about one port.
#[derive(Debug, Clone, Copy)]
struct Cached {
    /// The pid that held the port when we probed it.
    pid: Option<u32>,
    /// Whether it answered as a web server.
    web: bool,
    /// When to stop trusting this.
    expires: Instant,
}

/// Discovery state: the last published list, the probe cache, and until when
/// a chrome panel has asked for updates.
#[derive(Default)]
pub struct Registry {
    last: Mutex<Vec<DevServer>>,
    cache: Mutex<HashMap<u16, Cached>>,
    /// Polling runs until this instant; `None` while nobody is watching.
    lease: Mutex<Option<Instant>>,
}

impl Registry {
    /// The most recent scan, without starting one.
    pub fn current(&self) -> Vec<DevServer> {
        crate::state::lock(&self.last).clone()
    }

    /// Start or stop watching. Polling costs an `lsof` and a handful of HTTP
    /// probes every few seconds, so it only runs while a panel is open.
    ///
    /// `true` is a heartbeat: it (re)arms a lease of [`WATCH_LEASE`], so a
    /// panel that vanished in a chrome reload without saying `false` cannot
    /// keep polling running forever. `false` ends the lease now.
    pub fn watch(&self, on: bool) {
        self.watch_at(on, Instant::now());
    }

    fn watch_at(&self, on: bool, now: Instant) {
        *crate::state::lock(&self.lease) = on.then(|| now + WATCH_LEASE);
    }

    fn watched(&self) -> bool {
        self.watched_at(Instant::now())
    }

    fn watched_at(&self, now: Instant) -> bool {
        crate::state::lock(&self.lease).is_some_and(|until| until > now)
    }

    /// Whether `port` is known to be (or not to be) a web server.
    ///
    /// A cache entry recorded against a different pid is discarded: the same
    /// port with a new process behind it is a new question.
    fn cached(&self, port: u16, pid: Option<u32>) -> Option<bool> {
        let cache = crate::state::lock(&self.cache);
        let entry = cache.get(&port)?;
        (entry.expires > Instant::now() && entry.pid == pid).then_some(entry.web)
    }

    fn remember(&self, port: u16, pid: Option<u32>, web: bool) {
        let mut cache = crate::state::lock(&self.cache);
        cache.insert(
            port,
            Cached {
                pid,
                web,
                expires: Instant::now() + PROBE_CACHE_TTL,
            },
        );
        // Ports come and go; drop entries nobody asked about recently rather
        // than growing the map for the life of the process.
        let now = Instant::now();
        cache.retain(|_, e| e.expires > now);
    }

    /// Scan, publish, and report whether the list changed.
    pub async fn refresh(&self) -> (Vec<DevServer>, bool) {
        let found = scan_with(self).await;
        let mut last = crate::state::lock(&self.last);
        let changed = *last != found;
        if changed {
            last.clone_from(&found);
        }
        (found, changed)
    }
}

/// Poll while anything is watching, and tell the chrome when the list moves.
pub fn start(app: AppHandle<Runtime>) {
    tauri::async_runtime::spawn(async move {
        use tauri::Manager as _;
        loop {
            tokio::time::sleep(POLL_INTERVAL).await;
            let state = app.state::<crate::state::AppState>();
            if !state.devservers.watched() {
                continue;
            }
            let (servers, changed) = state.devservers.refresh().await;
            if changed {
                let _ = DevServersChanged { servers }.emit(&app);
            }
        }
    });
}

/// The one HTTP client every probe shares.
///
/// Local HTTPS development commonly uses a self-signed certificate. Probes
/// never follow redirects or leave loopback. Built once: a client per scan
/// was a connection pool and a TLS config every three seconds, and the
/// `unwrap_or_default` fallback it had would have followed redirects.
fn probe_client() -> Option<reqwest::Client> {
    static CLIENT: LazyLock<Option<reqwest::Client>> = LazyLock::new(|| {
        reqwest::Client::builder()
            .timeout(Duration::from_millis(1500))
            .danger_accept_invalid_certs(true)
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .map_err(|e| tracing::warn!("dev server probes are off; HTTP client failed: {e}"))
            .ok()
    });
    CLIENT.clone()
}

async fn scan_with(registry: &Registry) -> Vec<DevServer> {
    let candidates = match listeners().await {
        Some(found) => found,
        None => COMMON_PORTS
            .iter()
            .map(|&port| Listener {
                port,
                pid: None,
                command: None,
            })
            .collect(),
    };
    let Some(client) = probe_client() else {
        return Vec::new();
    };
    let probes = candidates.into_iter().map(|listener| {
        let client = client.clone();
        async move {
            if registry.cached(listener.port, listener.pid) == Some(false) {
                return None;
            }
            let server = probe(&client, &listener).await;
            registry.remember(listener.port, listener.pid, server.is_some());
            server
        }
    });
    let mut found: Vec<DevServer> = futures_util::stream::iter(probes)
        .buffer_unordered(PROBE_CONCURRENCY)
        .filter_map(|r| async move { r })
        .collect()
        .await;
    found.sort_by_key(|s| s.port);
    found
}

/// One candidate: connect, fetch the root document, and decide whether this
/// is a web server worth listing.
async fn probe(client: &reqwest::Client, listener: &Listener) -> Option<DevServer> {
    let port = listener.port;
    for scheme in ["http", "https"] {
        // Resolve explicitly. Some resolver configurations try only ::1 for
        // `localhost`, which made an IPv4-only Vite/Python server disappear;
        // the inverse can happen for IPv6-only listeners.
        for host in ["127.0.0.1", "[::1]"] {
            let probe_url = format!("{scheme}://{host}:{port}/");
            let Ok(response) = client.get(&probe_url).send().await else {
                continue;
            };
            let status = response.status();
            let headers = response.headers().clone();
            let server_header = headers
                .get("server")
                .and_then(|v| v.to_str().ok())
                .unwrap_or_default()
                .to_owned();
            let content_type = headers
                .get("content-type")
                .and_then(|v| v.to_str().ok())
                .unwrap_or_default()
                .to_ascii_lowercase();
            // A redirect from `/` is how plenty of dev servers greet you; the
            // target is still a page a person would open. Redirects are not
            // followed, which keeps every probe on loopback.
            let redirects = status.is_redirection() && headers.contains_key("location");
            let body = read_text_capped(response).await;
            if !redirects && !looks_like_a_page(&content_type, &body) {
                continue;
            }
            return Some(DevServer {
                port,
                url: format!("{scheme}://localhost:{port}/"),
                framework: detect(&body, &server_header),
                title: title_of(&body),
                process: listener.command.clone(),
                pid: listener.pid,
            });
        }
    }
    None
}

/// Whether a response is a document rather than an API or a raw socket.
///
/// Checked on the body as well as the header because dev servers are casual
/// about content types, and a Postgres or Redis port that happens to answer
/// an HTTP request should not turn up in a list of dev servers.
pub fn looks_like_a_page(content_type: &str, body: &str) -> bool {
    if content_type.contains("text/html") {
        return true;
    }
    if !content_type.is_empty() && !content_type.contains("text/plain") {
        return false;
    }
    let head = body.trim_start().to_ascii_lowercase();
    head.starts_with("<!doctype html") || head.starts_with("<html") || head.contains("<body")
}

async fn read_text_capped(response: reqwest::Response) -> String {
    let mut stream = response.bytes_stream();
    let mut body = Vec::with_capacity(16 * 1024);
    while let Some(Ok(chunk)) = stream.next().await {
        let remaining = MAX_PROBE_BODY.saturating_sub(body.len());
        body.extend_from_slice(&chunk[..chunk.len().min(remaining)]);
        if chunk.len() >= remaining {
            break;
        }
    }
    String::from_utf8_lossy(&body).into_owned()
}

/// Guess the tool from the root document and the `Server` header.
pub fn detect(body: &str, server_header: &str) -> String {
    let b = body.to_ascii_lowercase();
    let s = server_header.to_ascii_lowercase();
    if b.contains("/@vite/client") || b.contains("vite/dist/client") {
        "Vite"
    } else if b.contains("/_next/") || b.contains("__next") {
        "Next.js"
    } else if b.contains("storybook") {
        "Storybook"
    } else if b.contains("/_nuxt/") {
        "Nuxt"
    } else if b.contains("__sveltekit") || b.contains("/_app/immutable/") {
        "SvelteKit"
    } else if b.contains("astro-island") || b.contains("/_astro/") {
        "Astro"
    } else if b.contains("__webpack") || b.contains("webpack-dev-server") {
        "webpack"
    } else if b.contains("__remix") || b.contains("remix") {
        "Remix"
    } else if s.contains("werkzeug") || s.contains("flask") {
        "Flask"
    } else if s.contains("wsgiserver") || s.contains("django") {
        "Django"
    } else if s.contains("express") {
        "Express"
    } else {
        "HTTP"
    }
    .to_owned()
}

/// `<title>` text, if present.
fn title_of(body: &str) -> String {
    let lower = body.to_ascii_lowercase();
    let Some(start) = lower.find("<title") else {
        return String::new();
    };
    let Some(gt) = lower[start..].find('>') else {
        return String::new();
    };
    let rest = &body[start + gt + 1..];
    let end = rest
        .to_ascii_lowercase()
        .find("</title>")
        .unwrap_or(rest.len());
    rest[..end].trim().chars().take(80).collect()
}

/// Rewrite a localhost URL to this machine's LAN IP and render a QR code.
pub fn share(url: &str) -> AppResult<ShareInfo> {
    let mut parsed = url::Url::parse(url).map_err(AppError::new)?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err(AppError::new("only http and https URLs can be shared"));
    }
    let host = parsed.host_str().unwrap_or_default().to_owned();
    if host == "localhost" || host == "127.0.0.1" || host == "[::1]" || host == "0.0.0.0" {
        let ip = local_ip_address::local_ip()
            .map_err(|e| AppError::new(format!("no LAN address: {e}")))?;
        parsed
            .set_host(Some(&ip.to_string()))
            .map_err(AppError::new)?;
    }
    let lan_url = parsed.to_string();
    let code = qrcode::QrCode::new(lan_url.as_bytes()).map_err(AppError::new)?;
    let qr_svg = code
        .render::<qrcode::render::svg::Color>()
        .min_dimensions(180, 180)
        .quiet_zone(false)
        .build();
    Ok(ShareInfo { lan_url, qr_svg })
}

#[cfg(test)]
mod tests {
    #[test]
    fn local_urls_cover_loopback_and_dot_localhost() {
        assert!(super::is_local_url("http://localhost:3000/app"));
        assert!(super::is_local_url("http://127.0.0.1:5173"));
        assert!(super::is_local_url("http://[::1]:8080"));
        assert!(super::is_local_url("http://api.localhost/"));
        assert!(!super::is_local_url("https://example.com"));
        assert!(!super::is_local_url("about:blank"));
    }

    use super::*;

    #[test]
    fn detects_frameworks() {
        assert_eq!(
            detect(r#"<script type="module" src="/@vite/client"></script>"#, ""),
            "Vite"
        );
        assert_eq!(
            detect(
                r#"<script src="/_next/static/chunks/main.js"></script>"#,
                ""
            ),
            "Next.js"
        );
        assert_eq!(detect("<html></html>", "Werkzeug/3.0 Python/3.12"), "Flask");
        assert_eq!(detect("", ""), "HTTP");
        assert_eq!(
            title_of("<html><head><TITLE> My App </TITLE></head>"),
            "My App"
        );
        assert_eq!(title_of("<p>no title"), "");
    }

    #[test]
    fn share_rewrites_localhost_and_renders_qr() {
        // A public host is left alone and still gets a QR.
        let s = share("https://example.com/path?x=1").unwrap();
        assert_eq!(s.lan_url, "https://example.com/path?x=1");
        assert!(s.qr_svg.starts_with("<svg") || s.qr_svg.starts_with("<?xml"));
        assert!(share("not a url").is_err());
    }

    #[test]
    fn lsof_output_becomes_listeners_with_the_process_that_owns_them() {
        // Real shape: fields persist until replaced, and one process can
        // hold several sockets.
        let output = "\
p4321
cnode
n127.0.0.1:5173
n[::1]:5173
n*:24678
p9876
cpython3.12
n127.0.0.1:8000
";
        let found = parse_lsof(output);
        assert_eq!(
            found,
            vec![
                Listener {
                    port: 5173,
                    pid: Some(4321),
                    command: Some("node".into())
                },
                Listener {
                    port: 8000,
                    pid: Some(9876),
                    command: Some("python3.12".into())
                },
                Listener {
                    port: 24678,
                    pid: Some(4321),
                    command: Some("node".into())
                },
            ],
            "the IPv4 and IPv6 binds of one server are the same listener"
        );
    }

    #[test]
    fn only_ports_reachable_on_localhost_are_candidates() {
        let output = "\
p1
cnode
n127.0.0.1:3000
n*:3001
n0.0.0.0:3002
n[::]:3003
n192.168.1.9:3004
nfe80::1:3005
";
        let ports: Vec<u16> = parse_lsof(output).into_iter().map(|l| l.port).collect();
        assert!(ports.contains(&3000), "loopback");
        assert!(ports.contains(&3001), "* is every interface");
        assert!(ports.contains(&3002), "0.0.0.0 is every interface");
        assert!(ports.contains(&3003), "[::] is every interface");
        assert!(
            !ports.contains(&3004),
            "a LAN-only bind is not reachable as localhost"
        );
    }

    #[test]
    fn connected_sockets_and_junk_lines_are_ignored() {
        let output = "\
p1
cnode
n127.0.0.1:5173->127.0.0.1:52344
n127.0.0.1:notaport
nnohostorport
n127.0.0.1:0
n127.0.0.1:60000
n127.0.0.1:4321
fnot-a-tag
";
        let ports: Vec<u16> = parse_lsof(output).into_iter().map(|l| l.port).collect();
        assert_eq!(
            ports,
            vec![4321],
            "an established connection is not a listener, and an ephemeral port is not a dev server"
        );
    }

    #[test]
    fn a_pid_without_a_command_still_yields_a_listener() {
        // `-F pcn` normally gives all three, but the command line can be
        // missing for a process that exits mid-scan.
        let found = parse_lsof("p7\nn127.0.0.1:1234\n");
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].pid, Some(7));
        assert_eq!(found[0].command, None);
    }

    #[test]
    fn a_listening_socket_is_only_a_dev_server_once_it_serves_a_page() {
        assert!(looks_like_a_page("text/html; charset=utf-8", ""));
        assert!(looks_like_a_page("", "<!doctype html><html></html>"));
        assert!(looks_like_a_page("", "  <html><body>hi</body></html>"));
        // A database or a JSON API on a loopback port is not a dev server.
        assert!(!looks_like_a_page("application/json", "{\"ok\":true}"));
        assert!(!looks_like_a_page("", "PostgreSQL 16.2"));
        assert!(!looks_like_a_page("application/octet-stream", "<html>"));
    }

    #[test]
    fn probe_results_are_cached_per_port_and_per_process() {
        let registry = Registry::default();
        assert_eq!(registry.cached(5173, Some(1)), None, "nothing known yet");

        registry.remember(5173, Some(1), true);
        assert_eq!(registry.cached(5173, Some(1)), Some(true));

        // Restarting the server gives the port a new pid, so the old answer
        // is not reused.
        assert_eq!(
            registry.cached(5173, Some(2)),
            None,
            "a new process on the same port is a new question"
        );

        registry.remember(9999, None, false);
        assert_eq!(registry.cached(9999, None), Some(false));
    }

    #[test]
    fn watching_is_a_lease_that_reloads_cannot_leak() {
        let registry = Registry::default();
        assert!(
            !registry.watched(),
            "idle by default: polling costs an lsof"
        );
        let t0 = Instant::now();
        registry.watch_at(true, t0);
        assert!(registry.watched_at(t0));
        assert!(registry.watched_at(t0 + WATCH_LEASE / 2));
        // A panel lost in a chrome reload never says false; the lease lapses.
        assert!(!registry.watched_at(t0 + WATCH_LEASE));
        // A heartbeat before it lapses extends it.
        let t1 = t0 + WATCH_LEASE / 2;
        registry.watch_at(true, t1);
        assert!(registry.watched_at(t0 + WATCH_LEASE));
        assert!(!registry.watched_at(t1 + WATCH_LEASE));
        // Closing the panel stops polling at once, and again is harmless.
        registry.watch_at(false, t1);
        assert!(!registry.watched_at(t1));
        registry.watch_at(false, t1);
        assert!(!registry.watched_at(t1));
    }

    #[tokio::test]
    async fn probing_reaches_a_server_bound_only_to_ipv4_loopback() {
        use std::io::{Read as _, Write as _};

        let socket = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = socket.local_addr().unwrap().port();
        let server = std::thread::spawn(move || {
            let (mut stream, _) = socket.accept().unwrap();
            let mut request = [0_u8; 1024];
            let _ = stream.read(&mut request);
            let body = b"<!doctype html><title>IPv4 only</title><body>ready</body>";
            write!(
                stream,
                "HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                body.len()
            )
            .unwrap();
            stream.write_all(body).unwrap();
        });
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(2))
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .unwrap();
        let Some(found) = probe(
            &client,
            &Listener {
                port,
                pid: Some(7),
                command: Some("test-server".into()),
            },
        )
        .await
        else {
            if let Err(e) = reqwest::Client::new()
                .get(format!("http://127.0.0.1:{port}/"))
                .send()
                .await
            {
                let msg = format!("{e:?}");
                if msg.contains("PermissionDenied") || msg.contains("Operation not permitted") {
                    eprintln!("skipping test: sandbox blocked loopback TCP connection");
                    return;
                }
            }
            panic!("IPv4-only server should be visible");
        };
        let _ = server.join();
        assert_eq!(found.port, port);
        assert_eq!(found.title, "IPv4 only");
        assert_eq!(found.process.as_deref(), Some("test-server"));
    }
}
