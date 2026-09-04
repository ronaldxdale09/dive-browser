//! Pending native requests and page-lifetime decisions, independent of the UI.
use super::{
    Decision, Duration, PermissionAsked,
    policy::{self, Scope},
};
use crate::state::lock;
use dive_core::{Store, TabId};
use std::{collections::HashMap, sync::Mutex, time::Instant};

pub type Answer = Box<dyn FnOnce(Option<bool>) + Send>;
pub struct Incoming {
    pub native_id: u64,
    pub tab: TabId,
    pub label: String,
    pub origin: String,
    pub kinds: Vec<String>,
    pub frame: Option<String>,
    pub page_lifetime: bool,
    pub deadline: Instant,
    pub live: Box<dyn Fn() -> bool + Send>,
    pub answer: Answer,
}
struct Pending {
    request: Incoming,
}
#[derive(Hash, PartialEq, Eq)]
struct TemporaryKey {
    frame: Option<String>,
    origin: String,
    kind: String,
}
struct Session {
    label: String,
    scope: Scope,
    workspace: dive_core::WorkspaceId,
    temporary: HashMap<TemporaryKey, Decision>,
    pending: HashMap<String, Pending>,
}
type ResetContext =
    std::sync::Arc<dyn Fn(Option<(&str, &str)>) -> Result<bool, String> + Send + Sync>;
#[derive(Default)]
pub struct Registry {
    contexts: Mutex<Vec<(Scope, usize, ResetContext)>>,
    sessions: Mutex<HashMap<TabId, Session>>,
}
pub enum Admission {
    Prompt(PermissionAsked),
    Complete(Answer, Option<bool>),
}
impl Registry {
    pub fn has_session(&self, tab: TabId) -> bool {
        lock(&self.sessions).contains_key(&tab)
    }
    pub fn register_context(&self, scope: Scope, identity: usize, reset: ResetContext) {
        let mut contexts = lock(&self.contexts);
        contexts.retain(|(candidate, id, reset)| {
            (candidate != &scope || *id != identity) && reset(None).unwrap_or(true)
        });
        contexts.push((scope, identity, reset));
    }
    pub fn reset_contexts(&self, scope: &Scope, origin: &str, kind: &str) -> Result<(), String> {
        let contexts = lock(&self.contexts)
            .iter()
            .filter(|(candidate, _, _)| candidate == scope)
            .map(|(_, _, reset)| reset.clone())
            .collect::<Vec<_>>();
        for reset in contexts {
            if !reset(Some((origin, kind)))? {
                lock(&self.contexts)
                    .retain(|(_, _, candidate)| !std::sync::Arc::ptr_eq(candidate, &reset));
            }
        }
        Ok(())
    }

    pub fn revoke_and_reset(
        &self,
        scope: &Scope,
        origin: &str,
        kind: &str,
    ) -> (Vec<(TabId, String)>, Result<(), String>) {
        let dismissed = self.revoke(scope, origin, kind);
        let result = self.reset_contexts(scope, origin, kind);
        (dismissed, result)
    }
    pub fn revoke(&self, scope: &Scope, origin: &str, kind: &str) -> Vec<(TabId, String)> {
        let mut removed = Vec::new();
        {
            let mut sessions = lock(&self.sessions);
            for (tab, session) in sessions
                .iter_mut()
                .filter(|(_, session)| &session.scope == scope)
            {
                session
                    .temporary
                    .retain(|key, _| key.origin != origin || key.kind != kind);
                let ids = session
                    .pending
                    .iter()
                    .filter(|(_, pending)| {
                        pending.request.origin == origin
                            && pending
                                .request
                                .kinds
                                .iter()
                                .any(|candidate| candidate == kind)
                    })
                    .map(|(id, _)| id.clone())
                    .collect::<Vec<_>>();
                for id in ids {
                    if let Some(pending) = session.pending.remove(&id) {
                        removed.push((*tab, id, pending.request.answer));
                    }
                }
            }
        }
        removed
            .into_iter()
            .map(|(tab, id, answer)| {
                answer(None);
                (tab, id)
            })
            .collect()
    }

    pub fn begin_current(
        &self,
        tab: TabId,
        label: String,
        current: &str,
        scope: Scope,
        workspace: dive_core::WorkspaceId,
    ) -> Option<Vec<String>> {
        if current != label {
            return None;
        }
        Some(self.begin(tab, label, scope, workspace))
    }
    pub fn begin(
        &self,
        tab: TabId,
        label: String,
        scope: Scope,
        workspace: dive_core::WorkspaceId,
    ) -> Vec<String> {
        let old = lock(&self.sessions).insert(
            tab,
            Session {
                label,
                scope,
                workspace,
                temporary: HashMap::new(),
                pending: HashMap::new(),
            },
        );
        close_pending(old)
    }
    pub fn admit(&self, store: &Store, mut request: Incoming) -> dive_core::Result<Admission> {
        request.origin = policy::canonical_origin(&request.origin)?;
        let mut sessions = lock(&self.sessions);
        let Some(session) = sessions.get_mut(&request.tab) else {
            return Ok(Admission::Complete(request.answer, None));
        };
        if session.label != request.label
            || Scope::for_view(
                store,
                request.tab,
                session.workspace,
                session.scope.container_id,
            )? != session.scope
            || Instant::now() >= request.deadline
            || !(request.live)()
            || request.kinds.is_empty()
        {
            return Ok(Admission::Complete(request.answer, None));
        }
        let mut choices = Vec::new();
        for kind in &request.kinds {
            let key = TemporaryKey {
                frame: request.frame.clone(),
                origin: request.origin.clone(),
                kind: kind.clone(),
            };
            choices.push(session.temporary.get(&key).copied().unwrap_or(policy::read(
                store,
                &session.scope,
                &request.origin,
                kind,
            )?));
        }
        if choices.contains(&Decision::Deny) || !choices.contains(&Decision::Ask) {
            return Ok(Admission::Complete(
                request.answer,
                Some(choices.iter().all(|choice| *choice == Decision::Allow)),
            ));
        }
        let request_id = TabId::new().to_string();
        let event = PermissionAsked {
            request_id: request_id.clone(),
            tab_id: request.tab,
            origin: request.origin.clone(),
            kinds: request.kinds.clone(),
            scope: session.scope.clone(),
            page_lifetime: request.page_lifetime,
        };
        session.pending.insert(request_id, Pending { request });
        Ok(Admission::Prompt(event))
    }
    pub fn answer(
        &self,
        store: &Store,
        tab: TabId,
        label: &str,
        id: &str,
        choice: Decision,
        duration: Duration,
    ) -> dive_core::Result<Answer> {
        let mut sessions = lock(&self.sessions);
        let session = sessions.get_mut(&tab).ok_or_else(stale)?;
        let pending = session.pending.get(id).ok_or_else(stale)?;
        if session.label != label
            || Scope::for_view(store, tab, session.workspace, session.scope.container_id)?
                != session.scope
            || Instant::now() >= pending.request.deadline
            || !(pending.request.live)()
            || choice == Decision::Ask
        {
            return Err(stale());
        }
        if duration == Duration::Page && !pending.request.page_lifetime {
            return Err(dive_core::CoreError::Invalid(
                "This native permission supports remembered decisions only".into(),
            ));
        }
        if duration == Duration::Remember {
            policy::remember_group(
                store,
                &session.scope,
                &pending.request.origin,
                &pending.request.kinds,
                choice,
            )?;
        }
        let pending = session.pending.remove(id).unwrap();
        if duration == Duration::Page {
            for kind in &pending.request.kinds {
                session.temporary.insert(
                    TemporaryKey {
                        frame: pending.request.frame.clone(),
                        origin: pending.request.origin.clone(),
                        kind: kind.clone(),
                    },
                    choice,
                );
            }
        }
        Ok(pending.request.answer)
    }
    pub fn cancel(&self, tab: TabId, label: &str, native: u64) -> Vec<String> {
        let mut sessions = lock(&self.sessions);
        let Some(session) = sessions
            .get_mut(&tab)
            .filter(|session| session.label == label)
        else {
            return Vec::new();
        };
        let ids = session
            .pending
            .iter()
            .filter(|(_, pending)| pending.request.native_id == native)
            .map(|(id, _)| id.clone())
            .collect::<Vec<_>>();
        for id in &ids {
            session.pending.remove(id);
        }
        ids
    }
    pub fn navigating(&self, tab: TabId, label: &str, frame: Option<&str>, main: bool) {
        if let Some(session) = lock(&self.sessions)
            .get_mut(&tab)
            .filter(|session| session.label == label)
        {
            session
                .temporary
                .retain(|key, _| !main && key.frame.is_some() && key.frame.as_deref() != frame);
        }
    }
    pub fn drop_session(&self, tab: TabId, label: &str) -> Vec<String> {
        let old = {
            let mut sessions = lock(&self.sessions);
            if sessions
                .get(&tab)
                .is_some_and(|session| session.label == label)
            {
                sessions.remove(&tab)
            } else {
                None
            }
        };
        close_pending(old)
    }
}
fn close_pending(old: Option<Session>) -> Vec<String> {
    old.map_or_else(Vec::new, |old| {
        old.pending
            .into_iter()
            .map(|(id, pending)| {
                (pending.request.answer)(None);
                id
            })
            .collect()
    })
}
fn stale() -> dive_core::CoreError {
    dive_core::CoreError::Invalid("This permission request expired or its page changed".into())
}
#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    };
    #[test]
    fn settings_revoke_invalidates_pending_and_temporary_without_touching_other_origins() {
        let (store, tab, scope, registry) = fixture();
        let live = Arc::new(AtomicBool::new(true));
        let first = prompt(
            registry
                .admit(&store, incoming(tab, 1, live.clone()))
                .unwrap(),
        );
        registry
            .answer(
                &store,
                tab,
                "view-1",
                &first,
                Decision::Allow,
                Duration::Page,
            )
            .unwrap()(Some(true));
        let mut sibling = incoming(tab, 2, live.clone());
        sibling.origin = "https://sibling.test".into();
        let sibling = prompt(registry.admit(&store, sibling).unwrap());
        registry.revoke(&scope, "https://frame.test", "camera");
        let pending = prompt(
            registry
                .admit(&store, incoming(tab, 3, live.clone()))
                .unwrap(),
        );
        let dismissed = registry.revoke(&scope, "https://frame.test", "camera");
        assert_eq!(dismissed, vec![(tab, pending.clone())]);
        assert!(
            registry
                .answer(
                    &store,
                    tab,
                    "view-1",
                    &pending,
                    Decision::Allow,
                    Duration::Remember
                )
                .is_err()
        );
        assert!(
            registry
                .answer(
                    &store,
                    tab,
                    "view-1",
                    &sibling,
                    Decision::Deny,
                    Duration::Remember
                )
                .is_ok()
        );
    }
    #[test]
    fn settings_reset_reaches_surviving_native_context_after_last_session_closes() {
        let (_store, tab, scope, registry) = fixture();
        let calls = Arc::new(Mutex::new(Vec::new()));
        let observed = calls.clone();
        let alive = Arc::new(AtomicBool::new(true));
        let context_alive = alive.clone();
        registry.register_context(
            scope.clone(),
            1,
            Arc::new(move |request| {
                if !context_alive.load(Ordering::SeqCst) {
                    return Ok(false);
                }
                if let Some((origin, kind)) = request {
                    lock(&observed).push((origin.to_owned(), kind.to_owned()));
                }
                Ok(true)
            }),
        );
        let mut sibling = scope.clone();
        sibling.container_id = dive_core::ContainerId::new();
        registry.register_context(
            sibling,
            2,
            Arc::new(|request| {
                assert!(request.is_none(), "wrong context scope");
                Ok(true)
            }),
        );
        registry.drop_session(tab, "view-1");
        registry
            .reset_contexts(&scope, "https://frame.test", "camera")
            .unwrap();
        assert_eq!(
            *lock(&calls),
            vec![("https://frame.test".to_owned(), "camera".to_owned())]
        );
        alive.store(false, Ordering::SeqCst);
        registry
            .reset_contexts(&scope, "https://frame.test", "camera")
            .unwrap();
        assert_eq!(lock(&registry.contexts).len(), 1);
    }
    #[test]
    fn settings_final_readback_follows_native_dismissal_and_keeps_ids_on_failure() {
        let (store, tab, scope, registry) = fixture();
        let embargo = Arc::new(AtomicBool::new(false));
        let resets = embargo.clone();
        registry.register_context(
            scope.clone(),
            1,
            Arc::new(move |request| {
                if request.is_some() {
                    resets.store(false, Ordering::SeqCst);
                }
                Ok(true)
            }),
        );
        let mut request = incoming(tab, 1, Arc::new(AtomicBool::new(true)));
        let cancellation = embargo.clone();
        request.answer = Box::new(move |answer| {
            assert_eq!(answer, None);
            cancellation.store(true, Ordering::SeqCst);
        });
        let id = prompt(registry.admit(&store, request).unwrap());
        let (dismissed, result) = registry.revoke_and_reset(&scope, "https://frame.test", "camera");
        result.unwrap();
        assert_eq!(dismissed, vec![(tab, id)]);
        assert!(
            !embargo.load(Ordering::SeqCst),
            "DISMISS recreated embargo after the final reset"
        );
        registry.register_context(
            scope.clone(),
            1,
            Arc::new(|request| {
                if request.is_some() {
                    Err("native write failed".into())
                } else {
                    Ok(true)
                }
            }),
        );
        let id = prompt(
            registry
                .admit(&store, incoming(tab, 2, Arc::new(AtomicBool::new(true))))
                .unwrap(),
        );
        let (dismissed, result) = registry.revoke_and_reset(&scope, "https://frame.test", "camera");
        assert!(result.is_err());
        assert_eq!(dismissed, vec![(tab, id)]);
    }
    fn fixture() -> (Store, TabId, Scope, Registry) {
        let store = Store::in_memory().unwrap();
        let container = dive_core::Container::new("test");
        store.upsert_container(&container).unwrap();
        let profile = dive_core::Profile::new("test", container.id, 0);
        store.upsert_profile(&profile).unwrap();
        let workspace = dive_core::Workspace::new("test", container.id, profile.id, 0);
        store.upsert_workspace(&workspace).unwrap();
        let tab = dive_core::Tab::new(workspace.id, "https://top.test", 0);
        store.upsert_tab(&tab).unwrap();
        let scope = Scope::for_tab(&store, tab.id).unwrap();
        let registry = Registry::default();
        registry.begin(tab.id, "view-1".into(), scope.clone(), workspace.id);
        (store, tab.id, scope, registry)
    }
    fn incoming(tab: TabId, native: u64, live: Arc<AtomicBool>) -> Incoming {
        Incoming {
            native_id: native,
            tab,
            label: "view-1".into(),
            origin: "https://frame.test".into(),
            kinds: vec!["camera".into()],
            frame: Some("frame-a".into()),
            page_lifetime: true,
            deadline: Instant::now() + std::time::Duration::from_secs(30),
            live: Box::new(move || live.load(Ordering::SeqCst)),
            answer: Box::new(|_| {}),
        }
    }
    fn prompt(value: Admission) -> String {
        match value {
            Admission::Prompt(event) => event.request_id,
            Admission::Complete(..) => panic!("expected prompt"),
        }
    }
    #[test]
    fn page_choice_is_ephemeral_and_expires_when_its_frame_navigates() {
        let (store, tab, scope, registry) = fixture();
        let live = Arc::new(AtomicBool::new(true));
        let id = prompt(
            registry
                .admit(&store, incoming(tab, 1, live.clone()))
                .unwrap(),
        );
        registry
            .answer(&store, tab, "view-1", &id, Decision::Allow, Duration::Page)
            .unwrap()(Some(true));
        assert!(matches!(
            registry
                .admit(&store, incoming(tab, 2, live.clone()))
                .unwrap(),
            Admission::Complete(_, Some(true))
        ));
        assert_eq!(
            policy::read(&store, &scope, "https://frame.test", "camera").unwrap(),
            Decision::Ask
        );
        registry.navigating(tab, "view-1", Some("frame-b"), false);
        assert!(matches!(
            registry
                .admit(&store, incoming(tab, 3, live.clone()))
                .unwrap(),
            Admission::Complete(_, Some(true))
        ));
        registry.navigating(tab, "view-1", Some("frame-a"), false);
        prompt(registry.admit(&store, incoming(tab, 4, live)).unwrap());
    }
    #[test]
    fn late_or_reopened_replies_cannot_persist_grants() {
        let (store, tab, scope, registry) = fixture();
        let live = Arc::new(AtomicBool::new(true));
        let id = prompt(
            registry
                .admit(&store, incoming(tab, 1, live.clone()))
                .unwrap(),
        );
        live.store(false, Ordering::SeqCst);
        assert!(
            registry
                .answer(
                    &store,
                    tab,
                    "view-1",
                    &id,
                    Decision::Allow,
                    Duration::Remember
                )
                .is_err()
        );
        assert_eq!(
            policy::read(&store, &scope, "https://frame.test", "camera").unwrap(),
            Decision::Ask
        );
        live.store(true, Ordering::SeqCst);
        registry.begin(
            tab,
            "view-2".into(),
            scope.clone(),
            store.tab(tab).unwrap().workspace_id.unwrap(),
        );
        assert!(
            registry
                .answer(
                    &store,
                    tab,
                    "view-2",
                    &id,
                    Decision::Allow,
                    Duration::Remember
                )
                .is_err()
        );
        assert!(matches!(
            registry.admit(&store, incoming(tab, 2, live)).unwrap(),
            Admission::Complete(_, None)
        ));
    }
    #[test]
    fn expired_requests_and_closed_sessions_never_persist_and_dismiss_once() {
        let (store, tab, scope, registry) = fixture();
        let live = Arc::new(AtomicBool::new(true));
        let mut expired = incoming(tab, 1, live.clone());
        expired.deadline = Instant::now()
            .checked_sub(std::time::Duration::from_secs(1))
            .unwrap();
        assert!(matches!(
            registry.admit(&store, expired).unwrap(),
            Admission::Complete(_, None)
        ));
        let answers = Arc::new(Mutex::new(Vec::new()));
        let observed = answers.clone();
        let mut request = incoming(tab, 2, live);
        request.answer = Box::new(move |allow| lock(&observed).push(allow));
        let id = prompt(registry.admit(&store, request).unwrap());
        assert!(registry.drop_session(tab, "old-label").is_empty());
        assert_eq!(registry.drop_session(tab, "view-1"), vec![id.clone()]);
        assert!(registry.drop_session(tab, "view-1").is_empty());
        assert_eq!(*lock(&answers), vec![None]);
        assert!(
            registry
                .answer(
                    &store,
                    tab,
                    "view-1",
                    &id,
                    Decision::Allow,
                    Duration::Remember
                )
                .is_err()
        );
        assert_eq!(
            policy::read(&store, &scope, "https://frame.test", "camera").unwrap(),
            Decision::Ask
        );
    }
    #[test]
    fn grouped_request_is_all_or_nothing_and_exact_frame_origin() {
        let (store, tab, scope, registry) = fixture();
        let live = Arc::new(AtomicBool::new(true));
        policy::write(
            &store,
            &scope,
            "https://frame.test",
            "camera",
            Decision::Allow,
        )
        .unwrap();
        policy::write(
            &store,
            &scope,
            "https://frame.test",
            "microphone",
            Decision::Deny,
        )
        .unwrap();
        let mut both = incoming(tab, 1, live.clone());
        both.kinds.push("microphone".into());
        assert!(matches!(
            registry.admit(&store, both).unwrap(),
            Admission::Complete(_, Some(false))
        ));
        let mut other = incoming(tab, 2, live.clone());
        other.origin = "https://other.test".into();
        let id = prompt(registry.admit(&store, other).unwrap());
        registry
            .answer(&store, tab, "view-1", &id, Decision::Allow, Duration::Page)
            .unwrap()(Some(true));
        let mut sibling = incoming(tab, 3, live);
        sibling.origin = "https://other.test".into();
        sibling.frame = Some("sibling".into());
        prompt(registry.admit(&store, sibling).unwrap());
    }
    #[test]
    fn moving_to_another_profile_invalidates_pending_scope_but_essential_tabs_keep_native_scope() {
        let (store, tab, scope, registry) = fixture();
        let live = Arc::new(AtomicBool::new(true));
        let mut row = store.tab(tab).unwrap();
        row.workspace_id = None;
        store.upsert_tab(&row).unwrap();
        let id = prompt(registry.admit(&store, incoming(tab, 1, live)).unwrap());
        let container = dive_core::Container::new("other");
        store.upsert_container(&container).unwrap();
        let profile = dive_core::Profile::new("other", container.id, 1);
        store.upsert_profile(&profile).unwrap();
        let workspace = dive_core::Workspace::new("other", container.id, profile.id, 1);
        store.upsert_workspace(&workspace).unwrap();
        row.workspace_id = Some(workspace.id);
        store.upsert_tab(&row).unwrap();
        assert!(
            registry
                .answer(
                    &store,
                    tab,
                    "view-1",
                    &id,
                    Decision::Allow,
                    Duration::Remember
                )
                .is_err()
        );
        assert_eq!(
            policy::read(&store, &scope, "https://frame.test", "camera").unwrap(),
            Decision::Ask
        );
    }
    #[test]
    fn native_prompt_cannot_claim_unsupported_page_lifetime() {
        let (store, tab, scope, registry) = fixture();
        let mut request = incoming(tab, 1, Arc::new(AtomicBool::new(true)));
        request.page_lifetime = false;
        let id = prompt(registry.admit(&store, request).unwrap());
        assert!(
            registry
                .answer(&store, tab, "view-1", &id, Decision::Allow, Duration::Page)
                .is_err()
        );
        assert_eq!(
            policy::read(&store, &scope, "https://frame.test", "camera").unwrap(),
            Decision::Ask
        );
    }
    #[test]
    fn deferred_old_setup_cannot_replace_new_view_registration() {
        let (store, tab, scope, registry) = fixture();
        let workspace = store.tab(tab).unwrap().workspace_id.unwrap();
        registry.begin(tab, "view-2".into(), scope.clone(), workspace);
        let mut request = incoming(tab, 1, Arc::new(AtomicBool::new(true)));
        request.label = "view-2".into();
        let id = prompt(registry.admit(&store, request).unwrap());
        assert!(
            registry
                .begin_current(tab, "view-1".into(), "view-2", scope, workspace)
                .is_none()
        );
        assert!(registry.drop_session(tab, "view-1").is_empty());
        registry
            .answer(&store, tab, "view-2", &id, Decision::Allow, Duration::Page)
            .unwrap()(Some(true));
    }
}
