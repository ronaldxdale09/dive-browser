//! Saved logins. The listing (site, username, when) is a row in the core
//! store, scoped to the profile; the password itself is a keychain item
//! under the row's id, so the database never holds a secret and the OS
//! guards reads the way it guards the agent's API keys.

use crate::error::{AppError, AppResult};
use crate::state::AppState;
use dive_core::{Credential, ProfileId, Timestamp};

const SERVICE: &str = "app.dive.browser.passwords";

fn credential_store_name_for(windows: bool) -> &'static str {
    if windows {
        "Credential Manager"
    } else {
        "The Keychain"
    }
}

fn credential_store_name() -> &'static str {
    credential_store_name_for(cfg!(windows))
}

fn missing_password_error_for(windows: bool) -> String {
    format!(
        "{} no longer has this password. Forget the login and save it again.",
        credential_store_name_for(windows)
    )
}

fn missing_password_error() -> String {
    missing_password_error_for(cfg!(windows))
}

/// Whether `error` is the OS store saying it no longer has the password, as
/// opposed to refusing to hand it over.
pub fn is_missing_password(error: &AppError) -> bool {
    error.message == missing_password_error()
}

fn password_read_error(error: impl std::fmt::Display) -> String {
    format!(
        "{} would not hand over this password: {error}",
        credential_store_name()
    )
}

fn entry(id: &str) -> AppResult<keyring_core::Entry> {
    keyring_core::Entry::new(SERVICE, id).map_err(AppError::new)
}

/// `scheme://host[:port]` for a page URL or an origin, or an error when the
/// text is not a web address: a login keyed on the wrong string never fills.
pub fn origin_of(url: &str) -> AppResult<String> {
    let url = url.trim();
    // "localhost:3000" reads as scheme "localhost" to a URL parser, and
    // "192.168.1.1:8080" is not a URL at all; a port after the colon makes it
    // a host, the way the address bar takes it.
    let host_and_port = url.split_once(':').is_some_and(|(host, rest)| {
        !host.is_empty()
            && !host.contains(['/', '?', '#', ' '])
            && rest
                .split(['/', '?', '#'])
                .next()
                .is_some_and(|port| !port.is_empty() && port.chars().all(|c| c.is_ascii_digit()))
    });
    // A bare host gets https (http for this machine and the local network,
    // which rarely have certificates); anything already carrying a scheme
    // (mailto:, data:) is judged as written.
    let has_scheme = !host_and_port
        && url.split_once(':').is_some_and(|(scheme, _)| {
            !scheme.is_empty()
                && scheme
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || "+-.".contains(c))
        });
    let candidate = if has_scheme {
        url.to_owned()
    } else if is_local_address(url) {
        format!("http://{url}")
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

/// Whether a typed address (no scheme) names this machine or the local
/// network: localhost, a loopback or private IPv4 address, or a `.local` name.
fn is_local_address(typed: &str) -> bool {
    let authority = typed.split(['/', '?', '#']).next().unwrap_or_default();
    let host = authority
        .rsplit_once(':')
        .map_or(authority, |(host, _)| host)
        .to_ascii_lowercase();
    let last_label = host.rsplit('.').next().unwrap_or_default();
    if host == "localhost" || (host.contains('.') && matches!(last_label, "localhost" | "local")) {
        return true;
    }
    host.parse::<std::net::Ipv4Addr>()
        .is_ok_and(|ip| ip.is_loopback() || ip.is_private() || ip.is_link_local())
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

/// Why a private window keeps nothing.
pub const PRIVATE_SAVE: &str =
    "Private windows do not keep passwords. Sign in from a normal window to save this login.";

/// A login worth keeping has both halves.
pub fn check_login(username: &str, password: &str) -> AppResult<()> {
    if username.trim().is_empty() {
        return Err(AppError::new("a login needs a username"));
    }
    if password.is_empty() {
        return Err(AppError::new("a login needs a password"));
    }
    Ok(())
}

/// What adding a login from Settings did.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize, specta::Type)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum LoginSave {
    /// Saved; `replaced` when it took the place of a password already kept
    /// for that site and username.
    Saved {
        credential: Credential,
        replaced: bool,
    },
    /// The site already has a password for that username, and nothing was
    /// written: the person is asked before it is replaced.
    Exists { origin: String },
}

/// Add a login typed into Settings. Unlike a save from a sign-in, which is
/// the person's own "update" answer, a login added by hand that matches one
/// already kept is not written over unless `replace` says the person agreed.
pub fn add(
    state: &AppState,
    profile: ProfileId,
    url: &str,
    username: &str,
    password: &str,
    replace: bool,
) -> AppResult<LoginSave> {
    check_login(username, password)?;
    let origin = origin_of(url)?;
    let existed = crate::state::lock(&state.store)
        .credentials_for(profile, &origin)?
        .iter()
        .any(|c| c.username == username.trim());
    if existed && !replace {
        return Ok(LoginSave::Exists { origin });
    }
    let credential = save(state, profile, &origin, username, password)?;
    Ok(LoginSave::Saved {
        credential,
        replaced: existed,
    })
}

/// Change a saved login's username, its password, or both. An empty
/// `password` leaves the one in the OS store alone. The keychain item is
/// named by the row id, which a rename keeps, so only the secret is rewritten.
pub fn edit(
    state: &AppState,
    profile: ProfileId,
    id: &str,
    username: &str,
    password: &str,
) -> AppResult<Credential> {
    let username = username.trim();
    if username.is_empty() {
        return Err(AppError::new("a login needs a username"));
    }
    let before = crate::state::lock(&state.store)
        .credentials(profile)?
        .into_iter()
        .find(|c| c.id == id)
        .ok_or_else(|| AppError::new("no such login in this profile"))?;
    let renamed = if username == before.username {
        before.clone()
    } else {
        let clash = crate::state::lock(&state.store)
            .credentials_for(profile, &before.origin)?
            .iter()
            .any(|c| c.username == username);
        if clash {
            return Err(AppError::new(format!(
                "{} already has a saved login for {username}",
                before.origin
            )));
        }
        crate::state::lock(&state.store).rename_credential(id, username)?
    };
    if !password.is_empty() {
        let written = entry(id).and_then(|e| e.set_password(password).map_err(AppError::new));
        if let Err(error) = written {
            // Half an edit is a login whose name changed while its password
            // did not; put the name back so what is listed is what fills.
            if renamed.username != before.username {
                let _ = crate::state::lock(&state.store).rename_credential(id, &before.username);
            }
            return Err(AppError::new(format!(
                "{} would not take the new password: {}",
                credential_store_name(),
                error.message
            )));
        }
    }
    Ok(renamed)
}

/// Save (or update the password of) a login for the site of `url`.
pub fn save(
    state: &AppState,
    profile: ProfileId,
    url: &str,
    username: &str,
    password: &str,
) -> AppResult<Credential> {
    check_login(username, password)?;
    if crate::private_session::is_private() {
        // The private store is in memory; a Keychain item written now would
        // outlive its row and never be listed or removed again.
        return Err(AppError::new(PRIVATE_SAVE));
    }
    let username = username.trim();
    let origin = origin_of(url)?;
    let id = dive_core::TabId::new().to_string();
    let row = crate::state::lock(&state.store).upsert_credential(
        &id,
        profile,
        &origin,
        username,
        Timestamp::now(),
    )?;
    let written = entry(&row.id).and_then(|e| e.set_password(password).map_err(AppError::new));
    if let Err(error) = written {
        // A new row with no password behind it would be listed but could
        // never fill, and every later sign-in would offer to "update" it.
        if row.id == id {
            let _ = crate::state::lock(&state.store).remove_credential(&row.id);
        }
        return Err(error);
    }
    Ok(row)
}

/// The password behind a login, for filling or showing.
pub fn reveal(state: &AppState, profile: ProfileId, id: &str) -> AppResult<String> {
    owned(state, profile, id)?;
    entry(id)?.get_password().map_err(|e| match e {
        keyring_core::Error::NoEntry => AppError::new(missing_password_error()),
        e => AppError::new(password_read_error(e)),
    })
}

/// Forget a login and its password.
pub fn delete(state: &AppState, profile: ProfileId, id: &str) -> AppResult<bool> {
    owned(state, profile, id)?;
    // The secret goes first, and the row only once it has. Removing the row
    // after a refused delete left the password in the OS store with nothing
    // in Dive that could ever name it again. An item already gone is what
    // forgetting wanted anyway.
    match entry(id)?.delete_credential() {
        Ok(()) | Err(keyring_core::Error::NoEntry) => {}
        Err(error) => {
            return Err(AppError::new(format!(
                "{} would not forget this password: {error}",
                credential_store_name()
            )));
        }
    }
    Ok(crate::state::lock(&state.store).remove_credential(id)?)
}

/// Remove the password behind login `id`, whose row is about to go with its
/// profile. An item already gone counts as removed.
pub fn delete_secret(id: &str) -> AppResult<()> {
    match entry(id)?.delete_credential() {
        Ok(()) | Err(keyring_core::Error::NoEntry) => Ok(()),
        Err(error) => Err(AppError::new(format!(
            "{} would not forget this password: {error}",
            credential_store_name()
        ))),
    }
}

fn never_key(profile: ProfileId) -> String {
    format!("passwords.never.{profile}")
}

/// Sites this profile asked never to be offered a save for, as origins.
pub fn never_list(state: &AppState, profile: ProfileId) -> AppResult<Vec<String>> {
    let raw = crate::state::lock(&state.store).setting(&never_key(profile))?;
    Ok(raw
        .and_then(|text| serde_json::from_str::<Vec<String>>(&text).ok())
        .unwrap_or_default())
}

fn write_never(state: &AppState, profile: ProfileId, list: &[String]) -> AppResult<()> {
    let text = serde_json::to_string(list).map_err(AppError::new)?;
    Ok(crate::state::lock(&state.store).set_setting(&never_key(profile), &text)?)
}

/// Stop offering to save logins for the site of `url` in this profile.
pub fn never_add(state: &AppState, profile: ProfileId, url: &str) -> AppResult<String> {
    let origin = origin_of(url)?;
    let mut list = never_list(state, profile)?;
    if !list.contains(&origin) {
        list.push(origin.clone());
        list.sort();
        write_never(state, profile, &list)?;
    }
    Ok(origin)
}

/// Offer again for `origin`; returns whether it was on the list.
pub fn never_remove(state: &AppState, profile: ProfileId, origin: &str) -> AppResult<bool> {
    let mut list = never_list(state, profile)?;
    let before = list.len();
    list.retain(|o| o != origin);
    if list.len() != before {
        write_never(state, profile, &list)?;
    }
    Ok(list.len() != before)
}

/// Note a fill, for ordering when a site has several logins.
pub fn touch(state: &AppState, id: &str) -> AppResult<()> {
    Ok(crate::state::lock(&state.store).touch_credential(id, Timestamp::now())?)
}

/// A login is only readable from the profile it was saved in.
pub fn owned(state: &AppState, profile: ProfileId, id: &str) -> AppResult<()> {
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
    Debug, Clone, Default, PartialEq, Eq, serde::Serialize, serde::Deserialize, specta::Type,
)]
pub struct CsvImportSummary {
    /// Logins now saved that were not before.
    pub added: u32,
    /// Rows whose site and username Dive already had.
    pub skipped: u32,
    /// Rows without a usable site, username or password.
    pub unreadable: u32,
    /// Rows the OS store refused to keep. Counted apart from unreadable
    /// ones: the file was fine, and trying again may work.
    pub failed: u32,
    /// Why the first refused row was refused, to show with the count.
    pub failure: Option<String>,
}

/// The largest CSV an import reads. Password exports are a few hundred
/// bytes a login; anything this big is the wrong file, and reading it whole
/// would only stall the import.
pub const MAX_CSV_BYTES: u64 = 10 * 1024 * 1024;

/// Read a password export from disk, refusing files too big to be one.
pub fn read_csv_file(path: &std::path::Path) -> AppResult<String> {
    let too_big = || {
        AppError::new(format!(
            "{} is too large to be a password export (the limit is 10 MB)",
            path.display()
        ))
    };
    let unreadable =
        |e: std::io::Error| AppError::new(format!("could not read {}: {e}", path.display()));
    if std::fs::metadata(path).map_err(unreadable)?.len() > MAX_CSV_BYTES {
        return Err(too_big());
    }
    let bytes = std::fs::read(path).map_err(unreadable)?;
    if bytes.len() as u64 > MAX_CSV_BYTES {
        return Err(too_big());
    }
    Ok(decode_csv_bytes(&bytes))
}

/// Text from the bytes of an exported file. Most exports are UTF-8, some
/// with a byte-order mark; Excel on Windows saves UTF-16 with a mark or
/// Windows-1252 without one, and reading those as UTF-8 used to refuse the
/// whole file over one accented name.
pub fn decode_csv_bytes(bytes: &[u8]) -> String {
    if let Some(rest) = bytes.strip_prefix(&[0xEF, 0xBB, 0xBF]) {
        return String::from_utf8_lossy(rest).into_owned();
    }
    let utf16 = |rest: &[u8], unit: fn([u8; 2]) -> u16| {
        let units: Vec<u16> = rest
            .as_chunks::<2>()
            .0
            .iter()
            .map(|&pair| unit(pair))
            .collect();
        String::from_utf16_lossy(&units)
    };
    if let Some(rest) = bytes.strip_prefix(&[0xFF, 0xFE]) {
        return utf16(rest, u16::from_le_bytes);
    }
    if let Some(rest) = bytes.strip_prefix(&[0xFE, 0xFF]) {
        return utf16(rest, u16::from_be_bytes);
    }
    match std::str::from_utf8(bytes) {
        Ok(text) => text.to_owned(),
        Err(_) => bytes.iter().map(|&b| windows_1252(b)).collect(),
    }
}

/// One Windows-1252 byte as a character. It is Latin-1 but for 0x80-0x9F,
/// where it keeps the curly quotes, dashes and euro sign.
fn windows_1252(byte: u8) -> char {
    const HIGH: [char; 32] = [
        '\u{20AC}', '\u{FFFD}', '\u{201A}', '\u{0192}', '\u{201E}', '\u{2026}', '\u{2020}',
        '\u{2021}', '\u{02C6}', '\u{2030}', '\u{0160}', '\u{2039}', '\u{0152}', '\u{FFFD}',
        '\u{017D}', '\u{FFFD}', '\u{FFFD}', '\u{2018}', '\u{2019}', '\u{201C}', '\u{201D}',
        '\u{2022}', '\u{2013}', '\u{2014}', '\u{02DC}', '\u{2122}', '\u{0161}', '\u{203A}',
        '\u{0153}', '\u{FFFD}', '\u{017E}', '\u{0178}',
    ];
    match byte {
        0x80..=0x9F => HIGH[usize::from(byte - 0x80)],
        _ => char::from(byte),
    }
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
            // Taken exactly as exported: a space at either end of a password
            // is part of it, and trimming it saved a login that never worked.
            password: row.get(password).cloned().unwrap_or_default(),
        })
        .collect())
}

/// Save the logins of a CSV export into `profile`, leaving what is already
/// there alone.
pub fn import_csv(state: &AppState, profile: ProfileId, text: &str) -> AppResult<CsvImportSummary> {
    let logins = parse_password_csv(text)?;
    let mut known: std::collections::HashSet<(String, String)> = list(state, profile)?
        .into_iter()
        .map(|c| (c.origin, c.username))
        .collect();
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
        // Checked against what this import has saved too: an export that
        // lists a login twice (one row per page of a site, say) keeps the
        // first rather than writing the password over itself.
        let key = (origin, login.username);
        if known.contains(&key) {
            summary.skipped += 1;
            continue;
        }
        match save(state, profile, &key.0, &key.1, &login.password) {
            Ok(_) => {
                summary.added += 1;
                known.insert(key);
            }
            Err(error) => {
                summary.failed += 1;
                summary.failure.get_or_insert(error.message);
            }
        }
    }
    Ok(summary)
}

/// What a password export wrote.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize, specta::Type)]
pub struct PasswordExport {
    /// Where the file went.
    pub path: String,
    /// Logins written to it.
    pub exported: u32,
    /// Logins left out because the OS store would not hand their password over.
    pub failed: u32,
}

/// One CSV field, quoted when it has to be: a comma, a quote, a line break,
/// or a space at either end that a spreadsheet would otherwise drop.
fn csv_field(value: &str) -> String {
    let plain = !value.contains([',', '"', '\n', '\r']) && value.trim() == value;
    if plain {
        value.to_owned()
    } else {
        format!("\"{}\"", value.replace('"', "\"\""))
    }
}

/// One row of a password export in the columns Chrome writes, so the file
/// imports into Chrome, Edge, Firefox, Safari and the password managers.
pub fn export_row(origin: &str, username: &str, password: &str) -> String {
    let name = origin.split_once("://").map_or(origin, |(_, host)| host);
    format!(
        "{},{},{},{}\n",
        csv_field(name),
        csv_field(&format!("{origin}/")),
        csv_field(username),
        csv_field(password)
    )
}

/// Every login in `profile` as a Chrome-style CSV, with how many were
/// written and how many the OS store kept back.
pub fn export_csv(state: &AppState, profile: ProfileId) -> AppResult<(String, u32, u32)> {
    let logins = list(state, profile)?;
    let mut text = String::from("name,url,username,password\n");
    let (mut exported, mut failed) = (0u32, 0u32);
    for login in logins {
        match reveal(state, profile, &login.id) {
            Ok(password) => {
                text.push_str(&export_row(&login.origin, &login.username, &password));
                exported += 1;
            }
            Err(_) => failed += 1,
        }
    }
    Ok((text, exported, failed))
}

/// Write an export where only this user can read it: the file holds every
/// password in the clear.
pub fn write_private_file(path: &std::path::Path, text: &str) -> AppResult<()> {
    use std::io::Write as _;
    let unwritable =
        |e: std::io::Error| AppError::new(format!("could not write {}: {e}", path.display()));
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt as _;
        options.mode(0o600);
    }
    let mut file = options.open(path).map_err(unwritable)?;
    // A file that already existed keeps its old mode through `open`.
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt as _;
        let _ = file.set_permissions(std::fs::Permissions::from_mode(0o600));
    }
    file.write_all(text.as_bytes()).map_err(unwritable)
}

#[cfg(test)]
mod tests {
    #[test]
    fn missing_password_error_names_this_os_store() {
        let windows = super::missing_password_error_for(true);
        assert!(!windows.contains("Keychain"), "{windows}");
        assert!(windows.contains("Credential Manager"), "{windows}");
        let other = super::missing_password_error_for(false);
        assert!(other.contains("The Keychain"), "{other}");
        assert!(!other.contains("Credential Manager"), "{other}");
    }

    #[test]
    fn a_login_needs_both_halves() {
        assert!(super::check_login("dale", "x").is_ok());
        assert!(
            super::check_login("  ", "x")
                .unwrap_err()
                .to_string()
                .contains("username")
        );
        assert!(
            super::check_login("dale", "")
                .unwrap_err()
                .to_string()
                .contains("password")
        );
    }

    use super::{decode_csv_bytes, export_row, origin_of, parse_csv, parse_password_csv};

    #[test]
    fn a_password_keeps_its_spaces_on_import() {
        let got = parse_password_csv("url,username,password\n https://x.test , dale ,\"  pw \"\n")
            .unwrap();
        assert_eq!(
            (
                got[0].url.as_str(),
                got[0].username.as_str(),
                got[0].password.as_str()
            ),
            ("https://x.test", "dale", "  pw ")
        );
    }

    #[test]
    fn exports_saved_in_other_encodings_still_read() {
        assert_eq!(decode_csv_bytes(b"\xEF\xBB\xBFurl"), "url");
        // "Jos\u{e9} \u{2013} \u{20ac}5" as Windows-1252, the way Excel saves it.
        assert_eq!(
            decode_csv_bytes(b"Jos\xE9 \x96 \x805"),
            "Jos\u{e9} \u{2013} \u{20ac}5"
        );
        assert_eq!(decode_csv_bytes(b"\xFF\xFEu\0r\0l\0"), "url");
        assert_eq!(decode_csv_bytes("caf\u{e9}".as_bytes()), "caf\u{e9}");
    }

    #[test]
    fn an_export_row_is_chrome_shaped_and_quoted_where_needed() {
        assert_eq!(
            export_row("https://github.com", "dale", "hunter2"),
            "github.com,https://github.com/,dale,hunter2\n"
        );
        assert_eq!(
            export_row("http://localhost:3000", "a,b", "say \"hi\" "),
            "localhost:3000,http://localhost:3000/,\"a,b\",\"say \"\"hi\"\" \"\n"
        );
        // What was written reads back the same.
        let text = format!(
            "name,url,username,password\n{}",
            export_row("https://x.test", "me", " p,w\"\n")
        );
        let back = parse_password_csv(&text).unwrap();
        assert_eq!(back[0].password, " p,w\"\n");
    }

    #[test]
    fn a_host_and_port_is_an_address_not_a_scheme() {
        assert_eq!(
            origin_of("localhost:3000").unwrap(),
            "http://localhost:3000"
        );
        assert_eq!(
            origin_of("192.168.1.1:8080").unwrap(),
            "http://192.168.1.1:8080"
        );
        assert_eq!(
            origin_of("127.0.0.1:5173/app").unwrap(),
            "http://127.0.0.1:5173"
        );
        assert_eq!(origin_of("printer.local").unwrap(), "http://printer.local");
        assert_eq!(
            origin_of("staging.test:8443").unwrap(),
            "https://staging.test:8443"
        );
        assert_eq!(origin_of(" github.com ").unwrap(), "https://github.com");
        // A real scheme is still judged as written.
        assert!(origin_of("mailto:me@x.test").is_err());
    }

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
