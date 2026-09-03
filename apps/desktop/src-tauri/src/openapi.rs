//! Infer an `OpenAPI` 3.1 document from captured traffic: group requests by
//! method and templated path, record observed statuses, content types and
//! query parameters. Good enough to seed a spec or a typed client.

use std::collections::{BTreeMap, BTreeSet};
use std::fmt::Write as _;

use serde_json::{Map, Value, json};

use crate::buffers::RequestSummary;

/// Resource types that are API calls rather than page assets.
const API_TYPES: &[&str] = &["XHR", "Fetch", "Document", "Other", "WebSocket"];

/// Build the spec for one origin's API traffic. Requests to other origins
/// are grouped under their own server entry.
pub fn from_requests(page_url: &str, requests: &[RequestSummary]) -> Value {
    let mut servers: BTreeSet<String> = BTreeSet::new();
    let mut paths: BTreeMap<String, BTreeMap<String, Operation>> = BTreeMap::new();
    for r in requests.iter().filter(|r| {
        (r.resource_type.is_empty() || API_TYPES.contains(&r.resource_type.as_str()))
            && looks_like_api(r)
    }) {
        let Ok(url) = url::Url::parse(&r.url) else {
            continue;
        };
        servers.insert(url.origin().ascii_serialization());
        let path = template_path(url.path());
        let method = r.method.to_ascii_lowercase();
        let op = paths.entry(path).or_default().entry(method).or_default();
        op.count += 1;
        if let Some(status) = r.status {
            op.statuses
                .entry(status)
                .or_default()
                .insert(r.mime_type.clone());
            if let Some(body) = &r.response_body
                && let Ok(sample) = serde_json::from_str::<Value>(body)
            {
                op.schemas
                    .entry(status)
                    .or_insert_with(|| infer_schema(&sample));
            }
        }
        for (k, _) in url.query_pairs() {
            op.query.insert(k.into_owned());
        }
        if r.post_data.is_some() {
            op.request_types.insert(
                r.headers
                    .iter()
                    .find(|(k, _)| k.eq_ignore_ascii_case("content-type"))
                    .map_or_else(|| "application/json".into(), |(_, v)| v.clone()),
            );
        }
    }
    let title = url::Url::parse(page_url)
        .ok()
        .and_then(|u| u.host_str().map(|h| format!("{h} API")))
        .unwrap_or_else(|| "Captured API".into());
    json!({
        "openapi": "3.1.0",
        "info": {"title": title, "version": "captured", "description": "Inferred by Dive from observed traffic. Verify before relying on it."},
        "servers": servers.iter().map(|s| json!({"url": s})).collect::<Vec<_>>(),
        "paths": paths.iter().map(|(p, ops)| (p.clone(), Value::Object(ops.iter().map(|(m, op)| (m.clone(), op.to_json(p))).collect::<Map<_, _>>()))).collect::<Map<_, _>>(),
    })
}

#[derive(Default)]
struct Operation {
    count: u32,
    statuses: BTreeMap<u16, BTreeSet<String>>,
    query: BTreeSet<String>,
    request_types: BTreeSet<String>,
    schemas: BTreeMap<u16, Value>,
}

impl Operation {
    fn to_json(&self, path: &str) -> Value {
        let mut parameters: Vec<Value> = path
            .split('/')
            .filter_map(|seg| seg.strip_prefix('{').and_then(|s| s.strip_suffix('}')))
            .map(|name| json!({"name": name, "in": "path", "required": true, "schema": {"type": "string"}}))
            .collect();
        parameters.extend(
            self.query
                .iter()
                .map(|q| json!({"name": q, "in": "query", "schema": {"type": "string"}})),
        );
        let responses: Map<String, Value> = self
            .statuses
            .iter()
            .map(|(status, types)| {
                let schema = self
                    .schemas
                    .get(status)
                    .map_or_else(|| json!({}), |s| json!({"schema": s}));
                let content: Map<String, Value> = types
                    .iter()
                    .filter(|t| !t.is_empty())
                    .map(|t| (t.clone(), schema.clone()))
                    .collect();
                let mut r = json!({"description": reason(*status)});
                if !content.is_empty() {
                    r["content"] = Value::Object(content);
                }
                (status.to_string(), r)
            })
            .collect();
        let mut op = json!({"x-observed-count": self.count, "parameters": parameters, "responses": responses});
        if !self.request_types.is_empty() {
            op["requestBody"] = json!({"content": self.request_types.iter().map(|t| (t.clone(), json!({}))).collect::<Map<_, _>>()});
        }
        op
    }
}

fn reason(status: u16) -> &'static str {
    match status {
        200 => "OK",
        201 => "Created",
        204 => "No Content",
        301 | 302 | 307 | 308 => "Redirect",
        304 => "Not Modified",
        400 => "Bad Request",
        401 => "Unauthorized",
        403 => "Forbidden",
        404 => "Not Found",
        422 => "Unprocessable Content",
        429 => "Too Many Requests",
        500..=599 => "Server Error",
        _ => "Response",
    }
}

/// A JSON schema for a sample value: objects list their properties, arrays
/// use the first element, scalars map to JSON types. Good enough to seed a
/// typed client.
pub fn infer_schema(v: &Value) -> Value {
    match v {
        Value::Null => json!({"type": "null"}),
        Value::Bool(_) => json!({"type": "boolean"}),
        Value::Number(n) => {
            json!({"type": if n.is_i64() || n.is_u64() { "integer" } else { "number" }})
        }
        Value::String(_) => json!({"type": "string"}),
        Value::Array(items) => match items.first() {
            Some(first) => json!({"type": "array", "items": infer_schema(first)}),
            None => json!({"type": "array", "items": {}}),
        },
        Value::Object(map) => {
            let props: Map<String, Value> = map
                .iter()
                .take(200)
                .map(|(k, v)| (k.clone(), infer_schema(v)))
                .collect();
            json!({"type": "object", "properties": props})
        }
    }
}

/// Skip static assets even when they came through fetch.
// `path` is lowercased above, so the suffix checks are effectively case-insensitive.
#[allow(clippy::case_sensitive_file_extension_comparisons)]
fn looks_like_api(r: &RequestSummary) -> bool {
    let mime = r.mime_type.to_ascii_lowercase();
    if mime.starts_with("image/")
        || mime.starts_with("font/")
        || mime == "text/css"
        || mime.contains("javascript")
    {
        return false;
    }
    let path = url::Url::parse(&r.url)
        .map(|u| u.path().to_ascii_lowercase())
        .unwrap_or_default();
    !path.ends_with(".js")
        && !path.ends_with(".css")
        && !path.ends_with(".map")
        && !path.ends_with(".png")
        && !path.ends_with(".svg")
        && !path.ends_with(".ico")
        && !path.ends_with(".woff2")
}

/// Replace ids in a path with `{id}`-style parameters.
pub fn template_path(path: &str) -> String {
    let mut out = String::new();
    let mut prev = "";
    for seg in path.split('/') {
        if seg.is_empty() {
            continue;
        }
        out.push('/');
        if is_id(seg) {
            let name = singular(prev);
            let _ = write!(out, "{{{name}Id}}");
        } else {
            out.push_str(seg);
        }
        prev = seg;
    }
    if out.is_empty() { "/".into() } else { out }
}

fn is_id(seg: &str) -> bool {
    let digits = seg.chars().all(|c| c.is_ascii_digit()) && !seg.is_empty();
    let uuid = seg.len() == 36
        && seg.chars().filter(|c| *c == '-').count() == 4
        && seg.chars().all(|c| c.is_ascii_hexdigit() || c == '-');
    let hexish = seg.len() >= 16 && seg.chars().all(|c| c.is_ascii_hexdigit());
    digits || uuid || hexish
}

fn singular(word: &str) -> String {
    let w = word.trim().to_ascii_lowercase();
    if w.is_empty() || w.starts_with('{') {
        return "id".into();
    }
    let base = w
        .strip_suffix("ies")
        .map(|s| format!("{s}y"))
        .or_else(|| w.strip_suffix('s').map(str::to_owned))
        .unwrap_or(w);
    base.chars().filter(char::is_ascii_alphanumeric).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn req(
        method: &str,
        url: &str,
        status: u16,
        mime: &str,
        rt: &str,
        body: Option<&str>,
    ) -> RequestSummary {
        RequestSummary {
            id: url.into(),
            url: url.into(),
            method: method.into(),
            resource_type: rt.into(),
            status: Some(status),
            mime_type: mime.into(),
            encoded_length: None,
            error: None,
            headers: [("Content-Type".to_owned(), "application/json".to_owned())]
                .into_iter()
                .collect(),
            post_data: body.map(str::to_owned),
            response_body: None,
        }
    }

    #[test]
    fn templates_paths() {
        assert_eq!(
            template_path("/api/users/123/posts/9f1e2d3c4b5a69788776655443322110"),
            "/api/users/{userId}/posts/{postId}"
        );
        assert_eq!(
            template_path("/companies/550e8400-e29b-41d4-a716-446655440000"),
            "/companies/{companyId}"
        );
        assert_eq!(template_path("/"), "/");
        assert_eq!(template_path("/v1/health"), "/v1/health");
    }

    #[test]
    fn infers_schemas_from_bodies() {
        let s = infer_schema(
            &json!({"id": 1, "name": "x", "tags": ["a"], "meta": {"ok": true, "score": 1.5}, "none": null}),
        );
        assert_eq!(s["type"], "object");
        assert_eq!(s["properties"]["id"]["type"], "integer");
        assert_eq!(s["properties"]["tags"]["items"]["type"], "string");
        assert_eq!(
            s["properties"]["meta"]["properties"]["score"]["type"],
            "number"
        );
        assert_eq!(s["properties"]["none"]["type"], "null");
        let mut r = req(
            "GET",
            "https://api.a.dev/users/7",
            200,
            "application/json",
            "Fetch",
            None,
        );
        r.response_body = Some(r#"{"id": 7, "name": "dive"}"#.into());
        let spec = from_requests("https://a.dev/", &[r]);
        assert_eq!(
            spec["paths"]["/users/{userId}"]["get"]["responses"]["200"]["content"]["application/json"]
                ["schema"]["properties"]["name"]["type"],
            "string"
        );
    }

    #[test]
    fn builds_spec_from_traffic() {
        let reqs = vec![
            req(
                "GET",
                "https://api.a.dev/users/1?expand=posts",
                200,
                "application/json",
                "Fetch",
                None,
            ),
            req(
                "GET",
                "https://api.a.dev/users/2",
                404,
                "application/json",
                "XHR",
                None,
            ),
            req(
                "POST",
                "https://api.a.dev/users",
                201,
                "application/json",
                "Fetch",
                Some("{}"),
            ),
            req(
                "GET",
                "https://api.a.dev/static/app.js",
                200,
                "application/javascript",
                "Script",
                None,
            ),
            req(
                "GET",
                "https://cdn.a.dev/logo.png",
                200,
                "image/png",
                "Fetch",
                None,
            ),
            req(
                "GET",
                "https://api.a.dev/health",
                200,
                "application/json",
                "",
                None,
            ),
        ];
        let spec = from_requests("https://a.dev/", &reqs);
        assert_eq!(spec["openapi"], "3.1.0");
        assert_eq!(spec["servers"][0]["url"], "https://api.a.dev");
        let get = &spec["paths"]["/users/{userId}"]["get"];
        assert_eq!(get["x-observed-count"], 2);
        assert!(get["responses"].get("200").is_some() && get["responses"].get("404").is_some());
        assert_eq!(get["parameters"][0]["name"], "userId");
        assert_eq!(get["parameters"][1]["name"], "expand");
        assert!(
            spec["paths"]["/users"]["post"]["requestBody"]["content"]
                .get("application/json")
                .is_some()
        );
        assert!(spec["paths"].get("/static/app.js").is_none());
        assert!(spec["paths"].get("/logo.png").is_none());
        assert!(
            spec["paths"].get("/health").is_some(),
            "untyped requests still count"
        );
    }
}
