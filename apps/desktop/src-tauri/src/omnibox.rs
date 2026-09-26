//! What the address bar makes of what was typed: an address to open, or
//! words to search for.
//!
//! The chrome decides the same thing on its own to label the first
//! suggestion "Open" or "Search" (`looksLikeUrl` in `src/lib/omnibox.ts`), and
//! a label that disagrees with what Enter then does is worse than no label.
//! So both read one list of top-level domains (`omnibox/tlds.txt`) and are
//! tested against one set of examples (`omnibox/vectors.json`); a rule
//! changed here has to change there too, and the shared examples say so.

use std::net::{Ipv4Addr, Ipv6Addr};
use std::path::PathBuf;

/// Schemes the engine loads itself when they are typed out in full.
const ADDRESS_SCHEMES: &[&str] = &[
    "http",
    "https",
    "file",
    "about",
    "data",
    "blob",
    "view-source",
    crate::engine::INTERNAL_SCHEME,
];

/// Top-level domains a bare name must end in to be taken for a site.
const TLDS: &str = include_str!("omnibox/tlds.txt");

/// Endings reserved for home and office networks that no public registry
/// hands out: nothing there has a certificate, so they are asked for over
/// plain http like the ones `https_only::is_local` knows.
const PRIVATE_TLDS: &[&str] = &["lan", "home", "corp", "intranet"];

/// What was typed, understood.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Typed {
    /// Open this.
    Address(url::Url),
    /// Search for these words.
    Search(String),
}

/// Read what was typed into the address bar; `None` when there is nothing
/// to act on.
pub fn classify(input: &str) -> Option<Typed> {
    let text = input.trim();
    if text.is_empty() {
        return None;
    }
    // A leading question mark is how a person says "search, even though
    // this looks like an address", as in every other browser.
    if let Some(rest) = text.strip_prefix('?') {
        let rest = rest.trim();
        return (!rest.is_empty()).then(|| Typed::Search(rest.to_owned()));
    }
    if let Some(url) = file_path(text)
        .or_else(|| with_scheme(text))
        .or_else(|| bare_host(text))
    {
        return Some(Typed::Address(url));
    }
    Some(Typed::Search(text.to_owned()))
}

/// A path on this machine: absolute, from the home folder, or (on Windows)
/// from a drive letter.
fn file_path(text: &str) -> Option<url::Url> {
    if text.starts_with('/') {
        return url::Url::from_file_path(text).ok();
    }
    if text == "~" || text.starts_with("~/") {
        let home = PathBuf::from(std::env::var_os("HOME")?);
        let path = home.join(text[1..].trim_start_matches('/'));
        return url::Url::from_file_path(path).ok();
    }
    let bytes = text.as_bytes();
    if cfg!(windows)
        && bytes.len() > 2
        && bytes[0].is_ascii_alphabetic()
        && bytes[1] == b':'
        && matches!(bytes[2], b'\\' | b'/')
    {
        return url::Url::from_file_path(text).ok();
    }
    None
}

/// An address typed with its scheme: one the engine loads, or another app's
/// (`mailto:`, `vscode:`, `zoommtg:`), which is passed on untouched so the
/// navigation reaches the "open in another app" question instead of a search.
fn with_scheme(text: &str) -> Option<url::Url> {
    let url = url::Url::parse(text).ok()?;
    let scheme = url.scheme();
    if ADDRESS_SCHEMES.contains(&scheme) {
        return Some(url);
    }
    let (_, rest) = text.split_once(':')?;
    // "localhost:3000" and "example.com:8080/x" parse as a scheme and a
    // path; they are a host and a port.
    let port_like = rest.starts_with(|c: char| c.is_ascii_digit())
        && rest
            .trim_start_matches(|c: char| c.is_ascii_digit())
            .chars()
            .next()
            .is_none_or(|c| matches!(c, '/' | '?' | '#'));
    let external = scheme.len() > 1
        && !port_like
        && !rest.is_empty()
        // "std::io::Read" is a question about Rust, not a link to an app.
        && !rest.starts_with(':')
        && !text.chars().any(char::is_whitespace)
        && crate::external_link::is_external(&url);
    external.then_some(url)
}

/// A host typed without a scheme (`example.com/docs`, `localhost:5173`,
/// `[::1]:8080`), given http when it is on this machine or the local network
/// and https everywhere else.
fn bare_host(text: &str) -> Option<url::Url> {
    if text.chars().any(char::is_whitespace) {
        return None;
    }
    let authority = &text[..text.find(['/', '?', '#']).unwrap_or(text.len())];
    let (host, port) = split_port(authority)?;
    let local = if let Some(v6) = host.strip_prefix('[') {
        let v6 = v6.strip_suffix(']')?;
        v6.parse::<Ipv6Addr>().ok()?;
        crate::https_only::is_local(v6)
    } else if let Ok(v4) = host.parse::<Ipv4Addr>() {
        v4.is_unspecified() || crate::https_only::is_local(host)
    } else {
        let name = host.strip_suffix('.').unwrap_or(host).to_ascii_lowercase();
        let labels: Vec<&str> = name.split('.').collect();
        if labels.iter().any(|label| !valid_label(label)) {
            return None;
        }
        let tld = labels.last().copied().unwrap_or_default();
        if labels.len() == 1 {
            // A single word is a search, unless it is this machine or names
            // a port: "myserver:8080" is somebody's intranet, "12:30" a time.
            let named =
                tld == "localhost" || (port.is_some() && tld.chars().any(|c| !c.is_ascii_digit()));
            if !named {
                return None;
            }
            true
        } else {
            // A port says "address" plainly enough; otherwise the ending has
            // to be a real one, or "node.js" and "3.14" would be opened.
            if port.is_none() && !known_tld(tld) {
                return None;
            }
            PRIVATE_TLDS.contains(&tld) || crate::https_only::is_local(&name)
        }
    };
    let scheme = if local { "http" } else { "https" };
    url::Url::parse(&format!("{scheme}://{text}")).ok()
}

/// `host:port` split apart, with a port that is a real one or none at all.
fn split_port(authority: &str) -> Option<(&str, Option<u16>)> {
    let (host, port) = if authority.starts_with('[') {
        let end = authority.find(']')?;
        let (host, rest) = authority.split_at(end + 1);
        match rest {
            "" => (host, None),
            _ => (host, Some(rest.strip_prefix(':')?)),
        }
    } else {
        match authority.split_once(':') {
            Some((host, port)) => (host, Some(port)),
            None => (authority, None),
        }
    };
    if host.is_empty() {
        return None;
    }
    let port = match port {
        None => None,
        Some(port) if !port.is_empty() && port.bytes().all(|b| b.is_ascii_digit()) => {
            Some(port.parse::<u16>().ok()?)
        }
        Some(_) => return None,
    };
    Some((host, port))
}

/// Whether `label` could be one part of a host name. Anything outside ASCII
/// is left for the URL parser to judge, so "münchen.de" is a site.
fn valid_label(label: &str) -> bool {
    !label.is_empty()
        && label
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_' || !c.is_ascii())
}

/// Whether `tld` is an ending the bar recognises: a listed one, or an
/// internationalised one, which are too many to list and never collide with
/// a file extension.
fn known_tld(tld: &str) -> bool {
    tld.starts_with("xn--")
        || !tld.is_ascii()
        || TLDS
            .lines()
            .filter(|line| !line.starts_with('#'))
            .flat_map(str::split_whitespace)
            .any(|known| known == tld)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;

    /// The examples the chrome's own copy of these rules is tested against.
    #[test]
    fn agrees_with_the_shared_examples() {
        let vectors: Vec<Value> =
            serde_json::from_str(include_str!("omnibox/vectors.json")).unwrap();
        assert!(vectors.len() > 40);
        for vector in vectors {
            let input = vector["input"].as_str().unwrap();
            if vector["unix"].as_bool() == Some(true) && cfg!(windows) {
                continue;
            }
            let got = classify(input);
            if vector["empty"].as_bool() == Some(true) {
                assert_eq!(got, None, "{input:?}");
            } else if let Some(search) = vector["search"].as_str() {
                assert_eq!(got, Some(Typed::Search(search.to_owned())), "{input:?}");
            } else if let Some(url) = vector["url"].as_str() {
                match got {
                    Some(Typed::Address(got)) => assert_eq!(got.as_str(), url, "{input:?}"),
                    other => panic!("{input:?} should open {url}, got {other:?}"),
                }
            } else if let Some(tail) = vector["file"].as_str() {
                match got {
                    Some(Typed::Address(got)) => {
                        assert_eq!(got.scheme(), "file", "{input:?}");
                        assert!(got.path().ends_with(tail), "{input:?} gave {got}");
                    }
                    other => panic!("{input:?} should open a file, got {other:?}"),
                }
            } else {
                panic!("vector {vector} says nothing about the outcome");
            }
        }
    }

    #[test]
    fn the_listed_endings_are_lowercase_and_unique() {
        let listed: Vec<&str> = TLDS
            .lines()
            .filter(|line| !line.starts_with('#'))
            .flat_map(str::split_whitespace)
            .collect();
        let mut unique = listed.clone();
        unique.sort_unstable();
        unique.dedup();
        assert_eq!(unique.len(), listed.len(), "a domain is listed twice");
        assert!(listed.iter().all(|tld| *tld == tld.to_ascii_lowercase()));
        assert!(!known_tld("js") && !known_tld("14") && known_tld("uk"));
    }

    #[test]
    fn a_windows_drive_is_never_taken_for_another_app() {
        // "C:" parses as a scheme; it must not become an app link.
        assert!(!matches!(
            classify(r"C:\Users\me"),
            Some(Typed::Address(url)) if url.scheme() == "c"
        ));
    }
}
