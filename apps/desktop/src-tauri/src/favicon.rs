//! Site icons. CEF exposes no favicon callback through Tauri, so the icon is
//! resolved inside the page's own renderer over CDP: the script below picks the
//! best `<link rel=icon>`, fetches it with the tab's own session, and hands back
//! a `data:` URL. Keeping the fetch in the tab means the chrome webview never
//! touches the network and the bytes stay inside the tab's container profile —
//! and a `data:` URL needs no CSP host allowance to render in the chrome.
//!
//! The store keeps each icon once, under a key made from its bytes, and a tab
//! carries only that key; the chrome asks for the image with `favicon_get` and
//! keeps it for as long as it runs. A tab event used to carry the icon itself,
//! tens of kilobytes per event and per tab in every snapshot.

use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use dive_cdp::{CdpEvent, CdpSession};
use dive_core::{TabId, Timestamp, origin_of};
use serde_json::{Value, json};
use tauri::{AppHandle, Manager};

use crate::Runtime;
use crate::engine::update_tab;
use crate::state::{AppState, lock};

/// Largest icon file we are willing to look at, in bytes. Anything bigger is
/// a hero image mislabelled as an icon.
const MAX_BYTES: usize = 64 * 1024;

/// Size a bitmap icon is kept at once it is bigger than this, in bytes. The
/// chrome draws icons at 16px at most, so a 32px copy is sharp on a Retina
/// screen; a 180px touch icon or a multi-size `.ico` kept whole is ten or
/// twenty times the bytes for nothing anyone can see.
const TARGET_BYTES: usize = 8 * 1024;

/// Largest SVG kept as it is. An SVG cannot be redrawn smaller reliably --
/// the page's CSP may refuse the `blob:` image that would take -- so one that
/// is bigger is passed over for the next candidate.
const MAX_SVG_BYTES: usize = 32 * 1024;

/// Longest `data:` URL accepted back from the page: the largest SVG, base64
/// encoded, plus its header.
const MAX_DATA_URL: usize = MAX_SVG_BYTES * 4 / 3 + 64;

/// How long an icon stays trusted without being fetched again when the page
/// still declares the same icon links. A site that changes the file behind
/// an unchanged link picks up the new one within this.
const TRUST_FOR: time::Duration = time::Duration::days(7);

/// Gaps between attempts after `load`, cumulative. Plenty of sites inject or
/// swap their icon from script well after the load event, so one look is not
/// enough: a missed swap sticks until the next navigation.
const ATTEMPTS: [Duration; 3] = [
    Duration::from_millis(400),
    Duration::from_millis(800),
    Duration::from_millis(1800),
];

/// Resolve the best icon for the current document. Answers `{ sig, same }`
/// when the page declares exactly the icon links `KNOWN_SOURCE` fingerprints,
/// `{ sig, data }` with a `data:` URL otherwise, or `{ sig, data: null }` when
/// nothing usable is reachable.
///
/// Candidates are ordered by how good they will look at 16px for the bytes
/// they cost: an SVG scales, then a bitmap between 32 and 64px, then larger
/// ones smallest first, then smaller ones largest first. `/favicon.ico` is the
/// last resort every server is expected to answer.
///
/// `fetch` comes first because it preserves the original bytes, so an SVG stays
/// an SVG. A bitmap bigger than `TARGET_BYTES` is redrawn at 32px; an image
/// bitmap made from fetched bytes never taints the canvas. When a strict
/// `connect-src` refuses the request -- common on large sites -- the icon is
/// loaded as an `<img>` and repainted through a canvas, because image loads
/// answer to `img-src`. Completed 404/non-image fetches are not requested
/// again, and the conventional `/favicon.ico` fallback runs only on the first
/// delayed attempt.
const RESOLVE: &str = r#"(async () => {
  const MAX = MAX_BYTES;
  const TARGET = TARGET_BYTES;
  const MAX_SVG = MAX_SVG_BYTES;
  const SIZE = 32;
  const abs = (h) => { try { return new URL(h, document.baseURI).href; } catch { return null; } };
  const links = Array.from(document.querySelectorAll(
    'link[rel~="icon" i], link[rel="shortcut icon" i], link[rel~="apple-touch-icon" i]'
  ));
  // How far a bitmap is from the 32-64px band: larger costs bytes (and is
  // redrawn), smaller blurs, and blurring is the worse of the two.
  const distance = (n) => n < 32 ? 100 + (32 - n) : n > 64 ? (n - 64) / 8 : 0;
  const score = (l) => {
    const type = (l.getAttribute('type') || '').toLowerCase();
    const href = (l.getAttribute('href') || '').toLowerCase();
    if (type.includes('svg') || /\.svg(\?|#|$)/.test(href)) return 1000;
    const sizes = (l.getAttribute('sizes') || '').toLowerCase();
    if (sizes === 'any') return 1000;
    const declared = sizes.split(/\s+/).map((s) => parseInt(s, 10) || 0).filter(Boolean);
    // Undeclared: Apple's icons are 180px; a plain icon is usually an .ico
    // holding 16 and 32.
    const guess = /apple-touch-icon/i.test(l.getAttribute('rel') || '') ? 180 : 32;
    const best = Math.min(...(declared.length ? declared : [guess]).map(distance));
    return 900 - best;
  };
  const seen = new Set();
  const candidates = links
    .map((l) => ({ href: abs(l.getAttribute('href')), score: score(l) }))
    .filter((c) => c.href && !seen.has(c.href) && seen.add(c.href))
    .sort((a, b) => b.score - a.score)
    .map((c) => c.href);

  // FNV-1a over the declared links: the same links as last time mean the
  // same icon, and the fetch below can be skipped.
  let hash = 0x811c9dc5;
  const text = candidates.join('\n');
  for (let i = 0; i < text.length; i++) { hash ^= text.charCodeAt(i); hash = Math.imul(hash, 0x01000193) >>> 0; }
  const sig = hash.toString(16);
  if (sig === KNOWN_SOURCE) return { sig, same: true };

  if (INCLUDE_FALLBACK) {
    try { candidates.push(new URL('/favicon.ico', location.origin).href); } catch {}
  }

  const redraw = (source, w, h) => {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = SIZE;
    const scale = Math.min(SIZE / (w || SIZE), SIZE / (h || SIZE));
    const dw = (w || SIZE) * scale, dh = (h || SIZE) * scale;
    canvas.getContext('2d').drawImage(source, (SIZE - dw) / 2, (SIZE - dh) / 2, dw, dh);
    return canvas.toDataURL('image/png');
  };

  const read = (blob) => new Promise((resolve) => {
    const fr = new FileReader();
    fr.onload = () => resolve(typeof fr.result === 'string' ? fr.result : null);
    fr.onerror = () => resolve(null);
    fr.readAsDataURL(blob);
  });

  const fromBlob = async (blob) => {
    // A server with no icon commonly answers 200 with its HTML 404 page, so
    // the content type is the only thing that tells an icon from a document.
    if (!blob.size || blob.size > MAX || !/^image\//.test(blob.type)) return null;
    if (/svg/.test(blob.type)) return blob.size > MAX_SVG ? null : read(blob);
    if (blob.size > TARGET) {
      try {
        const bitmap = await createImageBitmap(blob);
        const url = redraw(bitmap, bitmap.width, bitmap.height);
        bitmap.close();
        return url;
      } catch {}
    }
    return blob.size > MAX_SVG ? null : read(blob);
  };

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
      // An SVG with no intrinsic size reports 0; `redraw` then fills the square.
      try { done(redraw(img, img.naturalWidth, img.naturalHeight)); } catch { done(null); }
    };
    img.src = href;
  });

  for (const href of candidates.slice(0, 4)) {
    try {
      const out = await byFetch(href);
      if (out) return { sig, data: out };
    } catch {
      // The canvas route is useful when a page's connect-src blocks fetch.
      // A completed non-image/404 fetch cannot become valid by loading the
      // same URL again as an image, so do not duplicate that request.
      try {
        const out = await byCanvas(href);
        if (out) return { sig, data: out };
      } catch {}
    }
  }
  return { sig, data: null };
})()"#;

/// What the resolver found on a page.
#[derive(Debug, Clone, PartialEq, Eq)]
enum Resolved {
    /// The page declares the icon links the stored icon came from.
    Same,
    /// A fresh icon, and the fingerprint of the links it came from.
    Icon { data: String, source: String },
}

/// Watch `session` for navigations and keep the tab's icon current.
pub fn attach(app: AppHandle<Runtime>, tab_id: TabId, session: CdpSession) {
    // Subscribed before the task is spawned: the caller navigates as soon as
    // the other feeds are ready, and a subscription taken inside the task
    // could miss the first load entirely.
    let mut events = session.subscribe();
    tauri::async_runtime::spawn(async move {
        if let Err(e) = session.call0("Page.enable").await {
            crate::cdp_feed::setup_failed(tab_id, "the favicon watcher", &e);
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
                            let known = cached(&app, &next).map(|entry| entry.key);
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
                        // What the store already has for this site, when it
                        // is recent enough to be trusted without a fetch.
                        let known = origin
                            .as_deref()
                            .and_then(|origin| cached(&app, origin))
                            .filter(|entry| is_trusted(entry, Timestamp::now()));
                        for (attempt, delay) in ATTEMPTS.into_iter().enumerate() {
                            if session.is_closed() {
                                return;
                            }
                            tokio::time::sleep(delay).await;
                            if session.is_closed() || epoch.load(Ordering::SeqCst) != mine {
                                return;
                            }
                            let source = known.as_ref().map(|entry| entry.source.as_str());
                            let key = match resolve(&session, attempt == 0, source).await {
                                Some(Resolved::Same) => known.as_ref().map(|e| e.key.clone()),
                                Some(Resolved::Icon { data, source }) => {
                                    remember(&app, origin.as_deref(), &data, &source)
                                }
                                None => None,
                            };
                            if let Some(key) = key {
                                if epoch.load(Ordering::SeqCst) != mine {
                                    return;
                                }
                                // `update_tab` writes and announces nothing
                                // when the tab already wears this key.
                                update_tab(&app, tab_id, |t| t.favicon = Some(key));
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

/// Whether a stored icon is recent enough to stand in for a fetch when the
/// page still declares the links it came from. One stored before Dive kept
/// the links has no fingerprint to compare, so it is never trusted.
fn is_trusted(entry: &dive_core::FaviconEntry, now: Timestamp) -> bool {
    !entry.source.is_empty() && now.0 - entry.updated_at.0 < TRUST_FOR
}

/// File the icon under its origin so every other tab on that site wears it too
/// -- including ones restored from a previous session that have no renderer --
/// and return the key it is stored under. A page with no origin to file under
/// (a `file:` document) still gets its image stored, for its own tab.
///
/// Taken and released before [`update_tab`] takes the same lock; the two must
/// never nest.
fn remember(
    app: &AppHandle<Runtime>,
    origin: Option<&str>,
    data: &str,
    source: &str,
) -> Option<String> {
    let state = app.state::<AppState>();
    let store = lock(&state.store);
    let stored = match origin {
        Some(origin) => store.set_favicon(origin, data, source),
        None => store.put_favicon_image(data),
    };
    stored
        .inspect_err(|e| tracing::warn!(origin, "failed to remember favicon: {e}"))
        .ok()
}

/// What the store remembers about `origin`'s icon, if anything.
///
/// Like [`remember`], this must finish with the store lock before the caller
/// hands it to [`update_tab`].
fn cached(app: &AppHandle<Runtime>, origin: &str) -> Option<dive_core::FaviconEntry> {
    let state = app.state::<AppState>();
    lock(&state.store).favicon_entry(origin).unwrap_or_default()
}

/// The resolver with its limits, the fallback choice and the fingerprint of
/// the links behind the stored icon filled in.
fn expression(include_fallback: bool, known_source: Option<&str>) -> String {
    // A JSON string is a JavaScript string literal; an empty one matches no
    // fingerprint, since those are never empty.
    let known = Value::from(known_source.unwrap_or_default()).to_string();
    RESOLVE
        .replace("MAX_BYTES", &MAX_BYTES.to_string())
        .replace("TARGET_BYTES", &TARGET_BYTES.to_string())
        .replace("MAX_SVG_BYTES", &MAX_SVG_BYTES.to_string())
        .replace(
            "INCLUDE_FALLBACK",
            if include_fallback { "true" } else { "false" },
        )
        .replace("KNOWN_SOURCE", &known)
}

/// Read the resolver's answer.
fn parse_resolved(value: &Value) -> Option<Resolved> {
    if value["same"] == Value::Bool(true) {
        return Some(Resolved::Same);
    }
    let data = value["data"].as_str()?;
    (data.starts_with("data:image/") && data.len() <= MAX_DATA_URL).then(|| Resolved::Icon {
        data: data.to_owned(),
        source: value["sig"].as_str().unwrap_or_default().to_owned(),
    })
}

/// Run the resolver in the page and return what it found.
async fn resolve(
    session: &CdpSession,
    include_fallback: bool,
    known_source: Option<&str>,
) -> Option<Resolved> {
    let result = session
        .call(
            "Runtime.evaluate",
            json!({
                "expression": expression(include_fallback, known_source),
                "awaitPromise": true,
                "returnByValue": true,
                "timeout": 8000,
            }),
        )
        .await
        .inspect_err(|e| tracing::debug!("favicon evaluate failed: {e}"))
        .ok()?;
    parse_resolved(&result["result"]["value"])
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
            navigation_epoch: 0,
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
    fn resolver_script_carries_its_limits_and_the_known_source() {
        let expression = expression(true, Some("1a2b"));
        assert!(expression.contains("const MAX = 65536;"));
        assert!(expression.contains("const TARGET = 8192;"));
        assert!(expression.contains("const MAX_SVG = 32768;"));
        assert!(expression.contains(r#"if (sig === "1a2b") return { sig, same: true };"#));
        for placeholder in [
            "MAX_BYTES",
            "TARGET_BYTES",
            "MAX_SVG_BYTES",
            "INCLUDE_FALLBACK",
            "KNOWN_SOURCE",
        ] {
            assert!(!expression.contains(placeholder), "{placeholder} left in");
        }
        // Nothing known: an empty string, which no fingerprint equals.
        assert!(super::expression(false, None).contains(r#"if (sig === "") return"#));
        // A stored source is data, never script.
        let hostile = super::expression(false, Some(r#""; alert(1); ""#));
        assert!(hostile.contains(r#"=== "\"; alert(1); \"")"#), "{hostile}");
    }

    #[test]
    fn reads_what_the_resolver_found() {
        assert_eq!(
            parse_resolved(&json!({"sig": "9", "same": true})),
            Some(Resolved::Same)
        );
        assert_eq!(
            parse_resolved(&json!({"sig": "9", "data": "data:image/png;base64,AA"})),
            Some(Resolved::Icon {
                data: "data:image/png;base64,AA".into(),
                source: "9".into()
            })
        );
        assert_eq!(parse_resolved(&json!({"sig": "9", "data": null})), None);
        assert_eq!(
            parse_resolved(&json!({"data": "data:text/html,<p>404</p>"})),
            None
        );
        let huge = format!("data:image/svg+xml;base64,{}", "A".repeat(MAX_DATA_URL));
        assert_eq!(parse_resolved(&json!({ "data": huge })), None);
        assert_eq!(parse_resolved(&Value::Null), None);
    }

    #[test]
    fn a_stored_icon_is_trusted_for_a_week_and_only_with_its_links() {
        let now = Timestamp::now();
        let entry = |source: &str, days: i64| dive_core::FaviconEntry {
            key: "k".into(),
            source: source.into(),
            updated_at: Timestamp(now.0 - time::Duration::days(days)),
        };
        assert!(is_trusted(&entry("9f", 1), now));
        assert!(!is_trusted(&entry("9f", 8), now));
        assert!(
            !is_trusted(&entry("", 0), now),
            "no fingerprint, nothing to compare"
        );
    }

    #[test]
    fn resolver_prefers_icons_near_the_size_they_are_drawn_at() {
        // The ranking, and the redraw that keeps a large bitmap small.
        assert!(RESOLVE.contains("n < 32 ? 100 + (32 - n) : n > 64 ? (n - 64) / 8 : 0"));
        assert!(RESOLVE.contains("createImageBitmap(blob)"));
        assert!(RESOLVE.contains("if (blob.size > TARGET)"));
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
