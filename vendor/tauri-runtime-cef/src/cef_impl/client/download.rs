// Copyright 2019-2024 Tauri Programme within The Commons Conservancy
// SPDX-License-Identifier: Apache-2.0
// SPDX-License-Identifier: MIT

use std::sync::Arc;

use cef::*;

wrap_download_handler! {
  pub struct TauriCefDownloadHandler {
    download_handler: Arc<tauri_runtime::webview::DownloadHandler>,
  }

  impl DownloadHandler {
    fn can_download(
      &self,
      _browser: Option<&mut Browser>,
      _url: Option<&CefStringUtf16>,
      _request_method: Option<&CefStringUtf16>,
    ) -> ::std::os::raw::c_int {
      // on_before_download is the one that actually validates the download.
      // so we return 1 to allow the download here
      1
    }

    fn on_before_download(
      &self,
      _browser: Option<&mut Browser>,
      download_item: Option<&mut DownloadItem>,
      suggested_name: Option<&CefStringUtf16>,
      callback: Option<&mut BeforeDownloadCallback>,
    ) -> ::std::os::raw::c_int {
      let Some(download_item) = download_item else {
        return 0;
      };
      let Some(callback) = callback else {
        return 0;
      };

      let url_str = CefString::from(&download_item.url()).to_string();
      let Ok(url) = url::Url::parse(&url_str) else {
        return 0;
      };

      let suggested_path = suggested_name
        .map(|s| s.to_string())
        .map(std::path::PathBuf::from)
        .unwrap_or_default();

      let mut destination = suggested_path.clone();

      // Call handler with Requested event.
      let should_allow =
        (self.download_handler)(tauri_runtime::webview::DownloadEvent::Requested {
          url: url.clone(),
          destination: &mut destination,
        });

      if should_allow {
        // Set the download path.
        let destination_cef = CefStringUtf16::from(destination.to_string_lossy().as_ref());

        // If the user callback did not modify the destination, show the dialog.
        let show_dialog = destination == suggested_path;
        callback.cont(Some(&destination_cef), show_dialog as ::std::os::raw::c_int);
      }

      1
    }

    fn on_download_updated(
      &self,
      _browser: Option<&mut Browser>,
      download_item: Option<&mut DownloadItem>,
      callback: Option<&mut DownloadItemCallback>,
    ) {
      let Some(download_item) = download_item else {
        return;
      };

      // Get download URL.
      let url_str = CefString::from(&download_item.url()).to_string();
      let Ok(url) = url::Url::parse(&url_str) else {
        return;
      };

      // Cancelling, pausing and resuming are only possible through the
      // callback CEF lends for the length of this call, so a request made
      // while nothing was in flight is applied on the next update.
      let id = download_item.id();
      if let Some(callback) = callback
        && let Some(action) = crate::downloads::take_control(id)
      {
        match action {
          crate::downloads::Control::Cancel => callback.cancel(),
          crate::downloads::Control::Pause => callback.pause(),
          crate::downloads::Control::Resume => callback.resume(),
        }
      }

      // Check download state - CEF returns i32 where 0 is false, non-zero is true.
      let is_complete = download_item.is_complete() != 0;
      let is_canceled = download_item.is_canceled() != 0;
      let success = is_complete && !is_canceled;

      // Get full path if available - full_path() returns CefStringUserfreeUtf16.
      let full_path = if is_complete || is_canceled {
        let path_cef = download_item.full_path();
        let path_str = CefString::from(&path_cef).to_string();
        if !path_str.is_empty() {
          Some(std::path::PathBuf::from(path_str))
        } else {
          None
        }
      } else {
        None
      };

      // What the chrome needs to draw a bar. Tauri's handler has no variant
      // for this, so it goes out through the runtime's own channel.
      let received = download_item.received_bytes().max(0);
      let total = download_item.total_bytes();
      crate::downloads::report(
        &crate::downloads::DownloadProgress {
          id,
          url: url_str.clone(),
          path: {
            let path = CefString::from(&download_item.full_path()).to_string();
            path
          },
          #[allow(clippy::cast_sign_loss)] // clamped to zero above.
          received: received as u64,
          // A chunked response reports no total; the chrome shows what has
          // arrived rather than inventing a percentage.
          #[allow(clippy::cast_sign_loss)]
          total: (total > 0).then_some(total as u64),
          #[allow(clippy::cast_sign_loss)]
          speed: download_item.current_speed().max(0) as u64,
          paused: download_item.is_paused() != 0,
        },
        is_complete || is_canceled,
      );

      // Only call handler when download is finished (complete or canceled).
      if is_complete || is_canceled {
        // Call handler with Finished event.
        (self.download_handler)(tauri_runtime::webview::DownloadEvent::Finished {
          url,
          path: full_path,
          success,
        });
      }
    }
  }
}
