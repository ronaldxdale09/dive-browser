//! Keep a page as a file.
//!
//! One file, not a folder: Chromium can serialise a live document and
//! everything it loaded into a single MHTML archive, so a saved page still
//! has its images and stylesheets when it is opened later, offline, in Dive
//! or in any Chromium browser.
//!
//! It is the live document that is saved, not a fresh request for the URL:
//! a page behind a login, or one that only exists after some scrolling, is
//! kept as it actually was on screen.

use dive_cdp::CdpSession;
use dive_core::TabId;
use serde_json::json;

use crate::error::{AppError, AppResult};
use crate::state::{AppState, lock};

/// Longest a page archive may be, so a runaway document cannot eat the disk.
const MAX_ARCHIVE: usize = 256 * 1024 * 1024;

/// A file name for this page: its title, else its host, with anything a file
/// system would object to replaced. Always ends in `.mhtml`.
pub fn file_name(title: &str, url: &str) -> String {
    let base = title.trim();
    let base = if base.is_empty() || base == "about:blank" {
        url::Url::parse(url)
            .ok()
            .and_then(|parsed| parsed.host_str().map(str::to_owned))
            .unwrap_or_else(|| "page".into())
    } else {
        base.to_owned()
    };
    let mut cleaned: String = base
        .chars()
        .map(|c| {
            if c.is_control() || matches!(c, '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|') {
                ' '
            } else {
                c
            }
        })
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    cleaned.truncate(120);
    let cleaned = cleaned.trim_matches('.').trim().to_owned();
    if cleaned.is_empty() {
        "page.mhtml".into()
    } else {
        format!("{cleaned}.mhtml")
    }
}

/// The tab's live document as an MHTML archive.
pub async fn archive(session: &CdpSession, tab_id: TabId) -> AppResult<String> {
    let result = session
        .call("Page.captureSnapshot", json!({"format": "mhtml"}))
        .await
        .map_err(|error| AppError::new(format!("this page could not be saved: {error}")))?;
    let data = result["data"]
        .as_str()
        .ok_or_else(|| AppError::new("this page could not be saved"))?;
    if data.len() > MAX_ARCHIVE {
        return Err(AppError::new("this page is too large to save"));
    }
    tracing::debug!(%tab_id, bytes = data.len(), "page archived");
    Ok(data.to_owned())
}

/// Everything the save needs from the host, gathered under its locks and
/// released before any dialog or disk work.
pub fn target(state: &AppState, tab_id: TabId) -> AppResult<(CdpSession, String)> {
    let session = {
        let host = lock(&state.host);
        host.as_ref()
            .and_then(|host| {
                host.sessions()
                    .into_iter()
                    .find_map(|(id, session)| (id == tab_id).then_some(session))
            })
            .ok_or_else(|| AppError::new("this tab is not loaded"))?
    };
    let suggested = {
        let store = lock(&state.store);
        let tab = store.tab(tab_id)?;
        file_name(&tab.title, &tab.url)
    };
    Ok((session, suggested))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_a_file_after_the_page() {
        assert_eq!(
            file_name("Rust Programming Language", "https://rust-lang.org"),
            "Rust Programming Language.mhtml"
        );
        // A title a file system would refuse still makes a file.
        assert_eq!(file_name("a/b:c*d?", "https://x.dev"), "a b c d.mhtml");
        // No title worth using falls back to the site.
        assert_eq!(file_name("", "https://example.com/a"), "example.com.mhtml");
        assert_eq!(
            file_name("about:blank", "https://example.com/a"),
            "example.com.mhtml"
        );
        // Nothing usable anywhere still yields a name.
        assert_eq!(file_name("", "not a url"), "page.mhtml");
        assert_eq!(file_name("...", "not a url"), "page.mhtml");
    }

    #[test]
    fn keeps_the_name_short_enough_for_a_file_system() {
        let long = "x".repeat(400);
        let name = file_name(&long, "https://x.dev");
        assert!(name.len() <= 130, "{} chars", name.len());
        assert!(
            std::path::Path::new(&name)
                .extension()
                .is_some_and(|e| e == "mhtml")
        );
    }
}
