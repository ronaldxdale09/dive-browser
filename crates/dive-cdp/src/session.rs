use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use serde::Deserialize;
use serde_json::{Value, json};
use tokio::sync::{broadcast, oneshot};

use crate::error::CdpError;

/// Something that can deliver an outgoing CDP message to the browser.
///
/// Implemented by the CEF host (`SendDevToolsMessage`) and by test fakes.
pub trait Transport: Send + Sync + 'static {
    /// Deliver one JSON-encoded protocol message. Must not block for long.
    fn send(&self, message: &str) -> Result<(), CdpError>;
}

/// An event pushed by the browser (a message without an `id`).
#[derive(Debug, Clone, PartialEq)]
pub struct CdpEvent {
    /// Fully-qualified method name such as `Page.loadEventFired`.
    pub method: String,
    /// Event parameters; `Null` when the browser sent none.
    pub params: Value,
}

#[derive(Deserialize)]
struct Incoming {
    id: Option<u64>,
    method: Option<String>,
    params: Option<Value>,
    result: Option<Value>,
    error: Option<ProtocolError>,
}

#[derive(Deserialize)]
struct ProtocolError {
    code: i64,
    message: String,
}

type Pending = Mutex<HashMap<u64, oneshot::Sender<Result<Value, CdpError>>>>;

/// One CDP session, multiplexing calls and events over a single transport.
///
/// Cloning is cheap; all clones share the same pending table and event bus.
#[derive(Clone)]
pub struct CdpSession {
    inner: Arc<Inner>,
}

struct Inner {
    transport: Box<dyn Transport>,
    next_id: AtomicU64,
    pending: Pending,
    events: broadcast::Sender<CdpEvent>,
}

const EVENT_BUFFER: usize = 1024;
/// First message id. The CEF host runtime issues its own `DevTools` messages
/// with small ids (script evaluation) and ids from `1_000_000` (init scripts);
/// Chromium silently drops a message whose id is already in flight, so we
/// start far away from both ranges.
const FIRST_ID: u64 = 10_000_000;

impl CdpSession {
    /// Create a session over `transport`.
    pub fn new(transport: impl Transport) -> Self {
        let (events, _) = broadcast::channel(EVENT_BUFFER);
        Self {
            inner: Arc::new(Inner {
                transport: Box::new(transport),
                next_id: AtomicU64::new(FIRST_ID),
                pending: Mutex::new(HashMap::new()),
                events,
            }),
        }
    }

    /// Invoke `method` with `params` and await the `result` object.
    pub async fn call(&self, method: &str, params: Value) -> Result<Value, CdpError> {
        let id = self.inner.next_id.fetch_add(1, Ordering::Relaxed);
        let (tx, rx) = oneshot::channel();
        self.pending().insert(id, tx);

        let message = json!({ "id": id, "method": method, "params": params }).to_string();
        if let Err(err) = self.inner.transport.send(&message) {
            self.pending().remove(&id);
            return Err(err);
        }
        rx.await.unwrap_or(Err(CdpError::Closed))
    }

    /// Invoke a method that takes no parameters.
    pub async fn call0(&self, method: &str) -> Result<Value, CdpError> {
        self.call(method, json!({})).await
    }

    /// Subscribe to every event the browser emits on this session.
    ///
    /// Slow subscribers that fall more than the buffer size behind receive a
    /// `Lagged` error from the receiver and must resubscribe.
    pub fn subscribe(&self) -> broadcast::Receiver<CdpEvent> {
        self.inner.events.subscribe()
    }

    /// Feed one raw message received from the browser.
    ///
    /// Returns `Err` only when the payload is not valid protocol JSON;
    /// unknown ids and events without subscribers are ignored.
    pub fn handle_incoming(&self, raw: &str) -> Result<(), CdpError> {
        let msg: Incoming = serde_json::from_str(raw)?;
        match (msg.id, msg.method) {
            (Some(id), _) => {
                let Some(tx) = self.pending().remove(&id) else {
                    tracing::debug!(id, "cdp result for unknown id");
                    return Ok(());
                };
                let outcome = match msg.error {
                    Some(err) => Err(CdpError::Protocol {
                        code: err.code,
                        message: err.message,
                    }),
                    None => Ok(msg.result.unwrap_or(Value::Null)),
                };
                // The caller may have given up; that is not an error here.
                let _ = tx.send(outcome);
            }
            (None, Some(method)) => {
                let _ = self.inner.events.send(CdpEvent {
                    method,
                    params: msg.params.unwrap_or(Value::Null),
                });
            }
            (None, None) => tracing::debug!("cdp message with neither id nor method"),
        }
        Ok(())
    }

    /// Fail every pending call; use when the browser goes away.
    pub fn close(&self) {
        self.pending().clear();
    }

    fn pending(
        &self,
    ) -> std::sync::MutexGuard<'_, HashMap<u64, oneshot::Sender<Result<Value, CdpError>>>> {
        // A poisoned lock only means another thread panicked mid-insert; the
        // map is still usable.
        self.inner
            .pending
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex as StdMutex;

    /// Records outgoing messages so tests can answer them.
    #[derive(Clone, Default)]
    struct FakeTransport {
        sent: Arc<StdMutex<Vec<String>>>,
        fail: bool,
    }

    impl Transport for FakeTransport {
        fn send(&self, message: &str) -> Result<(), CdpError> {
            if self.fail {
                return Err(CdpError::Transport("down".into()));
            }
            self.sent.lock().unwrap().push(message.to_owned());
            Ok(())
        }
    }

    fn sent_id(transport: &FakeTransport, index: usize) -> u64 {
        let raw = &transport.sent.lock().unwrap()[index];
        serde_json::from_str::<Value>(raw).unwrap()["id"]
            .as_u64()
            .unwrap()
    }

    #[tokio::test]
    async fn call_resolves_with_result() {
        let transport = FakeTransport::default();
        let session = CdpSession::new(transport.clone());
        let pending = tokio::spawn({
            let session = session.clone();
            async move {
                session
                    .call("Page.navigate", json!({"url": "about:blank"}))
                    .await
            }
        });
        tokio::task::yield_now().await;
        let id = sent_id(&transport, 0);
        session
            .handle_incoming(&json!({"id": id, "result": {"frameId": "f1"}}).to_string())
            .unwrap();
        let result = pending.await.unwrap().unwrap();
        assert_eq!(result["frameId"], "f1");
    }

    #[tokio::test]
    async fn protocol_error_is_surfaced() {
        let transport = FakeTransport::default();
        let session = CdpSession::new(transport.clone());
        let pending = tokio::spawn({
            let session = session.clone();
            async move { session.call0("Nope.method").await }
        });
        tokio::task::yield_now().await;
        let id = sent_id(&transport, 0);
        session
            .handle_incoming(
                &json!({"id": id, "error": {"code": -32601, "message": "not found"}}).to_string(),
            )
            .unwrap();
        match pending.await.unwrap() {
            Err(CdpError::Protocol { code, message }) => {
                assert_eq!(code, -32601);
                assert_eq!(message, "not found");
            }
            other => panic!("unexpected {other:?}"),
        }
    }

    #[tokio::test]
    async fn transport_failure_removes_pending_entry() {
        let session = CdpSession::new(FakeTransport {
            fail: true,
            ..Default::default()
        });
        let err = session.call0("Page.enable").await.unwrap_err();
        assert!(matches!(err, CdpError::Transport(_)));
        assert!(session.pending().is_empty());
    }

    #[tokio::test]
    async fn events_are_broadcast_to_subscribers() {
        let session = CdpSession::new(FakeTransport::default());
        let mut rx = session.subscribe();
        session
            .handle_incoming(r#"{"method":"Page.loadEventFired","params":{"timestamp":1.5}}"#)
            .unwrap();
        let event = rx.recv().await.unwrap();
        assert_eq!(event.method, "Page.loadEventFired");
        assert_eq!(event.params["timestamp"], 1.5);
    }

    #[tokio::test]
    async fn close_fails_pending_calls() {
        let session = CdpSession::new(FakeTransport::default());
        let pending = tokio::spawn({
            let session = session.clone();
            async move { session.call0("Page.enable").await }
        });
        tokio::task::yield_now().await;
        session.close();
        assert!(matches!(pending.await.unwrap(), Err(CdpError::Closed)));
    }

    #[test]
    fn ids_are_monotonic() {
        let transport = FakeTransport::default();
        let session = CdpSession::new(transport.clone());
        let rt = tokio::runtime::Builder::new_current_thread()
            .build()
            .unwrap();
        rt.block_on(async {
            for _ in 0..3 {
                let s = session.clone();
                tokio::spawn(async move { s.call0("X.y").await });
                tokio::task::yield_now().await;
            }
        });
        assert_eq!(
            (0..3).map(|i| sent_id(&transport, i)).collect::<Vec<_>>(),
            vec![FIRST_ID, FIRST_ID + 1, FIRST_ID + 2]
        );
    }

    #[test]
    fn malformed_json_is_an_error() {
        let session = CdpSession::new(FakeTransport::default());
        assert!(matches!(
            session.handle_incoming("{nope"),
            Err(CdpError::Serialization(_))
        ));
    }
}
