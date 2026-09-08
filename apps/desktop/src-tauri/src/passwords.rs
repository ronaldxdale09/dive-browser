//! Saved logins. The listing (site, username, when) is a row in the core
//! store, scoped to the profile; the password itself is a keychain item
//! under the row's id, so the database never holds a secret and the OS
//! guards reads the way it guards the agent's API keys.

use crate::error::{AppError, AppResult};
use crate::state::AppState;
use dive_core::{Credential, ProfileId, Timestamp};

const SERVICE: &str = "app.dive.browser.passwords";

fn entry(id: &str) -> AppResult<keyring_core::Entry> {
    keyring_core::Entry::new(SERVICE, id).map_err(AppError::new)
}

/// `scheme://host[:port]` for a page URL or an origin, or an error when the
/// text is not a web address: a login keyed on the wrong string never fills.
pub fn origin_of(url: &str) -> AppResult<String> {
    // A bare host gets https; anything already carrying a scheme (mailto:,
    // data:) is judged as written.
    let has_scheme = url.split_once(':').is_some_and(|(scheme, _)| {
        !scheme.is_empty()
            && scheme
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || "+-.".contains(c))
    });
    let candidate = if has_scheme {
        url.to_owned()
    } else {
        format!("https://{url}")
    };
    let parsed =
        url::Url::parse(&candidate).map_err(|_| AppError::new(format!("not a site: {url}")))?;
    if !matches!(parsed.scheme(), "http" | "https") || parsed.host_str().is_none() {
        return Err(AppError::new(format!("not a site: {url}")));
    }
    dive_core::origin_of(parsed.as_str()).ok_or_else(|| AppError::new(format!("not a site: {url}")))
}

/// Every login saved for `profile`.
pub fn list(state: &AppState, profile: ProfileId) -> AppResult<Vec<Credential>> {
    Ok(crate::state::lock(&state.store).credentials(profile)?)
}

/// Logins saved for the site of `url` in `profile`, most used first.
pub fn for_url(state: &AppState, profile: ProfileId, url: &str) -> AppResult<Vec<Credential>> {
    let origin = origin_of(url)?;
    Ok(crate::state::lock(&state.store).credentials_for(profile, &origin)?)
}

/// Save (or update the password of) a login for the site of `url`.
pub fn save(
    state: &AppState,
    profile: ProfileId,
    url: &str,
    username: &str,
    password: &str,
) -> AppResult<Credential> {
    let username = username.trim();
    if username.is_empty() {
        return Err(AppError::new("a login needs a username"));
    }
    if password.is_empty() {
        return Err(AppError::new("a login needs a password"));
    }
    let origin = origin_of(url)?;
    let id = dive_core::TabId::new().to_string();
    let row = crate::state::lock(&state.store).upsert_credential(
        &id,
        profile,
        &origin,
        username,
        Timestamp::now(),
    )?;
    entry(&row.id)?
        .set_password(password)
        .map_err(AppError::new)?;
    Ok(row)
}

/// The password behind a login, for filling or showing.
pub fn reveal(state: &AppState, profile: ProfileId, id: &str) -> AppResult<String> {
    owned(state, profile, id)?;
    entry(id)?.get_password().map_err(AppError::new)
}

/// Forget a login and its password.
pub fn delete(state: &AppState, profile: ProfileId, id: &str) -> AppResult<bool> {
    owned(state, profile, id)?;
    let _ = entry(id).and_then(|e| e.delete_credential().map_err(AppError::new));
    Ok(crate::state::lock(&state.store).remove_credential(id)?)
}

/// Note a fill, for ordering when a site has several logins.
pub fn touch(state: &AppState, id: &str) -> AppResult<()> {
    Ok(crate::state::lock(&state.store).touch_credential(id, Timestamp::now())?)
}

/// A login is only readable from the profile it was saved in.
fn owned(state: &AppState, profile: ProfileId, id: &str) -> AppResult<()> {
    let mine = crate::state::lock(&state.store)
        .credentials(profile)?
        .iter()
        .any(|c| c.id == id);
    if mine {
        Ok(())
    } else {
        Err(AppError::new("no such login in this profile"))
    }
}

#[cfg(test)]
mod tests {
    use super::origin_of;

    #[test]
    fn origins_come_from_page_urls_and_bare_hosts() {
        assert_eq!(
            origin_of("https://accounts.example.com/login?next=/").unwrap(),
            "https://accounts.example.com"
        );
        assert_eq!(
            origin_of("http://localhost:3000/app").unwrap(),
            "http://localhost:3000"
        );
        assert_eq!(origin_of("example.org").unwrap(), "https://example.org");
        assert!(origin_of("mailto:someone@example.org").is_err());
        assert!(origin_of("not a url at all").is_err());
    }
}
