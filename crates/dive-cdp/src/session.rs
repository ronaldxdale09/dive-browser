use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::Deserialize;
use serde_json::{Value, json};
use tokio::sync::{broadcast, oneshot, watch};

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
    /// Shared, not cloned: a session has a dozen subscribers per tab, and
    /// `broadcast` hands each its own copy of the value. A deep clone of the
    /// parsed JSON per subscriber per event is what that used to cost.
    events: broadcast::Sender<Arc<CdpEvent>>,
    /// Set once the browser behind the transport is going away. A call made
    /// after that fails here instead of reaching the transport: the feeds
    /// answer events on their own schedule, and a message handed to a
    /// browser mid-teardown is how the engine's message loop trips a CHECK.
    closed: watch::Sender<bool>,
}

/// A session event subscription that ends when the session is explicitly closed,
/// even while another feed still owns a clone of that session.
#[derive(Debug)]
pub struct CdpEventReceiver {
    events: broadcast::Receiver<Arc<CdpEvent>>,
    closed: watch::Receiver<bool>,
}

impl CdpEventReceiver {
    /// Receive the next event, or report lag/closure using broadcast semantics.
    /// Cancellation is safe: a cancelled wait does not consume an event.
    ///
    /// Events arrive shared (`Arc`); field access and `&event` borrows work
    /// as before, and a subscriber that needs an owned copy clones it.
    pub async fn recv(&mut self) -> Result<Arc<CdpEvent>, broadcast::error::RecvError> {
        if *self.closed.borrow() {
            return Err(broadcast::error::RecvError::Closed);
        }
        tokio::select! {
            biased;
            _ = self.closed.changed() => Err(broadcast::error::RecvError::Closed),
            event = self.events.recv() => {
                if *self.closed.borrow() {
                    Err(broadcast::error::RecvError::Closed)
                } else {
                    event
                }
            }
        }
    }

    /// Receive without waiting. Closed sessions never deliver buffered events.
    pub fn try_recv(&mut self) -> Result<Arc<CdpEvent>, broadcast::error::TryRecvError> {
        if *self.closed.borrow() {
            return Err(broadcast::error::TryRecvError::Closed);
        }
        let event = self.events.try_recv();
        if *self.closed.borrow() {
            Err(broadcast::error::TryRecvError::Closed)
        } else {
            event
        }
    }
}

impl CdpSession {
    /// Fail open for a `Fetch.requestPaused` we could not parse: pull the
    /// request id out of the raw text and continue the request as-is. The
    /// reply comes back under an id nobody is waiting for, which
    /// `handle_incoming` already ignores.
    fn release_paused_request_in(&self, raw: &str) {
        if !raw.contains("\"Fetch.requestPaused\"") {
            return;
        }
        let Some(request_id) = extract_string_field(raw, "\"requestId\":\"") else {
            return;
        };
        tracing::warn!(
            request_id,
            "unreadable Fetch.requestPaused; continuing the request so the page does not hang"
        );
        let id = self.inner.next_id.fetch_add(1, Ordering::Relaxed);
        let message = json!({
            "id": id,
            "method": "Fetch.continueRequest",
            "params": { "requestId": request_id }
        })
        .to_string();
        if let Err(error) = self.inner.transport.send(&message) {
            tracing::warn!(request_id, "could not continue the request: {error}");
        }
    }
}

/// The value of the first `"key":"..."` in `raw`, unescaped only as far as
/// a request id needs (they are plain ASCII).
fn extract_string_field<'a>(raw: &'a str, key: &str) -> Option<&'a str> {
    let start = raw.find(key)? + key.len();
    let rest = &raw[start..];
    let end = rest.find('"')?;
    Some(&rest[..end])
}

/// Replace JSON `\uXXXX` escapes that strict parsing rejects -- a lone half
/// of a surrogate pair, or an escape cut short -- with U+FFFD, leaving every
/// well-formed escape and everything else untouched.
fn repair_json_escapes(raw: &str) -> String {
    let bytes = raw.as_bytes();
    let mut out = String::with_capacity(raw.len());
    let mut i = 0;
    let hex4 = |at: usize| -> Option<u32> {
        let s = raw.get(at..at + 4)?;
        u32::from_str_radix(s, 16).ok()
    };
    while i < bytes.len() {
        if bytes[i] == b'\\' && i + 1 < bytes.len() && bytes[i + 1] == b'u' {
            match hex4(i + 2) {
                Some(unit) if (0xD800..0xDC00).contains(&unit) => {
                    // High surrogate: valid only when a low one follows.
                    let low = if raw.get(i + 6..i + 8) == Some("\\u") {
                        hex4(i + 8).filter(|u| (0xDC00..0xE000).contains(u))
                    } else {
                        None
                    };
                    if low.is_some() {
                        out.push_str(&raw[i..i + 12]);
                        i += 12;
                    } else {
                        out.push_str("\\ufffd");
                        i += 6;
                    }
                }
                Some(unit) if (0xDC00..0xE000).contains(&unit) => {
                    // A low surrogate on its own (a paired one was consumed above).
                    out.push_str("\\ufffd");
                    i += 6;
                }
                Some(_) => {
                    out.push_str(&raw[i..i + 6]);
                    i += 6;
                }
                None => {
                    // `\u` without four hex digits: an escape cut short.
                    out.push_str("\\ufffd");
                    i += 2;
                }
            }
        } else if bytes[i] == b'\\' && i + 1 < bytes.len() {
            // Any other escape: copy the pair so a `\\u` is not misread.
            out.push_str(&raw[i..i + 2]);
            i += 2;
        } else {
            let ch = raw[i..].chars().next().unwrap_or('\u{fffd}');
            out.push(ch);
            i += ch.len_utf8();
        }
    }
    out
}

/// Removes an in-flight call when its future is timed out or cancelled.
/// Results normally remove themselves in `handle_incoming`; this guard makes
/// every other exit path equally leak-free.
struct PendingGuard {
    inner: Arc<Inner>,
    id: u64,
}

impl Drop for PendingGuard {
    fn drop(&mut self) {
        self.inner
            .pending
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .remove(&self.id);
    }
}

const EVENT_BUFFER: usize = 1024;
const CALL_TIMEOUT: Duration = Duration::from_secs(30);
/// First message id. The CEF host runtime issues its own `DevTools` messages
/// with small ids (script evaluation) and ids from `1_000_000` (init scripts);
/// Chromium silently drops a message whose id is already in flight, so we
/// start far away from both ranges.
const FIRST_ID: u64 = 10_000_000;

impl CdpSession {
    /// Create a session over `transport`.
    pub fn new(transport: impl Transport) -> Self {
        let (events, _) = broadcast::channel(EVENT_BUFFER);
        let (closed, _) = watch::channel(false);
        Self {
            inner: Arc::new(Inner {
                transport: Box::new(transport),
                next_id: AtomicU64::new(FIRST_ID),
                pending: Mutex::new(HashMap::new()),
                events,
                closed,
            }),
        }
    }

    /// Invoke `method` with `params` and await the `result` object.
    pub async fn call(&self, method: &str, params: Value) -> Result<Value, CdpError> {
        self.call_with_timeout(method, params, CALL_TIMEOUT).await
    }

    /// Like [`call`](Self::call) with the caller's own deadline. The default
    /// is generous because a script evaluation on a busy page legitimately
    /// takes a while; a call that stands between a paused request and the
    /// page loading wants something far shorter.
    pub async fn call_with_timeout(
        &self,
        method: &str,
        params: Value,
        timeout: Duration,
    ) -> Result<Value, CdpError> {
        if *self.inner.closed.borrow() {
            return Err(CdpError::Closed);
        }
        let id = self.inner.next_id.fetch_add(1, Ordering::Relaxed);
        let (tx, rx) = oneshot::channel();
        {
            let mut pending = self.pending();
            // Pair registration with close's pending-table cleanup. Otherwise
            // close can drain the table just before this call inserts into it.
            if self.is_closed() {
                return Err(CdpError::Closed);
            }
            pending.insert(id, tx);
        }
        let _cleanup = PendingGuard {
            inner: Arc::clone(&self.inner),
            id,
        };

        let message = json!({ "id": id, "method": method, "params": params }).to_string();
        self.inner.transport.send(&message)?;
        match tokio::time::timeout(timeout, rx).await {
            Ok(Ok(result)) => result,
            Ok(Err(_)) => Err(CdpError::Closed),
            Err(_) => Err(CdpError::Timeout {
                method: method.to_owned(),
            }),
        }
    }

    /// Invoke a method that takes no parameters.
    pub async fn call0(&self, method: &str) -> Result<Value, CdpError> {
        self.call(method, json!({})).await
    }

    /// Subscribe to every event the browser emits on this session.
    ///
    /// Slow subscribers that fall more than the buffer size behind receive a
    /// `Lagged` error and can continue receiving at the oldest retained event.
    /// Explicit session closure discards buffered events and wakes subscribers.
    pub fn subscribe(&self) -> CdpEventReceiver {
        CdpEventReceiver {
            events: self.inner.events.subscribe(),
            closed: self.inner.closed.subscribe(),
        }
    }

    /// Feed one raw message received from the browser.
    ///
    /// Returns `Err` only when the payload is not valid protocol JSON;
    /// unknown ids and events without subscribers are ignored.
    pub fn handle_incoming(&self, raw: &str) -> Result<(), CdpError> {
        if *self.inner.closed.borrow() {
            // A closing browser still flushes a few events; nobody should
            // act on them, and acting is what breaks the teardown.
            return Ok(());
        }
        let msg: Incoming = match serde_json::from_str(raw) {
            Ok(msg) => msg,
            Err(error) => {
                // Chromium writes page text into protocol messages as JSON
                // `\uXXXX` escapes, and a page holding half of a surrogate
                // pair -- a broken emoji, a truncated string -- yields a lone
                // surrogate that strict JSON parsing rejects. Dropping the
                // message was how a paused request stayed paused forever and
                // a page "just stopped". Repair the escapes and parse again.
                let repaired = repair_json_escapes(raw);
                let Ok(msg) = serde_json::from_str(&repaired) else {
                    // Still unreadable. Whatever else it was, if it paused a
                    // request, release that request: a page must never hang
                    // on our failure to read a message about it.
                    self.release_paused_request_in(raw);
                    return Err(error.into());
                };
                tracing::debug!("cdp message repaired: {error}");
                msg
            }
        };
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
                let _ = self.inner.events.send(Arc::new(CdpEvent {
                    method,
                    params: msg.params.unwrap_or(Value::Null),
                }));
            }
            (None, None) => tracing::debug!("cdp message with neither id nor method"),
        }
        Ok(())
    }

    /// Fail every pending call, refuse new ones and ignore late incoming
    /// messages; use when the browser goes away.
    pub fn close(&self) {
        self.inner.closed.send_replace(true);
        self.pending().clear();
    }

    /// Whether [`close`](Self::close) has been called.
    pub fn is_closed(&self) -> bool {
        *self.inner.closed.borrow()
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

    #[test]
    fn repairs_lone_and_truncated_surrogate_escapes() {
        assert_eq!(
            repair_json_escapes(r#"{"a":"\ud83d\ude00"}"#),
            r#"{"a":"\ud83d\ude00"}"#
        );
        assert_eq!(
            repair_json_escapes(r#"{"a":"x\ud83dy"}"#),
            r#"{"a":"x\ufffdy"}"#
        );
        assert_eq!(
            repair_json_escapes(r#"{"a":"\ude00"}"#),
            r#"{"a":"\ufffd"}"#
        );
        assert_eq!(
            repair_json_escapes(r#"{"a":"\u12"}"#),
            r#"{"a":"\ufffd12"}"#
        );
        assert_eq!(
            repair_json_escapes(r#"{"a":"\\u0041"}"#),
            r#"{"a":"\\u0041"}"#
        );
        let repaired =
            repair_json_escapes(r#"{"method":"Log.entryAdded","params":{"t":"\ud83d"}}"#);
        assert!(serde_json::from_str::<serde_json::Value>(&repaired).is_ok());
    }

    #[test]
    fn extracts_a_request_id_from_raw_text() {
        let raw = r#"{"method":"Fetch.requestPaused","params":{"requestId":"interception-job-7.0","request":{"url":"\ud83d"}}}"#;
        assert_eq!(
            extract_string_field(raw, "\"requestId\":\""),
            Some("interception-job-7.0")
        );
    }

    #[tokio::test]
    async fn a_closed_session_refuses_calls_without_touching_the_transport() {
        use std::sync::atomic::AtomicUsize;
        struct Counting(Arc<AtomicUsize>);
        impl Transport for Counting {
            fn send(&self, _message: &str) -> Result<(), CdpError> {
                self.0.fetch_add(1, Ordering::SeqCst);
                Ok(())
            }
        }
        let sent = Arc::new(AtomicUsize::new(0));
        let session = CdpSession::new(Counting(Arc::clone(&sent)));
        let mut events = session.subscribe();
        session.close();
        assert!(session.is_closed());
        // The feeds keep their clones and answer events on their own schedule;
        // once the browser is going away their calls must fail here rather
        // than reach a browser mid-teardown.
        assert!(matches!(
            session.call0("Page.enable").await,
            Err(CdpError::Closed)
        ));
        assert_eq!(
            sent.load(Ordering::SeqCst),
            0,
            "nothing reached the transport"
        );
        // Late events from the closing browser are dropped, not dispatched.
        session
            .handle_incoming(r#"{"method":"Inspector.detached","params":{}}"#)
            .unwrap();
        assert!(
            events.try_recv().is_err(),
            "a closed session delivers no events"
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn close_never_waits_for_a_transport_blocked_on_the_ui_thread() {
        use std::sync::{Barrier, mpsc};

        struct Blocking {
            entered: Arc<Barrier>,
            release: Arc<Barrier>,
        }
        impl Transport for Blocking {
            fn send(&self, _message: &str) -> Result<(), CdpError> {
                self.entered.wait();
                self.release.wait();
                Ok(())
            }
        }

        let entered = Arc::new(Barrier::new(2));
        let release = Arc::new(Barrier::new(2));
        let session = CdpSession::new(Blocking {
            entered: Arc::clone(&entered),
            release: Arc::clone(&release),
        });
        let caller = session.clone();
        let call = tokio::spawn(async move { caller.call0("Page.enable").await });
        entered.wait();

        let (closed_tx, closed_rx) = mpsc::channel();
        let closer = session.clone();
        std::thread::spawn(move || {
            closer.close();
            let _ = closed_tx.send(());
        });
        assert!(
            closed_rx.recv_timeout(Duration::from_millis(250)).is_ok(),
            "close must not wait for a transport that needs the UI thread"
        );

        release.wait();
        assert!(matches!(call.await.unwrap(), Err(CdpError::Closed)));
    }

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
    async fn timeout_removes_pending_entry() {
        let session = CdpSession::new(FakeTransport::default());
        let err = session
            .call_with_timeout("Page.enable", json!({}), Duration::from_millis(1))
            .await
            .unwrap_err();
        assert!(matches!(err, CdpError::Timeout { ref method } if method == "Page.enable"));
        assert!(session.pending().is_empty());
    }

    #[tokio::test]
    async fn cancelled_call_removes_pending_entry() {
        let session = CdpSession::new(FakeTransport::default());
        let pending = tokio::spawn({
            let session = session.clone();
            async move { session.call0("Page.enable").await }
        });
        tokio::task::yield_now().await;
        assert_eq!(session.pending().len(), 1);
        pending.abort();
        let _ = pending.await;
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
    async fn closing_wakes_a_waiting_event_receiver() {
        let session = CdpSession::new(FakeTransport::default());
        let mut events = session.subscribe();
        let waiting = tokio::spawn(async move { events.recv().await });
        tokio::task::yield_now().await;
        session.close();
        let result = tokio::time::timeout(Duration::from_millis(100), waiting)
            .await
            .expect("close must wake an existing subscriber")
            .unwrap();
        assert!(matches!(result, Err(broadcast::error::RecvError::Closed)));
    }

    #[tokio::test]
    async fn subscribing_after_repeated_close_is_immediately_closed() {
        let session = CdpSession::new(FakeTransport::default());
        session.close();
        session.close();
        let mut events = session.subscribe();
        let result = tokio::time::timeout(Duration::from_millis(100), events.recv())
            .await
            .expect("a future subscriber must observe closure");
        assert!(matches!(result, Err(broadcast::error::RecvError::Closed)));
        assert!(matches!(
            events.try_recv(),
            Err(broadcast::error::TryRecvError::Closed)
        ));
    }

    #[tokio::test]
    async fn closing_discards_buffered_events() {
        let session = CdpSession::new(FakeTransport::default());
        let mut events = session.subscribe();
        session
            .handle_incoming(r#"{"method":"Page.loadEventFired"}"#)
            .unwrap();
        session.close();
        assert!(matches!(
            events.recv().await,
            Err(broadcast::error::RecvError::Closed)
        ));
    }

    #[tokio::test]
    async fn lagged_subscribers_can_resume_without_resubscribing() {
        let session = CdpSession::new(FakeTransport::default());
        let mut events = session.subscribe();
        for _ in 0..=EVENT_BUFFER {
            session
                .handle_incoming(r#"{"method":"Page.loadEventFired"}"#)
                .unwrap();
        }
        assert!(matches!(
            events.recv().await,
            Err(broadcast::error::RecvError::Lagged(1))
        ));
        assert_eq!(events.recv().await.unwrap().method, "Page.loadEventFired");
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
        assert!(session.pending().is_empty());
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
