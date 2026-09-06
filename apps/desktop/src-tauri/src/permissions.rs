//! Native permission callbacks, scoped decisions, and trusted chrome prompts.
//! No Browser.setPermission overrides or renderer-reported permission identity.

#[path = "permission_policy.rs"]
mod policy;
pub use policy::Scope;
pub use requests::Registry;
#[path = "permission_requests.rs"]
mod requests;

use dive_cdp::CdpSession;
use dive_core::TabId;
use serde::{Deserialize, Serialize};
use specta::Type;
use tauri::Manager;
use tauri::webview::{PermissionKind, PermissionResponse};
use tauri_specta::Event;

use crate::Runtime;
use crate::state::{AppState, lock};

const KINDS: &[&str] = &[
    "camera",
    "microphone",
    "geolocation",
    "notifications",
    "clipboard_read",
    "display_capture",
];

/// What the person decided for one origin and kind.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum Decision {
    /// Granted.
    Allow,
    /// Refused.
    Deny,
    /// Not decided; the original native request waits for the chrome.
    Ask,
}

impl Decision {
    fn parse(s: &str) -> Self {
        match s {
            "allow" => Self::Allow,
            "deny" => Self::Deny,
            _ => Self::Ask,
        }
    }

    fn as_str(self) -> &'static str {
        match self {
            Self::Allow => "allow",
            Self::Deny => "deny",
            Self::Ask => "ask",
        }
    }
}

/// A remembered decision, for the settings UI.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
pub struct SitePermission {
    /// Scheme and host the decision applies to.
    pub origin: String,
    /// `camera`, `microphone`, `geolocation`, `notifications`,
    /// `clipboard_read` or `display_capture`.
    pub kind: String,
    /// The decision.
    pub decision: Decision,
    pub scope: policy::Scope,
}

/// A page asked for something no decision covers yet.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type, Event)]
pub struct PermissionAsked {
    pub page_lifetime: bool,
    pub request_id: String,
    pub tab_id: TabId,
    pub origin: String,
    pub kinds: Vec<String>,
    pub scope: policy::Scope,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum Duration {
    Page,
    Remember,
}

/// A pending native request ended, including navigation, closure and timeout.
#[derive(Debug, Clone, Serialize, Deserialize, Type, Event)]
pub struct PermissionDismissed {
    pub request_id: String,
    pub tab_id: TabId,
}

/// Settings are scoped to the currently selected workspace's real CEF container.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct PermissionList {
    pub scope: Scope,
    pub profile_name: String,
    pub container_name: String,
    pub legacy_ignored: bool,
    pub permissions: Vec<SitePermission>,
}
fn active_scope(state: &AppState, store: &dive_core::Store) -> dive_core::Result<Scope> {
    let workspace = lock(&state.active_workspace)
        .ok_or_else(|| dive_core::CoreError::Invalid("No active permission scope".into()))?;
    Scope::for_workspace(store, workspace)
}
/// Persist only into the authoritative active scope; a stale settings panel cannot edit another profile.
pub fn set(
    app: &tauri::AppHandle<Runtime>,
    state: &AppState,
    expected: &Scope,
    origin: &str,
    kind: &str,
    choice: Decision,
) -> crate::error::AppResult<()> {
    let host = lock(&state.host);
    let store = lock(&state.store);
    let scope = active_scope(state, &store)?;
    if &scope != expected {
        return Err(crate::error::AppError::new(
            "Permission profile changed; reopen settings",
        ));
    }
    let origin = policy::canonical_origin(origin)?;
    if !KINDS.contains(&kind) {
        return Err(crate::error::AppError::new("Unknown permission kind"));
    }
    let (dismissed, reset) = state.permissions.revoke_and_reset(&scope, &origin, kind);
    let result = reset.map_err(crate::error::AppError::new).and_then(|()| {
        policy::write(&store, &scope, &origin, kind, choice).map_err(crate::error::AppError::new)
    });
    drop(store);
    drop(host);
    for (tab_id, request_id) in dismissed {
        let _ = PermissionDismissed { request_id, tab_id }.emit(app);
    }
    result
}
/// List only this scope; legacy unscoped records remain available for audit but never grant.
pub fn all(state: &AppState) -> dive_core::Result<PermissionList> {
    let store = lock(&state.store);
    let scope = active_scope(state, &store)?;
    Ok(PermissionList {
        profile_name: store.profile(scope.profile_id)?.name,
        container_name: store.container(scope.container_id)?.name,
        legacy_ignored: store
            .settings_with_prefix("perm:")?
            .iter()
            .any(|(key, _)| !key.starts_with("perm:v2:")),
        permissions: policy::all(&store, &scope)?,
        scope,
    })
}
/// Kind-only callbacks do not identify the requesting frame. Never grant from them.
pub fn decide(_webview: &tauri::Webview<Runtime>, _kind: PermissionKind) -> PermissionResponse {
    PermissionResponse::Deny
}

/// Permission commands have no renderer-supplied identity authority.
/// Must run on guarded UI because reading the native URL is synchronous.
pub fn require_chrome(view: &tauri::Webview<Runtime>) -> crate::error::AppResult<()> {
    let dev = if cfg!(debug_assertions) {
        view.app_handle().config().build.dev_url.as_ref()
    } else {
        None
    };
    if crate::ipc_security::trusted_chrome_label(view.label(), view.window().label())
        && crate::ipc_security::allowed_chrome_navigation(&view.url()?, dev)
    {
        Ok(())
    } else {
        Err(crate::error::AppError::new(
            "Permission controls require trusted browser chrome",
        ))
    }
}
/// Only the app's own chrome receives clipboard reads without a site prompt.
#[cfg(feature = "cef")]
pub fn attach_chrome(view: &tauri::Webview<Runtime>) -> tauri::Result<()> {
    let label = view.label().to_owned();
    let window = view.window().label().to_owned();
    let dev = if cfg!(debug_assertions) {
        view.app_handle().config().build.dev_url.clone()
    } else {
        None
    };
    view.with_webview(move |native| {
        native.set_permission_handler(
            move |request| {
                let allowed = crate::ipc_security::trusted_chrome_label(&label, &window)
                    && request.kinds == ["clipboard_read"]
                    && url::Url::parse(&request.top_level_url).is_ok_and(|url| {
                        crate::ipc_security::allowed_chrome_navigation(&url, dev.as_ref())
                            && url.origin().ascii_serialization() == request.origin
                    });
                request.respond(allowed.then_some(true));
            },
            |_| {},
            |_, _| {},
        );
    })
}

/// Called on the guarded native UI thread, with host -> store lock order.
pub fn reply(
    state: &AppState,
    tab: TabId,
    id: &str,
    choice: Decision,
    duration: Duration,
) -> crate::error::AppResult<()> {
    let answer = {
        let host = lock(&state.host);
        let host = host
            .as_ref()
            .ok_or_else(|| crate::error::AppError::new("Engine not ready"))?;
        let label = host.with_view(tab, |view| Ok(view.label().to_owned()))?;
        state
            .permissions
            .answer(&lock(&state.store), tab, &label, id, choice, duration)?
    };
    answer(Some(choice == Decision::Allow));
    Ok(())
}
#[cfg(feature = "cef")]
fn receive(app: &tauri::AppHandle<Runtime>, incoming: requests::Incoming) {
    let state = app.state::<AppState>();
    let admission = {
        let host = lock(&state.host);
        let current = host.as_ref().and_then(|host| {
            host.with_view(incoming.tab, |view| Ok(view.label().to_owned()))
                .ok()
        });
        if current.as_deref() != Some(&incoming.label) {
            (incoming.answer)(None);
            return;
        }
        state.permissions.admit(&lock(&state.store), incoming)
    };
    match admission {
        Ok(requests::Admission::Prompt(event)) => {
            let _ = event.emit(app);
        }
        Ok(requests::Admission::Complete(answer, allow)) => answer(allow),
        Err(error) => {
            tracing::warn!(%error,"invalid native permission request; native deadline will deny");
        }
    }
}
/// Install the per-webview callback before first navigation. Default-deny remains
/// enforced by the native adapter if setup fails or its deadline expires.
#[cfg(feature = "cef")]
pub async fn attach_page(
    app: tauri::AppHandle<Runtime>,
    tab_id: TabId,
    session: CdpSession,
    view: tauri::Webview<Runtime>,
    workspace: Option<dive_core::WorkspaceId>,
    container: dive_core::ContainerId,
) {
    let Some(workspace) = workspace else {
        return;
    };
    let mut events = session.subscribe();
    let label = view.label().to_owned();
    let (dismissed, scope) = {
        let state = app.state::<AppState>();
        let host = lock(&state.host);
        let store = lock(&state.store);
        let Some(current) = host.as_ref().and_then(|host| {
            host.with_view(tab_id, |view| Ok(view.label().to_owned()))
                .ok()
        }) else {
            return;
        };
        let Ok(scope) = Scope::for_view(&store, tab_id, workspace, container) else {
            return;
        };
        let Some(ids) = state.permissions.begin_current(
            tab_id,
            label.clone(),
            &current,
            scope.clone(),
            workspace,
        ) else {
            return;
        };
        (ids, scope)
    };
    dismiss(&app, tab_id, dismissed);
    let handler_app = app.clone();
    let handler_label = label.clone();
    let (tx, rx) = tokio::sync::oneshot::channel();
    // Every path answers, so a bridge that cannot be installed is reported
    // now rather than after the timeout runs out.
    let result = view.with_webview(move |native| {
        let _ = tx.send(install_page_callbacks(
            &native,
            &handler_app,
            tab_id,
            &handler_label,
            scope,
        ));
    });
    if result.is_err()
        || !matches!(
            tokio::time::timeout(std::time::Duration::from_secs(5), rx).await,
            Ok(Ok(true))
        )
    {
        tracing::warn!(%tab_id,"native permission bridge setup failed; requests remain denied");
    }
    tauri::async_runtime::spawn(async move {
        while next_permission_event(&mut events, tab_id).await.is_some() {}
        dismiss(
            &app,
            tab_id,
            app.state::<AppState>()
                .permissions
                .drop_session(tab_id, &label),
        );
    });
}
#[cfg(feature = "cef")]
fn install_page_callbacks(
    native: &tauri::webview::PlatformWebview<Runtime>,
    app: &tauri::AppHandle<Runtime>,
    tab_id: TabId,
    label: &str,
    scope: Scope,
) -> bool {
    let handler_app = app.clone();
    let cancel_app = app.clone();
    let navigation_app = app.clone();
    let handler_label = label.to_owned();
    let cancel_label = label.to_owned();
    let navigation_label = label.to_owned();
    let Some(context) = native.permission_context() else {
        return false;
    };
    handler_app
        .state::<AppState>()
        .permissions
        .register_context(
            scope,
            context.identity(),
            std::sync::Arc::new(move |request| match request {
                Some((origin, kind)) => context.reset(origin, kind),
                None => Ok(context.is_alive()),
            }),
        );
    native.set_permission_handler(
        move |request| {
            let live = request.clone();
            let answer = request.clone();
            let incoming = requests::Incoming {
                native_id: request.id,
                tab: tab_id,
                label: handler_label.clone(),
                origin: request.origin,
                kinds: request.kinds,
                frame: request.frame_id,
                page_lifetime: request.page_lifetime,
                deadline: request.deadline,
                live: Box::new(move || live.can_respond()),
                answer: Box::new(move |allow| answer.respond(allow)),
            };
            // CEF callbacks may execute outside Winit's dispatch guard. Defer
            // before entering a main task rather than blocking CEF on a getter.
            let app = handler_app.clone();
            tauri::async_runtime::spawn(async move {
                let handle = app.clone();
                let _ = app.run_on_main_thread(move || receive(&handle, incoming));
            });
        },
        move |native_id| {
            for request_id in
                cancel_app
                    .state::<AppState>()
                    .permissions
                    .cancel(tab_id, &cancel_label, native_id)
            {
                let _ = PermissionDismissed { request_id, tab_id }.emit(&cancel_app);
            }
        },
        move |frame, main| {
            navigation_app.state::<AppState>().permissions.navigating(
                tab_id,
                &navigation_label,
                frame.as_deref(),
                main,
            );
        },
    );
    true
}
fn dismiss(app: &tauri::AppHandle<Runtime>, tab_id: TabId, ids: Vec<String>) {
    for request_id in ids {
        let _ = PermissionDismissed { request_id, tab_id }.emit(app);
    }
}

/// Keep the permission service alive until the session itself ends.
async fn next_permission_event(
    events: &mut dive_cdp::CdpEventReceiver,
    tab_id: TabId,
) -> Option<dive_cdp::CdpEvent> {
    loop {
        match events.recv().await {
            Ok(event) => return Some(event),
            Err(tokio::sync::broadcast::error::RecvError::Lagged(n)) => {
                tracing::warn!(%tab_id, n, "permission monitor missed CDP events");
            }
            Err(tokio::sync::broadcast::error::RecvError::Closed) => return None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct NoopTransport;
    impl dive_cdp::Transport for NoopTransport {
        fn send(&self, _message: &str) -> Result<(), dive_cdp::CdpError> {
            Ok(())
        }
    }

    #[tokio::test]
    async fn permission_consumer_survives_event_overload() {
        let session = CdpSession::new(NoopTransport);
        let mut events = session.subscribe();
        for _ in 0..2048 {
            session
                .handle_incoming(r#"{"method":"Runtime.bindingCalled"}"#)
                .unwrap();
        }
        let event = next_permission_event(&mut events, TabId::new())
            .await
            .expect("permission handling must continue after a full CDP buffer");
        assert_eq!(event.method, "Runtime.bindingCalled");
    }

    #[tokio::test]
    async fn permission_consumer_exits_on_session_closure() {
        let session = CdpSession::new(NoopTransport);
        let mut events = session.subscribe();
        session.close();
        assert!(
            next_permission_event(&mut events, TabId::new())
                .await
                .is_none()
        );
    }

    #[test]
    fn decisions_round_trip_through_their_text_form() {
        for d in [Decision::Allow, Decision::Deny, Decision::Ask] {
            assert_eq!(Decision::parse(d.as_str()), d);
        }
        assert_eq!(Decision::parse("nonsense"), Decision::Ask);
    }
}
