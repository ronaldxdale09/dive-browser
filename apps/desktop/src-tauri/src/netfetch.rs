//! Fetching, from the host, an address a page chose.
//!
//! A page can name any URL -- an icon in its manifest, a script in a stack
//! frame, a source map at the end of that script -- and a fetch made for it
//! by the host runs outside the sandbox, from this machine, with this
//! machine's view of the network. Left alone that is a way for any site to
//! make the browser read the router's admin page, a cloud metadata endpoint
//! or a dev server on localhost, and to learn from the answer.
//!
//! So a page-chosen fetch resolves the name itself, refuses it when any
//! address it resolves to is private, loopback or link-local, and then
//! connects to exactly the addresses it checked, so a second lookup cannot
//! answer differently. Redirects are followed by hand and each hop checked
//! the same way. Only an address that names a local machine outright may
//! reach one, and only when the caller says the page itself is local.
//!
//! The fetch goes the way the engine's traffic goes: through the proxy set
//! in Settings when there is one, directly when Settings says so, and
//! otherwise however the environment says (see [`crate::netconfig`]).

use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::time::Duration;

/// Whether a fetch may reach this machine or its network.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Reach {
    /// Public addresses only.
    Public,
    /// Local addresses too, for a page that is itself on a local machine: a
    /// dev server's icons and source maps live beside it.
    AlsoLocal,
}

/// Most redirects followed before giving up.
const MAX_REDIRECTS: usize = 5;

/// Whether `url` names a local machine outright: `localhost`, a name under
/// `.localhost`, or an address that is not public. A name that merely
/// resolves to one does not count; that is the trick this module is for.
pub fn names_local_host(url: &url::Url) -> bool {
    match url.host() {
        Some(url::Host::Domain(name)) => {
            let name = name.trim_end_matches('.').to_ascii_lowercase();
            name == "localhost" || name.ends_with(".localhost")
        }
        Some(url::Host::Ipv4(ip)) => !is_public(IpAddr::V4(ip)),
        Some(url::Host::Ipv6(ip)) => !is_public(IpAddr::V6(ip)),
        None => false,
    }
}

/// Whether an address is on the public internet.
///
/// Written out because the standard library's `is_global` is not stable.
/// Everything that is this machine, a private network, link-local (which is
/// where cloud metadata services answer), carrier-grade NAT, multicast,
/// documentation or reserved space counts as not public.
pub fn is_public(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(ip) => public_v4(ip),
        IpAddr::V6(ip) => {
            if let Some(v4) = ip.to_ipv4_mapped() {
                return public_v4(v4);
            }
            let segments = ip.segments();
            !(ip.is_loopback()
                || ip.is_unspecified()
                || ip.is_multicast()
                // Unique local, fc00::/7.
                || (segments[0] & 0xfe00) == 0xfc00
                // Link-local, fe80::/10, and the old site-local, fec0::/10.
                || (segments[0] & 0xffc0) == 0xfe80
                || (segments[0] & 0xffc0) == 0xfec0
                // Documentation, 2001:db8::/32.
                || (segments[0] == 0x2001 && segments[1] == 0x0db8)
                // NAT64, which reaches whatever IPv4 address it embeds.
                || (segments[0] == 0x0064 && segments[1] == 0xff9b))
        }
    }
}

fn public_v4(ip: Ipv4Addr) -> bool {
    let [a, b, ..] = ip.octets();
    !(ip.is_private()
        || ip.is_loopback()
        || ip.is_link_local()
        || ip.is_broadcast()
        || ip.is_documentation()
        || ip.is_unspecified()
        || ip.is_multicast()
        || a == 0
        // Carrier-grade NAT, 100.64.0.0/10.
        || (a == 100 && (b & 0xc0) == 64)
        // Benchmarking, 198.18.0.0/15.
        || (a == 198 && (b & 0xfe) == 18)
        // Reserved, 240.0.0.0/4.
        || a >= 240)
}

/// The addresses `url` connects to, refused when `reach` does not allow one.
async fn addresses(url: &url::Url, reach: Reach) -> Result<Vec<SocketAddr>, String> {
    let port = url
        .port_or_known_default()
        .ok_or_else(|| format!("{url} has no port"))?;
    let found: Vec<SocketAddr> = match url.host() {
        Some(url::Host::Ipv4(ip)) => vec![SocketAddr::new(IpAddr::V4(ip), port)],
        Some(url::Host::Ipv6(ip)) => vec![SocketAddr::new(IpAddr::V6(ip), port)],
        Some(url::Host::Domain(name)) => tokio::net::lookup_host((name, port))
            .await
            .map_err(|e| format!("could not resolve {name}: {e}"))?
            .collect(),
        None => return Err(format!("{url} has no host")),
    };
    if found.is_empty() {
        return Err(format!("{url} resolves to nothing"));
    }
    if reach == Reach::Public && found.iter().any(|addr| !is_public(addr.ip())) {
        return Err(format!(
            "{} resolves to an address on this machine or its network, which a page may not make the browser fetch",
            url.host_str().unwrap_or_default()
        ));
    }
    Ok(found)
}

/// A client for one request to `url`, pinned to `pinned` and sent the way
/// the engine's traffic goes.
fn client(
    url: &url::Url,
    pinned: &[SocketAddr],
    timeout: Duration,
) -> Result<reqwest::Client, String> {
    let mut builder = reqwest::Client::builder()
        .connect_timeout(timeout.min(Duration::from_secs(5)))
        .timeout(timeout)
        .redirect(reqwest::redirect::Policy::none());
    if let Some(url::Host::Domain(name)) = url.host() {
        builder = builder.resolve_to_addrs(name, pinned);
    }
    builder = match crate::netconfig::host_proxy() {
        crate::netconfig::HostProxy::System => builder,
        crate::netconfig::HostProxy::Direct => builder.no_proxy(),
        crate::netconfig::HostProxy::Server(server) => builder.proxy(
            reqwest::Proxy::all(server.as_str()).map_err(|e| format!("proxy {server}: {e}"))?,
        ),
    };
    builder.build().map_err(|e| e.to_string())
}

/// GET `url`, a page's choice, and return at most `max_bytes` of its body.
///
/// `follow` says whether redirects are followed at all; a caller that has
/// checked `url` against something (a source map against its script's
/// origin) turns them off so the check still means something at the end.
pub async fn get(
    url: &str,
    reach: Reach,
    max_bytes: usize,
    timeout: Duration,
    follow: bool,
) -> Result<Vec<u8>, String> {
    use futures_util::StreamExt as _;
    let mut url = url::Url::parse(url).map_err(|e| format!("{url} is not an address: {e}"))?;
    let mut hops = 0;
    let response = loop {
        if !matches!(url.scheme(), "http" | "https") {
            return Err(format!("{}: addresses are not fetched", url.scheme()));
        }
        let pinned = addresses(&url, reach).await?;
        let response = client(&url, &pinned, timeout)?
            .get(url.clone())
            .send()
            .await
            .map_err(|e| e.to_string())?;
        if !response.status().is_redirection() {
            break response;
        }
        if !follow || hops == MAX_REDIRECTS {
            return Err(format!(
                "{url} redirected, and the redirect was not followed"
            ));
        }
        let location = response
            .headers()
            .get(reqwest::header::LOCATION)
            .and_then(|v| v.to_str().ok())
            .ok_or_else(|| format!("{url} redirected nowhere"))?;
        url = url
            .join(location)
            .map_err(|e| format!("{url} redirected to {location}: {e}"))?;
        hops += 1;
    };
    if !response.status().is_success() {
        return Err(format!("{url} answered {}", response.status()));
    }
    if response
        .content_length()
        .is_some_and(|n| usize::try_from(n).map_or(true, |n| n > max_bytes))
    {
        return Err(format!("{url} is larger than {max_bytes} bytes"));
    }
    let mut out = Vec::new();
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| e.to_string())?;
        if out.len() + chunk.len() > max_bytes {
            return Err(format!("{url} is larger than {max_bytes} bytes"));
        }
        out.extend_from_slice(&chunk);
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ip(s: &str) -> IpAddr {
        s.parse().unwrap()
    }

    #[test]
    fn only_the_public_internet_is_public() {
        for public in ["93.184.216.34", "1.1.1.1", "2606:4700:4700::1111"] {
            assert!(is_public(ip(public)), "{public}");
        }
        for local in [
            "127.0.0.1",
            "10.0.0.8",
            "172.16.4.4",
            "192.168.1.1",
            "169.254.169.254",
            "100.64.0.1",
            "0.0.0.0",
            "198.18.0.1",
            "240.0.0.1",
            "255.255.255.255",
            "::1",
            "::",
            "fd00::1",
            "fe80::1",
            "::ffff:127.0.0.1",
            "::ffff:169.254.169.254",
            "64:ff9b::a9fe:a9fe",
        ] {
            assert!(!is_public(ip(local)), "{local}");
        }
    }

    #[test]
    fn a_local_machine_is_named_outright_or_not_at_all() {
        let named = |s: &str| names_local_host(&url::Url::parse(s).unwrap());
        assert!(named("http://localhost:5173/app.js"));
        assert!(named("http://app.localhost/"));
        assert!(named("http://127.0.0.1:3000/"));
        assert!(named("http://[::1]:3000/"));
        assert!(named("http://192.168.1.20/"));
        // A public name is public here, whatever it resolves to later.
        assert!(!named("https://localhost.evil.example/"));
        assert!(!named("https://example.com/"));
    }

    #[tokio::test]
    async fn a_page_cannot_make_the_host_fetch_a_local_address() {
        for url in [
            "http://127.0.0.1:9/",
            "http://169.254.169.254/latest/meta-data/",
            "http://[::1]:9/",
            "http://10.1.2.3/",
        ] {
            let error = get(url, Reach::Public, 1024, Duration::from_secs(1), true)
                .await
                .expect_err(url);
            assert!(
                error.contains("this machine or its network"),
                "{url}: {error}"
            );
        }
        let error = get(
            "file:///etc/passwd",
            Reach::AlsoLocal,
            1024,
            Duration::from_secs(1),
            true,
        )
        .await
        .unwrap_err();
        assert!(error.contains("not fetched"), "{error}");
    }
}
