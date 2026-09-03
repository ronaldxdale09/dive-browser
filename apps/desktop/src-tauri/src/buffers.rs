//! Per-tab ring buffers of console and network activity kept in the host so
//! agents (MCP, the sidecar) can read recent history without the chrome.

use std::collections::{HashMap, VecDeque};
use std::sync::Mutex;

use dive_core::TabId;

use crate::console::ConsoleEntry;
use crate::network::NetworkEvent;

const CONSOLE_CAP: usize = 500;
const NETWORK_CAP: usize = 1000;

/// What a `ref` from `page_state` points at.
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
pub struct RefTarget {
    /// Backend DOM node id for CDP calls.
    pub backend_node_id: i64,
    /// ARIA role.
    pub role: String,
    /// Accessible name.
    pub name: String,
}

/// A merged view of one request, built from its lifecycle events.
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
pub struct RequestSummary {
    /// CDP request id.
    pub id: String,
    /// Full URL.
    pub url: String,
    /// HTTP method.
    pub method: String,
    /// Resource type.
    pub resource_type: String,
    /// HTTP status once headers arrived.
    pub status: Option<u16>,
    /// Content type.
    pub mime_type: String,
    /// Bytes on the wire once finished.
    pub encoded_length: Option<f64>,
    /// Error text if it failed.
    pub error: Option<String>,
    /// Request headers.
    pub headers: std::collections::BTreeMap<String, String>,
    /// Request body, when captured.
    pub post_data: Option<String>,
}

#[derive(Default)]
struct TabBuffers {
    console: VecDeque<ConsoleEntry>,
    requests: VecDeque<RequestSummary>,
    /// `ref` id -> backend DOM node id from the last `page_state` snapshot.
    ax_refs: HashMap<String, RefTarget>,
    /// Last two page snapshots, oldest first.
    snapshots: VecDeque<crate::snapshot::PageSnapshot>,
    /// Steps recorded so far; `None` when not recording.
    recording: Option<Vec<crate::recorder::RecordedStep>>,
    /// Nonce the trusted recorder script embeds in its payloads.
    recording_nonce: Option<String>,
}

/// Thread-safe buffers for every tab.
#[derive(Default)]
pub struct Buffers {
    inner: Mutex<HashMap<TabId, TabBuffers>>,
}

impl Buffers {
    fn with<T>(&self, f: impl FnOnce(&mut HashMap<TabId, TabBuffers>) -> T) -> T {
        f(&mut self
            .inner
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner))
    }

    /// Record a console entry.
    pub fn push_console(&self, entry: ConsoleEntry) {
        self.with(|m| {
            let buf = &mut m.entry(entry.tab_id).or_default().console;
            if buf.len() == CONSOLE_CAP {
                buf.pop_front();
            }
            buf.push_back(entry);
        });
    }

    /// Fold a network event into its request row.
    pub fn push_network(&self, event: &NetworkEvent) {
        self.with(|m| {
            let (tab_id, request_id) = match event {
                NetworkEvent::Sent {
                    tab_id, request_id, ..
                }
                | NetworkEvent::Response {
                    tab_id, request_id, ..
                }
                | NetworkEvent::Finished {
                    tab_id, request_id, ..
                }
                | NetworkEvent::Failed {
                    tab_id, request_id, ..
                } => (*tab_id, request_id),
            };
            let buf = &mut m.entry(tab_id).or_default().requests;
            match event {
                NetworkEvent::Sent {
                    url,
                    method,
                    resource_type,
                    headers,
                    post_data,
                    ..
                } => {
                    let row = RequestSummary {
                        id: request_id.clone(),
                        url: url.clone(),
                        method: method.clone(),
                        resource_type: resource_type.clone(),
                        status: None,
                        mime_type: String::new(),
                        encoded_length: None,
                        error: None,
                        headers: headers.clone(),
                        post_data: post_data.clone(),
                    };
                    if let Some(existing) = buf.iter_mut().find(|r| r.id == *request_id) {
                        *existing = row;
                    } else {
                        if buf.len() == NETWORK_CAP {
                            buf.pop_front();
                        }
                        buf.push_back(row);
                    }
                }
                NetworkEvent::Response {
                    status, mime_type, ..
                } => {
                    if let Some(r) = buf.iter_mut().find(|r| r.id == *request_id) {
                        r.status = Some(*status);
                        r.mime_type.clone_from(mime_type);
                    }
                }
                NetworkEvent::Finished { encoded_length, .. } => {
                    if let Some(r) = buf.iter_mut().find(|r| r.id == *request_id) {
                        r.encoded_length = Some(*encoded_length);
                    }
                }
                NetworkEvent::Failed { error, .. } => {
                    if let Some(r) = buf.iter_mut().find(|r| r.id == *request_id) {
                        r.error = Some(error.clone());
                    }
                }
            }
        });
    }

    /// Newest `limit` console entries, oldest first.
    pub fn console_tail(&self, tab: TabId, limit: usize) -> Vec<ConsoleEntry> {
        self.with(|m| {
            m.get(&tab)
                .map(|b| {
                    b.console
                        .iter()
                        .rev()
                        .take(limit)
                        .cloned()
                        .collect::<Vec<_>>()
                })
                .map(|mut v| {
                    v.reverse();
                    v
                })
                .unwrap_or_default()
        })
    }

    /// One request by id.
    pub fn request(&self, tab: TabId, request_id: &str) -> Option<RequestSummary> {
        self.with(|m| {
            m.get(&tab)
                .and_then(|b| b.requests.iter().find(|r| r.id == request_id).cloned())
        })
    }

    /// Newest `limit` requests, oldest first.
    pub fn requests(&self, tab: TabId, limit: usize) -> Vec<RequestSummary> {
        self.with(|m| {
            m.get(&tab)
                .map(|b| {
                    b.requests
                        .iter()
                        .rev()
                        .take(limit)
                        .cloned()
                        .collect::<Vec<_>>()
                })
                .map(|mut v| {
                    v.reverse();
                    v
                })
                .unwrap_or_default()
        })
    }

    /// Remember the ref -> backend node mapping of the latest snapshot.
    pub fn set_refs(&self, tab: TabId, refs: HashMap<String, RefTarget>) {
        self.with(|m| m.entry(tab).or_default().ax_refs = refs);
    }

    /// Target of `reference`, if the snapshot is current.
    pub fn resolve_ref(&self, tab: TabId, reference: &str) -> Option<RefTarget> {
        self.with(|m| m.get(&tab).and_then(|b| b.ax_refs.get(reference).cloned()))
    }

    /// Store a snapshot, keeping the two most recent.
    pub fn push_snapshot(&self, tab: TabId, snap: crate::snapshot::PageSnapshot) {
        self.with(|m| {
            let list = &mut m.entry(tab).or_default().snapshots;
            if list.len() == 2 {
                list.pop_front();
            }
            list.push_back(snap);
        });
    }

    /// The two most recent snapshots (older, newer), if both exist.
    pub fn last_two_snapshots(
        &self,
        tab: TabId,
    ) -> Option<(crate::snapshot::PageSnapshot, crate::snapshot::PageSnapshot)> {
        self.with(|m| {
            let list = &m.get(&tab)?.snapshots;
            (list.len() == 2).then(|| (list[0].clone(), list[1].clone()))
        })
    }

    /// Start (`Some(vec![])`) or stop (`None`) recording.
    pub fn set_recording(&self, tab: TabId, value: Option<Vec<crate::recorder::RecordedStep>>) {
        self.with(|m| m.entry(tab).or_default().recording = value);
    }

    /// Set or clear the recording nonce.
    pub fn set_recording_nonce(&self, tab: TabId, nonce: Option<String>) {
        self.with(|m| m.entry(tab).or_default().recording_nonce = nonce);
    }

    /// Whether a recording is active.
    pub fn is_recording(&self, tab: TabId) -> bool {
        self.with(|m| m.get(&tab).is_some_and(|b| b.recording.is_some()))
    }

    /// Append a recorded step if recording.
    pub fn push_recorded(&self, tab: TabId, step: crate::recorder::RecordedStep) {
        self.with(|m| {
            if let Some(list) = m.entry(tab).or_default().recording.as_mut() {
                list.push(step);
            }
        });
    }

    /// Stop recording and return the steps.
    pub fn take_recording(&self, tab: TabId) -> Vec<crate::recorder::RecordedStep> {
        self.with(|m| {
            m.get_mut(&tab)
                .and_then(|b| b.recording.take())
                .unwrap_or_default()
        })
    }

    /// Forget a closed tab.
    pub fn drop_tab(&self, tab: TabId) {
        self.with(|m| {
            m.remove(&tab);
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::console::Level;

    fn entry(tab: TabId, text: &str) -> ConsoleEntry {
        ConsoleEntry {
            tab_id: tab,
            level: Level::Info,
            text: text.into(),
            source: "console".into(),
            url: None,
            line: None,
            timestamp: 0.0,
            column: None,
        }
    }

    #[test]
    fn console_ring_keeps_newest() {
        let b = Buffers::default();
        let tab = TabId::new();
        for i in 0..(CONSOLE_CAP + 5) {
            b.push_console(entry(tab, &i.to_string()));
        }
        let tail = b.console_tail(tab, 3);
        assert_eq!(
            tail.iter().map(|e| e.text.as_str()).collect::<Vec<_>>(),
            ["502", "503", "504"]
        );
        assert_eq!(b.console_tail(tab, 10_000).len(), CONSOLE_CAP);
        b.drop_tab(tab);
        assert!(b.console_tail(tab, 3).is_empty());
    }

    #[test]
    fn network_rows_merge_lifecycle() {
        let b = Buffers::default();
        let tab = TabId::new();
        b.push_network(&NetworkEvent::Sent {
            tab_id: tab,
            request_id: "1".into(),
            url: "https://a/x".into(),
            method: "GET".into(),
            resource_type: "Fetch".into(),
            headers: std::collections::BTreeMap::new(),
            post_data: None,
            timestamp: 1.0,
        });
        b.push_network(&NetworkEvent::Response {
            tab_id: tab,
            request_id: "1".into(),
            status: 200,
            mime_type: "text/plain".into(),
            from_cache: false,
            timestamp: 1.1,
        });
        b.push_network(&NetworkEvent::Finished {
            tab_id: tab,
            request_id: "1".into(),
            encoded_length: 42.0,
            timestamp: 1.2,
        });
        b.push_network(&NetworkEvent::Failed {
            tab_id: tab,
            request_id: "zzz".into(),
            error: "nope".into(),
            timestamp: 1.3,
        });
        let rows = b.requests(tab, 10);
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].status, Some(200));
        assert_eq!(rows[0].encoded_length, Some(42.0));
        assert_eq!(rows[0].error, None);
    }
}
