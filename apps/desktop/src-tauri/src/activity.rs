//! Activity admission belongs to the native receipt boundary, not a lagging
//! broadcast consumer. A changed generation invalidates an in-flight probe.
use crate::state::lock;
use dive_core::TabId;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Ticket {
    pub nonce: String,
    revision: u64,
}
#[derive(Default)]
struct Entry {
    nonce: String,
    revision: u64,
    ready: bool,
    closing: bool,
    downloads: HashMap<String, usize>,
    pending: usize,
}
#[derive(Default)]
pub struct Registry {
    entries: Mutex<HashMap<TabId, Entry>>,
}
impl Registry {
    pub fn begin(&self, tab: TabId) -> String {
        let nonce = TabId::new().to_string();
        lock(&self.entries).insert(
            tab,
            Entry {
                nonce: nonce.clone(),
                ..Entry::default()
            },
        );
        nonce
    }
    pub fn ready(&self, tab: TabId, nonce: &str) {
        self.update(tab, nonce, |entry| entry.ready = true);
    }
    fn update(&self, tab: TabId, nonce: &str, f: impl FnOnce(&mut Entry)) {
        if let Some(entry) = lock(&self.entries).get_mut(&tab)
            && entry.nonce == nonce
        {
            f(entry);
            entry.revision += 1;
        }
    }
    pub fn session_current(&self, tab: TabId, nonce: &str) -> bool {
        lock(&self.entries)
            .get(&tab)
            .is_some_and(|e| e.nonce == nonce && !e.closing)
    }
    pub fn changed(&self, tab: TabId, nonce: &str) {
        self.update(tab, nonce, |_| {});
    }
    pub fn ticket(&self, tab: TabId) -> Option<Ticket> {
        lock(&self.entries)
            .get(&tab)
            .filter(|e| e.ready && !e.closing && e.pending == 0 && e.downloads.is_empty())
            .map(|e| Ticket {
                nonce: e.nonce.clone(),
                revision: e.revision,
            })
    }
    pub fn current(&self, tab: TabId, ticket: &Ticket) -> bool {
        self.ticket(tab).as_ref() == Some(ticket)
    }
    pub fn download(&self, tab: TabId, nonce: &str, url: &str, started: bool) {
        self.update(tab, nonce, |e| {
            if started {
                *e.downloads.entry(url.to_owned()).or_default() += 1;
            } else if let Some(count) = e.downloads.get_mut(url) {
                *count = count.saturating_sub(1);
                if *count == 0 {
                    e.downloads.remove(url);
                }
            }
        });
    }
    /// Called synchronously by the native protocol callback before broadcast.
    pub fn ingest(&self, tab: TabId, nonce: &str, text: &str) {
        if !text.contains("Runtime.bindingCalled")
            && !text.contains("Page.frame")
            && !text.contains("Runtime.executionContext")
        {
            return;
        }
        let Ok(value) = serde_json::from_str::<serde_json::Value>(text) else {
            return;
        };
        let method = value["method"].as_str().unwrap_or_default();
        if method == "Runtime.bindingCalled" {
            if value["params"]["name"] != "__diveActivityChanged" {
                return;
            }
            let Some(payload) = value["params"]["payload"]
                .as_str()
                .filter(|p| p.len() < 256)
            else {
                return;
            };
            let Ok(payload) = serde_json::from_str::<serde_json::Value>(payload) else {
                return;
            };
            if payload["nonce"] != nonce {
                return;
            }
        } else if !method.starts_with("Page.frame")
            && !method.starts_with("Runtime.executionContext")
        {
            return;
        }
        self.changed(tab, nonce);
    }
    pub fn begin_close(&self, tab: TabId, ticket: &Ticket) -> bool {
        let mut entries = lock(&self.entries);
        let Some(entry) = entries.get_mut(&tab) else {
            return false;
        };
        if !entry.ready
            || entry.closing
            || entry.pending != 0
            || !entry.downloads.is_empty()
            || entry.nonce != ticket.nonce
            || entry.revision != ticket.revision
        {
            return false;
        }
        entry.closing = true;
        true
    }
    pub fn is_closing(&self, tab: TabId, ticket: &Ticket) -> bool {
        lock(&self.entries)
            .get(&tab)
            .is_some_and(|e| e.nonce == ticket.nonce && e.closing)
    }
    pub fn drop_tab(&self, tab: TabId) {
        lock(&self.entries).remove(&tab);
    }
    pub fn pending(self: &Arc<Self>, tab: TabId) -> Pending {
        let nonce = lock(&self.entries).get(&tab).map(|e| e.nonce.clone());
        if let Some(nonce) = &nonce {
            self.update(tab, nonce, |e| e.pending += 1);
        }
        Pending {
            registry: self.clone(),
            tab,
            nonce,
        }
    }
}
pub struct Pending {
    registry: Arc<Registry>,
    tab: TabId,
    nonce: Option<String>,
}
impl Drop for Pending {
    fn drop(&mut self) {
        if let Some(nonce) = &self.nonce {
            self.registry
                .update(self.tab, nonce, |e| e.pending = e.pending.saturating_sub(1));
        }
    }
}
/// Install after permission wrappers and before first navigation. Failure leaves
/// the session unready, so automatic discard stays disabled for it.
pub async fn attach(registry: &Registry, tab: TabId, nonce: &str, session: &dive_cdp::CdpSession) {
    let source = include_str!("inject/activity-guard.js").replace(
        "__NONCE__",
        &serde_json::to_string(nonce).unwrap_or_default(),
    );
    let setup = async {
        session.call0("Runtime.enable").await?;
        session.call0("Page.enable").await?;
        session
            .call(
                "Runtime.addBinding",
                serde_json::json!({"name":"__diveActivityChanged"}),
            )
            .await?;
        session
            .call(
                "Page.addScriptToEvaluateOnNewDocument",
                serde_json::json!({"source":source}),
            )
            .await?;
        session
            .call("Runtime.evaluate", serde_json::json!({"expression":source}))
            .await?;
        Ok::<(), dive_cdp::CdpError>(())
    };
    if let Ok(Ok(())) = tokio::time::timeout(std::time::Duration::from_secs(5), setup).await {
        registry.ready(tab, nonce);
    } else {
        tracing::warn!(%tab, "activity instrumentation unavailable; keeping tab active");
    }
}

/// A single atomic renderer snapshot, with no sensitive form contents.
#[derive(serde::Deserialize, Debug)]
pub struct PageActivity {
    pub known: bool,
    pub reasons: Vec<String>,
    pub scroll: [i32; 2],
    pub url: String,
}
impl PageActivity {
    pub fn idle_for(&self, url: &str) -> bool {
        self.known && self.reasons.is_empty() && self.url == url
    }
}
/// Timeout, navigation, missing scripts, and malformed results are unknown.
pub async fn probe(session: &dive_cdp::CdpSession) -> Option<PageActivity> {
    let reply = tokio::time::timeout(std::time::Duration::from_millis(400), session.call("Runtime.evaluate",
        serde_json::json!({"expression":"window.__diveActivitySnapshot?.()", "returnByValue":true}))).await.ok()?.ok()?;
    serde_json::from_value(reply.get("result")?.get("value")?.clone()).ok()
}

/// Profile-scoped exceptions are read from current store state at commit time.
pub fn exempt(store: &dive_core::Store, tab: &dive_core::Tab) -> dive_core::Result<bool> {
    let Some(workspace) = tab.workspace_id else {
        return Ok(true);
    };
    let profile = store.workspace(workspace)?.profile_id;
    let Ok(url) = url::Url::parse(&tab.url) else {
        return Ok(true);
    };
    Ok(store
        .keep_active_sites(profile)?
        .contains(&url.origin().ascii_serialization()))
}

#[allow(clippy::needless_pass_by_value)] // Tauri command extraction takes owned arguments.
#[tauri::command]
#[specta::specta]
pub fn keep_sites_list(
    state: tauri::State<'_, crate::state::AppState>,
    profile_id: dive_core::ProfileId,
) -> crate::error::AppResult<Vec<String>> {
    lock(&state.store)
        .keep_active_sites(profile_id)
        .map_err(crate::error::AppError::new)
}
#[allow(clippy::needless_pass_by_value)] // Tauri command extraction takes owned arguments.
#[tauri::command]
#[specta::specta]
pub fn keep_site_set(
    state: tauri::State<'_, crate::state::AppState>,
    profile_id: dive_core::ProfileId,
    url: String,
    keep: bool,
) -> crate::error::AppResult<Vec<String>> {
    let store = lock(&state.store);
    store
        .set_keep_active_site(profile_id, &url, keep)
        .map_err(crate::error::AppError::new)?;
    store
        .keep_active_sites(profile_id)
        .map_err(crate::error::AppError::new)
}

#[cfg(test)]
mod tests {
    use super::*;
    struct Outbox(tokio::sync::mpsc::UnboundedSender<serde_json::Value>);
    impl dive_cdp::Transport for Outbox {
        fn send(&self, text: &str) -> Result<(), dive_cdp::CdpError> {
            self.0.send(serde_json::from_str(text).unwrap()).unwrap();
            Ok(())
        }
    }
    fn session() -> (
        dive_cdp::CdpSession,
        tokio::sync::mpsc::UnboundedReceiver<serde_json::Value>,
    ) {
        let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
        (dive_cdp::CdpSession::new(Outbox(tx)), rx)
    }
    #[tokio::test]
    async fn timed_out_or_malformed_activity_is_never_idle_evidence() {
        let (session, mut calls) = session();
        let task = {
            let session = session.clone();
            tokio::spawn(async move { probe(&session).await })
        };
        calls.recv().await.unwrap();
        assert!(
            task.await.unwrap().is_none(),
            "unresponsive renderer is unknown"
        );
        let task = {
            let session = session.clone();
            tokio::spawn(async move { probe(&session).await })
        };
        let call = calls.recv().await.unwrap();
        session
            .handle_incoming(
                &serde_json::json!({"id":call["id"],"result":{"result":{"value":{"known":true}}}})
                    .to_string(),
            )
            .unwrap();
        assert!(
            task.await.unwrap().is_none(),
            "partial evidence must not default missing fields"
        );
    }
    #[tokio::test]
    async fn native_activity_received_while_probe_waits_invalidates_its_answer() {
        let registry = Registry::default();
        let tab = TabId::new();
        let nonce = registry.begin(tab);
        registry.ready(tab, &nonce);
        let ticket = registry.ticket(tab).unwrap();
        let (session, mut calls) = session();
        let task = {
            let session = session.clone();
            tokio::spawn(async move { probe(&session).await })
        };
        let call = calls.recv().await.unwrap();
        registry.ingest(tab, &nonce, &serde_json::json!({"method":"Runtime.bindingCalled","params":{"name":"__diveActivityChanged","payload":serde_json::json!({"nonce":nonce}).to_string()}}).to_string());
        session.handle_incoming(&serde_json::json!({"id":call["id"],"result":{"result":{"value":{"known":true,"reasons":[],"scroll":[0,10],"url":"https://example.com"}}}}).to_string()).unwrap();
        assert!(task.await.unwrap().unwrap().idle_for("https://example.com"));
        assert!(
            !registry.begin_close(tab, &ticket),
            "an otherwise idle answer must not authorize stale close"
        );
    }
    #[test]
    fn closing_session_cannot_be_reprobed_or_finalize_a_reopened_tab() {
        let registry = Arc::new(Registry::default());
        let tab = TabId::new();
        let nonce = registry.begin(tab);
        registry.ready(tab, &nonce);
        let ticket = registry.ticket(tab).unwrap();
        assert!(registry.begin_close(tab, &ticket));
        assert!(registry.is_closing(tab, &ticket));
        assert!(registry.ticket(tab).is_none());
        assert!(!registry.begin_close(tab, &ticket));
        let fresh = registry.begin(tab);
        registry.ready(tab, &fresh);
        assert!(!registry.is_closing(tab, &ticket));
        assert!(registry.ticket(tab).is_some());
    }

    #[test]
    fn missing_setup_downloads_and_pending_work_cannot_admit_a_probe() {
        let registry = Arc::new(Registry::default());
        let tab = TabId::new();
        let nonce = registry.begin(tab);
        assert!(registry.ticket(tab).is_none(), "setup has not finished");
        registry.ready(tab, &nonce);
        assert!(registry.ticket(tab).is_some());
        registry.download(tab, &nonce, "file", true);
        registry.download(tab, &nonce, "file", true);
        assert!(registry.ticket(tab).is_none());
        registry.download(tab, &nonce, "file", false);
        assert!(registry.ticket(tab).is_none());
        registry.download(tab, &nonce, "file", false);
        assert!(registry.ticket(tab).is_some());
        let pending = registry.pending(tab);
        assert!(registry.ticket(tab).is_none());
        drop(pending);
        assert!(registry.ticket(tab).is_some());
    }
    #[test]
    fn activity_and_reopened_sessions_invalidate_a_completed_probe() {
        let registry = Registry::default();
        let tab = TabId::new();
        let nonce = registry.begin(tab);
        registry.ready(tab, &nonce);
        let before = registry.ticket(tab).unwrap();
        registry.changed(tab, &nonce);
        assert!(!registry.current(tab, &before));
        let before = registry.ticket(tab).unwrap();
        let fresh = registry.begin(tab);
        registry.ready(tab, &fresh);
        assert!(!registry.current(tab, &before));
        let current = registry.ticket(tab).unwrap();
        registry.download(tab, &nonce, "old", true);
        assert!(
            registry.current(tab, &current),
            "old session callback must not affect replacement"
        );
    }
}
