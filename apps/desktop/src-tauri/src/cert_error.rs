//! A page whose certificate the network would not accept.
//!
//! Chromium stops such a request and asks the embedder. Nothing answered, so
//! every one of them simply failed: an expired certificate on a staging
//! server, a self-signed one on a box on the desk, the same as a forged one
//! on a bank's address, with no way past any of them and no explanation
//! beyond an error code.
//!
//! The chrome now shows an interstitial. Going back is the answer it leads
//! with; proceeding is there, plainly marked unsafe, and it is remembered only
//! for this session and only for the exact certificate the person looked at:
//! the same host presenting a different certificate later is asked about
//! again, because that is precisely what an attack looks like.
//!
//! Errors the engine will not let anyone override (HSTS, a pinned key) come
//! without a way to continue. Those are refused as before; the page fails
//! and the error panel explains it.

use std::collections::{HashMap, HashSet};
use std::sync::Mutex;

use dive_core::TabId;
use serde::{Deserialize, Serialize};
use specta::Type;
use tauri::AppHandle;
use tauri_specta::Event;

use crate::Runtime;

/// A page's certificate was refused, and the person can decide.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type, Event)]
pub struct CertErrorAsked {
    pub tab_id: TabId,
    /// Opaque; pass it back to `cert_error_answer`.
    pub request_id: String,
    /// The address that was asked for.
    pub url: String,
    /// Its host, as the unsafe button names it.
    pub host: String,
    /// Chromium's name for the error, such as `ERR_CERT_AUTHORITY_INVALID`.
    pub error: String,
}

/// A certificate question that is no longer waiting.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type, Event)]
pub struct CertErrorClosed {
    pub tab_id: TabId,
    pub request_id: String,
}

/// One exception the person made: this host, with this certificate.
type Exception = (String, String);

/// A question waiting on the person, with the engine's hold on the request.
struct Pending<D> {
    asked: CertErrorAsked,
    fingerprint: String,
    decision: D,
}

/// The questions waiting, one per tab, and the exceptions granted this
/// session. Generic over the engine's decision so the bookkeeping can be
/// tested without one.
pub struct Book<D> {
    pending: HashMap<TabId, Pending<D>>,
    allowed: HashSet<Exception>,
    next: u64,
}

impl<D> Default for Book<D> {
    fn default() -> Self {
        Self {
            pending: HashMap::new(),
            allowed: HashSet::new(),
            next: 1,
        }
    }
}

/// What to do with a certificate error that just arrived.
pub enum Arrival<D> {
    /// The person already accepted this very certificate for this host.
    Proceed(D),
    /// Ask. A question the tab was still showing is replaced; its decision
    /// is handed back to be refused.
    Ask {
        asked: CertErrorAsked,
        replaced: Option<(String, D)>,
    },
}

impl<D> Book<D> {
    /// A certificate error for `url` in `tab_id`, with a way to continue.
    pub fn arrive(
        &mut self,
        tab_id: TabId,
        url: &str,
        error: &str,
        fingerprint: Option<&str>,
        decision: D,
    ) -> Arrival<D> {
        let host = url::Url::parse(url)
            .ok()
            .and_then(|url| url.host_str().map(str::to_ascii_lowercase))
            .unwrap_or_default();
        let fingerprint = fingerprint.unwrap_or_default().to_owned();
        // An exception without a certificate to pin it to would cover
        // whatever the host presented next; there is no such exception.
        if !fingerprint.is_empty() && self.allowed.contains(&(host.clone(), fingerprint.clone())) {
            return Arrival::Proceed(decision);
        }
        let asked = CertErrorAsked {
            tab_id,
            request_id: format!("cert-{}", self.next),
            url: url.to_owned(),
            host,
            error: error.to_owned(),
        };
        self.next += 1;
        let replaced = self
            .pending
            .insert(
                tab_id,
                Pending {
                    asked: asked.clone(),
                    fingerprint,
                    decision,
                },
            )
            .map(|old| (old.asked.request_id, old.decision));
        Arrival::Ask { asked, replaced }
    }

    /// The person answered. Proceeding remembers the exception for the rest
    /// of the session. `None` when the question is no longer waiting.
    pub fn answer(&mut self, tab_id: TabId, request_id: &str, proceed: bool) -> Option<D> {
        if self
            .pending
            .get(&tab_id)
            .is_none_or(|pending| pending.asked.request_id != request_id)
        {
            return None;
        }
        let pending = self.pending.remove(&tab_id)?;
        if proceed && !pending.fingerprint.is_empty() {
            self.allowed
                .insert((pending.asked.host, pending.fingerprint));
        }
        Some(pending.decision)
    }

    /// The tab closed or moved on: its question, if any, goes.
    pub fn take_tab(&mut self, tab_id: TabId) -> Option<(String, D)> {
        self.pending
            .remove(&tab_id)
            .map(|pending| (pending.asked.request_id, pending.decision))
    }

    /// The question waiting in `tab_id`, for a chrome that reloaded.
    pub fn asked(&self, tab_id: TabId) -> Option<&CertErrorAsked> {
        self.pending.get(&tab_id).map(|pending| &pending.asked)
    }
}

#[cfg(feature = "cef")]
type Decision = tauri_runtime_cef::CertificateDecision;
#[cfg(not(feature = "cef"))]
type Decision = ();

/// The application's certificate questions.
#[derive(Default)]
pub struct Registry(Mutex<Book<Decision>>);

impl Registry {
    fn book(&self) -> std::sync::MutexGuard<'_, Book<Decision>> {
        crate::state::lock(&self.0)
    }
}

fn registry() -> &'static Registry {
    // A static rather than a field on the application state: the engine's
    // callback runs before any state handle is needed, and this is the only
    // place the questions live.
    static REGISTRY: std::sync::OnceLock<Registry> = std::sync::OnceLock::new();
    REGISTRY.get_or_init(Registry::default)
}

/// Listen to a tab view's certificate errors. CEF asks inside its own
/// callback on the main thread; the question goes to the chrome from a task.
#[cfg(feature = "cef")]
pub fn attach(app: &AppHandle<Runtime>, tab_id: TabId, view: &tauri::Webview<Runtime>) {
    let app = app.clone();
    let _ = view.with_webview(move |native| {
        native.set_certificate_error_handler(move |error, decision| {
            tracing::warn!(%tab_id, error = %error.error, url = %error.url, "certificate refused");
            // Without a decision the engine will not allow an exception;
            // the request is already refused and the error panel says why.
            let Some(decision) = decision else {
                return;
            };
            let arrival = registry().book().arrive(
                tab_id,
                &error.url,
                &error.error,
                error.fingerprint.as_deref(),
                decision,
            );
            match arrival {
                Arrival::Proceed(decision) => decision.proceed(),
                Arrival::Ask { asked, replaced } => {
                    let app = app.clone();
                    if let Some((request_id, old)) = replaced {
                        old.refuse();
                        emit_soon(&app, CertErrorClosed { tab_id, request_id });
                    }
                    emit_soon(&app, asked);
                }
            }
        });
    });
}

/// Answer a certificate question. Proceeding continues the request and
/// remembers this host and certificate until Dive quits; refusing lets the
/// navigation fail. False when the question had already gone.
pub fn answer(app: &AppHandle<Runtime>, tab_id: TabId, request_id: &str, proceed: bool) -> bool {
    let Some(decision) = registry().book().answer(tab_id, request_id, proceed) else {
        return false;
    };
    // Answered outside the lock: continuing can re-enter the engine, and
    // the engine can report the next error from inside that call.
    #[cfg(feature = "cef")]
    if proceed {
        decision.proceed();
    } else {
        decision.refuse();
    }
    #[cfg(not(feature = "cef"))]
    let () = decision;
    let _ = CertErrorClosed {
        tab_id,
        request_id: request_id.to_owned(),
    }
    .emit(app);
    true
}

/// The question still waiting in `tab_id`, if any.
pub fn pending(tab_id: TabId) -> Option<CertErrorAsked> {
    registry().book().asked(tab_id).cloned()
}

/// `tab_id` closed: refuse whatever it was asking.
pub fn forget_tab(app: &AppHandle<Runtime>, tab_id: TabId) {
    let taken = registry().book().take_tab(tab_id);
    if let Some((request_id, decision)) = taken {
        drop(decision);
        let _ = CertErrorClosed { tab_id, request_id }.emit(app);
    }
}

/// Emit from a task: CEF asks from inside its own callback.
#[cfg(feature = "cef")]
fn emit_soon<E: Event + Serialize + Clone + Send + 'static>(app: &AppHandle<Runtime>, event: E) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let _ = event.emit(&app);
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    const URL: &str = "https://staging.example.com/login";

    fn ask(book: &mut Book<u32>, tab: TabId, fingerprint: &str, decision: u32) -> CertErrorAsked {
        match book.arrive(
            tab,
            URL,
            "ERR_CERT_AUTHORITY_INVALID",
            Some(fingerprint),
            decision,
        ) {
            Arrival::Ask { asked, .. } => asked,
            Arrival::Proceed(_) => panic!("expected a question"),
        }
    }

    #[test]
    fn a_proceed_is_remembered_for_that_certificate_only() {
        let mut book = Book::default();
        let tab = TabId::new();
        let asked = ask(&mut book, tab, "aa", 1);
        assert_eq!(asked.host, "staging.example.com");
        assert_eq!(book.answer(tab, &asked.request_id, true), Some(1));
        // The same certificate again goes straight through.
        assert!(matches!(
            book.arrive(tab, URL, "ERR_CERT_AUTHORITY_INVALID", Some("aa"), 2),
            Arrival::Proceed(2)
        ));
        // A different certificate on the same host is asked about again:
        // that is what an attack after the first visit looks like.
        let again = ask(&mut book, tab, "bb", 3);
        assert_eq!(again.host, "staging.example.com");
    }

    #[test]
    fn going_back_remembers_nothing() {
        let mut book = Book::default();
        let tab = TabId::new();
        let asked = ask(&mut book, tab, "aa", 1);
        assert_eq!(book.answer(tab, &asked.request_id, false), Some(1));
        ask(&mut book, tab, "aa", 2);
    }

    #[test]
    fn an_answer_counts_once_and_only_for_its_own_question() {
        let mut book = Book::default();
        let tab = TabId::new();
        let first = ask(&mut book, tab, "aa", 1);
        let Arrival::Ask {
            asked: second,
            replaced,
        } = book.arrive(tab, URL, "ERR_CERT_DATE_INVALID", Some("aa"), 2)
        else {
            panic!("expected a question");
        };
        assert_eq!(
            replaced,
            Some((first.request_id.clone(), 1)),
            "the older question is handed back to be refused"
        );
        assert_eq!(book.answer(tab, &first.request_id, true), None);
        assert_eq!(book.answer(tab, &second.request_id, true), Some(2));
        assert_eq!(book.answer(tab, &second.request_id, true), None);
    }

    #[test]
    fn a_certificate_without_a_fingerprint_is_never_remembered() {
        let mut book: Book<u32> = Book::default();
        let tab = TabId::new();
        let Arrival::Ask { asked, .. } = book.arrive(tab, URL, "ERR_CERT_INVALID", None, 1) else {
            panic!("expected a question");
        };
        book.answer(tab, &asked.request_id, true);
        assert!(matches!(
            book.arrive(tab, URL, "ERR_CERT_INVALID", None, 2),
            Arrival::Ask { .. }
        ));
    }

    #[test]
    fn a_closed_tab_takes_its_question_with_it() {
        let mut book = Book::default();
        let (tab, other) = (TabId::new(), TabId::new());
        let asked = ask(&mut book, tab, "aa", 1);
        ask(&mut book, other, "aa", 2);
        assert_eq!(book.take_tab(tab), Some((asked.request_id, 1)));
        assert_eq!(book.asked(tab), None);
        assert!(book.asked(other).is_some());
    }
}
