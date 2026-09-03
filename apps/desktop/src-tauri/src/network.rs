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

/// Enable the domain and forward events to the chrome.
pub fn attach(
    app: AppHandle<Runtime>,
    tab_id: TabId,
    session: CdpSession,
) -> crate::cdp_feed::Ready {
    let body_app = app.clone();
    let body_session = session.clone();
    crate::cdp_feed::attach(
        app,
        tab_id,
        session,
        &["Network.enable"],
        map_event,
        move |state, ev| {
            state.buffers.push_network(ev);
            // Same task that recorded the response, so the row's mime type is
            // already known here.
            if let NetworkEvent::Finished { request_id, .. } = ev
                && state
                    .buffers
                    .request(tab_id, request_id)
                    .is_some_and(|r| r.mime_type.contains("json"))
            {
                capture_body(
                    body_app.clone(),
                    tab_id,
                    body_session.clone(),
                    request_id.clone(),
                );
            }
        },
    )
}

/// Largest response body kept.
const MAX_BODY: usize = 64 * 1024;

/// Fetch a finished JSON response's body so the `OpenAPI` inference and the
/// replay editor can show it.
fn capture_body(app: AppHandle<Runtime>, tab_id: TabId, session: CdpSession, request_id: String) {
    use tauri::Manager;
    tauri::async_runtime::spawn(async move {
        if let Ok(result) = session
            .call(
                "Network.getResponseBody",
                serde_json::json!({"requestId": request_id}),
            )
            .await
            && result["base64Encoded"].as_bool() != Some(true)
            && let Some(body) = result["body"].as_str()
        {
            app.state::<crate::state::AppState>()
                .buffers
                .set_response_body(tab_id, &request_id, body.chars().take(MAX_BODY).collect());
        }
    });
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
            url: text(&p["request"]["url"]),
            method: text(&p["request"]["method"]),
            resource_type: text(&p["type"]),
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
            mime_type: text(&p["response"]["mimeType"]),
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
            url: text(&p["url"]),
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
            error: if p["blockedReason"].is_string() {
                format!("blocked: {}", text(&p["blockedReason"]))
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
    if payload.chars().count() <= MAX_FRAME {
        payload.to_owned()
    } else {
        let mut out: String = payload.chars().take(MAX_FRAME).collect();
        out.push('…');
        out
    }
}

/// CDP header object to a sorted map; non-string values are dropped.
fn headers_of(v: &Value) -> std::collections::BTreeMap<String, String> {
    v.as_object()
        .map(|m| {
            m.iter()
                .filter_map(|(k, v)| v.as_str().map(|v| (k.clone(), v.to_owned())))
                .collect()
        })
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

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

        let failed = map_event(tab, &ev("Network.loadingFailed", json!({"requestId": "2", "timestamp": 2.0, "errorText": "net::ERR_FAILED", "blockedReason": "csp"}))).unwrap();
        assert!(
            matches!(failed, NetworkEvent::Failed { ref error, .. } if error == "blocked: csp")
        );

        assert!(map_event(tab, &ev("Network.dataReceived", json!({"requestId": "1"}))).is_none());
        assert!(map_event(tab, &ev("Network.loadingFinished", json!({}))).is_none());
    }
}
