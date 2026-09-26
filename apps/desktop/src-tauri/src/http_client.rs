//! HTTP clients for the requests Dive makes itself, through Dive's proxy.
//!
//! Pages go out through Chromium, which honours the proxy in Settings. Search
//! suggestions, subtitle models, app icons and the agent's model calls go out
//! through `reqwest`, which knew nothing of it: on a network that only lets
//! traffic out through a proxy they simply failed, and with a proxy chosen
//! for privacy they went around it. Every such client is built here, from the
//! same network preferences the engine is started with.
//!
//! The preferences are read when a client is wanted, and a cached client is
//! rebuilt once they differ from the ones it was built with, so a change in
//! Settings reaches these requests at once; the engine itself still needs
//! the restart Settings asks for.

use std::sync::Mutex;
use std::time::Duration;

use tauri::{AppHandle, Manager};

use crate::Runtime;
use crate::netconfig::NetworkConfig;
use crate::state::{AppState, lock};

/// How long an idle pooled connection is kept. Long enough to serve the next
/// keystroke's suggestions; short enough not to hold a socket a proxy or a
/// changed network has long since dropped.
const POOL_IDLE: Duration = Duration::from_secs(30);
/// Keepalive probes on open connections, so one that died quietly (a laptop
/// asleep, a Wi-Fi hop) is noticed rather than written into.
const KEEPALIVE: Duration = Duration::from_secs(15);

/// The network preferences as saved now.
pub fn network(app: &AppHandle<Runtime>) -> NetworkConfig {
    let state = app.state::<AppState>();
    state.prefs.snapshot(&state).network()
}

/// Chromium's bypass list (`*.internal, <local>`) in the form `NO_PROXY`
/// takes (`.internal, localhost, 127.0.0.1, ::1`).
fn no_proxy_list(bypass: &str) -> String {
    bypass
        .split(',')
        .map(str::trim)
        .filter(|entry| !entry.is_empty())
        .flat_map(|entry| match entry {
            "<local>" => vec![
                "localhost".to_owned(),
                "127.0.0.1".to_owned(),
                "::1".to_owned(),
            ],
            _ => vec![entry.strip_prefix('*').unwrap_or(entry).to_owned()],
        })
        .collect::<Vec<_>>()
        .join(",")
}

/// A client builder that sends traffic where `config` says, with the pool
/// and keepalive every Dive client shares.
///
/// Refuses what `reqwest` cannot do as asked -- a SOCKS proxy -- rather than
/// quietly going around it: a proxy chosen for privacy that one request
/// skips is worse than that request failing. A PAC script cannot be run
/// here either; those requests follow the system's proxy variables.
pub fn builder(config: &NetworkConfig) -> Result<reqwest::ClientBuilder, String> {
    let builder = reqwest::Client::builder()
        .pool_idle_timeout(POOL_IDLE)
        .tcp_keepalive(KEEPALIVE);
    match config.proxy_mode.as_str() {
        "direct" => Ok(builder.no_proxy()),
        "manual" => {
            let server = config.proxy_server.trim();
            if server.is_empty() {
                // The engine ignores a manual proxy with no server too.
                return Ok(builder);
            }
            let url = if server.contains("://") {
                server.to_owned()
            } else {
                format!("http://{server}")
            };
            if !url.starts_with("http://") && !url.starts_with("https://") {
                return Err(format!(
                    "the proxy in Settings ({server}) is not an HTTP proxy, which Dive's own requests cannot use"
                ));
            }
            let proxy = reqwest::Proxy::all(&url)
                .map_err(|error| format!("the proxy in Settings is not usable: {error}"))?
                .no_proxy(reqwest::NoProxy::from_string(&no_proxy_list(
                    &config.proxy_bypass,
                )));
            Ok(builder.proxy(proxy))
        }
        // "system" and "pac": the system's proxy variables, as before.
        _ => Ok(builder),
    }
}

/// One client kept for reuse, rebuilt when the network preferences change.
pub struct Cached(Mutex<Option<(NetworkConfig, reqwest::Client)>>);

impl Cached {
    pub const fn new() -> Self {
        Self(Mutex::new(None))
    }

    /// The client for `config`, built with `customize` (timeouts, redirect
    /// policy) the first time and after every change of `config`.
    pub fn get(
        &self,
        config: &NetworkConfig,
        customize: impl FnOnce(reqwest::ClientBuilder) -> reqwest::ClientBuilder,
    ) -> Result<reqwest::Client, String> {
        let mut cached = lock(&self.0);
        if let Some((built_for, client)) = cached.as_ref()
            && built_for == config
        {
            return Ok(client.clone());
        }
        let client = customize(builder(config)?)
            .build()
            .map_err(|error| error.to_string())?;
        *cached = Some((config.clone(), client.clone()));
        Ok(client)
    }
}

/// Send a request, trying once more when the connection itself could not be
/// made. A connect error means nothing reached the server, so the second
/// try cannot repeat anything; it covers the first request after the network
/// came back, or after a pooled connection turned out to be dead.
pub async fn send_retrying(
    request: reqwest::RequestBuilder,
) -> Result<reqwest::Response, reqwest::Error> {
    let Some(again) = request.try_clone() else {
        return request.send().await;
    };
    match request.send().await {
        Err(error) if error.is_connect() => {
            tracing::debug!(%error, "connection failed; trying once more");
            tokio::time::sleep(Duration::from_millis(250)).await;
            again.send().await
        }
        other => other,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn config(mode: &str, server: &str, bypass: &str) -> NetworkConfig {
        NetworkConfig {
            proxy_mode: mode.into(),
            proxy_server: server.into(),
            proxy_bypass: bypass.into(),
            ..NetworkConfig::default()
        }
    }

    #[test]
    fn a_bypass_list_reads_the_same_to_both() {
        assert_eq!(
            no_proxy_list("*.internal, <local>, 10.0.0.0/8"),
            ".internal,localhost,127.0.0.1,::1,10.0.0.0/8"
        );
        assert_eq!(no_proxy_list(""), "");
    }

    #[test]
    fn every_mode_the_engine_accepts_builds_a_client() {
        for (mode, server) in [
            ("system", ""),
            ("direct", ""),
            ("manual", "10.0.0.2:8080"),
            ("manual", "https://proxy.example:443"),
            ("manual", ""),
            ("pac", ""),
        ] {
            assert!(
                builder(&config(mode, server, "*.internal"))
                    .and_then(|b| b.build().map_err(|e| e.to_string()))
                    .is_ok(),
                "{mode} {server}"
            );
        }
    }

    #[test]
    fn a_socks_proxy_is_refused_rather_than_gone_around() {
        let error = builder(&config("manual", "socks5://10.0.0.2:1080", "")).expect_err("refused");
        assert!(error.contains("not an HTTP proxy"));
    }

    #[test]
    fn a_cached_client_is_rebuilt_when_the_settings_change() {
        let cached = Cached::new();
        let direct = config("direct", "", "");
        cached.get(&direct, |b| b).unwrap();
        assert_eq!(
            lock(&cached.0).as_ref().map(|(c, _)| c.clone()),
            Some(direct.clone())
        );
        let manual = config("manual", "10.0.0.2:8080", "");
        cached.get(&manual, |b| b).unwrap();
        assert_eq!(
            lock(&cached.0).as_ref().map(|(c, _)| c.clone()),
            Some(manual)
        );
    }
}
