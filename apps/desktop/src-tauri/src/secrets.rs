//! The process's credential store: chosen once at startup (the OS store, or an in-memory one for private and test runs) and used by every feature that keeps a secret.

use crate::error::{AppError, AppResult};

/// Install the OS credential store once at startup.
pub fn init() {
    init_with(
        crate::private_session::is_private()
            || std::env::var_os("DIVE_USE_MOCK_KEYCHAIN").is_some(),
        || {
            #[cfg(target_os = "macos")]
            match apple_native_keyring_store::keychain::Store::new() {
                Ok(store) => keyring_core::set_default_store(store),
                Err(e) => tracing::warn!("keychain unavailable: {e}"),
            }
            // Credential Manager is the Windows equivalent. Leaving this out
            // does not fail loudly -- `keyring_core` simply has no default
            // store, and every attempt to save an API key errors instead.
            #[cfg(target_os = "windows")]
            match windows_native_keyring_store::Store::new() {
                Ok(store) => keyring_core::set_default_store(store),
                Err(e) => tracing::warn!("credential manager unavailable: {e}"),
            }
        },
    );
}

pub(crate) fn init_with(use_mock: bool, native: impl FnOnce()) {
    if use_mock {
        // Match Chromium's explicit test switch. No OS store is even created,
        // and no credential survives this disposable process.
        let store =
            keyring_core::mock::Store::new().expect("initialize disposable credential store");
        keyring_core::set_default_store(store);
        tracing::info!("agent credentials use an isolated in-memory test store");
    } else {
        native();
    }
}

/// The keychain item for `id` under `service`.
pub fn entry(service: &str, id: &str) -> AppResult<keyring_core::Entry> {
    keyring_core::Entry::new(service, id).map_err(AppError::new)
}

/// A fresh in-memory credential store for tests that touch saved secrets.
#[cfg(test)]
pub(crate) mod test_keychain {
    static KEYCHAIN: std::sync::Mutex<()> = std::sync::Mutex::new(());

    /// Puts back whatever default store was installed, even on a panic.
    struct Restore(Option<std::sync::Arc<keyring_core::api::CredentialStore>>);

    impl Drop for Restore {
        fn drop(&mut self) {
            match self.0.take() {
                Some(store) => keyring_core::set_default_store(store),
                None => drop(keyring_core::unset_default_store()),
            }
        }
    }

    /// Run `f` with a fresh in-memory credential store as the process default,
    /// restoring whatever was there. Holds a lock: the default store is global.
    pub(crate) fn with_mock_keychain<T>(f: impl FnOnce() -> T) -> T {
        let _held = KEYCHAIN
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let _restore = Restore(keyring_core::get_default_store());
        super::init_with(true, || panic!("tests never use the native keychain"));
        f()
    }
}
