//! HAR 1.2 export of the captured requests of one tab.
//!
//! A HAR is made to be attached to a bug report, so secrets are redacted:
//! credential headers are dropped, and secret-named headers, query
//! parameters, form fields and JSON keys keep their name but lose their
//! value. Redaction is by name, never by guessing at the value.

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
                "title": if title.is_empty() { sanitize_url(page_url) } else { title.to_owned() },
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
    let safe_url = sanitize_url(&r.url);
    let query: Vec<Value> = url::Url::parse(&safe_url)
        .ok()
        .iter()
        .flat_map(url::Url::query_pairs)
        .map(|(k, v)| json!({"name": k, "value": v}))
        .collect();
    let body_size = r.encoded_length.unwrap_or(-1.0);
    let mut request = json!({
        "method": r.method,
        "url": safe_url,
        "httpVersion": "",
        "cookies": [],
        "headers": headers(&r.headers),
        "queryString": query,
        "headersSize": -1,
        "bodySize": r.post_data.as_ref().map_or(0, String::len),
    });
    if let Some(post) = &r.post_data {
        let mime = header(&r.headers, "content-type");
        request["postData"] = match sanitize_body(mime, post) {
            Some(text) => json!({"mimeType": mime, "text": text}),
            None => json!({"mimeType": mime, "text": "", "comment": OMITTED_MULTIPART}),
        };
    }
    let mut content = json!({"size": body_size, "mimeType": r.mime_type});
    if let Some(body) = &r.response_body {
        match sanitize_body(&r.mime_type, body) {
            Some(text) => content["text"] = Value::String(text),
            None => content["comment"] = Value::String(OMITTED_MULTIPART.to_owned()),
        }
    } else if let Some(note) = &r.response_body_note {
        content["comment"] = Value::String(note.clone());
    }
    let location = header(&r.response_headers, "location");
    let redirect = if location.is_empty() {
        String::new()
    } else {
        sanitize_url(location)
    };
    let mut response = json!({
        "status": r.status.unwrap_or(0),
        "statusText": "",
        "httpVersion": "",
        "cookies": [],
        "headers": headers(&r.response_headers),
        "content": content,
        "redirectURL": redirect,
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

/// Headers that carry a credential: whoever has them is signed in as the
/// person. A HAR is made to be attached to a bug report, and is written to
/// the captures folder, so these are left out the way Chrome's sanitized
/// export leaves them out. Other secret-named headers, query parameters,
/// form fields and JSON keys are kept but redacted (see `is_sensitive_key`).
const CREDENTIAL_HEADERS: &[&str] = &[
    "cookie",
    "set-cookie",
    "authorization",
    "proxy-authorization",
];

const REDACTED: &str = "[redacted]";
const OMITTED_MULTIPART: &str = "multipart body omitted from the export";

/// Whether a header, query, form or JSON key names a secret. Mirrors
/// `isSensitiveKey` in `src/lib/curl.ts`; the two must change together.
pub(crate) fn is_sensitive_key(name: &str) -> bool {
    let key = name.to_ascii_lowercase();
    if ["code", "sig", "key", "otp"].contains(&key.as_str()) {
        return true;
    }
    if [
        "token",
        "secret",
        "password",
        "passwd",
        "pwd",
        "apikey",
        "api_key",
        "api-key",
        "session",
        "signature",
        "credential",
        "csrf",
        "xsrf",
    ]
    .iter()
    .any(|word| key.contains(word))
    {
        return true;
    }
    // "author" and "authored" are not secrets, but "authorization" is.
    key.contains("auth") && (!key.contains("author") || key.contains("authoriz"))
}

fn headers(map: &std::collections::BTreeMap<String, String>) -> Vec<Value> {
    map.iter()
        .filter(|(k, _)| !CREDENTIAL_HEADERS.iter().any(|c| k.eq_ignore_ascii_case(c)))
        .map(|(k, v)| {
            let value = if is_sensitive_key(k) { REDACTED } else { v };
            json!({"name": k, "value": value})
        })
        .collect()
}

/// Redact the values of sensitive keys in a `k=v&k=v` string.
fn redact_pairs(raw: &str) -> Option<String> {
    let pairs: Vec<(String, String)> = url::form_urlencoded::parse(raw.as_bytes())
        .map(|(k, v)| (k.into_owned(), v.into_owned()))
        .collect();
    if !pairs.iter().any(|(k, _)| is_sensitive_key(k)) {
        return None;
    }
    let mut out = url::form_urlencoded::Serializer::new(String::new());
    for (k, v) in &pairs {
        out.append_pair(k, if is_sensitive_key(k) { REDACTED } else { v });
    }
    Some(out.finish())
}

/// A URL that is safe to write out: no userinfo, and secret-named query
/// parameters (and fragment parameters, where the OAuth implicit flow puts
/// `access_token`) carry `[redacted]` instead of their value.
fn sanitize_url(raw: &str) -> String {
    let Ok(mut parsed) = url::Url::parse(raw) else {
        return raw.to_owned();
    };
    let _ = parsed.set_username("");
    let _ = parsed.set_password(None);
    let pairs: Vec<(String, String)> = parsed
        .query_pairs()
        .map(|(k, v)| (k.into_owned(), v.into_owned()))
        .collect();
    if pairs.iter().any(|(k, _)| is_sensitive_key(k)) {
        let redacted: Vec<(String, String)> = pairs
            .into_iter()
            .map(|(k, v)| {
                let v = if is_sensitive_key(&k) {
                    REDACTED.to_owned()
                } else {
                    v
                };
                (k, v)
            })
            .collect();
        parsed.query_pairs_mut().clear().extend_pairs(redacted);
    }
    if let Some(fragment) = parsed.fragment().and_then(redact_pairs) {
        parsed.set_fragment(Some(&fragment));
    }
    parsed.to_string()
}

fn redact_json(value: &mut Value) {
    match value {
        Value::Object(map) => {
            for (k, v) in map.iter_mut() {
                if is_sensitive_key(k) {
                    *v = Value::String(REDACTED.to_owned());
                } else {
                    redact_json(v);
                }
            }
        }
        Value::Array(items) => items.iter_mut().for_each(redact_json),
        _ => {}
    }
}

/// A body that is safe to write out, or `None` when it is left out entirely
/// (multipart). Only JSON and form bodies are rewritten; anything else, and a
/// "JSON" body that does not parse, is kept as it is.
fn sanitize_body(mime: &str, text: &str) -> Option<String> {
    let mime = mime.to_ascii_lowercase();
    if mime.contains("json") {
        return Some(match serde_json::from_str::<Value>(text) {
            Ok(mut value) => {
                redact_json(&mut value);
                value.to_string()
            }
            Err(_) => text.to_owned(),
        });
    }
    if mime.starts_with("application/x-www-form-urlencoded") {
        return Some(redact_pairs(text).unwrap_or_else(|| text.to_owned()));
    }
    if mime.starts_with("multipart/") {
        return None;
    }
    Some(text.to_owned())
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
            response_body_note: None,
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
    fn omitted_body_exports_a_reason_without_an_empty_sample() {
        let mut r = req();
        r.response_body = None;
        r.response_body_note = Some("Response exceeds the 64 KiB capture limit".into());
        let har = from_requests("https://api.dev/", "", &[r]);
        let content = &har["log"]["entries"][0]["response"]["content"];
        assert!(content.get("text").is_none());
        assert_eq!(
            content["comment"],
            "Response exceeds the 64 KiB capture limit"
        );
    }

    #[test]
    fn credentials_never_reach_the_file() {
        let mut r = req();
        r.headers.insert("Cookie".into(), "sid=secret".into());
        r.headers
            .insert("authorization".into(), "Bearer secret".into());
        r.headers
            .insert("Proxy-Authorization".into(), "Basic secret".into());
        r.response_headers
            .insert("Set-Cookie".into(), "sid=secret; HttpOnly".into());
        let har = from_requests("https://api.dev/", "", &[r]);
        let text = serde_json::to_string(&har).unwrap();
        assert!(!text.contains("secret"), "{text}");
        // The rest of the headers are still there to debug with.
        let e = &har["log"]["entries"][0];
        assert_eq!(e["request"]["headers"][0]["name"], "Accept");
        assert_eq!(e["response"]["headers"][0]["name"], "content-type");
    }

    #[test]
    fn query_tokens_are_redacted_in_url_and_query_string() {
        let mut r = req();
        r.url = "https://api.dev/cb?code=abc&page=2".into();
        let har = from_requests("https://api.dev/", "", &[r]);
        let text = serde_json::to_string(&har).unwrap();
        assert!(!text.contains("abc"), "{text}");
        let request = &har["log"]["entries"][0]["request"];
        assert!(request["url"].as_str().unwrap().contains("page=2"));
        assert_eq!(request["queryString"][0]["name"], "code");
        assert_eq!(request["queryString"][0]["value"], "[redacted]");
    }

    #[test]
    fn userinfo_is_stripped() {
        let mut r = req();
        r.url = "https://user:pw@api.dev/".into();
        let har = from_requests("https://api.dev/", "", &[r]);
        let text = serde_json::to_string(&har).unwrap();
        assert!(!text.contains("pw@"), "{text}");
    }

    #[test]
    fn custom_auth_headers_keep_their_name_but_lose_the_value() {
        let mut r = req();
        r.headers.insert("X-Api-Key".into(), "k123".into());
        let har = from_requests("https://api.dev/", "", &[r]);
        let text = serde_json::to_string(&har).unwrap();
        assert!(!text.contains("k123"), "{text}");
        let headers = har["log"]["entries"][0]["request"]["headers"]
            .as_array()
            .unwrap();
        assert!(
            headers
                .iter()
                .any(|h| h["name"] == "X-Api-Key" && h["value"] == "[redacted]")
        );
    }

    #[test]
    fn form_and_json_bodies_redact_secret_fields() {
        let mut r = req();
        r.method = "POST".into();
        r.headers.insert(
            "content-type".into(),
            "application/x-www-form-urlencoded".into(),
        );
        r.post_data = Some("user=dale&password=hunter".into());
        r.response_body = Some(r#"{"access_token":"t1","expires_in":3600}"#.into());
        let har = from_requests("https://api.dev/", "", &[r]);
        let text = serde_json::to_string(&har).unwrap();
        assert!(!text.contains("hunter"), "{text}");
        assert!(!text.contains("t1"), "{text}");
        let e = &har["log"]["entries"][0];
        assert!(
            e["request"]["postData"]["text"]
                .as_str()
                .unwrap()
                .contains("user=dale")
        );
        assert!(
            e["response"]["content"]["text"]
                .as_str()
                .unwrap()
                .contains("expires_in")
        );
    }

    #[test]
    fn multipart_bodies_are_omitted_with_a_note() {
        let mut r = req();
        r.method = "POST".into();
        r.headers.insert(
            "content-type".into(),
            "multipart/form-data; boundary=x".into(),
        );
        r.post_data = Some("--x\r\nfile-bytes\r\n--x--".into());
        let har = from_requests("https://api.dev/", "", &[r]);
        let post = &har["log"]["entries"][0]["request"]["postData"];
        assert_eq!(post["text"], "");
        assert_eq!(post["comment"], "multipart body omitted from the export");
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
