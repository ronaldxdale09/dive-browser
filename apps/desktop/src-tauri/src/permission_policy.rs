//! Permission scope and persistence. The renderer never supplies scope authority.
use super::Decision;
use dive_core::{ContainerId, ProfileId, Store, TabId};
const PREFIX: &str = "perm:v2:";

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize, specta::Type)]
pub struct Scope {
    pub profile_id: ProfileId,
    pub container_id: ContainerId,
}
impl Scope {
    #[cfg(test)]
    pub fn for_tab(store: &Store, tab: TabId) -> dive_core::Result<Self> {
        let workspace = store.tab(tab)?.workspace_id.ok_or_else(|| {
            dive_core::CoreError::Invalid("Permission request has no workspace".into())
        })?;
        Self::for_workspace(store, workspace)
    }
    pub fn for_workspace(
        store: &Store,
        workspace: dive_core::WorkspaceId,
    ) -> dive_core::Result<Self> {
        let workspace = store.workspace(workspace)?;
        store.profile(workspace.profile_id)?;
        store.container(workspace.container_id)?;
        Ok(Self {
            profile_id: workspace.profile_id,
            container_id: workspace.container_id,
        })
    }
    pub fn for_view(
        store: &Store,
        tab: TabId,
        workspace: dive_core::WorkspaceId,
        container: ContainerId,
    ) -> dive_core::Result<Self> {
        let current = store.tab(tab)?;
        let scope = Self::for_workspace(store, current.workspace_id.unwrap_or(workspace))?;
        if scope.container_id != container {
            return Err(dive_core::CoreError::Invalid(
                "Native permission container changed".into(),
            ));
        }
        Ok(scope)
    }
    fn prefix(&self) -> String {
        format!("{PREFIX}{}:{}:", self.profile_id, self.container_id)
    }
}
pub fn canonical_origin(origin: &str) -> dive_core::Result<String> {
    let parsed = url::Url::parse(origin)
        .map_err(|_| dive_core::CoreError::Invalid("Invalid permission origin".into()))?;
    if !matches!(parsed.scheme(), "http" | "https")
        || parsed.host_str().is_none()
        || !parsed.username().is_empty()
        || parsed.password().is_some()
        || parsed.path() != "/"
        || parsed.query().is_some()
        || parsed.fragment().is_some()
    {
        return Err(dive_core::CoreError::Invalid("Permission origin must be an HTTP(S) origin without credentials, path, query or fragment".into()));
    }
    Ok(parsed.origin().ascii_serialization())
}
fn key(scope: &Scope, origin: &str, kind: &str) -> dive_core::Result<String> {
    if !super::KINDS.contains(&kind) {
        return Err(dive_core::CoreError::Invalid(
            "Unsupported permission kind".into(),
        ));
    }
    Ok(format!(
        "{}{}:{kind}",
        scope.prefix(),
        canonical_origin(origin)?
    ))
}
pub fn read(store: &Store, scope: &Scope, origin: &str, kind: &str) -> dive_core::Result<Decision> {
    Ok(store
        .setting(&key(scope, origin, kind)?)?
        .map_or(Decision::Ask, |value| Decision::parse(&value)))
}
pub fn write(
    store: &Store,
    scope: &Scope,
    origin: &str,
    kind: &str,
    choice: Decision,
) -> dive_core::Result<()> {
    if choice == Decision::Ask {
        store.remove_setting(&key(scope, origin, kind)?).map(|_| ())
    } else {
        store.set_setting(&key(scope, origin, kind)?, choice.as_str())
    }
}
pub fn remember_group(
    store: &Store,
    scope: &Scope,
    origin: &str,
    kinds: &[String],
    choice: Decision,
) -> dive_core::Result<()> {
    let entries = kinds
        .iter()
        .map(|kind| Ok((key(scope, origin, kind)?, choice.as_str().to_owned())))
        .collect::<dive_core::Result<Vec<_>>>()?;
    store.set_settings_atomic(&entries)
}
pub fn all(store: &Store, scope: &Scope) -> dive_core::Result<Vec<super::SitePermission>> {
    Ok(store
        .settings_with_prefix(&scope.prefix())?
        .into_iter()
        .filter_map(|(key, value)| {
            let (origin, kind) = key.strip_prefix(&scope.prefix())?.rsplit_once(':')?;
            let origin = canonical_origin(origin).ok()?;
            if !super::KINDS.contains(&kind) {
                return None;
            }
            Some(super::SitePermission {
                origin,
                kind: kind.to_owned(),
                decision: Decision::parse(&value),
                scope: scope.clone(),
            })
        })
        .collect())
}
#[cfg(test)]
mod tests {
    use super::*;
    fn scope(store: &Store) -> Scope {
        let container = dive_core::Container::new("test");
        store.upsert_container(&container).unwrap();
        let profile = dive_core::Profile::new("test", container.id, 0);
        store.upsert_profile(&profile).unwrap();
        Scope {
            profile_id: profile.id,
            container_id: container.id,
        }
    }
    #[test]
    fn remembered_grants_do_not_cross_profile_or_container_and_ignore_legacy() {
        let store = Store::in_memory().unwrap();
        let a = scope(&store);
        let b = scope(&store);
        store
            .set_setting("perm:https://legacy.test:camera", "allow")
            .unwrap();
        assert_eq!(
            read(&store, &a, "https://legacy.test", "camera").unwrap(),
            Decision::Ask
        );
        write(
            &store,
            &a,
            "https://EXAMPLE.com:443",
            "camera",
            Decision::Allow,
        )
        .unwrap();
        assert_eq!(
            read(&store, &a, "https://example.com", "camera").unwrap(),
            Decision::Allow
        );
        assert_eq!(
            read(&store, &b, "https://example.com", "camera").unwrap(),
            Decision::Ask
        );
        let separate = Scope {
            profile_id: a.profile_id,
            container_id: b.container_id,
        };
        assert_eq!(
            read(&store, &separate, "https://example.com", "camera").unwrap(),
            Decision::Ask
        );
        assert_eq!(
            read(&store, &a, "https://example.com:8443", "camera").unwrap(),
            Decision::Ask
        );
    }
    #[test]
    fn malformed_origins_and_unknown_kinds_cannot_create_grants() {
        let store = Store::in_memory().unwrap();
        let scope = scope(&store);
        for origin in [
            "file:///tmp/a",
            "data:text/plain,a",
            "https://example.com/path",
            "https://user:pass@example.com",
            "https://example.com?x=1",
            "null",
        ] {
            assert!(
                write(&store, &scope, origin, "camera", Decision::Allow).is_err(),
                "{origin}"
            );
        }
        assert!(
            write(
                &store,
                &scope,
                "https://example.com",
                "filesystem",
                Decision::Allow
            )
            .is_err()
        );
    }
    #[test]
    fn remembered_choices_survive_store_restart_and_ask_removes_only_its_scope() {
        let path = std::env::temp_dir().join(format!("dive-permission-{}.db", TabId::new()));
        let scope = {
            let store = Store::open(&path).unwrap();
            let scope = scope(&store);
            write(
                &store,
                &scope,
                "https://example.com",
                "microphone",
                Decision::Deny,
            )
            .unwrap();
            scope
        };
        {
            let store = Store::open(&path).unwrap();
            assert_eq!(
                read(&store, &scope, "https://example.com", "microphone").unwrap(),
                Decision::Deny
            );
            write(
                &store,
                &scope,
                "https://example.com",
                "microphone",
                Decision::Ask,
            )
            .unwrap();
            assert_eq!(
                read(&store, &scope, "https://example.com", "microphone").unwrap(),
                Decision::Ask
            );
        }
        let _ = std::fs::remove_file(path);
    }
}
