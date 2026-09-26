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

      // Check download state - CEF returns i32 where 0 is false, non-zero is true.
      let is_complete = download_item.is_complete() != 0;
      let is_canceled = download_item.is_canceled() != 0;
      // An interrupted download (a full disk, a refused file, the network
      // gone) is neither complete nor cancelled, and the engine sends no
      // further updates for it. Reporting only the other two left it in the
      // list as in flight forever, with a Cancel that did nothing.
      let interrupted = (download_item.is_interrupted() != 0 && !is_complete && !is_canceled)
        .then(|| interrupt_reason(download_item));
      let success = is_complete && !is_canceled;
      let over = is_complete || is_canceled;

      // Cancelling, pausing and resuming go through the callback CEF lends
      // with each update. It is kept until the download is over for good, so
      // a cancel applies at once and an interrupted download can still be
      // resumed or cancelled; a request made before the first update waits
      // for it.
      let id = download_item.id();
      if let Some(callback) = callback {
        if over {
          crate::downloads::release(id);
        } else {
          crate::downloads::hold(id, callback.clone());
        }
        if let Some(action) = crate::downloads::take_control(id) {
          match action {
            crate::downloads::Control::Cancel => callback.cancel(),
            crate::downloads::Control::Pause => callback.pause(),
            crate::downloads::Control::Resume => callback.resume(),
          }
        }
      } else if over {
        crate::downloads::release(id);
      }
      // Reported once per interruption: the engine may repeat the update,
      // and each repeat would otherwise read as a second failure.
      let newly_interrupted = match &interrupted {
        Some(_) => crate::downloads::mark_interrupted(id),
        None => {
          crate::downloads::clear_interrupted(id);
          false
        }
      };
      let finished = over || newly_interrupted;

      // Get full path if available - full_path() returns CefStringUserfreeUtf16.
      let full_path = if finished {
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
          interrupted: interrupted.clone(),
        },
        finished,
      );
      if interrupted.is_some() && !newly_interrupted {
        return;
      }

      // Only call handler when download is finished (complete, canceled, or
      // interrupted, which is a failure until someone resumes it).
      if finished {
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

/// Chromium's name for why `item` was interrupted, without its prefix.
fn interrupt_reason(item: &DownloadItem) -> String {
    let reason = item.interrupt_reason();
    let reason: &cef::sys::cef_download_interrupt_reason_t = reason.as_ref();
    // The generated enum's debug form is the C name; the prefix says nothing.
    let name = format!("{reason:?}");
    name.strip_prefix("CEF_DOWNLOAD_INTERRUPT_REASON_")
        .unwrap_or(&name)
        .to_owned()
}
