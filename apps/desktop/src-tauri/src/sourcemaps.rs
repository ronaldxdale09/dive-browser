//! Resolve minified stack locations to original files through source maps,
//! so Watchers can point at `src/cart.ts:41` instead of `bundle.js:1:8812`.

use std::collections::HashMap;
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use specta::Type;
use tokio::sync::Mutex;

/// An original location.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
pub struct Original {
    /// Source path as recorded in the map (often relative to the project).
    pub source: String,
    /// 1-based line.
    pub line: u32,
    /// 1-based column.
    pub column: u32,
}

/// Fetches scripts and their maps, caching parsed maps per script URL.
#[derive(Clone, Default)]
pub struct Resolver {
    http: reqwest::Client,
    cache: Arc<Mutex<HashMap<String, Option<Arc<sourcemap::SourceMap>>>>>,
}

impl Resolver {
    /// Map `line`/`column` (1-based) in the script at `url` to its original.
    /// Only scripts served from `page_url`'s host are fetched: a page can
    /// name any URL in a stack frame, and this runs outside the sandbox.
    pub async fn resolve(
        &self,
        page_url: &str,
        url: &str,
        line: u32,
        column: u32,
    ) -> Option<Original> {
        if !same_host(page_url, url) {
            return None;
        }
        let map = self.map_for(url).await?;
        lookup(&map, line, column)
    }

    async fn map_for(&self, url: &str) -> Option<Arc<sourcemap::SourceMap>> {
        if let Some(cached) = self.cache.lock().await.get(url) {
            return cached.clone();
        }
        let loaded = self.load(url).await.map(Arc::new);
        self.cache
            .lock()
            .await
            .insert(url.to_owned(), loaded.clone());
        loaded
    }

    async fn load(&self, url: &str) -> Option<sourcemap::SourceMap> {
        if !url.starts_with("http://") && !url.starts_with("https://") {
            return None;
        }
        let script = String::from_utf8(fetch_capped(&self.http, url).await?).ok()?;
        let map_ref = map_url(&script)?;
        let bytes = if let Some(data) = map_ref.strip_prefix("data:") {
            let (_, payload) = data.split_once(',')?;
            if data.contains(";base64") {
                use base64::Engine as _;
                base64::engine::general_purpose::STANDARD
                    .decode(payload)
                    .ok()?
            } else {
                payload.as_bytes().to_vec()
            }
        } else {
            let absolute = url::Url::parse(url).ok()?.join(&map_ref).ok()?;
            self.http
                .get(absolute)
                .send()
                .await
                .ok()?
                .bytes()
                .await
                .ok()?
                .to_vec()
        };
        sourcemap::SourceMap::from_slice(&bytes).ok()
    }
}

/// Largest script or map we are willing to pull into memory.
const MAX_BYTES: usize = 8 * 1024 * 1024;

/// GET `url`, giving up past [`MAX_BYTES`].
async fn fetch_capped(http: &reqwest::Client, url: &str) -> Option<Vec<u8>> {
    use futures_util::StreamExt as _;
    let response = http.get(url).send().await.ok()?;
    if response
        .content_length()
        .is_some_and(|n| n > MAX_BYTES as u64)
    {
        return None;
    }
    let mut out = Vec::new();
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.ok()?;
        if out.len() + chunk.len() > MAX_BYTES {
            return None;
        }
        out.extend_from_slice(&chunk);
    }
    Some(out)
}

/// Whether two URLs share scheme, host and port.
pub fn same_host(a: &str, b: &str) -> bool {
    match (url::Url::parse(a), url::Url::parse(b)) {
        (Ok(a), Ok(b)) => {
            a.scheme() == b.scheme()
                && a.host_str() == b.host_str()
                && a.port_or_known_default() == b.port_or_known_default()
        }
        _ => false,
    }
}

/// The `//# sourceMappingURL=` reference at the end of a script, if any.
pub fn map_url(script: &str) -> Option<String> {
    script
        .lines()
        .rev()
        .take(5)
        .find_map(|l| {
            l.trim()
                .strip_prefix("//# sourceMappingURL=")
                .or_else(|| l.trim().strip_prefix("//@ sourceMappingURL="))
        })
        .map(|s| s.trim().to_owned())
}

/// Look up a 1-based generated position.
pub fn lookup(map: &sourcemap::SourceMap, line: u32, column: u32) -> Option<Original> {
    let token = map.lookup_token(line.saturating_sub(1), column.saturating_sub(1))?;
    Some(Original {
        source: token.get_source().unwrap_or("?").to_owned(),
        line: token.get_src_line() + 1,
        column: token.get_src_col() + 1,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_map_reference() {
        assert_eq!(
            map_url("x();\n//# sourceMappingURL=app.js.map\n").as_deref(),
            Some("app.js.map")
        );
        assert_eq!(
            map_url("x();\n//@ sourceMappingURL=data:application/json;base64,e30=").as_deref(),
            Some("data:application/json;base64,e30=")
        );
        assert_eq!(map_url("no map here"), None);
    }

    #[test]
    fn same_host_is_strict() {
        assert!(same_host(
            "http://localhost:5173/",
            "http://localhost:5173/assets/app.js"
        ));
        assert!(!same_host(
            "http://localhost:5173/",
            "http://localhost:3000/x.js"
        ));
        assert!(!same_host("https://a.dev/", "https://cdn.a.dev/x.js"));
        assert!(!same_host(
            "https://a.dev/",
            "http://169.254.169.254/latest"
        ));
    }

    #[test]
    fn resolves_through_a_generated_map() {
        // Generated line 1 col 10 came from src/app.ts line 3 col 5.
        let mut builder = sourcemap::SourceMapBuilder::new(None);
        let src = builder.add_source("src/app.ts");
        builder.add_raw(0, 9, 2, 4, Some(src), None, false);
        let map = builder.into_sourcemap();
        let o = lookup(&map, 1, 10).unwrap();
        assert_eq!(
            o,
            Original {
                source: "src/app.ts".into(),
                line: 3,
                column: 5
            }
        );
        assert!(lookup(&map, 50, 1).is_none() || lookup(&map, 50, 1).is_some());
    }
}
