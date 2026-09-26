//! Per-tab ring buffers of console and network activity kept in the host so
//! agents (MCP, the sidecar) can read recent history without the chrome.

use std::collections::{HashMap, VecDeque};
use std::sync::{Arc, Mutex};

use dive_core::TabId;
use serde::{Deserialize, Serialize};
use specta::Type;

use crate::console::ConsoleEntry;
use crate::network::NetworkEvent;

const CONSOLE_CAP: usize = 500;
const NETWORK_CAP: usize = 1000;
/// Bytes of request and response bodies kept per tab, together.
const BODY_BUDGET: usize = 2 * 1024 * 1024;
const RECORDED_STEP_CAP: usize = 5_000;

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
    /// Complete JSON response body, captured only within the byte budget.
    pub response_body: Option<String>,
    /// Why a response body is absent, when capture has completed or been omitted.
    pub response_body_note: Option<String>,
    /// Response headers once they arrived.
    pub response_headers: std::collections::BTreeMap<String, String>,
    /// CDP monotonic seconds when the request was sent.
    pub started_at: f64,
    /// Seconds since the epoch when the request was sent.
    pub wall_time: f64,
    /// CDP monotonic seconds when it finished or failed.
    pub finished_at: Option<f64>,
}

/// What the agent and MCP see of a request: no headers, bodies or cookies.
/// Bodies are fetched one at a time through `network_body`.
#[derive(Clone, Debug, serde::Serialize)]
pub struct RequestListing {
    pub id: String,
    pub method: String,
    pub url: String,
    pub resource_type: String,
    pub status: Option<u16>,
    pub mime_type: String,
    pub encoded_length: Option<f64>,
    pub error: Option<String>,
}

impl From<&RequestSummary> for RequestListing {
    fn from(r: &RequestSummary) -> Self {
        Self {
            id: r.id.clone(),
            method: r.method.clone(),
            url: r.url.clone(),
            resource_type: r.resource_type.clone(),
            status: r.status,
            mime_type: r.mime_type.clone(),
            encoded_length: r.encoded_length,
            error: r.error.clone(),
        }
    }
}

#[derive(Default)]
struct TabBuffers {
    console: VecDeque<ConsoleEntry>,
    /// Console entries ever pushed for this tab, so a mark survives the
    /// ring dropping its oldest lines.
    console_pushed: u64,
    /// `console_pushed` when the page last started over: a main-frame
    /// navigation or `console.clear()`. What came before is the old page's.
    console_mark: u64,
    /// Request rows, oldest first. Rows only ever leave from the front.
    requests: VecDeque<RequestSummary>,
    /// Request id -> sequence number of its row. Every network event is
    /// folded into its row by id, and finding it by walking up to a thousand
    /// rows per event was the cost of a busy page.
    request_index: HashMap<String, u64>,
    /// Sequence number of the row at the front of `requests`.
    first_request: u64,
    /// Bytes of request and response bodies the rows hold, kept as they
    /// change so the budget check never has to add them up.
    body_bytes: usize,
    /// `ref` id -> backend DOM node id from the last `page_state` snapshot.
    ax_refs: HashMap<String, RefTarget>,
    /// Last two page snapshots, oldest first.
    snapshots: VecDeque<crate::snapshot::PageSnapshot>,
    /// Steps recorded so far; `None` when not recording.
    recording: Option<Vec<crate::recorder::RecordedStep>>,
    /// Nonce the trusted recorder script embeds in its payloads.
    recording_nonce: Option<String>,
    /// CDP identifier for the recorder bootstrap installed on future documents.
    recording_script_id: Option<String>,
    /// WebSocket frames / server-sent events per request, newest last.
    frames: HashMap<String, VecDeque<FrameSummary>>,
    /// What automation has done to this tab, oldest first.
    timeline: VecDeque<ActionEvent>,
    /// Monotonic counter behind the action ids.
    next_action: u64,
    /// Media emulation currently applied to the tab. Shared by the UI and
    /// automation so changing one preference does not clear the others.
    media: crate::emulate::MediaOverrides,
    /// Device last applied to the tab, so the next change can tell whether
    /// the user agent moved and a reload is due.
    device: Option<crate::emulate::Device>,
    /// What workspace rules did to requests, by network request id, newest
    /// last. The Network panel shows headers as the page sent them, so this
    /// is how a rewrite becomes visible where the developer looks.
    rewrites: VecDeque<(String, String)>,
}

/// Most rule effects remembered per tab.
const REWRITES_KEPT: usize = 256;

impl RequestSummary {
    /// A row with nothing known yet beyond the request line.
    fn new(id: &str, url: &str, method: &str, resource_type: &str, started_at: f64) -> Self {
        Self {
            id: id.to_owned(),
            url: url.to_owned(),
            method: method.to_owned(),
            resource_type: resource_type.to_owned(),
            status: None,
            mime_type: String::new(),
            encoded_length: None,
            error: None,
            headers: std::collections::BTreeMap::new(),
            post_data: None,
            response_body: None,
            response_body_note: None,
            response_headers: std::collections::BTreeMap::new(),
            started_at,
            wall_time: 0.0,
            finished_at: None,
        }
    }
}

/// Bytes a row's bodies count against the tab's budget.
fn body_len(row: &RequestSummary) -> usize {
    row.response_body.as_ref().map_or(0, String::len)
        + row.post_data.as_ref().map_or(0, String::len)
}

impl TabBuffers {
    /// Where the row for `id` sits in `requests`, if it is still kept.
    fn position(&self, id: &str) -> Option<usize> {
        let seq = self.request_index.get(id)?;
        usize::try_from(seq - self.first_request).ok()
    }

    fn row(&self, id: &str) -> Option<&RequestSummary> {
        self.requests.get(self.position(id)?)
    }

    fn row_mut(&mut self, id: &str) -> Option<&mut RequestSummary> {
        let at = self.position(id)?;
        self.requests.get_mut(at)
    }

    /// Take the oldest row out, with everything that hangs off it.
    fn pop_front_row(&mut self) -> Option<RequestSummary> {
        let row = self.requests.pop_front()?;
        self.first_request += 1;
        self.request_index.remove(&row.id);
        self.body_bytes -= body_len(&row);
        self.frames.remove(&row.id);
        Some(row)
    }

    /// Insert a row, replacing one with the same id (redirects reuse ids).
    fn push_row(&mut self, row: RequestSummary) {
        let id = row.id.clone();
        let added = body_len(&row);
        if let Some(existing) = self.row_mut(&id) {
            let removed = body_len(existing);
            *existing = row;
            self.body_bytes = self.body_bytes - removed + added;
        } else {
            if self.requests.len() == NETWORK_CAP {
                self.pop_front_row();
            }
            let seq = self.first_request + self.requests.len() as u64;
            self.requests.push_back(row);
            self.request_index.insert(id.clone(), seq);
            self.body_bytes += added;
        }
        self.fit_bodies(&id);
    }

    /// Drop the oldest bodies until the tab is within its byte budget again,
    /// sparing `keep`'s. Request bodies count as much as response bodies: an
    /// upload-heavy page kept up to a thousand of them, uncounted.
    fn fit_bodies(&mut self, keep: &str) {
        if self.body_bytes <= BODY_BUDGET {
            return;
        }
        for row in &mut self.requests {
            if self.body_bytes <= BODY_BUDGET {
                break;
            }
            if row.id == keep {
                continue;
            }
            if let Some(old) = row.response_body.take() {
                self.body_bytes -= old.len();
                row.response_body_note = Some("Body evicted: tab capture budget reached".into());
            }
            if let Some(old) = row.post_data.take() {
                self.body_bytes -= old.len();
            }
        }
    }

    /// Set or clear a row's response body, keeping the byte count true.
    fn replace_response_body(&mut self, id: &str, body: Option<String>, note: Option<String>) {
        let Some(row) = self.row_mut(id) else {
            return;
        };
        let removed = row.response_body.as_ref().map_or(0, String::len);
        let added = body.as_ref().map_or(0, String::len);
        row.response_body = body;
        row.response_body_note = note;
        self.body_bytes = self.body_bytes - removed + added;
    }

    /// Fold a lifecycle event into its row; `Frame` events go to `frames`.
    fn fold_network(&mut self, event: &NetworkEvent, request_id: &str) {
        match event {
            NetworkEvent::Sent {
                url,
                method,
                resource_type,
                headers,
                post_data,
                timestamp,
                wall_time,
                ..
            } => {
                let mut row =
                    RequestSummary::new(request_id, url, method, resource_type, *timestamp);
                row.headers.clone_from(headers);
                row.post_data.clone_from(post_data);
                row.wall_time = *wall_time;
                self.push_row(row);
            }
            NetworkEvent::Socket { url, timestamp, .. } => {
                let mut row = RequestSummary::new(request_id, url, "GET", "WebSocket", *timestamp);
                row.mime_type = "websocket".into();
                self.push_row(row);
            }
            NetworkEvent::Frame {
                direction,
                payload,
                timestamp,
                ..
            } => {
                // Frames are useful only while their request row is retained.
                // Ignoring an unknown id also prevents a malformed event stream
                // from growing the side map without bound.
                if !self.request_index.contains_key(request_id) {
                    return;
                }
                let frames = self.frames.entry(request_id.to_owned()).or_default();
                if frames.len() == FRAME_CAP {
                    frames.pop_front();
                }
                frames.push_back(FrameSummary {
                    direction: direction.clone(),
                    payload: payload.clone(),
                    timestamp: *timestamp,
                });
            }
            NetworkEvent::Response {
                status,
                mime_type,
                headers,
                ..
            } => {
                if let Some(r) = self.row_mut(request_id) {
                    r.status = Some(*status);
                    r.mime_type.clone_from(mime_type);
                    r.response_headers.clone_from(headers);
                }
            }
            NetworkEvent::Finished {
                encoded_length,
                timestamp,
                ..
            } => {
                if let Some(r) = self.row_mut(request_id) {
                    r.encoded_length = Some(*encoded_length);
                    r.finished_at = Some(*timestamp);
                }
            }
            NetworkEvent::Failed {
                error, timestamp, ..
            } => {
                if let Some(r) = self.row_mut(request_id) {
                    r.error = Some(error.clone());
                    r.finished_at = Some(*timestamp);
                }
            }
        }
    }
}

/// One WebSocket frame or server-sent event.
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
pub struct FrameSummary {
    /// `sent` or `received`.
    pub direction: String,
    pub payload: String,
    /// CDP monotonic seconds.
    pub timestamp: f64,
}

/// Frames kept per socket.
const FRAME_CAP: usize = 200;
/// Actions remembered per tab.
const TIMELINE_CAP: usize = 100;

/// One automation action against a tab.
///
/// Handed back with every `page_inspect` so an agent that has lost track of
/// its own history — a new turn, a compacted context — can see what it
/// already tried instead of repeating it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
pub struct ActionEvent {
    /// Unique within the tab.
    pub id: String,
    /// Tool name, for example `page_click`.
    pub action: String,
    /// What it was aimed at, when that is meaningful.
    pub target: Option<String>,
    /// `running`, `succeeded` or `failed`.
    pub status: String,
    /// RFC 3339 start time.
    pub started_at: String,
    /// RFC 3339 completion time, absent while running.
    pub completed_at: Option<String>,
    /// Failure message, when it failed.
    pub error: Option<String>,
}

/// Thread-safe buffers for every tab.
///
/// Each tab's buffers sit behind a lock of their own. One lock for every tab
/// had each network event of each tab queue behind every other tab's, and
/// behind every agent read; the map's lock is now held only long enough to
/// find the tab.
#[derive(Default)]
pub struct Buffers {
    inner: Mutex<HashMap<TabId, Arc<Mutex<TabBuffers>>>>,
}

impl Buffers {
    /// The tab's buffers, made if `create` and they do not exist yet.
    fn tab(&self, tab: TabId, create: bool) -> Option<Arc<Mutex<TabBuffers>>> {
        let mut map = self
            .inner
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if create {
            Some(Arc::clone(map.entry(tab).or_default()))
        } else {
            map.get(&tab).cloned()
        }
    }

    /// Run `f` on the tab's buffers, making them if they do not exist yet.
    fn with_tab<T>(&self, tab: TabId, f: impl FnOnce(&mut TabBuffers) -> T) -> T {
        let buffers = self.tab(tab, true).unwrap_or_default();
        f(&mut buffers
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner))
    }

    /// Run `f` on the tab's buffers if they exist. A late write for a tab
    /// that was dropped must not bring it back.
    fn with_existing<T>(&self, tab: TabId, f: impl FnOnce(&mut TabBuffers) -> T) -> Option<T> {
        let buffers = self.tab(tab, false)?;
        Some(f(&mut buffers
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)))
    }

    /// Record a console entry.
    pub fn push_console(&self, entry: ConsoleEntry) {
        self.with_tab(entry.tab_id, |tab| {
            if tab.console.len() == CONSOLE_CAP {
                tab.console.pop_front();
            }
            tab.console.push_back(entry);
            tab.console_pushed += 1;
        });
    }

    /// Fold a network event into its request row.
    pub fn push_network(&self, event: &NetworkEvent) {
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
            }
            | NetworkEvent::Socket {
                tab_id, request_id, ..
            }
            | NetworkEvent::Frame {
                tab_id, request_id, ..
            } => (*tab_id, request_id),
        };
        self.with_tab(tab_id, |tab| tab.fold_network(event, request_id));
    }

    /// Note that the page started over -- a main-frame navigation, or
    /// `console.clear()` -- so a later clear can drop only what came before.
    pub fn mark_console(&self, tab: TabId) {
        self.with_tab(tab, |buf| buf.console_mark = buf.console_pushed);
    }

    /// Forget a tab's console output: all of it, or only what came before
    /// the page last started over.
    ///
    /// The chrome decides when, because "Preserve log" is its setting. It
    /// asks after the fact, by which time the new page may already have
    /// logged; the mark is what keeps those lines.
    pub fn clear_console(&self, tab: TabId, before_mark_only: bool) {
        self.with_existing(tab, |buf| {
            let since =
                usize::try_from(buf.console_pushed - buf.console_mark).unwrap_or(usize::MAX);
            let keep = if before_mark_only {
                since.min(buf.console.len())
            } else {
                0
            };
            let drop = buf.console.len() - keep;
            buf.console.drain(..drop);
        });
    }

    /// Forget a tab's requests: all of them, or those before `keep_from`,
    /// the request that started the page now showing. Frames, bodies and rule
    /// effects go with their requests.
    pub fn clear_network(&self, tab: TabId, keep_from: Option<&str>) {
        self.with_existing(tab, |buf| {
            let first_kept =
                keep_from
                    .and_then(|id| buf.position(id))
                    .unwrap_or(if keep_from.is_some() {
                        0
                    } else {
                        buf.requests.len()
                    });
            let mut gone = std::collections::HashSet::new();
            for _ in 0..first_kept {
                if let Some(row) = buf.pop_front_row() {
                    gone.insert(row.id);
                }
            }
            if !gone.is_empty() {
                buf.rewrites.retain(|(id, _)| !gone.contains(id));
            }
        });
    }

    /// Newest `limit` console entries, oldest first.
    pub fn console_tail(&self, tab: TabId, limit: usize) -> Vec<ConsoleEntry> {
        self.with_existing(tab, |b| {
            let skip = b.console.len().saturating_sub(limit);
            b.console.iter().skip(skip).cloned().collect()
        })
        .unwrap_or_default()
    }

    /// Newest `limit` requests as slim listings, oldest first.
    pub fn requests_listing(&self, tab: TabId, limit: usize) -> Vec<RequestListing> {
        self.with_existing(tab, |b| {
            let skip = b.requests.len().saturating_sub(limit);
            b.requests
                .iter()
                .skip(skip)
                .map(RequestListing::from)
                .collect()
        })
        .unwrap_or_default()
    }

    /// Frames of a socket or event stream, oldest first.
    pub fn frames(&self, tab: TabId, request_id: &str) -> Vec<FrameSummary> {
        self.with_existing(tab, |b| {
            b.frames
                .get(request_id)
                .map(|f| f.iter().cloned().collect())
        })
        .flatten()
        .unwrap_or_default()
    }

    /// Check capture eligibility without cloning request headers or bodies.
    pub fn is_json_response(&self, tab: TabId, request_id: &str) -> bool {
        self.with_existing(tab, |b| {
            b.row(request_id)
                .is_some_and(|r| crate::network::is_json_mime(&r.mime_type))
        })
        .unwrap_or(false)
    }

    /// Attach a complete response within a per-tab byte budget. Old bodies are
    /// evicted first while their request metadata stays available.
    pub fn set_response_body(&self, tab: TabId, request_id: &str, body: String) {
        if body.len() > crate::network::MAX_BODY {
            self.set_response_body_note(
                tab,
                request_id,
                "Response exceeds the 64 KiB capture limit",
            );
            return;
        }
        self.with_existing(tab, |b| {
            if b.row(request_id).is_none() {
                return;
            }
            b.replace_response_body(request_id, Some(body), None);
            b.fit_bodies(request_id);
        });
    }

    /// Preserve the reason a body is unavailable instead of implying an empty body.
    pub fn set_response_body_note(&self, tab: TabId, request_id: &str, note: &str) {
        self.with_existing(tab, |b| {
            b.replace_response_body(request_id, None, Some(note.to_owned()));
        });
    }

    /// Remember that a workspace rule changed `request_id`, in words.
    pub fn note_rewrite(&self, tab: TabId, request_id: &str, note: &str) {
        self.with_tab(tab, |b| {
            let list = &mut b.rewrites;
            list.push_back((request_id.to_owned(), note.to_owned()));
            while list.len() > REWRITES_KEPT {
                list.pop_front();
            }
        });
    }

    /// What rules did to `request_id`, oldest first.
    pub fn rewrites_for(&self, tab: TabId, request_id: &str) -> Vec<String> {
        self.with_existing(tab, |b| {
            b.rewrites
                .iter()
                .filter(|(id, _)| id == request_id)
                .map(|(_, note)| note.clone())
                .collect()
        })
        .unwrap_or_default()
    }

    /// One request by id.
    pub fn request(&self, tab: TabId, request_id: &str) -> Option<RequestSummary> {
        self.with_existing(tab, |b| b.row(request_id).cloned())
            .flatten()
    }

    /// Newest `limit` requests, oldest first.
    pub fn requests(&self, tab: TabId, limit: usize) -> Vec<RequestSummary> {
        self.with_existing(tab, |b| {
            let skip = b.requests.len().saturating_sub(limit);
            b.requests.iter().skip(skip).cloned().collect()
        })
        .unwrap_or_default()
    }

    /// Remember the ref -> backend node mapping of the latest snapshot.
    pub fn set_refs(&self, tab: TabId, refs: HashMap<String, RefTarget>) {
        self.with_tab(tab, |b| b.ax_refs = refs);
    }

    /// Target of `reference`, if the snapshot is current.
    pub fn resolve_ref(&self, tab: TabId, reference: &str) -> Option<RefTarget> {
        self.with_existing(tab, |b| b.ax_refs.get(reference).cloned())
            .flatten()
    }

    /// Store a snapshot, keeping the two most recent.
    pub fn push_snapshot(&self, tab: TabId, snap: crate::snapshot::PageSnapshot) {
        self.with_tab(tab, |b| {
            let list = &mut b.snapshots;
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
        self.with_existing(tab, |b| {
            let list = &b.snapshots;
            (list.len() == 2).then(|| (list[0].clone(), list[1].clone()))
        })
        .flatten()
    }

    /// Start (`Some(vec![])`) or stop (`None`) recording.
    pub fn set_recording(&self, tab: TabId, value: Option<Vec<crate::recorder::RecordedStep>>) {
        self.with_tab(tab, |b| b.recording = value);
    }

    /// Set or clear the recording nonce.
    pub fn set_recording_nonce(&self, tab: TabId, nonce: Option<String>) {
        self.with_tab(tab, |b| b.recording_nonce = nonce);
    }

    /// Remember the registered recorder bootstrap so stop can remove it.
    pub fn set_recording_script_id(&self, tab: TabId, id: Option<String>) {
        self.with_tab(tab, |b| b.recording_script_id = id);
    }

    /// Whether a recording is active.
    pub fn is_recording(&self, tab: TabId) -> bool {
        self.with_existing(tab, |b| b.recording.is_some())
            .unwrap_or(false)
    }

    /// Append a recorded step if recording.
    pub fn push_recorded(&self, tab: TabId, step: crate::recorder::RecordedStep) {
        self.with_tab(tab, |b| {
            if let Some(list) = b.recording.as_mut()
                && list.len() < RECORDED_STEP_CAP
            {
                list.push(step);
            }
        });
    }

    /// Stop recording and return the steps plus the registered script id.
    pub fn finish_recording(
        &self,
        tab: TabId,
    ) -> (Vec<crate::recorder::RecordedStep>, Option<String>) {
        self.with_existing(tab, |buffer| {
            buffer.recording_nonce = None;
            (
                buffer.recording.take().unwrap_or_default(),
                buffer.recording_script_id.take(),
            )
        })
        .unwrap_or_default()
    }

    /// Note that an action has started; returns its id.
    ///
    /// An action left `running` is a call that never came back — usually a
    /// crashed page — and stays visible as such rather than disappearing.
    pub fn begin_action(&self, tab: TabId, action: &str, target: Option<String>) -> String {
        self.with_tab(tab, |buf| {
            buf.next_action += 1;
            let id = format!("a{}", buf.next_action);
            if buf.timeline.len() == TIMELINE_CAP {
                buf.timeline.pop_front();
            }
            buf.timeline.push_back(ActionEvent {
                id: id.clone(),
                action: action.to_owned(),
                target,
                status: "running".into(),
                started_at: dive_core::Timestamp::now().to_rfc3339(),
                completed_at: None,
                error: None,
            });
            id
        })
    }

    /// Close out an action. `error` of `None` means it succeeded.
    pub fn end_action(&self, tab: TabId, id: &str, error: Option<String>) {
        self.with_existing(tab, |buf| {
            let Some(event) = buf.timeline.iter_mut().find(|e| e.id == id) else {
                return;
            };
            event.status = if error.is_some() {
                "failed"
            } else {
                "succeeded"
            }
            .into();
            event.completed_at = Some(dive_core::Timestamp::now().to_rfc3339());
            event.error = error.map(|e| e.chars().take(300).collect());
        });
    }

    /// The most recent actions against a tab, oldest first.
    pub fn timeline(&self, tab: TabId, limit: usize) -> Vec<ActionEvent> {
        self.with_existing(tab, |b| {
            let skip = b.timeline.len().saturating_sub(limit);
            b.timeline.iter().skip(skip).cloned().collect()
        })
        .unwrap_or_default()
    }

    /// Media overrides last applied to a tab.
    pub fn media(&self, tab: TabId) -> crate::emulate::MediaOverrides {
        self.with_existing(tab, |b| b.media.clone())
            .unwrap_or_default()
    }

    /// Remember the full set of media overrides after CDP accepted them.
    pub fn set_media(&self, tab: TabId, media: crate::emulate::MediaOverrides) {
        self.with_tab(tab, |b| b.media = media);
    }

    /// Device last applied to a tab, if any.
    pub fn device(&self, tab: TabId) -> Option<crate::emulate::Device> {
        self.with_existing(tab, |b| b.device.clone()).flatten()
    }

    /// Remember the device after CDP accepted it.
    pub fn set_device(&self, tab: TabId, device: Option<crate::emulate::Device>) {
        self.with_tab(tab, |b| b.device = device);
    }

    /// Forget a closed tab.
    pub fn drop_tab(&self, tab: TabId) {
        self.inner
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .remove(&tab);
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
    fn response_body_budget_preserves_metadata_and_releases_replaced_bodies() {
        let b = Buffers::default();
        let tab = TabId::new();
        let count = BODY_BUDGET / crate::network::MAX_BODY;
        for i in 0..=count {
            b.with_tab(tab, |t| {
                t.push_row(RequestSummary::new(
                    &i.to_string(),
                    "https://api.test",
                    "GET",
                    "Fetch",
                    0.0,
                ));
            });
            b.set_response_body(tab, &i.to_string(), "x".repeat(crate::network::MAX_BODY));
        }
        let rows = b.requests(tab, NETWORK_CAP);
        assert_eq!(rows.len(), count + 1);
        assert_eq!(
            rows.iter()
                .map(|r| r.response_body.as_ref().map_or(0, String::len))
                .sum::<usize>(),
            BODY_BUDGET
        );
        assert!(rows[0].response_body.is_none());
        assert_eq!(
            rows[0].response_body_note.as_deref(),
            Some("Body evicted: tab capture budget reached")
        );
        b.set_response_body(tab, "1", "{}".into());
        b.set_response_body(tab, "0", "[]".into());
        assert_eq!(
            b.request(tab, "0").unwrap().response_body.as_deref(),
            Some("[]")
        );
        assert!(b.request(tab, "0").unwrap().response_body_note.is_none());
        assert!(
            b.request(tab, "2").unwrap().response_body.is_some(),
            "replacing releases old bytes without evicting other rows"
        );
        b.set_response_body(tab, "1", "é".repeat(crate::network::MAX_BODY));
        assert!(
            b.request(tab, "1").unwrap().response_body.is_none(),
            "byte size is enforced even for direct callers"
        );
        b.drop_tab(tab);
        b.set_response_body(tab, "0", "late".into());
        b.set_response_body_note(tab, "0", "late");
        assert!(
            b.requests(tab, NETWORK_CAP).is_empty(),
            "late capture cannot recreate a dropped tab"
        );
    }

    fn sent(tab: TabId, id: &str, post_data: Option<String>) -> NetworkEvent {
        NetworkEvent::Sent {
            tab_id: tab,
            request_id: id.into(),
            url: format!("https://a.dev/{id}"),
            method: "POST".into(),
            resource_type: "Fetch".into(),
            headers: std::collections::BTreeMap::new(),
            post_data,
            timestamp: 0.0,
            wall_time: 0.0,
        }
    }

    /// The running byte count, checked against the rows it counts.
    fn assert_counted(b: &Buffers, tab: TabId) {
        b.with_existing(tab, |t| {
            assert_eq!(t.body_bytes, t.requests.iter().map(body_len).sum::<usize>());
        });
    }

    #[test]
    fn request_bodies_count_against_the_same_budget() {
        let b = Buffers::default();
        let tab = TabId::new();
        let count = BODY_BUDGET / crate::network::MAX_BODY;
        for i in 0..count + 4 {
            b.push_network(&sent(
                tab,
                &i.to_string(),
                Some("p".repeat(crate::network::MAX_BODY)),
            ));
            assert_counted(&b, tab);
        }
        let rows = b.requests(tab, NETWORK_CAP);
        assert_eq!(rows.len(), count + 4, "the rows themselves are all kept");
        let held: usize = rows.iter().map(body_len).sum();
        assert!(held <= BODY_BUDGET, "{held} bytes held");
        assert!(rows[0].post_data.is_none(), "the oldest bodies went first");
        assert!(rows[count + 3].post_data.is_some(), "the newest is kept");
    }

    #[test]
    fn the_request_index_follows_eviction_redirects_and_clears() {
        let b = Buffers::default();
        let tab = TabId::new();
        for i in 0..NETWORK_CAP + 10 {
            b.push_network(&sent(tab, &i.to_string(), Some("x".into())));
        }
        assert!(b.request(tab, "9").is_none(), "evicted rows are gone");
        assert_eq!(b.request(tab, "10").unwrap().id, "10");
        let last = (NETWORK_CAP + 9).to_string();
        assert_eq!(b.request(tab, &last).unwrap().id, last);
        // A redirect reuses its id and replaces the row where it stands.
        b.push_network(&sent(tab, "500", Some("longer body".into())));
        assert_eq!(
            b.request(tab, "500").unwrap().post_data.as_deref(),
            Some("longer body")
        );
        assert_eq!(b.requests(tab, NETWORK_CAP).len(), NETWORK_CAP);
        assert_counted(&b, tab);
        b.push_network(&NetworkEvent::Finished {
            tab_id: tab,
            request_id: "600".into(),
            encoded_length: 7.0,
            timestamp: 1.0,
        });
        assert_eq!(b.request(tab, "600").unwrap().encoded_length, Some(7.0));
        b.clear_network(tab, Some("600"));
        assert!(b.request(tab, "599").is_none());
        assert_eq!(b.requests(tab, NETWORK_CAP)[0].id, "600");
        assert_counted(&b, tab);
        b.push_network(&sent(tab, "new", None));
        assert_eq!(b.request(tab, "new").unwrap().id, "new");
        b.clear_network(tab, None);
        assert!(b.request(tab, "new").is_none());
        assert_counted(&b, tab);
    }

    #[test]
    fn rule_effects_are_remembered_per_request_and_bounded() {
        let buffers = Buffers::default();
        let tab = TabId::new();
        buffers.note_rewrite(tab, "r1", "Added header X-Test: 1");
        buffers.note_rewrite(tab, "r1", "Blocked by a rule");
        buffers.note_rewrite(tab, "r2", "Answered by a mock rule");
        assert_eq!(
            buffers.rewrites_for(tab, "r1"),
            vec![
                "Added header X-Test: 1".to_owned(),
                "Blocked by a rule".to_owned()
            ]
        );
        assert_eq!(
            buffers.rewrites_for(tab, "r2"),
            vec!["Answered by a mock rule".to_owned()]
        );
        assert!(buffers.rewrites_for(tab, "r3").is_empty());
        for i in 0..REWRITES_KEPT + 10 {
            buffers.note_rewrite(tab, &format!("x{i}"), "note");
        }
        assert!(
            buffers.rewrites_for(tab, "r1").is_empty(),
            "old effects fall off the end"
        );
    }

    #[test]
    fn clearing_the_console_can_keep_what_the_new_page_logged() {
        let b = Buffers::default();
        let tab = TabId::new();
        b.push_console(entry(tab, "old 1"));
        b.push_console(entry(tab, "old 2"));
        b.mark_console(tab);
        b.push_console(entry(tab, "new"));
        b.clear_console(tab, true);
        let texts: Vec<_> = b
            .console_tail(tab, 10)
            .into_iter()
            .map(|e| e.text)
            .collect();
        assert_eq!(texts, ["new"]);
        b.clear_console(tab, false);
        assert!(b.console_tail(tab, 10).is_empty());
        // Clearing a tab with nothing recorded is not an error.
        b.clear_console(TabId::new(), false);
    }

    #[test]
    fn clearing_requests_keeps_the_page_now_showing() {
        let b = Buffers::default();
        let tab = TabId::new();
        for id in ["old", "doc", "after"] {
            b.push_network(&NetworkEvent::Sent {
                tab_id: tab,
                request_id: id.into(),
                url: format!("https://a.dev/{id}"),
                method: "GET".into(),
                resource_type: "Document".into(),
                headers: std::collections::BTreeMap::new(),
                post_data: None,
                timestamp: 1.0,
                wall_time: 1.0,
            });
        }
        b.clear_network(tab, Some("doc"));
        let ids: Vec<_> = b.requests(tab, 10).into_iter().map(|r| r.id).collect();
        assert_eq!(ids, ["doc", "after"]);
        // A request that is not there any more keeps everything rather than
        // guessing what belongs to which page.
        b.clear_network(tab, Some("gone"));
        assert_eq!(b.requests(tab, 10).len(), 2);
        b.clear_network(tab, None);
        assert!(b.requests(tab, 10).is_empty());
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
            wall_time: 1_700_000_000.0,
        });
        b.push_network(&NetworkEvent::Response {
            tab_id: tab,
            request_id: "1".into(),
            status: 200,
            mime_type: "text/plain".into(),
            from_cache: false,
            headers: [("server".to_owned(), "x".to_owned())].into(),
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
        assert_eq!(
            rows[0].response_headers.get("server").map(String::as_str),
            Some("x")
        );
        assert_eq!(rows[0].finished_at, Some(1.2));
    }

    #[test]
    fn evicting_requests_also_evicts_their_frames() {
        let b = Buffers::default();
        let tab = TabId::new();
        for i in 0..=NETWORK_CAP {
            b.push_network(&NetworkEvent::Socket {
                tab_id: tab,
                request_id: i.to_string(),
                url: "wss://a.dev/ws".into(),
                timestamp: 0.0,
            });
            b.push_network(&NetworkEvent::Frame {
                tab_id: tab,
                request_id: i.to_string(),
                direction: "received".into(),
                payload: "x".into(),
                timestamp: 0.0,
            });
        }
        assert!(b.frames(tab, "0").is_empty());
        assert_eq!(b.frames(tab, &NETWORK_CAP.to_string()).len(), 1);
    }

    #[test]
    fn recording_steps_are_bounded() {
        let b = Buffers::default();
        let tab = TabId::new();
        b.set_recording(tab, Some(Vec::new()));
        for i in 0..(RECORDED_STEP_CAP + 10) {
            b.push_recorded(
                tab,
                crate::recorder::RecordedStep {
                    kind: "click".into(),
                    role: "button".into(),
                    name: i.to_string(),
                    value: String::new(),
                    at: 0.0,
                    masked: false,
                },
            );
        }
        assert_eq!(b.finish_recording(tab).0.len(), RECORDED_STEP_CAP);
    }

    #[test]
    fn media_overrides_are_isolated_and_removed_with_the_tab() {
        let b = Buffers::default();
        let (tab, other) = (TabId::new(), TabId::new());
        let media = crate::emulate::MediaOverrides {
            color_scheme: Some("dark".into()),
            reduced_motion: Some("reduce".into()),
            media_type: None,
            display_mode: Some("standalone".into()),
        };
        b.set_media(tab, media.clone());
        assert_eq!(b.media(tab), media);
        assert_eq!(b.media(other), crate::emulate::MediaOverrides::default());
        b.drop_tab(tab);
        assert_eq!(b.media(tab), crate::emulate::MediaOverrides::default());
    }
}
