//! Which site an address belongs to, in the sense the web uses for trust:
//! the registrable domain (`mail.example.co.uk` is `example.co.uk`), or the
//! address itself for a machine named by its IP.
//!
//! Two pages of one site share cookies and are usually one party; two sites
//! are two parties. That is the line the agent's taint tracking and the web
//! app install check both need, and a host comparison draws it in the wrong
//! place: `app.example.com` and `example.com` are one site, while
//! `a.github.io` and `b.github.io` are two.

/// The site `url` belongs to, or `None` when it is not a web address.
pub fn of(url: &str) -> Option<String> {
    let parsed = url::Url::parse(url.trim()).ok()?;
    of_url(&parsed)
}

/// [`of`] for an address that has already been parsed.
pub fn of_url(url: &url::Url) -> Option<String> {
    if !matches!(url.scheme(), "http" | "https") {
        return None;
    }
    match url.host()? {
        url::Host::Ipv4(ip) => Some(ip.to_string()),
        url::Host::Ipv6(ip) => Some(format!("[{ip}]")),
        url::Host::Domain(host) => {
            let host = host.trim_end_matches('.').to_ascii_lowercase();
            // A name with no public suffix -- `localhost`, a dev box on the
            // LAN -- is its own site.
            let site = psl::domain(host.as_bytes())
                .and_then(|d| std::str::from_utf8(d.as_bytes()).ok().map(str::to_owned))
                .unwrap_or(host);
            Some(site)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_site_is_its_registrable_domain() {
        assert_eq!(
            of("https://mail.example.co.uk/inbox").as_deref(),
            Some("example.co.uk")
        );
        assert_eq!(of("https://example.com").as_deref(), Some("example.com"));
        assert_eq!(of("http://localhost:3000/x").as_deref(), Some("localhost"));
        assert_eq!(of("http://127.0.0.1:8080/").as_deref(), Some("127.0.0.1"));
        assert_eq!(of("https://[::1]/").as_deref(), Some("[::1]"));
        assert_eq!(of("file:///etc/passwd"), None);
        assert_eq!(of("not a url"), None);
        // Subdomains are one site; pages hosted under a shared suffix are not.
        assert_eq!(of("https://app.example.com/a"), of("https://example.com/b"));
        assert_eq!(of("https://EXAMPLE.com./a"), of("https://example.com/b"));
        assert_ne!(of("https://a.github.io/"), of("https://b.github.io/"));
    }
}
