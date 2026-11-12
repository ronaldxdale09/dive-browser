//! Agent backend: one API key per provider in the OS keychain, model
//! listings, the tool loop, and streaming replies to the chrome over a Tauri
//! channel.

// Tauri commands receive their arguments by value; that is the IPC contract.
#![allow(clippy::needless_pass_by_value)]

use std::collections::HashMap;
use std::fmt::Write as _;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use dive_agent::{
    Client, Delta, Effort, ModelInfo, Provider, ProviderInfo, Request, Role, Turn, Usage,
};
use dive_core::TabId;
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use serde_json::json;
use specta::Type;
use std::sync::Mutex;
use tauri::State;
use tauri::ipc::Channel;
use tracing::Instrument as _;

use crate::error::{AppError, AppResult};
use crate::state::{AppState, lock};

mod prompt;
mod run;
mod threads;

pub use threads::prune_threads;

use prompt::rejection_text;
use run::drive;
use threads::fit_thread;

const KEYCHAIN_SERVICE: &str = "app.dive.browser";
/// The single key entry from before providers existed. Moved under the
/// Anthropic provider the first time it is read, so an upgrade keeps working.
const LEGACY_KEYCHAIN_USER: &str = "anthropic-api-key";
/// How long a provider's model listing is reused before it is fetched again.
const MODELS_TTL: Duration = Duration::from_mins(10);
/// How long an action waits for the user before it is treated as denied.
const APPROVAL_TIMEOUT: Duration = Duration::from_secs(120);
/// A silent provider stream should not leave the UI spinning forever.
const STREAM_IDLE_TIMEOUT: Duration = Duration::from_secs(120);
const RUN_ID_CAP: usize = 128;
const TURN_CAP: usize = 200;
const TURN_TEXT_CAP: usize = 256 * 1024;
const TRANSCRIPT_CAP: usize = 2 * 1024 * 1024;
const API_KEY_CAP: usize = 16 * 1024;

fn entry(provider: Provider) -> AppResult<keyring_core::Entry> {
    crate::secrets::entry(KEYCHAIN_SERVICE, &format!("key:{}", provider.id_str()))
}

fn parse_provider(id: &str) -> AppResult<Provider> {
    Provider::parse(id).ok_or_else(|| AppError::new(format!("unknown provider {id:?}")))
}

/// The stored key for `provider`, if any. Empty keys count as absent.
fn read_key(provider: Provider) -> Option<String> {
    let current = entry(provider)
        .ok()?
        .get_password()
        .ok()
        .filter(|k| !k.trim().is_empty());
    if current.is_some() || provider != Provider::Anthropic {
        return current;
    }
    let legacy = keyring_core::Entry::new(KEYCHAIN_SERVICE, LEGACY_KEYCHAIN_USER).ok()?;
    let key = legacy
        .get_password()
        .ok()
        .filter(|k| !k.trim().is_empty())?;
    if entry(provider).ok()?.set_password(&key).is_ok() {
        let _ = legacy.delete_credential();
    }
    Some(key)
}

/// A client for `provider` with the stored key, or `key` when given.
fn client_for(state: &AppState, provider: Provider, key: Option<String>) -> Client {
    let key = key
        .filter(|k| !k.trim().is_empty())
        .or_else(|| read_key(provider))
        .unwrap_or_default();
    let prefs = state.prefs.get(state);
    let base = (provider == Provider::Custom).then_some(prefs.agent_custom_base_url.clone());
    // Through the proxy in Settings, like everything else Dive sends; a proxy
    // this client cannot use fails the request rather than going around it.
    let http = crate::http_client::builder(&prefs.network());
    Client::with_http(provider, key.trim(), base.as_deref(), http)
}

// ----- state the commands share -----

/// A run in flight. The chrome stops one by id; the loop checks the flag at
/// every boundary and wakes from any await through the notifier.
#[derive(Default)]
pub struct Run {
    /// The chrome's id for this run; namespaces every step id it sees.
    id: String,
    cancelled: AtomicBool,
    notify: tokio::sync::Notify,
    /// The tabs this run may open, and where they go.
    pub scope: Scope,
    /// The fence page content is wrapped in for this run. New every run, and
    /// never sent anywhere a page could read it.
    tag: String,
    /// Sites this run has read private data from -- cookies, a response
    /// body, the console -- oldest first. Once there is one, carrying text to
    /// any other site is put to the person in every mode (see
    /// [`crate::agent_risk`]).
    tainted: Mutex<Vec<String>>,
    /// Sites whose pages this run has read in the person's own tabs. The
    /// softer mark: carrying text to another site afterwards asks in the
    /// default mode only.
    seen: Mutex<Vec<String>>,
}

impl Run {
    fn new(id: &str) -> Self {
        Self {
            id: id.to_owned(),
            tag: crate::agent_guard::tag(),
            ..Self::default()
        }
    }

    /// The id a tool call is known by in the chrome and in the approval
    /// table: `run id` and `call id` together. Provider-issued call ids are
    /// only unique within one reply, so two runs (or one retried reply) can
    /// carry the same one; keyed by call id alone, an answer for one run's
    /// step could resolve another's.
    fn step_id(&self, call_id: &str) -> String {
        format!("{}:{call_id}", self.id)
    }

    /// Remember that this run now holds private data of `site`.
    fn taint(&self, site: String) {
        let mut tainted = lock(&self.tainted);
        if !tainted.contains(&site) {
            tainted.push(site);
        }
    }

    /// Sites this run holds private data of.
    fn tainted(&self) -> Vec<String> {
        lock(&self.tainted).clone()
    }

    /// Remember that this run has read a page of `site` in the person's tabs.
    fn saw(&self, site: String) {
        let mut seen = lock(&self.seen);
        if !seen.contains(&site) {
            seen.push(site);
        }
    }

    /// Sites whose pages this run has read in the person's tabs.
    fn seen(&self) -> Vec<String> {
        lock(&self.seen).clone()
    }

    fn cancel(&self) {
        self.cancelled.store(true, Ordering::SeqCst);
        self.notify.notify_waiters();
    }

    fn is_cancelled(&self) -> bool {
        self.cancelled.load(Ordering::SeqCst)
    }

    /// Resolves once the run has been stopped, however long ago that was.
    ///
    /// Every await that could outlast a Stop races this: the model stream,
    /// the approval wait, the backoff, a tool that is driving the page and the
    /// first read of it. A single stored permit used to serve all of them,
    /// so whichever waited first took it and a tool running after that never
    /// heard the Stop at all. The flag is checked after the waiter is
    /// registered, so a cancel that lands between the two is not missed.
    async fn halted(&self) {
        loop {
            let notified = self.notify.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            if self.is_cancelled() {
                return;
            }
            notified.await;
        }
    }
}

/// How many tabs of its own one run may open.
///
/// Enough for the thing a single tab cannot do -- compare two pages, follow a
/// result while keeping the list, sign in beside the work -- and not enough to
/// bury the person in tabs while they are looking somewhere else.
pub const MAX_OPENED_TABS: usize = 4;

/// The tabs a run may open and where they go.
///
/// A run used to be confined to the tab the person was in, because an agent
/// that can open tabs can open twenty. A budget answers that better than a
/// prohibition: research is genuinely several pages at once, and comparing
/// two of them in one tab means losing the first.
///
/// When the run has a context of its own, every tab it opens goes there --
/// a separate session with none of the person's cookies, which is the safe
/// way to let an agent loose on a site it has no business being signed in to.
#[derive(Debug, Default)]
pub struct Scope {
    /// The context tabs go into, when the run made one.
    context: Mutex<Option<String>>,
    /// Tabs this run opened, oldest first.
    opened: Mutex<Vec<TabId>>,
    /// Tabs a tool of this run has acted on or read. Only these are kept
    /// awake for the run: protecting every tab while any run was going kept
    /// a hundred idle tabs alive for an agent working in one.
    touched: Mutex<std::collections::HashSet<TabId>>,
}

impl Scope {
    /// Put every tab this run opens into `context`.
    pub fn use_context(&self, context: String) {
        *lock(&self.context) = Some(context);
    }

    /// The context, if the run has one of its own.
    pub fn context(&self) -> Option<String> {
        lock(&self.context).clone()
    }

    /// Tabs this run opened.
    pub fn opened(&self) -> Vec<TabId> {
        lock(&self.opened).clone()
    }

    /// Whether the run may act on `tab`.
    ///
    /// A clean run works signed out of everything, and that promise is only
    /// as good as the tabs it can reach: a tab id from the person's own
    /// session -- in the page context, in a result, guessed -- would put the
    /// run back inside it. So a run with a context of its own may use the
    /// tabs it opened and nothing else.
    pub fn admits(&self, tab: TabId) -> Result<(), String> {
        if self.context().is_none() || lock(&self.opened).contains(&tab) {
            return Ok(());
        }
        Err(
            "this run is in a clean session and may only use the tabs it opened with tab_open"
                .into(),
        )
    }

    /// Note that a tool of this run is working on `tab`.
    pub fn touch(&self, tab: TabId) {
        lock(&self.touched).insert(tab);
    }

    /// Whether this run has worked on `tab`, or opened it.
    pub fn touches(&self, tab: TabId) -> bool {
        lock(&self.touched).contains(&tab) || lock(&self.opened).contains(&tab)
    }

    /// Whether there is room for another tab.
    ///
    /// The refusal names the budget rather than failing vaguely, so a model
    /// that wanted a fifth tab is told to reuse one instead of retrying.
    fn reserve(&self) -> Result<(), String> {
        if lock(&self.opened).len() >= MAX_OPENED_TABS {
            return Err(format!(
                "this run has already opened its {MAX_OPENED_TABS} tabs. Navigate one of them with tab_navigate instead of opening another."
            ));
        }
        Ok(())
    }

    /// Count a tab this run opened.
    fn record(&self, tab: TabId) {
        lock(&self.opened).push(tab);
    }

    /// Open a tab for the run, inside its context and within its budget.
    pub async fn open<B: dive_mcp::Browser>(
        &self,
        browser: &B,
        url: String,
    ) -> Result<dive_mcp::TabInfo, String> {
        self.reserve()?;
        let tab = browser
            .open_tab_in(self.context(), url)
            .await
            .map_err(|e| e.to_string())?;
        if let Ok(id) = tab.id.parse::<TabId>() {
            self.record(id);
        }
        Ok(tab)
    }
}

/// Runs by id.
pub type Runs = Mutex<HashMap<String, Arc<Run>>>;
/// Model listings by provider, with when they were fetched.
pub type ModelCache = Mutex<HashMap<Provider, (Instant, Vec<ModelInfo>)>>;

// ----- wire types -----

/// One message in the conversation, as the chrome stores it.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct ChatTurn {
    /// `user` or `assistant`.
    pub role: String,
    /// Text.
    pub content: String,
}

/// A tool call, as shown in the thread.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct ToolStep {
    /// Step id: the run id and the provider's call id, joined by a colon,
    /// so it is unique across runs (see `agent_approve`).
    pub id: String,
    /// Tool name.
    pub name: String,
    /// Input as JSON text.
    pub input: String,
    /// Whether the tool changes the page.
    pub action: bool,
    /// Playwright-style locator for the target, when the tool used a ref;
    /// otherwise what the host found at its coordinate or with focus, when
    /// it looked.
    pub locator: Option<String>,
    /// Why this step is being shown before it runs, when it is. `None` for a
    /// step that was allowed to run on its own.
    pub caution: Option<String>,
    /// Asked whatever the approval setting, "allow all this session"
    /// included, so the chrome does not offer to skip the question next time.
    pub always: bool,
}

/// A streamed piece of the reply.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(tag = "type", content = "data", rename_all = "snake_case")]
pub enum ChatDelta {
    /// More text.
    Text(String),
    /// More of the model's reasoning.
    Reasoning(String),
    /// The agent is calling a tool.
    ToolCall(ToolStep),
    /// An action needs the user's approval before it runs (answer with `agent_approve`).
    NeedsApproval(ToolStep),
    /// A tool finished: id, short summary, error flag.
    ToolDone {
        /// Call id.
        id: String,
        /// First line of the result.
        summary: String,
        /// Failed.
        error: bool,
    },
    /// Running token totals for this reply.
    Usage(Usage),
    /// A page tried to give the agent instructions. The text is for the
    /// person: what it tried, and the line it tried it on.
    Flagged(String),
    /// What the run is doing that is not part of the reply -- waiting out a
    /// busy provider, leaving out the oldest turns. Shown while it is true and
    /// never kept as text, so it cannot end up in the transcript the model is
    /// sent next time.
    Status(String),
    /// Finished with a stop reason (`end_turn`, `max_tokens`, `refusal`, `stopped`).
    Done(String),
    /// Failed.
    Error {
        /// What went wrong, for the person.
        message: String,
        /// Which kind of failure, so the chrome offers the fix that fits.
        kind: FailureKind,
    },
}

/// Why a run failed, as far as what the person can do about it goes.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum FailureKind {
    /// The key is missing or the provider refused it: Settings can fix it.
    Auth,
    /// The model or endpoint is wrong for this provider: pick another.
    Model,
    /// Anything else. Asking again is the likely remedy.
    Other,
}

impl FailureKind {
    /// Sort a provider failure by what would fix it.
    fn of(error: &dive_agent::AgentError) -> Self {
        match error {
            dive_agent::AgentError::MissingKey => Self::Auth,
            dive_agent::AgentError::MissingBaseUrl | dive_agent::AgentError::Config(_) => {
                Self::Model
            }
            e if e.is_unauthorized() => Self::Auth,
            dive_agent::AgentError::Api { status: 404, .. } => Self::Model,
            dive_agent::AgentError::Api {
                status: 400,
                message,
                ..
            } if message.to_ascii_lowercase().contains("model") => Self::Model,
            _ => Self::Other,
        }
    }
}

/// Tell the chrome the run failed.
fn fail(on_delta: &Channel<ChatDelta>, message: impl Into<String>, kind: FailureKind) {
    let _ = on_delta.send(ChatDelta::Error {
        message: message.into(),
        kind,
    });
}

/// When the run stops to ask before acting.
///
/// The middle setting is the default and the point of the three: a run that
/// asks about every scroll teaches the person to answer without looking, and
/// the way out they take is `Never`, which removes the check for the steps
/// that actually needed one. See [`crate::agent_risk`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Approvals {
    /// Every action is shown first.
    Every,
    /// Only the steps that look costly (see [`crate::agent_risk::caution`]).
    Risk,
    /// Nothing is shown; the run acts freely.
    Never,
}

impl Approvals {
    /// The mode named by a pref, falling back to the safe middle.
    pub fn parse(s: &str) -> Self {
        match s {
            "every" => Self::Every,
            "never" => Self::Never,
            _ => Self::Risk,
        }
    }

    /// Whether this step is put to the person before it runs.
    ///
    /// A step that always asks does so here too: "never" and "allow all this
    /// session" answer for clicking and typing, not for handing over a file,
    /// a session or a server's reply (see [`crate::agent_risk::Caution`]).
    pub fn asks_about(self, step: &ToolStep) -> bool {
        if step.always {
            return true;
        }
        match self {
            Self::Every => step.action,
            Self::Risk => step.caution.is_some(),
            Self::Never => false,
        }
    }
}

/// Per-message switches from the chrome.
#[derive(Debug, Clone, Default, Serialize, Deserialize, Type)]
pub struct SendOptions {
    /// Attach the current tab's title, URL, console, failed requests and text.
    pub include_page: bool,
    /// Run actions without asking, for this message only.
    pub auto_approve: bool,
    /// Work in a context of the run's own -- no cookies, nobody signed in,
    /// and the person's tab left alone -- thrown away when the run ends.
    pub clean_session: bool,
}

/// Outcome of trying a key against its provider.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct KeyCheck {
    /// The provider accepted it.
    pub ok: bool,
    /// The key is known to be unusable: the provider refused it (401 or
    /// 403), or there was nothing to try. Anything else that stops a check
    /// -- the provider down, no network, a proxy in the way -- says nothing
    /// about the key, and the chrome saves it anyway rather than making a
    /// working key impossible to enter while offline.
    #[serde(default)]
    pub rejected: bool,
    /// What happened, for the person.
    pub message: String,
}

// ----- keys and providers -----

/// The provider catalog, for the chrome's pickers.
#[tauri::command]
#[specta::specta]
pub(crate) fn agent_providers() -> Vec<ProviderInfo> {
    dive_agent::catalog()
}

/// Providers that have a key stored. Local servers need none and are not
/// listed; the chrome treats them as ready.
#[tauri::command]
#[specta::specta]
pub(crate) fn agent_keys() -> Vec<Provider> {
    Provider::ALL
        .into_iter()
        .filter(|p| p.info().needs_key && read_key(*p).is_some())
        .collect()
}

/// Store a provider's API key in the keychain. Empty removes it.
#[tauri::command]
#[specta::specta]
pub(crate) fn agent_key_set(provider: String, key: String) -> AppResult<()> {
    if key.len() > API_KEY_CAP {
        return Err(AppError::new("API key is too long"));
    }
    let e = entry(parse_provider(&provider)?)?;
    if key.trim().is_empty() {
        return e.delete_credential().or_else(|err| match err {
            keyring_core::Error::NoEntry => Ok(()),
            other => Err(AppError::new(other)),
        });
    }
    e.set_password(key.trim()).map_err(AppError::new)
}

/// Whether a key is configured for `provider`.
#[tauri::command]
#[specta::specta]
pub(crate) fn agent_key_present(provider: String) -> AppResult<bool> {
    let provider = parse_provider(&provider)?;
    Ok(!provider.info().needs_key || read_key(provider).is_some())
}

/// Try `key` (or the stored one) against the provider with its cheapest
/// authenticated call, so a typo is caught before the first message.
#[tauri::command]
#[specta::specta]
pub(crate) async fn agent_key_verify(
    state: State<'_, AppState>,
    provider: String,
    key: Option<String>,
) -> AppResult<KeyCheck> {
    let provider = parse_provider(&provider)?;
    let client = client_for(&state, provider, key);
    Ok(match client.verify().await {
        Ok(()) => KeyCheck {
            ok: true,
            rejected: false,
            message: format!("{} accepted the key.", provider.info().name),
        },
        Err(e) if e.is_unauthorized() => KeyCheck {
            ok: false,
            rejected: true,
            message: rejection_text(&provider.info().name, &e),
        },
        Err(dive_agent::AgentError::MissingKey) => KeyCheck {
            ok: false,
            rejected: true,
            message: "Paste a key first.".into(),
        },
        Err(dive_agent::AgentError::MissingBaseUrl) => KeyCheck {
            ok: false,
            rejected: true,
            message: "Set the base URL of the custom endpoint first.".into(),
        },
        Err(e @ dive_agent::AgentError::Config(_)) => KeyCheck {
            ok: false,
            rejected: true,
            message: e.to_string(),
        },
        Err(e) => KeyCheck {
            ok: false,
            rejected: false,
            message: format!("Could not reach {}: {e}", provider.info().name),
        },
    })
}

/// The models `provider` offers, cached for a while per provider.
#[tauri::command]
#[specta::specta]
pub(crate) async fn agent_models(
    state: State<'_, AppState>,
    provider: String,
    refresh: bool,
) -> AppResult<Vec<ModelInfo>> {
    let provider = parse_provider(&provider)?;
    if !refresh
        && let Some((at, models)) = lock(&state.agent_models).get(&provider)
        && at.elapsed() < MODELS_TTL
    {
        return Ok(models.clone());
    }
    let models = client_for(&state, provider, None)
        .models()
        .await
        .map_err(AppError::new)?;
    lock(&state.agent_models).insert(provider, (Instant::now(), models.clone()));
    Ok(models)
}

// ----- runs -----

/// Stop a run. The loop notices at its next await and reports `stopped`.
#[tauri::command]
#[specta::specta]
pub(crate) fn agent_stop(state: State<'_, AppState>, run_id: String) -> AppResult<()> {
    match lock(&state.agent_runs).get(&run_id) {
        Some(run) => {
            run.cancel();
            Ok(())
        }
        None => Err(AppError::new("no run with that id")),
    }
}

/// Resolve a pending action approval from the chrome.
#[tauri::command]
#[specta::specta]
pub(crate) fn agent_approve(state: State<'_, AppState>, id: String, allow: bool) -> AppResult<()> {
    match lock(&state.approvals).remove(&id) {
        Some(tx) => {
            let _ = tx.send(allow);
            Ok(())
        }
        None => Err(AppError::new("no pending approval with that id")),
    }
}

/// What came of asking the person about an action.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Approval {
    Allowed,
    Denied,
    /// Nobody answered within [`APPROVAL_TIMEOUT`]; the action was skipped.
    Unanswered,
}

/// Ask the chrome whether an action may run; page content can steer the
/// model, so the person decides before anything touches the page. A stopped
/// run counts as a denial.
async fn approved(
    state: &AppState,
    run: &Run,
    on_delta: &Channel<ChatDelta>,
    step: &ToolStep,
) -> Approval {
    let (tx, rx) = tokio::sync::oneshot::channel();
    lock(&state.approvals).insert(step.id.clone(), tx);
    if on_delta
        .send(ChatDelta::NeedsApproval(step.clone()))
        .is_err()
    {
        lock(&state.approvals).remove(&step.id);
        return Approval::Denied;
    }
    let decision = tokio::select! {
        () = run.halted() => Approval::Denied,
        answer = tokio::time::timeout(APPROVAL_TIMEOUT, rx) => match answer {
            Ok(Ok(true)) => Approval::Allowed,
            Ok(_) => Approval::Denied,
            Err(_) => Approval::Unanswered,
        },
    };
    lock(&state.approvals).remove(&step.id);
    decision
}

// ----- keeping a conversation -----

/// The conversation held in this tab, as the chrome last left it.
#[tauri::command]
#[specta::specta]
pub(crate) fn agent_thread_load(
    state: State<'_, AppState>,
    tab_id: TabId,
) -> AppResult<Option<dive_core::AgentThread>> {
    lock(&state.store)
        .agent_thread(tab_id)
        .map_err(AppError::new)
}

/// Keep this tab's conversation, so closing the panel or quitting the browser
/// is not the same as throwing it away.
///
/// A private session keeps nothing: that is what makes it private.
#[tauri::command]
#[specta::specta]
pub(crate) fn agent_thread_save(
    state: State<'_, AppState>,
    tab_id: TabId,
    title: String,
    messages: String,
) -> AppResult<()> {
    if crate::private_session::is_private() {
        return Ok(());
    }
    let messages = fit_thread(messages)?;
    let title: String = title.trim().chars().take(200).collect();
    lock(&state.store)
        .agent_thread_save(tab_id, &title, &messages)
        .map_err(AppError::new)
}

/// Forget this tab's conversation.
#[tauri::command]
#[specta::specta]
pub(crate) fn agent_thread_clear(state: State<'_, AppState>, tab_id: TabId) -> AppResult<bool> {
    lock(&state.store)
        .agent_thread_delete(tab_id)
        .map_err(AppError::new)
}

/// Send a conversation to the model; deltas stream back over `on_delta`.
/// Tool calls are executed here and fed back until the model stops, the
/// step budget runs out, or the chrome stops the run.
#[tauri::command]
#[specta::specta]
pub(crate) async fn agent_send(
    app: tauri::AppHandle<crate::Runtime>,
    state: State<'_, AppState>,
    run_id: String,
    turns: Vec<ChatTurn>,
    tab_id: Option<TabId>,
    options: SendOptions,
    on_delta: Channel<ChatDelta>,
) -> AppResult<()> {
    validate_run_id(&run_id)?;
    let fitted = fit_turns(turns)?;
    let run = Arc::new(Run::new(&run_id));
    {
        let mut runs = lock(&state.agent_runs);
        if runs.contains_key(&run_id) {
            return Err(AppError::new("a run with that id is already active"));
        }
        runs.insert(run_id.clone(), Arc::clone(&run));
    }
    // Hold the tab for as long as the run lasts, so a coding agent on the MCP
    // port cannot navigate out from under this one mid-step. The claim is the
    // host's to make and to give back: a model that forgets cannot strand a
    // tab, and a run that panics still releases on the way out.
    let browser = crate::mcp::AppBrowser::new(app.clone());
    // A clean run gets a context of its own before anything else happens, and
    // never touches the tab the person is in: the whole point is that the
    // agent works signed out of everything.
    let tab_id = if options.clean_session {
        match open_clean_context(&browser, &run).await {
            Ok(()) => None,
            Err(message) => {
                fail(&on_delta, message, FailureKind::Other);
                lock(&state.agent_runs).remove(&run_id);
                return Ok(());
            }
        }
    } else {
        tab_id
    };
    // The tab the run starts on is the one it works in; it stays awake.
    if let Some(tab) = tab_id {
        run.scope.touch(tab);
    }
    let mut claimed = None;
    if let Some(tab) = tab_id {
        let result = dive_mcp::lease::shared().claim(
            tab,
            dive_mcp::lease::DIVE_AGENT,
            dive_mcp::lease::MAX_TTL,
            std::time::Instant::now(),
        );
        match result {
            Ok(_) => claimed = Some(tab),
            Err(conflict) => {
                // Another agent has this tab. Starting anyway would have both
                // of them driving it, so stop here and say who has it.
                fail(
                    &on_delta,
                    format!(
                        "Another agent ({}) is working in this tab for the next {}s. Wait for it, or start this in another tab.",
                        conflict.holder, conflict.seconds_left
                    ),
                    FailureKind::Other,
                );
                if let Some(context) = run.scope.context() {
                    use dive_mcp::Browser as _;
                    let _ = browser
                        .context_close(dive_mcp::ContextCloseParams {
                            context_id: Some(context),
                        })
                        .await;
                }
                lock(&state.agent_runs).remove(&run_id);
                return Ok(());
            }
        }
    }
    // Everything the run logs, including each step's span and the MCP and CDP
    // lines under it, carries the run id. The provider is filled in by `drive`
    // once the preferences are read.
    let span = tracing::info_span!("agent.run", run = %run_id, provider = tracing::field::Empty);
    let outcome = drive(&browser, &state, &run, fitted, tab_id, options, &on_delta)
        .instrument(span)
        .await;
    if let Some(tab) = claimed {
        dive_mcp::lease::shared().release(tab, dive_mcp::lease::DIVE_AGENT);
    }
    // The run's own context goes when the run does, tabs and cookies with it.
    // Left behind it would be an unexplained workspace in the rail holding a
    // session nobody asked to keep.
    if let Some(context) = run.scope.context() {
        use dive_mcp::Browser as _;
        let closed = browser
            .context_close(dive_mcp::ContextCloseParams {
                context_id: Some(context),
            })
            .await;
        if let Err(error) = closed {
            tracing::warn!(%error, "clean-session context outlived its run");
        }
    }
    lock(&state.agent_runs).remove(&run_id);
    outcome
}

/// Give the run a context of its own, or say why it could not have one.
async fn open_clean_context(browser: &crate::mcp::AppBrowser, run: &Run) -> Result<(), String> {
    use dive_mcp::Browser as _;
    let opened = browser
        .context_open(dive_mcp::ContextOpenParams {
            name: Some("Agent (clean session)".into()),
            isolated: Some(true),
        })
        .await
        .map_err(|e| format!("Could not open a clean session: {e}"))?;
    let id = opened["context_id"]
        .as_str()
        .ok_or("Could not open a clean session: the browser returned no context.")?;
    run.scope.use_context(id.to_owned());
    Ok(())
}

fn validate_run_id(run_id: &str) -> AppResult<()> {
    if run_id.is_empty() || run_id.len() > RUN_ID_CAP {
        return Err(AppError::new("run id must be 1 to 128 bytes"));
    }
    Ok(())
}

/// A conversation as it will be sent, and whether older turns were left out
/// to get it there.
struct Fitted {
    turns: Vec<ChatTurn>,
    trimmed: bool,
}

/// Fit the chrome's conversation into what one request may carry.
///
/// A long conversation used to hit a wall: past [`TURN_CAP`] turns or
/// [`TRANSCRIPT_CAP`] bytes every send was refused, and the only way on was
/// to throw the whole thing away. The newest turns are the ones that matter to
/// the next reply, so the oldest are left out instead. Only the message being
/// sent now can make the send fail, by being too long on its own.
///
/// It is also made well-formed for the wire. A reply that was stopped before
/// it said anything is an assistant turn with no text, which Anthropic
/// refuses outright; blank turns are dropped, turns by the same speaker that
/// end up next to each other are joined, and the conversation starts with the
/// person, as every provider expects.
fn fit_turns(turns: Vec<ChatTurn>) -> AppResult<Fitted> {
    if turns
        .iter()
        .any(|t| !matches!(t.role.as_str(), "user" | "assistant"))
    {
        return Err(AppError::new("conversation role must be user or assistant"));
    }
    let Some(newest) = turns.last() else {
        return Err(AppError::new("there is nothing to send"));
    };
    if newest.content.len() > TURN_TEXT_CAP {
        return Err(AppError::new(format!(
            "the message is over the {TURN_TEXT_CAP} byte limit"
        )));
    }
    let offered = turns.len();
    let mut trimmed = false;
    let mut kept: Vec<ChatTurn> = Vec::new();
    let mut total = 0usize;
    for mut turn in turns.into_iter().rev() {
        if kept.len() == TURN_CAP {
            break;
        }
        if turn.content.len() > TURN_TEXT_CAP {
            let mut cut = TURN_TEXT_CAP;
            while !turn.content.is_char_boundary(cut) {
                cut -= 1;
            }
            turn.content.truncate(cut);
            trimmed = true;
        }
        if total + turn.content.len() > TRANSCRIPT_CAP {
            break;
        }
        total += turn.content.len();
        kept.push(turn);
    }
    trimmed |= kept.len() < offered;
    kept.reverse();
    let last = kept.len() - 1;
    let mut turns: Vec<ChatTurn> = Vec::with_capacity(kept.len());
    for (i, turn) in kept.into_iter().enumerate() {
        if i != last && turn.content.trim().is_empty() {
            continue;
        }
        match turns.last_mut() {
            Some(previous) if previous.role == turn.role => {
                previous.content.push_str("\n\n");
                previous.content.push_str(&turn.content);
            }
            None if turn.role == "assistant" => {}
            _ => turns.push(turn),
        }
    }
    if turns.is_empty() {
        return Err(AppError::new("there is nothing to send"));
    }
    Ok(Fitted { turns, trimmed })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn disposable_keychain_never_initializes_native_store() {
        crate::secrets::test_keychain::with_mock_keychain(disposable_keychain_body);
    }

    fn disposable_keychain_body() {
        crate::secrets::init_with(true, || panic!("test must not initialize native keychain"));
        let store = keyring_core::get_default_store().expect("mock store");
        assert!(store.as_any().is::<keyring_core::mock::Store>());
        assert!(agent_keys().is_empty());
        agent_key_set("anthropic".into(), "disposable-fixture-key".into()).unwrap();
        assert_eq!(agent_keys(), vec![Provider::Anthropic]);
        assert!(agent_key_present("anthropic".into()).unwrap());
        agent_key_set("anthropic".into(), String::new()).unwrap();
        assert!(!agent_key_present("anthropic".into()).unwrap());
        crate::secrets::init_with(true, || panic!("restart must remain isolated"));
        assert!(agent_keys().is_empty());
    }

    #[test]
    fn a_cancelled_run_wakes_a_waiter_and_stays_cancelled() {
        let run = Run::default();
        assert!(!run.is_cancelled());
        run.cancel();
        assert!(run.is_cancelled());
        // A waiter that arrives after the cancel still wakes, and so does
        // every one after it: the stream, the approval and the tool each
        // wait on the same Stop.
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_time()
            .build()
            .unwrap();
        rt.block_on(async {
            for _ in 0..3 {
                tokio::time::timeout(Duration::from_millis(50), run.halted())
                    .await
                    .expect("cancel must wake a later waiter");
            }
        });
    }

    #[test]
    fn a_stop_reaches_a_waiter_that_is_already_waiting() {
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_time()
            .build()
            .unwrap();
        rt.block_on(async {
            let run = Arc::new(Run::default());
            let waiting = Arc::clone(&run);
            let first = tokio::spawn(async move { waiting.halted().await });
            let waiting = Arc::clone(&run);
            let second = tokio::spawn(async move { waiting.halted().await });
            tokio::task::yield_now().await;
            run.cancel();
            tokio::time::timeout(Duration::from_millis(200), async {
                first.await.unwrap();
                second.await.unwrap();
            })
            .await
            .expect("every waiter hears the Stop");
        });
    }

    fn step(action: bool, caution: Option<&str>) -> ToolStep {
        ToolStep {
            id: "r:1".into(),
            name: "page_click".into(),
            input: "{}".into(),
            action,
            locator: None,
            caution: caution.map(str::to_owned),
            always: false,
        }
    }

    #[test]
    fn a_step_that_always_asks_is_asked_about_in_every_mode() {
        let upload = ToolStep {
            always: true,
            ..step(
                true,
                Some("this sends a file from your computer to the page"),
            )
        };
        let cookies = ToolStep {
            always: true,
            ..step(false, Some("this reads the site's cookies"))
        };
        for mode in [Approvals::Every, Approvals::Risk, Approvals::Never] {
            assert!(mode.asks_about(&upload), "{mode:?} waved an upload through");
            assert!(
                mode.asks_about(&cookies),
                "{mode:?} waved a cookie read through"
            );
        }
    }

    #[test]
    fn a_clean_run_reaches_only_the_tabs_it_opened() {
        let person = TabId::new();
        let scope = Scope::default();
        // Without a context of its own the run works in the person's tabs.
        assert!(scope.admits(person).is_ok());
        scope.use_context("workspace-7".into());
        let refused = scope.admits(person).unwrap_err();
        assert!(refused.contains("clean session"), "{refused}");
        let own = TabId::new();
        scope.record(own);
        assert!(scope.admits(own).is_ok());
    }

    #[test]
    fn a_run_remembers_each_site_it_read_private_data_from_once() {
        let run = Run::new("r");
        assert!(run.tainted().is_empty());
        run.taint("mail.example".into());
        run.taint("bank.example".into());
        run.taint("mail.example".into());
        assert_eq!(run.tainted(), ["mail.example", "bank.example"]);
    }

    #[test]
    fn a_run_remembers_each_page_it_read_once() {
        let run = Run::new("r");
        assert!(run.seen().is_empty());
        run.saw("mail.example".into());
        run.saw("docs.example.org".into());
        run.saw("mail.example".into());
        assert_eq!(run.seen(), ["mail.example", "docs.example.org"]);
        // The firm mark is a separate list.
        assert!(run.tainted().is_empty());
    }

    #[test]
    fn each_mode_asks_about_what_it_says_it_does() {
        let costly = step(true, Some("this cannot be undone"));
        let ordinary = step(true, None);
        let reading = step(false, None);

        // The default asks about the costly step and lets the rest run,
        // which is the whole reason it is not "every".
        assert!(Approvals::Risk.asks_about(&costly));
        assert!(!Approvals::Risk.asks_about(&ordinary));
        assert!(!Approvals::Risk.asks_about(&reading));

        assert!(Approvals::Every.asks_about(&costly));
        assert!(Approvals::Every.asks_about(&ordinary));
        assert!(
            !Approvals::Every.asks_about(&reading),
            "reading is not an action"
        );

        assert!(!Approvals::Never.asks_about(&costly));
    }

    #[test]
    fn an_unknown_approval_setting_falls_back_to_asking_about_the_costly() {
        assert_eq!(Approvals::parse("risk"), Approvals::Risk);
        assert_eq!(Approvals::parse("every"), Approvals::Every);
        assert_eq!(Approvals::parse("never"), Approvals::Never);
        assert_eq!(Approvals::parse(""), Approvals::Risk);
        assert_eq!(Approvals::parse("off"), Approvals::Risk);
    }

    #[test]
    fn a_run_may_open_a_few_tabs_and_then_is_told_to_reuse_them() {
        let scope = Scope::default();
        assert!(scope.context().is_none(), "no context unless one was made");
        for _ in 0..MAX_OPENED_TABS {
            scope.reserve().expect("within the budget");
            scope.record(TabId::new());
        }
        let refused = scope.reserve().unwrap_err();
        assert!(refused.contains("tab_navigate"), "{refused}");
        assert_eq!(scope.opened().len(), MAX_OPENED_TABS);
    }

    #[test]
    fn a_run_keeps_awake_only_the_tabs_it_worked_on_or_opened() {
        let scope = Scope::default();
        let (worked, opened, other) = (TabId::new(), TabId::new(), TabId::new());
        scope.touch(worked);
        scope.record(opened);
        assert!(scope.touches(worked));
        assert!(scope.touches(opened));
        assert!(
            !scope.touches(other),
            "an idle tab elsewhere may still sleep"
        );
    }

    #[test]
    fn a_clean_run_sends_its_tabs_to_its_own_context() {
        let scope = Scope::default();
        scope.use_context("workspace-7".into());
        assert_eq!(scope.context().as_deref(), Some("workspace-7"));
    }

    #[test]
    fn every_run_fences_page_content_with_a_tag_of_its_own() {
        let a = Run::new("r1");
        let b = Run::new("r2");
        assert_ne!(a.tag, b.tag);
        assert!(!a.tag.is_empty());
    }

    #[test]
    fn step_ids_are_namespaced_by_run() {
        let a = Run::new("run-a");
        let b = Run::new("run-b");
        assert_ne!(a.step_id("call_0"), b.step_id("call_0"));
        assert_eq!(a.step_id("call_0"), "run-a:call_0");
    }

    #[test]
    fn unknown_providers_are_refused() {
        assert!(parse_provider("openrouter").is_ok());
        assert!(parse_provider("skynet").is_err());
    }

    fn turn(role: &str, content: impl Into<String>) -> ChatTurn {
        ChatTurn {
            role: role.into(),
            content: content.into(),
        }
    }

    #[test]
    fn send_boundaries_reject_ambiguous_or_oversized_input() {
        assert!(validate_run_id("run-1").is_ok());
        assert!(validate_run_id("").is_err());
        assert!(validate_run_id(&"r".repeat(RUN_ID_CAP + 1)).is_err());
        assert!(fit_turns(vec![turn("user", "hello")]).is_ok());
        assert!(fit_turns(Vec::new()).is_err());
        assert!(fit_turns(vec![turn("system", "no")]).is_err());
        // Only the message being sent can be too long to send.
        assert!(fit_turns(vec![turn("user", "x".repeat(TURN_TEXT_CAP + 1))]).is_err());
    }

    #[test]
    fn a_stopped_reply_with_no_text_is_not_sent_back() {
        // Asking again after Stop: the stopped reply is an empty assistant
        // turn, which Anthropic refuses with a 400.
        let fitted = fit_turns(vec![
            turn("user", "first"),
            turn("assistant", ""),
            turn("user", "again"),
        ])
        .unwrap();
        assert!(!fitted.trimmed);
        assert_eq!(fitted.turns.len(), 1, "the two questions become one turn");
        assert_eq!(fitted.turns[0].role, "user");
        assert_eq!(fitted.turns[0].content, "first\n\nagain");
        let fitted = fit_turns(vec![
            turn("user", "a"),
            turn("assistant", "  \n"),
            turn("user", "b"),
            turn("assistant", "answer"),
            turn("user", "c"),
        ])
        .unwrap();
        let roles: Vec<_> = fitted.turns.iter().map(|t| t.role.as_str()).collect();
        assert_eq!(roles, ["user", "assistant", "user"]);
    }

    #[test]
    fn a_long_conversation_loses_its_oldest_turns_instead_of_failing() {
        let mut turns: Vec<ChatTurn> = (0..TURN_CAP + 10)
            .map(|i| {
                turn(
                    if i % 2 == 0 { "user" } else { "assistant" },
                    format!("turn {i}"),
                )
            })
            .collect();
        turns.push(turn("user", "newest"));
        let fitted = fit_turns(turns).unwrap();
        assert!(fitted.trimmed);
        assert!(fitted.turns.len() <= TURN_CAP);
        assert_eq!(fitted.turns.last().unwrap().content, "newest");
        assert_eq!(
            fitted.turns[0].role, "user",
            "it still opens with the person"
        );

        let big = "y".repeat(TURN_TEXT_CAP);
        let mut turns: Vec<ChatTurn> = (0..12)
            .map(|i| turn(if i % 2 == 0 { "user" } else { "assistant" }, big.clone()))
            .collect();
        turns.push(turn("user", "newest"));
        let fitted = fit_turns(turns).unwrap();
        assert!(fitted.trimmed);
        let bytes: usize = fitted.turns.iter().map(|t| t.content.len()).sum();
        assert!(bytes <= TRANSCRIPT_CAP + 4 * fitted.turns.len());
        assert!(fitted.turns.last().unwrap().content.ends_with("newest"));
    }

    #[test]
    fn failures_are_sorted_by_what_would_fix_them() {
        let api = |status, message: &str| dive_agent::AgentError::Api {
            status,
            message: message.into(),
            retry_after: None,
        };
        assert_eq!(
            FailureKind::of(&dive_agent::AgentError::MissingKey),
            FailureKind::Auth
        );
        assert_eq!(FailureKind::of(&api(401, "bad key")), FailureKind::Auth);
        assert_eq!(
            FailureKind::of(&api(404, "no such model")),
            FailureKind::Model
        );
        assert_eq!(
            FailureKind::of(&api(400, "model: not found")),
            FailureKind::Model
        );
        assert_eq!(
            FailureKind::of(&api(400, "messages: empty content")),
            FailureKind::Other
        );
        assert_eq!(FailureKind::of(&api(529, "overloaded")), FailureKind::Other);
        assert_eq!(
            FailureKind::of(&dive_agent::AgentError::Config("invalid base URL".into())),
            FailureKind::Model
        );
        assert_eq!(
            FailureKind::of(&dive_agent::AgentError::Unanswered("timed out".into())),
            FailureKind::Other
        );
    }
}
