//! Typed helpers for the `Page` and `Emulation` domains used by the toolkit.

use base64::Engine as _;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::{CdpError, CdpSession, Result};

/// Upper bound for one full-page capture in CSS pixels. Chromium has to
/// allocate the whole surface before PNG compression; bounding it prevents a
/// pathological document from taking down the browser process.
pub const MAX_FULL_PAGE_PIXELS: f64 = 32_000_000.0;
/// Upper bound for either side of a full-page capture.
pub const MAX_FULL_PAGE_DIMENSION: f64 = 32_768.0;

/// Image encoding for screenshots.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ImageFormat {
    /// Lossless PNG.
    Png,
    /// JPEG, quality controlled by [`ScreenshotOptions::quality`].
    Jpeg,
    /// WebP, quality controlled by [`ScreenshotOptions::quality`].
    Webp,
}

/// A rectangle in CSS pixels plus a scale factor, as CDP's `Viewport`.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct Clip {
    /// Left edge in CSS pixels.
    pub x: f64,
    /// Top edge in CSS pixels.
    pub y: f64,
    /// Width in CSS pixels.
    pub width: f64,
    /// Height in CSS pixels.
    pub height: f64,
    /// Multiplier over the device pixel ratio; `1.0` keeps CSS pixels.
    pub scale: f64,
}

/// Options for [`capture_screenshot`].
#[derive(Debug, Clone, Copy)]
pub struct ScreenshotOptions {
    /// Output encoding.
    pub format: ImageFormat,
    /// 0..=100, ignored for PNG.
    pub quality: Option<u8>,
    /// Region to capture; `None` captures the viewport.
    pub clip: Option<Clip>,
    /// Render content outside the viewport instead of resizing the window.
    pub capture_beyond_viewport: bool,
}

impl Default for ScreenshotOptions {
    fn default() -> Self {
        Self {
            format: ImageFormat::Png,
            quality: None,
            clip: None,
            capture_beyond_viewport: false,
        }
    }
}

/// Document and viewport sizes from `Page.getLayoutMetrics`.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct LayoutMetrics {
    /// Full document width in CSS pixels.
    pub content_width: f64,
    /// Full document height in CSS pixels.
    pub content_height: f64,
    /// Visible viewport width in CSS pixels.
    pub viewport_width: f64,
    /// Visible viewport height in CSS pixels.
    pub viewport_height: f64,
}

/// Navigate the main frame to `url` and return the frame id.
pub async fn navigate(session: &CdpSession, url: &str) -> Result<String> {
    let result = session.call("Page.navigate", json!({ "url": url })).await?;
    if let Some(text) = result.get("errorText").and_then(Value::as_str) {
        return Err(CdpError::Protocol {
            code: 0,
            message: text.to_owned(),
        });
    }
    result
        .get("frameId")
        .and_then(Value::as_str)
        .map(str::to_owned)
        .ok_or(CdpError::MissingField("frameId"))
}

/// Read document and viewport dimensions.
pub async fn layout_metrics(session: &CdpSession) -> Result<LayoutMetrics> {
    let result = session.call0("Page.getLayoutMetrics").await?;
    let size = |key: &'static str, field: &str| -> Result<f64> {
        result
            .get(key)
            .and_then(|v| v.get(field))
            .and_then(Value::as_f64)
            .ok_or(CdpError::MissingField(key))
    };
    Ok(LayoutMetrics {
        content_width: size("cssContentSize", "width")?,
        content_height: size("cssContentSize", "height")?,
        viewport_width: size("cssLayoutViewport", "clientWidth")?,
        viewport_height: size("cssLayoutViewport", "clientHeight")?,
    })
}

/// Capture a screenshot and return the decoded image bytes.
pub async fn capture_screenshot(session: &CdpSession, opts: ScreenshotOptions) -> Result<Vec<u8>> {
    let mut params = json!({
        "format": opts.format,
        "captureBeyondViewport": opts.capture_beyond_viewport,
        "fromSurface": true,
    });
    if let Some(q) = opts.quality {
        params["quality"] = json!(q.min(100));
    }
    if let Some(clip) = opts.clip {
        params["clip"] = serde_json::to_value(clip)?;
    }
    let result = session.call("Page.captureScreenshot", params).await?;
    let data = result
        .get("data")
        .and_then(Value::as_str)
        .ok_or(CdpError::MissingField("data"))?;
    base64::engine::general_purpose::STANDARD
        .decode(data)
        .map_err(|e| CdpError::Transport(format!("bad base64 in screenshot: {e}")))
}

/// Capture the whole document after visibly traversing it. The traversal lets
/// lazy content render and gives a user-initiated capture honest progress.
pub async fn capture_full_page(session: &CdpSession, format: ImageFormat) -> Result<Vec<u8>> {
    session
        .call(
            "Runtime.evaluate",
            json!({
                "expression": FULL_PAGE_SCROLL_SCRIPT,
                "awaitPromise": true,
                "returnByValue": true,
            }),
        )
        .await?;

    let captured = capture_full_page_instant(session, format).await;
    let restored = session
        .call(
            "Runtime.evaluate",
            json!({
                "expression": FULL_PAGE_RESTORE_SCRIPT,
                "awaitPromise": true,
                "returnByValue": true,
            }),
        )
        .await;
    match captured {
        Ok(bytes) => {
            restored?;
            Ok(bytes)
        }
        Err(error) => Err(error),
    }
}

/// Capture the full document without moving it. Automation uses this variant
/// so an agent screenshot stays quick and does not animate in front of people.
pub async fn capture_full_page_instant(
    session: &CdpSession,
    format: ImageFormat,
) -> Result<Vec<u8>> {
    let metrics = layout_metrics(session).await?;
    let width = metrics.content_width;
    let height = metrics.content_height;
    if !width.is_finite()
        || !height.is_finite()
        || width <= 0.0
        || height <= 0.0
        || width > MAX_FULL_PAGE_DIMENSION
        || height > MAX_FULL_PAGE_DIMENSION
        || width * height > MAX_FULL_PAGE_PIXELS
    {
        return Err(CdpError::InvalidArgument(format!(
            "full-page capture {width}x{height} exceeds the safe {MAX_FULL_PAGE_PIXELS:.0} pixel / {MAX_FULL_PAGE_DIMENSION:.0} px side limit"
        )));
    }
    capture_screenshot(
        session,
        ScreenshotOptions {
            format,
            quality: None,
            clip: Some(Clip {
                x: 0.0,
                y: 0.0,
                width: metrics.content_width,
                height: metrics.content_height,
                scale: 1.0,
            }),
            capture_beyond_viewport: true,
        },
    )
    .await
}

const FULL_PAGE_SCROLL_SCRIPT: &str = r"
(() => new Promise((resolve) => {
  const root = document.scrollingElement;
  if (!root) { resolve(false); return; }
  const key = '__diveFullPageCapture';
  const body = document.body;
  globalThis[key] = {
    x: globalThis.scrollX,
    y: globalThis.scrollY,
    rootBehavior: root.style.getPropertyValue('scroll-behavior'),
    rootPriority: root.style.getPropertyPriority('scroll-behavior'),
    bodyBehavior: body ? body.style.getPropertyValue('scroll-behavior') : '',
    bodyPriority: body ? body.style.getPropertyPriority('scroll-behavior') : ''
  };
  root.style.setProperty('scroll-behavior', 'auto', 'important');
  if (body) body.style.setProperty('scroll-behavior', 'auto', 'important');
  globalThis.scrollTo(0, 0);
  const reduced = globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  let steps = 0;
  let stalls = 0;
  let last = -1;
  const advance = () => {
    const bottom = Math.max(0, root.scrollHeight - globalThis.innerHeight);
    const step = Math.max(360, globalThis.innerHeight * 0.78);
    const next = Math.min(bottom, globalThis.scrollY + step);
    globalThis.scrollTo(0, next);
    steps += 1;
    stalls = Math.abs(globalThis.scrollY - last) < 1 ? stalls + 1 : 0;
    last = globalThis.scrollY;
    if (globalThis.scrollY >= bottom - 1 || stalls >= 3 || steps >= 240) {
      globalThis.scrollTo(0, bottom);
      globalThis.setTimeout(() => resolve(true), reduced ? 0 : 100);
      return;
    }
    globalThis.setTimeout(advance, reduced ? 0 : 70);
  };
  globalThis.setTimeout(advance, reduced ? 0 : 70);
}))()
";

const FULL_PAGE_RESTORE_SCRIPT: &str = r"
(() => new Promise((resolve) => {
  const root = document.scrollingElement;
  const body = document.body;
  const key = '__diveFullPageCapture';
  const state = globalThis[key];
  if (!root || !state) { resolve(false); return; }
  const restore = (element, value, priority) => {
    if (!element) return;
    if (value) element.style.setProperty('scroll-behavior', value, priority);
    else element.style.removeProperty('scroll-behavior');
  };
  restore(root, state.rootBehavior, state.rootPriority);
  restore(body, state.bodyBehavior, state.bodyPriority);
  globalThis.scrollTo(state.x, state.y);
  delete globalThis[key];
  globalThis.requestAnimationFrame(() => resolve(true));
}))()
";

#[cfg(test)]
mod tests {
    use super::*;
    use crate::Transport;
    use std::sync::{Arc, Mutex};

    /// Answers every call immediately with a canned result, in order.
    struct Scripted {
        session: Arc<Mutex<Option<CdpSession>>>,
        replies: Mutex<Vec<Value>>,
        sent: Arc<Mutex<Vec<Value>>>,
    }

    impl Transport for Scripted {
        fn send(&self, message: &str) -> Result<()> {
            let msg: Value = serde_json::from_str(message)?;
            self.sent.lock().unwrap().push(msg.clone());
            let reply = self.replies.lock().unwrap().remove(0);
            let session = self.session.lock().unwrap().clone().unwrap();
            session.handle_incoming(&json!({"id": msg["id"], "result": reply}).to_string())
        }
    }

    fn scripted(replies: Vec<Value>) -> (CdpSession, Arc<Mutex<Vec<Value>>>) {
        let slot = Arc::new(Mutex::new(None));
        let sent = Arc::new(Mutex::new(Vec::new()));
        let session = CdpSession::new(Scripted {
            session: slot.clone(),
            replies: Mutex::new(replies),
            sent: sent.clone(),
        });
        *slot.lock().unwrap() = Some(session.clone());
        (session, sent)
    }

    #[tokio::test]
    async fn full_page_uses_content_size_as_clip() {
        let png = base64::engine::general_purpose::STANDARD.encode(b"PNGDATA");
        let (session, sent) = scripted(vec![
            json!({"result": {"value": true},
                   "cssContentSize": {"width": 1280, "height": 4000},
                   "cssLayoutViewport": {"clientWidth": 1280, "clientHeight": 800}}),
            json!({"data": png, "cssContentSize": {"width": 1280, "height": 4000},
                   "cssLayoutViewport": {"clientWidth": 1280, "clientHeight": 800}}),
            json!({"data": base64::engine::general_purpose::STANDARD.encode(b"PNGDATA")}),
            json!({"result": {"value": true}}),
        ]);
        let bytes = capture_full_page(&session, ImageFormat::Png).await.unwrap();
        assert_eq!(bytes, b"PNGDATA");
        let sent = sent.lock().unwrap();
        assert_eq!(sent[0]["method"], "Runtime.evaluate");
        assert_eq!(sent[0]["params"]["awaitPromise"], true);
        let shot = &sent[2];
        assert_eq!(shot["method"], "Page.captureScreenshot");
        assert_eq!(shot["params"]["clip"]["height"], 4000.0);
        assert_eq!(shot["params"]["captureBeyondViewport"], true);
        assert_eq!(sent[3]["method"], "Runtime.evaluate");
    }

    #[tokio::test]
    async fn full_page_rejects_a_surface_large_enough_to_exhaust_memory() {
        let (session, sent) = scripted(vec![json!({
            "cssContentSize": {"width": 100_000, "height": 100_000},
            "cssLayoutViewport": {"clientWidth": 1280, "clientHeight": 800}
        })]);
        let error = capture_full_page_instant(&session, ImageFormat::Png)
            .await
            .unwrap_err();
        assert!(error.to_string().contains("safe"), "{error}");
        assert_eq!(
            sent.lock().unwrap().len(),
            1,
            "captureScreenshot must not be sent"
        );
    }

    #[tokio::test]
    async fn animated_capture_restores_scroll_after_capture_failure() {
        let (session, sent) = scripted(vec![
            json!({"result": {"value": true}}),
            json!({
                "cssContentSize": {"width": 100_000, "height": 100_000},
                "cssLayoutViewport": {"clientWidth": 1280, "clientHeight": 800}
            }),
            json!({"result": {"value": true}}),
        ]);

        let error = capture_full_page(&session, ImageFormat::Png)
            .await
            .unwrap_err();
        assert!(error.to_string().contains("safe"), "{error}");
        let sent = sent.lock().unwrap();
        assert_eq!(sent.len(), 3);
        assert_eq!(sent[2]["method"], "Runtime.evaluate");
    }

    #[tokio::test]
    async fn navigate_reports_error_text() {
        let (session, _) = scripted(vec![
            json!({"frameId": "f", "errorText": "net::ERR_FAILED"}),
        ]);
        let err = navigate(&session, "http://x").await.unwrap_err();
        assert!(err.to_string().contains("ERR_FAILED"));
    }
}
