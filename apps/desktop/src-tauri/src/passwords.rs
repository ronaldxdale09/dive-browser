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

/// One login read from a CSV export.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CsvLogin {
    pub url: String,
    pub username: String,
    pub password: String,
}

/// What a CSV import did.
#[derive(
    Debug, Clone, Copy, Default, PartialEq, Eq, serde::Serialize, serde::Deserialize, specta::Type,
)]
pub struct CsvImportSummary {
    /// Logins now saved that were not before.
    pub added: u32,
    /// Rows whose site and username Dive already had.
    pub skipped: u32,
    /// Rows without a usable site, username or password.
    pub unreadable: u32,
}

/// Split RFC 4180 CSV text into rows of fields: quoted fields, doubled
/// quotes inside them, and CR LF or LF line ends. Blank lines are dropped.
pub fn parse_csv(text: &str) -> Vec<Vec<String>> {
    let mut rows = Vec::new();
    let mut row = Vec::new();
    let mut field = String::new();
    let mut quoted = false;
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        if quoted {
            match c {
                '"' if chars.peek() == Some(&'"') => {
                    chars.next();
                    field.push('"');
                }
                '"' => quoted = false,
                _ => field.push(c),
            }
            continue;
        }
        match c {
            '"' if field.is_empty() => quoted = true,
            ',' => row.push(std::mem::take(&mut field)),
            '\r' => {}
            '\n' => {
                row.push(std::mem::take(&mut field));
                if row.iter().any(|f| !f.trim().is_empty()) {
                    rows.push(std::mem::take(&mut row));
                } else {
                    row.clear();
                }
            }
            _ => field.push(c),
        }
    }
    if !field.is_empty() || !row.is_empty() {
        row.push(field);
        if row.iter().any(|f| !f.trim().is_empty()) {
            rows.push(row);
        }
    }
    rows
}

/// Logins from a password CSV as Chrome, Safari, Firefox, Edge, 1Password
/// and Bitwarden export it: the header names the columns, in any order.
pub fn parse_password_csv(text: &str) -> AppResult<Vec<CsvLogin>> {
    let text = text.strip_prefix('\u{feff}').unwrap_or(text);
    let mut rows = parse_csv(text).into_iter();
    let header = rows
        .next()
        .ok_or_else(|| AppError::new("the file is empty"))?;
    let find = |names: &[&str]| {
        header.iter().position(|h| {
            let h = h.trim().to_ascii_lowercase();
            names.iter().any(|n| h == *n)
        })
    };
    let url = find(&[
        "url",
        "website",
        "login_uri",
        "web site",
        "hostname",
        "origin",
        "site",
        "uri",
    ]);
    let username = find(&[
        "username",
        "login_username",
        "login",
        "user",
        "user name",
        "email",
    ]);
    let password = find(&["password", "login_password", "pass"]);
    let (Some(url), Some(username), Some(password)) = (url, username, password) else {
        return Err(AppError::new(
            "this does not look like a password export: it needs url, username and password columns",
        ));
    };
    let cell =
        |row: &[String], i: usize| row.get(i).map(|s| s.trim().to_owned()).unwrap_or_default();
    Ok(rows
        .map(|row| CsvLogin {
            url: cell(&row, url),
            username: cell(&row, username),
            password: cell(&row, password),
        })
        .collect())
}

/// Save the logins of a CSV export into `profile`, leaving what is already
/// there alone.
pub fn import_csv(state: &AppState, profile: ProfileId, text: &str) -> AppResult<CsvImportSummary> {
    let logins = parse_password_csv(text)?;
    let known = list(state, profile)?;
    let mut summary = CsvImportSummary::default();
    for login in logins {
        let Ok(origin) = origin_of(&login.url) else {
            summary.unreadable += 1;
            continue;
        };
        if login.username.is_empty() || login.password.is_empty() {
            summary.unreadable += 1;
            continue;
        }
        if known
            .iter()
            .any(|c| c.origin == origin && c.username == login.username)
        {
            summary.skipped += 1;
            continue;
        }
        match save(state, profile, &origin, &login.username, &login.password) {
            Ok(_) => summary.added += 1,
            Err(_) => summary.unreadable += 1,
        }
    }
    Ok(summary)
}

#[cfg(test)]
mod tests {
    use super::{origin_of, parse_csv, parse_password_csv};

    #[test]
    fn csv_handles_quotes_doubled_quotes_and_crlf() {
        let rows = parse_csv("a,b\r\n\"x, y\",\"say \"\"hi\"\"\"\n\n,last");
        assert_eq!(
            rows,
            vec![vec!["a", "b"], vec!["x, y", "say \"hi\""], vec!["", "last"]]
        );
    }

    #[test]
    fn password_exports_from_the_usual_places_are_understood() {
        let chrome =
            "name,url,username,password,note\nGitHub,https://github.com/login,dale,hunter2,\n";
        let got = parse_password_csv(chrome).unwrap();
        assert_eq!(got.len(), 1);
        assert_eq!(
            (
                got[0].url.as_str(),
                got[0].username.as_str(),
                got[0].password.as_str()
            ),
            ("https://github.com/login", "dale", "hunter2")
        );
        let bitwarden = "folder,favorite,type,name,notes,fields,reprompt,login_uri,login_username,login_password,login_totp\n,,login,X,,,0,https://x.test,eve,pw,\n";
        assert_eq!(parse_password_csv(bitwarden).unwrap()[0].username, "eve");
        let safari =
            "\u{feff}Title,URL,Username,Password,Notes,OTPAuth\nSite,https://s.test,me,secret,,\n";
        assert_eq!(parse_password_csv(safari).unwrap()[0].password, "secret");
        assert!(parse_password_csv("id,name\n1,x\n").is_err());
        assert!(parse_password_csv("").is_err());
    }

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
