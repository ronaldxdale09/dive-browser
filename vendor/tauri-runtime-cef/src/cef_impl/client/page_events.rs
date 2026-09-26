// Copyright 2019-2024 Tauri Programme within The Commons Conservancy
// SPDX-License-Identifier: Apache-2.0
// SPDX-License-Identifier: MIT

//! Page lifecycle and find results handed to the application.
//!
//! Several CEF callbacks have nothing to do with a Tauri webview event but
//! everything to do with a browser tab: the moment a page agrees to close
//! (after its `beforeunload` handler had its say), the results of the
//! engine's own find in page, the renderer process dying or hanging, and a
//! certificate the network stack would not accept. All are delivered on
//! CEF's UI thread, so the application's handlers must hand the work on
//! rather than re-enter the runtime from inside the callback.

use std::sync::{Arc, Mutex};

use cef::*;

/// One report from the engine's find in page.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct FindUpdate {
    /// The search this report belongs to; a new query starts a new one.
    pub identifier: i32,
    /// Matches found so far on the page, frames included.
    pub count: i32,
    /// 1-based position of the highlighted match, 0 when there is none.
    pub active_match_ordinal: i32,
    /// Whether the engine has finished counting for this search.
    pub final_update: bool,
}

/// Why a page's renderer process went away, as the engine reported it.
///
/// The distinction matters to whoever recovers the page: a crash is worth a
/// reload, but a process the system killed for memory, or that someone
/// ended, would only be killed again by reloading it straight away.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RendererExit {
    /// The process crashed.
    Crashed,
    /// The process exited with a non-zero status.
    Abnormal,
    /// The process was killed: by the system, the task manager, or a person
    /// ending a page that stopped responding.
    Killed,
    /// The process ran out of memory.
    OutOfMemory,
    /// The process could not be started, or failed its integrity check.
    LaunchFailed,
    /// A status this build does not know.
    Other,
}

impl RendererExit {
    fn from_status(status: &TerminationStatus) -> Self {
        use cef::sys::cef_termination_status_t as Status;
        let status: &Status = status.as_ref();
        match status {
            Status::TS_PROCESS_CRASHED => Self::Crashed,
            Status::TS_ABNORMAL_TERMINATION => Self::Abnormal,
            Status::TS_PROCESS_WAS_KILLED => Self::Killed,
            Status::TS_PROCESS_OOM => Self::OutOfMemory,
            Status::TS_LAUNCH_FAILED | Status::TS_INTEGRITY_FAILURE => Self::LaunchFailed,
            _ => Self::Other,
        }
    }
}

/// The engine's hold on a renderer that stopped responding. Chromium keeps
/// waiting until one of these is called; dropping it leaves it waiting.
#[derive(Clone)]
pub struct UnresponsiveRenderer(UnresponsiveProcessCallback);

// SAFETY: CEF's implementation of this callback is reference counted with
// atomic counts and posts `wait` and `terminate` to its UI thread when they
// are called from any other, so it may be held and dropped anywhere.
unsafe impl Send for UnresponsiveRenderer {}
unsafe impl Sync for UnresponsiveRenderer {}

impl UnresponsiveRenderer {
    /// Keep waiting. The engine starts its hang timer again, and reports the
    /// page once more if it is still stuck when the timer runs out.
    pub fn wait(&self) {
        self.0.wait();
    }

    /// End the renderer process. The page then reports its termination as
    /// [`RendererExit::Killed`].
    pub fn terminate(&self) {
        self.0.terminate();
    }
}

/// Something that happened to a page's renderer process.
#[derive(Clone)]
pub enum RendererEvent {
    /// The process is gone and the page with it.
    Terminated {
        /// Why, as far as the engine knows.
        exit: RendererExit,
        /// The platform's exit code for the process.
        error_code: i32,
    },
    /// The page has not answered input for a while. The engine waits until
    /// told otherwise through the callback.
    Unresponsive(UnresponsiveRenderer),
    /// A page that was reported unresponsive answers again.
    Responsive,
}

/// A certificate the network stack refused for a page's own address.
#[derive(Debug, Clone)]
pub struct CertificateError {
    /// The address that was asked for.
    pub url: String,
    /// Chromium's name for the error, such as `ERR_CERT_AUTHORITY_INVALID`.
    pub error: String,
    /// SHA-256 of the server's certificate, hex encoded, when it sent one.
    /// An exception made for one certificate must not carry over to another
    /// the same host presents later.
    pub fingerprint: Option<String>,
}

/// The engine's hold on a request stopped by a certificate error. It stays
/// stopped until one of these is called; dropping it refuses the request.
pub struct CertificateDecision(Option<Callback>);

// SAFETY: as for `UnresponsiveRenderer`: CEF posts the answer to its UI
// thread when it arrives from another.
unsafe impl Send for CertificateDecision {}
unsafe impl Sync for CertificateDecision {}

impl CertificateDecision {
    /// Load the page anyway.
    pub fn proceed(mut self) {
        if let Some(callback) = self.0.take() {
            callback.cont();
        }
    }

    /// Refuse the request; the navigation fails with the certificate error.
    pub fn refuse(mut self) {
        if let Some(callback) = self.0.take() {
            callback.cancel();
        }
    }
}

impl Drop for CertificateDecision {
    fn drop(&mut self) {
        // A request nobody answers would stay open for the life of the tab.
        if let Some(callback) = self.0.take() {
            callback.cancel();
        }
    }
}

type CloseListener = Arc<dyn Fn() + Send + Sync>;
type FindListener = Arc<dyn Fn(FindUpdate) + Send + Sync>;
type RendererListener = Arc<dyn Fn(RendererEvent) + Send + Sync>;
type CertificateListener =
    Arc<dyn Fn(CertificateError, Option<CertificateDecision>) + Send + Sync>;

/// Per-webview hand-off for page close acceptance, find results, renderer
/// health and certificate errors.
#[derive(Default)]
pub struct PageEvents {
    close: Mutex<Option<CloseListener>>,
    find: Mutex<Option<FindListener>>,
    renderer: Mutex<Option<RendererListener>>,
    certificate: Mutex<Option<CertificateListener>>,
}

impl PageEvents {
    /// `handler` hears when the engine has committed to closing this page,
    /// whoever asked: a graceful close the page allowed, a forced close, or
    /// the page's own `window.close()`.
    pub fn install_close(&self, handler: CloseListener) {
        *self.close.lock().unwrap() = Some(handler);
    }

    /// `handler` receives every find report for this page.
    pub fn install_find(&self, handler: FindListener) {
        *self.find.lock().unwrap() = Some(handler);
    }

    /// `handler` hears when this page's renderer dies, hangs, or recovers
    /// from a hang, on every platform.
    pub fn install_renderer(&self, handler: RendererListener) {
        *self.renderer.lock().unwrap() = Some(handler);
    }

    /// `handler` hears about certificate errors on this page's own address.
    /// With a decision it may answer at any later time; without one the
    /// error cannot be overridden (HSTS, pinning) and is refused already.
    pub fn install_certificate(&self, handler: CertificateListener) {
        *self.certificate.lock().unwrap() = Some(handler);
    }

    fn renderer(&self, event: RendererEvent) -> bool {
        let handler = self.renderer.lock().unwrap().clone();
        let heard = handler.is_some();
        if let Some(handler) = handler {
            handler(event);
        }
        heard
    }

    pub(crate) fn renderer_terminated(&self, status: &TerminationStatus, error_code: i32) {
        self.renderer(RendererEvent::Terminated {
            exit: RendererExit::from_status(status),
            error_code,
        });
    }

    /// Returns whether anyone took the callback. Without a listener the
    /// engine's default applies: an indefinite wait.
    pub(crate) fn renderer_unresponsive(&self, callback: UnresponsiveProcessCallback) -> bool {
        self.renderer(RendererEvent::Unresponsive(UnresponsiveRenderer(callback)))
    }

    pub(crate) fn renderer_responsive(&self) {
        self.renderer(RendererEvent::Responsive);
    }

    /// Hand a certificate error on. Returns whether the listener took the
    /// decision; false means the request is refused now.
    pub(crate) fn certificate_error(
        &self,
        error: CertificateError,
        callback: Option<Callback>,
    ) -> bool {
        let handler = self.certificate.lock().unwrap().clone();
        let Some(handler) = handler else {
            return false;
        };
        let recoverable = callback.is_some();
        handler(error, callback.map(|c| CertificateDecision(Some(c))));
        recoverable
    }

    pub(crate) fn closing(&self) {
        // Taken out of the lock before the call, so a handler that installs
        // another (or drops this webview's last reference) cannot deadlock.
        let handler = self.close.lock().unwrap().clone();
        if let Some(handler) = handler {
            handler();
        }
    }

    fn found(&self, update: FindUpdate) {
        let handler = self.find.lock().unwrap().clone();
        if let Some(handler) = handler {
            handler(update);
        }
    }
}

wrap_find_handler! {
  pub struct TauriCefFindHandler { events: Arc<PageEvents> }
  impl FindHandler {
    fn on_find_result(&self, _browser: Option<&mut Browser>, identifier: i32, count: i32, _selection_rect: Option<&Rect>, active_match_ordinal: i32, final_update: i32) {
      self.events.found(FindUpdate { identifier, count, active_match_ordinal, final_update: final_update != 0 });
    }
  }
}
