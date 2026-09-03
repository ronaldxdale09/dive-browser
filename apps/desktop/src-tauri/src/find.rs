//! Find in page. The runtime has no native find API, so a small script walks
//! text nodes, counts matches, and selects the requested one.

use dive_cdp::CdpSession;
use serde::{Deserialize, Serialize};
use serde_json::json;
use specta::Type;

use crate::error::{AppError, AppResult};

/// Result of a find step.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, Type)]
pub struct FindResult {
    /// Total matches in the document.
    pub total: u32,
    /// 1-based index of the selected match, 0 when none.
    pub current: u32,
}

const SCRIPT: &str = r"(function(query, index){
  const sel = window.getSelection();
  if (!query) { sel && sel.removeAllRanges(); return {total:0,current:0}; }
  const needle = query.toLowerCase();
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
    acceptNode(n){
      const p = n.parentElement; if (!p) return NodeFilter.FILTER_REJECT;
      const tag = p.tagName; if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT') return NodeFilter.FILTER_REJECT;
      const cs = getComputedStyle(p); if (cs.display === 'none' || cs.visibility === 'hidden') return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    }});
  const ranges = [];
  let node;
  while ((node = walker.nextNode())) {
    const text = node.nodeValue.toLowerCase(); let from = 0;
    while (true) { const i = text.indexOf(needle, from); if (i === -1) break;
      const r = document.createRange(); r.setStart(node, i); r.setEnd(node, i + needle.length); ranges.push(r); from = i + needle.length; }
  }
  const total = ranges.length;
  if (!total) { sel && sel.removeAllRanges(); return {total:0,current:0}; }
  const cur = ((index - 1) % total + total) % total;
  const r = ranges[cur];
  sel.removeAllRanges(); sel.addRange(r);
  const el = r.startContainer.parentElement; if (el && el.scrollIntoView) el.scrollIntoView({block:'center', inline:'nearest'});
  return {total, current: cur + 1};
})";

/// Select match number `index` (1-based, wraps) of `query`.
pub async fn find(session: &CdpSession, query: &str, index: i32) -> AppResult<FindResult> {
    let expression = format!(
        "JSON.stringify({SCRIPT}({}, {index}))",
        serde_json::to_string(query).unwrap_or_default()
    );
    let result = session
        .call(
            "Runtime.evaluate",
            json!({"expression": expression, "returnByValue": true}),
        )
        .await
        .map_err(AppError::new)?;
    let raw = result["result"]["value"].as_str().unwrap_or("{}");
    Ok(serde_json::from_str(raw).unwrap_or_default())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn query_is_json_escaped_into_the_expression() {
        let q = serde_json::to_string("a \"quoted\" </script>").unwrap();
        assert!(q.starts_with('"') && q.contains("\\\""));
        let r: FindResult = serde_json::from_str(r#"{"total":3,"current":2}"#).unwrap();
        assert_eq!(
            r,
            FindResult {
                total: 3,
                current: 2
            }
        );
    }
}
