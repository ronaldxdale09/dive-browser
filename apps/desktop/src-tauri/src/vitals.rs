//! Web Vitals read from the page's buffered performance entries on demand.
//! No script needs to be injected at load time; INP is best-effort because it
//! only exists after real interactions.

use dive_cdp::CdpSession;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use specta::Type;

use crate::error::{AppError, AppResult};

/// Core metrics in milliseconds (CLS is unitless).
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, Type)]
pub struct Vitals {
    /// Time to first byte.
    pub ttfb: Option<f64>,
    /// First contentful paint.
    pub fcp: Option<f64>,
    /// Largest contentful paint.
    pub lcp: Option<f64>,
    /// Cumulative layout shift.
    pub cls: Option<f64>,
    /// Interaction to next paint (worst interaction so far).
    pub inp: Option<f64>,
    /// `DOMContentLoaded`.
    pub dcl: Option<f64>,
    /// Load event end.
    pub load: Option<f64>,
    /// Transfer size of the document in bytes.
    pub transfer_size: Option<f64>,
    /// Element description of the LCP candidate, when known.
    pub lcp_element: Option<String>,
}

const SCRIPT: &str = r"(function(){
  const nav = performance.getEntriesByType('navigation')[0];
  const paint = performance.getEntriesByType('paint');
  const fcp = paint.find(p => p.name === 'first-contentful-paint');
  const buffered = (type, opts) => { const out = []; try { const po = new PerformanceObserver(() => {}); po.observe(Object.assign({type, buffered: true}, opts||{})); out.push(...po.takeRecords()); po.disconnect(); } catch (e) {} return out; };
  const lcps = buffered('largest-contentful-paint'); const lcp = lcps[lcps.length - 1];
  const shifts = buffered('layout-shift').filter(s => !s.hadRecentInput);
  const cls = shifts.reduce((a, s) => a + s.value, 0);
  const events = buffered('event', {durationThreshold: 16}); const inp = events.length ? Math.max(...events.map(e => e.duration)) : null;
  const desc = el => el ? (el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + (el.className && typeof el.className === 'string' ? '.' + el.className.trim().split(/\s+/).slice(0,2).join('.') : '')) : null;
  return JSON.stringify({
    ttfb: nav ? nav.responseStart : null,
    fcp: fcp ? fcp.startTime : null,
    lcp: lcp ? lcp.startTime : null,
    cls: shifts.length ? cls : (lcps.length || fcp ? 0 : null),
    inp,
    dcl: nav ? nav.domContentLoadedEventEnd : null,
    load: nav ? nav.loadEventEnd : null,
    transfer_size: nav ? nav.transferSize : null,
    lcp_element: lcp ? desc(lcp.element) : null,
  });
})()";

/// Read the metrics for a tab.
pub async fn read(session: &CdpSession) -> AppResult<Vitals> {
    let result = session
        .call(
            "Runtime.evaluate",
            json!({"expression": SCRIPT, "returnByValue": true}),
        )
        .await
        .map_err(AppError::new)?;
    let raw = result["result"]["value"].as_str().unwrap_or("{}");
    Ok(parse(&serde_json::from_str(raw).unwrap_or_default()))
}

/// Map the script's JSON to the struct, treating non-numbers as unknown.
pub fn parse(v: &Value) -> Vitals {
    let num = |k: &str| v[k].as_f64();
    Vitals {
        ttfb: num("ttfb"),
        fcp: num("fcp"),
        lcp: num("lcp"),
        cls: num("cls"),
        inp: num("inp"),
        dcl: num("dcl"),
        load: num("load"),
        transfer_size: num("transfer_size"),
        lcp_element: v["lcp_element"].as_str().map(str::to_owned),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_partial_results() {
        let v = parse(
            &json!({"ttfb": 120.5, "lcp": 900, "cls": 0.02, "inp": null, "lcp_element": "img#hero"}),
        );
        assert_eq!(v.ttfb, Some(120.5));
        assert_eq!(v.lcp, Some(900.0));
        assert_eq!(v.inp, None);
        assert_eq!(v.fcp, None);
        assert_eq!(v.lcp_element.as_deref(), Some("img#hero"));
        assert_eq!(parse(&json!({})), Vitals::default());
    }
}
