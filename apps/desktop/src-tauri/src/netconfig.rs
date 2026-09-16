//! Where the browser sends its traffic: encrypted DNS, and a proxy.
//!
//! Both are Chromium command-line switches, and Chromium reads them once when
//! the process starts. Preferences live in the database, which is not open
//! yet at that point -- so the settings are mirrored to a small file beside
//! the profile as they are saved, and that file is what the launch reads.
//! Changing either needs a restart, which is what Chrome asks for too; the
//! setting says so rather than pretending otherwise.
//!
//! Nothing here contacts a resolver or a proxy itself. It decides which
//! switches the engine is started with, and refuses the ones that would
//! quietly do nothing (a `secure` DNS mode with no template) or that would
//! let a stray preference inject arbitrary switches.

use serde::{Deserialize, Serialize};

use crate::error::{AppError, AppResult};

/// How DNS is resolved.
///
/// `automatic` upgrades to `DoH` where the system resolver is known to offer
/// it and falls back otherwise; `secure` refuses to fall back, which is the
/// point of choosing it.
pub const DNS_MODES: &[&str] = &["system", "automatic", "secure"];

/// Where requests are sent.
pub const PROXY_MODES: &[&str] = &["system", "direct", "manual", "pac"];

/// The resolvers offered by name, so the common case is a choice rather than
/// a URL to get right. `custom` takes the template as typed.
pub const DNS_PROVIDERS: &[(&str, &str)] = &[
    ("cloudflare", "https://cloudflare-dns.com/dns-query"),
    ("google", "https://dns.google/dns-query"),
    ("quad9", "https://dns.quad9.net/dns-query"),
];

/// The startup mirror of the network preferences.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct NetworkConfig {
    /// One of [`DNS_MODES`].
    pub dns_mode: String,
    /// A name from [`DNS_PROVIDERS`], or `custom`.
    pub dns_provider: String,
    /// The template used when `dns_provider` is `custom`.
    pub dns_template: String,
    /// One of [`PROXY_MODES`].
    pub proxy_mode: String,
    /// `host:port`, for `manual`.
    pub proxy_server: String,
    /// The PAC script's address, for `pac`.
    pub proxy_pac_url: String,
    /// Hosts that skip the proxy, comma separated.
    pub proxy_bypass: String,
}

/// The file the launch reads, beside the profiles rather than inside one:
/// the switches are per process, not per profile.
fn path() -> std::path::PathBuf {
    crate::state::data_root().join("network.json")
}

/// The saved configuration, or the default when there is none or it is
/// unreadable. A launch must never fail because this file is damaged.
pub fn load() -> NetworkConfig {
    let Ok(bytes) = std::fs::read(path()) else {
        return NetworkConfig::default();
    };
    serde_json::from_slice(&bytes).unwrap_or_else(|error| {
        tracing::warn!(%error, "network settings unreadable; starting with the defaults");
        NetworkConfig::default()
    })
}

/// Mirror the configuration for the next launch.
pub fn save(config: &NetworkConfig) -> AppResult<()> {
    let path = path();
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(AppError::new)?;
    }
    let json = serde_json::to_vec_pretty(config).map_err(AppError::new)?;
    std::fs::write(path, json).map_err(AppError::new)
}

/// The `DoH` template this configuration resolves to, if any.
pub fn template_of(config: &NetworkConfig) -> Option<String> {
    if config.dns_provider == "custom" {
        let template = config.dns_template.trim();
        return https_url(template).map(str::to_owned);
    }
    DNS_PROVIDERS
        .iter()
        .find(|(name, _)| *name == config.dns_provider)
        .map(|(_, template)| (*template).to_owned())
}

/// A URL only when it is one, and only over https: a `DoH` template that is not
/// encrypted is the opposite of the setting.
fn https_url(value: &str) -> Option<&str> {
    let parsed = url::Url::parse(value).ok()?;
    (parsed.scheme() == "https" && parsed.host().is_some()).then_some(value)
}

/// `host:port`, with nothing in it that could become another switch.
fn proxy_authority(value: &str) -> Option<&str> {
    let value = value.trim();
    if value.is_empty() || value.len() > 255 {
        return None;
    }
    let plain = value
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | ':' | '_' | '[' | ']' | '/'));
    // A scheme is allowed (`socks5://10.0.0.1:1080`) but a space or a quote
    // would let a preference smuggle in a second switch.
    plain.then_some(value)
}

/// A bypass list Chromium will accept, with anything unsafe dropped.
fn bypass_list(value: &str) -> Option<String> {
    let cleaned: Vec<&str> = value
        .split(',')
        .map(str::trim)
        .filter(|entry| !entry.is_empty() && proxy_authority(entry).is_some())
        .collect();
    (!cleaned.is_empty()).then(|| cleaned.join(","))
}

/// The Chromium switches this configuration asks for.
///
/// Anything that does not add up is left out rather than passed on: a proxy
/// mode with no server, or a secure DNS mode with no template, would start
/// the engine in a state the settings screen does not describe.
pub fn flags(config: &NetworkConfig) -> Vec<(String, Option<String>)> {
    let mut args = Vec::new();

    if config.dns_mode != "system"
        && DNS_MODES.contains(&config.dns_mode.as_str())
        && let Some(template) = template_of(config)
    {
        args.push((
            "enable-features".to_owned(),
            Some("DnsOverHttps".to_owned()),
        ));
        args.push((
            "dns-over-https-mode".to_owned(),
            Some(config.dns_mode.clone()),
        ));
        args.push(("dns-over-https-templates".to_owned(), Some(template)));
    }

    match config.proxy_mode.as_str() {
        "direct" => args.push(("no-proxy-server".to_owned(), None)),
        "manual" => {
            if let Some(server) = proxy_authority(&config.proxy_server) {
                args.push(("proxy-server".to_owned(), Some(server.to_owned())));
                if let Some(bypass) = bypass_list(&config.proxy_bypass) {
                    args.push(("proxy-bypass-list".to_owned(), Some(bypass)));
                }
            }
        }
        "pac" => {
            if let Some(url) = https_url(config.proxy_pac_url.trim())
                .or_else(|| http_pac(config.proxy_pac_url.trim()))
            {
                args.push(("proxy-pac-url".to_owned(), Some(url.to_owned())));
            }
        }
        // "system" is Chromium's own default: no switch at all.
        _ => {}
    }
    args
}

/// A PAC script may legitimately be served over plain http on a local
/// network, which a `DoH` template may not.
fn http_pac(value: &str) -> Option<&str> {
    let parsed = url::Url::parse(value).ok()?;
    (matches!(parsed.scheme(), "http" | "https" | "file") && !value.contains(char::is_whitespace))
        .then_some(value)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn config(pairs: &[(&str, &str)]) -> NetworkConfig {
        let mut c = NetworkConfig {
            dns_mode: "system".into(),
            dns_provider: "cloudflare".into(),
            proxy_mode: "system".into(),
            ..NetworkConfig::default()
        };
        for (key, value) in pairs {
            match *key {
                "dns_mode" => c.dns_mode = (*value).into(),
                "dns_provider" => c.dns_provider = (*value).into(),
                "dns_template" => c.dns_template = (*value).into(),
                "proxy_mode" => c.proxy_mode = (*value).into(),
                "proxy_server" => c.proxy_server = (*value).into(),
                "proxy_pac_url" => c.proxy_pac_url = (*value).into(),
                "proxy_bypass" => c.proxy_bypass = (*value).into(),
                other => panic!("no field {other}"),
            }
        }
        c
    }

    fn names(config: &NetworkConfig) -> Vec<String> {
        flags(config).into_iter().map(|(name, _)| name).collect()
    }

    #[test]
    fn the_default_asks_for_nothing_and_leaves_chromium_as_it_was() {
        assert!(flags(&NetworkConfig::default()).is_empty());
        assert!(flags(&config(&[])).is_empty());
    }

    #[test]
    fn a_named_resolver_becomes_a_template() {
        let args = flags(&config(&[
            ("dns_mode", "secure"),
            ("dns_provider", "quad9"),
        ]));
        assert_eq!(
            args,
            vec![
                (
                    "enable-features".to_owned(),
                    Some("DnsOverHttps".to_owned())
                ),
                ("dns-over-https-mode".to_owned(), Some("secure".to_owned())),
                (
                    "dns-over-https-templates".to_owned(),
                    Some("https://dns.quad9.net/dns-query".to_owned())
                ),
            ]
        );
    }

    #[test]
    fn encrypted_dns_that_is_not_encrypted_is_refused() {
        // Without this the engine starts with DoH "on" and resolving in the
        // clear, which is worse than the setting being off.
        for template in ["http://dns.example/dns-query", "not a url", "", "ftp://x/y"] {
            let args = names(&config(&[
                ("dns_mode", "secure"),
                ("dns_provider", "custom"),
                ("dns_template", template),
            ]));
            assert!(args.is_empty(), "{template} was accepted");
        }
        let good = names(&config(&[
            ("dns_mode", "automatic"),
            ("dns_provider", "custom"),
            ("dns_template", "https://dns.example/dns-query"),
        ]));
        assert_eq!(good.len(), 3);
    }

    #[test]
    fn a_proxy_is_passed_on_only_when_it_is_usable() {
        assert_eq!(
            names(&config(&[
                ("proxy_mode", "manual"),
                ("proxy_server", "10.0.0.2:8080")
            ])),
            vec!["proxy-server"]
        );
        assert_eq!(
            names(&config(&[
                ("proxy_mode", "manual"),
                ("proxy_server", "socks5://10.0.0.2:1080")
            ])),
            vec!["proxy-server"]
        );
        // Nothing to point at: no switch rather than a broken one.
        assert!(names(&config(&[("proxy_mode", "manual")])).is_empty());
        assert_eq!(
            names(&config(&[("proxy_mode", "direct")])),
            vec!["no-proxy-server"]
        );
        assert!(names(&config(&[("proxy_mode", "system")])).is_empty());
    }

    #[test]
    fn a_preference_cannot_smuggle_in_another_switch() {
        for hostile in [
            "10.0.0.2:8080 --disable-web-security",
            "10.0.0.2:8080\n--no-sandbox",
            "\"; rm -rf /\"",
        ] {
            assert!(
                names(&config(&[
                    ("proxy_mode", "manual"),
                    ("proxy_server", hostile)
                ]))
                .is_empty(),
                "{hostile} was accepted"
            );
        }
    }

    #[test]
    fn the_bypass_list_keeps_the_entries_that_make_sense() {
        let args = flags(&config(&[
            ("proxy_mode", "manual"),
            ("proxy_server", "10.0.0.2:8080"),
            (
                "proxy_bypass",
                "localhost, 127.0.0.1, bad entry, *.internal",
            ),
        ]));
        let bypass = args
            .iter()
            .find(|(name, _)| name == "proxy-bypass-list")
            .and_then(|(_, value)| value.clone())
            .unwrap();
        assert_eq!(bypass, "localhost,127.0.0.1");
    }

    #[test]
    fn a_pac_script_may_be_local_but_never_a_stray_string() {
        assert_eq!(
            names(&config(&[
                ("proxy_mode", "pac"),
                ("proxy_pac_url", "http://wpad/proxy.pac")
            ])),
            vec!["proxy-pac-url"]
        );
        assert!(names(&config(&[("proxy_mode", "pac"), ("proxy_pac_url", "wpad")])).is_empty());
    }
}
