//! Site icons. CEF exposes no favicon callback through Tauri, so the icon is
//! resolved inside the page's own renderer over CDP: the script below picks the
//! best `<link rel=icon>`, fetches it with the tab's own session, and hands back
//! a `data:` URL. Keeping the fetch in the tab means the chrome webview never
//! touches the network and the bytes stay inside the tab's container profile —
//! and a `data:` URL needs no CSP host allowance to render in the chrome.

use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use dive_cdp::{CdpEvent, CdpSession};
use dive_core::{TabId, origin_of};
use serde_json::json;
use tauri::{AppHandle, Manager};

use crate::Runtime;
use crate::engine::update_tab;
use crate::state::{AppState, lock};

/// Largest icon we are willing to inline, in bytes of encoded image. Anything
/// bigger is a hero image mislabelled as an icon; the row it would bloat is
/// re-read on every snapshot.
const MAX_BYTES: usize = 64 * 1024;

/// Gaps between attempts after `load`, cumulative. Plenty of sites inject or
/// swap their icon from script well after the load event, so one look is not
/// enough: a missed swap sticks until the next navigation.
const ATTEMPTS: [Duration; 3] = [
    Duration::from_millis(400),
    Duration::from_millis(800),
    Duration::from_millis(1800),
];

/// Resolve the best icon for the current document and return it as a `data:`
/// URL, or `null` when nothing usable is reachable.
///
/// Ordered by how crisp the result will be at 16px: an SVG scales, otherwise
/// the largest declared bitmap wins, and `/favicon.ico` is the last resort
/// every server is expected to answer.
///
/// `fetch` comes first because it preserves the original bytes, so an SVG stays
/// an SVG. When a strict `connect-src` refuses that request -- common on large
/// sites -- the icon is loaded as an `<img>` and repainted through a canvas,
/// because image loads answer to `img-src`. Completed 404/non-image fetches are
/// not requested again, and the conventional `/favicon.ico` fallback runs only
/// on the first delayed attempt.
const RESOLVE: &str = r#"(async () => {
  const MAX = MAX_BYTES;
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
  if (INCLUDE_FALLBACK) {
    try { candidates.push(new URL('/favicon.ico', location.origin).href); } catch {}
  }

  const fromBlob = (blob) => new Promise((resolve) => {
    // A server with no icon commonly answers 200 with its HTML 404 page, so
    // the content type is the only thing that tells an icon from a document.
    if (!blob.size || blob.size > MAX || !/^image\//.test(blob.type)) return resolve(null);
    const fr = new FileReader();
    fr.onload = () => resolve(typeof fr.result === 'string' ? fr.result : null);
    fr.onerror = () => resolve(null);
    fr.readAsDataURL(blob);
  });

  const byFetch = async (href) => {
    const res = await fetch(href, { credentials: 'omit', redirect: 'follow' });
    return res.ok ? await fromBlob(await res.blob()) : null;
  };

  const byCanvas = (href) => new Promise((resolve) => {
    const img = new Image();
    // Without this a cross-origin icon taints the canvas and toDataURL throws;
    // with it the load simply fails unless the host opted into CORS. Either
    // way the answer is null, and same-origin icons -- the usual case -- work.
    img.crossOrigin = 'anonymous';
    const done = (v) => { clearTimeout(timer); img.onload = img.onerror = null; resolve(v); };
    const timer = setTimeout(() => done(null), 1500);
    img.onerror = () => done(null);
    img.onload = () => {
      try {
        // An SVG with no intrinsic size reports 0; 32px is enough for a mark
        // that is drawn at 14, and caps what a huge PNG can cost.
        const n = Math.min(64, Math.max(img.naturalWidth, img.naturalHeight) || 32);
        const canvas = document.createElement('canvas');
        canvas.width = canvas.height = n;
        canvas.getContext('2d').drawImage(img, 0, 0, n, n);
        const url = canvas.toDataURL('image/png');
        done(url.length > MAX ? null : url);
      } catch { done(null); }
    };
    img.src = href;
  });

  for (const href of candidates.slice(0, 4)) {
    try {
      const out = await byFetch(href);
      if (out) return out;
    } catch {
      // The canvas route is useful when a page's connect-src blocks fetch.
      // A completed non-image/404 fetch cannot become valid by loading the
      // same URL again as an image, so do not duplicate that request.
      try {
        const out = await byCanvas(href);
        if (out) return out;
      } catch {}
    }
  }
  return null;
})()"#;

/// Watch `session` for navigations and keep the tab's icon current.
pub fn attach(app: AppHandle<Runtime>, tab_id: TabId, session: CdpSession) {
    // Subscribed before the task is spawned: the caller navigates as soon as
    // the other feeds are ready, and a subscription taken inside the task
    // could miss the first load entirely.
    let mut events = session.subscribe();
    tauri::async_runtime::spawn(async move {
        if let Err(e) = session.call0("Page.enable").await {
            tracing::warn!(%tab_id, "Page.enable failed: {e}");
            return;
        }
        // The origin the current icon belongs to. A move to another origin
        // invalidates it immediately, so no tab ever wears a stranger's mark.
        let mut origin: Option<String> = None;
        // Bumped whenever the page underneath changes. A resolver already in
        // flight compares it before writing, so a slow answer for the page we
        // just left can never land on the page we are on.
        let epoch = Arc::new(AtomicU64::new(0));
        loop {
            match events.recv().await {
                Ok(event) => {
                    if let Some(next) = navigated_origin(&event) {
                        if origin.as_deref() != Some(next.as_str()) {
                            epoch.fetch_add(1, Ordering::SeqCst);
                            // Sites we have seen before get their mark back at
                            // once instead of flashing the fallback globe for
                            // as long as the page takes to load.
                            let known = cached(&app, &next);
                            origin = Some(next);
                            update_tab(&app, tab_id, |t| t.favicon = known);
                        }
                        continue;
                    }
                    if !is_load(&event) {
                        continue;
                    }
                    let mine = epoch.fetch_add(1, Ordering::SeqCst) + 1;
                    let (app, session, epoch, origin) =
                        (app.clone(), session.clone(), epoch.clone(), origin.clone());
                    // Spawned so the retries never stall this listener: a
                    // navigation during them has to be seen to cancel them.
                    tauri::async_runtime::spawn(async move {
                        for (attempt, delay) in ATTEMPTS.into_iter().enumerate() {
                            tokio::time::sleep(delay).await;
                            if epoch.load(Ordering::SeqCst) != mine {
                                return;
                            }
                            if let Some(data) = resolve(&session, attempt == 0).await {
                                if epoch.load(Ordering::SeqCst) != mine {
                                    return;
                                }
                                remember(&app, origin.as_deref(), &data);
                                update_tab(&app, tab_id, |t| t.favicon = Some(data));
                                return;
                            }
                        }
                        tracing::debug!(%tab_id, "no favicon for this page");
                    });
                }
                Err(tokio::sync::broadcast::error::RecvError::Lagged(n)) => {
                    tracing::warn!(%tab_id, n, "favicon listener lagged");
                }
                Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
            }
        }
    });
}

/// File the icon under its origin so every other tab on that site wears it too
/// -- including ones restored from a previous session that have no renderer.
///
/// Taken and released before [`update_tab`] takes the same lock; the two must
/// never nest.
fn remember(app: &AppHandle<Runtime>, origin: Option<&str>, data: &str) {
    let Some(origin) = origin else { return };
    let state = app.state::<AppState>();
    if let Err(e) = lock(&state.store).set_favicon(origin, data) {
        tracing::warn!(origin, "failed to remember favicon: {e}");
    }
}

/// The icon already remembered for `origin`, if any.
///
/// Like [`remember`], this must finish with the store lock before the caller
/// hands it to [`update_tab`].
fn cached(app: &AppHandle<Runtime>, origin: &str) -> Option<String> {
    let state = app.state::<AppState>();
    lock(&state.store).favicon(origin).unwrap_or_default()
}

/// Run the resolver in the page and return the `data:` URL it produced.
async fn resolve(session: &CdpSession, include_fallback: bool) -> Option<String> {
    let expression = RESOLVE
        .replace("MAX_BYTES", &MAX_BYTES.to_string())
        .replace(
            "INCLUDE_FALLBACK",
            if include_fallback { "true" } else { "false" },
        );
    let result = session
        .call(
            "Runtime.evaluate",
            json!({
                "expression": expression,
                "awaitPromise": true,
                "returnByValue": true,
                "timeout": 8000,
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
    origin_of(url)
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
        let expression = RESOLVE
            .replace("MAX_BYTES", &MAX_BYTES.to_string())
            .replace("INCLUDE_FALLBACK", "true");
        assert!(expression.contains("const MAX = 65536;"));
        assert!(!expression.contains("MAX_BYTES"));
        assert!(!expression.contains("INCLUDE_FALLBACK"));
    }

    #[test]
    fn resolver_script_has_a_fallback_for_a_blocked_fetch() {
        // A strict `connect-src` is the usual reason a real site's icon never
        // arrives, so the canvas path has to stay wired into the attempt list.
        assert!(RESOLVE.contains("byCanvas"));
        assert!(RESOLVE.contains("const out = await byCanvas(href)"));
    }

    #[test]
    fn resolver_can_skip_the_default_fallback_on_retries() {
        assert!(RESOLVE.contains("if (INCLUDE_FALLBACK)"));
    }
}
