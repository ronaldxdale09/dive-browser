//! HAR 1.2 export of the captured requests of one tab.

use serde_json::{Value, json};

use crate::buffers::RequestSummary;

/// Build a HAR log for `requests` captured on `page_url`.
pub fn from_requests(page_url: &str, title: &str, requests: &[RequestSummary]) -> Value {
    let page_started = requests.first().map_or_else(
        || dive_core::Timestamp::now().to_rfc3339(),
        |r| rfc3339(r.wall_time),
    );
    let entries: Vec<Value> = requests.iter().map(entry).collect();
    json!({
        "log": {
            "version": "1.2",
            "creator": {"name": "Dive", "version": env!("CARGO_PKG_VERSION")},
            "pages": [{
                "startedDateTime": page_started,
                "id": "page_1",
                "title": if title.is_empty() { page_url } else { title },
                "pageTimings": {}
            }],
            "entries": entries
        }
    })
}

fn entry(r: &RequestSummary) -> Value {
    let time_ms = r
        .finished_at
        .map_or(0.0, |end| ((end - r.started_at) * 1000.0).max(0.0));
    let query: Vec<Value> = url::Url::parse(&r.url)
        .ok()
        .iter()
        .flat_map(url::Url::query_pairs)
        .map(|(k, v)| json!({"name": k, "value": v}))
        .collect();
    let body_size = r.encoded_length.unwrap_or(-1.0);
    let mut request = json!({
        "method": r.method,
        "url": r.url,
        "httpVersion": "",
        "cookies": [],
        "headers": headers(&r.headers),
        "queryString": query,
        "headersSize": -1,
        "bodySize": r.post_data.as_ref().map_or(0, String::len),
    });
    if let Some(post) = &r.post_data {
        request["postData"] = json!({"mimeType": header(&r.headers, "content-type"), "text": post});
    }
    let mut content = json!({"size": body_size, "mimeType": r.mime_type});
    if let Some(body) = &r.response_body {
        content["text"] = Value::String(body.clone());
    }
    let mut response = json!({
        "status": r.status.unwrap_or(0),
        "statusText": "",
        "httpVersion": "",
        "cookies": [],
        "headers": headers(&r.response_headers),
        "content": content,
        "redirectURL": header(&r.response_headers, "location"),
        "headersSize": -1,
        "bodySize": body_size,
    });
    if let Some(error) = &r.error {
        response["_error"] = Value::String(error.clone());
    }
    json!({
        "pageref": "page_1",
        "startedDateTime": rfc3339(r.wall_time),
        "time": time_ms,
        "request": request,
        "response": response,
        "cache": {},
        // Only the whole round trip is known; HAR requires the three fields.
        "timings": {"send": 0, "wait": time_ms, "receive": 0},
        "_resourceType": r.resource_type,
    })
}

fn headers(map: &std::collections::BTreeMap<String, String>) -> Vec<Value> {
    map.iter()
        .map(|(k, v)| json!({"name": k, "value": v}))
        .collect()
}

fn header<'a>(map: &'a std::collections::BTreeMap<String, String>, name: &str) -> &'a str {
    map.iter()
        .find(|(k, _)| k.eq_ignore_ascii_case(name))
        .map_or("", |(_, v)| v.as_str())
}

/// Epoch seconds to RFC 3339.
fn rfc3339(epoch_seconds: f64) -> String {
    #[allow(clippy::cast_possible_truncation)]
    let nanos = (epoch_seconds * 1e9).round() as i128;
    time::OffsetDateTime::from_unix_timestamp_nanos(nanos)
        .unwrap_or(time::OffsetDateTime::UNIX_EPOCH)
        .format(&time::format_description::well_known::Rfc3339)
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn req() -> RequestSummary {
        RequestSummary {
            id: "1".into(),
            url: "https://api.dev/users?page=2".into(),
            method: "GET".into(),
            resource_type: "Fetch".into(),
            status: Some(200),
            mime_type: "application/json".into(),
            encoded_length: Some(120.0),
            error: None,
            headers: [("Accept".to_owned(), "application/json".to_owned())].into(),
            post_data: None,
            response_body: Some("[]".into()),
            response_headers: [("content-type".to_owned(), "application/json".to_owned())].into(),
            started_at: 10.0,
            wall_time: 1_700_000_000.5,
            finished_at: Some(10.25),
        }
    }

    #[test]
    fn builds_a_har_entry_with_timing_and_query() {
        let har = from_requests("https://api.dev/", "API", &[req()]);
        let e = &har["log"]["entries"][0];
        assert_eq!(e["time"], 250.0);
        assert_eq!(e["startedDateTime"], "2023-11-14T22:13:20.5Z");
        assert_eq!(e["request"]["queryString"][0]["name"], "page");
        assert_eq!(e["response"]["content"]["text"], "[]");
        assert_eq!(e["response"]["headers"][0]["name"], "content-type");
        assert_eq!(har["log"]["pages"][0]["title"], "API");
    }

    #[test]
    fn failed_requests_keep_the_error() {
        let mut r = req();
        r.status = None;
        r.error = Some("net::ERR_FAILED".into());
        let har = from_requests("https://api.dev/", "", &[r]);
        assert_eq!(
            har["log"]["entries"][0]["response"]["_error"],
            "net::ERR_FAILED"
        );
        assert_eq!(har["log"]["pages"][0]["title"], "https://api.dev/");
    }
}
