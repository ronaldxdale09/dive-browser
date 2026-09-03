//! Site icons. CEF exposes no favicon callback through Tauri, so the icon is
//! resolved inside the page's own renderer over CDP: the script below picks the
//! best `<link rel=icon>`, fetches it with the tab's own session, and hands back
//! a `data:` URL. Keeping the fetch in the tab means the chrome webview never
//! touches the network and the bytes stay inside the tab's container profile —
//! and a `data:` URL needs no CSP host allowance to render in the chrome.

use std::time::Duration;

use dive_cdp::{CdpEvent, CdpSession};
use dive_core::TabId;
use serde_json::json;
use tauri::AppHandle;

use crate::Runtime;
use crate::engine::update_tab;

/// Largest icon we are willing to inline, in bytes of encoded image. Anything
/// bigger is a hero image mislabelled as an icon; the row it would bloat is
/// re-read on every snapshot.
const MAX_BYTES: usize = 64 * 1024;

/// How long to wait after `load` before looking. Plenty of sites inject or
/// swap their icon from script, and a missed swap sticks until the next load.
const SETTLE: Duration = Duration::from_millis(400);

/// Resolve the best icon for the current document and return it as a `data:`
/// URL, or `null` when nothing usable is reachable.
///
/// Ordered by how crisp the result will be at 16px: an SVG scales, otherwise
/// the largest declared bitmap wins, and `/favicon.ico` is the last resort
/// every server is expected to answer.
const RESOLVE: &str = r#"(async () => {
  const abs = (h) => { try { return new URL(h, document.baseURI).href; } catch { return null; } };
  const links = Array.from(document.querySelectorAll(
    'link[rel~="icon" i], link[rel="shortcut icon" i], link[rel~="apple-touch-icon" i]'
  ));
  const score = (l) => {
    const type = (l.getAttribute('type') || '').toLowerCase();
    const href = (l.getAttribute('href') || '').toLowerCase();
    if (type.includes('svg') || /\.svg(\?|#|$)/.test(href)) return 4096;
    const sizes = (l.getAttribute('sizes') || '').toLowerCase();
    if (sizes === 'any') return 4096;
    const n = Math.max(0, ...sizes.split(/\s+/).map((s) => parseInt(s, 10) || 0));
    return n || 16;
  };
  const seen = new Set();
  const candidates = links
    .map((l) => ({ href: abs(l.getAttribute('href')), score: score(l) }))
    .filter((c) => c.href && !seen.has(c.href) && seen.add(c.href))
    .sort((a, b) => b.score - a.score)
    .map((c) => c.href);
  try { candidates.push(new URL('/favicon.ico', location.origin).href); } catch {}

  for (const href of candidates.slice(0, 4)) {
    try {
      const res = await fetch(href, { credentials: 'omit', redirect: 'follow' });
      if (!res.ok) continue;
      const blob = await res.blob();
      // A server with no icon commonly answers 200 with its HTML 404 page, so
      // the content type is the only thing that tells an icon from a document.
      if (!blob.size || blob.size > MAX_BYTES || !/^image\//.test(blob.type)) continue;
      return await new Promise((resolve) => {
        const fr = new FileReader();
        fr.onload = () => resolve(typeof fr.result === 'string' ? fr.result : null);
        fr.onerror = () => resolve(null);
        fr.readAsDataURL(blob);
      });
    } catch {}
  }
  return null;
})()"#;

/// Watch `session` for navigations and keep the tab's icon current.
pub fn attach(app: AppHandle<Runtime>, tab_id: TabId, session: CdpSession) {
    tauri::async_runtime::spawn(async move {
        let mut events = session.subscribe();
        if let Err(e) = session.call0("Page.enable").await {
            tracing::warn!(%tab_id, "Page.enable failed: {e}");
            return;
        }
        // The origin the current icon belongs to. A move to another origin
        // invalidates it immediately, so no tab ever wears a stranger's mark.
        let mut origin: Option<String> = None;
        loop {
            match events.recv().await {
                Ok(event) => {
                    if let Some(next) = navigated_origin(&event) {
                        if origin.as_deref() != Some(next.as_str()) {
                            origin = Some(next);
                            update_tab(&app, tab_id, |t| t.favicon = None);
                        }
                        continue;
                    }
                    if !is_load(&event) {
                        continue;
                    }
                    tokio::time::sleep(SETTLE).await;
                    if let Some(data) = resolve(&session).await {
                        update_tab(&app, tab_id, |t| t.favicon = Some(data));
                    } else {
                        tracing::debug!(%tab_id, "no favicon for this page");
                    }
                }
                Err(tokio::sync::broadcast::error::RecvError::Lagged(n)) => {
                    tracing::warn!(%tab_id, n, "favicon listener lagged");
                }
                Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
            }
        }
    });
}

/// Run the resolver in the page and return the `data:` URL it produced.
async fn resolve(session: &CdpSession) -> Option<String> {
    let expression = RESOLVE.replace("MAX_BYTES", &MAX_BYTES.to_string());
    let result = session
        .call(
            "Runtime.evaluate",
            json!({
                "expression": expression,
                "awaitPromise": true,
                "returnByValue": true,
                "timeout": 5000,
            }),
        )
        .await
        .inspect_err(|e| tracing::debug!("favicon evaluate failed: {e}"))
        .ok()?;
    let value = result["result"]["value"].as_str()?;
    (value.starts_with("data:image/") && value.len() <= MAX_BYTES * 2).then(|| value.to_owned())
}

/// Whether the event says the top frame finished loading.
fn is_load(event: &CdpEvent) -> bool {
    event.method == "Page.loadEventFired"
}

/// The new origin when the event is a top-frame navigation, else `None`.
///
/// Same-document navigations are included: a single-page app can swap its icon
/// on a route change without ever firing `load` again.
fn navigated_origin(event: &CdpEvent) -> Option<String> {
    let url = match event.method.as_str() {
        "Page.frameNavigated" => {
            let frame = &event.params["frame"];
            // Sub-frames carry a parent; only the top frame owns the icon.
            if !frame["parentId"].is_null() {
                return None;
            }
            frame["url"].as_str()?
        }
        "Page.navigatedWithinDocument" => event.params["url"].as_str()?,
        _ => return None,
    };
    url::Url::parse(url)
        .ok()
        .map(|u| u.origin().ascii_serialization())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;

    fn ev(method: &str, params: Value) -> CdpEvent {
        CdpEvent {
            method: method.into(),
            params,
        }
    }

    #[test]
    fn reads_the_origin_of_top_frame_navigations_only() {
        let top = ev(
            "Page.frameNavigated",
            json!({"frame": {"id": "1", "url": "https://example.com/a/b?q=1"}}),
        );
        assert_eq!(
            navigated_origin(&top).as_deref(),
            Some("https://example.com")
        );

        let child = ev(
            "Page.frameNavigated",
            json!({"frame": {"id": "2", "parentId": "1", "url": "https://ads.example.net/x"}}),
        );
        assert!(navigated_origin(&child).is_none());

        let spa = ev(
            "Page.navigatedWithinDocument",
            json!({"url": "https://example.com/route"}),
        );
        assert_eq!(
            navigated_origin(&spa).as_deref(),
            Some("https://example.com")
        );

        assert!(navigated_origin(&ev("Page.loadEventFired", json!({}))).is_none());
    }

    #[test]
    fn recognises_the_load_event() {
        assert!(is_load(&ev("Page.loadEventFired", json!({}))));
        assert!(!is_load(&ev("Page.domContentEventFired", json!({}))));
    }

    #[test]
    fn resolver_script_carries_the_size_cap() {
        let expression = RESOLVE.replace("MAX_BYTES", &MAX_BYTES.to_string());
        assert!(expression.contains("blob.size > 65536"));
        assert!(!expression.contains("MAX_BYTES"));
    }
}
