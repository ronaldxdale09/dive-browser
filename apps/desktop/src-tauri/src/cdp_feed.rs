//! Shared "enable domains, then forward mapped CDP events" loop used by the
//! console and network feeds.

use dive_cdp::{CdpEvent, CdpSession};
use dive_core::TabId;
use tauri::{AppHandle, Emitter, Manager};

use crate::Runtime;
use crate::state::AppState;

pub(crate) const IPC_BATCH_MAX: usize = 64;
const IPC_BATCH_WINDOW: std::time::Duration = std::time::Duration::from_millis(16);

/// A feed-local bounded batch. Host history is recorded before insertion;
/// this only delays and reduces native-to-chrome IPC publications.
pub(crate) struct IpcBatch<T> {
    items: Vec<T>,
    deadline: Option<tokio::time::Instant>,
}

impl<T> Default for IpcBatch<T> {
    fn default() -> Self {
        Self {
            items: Vec::with_capacity(IPC_BATCH_MAX),
            deadline: None,
        }
    }
}

impl<T> IpcBatch<T> {
    pub(crate) fn push(&mut self, item: T) -> bool {
        if self.items.is_empty() {
            self.deadline = Some(tokio::time::Instant::now() + IPC_BATCH_WINDOW);
        }
        self.items.push(item);
        self.items.len() >= IPC_BATCH_MAX
    }

    pub(crate) fn deadline(&self) -> Option<tokio::time::Instant> {
        self.deadline
    }

    pub(crate) fn take(&mut self) -> Vec<T> {
        self.deadline = None;
        std::mem::replace(&mut self.items, Vec::with_capacity(IPC_BATCH_MAX))
    }
}

pub(crate) fn emit_batch<T: serde::Serialize>(
    app: &AppHandle<Runtime>,
    session: &CdpSession,
    event: &str,
    batch: &mut IpcBatch<T>,
    tab_id: TabId,
) {
    let items = batch.take();
    if !session.is_closed()
        && !items.is_empty()
        && let Err(error) = app.emit(event, &items)
    {
        tracing::warn!(%tab_id, %error, event, "batch emit failed");
    }
}

fn emit_navigation_reset(
    app: &AppHandle<Runtime>,
    session: &CdpSession,
    event: &str,
    tab_id: TabId,
) {
    if !session.is_closed()
        && let Err(error) = app.emit(event, serde_json::json!({ "reset": tab_id }))
    {
        tracing::warn!(%tab_id, %error, event, "navigation reset emit failed");
    }
}

/// Map every event matching `methods` with `map`; each hit is recorded
/// through `record` and emitted to the chrome. `navigated` runs when the main
/// frame commits a new document, before the chrome is told, so `methods`
/// always takes in `Page.frameNavigated` as well.
///
/// The feed enables nothing itself: [`enable_domains`] does that once for
/// the whole tab. It subscribes before returning, so a caller that enables
/// the domains afterwards cannot lose an event to the task not having
/// started yet.
#[allow(clippy::too_many_arguments)] // Each hook is one feed-specific step; a struct of them would only rename the list.
pub fn attach<T, M, R, N>(
    app: AppHandle<Runtime>,
    tab_id: TabId,
    session: CdpSession,
    methods: &'static [&'static str],
    batch_event: &'static str,
    map: M,
    record: R,
    navigated: N,
) where
    T: serde::Serialize + Clone + Send + 'static,
    M: Fn(TabId, &CdpEvent) -> Option<T> + Send + 'static,
    R: Fn(&AppState, &T) + Send + 'static,
    N: Fn(&AppState, TabId) + Send + 'static,
{
    let mut events = session.subscribe_to(methods);
    tauri::async_runtime::spawn(async move {
        let mut batch = IpcBatch::default();
        loop {
            let incoming = if let Some(deadline) = batch.deadline() {
                tokio::select! {
                    event = events.recv() => Some(event),
                    () = tokio::time::sleep_until(deadline) => None,
                }
            } else {
                Some(events.recv().await)
            };
            let Some(incoming) = incoming else {
                emit_batch(&app, &session, batch_event, &mut batch, tab_id);
                continue;
            };
            match incoming {
                Ok(event) => {
                    if event.method == "Page.frameNavigated"
                        && event.params["frame"]["parentId"].is_null()
                    {
                        emit_batch(&app, &session, batch_event, &mut batch, tab_id);
                        navigated(&app.state::<AppState>(), tab_id);
                        emit_navigation_reset(&app, &session, batch_event, tab_id);
                    }
                    if let Some(item) = map(tab_id, &event) {
                        record(&app.state::<AppState>(), &item);
                        if batch.push(item) {
                            emit_batch(&app, &session, batch_event, &mut batch, tab_id);
                        }
                    }
                }
                Err(tokio::sync::broadcast::error::RecvError::Lagged(n)) => {
                    tracing::warn!(%tab_id, n, "cdp feed lagged");
                }
                Err(tokio::sync::broadcast::error::RecvError::Closed) => {
                    // Host history was recorded immediately. The UI may have
                    // already dropped this tab, so a close must not publish a
                    // late batch that resurrects it.
                    let _ = batch.take();
                    break;
                }
            }
        }
    });
}

/// Resolves once a feed is set up far enough for the first navigation.
pub type Ready = tokio::sync::oneshot::Receiver<()>;

/// Enable, once for the whole tab, every `DevTools` domain its feeds and page
/// scripts listen on. Each of them used to enable its own, one after the
/// other: `Runtime` three times, `Page` five and `Network` twice, each a
/// round trip through the main thread standing between a new tab and its
/// first navigation. Here they go out together and are awaited together.
///
/// `feeds` is false when the `DevTools` feeds are switched off, and then only
/// the domains the page scripts need are enabled. Returns whether the
/// network domain acknowledged its buffer limits, which response capture
/// depends on.
pub async fn enable_domains(tab_id: TabId, session: &CdpSession, feeds: bool) -> bool {
    let report = |what: &str, result: &Result<serde_json::Value, dive_cdp::CdpError>| {
        if let Err(error) = result {
            setup_failed(tab_id, what, error);
        }
    };
    if feeds {
        let (runtime, page, log, network) = tokio::join!(
            session.call0("Runtime.enable"),
            session.call0("Page.enable"),
            session.call0("Log.enable"),
            crate::network::enable(session),
        );
        report("the Runtime domain", &runtime);
        report("the Page domain", &page);
        report("the Log domain", &log);
        report("response body capture", &network);
        network.is_ok()
    } else {
        let (runtime, page) = tokio::join!(
            session.call0("Runtime.enable"),
            session.call0("Page.enable"),
        );
        report("the Runtime domain", &runtime);
        report("the Page domain", &page);
        false
    }
}

/// Report that a per-tab feed could not be set up.
///
/// A tab that is closing takes its CDP session with it while a dozen
/// subsystems are still attaching to it, and each of them reporting that
/// separately at warning level buried the one line that mattered: a single
/// native view timing out produced twelve warnings, none of them the cause.
/// The tab being gone is expected and goes to debug; anything else is still
/// worth somebody's attention.
pub fn setup_failed(tab_id: dive_core::TabId, what: &str, error: &dive_cdp::CdpError) {
    if error.is_gone() {
        tracing::debug!(%tab_id, %error, "{what} not set up: the tab was already gone");
    } else {
        tracing::warn!(%tab_id, %error, "{what} setup failed");
    }
}

/// The next event on a per-tab feed, riding out a burst it fell behind on.
/// `while let Ok(..) = recv()` ended the loop on the first `Lagged` -- a
/// network-heavy page overruns the buffer easily -- and the feature went dead
/// for that tab until it was reopened. Only a closed session ends it.
pub async fn next_event(
    events: &mut dive_cdp::CdpEventReceiver,
    tab_id: TabId,
    what: &str,
) -> Option<std::sync::Arc<CdpEvent>> {
    loop {
        match events.recv().await {
            Ok(event) => return Some(event),
            Err(tokio::sync::broadcast::error::RecvError::Lagged(n)) => {
                tracing::debug!(%tab_id, n, "{what} fell behind and skipped CDP events");
            }
            Err(tokio::sync::broadcast::error::RecvError::Closed) => return None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn batch_flushes_at_the_count_limit_in_insertion_order() {
        let mut batch = IpcBatch::default();
        for value in 0..IPC_BATCH_MAX - 1 {
            assert!(!batch.push(value));
        }
        assert!(batch.push(IPC_BATCH_MAX - 1));
        assert_eq!(batch.take(), (0..IPC_BATCH_MAX).collect::<Vec<_>>());
        assert!(batch.deadline().is_none());
    }

    #[test]
    fn first_item_starts_one_short_deadline() {
        let mut batch = IpcBatch::default();
        assert!(batch.deadline().is_none());
        batch.push(1);
        let deadline = batch.deadline().unwrap();
        batch.push(2);
        assert_eq!(batch.deadline(), Some(deadline));
        assert!(deadline <= tokio::time::Instant::now() + IPC_BATCH_WINDOW);
    }

    /// Records what the session sent, so a test can answer it.
    #[derive(Clone, Default)]
    struct Outbox(std::sync::Arc<std::sync::Mutex<Vec<serde_json::Value>>>);
    impl dive_cdp::Transport for Outbox {
        fn send(&self, message: &str) -> Result<(), dive_cdp::CdpError> {
            self.0
                .lock()
                .unwrap()
                .push(serde_json::from_str(message).unwrap());
            Ok(())
        }
    }

    #[tokio::test]
    async fn every_domain_is_enabled_once_and_all_at_the_same_time() {
        let outbox = Outbox::default();
        let session = CdpSession::new(outbox.clone());
        let setup = tokio::spawn({
            let session = session.clone();
            async move { enable_domains(TabId::new(), &session, true).await }
        });
        tokio::task::yield_now().await;
        let sent = outbox.0.lock().unwrap().clone();
        let methods: Vec<_> = sent.iter().map(|m| m["method"].as_str().unwrap()).collect();
        assert_eq!(
            methods,
            [
                "Runtime.enable",
                "Page.enable",
                "Log.enable",
                "Network.enable"
            ],
            "all four are out before any of them is answered"
        );
        assert!(sent[3]["params"]["maxTotalBufferSize"].is_number());
        for message in &sent {
            session
                .handle_incoming(
                    &serde_json::json!({"id": message["id"], "result": {}}).to_string(),
                )
                .unwrap();
        }
        assert!(setup.await.unwrap(), "the network limits were acknowledged");
    }

    #[tokio::test]
    async fn without_feeds_only_the_page_script_domains_are_enabled() {
        let outbox = Outbox::default();
        let session = CdpSession::new(outbox.clone());
        let setup = tokio::spawn({
            let session = session.clone();
            async move { enable_domains(TabId::new(), &session, false).await }
        });
        tokio::task::yield_now().await;
        let sent = outbox.0.lock().unwrap().clone();
        let methods: Vec<_> = sent.iter().map(|m| m["method"].as_str().unwrap()).collect();
        assert_eq!(methods, ["Runtime.enable", "Page.enable"]);
        session.close();
        assert!(!setup.await.unwrap());
    }
}
