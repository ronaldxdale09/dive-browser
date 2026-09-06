//! Capped asset delivery facts. Request identities and URLs never leave this collector.
use serde_json::{Value, json};
use std::collections::HashMap;

const LIMIT: usize = 256;
const REQUEST_LIMIT: u64 = 64;

pub(super) struct NetworkFacts {
    admitted: bool,
    count: usize,
    next: u64,
    requests: HashMap<String, u64>,
}

impl NetworkFacts {
    pub(super) fn new(admitted: bool) -> Self {
        Self {
            admitted,
            count: 0,
            next: 0,
            requests: HashMap::new(),
        }
    }
    pub(super) fn full(&self) -> bool {
        self.count >= LIMIT
    }
    pub(super) fn collect(&mut self, method: &str, params: &Value) -> Option<Value> {
        if !self.admitted || self.full() {
            return None;
        }
        let request_id = params["requestId"]
            .as_str()
            .filter(|id| !id.is_empty() && id.len() <= 128)?;
        let row = match method {
            "Network.requestWillBeSent" => {
                // Redirects may reuse an identity. Never follow one outside the asset origin.
                let request = &params["request"];
                let asset = request["url"].as_str().is_some_and(|url| {
                    url.starts_with("asset://localhost/")
                        || url.starts_with("http://asset.localhost/")
                        || url.starts_with("https://asset.localhost/")
                });
                if !asset {
                    self.requests.remove(request_id);
                    return None;
                }
                let id = if let Some(id) = self.requests.get(request_id) {
                    *id
                } else {
                    if self.next >= REQUEST_LIMIT {
                        return None;
                    }
                    self.next += 1;
                    self.requests.insert(request_id.to_owned(), self.next);
                    self.next
                };
                let (start, end) = request_range(header(&request["headers"], "range"));
                let method = match request["method"].as_str() {
                    Some("GET") => "GET",
                    Some("HEAD") => "HEAD",
                    _ => "other",
                };
                let kind = match params["type"].as_str() {
                    Some("Media") => "media",
                    Some("Fetch") => "fetch",
                    Some("XHR") => "xhr",
                    _ => "other",
                };
                json!({"stage":"request","id":id,"method":method,"kind":kind,"rangeStart":start,"rangeEnd":end})
            }
            "Network.responseReceived" => {
                let id = self.requests.get(request_id)?;
                let response = &params["response"];
                let (start, end, total) =
                    response_range(header(&response["headers"], "content-range"));
                let length = header(&response["headers"], "content-length").and_then(decimal);
                let status = response["status"]
                    .as_u64()
                    .filter(|status| (100..=599).contains(status));
                json!({"stage":"response","id":id,"status":status,"rangeStart":start,"rangeEnd":end,"total":total,"length":length})
            }
            "Network.loadingFinished" => {
                let id = self.requests.remove(request_id)?;
                let bytes = params["encodedDataLength"]
                    .as_f64()
                    .filter(|v| v.is_finite() && *v >= 0.0);
                json!({"stage":"finished","id":id,"bytes":bytes})
            }
            "Network.loadingFailed" => {
                let id = self.requests.remove(request_id)?;
                let error = match params["errorText"].as_str() {
                    Some("net::ERR_REQUEST_RANGE_NOT_SATISFIABLE") => "range_not_satisfiable",
                    Some("net::ERR_CONTENT_LENGTH_MISMATCH") => "content_length_mismatch",
                    Some("net::ERR_ABORTED") => "aborted",
                    Some("net::ERR_FAILED") => "failed",
                    Some("net::ERR_FILE_NOT_FOUND") => "file_not_found",
                    Some("net::ERR_ACCESS_DENIED") => "access_denied",
                    Some("net::ERR_TIMED_OUT") => "timed_out",
                    _ => "other",
                };
                json!({"stage":"failed","id":id,"error":error,"canceled":params["canceled"].as_bool()})
            }
            _ => return None,
        };
        self.count += 1;
        Some(row)
    }
}

fn header<'a>(headers: &'a Value, name: &str) -> Option<&'a str> {
    headers
        .as_object()?
        .iter()
        .take(64)
        .find(|(key, _)| key.eq_ignore_ascii_case(name))?
        .1
        .as_str()
        .filter(|value| value.len() <= 128)
}
fn decimal(value: &str) -> Option<u64> {
    if value.is_empty() || !value.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    value.parse().ok()
}
fn request_range(value: Option<&str>) -> (Option<u64>, Option<u64>) {
    let parse = || {
        let (start, end) = value?.strip_prefix("bytes=")?.split_once('-')?;
        let start = decimal(start)?;
        let end = if end.is_empty() {
            None
        } else {
            Some(decimal(end)?)
        };
        if end.is_some_and(|end| end < start) {
            return None;
        }
        Some((Some(start), end))
    };
    parse().unwrap_or((None, None))
}
fn response_range(value: Option<&str>) -> (Option<u64>, Option<u64>, Option<u64>) {
    let parse = || {
        let (bounds, total) = value?.strip_prefix("bytes ")?.split_once('/')?;
        let (start, end) = bounds.split_once('-')?;
        let (start, end, total) = (decimal(start)?, decimal(end)?, decimal(total)?);
        if start > end || end >= total {
            return None;
        }
        Some((Some(start), Some(end), Some(total)))
    };
    parse().unwrap_or((None, None, None))
}

#[cfg(test)]
mod tests {
    use super::*;
    fn request(id: &str) -> Value {
        json!({"requestId":id,"type":"Media","request":{"url":"asset://localhost/private-path.mp4","method":"GET","headers":{"Range":"bytes=1024000-","Cookie":"secret"}}})
    }
    #[test]
    fn admission_and_asset_scope_are_required() {
        assert!(
            NetworkFacts::new(false)
                .collect("Network.requestWillBeSent", &request("1"))
                .is_none()
        );
        let mut capture = NetworkFacts::new(true);
        let mut external = request("1");
        external["request"]["url"] = json!("https://external/private");
        assert!(
            capture
                .collect("Network.requestWillBeSent", &external)
                .is_none()
        );
        assert!(
            capture
                .collect(
                    "Network.loadingFailed",
                    &json!({"requestId":"1","errorText":"secret"})
                )
                .is_none()
        );
        assert!(
            capture
                .collect("Network.requestWillBeSent", &request("1"))
                .is_some()
        );
    }
    #[test]
    fn nonzero_range_failure_is_correlated_without_sensitive_strings() {
        let mut capture = NetworkFacts::new(true);
        let req = capture
            .collect("Network.requestWillBeSent", &request("private-id"))
            .unwrap();
        assert_eq!(req["rangeStart"], 1_024_000);
        assert!(req["rangeEnd"].is_null());
        let fail = capture.collect("Network.loadingFailed", &json!({"requestId":"private-id","errorText":"net::ERR_REQUEST_RANGE_NOT_SATISFIABLE","canceled":false,"blockedReason":"secret"})).unwrap();
        assert_eq!(req["id"], fail["id"]);
        assert_eq!(fail["error"], "range_not_satisfiable");
        for row in [req, fail] {
            let text = row.to_string();
            assert!(!text.contains("private"));
            assert!(!text.contains("secret"));
            assert!(!text.contains("asset:"));
        }
        assert!(
            capture
                .collect("Network.loadingFailed", &json!({"requestId":"private-id"}))
                .is_none()
        );
    }
    #[test]
    fn successful_partial_response_reports_numeric_bounds_and_completion() {
        let mut capture = NetworkFacts::new(true);
        capture.collect("Network.requestWillBeSent", &request("1"));
        let row = capture.collect("Network.responseReceived", &json!({"requestId":"1","response":{"status":206,"headers":{"Content-Range":"bytes 1024000-2047999/4000000","Content-Length":"1024000","X-Secret":"private"}}})).unwrap();
        assert_eq!(row["status"], 206);
        assert_eq!(row["rangeStart"], 1_024_000);
        assert_eq!(row["rangeEnd"], 2_047_999);
        assert_eq!(row["total"], 4_000_000);
        assert_eq!(row["length"], 1_024_000);
        let done = capture
            .collect(
                "Network.loadingFinished",
                &json!({"requestId":"1","encodedDataLength":1_024_000}),
            )
            .unwrap();
        assert_eq!(done["bytes"].as_f64(), Some(1_024_000.0));
    }
    #[test]
    fn malformed_values_and_unknown_errors_are_not_copied() {
        let mut capture = NetworkFacts::new(true);
        capture.collect("Network.requestWillBeSent", &request("1"));
        let row = capture.collect("Network.responseReceived", &json!({"requestId":"1","response":{"status":"secret","headers":{"Content-Range":"bytes +1-2/3","Content-Length":"secret"}}})).unwrap();
        assert!(row["status"].is_null());
        assert!(row["rangeStart"].is_null());
        assert!(row["length"].is_null());
        let row = capture
            .collect(
                "Network.loadingFailed",
                &json!({"requestId":"1","errorText":"secret","canceled":"secret"}),
            )
            .unwrap();
        assert_eq!(row["error"], "other");
        assert!(row["canceled"].is_null());
        assert!(!row.to_string().contains("secret"));
    }
    #[test]
    fn both_record_and_identity_storage_are_bounded() {
        let mut capture = NetworkFacts::new(true);
        for index in 0..REQUEST_LIMIT {
            assert!(
                capture
                    .collect("Network.requestWillBeSent", &request(&index.to_string()))
                    .is_some()
            );
        }
        assert!(
            capture
                .collect("Network.requestWillBeSent", &request("overflow"))
                .is_none()
        );
        for _ in usize::try_from(REQUEST_LIMIT).unwrap()..LIMIT {
            assert!(
                capture
                    .collect(
                        "Network.responseReceived",
                        &json!({"requestId":"0","response":{"status":206}})
                    )
                    .is_some()
            );
        }
        assert!(capture.full());
        assert!(
            capture
                .collect("Network.loadingFinished", &json!({"requestId":"0"}))
                .is_none()
        );
        assert_eq!(
            capture.requests.len(),
            usize::try_from(REQUEST_LIMIT).unwrap()
        );
    }
}
