//! passwords commands.

// Tauri commands receive their arguments by value; that is the IPC contract.
#![allow(clippy::needless_pass_by_value)]

use dive_core::TabId;
use tauri::{AppHandle, State};

use super::active_profile;
use crate::Runtime;
use crate::error::{AppError, AppResult};
use crate::state::{AppState, lock};

/// Every login saved in the active profile.
#[tauri::command]
#[specta::specta]
pub(crate) fn passwords_list(state: State<'_, AppState>) -> AppResult<Vec<dive_core::Credential>> {
    let profile = active_profile(&lock(&state.store), *lock(&state.active_workspace))?;
    crate::passwords::list(&state, profile.id)
}

/// Logins saved for the site of `url`, most used first.
#[tauri::command]
#[specta::specta]
pub(crate) fn passwords_for_url(
    state: State<'_, AppState>,
    url: String,
) -> AppResult<Vec<dive_core::Credential>> {
    let profile = active_profile(&lock(&state.store), *lock(&state.active_workspace))?;
    crate::passwords::for_url(&state, profile.id, &url)
}

/// Run `work` against the app state on a blocking thread. Keychain reads
/// and writes wait on the OS, and the owner check waits on the person, so
/// neither may hold up the main thread or an async runtime worker.
async fn with_state_blocking<T: Send + 'static>(
    app: AppHandle<Runtime>,
    work: impl FnOnce(&AppState) -> AppResult<T> + Send + 'static,
) -> AppResult<T> {
    tauri::async_runtime::spawn_blocking(move || {
        use tauri::Manager as _;
        work(&app.state::<AppState>())
    })
    .await
    .map_err(AppError::new)?
}

fn active_profile_id(state: &AppState) -> AppResult<dive_core::ProfileId> {
    Ok(active_profile(&lock(&state.store), *lock(&state.active_workspace))?.id)
}

/// Add a login typed into Settings for the site of `url` in the active
/// profile. One already kept for that site and username is only written
/// over when `replace` says the person agreed to it.
#[tauri::command]
#[specta::specta]
pub(crate) async fn passwords_save(
    app: AppHandle<Runtime>,
    url: String,
    username: String,
    password: String,
    replace: bool,
) -> AppResult<crate::passwords::LoginSave> {
    with_state_blocking(app, move |state| {
        let profile = active_profile_id(state)?;
        crate::passwords::add(state, profile, &url, &username, &password, replace)
    })
    .await
}

/// Change a saved login's username and, when `password` is not empty, its
/// password.
#[tauri::command]
#[specta::specta]
pub(crate) async fn passwords_edit(
    app: AppHandle<Runtime>,
    id: String,
    username: String,
    password: String,
) -> AppResult<dive_core::Credential> {
    with_state_blocking(app, move |state| {
        let profile = active_profile_id(state)?;
        crate::passwords::edit(state, profile, &id, &username, &password)
    })
    .await
}

/// The password behind a saved login, once the OS has confirmed the owner
/// is at the keyboard. `None` when the person cancelled that check.
#[tauri::command]
#[specta::specta]
pub(crate) async fn passwords_reveal(
    app: AppHandle<Runtime>,
    id: String,
) -> AppResult<Option<String>> {
    with_state_blocking(app, move |state| {
        let profile = active_profile_id(state)?;
        crate::passwords::owned(state, profile, &id)?;
        if !crate::user_presence::confirm("show a saved password")? {
            return Ok(None);
        }
        crate::passwords::reveal(state, profile, &id).map(Some)
    })
    .await
}

/// Copy a saved login's password to the clipboard, concealed from clipboard
/// history and cleared again shortly, after the same owner check as showing
/// it. The password never passes through the chrome. False when the person
/// cancelled the check.
#[tauri::command]
#[specta::specta]
pub(crate) async fn passwords_copy(app: AppHandle<Runtime>, id: String) -> AppResult<bool> {
    with_state_blocking(app, move |state| {
        let profile = active_profile_id(state)?;
        crate::passwords::owned(state, profile, &id)?;
        if !crate::user_presence::confirm("copy a saved password")? {
            return Ok(false);
        }
        let password = crate::passwords::reveal(state, profile, &id)?;
        crate::clipboard_secret::write(&password)?;
        Ok(true)
    })
    .await
}

/// Write every login in the active profile, passwords in the clear, to a
/// CSV the person chooses, in the columns Chrome exports. Asks the OS to
/// confirm the owner first. `None` when that check or the save dialog was
/// cancelled.
#[tauri::command]
#[specta::specta]
pub(crate) async fn passwords_export(
    app: AppHandle<Runtime>,
) -> AppResult<Option<crate::passwords::PasswordExport>> {
    if !crate::user_presence::confirm_fresh_async("export your saved passwords").await? {
        return Ok(None);
    }
    let Some(file) = rfd::AsyncFileDialog::new()
        .set_title("Export saved passwords")
        .set_file_name("Dive Passwords.csv")
        .add_filter("CSV", &["csv"])
        .save_file()
        .await
    else {
        return Ok(None);
    };
    let path = file.path().to_owned();
    with_state_blocking(app, move |state| {
        let profile = active_profile_id(state)?;
        let (text, exported, failed) = crate::passwords::export_csv(state, profile)?;
        crate::passwords::write_private_file(&path, &text)?;
        Ok(Some(crate::passwords::PasswordExport {
            path: path.to_string_lossy().into_owned(),
            exported,
            failed,
        }))
    })
    .await
}

/// Note that a saved login was just filled, so the site's most used login
/// comes first next time.
#[tauri::command]
#[specta::specta]
pub(crate) fn passwords_used(state: State<'_, AppState>, id: String) -> AppResult<()> {
    crate::passwords::touch(&state, &id)
}

/// Saved addresses in the active profile.
#[tauri::command]
#[specta::specta]
pub(crate) fn addresses_list(state: State<'_, AppState>) -> AppResult<Vec<dive_core::Address>> {
    let store = lock(&state.store);
    let profile = active_profile(&store, *lock(&state.active_workspace))?;
    Ok(store.addresses(profile.id)?)
}

/// Save an address; an empty id creates one.
#[tauri::command]
#[specta::specta]
pub(crate) fn address_save(
    state: State<'_, AppState>,
    address: dive_core::Address,
) -> AppResult<dive_core::Address> {
    let profile = {
        let store = lock(&state.store);
        active_profile(&store, *lock(&state.active_workspace))?
    };
    crate::autofill::save_address(&state, profile.id, address)
}

/// Forget an address.
#[tauri::command]
#[specta::specta]
pub(crate) fn address_delete(state: State<'_, AppState>, id: String) -> AppResult<bool> {
    let store = lock(&state.store);
    let profile = active_profile(&store, *lock(&state.active_workspace))?;
    Ok(store.remove_address(profile.id, &id)?)
}

/// Put a saved address into the tab's form. `url` is the page the person
/// picked it on: a tab that has moved to another site since is not filled.
/// The address comes from the profile the tab belongs to, which is not
/// always the active one.
#[tauri::command]
#[specta::specta]
pub(crate) async fn address_fill(
    app: AppHandle<Runtime>,
    tab_id: TabId,
    id: String,
    url: String,
) -> AppResult<u32> {
    use tauri::Manager as _;
    let state = app.state::<AppState>();
    let profile = crate::credential_fill::profile_of_tab(&app, tab_id)
        .ok_or_else(|| AppError::new("that tab has no profile"))?;
    let address = lock(&state.store)
        .addresses(profile)?
        .into_iter()
        .find(|address| address.id == id)
        .ok_or_else(|| AppError::new("no such address"))?;
    let filled = crate::autofill::fill_into(
        &state,
        tab_id,
        profile,
        &url,
        crate::autofill::Wallet::Address(&address),
    )
    .await?;
    lock(&state.store).address_used(&id, dive_core::Timestamp::now())?;
    Ok(filled)
}

/// Saved cards in the active profile. Numbers are never included.
#[tauri::command]
#[specta::specta]
pub(crate) fn cards_list(state: State<'_, AppState>) -> AppResult<Vec<dive_core::Card>> {
    let store = lock(&state.store);
    let profile = active_profile(&store, *lock(&state.active_workspace))?;
    Ok(store.cards(profile.id)?)
}

/// Save a card: its listing here, its number in the keychain.
#[tauri::command]
#[specta::specta]
pub(crate) async fn card_save(
    app: AppHandle<Runtime>,
    draft: crate::autofill::CardDraft,
) -> AppResult<dive_core::Card> {
    with_state_blocking(app, move |state| {
        let profile = active_profile_id(state)?;
        crate::autofill::save_card(state, profile, &draft)
    })
    .await
}

/// Forget a card, keychain item and all.
#[tauri::command]
#[specta::specta]
pub(crate) async fn card_delete(app: AppHandle<Runtime>, id: String) -> AppResult<bool> {
    with_state_blocking(app, move |state| {
        let profile = active_profile_id(state)?;
        crate::autofill::delete_card(state, profile, &id)
    })
    .await
}

/// Put a saved card into the tab's form. This is the only path that reads a
/// card number, and only for the fill the person just asked for, on a page
/// with a field for it. `url` is the page the person picked it on, and the
/// card comes from the tab's own profile, as for an address.
#[tauri::command]
#[specta::specta]
pub(crate) async fn card_fill(
    app: AppHandle<Runtime>,
    tab_id: TabId,
    id: String,
    url: String,
) -> AppResult<u32> {
    use tauri::Manager as _;
    let state = app.state::<AppState>();
    let profile = crate::credential_fill::profile_of_tab(&app, tab_id)
        .ok_or_else(|| AppError::new("that tab has no profile"))?;
    crate::autofill::fill_into(
        &state,
        tab_id,
        profile,
        &url,
        crate::autofill::Wallet::Card(&id),
    )
    .await
}

/// Answer a save or update prompt: save the submitted login, or let it go.
#[tauri::command]
#[specta::specta]
pub(crate) fn passwords_answer(
    state: State<'_, AppState>,
    token: String,
    save: bool,
) -> AppResult<Option<dive_core::Credential>> {
    crate::credential_fill::answer(&state, &token, save)
}

/// Answer a save prompt with "never for this site"; returns the origin.
#[tauri::command]
#[specta::specta]
pub(crate) fn passwords_never(state: State<'_, AppState>, token: String) -> AppResult<String> {
    crate::credential_fill::never(&state, &token)
}

/// Sites the active profile never wants a save offered for.
#[tauri::command]
#[specta::specta]
pub(crate) fn passwords_never_list(state: State<'_, AppState>) -> AppResult<Vec<String>> {
    let profile = active_profile(&lock(&state.store), *lock(&state.active_workspace))?;
    crate::passwords::never_list(&state, profile.id)
}

/// Offer to save again for `origin`.
#[tauri::command]
#[specta::specta]
pub(crate) fn passwords_never_remove(
    state: State<'_, AppState>,
    origin: String,
) -> AppResult<bool> {
    let profile = active_profile(&lock(&state.store), *lock(&state.active_workspace))?;
    crate::passwords::never_remove(&state, profile.id, &origin)
}

/// Fill the chosen saved login into the tab's login form.
#[tauri::command]
#[specta::specta]
pub(crate) async fn passwords_fill(
    app: AppHandle<Runtime>,
    tab_id: TabId,
    id: String,
) -> AppResult<()> {
    crate::credential_fill::fill_into(app, tab_id, id).await
}

/// Ask for a password CSV export to import; `None` when the person cancels.
#[tauri::command]
#[specta::specta]
pub(crate) async fn passwords_pick_csv() -> Option<String> {
    rfd::AsyncFileDialog::new()
        .set_title("Import passwords from a CSV export")
        .add_filter("CSV", &["csv", "txt"])
        .pick_file()
        .await
        .map(|file| file.path().to_string_lossy().into_owned())
}

/// Import the logins in a CSV export into the active profile.
#[tauri::command]
#[specta::specta]
pub(crate) async fn passwords_import_csv(
    app: AppHandle<Runtime>,
    path: String,
) -> AppResult<crate::passwords::CsvImportSummary> {
    with_state_blocking(app, move |state| {
        let text = crate::passwords::read_csv_file(std::path::Path::new(&path))?;
        let profile = active_profile_id(state)?;
        crate::passwords::import_csv(state, profile, &text)
    })
    .await
}

/// Forget a saved login.
#[tauri::command]
#[specta::specta]
pub(crate) async fn passwords_delete(app: AppHandle<Runtime>, id: String) -> AppResult<bool> {
    with_state_blocking(app, move |state| {
        let profile = active_profile_id(state)?;
        crate::passwords::delete(state, profile, &id)
    })
    .await
}

/// Every form entry remembered in the active profile.
#[tauri::command]
#[specta::specta]
pub(crate) fn forms_list(state: State<'_, AppState>) -> AppResult<Vec<dive_core::FormEntry>> {
    let store = lock(&state.store);
    let profile = active_profile(&store, *lock(&state.active_workspace))?;
    Ok(store.form_entries(profile.id)?)
}

/// Forget one form entry.
#[tauri::command]
#[specta::specta]
pub(crate) fn forms_delete(state: State<'_, AppState>, id: String) -> AppResult<bool> {
    let store = lock(&state.store);
    let profile = active_profile(&store, *lock(&state.active_workspace))?;
    let owned = store.form_entries(profile.id)?.iter().any(|e| e.id == id);
    if !owned {
        return Ok(false);
    }
    Ok(store.remove_form_entry(&id)?)
}

/// Forget every form entry in the active profile; returns how many went.
#[tauri::command]
#[specta::specta]
pub(crate) fn forms_clear(state: State<'_, AppState>) -> AppResult<u32> {
    let store = lock(&state.store);
    let profile = active_profile(&store, *lock(&state.active_workspace))?;
    Ok(u32::try_from(store.clear_form_entries(profile.id)?).unwrap_or(u32::MAX))
}
