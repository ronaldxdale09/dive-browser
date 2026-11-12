//! page commands.

// Tauri commands receive their arguments by value; that is the IPC contract.
#![allow(clippy::needless_pass_by_value)]

use dive_core::TabId;
use tauri::AppHandle;

use super::on_main;
use crate::Runtime;
use crate::error::{AppError, AppResult};
use crate::state::AppState;

/// Show just the article on a tab's page.
#[tauri::command]
#[specta::specta]
pub(crate) async fn page_reader(
    app: AppHandle<Runtime>,
    id: TabId,
) -> AppResult<crate::reader::ReaderResult> {
    use tauri::Manager as _;
    let state = app.state::<AppState>();
    crate::reader::enter(&state, id).await
}

/// Leave reader view, restoring the page.
#[tauri::command]
#[specta::specta]
pub(crate) async fn page_reader_leave(app: AppHandle<Runtime>, id: TabId) -> AppResult<()> {
    use tauri::Manager as _;
    let state = app.state::<AppState>();
    crate::reader::leave(&state, id).await
}

/// Whether a tab is showing reader view.
#[tauri::command]
#[specta::specta]
pub(crate) async fn page_reader_open(app: AppHandle<Runtime>, id: TabId) -> AppResult<bool> {
    use tauri::Manager as _;
    let state = app.state::<AppState>();
    crate::reader::is_open(&state, id).await
}

/// Translate a tab's page into `target`, on this machine.
#[tauri::command]
#[specta::specta]
pub(crate) async fn page_translate(
    app: AppHandle<Runtime>,
    id: TabId,
    target: String,
) -> AppResult<crate::translate::Translation> {
    use tauri::Manager as _;
    let state = app.state::<AppState>();
    crate::translate::translate(&state, id, &target).await
}

/// Put a translated page's own words back.
#[tauri::command]
#[specta::specta]
pub(crate) async fn page_translate_restore(app: AppHandle<Runtime>, id: TabId) -> AppResult<()> {
    use tauri::Manager as _;
    let state = app.state::<AppState>();
    crate::translate::restore(&state, id).await
}

/// What language a tab's page is in, and whether it has been translated.
#[tauri::command]
#[specta::specta]
pub(crate) async fn page_translate_state(
    app: AppHandle<Runtime>,
    id: TabId,
) -> AppResult<crate::translate::TranslateState> {
    use tauri::Manager as _;
    let state = app.state::<AppState>();
    crate::translate::state_of(&state, id).await
}

/// Every tab and what it is costing right now.
#[tauri::command]
#[specta::specta]
pub(crate) async fn tasks_list(
    app: AppHandle<Runtime>,
) -> AppResult<Vec<crate::task_manager::TaskRow>> {
    use tauri::Manager as _;
    let state = app.state::<AppState>();
    crate::task_manager::list(&state).await
}

/// Save the tab's live page as a single MHTML archive. Returns where it went,
/// or `None` when the person cancelled the dialog.
#[tauri::command]
#[specta::specta]
pub(crate) async fn page_save(app: AppHandle<Runtime>, id: TabId) -> AppResult<Option<String>> {
    let (session, suggested) = {
        use tauri::Manager as _;
        let state = app.state::<AppState>();
        crate::save_page::target(&state, id)?
    };
    let data = crate::save_page::archive(&session, id).await?;
    let Some(file) = rfd::AsyncFileDialog::new()
        .set_title("Save page")
        .set_file_name(&suggested)
        .add_filter("Web archive", &["mhtml"])
        .save_file()
        .await
    else {
        return Ok(None);
    };
    let path = file.path().to_owned();
    tokio::fs::write(&path, data.as_bytes())
        .await
        .map_err(|error| AppError::new(format!("could not write {}: {error}", path.display())))?;
    Ok(Some(path.to_string_lossy().into_owned()))
}

/// What the search engine thinks this query might be. Empty when the person
/// turned suggestions off, in a private session, or when the engine did not
/// answer in time -- the address bar shows what it knows either way.
#[tauri::command]
#[specta::specta]
pub(crate) async fn search_suggest(
    app: AppHandle<Runtime>,
    query: String,
) -> AppResult<Vec<String>> {
    if crate::private_session::is_private() {
        return Ok(Vec::new());
    }
    let (enabled, engine, network) = {
        use tauri::Manager as _;
        let state = app.state::<AppState>();
        let prefs = state.prefs.snapshot(&state);
        (
            prefs.search_suggestions,
            prefs.search_engine.clone(),
            prefs.network(),
        )
    };
    if !enabled {
        return Ok(Vec::new());
    }
    crate::search_suggest::suggest(&network, &engine, &query).await
}

/// Silence a tab, or let it be heard again.
#[tauri::command]
#[specta::specta]
pub(crate) fn tab_set_muted(app: AppHandle<Runtime>, id: TabId, muted: bool) -> AppResult<()> {
    on_main(&app, move |main, app, state| {
        crate::tab_audio::set_muted(main, app, state, id, muted);
        Ok(())
    })
}

/// What a tab is doing with sound right now, for a chrome that just opened.
#[tauri::command]
#[specta::specta]
pub(crate) fn tab_audio_state(id: TabId) -> crate::tab_audio::TabAudio {
    crate::tab_audio::snapshot(id)
}

/// Open a link that belongs to another app, optionally remembering the site.
#[tauri::command]
#[specta::specta]
pub(crate) fn external_link_open(
    app: AppHandle<Runtime>,
    token: String,
    always: bool,
) -> AppResult<()> {
    crate::external_link::answer(&app, &token, always)
}

/// Let go of a link the person did not want opened.
#[tauri::command]
#[specta::specta]
pub(crate) fn external_link_dismiss(app: AppHandle<Runtime>, token: String) {
    crate::external_link::dismiss(&app, &token);
}
