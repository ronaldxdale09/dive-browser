//! The page's right-click menu, the part the engine hands back to the app:
//! opening links and images in new tabs, copying addresses, saving,
//! searching a selection, and Dive's own entries (QR code, the agent,
//! the device simulator, Inspect). CEF carries out Back, Forward, Reload,
//! Print, View Source and the editing commands itself.

use tauri::{AppHandle, Manager};
use tauri_runtime_cef::{ContextMenuAction, ContextMenuCommand, ContextMenuOptions};
use tauri_specta::Event;

use dive_core::TabId;

use crate::Runtime;
use crate::error::{AppError, AppResult};
use crate::state::{AppState, lock};

/// Install the menu handler on a page view. Choices arrive on a CEF
/// thread and are carried to the main thread before anything is touched.
pub fn attach(app: &AppHandle<Runtime>, tab_id: TabId, view: &tauri::Webview<Runtime>) {
    let app = app.clone();
    if let Err(error) = view.with_webview(move |native| {
        // A private window refuses the agent, so the menu does not offer it.
        native.set_context_menu_options(ContextMenuOptions {
            agent: !crate::private_session::is_private(),
        });
        native.set_context_menu_handler(move |command| {
            let app = app.clone();
            let _ = app.clone().run_on_main_thread(move || {
                tracing::debug!(%tab_id, action = ?command.action, "page menu action");
                if let Err(error) = carry_out(&app, tab_id, &command) {
                    tracing::warn!(%tab_id, action = ?command.action, "page menu action failed: {error}");
                }
            });
        });
    }) {
        tracing::warn!(%tab_id, "page menu unavailable on this tab: {error}");
    }
}

/// The address a search for `selection` goes to, with the profile's engine
/// template (`{query}` stands for the encoded words).
pub fn search_url(template: &str, selection: &str) -> AppResult<String> {
    let query = selection.split_whitespace().collect::<Vec<_>>().join(" ");
    if query.is_empty() {
        return Err(AppError::new("nothing selected to search for"));
    }
    let encoded: String = url::form_urlencoded::byte_serialize(query.as_bytes()).collect();
    Ok(template.replace("{query}", &encoded))
}

/// The address that shows a page's source: Chromium's `view-source:` scheme
/// in front of the page, unless it already is one.
pub fn source_url_for(page_url: &str) -> AppResult<String> {
    if page_url.is_empty() {
        return Err(AppError::new(
            "this page has no address to show the source of",
        ));
    }
    if page_url.starts_with("view-source:") {
        return Ok(page_url.to_owned());
    }
    Ok(format!("view-source:{page_url}"))
}

fn carry_out(
    app: &AppHandle<Runtime>,
    tab_id: TabId,
    command: &ContextMenuCommand,
) -> AppResult<()> {
    let state = app.state::<AppState>();
    let Some(main) = crate::engine::MainThread::here() else {
        return Err(AppError::new("page menu action off the main thread"));
    };
    match command.action {
        ContextMenuAction::OpenLinkInNewTab => {
            open_beside(&main, app, &state, tab_id, &command.link_url)
        }
        ContextMenuAction::OpenImageInNewTab => {
            open_beside(&main, app, &state, tab_id, &command.source_url)
        }
        ContextMenuAction::CopyLink => copy(&command.link_url, "Copied the link"),
        ContextMenuAction::CopyImageAddress => {
            copy(&command.source_url, "Copied the image address")
        }
        ContextMenuAction::SaveImage => download(&state, tab_id, &command.source_url),
        ContextMenuAction::SavePage => download(&state, tab_id, &command.page_url),
        ContextMenuAction::SearchSelection => {
            let url = search_url(
                state.prefs.get(&state).search_template(),
                &command.selection,
            )?;
            open_beside(&main, app, &state, tab_id, &url)
        }
        ContextMenuAction::QrCode => chrome(app, "share.open"),
        ContextMenuAction::AskAgent => chrome(app, "sidecar.open"),
        ContextMenuAction::DeviceSimulator => chrome(app, "simulator.toggle"),
        ContextMenuAction::ViewSource => {
            let url = source_url_for(&command.page_url)?;
            open_beside(&main, app, &state, tab_id, &url)
        }
        ContextMenuAction::Inspect => crate::commands::with_view(&state, tab_id, |v| {
            v.open_devtools();
            Ok(())
        }),
    }
}

/// A new tab in the workspace the page's tab lives in.
fn open_beside(
    main: &crate::engine::MainThread,
    app: &AppHandle<Runtime>,
    state: &AppState,
    tab_id: TabId,
    url: &str,
) -> AppResult<()> {
    if url.is_empty() {
        return Err(AppError::new("that item has no address"));
    }
    let workspace = {
        let store = lock(&state.store);
        store.tab(tab_id).ok().and_then(|t| t.workspace_id)
    }
    .or(*lock(&state.active_workspace))
    .ok_or_else(|| AppError::new("no workspace to open the tab in"))?;
    crate::commands::open_tab(main, app, state, workspace, url)?;
    Ok(())
}

fn copy(text: &str, _done: &str) -> AppResult<()> {
    if text.is_empty() {
        return Err(AppError::new("that item has no address"));
    }
    arboard::Clipboard::new()
        .and_then(|mut c| c.set_text(text.to_owned()))
        .map_err(|e| AppError::new(format!("could not copy: {e}")))
}

/// Hand a URL to the engine's downloader; the download notice reports it.
fn download(state: &AppState, tab_id: TabId, url: &str) -> AppResult<()> {
    if url.is_empty() {
        return Err(AppError::new("that item has no address"));
    }
    let url = url.to_owned();
    crate::commands::with_view(state, tab_id, move |v| {
        v.with_webview(move |native| {
            use cef::{ImplBrowser, ImplBrowserHost};
            if let Some(host) = native.browser().host() {
                host.start_download(Some(&cef::CefString::from(url.as_str())));
            }
        })
    })
}

/// Run one of the chrome's own commands, the way the native menu does.
fn chrome(app: &AppHandle<Runtime>, command: &str) -> AppResult<()> {
    crate::menu::MenuCommand(command.to_owned()).emit_to(app, crate::CHROME_LABEL)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    #[test]
    fn view_source_wraps_the_page_address_once() {
        assert_eq!(
            super::source_url_for("https://a.test/x").unwrap(),
            "view-source:https://a.test/x"
        );
        assert_eq!(
            super::source_url_for("view-source:https://a.test/x").unwrap(),
            "view-source:https://a.test/x"
        );
        assert!(super::source_url_for("").is_err());
    }

    #[test]
    fn a_selection_becomes_a_search_with_the_profile_engine() {
        let url = super::search_url(
            "https://duckduckgo.com/?q={query}",
            "  rust   context\nmenu ",
        )
        .unwrap();
        assert_eq!(url, "https://duckduckgo.com/?q=rust+context+menu");
        assert!(super::search_url("https://duckduckgo.com/?q={query}", "   ").is_err());
    }
}
