//! Remembered per-site zoom levels, kept in memory.
//!
//! A tab's zoom is put back on every address change, and single-page apps
//! change address on every click. Reading the level from the store each time
//! took the store's lock on the main thread for a value that only changes
//! when the person zooms. The levels are read from the store once and kept
//! here; the one place that writes them updates both.

use std::collections::HashMap;
use std::sync::Mutex;

use dive_core::Store;

/// Settings key prefix for a site's remembered zoom factor.
pub const SITE_ZOOM_PREFIX: &str = "zoom:";

/// The levels could not be loaded because the store was busy.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct StoreBusy;

/// The zoom levels people chose, by origin.
#[derive(Default)]
pub struct SiteZooms {
    /// `None` until first read from the store.
    levels: Mutex<Option<HashMap<String, f64>>>,
}

impl SiteZooms {
    /// The level remembered for `origin`, reading the store the first time.
    ///
    /// `store` is asked for only while nothing has been loaded. When it
    /// answers `None` the store was busy, and the caller tries again later.
    pub fn level(
        &self,
        origin: &str,
        store: impl FnOnce() -> Option<Vec<(String, String)>>,
    ) -> Result<Option<f64>, StoreBusy> {
        let mut levels = self
            .levels
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if levels.is_none() {
            *levels = Some(parse(store().ok_or(StoreBusy)?));
        }
        Ok(levels.as_ref().and_then(|l| l.get(origin).copied()))
    }

    /// Record that `origin` now opens at `factor`, or at the default when
    /// `None`. Call after the store has been written.
    pub fn remember(&self, origin: &str, factor: Option<f64>) {
        let mut levels = self
            .levels
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        // Not loaded yet: the first read will find this in the store.
        let Some(levels) = levels.as_mut() else {
            return;
        };
        match factor {
            Some(factor) => levels.insert(origin.to_owned(), factor),
            None => levels.remove(origin),
        };
    }
}

fn parse(settings: Vec<(String, String)>) -> HashMap<String, f64> {
    settings
        .into_iter()
        .filter_map(|(key, value)| {
            let origin = key.strip_prefix(SITE_ZOOM_PREFIX)?;
            Some((origin.to_owned(), value.parse::<f64>().ok()?))
        })
        .collect()
}

/// The process's remembered levels.
pub fn cache() -> &'static SiteZooms {
    static CACHE: std::sync::OnceLock<SiteZooms> = std::sync::OnceLock::new();
    CACHE.get_or_init(SiteZooms::default)
}

/// Every remembered level in `store`, for [`SiteZooms::level`].
pub fn stored(store: &Store) -> Option<Vec<(String, String)>> {
    store.settings_with_prefix(SITE_ZOOM_PREFIX).ok()
}

/// What a page's zoom is keyed on: its origin, or `""` for a page without
/// one (`file:`, `data:`, an error page). Pages without an origin all share
/// the default zoom, which is what they are put back to when a tab arrives
/// from a site that was zoomed.
pub fn key_of(url: &str) -> String {
    dive_core::origin_of(url).unwrap_or_default()
}

/// Host of `url`, which is what the engine keeps zoom levels by.
pub fn host_of(url: &str) -> Option<String> {
    url::Url::parse(url)
        .ok()?
        .host_str()
        .map(str::to_ascii_lowercase)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn levels_load_once_and_follow_writes() {
        let zooms = SiteZooms::default();
        let mut reads = 0;
        let mut read = || {
            reads += 1;
            Some(vec![
                ("zoom:https://a.dev".to_owned(), "1.25".to_owned()),
                ("zoom:https://bad.dev".to_owned(), "nope".to_owned()),
            ])
        };
        assert_eq!(zooms.level("https://a.dev", &mut read), Ok(Some(1.25)));
        assert_eq!(zooms.level("https://bad.dev", &mut read), Ok(None));
        assert_eq!(reads, 1, "the store is read once");
        zooms.remember("https://b.dev", Some(0.9));
        zooms.remember("https://a.dev", None);
        assert_eq!(zooms.level("https://b.dev", || None), Ok(Some(0.9)));
        assert_eq!(zooms.level("https://a.dev", || None), Ok(None));
    }

    #[test]
    fn a_busy_store_is_tried_again_and_early_writes_wait_for_the_load() {
        let zooms = SiteZooms::default();
        zooms.remember("https://a.dev", Some(2.0));
        assert_eq!(zooms.level("https://a.dev", || None), Err(StoreBusy));
        assert_eq!(
            zooms.level("https://a.dev", || Some(vec![(
                "zoom:https://a.dev".to_owned(),
                "2".to_owned()
            )])),
            Ok(Some(2.0))
        );
    }

    #[test]
    fn pages_without_an_origin_share_one_key() {
        assert_eq!(key_of("https://a.dev/x?y#z"), "https://a.dev");
        assert_eq!(key_of("file:///Users/me/a.html"), "");
        assert_eq!(key_of("data:text/html,hi"), "");
        assert_eq!(host_of("https://A.dev:8080/x").as_deref(), Some("a.dev"));
        assert_eq!(host_of("data:text/html,hi"), None);
    }
}
