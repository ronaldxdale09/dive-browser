//! Network capture: maps CDP `Network.*` lifecycle events into typed events
//! the dock folds into request rows.

use dive_cdp::{CdpEvent, CdpSession};
use dive_core::TabId;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use specta::Type;
use tauri::AppHandle;
use tauri_specta::Event;

use crate::Runtime;

/// One step in a request's life. The chrome merges these by `request_id`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type, Event)]
#[serde(tag = "type", content = "data", rename_all = "snake_case")]
pub enum NetworkEvent {
    /// A request left the browser.
    Sent {
        /// Tab that issued it.
        tab_id: TabId,
        /// CDP request id, unique per session.
        request_id: String,
        /// Full URL.
        url: String,
        /// HTTP method.
        method: String,
        /// `Document`, `Script`, `XHR`, `Fetch`, `Image`, ...
        resource_type: String,
        /// Request headers as sent by the renderer.
        headers: std::collections::BTreeMap<String, String>,
        /// Request body when present and small.
        post_data: Option<String>,
        /// Seconds since an arbitrary monotonic origin.
        timestamp: f64,
        /// Seconds since the epoch, for exports.
        wall_time: f64,
    },
    /// Headers arrived.
    Response {
        /// Tab.
        tab_id: TabId,
        /// Request id.
        request_id: String,
        /// HTTP status.
        status: u16,
        /// Content type without parameters.
        mime_type: String,
        /// Whether it was served from cache.
        from_cache: bool,
        /// Response headers.
        headers: std::collections::BTreeMap<String, String>,
        /// Seconds.
        timestamp: f64,
    },
    /// Body fully received.
    Finished {
        /// Tab.
        tab_id: TabId,
        /// Request id.
        request_id: String,
        /// Bytes on the wire.
        encoded_length: f64,
        /// Seconds.
        timestamp: f64,
    },
    /// A WebSocket handshake started; shown as a request row.
    Socket {
        /// Tab.
        tab_id: TabId,
        /// Request id.
        request_id: String,
        /// Socket URL.
        url: String,
        /// Seconds.
        timestamp: f64,
    },
    /// A WebSocket frame or a server-sent event.
    Frame {
        /// Tab.
        tab_id: TabId,
        /// Request id of the socket or event stream.
        request_id: String,
        /// `sent` or `received`.
        direction: String,
        /// Text payload, truncated; binary frames are summarised.
        payload: String,
        /// Seconds.
        timestamp: f64,
    },
    /// Request failed or was blocked.
    Failed {
        /// Tab.
        tab_id: TabId,
        /// Request id.
        request_id: String,
        /// Chromium error text, e.g. `net::ERR_FAILED`.
        error: String,
        /// Seconds.
        timestamp: f64,
    },
}

/// Enable bounded inspector storage at every call site: Chromium resets
/// omitted limits to defaults when Network.enable is called again.
pub(crate) async fn enable(session: &CdpSession) -> Result<Value, dive_cdp::CdpError> {
    session
        .call(
            "Network.enable",
            serde_json::json!({
                "maxTotalBufferSize": 2 * 1024 * 1024,
                "maxResourceBufferSize": MAX_BODY,
                "maxPostDataSize": MAX_BODY,
            }),
        )
        .await
}

/// Forward metadata independently of the bounded response capture worker.
pub fn attach(
    app: AppHandle<Runtime>,
    tab_id: TabId,
    session: CdpSession,
    view_label: String,
) -> crate::cdp_feed::Ready {
    use tauri::Manager;
    let (ready_tx, ready_rx) = tokio::sync::oneshot::channel();
    tauri::async_runtime::spawn(async move {
        let mut events = session.subscribe();
        let capture_enabled = match enable(&session).await {
            Ok(_) => true,
            Err(error) => {
                tracing::warn!(%tab_id, %error, "body capture disabled: engine limits were not acknowledged");
                false
            }
        };
        let (queue, receiver) = tokio::sync::mpsc::channel(BODY_QUEUE_CAP);
        let body_app = app.clone();
        let body_session = session.clone();
        let body_label = view_label.clone();
        let worker = tauri::async_runtime::spawn(body_worker(
            receiver,
            session.clone(),
            body_slots(),
            tab_id,
            move |id, result| {
                record_capture(&body_app, tab_id, &body_session, &body_label, &id, result);
            },
        ));
        let mut tracker = BodyTracker::default();
        let _ = ready_tx.send(());
        loop {
            match events.recv().await {
                Ok(event) => {
                    tracker.observe(&event);
                    if let Some(item) = map_event(tab_id, &event) {
                        let state = app.state::<crate::state::AppState>();
                        let host = crate::state::lock(&state.host);
                        if session.is_closed()
                            || host.as_ref().is_none_or(|host| {
                                !host
                                    .with_view(tab_id, |view| Ok(view.label() == view_label))
                                    .unwrap_or(false)
                            })
                        {
                            continue;
                        }
                        state.buffers.push_network(&item);
                        if let NetworkEvent::Finished { request_id, .. } = &item {
                            let eligibility = tracker.finish(request_id);
                            if state.buffers.is_json_response(tab_id, request_id) {
                                let eligibility = if capture_enabled {
                                    eligibility
                                } else {
                                    Err(
                                        "Body capture unavailable: engine limits were not acknowledged",
                                    )
                                };
                                match eligibility {
                                    Ok(()) => {
                                        if queue.try_send(request_id.clone()).is_err() {
                                            state.buffers.set_response_body_note(
                                                tab_id,
                                                request_id,
                                                "Body omitted: capture queue is busy",
                                            );
                                        }
                                    }
                                    Err(note) => state
                                        .buffers
                                        .set_response_body_note(tab_id, request_id, note),
                                }
                            }
                        }
                        if let Err(error) = item.emit(&app) {
                            tracing::warn!(%tab_id, %error, "network event emit failed");
                        }
                    }
                }
                Err(tokio::sync::broadcast::error::RecvError::Lagged(missed)) => {
                    tracker.clear();
                    tracing::warn!(%tab_id, missed, "network feed lagged; partial body sizes discarded");
                }
                Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
            }
        }
        // Cancel both queued and in-flight capture immediately on session close.
        // Dropping a pending CDP call and its permit releases their resources.
        worker.abort();
    });
    ready_rx
}

fn record_capture(
    app: &AppHandle<Runtime>,
    tab: TabId,
    session: &CdpSession,
    label: &str,
    id: &str,
    result: Result<String, &'static str>,
) {
    use tauri::Manager;
    let state = app.state::<crate::state::AppState>();
    // Retain the host lock through the buffer write: a closing renderer cannot
    // attach its body to a replacement view's reused request ID.
    let host = crate::state::lock(&state.host);
    if session.is_closed()
        || host.as_ref().is_none_or(|host| {
            !host
                .with_view(tab, |view| Ok(view.label() == label))
                .unwrap_or(false)
        })
    {
        return;
    }
    match result {
        Ok(body) => state.buffers.set_response_body(tab, id, body),
        Err(note) => state.buffers.set_response_body_note(tab, id, note),
    }
}

pub(crate) const MAX_BODY: usize = 64 * 1024;
const TRACKED_RESPONSES: usize = 1024;
const BODY_QUEUE_CAP: usize = 16;
const MAX_URL: usize = 8 * 1024;
const MAX_HEADER_NAME: usize = 256;
const MAX_HEADER_VALUE: usize = 8 * 1024;
const MAX_HEADERS: usize = 200;

#[derive(Default)]
struct BodySize {
    bytes: Option<usize>,
    observed: bool,
}
#[derive(Default)]
struct BodyTracker {
    responses: std::collections::HashMap<String, BodySize>,
}
impl BodyTracker {
    fn observe(&mut self, event: &CdpEvent) {
        let Some(id) = event.params["requestId"].as_str() else {
            return;
        };
        match event.method.as_str() {
            "Network.requestWillBeSent" | "Network.loadingFailed" => {
                self.responses.remove(id);
            }
            "Network.responseReceived" => {
                self.responses.remove(id);
                if is_json_mime(
                    event.params["response"]["mimeType"]
                        .as_str()
                        .unwrap_or_default(),
                ) && self.responses.len() < TRACKED_RESPONSES
                {
                    self.responses.insert(
                        id.to_owned(),
                        BodySize {
                            bytes: Some(0),
                            observed: false,
                        },
                    );
                }
            }
            "Network.dataReceived" => {
                if let Some(size) = self.responses.get_mut(id) {
                    size.observed = true;
                    size.bytes = size.bytes.and_then(|before| {
                        usize::try_from(event.params["dataLength"].as_u64()?)
                            .ok()
                            .and_then(|chunk| before.checked_add(chunk))
                            .filter(|total| *total <= MAX_BODY)
                    });
                }
            }
            _ => {}
        }
    }
    fn finish(&mut self, id: &str) -> Result<(), &'static str> {
        match self.responses.remove(id) {
            Some(BodySize { bytes: None, .. }) => Err("Response exceeds the 64 KiB capture limit"),
            Some(BodySize {
                bytes: Some(_),
                observed: true,
            }) => Ok(()),
            _ => Err("Body omitted: complete decoded size was not observed"),
        }
    }
    fn clear(&mut self) {
        self.responses.clear();
    }
    #[cfg(test)]
    fn len(&self) -> usize {
        self.responses.len()
    }
}

pub(crate) fn is_json_mime(mime: &str) -> bool {
    let mime = mime
        .split(';')
        .next()
        .unwrap_or_default()
        .trim()
        .to_ascii_lowercase();
    mime == "application/json"
        || mime == "text/json"
        || mime
            .strip_prefix("application/")
            .is_some_and(|subtype| subtype.ends_with("+json"))
}

fn body_slots() -> std::sync::Arc<tokio::sync::Semaphore> {
    static SLOTS: std::sync::OnceLock<std::sync::Arc<tokio::sync::Semaphore>> =
        std::sync::OnceLock::new();
    SLOTS
        .get_or_init(|| std::sync::Arc::new(tokio::sync::Semaphore::new(4)))
        .clone()
}

async fn body_worker(
    mut receiver: tokio::sync::mpsc::Receiver<String>,
    session: CdpSession,
    slots: std::sync::Arc<tokio::sync::Semaphore>,
    tab_id: TabId,
    record: impl Fn(String, Result<String, &'static str>) + Send + 'static,
) {
    while let Some(id) = receiver.recv().await {
        if session.is_closed() {
            break;
        }
        let Ok(permit) = slots.acquire().await else {
            break;
        };
        if session.is_closed() {
            break;
        }
        tracing::debug!(%tab_id, request_id = %id, "response body fetch dispatched");
        let result = match session
            .call(
                "Network.getResponseBody",
                serde_json::json!({"requestId": id}),
            )
            .await
        {
            Ok(result) => decode_body(&result),
            Err(_) => Err("Body unavailable: engine cache was cleared or the page closed"),
        };
        drop(permit);
        if !session.is_closed() {
            record(id, result);
        }
    }
}

fn decode_body(result: &Value) -> Result<String, &'static str> {
    use base64::Engine;
    let body = result["body"]
        .as_str()
        .ok_or("Body unavailable: invalid engine response")?;
    let body = if result["base64Encoded"].as_bool() == Some(true) {
        if body.len() > MAX_BODY.div_ceil(3) * 4 {
            return Err("Response exceeds the 64 KiB capture limit");
        }
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(body)
            .map_err(|_| "Body unavailable: invalid encoded response")?;
        String::from_utf8(bytes).map_err(|_| "Body unavailable: response is not UTF-8 text")?
    } else {
        if body.len() > MAX_BODY {
            return Err("Response exceeds the 64 KiB capture limit");
        }
        body.to_owned()
    };
    if body.len() > MAX_BODY {
        return Err("Response exceeds the 64 KiB capture limit");
    }
    Ok(body)
}

/// Translate a CDP event into a network event, if relevant.
pub fn map_event(tab_id: TabId, event: &CdpEvent) -> Option<NetworkEvent> {
    let p = &event.params;
    let request_id = p["requestId"].as_str()?.to_owned();
    let timestamp = p["timestamp"].as_f64().unwrap_or_default();
    let text = |v: &Value| v.as_str().unwrap_or_default().to_owned();
    match event.method.as_str() {
        "Network.requestWillBeSent" => Some(NetworkEvent::Sent {
            tab_id,
            request_id,
            url: cap_to(&text(&p["request"]["url"]), MAX_URL),
            method: cap_to(&text(&p["request"]["method"]), 32),
            resource_type: cap_to(&text(&p["type"]), 64),
            headers: headers_of(&p["request"]["headers"]),
            post_data: p["request"]["postData"]
                .as_str()
                .map(|d| d.chars().take(64 * 1024).collect()),
            timestamp,
            wall_time: p["wallTime"].as_f64().unwrap_or_default(),
        }),
        "Network.responseReceived" => Some(NetworkEvent::Response {
            tab_id,
            request_id,
            status: u16::try_from(p["response"]["status"].as_u64().unwrap_or(0)).unwrap_or(0),
            mime_type: cap_to(&text(&p["response"]["mimeType"]), 256),
            from_cache: p["response"]["fromDiskCache"].as_bool().unwrap_or(false)
                || p["response"]["fromServiceWorker"]
                    .as_bool()
                    .unwrap_or(false),
            headers: headers_of(&p["response"]["headers"]),
            timestamp,
        }),
        "Network.loadingFinished" => Some(NetworkEvent::Finished {
            tab_id,
            request_id,
            encoded_length: p["encodedDataLength"].as_f64().unwrap_or_default(),
            timestamp,
        }),
        "Network.webSocketCreated" => Some(NetworkEvent::Socket {
            tab_id,
            request_id,
            url: cap_to(&text(&p["url"]), MAX_URL),
            timestamp,
        }),
        "Network.webSocketFrameSent" | "Network.webSocketFrameReceived" => {
            let payload = if p["response"]["opcode"].as_u64() == Some(2) {
                format!(
                    "<binary {} bytes>",
                    p["response"]["payloadData"].as_str().map_or(0, str::len)
                )
            } else {
                cap(&text(&p["response"]["payloadData"]))
            };
            Some(NetworkEvent::Frame {
                tab_id,
                request_id,
                direction: if event.method == "Network.webSocketFrameSent" {
                    "sent"
                } else {
                    "received"
                }
                .into(),
                payload,
                timestamp,
            })
        }
        "Network.webSocketClosed" => Some(NetworkEvent::Finished {
            tab_id,
            request_id,
            encoded_length: 0.0,
            timestamp,
        }),
        "Network.eventSourceMessageReceived" => Some(NetworkEvent::Frame {
            tab_id,
            request_id,
            direction: "received".into(),
            payload: cap(&format!("{}: {}", text(&p["eventName"]), text(&p["data"]))),
            timestamp,
        }),
        "Network.loadingFailed" => Some(NetworkEvent::Failed {
            tab_id,
            request_id,
            // A request the page itself abandoned (a media element dropping a
            // byte range, a fetch aborted by navigation) is not a failure.
            error: if p["blockedReason"].is_string() {
                format!("blocked: {}", text(&p["blockedReason"]))
            } else if p["canceled"].as_bool() == Some(true) {
                "canceled".to_owned()
            } else {
                text(&p["errorText"])
            },
            timestamp,
        }),
        _ => None,
    }
}

/// Largest frame payload kept.
const MAX_FRAME: usize = 4 * 1024;

fn cap(payload: &str) -> String {
    cap_to(payload, MAX_FRAME)
}

fn cap_to(payload: &str, max: usize) -> String {
    if payload.chars().count() <= max {
        payload.to_owned()
    } else {
        let mut out: String = payload.chars().take(max).collect();
        out.push('…');
        out
    }
}

/// CDP header object to a sorted map; non-string values are dropped.
fn headers_of(v: &Value) -> std::collections::BTreeMap<String, String> {
    v.as_object()
        .map(|m| {
            m.iter()
                .take(MAX_HEADERS)
                .filter_map(|(k, v)| {
                    v.as_str()
                        .map(|v| (cap_to(k, MAX_HEADER_NAME), cap_to(v, MAX_HEADER_VALUE)))
                })
                .collect()
        })
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn body_decoding_keeps_complete_utf8_and_rejects_byte_overflow() {
        use base64::Engine;
        let body = "é".repeat(MAX_BODY / 2);
        assert_eq!(decode_body(&json!({"body":body})), Ok(body.clone()));
        assert!(decode_body(&json!({"body":format!("{body}x")})).is_err());
        let encoded = base64::engine::general_purpose::STANDARD.encode(body.as_bytes());
        assert_eq!(
            decode_body(&json!({"body":encoded,"base64Encoded":true})),
            Ok(body)
        );
        assert!(decode_body(&json!({"body":"/w==","base64Encoded":true})).is_err());
        assert!(decode_body(&json!({"body":"invalid","base64Encoded":true})).is_err());
    }

    struct CaptureTransport(tokio::sync::mpsc::UnboundedSender<Value>);
    impl dive_cdp::Transport for CaptureTransport {
        fn send(&self, message: &str) -> Result<(), dive_cdp::CdpError> {
            self.0.send(serde_json::from_str(message).unwrap()).unwrap();
            Ok(())
        }
    }

    #[tokio::test]
    async fn capture_workers_share_slots_and_do_not_send_queued_jobs_after_close() {
        let (sent, mut calls) = tokio::sync::mpsc::unbounded_channel();
        let slots = std::sync::Arc::new(tokio::sync::Semaphore::new(1));
        let (recorded, mut records) = tokio::sync::mpsc::unbounded_channel();
        let mut sessions = Vec::new();
        let mut workers = Vec::new();
        for prefix in ["a", "b"] {
            let session = CdpSession::new(CaptureTransport(sent.clone()));
            let (queue, receiver) = tokio::sync::mpsc::channel(BODY_QUEUE_CAP);
            for i in 0..BODY_QUEUE_CAP {
                queue.try_send(format!("{prefix}{i}")).unwrap();
            }
            assert!(queue.try_send("overflow".into()).is_err());
            drop(queue);
            let recorded = recorded.clone();
            workers.push(tokio::spawn(body_worker(
                receiver,
                session.clone(),
                slots.clone(),
                TabId::new(),
                move |id, result| {
                    recorded.send((id, result)).unwrap();
                },
            )));
            sessions.push(session);
        }
        let first = calls.recv().await.unwrap();
        assert_eq!(first["method"], "Network.getResponseBody");
        tokio::task::yield_now().await;
        assert!(
            calls.try_recv().is_err(),
            "a shared slot bounds concurrent calls across tabs"
        );
        let winner = usize::from(
            first["params"]["requestId"]
                .as_str()
                .unwrap()
                .starts_with('b'),
        );
        sessions[1 - winner].close();
        sessions[winner]
            .handle_incoming(
                &json!({"id":first["id"],"result":{"body":"{}","base64Encoded":false}}).to_string(),
            )
            .unwrap();
        let captured = records.recv().await.unwrap();
        assert_eq!(captured.1, Ok("{}".into()));
        sessions[winner].close();
        for worker in workers {
            tokio::time::timeout(std::time::Duration::from_secs(1), worker)
                .await
                .unwrap()
                .unwrap();
        }
        while let Ok(call) = calls.try_recv() {
            assert!(
                call["params"]["requestId"]
                    .as_str()
                    .unwrap()
                    .starts_with(if winner == 0 { 'a' } else { 'b' }),
                "closed waiting tab never sends queued jobs"
            );
        }
        assert!(
            records.try_recv().is_err(),
            "in-flight cancellation does not write a stale body"
        );
    }

    #[test]
    fn capture_uses_decoded_size_not_compressed_wire_length() {
        let mut tracker = BodyTracker::default();
        tracker.observe(&ev(
            "Network.responseReceived",
            json!({"requestId":"a", "response":{"mimeType":"application/json"}}),
        ));
        tracker.observe(&ev(
            "Network.dataReceived",
            json!({"requestId":"a", "dataLength":MAX_BODY+1, "encodedDataLength":20}),
        ));
        assert_eq!(
            tracker.finish("a"),
            Err("Response exceeds the 64 KiB capture limit")
        );
    }

    #[test]
    fn capture_requires_observed_complete_bytes_and_drops_lagged_partial_state() {
        let mut tracker = BodyTracker::default();
        let response = ev(
            "Network.responseReceived",
            json!({"requestId":"a", "response":{"mimeType":"application/problem+json"}}),
        );
        tracker.observe(&response);
        assert!(tracker.finish("a").is_err());
        tracker.observe(&response);
        tracker.observe(&ev(
            "Network.dataReceived",
            json!({"requestId":"a", "dataLength":16}),
        ));
        tracker.clear();
        assert!(tracker.finish("a").is_err());
        tracker.observe(&response);
        tracker.observe(&ev(
            "Network.dataReceived",
            json!({"requestId":"a", "dataLength":16}),
        ));
        assert_eq!(tracker.finish("a"), Ok(()));
        assert!(tracker.finish("a").is_err());
    }

    #[test]
    fn redirects_reset_old_body_sizes_and_invalid_sizes_never_become_eligible() {
        let mut tracker = BodyTracker::default();
        let response = ev(
            "Network.responseReceived",
            json!({"requestId":"a", "response":{"mimeType":"application/json"}}),
        );
        tracker.observe(&response);
        tracker.observe(&ev(
            "Network.dataReceived",
            json!({"requestId":"a", "dataLength":5}),
        ));
        tracker.observe(&ev("Network.requestWillBeSent", json!({"requestId":"a"})));
        tracker.observe(&response);
        assert!(tracker.finish("a").is_err());
        tracker.observe(&response);
        tracker.observe(&ev(
            "Network.dataReceived",
            json!({"requestId":"a", "dataLength":-1}),
        ));
        tracker.observe(&ev(
            "Network.dataReceived",
            json!({"requestId":"a", "dataLength":5}),
        ));
        assert!(tracker.finish("a").is_err());
    }

    #[test]
    fn capture_tracking_is_bounded_and_does_not_fetch_non_json_mime_lookalikes() {
        let mut tracker = BodyTracker::default();
        for id in 0..TRACKED_RESPONSES + 100 {
            tracker.observe(&ev(
                "Network.responseReceived",
                json!({"requestId":id.to_string(), "response":{"mimeType":"application/json"}}),
            ));
        }
        assert_eq!(tracker.len(), TRACKED_RESPONSES);
        let mut tracker = BodyTracker::default();
        tracker.observe(&ev(
            "Network.responseReceived",
            json!({"requestId":"a", "response":{"mimeType":"image/json-lookalike"}}),
        ));
        tracker.observe(&ev(
            "Network.dataReceived",
            json!({"requestId":"a", "dataLength":5}),
        ));
        assert!(tracker.finish("a").is_err());
    }

    fn ev(method: &str, params: Value) -> CdpEvent {
        CdpEvent {
            method: method.into(),
            params,
        }
    }

    #[test]
    fn maps_socket_frames_and_events() {
        let tab = TabId::new();
        let sock = map_event(
            tab,
            &ev(
                "Network.webSocketCreated",
                json!({"requestId": "s", "url": "wss://a.dev/ws"}),
            ),
        )
        .unwrap();
        assert!(matches!(sock, NetworkEvent::Socket { ref url, .. } if url == "wss://a.dev/ws"));
        let frame = map_event(tab, &ev("Network.webSocketFrameReceived", json!({"requestId": "s", "timestamp": 2.0, "response": {"opcode": 1, "payloadData": "hi"}}))).unwrap();
        assert!(
            matches!(frame, NetworkEvent::Frame { ref direction, ref payload, .. } if direction == "received" && payload == "hi")
        );
        let bin = map_event(tab, &ev("Network.webSocketFrameSent", json!({"requestId": "s", "timestamp": 2.0, "response": {"opcode": 2, "payloadData": "AAAA"}}))).unwrap();
        assert!(
            matches!(bin, NetworkEvent::Frame { ref payload, .. } if payload.starts_with("<binary"))
        );
        let sse = map_event(
            tab,
            &ev(
                "Network.eventSourceMessageReceived",
                json!({"requestId": "e", "timestamp": 3.0, "eventName": "message", "data": "{}"}),
            ),
        )
        .unwrap();
        assert!(matches!(sse, NetworkEvent::Frame { ref payload, .. } if payload == "message: {}"));
    }

    #[test]
    fn maps_request_lifecycle() {
        let tab = TabId::new();
        let sent = map_event(
            tab,
            &ev(
                "Network.requestWillBeSent",
                json!({"requestId": "1", "timestamp": 1.5, "type": "Document",
                "request": {"url": "https://a.dev/", "method": "GET"}}),
            ),
        )
        .unwrap();
        assert!(
            matches!(sent, NetworkEvent::Sent { ref url, ref resource_type, .. } if url == "https://a.dev/" && resource_type == "Document")
        );

        let resp = map_event(
            tab,
            &ev(
                "Network.responseReceived",
                json!({"requestId": "1", "timestamp": 1.6,
                "response": {"status": 304, "mimeType": "text/html", "fromDiskCache": true}}),
            ),
        )
        .unwrap();
        assert!(matches!(
            resp,
            NetworkEvent::Response {
                status: 304,
                from_cache: true,
                ..
            }
        ));

        let canceled = map_event(tab, &ev("Network.loadingFailed", json!({"requestId": "3", "timestamp": 2.0, "errorText": "net::ERR_ABORTED", "canceled": true}))).unwrap();
        assert!(matches!(&canceled, NetworkEvent::Failed { error, .. } if error == "canceled"));
        let failed = map_event(tab, &ev("Network.loadingFailed", json!({"requestId": "2", "timestamp": 2.0, "errorText": "net::ERR_FAILED", "blockedReason": "csp"}))).unwrap();
        assert!(
            matches!(failed, NetworkEvent::Failed { ref error, .. } if error == "blocked: csp")
        );

        assert!(map_event(tab, &ev("Network.dataReceived", json!({"requestId": "1"}))).is_none());
        assert!(map_event(tab, &ev("Network.loadingFinished", json!({}))).is_none());
    }

    #[test]
    fn retained_request_fields_are_bounded() {
        let tab = TabId::new();
        let sent = map_event(
            tab,
            &ev(
                "Network.requestWillBeSent",
                json!({"requestId": "1", "request": {
                    "url": "u".repeat(MAX_URL + 10),
                    "method": "M".repeat(40),
                    "headers": {"x": "v".repeat(MAX_HEADER_VALUE + 10)}
                }}),
            ),
        )
        .unwrap();
        let NetworkEvent::Sent {
            url,
            method,
            headers,
            ..
        } = sent
        else {
            panic!("expected sent event");
        };
        assert_eq!(url.chars().count(), MAX_URL + 1);
        assert_eq!(method.chars().count(), 33);
        assert_eq!(headers["x"].chars().count(), MAX_HEADER_VALUE + 1);
    }
}
